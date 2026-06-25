extends Node
## AgentCraft VoiceBridge (Track C) — the game-side half of the voice loop.
##
## Instantiated as a CHILD of the VoiceWebSocket autoload (see voice_websocket.gd `_ready`), so it
## needs NO project.godot entry and lives entirely in Track C's owned files.
##
## Two jobs:
##
##   1. CLIENT-TOOL DISPATCH (the committed path — no custom-LLM, no tunnel). When the ElevenLabs
##      agent calls a client tool, VoiceWebSocket emits `tool_called(name, id, params)`. We handle it
##      HERE and call the LOCAL sidecar's HTTP API:
##        run_task     -> POST http://127.0.0.1:8787/agents/<character_id>/prompt { prompt }
##        get_status   -> GET  http://127.0.0.1:8787/world  (return that character's state/status/task)
##        commit_work  -> POST .../prompt with a "commit your changes" instruction
##      Then we answer the tool with VoiceWebSocket.send_tool_result(id, ...). Because this runs in the
##      game (the client), the dispatch reaches 127.0.0.1 directly — the sidecar never needs to be
##      reachable from ElevenLabs' cloud, so there is no tunnel.
##
##   2. RELAY OUT (optional, multi-viewer). We mirror the locally-observed speaking/caption events to
##      the sidecar via the additive `relay` ClientCommand (contract.ts) so OTHER connected viewers
##      see the in-world tell on the clicked character. Single-viewer demos don't need this — B reads
##      VoiceWebSocket's `caption`/`speaking_changed` signals directly. Relay is best-effort and never
##      blocks voice; it needs the per-launch WS token from sidecar/runtime/auth.token.
##
## CONTRACT (mirror of sidecar/contract.ts — keep in sync):
##   HTTP  POST /agents/:id/prompt { prompt }     -> 202 Accepted
##   HTTP  GET  /world                            -> WorldSnapshot { agents:[{agent_id,state,...}] }
##   WS    { "type":"hello", "token":<str> }      -> authes this socket
##   WS    { "type":"relay", "event": <ServerEvent speaking|caption|status> }  -> re-broadcast

# HUD relay (Lane D wiring): A's mid-turn `tool_activity` / `service` ServerEvents arrive here on the
# sidecar WS, but the HUD's activity()/service() sinks had no producer. We re-emit them as plain signals
# so WorldManager can bind them to Hud.activity()/Hud.service(). NOT gated on the active voice agent —
# the HUD card may be open for an agent you are NOT in a voice call with.
signal tool_activity(agent_id: String, tool: String, summary: String)
signal service_up(agent_id: String, url: String)

@export var enabled: bool = true
@export var sidecar_http: String = "http://127.0.0.1:8787"
@export var sidecar_ws: String = "ws://127.0.0.1:8787/"
## Per-launch WS token (sidecar/runtime/auth.token). Loaded on _ready; only the relay needs it — the
## HTTP routes are tokenless on localhost, so run_task works even if this is empty.
@export var auth_token: String = ""
@export var reconnect_delay: float = 1.5
## Mirror captions/speaking to the sidecar so other viewers see the tell. Off by default — the
## single-machine demo drives the tell locally off VoiceWebSocket's own signals.
@export var relay_enabled: bool = false

var _vws: Node = null               # the parent VoiceWebSocket autoload

# Sidecar WS — relay producer AND result listener. Live whenever relay_enabled OR a conversation is up.
var _peer: WebSocketPeer = null
var _connected: bool = false
var _hello_sent: bool = false
var _reconnect_t: float = 0.0
var _conv_active: bool = false      # a voice conversation is live -> listen for the agent's results


func _ready() -> void:
	_vws = get_parent()
	# Connect to the C-internal 3-arg signal (carries the tool_call_id needed to answer). The contract's
	# 2-arg tool_called(name, args) stays for any B-side listener; we use tool_call_received here.
	if _vws and _vws.has_signal("tool_call_received"):
		_vws.tool_call_received.connect(_on_tool_called)
	if relay_enabled and _vws:
		if _vws.has_signal("caption"):
			_vws.caption.connect(_on_local_caption)
		if _vws.has_signal("speaking_changed"):
			_vws.speaking_changed.connect(_on_local_speaking)
	# Result-back-to-voice: while a conversation is live, listen on the sidecar WS for the active
	# character's `result`/`done` events and feed them into the conversation so the agent can report.
	if _vws and _vws.has_signal("conversation_started"):
		_vws.conversation_started.connect(_on_conv_started)
	if _vws and _vws.has_signal("conversation_ended"):
		_vws.conversation_ended.connect(_on_conv_ended)
	_load_token()
	if enabled and relay_enabled:
		_open_peer()  # pre-warm the relay socket so it's hot before the first Talk


func _load_token() -> void:
	if auth_token != "":
		return
	var f := FileAccess.open("res://sidecar/runtime/auth.token", FileAccess.READ)
	if f:
		auth_token = f.get_as_text().strip_edges()
		f.close()


# =============================================================================
# CLIENT-TOOL DISPATCH  (ElevenLabs run_task -> the local sidecar)
# =============================================================================

func _on_tool_called(tool_name: String, tool_call_id: String, params: Dictionary) -> void:
	match tool_name:
		"run_task":
			_dispatch_run_task(tool_call_id, params)
		"ask_claude", "send_message":
			_dispatch_ask(tool_call_id, params)
		"get_status":
			_dispatch_get_status(tool_call_id, params)
		"commit_work":
			_dispatch_commit(tool_call_id, params)
		_:
			# Unknown tool — answer with an error so the agent doesn't hang waiting on the result.
			_result(tool_call_id, "Unknown tool: %s" % tool_name, true)


## run_task: send the spoken task to the character's real Claude session.
func _dispatch_run_task(tool_call_id: String, params: Dictionary) -> void:
	var character_id := _resolve_character(params)
	var task := _sv(params.get("task", params.get("prompt", ""))).strip_edges()
	if character_id == "":
		_result(tool_call_id, "No character selected to run the task on.", true)
		return
	if task == "":
		_result(tool_call_id, "No task text was provided.", true)
		return
	_http_post("/agents/%s/prompt" % character_id.uri_encode(), {"prompt": task},
		func(ok: bool, code: int, _body: Dictionary):
			if ok and code == 202:
				_result(tool_call_id, "Task dispatched to %s — it's working on it now." % character_id)
			else:
				_result(tool_call_id, _dispatch_error("dispatch the task", character_id, code), true)
	)


## ask_claude: the "ask Claude → get its answer → speak it back" loop. Tries the SYNCHRONOUS sidecar
## route POST /agents/:id/ask {question} -> { answer } (runs a real Claude turn, returns its words). If
## that route isn't live yet (A's lane), falls back to dispatching the question as a task — the answer
## then arrives async via result-back-to-voice. So it works today and gets crisper when /ask ships.
func _dispatch_ask(tool_call_id: String, params: Dictionary) -> void:
	var character_id := _resolve_character(params)
	var question := _sv(params.get("question", params.get("message", params.get("task", "")))).strip_edges()
	if character_id == "" or question == "":
		_result(tool_call_id, "There's nothing to ask yet.", true)
		return
	_http_post("/agents/%s/ask" % character_id.uri_encode(), {"question": question},
		func(ok: bool, code: int, body: Dictionary):
			if ok and code == 200 and _sv(body.get("answer")) != "":
				_result(tool_call_id, _sv(body.get("answer")))           # the session's real answer -> spoken
			elif code == 404 or code == 0:
				_ask_fallback(tool_call_id, character_id, question)      # /ask not live yet -> async
			else:
				_result(tool_call_id, _dispatch_error("ask that", character_id, code), true)
	)


## Async fallback when /ask isn't available: dispatch as a task; the answer lands via result-back-to-voice.
func _ask_fallback(tool_call_id: String, character_id: String, question: String) -> void:
	_http_post("/agents/%s/prompt" % character_id.uri_encode(), {"prompt": question},
		func(ok: bool, code: int, _b: Dictionary):
			if ok and code == 202:
				_result(tool_call_id, "Looking into that now — I'll tell you in a sec.")
			else:
				_result(tool_call_id, _dispatch_error("ask that", character_id, code), true)
	)


## get_status: read /world and report this character's live state to the agent (so it can say it aloud).
func _dispatch_get_status(tool_call_id: String, params: Dictionary) -> void:
	var character_id := _resolve_character(params)
	_http_get("/world", func(ok: bool, _code: int, body: Dictionary):
		if not ok:
			_result(tool_call_id, "Could not reach the world state.", true)
			return
		var agents: Array = body.get("agents", [])
		for a in agents:
			if typeof(a) == TYPE_DICTIONARY and String(a.get("agent_id", "")) == character_id:
				_result(tool_call_id, {
					"state": a.get("state", "unknown"),
					"status_line": a.get("status_line", ""),
					"current_task": a.get("current_task"),
				})
				return
		_result(tool_call_id, "No status for %s yet." % character_id)
	)


## commit_work: ask the character's session to commit its current diff.
func _dispatch_commit(tool_call_id: String, params: Dictionary) -> void:
	var character_id := _resolve_character(params)
	if character_id == "":
		_result(tool_call_id, "No character selected to commit.", true)
		return
	var prompt := "Commit your current changes with a clear, concise message, then reply with just the commit subject line."
	_http_post("/agents/%s/prompt" % character_id.uri_encode(), {"prompt": prompt},
		func(ok: bool, code: int, _body: Dictionary):
			if ok and code == 202:
				_result(tool_call_id, "Commit started — watch the feed for the result.")
			else:
				_result(tool_call_id, _dispatch_error("start the commit", character_id, code), true)
	)


## Prefer an explicit target in the tool params; else the character this conversation is about.
func _resolve_character(params: Dictionary) -> String:
	for key in ["agent_id", "character_id", "target", "id"]:
		if params.has(key) and _sv(params[key]) != "":
			return _sv(params[key])
	if _vws and _vws.has_method("get_active_character_id"):
		return _vws.get_active_character_id()
	return ""


func _result(tool_call_id: String, value: Variant, is_error: bool = false) -> void:
	if _vws and _vws.has_method("send_tool_result"):
		_vws.send_tool_result(tool_call_id, value, is_error)


## Turn a sidecar HTTP failure into a spoken-friendly reason (code 0 = couldn't even reach it).
func _dispatch_error(action: String, id: String, code: int) -> String:
	match code:
		0:
			return "I can't reach the sidecar — is it running?"
		404:
			return "There's no agent called %s." % id
		409, 503:
			return "%s is busy right now — try again in a moment." % id
		429:
			return "Too many requests right now — give it a second."
		_:
			return "Couldn't %s (sidecar %d)." % [action, code]


# =============================================================================
# DIVE CONTEXT  (pull A's /agents/:id/context so the agent knows what it's working on)
# =============================================================================

## Fetch the agent's live context (branch / PR / diff / task / hierarchy) from A's endpoint, then
## hand the dict to `cb`. Empty dict on any failure — the agent's dynamic-variable defaults cover it.
func fetch_context(character_id: String, cb: Callable) -> void:
	_http_get("/agents/%s/context" % character_id.uri_encode(), func(ok: bool, _code: int, body: Dictionary):
		cb.call(body if ok else {})
	)


# =============================================================================
# RESULT-BACK-TO-VOICE  (the agent's work finishes -> tell the conversation)
# =============================================================================

func _on_conv_started() -> void:
	_conv_active = true
	if _peer == null:
		_open_peer()  # bring the listener socket up for this conversation


func _on_conv_ended() -> void:
	_conv_active = false
	if not relay_enabled and _peer != null:
		_peer.close()
		_peer = null


## A `result`/`done` ServerEvent for the character we're talking to -> inject it as a non-spoken
## context update so the voice agent can naturally report the outcome on its next turn.
func _on_inbound(ev: Dictionary) -> void:
	var t := String(ev.get("type", ""))
	var aid := String(ev.get("agent_id", ""))
	if aid == "":
		return
	# HUD relay first — these light up the OPEN agent card, which need NOT be the voice target, so they
	# must run BEFORE the _active_id() gate below (which suppresses everything for a non-conversation agent).
	if t == "tool_activity":
		tool_activity.emit(aid, _sv(ev.get("tool")), _sv(ev.get("summary")))
		return
	if t == "service":
		# Also surface the localhost chip on the card (in addition to the voice tell below for the active agent).
		var svc_url := _sv(ev.get("url"))
		if svc_url != "":
			service_up.emit(aid, svc_url)
		# fall through: the voice tell still fires for the active conversation agent.
	if aid != _active_id():
		return
	if t == "result":
		_push_to_voice("Your session just finished: %s" % _sv(ev.get("summary")))
	elif t == "service":
		# A localhost server the turn surfaced (A's `service` ServerEvent: {url, port}). Tell the player
		# it's live and reachable so the agent can announce e.g. "it's running at http://localhost:3000".
		var url := _sv(ev.get("url"))
		if url != "":
			_push_to_voice("A local server is now running at %s." % url)
	elif t == "status" and _sv(ev.get("state")) == "done":
		_push_to_voice("Your task is done.")


func _push_to_voice(text: String) -> void:
	if _vws and _vws.has_method("send_context_update"):
		_vws.send_context_update("%s Briefly let the player know if it's relevant." % text)


# =============================================================================
# HTTP to the sidecar  (fresh request node per call — avoids HTTPRequest single-flight)
# =============================================================================

func _http_post(path: String, body: Dictionary, on_done: Callable) -> void:
	var http := HTTPRequest.new()
	add_child(http)
	http.request_completed.connect(func(result: int, code: int, _h: PackedStringArray, data: PackedByteArray):
		http.queue_free()
		on_done.call(result == HTTPRequest.RESULT_SUCCESS, code, _parse_json(data))
	)
	var err := http.request(sidecar_http + path, ["content-type: application/json"],
		HTTPClient.METHOD_POST, JSON.stringify(body))
	if err != OK:
		http.queue_free()
		on_done.call(false, 0, {})


func _http_get(path: String, on_done: Callable) -> void:
	var http := HTTPRequest.new()
	add_child(http)
	http.request_completed.connect(func(result: int, code: int, _h: PackedStringArray, data: PackedByteArray):
		http.queue_free()
		on_done.call(result == HTTPRequest.RESULT_SUCCESS, code, _parse_json(data))
	)
	var err := http.request(sidecar_http + path)
	if err != OK:
		http.queue_free()
		on_done.call(false, 0, {})


func _parse_json(data: PackedByteArray) -> Dictionary:
	var parsed = JSON.parse_string(data.get_string_from_utf8())
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}


## Null-safe Variant->String: null/absent -> "". String(null) crashes the engine; str() doesn't.
func _sv(v) -> String:
	return "" if v == null else str(v)


# =============================================================================
# RELAY OUT  (mirror local speaking/caption to the sidecar for other viewers)
# =============================================================================

func _on_local_caption(text: String) -> void:
	_relay({"type": "caption", "agent_id": _active_id(), "text": text})


func _on_local_speaking(on: bool) -> void:
	_relay({"type": "speaking", "agent_id": _active_id(), "speaking": on})


func _active_id() -> String:
	if _vws and _vws.has_method("get_active_character_id"):
		return _vws.get_active_character_id()
	return ""


func _relay(event: Dictionary) -> void:
	if not relay_enabled:
		return
	_send({"type": "relay", "event": event})


# =============================================================================
# Relay socket lifecycle (best-effort; never blocks voice)
# =============================================================================

func _open_peer() -> void:
	_peer = WebSocketPeer.new()
	_hello_sent = false
	var err := _peer.connect_to_url(sidecar_ws)
	if err != OK:
		_peer = null
		_reconnect_t = reconnect_delay


func _process(delta: float) -> void:
	# Socket is wanted while relaying OR while a conversation is live (to hear the agent's results).
	if not (enabled and (relay_enabled or _conv_active)):
		return
	if _peer == null:
		_reconnect_t -= delta
		if _reconnect_t <= 0.0:
			_open_peer()
		return

	_peer.poll()
	match _peer.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if not _hello_sent:
				_hello_sent = true
				_connected = true
				_send({"type": "hello", "token": auth_token})
				_send({"type": "subscribe"})  # all agents; we filter inbound to the active character
			while _peer.get_available_packet_count() > 0:
				var ev := _parse_json(_peer.get_packet())
				if not ev.is_empty():
					_on_inbound(ev)
		WebSocketPeer.STATE_CLOSED:
			_connected = false
			_peer = null
			_reconnect_t = reconnect_delay


func _send(obj: Dictionary) -> void:
	if _peer != null and _peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_peer.send_text(JSON.stringify(obj))
