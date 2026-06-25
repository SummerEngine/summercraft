extends Control
# No class_name (consistent with fleet_roster.gd / juice.gd / ui_sounds.gd, commit 82aa023):
# scripts/ui is not in the editor's global class cache, so a global class_name would fail to
# resolve at load. The Hud shell holds this instance untyped and binds it via a preload const,
# calling only the documented API below — neither needs a global name. Theme via SummerUI,
# motion via Juice, sound via UiSounds (preload const; never as a type).
const Juice := preload("res://scripts/ui/juice.gd")
const UiSounds := preload("res://scripts/ui/ui_sounds.gd")
# ============================================================================
#  WorldBrowser — the "visit other people's worlds" front door (Lane D).
#
#  A frosted overlay panel that lists the multiplayer worlds the player can
#  visit. One row per world (name · owner_code · world_id · last_seen + an
#  online dot). Clicking a row emits world_visit_requested(world_id) UP to the
#  Hud shell, which relays it out as the contract `world_visit_requested` signal
#  for B to act on (load that world read-only).
#
#  Pure view. The shell feeds it A's GET /worlds payload via show_worlds(payload)
#  and toggles visibility via open()/close(). It owns NO sidecar comms — the
#  actual /worlds GET and the read-only visit load are B's bridge (the shell
#  relays worlds_requested() out for B to fetch, and world_visit_requested(id)
#  for B to load). Graceful loading + empty states. Theme ONLY via SummerUI,
#  motion ONLY via Juice, sound ONLY via UiSounds. Null-safe on every field —
#  A's WorldSummary is loose JSON.
#
#  Consumes A's contract:
#    GET /worlds -> { you, you_owner_code, worlds: WorldSummary[] }
#    WorldSummary = { world_id, owner_code, name, agent_count, last_seen (ISO), online (bool) }
# ============================================================================

# A world row was clicked → shell relays the contract world_visit_requested(world_id).
signal world_visit_requested(world_id: String)
# The browser was dismissed (close button / backdrop). Shell may restore chrome.
signal closed()

# Built nodes.
var _backdrop: ColorRect            # dim scrim behind the panel; click = close
var _panel: PanelContainer          # the frosted card
var _title: Label
var _you_label: Label               # "you · <owner_code>" identity line
var _list: VBoxContainer            # the world-row column (inside a ScrollContainer)
var _status: Label                  # loading / empty state line (shown when no rows)

# State mirrors (reused; rows are upserted in place, never blanket-rebuilt, so a
# refresh that returns the same set keeps scroll position and fires no churn).
var _rows: Dictionary = {}          # world_id -> row-refs Dictionary
var _order: Array[String] = []      # current render order (world_ids), feed order
var _loaded := false                # has show_worlds() been called at least once?

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE  # hidden by default; shell toggles visible
	set_anchors_preset(Control.PRESET_FULL_RECT)
	visible = false

	# Backdrop scrim — eats clicks so the world behind doesn't react, and a click on it
	# closes the browser (a familiar dismiss affordance). Drawn behind the panel.
	_backdrop = ColorRect.new()
	_backdrop.color = Color(0, 0, 0, 0.45)
	_backdrop.set_anchors_preset(Control.PRESET_FULL_RECT)
	_backdrop.mouse_filter = Control.MOUSE_FILTER_STOP
	_backdrop.gui_input.connect(_on_backdrop_input)
	add_child(_backdrop)

	# The frosted card, centered, sized as a responsive fraction band of the viewport.
	_panel = PanelContainer.new()
	_panel.mouse_filter = Control.MOUSE_FILTER_STOP
	_panel.set_anchors_preset(Control.PRESET_CENTER)
	_panel.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_panel.grow_vertical = Control.GROW_DIRECTION_BOTH
	add_child(_panel)
	# FROST recipe step 1: a blurred FrostRect becomes the backmost child; the panel
	# stylebox drops to transparent so the fill is frosted glass with the shader's AA rim.
	SummerUI.attach_frost(_panel, SummerUI.BG_GLASS, SummerUI.RADIUS)

	var m := MarginContainer.new()
	for side in ["left", "right", "top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, 18)
	_panel.add_child(m)

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 12)
	m.add_child(col)

	# Header row: title + identity on the left, a close ✗ on the right.
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 10)
	col.add_child(head)

	var head_text := VBoxContainer.new()
	head_text.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head_text.add_theme_constant_override("separation", 2)
	head.add_child(head_text)
	_title = _label("VISIT A WORLD", SummerUI.FS_TITLE, SummerUI.TEXT)
	head_text.add_child(_title)
	_you_label = _label("", SummerUI.FS_LABEL, SummerUI.TEXT_DIM)
	_you_label.clip_text = true
	head_text.add_child(_you_label)

	var close_btn := Button.new()
	# Tofu guard (mirrors fleet_roster's approve ✓): a bundled UI TTF likely lacks ✗, which
	# would render a tofu box on the projector. Use "Close" when a custom font is active; the
	# engine default font carries the glyph, so ✗ reads when none is bundled.
	close_btn.text = "✕" if not SummerUI.has_custom_font() else "Close"
	close_btn.tooltip_text = "Close"
	close_btn.focus_mode = Control.FOCUS_NONE
	close_btn.mouse_filter = Control.MOUSE_FILTER_STOP
	close_btn.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	SummerUI.ghost_button(close_btn)
	close_btn.pressed.connect(_on_close)
	close_btn.mouse_entered.connect(func(): UiSounds.play("hover"))
	head.add_child(close_btn)

	# Hairline divider under the header (a faint glass pill, 1px tall).
	var rule := PanelContainer.new()
	rule.custom_minimum_size = Vector2(0, 1)
	rule.add_theme_stylebox_override("panel", SummerUI.sb(SummerUI.BORDER, 0))
	col.add_child(rule)

	# The world-row column inside a vertical scroll so a long world list never breaks layout.
	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	col.add_child(scroll)

	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 8)
	_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_list)

	# Loading / empty state. Lives in the column; centered, hidden once rows exist.
	_status = _label("Loading worlds…", SummerUI.FS_LABEL, SummerUI.TEXT_FAINT)
	_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_status.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_status.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_status.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(_status)

	# Relayout responsively (portrait phone ↔ wide projector).
	var vp := get_viewport()
	if vp != null and not vp.size_changed.is_connected(_relayout):
		vp.size_changed.connect(_relayout)
	_relayout()

# ── Shell API (methods the Hud shell calls down) ────────────────────────────

# Open the browser. Shows a loading state until show_worlds() lands; the shell should
# emit worlds_requested() (relayed for B's /worlds fetch) right after calling this.
func open() -> void:
	if visible:
		return
	visible = true
	mouse_filter = Control.MOUSE_FILTER_STOP
	# If we've never been fed, show the loading line; if we have a cached list, keep it.
	if not _loaded:
		_status.text = "Loading worlds…"
		_status.visible = true
	UiSounds.play("panel_open")
	Juice.pop(_panel)

# Close the browser (silent on `closed` — the explicit dismiss path emits it).
func close() -> void:
	if not visible:
		return
	visible = false
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	UiSounds.play("panel_close")

# Feed A's GET /worlds payload (or a bare WorldSummary[] array). Upserts rows in place,
# drops rows for worlds no longer present, reorders to match the feed. Null-safe on every
# nullable field — A's WorldSummary is loose JSON.
func show_worlds(payload) -> void:
	_loaded = true
	var worlds = payload
	var you := ""
	var you_owner := ""
	if payload is Dictionary:
		worlds = payload.get("worlds", [])
		you = SummerUI.s(payload.get("you"))
		you_owner = SummerUI.s(payload.get("you_owner_code"))
	if not (worlds is Array):
		worlds = []

	# Identity line: "you · <owner_code>" so the player knows whose roster this is.
	if you != "" or you_owner != "":
		var who := you if you != "" else "you"
		_you_label.text = "%s · %s" % [who, you_owner] if you_owner != "" else who
		_you_label.visible = true
	else:
		_you_label.visible = false

	var seen := {}
	_order.clear()
	for w in worlds:
		if not (w is Dictionary):
			continue
		var wid := SummerUI.s(w.get("world_id"))
		if wid == "":
			continue
		_order.append(wid)
		seen[wid] = true
		_upsert_row(w, wid)

	# Drop rows for worlds no longer present.
	for wid in _rows.keys():
		if not seen.has(wid):
			_rows[wid]["root"].queue_free()
			_rows.erase(wid)

	# Keep the column in feed order (move_child is allocation-free).
	for i in _order.size():
		var wid: String = _order[i]
		if _rows.has(wid):
			_list.move_child(_rows[wid]["root"], i)

	# Empty state: a successful fetch that returned zero worlds.
	if _rows.is_empty():
		_status.text = "No worlds online yet."
		_status.visible = true
	else:
		_status.visible = false

# True when the overlay is showing.
func is_open() -> bool:
	return visible

# ── Row upsert (in place — no flicker / no scroll loss) ─────────────────────

func _upsert_row(w: Dictionary, wid: String) -> void:
	if _rows.has(wid):
		_update_row(_rows[wid], w, wid)
	else:
		var refs := _make_row(wid)
		_rows[wid] = refs
		_list.add_child(refs["root"])
		_update_row(refs, w, wid, true)
		Juice.pop(refs["root"])

func _make_row(wid: String) -> Dictionary:
	var root := PanelContainer.new()
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	root.add_theme_stylebox_override("panel", SummerUI.sb(SummerUI.BG_CHIP, SummerUI.RADIUS_SM, SummerUI.BORDER, 1))
	root.gui_input.connect(func(e): _on_row_input(e, wid))
	root.mouse_entered.connect(func(): UiSounds.play("hover"))

	var m := MarginContainer.new()
	m.mouse_filter = Control.MOUSE_FILTER_IGNORE
	for side in ["left", "right"]:
		m.add_theme_constant_override("margin_" + side, 12)
	for side in ["top", "bottom"]:
		m.add_theme_constant_override("margin_" + side, 10)
	root.add_child(m)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	m.add_child(row)

	# Online dot — green when online, faint when offline.
	var dot := _label("●", 9, SummerUI.TEXT_FAINT)
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	row.add_child(dot)

	# Name + meta sub-line (owner_code · world_id · last_seen).
	var text_col := VBoxContainer.new()
	text_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	text_col.add_theme_constant_override("separation", 1)
	text_col.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(text_col)
	var name_lbl := _label("world", SummerUI.FS_BODY, SummerUI.TEXT)
	name_lbl.clip_text = true
	name_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	text_col.add_child(name_lbl)
	var sub := _label("", SummerUI.FS_LABEL, SummerUI.TEXT_DIM)
	sub.clip_text = true
	sub.mouse_filter = Control.MOUSE_FILTER_IGNORE
	text_col.add_child(sub)

	# A "Visit ↗" chip on the right so the row reads as an actionable destination.
	var visit := _label("Visit →", SummerUI.FS_LABEL, SummerUI.ACCENT_HI)
	visit.mouse_filter = Control.MOUSE_FILTER_IGNORE
	visit.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	row.add_child(visit)

	return {
		"root": root, "dot": dot, "name": name_lbl, "sub": sub,
		# Cached visual signature so a refresh that returns identical fields skips the
		# colour-override allocation (online state is binary).
		"_vis_online": -1,
	}

func _update_row(refs: Dictionary, w: Dictionary, wid: String, _seed := false) -> void:
	refs["name"].text = SummerUI.s(w.get("name"), wid)

	# Meta sub-line: owner_code · world_id · last_seen (relative), with agent_count.
	var owner := SummerUI.s(w.get("owner_code"))
	var last := _relative_time(SummerUI.s(w.get("last_seen")))
	var parts: Array[String] = []
	if owner != "":
		parts.append(owner)
	parts.append(wid)
	var n := int(w.get("agent_count", 0))
	if n > 0:
		parts.append("%d agent%s" % [n, "" if n == 1 else "s"])
	if last != "":
		parts.append(last)
	refs["sub"].text = "  ·  ".join(parts)

	# Online dot colour (binary) — restyle only when it flips.
	var online := 1 if bool(w.get("online", false)) else 0
	if online != int(refs.get("_vis_online", -1)):
		refs["_vis_online"] = online
		refs["dot"].add_theme_color_override("font_color", SummerUI.OK_GREEN if online == 1 else SummerUI.TEXT_FAINT)

# ── ISO8601 → a compact "x ago" string (null-safe; "" when unparseable) ──────
# A's last_seen is an ISO timestamp; we render it relative so the list reads at a glance.
# Time.get_unix_time_from_datetime_string parses ISO8601; on failure it returns 0, which
# we treat as unknown rather than 1970.
func _relative_time(iso: String) -> String:
	if iso.strip_edges() == "":
		return ""
	var then := Time.get_unix_time_from_datetime_string(iso)
	if then <= 0:
		return iso  # not parseable — show the raw stamp rather than a wrong "ago"
	var now := Time.get_unix_time_from_system()
	var d := int(now - then)
	if d < 0:
		d = 0
	if d < 60:
		return "just now"
	if d < 3600:
		var mins := d / 60
		return "%dm ago" % mins
	if d < 86400:
		var hrs := d / 3600
		return "%dh ago" % hrs
	var days := d / 86400
	return "%dd ago" % days

# ── Interaction ─────────────────────────────────────────────────────────────

func _on_row_input(event: InputEvent, wid: String) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		UiSounds.play("select")
		if _rows.has(wid):
			Juice.flash(_rows[wid]["root"], SummerUI.ACCENT)
		world_visit_requested.emit(wid)

func _on_backdrop_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		_on_close()

func _on_close() -> void:
	close()
	closed.emit()

# ── Responsive layout: a centered fraction band, clamped to a readable size ──
func _relayout() -> void:
	if _panel == null:
		return
	var vp := get_viewport()
	if vp == null:
		return
	var vps: Vector2 = vp.get_visible_rect().size
	if vps.x <= 0.0 or vps.y <= 0.0:
		return
	var w: float = clampf(vps.x * 0.5, 360.0, 640.0)
	w = minf(w, vps.x - 48.0)
	var h: float = clampf(vps.y * 0.7, 320.0, 760.0)
	h = minf(h, vps.y - 48.0)
	_panel.custom_minimum_size = Vector2(w, h)
	# Pin dead-center: anchors are 0.5/0.5 (PRESET_CENTER) so set the four offsets
	# to a half-size box straddling the anchor. Setting `size` alone leaves the
	# preset's zero-size offsets in place and the card grows from the anchor point
	# (off-center / toward bottom-right); the explicit offsets recenter it.
	_panel.offset_left = -w * 0.5
	_panel.offset_right = w * 0.5
	_panel.offset_top = -h * 0.5
	_panel.offset_bottom = h * 0.5

# ── Small builder helper (matches the codebase's programmatic style) ─────────
func _label(text: String, size: int, color: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	return l
