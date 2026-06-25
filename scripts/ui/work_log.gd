extends Control
# WorkLog — a small frosted "session activity" card that streams an agent's live tool calls
# (⚙ Read / Edit / Bash …) so you can WATCH Claude work, not just see the result. Fed by Hud.activity().
#
# Deliberately dumb + crash-proof: a FIXED pool of Labels created once in _ready() and only ever has its
# .text reassigned — no dynamic add_child, no move_child, no pop on a detached node (the bugs that bit the
# roster). Hidden until activity arrives; auto-hides after a quiet spell. No class_name (preload-const bound).
const Juice := preload("res://scripts/ui/juice.gd")

const KEEP := 6          # how many recent tool lines to show
const IDLE_HIDE_S := 10.0 # hide the card this long after the last activity (the turn went quiet)

var _bg: PanelContainer
var _header: Label
var _lines: Array[Label] = []
var _hide_t: float = 0.0

func _ready() -> void:
	# Left side, below the FLEET roster. A little card, same frosted style as the rest.
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	offset_left = 24.0
	offset_top = 384.0
	custom_minimum_size = Vector2(300, 0)
	mouse_filter = Control.MOUSE_FILTER_IGNORE

	_bg = PanelContainer.new()
	_bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	SummerUI.attach_frost(_bg, SummerUI.BG_GLASS, 14, 12)
	add_child(_bg)

	var col := VBoxContainer.new()
	col.add_theme_constant_override("separation", 4)
	col.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_bg.add_child(col)

	_header = _mk(" ✦ working…", SummerUI.FS_LABEL, SummerUI.TEXT)
	col.add_child(_header)
	for _i in KEEP:
		var l := _mk("", SummerUI.FS_MICRO, SummerUI.TEXT_DIM)
		col.add_child(l)
		_lines.append(l)

	visible = false

func _mk(t: String, sz: int, c: Color) -> Label:
	var l := Label.new()
	l.text = t
	l.add_theme_font_size_override("font_size", sz)
	l.add_theme_color_override("font_color", c)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.clip_text = true
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l

# Append one tool call to the feed (newest at the bottom), fade older ones, show the card.
func set_activity(_agent_id: String, tool: String, summary: String) -> void:
	if _lines.is_empty():
		return
	for i in range(_lines.size() - 1):
		_lines[i].text = _lines[i + 1].text
		_lines[i].add_theme_color_override("font_color", SummerUI.TEXT_FAINT)
	var line := "⚙ %s" % tool
	if summary != "":
		line = "⚙ %s: %s" % [tool, summary]
	var newest := _lines[_lines.size() - 1]
	newest.text = line
	newest.add_theme_color_override("font_color", SummerUI.TEXT)
	_hide_t = IDLE_HIDE_S
	visible = true
	if not Juice.reduced_motion:
		Juice.pulse(_header)

func _process(delta: float) -> void:
	if not visible:
		return
	if _hide_t > 0.0:
		_hide_t -= delta
		if _hide_t <= 0.0:
			_clear()

func _clear() -> void:
	visible = false
	for l in _lines:
		l.text = ""
