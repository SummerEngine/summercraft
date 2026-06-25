extends ColorRect
# FrostRect — the frosted-glass backing layer (Chat D). A ColorRect that fills its
# parent panel, runs ui_frost.gdshader (blurs + tints the diorama behind, masked to
# a rounded rect), and keeps the shader's rect_size/radius in sync on resize so the
# rounded mask always matches the panel. Add it as the BACKMOST child of a panel
# whose own stylebox is just a hairline border + transparent fill.
#
# No class_name (scripts/ui is outside the global class cache — see commit 82aa023);
# SummerUI builds these via preload. Built through SummerUI.frost_rect() so the
# tint/blur defaults stay in one place.

const FROST_SHADER := preload("res://scripts/ui/ui_frost.gdshader")

var radius: float = 18.0

func _init() -> void:
	# Build the material up-front so callers can set tint/radius before _ready.
	var m := ShaderMaterial.new()
	m.shader = FROST_SHADER
	material = m

func _ready() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	color = Color(1, 1, 1, 1)  # the shader writes the final colour; this is just coverage
	resized.connect(_sync)
	_sync()

func set_tint(tint: Color) -> void:
	if material is ShaderMaterial:
		(material as ShaderMaterial).set_shader_parameter("tint", tint)

func set_radius(r: float) -> void:
	radius = r
	_sync()

func _sync() -> void:
	if material is ShaderMaterial:
		var m := material as ShaderMaterial
		m.set_shader_parameter("rect_size", size)
		m.set_shader_parameter("radius", radius)
