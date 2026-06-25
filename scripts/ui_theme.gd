extends RefCounted
class_name SummerUI
# SummerCraft — shared 2D theme (Chat D / The Interface).
#
# NOTE on bindings: this file (scripts/ui_theme.gd) keeps its global `class_name`
# — consumers reference it as the bare `SummerUI` identifier and that resolves
# fine because it lives OUTSIDE scripts/ui/. The scripts/ui/* helpers (Juice,
# UiSounds, DiffView) have NO class_name and are NOT in the editor's global class
# cache, so we MUST bind them by path via preload consts (see commit 82aa023).
const Juice := preload("res://scripts/ui/juice.gd")
const FrostRect := preload("res://scripts/ui/frost_rect.gd")
#
# Single source of truth for the command-center look: near-monochrome charcoal
# frost with ONE cool-indigo accent (Linear/OpenAI grade — no warm "playdough"
# mid-tones). Everything is built programmatically (StyleBoxFlat) so
# there are no fragile .tscn sub-resources to drift — the same philosophy the
# original interaction_panel used. Both hud.gd and interaction_panel.gd pull from
# here so the whole HUD stays coherent. Pure static helpers; never instantiated.

# ---- Palette — refined near-monochrome dark glass (Linear / OpenAI grade) ---
# Panels are frosted glass: ui_frost.gdshader blurs AND desaturates the diorama
# behind them, so these tints read as crisp cool-charcoal, never muddy. Colour is
# reserved for ONE accent + small status dots; every surface + label is neutral.
const BG_GLASS      := Color(0.035, 0.040, 0.052, 0.62)  # floating panels (frosted, crisp)
const BG_GLASS_SOFT := Color(0.045, 0.050, 0.064, 0.42)  # secondary / nested surfaces
const BG_SOLID      := Color(0.030, 0.035, 0.046, 0.70)  # the agent card (densest)
const BG_INPUT      := Color(1, 1, 1, 0.05)              # inputs: a faint light well on the glass
const BG_CHIP       := Color(1, 1, 1, 0.04)              # rows: a whisper of light on the glass

const BORDER        := Color(1, 1, 1, 0.08)              # hairline
const BORDER_HI     := Color(1, 1, 1, 0.14)
const BORDER_FOCUS  := Color(0.42, 0.58, 0.98, 0.85)

# Crisp neutral type ramp — strong hierarchy (names pop, meta recedes).
const TEXT          := Color(0.96, 0.97, 0.99)           # names / primary
const TEXT_DIM      := Color(0.60, 0.64, 0.72)           # meta / sub
const TEXT_FAINT    := Color(0.42, 0.46, 0.54)           # section headers / hints

# THE one accent — a confident cool indigo (kills the playdough gold). Cool UI over
# the warm diorama is the deliberate contrast; used ONLY for the primary action +
# selection. ACCENT_TEXT is near-white ink on a filled accent.
const ACCENT        := Color(0.40, 0.56, 0.96)
const ACCENT_HI     := Color(0.52, 0.67, 1.00)
const ACCENT_LO     := Color(0.30, 0.44, 0.82)
const ACCENT_TEXT   := Color(0.98, 0.99, 1.00)

const BLUE          := Color(0.40, 0.56, 0.96)
const BLUE_HI       := Color(0.52, 0.67, 1.00)
const BLUE_LO       := Color(0.30, 0.44, 0.82)

# Status hues — small crisp dots ONLY (clean, not neon, not muddy).
const OK_GREEN      := Color(0.32, 0.82, 0.56)
const DANGER        := Color(0.97, 0.45, 0.45)

# Diff line colours — clean, lightly desaturated for code legibility.
const DIFF_ADD      := Color(0.45, 0.83, 0.58)
const DIFF_DEL      := Color(0.96, 0.52, 0.52)
const DIFF_META     := Color(0.52, 0.66, 0.96)
const DIFF_CTX      := Color(0.62, 0.66, 0.76)
const DIFF_FAINT    := Color(0.45, 0.49, 0.58)

# ---- StyleBox builders -----------------------------------------------------
static func sb(bg: Color, radius: int = 12, border := Color(0, 0, 0, 0), border_w := 0, pad := 0) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = bg
	box.set_corner_radius_all(radius)
	if border_w > 0:
		box.set_border_width_all(border_w)
		box.border_color = border
	if pad > 0:
		box.set_content_margin_all(pad)
	return box

static func pill(bg: Color, radius := 9, padx := 10, pady := 3) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = bg
	box.set_corner_radius_all(radius)
	box.content_margin_left = padx
	box.content_margin_right = padx
	box.content_margin_top = pady
	box.content_margin_bottom = pady
	return box

# ---- Button styling --------------------------------------------------------
# NOTE: theme is VISUALS ONLY. Sound + signal wiring is the consumer's job —
# the component connects pressed/mouse_entered and calls UiSounds.play("click"/
# "hover") at its own interaction site (§4). The absence of any play() here is
# by design (§0 ownership), not a forgotten coverage gap.
# Applies normal/hover/pressed/disabled styleboxes + matching font colours.
# Frosted button: translucent fills + a hairline border on every state, soft text.
# Buttons read as glass chips; only the single primary action carries the accent.
static func style_button_b(b: Button, base: Color, hover: Color, pressed: Color, fg: Color, border: Color, radius := 10, pad := 10) -> void:
	b.add_theme_stylebox_override("normal", sb(base, radius, border, 1, pad))
	b.add_theme_stylebox_override("hover", sb(hover, radius, BORDER_HI, 1, pad))
	b.add_theme_stylebox_override("pressed", sb(pressed, radius, border, 1, pad))
	b.add_theme_stylebox_override("focus", sb(hover, radius, BORDER_FOCUS, 1, pad))
	b.add_theme_stylebox_override("disabled", sb(Color(base.r, base.g, base.b, base.a * 0.5), radius, BORDER, 1, pad))
	for cn in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		b.add_theme_color_override(cn, fg)
	b.add_theme_color_override("font_disabled_color", Color(fg.r, fg.g, fg.b, 0.4))

# Back-compat borderless entry (legacy callers) → routed through the bordered look.
static func style_button(b: Button, base: Color, hover: Color, pressed: Color, fg: Color, radius := 10, pad := 10) -> void:
	style_button_b(b, base, hover, pressed, fg, BORDER, radius, pad)

static func accent_button(b: Button) -> void:
	# Confident FILLED indigo — the single primary action. Near-white ink, no border.
	var a := ACCENT
	style_button_b(b, Color(a.r, a.g, a.b, 0.95), Color(a.r, a.g, a.b, 1.0), Color(a.r, a.g, a.b, 0.82), ACCENT_TEXT, Color(a.r, a.g, a.b, 0.0))

static func primary_button(b: Button) -> void:
	var c := BLUE
	style_button_b(b, Color(c.r, c.g, c.b, 0.18), Color(c.r, c.g, c.b, 0.28), Color(c.r, c.g, c.b, 0.12), BLUE_HI, Color(c.r, c.g, c.b, 0.40))

static func ghost_button(b: Button) -> void:
	style_button_b(b, Color(1, 1, 1, 0.05), Color(1, 1, 1, 0.10), Color(1, 1, 1, 0.03), Color(0.82, 0.86, 0.94), BORDER)

static func success_button(b: Button) -> void:
	var g := OK_GREEN
	style_button_b(b, Color(g.r, g.g, g.b, 0.14), Color(g.r, g.g, g.b, 0.24), Color(g.r, g.g, g.b, 0.10), Color(0.72, 0.92, 0.80), Color(g.r, g.g, g.b, 0.34))

static func icon_button(b: Button) -> void:
	style_button_b(b, Color(0, 0, 0, 0), Color(1, 1, 1, 0.08), Color(1, 1, 1, 0.04), TEXT_DIM, Color(0, 0, 0, 0), 9, 6)

# ---- State + kind semantics ------------------------------------------------
# Maps the frozen AgentState enum to a colour-coded pill.
# Required game-feel beat per state (fired by the COMPONENT, not here):
#   working -> Juice.pulse      + UiSounds.play("state_working")
#   done    -> Juice.done_cheer + UiSounds.play("done_cheer")   # label "REVIEW"
#   blocked -> Juice.lock_slam  + UiSounds.play("blocked")
# This is the single source of the state->visual mapping; keep the trigger
# logic in the consumers aligned to it so a reviewer can verify from one file.
static func state_palette(state: String) -> Dictionary:
	# Labels are NEUTRAL (brightness encodes active/idle); the DOT is the only hue.
	# `bg` is a faint neutral well (kept only for any legacy pill caller).
	match state:
		"working":
			return {"bg": Color(1, 1, 1, 0.06), "fg": Color(0.82, 0.86, 0.92), "label": "Working", "dot": OK_GREEN}
		"moving":
			return {"bg": Color(1, 1, 1, 0.06), "fg": Color(0.82, 0.86, 0.92), "label": "Moving", "dot": Color(0.40, 0.62, 0.98)}
		"blocked":
			return {"bg": Color(1, 1, 1, 0.06), "fg": Color(0.84, 0.82, 0.86), "label": "Blocked", "dot": DANGER}
		"done":
			return {"bg": Color(1, 1, 1, 0.06), "fg": Color(0.84, 0.86, 0.92), "label": "Review", "dot": Color(0.97, 0.74, 0.36)}
		"waiting":
			return {"bg": Color(1, 1, 1, 0.04), "fg": Color(0.48, 0.52, 0.60), "label": "Idle", "dot": Color(0.50, 0.55, 0.62)}
		_:
			return {"bg": Color(1, 1, 1, 0.04), "fg": Color(0.48, 0.52, 0.60), "label": (state.capitalize() if state != "" else "—"), "dot": TEXT_FAINT}

# `done` is our "awaiting approval" state — surfaces an Approve affordance.
static func awaits_approval(state: String) -> bool:
	return state == "done"

static func is_active(state: String) -> bool:
	return state == "working" or state == "moving" or state == "blocked" or state == "done"

# Active = more visible (Mathias's note: grey-on-grey-on-gradient is hard to read).
# Working/moving get a denser frost tint + a state-coloured rim at full opacity;
# blocked/done (attention) similar; idle/waiting recede (lighter tint, faint rim,
# slightly dimmed). For a frosted surface: feed {tint, rim} to set_frost_emphasis
# and {alpha} to the node's modulate.
static func state_emphasis(state: String) -> Dictionary:
	var dot: Color = state_palette(state)["dot"]
	match state:
		"working", "moving":
			return {"tint": Color(BG_GLASS.r, BG_GLASS.g, BG_GLASS.b, 0.66), "rim": Color(dot.r, dot.g, dot.b, 0.52), "alpha": 1.0}
		"blocked", "done":
			return {"tint": Color(BG_GLASS.r, BG_GLASS.g, BG_GLASS.b, 0.60), "rim": Color(dot.r, dot.g, dot.b, 0.44), "alpha": 1.0}
		_:
			return {"tint": Color(BG_GLASS.r, BG_GLASS.g, BG_GLASS.b, 0.44), "rim": Color(1, 1, 1, 0.07), "alpha": 0.78}

# Chip emphasis for stylebox-based chips (the roster). Active states get a brighter
# fill + a soft state-tinted border; idle recedes (dim via the returned alpha + plain
# border). Subtle tint, NOT the loud blocked-bar. Selected wins the accent border.
static func chip_emphasis(state: String, selected := false) -> Dictionary:
	if selected:
		# the open agent — a calm accent wash + accent hairline, never loud
		return {"fill": Color(ACCENT.r, ACCENT.g, ACCENT.b, 0.12), "border": Color(ACCENT.r, ACCENT.g, ACCENT.b, 0.55)}
	if is_active(state):
		# working/blocked/etc — a brighter light well draws the eye; the DOT carries hue
		return {"fill": Color(1, 1, 1, 0.085), "border": Color(1, 1, 1, 0.08)}
	# idle / waiting — recede: a faint well, near-invisible edge (neutral, no colour)
	return {"fill": Color(1, 1, 1, 0.03), "border": Color(1, 1, 1, 0.04)}

static func kind_color(kind: String) -> Color:
	match kind:
		"viking":    return Color(0.45, 0.62, 0.95)
		"wizard":    return Color(0.66, 0.50, 0.95)
		"dwarf":     return Color(0.95, 0.62, 0.30)
		"barbarian": return Color(0.95, 0.45, 0.42)
		_:           return Color(0.70, 0.74, 0.86)

# Per-kind glyph. RISK: 🪓🪄⛏🛡 are emoji a bundled UI TTF likely lacks, which
# renders as tofu boxes on the projector. So the safe dot (●, coloured via
# kind_color) is the PRIMARY indicator and is always used when a custom font is
# bundled; the themed emoji are a nice-to-have only on the engine default font
# (which carries emoji fallback). Callers should pair this with kind_color().
static func kind_glyph(kind: String) -> String:
	if has_custom_font():
		return "●"
	match kind:
		"viking":    return "🪓"
		"wizard":    return "🪄"
		"dwarf":     return "⛏"
		"barbarian": return "🛡"
		_:           return "●"

# Null-safe Variant -> String (nullable contract fields throw on String(null)).
static func s(v, def := "") -> String:
	if v == null:
		return def
	return String(v)

# ============================================================================
#  ADDITIVE SURFACE (announced in INTERFACES.md §3) — production theme.
#  Everything below is purely additive: a generated Theme resource, a custom
#  font loader (graceful fallback to the engine default), the full set of
#  glass / pill / input state styleboxes, and the reduced_motion mirror Juice
#  reads. None of the tokens / builders / semantics above change — hud.gd and
#  interaction_panel.gd keep pulling exactly what they already do.
# ============================================================================

# ── Type-scale (one place; legible across a room) ───────────────────────────
# Fixed, crisp sizes — the projector + portrait phone both read these. Not px
# magic for layout (anchors do that); these are *text* sizes only.
const FS_DISPLAY := 28   # brand / dive name
const FS_TITLE   := 22   # card header label
const FS_BODY    := 18   # default body / transcript
const FS_LABEL   := 15   # sub-lines, ribbons
const FS_PILL    := 13   # state pills, tabs
const FS_MICRO   := 12   # faint tags / section headers
const FS_CHAT    := 20   # dive conversation lines (read at a glance)

# ── Spacing rhythm (shared separations / margins) ───────────────────────────
const PAD_CARD   := 14
const PAD_TIGHT  := 9
const GAP_ROW    := 8
const RADIUS     := 12
const RADIUS_SM  := 9

# ── Custom font ─────────────────────────────────────────────────────────────
# Drop a display font at FONT_PATH and the whole HUD picks it up; absent, we
# fall back to the engine default (never an error, never a missing-glyph box).
# Resolved + cached once. Loaded lazily so this RefCounted has zero load cost
# until the Theme is first built.
const FONT_PATH      := "res://fonts/ui.ttf"
const FONT_MONO_PATH := "res://fonts/ui_mono.ttf"

static var _font: Font = null
static var _font_mono: Font = null
static var _font_resolved := false
static var _theme: Theme = null

# Returns the UI display font, or null when none is bundled (callers / Theme
# then use the engine default automatically). ResourceLoader-guarded so a
# missing asset is silent, exactly like UiSounds.
static func font() -> Font:
	_resolve_fonts()
	return _font

# Returns the monospace font for the diff view; null => default mono fallback.
static func mono_font() -> Font:
	_resolve_fonts()
	return _font_mono

static func has_custom_font() -> bool:
	_resolve_fonts()
	return _font != null

static func _resolve_fonts() -> void:
	if _font_resolved:
		return
	_font_resolved = true
	if ResourceLoader.exists(FONT_PATH):
		var f = ResourceLoader.load(FONT_PATH)
		if f is Font:
			_font = f
	if ResourceLoader.exists(FONT_MONO_PATH):
		var fm = ResourceLoader.load(FONT_MONO_PATH)
		if fm is Font:
			_font_mono = fm

# ── Reduced-motion mirror ────────────────────────────────────────────────────
# Juice owns the actual gate (Juice.reduced_motion); SummerUI is the public
# face settings flip, and it writes through so there is ONE source of truth.
# Components/settings call SummerUI.set_reduced_motion(true); Juice reads its
# own flag at every tween site. Read-back mirror provided for symmetry.
static func set_reduced_motion(on: bool) -> void:
	Juice.reduced_motion = on

static func reduced_motion() -> bool:
	return Juice.reduced_motion

# ── Glass / input / pill state styleboxes (full state matrix) ────────────────
# A floating glass surface (panels, trays, the card). Soft border + room-legible
# rounding. `soft` picks the secondary tone.
static func glass(soft := false, radius := RADIUS, pad := 0) -> StyleBoxFlat:
	return sb(BG_GLASS_SOFT if soft else BG_GLASS, radius, BORDER, 1, pad)

# The agent card surface — now a denser frosted tint (no longer opaque). Used as
# the stylebox when a panel is NOT frosted with a real blur; frosted panels use
# attach_frost() + frost_border() instead.
static func card_surface(radius := RADIUS, pad := PAD_CARD) -> StyleBoxFlat:
	return sb(BG_SOLID, radius, BORDER_HI, 1, pad)

# ── Frosted backing (the premium translucency) ───────────────────────────────
# A FrostRect blurs + tints the diorama behind a panel, masked to a rounded rect.
# Pattern: attach_frost(panel) turns `panel` into a frosted surface — it inserts
# the frost fill as the BACKMOST child and sets the panel's stylebox to a hairline
# border with a transparent fill, so the frost is the fill and the edge stays crisp.
static func frost_border(radius := RADIUS, pad := 0, strong := false) -> StyleBoxFlat:
	return sb(Color(0, 0, 0, 0), radius, BORDER_HI if strong else BORDER, 1, pad)

static func attach_frost(panel: Control, tint := BG_GLASS, radius := RADIUS, pad := 0, strong_border := false) -> Control:
	var fr = FrostRect.new()  # untyped: .radius is on the frost_rect script, not ColorRect
	fr.radius = float(radius)
	panel.add_child(fr)
	panel.move_child(fr, 0)
	if fr.material is ShaderMaterial:
		var mm := fr.material as ShaderMaterial
		mm.set_shader_parameter("tint", tint)
		mm.set_shader_parameter("rim_color", Color(1, 1, 1, 0.14 if strong_border else 0.09))
	# Borderless: the shader's AA'd rim is the edge. A StyleBoxFlat border aliases on
	# rounded corners under the mobile renderer (no 2D MSAA), so draw NO stylebox border.
	panel.add_theme_stylebox_override("panel", sb(Color(0, 0, 0, 0), radius, Color(0, 0, 0, 0), 0, pad))
	return fr

# Recolour an already-attached frost — state emphasis: denser tint + a state-tinted
# rim so ACTIVE agents read brighter than idle. `fr` is the ColorRect from attach_frost.
static func set_frost_emphasis(fr, tint: Color, rim: Color) -> void:
	if fr != null and is_instance_valid(fr) and fr.material is ShaderMaterial:
		var mm := fr.material as ShaderMaterial
		mm.set_shader_parameter("tint", tint)
		mm.set_shader_parameter("rim_color", rim)

# A chip surface (roster chip / tray row). `hovered` and `selected` give the
# two interactive states so a list upsert can swap stylebox without realloc'ing
# the node. Selected uses the warm accent border = "this is the open agent".
static func chip_surface(hovered := false, selected := false) -> StyleBoxFlat:
	var bg := BG_CHIP
	if hovered:
		bg = BG_CHIP.lightened(0.06)
	var border := BORDER_HI if hovered else BORDER
	var bw := 1
	if selected:
		border = ACCENT
		bw = 2
		# selected+hover must be >= both standalone states (else hovering the open
		# agent dims it); compute from the post-hover value, on-palette, clamps safely.
		bg = BG_CHIP.lightened(0.10) if hovered else BG_CHIP.lightened(0.04)
	return sb(bg, RADIUS_SM, border, bw, 0)

# The three LineEdit states (normal / focus / read_only). Focus draws the blue
# ring; read_only dims. LineEdit has no "hover" stylebox slot in Godot 4 — a
# hover affordance on an input must be a mouse_entered tint in the component,
# not a stylebox here.
static func input_normal(pad := 8) -> StyleBoxFlat:
	return sb(BG_INPUT, RADIUS_SM, BORDER, 1, pad)

static func input_focus(pad := 8) -> StyleBoxFlat:
	return sb(BG_INPUT, RADIUS_SM, BORDER_FOCUS, 2, pad)

static func input_disabled(pad := 8) -> StyleBoxFlat:
	return sb(BG_INPUT.darkened(0.25), RADIUS_SM, BORDER, 1, pad)

# Apply the full state matrix to a LineEdit in one call (mirrors *_button()).
static func style_input(le: LineEdit, pad := 8) -> void:
	le.add_theme_stylebox_override("normal", input_normal(pad))
	le.add_theme_stylebox_override("focus", input_focus(pad))
	le.add_theme_stylebox_override("read_only", input_disabled(pad))
	le.add_theme_color_override("font_color", TEXT)
	le.add_theme_color_override("font_placeholder_color", TEXT_FAINT)
	le.add_theme_color_override("font_uneditable_color", TEXT_FAINT)
	le.add_theme_color_override("caret_color", ACCENT_HI)
	le.add_theme_color_override("selection_color", Color(BLUE.r, BLUE.g, BLUE.b, 0.35))

# ── Generated Theme resource ─────────────────────────────────────────────────
# A single Theme covering the default look so plain Controls (Labels, the
# transcript RichTextLabel, scrollbars, tooltips) inherit the command-center
# palette + font without per-node overrides. Built once, cached. The bespoke
# components still style their interactive widgets through the *_button/_input
# helpers above (the full hover/pressed/focus/disabled matrix lives there —
# a Theme can only carry one set of default styleboxes per type).
#
# Assign at the HUD root: `$Hud.theme = SummerUI.theme()` and it cascades.
static func theme() -> Theme:
	if _theme != null:
		return _theme
	_resolve_fonts()
	var t := Theme.new()

	# Default font + sizes across every type that takes one.
	if _font != null:
		t.default_font = _font
	t.default_font_size = FS_BODY

	# Labels.
	t.set_color("font_color", "Label", TEXT)
	t.set_color("font_shadow_color", "Label", Color(0, 0, 0, 0.35))
	t.set_constant("shadow_offset_y", "Label", 1)
	t.set_font_size("font_size", "Label", FS_BODY)

	# RichTextLabel (the transcript / dive captions).
	t.set_color("default_color", "RichTextLabel", TEXT)
	t.set_font_size("normal_font_size", "RichTextLabel", FS_BODY)
	if _font_mono != null:
		t.set_font("mono_font", "RichTextLabel", _font_mono)

	# Buttons — a sane default (ghost-like) so any un-styled Button is still on
	# palette; the *_button() helpers override per-instance for the real CTAs.
	t.set_stylebox("normal", "Button", sb(Color(0.17, 0.19, 0.26, 1), RADIUS_SM, Color(0, 0, 0, 0), 0, 10))
	t.set_stylebox("hover", "Button", sb(Color(0.22, 0.25, 0.33, 1), RADIUS_SM, Color(0, 0, 0, 0), 0, 10))
	t.set_stylebox("pressed", "Button", sb(Color(0.13, 0.15, 0.20, 1), RADIUS_SM, Color(0, 0, 0, 0), 0, 10))
	t.set_stylebox("focus", "Button", sb(Color(0.17, 0.19, 0.26, 1), RADIUS_SM, BORDER_HI, 1, 10))
	t.set_stylebox("disabled", "Button", sb(Color(0.12, 0.13, 0.18, 1), RADIUS_SM, Color(0, 0, 0, 0), 0, 10))
	t.set_color("font_color", "Button", Color(0.86, 0.90, 1.0))
	t.set_color("font_hover_color", "Button", TEXT)
	t.set_color("font_pressed_color", "Button", TEXT_DIM)
	t.set_color("font_focus_color", "Button", TEXT)
	t.set_color("font_disabled_color", "Button", TEXT_FAINT)
	t.set_font_size("font_size", "Button", FS_BODY)

	# LineEdit default (interactive instances re-style via style_input()).
	t.set_stylebox("normal", "LineEdit", input_normal())
	t.set_stylebox("focus", "LineEdit", input_focus())
	t.set_stylebox("read_only", "LineEdit", input_disabled())
	t.set_color("font_color", "LineEdit", TEXT)
	t.set_color("font_placeholder_color", "LineEdit", TEXT_FAINT)
	t.set_color("caret_color", "LineEdit", ACCENT_HI)

	# PanelContainer / Panel default = glass.
	t.set_stylebox("panel", "PanelContainer", glass())
	t.set_stylebox("panel", "Panel", glass())

	# Tooltips on palette.
	t.set_stylebox("panel", "TooltipPanel", sb(BG_SOLID, RADIUS_SM, BORDER_HI, 1, 8))
	t.set_color("font_color", "TooltipLabel", TEXT)

	# Slim, unobtrusive scrollbars (the transcript / diff / roster all scroll).
	for sbar in ["VScrollBar", "HScrollBar"]:
		t.set_stylebox("scroll", sbar, sb(Color(1, 1, 1, 0.03), 6))
		t.set_stylebox("grabber", sbar, sb(Color(1, 1, 1, 0.16), 6))
		t.set_stylebox("grabber_highlight", sbar, sb(Color(1, 1, 1, 0.26), 6))
		t.set_stylebox("grabber_pressed", sbar, sb(ACCENT, 6))

	_theme = t
	return _theme
