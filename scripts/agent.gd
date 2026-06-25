extends Node3D
# AgentCraft character — ONE per real Claude coding agent.
#
# Distilled from barbarian.gd + auto_wander.gd: the animation helpers
# (_find_anim_player / _match_clip / _play / _face) and the move-toward-a-point
# math are copied here, stripped of all combat/targeting/AI. This script has NO
# autonomous behaviour: its STATE IS SET ONLY EXTERNALLY by world_manager from
# the sidecar /world feed via set_state(). The only thing _process does is play
# the right clip and (in `moving`) lerp toward its target building.
#
# State -> animation (the frozen contract enum, existing _match_clip system):
#   waiting -> idle clip (stop() if the model has none)
#   moving  -> walk clip + lerp toward the target building
#   working -> attack/cast/hammer clip, looped
#   blocked -> idle clip + grey tint
#   done    -> one attack/cheer pulse + procedural hop -> idle
#
# Spawned by world_manager: it instantiates a character GLB, set_script(AGENT),
# calls setup(...) BEFORE add_child(), then sets global_position AFTER add_child().
# A click collider (Area3D + CollisionShape3D) is built in _ready() so selection
# works the instant the node exists — the top "click does nothing" failure mode.

# --- Tunables (mirrors the old units; no new art) ---
@export var move_speed: float = 2.6      # units/sec walking toward the building
@export var turn_speed: float = 6.0      # yaw lerp factor
@export var target_height: float = 2.5   # body height in world units. GLBs import at a 0.01
                                          # armature scale, so we FIT the model child to this —
                                          # NEVER set the root scale absolutely (that made 130x giants)
@export var arrive_dist: float = 3.4     # stop this far from the building centre (its footprint)
@export var attack_anim_speed: float = 1.6   # play the working clip a touch faster
@export var click_radius: float = 1.1    # selection sphere radius (world units, pre-scale)
@export var hop_height: float = 0.6      # peak of the procedural "done" hop
@export var hop_time: float = 0.45       # duration of the done hop

const HEALTH_BAR := preload("res://scripts/health_bar.gd")

# TEMP B1 anim diagnostic toggle — flip to false to silence the per-spawn print.
const DBG_ANIM := false

# --- §3.1 signals (B1 produces; B5 juice connects, never edits us) ---
signal state_changed(new_state: String)
signal arrived()                 # fired once when we first reach arrive_dist of the target
signal selected_changed(on: bool)
signal planted(agent_id: String, at: Vector3)   # commit plant beat complete

# Status enum values straight from the contract.
const ST_WAITING := "waiting"
const ST_MOVING := "moving"
const ST_WORKING := "working"
const ST_BLOCKED := "blocked"
const ST_DONE := "done"

# --- Identity (set by world_manager from the feed) ---
var agent_id: String = ""
var label: String = ""
var character_kind: String = "viking"

# --- Runtime state ---
var state: String = ST_WAITING
var _target_pos: Vector3 = Vector3.ZERO   # building world position to walk toward
var _has_target: bool = false
var _arrived: bool = false                # latched so arrived() fires once per move leg
var _base_y: float = 0.0

# --- Idle wander (ambient life while waiting; never overrides feed move/work or planting) ---
@export var wander_radius: float = 4.0
@export var wander_speed: float = 1.1
@export var wander_pause: float = 1.6
var allow_wander: bool = true            # world_manager clears this for the agent you're talking to
var _home: Vector3 = Vector3.ZERO
var _has_home: bool = false
var _wander_target: Vector3 = Vector3.ZERO
var _has_wander_target: bool = false
var _wander_pause_t: float = 0.0

# --- Plant beat (commit choreography; overrides feed state + wander while active) ---
@export var plant_work_time: float = 4.0
var _planting: bool = false
var _plant_target: Vector3 = Vector3.ZERO
var _plant_t: float = 0.0
var _plant_arrived: bool = false

# --- Animation ---
var _anim: AnimationPlayer = null
var _walk_clip: String = ""
var _idle_clip: String = ""
var _attack_clip: String = ""
var _has_idle: bool = false

# --- Selection highlight / blocked tint ---
var _mesh: MeshInstance3D = null
var _overlay: StandardMaterial3D = null
var _selected: bool = false

# --- "done" pulse bookkeeping ---
var _done_pulsing: bool = false
var _hop_t: float = -1.0

# Called by world_manager BEFORE add_child().
func setup(p_agent_id: String, p_label: String, p_kind: String) -> void:
	agent_id = p_agent_id
	label = p_label
	character_kind = p_kind

func _ready() -> void:
	_base_y = position.y
	_fit_model()                              # scale the GLB child to a readable world height
	_rebind_skins()                           # bind the skinned mesh to its Skeleton3D (fixes the T-pose)
	_anim = _find_anim_player(self)
	if _anim:
		_merge_extra_clips()
		# Prefer a real "walk" clip (base GLB carries "Armature|walking_man|baselayer");
		# fall back to "run" only if a kind ships no walk. Two passes so walk always wins
		# over a merged Running clip regardless of get_animation_list() ordering.
		_walk_clip = _match_clip(["walk"])
		if _walk_clip == "":
			_walk_clip = _match_clip(["run"])
		# NB: deliberately NO "tpose" key — matching a clip literally named tpose and
		# looping it as "idle" is exactly the failure this whole task exists to prevent.
		_idle_clip = _match_clip(["idle", "stand", "rest"])
		# The dwarf ships BOTH a Heavy_Hammer_Swing and an Attack clip. We want the
		# heavy hammer to read as "working" (the builder look). _match_clip returns the
		# first CLIP in get_animation_list() order matching ANY key, so key order alone
		# can't force a winner when both clips exist — do a dedicated hammer pass first,
		# then fall back to the general keys. Two passes => hammer deterministically wins.
		if character_kind == "dwarf":
			_attack_clip = _match_clip(["hammer"])
		if _attack_clip == "":
			_attack_clip = _match_clip(["attack", "cast", "spell", "soell", "hammer", "swing", "slash", "punch"])
		_has_idle = _idle_clip != ""
		_anim.animation_finished.connect(_on_anim_finished)
	# TEMP B1 anim diagnostic — flip DBG_ANIM to false to silence once confirmed.
	if DBG_ANIM:
		print("[B1/anim] kind=%s anim=%s list=%s walk=%s idle=%s attack=%s" % [
			character_kind, str(_anim != null),
			str(_anim.get_animation_list()) if _anim else "[]",
			_walk_clip, _idle_clip, _attack_clip])
	_mesh = _find_mesh_instance(self)
	_setup_overlay()
	# Floating name/status bar lives in world space under us (added by the manager
	# as a separate billboard so it doesn't inherit our scale). The health-bar
	# style billboard is reused by Track D for the lock chip; we don't add it here.
	_build_click_collider()
	# Settle into the starting pose.
	_apply_anim()

# Fit the character GLB ("Model" child) to target_height in world units. Every Meshy/greg
# GLB imports with a 0.01 armature scale (authored in cm); the old `scale = ONE * 1.3` set
# the agent's OWN scale absolutely, overwriting that 0.01 and blowing every body up ~130x
# (a ~220-unit giant you stand inside — the "over-zoom" symptom). Here we instead measure
# the mesh's true height in the model's local space (robust to Godot's skin/skeleton
# restructuring) and scale ONLY the model child, leaving the agent root at unit scale so
# name tags / overlays / the click collider stay in real world units.
func _fit_model() -> void:
	var model := get_node_or_null("Model") as Node3D
	if model == null:
		return
	model.scale = Vector3.ONE
	var h := _character_height(model)
	if h > 0.001:
		model.scale = Vector3.ONE * (target_height / h)

# Character height in MODEL-local units (with model.scale == 1). A SKINNED body renders at its
# Skeleton3D's transform, so we measure the SKELETON's bone span through skel.global_transform —
# the SAME transform the bound mesh renders through. Measuring the mesh node's AABB instead is
# inconsistent with bound rendering: the mesh path carries the GLB's 0.01 armature scale, the
# skeleton path may not, so the bound body comes out ~100x too large. Falls back to the mesh AABB
# only for unrigged models (a static prop / skeleton-less fallback).
func _character_height(model: Node3D) -> float:
	var skel := _find_skeleton(model)
	if skel != null and skel.get_bone_count() > 0:
		var base := skel.global_transform
		var lo := INF
		var hi := -INF
		for i in skel.get_bone_count():
			var wy: float = (base * skel.get_bone_global_pose(i).origin).y
			lo = minf(lo, wy)
			hi = maxf(hi, wy)
		if hi - lo > 0.001:
			return hi - lo
	var mi := _find_mesh_instance(model)
	if mi != null and mi.mesh != null:
		var rel := model.global_transform.affine_inverse() * mi.global_transform
		return mi.get_aabb().size.y * abs(rel.basis.get_scale().y)
	return 0.0

# Re-bind every skinned mesh to the character's Skeleton3D. The Meshy GLB import leaves the
# MeshInstance3D.skeleton NodePath unresolved — the AnimationPlayer animates the skeleton but the
# mesh renders in its static BIND POSE (the T-pose bug: clips resolve + play, skeleton moves, the
# mesh doesn't follow). Pointing each skinned mesh at the live skeleton is what makes it deform.
func _rebind_skins() -> void:
	var skel := _find_skeleton(self)
	if skel == null:
		return
	for mi in _all_mesh_instances(self, []):
		if mi.skin != null:
			mi.skeleton = mi.get_path_to(skel)

func _all_mesh_instances(n: Node, acc: Array) -> Array:
	for c in n.get_children():
		if c is MeshInstance3D:
			acc.append(c)
		_all_mesh_instances(c, acc)
	return acc

# ============================================================
#  EXTERNAL STATE — the ONLY way this character changes behaviour
# ============================================================

# Set the character's state from the feed. `target` is the building world
# position to walk toward (only meaningful for `moving`); pass null/ignore for
# the rest. Re-applying the same state is cheap (no clip restart thrash).
func set_state(new_state: String, target = null) -> void:
	if target != null and target is Vector3:
		# A new/changed target means a fresh move leg — re-arm the arrived() latch.
		if target != _target_pos:
			_arrived = false
		_target_pos = target
		_has_target = true
	var changed := new_state != state
	state = new_state
	# Entering `moving` starts a fresh leg; re-arm so we can announce arrival again.
	if new_state == ST_MOVING and changed:
		_arrived = false
	# Fire the one-shot "done" pulse on the transition into `done`.
	if new_state == ST_DONE and changed:
		_start_done_pulse()
	if changed:
		_apply_anim()
		state_changed.emit(new_state)
	_apply_tint()

func set_target(target: Vector3) -> void:
	if target != _target_pos:
		_arrived = false
	_target_pos = target
	_has_target = true

# Where this agent loiters when idle — the stand pos in front of its repo-house.
func set_home(pos: Vector3) -> void:
	_home = pos
	_home.y = 0.0
	_has_home = true

# Choreographed plant action (commit): walk to `pos`, work plant_work_time, emit planted().
# Overrides feed state + wander until complete; a new plant_at retargets the current one.
func plant_at(pos: Vector3) -> void:
	_plant_target = pos
	_plant_target.y = 0.0
	_planting = true
	_plant_arrived = false
	_plant_t = 0.0
	_has_wander_target = false

# ============================================================
#  Per-frame: drive the clip + lerp. NO decision-making here.
# ============================================================
func _process(delta: float) -> void:
	_update_hop(delta)
	if _planting:
		_do_plant(delta)
		return
	match state:
		ST_MOVING:
			_do_move(delta)
		ST_WAITING:
			if _has_home and allow_wander:
				_wander(delta)
		_:
			# working / blocked / done stand in place; the clip was set on the
			# state transition. Nothing to integrate per-frame.
			pass

func _do_move(delta: float) -> void:
	# Re-assert the walk loop EVERY frame while moving — the proven template
	# (barbarian.gd / auto_wander.gd) plays the walk clip per-frame, never just on
	# the state transition. Doing it only on transition was the T-pose-while-moving
	# regression: the body lerped (this fn runs each frame) while the clip, set at
	# most once, could be missing/stopped and never restarted -> a sliding T-pose.
	# _play() is cheap (no-ops once current_animation == _walk_clip).
	_play(_walk_clip, true)
	if not _has_target:
		return
	var to := _target_pos - global_position
	to.y = 0.0
	var dist := to.length()
	if dist <= arrive_dist:
		# Arrived: keep the walking-in-place look until the feed flips us to working.
		# (We do NOT self-transition — state is external. Just face the building.)
		_face(_target_pos, delta)
		if not _arrived:
			_arrived = true
			arrived.emit()
		return
	var dir := to / dist
	_face(_target_pos, delta)
	global_position += dir * move_speed * delta
	# Only pin to the ground plane when NO hop is active. _update_hop owns y while
	# _hop_t >= 0.0; forcing _base_y here would flatten a hop if a done->moving
	# transition lands mid-arc (the hop vs move y-fight).
	if _hop_t < 0.0:
		global_position.y = _base_y

# Gentle ambient roam on a ring around home while idle. Picks a point on the ring, ambles there,
# pauses, picks another. Stays OUTSIDE the house footprint (ring radius), so it never walks into
# the building. The feed flipping us off ST_WAITING ends it instantly (see _process).
func _wander(delta: float) -> void:
	if _wander_pause_t > 0.0:
		_wander_pause_t -= delta
		if _has_idle:
			_play(_idle_clip, true)
		else:
			_stand()
		return
	if not _has_wander_target:
		var ang := randf() * TAU
		_wander_target = _home + Vector3(cos(ang), 0.0, sin(ang)) * wander_radius
		_wander_target.y = 0.0
		_has_wander_target = true
	var to := _wander_target - global_position
	to.y = 0.0
	if to.length() <= 0.4:
		_has_wander_target = false
		_wander_pause_t = wander_pause
		return
	_play(_walk_clip, true)
	_face(_wander_target, delta)
	global_position += to.normalized() * wander_speed * delta
	if _hop_t < 0.0:
		global_position.y = _base_y

# Choreographed plant beat (commit): walk to the plot, work plant_work_time, then emit planted().
func _do_plant(delta: float) -> void:
	if not _plant_arrived:
		var to := _plant_target - global_position
		to.y = 0.0
		if to.length() <= 0.6:
			_plant_arrived = true
			_plant_t = 0.0
		else:
			_play(_walk_clip, true)
			_face(_plant_target, delta)
			global_position += to.normalized() * move_speed * delta
			if _hop_t < 0.0:
				global_position.y = _base_y
		return
	if _attack_clip != "":
		_play(_attack_clip, true, attack_anim_speed)
	else:
		_play(_walk_clip, true)
	_plant_t += delta
	if _plant_t >= plant_work_time:
		_planting = false
		planted.emit(agent_id, _plant_target)
		_apply_anim()

# ============================================================
#  Animation application
# ============================================================
func _apply_anim() -> void:
	match state:
		ST_WAITING, ST_BLOCKED:
			_stand()
		ST_MOVING:
			_play(_walk_clip, true)
		ST_WORKING:
			if _attack_clip != "":
				_play(_attack_clip, true, attack_anim_speed)
			else:
				_play(_walk_clip, true)   # fallback: keep limbs alive, never T-pose
		ST_DONE:
			# The pulse plays the attack clip once; afterwards _on_anim_finished
			# settles us back to idle. If there's no attack clip there is no clip to
			# fire animation_finished, so _on_anim_finished never clears the latch —
			# clear it HERE or greg (no attack clip) stays _done_pulsing forever.
			if _attack_clip != "":
				_play(_attack_clip, false, attack_anim_speed)
			else:
				_done_pulsing = false
				_stand()

# Stand still without ever showing the bare bind/T-pose:
#   * have an idle clip  -> loop it.
#   * no idle (greg)     -> hold a single posed frame of the walk clip via seek()
#     (limbs mid-stride, NOT the T-pose), and freeze it by zeroing playback speed.
# Bare stop() drops the skeleton to the import bind pose (the T-pose), so we never
# do that — _hold_rest_frame keeps a believable standing silhouette instead.
func _stand() -> void:
	if _has_idle:
		_play(_idle_clip, true)
	else:
		_hold_rest_frame()

# Freeze the model on one mid-stride frame of the walk clip (or whatever clip we
# have) so a kind without an idle still reads as "standing", never as a T-pose.
func _hold_rest_frame() -> void:
	if _anim == null:
		return
	var clip := _walk_clip if _walk_clip != "" else _attack_clip
	if clip == "":
		return
	var a := _anim.get_animation(clip)
	if a == null:
		return
	# A frame a little into the cycle reads as a settled stance, not frame-0 contact.
	var pose_t: float = clampf(a.length * 0.5, 0.0, a.length)
	_anim.play(clip, -1, 0.0)   # speed 0 -> the clip is loaded but does not advance
	_anim.seek(pose_t, true)    # pose the skeleton on this frame and update immediately

func _start_done_pulse() -> void:
	_done_pulsing = true
	_hop_t = 0.0   # procedural hop overlays the cheer

func _update_hop(delta: float) -> void:
	if _hop_t < 0.0:
		return
	_hop_t += delta
	var p := _hop_t / hop_time
	if p >= 1.0:
		_hop_t = -1.0
		position.y = _base_y
	else:
		position.y = _base_y + sin(p * PI) * hop_height

func _on_anim_finished(anim_name: String) -> void:
	# After the one-shot "done" cheer, drop back to idle (the feed will usually
	# also flip us to waiting, but settle locally so we never freeze on the last
	# frame of the attack clip).
	if state == ST_DONE and anim_name == _attack_clip:
		_done_pulsing = false
		_stand()

# ============================================================
#  Selection highlight + blocked tint (material_overlay)
# ============================================================
func _setup_overlay() -> void:
	if _mesh == null:
		return
	_overlay = StandardMaterial3D.new()
	_overlay.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_overlay.albedo_color = Color(0, 0, 0, 0)   # transparent until highlighted/tinted
	_mesh.material_overlay = _overlay

# Called by click_controller via world_manager when this agent is (de)selected.
func set_selected(on: bool) -> void:
	var changed := on != _selected
	_selected = on
	_apply_tint()
	if changed:
		selected_changed.emit(on)

# Highlight (selected) takes priority; otherwise grey when blocked; else clear.
func _apply_tint() -> void:
	if _overlay == null:
		return
	if _selected:
		_overlay.albedo_color = Color(1.0, 0.92, 0.3, 0.35)   # warm gold select glow
	elif state == ST_BLOCKED:
		_overlay.albedo_color = Color(0.1, 0.1, 0.12, 0.45)    # greyed-out
	else:
		_overlay.albedo_color = Color(0, 0, 0, 0)

# ============================================================
#  Click collider — built at spawn so selection works immediately
# ============================================================
func _build_click_collider() -> void:
	var area := Area3D.new()
	area.name = "ClickArea"
	# input_ray_pickable defaults true; raycast from click_controller hits this.
	var shape := CollisionShape3D.new()
	var sphere := SphereShape3D.new()
	sphere.radius = click_radius
	shape.shape = sphere
	# Lift the sphere to roughly torso height so the body is the click target.
	shape.position = Vector3(0.0, click_radius, 0.0)
	area.add_child(shape)
	add_child(area)
	# Stash our agent_id on the Area3D so the raycast result can resolve us back
	# without a node-walk. click_controller reads "agent_id" off the collider owner.
	area.set_meta("agent_id", agent_id)

# ============================================================
#  Helpers (copied verbatim from barbarian.gd / auto_wander.gd)
# ============================================================
func _find_anim_player(n: Node) -> AnimationPlayer:
	for c in n.get_children():
		if c is AnimationPlayer:
			return c
		var found := _find_anim_player(c)
		if found:
			return found
	return null

func _find_mesh_instance(n: Node) -> MeshInstance3D:
	for c in n.get_children():
		if c is MeshInstance3D:
			return c
		var found := _find_mesh_instance(c)
		if found:
			return found
	return null

func _find_skeleton(n: Node) -> Skeleton3D:
	for c in n.get_children():
		if c is Skeleton3D:
			return c
		var found := _find_skeleton(c)
		if found:
			return found
	return null

# Merge the per-kind extra clips (attack/idle/run) into an editable "extra"
# library so _match_clip can resolve idle + attack even though they ship in
# separate GLBs. The base GLB only carries walk.
func _merge_extra_clips() -> void:
	if _anim.has_animation_library("extra"):
		return
	var clips: Dictionary = {}
	match character_kind:
		"wizard":
			clips = WizardAnims.clips()
		"dwarf":
			clips = DwarfAnims.clips()
		_:
			# viking + barbarian both ride the viking skeleton's extra clips.
			clips = VikingAnims.clips()
	if clips.is_empty():
		return
	var extra := AnimationLibrary.new()
	for cname in clips:
		extra.add_animation(cname, clips[cname])
	_anim.add_animation_library("extra", extra)

# Return the first clip whose name contains any of the given substrings.
func _match_clip(keys: Array) -> String:
	if _anim == null:
		return ""
	for clip in _anim.get_animation_list():
		var lower := String(clip).to_lower()
		for k in keys:
			if lower.find(k) != -1:
				return clip
	return ""

func _play(clip: String, loop_it: bool, speed: float = 1.0) -> void:
	if _anim == null or clip == "":
		return
	# No-op only if the SAME clip is already playing AND actually advancing. A clip
	# parked at speed 0 by _hold_rest_frame() shares the same current_animation, so we
	# must NOT early-out — otherwise a moving->rest->moving cycle leaves the body frozen
	# on the held frame while it slides (the T-pose-while-moving symptom in disguise).
	# get_playing_speed() reflects the per-play custom_speed (0.0 while held).
	if speed == 1.0 and _anim.current_animation == clip and _anim.is_playing() \
			and not is_zero_approx(_anim.get_playing_speed()):
		return
	_anim.play(clip, -1, speed)
	var anim := _anim.get_animation(clip)
	if anim:
		anim.loop_mode = Animation.LOOP_LINEAR if loop_it else Animation.LOOP_NONE

# Smooth yaw toward a world-space point (yaw only).
func _face(toward: Vector3, delta: float) -> void:
	var to := toward - global_position
	to.y = 0.0
	if to.length() < 0.0001:
		return
	var desired_yaw := atan2(to.x, to.z)
	rotation.y = lerp_angle(rotation.y, desired_yaw, clamp(turn_speed * delta, 0.0, 1.0))
