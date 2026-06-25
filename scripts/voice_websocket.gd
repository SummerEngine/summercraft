## VoiceWebSocket — native-Godot realtime voice for AgentCraft (Track C), autoload "VoiceWebSocket".
##
## PORT of a prior Godot voice prototype's voice_websocket autoload. The proven NATIVE pipeline:
##   Godot --(WebSocketPeer)--> ElevenLabs Conversational AI  (STT + turn-taking + TTS in the cloud)
##
## ARCHITECTURE (the committed path — client tool, NO custom-LLM, NO tunnel):
##   The ElevenLabs agent uses its OWN cloud LLM for the *conversation* (fast, low-latency). It does
##   NOT do the coding. When the player asks for real work, the agent calls the `run_task` CLIENT TOOL.
##   A client tool is handled HERE, in the game (the client) — so the tool dispatch reaches the LOCAL
##   sidecar (POST http://127.0.0.1:8787/agents/<id>/prompt), which runs the real Claude Code session
##   on the user's subscription. Because the tool is handled client-side, the sidecar never has to be
##   reachable from ElevenLabs' cloud — so there is NO tunnel and NO custom-LLM URL (that older design
##   needed ElevenLabs' servers to reach 127.0.0.1, which is impossible without a public tunnel).
##
##   VoiceBridge (a child of this node, scripts/voice_bridge.gd) does the actual tool dispatch and the
##   speaking/caption relay. This node owns ONLY the ElevenLabs transport + the contract seam API.
##
## CONTRACT SEAM (master plan §5.4 — B calls these on the first-person dive):
##   start_conversation(character_id: String, context: Dictionary = {})   # context = branch/PR/diff/task
##   end_conversation()
##   signals: caption(text), speaking_changed(on), tool_called(name, id, params)
##   set_target_npc(node)  # the clicked character's AgentVoicePlayer = the positional audio sink
##
## CONNECT PATH — two modes (export-selected):
##   - SIGNED relay (DEFAULT): GET a short-lived signed_url from the LOCAL sidecar
##     (http://127.0.0.1:8787/voice/signed-url). The sidecar holds ELEVENLABS_API_KEY + the agent id
##     server-side; the game never sees the key. Self-contained on the demo machine.
##   - PUBLIC agent: connect straight to ElevenLabs with a bare agent_id (set use_signed_url=false and
##     elevenlabs_agent_id). Simplest if the agent is public; still no key in the game.
##
## PER-CHARACTER ROUTING: one shared ElevenLabs "template" agent serves every character. The clicked
##   character_id is sent as a conversation dynamic variable and is what VoiceBridge POSTs the run_task
##   prompt to — so the right live Claude session does the work. NOT a different agent per character.
##
## REQUIRES project.godot:  [audio] driver/enable_input=true  (mic is silently dead otherwise) and
## an [autoload] entry  VoiceWebSocket="*res://scripts/voice_websocket.gd"  (both already present).

extends Node

# =============================================================================
# SIGNALS  (agent-neutral; the conversation brain is ElevenLabs' cloud LLM, the work brain is Claude)
# =============================================================================

signal conversation_started()
signal conversation_ended()
signal agent_started_speaking()
signal agent_finished_speaking()
## Contract-aligned speaking tell (master plan §5.4) — B flips the in-world speaking material/icon.
signal speaking_changed(on: bool)
signal agent_audio_chunk(audio: PackedByteArray)
## user_text = your transcribed speech, agent_text = the agent's response text (captions).
signal transcript_received(user_text: String, agent_text: String)
signal caption(text: String)
signal error_occurred(message: String)
signal mic_level_changed(level: float)
## Contract-frozen §5.4 signal: tool_called(name, args). B may listen to surface "agent is acting".
signal tool_called(name: String, args: Dictionary)
## C-internal richer signal — carries the tool_call_id needed to answer with send_tool_result().
## VoiceBridge connects to THIS one; tool_called stays 2-arg to honor the frozen contract.
signal tool_call_received(tool_name: String, tool_call_id: String, parameters: Dictionary)

# =============================================================================
# CONFIGURATION
# =============================================================================

## ElevenLabs Conversational AI direct WS base (PUBLIC-agent path — no signed URL needed).
const ELEVENLABS_WS_BASE := "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=%s"

## The LOCAL sidecar signed-url relay (master plan / contract.ts GET /voice/signed-url). It holds
## ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID server-side and returns { configured, signed_url }. This
## replaces the prototype's remote endpoint so AgentCraft is self-contained on the demo box.
@export var signed_url_endpoint: String = "http://127.0.0.1:8787/voice/signed-url"

## true (default): fetch a signed URL from the local sidecar (key stays server-side). false: connect
## directly to a PUBLIC ElevenLabs agent using elevenlabs_agent_id (no key in the game either way).
@export var use_signed_url: bool = true

## The single shared ElevenLabs "template" agent id. For the signed path this is OPTIONAL (the sidecar
## uses its ELEVENLABS_AGENT_ID env); set it to override per-call. For the public path it is REQUIRED.
@export var elevenlabs_agent_id: String = ""

## Only fall back to a bare-agent_id PUBLIC connect when signed-url is unconfigured IF the agent is
## actually public. setup-agent.mjs creates a PRIVATE agent, so default false: on configured:false we
## surface the real reason instead of a confusing socket close.
@export var use_public_agent: bool = false

const SAMPLE_RATE: int = 16000  # ElevenLabs expects 16kHz

# =============================================================================
# STATE
# =============================================================================

var _connected: bool = false
var is_recording: bool = false
var is_muted: bool = false
## Latch: B (or the dive) may call start_recording() before the WS is open. We remember the intent and
## actually open the mic in _on_conversation_started. Default true = open-mic dive (use set_muted for
## push-to-talk). Without this the §5.4 seam (start_conversation only) leaves the mic dead — one-way.
var _want_recording: bool = true

# Dead-mic watchdog — catches mic-permission-denied (the mic bus is silent, no error, voice just looks
# dead). If recording is live + unmuted for MIC_WATCHDOG_MS with zero captured level, warn once.
const MIC_WATCHDOG_MS: int = 3500
const MIC_LEVEL_FLOOR: float = 0.015
var _mic_seen_audio: bool = false
var _record_start_ms: int = 0
var _mic_warned: bool = false

var _initiation_sent: bool = false
var _agent_id: String = ""          # ElevenLabs agent id of the active conversation
var _character_id: String = ""      # AgentCraft character id (routes the live Claude session)
var _context: Dictionary = {}       # branch/PR/diff/task injected on the dive (context injection)
var _conversation_id: String = ""

var _ws: WebSocketPeer = null
var _ws_state: int = WebSocketPeer.STATE_CLOSED

var _mic_capture: MicCapture = null
var _bridge: Node = null            # scripts/voice_bridge.gd — tool dispatch + relay (child of this)

var _is_playing_audio: bool = false
## The clicked character's AgentVoicePlayer — voice emanates from this body. May be null
## (then audio chunks still emit via agent_audio_chunk for any other sink to play).
var _target_npc: Node = null

# =============================================================================
# LIFECYCLE
# =============================================================================

func _ready() -> void:
	_mic_capture = MicCapture.new()
	_mic_capture.name = "MicCapture"
	add_child(_mic_capture)
	_mic_capture.audio_chunk_ready.connect(_on_audio_chunk_ready)
	_mic_capture.mic_level_changed.connect(_on_mic_level)

	# VoiceBridge handles the run_task tool dispatch -> sidecar and the speaking/caption relay. It is a
	# child of this autoload (NOT a separate autoload), so no project.godot change is needed and it
	# stays entirely inside Track C's owned files.
	var bridge_script := load("res://scripts/voice_bridge.gd")
	if bridge_script:
		_bridge = bridge_script.new()
		_bridge.name = "VoiceBridge"
		add_child(_bridge)
	print("[VoiceWebSocket] Initialized (native mic, client-tool dispatch)")


func _process(_delta: float) -> void:
	_mic_watchdog()
	if _ws == null:
		return

	_ws.poll()
	_ws_state = _ws.get_ready_state()

	match _ws_state:
		WebSocketPeer.STATE_OPEN:
			if not _initiation_sent:
				_send_initiation_message()
				_initiation_sent = true
			while _ws.get_available_packet_count() > 0:
				var packet := _ws.get_packet()
				_handle_message(packet.get_string_from_utf8())
		WebSocketPeer.STATE_CLOSING:
			pass
		WebSocketPeer.STATE_CLOSED:
			var code := _ws.get_close_code()
			var reason := _ws.get_close_reason()
			_ws = null  # clear first so a closed socket isn't re-handled next frame
			if _connected:
				print("[VoiceWebSocket] Connection closed: %d - %s" % [code, reason])
				if code != 1000 and code != 1005:
					emit_signal("caption", "Voice disconnected (%d). %s" % [code, _close_hint(code)])
				_on_disconnected()
			else:
				# Closed before the init handshake — auth/agent rejection, bad key, unreachable, etc.
				push_warning("[VoiceWebSocket] Closed before init: %d - %s" % [code, reason])
				emit_signal("caption", "Voice couldn't start (%d). %s" % [code, _close_hint(code)])
				emit_signal("error_occurred", "closed before init: %d" % code)


func _exit_tree() -> void:
	end_conversation()


# =============================================================================
# PUBLIC API  (the contract seam — B calls these on the dive)
# =============================================================================

## Start a voice conversation with the clicked character.
##   character_id : the AgentCraft character (routes run_task to its live Claude session).
##   context      : optional branch/PR/diff/task injected so the agent knows what it's working on.
##                  Recognized keys (all optional): label, persona, repo, branch, task, diff_summary, pr.
##   el_agent_id  : optional override of the shared ElevenLabs agent (rarely needed).
func start_conversation(character_id: String, context: Dictionary = {}, el_agent_id: String = "") -> void:
	if _connected:
		push_warning("[VoiceWebSocket] Already in a conversation")
		return

	_character_id = character_id
	_context = context if context != null else {}
	_agent_id = el_agent_id if el_agent_id != "" else elevenlabs_agent_id
	_initiation_sent = false
	print("[VoiceWebSocket] Starting conversation (character=%s)" % _character_id)

	if use_signed_url:
		# Signed path: the sidecar supplies the agent (its env) unless we pass an override.
		_get_signed_url(_agent_id)
	else:
		if _agent_id == "":
			emit_signal("error_occurred", "PUBLIC voice path needs elevenlabs_agent_id")
			return
		_connect_websocket(ELEVENLABS_WS_BASE % _agent_id)


## Set the character whose AgentVoicePlayer plays the voice (call before start_conversation).
func set_target_npc(npc: Node) -> void:
	_target_npc = npc


## ONE-CALL DIVE ENTRYPOINT for B (§5.4): set the positional audio sink, pull A's /agents/:id/context
## (branch / PR / diff / task / hierarchy), and start the conversation grounded in that. B just calls
## this on the dive and end_conversation() on exit — context fetch + injection are handled here.
func start_dive(character_id: String, npc: Node = null) -> void:
	set_target_npc(npc)
	if _bridge and _bridge.has_method("fetch_context"):
		_bridge.fetch_context(character_id, func(ctx: Dictionary):
			start_conversation(character_id, ctx)
		)
	else:
		start_conversation(character_id)


func end_conversation() -> void:
	if not _connected and _ws == null:
		return
	stop_recording()
	if _ws:
		_ws.close()
		_ws = null
	_on_disconnected()
	print("[VoiceWebSocket] Conversation ended")


func start_recording() -> void:
	_want_recording = true
	if not _connected:
		return  # latched — _on_conversation_started opens the mic once the WS is connected
	if is_recording:
		return
	is_recording = true
	# arm the dead-mic watchdog
	_mic_seen_audio = false
	_mic_warned = false
	_record_start_ms = Time.get_ticks_msec()
	_mic_capture.start_recording()
	print("[VoiceWebSocket] Recording started (native mic)")


func stop_recording() -> void:
	if not is_recording:
		return
	is_recording = false
	_mic_capture.stop_recording()
	print("[VoiceWebSocket] Recording stopped (native mic)")


## Fire the macOS microphone-permission dialog at BOOT, not mid-demo. B calls this once on _setup_voice
## so the OS prompt is dealt with before the first real dive. A brief start/stop is enough to trigger it.
func prime_mic() -> void:
	if _mic_capture:
		_mic_capture.start_recording()
		_mic_capture.stop_recording()
		print("[VoiceWebSocket] Mic primed (permission requested at boot)")


func _on_mic_level(level: float) -> void:
	if level > MIC_LEVEL_FLOOR:
		_mic_seen_audio = true
	emit_signal("mic_level_changed", level)


## If the mic has been live + unmuted for a few seconds and we've captured literal silence, the OS most
## likely denied mic permission (the bus runs but is empty, with no error). Tell the player, once.
func _mic_watchdog() -> void:
	if not is_recording or is_muted or _mic_seen_audio or _mic_warned:
		return
	if Time.get_ticks_msec() - _record_start_ms > MIC_WATCHDOG_MS:
		_mic_warned = true
		emit_signal("caption", "I can't hear you — check that the app has microphone permission.")
		emit_signal("error_occurred", "mic captured silence (permission?)")


## Inject extra context mid-conversation (non-spoken). Used for the dive opener and "task done" pokes.
func send_context_update(context: String) -> void:
	if not _connected:
		return
	_send_json({"type": "contextual_update", "text": context})


func set_muted(muted: bool) -> void:
	is_muted = muted


## The character this conversation routes work to (VoiceBridge POSTs run_task here).
func get_active_character_id() -> String:
	return _character_id


# =============================================================================
# CONNECTION
# =============================================================================

func _get_signed_url(agent_id: String) -> void:
	var http := HTTPRequest.new()
	add_child(http)
	http.request_completed.connect(_on_signed_url_received.bind(http))
	# agent_id is optional for the local relay (it falls back to its ELEVENLABS_AGENT_ID env).
	var url := signed_url_endpoint
	if agent_id != "":
		url = "%s?agent_id=%s" % [signed_url_endpoint, agent_id.uri_encode()]
	var err := http.request(url)
	if err != OK:
		push_error("[VoiceWebSocket] Failed to request signed URL: %d" % err)
		emit_signal("error_occurred", "Failed to get voice connection")
		http.queue_free()


func _on_signed_url_received(result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray, http: HTTPRequest) -> void:
	http.queue_free()
	if result != HTTPRequest.RESULT_SUCCESS or response_code != 200:
		push_error("[VoiceWebSocket] Failed to get signed URL: %d, %d" % [result, response_code])
		emit_signal("error_occurred", "Failed to reach the voice service (is the sidecar up?)")
		return
	var json := JSON.new()
	if json.parse(body.get_string_from_utf8()) != OK:
		emit_signal("error_occurred", "Invalid response from voice service")
		return
	var data = json.data
	if typeof(data) != TYPE_DICTIONARY:
		emit_signal("error_occurred", "Invalid response from voice service")
		return
	# Local sidecar relay shape: { configured:true, signed_url, agent_id } | { configured:false, reason }.
	if not data.get("configured", true):
		var reason := String(data.get("reason", "voice not configured"))
		print("[VoiceWebSocket] Voice not configured: %s" % reason)
		# Only fall back to a bare-agent_id connect if the agent is actually PUBLIC (it isn't by default —
		# setup-agent.mjs makes a private agent). Otherwise surface the real, actionable reason.
		if use_public_agent and elevenlabs_agent_id != "":
			_connect_websocket(ELEVENLABS_WS_BASE % elevenlabs_agent_id)
		else:
			emit_signal("caption", "Voice not configured — set ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID on the sidecar (%s)" % reason)
			emit_signal("error_occurred", reason)
		return
	if not data.has("signed_url"):
		emit_signal("error_occurred", "Missing signed URL")
		return
	_connect_websocket(String(data["signed_url"]))


func _connect_websocket(url: String) -> void:
	_ws = WebSocketPeer.new()
	# ElevenLabs streams large audio chunks — generous buffers.
	_ws.inbound_buffer_size = 1024 * 1024
	_ws.outbound_buffer_size = 256 * 1024
	_ws.max_queued_packets = 4096
	var err := _ws.connect_to_url(url)
	if err != OK:
		push_error("[VoiceWebSocket] Failed to connect WebSocket: %d" % err)
		emit_signal("error_occurred", "Failed to connect to voice service")
		_ws = null
		return
	print("[VoiceWebSocket] Connecting to ElevenLabs...")


func _send_initiation_message() -> void:
	# conversation_initiation_client_data triggers the agent's first turn and carries:
	#   - dynamic_variables: fill {{character_id}}, {{label}}, {{task}}... placeholders in the agent's
	#     configured prompt/first-message, so the agent knows WHO it is and WHAT it's working on.
	#   - the run_task client tool is configured on the agent (dashboard); when it fires we get a
	#     client_tool_call frame -> emit tool_called -> VoiceBridge POSTs the sidecar.
	# Send ONLY per-conversation data — character_id + injected context as dynamic variables. We do NOT
	# send conversation_config_override: all behavior (turn-taking, voice, model, ASR...) lives in the
	# agent config (voice.config.mjs, applied via setup-agent.mjs). Overriding here would also be
	# rejected/ignored unless the matching platform_settings.overrides flag is enabled on the agent.
	var init_data := {
		"type": "conversation_initiation_client_data",
		"dynamic_variables": _build_dynamic_variables(),
	}
	_send_json(init_data)
	print("[VoiceWebSocket] Sent initiation (character_id=%s)" % _character_id)


## Flatten the injected context into ElevenLabs dynamic variables (all strings). ALWAYS send the full
## set with safe fallbacks: ElevenLabs rejects conversation start if a {{var}} in the prompt has no
## value. (The agent also declares defaults — defense in depth — but never rely on B passing context.)
## Safe Variant->String: null/absent -> "" (so the defaults below apply). NEVER use String(v) on a
## /context value: those come from JSON and can be null (current_task, pr_url, diff), and String(null)
## CRASHES the engine ("Invalid String constructor"). str() also handles ints/bools safely.
func _sv(v) -> String:
	return "" if v == null else str(v)


func _build_dynamic_variables() -> Dictionary:
	# Tolerate A's /context key variants. Only map when the source is a real (non-null) value, so a null
	# current_task/diff falls through to the default rather than injecting "<null>".
	if not _context.has("task") and _sv(_context.get("current_task")) != "":
		_context["task"] = _context["current_task"]
	if not _context.has("diff_summary") and _sv(_context.get("diff")) != "":
		_context["diff_summary"] = _sv(_context["diff"]).substr(0, 240)  # cap: raw diffs can be huge
	# label/persona + the SummerCraft hierarchy (project/repo/group) + work state. All optional.
	var defaults := {
		"label": _character_id if _character_id != "" else "the agent",
		"persona": "", "project": "this project", "repo": "this repo", "group": "",
		"branch": "its branch", "task": "its current task", "diff_summary": "", "pr": "",
	}
	var dv := {"character_id": _character_id}
	for key in defaults:
		var v := _sv(_context.get(key))
		dv[key] = v if v != "" else str(defaults[key])
	return dv


## Supplemental context sent as a non-spoken contextual_update after connect — ONLY the fields the
## prompt placeholders don't already template (label/repo/branch/task go via dynamic variables, so
## they're NOT repeated here to avoid double-priming the agent's first turn / burning the greeting).
func _build_supplemental_context_text() -> String:
	var lines: Array[String] = []
	# THE CATCH-UP: the session's recent transcript — what this agent was actually doing. This is how the
	# voice "knows the chat it represents" without holding the session's full context window.
	var tail = _context.get("transcript_tail", [])
	if tail is Array and not tail.is_empty():
		var recent: Array[String] = []
		for t in tail:
			var s := _sv(t)
			if s != "":
				recent.append(s)
		if not recent.is_empty():
			lines.append("Here's where your session left off: %s." % " → ".join(recent))
	if _sv(_context.get("diff_summary")) != "":
		lines.append("Uncommitted changes: %s." % _sv(_context.get("diff_summary")))
	if _sv(_context.get("pr")) != "":
		lines.append("Open PR: %s." % _sv(_context.get("pr")))
	if not lines.is_empty():
		lines.append("If the player asks where you left off, recap this naturally in a sentence. For anything deeper, call get_status or run_task to ask your live session — it remembers everything.")
	return " ".join(lines)


# =============================================================================
# MIC -> ELEVENLABS
# =============================================================================

func _on_audio_chunk_ready(chunk: PackedByteArray) -> void:
	if not _connected or not is_recording or is_muted:
		return
	_send_json({"user_audio_chunk": Marshalls.raw_to_base64(chunk)})


# =============================================================================
# ELEVENLABS -> GAME  (frame switch kept UNCHANGED — proven transport)
# =============================================================================

func _handle_message(message: String) -> void:
	var json := JSON.new()
	if json.parse(message) != OK:
		push_warning("[VoiceWebSocket] Failed to parse message")
		return
	var data = json.data
	if typeof(data) != TYPE_DICTIONARY:
		return

	var msg_type := String(data.get("type", ""))
	match msg_type:
		"conversation_initiation_metadata":
			_on_conversation_started(data)
		"user_transcript":
			_on_user_transcript(data)
		"agent_response":
			_on_agent_response(data)
		"audio":
			_on_audio_response(data)
		"interruption":
			_on_interruption(data)
		"ping":
			_send_pong(data)
		"agent_response_correction":
			_on_agent_correction(data)
		"vad_score":
			pass
		"client_tool_call":
			_on_tool_call(data)
		"error":
			_on_el_error(data)
		_:
			# ElevenLabs sometimes surfaces errors without a clean type — catch a stray error payload.
			if data.has("error"):
				_on_el_error(data)
			else:
				print("[VoiceWebSocket] Unknown message type: %s" % msg_type)


func _on_conversation_started(data: Dictionary) -> void:
	_connected = true
	_conversation_id = data.get("conversation_initiation_metadata_event", {}).get("conversation_id", "")
	print("[VoiceWebSocket] Conversation started: %s" % _conversation_id)
	emit_signal("conversation_started")
	# Open the mic now that the WS is up (the §5.4 seam is start_conversation only; without this the
	# dive is one-way — agent speaks, never hears). _want_recording defaults true; set_muted = PTT.
	if _want_recording:
		start_recording()
	# Supplemental context (diff/PR only — the rest is already templated via dynamic variables).
	var ctx := _build_supplemental_context_text()
	if ctx != "":
		send_context_update(ctx)


func _on_user_transcript(data: Dictionary) -> void:
	var event = data.get("user_transcription_event", {})
	var transcript := String(event.get("user_transcript", ""))
	if transcript != "":
		emit_signal("transcript_received", transcript, "")


func _on_agent_response(data: Dictionary) -> void:
	var event = data.get("agent_response_event", {})
	var response := String(event.get("agent_response", ""))
	if response != "":
		_start_speaking()
		emit_signal("caption", response)
		emit_signal("transcript_received", "", response)


func _on_audio_response(data: Dictionary) -> void:
	var event = data.get("audio_event", {})
	var audio_base64 := String(event.get("audio_base_64", ""))
	if audio_base64 == "":
		audio_base64 = String(data.get("audio_base_64", ""))
		if audio_base64 == "":
			audio_base64 = String(data.get("audio", ""))
	if audio_base64 != "":
		var audio_data := Marshalls.base64_to_raw(audio_base64)
		_queue_audio(audio_data)
		emit_signal("agent_audio_chunk", audio_data)


func _on_interruption(_data: Dictionary) -> void:
	print("[VoiceWebSocket] Interruption detected")
	_clear_audio_queue()
	_stop_speaking()


func _on_agent_correction(_data: Dictionary) -> void:
	pass


## ElevenLabs surfaced an error mid-conversation (rate limit, quota, model error, etc.). Surface a
## short, friendly caption so the agent never just goes silent on stage, and emit the raw detail.
func _on_el_error(data: Dictionary) -> void:
	var detail := ""
	if data.has("error"):
		detail = _sv(data["error"])      # may be a nested object -> _sv (str) is crash-safe, String() isn't
	elif data.has("message"):
		detail = _sv(data["message"])
	else:
		detail = JSON.stringify(data).substr(0, 160)
	push_warning("[VoiceWebSocket] ElevenLabs error: %s" % detail)
	emit_signal("caption", "Voice hiccup — %s" % _friendly_error(detail))
	emit_signal("error_occurred", detail)


func _friendly_error(detail: String) -> String:
	var d := detail.to_lower()
	if d.contains("rate") or d.contains("429") or d.contains("too many"):
		return "rate-limited, give it a second."
	if d.contains("quota") or d.contains("credit") or d.contains("payment"):
		return "out of ElevenLabs credits."
	if d.contains("unauthor") or d.contains("401") or d.contains("403"):
		return "auth issue — check the ElevenLabs key."
	return "let's try that again."


func _close_hint(code: int) -> String:
	match code:
		1008, 3000:
			return "Auth/agent issue — check ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID."
		1011:
			return "Voice service error — try again."
		1006:
			return "Lost connection — check your network."
		_:
			return "Tap to retry."


func _send_pong(data: Dictionary) -> void:
	var ping_event = data.get("ping_event", {})
	var event_id = ping_event.get("event_id", 0)
	_send_json({"pong_event": {"event_id": event_id}})


func _on_tool_call(data: Dictionary) -> void:
	var tool_event = data.get("client_tool_call", {})
	var tool_name := String(tool_event.get("tool_name", ""))
	var tool_call_id := String(tool_event.get("tool_call_id", ""))
	var parameters = tool_event.get("parameters", {})
	if typeof(parameters) != TYPE_DICTIONARY:
		parameters = {}
	print("[VoiceWebSocket] Tool called: %s (id: %s) %s" % [tool_name, tool_call_id, parameters])
	emit_signal("tool_called", tool_name, parameters)  # §5.4 contract (2-arg)
	emit_signal("tool_call_received", tool_name, tool_call_id, parameters)  # C-internal (has the id to answer)


func send_tool_result(tool_call_id: String, result: Variant, is_error: bool = false) -> void:
	var result_str: String
	if typeof(result) == TYPE_DICTIONARY or typeof(result) == TYPE_ARRAY:
		result_str = JSON.stringify(result)
	else:
		result_str = str(result)
	_send_json({
		"type": "client_tool_result",
		"tool_call_id": tool_call_id,
		"result": result_str,
		"is_error": is_error,
	})


func _on_disconnected() -> void:
	_connected = false
	is_recording = false
	_conversation_id = ""
	_clear_audio_queue()
	_stop_speaking()
	emit_signal("conversation_ended")


# =============================================================================
# AUDIO PLAYBACK (routed to the clicked character's AgentVoicePlayer)
# =============================================================================

func _queue_audio(audio_data: PackedByteArray) -> void:
	if not _is_playing_audio:
		_is_playing_audio = true
		if _target_npc and _target_npc.has_method("start_audio_playback"):
			_target_npc.start_audio_playback()
	if _target_npc and _target_npc.has_method("play_audio_chunk"):
		_target_npc.play_audio_chunk(audio_data)


func _clear_audio_queue() -> void:
	_is_playing_audio = false
	if _target_npc and _target_npc.has_method("stop_audio_playback"):
		_target_npc.stop_audio_playback()


func _start_speaking() -> void:
	if _target_npc and _target_npc.has_method("start_speaking"):
		_target_npc.start_speaking()
	emit_signal("agent_started_speaking")
	emit_signal("speaking_changed", true)


func _stop_speaking() -> void:
	if _target_npc and _target_npc.has_method("stop_speaking"):
		_target_npc.stop_speaking()
	emit_signal("agent_finished_speaking")
	emit_signal("speaking_changed", false)


# =============================================================================
# HELPERS
# =============================================================================

func _send_json(data: Dictionary) -> void:
	if _ws and _ws_state == WebSocketPeer.STATE_OPEN:
		_ws.send_text(JSON.stringify(data))
