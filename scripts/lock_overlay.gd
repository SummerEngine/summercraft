extends Node3D
class_name LockOverlay
# AgentCraft — Aiven coordination overlay (Track D, plan §7 Phase 3).
#
# A code-built billboard that renders the visible side of agent coordination:
#   - a TASK CHIP (the agent's current_task / status line) floating above the character
#   - a floating "LOCKED: <file>" tag over a contested base when a file_locks row is held there
#
# Built entirely in code (Label3D only), no texture/scene import — mirrors the billboard approach
# in health_bar.gd so it can never slide off-camera. The Godot game holds NO Aiven creds: this
# overlay is driven purely by the /world snapshot the sidecar projects.
#
# GREY TINT OWNERSHIP (read before re-adding any material_overlay code here):
#   The grey tint for a blocked/stale agent is NOT this file's job. Track B's scripts/agent.gd
#   OWNS the agent body's single MeshInstance3D.material_overlay slot — its _apply_tint() drives
#   that one slot with priority logic (selection-gold > blocked-grey > clear). Godot has exactly
#   ONE material_overlay slot per MeshInstance3D, so two writers cannot share it: if this overlay
#   also wrote it, the selection highlight would break and un-blocking would null out agent.gd's
#   overlay entirely. So lock_overlay does the chip + LOCKED tag only (both unique, non-conflicting)
#   and merely recolours its OWN chip when blocked. set_blocked() takes the flag so the chip can
#   reflect it, but writes no material_overlay.
#
# OWNERSHIP: Track D owns this file. world_manager.gd (Track B) instances one LockOverlay per agent
# and per building and feeds it from the polled snapshot via the public API below:
#   - set_chip(text)                         # current task / status chip
#   - set_locked(file_path)  / clear_lock()  # the "LOCKED: <file>" tag (call on the building)
#   - set_blocked(is_blocked)                # recolour the chip for the blocked/stale loser (chip only — tint is agent.gd's)
#   - apply_agent(agent_dict)                # convenience: drive chip + blocked-chip from one /world agent
#   - apply_lock(lock_dict_or_null)          # convenience: drive the LOCKED tag from one /world lock

@export var chip_height: float = 2.8       # local Y of the task chip above the unit origin
@export var lock_height: float = 3.7       # local Y of the LOCKED tag (sits above the chip)
@export var chip_font_size: int = 34       # raster quality only; on-screen size is pixel_size (fixed_size labels)
@export var lock_font_size: int = 56

# Hard caps so the chip can NEVER render as a screen-spanning sentence. The chip is a tiny
# state tag, not a log line: we truncate to CHIP_MAX_CHARS, word-wrap inside CHIP_WIDTH px,
# and DROP noisy operator/lock telemetry ("op world_pulse succeeded", "stale 1490s blocked…")
# entirely — those are sidecar log strings, not something to float across the field.
const CHIP_MAX_CHARS := 32
const CHIP_WIDTH := 320.0
# Lowercased substrings that mark a status line as noisy telemetry rather than a task.
const CHIP_NOISE := ["op ", " succeeded", " failed", "world_pulse", "stale ", "heartbeat", "lock acquired", "lock released", "blocked on", "poll "]
# CRITICAL (fixed_size billboards): on-screen size = font_size * pixel_size * proj. The default
# pixel_size 0.01 with font_size ~64 made each label ~2.0 NDC tall = the WHOLE viewport (the
# "ENORMOUS text drowning the scene" bug). With fixed_size=true a label must use a TINY pixel_size.
# At FOV 40 (proj[1][1]~2.75): chip 48*0.0004*2.75 ~= 0.053 NDC (~28px tall); lock 56*0.00045*2.75
# ~= 0.069 NDC (~37px). Small crisp floating labels — never screen-filling.
@export var chip_pixel_size: float = 0.0004
@export var lock_pixel_size: float = 0.00045

const COLOR_CHIP := Color(0.92, 0.94, 1.0, 0.96)
const COLOR_CHIP_BLOCKED := Color(0.62, 0.64, 0.70, 0.96)
const COLOR_LOCK := Color(1.0, 0.78, 0.26, 1.0)        # warm amber — reads as "claimed"
const COLOR_LOCK_OUTLINE := Color(0.15, 0.10, 0.0, 1.0)

var _chip: Label3D
var _lock: Label3D
var _blocked: bool = false

func _ready() -> void:
	_build_chip()
	_build_lock()

# --- construction -----------------------------------------------------------

func _build_chip() -> void:
	_chip = _make_label(chip_font_size, chip_pixel_size, COLOR_CHIP, chip_height)
	_chip.outline_size = 6
	_chip.outline_modulate = Color(0.05, 0.06, 0.10, 0.85)
	# Cap the chip's world footprint: wrap inside a fixed width so a long task line
	# breaks onto a second line instead of stretching across the whole field.
	_chip.width = CHIP_WIDTH
	_chip.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_chip.visible = false
	add_child(_chip)

func _build_lock() -> void:
	_lock = _make_label(lock_font_size, lock_pixel_size, COLOR_LOCK, lock_height)
	_lock.outline_size = 8
	_lock.outline_modulate = COLOR_LOCK_OUTLINE
	_lock.visible = false
	add_child(_lock)

func _make_label(font_size: int, pixel_size: float, color: Color, y: float) -> Label3D:
	var l := Label3D.new()
	l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	l.no_depth_test = true                       # always draw over the world geometry
	l.fixed_size = true                          # constant pixel size regardless of camera distance
	l.pixel_size = pixel_size                    # MUST be tiny with fixed_size — see header note
	l.font_size = font_size
	l.modulate = color
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	l.position.y = y
	l.render_priority = 4
	l.outline_render_priority = 3
	return l

# --- public API (Track B calls these from the /world poll) ------------------

# Task chip text (the agent's current task / status line). Empty hides it.
# Noisy operator/lock telemetry is dropped and anything long is truncated so the
# chip stays a tiny state tag — never a screen-spanning sentence (see _clean_chip).
func set_chip(text: String) -> void:
	if _chip == null:
		return
	var t := _clean_chip(text)
	_chip.text = t
	_chip.visible = t != ""
	_chip.modulate = COLOR_CHIP_BLOCKED if _blocked else COLOR_CHIP

# Reduce an arbitrary status/task line to a short, clean chip:
#   - drop noisy operator/lock log strings entirely (returns "" -> chip hidden)
#   - collapse whitespace and hard-truncate to CHIP_MAX_CHARS with an ellipsis
func _clean_chip(text: String) -> String:
	var t := text.strip_edges()
	if t == "":
		return ""
	var low := t.to_lower()
	for noise in CHIP_NOISE:
		if low.find(noise) != -1:
			return ""
	# Collapse any internal newlines/runs of whitespace to single spaces.
	t = " ".join(t.split("\n", false))
	if t.length() > CHIP_MAX_CHARS:
		t = t.substr(0, CHIP_MAX_CHARS).strip_edges() + "…"
	return t

# Show the floating "LOCKED: <file>" tag (call on the contested BASE/building).
func set_locked(file_path: String) -> void:
	if _lock == null:
		return
	var f := file_path.strip_edges()
	if f == "":
		clear_lock()
		return
	_lock.text = "🔒 LOCKED: %s" % f.get_file()  # show just the filename so the tag stays short
	_lock.visible = true

func clear_lock() -> void:
	if _lock != null:
		_lock.visible = false

# Mark a blocked/stale agent (the loser of an Aiven lock race). This recolours the
# task CHIP only — the agent body's grey tint is owned by Track B's agent.gd (_apply_tint),
# which holds the single MeshInstance3D.material_overlay slot and resolves selection-vs-blocked
# priority. We must NOT touch material_overlay here or we'd stomp that slot (see header note).
func set_blocked(is_blocked: bool) -> void:
	_blocked = is_blocked
	if _chip != null and _chip.visible:
		_chip.modulate = COLOR_CHIP_BLOCKED if is_blocked else COLOR_CHIP

# Convenience: drive chip + blocked-chip straight from one /world `agents[]` entry.
# `state` of "blocked" (or a stale heartbeat >15s) recolours the chip; the body grey tint
# for the same condition is agent.gd's job (see set_blocked / header note).
func apply_agent(agent: Dictionary) -> void:
	var state := String(agent.get("state", "waiting"))
	var hb := float(agent.get("heartbeat_age_s", 0.0))
	var task := String(agent.get("current_task", "")) if agent.get("current_task") != null else ""
	var status := String(agent.get("status_line", ""))
	var chip := task if task != "" else status
	var blocked := state == "blocked" or hb > 15.0
	set_blocked(blocked)
	set_chip(chip)

# Convenience: drive the LOCKED tag from one /world `locks[]` entry (or null to clear).
func apply_lock(lock) -> void:
	if lock == null or typeof(lock) != TYPE_DICTIONARY:
		clear_lock()
		return
	set_locked(String((lock as Dictionary).get("file_path", "")))
