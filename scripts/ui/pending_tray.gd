extends Control
# No class_name (consistent with juice.gd / ui_sounds.gd / diff_view.gd / fleet_roster.gd /
# dive_overlay.gd): scripts/ui is NOT in the editor's global class cache, so a global
# class_name on this script fails to resolve at load (the load fix, commit 82aa023). The
# shell holds this instance UNTYPED and binds Juice/UiSounds by path (preload) for the same
# reason. Re-adding a class_name here reintroduces the load failure.
# Bind Juice/UiSounds by path (preload) — scripts/ui is not in the editor's global
# class cache, so global class_name refs would fail to resolve at load.
const Juice := preload("res://scripts/ui/juice.gd")
const UiSounds := preload("res://scripts/ui/ui_sounds.gd")
const FrostRect := preload("res://scripts/ui/frost_rect.gd")
# ============================================================================
#  PendingTray — permissions / pending surface (Chat D / The Interface).
#
#  The "what needs ME" panel — the visible face of permissions & approvals. It
#  surfaces three things the operator must act on, fed entirely from the frozen
#  /world data:
#    1. AWAITING REVIEW — agents in state `done`: each row has Approve ✓ / Reject ✗.
#    2. BLOCKED ON LOCK — agents in state `blocked`, cross-referenced with locks[]
#       to show "<agent> wants <file> — held by <holder>"; a Focus affordance jumps
#       to that agent. This is where contention becomes legible.
#    3. THE MERGE RITUAL — per project (repo_id), once that project has reviewed
#       work, a town-hall "Merge <project>" button: the ceremonial moment the
#       fleet's work lands. Big, deliberate, sound-backed (UiSounds "merge").
#
#  Pure view, upsert-in-place (no flicker / no focus loss on the 1s poll). The
#  shell feeds set_world(); the tray emits intents UP and the shell relays them
#  as the frozen contract signals (approve / merge_requested) + additive ones.
#  No sidecar comms here.
#
#  Production: anchored (portrait + projector), zero per-frame allocations, an
#  explicit empty state ("All clear — nothing pending."), Juice on row enter /
#  approve / merge, a UiSounds.play() at every button site, legible at distance.
#
#  ── Construction ────────────────────────────────────────────────────────────
#  The whole tree is built programmatically in _ready() (matching SummerUI's
#  StyleBoxFlat-everywhere philosophy — no fragile .tscn sub-resources to drift).
#  Rows are created ONCE per id and mutated in place; only membership changes
#  (an id appears / disappears, or a row moves a section) touch the tree. The
#  poll path allocates nothing.
# ============================================================================

# ── Signals up to the shell ─────────────────────────────────────────────────
# Approve an awaiting-review agent → shell emits contract `approve(id)`.
signal approve(agent_id: String)
# Reject / send-back an awaiting-review agent (additive; no contract signal yet —
# shell decides how to forward, e.g. a prompt). Surfaced here as a first-class verb.
signal reject(agent_id: String)
# Trigger the town-hall merge ritual for a project → shell emits contract
# `merge_requested(project_id)`.
signal merge_project(project_id: String)
# Jump to / select a blocked agent → shell calls Hud.show_agent / focuses it.
signal focus_agent(agent_id: String)

# ── Layout constants (no magic numbers scattered in the body) ────────────────
const STALE_AGE_S := 15.0          # heartbeat_age_s above this == stale (dim row)
# A "blocked on lock" item is only a REAL, actionable Focus item when the contention is
# live. Two ways it goes garbage and must NOT render as a Focus row:
#   1. the blocked agent is ITSELF stale/crashed — the Aiven projection force-projects a
#      stale (>15s) agent into state `blocked` with a "stale <N>s — …" status_line
#      (projection.ts:122-129), so a dead session masquerades as a block. Not actionable.
#   2. it is blocked on an ABANDONED lock — the holding lock is older than this TTL (a dead
#      session's auto-registered claim held ~1490s), so the contention is fictional.
# LOCK_STALE_AGE_S mirrors the ~60s the operator intuits as "nobody's actually holding this".
const LOCK_STALE_AGE_S := 60.0
const PAD := 16                    # outer content margin (§1 generous padding)
const ROW_GAP := 8                 # gap between rows in a section
const SECTION_GAP := 16            # gap between the three sections
const ROW_PAD := 12                # inner row content margin (no cramped rows)
const ROW_BTN_H := 36              # one row-button height EVERYWHERE (consistent rows)
const HEAD_SIZE := SummerUI.FS_LABEL   # the standing "NEEDS YOU" header
const TITLE_SIZE := SummerUI.FS_MICRO  # section headers: tiny + tracked + quiet
const ROW_NAME_SIZE := SummerUI.FS_BODY  # names pop (§1: ≥ 18)
const ROW_SUB_SIZE := SummerUI.FS_LABEL  # meta recedes but legible
const MERGE_SIZE := 17
const EMPTY_SIZE := SummerUI.FS_LABEL

# Built nodes.
var _scroll: ScrollContainer
var _outer: VBoxContainer             # full content column (animated on set_open)
var _column: VBoxContainer            # holds the three section blocks + empty label
var _review_block: VBoxContainer      # header + rows for awaiting-review
var _review_section: VBoxContainer    # awaiting-review rows
var _blocked_block: VBoxContainer
var _blocked_section: VBoxContainer   # blocked-on-lock rows
var _merge_block: VBoxContainer
var _merge_section: VBoxContainer     # per-project merge buttons
var _empty: Label                     # "All clear" placeholder
var _review_title: Label
var _blocked_title: Label
var _merge_title: Label

# State mirrors (reused across polls; never reallocated).
var _review_rows: Dictionary = {}    # agent_id -> row refs Dictionary
var _blocked_rows: Dictionary = {}   # agent_id -> row refs Dictionary
var _merge_rows: Dictionary = {}     # project_id -> row refs Dictionary
var _locks: Array = []               # last locks[] snapshot (for holder lookup)
# STICKY REVIEW LATCH (bug fix: a pending review must PERSIST until the user acts).
# Once an agent enters AWAITING REVIEW (state == done) we latch its last-known
# AgentView here and keep rendering the row even if a later poll momentarily omits
# the agent or reports it in a non-done state. A latched item clears ONLY on an
# explicit approve/reject (the user acted) or when the agent genuinely went back to
# work (reappears in an ACTIVE non-done state: working/moving/blocked) — i.e. a real
# resolution, not a poll flicker. agent_id -> last AgentView dict.
var _review_latched: Dictionary = {}
# Ids the user explicitly approved/rejected — suppressed from re-latching until the
# agent demonstrably moves on, so an approve/reject can't be undone by a stale poll
# that still reports the just-acted agent as done. Cleared once the agent leaves done.
var _review_acted: Dictionary = {}
# Consecutive-poll absence counter for latched/acted ids (agent_id -> int). A done agent that
# despawns or is resolved server-side leaves the /world feed WITHOUT a working/moving/blocked
# transition, so the reconcile pass never clears it and the row would leak forever (pre-fix the
# absence self-healed via _drop_stale, removed when the latch became the render source). We instead
# count consecutive polls an id is ABSENT from agents[]; after ABSENT_DROP_POLLS we drop the latch
# (and the acted flag), so a momentary flicker (1–2 polls) is forgiven but a real vanish is reaped.
var _review_absent: Dictionary = {}
const ABSENT_DROP_POLLS := 4   # ~4s at the 1s poll: covers the intended flicker grace, reaps a true vanish
var _open := true                    # tray visibility (set_open)
# False until the FIRST set_world has painted. The first paint must NOT fire
# done_cheer / lock_slam for pre-existing rows (that's a wall of overlapping audio
# on a pool of 6 + a swarm of concurrent tweens) — cheer/slam celebrate a
# TRANSITION into the queue, not initial membership. Rows still pop in; only the
# celebration + its sound is suppressed on the priming pass.
var _primed := false

# Scratch reused every poll so the upsert path allocates nothing. Each consumer
# clears before filling; never aliased across two live uses in the same frame.
var _scratch_order: Array = []       # id ordering for the section currently refreshing
var _merge_counts: Dictionary = {}   # repo_id -> reviewable count (merge aggregation)
var _merge_names: Dictionary = {}    # repo_id -> friendly display name (projector-legible)
var _merge_all_stale: Dictionary = {} # repo_id -> bool (every contributing agent stale)

# Content height for the shell's layout, so the tray floats as a card hugging its
# rows instead of a fixed box. Estimated from the live row counts.
func content_height() -> float:
	var rows := _review_rows.size() + _blocked_rows.size() + _merge_rows.size()
	if rows == 0:
		return 86.0  # just the "All clear — nothing pending." empty state
	var sections := (1 if _review_rows.size() > 0 else 0) \
		+ (1 if _blocked_rows.size() > 0 else 0) \
		+ (1 if _merge_rows.size() > 0 else 0)
	# header "NEEDS YOU" + per-section quiet title + each row (name 18 + sub + ROW_PAD
	# top/bottom + button) + the inter-section/row gaps. Estimate slightly generous so
	# the content-hugging card never clips its last row.
	return float(PAD) * 2.0 + 26.0 + float(sections) * 24.0 + float(rows) * 66.0 \
		+ float(sections) * float(SECTION_GAP)

func _ready() -> void:
	# World clicks fall through the empty gaps of the dock.
	mouse_filter = Control.MOUSE_FILTER_PASS
	_build()

# ── Tree construction (once) ────────────────────────────────────────────────
func _build() -> void:
	var bg := Panel.new()
	bg.name = "Bg"
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_PASS
	# Frosted glass: a blurred FrostRect backs the panel, the stylebox is a hairline
	# edge (attach_frost handles both). Match the cards' ~16 radius.
	SummerUI.attach_frost(bg, SummerUI.BG_GLASS, 16)
	add_child(bg)

	var margin := MarginContainer.new()
	margin.name = "Margin"
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", PAD)
	margin.add_theme_constant_override("margin_right", PAD)
	margin.add_theme_constant_override("margin_top", PAD)
	margin.add_theme_constant_override("margin_bottom", PAD)
	bg.add_child(margin)

	var outer := VBoxContainer.new()
	outer.name = "Outer"
	outer.add_theme_constant_override("separation", 10)
	margin.add_child(outer)
	_outer = outer

	# Header: "NEEDS YOU". Per-section counts live in the section titles
	# (_update_titles/_title_with_count), so the header is just the standing label.
	var head_label := Label.new()
	head_label.text = "NEEDS YOU"
	head_label.add_theme_font_size_override("font_size", HEAD_SIZE)
	head_label.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	outer.add_child(head_label)

	_scroll = ScrollContainer.new()
	_scroll.name = "Scroll"
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	outer.add_child(_scroll)

	_column = VBoxContainer.new()
	_column.name = "Column"
	_column.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_column.add_theme_constant_override("separation", SECTION_GAP)
	_scroll.add_child(_column)

	# The three section blocks (header + rows VBox each). Hidden until populated.
	var review := _make_section("AWAITING REVIEW")
	_review_block = review[0]; _review_title = review[1]; _review_section = review[2]
	var blocked := _make_section("BLOCKED ON LOCK")
	_blocked_block = blocked[0]; _blocked_title = blocked[1]; _blocked_section = blocked[2]
	var merge := _make_section("MERGE RITUAL")
	_merge_block = merge[0]; _merge_title = merge[1]; _merge_section = merge[2]
	_column.add_child(_review_block)
	_column.add_child(_blocked_block)
	_column.add_child(_merge_block)

	# Empty / all-clear state.
	_empty = Label.new()
	_empty.name = "Empty"
	_empty.text = "All clear — nothing pending."
	_empty.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_empty.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_empty.add_theme_font_size_override("font_size", EMPTY_SIZE)
	_empty.add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	_empty.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_empty.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_column.add_child(_empty)

	_set_block_visible(_review_block, false)
	_set_block_visible(_blocked_block, false)
	_set_block_visible(_merge_block, false)

# Returns [block, title_label, rows_vbox].
# Section headers are QUIET + tracked (§1/§4): no colour-coded dot (colour is signal,
# not decoration — the row's own state dot carries hue), faint + tiny + uppercase so
# the header recedes and the rows are what the eye lands on.
func _make_section(title: String) -> Array:
	var block := VBoxContainer.new()
	block.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	block.add_theme_constant_override("separation", ROW_GAP)

	var base_text := title
	var title_lbl := Label.new()
	title_lbl.add_theme_font_size_override("font_size", TITLE_SIZE)
	title_lbl.add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	# Light letter-tracking gives the "expensive" small-caps header feel without a
	# bespoke font; Label has no spacing constant, so we space the glyphs in text.
	# Cache the tracked (letter-spaced) base ONCE so the poll path only formats the
	# count, never re-spaces the string every frame (steady-poll allocation discipline).
	title_lbl.set_meta("base", _tracked(base_text))
	title_lbl.text = title_lbl.get_meta("base")
	block.add_child(title_lbl)

	var rows := VBoxContainer.new()
	rows.name = "Rows"
	rows.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rows.add_theme_constant_override("separation", ROW_GAP)
	block.add_child(rows)

	return [block, title_lbl, rows]

# Insert a hair space between glyphs so an uppercase header reads tracked/letter-spaced
# (calm, precise — Linear/OpenAI grade) without depending on a font with real tracking.
func _tracked(s: String) -> String:
	if s == "":
		return s
	var out := ""
	for i in s.length():
		out += s[i]
		if i < s.length() - 1:
			out += " "  # hair space
	return out

# ── Shell API (methods the Hud shell calls down) ────────────────────────────

# Feed the frozen WorldSnapshot each poll. Derives the three queues from agents[]
# (state done / blocked) and locks[]; upserts rows in place; drops rows that no
# longer apply; computes which projects have reviewable work to show a merge
# button. Null-safe on every nullable field. Fires Juice + UiSounds on new rows
# (done_cheer on a fresh review item, lock_slam on a fresh block).
func set_world(snapshot: Dictionary) -> void:
	var agents: Array = snapshot.get("agents", []) if snapshot != null else []
	if not (agents is Array):
		agents = []
	var locks_raw = snapshot.get("locks", []) if snapshot != null else []
	_locks = locks_raw if locks_raw is Array else []

	# First paint celebrates nothing (initial membership is not a transition).
	var celebrate := _primed
	_refresh_review(agents, celebrate)
	_refresh_blocked(agents, celebrate)
	_refresh_merge(agents, celebrate)

	# Empty-state vs content are MUTUALLY EXCLUSIVE — never both laid out at once
	# (that's the overlap bug: the centered "nothing pending" label colliding with a
	# section header + its "· N" count). When anything is pending the empty line is
	# hidden (so it claims no vertical space and can't collide); when nothing is
	# pending every section block is already hidden by its own _set_block_visible,
	# so only the empty line shows. The titles' "· N" suffix is therefore only ever
	# rendered while the empty line is hidden.
	var total := _review_rows.size() + _blocked_rows.size() + _merge_rows.size()
	var has_any := total > 0
	_empty.visible = not has_any
	_update_titles()
	_primed = true

# ── Section 1: AWAITING REVIEW (state == done) ───────────────────────────────
# STICKY: a review item, once surfaced, survives a poll that momentarily omits the
# agent or reports it off-`done`. We render from a LATCHED set, not from the raw
# current-poll done-set, so a diff/approve row can't vanish under the operator before
# they act. The latch clears only on explicit approve/reject or a real resolution
# (the agent reappears actively working again).
func _refresh_review(agents: Array, celebrate: bool) -> void:
	# 1) Reconcile the latch against this poll. An agent reported in an ACTIVE non-done
	#    state (working/moving/blocked) has genuinely moved on — drop its latch + acted
	#    flag (a future done re-latches it). A done agent (re)latches with its fresh view,
	#    unless the user just acted on it (suppressed until it leaves done).
	var present := {}
	for a in agents:
		if not (a is Dictionary):
			continue
		var pid := SummerUI.s(a.get("agent_id"))
		if pid == "":
			continue
		present[pid] = true
		var pstate := SummerUI.s(a.get("state"))
		if SummerUI.awaits_approval(pstate):
			if not _review_acted.has(pid):
				_review_latched[pid] = a  # latch / refresh the last-known done view
		elif pstate == "working" or pstate == "moving" or pstate == "blocked":
			# Real resolution: the agent went back to work. Stop latching it.
			_review_latched.erase(pid)
			_review_acted.erase(pid)
		# `waiting` (still present) is treated as a flicker — keep whatever we have latched.

	# Presence reaper: a latched/acted id that has VANISHED from the feed (despawned or resolved
	# server-side) gets an absence count; present ids reset to 0. After ABSENT_DROP_POLLS consecutive
	# misses we drop the latch + acted flag so a done-then-gone agent can't leak its stale row forever.
	# A short absence (flicker) is forgiven because the count resets the instant the id reappears.
	var tracked := {}
	for id in _review_latched.keys():
		tracked[id] = true
	for id in _review_acted.keys():
		tracked[id] = true
	for id in tracked.keys():
		if present.has(id):
			_review_absent.erase(id)
		else:
			var n := int(_review_absent.get(id, 0)) + 1
			if n >= ABSENT_DROP_POLLS:
				_review_latched.erase(id)
				_review_acted.erase(id)
				_review_absent.erase(id)
			else:
				_review_absent[id] = n
	# Forget absence counters for ids we no longer track at all (defensive; keeps the map bounded).
	for id in _review_absent.keys():
		if not tracked.has(id):
			_review_absent.erase(id)

	# 2) Render one row per latched id, using the latched (last-known) view. Absent-this-
	#    poll agents keep their cached view, so the row stays put until the user acts.
	_scratch_order.clear()
	for aid in _review_latched.keys():
		var a: Dictionary = _review_latched[aid]
		if not (a is Dictionary):
			continue
		_scratch_order.append(aid)
		var fresh := not _review_rows.has(aid)
		var row: Dictionary = _review_rows[aid] if not fresh else _make_review_row(aid)
		if fresh:
			_review_rows[aid] = row
			_review_section.add_child(row["root"])
		_fill_review_row(row, a)
		# Entrance is owned here, AFTER fill, so the row's rest modulate (dimmed to
		# 0.55 if stale by _apply_stale) is already in place. A celebrated row cheers —
		# done_cheer captures that rest alpha, so a stale arrival cheers to 0.55, not
		# 1.0. A non-celebrated (priming) row pops in, EXCEPT when stale: pop would
		# tween modulate:a back to 1.0 and permanently un-dim it, so we let a stale
		# fresh row simply appear at its dim.
		if fresh:
			if celebrate:
				Juice.done_cheer(row["root"])
				UiSounds.play("done_cheer")
			elif float(row.get("_alpha", 1.0)) >= 1.0:
				Juice.pop(row["root"])

	_drop_stale(_review_rows, _scratch_order)
	_reorder(_review_section, _review_rows, _scratch_order)
	_set_block_visible(_review_block, _review_rows.size() > 0)

func _make_review_row(aid: String) -> Dictionary:
	var root := _row_panel()

	# A PanelContainer sizes ALL its Control children to its content rect and routes
	# input to the topmost (last) child first. So child 0 is a full-rect, behind-
	# everything focus button (the clickable body), and child 1 is the content HBox
	# whose real buttons sit on top and capture their own clicks. No FULL_RECT child
	# fighting a container's layout.
	var body_btn := Button.new()
	body_btn.flat = true
	body_btn.focus_mode = Control.FOCUS_NONE
	body_btn.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	body_btn.add_theme_stylebox_override("normal", SummerUI.sb(Color(0, 0, 0, 0), 8))
	body_btn.add_theme_stylebox_override("hover", SummerUI.sb(Color(1, 1, 1, 0.05), 8))
	body_btn.add_theme_stylebox_override("pressed", SummerUI.sb(Color(1, 1, 1, 0.03), 8))
	body_btn.pressed.connect(func() -> void:
		UiSounds.play("select")
		focus_agent.emit(aid))
	body_btn.mouse_entered.connect(func() -> void: UiSounds.play("hover"))
	root.add_child(body_btn)

	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 10)
	hb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hb.mouse_filter = Control.MOUSE_FILTER_PASS  # empty gaps fall through to body_btn
	root.add_child(hb)

	var dot := Panel.new()
	dot.custom_minimum_size = Vector2(10, 10)
	dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hb.add_child(dot)

	var col := VBoxContainer.new()
	col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	col.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	col.add_theme_constant_override("separation", 1)
	col.mouse_filter = Control.MOUSE_FILTER_IGNORE  # let body clicks reach body_btn
	hb.add_child(col)
	var name_lbl := _name_label()
	var sub_lbl := _sub_label()
	col.add_child(name_lbl)
	col.add_child(sub_lbl)

	var reject_btn := Button.new()
	reject_btn.text = "Reject"
	reject_btn.custom_minimum_size = Vector2(0, ROW_BTN_H)
	reject_btn.tooltip_text = "Send back"
	SummerUI.ghost_button(reject_btn)
	reject_btn.pressed.connect(func() -> void:
		UiSounds.play("reject")
		Juice.flash(root, SummerUI.DANGER)
		_mark_acted(aid)
		reject.emit(aid))
	reject_btn.mouse_entered.connect(func() -> void: UiSounds.play("hover"))
	hb.add_child(reject_btn)

	var approve_btn := Button.new()
	approve_btn.text = "Approve"
	approve_btn.custom_minimum_size = Vector2(0, ROW_BTN_H)
	SummerUI.accent_button(approve_btn)
	approve_btn.pressed.connect(func() -> void:
		UiSounds.play("approve")
		Juice.pop(approve_btn)
		_mark_acted(aid)
		approve.emit(aid))
	approve_btn.mouse_entered.connect(func() -> void: UiSounds.play("hover"))
	hb.add_child(approve_btn)

	# NOTE: no Juice.pop() here. The entrance is owned by the refresh AFTER the row is
	# filled, so it can (a) cheer/slam a celebrated row without a second _TW_SCALE tween
	# fighting pop, and (b) skip pop on a stale row so pop's modulate:a→1.0 doesn't
	# overshoot the intended stale dim (0.55) and leave it permanently un-dimmed.
	return {"root": root, "dot": dot, "name": name_lbl, "sub": sub_lbl,
		"approve": approve_btn, "reject": reject_btn}

func _fill_review_row(row: Dictionary, a: Dictionary) -> void:
	var pal := SummerUI.state_palette("done")
	(row["dot"] as Panel).add_theme_stylebox_override("panel", SummerUI.sb(pal["dot"], 5))
	var label := SummerUI.s(a.get("label"), SummerUI.s(a.get("agent_id"), "agent"))
	(row["name"] as Label).text = label
	var task := SummerUI.s(a.get("current_task"))
	var sub := task if task != "" else SummerUI.s(a.get("status_line"), "awaiting your review")
	_apply_stale(row, a, sub)

# ── Section 2: BLOCKED ON LOCK (state == blocked × locks[]) ──────────────────
func _refresh_blocked(agents: Array, celebrate: bool) -> void:
	_scratch_order.clear()
	for a in agents:
		if not (a is Dictionary):
			continue
		if SummerUI.s(a.get("state")) != "blocked":
			continue
		var aid := SummerUI.s(a.get("agent_id"))
		if aid == "":
			continue
		# Gate out garbage "blocked" rows that aren't a real, actionable contention.
		# A stale/crashed agent (projection force-projects it to `blocked`) or a block on
		# an abandoned lock is noise — surfacing it as a Focus item shows the operator
		# nothing real. Suppress it; if nothing real remains the empty state shows.
		if _is_stale_block(a):
			continue
		_scratch_order.append(aid)
		var fresh := not _blocked_rows.has(aid)
		var row: Dictionary = _blocked_rows[aid] if not fresh else _make_blocked_row(aid)
		if fresh:
			_blocked_rows[aid] = row
			_blocked_section.add_child(row["root"])
		_fill_blocked_row(row, a)
		# Entrance owned here after fill (see _refresh_review). A fresh block lands hard
		# with lock_slam, which captures the post-fill rest alpha (0.55 if stale). On the
		# priming pass we pop instead — but skip pop on a stale row so it keeps its dim
		# rather than pop overshooting modulate:a to 1.0.
		if fresh:
			if celebrate:
				Juice.lock_slam(row["root"])
				UiSounds.play("blocked")
			elif float(row.get("_alpha", 1.0)) >= 1.0:
				Juice.pop(row["root"])

	_drop_stale(_blocked_rows, _scratch_order)
	_reorder(_blocked_section, _blocked_rows, _scratch_order)
	_set_block_visible(_blocked_block, _blocked_rows.size() > 0)

func _make_blocked_row(aid: String) -> Dictionary:
	# A low-alpha danger tint over the frost — warm contention, not a loud red slab.
	var dt := SummerUI.DANGER
	var root := _row_panel(Color(dt.r * 0.4, dt.g * 0.25, dt.b * 0.25, 0.30))
	var hb := HBoxContainer.new()
	hb.add_theme_constant_override("separation", 10)
	hb.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_child(hb)

	# A DANGER state dot (not a 🔒 emoji — bundled UI fonts render emoji as tofu, and
	# the dot matches the review row's shape so both sections read as ONE clean list).
	# Colour = signal: this dot is the only hue on the row.
	var dot := Panel.new()
	dot.custom_minimum_size = Vector2(10, 10)
	dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	dot.add_theme_stylebox_override("panel", SummerUI.sb(SummerUI.DANGER, 5))
	hb.add_child(dot)

	var col := VBoxContainer.new()
	col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	col.add_theme_constant_override("separation", 1)
	hb.add_child(col)
	var name_lbl := _name_label()
	var sub_lbl := _sub_label()
	col.add_child(name_lbl)
	col.add_child(sub_lbl)

	var focus_btn := Button.new()
	focus_btn.text = "Focus"
	focus_btn.custom_minimum_size = Vector2(0, ROW_BTN_H)
	SummerUI.ghost_button(focus_btn)
	focus_btn.pressed.connect(func() -> void:
		UiSounds.play("select")
		focus_agent.emit(aid))
	focus_btn.mouse_entered.connect(func() -> void: UiSounds.play("hover"))
	hb.add_child(focus_btn)

	# NOTE: no Juice.pop() here — entrance owned by the refresh after fill (see
	# _make_review_row). Lets a celebrated row lock_slam cleanly and a stale row keep
	# its dim instead of pop overshooting modulate:a to 1.0.
	return {"root": root, "name": name_lbl, "sub": sub_lbl, "focus": focus_btn}

func _fill_blocked_row(row: Dictionary, a: Dictionary) -> void:
	var aid := SummerUI.s(a.get("agent_id"))
	var label := SummerUI.s(a.get("label"), aid if aid != "" else "agent")
	(row["name"] as Label).text = label
	# Cross-reference locks[] to explain the contention legibly.
	var repo_path := SummerUI.s(a.get("repo_path"))
	var sub := _contention_text(aid, repo_path)
	if sub == "":
		sub = SummerUI.s(a.get("status_line"), "blocked")
	_apply_stale(row, a, sub)

# Build the contention sub-line from the frozen locks[] for this agent. AgentView
# has no "wanted file" field, so the specific file is a heuristic: assert it ONLY
# when exactly one foreign lock matches this repo. With multiple contended locks in
# the repo we can't know which one this agent waits on, so we soften to
# "waiting on a lock — held by <holder>" rather than naming the wrong file as fact.
func _contention_text(agent_id: String, repo_path: String) -> String:
	var first_holder := ""
	var first_file := ""
	var matches := 0
	for l in _locks:
		if not (l is Dictionary):
			continue
		var holder := SummerUI.s(l.get("holder_agent_id"))
		if holder == "" or holder == agent_id:
			continue
		# Match by repo when we have one; otherwise surface any contended lock.
		var lrepo := SummerUI.s(l.get("repo_path"))
		if repo_path != "" and lrepo != "" and lrepo != repo_path:
			continue
		matches += 1
		if matches == 1:
			first_holder = holder
			first_file = SummerUI.s(l.get("file_path"), "a file")
	if matches == 0:
		return ""
	if matches == 1:
		return "wants %s — held by %s" % [_basename(first_file), first_holder]
	# Ambiguous: name the holder but not a specific file we can't be sure of.
	return "waiting on a lock — held by %s" % first_holder

func _basename(path: String) -> String:
	var p := path.replace("\\", "/")
	var idx := p.rfind("/")
	return p.substr(idx + 1) if idx >= 0 else p

# True when a `blocked` agent is NOT a real, actionable contention and must be suppressed
# from the tray. Three garbage shapes, any one disqualifies it:
#   (a) the agent is itself stale (heartbeat_age_s past STALE_AGE_S) — a crashed/wedged
#       session the projection force-projected into `blocked` (projection.ts), not a
#       genuine wait-on-peer. Clicking Focus shows nothing live.
#   (b) its status_line is flagged stale/auto-registered — the projection prefixes a
#       crashed agent's line with "stale <N>s — …" and abandoned auto-registered claims
#       read "auto-registered". String-level catch for the same dead-session case.
#   (c) it is blocked ONLY on abandoned locks — every foreign lock it could be waiting on
#       was claimed long ago (claimed_at older than LOCK_STALE_AGE_S) by a holder that has
#       gone away. No live holder == fictional block.
func _is_stale_block(a: Dictionary) -> bool:
	var age := float(a.get("heartbeat_age_s", 0.0)) if a.get("heartbeat_age_s") != null else 0.0
	if age > STALE_AGE_S:
		return true
	var line := SummerUI.s(a.get("status_line")).to_lower()
	if line.begins_with("stale ") or line.find("auto-registered") >= 0 or line.find("auto registered") >= 0:
		return true
	return _block_is_abandoned(a)

# A block is "abandoned" when the agent has foreign locks it could be waiting on but EVERY
# such lock is stale (claimed_at past LOCK_STALE_AGE_S) — i.e. held by a dead session whose
# claim was never reaped. Returns false when there is at least one fresh foreign lock (a
# live contention worth surfacing) or when we can't time the lock (no parseable claimed_at:
# never suppress on uncertainty — a real block must keep working).
func _block_is_abandoned(a: Dictionary) -> bool:
	var aid := SummerUI.s(a.get("agent_id"))
	var repo_path := SummerUI.s(a.get("repo_path"))
	var foreign := 0
	var stale := 0
	for l in _locks:
		if not (l is Dictionary):
			continue
		var holder := SummerUI.s(l.get("holder_agent_id"))
		if holder == "" or holder == aid:
			continue
		var lrepo := SummerUI.s(l.get("repo_path"))
		if repo_path != "" and lrepo != "" and lrepo != repo_path:
			continue
		foreign += 1
		var claimed_age := _lock_age_s(l)
		# Unknown age (-1) is treated as fresh — never suppress a real block on uncertainty.
		if claimed_age >= 0.0 and claimed_age > LOCK_STALE_AGE_S:
			stale += 1
	# No foreign lock at all: this isn't a lock-abandonment case, leave it to other gates.
	if foreign == 0:
		return false
	return stale == foreign

# Seconds since a lock's claimed_at (ISO 8601). Returns -1.0 when absent/unparseable so the
# caller can treat unknown age as fresh rather than wrongly reaping a live block.
func _lock_age_s(l: Dictionary) -> float:
	var claimed := SummerUI.s(l.get("claimed_at"))
	if claimed == "":
		return -1.0
	# claimed_at is UTC ISO 8601 ("…Z"). get_unix_time_from_datetime_string reads the
	# wall-clock fields with no zone, so compare it against UTC now (get_unix_time_from_system
	# is UTC) — never local — or the local offset would skew the age (a fresh lock could read
	# stale under a negative offset). Strip the trailing Z (zone designators aren't parsed).
	var iso := claimed.rstrip("Zz")
	var unix := Time.get_unix_time_from_datetime_string(iso)
	if unix <= 0.0:
		return -1.0
	var now := Time.get_unix_time_from_system()
	var age := now - unix
	return age if age >= 0.0 else 0.0

# ── Section 3: THE MERGE RITUAL (per repo_id with reviewable work) ───────────
func _refresh_merge(agents: Array, celebrate: bool) -> void:
	# Aggregate per project: how much reviewable (done) work it has, a human display
	# name (raw repo_id is a slug/uuid — unreadable on a projector), and whether ALL
	# its contributing agents are stale (so the ceremonial CTA doesn't over-promise).
	# Only repos with >0 reviewable agents get a merge row, so we count straight in.
	_merge_counts.clear()
	_merge_names.clear()
	_merge_all_stale.clear()
	for a in agents:
		if not (a is Dictionary):
			continue
		if not SummerUI.awaits_approval(SummerUI.s(a.get("state"))):
			continue
		var repo := SummerUI.s(a.get("repo_id"))
		if repo == "":
			continue
		_merge_counts[repo] = int(_merge_counts.get(repo, 0)) + 1
		# Capture the first non-empty agent label (else repo_path basename) as the
		# friendly name; fall back to repo_id later if neither is present.
		if not _merge_names.has(repo):
			var nm := SummerUI.s(a.get("label"))
			if nm == "":
				nm = _basename(SummerUI.s(a.get("repo_path")))
			if nm != "":
				_merge_names[repo] = nm
		# All-stale tracking: a repo is "all stale" only if EVERY contributing agent is.
		var age := float(a.get("heartbeat_age_s", 0.0)) if a.get("heartbeat_age_s") != null else 0.0
		var this_stale := age > STALE_AGE_S
		_merge_all_stale[repo] = this_stale if not _merge_all_stale.has(repo) else (bool(_merge_all_stale[repo]) and this_stale)

	_scratch_order.clear()
	for repo in _merge_counts.keys():
		var n := int(_merge_counts[repo])
		if n <= 0:
			continue  # only show the ritual when there is landed work to merge
		_scratch_order.append(repo)
		var fresh := not _merge_rows.has(repo)
		var row: Dictionary = _merge_rows[repo] if not fresh else _make_merge_row(repo)
		if fresh:
			_merge_rows[repo] = row
			_merge_section.add_child(row["root"])
		var btn := row["btn"] as Button
		var display := SummerUI.s(_merge_names.get(repo, repo), repo)
		btn.text = "⚔  Merge %s  (%d)" % [display, n]
		# The aggregate count climbing is the most important number in the room —
		# give the silent rewrite a beat when it ticks UP on an existing row.
		if not fresh and celebrate and n > int(row.get("_n", n)):
			Juice.pulse(btn)
			UiSounds.play("done_cheer")
		row["_n"] = n
		# Don't over-promise: if every contributing agent is stale, dim the CTA to
		# match row staleness (write only on change to not fight any in-flight tween).
		var alpha := 0.6 if bool(_merge_all_stale.get(repo, false)) else 1.0
		if row.get("_alpha") != alpha:
			(row["root"] as Control).modulate = Color(1, 1, 1, alpha)
			row["_alpha"] = alpha
		# Pop only a non-dimmed fresh row: pop tweens modulate:a→1.0, which would
		# overshoot the all-stale CTA dim (0.6) and leave it permanently un-dimmed
		# (same class of bug as the review/blocked entrance — see _refresh_review).
		if fresh and alpha >= 1.0:
			Juice.pop(row["root"])

	_drop_stale(_merge_rows, _scratch_order)
	_reorder(_merge_section, _merge_rows, _scratch_order)
	_set_block_visible(_merge_block, false)  # SLAM Fix 2: merge isn't a demo beat (kept built, just hidden)

func _make_merge_row(repo: String) -> Dictionary:
	var btn := Button.new()
	btn.custom_minimum_size = Vector2(0, 48)
	btn.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	btn.add_theme_font_size_override("font_size", MERGE_SIZE)
	SummerUI.success_button(btn)
	btn.pressed.connect(func() -> void:
		UiSounds.play("merge")
		Juice.done_cheer(btn)
		merge_project.emit(repo))
	btn.mouse_entered.connect(func() -> void: UiSounds.play("hover"))
	return {"root": btn, "btn": btn}

# ── Row helpers ──────────────────────────────────────────────────────────────
# Each row is a frosted-glass surface (secondary tone) with a hairline edge. A
# blocked row passes its DANGER tint through the frost so contention reads warm.
# attach_frost inserts the blur as child 0; the row's content HBox/body button are
# added AFTER, so they sit on top — input routing (PanelContainer → topmost child)
# is unaffected. pad 10 keeps the row's inner content margin.
func _row_panel(tint := SummerUI.BG_GLASS_SOFT) -> PanelContainer:
	var pc := PanelContainer.new()
	pc.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	SummerUI.attach_frost(pc, tint, 12, ROW_PAD)
	return pc

func _name_label() -> Label:
	var l := Label.new()
	l.add_theme_font_size_override("font_size", ROW_NAME_SIZE)
	l.add_theme_color_override("font_color", SummerUI.TEXT)
	l.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	l.clip_text = true
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

func _sub_label() -> Label:
	var l := Label.new()
	l.add_theme_font_size_override("font_size", ROW_SUB_SIZE)
	l.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	l.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	l.clip_text = true
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

# Apply the sub-line + stale dimming. heartbeat_age_s > STALE_AGE_S => faded +
# a "(stale)" hint so a dead agent in the queue is obvious, not silently trusted.
func _apply_stale(row: Dictionary, a: Dictionary, sub: String) -> void:
	var age := float(a.get("heartbeat_age_s", 0.0)) if a.get("heartbeat_age_s") != null else 0.0
	var stale := age > STALE_AGE_S
	var sub_lbl := row["sub"] as Label
	sub_lbl.text = (sub + "  · stale") if stale else sub
	# Write modulate ONLY when the stale state changes. Writing it every poll would
	# (a) fight an in-flight Juice cheer/slam modulate tween and (b) instantly stomp
	# a Juice.flash (e.g. the reject DANGER flash) back to opaque on the next 1s poll.
	# Storing _alpha lets Juice own modulate between actual state changes.
	var alpha := 0.55 if stale else 1.0
	if row.get("_alpha") != alpha:
		(row["root"] as Control).modulate = Color(1, 1, 1, alpha)
		row["_alpha"] = alpha

# The user explicitly approved/rejected this review item. Drop it from the live latch
# (the row clears on the next reorder/drop pass) and remember the id as acted so a
# stale poll still reporting it `done` can't resurrect the row. The acted flag clears
# the moment the agent leaves `done` (see _refresh_review's reconcile pass).
func _mark_acted(aid: String) -> void:
	_review_latched.erase(aid)
	_review_acted[aid] = true
	# Tear the row down now so the act feels immediate (don't wait a poll for _drop_stale).
	if _review_rows.has(aid):
		var node := (_review_rows[aid] as Dictionary)["root"] as Node
		if is_instance_valid(node):
			node.queue_free()
		_review_rows.erase(aid)

# ── Membership maintenance (the only tree mutations on the poll) ─────────────

# Free + erase rows whose id is no longer in `keep`.
func _drop_stale(rows: Dictionary, keep: Array) -> void:
	var to_drop: Array = []
	for id in rows.keys():
		if not keep.has(id):
			to_drop.append(id)
	for id in to_drop:
		var row: Dictionary = rows[id]
		var node := row["root"] as Node
		if is_instance_valid(node):
			node.queue_free()
		rows.erase(id)

# Match child order to `order` (membership-stable rows keep identity; no flicker).
func _reorder(section: VBoxContainer, rows: Dictionary, order: Array) -> void:
	var idx := 0
	for id in order:
		if not rows.has(id):
			continue
		var node := (rows[id] as Dictionary)["root"] as Control
		if section.get_child(idx) != node:
			section.move_child(node, idx)
		idx += 1

func _set_block_visible(block: VBoxContainer, on: bool) -> void:
	if block.visible != on:
		block.visible = on

func _update_titles() -> void:
	_title_with_count(_review_title, _review_rows.size())
	_title_with_count(_blocked_title, _blocked_rows.size())
	_title_with_count(_merge_title, _merge_rows.size())

func _title_with_count(title: Label, n: int) -> void:
	# base is already tracked + cached (set in _make_section); just append the count.
	var base := SummerUI.s(title.get_meta("base", ""), "")
	title.text = "%s   %d" % [base, n] if n > 0 else base

# ── Shell API: visibility + count ────────────────────────────────────────────

# Show/hide the tray (the shell may dock it under the roster or toggle it). Plays
# UiSounds panel_open/panel_close at the call site.
#
# Motion note: the tray root is anchored FULL_RECT by the shell (see .tscn PRESET 15),
# so its rect is anchor/container-driven — writing `position` on it (Juice.slide_in)
# would be fought by the next layout pass and snap/jitter. So we keep SELF purely
# visible/hidden and animate the inner content column with Juice.pop, which animates
# `scale` around a centered pivot (never position/size) and so never fights layout.
func set_open(open: bool) -> void:
	if open == _open and visible == open:
		return
	_open = open
	if open:
		visible = true
		if _outer != null:
			Juice.pop(_outer)
		UiSounds.play("panel_open")
	else:
		UiSounds.play("panel_close")
		visible = false

# Count of items currently needing attention (review + blocked) — lets the shell
# badge a tab / decide whether to auto-open the tray.
func pending_count() -> int:
	return _review_rows.size() + _blocked_rows.size()
