extends Control
# No class_name: bound via preload consts (below) so refs resolve by path even though
# scripts/ui is not in the editor's global class cache. interaction_panel.gd likewise
# binds this script as `const DiffView := preload("res://scripts/ui/diff_view.gd")`.
const Juice := preload("res://scripts/ui/juice.gd")
const UiSounds := preload("res://scripts/ui/ui_sounds.gd")
# ============================================================================
#  DiffView — unified-diff renderer (Chat D / The Interface).
#
#  A self-contained Control that turns a raw `git diff` string into a readable,
#  coloured, monospaced view. Hosted by InteractionPanel (the card) and reusable
#  by the dive context ribbon. It owns ZERO sidecar comms: the shell hands it
#  text via set_diff(); the request for fresh text is the shell's job (the card
#  emits diff_requested; B fetches GET /agents/:id/diff and calls set_diff()).
#
#  Renders, per the production checklist:
#    • per-file sections (split on `diff --git` / `+++` headers) with a file label
#    • +/- gutter colouring (adds green, dels red, context dim) via SummerUI.DIFF_*
#    • hunk headers (@@ … @@) styled as metadata
#    • a mono font, line numbers optional, tight line spacing
#    • an additions/deletions stat ([+N  −M]) computed once on set
#    • explicit loading / empty / error states (never a blank void)
#    • truncation: diffs over ~MAX_LINES are cut with a "+N more lines" notice
#      so a huge diff can't blow up layout or stall the UI
#
#  Data shape: the raw string is the `diff` field of the frozen AgentDiff
#  (contract.ts). `truncated`/`files` from AgentDiff may be passed for a better
#  header but are optional — set_diff(text) alone is sufficient.
#
#  ── Production notes ────────────────────────────────────────────────────────
#  Responsive: pure anchors/containers, no magic px — fills its host at both
#  720x1280 portrait and the wide projector. Allocation discipline: ALL work
#  happens in set_diff()/state setters; nothing runs in _process (there is none),
#  so the 1s poll never churns. The body is rebuilt only when set_diff is called
#  with text that differs from what's already shown (guarded by _last_text), so a
#  poll that re-hands identical diff text causes zero rebuild / zero scroll-jump.
#  Every nullable is funnelled through SummerUI.s(). Theme ONLY via SummerUI,
#  motion ONLY via Juice, sound ONLY via UiSounds.
# ============================================================================

# Cap before we truncate + show a notice (protects layout + perf on giant diffs).
const MAX_LINES := 800

# Internal render states.
enum _S { EMPTY, LOADING, ERROR, DIFF }

# Built nodes (programmatic so there are no fragile .tscn sub-resources).
var _title: Label           # "DIFF" eyebrow, top-left
var _stat: Label            # the [+N −M] stat, top-right
var _scroll: ScrollContainer
var _body: RichTextLabel    # the coloured mono diff text
var _state_label: Label     # loading / empty / error placeholder

var _adds := 0
var _dels := 0

# Guard so a re-hand of identical text on the poll is a no-op (no flicker / no
# scroll-reset). "" is never a valid rendered diff (it routes to EMPTY).
var _last_text := ""
var _state: int = _S.EMPTY

func _ready() -> void:
	# Fill the host at every aspect ratio — anchors, not fixed sizes.
	set_anchors_preset(Control.PRESET_FULL_RECT)
	size_flags_horizontal = Control.SIZE_EXPAND_FILL
	size_flags_vertical = Control.SIZE_EXPAND_FILL
	clip_contents = true

	# Frosted glass surface behind the diff so it reads as one panel across a room.
	# Nested/secondary surface (hosted inside the agent card) -> softer BG_GLASS_SOFT
	# tint. attach_frost inserts a blurred FrostRect as the backmost child and sets the
	# panel stylebox to a hairline border: frosted fill, crisp 1px edge. Radius 16
	# matches the card; pad 8 keeps the existing content inset.
	var bg := PanelContainer.new()
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_PASS
	add_child(bg)
	SummerUI.attach_frost(bg, SummerUI.BG_GLASS_SOFT, 16, 8)

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 6)
	bg.add_child(col)

	# ── Header row: eyebrow + stat ──────────────────────────────────────────
	var header := HBoxContainer.new()
	header.add_theme_constant_override("separation", 8)
	col.add_child(header)

	_title = Label.new()
	_title.text = "DIFF"
	_title.add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	_title.add_theme_font_size_override("font_size", 12)
	_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(_title)

	_stat = Label.new()
	_stat.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	# Stat colour never changes — set it once here, not on every set_diff (avoids a
	# redundant theme-override write / dirty on each diff arrival).
	_stat.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	_apply_mono(_stat, 13)
	header.add_child(_stat)

	# ── Body: vertically scrollable mono diff (lines wrap, no h-scroll) ──────
	_scroll = ScrollContainer.new()
	_scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	# Spec §2: the diff WRAPS — never a horizontal scroll bar / off-screen line.
	# Only the vertical scroll engages; long code lines fold within the card width.
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	col.add_child(_scroll)

	_body = RichTextLabel.new()
	_body.bbcode_enabled = true
	_body.scroll_active = false            # the ScrollContainer owns scrolling
	_body.fit_content = true               # grow to content so the v-scroll engages
	# Spec §2: wrap long lines inside the card width (no off-screen overflow). Mono
	# code with no spaces still folds because ARBITRARY breaks at the glyph.
	_body.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_body.selection_enabled = true
	_body.focus_mode = Control.FOCUS_NONE
	_body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_body.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_body.add_theme_constant_override("line_separation", 2)
	_body.add_theme_color_override("default_color", SummerUI.DIFF_CTX)
	_apply_mono(_body, 14)
	_scroll.add_child(_body)

	# ── State placeholder (loading / empty / error) overlays the body slot ──
	_state_label = Label.new()
	_state_label.set_anchors_preset(Control.PRESET_FULL_RECT)
	_state_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_state_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_state_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_state_label.add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	_state_label.add_theme_font_size_override("font_size", 15)
	_state_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bg.add_child(_state_label)

	clear()

# ── Shell API (methods the card / shell calls down) ─────────────────────────

# Render a raw unified-diff string. Computes the +/- stat, colours every line,
# truncates past MAX_LINES with a notice. Empty/whitespace => the empty state.
# `truncated_hint` (from AgentDiff.truncated) forces the truncation notice even
# when under MAX_LINES (the sidecar already cut it server-side).
func set_diff(text: String, truncated_hint: bool = false) -> void:
	var raw := SummerUI.s(text)
	# Identical re-hand on the poll: keep current view, no flicker, no scroll jump.
	if _state == _S.DIFF and raw == _last_text:
		return
	if raw.strip_edges() == "":
		clear()
		return

	# Was this a real arrival (loading/empty/error -> diff) vs a diff-to-diff text
	# update? Only the arrival gets a sound; capture before we flip _state.
	var fresh_arrival := _state != _S.DIFF
	_last_text = raw
	_state = _S.DIFF
	_render(raw, truncated_hint)

	# Highlight the freshly-arrived diff without moving layout, and reset scroll
	# to the top so the reviewer starts at the first hunk.
	_scroll.scroll_vertical = 0
	_scroll.scroll_horizontal = 0
	Juice.flash(_body, SummerUI.DIFF_META)
	# State change DIFF is a visible beat (Game-Feel Bible §6 wants sound on state
	# changes); pair the flash with a soft tick. §4 has no dedicated diff-arrival
	# event, so reuse "click" pitched up. The identical-poll path returns above and
	# a diff->diff text refresh keeps prev _state==DIFF, so both stay silent.
	if fresh_arrival:
		UiSounds.play("click", 1.06)

# Show the "fetching…" placeholder while the shell asks B for fresh diff text.
func set_loading() -> void:
	_state = _S.LOADING
	_last_text = ""
	_show_state("Loading diff…", SummerUI.TEXT_DIM)

# Show an error placeholder (e.g. the diff fetch failed). Pairs with
# UiSounds.play("error") at the call site.
func set_error(message: String = "Couldn't load the diff.") -> void:
	_state = _S.ERROR
	_last_text = ""
	_show_state(SummerUI.s(message, "Couldn't load the diff."), SummerUI.DANGER)
	UiSounds.play("error")
	Juice.flash(_state_label, SummerUI.DANGER)

# Clear back to the neutral empty state ("No changes yet.").
func clear() -> void:
	_state = _S.EMPTY
	_last_text = ""
	_adds = 0
	_dels = 0
	_show_state("No changes yet.", SummerUI.TEXT_FAINT)

# Current additions / deletions counts from the last set_diff (for a host header).
func stat() -> Vector2i:
	return Vector2i(_adds, _dels)

# ── Internals ───────────────────────────────────────────────────────────────

# Swap to a placeholder state: empty body, centred message, blank stat. Stat
# counts are zeroed so stat() can't report a stale [+N −M] to the host header
# after a loading/error/clear transition.
func _show_state(msg: String, color: Color) -> void:
	_adds = 0
	_dels = 0
	if _body != null:
		_body.clear()
	if _scroll != null:
		_scroll.visible = false
	if _stat != null:
		_stat.text = ""
	_state_label.text = msg
	_state_label.add_theme_color_override("font_color", color)
	_state_label.visible = true

# Parse + colour the whole diff in one pass, set the stat, append a truncation
# notice when needed. Single build; nothing per-frame.
func _render(raw: String, truncated_hint: bool) -> void:
	_state_label.visible = false
	_scroll.visible = true

	var lines := raw.split("\n")
	var total := lines.size()
	var shown := mini(total, MAX_LINES)
	var truncated := truncated_hint or total > MAX_LINES

	_adds = 0
	_dels = 0

	# Build the whole body as one BBCode string, then assign once (one alloc burst
	# on set, none afterward).
	var sb := PackedStringArray()
	for i in shown:
		var line := lines[i]
		sb.append(_format_line(line))
	var body_text := "\n".join(sb)

	if truncated:
		var more := total - shown
		var notice := "  … truncated"
		if more > 0:
			notice = "  … %d more line%s truncated" % [more, "" if more == 1 else "s"]
		# Notice is author-controlled (no user content, no "[") — no _esc needed.
		body_text += "\n" + _bb(SummerUI.DIFF_FAINT, notice, true)

	_body.text = body_text
	# _stat is a plain Label (no BBCode); font_color is set once in _ready().
	_stat.text = "+%d  −%d" % [_adds, _dels]

# Colour + (where useful) background-tint one diff line, returning its BBCode.
# Counts +/- into the stat as a side-effect (content lines only).
func _format_line(line: String) -> String:
	# File-section headers — the strongest visual divider.
	if line.begins_with("diff --git ") or line.begins_with("+++ ") or line.begins_with("--- "):
		# Don't let the +++/--- file markers be miscounted as add/del content.
		return _bb(SummerUI.DIFF_META, _esc(line), true)
	# Hunk header @@ -a,b +c,d @@
	if line.begins_with("@@"):
		return _bb(SummerUI.DIFF_META, _esc(line), false)
	# Index / mode / similarity metadata.
	if line.begins_with("index ") or line.begins_with("new file") or line.begins_with("deleted file") \
			or line.begins_with("old mode") or line.begins_with("new mode") \
			or line.begins_with("rename ") or line.begins_with("similarity ") \
			or line.begins_with("copy ") or line.begins_with("Binary files"):
		return _bb(SummerUI.DIFF_FAINT, _esc(line), false)
	# Added line. The line WRAPS (spec §2), so a fixed-width band is gone — the
	# bgcolor tints the (possibly multi-row) glyphs; colour + sign carry the signal.
	if line.begins_with("+"):
		_adds += 1
		return _bb(SummerUI.DIFF_ADD, _esc(line), false, Color(SummerUI.DIFF_ADD.r, SummerUI.DIFF_ADD.g, SummerUI.DIFF_ADD.b, 0.10))
	# Removed line — same red tint.
	if line.begins_with("-"):
		_dels += 1
		return _bb(SummerUI.DIFF_DEL, _esc(line), false, Color(SummerUI.DIFF_DEL.r, SummerUI.DIFF_DEL.g, SummerUI.DIFF_DEL.b, 0.10))
	# "\ No newline at end of file" and similar.
	if line.begins_with("\\"):
		return _bb(SummerUI.DIFF_FAINT, _esc(line), false)
	# Context line (leading space) or anything else.
	return _bb(SummerUI.DIFF_CTX, _esc(line), false)

# Wrap text in a colour (+ optional bold + optional bg highlight) BBCode span.
func _bb(color: Color, text: String, bold: bool = false, bg := Color(0, 0, 0, 0)) -> String:
	var inner := text if text != "" else " "
	if bold:
		inner = "[b]" + inner + "[/b]"
	if bg.a > 0.0:
		inner = "[bgcolor=#%s]%s[/bgcolor]" % [bg.to_html(true), inner]
	return "[color=#%s]%s[/color]" % [color.to_html(false), inner]

# Escape BBCode metacharacters so diff content can't inject markup.
func _esc(text: String) -> String:
	return text.replace("[", "[lb]")

# Apply a legible monospace font + size to a node. Prefers the bundled project
# mono font (SummerUI.mono_font(), the additive theme surface in INTERFACES.md
# §3) so the diff matches the rest of the HUD; falls back to a SystemFont stack
# resolving a platform monospace when none is bundled (never an error / box).
func _apply_mono(node: Control, size: int) -> void:
	var mono: Font = SummerUI.mono_font()
	if mono == null:
		var sys := SystemFont.new()
		sys.font_names = PackedStringArray([
			"JetBrains Mono", "Cascadia Mono", "SF Mono", "Menlo",
			"DejaVu Sans Mono", "Consolas", "monospace",
		])
		mono = sys
	node.add_theme_font_override("font", mono)
	if node is RichTextLabel:
		node.add_theme_font_override("normal_font", mono)
		node.add_theme_font_override("bold_font", mono)
		node.add_theme_font_override("mono_font", mono)
		node.add_theme_font_size_override("normal_font_size", size)
		node.add_theme_font_size_override("bold_font_size", size)
	node.add_theme_font_size_override("font_size", size)
