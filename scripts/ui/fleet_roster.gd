extends Control
# No class_name (consistent with juice.gd / ui_sounds.gd / diff_view.gd, commit 82aa023):
# scripts/ui is not in the editor's global class cache, so a global class_name would fail
# to resolve at load. The .tscn binds this script by ExtResource path, and the shell holds
# the instance untyped / binds it via preload const — neither needs the global name.
# Likewise bind Juice/UiSounds by path (preload) and use them as values, never as types.
const Juice := preload("res://scripts/ui/juice.gd")
const UiSounds := preload("res://scripts/ui/ui_sounds.gd")
# ============================================================================
#  FleetRoster — the fleet list + project-overview tabs (Chat D / The Interface).
#
#  The left-rail Control that answers "who is in my fleet and what are they
#  doing" at a glance, across a room. Two surfaces in one component:
#    • FLEET tab     — one chip per agent: kind dot, name, status sub-line,
#                      colour-coded state pill, blocked/locked badge, an Approve
#                      ✓ affordance when the agent awaits review (state == done).
#    • OVERVIEW tabs — agents grouped by project (repo_id) with per-project
#                      state dots, so the projector view reads project health fast.
#                      Activating a project tab FILTERS the chip column to it.
#
#  Pure view. The Hud shell feeds it the frozen /world data via set_world() each
#  1s poll; the roster UPSERTS chips IN PLACE (never rebuilds the list) so there
#  is no flicker and no focus/scroll loss. It emits selection + approve UP to the
#  shell, which relays them out as the frozen contract signals. No sidecar comms.
#
#  Production: anchored fill (portrait + projector), zero per-frame allocations
#  (chips are created once and mutated; the order/membership mirrors reused; the tab
#  ROW is rebuilt only on a membership change — dots/active styling reconcile in place
#  each poll, allocation-gated), graceful empty state, Juice on
#  every chip spawn / state change, UiSounds.play() at hover/select/approve/tab
#  sites, kept legible at distance. Theme ONLY via SummerUI, motion ONLY via
#  Juice, sound ONLY via UiSounds.
# ============================================================================

# ── Signals up to the shell ─────────────────────────────────────────────────
# A fleet chip was clicked → shell calls Hud.show_agent(view) and re-selects.
signal chip_selected(agent_id: String)
# The Approve ✓ on a chip was pressed → shell emits the contract `approve(id)`.
signal approve_pressed(agent_id: String)
# (additive convenience) A project overview tab was activated → shell may scope
# the pending tray / focus that project. Carries repo_id, "" == the All/Fleet tab.
signal project_selected(project_id: String)

# heartbeat_age_s past this == stale; the chip is dimmed (contract §2).
const STALE_AGE_S := 15.0
const ALL_TAB := ""  # the "FLEET" / all-agents tab id.
const TAB_LABEL_MAX_CHARS := 16  # cap a project tab's displayed repo_id so none dominates.

# Built nodes.
var _tabs: HBoxContainer        # FLEET + per-project overview tabs
var _list: VBoxContainer        # the chip column (inside a ScrollContainer)
var _empty: Label               # shown when there are no agents (or none in tab)

# State mirrors (reused; not reallocated per poll).
var _chips: Dictionary = {}     # agent_id -> chip-refs Dictionary
var _order: Array[String] = []  # current render order (agent_ids), feed order
var _views: Dictionary = {}     # agent_id -> last AgentView dict
var _tab_refs: Dictionary = {}  # project_id -> tab-refs Dictionary
var _tab_order: Array[String] = []  # current project set (incl. ALL_TAB), for membership diff
# Persistent scratch reused by _rebuild_tabs so a steady poll allocates no new containers.
# _by_project: pid -> Array[String] of member states (the only datum _update_tab needs);
# the nested Arrays are cleared (not freed) and refilled. _want: the candidate tab set.
var _by_project: Dictionary = {}
var _want: Array[String] = []
var _all_states: Array[String] = []  # reused FLEET-tab member-state buffer (cleared per poll)
var _locks: Array = []          # last LockView[] seen (for blocked-on-<file> badges)
var _selected_id: String = ""
var _active_project: String = ""  # "" == All / Fleet view

# ── Grouped "roster by house" path (additive; see set_characters) ────────────
# The flat agent path above is unchanged. set_characters() drives a SEPARATE
# surface — characters bucketed by home_project_id, a small house header per
# project, then its character chips — built lazily into _houses (a VBox added to
# the same chip scroll on first call). The two paths never share node refs or
# state, so feeding one never disturbs the other; the shell picks ONE (see the
# report). All grouped nodes/refs are upserted in place (no flicker, key by id).
var _houses: VBoxContainer        # container for house sections (lazily built)
var _house_refs: Dictionary = {}  # home_project_id -> {root, header, body}
var _house_order: Array[String] = []  # current house render order (feed order)
var _char_chips: Dictionary = {}  # character_id -> chip-refs Dictionary
var _char_views: Dictionary = {}  # character_id -> last character dict

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE  # empty rail space lets world clicks through
	set_anchors_preset(Control.PRESET_FULL_RECT)

	var panel := PanelContainer.new()
	panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	panel.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(panel)
	# FROST the rail (recipe step 1): a blurred FrostRect becomes the backmost child and
	# the panel stylebox drops to a hairline border, so the fill is frosted glass and the
	# edge stays a crisp 1px line. Match the card radius (~16); BG_GLASS is the primary tint.
	SummerUI.attach_frost(panel, SummerUI.BG_GLASS, 16)

	var m := MarginContainer.new()
	m.set_anchors_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, 14)
	panel.add_child(m)

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 10)
	m.add_child(col)

	# Header.
	var head := _label("FLEET", 12, SummerUI.TEXT_FAINT)
	col.add_child(head)

	# Tabs row (FLEET + per-project) in its own scroll so many projects never
	# break the layout on a narrow portrait rail.
	var tab_scroll := ScrollContainer.new()
	tab_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	tab_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	tab_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	col.add_child(tab_scroll)

	_tabs = HBoxContainer.new()
	_tabs.add_theme_constant_override("separation", 6)
	tab_scroll.add_child(_tabs)

	# The chip column.
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	col.add_child(scroll)

	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 8)
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_list)

	# Empty state (graceful no-data). Lives in the column so it centers nicely.
	_empty = _label("Connecting…", SummerUI.FS_LABEL, SummerUI.TEXT_FAINT)
	_empty.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_empty.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_empty.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	scroll.add_child(_empty)

	_rebuild_tabs(true)  # seed the FLEET tab so the rail reads before any feed.

# ── Shell API (methods the Hud shell calls down) ────────────────────────────

# Content height for the shell's layout, so the rail floats as a CARD that hugs its
# agents instead of a full-height slab. Estimated from the live agent count — chips
# live in an expandable scroll, so a min-size read wouldn't include them.
func content_height() -> float:
	var n := _order.size()
	if n == 0:
		n = 1  # the "No agents yet." line takes ~one chip's room
	return 104.0 + float(n) * 60.0  # header + tabs + margins, then ~60px per chip

# Feed the frozen WorldSnapshot (or its `agents` array) each poll. Upserts chips
# in place, drops chips for agents no longer present, reorders to match the feed,
# rebuilds the overview tabs ONLY when the project set changes, fires Juice +
# UiSounds on per-chip state changes. Null-safe on every nullable field.
func set_world(snapshot: Dictionary) -> void:
	var agents = snapshot.get("agents", [])
	if not (agents is Array):
		agents = []
	# Locks ride along on the same poll when present (contract §2); chips show a
	# blocked-on-<file> badge from them. set_locks() may also drive this directly.
	if snapshot.has("locks") and snapshot["locks"] is Array:
		# Shallow-copy so we don't alias B's buffer (it may reuse/mutate it between polls).
		_locks = (snapshot["locks"] as Array).duplicate()

	var seen := {}
	_order.clear()
	for a in agents:
		if not (a is Dictionary):
			continue
		var id := SummerUI.s(a.get("agent_id"))
		if id == "":
			continue
		_order.append(id)
		seen[id] = true
		_upsert_chip(a)

	# Drop chips + cached views for agents no longer present.
	for id in _chips.keys():
		if not seen.has(id):
			# Kill any looping idle bob first so a removed chip doesn't leak a tween.
			Juice.stop(_chips[id].get("_bob"))
			_chips[id]["root"].queue_free()
			_chips.erase(id)
	for id in _views.keys():
		if not seen.has(id):
			_views.erase(id)

	# If the active project filter no longer exists, fall back to the FLEET tab.
	if _active_project != ALL_TAB and not _project_present(_active_project):
		_active_project = ALL_TAB

	_reorder_chips()
	_rebuild_tabs()        # membership-gated inside; no-op when the set is unchanged.
	_apply_filter()        # show/hide chips for the active project + empty state.
	_refresh_badges()      # lock badges off the latest locks[].

# Highlight a given agent's chip as selected (e.g. a world click opened the card).
# "" clears selection. Restyles only the two affected chips — no rebuild.
func set_selected(agent_id: String) -> void:
	var prev := _selected_id
	_selected_id = agent_id
	# Restyle the previously-selected on whichever path owns it.
	if prev != "":
		if _chips.has(prev):
			_restyle_root(prev)
		if _char_chips.has(prev):
			_restyle_char_root(prev, _lifecycle_state(SummerUI.s((_char_views.get(prev, {}) as Dictionary).get("lifecycle"))))
	if agent_id != "":
		if _chips.has(agent_id):
			_restyle_root(agent_id)
			# Selection pop (§6 'selection pop'): the most frequent interaction gets a Juice
			# beat like every other site. On root (Juice owns root.scale/modulate) so it
			# composes multiplicatively with the stale dim layer (dim.self_modulate).
			Juice.pulse(_chips[agent_id]["root"])
		if _char_chips.has(agent_id):
			_restyle_char_root(agent_id, _lifecycle_state(SummerUI.s((_char_views.get(agent_id, {}) as Dictionary).get("lifecycle"))))
			Juice.pulse(_char_chips[agent_id]["root"])

# Surface the lock list so chips can show a "blocked on <file>" badge tied to the
# frozen locks[]. Optional; set_world already drives the blocked pill from state.
func set_locks(locks: Array) -> void:
	# Shallow-copy so badges never reflect out-of-band mutations of the caller's array.
	_locks = locks.duplicate()
	_refresh_badges()

# Subtle LIVE ACTIVITY on the rail (additive): the shell relays A's `tool_activity` here
# (alongside the open card). Shows a dim one-line "⚙ <tool>: <summary>" under the agent's
# chip so the operator sees a working agent is actually DOING something without opening its
# card. Upserts the existing per-chip Label IN PLACE (no alloc, no flicker) and gates on a
# cached signature so an identical repeat touches nothing. No-op when the agent has no chip
# (e.g. it's a sleeping character on the grouped path) or isn't currently 'working' — the
# line is cleared on the leave-working transition in _update_chip, so a late event after the
# agent went idle won't resurrect it. Null-safe on both fields.
func set_activity(agent_id: String, tool: String, summary: String) -> void:
	if not _chips.has(agent_id):
		return
	var refs: Dictionary = _chips[agent_id]
	# Only annotate a working chip; a tool event for an agent that already left 'working'
	# (race against the poll) must not flash a line under an idle chip.
	if SummerUI.s((_views.get(agent_id, {}) as Dictionary).get("state")) != "working":
		return
	var t := tool.strip_edges()
	var sm := summary.strip_edges()
	var line := "⚙ %s: %s" % [t, sm] if t != "" and sm != "" else "⚙ %s" % (t if t != "" else sm)
	if line.strip_edges() == "⚙":
		return  # nothing to show
	if line == SummerUI.s(refs.get("_activity_sig")):
		return  # identical to what's already shown — skip the assignment + visibility toggle
	refs["_activity_sig"] = line
	refs["activity"].text = line
	refs["activity"].visible = true

# Switch the active overview tab programmatically ("" == Fleet/all). Idempotent.
func focus_project(project_id: String) -> void:
	_activate_tab(project_id, false)

# Currently selected agent_id ("" if none).
func selected() -> String:
	return _selected_id

# ── Roster by house (grouped characters) — ADDITIVE ─────────────────────────
# Feed the frozen /world `characters[]`: each
#   { character_id, name, persona, home_project_id, lifecycle:'asleep'|'working',
#     active_session_id }.
# Buckets characters by home_project_id, renders a small house header per project
# then its character chips. `asleep` chips RECEDE (dim + a calm dot); `working`
# chips use the active emphasis. Keyed by character_id; everything UPSERTS in
# place (houses, headers and chips are created once then mutated — no flicker, no
# focus/scroll loss). Drops houses/chips no longer present. Null-safe on every
# nullable field. Independent of set_world(): shares no node refs or state.
func set_characters(list) -> void:
	if not (list is Array):
		list = []
	if _houses == null:
		_build_houses()

	# Bucket by home_project_id in feed order; preserve per-house character order.
	var by_house := {}          # pid -> Array[Dictionary] of characters
	var house_order: Array[String] = []
	var seen_chars := {}
	for c in list:
		if not (c is Dictionary):
			continue
		var cid := SummerUI.s(c.get("character_id"))
		if cid == "":
			continue
		var pid := SummerUI.s(c.get("home_project_id"), "?")
		if not by_house.has(pid):
			by_house[pid] = []
			house_order.append(pid)
		(by_house[pid] as Array).append(c)
		seen_chars[cid] = true

	# Drop chips + cached views for characters no longer present.
	for cid in _char_chips.keys():
		if not seen_chars.has(cid):
			Juice.stop(_char_chips[cid].get("_bob"))
			_char_chips[cid]["root"].queue_free()
			_char_chips.erase(cid)
	for cid in _char_views.keys():
		if not seen_chars.has(cid):
			_char_views.erase(cid)

	# Drop houses no longer present.
	for pid in _house_refs.keys():
		if not by_house.has(pid):
			_house_refs[pid]["root"].queue_free()
			_house_refs.erase(pid)

	# Upsert houses (header + body) in feed order, then upsert their chips.
	for hi in house_order.size():
		var pid: String = house_order[hi]
		var house: Dictionary = _ensure_house(pid)
		_houses.move_child(house["root"], hi)  # keep houses in feed order (alloc-free)
		var members: Array = by_house[pid]
		_update_house_header(house, pid, members)
		var body: VBoxContainer = house["body"]
		for mi in members.size():
			var c: Dictionary = members[mi]
			var cid := SummerUI.s(c.get("character_id"))
			var refs: Dictionary = _ensure_char_chip(cid, body)
			body.move_child(refs["root"], mi)  # keep chips in feed order within the house
			_update_char_chip(refs, c, cid)
			_char_views[cid] = c

	_house_order = house_order.duplicate()
	_houses.visible = not _char_chips.is_empty()
	# When the grouped path has data, the flat empty-state line must not also show.
	if _empty != null and not _char_chips.is_empty():
		_empty.visible = false

func _build_houses() -> void:
	# Insert the houses container as the FIRST child of the chip scroll's list so
	# grouped sections sit above the (separate) flat agent column. Both share the
	# same scroll so the rail scrolls as one. The flat _list lives in the same
	# scroll; we add _houses as its own VBox sibling under that scroll's parent.
	_houses = VBoxContainer.new()
	_houses.add_theme_constant_override("separation", 12)
	_houses.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_houses.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Parent into the same scroll content as the flat list, ABOVE it.
	var parent := _list.get_parent()
	if parent != null:
		parent.add_child(_houses)
		parent.move_child(_houses, 0)
	else:
		add_child(_houses)

func _ensure_house(pid: String) -> Dictionary:
	if _house_refs.has(pid):
		return _house_refs[pid]
	var root := VBoxContainer.new()
	root.add_theme_constant_override("separation", 6)
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE

	# House header: a small section row — name + a faint member count, with state
	# dots mirroring the project-overview tabs so the house reads at a glance.
	var head_row := HBoxContainer.new()
	head_row.add_theme_constant_override("separation", 6)
	head_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var disp := "—" if pid == "?" else _truncate(pid, TAB_LABEL_MAX_CHARS)
	var header := _label(disp.to_upper(), SummerUI.FS_MICRO, SummerUI.TEXT_FAINT)
	header.mouse_filter = Control.MOUSE_FILTER_IGNORE
	header.clip_text = true
	head_row.add_child(header)
	var dots := HBoxContainer.new()
	dots.add_theme_constant_override("separation", 3)
	dots.mouse_filter = Control.MOUSE_FILTER_IGNORE
	head_row.add_child(dots)
	root.add_child(head_row)

	var body := VBoxContainer.new()
	body.add_theme_constant_override("separation", 8)
	body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	body.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(body)

	_houses.add_child(root)
	var refs := {"root": root, "header": header, "dots": dots, "body": body, "_pid": pid}
	_house_refs[pid] = refs
	Juice.pop(root)  # a new house gently pops in
	return refs

# Update the house header's state dots in place (one calm dot per member; working
# carries the working hue, asleep a faint neutral). Dots are upserted (reused).
func _update_house_header(house: Dictionary, _pid: String, members: Array) -> void:
	var dots: HBoxContainer = house["dots"]
	while dots.get_child_count() < members.size():
		var d := _label("●", SummerUI.FS_PILL, SummerUI.TEXT_FAINT)
		d.mouse_filter = Control.MOUSE_FILTER_IGNORE
		d.set_meta("col", " ")
		dots.add_child(d)
	while dots.get_child_count() > members.size():
		dots.get_child(dots.get_child_count() - 1).queue_free()
	for i in members.size():
		var m = members[i]
		var st := _lifecycle_state(SummerUI.s((m as Dictionary).get("lifecycle")))
		var pal := SummerUI.state_palette(st)
		var dot := dots.get_child(i)
		if dot is Label:
			var key := str(pal["dot"])
			if key != SummerUI.s(dot.get_meta("col", " ")):
				dot.set_meta("col", key)
				dot.add_theme_color_override("font_color", pal["dot"])

# Map the character lifecycle to the shared state vocabulary so SummerUI styling
# (state_palette / chip_emphasis) applies: working -> active emphasis + green dot,
# asleep -> 'waiting' which recedes (idle emphasis) + a calm neutral dot.
func _lifecycle_state(lifecycle: String) -> String:
	return "working" if lifecycle == "working" else "waiting"

# A character chip: kind-neutral dot + name + persona sub-line + lifecycle pill.
# Mirrors the agent chip's look (so the rail reads coherent) but keyed/owned on
# the grouped path. Clicking emits chip_selected(character_id) UP to the shell.
func _ensure_char_chip(cid: String, body: VBoxContainer) -> Dictionary:
	if _char_chips.has(cid):
		# Reparent to the requested house body if the character changed houses (or this is the
		# first placement after a rebuild) so the caller's move_child(body, …) has a real child.
		var cached: Dictionary = _char_chips[cid]
		var croot: Control = cached["root"]
		if croot.get_parent() != body:
			if croot.get_parent() != null:
				croot.get_parent().remove_child(croot)
			body.add_child(croot)
		return cached
	var root := PanelContainer.new()
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	root.gui_input.connect(func(e): _on_char_input(e, cid))
	root.mouse_entered.connect(func(): UiSounds.play("hover"))

	# Dim layer (stale/asleep recede via self_modulate, never root.modulate — Juice
	# owns root). Mirrors the agent chip's dim-layer contract.
	var m := MarginContainer.new()
	m.mouse_filter = Control.MOUSE_FILTER_IGNORE
	for side in ["left", "right"]:
		m.add_theme_constant_override("margin_" + side, 11)
	for side in ["top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, 9)
	root.add_child(m)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 9)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	m.add_child(row)

	# Lifecycle dot in a plain Control wrapper (free position for the idle bob, as
	# in the agent chip — a Container would stomp position on every sort).
	var dot_holder := Control.new()
	dot_holder.custom_minimum_size = Vector2(16, 18)
	dot_holder.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	dot_holder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(dot_holder)
	var dot := _label("●", 15, SummerUI.TEXT_FAINT)
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	dot.position = Vector2(0, 1)
	dot_holder.add_child(dot)

	var name_col := VBoxContainer.new()
	name_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_col.add_theme_constant_override("separation", 1)
	name_col.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(name_col)
	var name_lbl := _label("character", SummerUI.FS_BODY, SummerUI.TEXT)
	name_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	name_lbl.clip_text = true
	var sub := _label("", SummerUI.FS_LABEL, SummerUI.TEXT_DIM)
	sub.mouse_filter = Control.MOUSE_FILTER_IGNORE
	sub.clip_text = true
	name_col.add_child(name_lbl)
	name_col.add_child(sub)

	# Soft state dot + light label (lifecycle).
	var pill := HBoxContainer.new()
	pill.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	pill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pill.add_theme_constant_override("separation", 6)
	var state_dot := _label("●", 7, SummerUI.TEXT_FAINT)
	state_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	state_dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	pill.add_child(state_dot)
	var pill_label := _label("Idle", SummerUI.FS_LABEL + 1, SummerUI.TEXT_DIM)
	pill_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pill.add_child(pill_label)
	row.add_child(pill)

	var refs := {
		"root": root, "dim": m, "name": name_lbl, "sub": sub,
		"pill_label": pill_label, "state_dot": state_dot, "dot": dot,
		"_state": "", "_bob": null,
		"_vis_pill_state": "", "_vis_recede": -1, "_root_sig": "",
	}
	body.add_child(root)  # MUST be in the tree before Juice.pop (needs get_tree) + the caller's move_child
	_char_chips[cid] = refs
	Juice.pop(root)
	return refs

func _update_char_chip(refs: Dictionary, c: Dictionary, cid: String) -> void:
	var lifecycle := SummerUI.s(c.get("lifecycle"))
	var state := _lifecycle_state(lifecycle)
	var prev_state := SummerUI.s(refs.get("_state"))
	var pal := SummerUI.state_palette(state)

	refs["name"].text = SummerUI.s(c.get("name"), cid)
	# Sub-line: persona (free text) when present; else the active session, else "—".
	var sub := SummerUI.s(c.get("persona"))
	if sub == "":
		var sess := SummerUI.s(c.get("active_session_id"))
		sub = sess if sess != "" else "—"
	refs["sub"].text = sub
	refs["pill_label"].text = pal["label"]

	# Soft state dot + light label — restyle only on a lifecycle flip (alloc-gated).
	if state != SummerUI.s(refs.get("_vis_pill_state")):
		refs["_vis_pill_state"] = state
		refs["state_dot"].add_theme_color_override("font_color", pal["dot"])
		refs["pill_label"].add_theme_color_override("font_color", pal["fg"])
		# The kind dot tracks the lifecycle hue too (calm neutral when asleep).
		refs["dot"].add_theme_color_override("font_color", pal["dot"])

	# asleep recedes (dim via the dim layer's self_modulate, never root.modulate).
	var recede := 1 if state != "working" else 0
	if recede != int(refs.get("_vis_recede", -1)):
		refs["_vis_recede"] = recede
		refs["dim"].self_modulate = Color(1, 1, 1, 0.62) if recede == 1 else Color(1, 1, 1, 1)

	_restyle_char_root(cid, state)

	# Idle bob for an asleep chip so the house never reads frozen; killed on wake.
	var bob = refs.get("_bob")
	if state != "working":
		if bob == null:
			refs["_bob"] = Juice.idle_bob(refs["dot"])
	elif bob != null:
		Juice.stop(bob)
		refs["_bob"] = null

	# Wake/sleep transition feedback (skip first paint; _state seeded "").
	if prev_state != "" and state != prev_state:
		if state == "working":
			Juice.pulse(refs["root"])
			UiSounds.play("state_working")
		else:
			Juice.pulse(refs["root"])
	refs["_state"] = state

# Style a character chip root from selection + lifecycle emphasis (working == the
# active emphasis; asleep recedes). Alloc-gated on the (state, selected) signature.
func _restyle_char_root(cid: String, state: String) -> void:
	if not _char_chips.has(cid):
		return
	var refs: Dictionary = _char_chips[cid]
	var selected := cid == _selected_id
	var sig := state + ("S" if selected else "_")
	if sig == SummerUI.s(refs.get("_root_sig")):
		return
	refs["_root_sig"] = sig
	var em := SummerUI.chip_emphasis(state, selected)
	refs["root"].add_theme_stylebox_override("panel", SummerUI.sb(em["fill"], SummerUI.RADIUS_SM, em["border"], 1))

func _on_char_input(event: InputEvent, cid: String) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		UiSounds.play("select")
		set_selected(cid)
		chip_selected.emit(cid)

# ── Chip upsert (in place — no flicker / no focus loss) ─────────────────────

func _upsert_chip(view: Dictionary) -> void:
	var id := SummerUI.s(view.get("agent_id"))
	if id == "":
		return
	if _chips.has(id):
		_update_chip(_chips[id], view, id)
	else:
		var refs := _make_chip(id)
		_chips[id] = refs
		_list.add_child(refs["root"])
		# A brand-new chip gets a fresh state baseline (no spurious transition cue).
		refs["_state"] = SummerUI.s(view.get("state"))
		_update_chip(refs, view, id, true)
		Juice.pop(refs["root"])
	_views[id] = view

func _make_chip(id: String) -> Dictionary:
	var root := PanelContainer.new()
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	root.gui_input.connect(func(e): _on_chip_input(e, id))
	root.mouse_entered.connect(func(): UiSounds.play("hover"))

	# The dim layer: stale-ness is carried on this inner container's self_modulate,
	# NEVER on root.modulate (which Juice owns — pop/pulse/cheer/slam/flash all END by
	# writing root.modulate = WHITE and would otherwise wipe a stale dim). self_modulate
	# composes multiplicatively under whatever Juice does to the root, so the two never
	# fight: a stale chip stays dim through a done_cheer/lock_slam/flash.
	var m := MarginContainer.new()
	m.mouse_filter = Control.MOUSE_FILTER_IGNORE
	for side in ["left", "right"]:
		m.add_theme_constant_override("margin_" + side, 11)
	for side in ["top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, 9)
	root.add_child(m)

	var outer := VBoxContainer.new()
	outer.add_theme_constant_override("separation", 5)
	outer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	m.add_child(outer)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 9)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	outer.add_child(row)

	# The kind dot sits inside a plain Control wrapper (NOT a Container). A bare Control
	# does NOT lay out its children, so the dot Label's position:y is free for the idle
	# bob — unlike any Container child (HBox/Panel/Margin) whose position the parent
	# overwrites on every _sort_children (resize / theme-override / content-size change).
	# The wrapper takes the dot's footprint so the row layout is unchanged.
	var dot_holder := Control.new()
	dot_holder.custom_minimum_size = Vector2(16, 18)
	dot_holder.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	dot_holder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(dot_holder)
	# No anchor preset: a child of a plain Control keeps whatever position we leave it at
	# (the Control never sorts), so position:y stays the bob's to own. Nudge it down so the
	# glyph sits roughly centered in the 18px holder; the bob tweens around this rest_y.
	var dot := _label("●", 15, SummerUI.TEXT_FAINT)
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	dot.position = Vector2(0, 1)
	dot_holder.add_child(dot)

	var name_col := VBoxContainer.new()
	name_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	name_col.add_theme_constant_override("separation", 1)
	name_col.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(name_col)
	var name_lbl := _label("agent", SummerUI.FS_BODY, SummerUI.TEXT)
	name_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	name_lbl.clip_text = true
	# Sub-line at the legible label scale (was 11 — unreadable across a room).
	var sub := _label("", SummerUI.FS_LABEL, SummerUI.TEXT_DIM)
	sub.mouse_filter = Control.MOUSE_FILTER_IGNORE
	sub.clip_text = true
	name_col.add_child(name_lbl)
	name_col.add_child(sub)
	# LIVE ACTIVITY one-liner (subtle): "⚙ Bash: npm run dev" — the latest tool_activity
	# relayed from the open-card path, shown here too so the operator sees a working agent is
	# actually DOING something without opening its card. FAINT + micro so it whispers; hidden
	# until the agent works (set via set_activity, cleared when the chip leaves 'working').
	# clip_text so a long command never stretches the chip. Upserted in place (no per-poll alloc).
	var activity_lbl := _label("", SummerUI.FS_MICRO, SummerUI.TEXT_FAINT)
	activity_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	activity_lbl.clip_text = true
	activity_lbl.visible = false
	name_col.add_child(activity_lbl)

	# SOFT STATE DOT + light label (recipe step 2): the chunky filled state pill is gone.
	# A small ~7px colour dot (state_palette["dot"]) is now the indicator and the state
	# label sits beside it in light desaturated text (state_palette["fg"]) — understated,
	# not a saturated block. Still sized one step above FS_PILL so it reads across the room.
	var pill := HBoxContainer.new()
	pill.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	pill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pill.add_theme_constant_override("separation", 6)
	var state_dot := _label("●", 7, SummerUI.TEXT_FAINT)
	state_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	state_dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	pill.add_child(state_dot)
	var pill_label := _label("IDLE", SummerUI.FS_LABEL + 1, SummerUI.TEXT_DIM)
	pill_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pill.add_child(pill_label)
	row.add_child(pill)

	var approve_btn := Button.new()
	# Mirror the kind_glyph tofu guard: a bundled UI TTF likely lacks ✓, which would
	# render a tofu box on the projector. Use "OK" when a custom font is active; the
	# engine default font carries the checkmark, so ✓ reads when none is bundled.
	approve_btn.text = "✓" if not SummerUI.has_custom_font() else "OK"
	approve_btn.tooltip_text = "Approve"
	approve_btn.visible = false
	# No keyboard focus (matches the tabs at line ~504): a click/touch target only. Avoids a
	# focus stylebox ring on the projector, and avoids dropping focus when the button is
	# hidden on the poll as the agent leaves 'done' (visibility toggles each second).
	approve_btn.focus_mode = Control.FOCUS_NONE
	approve_btn.mouse_filter = Control.MOUSE_FILTER_STOP
	approve_btn.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	SummerUI.success_button(approve_btn)
	approve_btn.add_theme_font_size_override("font_size", 13)
	approve_btn.pressed.connect(func(): _on_approve(id))
	approve_btn.mouse_entered.connect(func(): UiSounds.play("hover"))
	row.add_child(approve_btn)

	# Blocked/locked badge — its own row under the chip so a long file path clips
	# (clip_text below) without squeezing the status row. Hidden unless blocked.
	# The loud red "blocked" bar is gone (recipe step 2): now a small danger dot +
	# light label over a FAINT danger tint, so the hazard reads without shouting.
	var badge := PanelContainer.new()
	badge.visible = false
	badge.mouse_filter = Control.MOUSE_FILTER_IGNORE
	badge.add_theme_stylebox_override("panel", SummerUI.pill(Color(SummerUI.DANGER.r, SummerUI.DANGER.g, SummerUI.DANGER.b, 0.10), 7, 8, 2))
	var badge_row := HBoxContainer.new()
	badge_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	badge_row.add_theme_constant_override("separation", 6)
	badge.add_child(badge_row)
	var badge_dot := _label("●", 7, SummerUI.DANGER)
	badge_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	badge_dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	badge_row.add_child(badge_dot)
	var badge_label := _label("", SummerUI.FS_PILL, Color(0.86, 0.74, 0.72))
	badge_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	badge_label.clip_text = true
	badge_row.add_child(badge_label)
	outer.add_child(badge)

	return {
		"root": root, "dim": m, "name": name_lbl, "sub": sub, "pill": pill,
		"pill_label": pill_label, "state_dot": state_dot, "dot": dot, "approve": approve_btn,
		"activity": activity_lbl, "_activity_sig": "",
		"badge": badge, "badge_label": badge_label, "_state": "",
		# Looping idle-bob tween for a "waiting" chip; killed on leaving waiting / drop.
		"_bob": null,
		# Cached visual signature — set to sentinels so the first _update_chip and
		# _restyle_root apply once, then skip the StyleBoxFlat / color-override
		# allocations on every steady-state poll (zero per-poll alloc churn).
		"_vis_kind": "", "_vis_pill_state": "", "_vis_stale": -1,
		"_root_sig": "",
	}

# Refresh one chip from a fresh AgentView. `seed` suppresses transition cues for a
# chip born this frame. Fires Juice + UiSounds ONLY on an actual state transition.
func _update_chip(refs: Dictionary, view: Dictionary, id: String, seed := false) -> void:
	var state := SummerUI.s(view.get("state"))
	var prev_state := SummerUI.s(refs.get("_state"))
	var pal := SummerUI.state_palette(state)

	# Plain Label.text assignment is a cheap no-op when unchanged (Godot early-returns
	# on equal text), so these stay unconditional. The allocating overrides below are
	# gated on a change signature so the steady-state poll allocates nothing.
	refs["name"].text = SummerUI.s(view.get("label"), id)
	var sub := SummerUI.s(view.get("status_line"))
	if sub == "":
		var task := SummerUI.s(view.get("current_task"))
		sub = task if task != "" else SummerUI.s(view.get("repo_id"), "?")
	refs["sub"].text = sub
	refs["pill_label"].text = pal["label"]
	refs["approve"].visible = SummerUI.awaits_approval(state)

	# Dot colour (depends only on character_kind) — restyle only when kind changes.
	var kind := SummerUI.s(view.get("character_kind"))
	if kind != SummerUI.s(refs.get("_vis_kind")):
		refs["_vis_kind"] = kind
		refs["dot"].add_theme_color_override("font_color", SummerUI.kind_color(kind))

	# Soft state dot + light label (depend only on state) — restyle only when state changes.
	# The dot carries the state colour (pal["dot"]); the label stays light/desaturated
	# (pal["fg"]). No filled stylebox — the dot is the indicator, not a saturated block.
	if state != SummerUI.s(refs.get("_vis_pill_state")):
		refs["_vis_pill_state"] = state
		refs["state_dot"].add_theme_color_override("font_color", pal["dot"])
		refs["pill_label"].add_theme_color_override("font_color", pal["fg"])

	# Stale heartbeat → dim the chip via the dim layer's self_modulate (NOT root.modulate,
	# which Juice owns and resets to WHITE at the end of every cue). Gated on the flip to
	# keep the steady poll allocation-free; self_modulate survives any Juice motion on root.
	var age := float(view.get("heartbeat_age_s", 0.0))
	var stale := 1 if age > STALE_AGE_S else 0
	if stale != int(refs.get("_vis_stale", -1)):
		refs["_vis_stale"] = stale
		# 0.7 (not 0.55): the dim must still read "gone quiet" at a glance, but a chip that is
		# BOTH stale AND blocked is exactly the one an operator most needs to see across a room
		# — at 0.55 the red BLOCKED pill + lock badge became the dimmest thing on screen. 0.7
		# keeps the hazard legible at pitch distance while still clearly de-emphasising the chip.
		refs["dim"].self_modulate = Color(1, 1, 1, 0.7) if stale == 1 else Color(1, 1, 1, 1)

	_restyle_root(id, state)

	# Idle motion (§6): a "waiting" chip gently bobs so the fleet never reads frozen.
	# Bob the kind dot — a Label parented to a PLAIN Control (dot_holder), which does NOT
	# lay out its children, so the dot's position:y is genuinely free. (Never bob a node a
	# Container owns: a PanelContainer/HBox re-runs _sort_children on resize, on any
	# add_theme_*_override, and on a content-size change — each sort stomps position back to
	# the layout origin and fights/freezes the bob.) Start on entry to waiting, kill on
	# leaving. idle_bob returns null under reduced motion; allocation is one-shot per entry.
	var bob = refs.get("_bob")
	if state == "waiting":
		if bob == null:
			refs["_bob"] = Juice.idle_bob(refs["dot"])
	elif bob != null:
		Juice.stop(bob)
		refs["_bob"] = null

	# Live-activity line only makes sense while the agent works; clear it the moment it
	# leaves 'working' (done/blocked/idle) so a stale "⚙ …" never lingers under an idle chip.
	# Gated on the cached signature so a steady working poll touches nothing.
	if state != "working" and SummerUI.s(refs.get("_activity_sig")) != "":
		refs["_activity_sig"] = ""
		refs["activity"].text = ""
		refs["activity"].visible = false

	# State-transition feedback (skip on the seed frame and when unchanged).
	if not seed and state != prev_state:
		match state:
			"working":
				Juice.pulse(refs["root"])
				UiSounds.play("state_working")
			"done":
				Juice.done_cheer(refs["root"])
				UiSounds.play("done_cheer")
			"blocked":
				Juice.lock_slam(refs["root"])
				UiSounds.play("blocked")
			_:
				# Transitions INTO 'moving'/'waiting' are pulsed but INTENTIONALLY silent:
				# there is no 'moving'/'waiting' key in the EVENTS vocabulary (§4), and
				# reusing state_working/etc. would mislabel the audio. These are quiet,
				# low-stakes locomotion beats; the visual pulse alone marks the change.
				Juice.pulse(refs["root"])
	refs["_state"] = state

# Style a chip root from selection + blocked accent. `state` optional (looked up).
func _restyle_root(id: String, state := "") -> void:
	if not _chips.has(id):
		return
	var refs: Dictionary = _chips[id]
	if state == "":
		state = SummerUI.s((_views.get(id, {}) as Dictionary).get("state"))
	var selected := id == _selected_id
	# Active = more visible (Mathias's note): chip_emphasis brightens active chips +
	# gives a soft state-tinted edge; idle recedes (darker fill, faint border);
	# selected wins the accent edge. Depends only on (state, selected) — gate the alloc.
	var sig := state + ("S" if selected else "_")
	if sig == SummerUI.s(refs.get("_root_sig")):
		return
	refs["_root_sig"] = sig
	var em := SummerUI.chip_emphasis(state, selected)
	refs["root"].add_theme_stylebox_override("panel", SummerUI.sb(em["fill"], SummerUI.RADIUS_SM, em["border"], 1))

# Keep the chip column in feed order (move_child is allocation-free).
func _reorder_chips() -> void:
	for i in _order.size():
		var id: String = _order[i]
		if _chips.has(id):
			_list.move_child(_chips[id]["root"], i)

# Blocked-on-<file> badge: find the lock this blocked agent is waiting on and name
# the holder. Pure restyle of existing nodes — no allocation beyond the small map.
func _refresh_badges() -> void:
	# For each blocked chip, _blocked_badge_text does a linear scan over _locks — real
	# cost is O(blocked_chips x locks). Fine at pitch scale (both lists are small); no
	# index is built. Non-blocked chips short-circuit before the scan.
	# The blocked file already shows in the chip sub-line + the red dot + the "Blocked"
	# label, so the separate badge pill was redundant — it read as a slop bar. Keep the
	# node (ref stability) but never show it.
	for id in _chips.keys():
		var refs: Dictionary = _chips[id]
		if refs.has("badge"):
			refs["badge"].visible = false

func _blocked_badge_text(id: String, view: Dictionary) -> String:
	var repo := SummerUI.s(view.get("repo_path"))
	# Find a lock NOT held by this agent in the same repo — what it's waiting on.
	for l in _locks:
		if not (l is Dictionary):
			continue
		var holder := SummerUI.s(l.get("holder_agent_id"))
		if holder == id:
			continue
		if repo != "" and SummerUI.s(l.get("repo_path")) != repo:
			continue
		var file := SummerUI.s(l.get("file_path"))
		var fname := file.get_file() if file != "" else file
		if fname != "":
			return "%s %s · %s" % [_lock_glyph(), fname, holder] if holder != "" else "%s %s" % [_lock_glyph(), fname]
	return "%s blocked" % _lock_glyph()

# The blocked badge is the single most hazard-critical token on the rail. Mirror
# SummerUI.kind_glyph's tofu guard: a bundled UI TTF (FONT_PATH) likely lacks the
# lock emoji and would render a tofu box at pitch distance. Degrade to a guaranteed-
# present ASCII marker when a custom font is active; the engine default font carries
# emoji fallback, so the lock reads when no font is bundled.
func _lock_glyph() -> String:
	return "!" if SummerUI.has_custom_font() else "🔒"

# ── Project overview tabs ───────────────────────────────────────────────────

# Rebuild the tabs row ONLY when the project membership set changes (or `force`).
# Per-project state dots are updated in place on the existing tabs every poll.
func _rebuild_tabs(force := false) -> void:
	# Collect the current project set + per-project member STATES in feed order, reusing
	# the persistent _by_project buffers (cleared, not reallocated) and the _want list so a
	# steady poll allocates no new containers. _update_tab only needs each member's state to
	# colour its dot, so we carry states (Array[String]) rather than rebuilding view dicts.
	for arr in _by_project.values():
		(arr as Array).clear()
	_want.clear()
	_want.append(ALL_TAB)
	for id in _order:
		var v: Dictionary = _views.get(id, {})
		var pid := SummerUI.s(v.get("repo_id"), "?")
		if not _by_project.has(pid):
			_by_project[pid] = []  # one allocation only when a NEW project appears
			_want.append(pid)
		(_by_project[pid] as Array).append(SummerUI.s(v.get("state")))

	# Drop scratch buckets for projects that vanished (keeps _by_project from growing
	# unbounded across a long run; rare, only when the project set shrinks).
	if _by_project.size() > _want.size():
		for pid in _by_project.keys():
			if not _want.has(pid):
				_by_project.erase(pid)

	if force or _want != _tab_order:
		# Membership changed — rebuild the row (rare; not per-poll).
		for c in _tabs.get_children():
			c.queue_free()
		_tab_refs.clear()
		for pid in _want:
			var refs := _make_tab(pid)
			_tab_refs[pid] = refs
			_tabs.add_child(refs["root"])
		_tab_order = _want.duplicate()

	# Update per-tab dots + active styling in place from the reused state buffers.
	_all_states.clear()
	for id in _order:
		_all_states.append(SummerUI.s((_views.get(id, {}) as Dictionary).get("state")))
	for pid in _tab_refs.keys():
		var states: Array = _all_states if pid == ALL_TAB else _by_project.get(pid, [])
		_update_tab(_tab_refs[pid], pid, states)

func _make_tab(pid: String) -> Dictionary:
	var root := Button.new()
	root.flat = true
	root.focus_mode = Control.FOCUS_NONE
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	root.add_theme_font_size_override("font_size", 12)
	root.pressed.connect(func(): _activate_tab(pid, true))
	root.mouse_entered.connect(func(): UiSounds.play("hover"))

	# Custom content (label + dots) sits on a child HBox so we control spacing;
	# the Button itself provides the click target + pressed feedback.
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.set_anchors_preset(Control.PRESET_FULL_RECT)
	var m := MarginContainer.new()
	for side in ["left", "right"]:
		m.add_theme_constant_override("margin_" + side, 11)
	for side in ["top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, 6)
	m.mouse_filter = Control.MOUSE_FILTER_IGNORE
	m.add_child(row)
	root.add_child(m)

	# Truncate the display id so a long repo_id can't stretch a tab and push the rest off
	# the rail (deterministic — Labels size to content, so we cap the string, not the rect).
	var disp := "FLEET" if pid == ALL_TAB else _truncate(pid, TAB_LABEL_MAX_CHARS)
	var name_lbl := _label(disp, 12, SummerUI.TEXT)
	name_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	name_lbl.clip_text = true
	if pid != ALL_TAB and disp != pid:
		root.tooltip_text = pid  # full id on hover when truncated (Button receives hover; Label ignores)
	row.add_child(name_lbl)

	var dots := HBoxContainer.new()
	dots.add_theme_constant_override("separation", 3)
	dots.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(dots)

	# _vis_active sentinel forces the first styling pass, then gates the 3 pill
	# StyleBoxFlat allocations + name-colour override so an unchanged tab allocates
	# nothing on the poll (active state is binary; restyle only when it flips).
	return {"root": root, "name": name_lbl, "dots": dots, "_vis_active": -1}

# Update a tab's state dots + active styling. `states` is an Array[String] of member
# states (reused buffer). Dots are upserted (reused) so a poll that doesn't change counts
# allocates nothing.
func _update_tab(refs: Dictionary, pid: String, states: Array) -> void:
	var dots: HBoxContainer = refs["dots"]
	# Reconcile dot count (membership-gated mutation only).
	while dots.get_child_count() < states.size():
		var d := _label("●", SummerUI.FS_LABEL, SummerUI.TEXT_FAINT)
		d.mouse_filter = Control.MOUSE_FILTER_IGNORE
		d.set_meta("col", " ")  # sentinel so the first colour applies once
		dots.add_child(d)
	while dots.get_child_count() > states.size():
		dots.get_child(dots.get_child_count() - 1).queue_free()
	for i in states.size():
		var pal := SummerUI.state_palette(SummerUI.s(states[i]))
		var dot := dots.get_child(i)
		if dot is Label:
			# Colour overrides don't early-return on equal value — gate per dot.
			var key := str(pal["dot"])  # Color -> stable string key; String(Color) is an invalid ctor (runtime crash)
			if key != SummerUI.s(dot.get_meta("col", " ")):
				dot.set_meta("col", key)
				dot.add_theme_color_override("font_color", pal["dot"])

	var btn := refs["root"] as Button
	var active_i := 1 if pid == _active_project else 0
	# Active state is binary — restyle the pill + name colour only when it flips, so
	# a steady poll allocates none of the 3 StyleBoxFlats / the colour override.
	if active_i == int(refs.get("_vis_active", -1)):
		return
	refs["_vis_active"] = active_i
	var active := active_i == 1
	# Tabs are GHOST by default (recipe steps 2 + 3): the active tab is a subtle accent
	# HAIRLINE over a whisper of warm fill with light accent text — not a chunky filled
	# ACCENT_LO block. Inactive tabs are a faint glass pill with a hairline border.
	var bg := Color(SummerUI.ACCENT.r, SummerUI.ACCENT.g, SummerUI.ACCENT.b, 0.10) if active else SummerUI.BG_GLASS_SOFT
	var border := SummerUI.ACCENT if active else SummerUI.BORDER
	var fg := SummerUI.ACCENT_HI if active else SummerUI.TEXT_DIM
	# Hairline pill so the active tab reads at distance without shouting; reuse for normal/pressed.
	var nb := SummerUI.pill(bg, SummerUI.RADIUS_SM, 0, 0)
	nb.set_border_width_all(1)
	nb.border_color = border
	btn.add_theme_stylebox_override("normal", nb)
	btn.add_theme_stylebox_override("pressed", nb)
	var hb := SummerUI.pill(bg if active else Color(1, 1, 1, 0.06), SummerUI.RADIUS_SM, 0, 0)
	hb.set_border_width_all(1)
	hb.border_color = SummerUI.ACCENT if active else SummerUI.BORDER_HI
	btn.add_theme_stylebox_override("hover", hb)
	(refs["name"] as Label).add_theme_color_override("font_color", fg)

func _activate_tab(pid: String, user: bool) -> void:
	# A PROGRAMMATIC activation (focus_project from the shell) may carry a repo_id that
	# isn't in the current feed (a stale project the tray scoped, or one that never
	# existed). There'd be no matching tab to style and _apply_filter would hide every
	# chip → a dead "No agents in this project." with no active tab to recover from.
	# Fall back to the FLEET tab. A USER tap can only originate from a real tab, so it's
	# trusted. Mirrors the _project_present fallback in set_world.
	if not user and pid != ALL_TAB and not _project_present(pid):
		pid = ALL_TAB
	if pid == _active_project:
		return
	_active_project = pid
	if user:
		UiSounds.play("tab_switch")
		project_selected.emit(pid)
	# Restyle tabs + filter the chip column.
	_rebuild_tabs()
	_apply_filter()

# Show only chips for the active project (ALL_TAB shows everyone). Also drives the
# empty state. Pure visibility toggle — no allocation, no reorder.
func _apply_filter() -> void:
	var any_visible := false
	for id in _chips.keys():
		var v: Dictionary = _views.get(id, {})
		var pid := SummerUI.s(v.get("repo_id"), "?")
		var vis := _active_project == ALL_TAB or pid == _active_project
		_chips[id]["root"].visible = vis
		any_visible = any_visible or vis
	if _chips.is_empty():
		_empty.text = "No agents yet."
		_empty.visible = true
	elif not any_visible:
		_empty.text = "No agents in this project."
		_empty.visible = true
	else:
		_empty.visible = false

func _project_present(pid: String) -> bool:
	for id in _order:
		if SummerUI.s((_views.get(id, {}) as Dictionary).get("repo_id"), "?") == pid:
			return true
	return false

# ── Interaction ─────────────────────────────────────────────────────────────

func _on_chip_input(event: InputEvent, id: String) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		UiSounds.play("select")
		set_selected(id)
		chip_selected.emit(id)

func _on_approve(id: String) -> void:
	UiSounds.play("approve")
	if _chips.has(id):
		Juice.flash(_chips[id]["root"], SummerUI.OK_GREEN)
	approve_pressed.emit(id)

# ── Small builder helper (matches the codebase's programmatic style) ─────────
func _truncate(text: String, max_chars: int) -> String:
	return text if text.length() <= max_chars else text.substr(0, max_chars - 1) + "…"

func _label(text: String, size: int, color: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	return l
