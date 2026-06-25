extends Node3D
## The one camera controller — two states on a single bound Camera3D:
##
##   COMMAND  : the top-down diorama view. A subtle grab-the-world swipe-pan
##              (folded in from camera_pan.gd) plus a clamped dolly-zoom, all
##              clamped so the framing only ever shifts a little. This is the
##              projector-readable "command center" pose captured in bind().
##   DIVE     : the signature first-person moment. enter_dive(agent) tweens the
##              camera down and forward to stand IN FRONT of the agent, facing it
##              at eye height with a wider FOV, and gently thickens the world's fog
##              so the background recedes. exit_dive() reverses it cleanly back to
##              command framing and RESTORES the captured base fog values.
##
## Nothing snaps — every transition rides a single eased Tween (Game-Feel Bible).
## The dive re-targets the LIVE agent every frame, so it tracks a walking agent
## through the descent instead of locking onto a stale start pose.
##
## Renderer note: Forward MOBILE strips far-DOF (CameraAttributes far-blur is a
## Forward+ feature, same family as SSAO/SSR/SDFGI), so the depth cue is the
## WorldEnvironment FOG (mobile-supported), captured + restored so we never
## permanently alter the shared scene Environment (B3's lane).
##
## Created from code by world_manager; bind(camera) captures the home framing off
## the already-positioned scene camera the instant it's handed over.

signal dive_entered(agent_node: Node3D)
signal dive_exited()

# --- Command-mode pan (ported from camera_pan.gd) ---
@export var pan_speed: float = 0.045   # world units per pixel of drag (was 0.012 — too sticky)
@export var max_pan_x: float = 36.0    # half-width of the pan rectangle — cover the whole island
@export var max_pan_y: float = 30.0    # half-height of the pan rectangle

# --- Command-mode zoom (dolly along the view direction). GENEROUS range so it actually zooms —
# the old 6/4 clamps barely moved on a ~90-unit-distant diorama, so zoom felt dead. ---
@export var zoom_speed: float = 3.5    # world units dollied per wheel notch / scroll step
@export var max_zoom_in: float = 55.0  # how far the camera may dolly toward the diorama
@export var max_zoom_out: float = 30.0 # how far it may pull back

# --- The dive ---
@export var dive_time: float = 0.85          # seconds for the descent / ascent
@export var dive_eye_height: float = 1.65    # first-person eye height (Walk-with-Bob)
@export var dive_standoff: float = 1.6        # how far in front of the agent we stand
@export var dive_fov: float = 62.0           # portrait-feel first-person FOV (62; 70 max — 85 fisheyed a 1.6m face)

# Fog depth cue (Forward Mobile-safe; replaces the dead far-DOF rig). We tween the
# live WorldEnvironment's fog UP during the dive and restore the captured base on exit.
@export var dive_fog_density: float = 0.035          # target fog density at full dive (base ~0.0018)
@export var dive_fog_aerial: float = 0.7             # target aerial-perspective at full dive (base ~0.25)

var _cam: Camera3D = null

# Captured home framing (the command pose) — restored on exit_dive.
var _home_pos: Vector3
var _home_basis: Basis
var _home_fov: float
var _right: Vector3        # screen-plane right axis, projected onto the X-Z plane
var _up: Vector3          # screen-plane up axis, projected onto the X-Z plane
var _forward: Vector3      # view direction, for the dolly-zoom

# Command-mode offsets, layered onto the home pose every frame.
var _pan_x: float = 0.0
var _pan_y: float = 0.0
var _zoom: float = 0.0

# Dive state.
var _diving: bool = false
var _dive_target: Node3D = null
var _tween: Tween = null

# Fog depth cue. We borrow the LIVE scene Environment (never edit world.tscn), snapshot
# its base fog at dive-start, drive it up across the descent, and restore on exit.
var _env: Environment = null            # the live WorldEnvironment.environment we're driving
var _fog_density_base: float = 0.0      # captured base fog_density (restored on exit)
var _fog_aerial_base: float = 0.0       # captured base fog_aerial_perspective (restored on exit)
var _fog_was_enabled: bool = false      # captured base fog_enabled (restored on exit)


# Called by world_manager the instant it hands us the scene camera (before
# add_child). The camera transform is known and settled at that moment, so we
# capture the home framing HERE — snapshotting later (in _ready) risks grabbing a
# mid-animation pose if anything nudged the camera in between.
func bind(cam: Camera3D) -> void:
	_cam = cam
	if _cam != null:
		_capture_home()


func _ready() -> void:
	if _cam == null:
		_cam = get_viewport().get_camera_3d()
	if _cam == null:
		return
	# Home framing is normally captured in bind(); cover the get_viewport() fallback path.
	if _home_basis == Basis():
		_capture_home()


# Snapshot the command pose and derive the screen-plane axes once. The camera
# never rotates in command mode, so we only ever slide along these.
func _capture_home() -> void:
	var xf := _cam.global_transform
	_home_pos = xf.origin
	_home_basis = xf.basis
	_home_fov = _cam.fov
	var bx := xf.basis.x
	var by := xf.basis.y
	var bz := xf.basis.z
	_right = Vector3(bx.x, 0.0, bx.z).normalized()
	_up = Vector3(by.x, 0.0, by.z).normalized()
	_forward = (-bz).normalized()   # camera looks down -Z


# Find the LIVE scene Environment so we can drive its fog during the dive. We read
# it fresh each dive (the WorldEnvironment node, falling back to the viewport's
# world_3d.environment) and NEVER touch world.tscn — we only borrow + restore.
func _resolve_env() -> Environment:
	# Prefer a WorldEnvironment node in the active scene.
	var tree := get_tree()
	if tree != null and tree.current_scene != null:
		var wenv := _find_world_environment(tree.current_scene)
		if wenv != null and wenv.environment != null:
			return wenv.environment
	# Fallback: the viewport's world environment.
	if _cam != null:
		var vp := _cam.get_viewport()
		if vp != null and vp.world_3d != null and vp.world_3d.environment != null:
			return vp.world_3d.environment
	var vp2 := get_viewport()
	if vp2 != null and vp2.world_3d != null:
		return vp2.world_3d.environment
	return null


func _find_world_environment(n: Node) -> WorldEnvironment:
	if n is WorldEnvironment:
		return n
	for c in n.get_children():
		var found := _find_world_environment(c)
		if found != null:
			return found
	return null


func is_diving() -> bool:
	return _diving


# ============================================================
#  Command mode — swipe-pan + clamped dolly-zoom
# ============================================================

func _unhandled_input(event: InputEvent) -> void:
	# All command-mode camera nudging is suspended during/after a dive; the dive
	# owns the transform until exit completes.
	if _cam == null or _diving:
		return

	# --- Pan: drag to grab the world (mouse-left-drag or one-finger touch drag) ---
	var rel := Vector2.ZERO
	if event is InputEventScreenDrag:
		rel = event.relative
	elif event is InputEventMouseMotion and (event.button_mask & MOUSE_BUTTON_MASK_LEFT) != 0:
		rel = event.relative
	if rel != Vector2.ZERO:
		_pan_x = clampf(_pan_x - rel.x * pan_speed, -max_pan_x, max_pan_x)
		_pan_y = clampf(_pan_y + rel.y * pan_speed, -max_pan_y, max_pan_y)
		_apply_command_pose()
		return

	# --- Zoom: mouse wheel, pinch-magnify, OR two-finger trackpad scroll. Trackpads emit NO
	# wheel events — they send Pan/Magnify gestures — which is why wheel-only zoom felt dead on a
	# laptop. Cover all three so "scroll / pinch to zoom" just works. ---
	var dz := 0.0
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			dz = zoom_speed
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			dz = -zoom_speed
	elif event is InputEventMagnifyGesture:
		dz = (event.factor - 1.0) * zoom_speed * 8.0
	elif event is InputEventPanGesture:
		dz = -event.delta.y * zoom_speed * 0.4    # two-finger scroll: up = zoom in
	if dz != 0.0:
		_zoom = clampf(_zoom + dz, -max_zoom_out, max_zoom_in)
		_apply_command_pose()


# Rebuild the command position from the home pose + the current pan/zoom offsets.
# Rotation stays at home (the command camera never tilts).
func _apply_command_pose() -> void:
	if _cam == null:
		return
	_cam.global_position = _home_pos + _right * _pan_x + _up * _pan_y + _forward * _zoom


# ============================================================
#  The dive
# ============================================================

# Tween from the current command framing down to a first-person pose standing IN
# FRONT of `target`, facing it at eye height. Re-entrant safe: a dive while already
# diving simply retargets and re-tweens from wherever the camera is now. The
# destination is recomputed from the LIVE target every frame (see the tween step),
# so a walking agent stays framed through the descent.
func enter_dive(target: Node3D) -> void:
	if _cam == null or not is_instance_valid(target):
		return
	var target_changed := target != _dive_target
	_dive_target = target
	var first_dive := not _diving
	if first_dive:
		_capture_fog()          # snapshot the live env's base fog before we drive it up
	_diving = true

	_run_dive_tween(dive_fov)

	# Re-emit whenever the FOCUS changes (first dive, or clicking agent B while
	# already dived into A) so C/D can rebind to the current target.
	if first_dive or target_changed:
		dive_entered.emit(target)


# Reverse cleanly back to the command framing (home pose + any pan/zoom the
# player had dialed in before diving). Clears the dive flag only once the tween
# finishes, so input stays suspended through the whole ascent.
func exit_dive() -> void:
	if _cam == null or not _diving:
		return
	_dive_target = null
	var home := _command_pose()
	var tw := _run_transform_tween(home.origin, home.basis, _home_fov, true)
	if tw != null:
		tw.finished.connect(_on_exit_finished, CONNECT_ONE_SHOT)
	else:
		_on_exit_finished()


func _on_exit_finished() -> void:
	_diving = false
	_restore_fog()              # put the shared env's fog back exactly as we found it
	dive_exited.emit()


# Snapshot the live scene Environment's base fog so we can restore it untouched.
func _capture_fog() -> void:
	_env = _resolve_env()
	if _env == null:
		return
	_fog_was_enabled = _env.fog_enabled
	_fog_density_base = _env.fog_density
	_fog_aerial_base = _env.fog_aerial_perspective


# Restore the captured base fog values (and enabled flag) onto the shared env.
func _restore_fog() -> void:
	if _env == null:
		return
	_env.fog_density = _fog_density_base
	_env.fog_aerial_perspective = _fog_aerial_base
	_env.fog_enabled = _fog_was_enabled
	_env = null


# The first-person target transform: stand `dive_standoff` IN FRONT of the agent,
# at eye height, looking back at its head. The agent faces +Z (agent.gd sets
# rotation.y = atan2(to.x, to.z) with no compensating model yaw), so its FACE
# points along +basis.z. We stand along +basis.z and look back — standing on -Z
# would film the back of its head. Guarded against a freed target by the caller.
func _dive_pose(target: Node3D) -> Transform3D:
	var agent_pos := target.global_position
	# Stand off the agent's FRONT (+Z of its basis — the direction its face points);
	# if that's degenerate fall back to the vector from the agent toward the current
	# camera so we never end up inside geometry.
	var front := target.global_transform.basis.z
	front.y = 0.0
	if front.length() < 0.01:
		front = _cam.global_position - agent_pos
		front.y = 0.0
	front = front.normalized()

	var eye := agent_pos + front * dive_standoff + Vector3.UP * dive_eye_height
	var look_at := agent_pos + Vector3.UP * (dive_eye_height * 0.92)   # the agent's head/upper chest
	var b := _basis_looking_at(eye, look_at)
	return Transform3D(b, eye)


# The command transform we return to: home pose + whatever pan/zoom was dialed in.
func _command_pose() -> Transform3D:
	var pos := _home_pos + _right * _pan_x + _up * _pan_y + _forward * _zoom
	return Transform3D(_home_basis, pos)


# A look-at basis with no roll: forward toward `look_at`, world-up as the hint.
func _basis_looking_at(from: Vector3, to: Vector3) -> Basis:
	var dir := (to - from)
	if dir.length() < 0.0001:
		return _home_basis
	# Transform3D.looking_at gives a clean, roll-free basis (camera looks down -Z).
	var xf := Transform3D().looking_at(dir, Vector3.UP)
	return xf.basis


# The DESCENT tween. Position/rotation/fov ride a single eased t, but the
# destination is recomputed from the LIVE _dive_target every frame — so a walking
# agent (dive can fire from request_voice mid-walk) stays framed instead of
# drifting out of shot. Fog is driven UP toward its dive target on the same t.
# If the target is freed mid-dive we abort to exit_dive() (no null deref).
func _run_dive_tween(dst_fov: float) -> Tween:
	if _cam == null:
		return null
	if _tween != null and _tween.is_valid():
		_tween.kill()

	var from_xf := _cam.global_transform
	var from_fov := _cam.fov
	if _env != null:
		_env.fog_enabled = true              # ensure fog is on for the whole dive

	var step := func(t: float) -> void:
		if _cam == null:
			return
		# Target gone mid-dive -> bail out cleanly (auto-ascend) instead of deref.
		if not is_instance_valid(_dive_target):
			call_deferred("exit_dive")
			return
		# Recompute the live destination each frame and interpolate the START pose
		# toward it on t — tracks the agent as it walks during the descent.
		var live := _dive_pose(_dive_target)
		var to_xf := Transform3D(live.basis.orthonormalized(), live.origin)
		_cam.global_transform = from_xf.interpolate_with(to_xf, t)
		_cam.fov = lerpf(from_fov, dst_fov, t)
		if _env != null:
			_env.fog_density = lerpf(_fog_density_base, dive_fog_density, t)
			_env.fog_aerial_perspective = lerpf(_fog_aerial_base, dive_fog_aerial, t)

	_tween = create_tween()
	_tween.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	_tween.tween_method(step, 0.0, 1.0, dive_time)
	return _tween


# The ASCENT/static tween: position (lerp) + rotation (quaternion slerp, no roll
# glitch) + fov on a single eased t toward a FIXED destination. If `restore_fog`,
# fog is eased back to its captured base across the same t. Returns the tween (or
# null if we couldn't build one).
func _run_transform_tween(dst_pos: Vector3, dst_basis: Basis, dst_fov: float, restore_fog: bool) -> Tween:
	if _cam == null:
		return null
	if _tween != null and _tween.is_valid():
		_tween.kill()

	var from_xf := _cam.global_transform
	var to_xf := Transform3D(dst_basis.orthonormalized(), dst_pos)
	var from_fov := _cam.fov
	var from_density := _env.fog_density if _env != null else 0.0
	var from_aerial := _env.fog_aerial_perspective if _env != null else 0.0

	# interpolate_with does position lerp + quaternion slerp internally — the clean,
	# roll-free path between two poses. We drive everything off a single eased t.
	var step := func(t: float) -> void:
		if _cam == null:
			return
		_cam.global_transform = from_xf.interpolate_with(to_xf, t)
		_cam.fov = lerpf(from_fov, dst_fov, t)
		if restore_fog and _env != null:
			_env.fog_density = lerpf(from_density, _fog_density_base, t)
			_env.fog_aerial_perspective = lerpf(from_aerial, _fog_aerial_base, t)

	_tween = create_tween()
	_tween.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	_tween.tween_method(step, 0.0, 1.0, dive_time)
	return _tween
