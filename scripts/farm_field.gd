extends Node3D
class_name FarmField
# A per-repo farm: a flat grid of plots laid out around `center`, plus a simple soil tile + low
# fence built in code (no asset dependency). claim_plot() hands out the next free plot; plant()
# drops a model on a plot and floats the commit message above it (fixed_size billboard, like
# lock_overlay.gd). world_manager owns one FarmField per repo and drives it from the /world feed.

const SOIL := Color(0.46, 0.34, 0.22, 1.0)
const FENCE := Color(0.92, 0.92, 0.9, 1.0)

var _plots: Array = []        # Array[Vector3] plot world positions, row-major
var _used: int = 0            # next free plot index

# Build the grid centred on `center`: cols x rows plots spaced `cell` apart, plus soil + fence.
func setup(center: Vector3, cols: int, rows: int, cell: float) -> void:
	_plots.clear()
	_used = 0
	var w := (cols - 1) * cell
	var h := (rows - 1) * cell
	for r in range(rows):
		for c in range(cols):
			var p := center + Vector3(c * cell - w * 0.5, 0.0, r * cell - h * 0.5)
			p.y = 0.0
			_plots.append(p)
	_build_soil(center, w + cell, h + cell)
	_build_fence(center, w + cell, h + cell)

func has_free() -> bool:
	return _used < _plots.size()

func plot_count() -> int:
	return _plots.size()

# Hand out the next free plot's world position, or null when the field is full.
func claim_plot():
	if not has_free():
		return null
	var p: Vector3 = _plots[_used]
	_used += 1
	return p

# Drop `model` on the plot and float `label_text` above it (the commit message).
func plant(at: Vector3, model: Node3D, label_text: String) -> void:
	if model == null:
		return
	add_child(model)
	model.global_position = at
	if label_text.strip_edges() != "":
		var tag := Label3D.new()
		tag.text = label_text
		tag.font_size = 40
		tag.pixel_size = 0.0035
		tag.fixed_size = true
		tag.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		tag.no_depth_test = true
		tag.outline_size = 8
		tag.modulate = Color(1, 1, 1, 0.96)
		tag.position = at + Vector3(0.0, 2.4, 0.0)
		add_child(tag)

func _build_soil(center: Vector3, w: float, h: float) -> void:
	var mi := MeshInstance3D.new()
	var pm := PlaneMesh.new()
	pm.size = Vector2(w, h)
	mi.mesh = pm
	var mat := StandardMaterial3D.new()
	mat.albedo_color = SOIL
	mat.roughness = 1.0
	mi.material_override = mat
	mi.position = center + Vector3(0.0, 0.02, 0.0)   # just above the grass
	add_child(mi)

func _build_fence(center: Vector3, w: float, h: float) -> void:
	# Four thin box rails around the field perimeter.
	var mat := StandardMaterial3D.new()
	mat.albedo_color = FENCE
	var rails := [
		[Vector3(0, 0.25, -h * 0.5), Vector3(w, 0.5, 0.1)],
		[Vector3(0, 0.25, h * 0.5), Vector3(w, 0.5, 0.1)],
		[Vector3(-w * 0.5, 0.25, 0), Vector3(0.1, 0.5, h)],
		[Vector3(w * 0.5, 0.25, 0), Vector3(0.1, 0.5, h)],
	]
	for r in rails:
		var mi := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = r[1]
		mi.mesh = bm
		mi.material_override = mat
		mi.position = center + r[0]
		add_child(mi)
