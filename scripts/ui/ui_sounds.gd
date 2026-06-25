extends RefCounted
# No class_name: consumers bind this via `const UiSounds := preload(...)` so it resolves
# by path. scripts/ui was authored on disk and is not in the editor's global class
# cache, so a global class_name would fail to resolve at load (preload always works).
# ============================================================================
#  UiSounds — THE SOUND BOARD (Chat D / The Interface).
#
#  The SINGLE source of truth for every 2D / UI sound in SummerCraft. Open this
#  ONE file and you see every sound the interface can make, what it is FOR, WHEN
#  it fires, and exactly where to drop the asset. Every other 2D component calls
#  `UiSounds.play("<key>")` at its interaction sites — no component ever loads or
#  plays audio itself. (World/3D SFX is B's `sfx.gd`; this is screen-space only.)
#
#  ── How it works ──────────────────────────────────────────────────────────
#  • Needs NO autoload registration. The first `play()` lazily bootstraps a tiny
#    pool of AudioStreamPlayer nodes parented to the scene-tree root
#    (Engine.get_main_loop().root), reused round-robin so there are ZERO
#    per-call allocations after warm-up and overlapping sounds don't cut off.
#  • Silent-safe: if the asset file is missing / unassigned, `play()` is a no-op.
#    ResourceLoader.exists() guards every load; missing audio NEVER errors or
#    spams the console — Mathias can ship with zero assets and add them later.
#  • Streams are cached after first resolve (no repeat disk hits, even for the
#    known-missing case which caches `null`).
#
#  ── For Mathias: adding a sound ─────────────────────────────────────────────
#  Drop an .ogg at the `path` shown for each key below (res://audio/ui/<key>.ogg).
#  That's it — no code change. To rename/redirect, edit the `path` in EVENTS.
#  Pitch can be nudged per call site: UiSounds.play("click", 1.08).
# ============================================================================

# Where every UI sound asset lives. Mathias drops <key>.ogg here.
const DIR := "res://audio/ui/"

# ── THE EVENTS TABLE — every UI sound, its purpose, and when it fires ────────
# key -> { path, doc }.  `doc` states PURPOSE and WHEN IT FIRES so this file is
# self-documenting. Callers reference ONLY these string keys.
const EVENTS := {
	"click":         { "path": DIR + "click.ogg",
		"doc": "Primary button press — Send / Diff / tab / any committing tap. The workhorse click." },
	"hover":         { "path": DIR + "hover.ogg",
		"doc": "Pointer enters an interactive control (button/chip/tab). Soft, very quiet; fires a lot." },
	"select":        { "path": DIR + "select.ogg",
		"doc": "A fleet chip / agent is selected and its card opens. The satisfying 'I picked this one' tap." },
	"panel_open":    { "path": DIR + "panel_open.ogg",
		"doc": "The agent card (or a tray) slides into view. Pairs with Juice.slide_in / pop." },
	"panel_close":   { "path": DIR + "panel_close.ogg",
		"doc": "The agent card / tray is dismissed (close button, deselect)." },
	"send":          { "path": DIR + "send.ogg",
		"doc": "A typed prompt is submitted to an agent (Send button or Enter in the input)." },
	"approve":       { "path": DIR + "approve.ogg",
		"doc": "An awaiting-review item is approved (card or roster or pending-tray ✓). Positive, confirming." },
	"reject":        { "path": DIR + "reject.ogg",
		"doc": "An awaiting-review item is rejected / sent back in the pending tray. Soft negative, not harsh." },
	"merge":         { "path": DIR + "merge.ogg",
		"doc": "The town-hall MERGE RITUAL is triggered for a project (pending tray / card Merge). Big + ceremonial." },
	"tab_switch":    { "path": DIR + "tab_switch.ogg",
		"doc": "The active project/overview tab changes. Lighter than 'click'; a quick flick." },
	"state_working": { "path": DIR + "state_working.ogg",
		"doc": "An agent transitions INTO the working state (chip/card pulse). The 'it started moving' tick." },
	"done_cheer":    { "path": DIR + "done_cheer.ogg",
		"doc": "An agent finishes — transitions to done/REVIEW. Celebratory chime; pairs with Juice.done_cheer." },
	"blocked":       { "path": DIR + "blocked.ogg",
		"doc": "An agent becomes blocked (lost a lock). A lock 'thunk'; pairs with Juice.lock_slam." },
	"dive_in":       { "path": DIR + "dive_in.ogg",
		"doc": "The first-person dive begins (enter_dive). Cinematic whoosh as the 2D shifts to conversation." },
	"dive_out":      { "path": DIR + "dive_out.ogg",
		"doc": "The dive ends (exit_dive / Leave). Reverse whoosh back to the command center." },
	"caption_tick":  { "path": DIR + "caption_tick.ogg",
		"doc": "A new voice caption line lands in the dive caption history. Tiny, subtle typewriter tick." },
	"error":         { "path": DIR + "error.ogg",
		"doc": "A surfaced error (ServerEvent error / failed action). Low, non-alarming notice." },
}

# ── Pool config (allocation-light) ──────────────────────────────────────────
const _POOL_SIZE := 6
# Preferred bus so UI sound can be mixed/ducked independently (the point of a sound
# board). Falls back to "Master" when no "UI" bus exists — so this is live, not dead:
# Mathias can add a "UI" bus in the audio layout later with zero code change, and
# until then everything routes to Master. (project.godot is off-limits to this lane.)
const _BUS := "UI"
# Guard rail for pitch so a bad call site can never produce a silent/garbled clip.
const _PITCH_MIN := 0.1
const _PITCH_MAX := 4.0

# Process-wide singletons (RefCounted is never instanced; all state is static).
static var _players: Array[AudioStreamPlayer] = []
static var _next := 0
static var _cache := {}            # key -> AudioStream (or null when known-missing)
static var _booted := false

# ── play(): the ONLY entry point every component calls ──────────────────────
# Silent no-op when the asset is missing or the key is unknown. `pitch` lets a
# call site vary feel (e.g. ascending taps) without new assets. Never errors.
static func play(event: String, pitch: float = 1.0) -> void:
	var stream := _stream_for(event)
	if stream == null:
		return  # unknown key or missing asset — stay silent.
	var p := _next_player()
	if not is_instance_valid(p):
		# Tree not ready yet (pre-_ready) OR the pooled player was freed (e.g. root
		# torn down on quit). Re-arm the pool so a later play() rebuilds it instead of
		# erroring on a dangling instance.
		if p != null:
			_booted = false
			_players.clear()
		return
	p.stream = stream
	p.pitch_scale = clampf(pitch, _PITCH_MIN, _PITCH_MAX)
	p.play()

# Resolve the asset path for a key (or "" if the key is unknown). Lets callers /
# tooling verify a sound exists without playing it.
static func path_for(event: String) -> String:
	if EVENTS.has(event):
		return String(EVENTS[event]["path"])
	return ""

# True when an asset file is actually present on disk for this key. Components can
# branch on this if they want to skip Juice that's meant to land with a sound.
static func has_asset(event: String) -> bool:
	var path := path_for(event)
	if path.is_empty():
		return false
	return ResourceLoader.exists(path, "AudioStream")

# ── internals ───────────────────────────────────────────────────────────────

# Resolve (and cache) the AudioStream for a key. Caches `null` for unknown keys
# and known-missing assets so a missing sound costs one disk check, ever.
static func _stream_for(event: String) -> AudioStream:
	if _cache.has(event):
		return _cache[event]  # may be null (known-missing) — that's intentional.
	var stream: AudioStream = null
	var path := path_for(event)
	if not path.is_empty() and ResourceLoader.exists(path, "AudioStream"):
		var res := ResourceLoader.load(path, "AudioStream")
		if res is AudioStream:
			stream = res
	_cache[event] = stream
	return stream

# Grab the next round-robin player, bootstrapping the pool on first use.
static func _next_player() -> AudioStreamPlayer:
	if not _booted:
		_ensure_pool()
	if _players.is_empty():
		return null
	var p := _players[_next]
	_next = (_next + 1) % _players.size()
	return p

# Lazily create the AudioStreamPlayer pool under the scene-tree root. Idempotent.
# Needs NO autoload — bootstraps on first play(). If the tree isn't up yet it
# leaves the pool empty (and unbooted) so a later play() retries.
static func _ensure_pool() -> void:
	var loop := Engine.get_main_loop()
	if loop == null or not (loop is SceneTree):
		return  # headless / not ready — try again next play().
	var root: Window = (loop as SceneTree).root
	if root == null:
		return
	var bus := _BUS if AudioServer.get_bus_index(_BUS) != -1 else "Master"
	for i in _POOL_SIZE:
		var p := AudioStreamPlayer.new()
		p.name = "UiSoundPlayer_%d" % i
		p.bus = bus
		# Survive scene changes so a one-off UI tick never gets cut by a reload.
		p.process_mode = Node.PROCESS_MODE_ALWAYS
		root.add_child(p)
		_players.append(p)
	_booted = true
