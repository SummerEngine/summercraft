extends RefCounted
class_name PlantRegistry
# Asset-agnostic plant source. When Mathias drops plant GLBs into models/plants/, list their paths
# in MODELS and make_plant() instances a random one. Until then it returns a code-built sapling so
# the whole commit->plant loop works with zero art. ONE place to swap art in.

# e.g. "res://models/plants/sapling.glb", "res://models/plants/flower_tree.glb"
const MODELS: Array[String] = []

static func make_plant() -> Node3D:
	for _try in range(MODELS.size()):
		var path: String = MODELS[randi() % MODELS.size()]
		var ps = load(path)
		if ps != null:
			return ps.instantiate()
	return _placeholder()

# A cheap stylised sapling: a brown trunk + a green foliage sphere. Mobile-safe, no import.
static func _placeholder() -> Node3D:
	var root := Node3D.new()
	var trunk := MeshInstance3D.new()
	var cyl := CylinderMesh.new()
	cyl.top_radius = 0.06
	cyl.bottom_radius = 0.09
	cyl.height = 0.6
	trunk.mesh = cyl
	var tmat := StandardMaterial3D.new()
	tmat.albedo_color = Color(0.45, 0.31, 0.18, 1.0)
	trunk.material_override = tmat
	trunk.position = Vector3(0.0, 0.3, 0.0)
	root.add_child(trunk)
	var leaves := MeshInstance3D.new()
	var sph := SphereMesh.new()
	sph.radius = 0.45
	sph.height = 0.9
	leaves.mesh = sph
	var lmat := StandardMaterial3D.new()
	lmat.albedo_color = Color(0.30, 0.62, 0.26, 1.0)
	leaves.material_override = lmat
	leaves.position = Vector3(0.0, 0.95, 0.0)
	root.add_child(leaves)
	return root
