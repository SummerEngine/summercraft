extends CanvasLayer
# ============================================================================
#  Hud — SummerCraft command center SHELL (Chat D / The Interface).
#
#  THE single screen-space root, registered as the `Hud` autoload; B (the 3D
#  world) talks ONLY to this. After the decomposition the shell is THIN: it
#  instantiates the four 2D components and routes data + signals between them
#  and B. It owns no widget tree of its own beyond a brand strip — every surface
#  is a component leaf:
#    • FleetRoster      (scenes/ui/fleet_roster.tscn) — left rail: who / state /
#                        approve, project-overview tabs.
#    • InteractionPanel (scenes/interaction_panel.tscn) — the per-agent card
#                        (header · transcript · actions · input · hosted DiffView).
#    • PendingTray      (scenes/ui/pending_tray.tscn) — "what needs me": review /
#                        blocked / the per-project merge ritual.
#    • DiveOverlay      (scenes/ui/dive_overlay.tscn) — the first-person dive
#                        surface (context ribbon · caption history · visualiser).
#
#  ── Frozen seam (§5.3 / INTERFACES.md §1) — methods B calls, signals B connects.
#     These signatures are LAW; do not change them. ──────────────────────────
#    Hud.set_world(snapshot)         Hud.show_agent(view)     Hud.update_agent(view)
#    Hud.show_diff(agent_id, text)   Hud.hide()
#    Hud.enter_dive(agent_id)        Hud.exit_dive()
#    signals: prompt_submitted, talk_requested, diff_requested, merge_requested,
#             approve
#
#  ── ADDITIVE (announced to the orchestrator; breaks no existing shape) ───────
#    Hud.caption(agent_id, text) / Hud.set_speaking(agent_id, on)  — the caption
#        surface §4.D requires (seam #3 listed no caption sink). C/B feed these.
#    Hud.set_context(agent_id, context) — hand C's AgentContext (branch/pr/diff)
#        to the live dive ribbon. Optional; the dive reads the AgentView regardless.
#    Hud.activity(agent_id, tool, summary) — relay A's `tool_activity` WS event; shows
#        the agent's most recent action ("⚙ Bash: npm run dev") on its open card AND as a
#        subtle dim one-liner under that agent's chip on the LEFT roster.
#    Hud.service(agent_id, url) — relay A's `service` WS event; shows an "Open
#        localhost ↗" chip on the open card (click → OS.shell_open).
#    signal dive_exit_requested(agent_id)  — the on-screen "Leave" button.
#    signal rejected(agent_id)  — the tray's ✗ "send back" verb (no contract
#        reject seam yet; the shell surfaces it so B/A can decide the policy).
#    Hud.session_started(agent_id) — B calls this after a successful POST
#        /agents/:id/new-session so the card clears to a fresh chat.
#    Hud.show_sessions(agent_id, list) — B hands back A's GET /agents/:id/sessions
#        (SessionSummary[]) for the card's History panel.
#    Hud.show_session_transcript(agent_id, session_id, lines) — B hands back an
#        archived session's transcript for read-only viewing.
#    signals new_chat_requested / send_away_requested / sessions_requested /
#        session_view_requested  — the card's session verbs, relayed for B.
#
#  All sidecar comms stay in B: for a diff we emit diff_requested; B fetches
#  GET /agents/:id/diff and hands the text back via Hud.show_diff().
# ============================================================================

# --- Frozen contract signals (UNCHANGED) ---
signal prompt_submitted(agent_id: String, text: String)
signal talk_requested(agent_id: String)
signal diff_requested(agent_id: String)
signal merge_requested(project_id: String)
signal approve(agent_id: String)
# --- Additive (announced) ---
signal dive_exit_requested(agent_id: String)
signal rejected(agent_id: String)
signal operator_run_requested(mission_id: String)  # Ada's Aiven beat → B → sidecar /operator/run
# --- Additive (announced): character/session verbs (mirror prompt_submitted) ─────
# These relay the card's session verbs OUT for B (world_manager connects via has_signal,
# exactly like prompt_submitted). All sidecar comms stay in B:
#   new_chat_requested(agent_id)  → B POSTs /agents/:id/new-session ; on 200 B calls
#                                   Hud.session_started(agent_id) to clear the card.
#   send_away_requested(agent_id) → B POSTs /agents/:id/send-away.
#   sessions_requested(agent_id)  → B GETs  /agents/:id/sessions, hands back via
#                                   Hud.show_sessions(agent_id, list).
#   session_view_requested(agent_id, session_id) → B fetches that archived transcript,
#                                   hands back via Hud.show_session_transcript(...).
signal new_chat_requested(agent_id: String)
signal send_away_requested(agent_id: String)
signal sessions_requested(agent_id: String)
signal session_view_requested(agent_id: String, session_id: String)
# --- Additive (announced): MULTIPLAYER WORLD BROWSER (Lane D) ────────────────
# The "visit other people's worlds" front door. All sidecar comms stay in B:
#   worlds_requested()              → B GETs /worlds, hands the payload back via
#                                     Hud.show_worlds(payload) (open_world_browser() emits
#                                     this right after opening, so the panel self-loads).
#   world_visit_requested(world_id) → B loads that world read-only (its own bridge).
# Relayed OUT exactly like new_chat_requested (world_manager connects via has_signal).
signal world_visit_requested(world_id: String)
signal worlds_requested()

const AGENT_PANEL := preload("res://scenes/interaction_panel.tscn")
const FLEET_ROSTER := preload("res://scenes/ui/fleet_roster.tscn")
const PENDING_TRAY := preload("res://scenes/ui/pending_tray.tscn")
const DIVE_OVERLAY := preload("res://scenes/ui/dive_overlay.tscn")
# WorldBrowser is a SCRIPT (no .tscn) — instantiated via .new() like a pure Control. Lane D
# ships one component file (scripts/ui/world_browser.gd) plus this seam; it owns its whole
# widget tree in _ready(), so no scene is needed. preload the script as a value (never a type).
const WORLD_BROWSER := preload("res://scripts/ui/world_browser.gd")
const WORK_LOG := preload("res://scripts/ui/work_log.gd")

# Bind UiSounds by path (preload const) — scripts/ui is NOT in the editor's global
# class cache, so a global class_name / static type annotation would fail to resolve
# at load (the load fix, commit 82aa023). preload always resolves. The shell plays
# ONLY the events no component can own — the `events[]` feed's `error` beat; every
# other UI sound (open/close/select/state/approve/merge/dive/caption) is owned at
# its component call site, so the shell stays silent there to avoid double-firing.
const UiSounds := preload("res://scripts/ui/ui_sounds.gd")

# Left-rail rail width as a fraction of the viewport, clamped to a readable band,
# so the roster reflows between portrait 720x1280 and a wide projector.
const RAIL_W_FRAC := 0.26
const RAIL_W_MIN := 280.0
const RAIL_W_MAX := 360.0
const TRAY_W_FRAC := 0.26
const TRAY_W_MIN := 300.0
const TRAY_W_MAX := 380.0
const TOPBAR_H := 46.0  # now just reserves room for the tiny brand mark (no bar)
const EDGE_INSET := 16.0
const GAP := 12.0

# The tray shares the right column with the agent card (which docks bottom-right).
# To keep the two surfaces provably DISJOINT at every aspect, the tray's bottom is
# clamped to sit above the card's top edge. These mirror the EXPANDED-card branch of
# interaction_panel.gd's _relayout (interaction_panel.gd:250-251 —
# `clampf(vps.y * CARD_H_FRAC, CARD_H_MIN, CARD_H_MAX)` then `minf(h, vps.y -
# CARD_INSET*2)`), which is the case that shares the column with the tray (the
# compact branch only runs during a dive, when the dive overlay covers everything).
# SINGLE SOURCE OF TRUTH lives in interaction_panel.gd:59-65 — these four values
# MUST stay byte-identical to those lines. Verified equal as of this revision; if the
# card's CARD_H_* / CARD_INSET change there, change them here too (grep CARD_H_FRAC
# across scripts/ to find both sites). When the panel later exposes a card-top query,
# replace this mirror with that call to eliminate the coupling entirely.
const CARD_H_FRAC := 0.62   # == interaction_panel.gd:62
const CARD_H_MIN := 420.0   # == interaction_panel.gd:63
const CARD_H_MAX := 820.0   # == interaction_panel.gd:64
const CARD_INSET := 24.0    # == interaction_panel.gd:65
# The tray never grows past this fraction of the column even when the card is tiny.
const TRAY_MAX_H_FRAC := 0.46
const TRAY_MIN_H := 200.0

# Built nodes.
var _screen: Control
# Components are held untyped (dynamic dispatch) so the shell does not hard-depend
# on the components' class_name registration order at compile time — it calls only
# their documented (frozen) API. Mirrors how _panel has always been wired.
var _roster_holder: Control
var _tray_holder: Control
var _roster                         # FleetRoster instance
var _tray                           # PendingTray instance
var _dive                           # DiveOverlay instance
var _panel                          # interaction_panel instance
var _world_browser                  # WorldBrowser instance (Lane D; full-screen overlay)
var _work_log                       # WorkLog — streaming tool-activity card (Lane D)
var _grouped_roster := false        # true once the roster's grouped-by-house path (set_characters) is fed
var _conn_pill: PanelContainer      # top-center connection status (Connecting/Live/Offline)
var _conn_label: Label
var _conn_dot: Label

# State mirrors of the feed (so enter_dive / context have the latest AgentView).
var _agents: Dictionary = {}        # agent_id -> latest AgentView dict
var _contexts: Dictionary = {}      # agent_id -> last AgentContext dict (for the dive)
var _dive_id: String = ""
# Signature of the last error event we beeped, so a sticky error in the feed plays
# the `error` sound ONCE (not on every ~1s poll). Cleared when the feed has none.
var _last_error_sig: String = ""

func _ready() -> void:
	layer = 12
	_build()

# ============================================================================
#  Build — instantiate + route the components (the shell does only this)
# ============================================================================
func _build() -> void:
	_screen = Control.new()
	_screen.name = "Screen"
	_screen.set_anchors_preset(Control.PRESET_FULL_RECT)
	_screen.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# A generated Theme cascades the warm-glass look to every child widget; bespoke
	# components still override their own state matrices on top.
	_screen.theme = SummerUI.theme()
	add_child(_screen)

	_build_topbar()
	_build_roster()
	_build_tray()
	_build_card()
	_build_dive()
	_build_world_browser()
	_build_work_log()
	_build_conn()

	# Lay out the rail + tray responsively now and on every viewport resize.
	var vp := get_viewport()
	if vp != null and not vp.size_changed.is_connected(_relayout):
		vp.size_changed.connect(_relayout)
	_relayout()

# Just a tiny brand mark top-left — the full command bar was bloat, removed. No
# panel/frost/COMMAND tag; only the sun + a faint wordmark. Drop the two add_child
# lines (or the whole func) for zero chrome.
func _build_topbar() -> void:
	var row := HBoxContainer.new()
	row.name = "Brand"
	row.set_anchors_preset(Control.PRESET_TOP_LEFT)
	row.offset_left = 18
	row.offset_top = 13
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_constant_override("separation", 6)
	# Brand sun is a warm sun-yellow (not the indigo ACCENT) — it's a literal sun, so it
	# reads as one. SummerUI has no yellow token, so an inline warm gold here, mirroring the
	# inline amber already used for the connection dot below.
	var sun := _label("☀", SummerUI.FS_TITLE, Color(1.0, 0.80, 0.25))
	sun.mouse_filter = Control.MOUSE_FILTER_IGNORE
	sun.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var name_lbl := _label("SummerCraft", SummerUI.FS_LABEL, SummerUI.TEXT_DIM)
	name_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	name_lbl.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	row.add_child(sun)
	row.add_child(name_lbl)
	_screen.add_child(row)

	# The "visit a world" front door (Lane D): a small Worlds button beside the brand. This is the
	# ONLY entry point that opens the multiplayer world browser (open_world_browser emits
	# worlds_requested, which B fetches + feeds back via show_worlds). Placed in the always-visible
	# brand strip so it's reachable from the command view regardless of selection.
	var worlds_btn := Button.new()
	worlds_btn.text = "Worlds"
	worlds_btn.tooltip_text = "Visit another world"
	worlds_btn.focus_mode = Control.FOCUS_NONE
	worlds_btn.mouse_filter = Control.MOUSE_FILTER_STOP
	worlds_btn.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	SummerUI.ghost_button(worlds_btn)
	worlds_btn.pressed.connect(open_world_browser)
	worlds_btn.mouse_entered.connect(func(): UiSounds.play("hover"))
	row.add_child(worlds_btn)

# Host the FleetRoster in a left-rail holder we anchor responsively each resize.
func _build_roster() -> void:
	_roster_holder = Control.new()
	_roster_holder.name = "RosterHolder"
	_roster_holder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_screen.add_child(_roster_holder)

	_roster = FLEET_ROSTER.instantiate()
	_roster_holder.add_child(_roster)
	_roster.chip_selected.connect(_on_roster_chip)
	_roster.approve_pressed.connect(_on_roster_approve)
	# project_selected is NOT connected: the roster already scopes its own chip column
	# on a tab switch, and the shell has no tray-scoping behavior to deliver yet. A
	# no-op handler would advertise (and per-tab-switch allocate a call for) behavior
	# that does not exist. When tray project-scoping lands, reconnect here and call the
	# tray's scope method — the additive `project_selected` seam stays available.

# Host the PendingTray in a right-rail holder (above the card) — the "needs me"
# surface. Anchored responsively each resize.
func _build_tray() -> void:
	_tray_holder = Control.new()
	_tray_holder.name = "TrayHolder"
	_tray_holder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_screen.add_child(_tray_holder)

	_tray = PENDING_TRAY.instantiate()
	_tray_holder.add_child(_tray)
	_tray.approve.connect(_on_tray_approve)
	_tray.reject.connect(_on_tray_reject)
	_tray.merge_project.connect(_on_tray_merge)
	_tray.focus_agent.connect(_on_tray_focus)

func _build_card() -> void:
	_panel = AGENT_PANEL.instantiate()
	_screen.add_child(_panel)
	_panel.send_prompt.connect(_on_panel_prompt)
	_panel.request_voice.connect(_on_panel_voice)
	_panel.diff_requested.connect(_on_panel_diff)
	_panel.approve_requested.connect(_on_panel_approve)
	_panel.merge_requested.connect(_on_panel_merge)
	_panel.closed.connect(_on_panel_closed)
	_panel.operator_run_requested.connect(_on_panel_operator_run)
	# Session verbs (additive). has_signal-guarded so an older card .tscn without these
	# signals still loads (the card script in this lane always defines them).
	if _panel.has_signal("new_chat_requested"):
		_panel.new_chat_requested.connect(_on_panel_new_chat)
	if _panel.has_signal("send_away_requested"):
		_panel.send_away_requested.connect(_on_panel_send_away)
	if _panel.has_signal("sessions_requested"):
		_panel.sessions_requested.connect(_on_panel_sessions)
	if _panel.has_signal("session_view_requested"):
		_panel.session_view_requested.connect(_on_panel_session_view)

func _build_dive() -> void:
	_dive = DIVE_OVERLAY.instantiate()
	_screen.add_child(_dive)
	_dive.exit_requested.connect(_on_dive_exit)

# WorldBrowser (Lane D) — a full-screen frosted overlay added LAST so it layers above the
# roster / tray / card. Hidden until open_world_browser(); its row clicks + the loading/empty
# states are owned inside the component. We relay its two UP signals OUT as the contract
# world_visit_requested / (re-fetch via) worlds_requested.
func _build_world_browser() -> void:
	_world_browser = WORLD_BROWSER.new()
	_world_browser.set_anchors_preset(Control.PRESET_FULL_RECT)
	_screen.add_child(_world_browser)
	_world_browser.world_visit_requested.connect(_on_world_visit)
	_world_browser.closed.connect(_on_world_browser_closed)

# Anchor the rail + tray holders to a responsive width band. The roster fills its
# holder (PRESET_FULL_RECT inside it); the tray docks the upper-right column above
# the card. No magic absolute sizes — fractions of the live viewport, clamped.
func _relayout() -> void:
	var vp := get_viewport()
	if vp == null:
		return
	var vps: Vector2 = vp.get_visible_rect().size
	if vps.x <= 0.0 or vps.y <= 0.0:
		return

	var rail_w: float = clampf(vps.x * RAIL_W_FRAC, RAIL_W_MIN, RAIL_W_MAX)
	rail_w = minf(rail_w, vps.x * 0.5 - EDGE_INSET)
	var top: float = TOPBAR_H + GAP
	# Rail floats as a CARD that hugs its agents — top-anchored, height from content
	# (capped), NOT a full-height slab. The component fills this content-sized holder.
	var rail_h: float = 300.0
	if _roster != null and _roster.has_method("content_height"):
		rail_h = _roster.content_height()
	rail_h = clampf(rail_h, 120.0, minf(vps.y * 0.72, vps.y - top - EDGE_INSET))
	_roster_holder.anchor_left = 0.0
	_roster_holder.anchor_top = 0.0
	_roster_holder.anchor_right = 0.0
	_roster_holder.anchor_bottom = 0.0
	_roster_holder.offset_left = EDGE_INSET
	_roster_holder.offset_right = EDGE_INSET + rail_w
	_roster_holder.offset_top = top
	_roster_holder.offset_bottom = top + rail_h

	var tray_w: float = clampf(vps.x * TRAY_W_FRAC, TRAY_W_MIN, TRAY_W_MAX)
	tray_w = minf(tray_w, vps.x - rail_w - EDGE_INSET * 3.0)
	# Tray floats top-right, hugging its rows — but never past the agent card's top
	# edge (computed exactly as the card docks it, bottom-right) so they never overlap.
	var card_h: float = clampf(vps.y * CARD_H_FRAC, CARD_H_MIN, CARD_H_MAX)
	card_h = minf(card_h, vps.y - CARD_INSET * 2.0)
	var card_top: float = vps.y - card_h - CARD_INSET
	var tray_h: float = 200.0
	if _tray != null and _tray.has_method("content_height"):
		tray_h = _tray.content_height()
	tray_h = clampf(tray_h, 90.0, maxf((card_top - GAP) - top, 90.0))
	_tray_holder.anchor_left = 1.0
	_tray_holder.anchor_top = 0.0
	_tray_holder.anchor_right = 1.0
	_tray_holder.anchor_bottom = 0.0
	_tray_holder.offset_left = -(tray_w + EDGE_INSET)
	_tray_holder.offset_right = -EDGE_INSET
	_tray_holder.offset_top = top
	_tray_holder.offset_bottom = top + tray_h

# ============================================================================
#  Seam: world feed (fans out to every live component)
# ============================================================================
func set_world(snapshot: Dictionary) -> void:
	# Cache AgentViews so enter_dive / show_agent-from-roster have the latest shape.
	var agents = snapshot.get("agents", [])
	if not (agents is Array):
		agents = []
	var seen := {}
	for a in agents:
		if not (a is Dictionary):
			continue
		var id := SummerUI.s(a.get("agent_id"))
		if id == "":
			continue
		_agents[id] = a
		seen[id] = true
	for id in _agents.keys():
		if not seen.has(id):
			_agents.erase(id)

	# The `events[]` feed is seen by NO component (INTERFACES.md §2) — surfacing it
	# is the shell's job. We only sound the most recent `error` beat, de-duped so a
	# sticky error doesn't beep every poll. Visual error rows stay the components'
	# province (blocked/lock); this is the one shell-owned UiSounds site.
	_surface_error_events(snapshot.get("events", []))

	# FleetRoster.set_world already ingests snapshot["locks"] and refreshes its badges
	# (fleet_roster.gd) — calling set_locks() here too would duplicate the array and
	# run a second badge pass every poll for identical data (INTERFACES.md §3:
	# "set_locks is optional; set_world already drives the blocked pill"). PendingTray
	# likewise reads locks out of the snapshot it is handed. So we pass the whole
	# snapshot down once and let each component slice it — zero redundant per-poll work.
	# Roster: the character-session model adds snapshot.characters[] (persistent NPCs, incl. ASLEEP
	# ones that `agents` — live Sessions only — can't show). When present, drive the roster's
	# grouped-by-house path (set_characters) so sleeping characters render and chips group under their
	# home project. The shell picks ONE path so working characters don't render twice (flat chip +
	# house chip): grouped when characters[] is non-empty, else the flat set_world (pre-character feeds).
	var characters = snapshot.get("characters", [])
	var has_chars: bool = characters is Array and not (characters as Array).is_empty()
	if has_chars and _roster.has_method("set_characters"):
		_roster.set_characters(characters)
		_grouped_roster = true
	else:
		# No characters this poll: drive the flat path. Only clear the grouped path if it was
		# previously fed (so a pure-flat feed never builds the houses container at all).
		if _grouped_roster and _roster.has_method("set_characters"):
			_roster.set_characters([])
			_grouped_roster = false
		_roster.set_world(snapshot)
	_tray.set_world(snapshot)

	# Keep the open card live in place (the card no-ops if hidden / id mismatch).
	if _panel.visible:
		var open_id: String = _panel.get_agent_id()
		if _agents.has(open_id):
			_panel.update_agent(_agents[open_id])

	# Keep the dive ribbon fresh if the dived agent's view changed this poll.
	if _dive.visible and _dive_id != "" and _agents.has(_dive_id):
		_dive.update_context(_agents[_dive_id], _contexts.get(_dive_id, {}))

	# Re-flow the floating cards to their new content height (agent/row counts changed).
	_relayout()

# ============================================================================
#  Seam: agent card
# ============================================================================
func show_agent(view: Dictionary) -> void:
	var id := SummerUI.s(view.get("agent_id"))
	if id != "":
		_agents[id] = view
	_panel.show_agent(view)
	_roster.set_selected(id)

func update_agent(view: Dictionary) -> void:
	var id := SummerUI.s(view.get("agent_id"))
	if id != "":
		_agents[id] = view
	_panel.update_agent(view)

func show_diff(agent_id: String, text: String) -> void:
	if _panel.visible and _panel.get_agent_id() == agent_id:
		_panel.show_diff(text)

# Contract seam: closes the agent card (NOT the whole layer). We intentionally
# shadow CanvasLayer.hide(); explicit Hud.hide() calls from B dispatch here.
@warning_ignore("native_method_override")
func hide() -> void:
	# hide_panel() is silent on `closed` (only the panel's close button emits it,
	# routing to _on_panel_closed), so we deselect the roster explicitly here. The
	# close-button path and this B-driven path converge without double-firing.
	_panel.hide_panel()
	_roster.set_selected("")
	if _dive.visible:
		exit_dive()

# ============================================================================
#  Seam: the dive (delegated to DiveOverlay)
# ============================================================================
# Top-center connection status so the screen is never silently dead (SLAM Fix 4).
# Defaults to "Connecting…"; B flips it via _bridge.connection_changed → set_connection().
func _build_conn() -> void:
	_conn_pill = PanelContainer.new()
	_conn_pill.name = "ConnPill"
	_conn_pill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_conn_pill.set_anchors_preset(Control.PRESET_CENTER_TOP)
	_conn_pill.offset_top = 13
	_conn_pill.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_conn_pill.add_theme_stylebox_override("panel", SummerUI.pill(SummerUI.BG_GLASS, 9, 12, 5))
	_screen.add_child(_conn_pill)
	var row := HBoxContainer.new()
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_constant_override("separation", 7)
	_conn_pill.add_child(row)
	_conn_dot = _label("●", SummerUI.FS_PILL, Color(0.97, 0.74, 0.36))
	_conn_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_conn_dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	row.add_child(_conn_dot)
	_conn_label = _label("Connecting…", SummerUI.FS_LABEL, SummerUI.TEXT_DIM)
	_conn_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(_conn_label)

func set_connection(connected: bool) -> void:
	if _conn_label == null:
		return
	if connected:
		_conn_label.text = "Live"
		_conn_label.add_theme_color_override("font_color", SummerUI.TEXT)
		_conn_dot.add_theme_color_override("font_color", SummerUI.OK_GREEN)
	else:
		_conn_label.text = "Offline — demo feed"
		_conn_label.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
		_conn_dot.add_theme_color_override("font_color", Color(0.97, 0.74, 0.36))

func enter_dive(agent_id: String) -> void:
	_dive_id = agent_id
	var view: Dictionary = _agents.get(agent_id, {"agent_id": agent_id})
	# Conversation mode: clear EVERY command surface so only the dive shows — no
	# overlapping roster / tray / card boxes behind the chat (Mathias: "remove the
	# overlay boxes"). The dive overlay carries the agent header + the chat itself.
	_roster_holder.visible = false
	_tray_holder.visible = false
	if _conn_pill != null:
		_conn_pill.visible = false
	_panel.hide_panel()
	_dive.enter(agent_id, view, _contexts.get(agent_id, {}))

func exit_dive() -> void:
	_dive_id = ""
	_dive.exit()
	# Back to command mode — restore the rail + tray. The card stays closed until the
	# player re-selects an agent (set_compact reset so a future open isn't folded).
	_roster_holder.visible = true
	_tray_holder.visible = true
	if _conn_pill != null:
		_conn_pill.visible = true
	_panel.set_compact(false)

# ============================================================================
#  Additive: caption / speaking / context (C/B feed via WS relay)
# ============================================================================
func caption(agent_id: String, text: String) -> void:
	var t := text.strip_edges()
	if t == "":
		return
	# Route to the dive history ONLY for the dived agent. Mirrors set_speaking's
	# guard exactly (`_dive_id != "" and agent_id == _dive_id`) so the two additive
	# sinks agree: with an empty _dive_id we never cross-contaminate the first-person
	# history with some other agent's captions.
	if _dive.visible and _dive_id != "" and agent_id == _dive_id:
		_dive.push_caption(t)
	# Mirror into the open card transcript when it's the same agent.
	if _panel.visible and _panel.get_agent_id() == agent_id and _panel.has_method("append_line"):
		_panel.append_line(t)

func set_speaking(agent_id: String, on: bool) -> void:
	if _dive_id != "" and agent_id != _dive_id:
		return
	_dive.set_speaking(on)

# WorkLog: the prominent "watch Claude work" card on the left — streams every tool call live.
func _build_work_log() -> void:
	_work_log = WORK_LOG.new()
	_work_log.name = "WorkLog"
	_screen.add_child(_work_log)

# ── Additive: live activity feed (B/C relay A's tool_activity WS event) ──────
# When an agent is working, show WHAT it's doing: a prominent streaming WorkLog card on the
# left (every tool call), PLUS the most recent action on its open card + a subtle roster line.
# Consumes A's ActivityEvent: { type:"tool_activity", agent_id, tool, summary, ts }. All null-safe.
func activity(agent_id: String, tool: String, summary: String) -> void:
	# Prominent: the WorkLog card streams every tool call so you can WATCH the agent work.
	if _work_log != null and _work_log.has_method("set_activity"):
		_work_log.set_activity(agent_id, tool, summary)
	if _panel.visible and _panel.get_agent_id() == agent_id and _panel.has_method("set_activity"):
		_panel.set_activity(tool, summary)
	# Second, SUBTLE consumer: the LEFT roster also shows the latest action as a dim one-liner
	# under the working agent's chip (so the operator sees "it's doing stuff" without opening
	# the card). id-scoped inside the roster (keyed by agent_id); no-op if it has no chip or
	# the agent isn't 'working'. has_method-guarded so an older roster build still loads.
	if _roster != null and _roster.has_method("set_activity"):
		_roster.set_activity(agent_id, tool, summary)

# When A emits a ServiceEvent ({ type:"service", agent_id, url, port, ts }) we surface
# an "Open localhost ↗" chip on the open card; clicking it opens the URL via OS.shell_open
# (handled in the panel). Same id-scoping as activity().
func service(agent_id: String, url: String) -> void:
	if _panel.visible and _panel.get_agent_id() == agent_id and _panel.has_method("set_service"):
		_panel.set_service(url)

# ── Additive: session sinks (B calls these back after its sidecar round-trips) ──
# B POSTs /agents/:id/new-session; on 200 it calls this so the card clears to a fresh chat.
# id-scoped + has_method-guarded. NOTE: deliberately NOT gated on _panel.visible — New chat is
# routinely triggered from the voice/dive view where the card is hidden, and voice captions/typed
# echoes live in the card's _pending_echoes, which ONLY start_fresh_chat() clears (the poll can't:
# update_agent early-returns while hidden, and the tail-prune leaves unmatched echoes in place).
# Gating on visibility here was THE "New chat doesn't clear the old conversation" bug.
func session_started(agent_id: String) -> void:
	if _panel.get_agent_id() == agent_id and _panel.has_method("start_fresh_chat"):
		_panel.start_fresh_chat()

# B GETs /agents/:id/sessions and hands back the SessionSummary[] for the card's History
# panel. `sessions` is the raw decoded array (newest-first per A's contract).
func show_sessions(agent_id: String, sessions) -> void:
	if _panel.visible and _panel.get_agent_id() == agent_id and _panel.has_method("show_sessions"):
		_panel.show_sessions(sessions)

# B hands back an archived session's transcript lines (read-only). `lines` is an Array
# of transcript strings (same shape as AgentView.transcript_tail).
func show_session_transcript(agent_id: String, session_id: String, lines) -> void:
	if _panel.visible and _panel.get_agent_id() == agent_id and _panel.has_method("show_session_transcript"):
		_panel.show_session_transcript(session_id, lines)

# ── Additive: MULTIPLAYER WORLD BROWSER (Lane D) ─────────────────────────────
# Open the "visit a world" overlay AND ask for the list in one call: we open the panel
# (it shows a loading state) then emit worlds_requested() so B fetches GET /worlds and
# hands the payload back via show_worlds(). If B is not wired yet the panel simply sits on
# "Loading worlds…" — no crash, no fake data.
func open_world_browser() -> void:
	if _world_browser == null:
		return
	_world_browser.open()
	worlds_requested.emit()

# B hands back A's GET /worlds payload ({ you, you_owner_code, worlds: WorldSummary[] }),
# or a bare WorldSummary[] array. The browser upserts rows in place + drives its empty state.
func show_worlds(payload) -> void:
	if _world_browser != null:
		_world_browser.show_worlds(payload)

# Programmatic close (e.g. B leaves multiplayer). The component is silent on `closed` here;
# only the user-driven dismiss path emits it.
func close_world_browser() -> void:
	if _world_browser != null:
		_world_browser.close()

# Hand C's AgentContext (branch / base_branch / pr_url / diff / files) for the dive
# ribbon. Cached so a later enter_dive / poll repaint picks it up. Additive seam.
func set_context(agent_id: String, context: Dictionary) -> void:
	var id := SummerUI.s(agent_id)
	if id == "":
		return
	_contexts[id] = context
	# Repaint the live ribbon only for the dived agent (same id-scoping as caption /
	# set_speaking — an empty _dive_id must not let another agent's context overwrite
	# the open dive's ribbon).
	if _dive.visible and _dive_id != "" and id == _dive_id:
		_dive.update_context(_agents.get(id, {"agent_id": id}), context)

# ============================================================================
#  Component UP signals → relayed OUT as the frozen contract signals
# ============================================================================

# FleetRoster ----------------------------------------------------------------
func _on_roster_chip(id: String) -> void:
	if _agents.has(id):
		show_agent(_agents[id])
	else:
		_panel.show_agent({"agent_id": id})
		_roster.set_selected(id)

func _on_roster_approve(id: String) -> void:
	if _agents.has(id):
		show_agent(_agents[id])
	approve.emit(id)

# PendingTray ----------------------------------------------------------------
func _on_tray_approve(id: String) -> void:
	if _agents.has(id):
		show_agent(_agents[id])
	approve.emit(id)

func _on_tray_reject(id: String) -> void:
	rejected.emit(id)

func _on_tray_merge(project_id: String) -> void:
	merge_requested.emit(project_id)

func _on_tray_focus(id: String) -> void:
	if _agents.has(id):
		show_agent(_agents[id])
	else:
		_panel.show_agent({"agent_id": id})
		_roster.set_selected(id)

# InteractionPanel (card) ----------------------------------------------------
func _on_panel_prompt(id: String, t: String) -> void:
	prompt_submitted.emit(id, t)

func _on_panel_voice(id: String) -> void:
	talk_requested.emit(id)

func _on_panel_diff(id: String) -> void:
	diff_requested.emit(id)

func _on_panel_approve(id: String) -> void:
	approve.emit(id)

func _on_panel_operator_run(mid: String) -> void:
	operator_run_requested.emit(mid)

func _on_panel_merge(pid: String) -> void:
	merge_requested.emit(pid)

# Session verbs — relayed OUT for B (mirrors _on_panel_prompt). No sidecar comms here.
func _on_panel_new_chat(id: String) -> void:
	new_chat_requested.emit(id)

func _on_panel_send_away(id: String) -> void:
	send_away_requested.emit(id)

func _on_panel_sessions(id: String) -> void:
	sessions_requested.emit(id)

func _on_panel_session_view(id: String, session_id: String) -> void:
	session_view_requested.emit(id, session_id)

func _on_panel_closed() -> void:
	_roster.set_selected("")

# DiveOverlay ----------------------------------------------------------------
func _on_dive_exit(id: String) -> void:
	dive_exit_requested.emit(id)

# WorldBrowser (Lane D) ------------------------------------------------------
# A world row was clicked → relay the contract world_visit_requested(world_id) OUT for B,
# which loads that world read-only (B's bridge). No sidecar comms here.
func _on_world_visit(world_id: String) -> void:
	world_visit_requested.emit(world_id)

# The browser was dismissed by the user — nothing to relay; the component already closed
# itself. Hook kept so a future "restore chrome on close" lives in one place.
func _on_world_browser_closed() -> void:
	pass

# ============================================================================
#  events[] — the shell-owned error beat (no component sees the events feed)
# ============================================================================
# Beep `error` once for the newest error CoordEvent in the feed; stay silent while
# that same error persists across polls, and reset when the feed clears so a later
# recurrence beeps again. Null-safe on every field (frozen CoordEvent is loose).
func _surface_error_events(events) -> void:
	if not (events is Array):
		_last_error_sig = ""
		return
	var sig := ""
	for e in events:
		if not (e is Dictionary):
			continue
		if SummerUI.s(e.get("type")) != "error":
			continue
		# Last error wins (events are oldest→newest); signature = type+agent+detail.
		sig = "%s|%s|%s" % [
			SummerUI.s(e.get("agent_id")),
			SummerUI.s(e.get("detail")),
			SummerUI.s(e.get("ts")),
		]
	if sig == "":
		_last_error_sig = ""
		return
	if sig != _last_error_sig:
		_last_error_sig = sig
		UiSounds.play("error")

# ============================================================================
#  Small builder
# ============================================================================
func _label(text: String, size: int, color: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l
