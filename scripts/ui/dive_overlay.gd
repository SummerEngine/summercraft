extends Control
# No class_name: scripts/ui is not in the editor's global class cache (load fix
# 82aa023), so a global class_name on this script would fail to resolve at load.
# The shell holds this instance UNTYPED and never uses it as a static type.
# Bind Juice/UiSounds by path (preload) for the same reason.
const Juice := preload("res://scripts/ui/juice.gd")
const UiSounds := preload("res://scripts/ui/ui_sounds.gd")
# ============================================================================
#  DiveOverlay — the first-person conversation surface (Chat D / The Interface).
#
#  THE signature moment's 2D half. When the player dives into an agent (B tilts
#  the camera to first-person, C opens the realtime voice), the command UI gives
#  way to this cinematic conversation overlay. It is the screenshot that wins the
#  pitch, so it carries real weight:
#    • CONTEXT RIBBON   — top: label · persona · branch · PR · current_task ·
#                         diff-stat (+N −M). Built from the frozen AgentView +
#                         AgentContext (branch/pr_url) so the player sees exactly
#                         what this agent is working on.
#    • CAPTION HISTORY  — bottom: a scrolling history of the last several caption
#                         lines (NOT just the latest), older lines fading back, so
#                         the conversation reads like a transcript, not a flash.
#    • SPEAKING VISUAL  — an animated visualiser that reacts while the agent talks
#                         (driven by set_speaking); idles when quiet.
#    • CINEMATIC VIGNETTE — dark top/bottom gradients + edge vignette so the world
#                         behind it depth-blurs into a stage. No shader required.
#    • SMOOTH ENTER/EXIT — fades + eases in on enter(), reverses on exit(); pairs
#                         with UiSounds dive_in / dive_out and B's camera tween.
#
#  Pure view. The shell drives it via the methods below (fed from the frozen
#  /world AgentView + C's AgentContext + the WS relay caption/speaking events).
#  It emits ONE intent up: the on-screen Leave button. No sidecar comms.
#
#  Production: anchored full-rect (portrait + projector), caption history capped
#  (ring, no unbounded growth → zero per-frame allocation creep), graceful with
#  missing context (nullable branch/PR/task all hidden cleanly), Juice on enter/
#  exit/speaking, UiSounds at the dive + caption + leave sites, big legible type.
# ============================================================================

# ── Signals up to the shell ─────────────────────────────────────────────────
# The on-screen "✕ Leave" button was pressed → shell emits dive_exit_requested /
# calls Hud.exit_dive() and B reverses the camera.
signal exit_requested(agent_id: String)

# Caption history cap (older lines drop off; keeps allocations bounded + readable).
const CAPTION_HISTORY := 8

# ── Layout constants (anchors + offsets, not magic per-frame math) ──────────
const RIBBON_MARGIN := 28        # inset of the context ribbon from screen edges
const CAPTION_MARGIN := 28       # inset of the caption column from screen edges
const CHAT_MAX_W := 960.0        # the conversation reads in a centered column, not full width
const VIGNETTE_BAND := 0.0       # cinematic bands removed (D1) — no band in layout math
const SHOW_RIBBON := false       # D4: ribbon (label/persona/meta/state) built but dormant; NPC visible through chrome-free overlay
const VIS_BARS := 5              # speaking-visualiser bar count
const VIS_BAR_W := 7
const VIS_BAR_GAP := 6
const VIS_HEIGHT := 34
const ENTER_TIME := 0.40
const EXIT_TIME := 0.30
const CAPTION_FADE_TIME := 0.28
const VIS_PULSE_TIME := 0.34
const VIS_IDLE_TIME := 2.2        # slow idle breath cycle (low-amplitude, never frozen)
const LEAVE_BAND := 64            # vertical band reserved bottom-right for the Leave button

# ── Built nodes ─────────────────────────────────────────────────────────────
var _content: Control               # everything that fades together on enter/exit
# D1/D2: _vignette_top/_vignette_bottom (cinematic bands) and _edge (border frame) removed.
var _ribbon_panel: PanelContainer   # the glass plate behind the ribbon (D4: built only when SHOW_RIBBON)
var _ribbon: HBoxContainer          # the context ribbon row
var _kind_dot: Panel                # character-kind colour dot
var _label_node: Label              # agent label
var _persona: Label                 # persona / repo sub-line
var _state_box: HBoxContainer        # soft state indicator (dot + light label), not a bold pill
var _state_dot: Panel               # small colour dot — THE state indicator
var _state_dot_box: StyleBoxFlat = null   # reused; recoloured in place (no per-poll alloc)
var _state_label: Label             # state label in light text (state_palette fg / TEXT_DIM)
var _caption_panel: PanelContainer  # frosted band behind the caption history (legibility)
var _meta: RichTextLabel            # branch · PR · task · diff-stat, dim
var _vis_panel: PanelContainer      # speaking visualiser plate (right of ribbon)
var _vis_row: HBoxContainer         # the animated bars container
var _vis_bars: Array[Panel] = []    # reused bar nodes (no per-frame alloc)
var _captions: VBoxContainer        # caption history (newest at bottom)
var _caption_labels: Array[Label] = []  # reused label pool, sized to CAPTION_HISTORY
var _leave: Button
var _copy: Button                    # copies the caption history (the conversation) to the clipboard

# ── State ───────────────────────────────────────────────────────────────────
var _agent_id: String = ""
var _kind: String = ""
var _last_state := ""                    # last AgentView.state (gate state-change juice/sound)
var _caption_lines: Array[String] = []  # ring of recent caption text (oldest→newest)
var _speaking := false
var _vis_tween: Tween = null             # looping visualiser pulse (killed on off/exit)
var _io_tween: Tween = null              # enter/exit fade tween (killed before re-issue)
var _kind_dot_box: StyleBoxFlat = null   # reused; recoloured in place (no per-poll alloc)
var _last_meta := ""                     # last meta BBCode (skip redundant RichText reflow)
var _io_target := 1.0                    # current intent for the io fade (1.0 = entering, 0.0 = exiting)
var _popped_label: Label = null          # label with an in-flight caption pop (its alpha tween)
var _reveal_tween: Tween = null          # D5: typewriter reveal of the newest caption (visible_characters)
var _revealing_label: Label = null       # the label whose text is mid-reveal (snapped to full on the next push)

# ============================================================================
#  Construction
# ============================================================================
func _ready() -> void:
	# Full-rect, click-through where nothing interactive sits (the Leave button
	# re-enables hits on itself). Start hidden + transparent so the first enter()
	# fades cleanly in.
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	visible = false
	modulate.a = 0.0

	_build_vignette()
	_build_content()
	_seed_caption_pool()
	# Do NOT start the idle breath here: the overlay is hidden until the first
	# enter(), and a looping method-tween would burn a per-frame callback on 5 bars
	# for the entire pre-dive lifetime. enter() starts the breath once shown; leave
	# the bars at a static floor until then.
	_set_bars_phase(0.0)

# The overlay stage. D1/D2: the cinematic top/bottom dark bands and the full-rect
# edge/border frame are GONE — the player sees the NPC + the streamed conversation
# with no chrome. Only the fade-together _content container survives here.
func _build_vignette() -> void:
	_content = Control.new()
	_content.name = "Content"
	_content.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_content.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(_content)

# The ribbon (top) + speaking visualiser + caption history (bottom) + Leave.
func _build_content() -> void:
	# D4: the context ribbon (label/persona/meta/state + visualiser) is built ONLY
	# when SHOW_RIBBON. With it off the player sees the 3D NPC through a chrome-free
	# overlay and just the streamed captions. The ribbon nodes stay null; every
	# writer (_apply_state/_apply_label/_apply_context/visualiser) is null-safe.
	if SHOW_RIBBON:
		_build_ribbon()
	_build_captions_and_leave()

# The (now dormant by default) context ribbon: kind-dot + title column + meta line
# + soft state indicator + speaking visualiser. Code kept intact; only constructed
# when SHOW_RIBBON is true (D4).
func _build_ribbon() -> void:
	# ---- Context ribbon -----------------------------------------------------
	# Anchored to the top edge, full width minus margins. A glass plate hosts the
	# kind-dot + title column + meta line, with the visualiser pinned to its right.
	_ribbon_panel = PanelContainer.new()
	_ribbon_panel.name = "RibbonPanel"
	_ribbon_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Centered to the same reading column as the chat (agent header sits above it).
	_ribbon_panel.anchor_left = 0.5
	_ribbon_panel.anchor_right = 0.5
	_ribbon_panel.anchor_top = 0.0
	_ribbon_panel.anchor_bottom = 0.0
	_ribbon_panel.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_ribbon_panel.offset_left = -CHAT_MAX_W * 0.5
	_ribbon_panel.offset_right = CHAT_MAX_W * 0.5
	_ribbon_panel.offset_top = RIBBON_MARGIN
	_content.add_child(_ribbon_panel)
	# Frosted glass plate: a blurred FrostRect backmost + a hairline border edge
	# (the recipe). Radius matches the cards (~16); inner padding via the frost pad.
	SummerUI.attach_frost(_ribbon_panel, SummerUI.BG_GLASS, 16, 16, true)

	_ribbon = HBoxContainer.new()
	_ribbon.name = "Ribbon"
	_ribbon.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_ribbon.add_theme_constant_override("separation", 16)
	_ribbon_panel.add_child(_ribbon)

	# Kind dot — a small rounded square tinted by character_kind.
	_kind_dot = Panel.new()
	_kind_dot.name = "KindDot"
	_kind_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_kind_dot.custom_minimum_size = Vector2(16, 16)
	_kind_dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_apply_kind_dot("")
	_ribbon.add_child(_kind_dot)

	# Title column: big label + persona/repo sub-line.
	var title_col := VBoxContainer.new()
	title_col.name = "TitleCol"
	title_col.mouse_filter = Control.MOUSE_FILTER_IGNORE
	title_col.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	title_col.add_theme_constant_override("separation", 2)
	_ribbon.add_child(title_col)

	_label_node = Label.new()
	_label_node.name = "AgentLabel"
	_label_node.add_theme_font_size_override("font_size", 26)
	_label_node.add_theme_color_override("font_color", SummerUI.TEXT)
	_label_node.text = "—"
	title_col.add_child(_label_node)

	_persona = Label.new()
	_persona.name = "Persona"
	_persona.add_theme_font_size_override("font_size", 15)
	_persona.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	_persona.text = ""
	title_col.add_child(_persona)

	# Meta line: branch · PR · task · diff-stat. RichText so we can colour the
	# +N −M stat inline (DIFF_ADD / DIFF_DEL) and dim the separators.
	_meta = RichTextLabel.new()
	_meta.name = "Meta"
	_meta.bbcode_enabled = true
	_meta.fit_content = true
	_meta.scroll_active = false
	_meta.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Wrap within the ribbon at narrow widths (portrait ~664px usable) so a long
	# branch·PR·task·diff line never clips/overflows the panel + screen edge. The
	# RichTextLabel is fit_content, so the ribbon panel grows to fit the wrapped line.
	_meta.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_meta.add_theme_font_size_override("normal_font_size", 15)
	_meta.add_theme_color_override("default_color", SummerUI.TEXT_FAINT)
	_meta.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_meta.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_meta.text = ""
	title_col.add_child(_meta)

	# ---- Soft state indicator (between the title column and the visualiser) -
	# A small ~7px colour dot (state_palette["dot"]) + the state label in LIGHT
	# text — understated, not a saturated block. The dot is the indicator. Reads
	# WORKING / REVIEW / BLOCKED / MOVING / IDLE across a room. Recoloured in place.
	_state_box = HBoxContainer.new()
	_state_box.name = "StateBox"
	_state_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_state_box.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_state_box.add_theme_constant_override("separation", 7)
	_state_box.visible = false
	_ribbon.add_child(_state_box)

	_state_dot = Panel.new()
	_state_dot.name = "StateDot"
	_state_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_state_dot.custom_minimum_size = Vector2(7, 7)
	_state_dot.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_state_dot_box = StyleBoxFlat.new()
	_state_dot_box.set_corner_radius_all(4)
	_state_dot_box.bg_color = SummerUI.state_palette("").get("dot") as Color
	_state_dot.add_theme_stylebox_override("panel", _state_dot_box)
	_state_box.add_child(_state_dot)

	_state_label = Label.new()
	_state_label.name = "StateLabel"
	_state_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_state_label.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_state_label.add_theme_font_size_override("font_size", 14)
	_state_label.add_theme_color_override("font_color", SummerUI.state_palette("").get("fg") as Color)
	_state_label.text = ""
	_state_box.add_child(_state_label)

	# ---- Speaking visualiser (right of the title column) -------------------
	_vis_panel = PanelContainer.new()
	_vis_panel.name = "VisPanel"
	_vis_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_vis_panel.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_ribbon.add_child(_vis_panel)
	# Nested/secondary surface → soft frost tint (the recipe). Frost pad mirrors the
	# old pill padding so the bars keep their breathing room.
	SummerUI.attach_frost(_vis_panel, SummerUI.BG_GLASS_SOFT, 12, 8, false)

	_vis_row = HBoxContainer.new()
	_vis_row.name = "VisRow"
	_vis_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_vis_row.alignment = BoxContainer.ALIGNMENT_CENTER
	_vis_row.add_theme_constant_override("separation", VIS_BAR_GAP)
	_vis_panel.add_child(_vis_row)

	for i in VIS_BARS:
		var bar := Panel.new()
		bar.name = "Bar%d" % i
		bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
		bar.custom_minimum_size = Vector2(VIS_BAR_W, VIS_HEIGHT)
		bar.size_flags_vertical = Control.SIZE_SHRINK_CENTER
		bar.pivot_offset = Vector2(VIS_BAR_W * 0.5, VIS_HEIGHT * 0.5)
		var bar_box := StyleBoxFlat.new()
		bar_box.bg_color = SummerUI.ACCENT
		bar_box.set_corner_radius_all(int(VIS_BAR_W * 0.5))
		bar.add_theme_stylebox_override("panel", bar_box)
		_vis_row.add_child(bar)
		_vis_bars.append(bar)

# Caption history (bottom) + Leave button. Always built — this is the conversation
# surface that survives the chrome strip (D1/D2/D4).
func _build_captions_and_leave() -> void:
	# ---- Caption history (bottom) ------------------------------------------
	# Anchored to the bottom, growing upward; newest line at the bottom, older
	# lines above and faded. A reused label pool keeps allocations flat. The whole
	# column sits inside a frosted band so captions stay highly legible over any 3D
	# bg — a DENSER frost tint than the ribbon (the recipe: dense behind captions),
	# layered over the cinematic vignette. PanelContainer hugs its content, so the
	# band only covers the lines actually showing (anchored bottom, grows upward).
	_caption_panel = PanelContainer.new()
	_caption_panel.name = "CaptionPanel"
	_caption_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Bottom-anchored and grows UPWARD: a PanelContainer hugs its child's min height,
	# so with grow_vertical=BEGIN the frost band only spans the caption lines actually
	# showing (one line = a thin band; six = a taller one), never the whole lower half.
	# Centered, capped to a comfortable reading width — never the full screen.
	_caption_panel.anchor_left = 0.5
	_caption_panel.anchor_right = 0.5
	_caption_panel.anchor_top = 1.0
	_caption_panel.anchor_bottom = 1.0
	_caption_panel.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_caption_panel.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_caption_panel.offset_left = -CHAT_MAX_W * 0.5
	_caption_panel.offset_right = CHAT_MAX_W * 0.5
	# Reserve a bottom band for the Leave button so captions never sit under it.
	# Derived from LEAVE_BAND (the button's vertical band), not a bare magic number.
	_caption_panel.offset_bottom = -(CAPTION_MARGIN + LEAVE_BAND)
	_content.add_child(_caption_panel)
	# Denser tint behind the caption band for legibility (BG_SOLID = the densest
	# frost token); frost pad gives the lines breathing room inside the band.
	SummerUI.attach_frost(_caption_panel, SummerUI.BG_SOLID, 16, 16, false)

	# D3: side padding for the caption column. A MarginContainer (~32px L/R) wraps
	# the VBox so the lines never hug the centered column's edges. Survives the
	# CHAT_MAX_W centering better than bumping the frost pad.
	var caption_margin := MarginContainer.new()
	caption_margin.name = "CaptionMargin"
	caption_margin.mouse_filter = Control.MOUSE_FILTER_IGNORE
	caption_margin.add_theme_constant_override("margin_left", 48)
	caption_margin.add_theme_constant_override("margin_right", 48)
	caption_margin.add_theme_constant_override("margin_top", 24)
	caption_margin.add_theme_constant_override("margin_bottom", 24)
	_caption_panel.add_child(caption_margin)

	_captions = VBoxContainer.new()
	_captions.name = "Captions"
	_captions.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_captions.alignment = BoxContainer.ALIGNMENT_END
	_captions.add_theme_constant_override("separation", 10)
	caption_margin.add_child(_captions)

	# ---- Leave button (bottom-right) ---------------------------------------
	# Hosted in a bottom-right anchored MarginContainer; the button sizes to its
	# own content (SHRINK_END) instead of a fixed -180px left offset, so a longer
	# localized label ("✕ Leave") grows leftward and never clips its own text.
	var leave_holder := MarginContainer.new()
	leave_holder.name = "LeaveHolder"
	leave_holder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	leave_holder.anchor_left = 0.0
	leave_holder.anchor_right = 1.0
	leave_holder.anchor_top = 1.0
	leave_holder.anchor_bottom = 1.0
	leave_holder.offset_top = -(LEAVE_BAND + CAPTION_MARGIN)
	leave_holder.offset_left = CAPTION_MARGIN
	leave_holder.offset_right = -CAPTION_MARGIN
	leave_holder.offset_bottom = -CAPTION_MARGIN
	_content.add_child(leave_holder)

	# A bottom-right cluster: [⧉ Copy] (ghost) · [✕ Leave] (ghost). An HBox keeps both
	# hugging the right edge (SHRINK_END) so a longer localized label grows leftward.
	var btn_row := HBoxContainer.new()
	btn_row.name = "BottomButtons"
	btn_row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	btn_row.alignment = BoxContainer.ALIGNMENT_END
	btn_row.add_theme_constant_override("separation", 12)
	btn_row.size_flags_horizontal = Control.SIZE_SHRINK_END
	btn_row.size_flags_vertical = Control.SIZE_SHRINK_END
	leave_holder.add_child(btn_row)

	_copy = Button.new()
	_copy.name = "CopyButton"
	_copy.text = "⧉  Copy"
	_copy.focus_mode = Control.FOCUS_NONE
	_copy.mouse_filter = Control.MOUSE_FILTER_STOP
	_copy.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	_copy.tooltip_text = "Copy the conversation to the clipboard"
	_copy.add_theme_font_size_override("font_size", 17)
	SummerUI.ghost_button(_copy)
	_copy.pressed.connect(_on_copy_pressed)
	_copy.mouse_entered.connect(func() -> void: UiSounds.play("hover"))
	btn_row.add_child(_copy)

	_leave = Button.new()
	_leave.name = "LeaveButton"
	_leave.text = "✕  Leave"
	_leave.focus_mode = Control.FOCUS_NONE
	_leave.mouse_filter = Control.MOUSE_FILTER_STOP
	_leave.add_theme_font_size_override("font_size", 17)
	SummerUI.ghost_button(_leave)
	_leave.size_flags_horizontal = Control.SIZE_SHRINK_END
	_leave.size_flags_vertical = Control.SIZE_SHRINK_END
	_leave.pressed.connect(_on_leave_pressed)
	_leave.mouse_entered.connect(func() -> void: UiSounds.play("hover"))
	btn_row.add_child(_leave)

# Build the reusable caption-label pool once (sized to the ring). We never add /
# free labels at runtime — we relabel + retint them, so there are zero per-poll
# allocations and no layout thrash.
func _seed_caption_pool() -> void:
	for i in CAPTION_HISTORY:
		var lbl := Label.new()
		lbl.name = "Caption%d" % i
		lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
		lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
		lbl.add_theme_font_size_override("font_size", 30)
		lbl.add_theme_color_override("font_color", SummerUI.TEXT)
		# Legible across a room: a dark outline so captions read over any 3D bg.
		lbl.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.85))
		lbl.add_theme_constant_override("outline_size", 6)
		lbl.visible = false
		_captions.add_child(lbl)
		_caption_labels.append(lbl)

# ============================================================================
#  Shell API (methods the Hud shell calls down)
# ============================================================================

# Begin the dive for an agent. `view` is the frozen AgentView (label/persona/
# repo/task/state); `context` is C's AgentContext fields (branch / base_branch /
# pr_url / diff stat) when available — both null-safe / partial-safe. Fades+eases
# the overlay in (Juice), clears caption history, plays UiSounds "dive_in".
func enter(agent_id: String, view: Dictionary, context: Dictionary = {}) -> void:
	_agent_id = SummerUI.s(agent_id)
	_last_state = ""  # first _apply_state paints silently (no spurious cheer/slam on dive-in)
	_clear_captions()
	_apply_context(view, context)

	visible = true
	mouse_filter = Control.MOUSE_FILTER_STOP  # eat clicks behind the overlay while diving

	UiSounds.play("dive_in")
	_play_io_tween(1.0, ENTER_TIME, true)
	_refresh_visualiser_idle()

# End the dive. Reverses the enter tween, stops the speaking visualiser, plays
# UiSounds "dive_out". The shell hides the overlay after the tween completes.
func exit() -> void:
	set_speaking(false)
	UiSounds.play("dive_out")
	_play_io_tween(0.0, EXIT_TIME, false)

# Push a new caption line into the history (from the WS relay `caption` event,
# routed through the shell). Appends, drops the oldest past CAPTION_HISTORY,
# fades the newest in, plays a subtle UiSounds "caption_tick". Empty => no-op.
func push_caption(text: String) -> void:
	var line := SummerUI.s(text).strip_edges()
	if line == "":
		return
	# Ring discipline: append, trim the front past the cap. Bounded array; no
	# unbounded growth on a long conversation.
	_caption_lines.append(line)
	while _caption_lines.size() > CAPTION_HISTORY:
		_caption_lines.pop_front()
	# Kill the prior line's in-flight pop BEFORE _render_captions reassigns alphas.
	# Otherwise that label (now age 1) gets a=0.83 from _render_captions while its
	# still-running pop tween drives modulate.a back toward 1.0 → flicker. After the
	# stop, _render_captions' age-based alpha is the final word for every older line.
	_stop_caption_pop()
	# D5: snap any prior in-flight typewriter reveal to full BEFORE _render_captions
	# reassigns text — the previous newest line becomes an older, fully-shown line.
	_stop_caption_reveal()
	_render_captions()
	UiSounds.play("caption_tick")
	# Pop ONLY the newest line in (scale + modulate.a to 1.0, NOT ring-alpha sync).
	# These labels are children of a VBoxContainer, so we must NOT animate `position`
	# (slide_in) — the container re-sorts every layout pass and would fight/flicker
	# the tween. Juice.pop is layout-safe (scale around a centered pivot + modulate.a).
	var newest := _newest_caption_label()
	if newest != null:
		Juice.pop(newest, CAPTION_FADE_TIME)
		_popped_label = newest
		# D5: typewriter reveal — upstream sends one full line per turn, so simulate
		# streaming client-side by animating visible_characters 0→full. Older lines
		# stay fully shown (only the newest reveals). No position animation (the VBox
		# re-sorts). Instant under reduced motion.
		_reveal_newest(newest, line.length())

# Toggle the speaking visualiser (from the WS relay `speaking` event). Animates
# while on, idles when off. Allocation-light looping tween, killed on off/exit.
func set_speaking(on: bool) -> void:
	if on == _speaking:
		return
	_speaking = on
	if _speaking:
		_start_visualiser()
	else:
		_refresh_visualiser_idle()

# Refresh just the context ribbon mid-dive (e.g. AgentContext arrives after the
# dive started, or the task/branch changes on a poll). Null-safe / partial-safe.
func update_context(view: Dictionary, context: Dictionary = {}) -> void:
	_apply_context(view, context)

# The agent currently being dived into ("" if not in a dive).
func agent_id() -> String:
	return _agent_id

# ============================================================================
#  Internals
# ============================================================================

# Paint the ribbon from the frozen AgentView + AgentContext. Every nullable field
# is routed through SummerUI.s() so a missing branch / PR / task is simply hidden,
# never "null". Builds the meta line as BBCode so the diff-stat colours inline.
func _apply_context(view: Dictionary, context: Dictionary) -> void:
	# D4: null-safe when the ribbon is dormant (SHOW_RIBBON=false) — no nodes to
	# paint, so the whole ribbon paint is a no-op.
	if _ribbon_panel == null or _label_node == null:
		return
	var label := SummerUI.s(view.get("label"), "")
	if label == "":
		label = SummerUI.s(view.get("agent_id"), "Agent")
	_label_node.text = label

	_kind = SummerUI.s(view.get("character_kind"), "")
	_apply_kind_dot(_kind)

	# State: paint the pill every time, and on a *real* transition (not the first
	# paint of this dive) fire the matching Juice beat + UiSounds event on the
	# ribbon — this is the one surface that most prominently shows agent state, so
	# done/blocked/working land here in real time on the ~1s poll.
	_apply_state(SummerUI.s(view.get("state"), ""))

	# Persona / repo sub-line: prefer status_line, fall back to repo path's tail.
	var persona := SummerUI.s(view.get("status_line"), "")
	if persona == "":
		var repo := SummerUI.s(view.get("repo_path"), SummerUI.s(view.get("repo_id"), ""))
		persona = repo.get_file() if repo != "" else ""
	_persona.text = persona
	_persona.visible = persona != ""

	# Only re-set the meta BBCode when it actually changed — setting RichTextLabel.text
	# forces a reflow, and update_context() runs on the ~1s poll where the ribbon is
	# usually unchanged.
	var meta := _build_meta_bbcode(view, context)
	if meta != _last_meta:
		_last_meta = meta
		_meta.text = meta

# Paint the state pill and, on a real transition, fire the paired Juice + UiSounds
# beat. `_last_state == ""` means this is the first paint of the dive (set in
# enter()) — we paint but stay silent so diving onto an already-working agent does
# not spuriously cheer/slam. Recolours the pill StyleBox in place (no alloc).
func _apply_state(state: String) -> void:
	# D4: null-safe when the ribbon is dormant — no state box/label/dot to paint.
	if _state_box == null:
		return
	var pal := SummerUI.state_palette(state)
	if state == "":
		_state_box.visible = false
	else:
		_state_box.visible = true
		_state_label.text = SummerUI.s(pal.get("label"), state.to_upper())
		# Light label (desaturated fg), small colour dot = the indicator. No bold pill.
		_state_label.add_theme_color_override("font_color", pal.get("fg", SummerUI.TEXT_DIM) as Color)
		if _state_dot_box != null:
			_state_dot_box.bg_color = pal.get("dot", SummerUI.TEXT_FAINT) as Color

	if state == _last_state:
		return
	var first := _last_state == ""
	_last_state = state
	if first or state == "":
		return  # first paint of the dive (or cleared) — no transition beat
	match state:
		"done":
			Juice.done_cheer(_ribbon_panel)
			UiSounds.play("done_cheer")
		"blocked":
			Juice.lock_slam(_ribbon_panel)
			UiSounds.play("blocked")
		"working":
			Juice.pulse(_ribbon_panel)
			UiSounds.play("state_working")

# Compose "branch · PR · task · +N −M", hiding any segment whose source is null/
# empty. The diff-stat is coloured; separators are dimmed.
func _build_meta_bbcode(view: Dictionary, context: Dictionary) -> String:
	var segs: Array[String] = []

	var branch := SummerUI.s(context.get("branch"), "")
	if branch != "":
		segs.append("[color=#%s]⎇ %s[/color]" % [SummerUI.BLUE_HI.to_html(false), _esc(branch)])

	var pr := SummerUI.s(context.get("pr_url"), "")
	if pr != "":
		segs.append("[color=#%s]PR %s[/color]" % [SummerUI.ACCENT.to_html(false), _esc(_pr_short(pr))])

	var task := SummerUI.s(view.get("current_task"), "")
	if task != "":
		segs.append("[color=#%s]%s[/color]" % [SummerUI.TEXT_DIM.to_html(false), _esc(task)])

	var stat := _diff_stat(context)
	if stat.x > 0 or stat.y > 0:
		segs.append("[color=#%s]+%d[/color] [color=#%s]−%d[/color]" % [
			SummerUI.DIFF_ADD.to_html(false), stat.x,
			SummerUI.DIFF_DEL.to_html(false), stat.y])

	if segs.is_empty():
		return "[color=#%s]no context yet[/color]" % SummerUI.TEXT_FAINT.to_html(false)

	var sep := " [color=#%s]·[/color] " % SummerUI.TEXT_FAINT.to_html(false)
	return sep.join(segs)

# Extract +adds / −dels from AgentContext. Accepts explicit adds and/or dels keys
# (a missing one defaults to 0) or a raw unified-diff string under "diff" (counted
# by leading +/-, ignoring the ++/-- file headers). Returns Vector2i(adds, dels).
func _diff_stat(context: Dictionary) -> Vector2i:
	if context.has("adds") or context.has("dels"):
		return Vector2i(int(context.get("adds", 0)), int(context.get("dels", 0)))
	var raw := SummerUI.s(context.get("diff"), "")
	if raw == "":
		return Vector2i.ZERO
	var adds := 0
	var dels := 0
	for ln in raw.split("\n", false):
		if ln.begins_with("+") and not ln.begins_with("+++"):
			adds += 1
		elif ln.begins_with("-") and not ln.begins_with("---"):
			dels += 1
	return Vector2i(adds, dels)

# Tint the kind dot from character_kind (falls back to the neutral SummerUI tint).
# The StyleBoxFlat is built once and recoloured in place so a poll-driven
# update_context() costs zero allocations.
func _apply_kind_dot(kind: String) -> void:
	if _kind_dot_box == null:
		_kind_dot_box = StyleBoxFlat.new()
		_kind_dot_box.set_corner_radius_all(5)
		_kind_dot.add_theme_stylebox_override("panel", _kind_dot_box)
	_kind_dot_box.bg_color = SummerUI.kind_color(kind)

# Render the caption ring into the reused label pool. Newest at the bottom; older
# lines above with progressively lower alpha so the latest reads loudest. Upsert
# in place (relabel + retint), never rebuild — zero per-frame allocations.
func _render_captions() -> void:
	var n := _caption_lines.size()
	for i in CAPTION_HISTORY:
		var lbl := _caption_labels[i]
		# Pool index i counts from the TOP; map so the newest line lands at the
		# bottom-most used label.
		var line_idx := i - (CAPTION_HISTORY - n)
		if line_idx < 0 or line_idx >= n:
			lbl.visible = false
			lbl.text = ""
			continue
		lbl.text = _caption_lines[line_idx]
		lbl.visible = true
		# Fade older lines: newest (line_idx == n-1) full, each older a step dimmer.
		var age := (n - 1) - line_idx  # 0 = newest
		var a := clampf(1.0 - age * 0.17, 0.34, 1.0)
		lbl.modulate.a = a

# The bottom-most currently-visible caption label (the newest line), or null.
func _newest_caption_label() -> Label:
	for i in range(CAPTION_HISTORY - 1, -1, -1):
		if _caption_labels[i].visible:
			return _caption_labels[i]
	return null

# Stop the in-flight caption pop on the previously-popped label so _render_captions'
# age-based alpha wins. Juice.pop drives BOTH scale and modulate.a on a SINGLE tween
# stored under "_juice_tw_scale" (it never writes "_juice_tw_mod" — that slot is
# flash()'s), so killing that one slot stops the whole pop. Reset scale to ONE so a
# half-popped label that just aged out never lingers shrunk. Null/invalid-safe.
func _stop_caption_pop() -> void:
	if _popped_label == null or not is_instance_valid(_popped_label):
		_popped_label = null
		return
	if _popped_label.has_meta("_juice_tw_scale"):
		Juice.stop(_popped_label.get_meta("_juice_tw_scale") as Tween)
	_popped_label.scale = Vector2.ONE
	_popped_label = null

# D5: typewriter reveal of the newest caption. The labels are Labels (not RichText),
# so animate visible_characters 0→all over ~max(0.4, len*0.018)s. Instant under
# reduced motion. Position is NEVER animated (the VBox re-sorts on every layout pass
# and would stutter). The reveal tween is killed/snapped to full on the next push.
func _reveal_newest(lbl: Label, char_count: int) -> void:
	if lbl == null or not is_instance_valid(lbl):
		return
	if Juice.reduced_motion or char_count <= 0:
		lbl.visible_characters = -1  # all
		return
	lbl.visible_characters = 0
	_revealing_label = lbl
	var dur := maxf(0.4, char_count * 0.018)
	_reveal_tween = create_tween()
	_reveal_tween.tween_property(lbl, "visible_characters", char_count, dur) \
		.set_trans(Tween.TRANS_LINEAR)
	# After the reveal completes, restore -1 so future relayout/retint keeps it fully shown.
	_reveal_tween.tween_callback(func() -> void:
		if is_instance_valid(lbl):
			lbl.visible_characters = -1
		_revealing_label = null)

# Snap any in-flight typewriter reveal to fully-shown and drop the tween. Called
# before the next push reassigns text, and on clear. Null/invalid-safe.
func _stop_caption_reveal() -> void:
	Juice.stop(_reveal_tween)
	_reveal_tween = null
	if _revealing_label != null and is_instance_valid(_revealing_label):
		_revealing_label.visible_characters = -1
	_revealing_label = null

func _clear_captions() -> void:
	_stop_caption_pop()
	_stop_caption_reveal()
	_caption_lines.clear()
	for lbl in _caption_labels:
		lbl.visible = false
		lbl.text = ""
		lbl.modulate.a = 1.0
		lbl.scale = Vector2.ONE
		lbl.visible_characters = -1

# ── Speaking visualiser ─────────────────────────────────────────────────────
# Looping pulse while speaking: each bar scales on its own offset phase so it
# reads as live audio. ONE method_tween drives a shared phase var; bars derive
# their scale from it in a cheap callback (no per-bar tween, allocation-light).
func _start_visualiser() -> void:
	Juice.stop(_vis_tween)
	_vis_tween = null
	# D4: null-safe when the ribbon (which hosts the visualiser) is dormant.
	if not is_instance_valid(_vis_row):
		return
	# Restore full accent tint + visible when active.
	_set_bars_tint(SummerUI.ACCENT)
	if Juice.reduced_motion:
		_set_bars_phase(0.5)  # static mid height — still reads as "speaking"
		return
	_vis_tween = create_tween().set_loops()
	_vis_tween.tween_method(_set_bars_phase, 0.0, TAU, VIS_PULSE_TIME).set_trans(Tween.TRANS_SINE)

# Idle state: bars settle short + dim, but BREATHE — a slow, low-amplitude loop so
# a first-person conversation surface never reads as frozen on a projector between
# speaking bursts (Game-Feel Bible §6 idle motion). Same single method-tween as the
# speaking pulse (one tween either way), driven slower; killed on every re-issue and
# on exit by the existing Juice.stop(_vis_tween) sites. Snaps static under reduced
# motion.
func _refresh_visualiser_idle() -> void:
	Juice.stop(_vis_tween)
	_vis_tween = null
	if not is_instance_valid(_vis_row):
		return
	_set_bars_tint(SummerUI.TEXT_FAINT)
	if Juice.reduced_motion:
		_set_bars_phase(0.0)  # static idle floor
		return
	_vis_tween = create_tween().set_loops()
	_vis_tween.tween_method(_set_bars_phase, 0.0, TAU, VIS_IDLE_TIME).set_trans(Tween.TRANS_SINE)

# Map a single driving phase to every bar's vertical scale. Each bar gets a phase
# offset so the wave travels across the row. Cheap, no allocations. When speaking,
# a tall 0.30..1.0 wave reads as live audio; when idle, a gentle 0.26..0.40 breath.
func _set_bars_phase(phase: float) -> void:
	for i in _vis_bars.size():
		var bar := _vis_bars[i]
		if not is_instance_valid(bar):
			continue
		var local := phase + i * (PI / VIS_BARS)
		var wave := 0.5 + 0.5 * sin(local)  # 0..1
		var h := 0.26 + 0.14 * wave         # idle: low-amplitude breath
		if _speaking:
			h = 0.30 + 0.70 * wave          # speaking: full live-audio swing
		bar.scale = Vector2(1.0, h)

func _set_bars_tint(c: Color) -> void:
	for bar in _vis_bars:
		if not is_instance_valid(bar):
			continue
		var box := bar.get_theme_stylebox("panel")
		if box is StyleBoxFlat:
			(box as StyleBoxFlat).bg_color = c

# ── Enter / exit fade ───────────────────────────────────────────────────────
# One reused tween fades the whole overlay's modulate.a; on exit-complete we hide
# so the layer stops eating clicks. Honours reduced motion (snap to end state).
func _play_io_tween(target_a: float, time: float, _entering: bool) -> void:
	Juice.stop(_io_tween)
	_io_tween = null
	# Record current intent on a member, not the bound flag: _on_io_done reads
	# _io_target so a queued/late finished after a kill can never act on a stale
	# direction. A mid-fade exit→enter overwrites _io_target=1.0 before the killed
	# exit tween could ever resolve.
	_io_target = target_a
	if Juice.reduced_motion:
		modulate.a = target_a
		_on_io_done()
		return
	_io_tween = create_tween()
	_io_tween.tween_property(self, "modulate:a", target_a, time) \
		.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	_io_tween.finished.connect(_on_io_done)

func _on_io_done() -> void:
	# Only tear down if the *current* intent is "exited". Guards against a late
	# finished arriving after intent flipped back to enter.
	if _io_target <= 0.0:
		visible = false
		mouse_filter = Control.MOUSE_FILTER_IGNORE
		_clear_captions()
		_agent_id = ""
		_last_state = ""
		# Stop the idle/speaking breath once hidden — no looping tween runs off-screen.
		Juice.stop(_vis_tween)
		_vis_tween = null

func _on_leave_pressed() -> void:
	UiSounds.play("click")
	exit_requested.emit(_agent_id)

# Copy the caption history (the conversation) to the OS clipboard. The captions are
# plain Labels (no BBCode), so _caption_lines is already clean prose — join newest-
# order (oldest→newest, as held). Null/empty-safe: an empty ring still gives audio
# feedback but doesn't overwrite the clipboard with nothing.
func _on_copy_pressed() -> void:
	if _caption_lines.is_empty():
		UiSounds.play("click")
		if _copy != null:
			Juice.pop(_copy)
		return
	DisplayServer.clipboard_set("\n".join(_caption_lines))
	UiSounds.play("select")
	if _copy != null:
		Juice.pop(_copy)

# BBCode-escape a context string so a stray "[" in a branch/task can't break the
# meta markup.
func _esc(s: String) -> String:
	return s.replace("[", "[lb]")

# Compress a PR URL down to "#123" (or "owner/repo#123") for the ribbon.
func _pr_short(url: String) -> String:
	var parts := url.split("/", false)
	if parts.size() >= 2 and parts[parts.size() - 2] == "pull":
		return "#" + parts[parts.size() - 1]
	if parts.size() >= 1:
		var tail := parts[parts.size() - 1]
		return tail if tail != "" else url
	return url
