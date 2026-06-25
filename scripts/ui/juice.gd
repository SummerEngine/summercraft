extends RefCounted
# No class_name: consumers bind this via `const Juice := preload(...)` so it resolves
# by path. scripts/ui was authored on disk and is not in the editor's global class
# cache, so a global class_name would fail to resolve at load (preload always works).
# ============================================================================
#  Juice — 2D motion helpers (Chat D / The Interface).
#
#  The SINGLE source of truth for how the command-center MOVES. Nothing in the
#  HUD snaps: chips pop in, state changes pulse, `done` cheers, locks slam, the
#  dive whooshes. Every D component calls these instead of hand-rolling tweens,
#  so the feel is coherent and tunable from one place. Pairs 1:1 with UiSounds —
#  the convention is "Juice.x() for the motion, UiSounds.play() for the sound" at
#  the same call site (Juice never plays audio itself).
#
#  ── Allocation discipline ────────────────────────────────────────────────────
#  Helpers are static and take the Node they animate; the tween is created on
#  that node's tree and auto-frees when done — no retained per-frame allocations,
#  nothing to clean up. Safe to call on every state change on the 1s poll.
#  Transforms animate `scale` around a centered `pivot_offset` (never `size` /
#  position rect) so layout is untouched and there is no reflow / flicker.
#
#  ── Reduced motion ───────────────────────────────────────────────────────────
#  `reduced_motion` is the master accessibility flag. When true, every helper
#  applies the END state instantly (no tween) so the UI is fully legible/usable
#  with zero animation — for projector glare, motion sensitivity, or debugging.
#  SummerUI / settings read+set this; Juice is the one place motion is gated.
# ============================================================================

# Master switch. Set by settings; read by every helper. (Static field, shared
# process-wide without an autoload.)
static var reduced_motion := false

# ── Durations (one place to tune the whole HUD's tempo) ─────────────────────
const POP_TIME    := 0.22   # spawn / appear
const PULSE_TIME  := 0.16   # state change tick
const SLIDE_TIME  := 0.26   # panel / tray slide-in
const FLASH_TIME  := 0.30   # attention flash fade
const CHEER_TIME  := 0.40   # done celebration
const SLAM_TIME   := 0.18   # lock slam
const BOB_TIME    := 1.40   # idle bob loop half-cycle

# Warm + danger tints used by the celebratory / alarm helpers (kept in sync with
# SummerUI.ACCENT_HI / SummerUI.DANGER; duplicated here to avoid a hard dependency
# on theme load order in headless parse).
const _CHEER_TINT := Color(1.00, 0.80, 0.42)
const _SLAM_TINT  := Color(0.95, 0.42, 0.40)

# Meta key under which a node stores its current Juice tween, so a re-trigger kills
# the in-flight one instead of STACKING a second tween that fights over the same
# property. Critical because pulse/flash/cheer/slam fire on every state transition
# on the 1s poll — without this, rapid re-triggers leave the node mid-animation with
# two tweens racing (visible jitter, and a node can settle at the wrong scale/tint).
# One meta slot per node (not per frame); freed with the node. We key by family so a
# scale animation and a modulate animation on the same node don't cancel each other.
const _TW_SCALE := "_juice_tw_scale"
const _TW_MOD   := "_juice_tw_mod"
const _TW_POS   := "_juice_tw_pos"

# Kill any in-flight Juice tween stored under `key` on `node`, then create + store a
# fresh one. Allocation is one meta write per call (no per-frame cost). The stored
# tween auto-frees when it finishes; we only ever pre-empt a still-running one.
static func _retween(node: Object, key: String) -> Tween:
	if node.has_meta(key):
		var prev: Tween = node.get_meta(key)
		if prev != null and prev.is_valid():
			prev.kill()
	var tw := (node as Node).create_tween()
	node.set_meta(key, tw)
	return tw

# Resolve the modulate to settle BACK to for a cheer/slam, and pre-empt anything
# already animating modulate so the tint flash isn't fought. A cheer/slam overwrites
# `node.modulate` with its tint, so we must read rest BEFORE that. If a cheer/slam (or
# a flash) is already in flight, `node.modulate` is mid-tween — reading it would drift
# the node off its true color on repeated triggers — so we reuse the stored rest. Kills
# any in-flight flash so its modulate leg can't race the cheer/slam's modulate leg.
static func _settle_rest(node: Object) -> Color:
	var rest: Color = (node as CanvasItem).modulate
	var key := _TW_SCALE + "_rest"
	var animating := false
	if node.has_meta(_TW_SCALE):
		var prev: Tween = node.get_meta(_TW_SCALE)
		animating = prev != null and prev.is_valid()
	if animating and node.has_meta(key):
		rest = node.get_meta(key)
	# A concurrent flash owns _TW_MOD; cancel it so two tweens don't write modulate.
	if node.has_meta(_TW_MOD):
		var fl: Tween = node.get_meta(_TW_MOD)
		if fl != null and fl.is_valid():
			fl.kill()
	node.set_meta(key, rest)
	return rest

# ── pop ─────────────────────────────────────────────────────────────────────
# Appear with a scale-up + fade-in (back-ease overshoot). Use when a node first
# enters the scene (a new roster chip, a card opening). Pivot is centered so the
# scale grows from the middle and layout never shifts.
static func pop(node: Control, time: float = POP_TIME) -> void:
	if not is_instance_valid(node):
		return
	if reduced_motion:
		_center_pivot(node)
		node.scale = Vector2.ONE
		node.modulate.a = 1.0
		return
	# Pre-set the start state immediately so there's no first-frame flash at full
	# size, but DEFER the pivot+tween one frame for a freshly-parented node whose
	# container hasn't sized it yet (size == 0 => pivot would be top-left and the
	# scale would grow from the corner). Once sized, the pivot is centered.
	node.scale = Vector2(0.86, 0.86)
	node.modulate.a = 0.0
	if node.size == Vector2.ZERO:
		_run_deferred_spawn(node, _pop_run.bind(node, time))
	else:
		_pop_run(node, time)

static func _pop_run(node: Control, time: float) -> void:
	if not is_instance_valid(node):
		return
	_center_pivot(node)
	var tw := _retween(node, _TW_SCALE).set_parallel(true)
	tw.tween_property(node, "scale", Vector2.ONE, time) \
		.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "modulate:a", 1.0, time * 0.8)

# ── pulse ─────────────────────────────────────────────────────────────────────
# A quick scale bump back to rest — the "something just changed here" tick. Use
# on a chip/pill when its state flips (e.g. -> working). Non-destructive to layout.
static func pulse(node: Control, strength: float = 1.06, time: float = PULSE_TIME) -> void:
	if not is_instance_valid(node):
		return
	_center_pivot(node)
	if reduced_motion:
		node.scale = Vector2.ONE
		return
	node.scale = Vector2.ONE
	var tw := _retween(node, _TW_SCALE)
	tw.tween_property(node, "scale", Vector2(strength, strength), time * 0.4) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "scale", Vector2.ONE, time * 0.6) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN)

# ── slide_in ──────────────────────────────────────────────────────────────────
# Slide a panel in from an edge while fading up. `from` is a pixel offset applied
# to position at the start (e.g. Vector2(0, 40) = rises from below). Use for the
# agent card and the pending tray. Animates position back to its laid-out spot.
static func slide_in(node: Control, from: Vector2, time: float = SLIDE_TIME) -> void:
	if not is_instance_valid(node):
		return
	var rest := node.position
	if reduced_motion:
		node.position = rest
		node.modulate.a = 1.0
		return
	node.position = rest + from
	node.modulate.a = 0.0
	var tw := _retween(node, _TW_POS).set_parallel(true)
	tw.tween_property(node, "position", rest, time) \
		.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "modulate:a", 1.0, time * 0.7)

# ── flash ─────────────────────────────────────────────────────────────────────
# Briefly tint a node toward `color` then back to normal — draw the eye without
# moving layout. Use to highlight a freshly-arrived diff or an errored row.
static func flash(node: CanvasItem, color: Color, time: float = FLASH_TIME) -> void:
	if not is_instance_valid(node):
		return
	# Return to the node's CURRENT modulate, not a hardcoded WHITE — a stale chip is
	# dimmed via modulate (INTERFACES §2) and a row may carry a tint; flashing must
	# not silently un-dim / recolor it. Under reduced_motion we leave it untouched.
	if reduced_motion:
		return
	# A cheer/slam animates `modulate` on the _TW_SCALE slot; if one is mid-flight,
	# kill that leg first so modulate has a SINGLE owner (mirrors _settle_rest killing
	# our _TW_MOD leg). It stashed the TRUE base color under _TW_SCALE+"_rest" — prefer
	# that over node.modulate (a partial mid-cheer tint) so flash returns to base.
	var rest: Color = node.modulate
	if node.has_meta(_TW_SCALE):
		var cheer: Tween = node.get_meta(_TW_SCALE)
		if cheer != null and cheer.is_valid():
			if node.has_meta(_TW_SCALE + "_rest"):
				rest = node.get_meta(_TW_SCALE + "_rest")
			cheer.kill()
	# If a flash is already mid-fade, node.modulate is partway between `color` and rest;
	# reuse the stored _TW_MOD rest instead of capturing the drifted value so repeated
	# flashes converge on the true base color.
	if node.has_meta(_TW_MOD):
		var prev: Tween = node.get_meta(_TW_MOD)
		if prev != null and prev.is_valid() and node.has_meta(_TW_MOD + "_rest"):
			rest = node.get_meta(_TW_MOD + "_rest")
	node.set_meta(_TW_MOD + "_rest", rest)
	node.modulate = color
	var tw := _retween(node, _TW_MOD)
	tw.tween_property(node, "modulate", rest, time) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)

# ── done_cheer ────────────────────────────────────────────────────────────────
# The celebration when an agent finishes (state -> done/REVIEW): a pop overshoot
# plus a warm accent flash. The signature "it's ready for review" beat.
# Pair with UiSounds.play("done_cheer").
static func done_cheer(node: Control) -> void:
	if not is_instance_valid(node):
		return
	if reduced_motion:
		_center_pivot(node)
		node.scale = Vector2.ONE
		return
	# Capture the node's rest modulate to return to (NOT WHITE) so a dimmed/tinted
	# chip keeps its base color after the cheer; flash the tint at the rest alpha so
	# we never punch a faded chip back to full opacity.
	var rest := _settle_rest(node)
	node.scale = Vector2(0.92, 0.92)
	node.modulate = Color(_CHEER_TINT.r, _CHEER_TINT.g, _CHEER_TINT.b, rest.a)
	if node.size == Vector2.ZERO:
		_run_deferred_spawn(node, _cheer_run.bind(node, rest))
	else:
		_cheer_run(node, rest)

static func _cheer_run(node: Control, rest: Color) -> void:
	if not is_instance_valid(node):
		return
	_center_pivot(node)
	var tw := _retween(node, _TW_SCALE).set_parallel(true)
	tw.tween_property(node, "scale", Vector2.ONE, CHEER_TIME) \
		.set_trans(Tween.TRANS_ELASTIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "modulate", rest, CHEER_TIME) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)

# ── lock_slam ─────────────────────────────────────────────────────────────────
# A hard, weighty slam for when an agent gets BLOCKED on a lock: starts large (1.08)
# and snaps down past 1.0 with a back-ease (TRANS_BACK / EASE_IN undershoots below
# 1.0) then settles, plus a danger-tinted flash. Pair with UiSounds.play("blocked").
# Heavier and snappier than pulse. Start scale kept at 1.08 (not higher) so a chip in
# a tight roster VBox at portrait 720x1280 doesn't visibly collide with its neighbours.
static func lock_slam(node: Control) -> void:
	if not is_instance_valid(node):
		return
	if reduced_motion:
		_center_pivot(node)
		node.scale = Vector2.ONE
		return
	var rest := _settle_rest(node)
	node.scale = Vector2(1.08, 1.08)
	node.modulate = Color(_SLAM_TINT.r, _SLAM_TINT.g, _SLAM_TINT.b, rest.a)
	if node.size == Vector2.ZERO:
		_run_deferred_spawn(node, _slam_run.bind(node, rest))
	else:
		_slam_run(node, rest)

static func _slam_run(node: Control, rest: Color) -> void:
	if not is_instance_valid(node):
		return
	_center_pivot(node)
	var tw := _retween(node, _TW_SCALE).set_parallel(true)
	tw.tween_property(node, "scale", Vector2.ONE, SLAM_TIME) \
		.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_IN)
	tw.tween_property(node, "modulate", rest, SLAM_TIME * 2.0) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)

# Meta keys stored ON the bob Tween itself so stop(tw) can restore the node to its
# laid-out y on kill (the Tween is the only handle a caller keeps). Without this a
# bob killed mid-cycle leaves the node frozen up to `amplitude` px off rest, and a
# later re-bob captures that offset as its NEW rest → cumulative upward drift.
const _BOB_NODE := "_juice_bob_node"
const _BOB_REST := "_juice_bob_rest"

# ── idle_bob ──────────────────────────────────────────────────────────────────
# A gentle, looping vertical bob so a resting element is never dead-static (e.g. a
# "waiting" agent's chip, the speaking dot). Animates `position:y` via a relative
# offset so layout is preserved. Returns the looping Tween so the caller can stop()
# it when the element leaves the idle state; stop() restores the rest y. Returns
# null under reduced_motion (the caller simply has nothing to kill).
# Routed through the shared _TW_POS slot so `position` has a SINGLE owner per node:
# a slide_in pre-empts a running bob (and vice-versa) cleanly instead of two tweens
# fighting over position:y. The returned Tween is what callers store + stop().
static func idle_bob(node: Control, amplitude: float = 3.0, time: float = BOB_TIME) -> Tween:
	if not is_instance_valid(node) or reduced_motion:
		return null
	var rest_y := node.position.y
	var tw := _retween(node, _TW_POS).set_loops()
	# Stash the restore target on the tween so stop(tw) is fully self-contained — no
	# caller change and no node-meta lookup needed.
	tw.set_meta(_BOB_NODE, node)
	tw.set_meta(_BOB_REST, rest_y)
	tw.tween_property(node, "position:y", rest_y - amplitude, time) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	tw.tween_property(node, "position:y", rest_y, time) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	return tw

# ── helper: kill a previously-stored tween safely ───────────────────────────
# Components hold a per-node Tween (e.g. the speaking pulse / idle_bob) and call
# this before starting a new one, so loops never stack. Allocation-free and
# null/invalid-safe. If the tween is an idle_bob (carries the _BOB_* meta), restore
# the node's laid-out y FIRST so a bob killed mid-cycle never leaves the node frozen
# off-position (and a later re-bob can't accumulate the offset as a false rest).
static func stop(tw: Tween) -> void:
	if tw == null or not tw.is_valid():
		return
	if tw.has_meta(_BOB_NODE):
		var node = tw.get_meta(_BOB_NODE)
		if is_instance_valid(node) and tw.has_meta(_BOB_REST):
			(node as Control).position.y = tw.get_meta(_BOB_REST)
	tw.kill()

# ── internal: defer a spawn animation until the node has a real size ─────────
# A Control just parented into a container has size == Vector2.ZERO until the
# container sorts its children next frame; running _center_pivot then would pin
# the pivot to the top-left and the scale would grow from the corner. We wait one
# frame (or for the node's first resize, whichever comes first) so the pivot is
# truly centered. The start state (small scale / tint) is already applied by the
# caller, so there is no flash at full size in the meantime. Allocation here is
# one-shot per spawn (a brand-new node), never on the steady-state poll.
static func _run_deferred_spawn(node: Control, runner: Callable) -> void:
	var tree := node.get_tree()
	if tree == null:
		# Not in the tree yet (rare for a spawn helper) — run on the next idle.
		runner.call_deferred()
		return
	await tree.process_frame
	if is_instance_valid(node):
		runner.call()

# ── internal: center a Control's pivot so scale grows from the middle ────────
# Keeps scale animations from shifting a node's visual anchor. Cheap; safe to call
# every time (size is read, never written, so no layout side-effects).
static func _center_pivot(node: Control) -> void:
	node.pivot_offset = node.size * 0.5
