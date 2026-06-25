extends Node
# Click-to-select controller. Distinguishes a TAP (select an agent) from a DRAG
# (pan the camera) by a pixel threshold, so a small finger-wobble while panning
# never mis-fires a selection. On a clean tap it raycasts from the Camera3D into
# the world; if the ray hits an agent's ClickArea (Area3D built at spawn in
# agent.gd) it emits selected(agent_id). A tap on empty ground emits selected("")
# so the panel can close.
#
# Created from code by world_manager; bind(camera) BEFORE add_child(). Pairs with
# camera_pan.gd, which handles the actual drag panning — we only DETECT the tap
# and consume the input so panning and selection don't both react to one gesture.

signal selected(agent_id: String)

@export var drag_threshold: float = 12.0   # px of motion before a press counts as a drag, not a tap
@export var ray_length: float = 1000.0

var _cam: Camera3D = null
var _press_pos: Vector2 = Vector2.ZERO
var _pressed: bool = false
var _dragged: bool = false

# Called by world_manager BEFORE add_child().
func bind(cam: Camera3D) -> void:
	_cam = cam

func _ready() -> void:
	if _cam == null:
		_cam = get_viewport().get_camera_3d()

func _unhandled_input(event: InputEvent) -> void:
	if _cam == null:
		return
	# --- Press start (mouse or touch) ---
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			_begin_press(event.position)
		else:
			_end_press(event.position)
		return
	if event is InputEventScreenTouch:
		if event.pressed:
			_begin_press(event.position)
		else:
			_end_press(event.position)
		return
	# --- Motion: promote to a drag once past the threshold ---
	if event is InputEventMouseMotion and _pressed:
		if _press_pos.distance_to(event.position) > drag_threshold:
			_dragged = true
		return
	if event is InputEventScreenDrag and _pressed:
		if _press_pos.distance_to(event.position) > drag_threshold:
			_dragged = true
		return

func _begin_press(pos: Vector2) -> void:
	_pressed = true
	_dragged = false
	_press_pos = pos

func _end_press(pos: Vector2) -> void:
	if not _pressed:
		return
	_pressed = false
	# A drag (past threshold) is a camera pan, not a selection — ignore it.
	if _dragged or _press_pos.distance_to(pos) > drag_threshold:
		return
	_handle_tap(pos)

# Raycast from the camera through the tap point; resolve the agent_id if we hit
# an agent collider, else "" for empty ground. Consume the input so camera_pan
# doesn't also treat this frame's release as the end of a pan.
func _handle_tap(screen_pos: Vector2) -> void:
	var hit_id := _raycast_agent(screen_pos)
	selected.emit(hit_id)
	get_viewport().set_input_as_handled()

func _raycast_agent(screen_pos: Vector2) -> String:
	var space := _cam.get_world_3d().direct_space_state
	var from := _cam.project_ray_origin(screen_pos)
	var to := from + _cam.project_ray_normal(screen_pos) * ray_length
	var query := PhysicsRayQueryParameters3D.create(from, to)
	query.collide_with_areas = true     # our click colliders are Area3D
	query.collide_with_bodies = false
	var result := space.intersect_ray(query)
	if result.is_empty():
		return ""
	var collider = result.get("collider")
	if collider == null:
		return ""
	# agent.gd stashed agent_id as meta on its ClickArea.
	if collider.has_meta("agent_id"):
		return String(collider.get_meta("agent_id"))
	return ""
