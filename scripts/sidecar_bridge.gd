extends Node
## AgentCraft sidecar bridge (Track B — finalized).
##
## Polls GET http://127.0.0.1:8787/world every ~1s with a real HTTPRequest and
## emits world_updated(snapshot) for world_manager to render. When MOCK_FEED is
## true it instead drives the world from an in-process fake feed cycling all four
## states — so the world is FULLY demoable with NO sidecar, NO Aiven, NO Claude.
## This MOCK_FEED path is the hour-1 safety net; never remove it.
##
## FROZEN /world CONTRACT (mirror of sidecar/contract.ts — keep in sync, do not drift):
##   {
##     "agents": [ {
##        "agent_id", "repo_id", "repo_path",
##        "character_kind": "viking|wizard|dwarf|barbarian",
##        "state": "waiting|moving|working|blocked|done",
##        "label", "status_line", "current_task", "target_base_id",
##        "heartbeat_age_s", "transcript_tail": []
##     } ],
##     "locks":  [ { "repo_path", "file_path", "holder_agent_id", "claimed_at" } ],
##     "events": [ { "ts", "type", "agent_id", "detail" } ]
##   }
## COMMIT EVENT (A emits, B plants): an events[] entry { type:"commit", agent_id, detail:"<commit msg>" }.
## B resolves repo_id from the agent's view; one plant per unique (agent_id|detail).
##
## State -> animation (existing _match_clip system, no new art):
##   waiting->idle | moving->walk+lerp | working->attack-loop | blocked->idle+grey | done->cheer+hop
##
## Outbound (Track B -> sidecar): send_prompt() POSTs /agents/:id/prompt;
## request_voice() is a stub hook the Voice track (C) fills in over WS — kept here
## so world_manager has a stable seam regardless of which track lands first.

signal world_updated(snapshot: Dictionary)
# Connection state for D's status pill: true on the first real poll, false when we fall to the mock feed.
signal connection_changed(connected: bool)

# REAL by default — the game talks to the live sidecar (type -> real Claude agent -> real diff).
# If the sidecar is unreachable for FALLBACK_AFTER consecutive polls, we auto-fall-back to the mock
# feed so the world never goes dead on stage, and we auto-recover the instant a real poll succeeds.
@export var MOCK_FEED: bool = false
@export var poll_interval: float = 1.0
const SIDECAR_HOST := "http://127.0.0.1:8787"
const SIDECAR_URL := "http://127.0.0.1:8787/world"
const FALLBACK_AFTER := 5  # ~5s of failed polls -> show mock (but keep probing for the real sidecar)

var _t := 0.0
var _http: HTTPRequest = null
var _inflight := false
var _fail_count := 0
var _using_mock_fallback := false
var _conn_state := -1   # -1 unknown, 0 offline (mock), 1 live — emit connection_changed only on change
# Read-only multiplayer visit: while paused the poller emits NO world_updated, so a visited world
# (rendered by world_manager from GET /worlds/:id) is not stomped by the live /world feed.
var _paused := false

# --- Mock feed scripting (drives a believable demo with no backend) ---
# a1 (viking) cycles the full lifecycle; a2 (wizard) deliberately stays BLOCKED on
# the same file a1 holds, so the Aiven contention beat reads even in mock mode.
const _CYCLE := ["waiting", "moving", "working", "done"]
var _phase := 0
var _mock_commit_t := 0   # tick counter; fire a mock commit every few cycles for the offline farm demo
var _mock_commit_n := 0   # mock commit number (for the message)

func _ready() -> void:
	_http = HTTPRequest.new()
	add_child(_http)
	_http.request_completed.connect(_on_request_completed)

# Pause/resume the live world poll (read-only multiplayer visit). While paused we emit no
# world_updated and skip the HTTP poll entirely; resuming clears the timer so the next poll fires soon.
func set_paused(paused: bool) -> void:
	_paused = paused
	if not paused:
		_t = poll_interval   # fire a fresh poll on the next frame so the live world snaps back

func _process(delta: float) -> void:
	if _paused:
		return
	_t += delta
	if _t < poll_interval:
		return
	_t = 0.0
	if MOCK_FEED:
		_phase = (_phase + 1) % _CYCLE.size()
		world_updated.emit(_mock_snapshot())
	else:
		# While in the down-sidecar fallback, keep the world alive on the mock feed AND keep probing
		# the real sidecar; the first successful poll clears the fallback (see _on_request_completed).
		if _using_mock_fallback:
			_phase = (_phase + 1) % _CYCLE.size()
			world_updated.emit(_mock_snapshot())
		_poll()

# --- Real poll ---------------------------------------------------------------
func _poll() -> void:
	if _inflight:
		return   # skip overlapping polls if the sidecar is slow; next tick retries
	_inflight = true
	var err := _http.request(SIDECAR_URL)
	if err != OK:
		_inflight = false   # connect failed (sidecar down)
		_note_poll_failure()

func _on_request_completed(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	_inflight = false
	if code != 200:
		_note_poll_failure()
		return
	var parsed = JSON.parse_string(body.get_string_from_utf8())
	if parsed is Dictionary:
		# A real snapshot arrived — we're connected. Clear any down-sidecar fallback and render it.
		_fail_count = 0
		_using_mock_fallback = false
		if _conn_state != 1:
			_conn_state = 1
			connection_changed.emit(true)
		world_updated.emit(parsed)
	else:
		_note_poll_failure()

# Count a failed/garbage poll; after FALLBACK_AFTER in a row, switch the world to the mock safety net.
func _note_poll_failure() -> void:
	_fail_count += 1
	if _fail_count >= FALLBACK_AFTER:
		_using_mock_fallback = true
		if _conn_state != 0:
			_conn_state = 0
			connection_changed.emit(false)

# --- Outbound commands (world_manager relays panel actions here) -------------

# POST the typed prompt to the agent's session. Fire-and-forget; the resulting
# state change shows up on the next /world poll. Uses a throwaway HTTPRequest so
# it never contends with the world poller's single in-flight slot.
func send_prompt(agent_id: String, prompt: String) -> void:
	if MOCK_FEED:
		return   # no sidecar in mock mode; the world keeps animating on its own
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(func(_r, _c, _h, _b): req.queue_free())
	var url := "%s/agents/%s/prompt" % [SIDECAR_HOST, agent_id]
	var headers := PackedStringArray(["Content-Type: application/json"])
	var payload := JSON.stringify({"prompt": prompt})
	var err := req.request(url, headers, HTTPClient.METHOD_POST, payload)
	if err != OK:
		req.queue_free()

# Voice is now handled NATIVELY in-engine: world_manager._on_panel_request_voice drives the
# VoiceWebSocket autoload (ported from a prior voice prototype: native mic -> ElevenLabs WS -> the sidecar
# custom-LLM shim brain). world_manager no longer routes the Talk button through this bridge, so
# this stays a harmless no-op kept only for backward compatibility / the demoted browser path.
func request_voice(_agent_id: String) -> void:
	pass

# --- Diff / approve / merge (Track D actions, relayed; sidecar owns the endpoints) ----

# Fetch the agent's real git diff (A's GET /agents/:id/diff) and hand the text back via cb,
# called as cb.call(agent_id, diff_text). MOCK mode returns a small fake diff so the 2D
# DiffView is demoable offline.
func fetch_diff(agent_id: String, cb: Callable) -> void:
	if MOCK_FEED:
		cb.call(agent_id, _mock_diff(agent_id))
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(_on_diff_response.bind(req, agent_id, cb))
	var url := "%s/agents/%s/diff" % [SIDECAR_HOST, agent_id]
	if req.request(url) != OK:
		req.queue_free()
		cb.call(agent_id, "")

func _on_diff_response(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, req: HTTPRequest, agent_id: String, cb: Callable) -> void:
	var text := ""
	if code == 200:
		var parsed = JSON.parse_string(body.get_string_from_utf8())
		if parsed is Dictionary:
			text = String(parsed.get("diff", ""))
		else:
			text = body.get_string_from_utf8()
	cb.call(agent_id, text)
	req.queue_free()

# --- Session verbs (Track A character-session model; relayed from D's SessionBar) ----
# POST /agents/:id/new-session -> 200 { character_id, session_id }. Archives the live chat
# and brings up a fresh Claude run. On 200, cb.call(agent_id) so B can clear the card to a
# fresh chat (Hud.session_started). MOCK mode just fires cb so the card clears offline.
func new_session(agent_id: String, cb: Callable) -> void:
	if MOCK_FEED:
		print("[bridge] new_session(%s) MOCK -> firing cb immediately" % agent_id)
		cb.call(agent_id)
		return
	var req := HTTPRequest.new()
	add_child(req)
	var url := "%s/agents/%s/new-session" % [SIDECAR_HOST, agent_id]
	# Log the round-trip so a runtime silence (sidecar down / non-200) is VISIBLE, not silent.
	# On 200 we fire cb (Hud.session_started clears the card); any other code logs why nothing cleared.
	req.request_completed.connect(func(result, code, _h, _b):
		if code == 200:
			print("[bridge] new_session(%s) 200 -> firing cb (card clears)" % agent_id)
			cb.call(agent_id)
		else:
			push_warning("[bridge] new_session(%s) FAILED result=%d code=%d (card NOT cleared) url=%s" % [agent_id, result, code, url])
		req.queue_free())
	var headers := PackedStringArray(["Content-Type: application/json"])
	var err := req.request(url, headers, HTTPClient.METHOD_POST, "{}")
	if err != OK:
		push_warning("[bridge] new_session(%s) request() could not start err=%d (sidecar unreachable?) url=%s" % [agent_id, err, url])
		req.queue_free()

# POST /agents/:id/send-away -> 200 { character_id, was_active }. Archives the active session
# and puts the character to sleep at home. Fire-and-forget; the asleep state shows on the next poll.
func send_away(agent_id: String) -> void:
	_post("/agents/%s/send-away" % agent_id)

# GET /agents/:id/sessions -> SessionSummary[] (newest first). Hand the decoded array back via
# cb.call(agent_id, sessions). MOCK mode returns a small fake history so D's History panel is
# demoable offline.
func fetch_sessions(agent_id: String, cb: Callable) -> void:
	if MOCK_FEED:
		cb.call(agent_id, _mock_sessions(agent_id))
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(_on_sessions_response.bind(req, agent_id, cb))
	var url := "%s/agents/%s/sessions" % [SIDECAR_HOST, agent_id]
	if req.request(url) != OK:
		req.queue_free()
		cb.call(agent_id, [])

func _on_sessions_response(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, req: HTTPRequest, agent_id: String, cb: Callable) -> void:
	var sessions: Array = []
	if code == 200:
		var parsed = JSON.parse_string(body.get_string_from_utf8())
		if parsed is Array:
			sessions = parsed
	cb.call(agent_id, sessions)
	req.queue_free()

# View an archived session's transcript. GET /agents/:id/sessions/:session_id/transcript ->
# SessionTranscript { agent_id, session_id, started_at, ended_at, limit, lines: TranscriptLine[] }
# where TranscriptLine = { ts, role, text }. We hand the decoded lines back via
# cb.call(agent_id, session_id, lines) so the Hud's read-only transcript view shows the REAL
# archived chat (each line rendered "role: text"), not a one-line summary. MOCK mode returns a
# small fake multi-line transcript so D's History view is demoable offline.
func fetch_session_transcript(agent_id: String, session_id: String, cb: Callable) -> void:
	if MOCK_FEED:
		cb.call(agent_id, session_id, _mock_transcript(agent_id, session_id))
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(_on_transcript_response.bind(req, agent_id, session_id, cb))
	var url := "%s/agents/%s/sessions/%s/transcript" % [SIDECAR_HOST, agent_id, session_id]
	if req.request(url) != OK:
		req.queue_free()
		cb.call(agent_id, session_id, [])

func _on_transcript_response(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, req: HTTPRequest, agent_id: String, session_id: String, cb: Callable) -> void:
	var lines: Array = []
	if code == 200:
		var parsed = JSON.parse_string(body.get_string_from_utf8())
		if parsed is Dictionary:
			var raw = parsed.get("lines", [])
			if raw is Array:
				lines = _format_transcript_lines(raw)
	cb.call(agent_id, session_id, lines)
	req.queue_free()

# TranscriptLine[] ({ts, role, text}) -> the Array[String] shape the Hud's read-only transcript
# view wants (same shape as AgentView.transcript_tail). Prefix each line with its role so a
# user/agent/tool turn reads at a glance; a bare string element is passed through unchanged.
func _format_transcript_lines(raw: Array) -> Array:
	var out: Array = []
	for ln in raw:
		if ln is Dictionary:
			var role := String(ln.get("role", ""))
			var text := String(ln.get("text", ""))
			if text == "":
				continue
			out.append("%s: %s" % [role, text] if role != "" else text)
		elif ln != null:
			out.append(String(ln))
	return out

func _mock_transcript(_agent_id: String, _session_id: String) -> Array:
	return [
		"user: set up the auth module",
		"agent: reading auth.ts",
		"tool: Edit auth.ts",
		"agent: added a login handler and a health endpoint",
	]

func _mock_sessions(agent_id: String) -> Array:
	return [
		{"session_id": "live", "character_id": agent_id, "summary": "(active chat)", "started_at": "", "ended_at": null},
		{"session_id": "s2", "character_id": agent_id, "summary": "added a health endpoint", "started_at": "", "ended_at": "2026-06-25T10:00:00Z"},
		{"session_id": "s1", "character_id": agent_id, "summary": "set up the auth module", "started_at": "", "ended_at": "2026-06-24T09:00:00Z"},
	]

# --- Multiplayer world browser (Lane D; sidecar owns /worlds + /worlds/:id) ----

# GET /worlds -> { you, you_owner_code, worlds: WorldSummary[] } (the multiplayer directory).
# Hand the decoded payload back via cb.call(payload) so the Hud's WorldBrowser renders rows +
# the "mine vs theirs" identity line. MOCK mode returns a small fake directory so the browser is
# demoable with NO sidecar / NO Aiven (mirrors fetch_diff / fetch_sessions offline fallbacks).
func fetch_worlds(cb: Callable) -> void:
	if MOCK_FEED:
		cb.call(_mock_worlds())
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(_on_worlds_response.bind(req, cb))
	if req.request(SIDECAR_HOST + "/worlds") != OK:
		req.queue_free()
		cb.call(_mock_worlds())   # sidecar unreachable -> keep the browser demoable, never blank

func _on_worlds_response(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, req: HTTPRequest, cb: Callable) -> void:
	var payload = {}
	if code == 200:
		var parsed = JSON.parse_string(body.get_string_from_utf8())
		if parsed is Dictionary or parsed is Array:
			payload = parsed
	else:
		payload = _mock_worlds()   # non-200 (e.g. Aiven off) -> fall back so the panel never hangs
	cb.call(payload)
	req.queue_free()

# GET /worlds/:id -> SharedWorldSnapshot (visit a world read-only; anonymized — no code/paths).
# Hand the decoded snapshot back via cb.call(world_id, snapshot). MOCK mode returns a small fake
# visited world so the read-only visit is demoable offline.
func fetch_world(world_id: String, cb: Callable) -> void:
	if MOCK_FEED:
		cb.call(world_id, _mock_visited_world(world_id))
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(_on_world_response.bind(req, world_id, cb))
	if req.request("%s/worlds/%s" % [SIDECAR_HOST, world_id]) != OK:
		req.queue_free()
		cb.call(world_id, _mock_visited_world(world_id))

func _on_world_response(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, req: HTTPRequest, world_id: String, cb: Callable) -> void:
	var snap = {}
	if code == 200:
		var parsed = JSON.parse_string(body.get_string_from_utf8())
		if parsed is Dictionary:
			snap = parsed
	else:
		snap = _mock_visited_world(world_id)
	cb.call(world_id, snap)
	req.queue_free()

func _mock_worlds() -> Dictionary:
	return {
		"you": "world-local",
		"you_owner_code": "you",
		"worlds": [
			{"world_id": "world-local", "owner_code": "you", "name": "Your World", "agent_count": 3, "last_seen": "", "online": true},
			{"world_id": "world-ada", "owner_code": "ada", "name": "Ada's Forge", "agent_count": 2, "last_seen": "", "online": true},
			{"world_id": "world-merlin", "owner_code": "merlin", "name": "Merlin's Tower", "agent_count": 1, "last_seen": "", "online": false},
		],
	}

# A fake SharedWorldSnapshot for offline visit. agents[] use SharedAgent's safe subset
# (no path/task/transcript) — exactly what a visited world is allowed to expose.
func _mock_visited_world(world_id: String) -> Dictionary:
	# agents[] carry an optional position {x,z}; plants[] carry coords + the commit message. This is
	# exactly the coord-bearing shape world_manager renders, so the visit-render (remote agents at
	# their real spots + their planted trees in LOCAL assets) is demoable with NO sidecar / NO Aiven.
	return {
		"world_id": world_id, "name": "Visited: %s" % world_id,
		"groups": [], "repos": [{"id": "web", "name": "web", "group_id": null}],
		"projects": [{"id": "web", "name": "web", "repo_id": "web"}],
		"agents": [
			{"agent_id": "v1", "label": "Guest-Viking", "character_kind": "viking", "state": "working", "repo_id": "web", "position": {"x": -6.0, "z": 4.0}},
			{"agent_id": "v2", "label": "Guest-Wizard", "character_kind": "wizard", "state": "waiting", "repo_id": "web", "position": {"x": 6.0, "z": -4.0}},
		],
		"plants": [
			{"repo_id": "web", "position": {"x": -3.0, "z": 8.0}, "message": "feat: visited commit #1"},
			{"repo_id": "web", "position": {"x": -1.3, "z": 8.0}, "message": "fix: visited commit #2"},
			{"repo_id": "web", "position": {"x": 0.4, "z": 8.0}, "message": "docs: visited commit #3"},
		],
	}

# Approve an agent's awaiting-review work; merge a project's reviewed work.
func approve(agent_id: String) -> void:
	_post("/agents/%s/approve" % agent_id)

func merge(project_id: String) -> void:
	_post("/projects/%s/merge" % project_id)

# Run an operator mission (Ada's Aiven beat — e.g. "world_pulse"): POST /operator/run {mission_id}.
func run_operator_mission(mission_id: String) -> void:
	if MOCK_FEED:
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(func(_r, _c, _h, _b): req.queue_free())
	var url := SIDECAR_HOST + "/operator/run"
	var headers := PackedStringArray(["Content-Type: application/json"])
	var payload := JSON.stringify({"mission_id": mission_id})
	if req.request(url, headers, HTTPClient.METHOD_POST, payload) != OK:
		req.queue_free()

# Fire-and-forget POST {} (approve / merge); no-op in MOCK mode.
func _post(path: String) -> void:
	if MOCK_FEED:
		return
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(func(_r, _c, _h, _b): req.queue_free())
	var url := SIDECAR_HOST + path
	if req.request(url, PackedStringArray(["Content-Type: application/json"]), HTTPClient.METHOD_POST, "{}") != OK:
		req.queue_free()

func _mock_diff(agent_id: String) -> String:
	return "diff --git a/auth.ts b/auth.ts\n@@ -1,3 +1,5 @@\n+// %s wrote a health endpoint\n+export function health() { return { ok: true } }\n function auth() {\n-  return false\n+  return true\n }\n" % agent_id

# --- Mock snapshot -----------------------------------------------------------
func _mock_snapshot() -> Dictionary:
	var s: String = _CYCLE[_phase]
	# Fire a mock commit for a1 every ~6 cycles so the commit->plant farm loop runs with no sidecar.
	_mock_commit_t += 1
	var evs := [{"ts": "", "type": "file_claimed", "agent_id": "a1", "detail": "auth.ts"}]
	if _mock_commit_t % 6 == 0:
		_mock_commit_n += 1
		evs.append({"ts": "", "type": "commit", "agent_id": "a1", "detail": "feat: commit #%d" % _mock_commit_n})
	return {
		"agents": [
			{
				"agent_id": "a1", "repo_id": "web", "repo_path": "/tmp/web",
				"character_kind": "viking", "state": s, "label": "Vinny",
				"status_line": "mock: %s" % s, "current_task": "add health endpoint",
				"target_base_id": "web", "heartbeat_age_s": 0,
				"transcript_tail": ["reading auth.ts", "writing handler"],
			},
			{
				"agent_id": "a2", "repo_id": "engine", "repo_path": "/tmp/engine",
				"character_kind": "wizard", "state": "blocked", "label": "Merlin",
				"status_line": "mock: blocked on lock: auth.ts", "current_task": "refactor auth",
				"target_base_id": "web", "heartbeat_age_s": 1,
				"transcript_tail": ["wanted auth.ts", "denied"],
			},
			{
				"agent_id": "a3", "repo_id": "templates", "repo_path": "/tmp/templates",
				"character_kind": "dwarf", "state": "waiting", "label": "Durin",
				"status_line": "mock: idle", "current_task": null,
				"target_base_id": null, "heartbeat_age_s": 0, "transcript_tail": [],
			},
		],
		"locks": [{"repo_path": "/tmp/web", "file_path": "auth.ts", "holder_agent_id": "a1", "claimed_at": ""}],
		"events": evs,
	}
