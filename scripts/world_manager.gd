extends Node
# WorldManager — the central brain of the AgentCraft world (replaces battle_manager.gd).
#
# Responsibilities (Track B):
#   * Resolve the two existing House bases (base.gd) as the first two repo buildings.
#   * Bind camera_pan.gd to the scene camera BEFORE add_child() (the contract).
#   * Add a ClickController (selection) + a SidecarBridge (the /world feed).
#   * Consume world_updated snapshots: spawn/update one Agent character per feed
#     agent, drive each one's state via apply_agent_state(), spawn a repo building
#     for any repo we don't yet have a building for.
#   * Open the InteractionPanel on selection; relay its prompt/voice signals out.
#
# It holds NO game logic, NO Aiven creds — it only renders the sidecar projection.
# The whole world is demoable with the SidecarBridge in MOCK_FEED mode (no sidecar).

const AGENT := preload("res://scripts/agent.gd")
const CLICK_CONTROLLER := preload("res://scripts/click_controller.gd")
const SIDECAR_BRIDGE := preload("res://scripts/sidecar_bridge.gd")
const CAMERA_CONTROLLER := preload("res://scripts/camera_controller.gd")  # Track B2 — pan/zoom + dive
const HOUSE_GLB := preload("res://models/house.glb")
const BASE := preload("res://scripts/base.gd")
const INTERACTION_PANEL := preload("res://scenes/interaction_panel.tscn")
const LOCK_OVERLAY := preload("res://scripts/lock_overlay.gd")   # Track D — Aiven chip + LOCKED tag
const AGENT_VOICE_PLAYER := preload("res://scripts/agent_voice_player.gd")  # Track C — positional TTS playback
const FARM_FIELD := preload("res://scripts/farm_field.gd")       # commit-farm: per-repo plot grid

# Character GLBs — base walking model per kind (extra clips merged in agent.gd).
const VIKING_GLB := preload("res://models/viking/Meshy_AI_Viking_Action_Figure__biped_Animation_Walking_withSkin.glb")
const WIZARD_GLB := preload("res://models/wizard/Meshy_AI_Violet_Archmage_biped_Animation_Walking_withSkin.glb")
const DWARF_GLB := preload("res://models/dwarf/Meshy_AI_Flying_Dwarf_biped_Animation_Walking_withSkin.glb")
# Barbarian (greg) has NO idle clip — agent.gd falls back to stop()/walk. Prefer
# viking/wizard/dwarf for demo characters per the plan's animation gotcha.
const BARBARIAN_GLB := preload("res://models/greg_walking.glb")

# Gate-zero render switch. Force every agent onto ONE character kind so the
# world/camera/spawn pipeline can be A/B tested against the known-good greg model:
# set to "barbarian" to prove bodies render regardless of the Meshy skins; if greg
# shows up but viking/wizard/dwarf don't, the bug is the Meshy skins, not the spawn.
# "" = use each agent's character_kind from the feed (the real demo). Leave "".
const FORCE_KIND := ""

# Trace the integrated A->B->D->C chain to the console (verify without pixels). Off by default;
# flip to true to watch feed->Hud->dive->voice fire. Proven green via MCP play (feed->render->Hud
# ->show_agent->dive->voice all fired, 0 errors; voice only failed to reach the offline backend).
const DBG_CHAIN := false
# Trace the commit->plant farm loop to the console (field creation, commit, planted). Off by default;
# flip true to watch it. Proven green via MCP (3 fields + pre-seed, commit -> walk -> plant + message).
const DBG_FARM := false

const HOUSE_SCALE := 8.0          # matches the two pre-placed Houses in world.tscn
const OCTAGON_LIMIT := 31.0       # |x|+|z| < 31 free-slot bound (from the plan)
const BUILDING_INSET := 14.0      # ring radius for spawned repo buildings
const STAND_OFFSET := 5.0         # how far in front of a building an agent stands/works
const SPAWN_OFFSET := 13.0        # how far BEHIND the building (away from centre) an agent spawns,
                                  # so `moving` lerps a real, visible distance to its stand pos
                                  # (must exceed agent.arrive_dist 3.4 + STAND_OFFSET 5.0 by a margin)

# Commit-farm layout: a fenced plot grid beside each repo-house.
const FIELD_COLS := 4
const FIELD_ROWS := 3
const FIELD_CELL := 1.7
const FIELD_OFFSET := 9.0    # how far OUT from map centre the field sits, beyond the house

var _cam: Camera3D = null
var _cam_ctrl = null
var _click = null
var _bridge = null
var _hud = null                     # the Hud autoload (Track D) — the ONLY 2D seam B drives
var _dive_agent: String = ""        # agent currently dived-into ("" = command view)

# repo_id -> building Node3D (its world position is the target_base).
var _buildings: Dictionary = {}
# agent_id -> Agent character Node3D.
var _agents: Dictionary = {}
# agent_id -> LockOverlay (task chip floating above the character; Track D seam §4.4).
var _agent_overlays: Dictionary = {}
# repo_id -> LockOverlay (the "LOCKED: <file>" tag floating over the contested building).
var _building_overlays: Dictionary = {}
# Occupied octagon slots (Vector3 building positions) so new repos don't overlap.
var _used_slots: Array = []
# Commit-farm: repo_id -> FarmField, agent_id -> repo_id, and a de-dupe set for polled commit events.
var _fields: Dictionary = {}
var _agent_repo: Dictionary = {}
var _seen_commits: Dictionary = {}
# agent_id -> last AgentView Dictionary seen from the /world poll. Lets voice enter/exit
# re-apply state THIS frame (stand still / re-arm wander) instead of waiting for the next poll.
var _last_view: Dictionary = {}

# The two pre-placed Houses, claimed as the first repo buildings on demand.
var _house_pool: Array = []
var _selected_agent_id: String = ""
# Read-only multiplayer visit: true while showing another world (the live /world poll is paused
# so its snapshots can't stomp the visited bodies). Cleared when the browser closes.
var _visiting: bool = false

# --- Native voice (Track C) ---------------------------------------------------
# The VoiceWebSocket autoload (ported from a prior voice prototype) owns the ElevenLabs WS + mic. We hold
# per-agent AgentVoicePlayer sinks (lazily attached) so the streamed voice emanates from the
# clicked character, and track which agent currently holds the single live conversation.
const VOICE_AUTOLOAD := "/root/VoiceWebSocket"
# agent_id -> AgentVoicePlayer node (positional TTS playback + speaking tell).
var _voice_players: Dictionary = {}
# agent_id of the agent currently in a voice conversation ("" = none).
var _voice_active_agent: String = ""
var _voice = null   # cached VoiceWebSocket autoload ref (null if absent — voice is best-effort)

func _ready() -> void:
	_cam = get_viewport().get_camera_3d()
	_resolve_houses()
	_setup_camera()
	_setup_click_controller()
	_setup_hud()
	_setup_bridge()
	_setup_voice()
	# Warm the per-kind animation caches at boot (B1 perf finding): each *Anims.clips()
	# synchronously loads ~7MB GLBs, so doing it here moves the ~80-300ms-per-kind hitch
	# off the gameplay spawn path (when the first viking/wizard/dwarf appears) to load time.
	VikingAnims.warm()
	WizardAnims.warm()
	DwarfAnims.warm()

# ============================================================
#  Scene wiring
# ============================================================

# Find the two pre-placed House nodes (base.gd) in the scene to reuse as the
# first two repo buildings — no new art, exactly as the plan asks.
func _resolve_houses() -> void:
	var root := get_parent()
	if root == null:
		return
	for sib in root.get_children():
		if sib.has_method("take_damage") and sib.has_signal("destroyed"):
			_house_pool.append(sib)
			_used_slots.append(sib.global_position)

# The single camera controller (Track B2): top-down command framing + swipe-pan/zoom AND
# the first-person dive. bind(camera) BEFORE add_child() so _ready captures the home framing
# (binding after add_child misses that capture — the camera contract).
func _setup_camera() -> void:
	var cc = CAMERA_CONTROLLER.new()
	cc.bind(_cam)
	add_child(cc)
	_cam_ctrl = cc

func _setup_click_controller() -> void:
	var cc = CLICK_CONTROLLER.new()
	cc.bind(_cam)             # bind BEFORE add_child, same camera contract
	add_child(cc)
	cc.selected.connect(_on_agent_selected)
	_click = cc

# The 2D command center is the Hud autoload (Track D); B talks ONLY to it. Connect its UP
# signals (prompt / talk / diff / merge / approve / leave-dive). Guarded: if the autoload is
# absent the world still renders + animates (no 2D), never crashes.
func _setup_hud() -> void:
	_hud = get_node_or_null("/root/Hud")
	if _hud == null:
		push_warning("[WorldManager] Hud autoload missing — 2D command center disabled")
		return
	if _hud.has_signal("prompt_submitted"):
		_hud.prompt_submitted.connect(_on_hud_prompt)
	if _hud.has_signal("talk_requested"):
		_hud.talk_requested.connect(_on_hud_talk)
	if _hud.has_signal("diff_requested"):
		_hud.diff_requested.connect(_on_hud_diff)
	if _hud.has_signal("merge_requested"):
		_hud.merge_requested.connect(_on_hud_merge)
	if _hud.has_signal("approve"):
		_hud.approve.connect(_on_hud_approve)
	if _hud.has_signal("dive_exit_requested"):
		_hud.dive_exit_requested.connect(_on_hud_dive_exit)
	# Session verbs (Track A character-session model). D's SessionBar relays these UP; B drives
	# the sidecar round-trips and hands results back to the Hud (mirrors the diff_requested seam).
	if _hud.has_signal("new_chat_requested"):
		_hud.new_chat_requested.connect(_on_hud_new_chat)
	if _hud.has_signal("send_away_requested"):
		_hud.send_away_requested.connect(_on_hud_send_away)
	if _hud.has_signal("sessions_requested"):
		_hud.sessions_requested.connect(_on_hud_sessions)
	if _hud.has_signal("session_view_requested"):
		_hud.session_view_requested.connect(_on_hud_session_view)
	# Ada's Aiven beat: D's on-screen "What's happening across the worlds?" button -> /operator/run.
	if _hud.has_signal("operator_run_requested"):
		_hud.operator_run_requested.connect(func(mid):
			if _bridge and _bridge.has_method("run_operator_mission"):
				_bridge.run_operator_mission(mid))
	# Multiplayer world browser (Lane D). D's "visit a world" front door relays these UP; B drives
	# the sidecar round-trips and hands results back to the Hud (mirrors the diff/sessions seams):
	#   worlds_requested()              -> bridge.fetch_worlds -> Hud.show_worlds(payload)
	#   world_visit_requested(world_id) -> bridge.fetch_world  -> render that world READ-ONLY
	if _hud.has_signal("worlds_requested"):
		_hud.worlds_requested.connect(_on_hud_worlds)
	if _hud.has_signal("world_visit_requested"):
		_hud.world_visit_requested.connect(_on_hud_world_visit)

func _setup_bridge() -> void:
	_bridge = SIDECAR_BRIDGE.new()
	add_child(_bridge)
	_bridge.world_updated.connect(_on_world_updated)
	# Connection pill (FIX 4): relay the bridge's LIVE/OFFLINE state to D's Hud status pill.
	if _hud != null and _hud.has_method("set_connection"):
		_bridge.connection_changed.connect(_hud.set_connection)

# Native voice (Track C). The VoiceWebSocket autoload (ported from a prior voice prototype) does mic capture +
# the ElevenLabs WS; here we just bind its caption/transcript signals to the in-world surfaces.
# Best-effort: if the autoload is missing (voice disabled) every call below is a guarded no-op.
func _setup_voice() -> void:
	_voice = get_node_or_null(VOICE_AUTOLOAD)
	if _voice == null:
		return
	# Track C's documented relay signals -> the 2D Hud + the 3D character surfaces.
	if _voice.has_signal("caption"):
		_voice.caption.connect(_on_voice_caption)
	if _voice.has_signal("speaking_changed"):
		_voice.speaking_changed.connect(_on_voice_speaking)
	if _voice.has_signal("conversation_ended"):
		_voice.conversation_ended.connect(_on_voice_ended)
	if _voice.has_signal("error_occurred"):
		_voice.error_occurred.connect(_on_voice_error)
	# Prime the mic once at boot so the macOS permission dialog fires off-stage, not mid-demo (FIX 5).
	if _voice.has_method("prime_mic"):
		_voice.prime_mic()
	# Lane D wiring: VoiceBridge (child of the autoload) re-emits A's `tool_activity` / `service` WS events;
	# relay them to the Hud so the open agent card's live-activity column + "Open localhost" chip light up.
	# These are NOT scoped to the voice target — the Hud id-scopes to the OPEN card itself.
	var bridge: Node = _voice.get_node_or_null("VoiceBridge")
	if bridge != null:
		if bridge.has_signal("tool_activity"):
			bridge.tool_activity.connect(_on_voice_tool_activity)
		if bridge.has_signal("service_up"):
			bridge.service_up.connect(_on_voice_service)

# ============================================================
#  Feed consumption
# ============================================================
func _on_world_updated(snapshot: Dictionary) -> void:
	var agents = snapshot.get("agents", [])
	if not (agents is Array):
		return
	# repo_path -> repo_id, harvested from the agents, so we can resolve a lock's
	# repo_path to the building that should carry its "LOCKED" tag.
	var path_to_repo: Dictionary = {}
	for a in agents:
		if a is Dictionary:
			_ingest_agent(a)
			var rp := _s(a.get("repo_path"))
			var rid := _s(a.get("repo_id"))
			if rp != "" and rid != "":
				path_to_repo[rp] = rid
	# Drive the per-agent task chips (Track D §4.4) from the same snapshot.
	for a in agents:
		if a is Dictionary:
			var aid := _s(a.get("agent_id"))
			if aid != "" and _agent_overlays.has(aid):
				var ov = _agent_overlays[aid]
				if is_instance_valid(ov):
					ov.apply_agent(a)
	# Drive the floating "LOCKED: <file>" tags over contested buildings.
	_apply_locks(snapshot.get("locks", []), path_to_repo)
	# Despawn agents that left the feed — otherwise removed agents leave ghost bodies forever.
	var seen := {}
	for av in agents:
		if av is Dictionary:
			var sid := _s(av.get("agent_id"))
			if sid != "":
				seen[sid] = true
	for aid in _agents.keys():
		if not seen.has(aid):
			_despawn_agent(aid)
	# Commit events -> the plant beat: the repo's agent walks to its next plot and plants.
	var events = snapshot.get("events", [])
	if events is Array:
		for ev in events:
			if ev is Dictionary and _s(ev.get("type")) == "commit":
				_handle_commit(ev)
	# Feed the whole snapshot to the 2D command center (Track D): roster, pending tray, and the
	# live agent card all refresh from this (Hud upserts in place — no flicker).
	if _hud and _hud.has_method("set_world"):
		_hud.set_world(snapshot)
		if DBG_CHAIN:
			print("[B/chain] /world agents=%d -> Hud.set_world" % agents.size())

# Remove an agent that left the /world feed: free its body (which frees its child name tag, lock
# overlay, and voice player) and clear every map so no ghost body lingers.
func _despawn_agent(agent_id: String) -> void:
	if _agents.has(agent_id):
		var a = _agents[agent_id]
		if is_instance_valid(a):
			a.queue_free()
		_agents.erase(agent_id)
	_agent_overlays.erase(agent_id)
	_voice_players.erase(agent_id)
	_last_view.erase(agent_id)
	if _selected_agent_id == agent_id:
		_selected_agent_id = ""
		if _hud and _hud.has_method("hide"):
			_hud.hide()
	if _dive_agent == agent_id:
		_leave_dive()

# A commit landed: route the committing agent to its repo's next plot and start the plant beat.
# De-duped by (agent_id|detail) since the events feed is polled and may repeat the same event.
func _handle_commit(ev: Dictionary) -> void:
	var agent_id := _s(ev.get("agent_id"))
	var message := _s(ev.get("detail"))
	var sig := "%s|%s" % [agent_id, message]
	if _seen_commits.has(sig):
		return
	_seen_commits[sig] = true
	if not _agents.has(agent_id) or not _agent_repo.has(agent_id):
		return
	var repo_id: String = _agent_repo[agent_id]
	if not _fields.has(repo_id):
		return
	var field = _fields[repo_id]
	if not is_instance_valid(field) or not field.has_free():
		return
	var plot = field.claim_plot()
	if plot == null:
		return
	var agent = _agents[agent_id]
	if not is_instance_valid(agent) or not agent.has_method("plant_at"):
		return
	agent.set_meta("pending_commit_msg", message)
	if not agent.is_connected("planted", _on_agent_planted):
		agent.planted.connect(_on_agent_planted)
	agent.plant_at(plot)
	if DBG_FARM:
		print("[B/farm] commit %s '%s' -> repo=%s plant_at %s" % [agent_id, message, repo_id, str(plot)])

# The agent finished the plant beat -> drop the plant model + the commit message onto the plot.
func _on_agent_planted(agent_id: String, at: Vector3) -> void:
	if not _agent_repo.has(agent_id) or not _agents.has(agent_id):
		return
	var repo_id: String = _agent_repo[agent_id]
	if not _fields.has(repo_id):
		return
	var field = _fields[repo_id]
	if not is_instance_valid(field):
		return
	var msg := ""
	var agent = _agents[agent_id]
	if is_instance_valid(agent) and agent.has_meta("pending_commit_msg"):
		msg = _s(agent.get_meta("pending_commit_msg"))
	field.plant(at, PlantRegistry.make_plant(), msg)
	if DBG_FARM:
		print("[B/farm] planted %s at %s msg='%s'" % [agent_id, str(at), msg])

# Show one "LOCKED: <file>" tag per held lock over the building that owns the file;
# clear the tag on any building no longer named by a lock this poll.
func _apply_locks(locks, path_to_repo: Dictionary) -> void:
	var locked_repos: Dictionary = {}
	if locks is Array:
		for lk in locks:
			if not (lk is Dictionary):
				continue
			var rp := _s(lk.get("repo_path"))
			var repo_id := _s(path_to_repo.get(rp))
			# Fallback: a lock whose repo_path didn't match any agent — try a building
			# keyed directly by the repo_path (defensive; usually the map hits).
			if repo_id == "" and _buildings.has(rp):
				repo_id = rp
			if repo_id == "":
				continue
			var ov = _building_overlay_for(repo_id)
			if ov != null and is_instance_valid(ov):
				ov.apply_lock(lk)
				locked_repos[repo_id] = true
	# Clear stale tags on buildings that hold no lock this poll.
	for repo_id in _building_overlays.keys():
		if not locked_repos.has(repo_id):
			var ov = _building_overlays[repo_id]
			if is_instance_valid(ov):
				ov.clear_lock()

func _ingest_agent(view: Dictionary) -> void:
	var agent_id := _s(view.get("agent_id"))
	if agent_id == "":
		return
	var repo_id := _s(view.get("repo_id"))
	if repo_id != "":
		_agent_repo[agent_id] = repo_id
	var kind := _s(view.get("character_kind"), "viking")
	# Ensure a building exists for this repo.
	var building = _ensure_building(repo_id)
	# Spawn the character on first sight.
	if not _agents.has(agent_id):
		_spawn_agent(agent_id, view, kind, building)
	_last_view[agent_id] = view
	apply_agent_state(agent_id, view)

# Drive one character's state from its AgentView. STATE IS SET ONLY HERE (external).
func apply_agent_state(agent_id: String, view: Dictionary) -> void:
	if not _agents.has(agent_id):
		return
	var agent = _agents[agent_id]
	if not is_instance_valid(agent):
		_agents.erase(agent_id)
		return
	var state := _s(view.get("state"), "waiting")
	# While you're TALKING to this agent (voice conversation), it must stand and idle —
	# not walk to its building or play its work/attack clip. Force idle for the active
	# conversation target (Mathias: "it should just be standing idle and talking").
	# Cleared automatically when the conversation ends (_voice_active_agent -> "").
	if agent_id != "" and agent_id == _voice_active_agent:
		state = "waiting"
	# Target building: prefer the agent's target_base_id, else its own repo's building.
	# (target_base_id is nullable in the contract — _s() coerces null -> "".)
	var target_id := _s(view.get("target_base_id"))
	if target_id == "":
		target_id = _s(view.get("repo_id"))
	var target_pos = _stand_pos_for(target_id)
	if target_pos != null:
		agent.set_state(state, target_pos)
	else:
		agent.set_state(state)
	# Idle-wander home = the stand pos in front of this agent's repo building. The agent you're
	# TALKING to stands still (no wander) — it should just idle and talk.
	var home_pos = _stand_pos_for(_s(view.get("repo_id")))
	if home_pos != null and agent.has_method("set_home"):
		agent.set_home(home_pos)
	# Vinny (a1) is the demo agent — he stands still at his house so you can reliably walk up and talk
	# (Mathias: "just the Vinny standing still in idle"). Everyone else still wanders for ambient life.
	agent.allow_wander = (agent_id != _voice_active_agent) and (agent_id != "a1")

# ============================================================
#  Spawning — colliders built in agent.gd._ready() at spawn (click safety)
# ============================================================
func _spawn_agent(agent_id: String, view: Dictionary, kind: String, building) -> void:
	# The agent root is a unit-scale Node3D; the character GLB is its "Model" child, fitted
	# to a readable world height in agent.gd. Decoupling body-scale from the root keeps name
	# tags / overlays / the click collider in real world units — the GLB roots import at a
	# 0.01 armature scale, so scaling the root absolutely is what made bodies ~130x too big.
	var a := Node3D.new()
	a.set_script(AGENT)
	var body := _instantiate_character(kind)
	body.name = "Model"
	a.add_child(body)
	# Use the kind we ACTUALLY spawned (a greg fallback changes the skeleton, so anim-clip
	# merging in agent.gd must match) — stashed as meta on the body before the wrap.
	var eff_kind := _s(body.get_meta("effective_kind", kind))
	var label := _s(view.get("label"), agent_id)
	a.setup(agent_id, label, eff_kind)      # setup BEFORE add_child (the unit contract)
	add_child(a)
	# Spawn BEHIND the building (away from map centre), distinct from the stand/work
	# position (which is in FRONT, toward centre). This makes `moving` lerp a real,
	# visible distance to the building instead of starting on top of the target.
	# Honor an explicit world position from the snapshot if the feed carries one (the visit-render
	# path: a remote SharedAgent with {position:{x,z}} renders at its REAL spot, not (0,0,0) on top
	# of the building). Falls back to the building-relative spawn for the live local feed.
	var spawn_pos := _spawn_pos_for_node(building)
	var explicit = _pos_from_view(view)
	if explicit != null:
		spawn_pos = explicit
	a.global_position = spawn_pos            # global_position AFTER add_child
	_attach_name_tag(a, label)
	_attach_lock_overlay(a, agent_id)
	_agents[agent_id] = a

func _glb_for_kind(kind: String) -> PackedScene:
	match kind:
		"wizard":
			return WIZARD_GLB
		"dwarf":
			return DWARF_GLB
		"barbarian":
			return BARBARIAN_GLB
		_:
			return VIKING_GLB

# Instantiate the character body for `kind`, GUARANTEEING a renderable mesh (gate zero).
# If the chosen Meshy model imports without a usable skinned mesh (the failure the plan
# warns about), free it and fall back to the known-good greg model so a body always shows.
# Stashes the kind actually used as meta("effective_kind") for downstream anim merging.
func _instantiate_character(kind: String) -> Node3D:
	var k := FORCE_KIND if FORCE_KIND != "" else kind
	var node: Node3D = _glb_for_kind(k).instantiate()
	if _has_renderable_mesh(node):
		node.set_meta("effective_kind", k)
		return node
	push_warning("[WorldManager] character '%s' has no renderable mesh — falling back to greg" % k)
	node.queue_free()
	var fallback: Node3D = BARBARIAN_GLB.instantiate()
	fallback.set_meta("effective_kind", "barbarian")
	return fallback

# True if the subtree contains a MeshInstance3D with real, non-degenerate geometry.
# Catches the "instanced but invisible" case (no mesh / no surfaces / zero-size AABB).
func _has_renderable_mesh(n: Node) -> bool:
	var mi := _first_mesh_instance(n)
	if mi == null or mi.mesh == null:
		return false
	if mi.mesh.get_surface_count() <= 0:
		return false
	return mi.mesh.get_aabb().size.length() > 0.001

func _first_mesh_instance(n: Node) -> MeshInstance3D:
	for c in n.get_children():
		if c is MeshInstance3D:
			return c
		var found := _first_mesh_instance(c)
		if found:
			return found
	return null

# A floating name billboard above the character (reuses the health_bar billboard
# style via a 3D Label). Added under the agent in world space.
func _attach_name_tag(agent: Node3D, label: String) -> void:
	var tag := Label3D.new()
	tag.name = "NameTag"
	# Keep the name a tiny one-line tag — truncate so a long agent id can't render
	# as a screen-spanning billboard.
	var clean := label.strip_edges()
	if clean.length() > 24:
		clean = clean.substr(0, 24).strip_edges() + "…"
	tag.text = clean
	tag.font_size = 40
	# fixed_size + tiny pixel_size: constant small on-screen size regardless of camera
	# distance (mirrors lock_overlay.gd) so the name never balloons on a close dive.
	tag.fixed_size = true
	tag.pixel_size = 0.0004
	tag.width = 320.0
	tag.autowrap_mode = TextServer.AUTOWRAP_OFF
	tag.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	tag.no_depth_test = true
	tag.modulate = Color(1, 1, 1, 0.95)
	tag.outline_size = 6
	tag.position = Vector3(0.0, 2.6, 0.0)
	agent.add_child(tag)

# Instance one LockOverlay per agent (Track D) and add it under the character so its
# billboard task-chip floats above the body. The overlay's Label3Ds are fixed_size
# billboards, so the agent's visual_scale doesn't distort the text. Driven each poll
# from the /world snapshot via apply_agent() (chip + blocked-chip colour).
func _attach_lock_overlay(agent: Node3D, agent_id: String) -> void:
	var ov = LOCK_OVERLAY.new()
	ov.name = "LockOverlay"
	agent.add_child(ov)
	_agent_overlays[agent_id] = ov

# Lazily instance one LockOverlay per BUILDING for the floating "LOCKED: <file>" tag.
# Added in WORLD space at the building's position (NOT as a child of the house — the
# house is scaled ~8x, which would multiply the overlay's local Y and balloon the tag
# off-screen). Parented to our scene root, unscaled, so lock_height reads in real units.
func _building_overlay_for(repo_id: String):
	if repo_id == "" or not _buildings.has(repo_id):
		return null
	if _building_overlays.has(repo_id):
		var existing = _building_overlays[repo_id]
		if is_instance_valid(existing):
			return existing
		_building_overlays.erase(repo_id)
	var b = _buildings[repo_id]
	if not is_instance_valid(b):
		return null
	var ov = LOCK_OVERLAY.new()
	ov.name = "LockTag_%s" % repo_id
	var root := get_parent()
	if root == null:
		return null
	root.add_child(ov)
	# Place over the building, lifted to clear the roof of the (8x-scaled) house.
	ov.global_position = b.global_position + Vector3(0.0, 6.0, 0.0)
	_building_overlays[repo_id] = ov
	return ov

# ============================================================
#  Buildings — reuse the two Houses, then spawn new ones at free octagon slots
# ============================================================
func _ensure_building(repo_id: String):
	if repo_id == "":
		return null
	if _buildings.has(repo_id):
		_ensure_field(repo_id)
		return _buildings[repo_id]
	var b
	# Claim a pre-placed House first (no new art).
	if not _house_pool.is_empty():
		b = _house_pool.pop_front()
	else:
		# Otherwise spawn a fresh repo building at a free slot.
		b = spawn_repo_building(repo_id)
	_buildings[repo_id] = b
	_ensure_field(repo_id)
	return b

# Build the repo's farm field once, beside its house (further OUT from map centre so it doesn't
# overlap the building or the agent's stand/spawn area), then pre-seed all but the last few plots
# so it reads as accumulated history (your Hay Day screenshot) with room for live commits.
func _ensure_field(repo_id: String) -> void:
	if repo_id == "" or _fields.has(repo_id) or not _buildings.has(repo_id):
		return
	var b = _buildings[repo_id]
	if not is_instance_valid(b):
		return
	var bp: Vector3 = b.global_position
	var outv := bp
	outv.y = 0.0
	var dir := outv.normalized() if outv.length() > 0.001 else Vector3.BACK
	var center := bp + dir * FIELD_OFFSET
	center.y = 0.0
	var field = FARM_FIELD.new()
	field.name = "Farm_%s" % repo_id
	get_parent().add_child(field)
	field.setup(center, FIELD_COLS, FIELD_ROWS, FIELD_CELL)
	_fields[repo_id] = field
	# Pre-seed all but the last 3 plots so live commits have empty plots to land on visibly.
	var seed_count: int = max(0, field.plot_count() - 3)
	for _i in range(seed_count):
		var p = field.claim_plot()
		if p == null:
			break
		field.plant(p, PlantRegistry.make_plant(), "")
	if DBG_FARM:
		print("[B/farm] field repo=%s plots=%d seeded=%d at=%s" % [repo_id, field.plot_count(), seed_count, str(center)])

# Spawn a repo building (a House) at a free octagon slot where |x|+|z| < 31, not
# colliding with an already-used slot. Returns the building node.
func spawn_repo_building(repo_id: String) -> Node3D:
	var pos := _free_slot()
	var house = HOUSE_GLB.instantiate()
	house.set_script(BASE)
	# Match the pre-placed houses' scale + a yaw facing roughly toward centre.
	var yaw := atan2(-pos.x, -pos.z)
	var basis := Basis(Vector3.UP, yaw).scaled(Vector3.ONE * HOUSE_SCALE)
	get_parent().add_child(house)
	house.global_transform = Transform3D(basis, pos)
	_buildings[repo_id] = house
	_used_slots.append(pos)
	return house

# Find a free octagon slot: scan candidate ring positions and pick the first one
# at least a minimum distance from every used slot, staying inside |x|+|z| < 31.
func _free_slot() -> Vector3:
	var min_sep := 9.0
	# Candidate angles around the central ring; bias to corners away from the houses.
	for step in range(16):
		var ang := TAU * float(step) / 16.0
		var p := Vector3(cos(ang) * BUILDING_INSET, 0.0, sin(ang) * BUILDING_INSET)
		if absf(p.x) + absf(p.z) >= OCTAGON_LIMIT:
			continue
		var ok := true
		for used in _used_slots:
			if p.distance_to(used) < min_sep:
				ok = false
				break
		if ok:
			return p
	# Fallback: a jittered point inside the octagon if the ring is full.
	for _i in range(20):
		var p := Vector3(randf_range(-22.0, 22.0), 0.0, randf_range(-22.0, 22.0))
		if absf(p.x) + absf(p.z) < OCTAGON_LIMIT:
			return p
	return Vector3.ZERO

# World position an agent stands/works at for a given repo (in front of its
# building, toward map centre). Returns null if the repo has no building yet.
func _stand_pos_for(repo_id: String):
	if not _buildings.has(repo_id):
		return null
	var b = _buildings[repo_id]
	if not is_instance_valid(b):
		return null
	return _stand_pos_for_node(b)

func _stand_pos_for_node(building) -> Vector3:
	if building == null or not is_instance_valid(building):
		return Vector3.ZERO
	var bp: Vector3 = building.global_position
	var to_center := Vector3.ZERO - bp
	to_center.y = 0.0
	var dir := to_center.normalized() if to_center.length() > 0.001 else Vector3.FORWARD
	var p := bp + dir * STAND_OFFSET
	p.y = 0.0
	return p

# Spawn position for an agent: BEHIND its building (away from map centre), the
# opposite side from the stand/work position. Walking from here to the stand pos
# covers SPAWN_OFFSET + STAND_OFFSET of ground — well past arrive_dist (3.4) — so
# the `moving` beat (D4) is visible even when an agent's target IS its own repo.
func _spawn_pos_for_node(building) -> Vector3:
	if building == null or not is_instance_valid(building):
		return Vector3.ZERO
	var bp: Vector3 = building.global_position
	var to_center := Vector3.ZERO - bp
	to_center.y = 0.0
	# Away-from-centre direction (behind the building). Fallback if dead-centre.
	var away := (-to_center).normalized() if to_center.length() > 0.001 else Vector3.BACK
	var p := bp + away * SPAWN_OFFSET
	p.y = 0.0
	return p

# ============================================================
#  Selection + panel relay
# ============================================================
func _on_agent_selected(agent_id: String) -> void:
	# Clear the previous highlight.
	if _selected_agent_id != "" and _agents.has(_selected_agent_id):
		var prev = _agents[_selected_agent_id]
		if is_instance_valid(prev):
			prev.set_selected(false)
	if agent_id == "" or not _agents.has(agent_id):
		_selected_agent_id = ""
		if _hud and _hud.has_method("hide"):
			_hud.hide()
		return
	_selected_agent_id = agent_id
	var agent = _agents[agent_id]
	if is_instance_valid(agent):
		agent.set_selected(true)
	# Open the agent card on the Hud with the latest known view (next poll fills live fields).
	if _hud and _hud.has_method("show_agent"):
		_hud.show_agent(_latest_view(agent_id))
		if DBG_CHAIN:
			print("[B/chain] selected %s -> Hud.show_agent" % agent_id)

# Build a best-effort AgentView dict for the panel from what we last rendered.
# (The next poll's update_agent() overwrites the live fields anyway.)
func _latest_view(agent_id: String) -> Dictionary:
	var agent = _agents.get(agent_id)
	var label := agent_id
	var kind := "viking"
	var repo := ""
	var state := "waiting"
	if is_instance_valid(agent):
		label = agent.label
		kind = agent.character_kind
		state = agent.state
	# repo_id: reverse-lookup from our buildings is overkill; the next poll fills it.
	return {
		"agent_id": agent_id, "label": label, "repo_id": repo,
		"character_kind": kind, "state": state, "status_line": "",
		"transcript_tail": [],
	}

# ============================================================
#  Hud (Track D) UP-signal handlers — the 2D command center drives these
# ============================================================

# Send / Enter in the card -> relay the prompt to the agent's session (bridge owns the POST).
func _on_hud_prompt(agent_id: String, prompt: String) -> void:
	if _bridge and _bridge.has_method("send_prompt"):
		_bridge.send_prompt(agent_id, prompt)
	if DBG_CHAIN:
		print("[B/chain] prompt %s: %s -> bridge.send_prompt" % [agent_id, prompt])

# Talk -> the signature dive: camera descends, the 2D UI shifts to the conversation surface,
# and Track C opens the realtime voice line (C fetches /context itself).
func _on_hud_talk(agent_id: String) -> void:
	if agent_id == "" or not _agents.has(agent_id):
		return
	if _dive_agent == agent_id:
		return                               # already diving into this one
	if _dive_agent != "":
		_leave_dive()                        # switch: leave the current dive first
	if _selected_agent_id != agent_id:
		_on_agent_selected(agent_id)         # talk can come from the roster, not the 3D click
	_dive_agent = agent_id
	_dive_to(agent_id)                       # B2 camera dive (faces the agent)
	if _hud and _hud.has_method("enter_dive"):
		_hud.enter_dive(agent_id)            # D: command -> conversation surface
	_enter_voice(agent_id)                   # C: /context + realtime voice + mic
	if DBG_CHAIN:
		print("[B/chain] talk %s -> dive (camera + Hud.enter_dive + voice.start_dive)" % agent_id)

# Diff action -> fetch the agent's real git diff (sidecar owns the GET) -> hand text to the Hud.
func _on_hud_diff(agent_id: String) -> void:
	if _bridge and _bridge.has_method("fetch_diff"):
		_bridge.fetch_diff(agent_id, _on_diff_fetched)
	if DBG_CHAIN:
		print("[B/chain] diff_requested %s -> bridge.fetch_diff" % agent_id)

func _on_diff_fetched(agent_id: String, text: String) -> void:
	if _hud and _hud.has_method("show_diff"):
		_hud.show_diff(agent_id, text)

# New chat -> archive the live session + bring up a fresh Claude run (bridge owns the POST).
# On a 200 the bridge calls back so we tell the Hud to clear the card to a fresh chat.
func _on_hud_new_chat(agent_id: String) -> void:
	if _bridge and _bridge.has_method("new_session"):
		_bridge.new_session(agent_id, _on_new_session_started)
	if DBG_CHAIN:
		print("[B/chain] new_chat_requested %s -> bridge.new_session" % agent_id)

func _on_new_session_started(agent_id: String) -> void:
	if _hud and _hud.has_method("session_started"):
		_hud.session_started(agent_id)

# Send away -> archive the active session + put the character to sleep (next poll shows asleep).
func _on_hud_send_away(agent_id: String) -> void:
	if _bridge and _bridge.has_method("send_away"):
		_bridge.send_away(agent_id)
	if DBG_CHAIN:
		print("[B/chain] send_away_requested %s -> bridge.send_away" % agent_id)

# History -> fetch the character's session list (bridge owns the GET) -> hand it to the Hud.
func _on_hud_sessions(agent_id: String) -> void:
	if _bridge and _bridge.has_method("fetch_sessions"):
		_bridge.fetch_sessions(agent_id, _on_sessions_fetched)
	if DBG_CHAIN:
		print("[B/chain] sessions_requested %s -> bridge.fetch_sessions" % agent_id)

func _on_sessions_fetched(agent_id: String, sessions) -> void:
	if _hud and _hud.has_method("show_sessions"):
		_hud.show_sessions(agent_id, sessions)

# View an archived session -> fetch its transcript (bridge owns the GET) -> hand it to the Hud.
func _on_hud_session_view(agent_id: String, session_id: String) -> void:
	if _bridge and _bridge.has_method("fetch_session_transcript"):
		_bridge.fetch_session_transcript(agent_id, session_id, _on_session_transcript_fetched)
	if DBG_CHAIN:
		print("[B/chain] session_view_requested %s/%s -> bridge.fetch_session_transcript" % [agent_id, session_id])

func _on_session_transcript_fetched(agent_id: String, session_id: String, lines) -> void:
	if _hud and _hud.has_method("show_session_transcript"):
		_hud.show_session_transcript(agent_id, session_id, lines)

# World browser opened -> fetch the multiplayer directory (bridge owns the GET) -> hand to the Hud.
# Re-opening the browser is also the "leave the visited world" affordance: if we were visiting,
# resume the live /world poll so the next selection (incl. your own world) starts from a live base.
func _on_hud_worlds() -> void:
	if _visiting:
		_exit_visit()
	if _bridge and _bridge.has_method("fetch_worlds"):
		_bridge.fetch_worlds(_on_worlds_fetched)
	if DBG_CHAIN:
		print("[B/chain] worlds_requested -> bridge.fetch_worlds")

# Leave read-only visit mode: resume the live /world poll. The next live snapshot despawns the
# visited guest bodies (they're not in the live feed) and re-renders your own world.
func _exit_visit() -> void:
	_visiting = false
	if _bridge and _bridge.has_method("set_paused"):
		_bridge.set_paused(false)

func _on_worlds_fetched(payload) -> void:
	if _hud and _hud.has_method("show_worlds"):
		_hud.show_worlds(payload)

# A world row was clicked -> fetch that world's anonymized SharedWorldSnapshot and render it
# READ-ONLY: pause the live /world poll (so it can't stomp the visited bodies), then push the
# visited agents through the normal render path as AgentView-shaped dicts. Closing the browser
# (or visiting "your" own world id) resumes the live poll.
func _on_hud_world_visit(world_id: String) -> void:
	if _bridge and _bridge.has_method("fetch_world"):
		_bridge.fetch_world(world_id, _on_world_visited)
	if DBG_CHAIN:
		print("[B/chain] world_visit_requested %s -> bridge.fetch_world" % world_id)

func _on_world_visited(world_id: String, snapshot) -> void:
	if not (snapshot is Dictionary):
		return
	# Enter read-only visit mode: stop the live poller so its snapshots don't fight the visited one.
	_visiting = true
	if _bridge and _bridge.has_method("set_paused"):
		_bridge.set_paused(true)
	# Map SharedAgent[] (the safe subset) -> AgentView-shaped dicts the render path understands.
	# SharedAgent carries no task/transcript/lock data, so those render as empty (read-only).
	var shared = snapshot.get("agents", [])
	var views: Array = []
	if shared is Array:
		for sa in shared:
			if not (sa is Dictionary):
				continue
			var v := {
				"agent_id": _s(sa.get("agent_id")),
				"repo_id": _s(sa.get("repo_id")),
				"repo_path": "",
				"character_kind": _s(sa.get("character_kind"), "viking"),
				"state": _s(sa.get("state"), "waiting"),
				"label": _s(sa.get("label"), _s(sa.get("agent_id"))),
				"status_line": "visiting %s" % _s(snapshot.get("name"), world_id),
				"current_task": null, "target_base_id": _s(sa.get("repo_id")),
				"heartbeat_age_s": 0, "transcript_tail": [],
			}
			# Carry the remote agent's coordinates through so it renders at its REAL spot in the
			# visited world (not stacked at the building). Only present once the sidecar publishes
			# position in SharedAgent; absent today -> building-relative spawn (graceful).
			if sa.has("position"):
				v["position"] = sa.get("position")
			views.append(v)
	# Render the visited world through the same consumer the live poll uses (read-only: no locks/events).
	_on_world_updated({"agents": views, "locks": [], "events": [], "characters": []})
	# Ensure a building + farm field for EVERY repo in the visited snapshot — not just repos that happen to
	# have a live agent (which is all _on_world_updated above creates). A visited world publishes a tree per
	# commit for every repo, so a repo whose agents are all asleep still needs its field to receive plants.
	var vrepos = snapshot.get("repos", [])
	if vrepos is Array:
		for rep in vrepos:
			if rep is Dictionary:
				var rid := _s(rep.get("id"))
				if rid != "":
					_ensure_building(rid)
	# Render the visited world's planted trees with LOCAL assets. Each plant carries repo_id + commit
	# message; no coordinate on the live path, so _render_visited_plants claims a plot on the repo's field.
	_render_visited_plants(snapshot.get("plants", []))
	# Close the browser so the visited world is visible underneath.
	if _hud and _hud.has_method("close_world_browser"):
		_hud.close_world_browser()
	if DBG_CHAIN:
		print("[B/chain] visited %s agents=%d (poll paused)" % [world_id, views.size()])

# Render a visited world's planted trees with LOCAL assets (PlantRegistry) at their published
# coordinates. Each plant carries {repo_id?, x, z OR position:{x,z}, message?}. We drop the LOCAL
# plant model + the commit message label on the matching repo's farm field (or, if that repo has no
# field yet, a standalone holder) so the visitor sees the other person's commit history as trees.
# Absent today (sidecar doesn't publish plants yet) -> this is a no-op; present -> renders cleanly.
func _render_visited_plants(plants) -> void:
	if not (plants is Array) or plants.is_empty():
		return
	for pl in plants:
		if not (pl is Dictionary):
			continue
		var msg := _s(pl.get("message"))
		var repo_id := _s(pl.get("repo_id"))
		var has_field: bool = repo_id != "" and _fields.has(repo_id) and is_instance_valid(_fields[repo_id])
		# An explicit published coord pins the plant exactly; absent (the live path — no server-side layout)
		# we let the repo's farm field self-assign the next free plot via claim_plot(). Either way the tree
		# lands inside the repo's soil/fence. Only when neither a coord NOR a field exists do we skip.
		var at = _pos_from_view(pl)
		if at == null and has_field:
			at = _fields[repo_id].claim_plot()
		if at == null:
			continue
		# Prefer the repo's farm field so plants land inside its soil/fence; else a bare holder node.
		if has_field:
			_fields[repo_id].plant(at, PlantRegistry.make_plant(), msg)
		else:
			var holder := Node3D.new()
			get_parent().add_child(holder)
			var model: Node3D = PlantRegistry.make_plant()
			holder.add_child(model)
			model.global_position = at
		if DBG_FARM:
			print("[B/farm] visited plant repo=%s at=%s msg='%s'" % [repo_id, str(at), msg])

func _on_hud_approve(agent_id: String) -> void:
	if _bridge and _bridge.has_method("approve"):
		_bridge.approve(agent_id)

func _on_hud_merge(project_id: String) -> void:
	if _bridge and _bridge.has_method("merge"):
		_bridge.merge(project_id)

func _on_hud_dive_exit(_agent_id: String) -> void:
	_leave_dive()

# ============================================================
#  Dive lifecycle — camera (B2) + 2D surface (D) + voice (C) move together
# ============================================================
func _leave_dive() -> void:
	_undive()                                # camera rises to command framing
	if _hud and _hud.has_method("exit_dive"):
		_hud.exit_dive()
	_exit_voice()
	_dive_agent = ""

# Track C voice: one call opens the realtime line — C fetches /context itself; we pass the id
# + the positional sink so the voice emanates from the character.
func _enter_voice(agent_id: String) -> void:
	if _voice == null:
		_voice = get_node_or_null(VOICE_AUTOLOAD)
	if _voice == null or not _agents.has(agent_id):
		return                               # voice disabled — the dive still works visually
	var node = _agents[agent_id]
	if not is_instance_valid(node):
		return
	var vp = _ensure_voice_player(agent_id)
	if _voice.has_method("start_dive"):
		_voice.start_dive(agent_id, vp)      # C's seam: /context + conversation + mic
	elif _voice.has_method("start_conversation"):
		_voice.start_conversation(agent_id)  # legacy fallback
	_voice_active_agent = agent_id
	# Re-apply state THIS frame so the agent stands & idles immediately (clears allow_wander,
	# plays the idle clip) instead of walking / holding a stale pose until the next /world poll.
	if _last_view.has(agent_id):
		apply_agent_state(agent_id, _last_view[agent_id])

func _exit_voice() -> void:
	if _voice and _voice.has_method("end_conversation"):
		_voice.end_conversation()
	var prev := _voice_active_agent
	_voice_active_agent = ""
	# Re-arm wander THIS frame for the agent we just left (apply_agent_state now sees it is no
	# longer the active voice target) instead of waiting for the next /world poll.
	if prev != "" and _last_view.has(prev):
		apply_agent_state(prev, _last_view[prev])

# Lazily attach one AgentVoicePlayer under the agent so its voice plays in 3D from that body.
func _ensure_voice_player(agent_id: String):
	if _voice_players.has(agent_id):
		var existing = _voice_players[agent_id]
		if is_instance_valid(existing):
			return existing
		_voice_players.erase(agent_id)
	if not _agents.has(agent_id):
		return null
	var agent = _agents[agent_id]
	if not is_instance_valid(agent):
		return null
	var sink = AGENT_VOICE_PLAYER.new()
	sink.name = "AgentVoicePlayer"           # name matches Track C's hook lookup
	agent.add_child(sink)
	_voice_players[agent_id] = sink
	return sink

# --- Voice relay handlers -> the 2D Hud + the 3D character surfaces ---
func _on_voice_caption(text: String) -> void:
	_push_voice_caption(_voice_active_agent, text)

func _on_voice_speaking(on: bool) -> void:
	if _hud and _hud.has_method("set_speaking") and _voice_active_agent != "":
		_hud.set_speaking(_voice_active_agent, on)

# Floating caption over the speaking agent's chip (3D) + the Hud conversation surface (2D).
func _push_voice_caption(agent_id: String, text: String) -> void:
	if agent_id == "" or text.strip_edges() == "":
		return
	if _agent_overlays.has(agent_id):
		var ov = _agent_overlays[agent_id]
		if is_instance_valid(ov):
			ov.set_chip(text)
	if _hud and _hud.has_method("caption"):
		_hud.caption(agent_id, text)

# A's mid-turn per-tool pulse -> the open card's live-activity line. The Hud no-ops unless the card is
# open AND showing this agent (id-scoped there), so an off-card agent's pulse can't write the wrong card.
func _on_voice_tool_activity(agent_id: String, tool: String, summary: String) -> void:
	if _hud and _hud.has_method("activity"):
		_hud.activity(agent_id, tool, summary)

# A's `service` event -> the open card's "Open localhost ↗" chip. Same Hud id-scoping as activity().
func _on_voice_service(agent_id: String, url: String) -> void:
	if _hud and _hud.has_method("service"):
		_hud.service(agent_id, url)

func _on_voice_ended() -> void:
	_leave_dive()

func _on_voice_error(message: String) -> void:
	push_warning("[WorldManager] voice error: %s" % message)

# ============================================================
#  Camera dive (Track B2) — enter/exit + an F-key debug that drives the FULL chain
#  (camera + Hud + voice) so the dive is verifiable before a Hud Talk button exists.
# ============================================================
func _dive_to(agent_id: String) -> void:
	if _cam_ctrl == null or not _agents.has(agent_id):
		return
	var node = _agents[agent_id]
	if is_instance_valid(node) and _cam_ctrl.has_method("enter_dive"):
		_cam_ctrl.enter_dive(node)

func _undive() -> void:
	if _cam_ctrl != null and _cam_ctrl.has_method("exit_dive"):
		if not _cam_ctrl.has_method("is_diving") or _cam_ctrl.is_diving():
			_cam_ctrl.exit_dive()

# (Removed the DEBUG F-key dive toggle — the Hud Talk button is the only dive trigger now, so a stray
# keyboard press on stage can't fire an unintended dive.)

# Null-safe Variant -> String. Contract fields like target_base_id / current_task
# are nullable; String(null) throws, so coerce null (and a missing key) to `def`.
func _s(v, def: String = "") -> String:
	if v == null:
		return def
	return String(v)

# Extract an explicit world position from an AgentView/SharedAgent if the feed carries one.
# Accepts {position:{x,z}} (the multiplayer coord shape) or {x,z} at the top level. Returns a
# ground-plane Vector3 (y=0) or null if no usable coords are present (live local feed path).
func _pos_from_view(view: Dictionary):
	var p = view.get("position")
	if p is Dictionary and (p.has("x") or p.has("z")):
		return Vector3(float(p.get("x", 0.0)), 0.0, float(p.get("z", 0.0)))
	if view.has("x") or view.has("z"):
		return Vector3(float(view.get("x", 0.0)), 0.0, float(view.get("z", 0.0)))
	return null
