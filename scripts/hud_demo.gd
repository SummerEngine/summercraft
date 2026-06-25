extends Node
# ============================================================================
#  hud_demo — DEV-ONLY state-matrix test bed for Chat D (The Interface).
#
#  Exercises the whole HUD shell with NO sidecar / A / B / C. It instantiates the
#  Hud scene, drives it with a cycling mock WorldSnapshot (frozen-contract shape)
#  that walks EVERY agent state (waiting / moving / working / blocked / done),
#  answers diff_requested with a big multi-file diff, streams captions into a dive,
#  toggles speaking, flips both orientations (portrait 720x1280 ↔ landscape
#  projector), and prints every contract signal so the seam is visible.
#
#  A tiny on-screen control strip (its own CanvasLayer above the Hud) documents
#  the keys and shows the live scenario; everything is also keyboard-driven:
#    [Space] pause/resume the poll      [N] step one poll
#    [1..5]  force a state on the focus  [R] randomize the fleet
#    [O]     toggle orientation          [F] cycle the focused agent
#    [D]     request a diff              [G] push a BIG diff straight in
#    [V]     dive        [B] leave dive   [C] push a caption   [S] toggle speaking
#    [P]     pending/merge scenario      [E] empty-world scenario
#    [T]     stale scenario (old heartbeats)
#
#  Not wired into project.godot / the main scene — purely a manual entry point.
#  Open scenes/hud_demo.tscn and press Play.
# ============================================================================

const HUD := preload("res://scenes/hud.tscn")

const PORTRAIT := Vector2i(720, 1280)
const LANDSCAPE := Vector2i(1600, 900)   # projector-ish landscape

# A deliberately BIG multi-file diff so DiffView truncation + perf are exercised.
const SAMPLE_DIFF := """diff --git a/src/auth.ts b/src/auth.ts
index 8c1f2a1..b2e9d44 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -12,6 +12,11 @@ export async function handler(req: Request) {
-  return new Response("ok")
+  if (!req.headers.get("authorization")) {
+    return new Response("unauthorized", { status: 401 })
+  }
+  const user = await verify(req)
+  return Response.json({ user })
 }
@@ -40,3 +45,9 @@ function verify(req: Request) {
-  return null
+  const token = req.headers.get("authorization")?.replace("Bearer ", "")
+  if (!token) return null
+  return jwt.verify(token, SECRET)
 }
diff --git a/src/db.ts b/src/db.ts
index 1111111..2222222 100644
--- a/src/db.ts
+++ b/src/db.ts
@@ -1,4 +1,7 @@
-import pg from "pg"
+import pg from "pg"
+import { z } from "zod"
+
+const RowSchema = z.object({ id: z.string(), name: z.string() })
 export const pool = new pg.Pool()
diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,4 @@
 # Project
-TODO
+## Auth
+Requests must carry a Bearer token; see src/auth.ts.
+Run `npm test` before pushing."""

var _hud: CanvasLayer
var _info: Label

# Scenario state.
var _phase := 0
var _focus := "a1"
var _speaking := false
var _paused := false
var _portrait := false
var _forced_state := ""        # "" == cycle; otherwise pin the focus agent's state
var _scenario := "fleet"       # "fleet" | "pending" | "empty" | "stale"
const _CYCLE := ["waiting", "moving", "working", "blocked", "done"]

func _ready() -> void:
	_build_backdrop()  # faux diorama so the frosted-glass blur is visible in isolation
	_hud = HUD.instantiate()
	add_child(_hud)
	_hud.prompt_submitted.connect(func(id, t): print("[seam] prompt_submitted  ", id, "  -> ", t))
	_hud.talk_requested.connect(func(id): print("[seam] talk_requested  ", id))
	_hud.diff_requested.connect(_on_diff_requested)
	_hud.merge_requested.connect(func(pid): print("[seam] merge_requested  ", pid))
	_hud.approve.connect(func(id): print("[seam] approve  ", id))
	if _hud.has_signal("rejected"):
		_hud.rejected.connect(func(id): print("[seam] rejected  ", id))
	_hud.dive_exit_requested.connect(func(id):
		print("[seam] dive_exit_requested  ", id)
		# In production B reverses the camera FIRST, then calls exit_dive — so the
		# Leave button is pressed while the overlay is still up for a beat. Emulate
		# that latency instead of exiting synchronously, so the dive-exit feel (any
		# flicker / double-press / sound during the window) is rehearsed honestly.
		await get_tree().create_timer(0.25).timeout
		_hud.exit_dive())

	_build_info_strip()
	_apply_orientation()
	_tick()

	var t := Timer.new()
	t.wait_time = 1.0
	t.autostart = true
	t.timeout.connect(func(): if not _paused: _tick())
	add_child(t)

	# Open a card on launch so the surface is populated.
	await get_tree().create_timer(0.3).timeout
	if _agents_for_scenario().size() > 0:
		_hud.show_agent(_agents_for_scenario()[0])
	print("hud_demo ready — see the on-screen key strip. [Space] pause · [O] orient · [V] dive · [P] pending")

# A stand-in diorama behind the HUD (layer 0) so the frost shader has a warm,
# structured backdrop to blur — the real game renders the 3D world here.
func _build_backdrop() -> void:
	var layer := CanvasLayer.new()
	layer.layer = 0
	add_child(layer)
	var g := Gradient.new()
	g.set_color(0, Color(0.42, 0.62, 0.82))
	g.set_color(1, Color(0.27, 0.46, 0.28))
	g.add_point(0.52, Color(0.40, 0.58, 0.42))
	var gt := GradientTexture2D.new()
	gt.gradient = g
	gt.fill_from = Vector2(0, 0)
	gt.fill_to = Vector2(0, 1)
	gt.width = 16
	gt.height = 256
	var sky := TextureRect.new()
	sky.texture = gt
	sky.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	sky.stretch_mode = TextureRect.STRETCH_SCALE
	sky.mouse_filter = Control.MOUSE_FILTER_IGNORE
	layer.add_child(sky)
	# a few soft "buildings" so the blur has shape to soften
	for spec in [Vector3(360, 470, 70), Vector3(820, 430, 40), Vector3(560, 560, 95)]:
		var b := ColorRect.new()
		b.color = Color(0.80, 0.66, 0.42, 0.92)
		b.size = Vector2(190, 140)
		b.position = Vector2(spec.x, spec.y)
		b.rotation = deg_to_rad(spec.z * 0.0)
		b.mouse_filter = Control.MOUSE_FILTER_IGNORE
		layer.add_child(b)

# ── On-screen control + scenario readout ─────────────────────────────────────
func _build_info_strip() -> void:
	var layer := CanvasLayer.new()
	layer.layer = 50  # above the Hud (layer 12) so it never hides
	add_child(layer)
	var panel := PanelContainer.new()
	panel.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	panel.offset_left = 12
	panel.offset_bottom = -12
	panel.offset_top = -120
	panel.add_theme_stylebox_override("panel", SummerUI.sb(SummerUI.BG_GLASS, 10, SummerUI.BORDER, 1, 10))
	layer.add_child(panel)
	_info = Label.new()
	_info.add_theme_font_size_override("font_size", 12)
	_info.add_theme_color_override("font_color", SummerUI.TEXT_DIM)
	panel.add_child(_info)
	_refresh_info()

func _refresh_info() -> void:
	if _info == null:
		return
	_info.text = "SCENARIO %s   orient=%s   focus=%s   state=%s   %s\n[Space]pause [N]step [O]orient [F]focus [1-5]state [R]rand\n[D]diff [G]bigdiff [V]dive [B]leave [C]caption [S]speak\n[P]pending [E]empty [T]stale" % [
		_scenario.to_upper(),
		"portrait" if _portrait else "landscape",
		_focus,
		(_forced_state if _forced_state != "" else "cycle:" + _CYCLE[_phase]),
		("PAUSED" if _paused else "live"),
	]

func _apply_orientation() -> void:
	var win := get_window()
	if win == null:
		return
	var sz := PORTRAIT if _portrait else LANDSCAPE
	win.size = sz
	# Let the HUD's resize hooks fire.
	_refresh_info()

# ── Diff reply ────────────────────────────────────────────────────────────────
func _on_diff_requested(id: String) -> void:
	print("[seam] diff_requested  ", id, "  (replying with sample diff)")
	_hud.show_diff(id, SAMPLE_DIFF)

# ── Poll tick ─────────────────────────────────────────────────────────────────
func _tick() -> void:
	if _forced_state == "":
		_phase = (_phase + 1) % _CYCLE.size()
	_hud.set_world(_snapshot())
	_refresh_info()

func _unhandled_input(event: InputEvent) -> void:
	if not (event is InputEventKey and event.pressed and not event.echo):
		return
	match event.keycode:
		KEY_SPACE:
			_paused = not _paused
		KEY_N:
			_tick()
		KEY_O:
			_portrait = not _portrait
			_apply_orientation()
		KEY_F:
			_focus = _next_focus()
		KEY_R:
			_forced_state = ""
			_phase = randi() % _CYCLE.size()
			_tick()
		KEY_1: _force_state("waiting")
		KEY_2: _force_state("moving")
		KEY_3: _force_state("working")
		KEY_4: _force_state("blocked")
		KEY_5: _force_state("done")
		KEY_D:
			# Open the card and push a diff through the seam (show_diff path).
			_hud.show_agent(_first_with_id(_focus))
			_hud.show_diff(_focus, SAMPLE_DIFF)
		KEY_G:
			_hud.show_agent(_first_with_id(_focus))
			_hud.show_diff(_focus, SAMPLE_DIFF)
		KEY_V:
			_hud.enter_dive(_focus)
			# Feed the context in the REAL seam shape (branch/base_branch/pr_url/diff/
			# files per INTERFACES.md §2) — NOT literal adds/dels ints. dive_overlay's
			# _diff_stat falls back to counting +/- lines in the `diff` string when no
			# adds/dels are present, so giving it the actual diff rehearses the
			# production stat path (the seam never delivers pre-counted ints).
			_hud.set_context(_focus, {
				"branch": "feat/auth-guard",
				"base_branch": "main",
				"pr_url": "https://github.com/acme/web/pull/142",
				"diff": SAMPLE_DIFF,
				"files": ["src/auth.ts", "src/db.ts", "README.md"],
			})
			_hud.caption(_focus, "Looking at the auth handler now — I'll add the 401 guard and a verify() call.")
		KEY_B:
			_hud.exit_dive()
		KEY_C:
			_hud.caption(_focus, _random_caption())
		KEY_S:
			_speaking = not _speaking
			_hud.set_speaking(_focus, _speaking)
		KEY_P:
			_scenario = "pending"
			_tick()
		KEY_E:
			_scenario = "empty"
			_tick()
		KEY_T:
			_scenario = "stale"
			_tick()
	_refresh_info()

func _force_state(s: String) -> void:
	_forced_state = s
	_scenario = "fleet"
	_tick()

func _next_focus() -> String:
	var ids := []
	for a in _agents_for_scenario():
		ids.append(a["agent_id"])
	if ids.is_empty():
		return _focus
	var i := ids.find(_focus)
	return ids[(i + 1) % ids.size()]

func _random_caption() -> String:
	var lines := [
		"Done. Pushed the change to the branch and opened a PR for review.",
		"Running tsc — no type errors. Adding a test for the unauthorized path.",
		"I need src/db.ts but Bjorn holds the lock; I'll wait or take another task.",
		"Committed the guard. Want me to merge, or hold for your review?",
	]
	return lines[randi() % lines.size()]

# ── Mock feed (frozen /world shape) ──────────────────────────────────────────
func _snapshot() -> Dictionary:
	match _scenario:
		"empty":
			return {"agents": [], "locks": [], "events": []}
		"pending":
			return _pending_snapshot()
		"stale":
			return _stale_snapshot()
		_:
			return _fleet_snapshot()

func _fleet_snapshot() -> Dictionary:
	var s: String = _forced_state if _forced_state != "" else _CYCLE[_phase]
	return {
		"agents": [
			_agent("a1", "Vinny", "web", "viking", s, "add auth guard", _tail(s)),
			_agent("a2", "Merlin", "engine", "wizard", "blocked", "refactor auth", ["wanted auth.ts", "denied: locked by Vinny"]),
			_agent("a3", "Durin", "templates", "dwarf", "waiting", "", []),
			_agent("a4", "Bjorn", "web", "barbarian", "working", "write tests", ["reading handler.test.ts"]),
			_agent("a5", "Sigrún", "engine", "viking", "done", "fix shader warns", ["patched 3 warnings", "committed"]),
		],
		"locks": [{"repo_path": "/tmp/web", "file_path": "auth.ts", "holder_agent_id": "a1", "claimed_at": ""}],
		"events": [{"ts": "", "type": "file_claimed", "agent_id": "a1", "detail": "auth.ts"}],
	}

# Several done (awaiting review) + a blocked, so the PendingTray shows review rows,
# a blocked-on-lock row, AND the per-project merge ritual button.
func _pending_snapshot() -> Dictionary:
	return {
		"agents": [
			_agent("a1", "Vinny", "web", "viking", "done", "add auth guard", ["committed", "ready for review"]),
			_agent("a4", "Bjorn", "web", "barbarian", "done", "write tests", ["tests green", "committed"]),
			_agent("a2", "Merlin", "engine", "wizard", "blocked", "refactor auth", ["wanted shader.gd"]),
			_agent("a5", "Sigrún", "engine", "viking", "done", "fix shader warns", ["committed"]),
			_agent("a3", "Durin", "templates", "dwarf", "waiting", "", []),
		],
		"locks": [{"repo_path": "/tmp/engine", "file_path": "shader.gd", "holder_agent_id": "a5", "claimed_at": ""}],
		"events": [],
	}

# Old heartbeats so every surface dims the stale rows/chips.
func _stale_snapshot() -> Dictionary:
	var a := _fleet_snapshot()
	for v in a["agents"]:
		v["heartbeat_age_s"] = 42
	return a

func _agents_for_scenario() -> Array:
	return _snapshot().get("agents", [])

func _first_with_id(id: String) -> Dictionary:
	for a in _agents_for_scenario():
		if a["agent_id"] == id:
			return a
	# Fallback so a focus that isn't in the current scenario still opens something.
	var arr := _agents_for_scenario()
	return arr[0] if arr.size() > 0 else {"agent_id": id}

func _agent(id: String, label: String, repo: String, kind: String, state: String, task := "", tail := []) -> Dictionary:
	return {
		"agent_id": id, "repo_id": repo, "repo_path": "/tmp/%s" % repo,
		"character_kind": kind, "state": state, "label": label,
		"status_line": _status_for(state, task), "current_task": (task if task != "" else null),
		"target_base_id": repo, "heartbeat_age_s": 1, "transcript_tail": tail,
	}

func _status_for(state: String, task: String) -> String:
	match state:
		"working": return "editing auth.ts"
		"moving": return "walking to web"
		"blocked": return "blocked on lock: auth.ts"
		"done": return "done — awaiting review"
		_: return "idle" if task == "" else "queued: %s" % task

func _tail(state: String) -> Array:
	match state:
		"working": return ["reading auth.ts", "writing handler", "running tsc"]
		"done": return ["reading auth.ts", "writing handler", "tsc clean", "committed"]
		"blocked": return ["wanted auth.ts", "denied: held by Vinny"]
		"moving": return ["walking to web building"]
		_: return ["reading auth.ts"]
