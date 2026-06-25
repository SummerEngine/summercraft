# SummerCraft — UI component contract

> This file is the **mini-contract** for the 2D command center. The Hud shell and every
> 2D component obey it. It freezes (1) each component's API — the methods the shell calls
> down and the signals it emits up; (2) how the shell feeds the **frozen `/world` data**
> in; and (3) the complete **sound-event vocabulary**. Additive only — never change a
> listed signature.
>
> Scope: **2D screen-space only** (CanvasLayer). The 3D world, voice, and sidecar
> are reached only through the frozen seams in the Hud autoload.

---

## 0. Layout of the package

```
scripts/ui_theme.gd            SummerUI   — design tokens + StyleBox/Theme builders (theme)
scripts/ui/juice.gd            Juice      — 2D motion helpers (honours reduced_motion)
scripts/ui/ui_sounds.gd        UiSounds   — THE SOUND BOARD (single source of truth for UI sound)
scripts/ui/fleet_roster.gd     FleetRoster— fleet list + project-overview tabs
scripts/ui/diff_view.gd        DiffView   — unified-diff renderer
scripts/ui/pending_tray.gd     PendingTray— permissions / pending / merge-ritual surface
scripts/ui/dive_overlay.gd     DiveOverlay— first-person conversation surface
scripts/interaction_panel.gd   (card)     — per-agent command card shell + transcript; hosts a DiffView
scripts/hud.gd                 Hud        — the CanvasLayer shell + autoload (the frozen seam)
scenes/ui/*.tscn               one scene per component above
scenes/interaction_panel.tscn  the card scene (DiffSection now hosts a DiffView at DiffHost)
scenes/hud.tscn                the Hud root
```

**Ownership rule:** the shell (`hud.gd`) is the ONLY node B talks to. The shell instances the
components, feeds them the frozen feed, connects their UP signals, and relays them OUT as the
frozen contract signals. Components never touch the sidecar, the 3D world, the voice files, or
each other — they are leaves hanging off the shell.

---

## 1. The frozen Hud seam (UNCHANGED — §5.3 of the master plan)

`hud.gd` (the `Hud` autoload) is the integration seam. **These signatures are law; B depends on
them; do not change them.**

```gdscript
# methods B calls DOWN
Hud.set_world(snapshot: Dictionary)        # the WorldSnapshot each ~1s poll
Hud.show_agent(view: Dictionary)           # open the card for an AgentView
Hud.update_agent(view: Dictionary)         # refresh the open agent in place
Hud.show_diff(agent_id: String, text: String)  # raw git diff text -> the card's DiffView
Hud.hide()                                 # close the card (NOT the layer); shadows CanvasLayer.hide
Hud.enter_dive(agent_id: String)           # begin the first-person dive overlay
Hud.exit_dive()                            # end the dive

# signals B connects UP
signal prompt_submitted(agent_id: String, text: String)
signal talk_requested(agent_id: String)
signal diff_requested(agent_id: String)
signal merge_requested(project_id: String)
signal approve(agent_id: String)
```

**Additive (announced, breaks no existing shape):**
```gdscript
Hud.caption(agent_id: String, text: String)   # a voice caption -> dive history + card transcript
Hud.set_speaking(agent_id: String, on: bool)   # voice speaking tell -> dive visualiser
signal dive_exit_requested(agent_id: String)   # the on-screen "Leave" button during a dive
```

The shell fans these to the components: `set_world` → FleetRoster + PendingTray (+ live card);
`show_agent`/`update_agent`/`show_diff` → the card; `enter_dive`/`exit_dive`/`caption`/
`set_speaking` → DiveOverlay; component UP signals are relayed back out as the signals above.

---

## 2. How the frozen `/world` data flows in

The shell receives the frozen **`WorldSnapshot`** (`sidecar/contract.ts`) and hands the relevant
slice to each component. **Every nullable field is null-safe via `SummerUI.s(v, default)`** —
`current_task` and `target_base_id` are `string | null`; never call `String(null)`.

```
WorldSnapshot {
  agents: AgentView[]   // -> FleetRoster.set_world, PendingTray.set_world, card.update_agent
  locks:  LockView[]    // -> FleetRoster.set_locks, PendingTray.set_world (holder lookup)
  events: CoordEvent[]  // (shell may surface errors / aiven beats; not required by components)
}

AgentView {
  agent_id, repo_id, repo_path, character_kind: "viking|wizard|dwarf|barbarian",
  state: "waiting|moving|working|blocked|done", label, status_line,
  current_task: string|null, target_base_id: string|null,
  heartbeat_age_s: number,  // > 15 == stale (components may dim a stale chip)
  transcript_tail: string[]
}
LockView   { repo_path, file_path, holder_agent_id, claimed_at }
```

Diffs/context arrive **out of band** (the shell asks B, B fetches, hands text back):
- `AgentDiff.diff` (string) → `Hud.show_diff` → card → `DiffView.set_diff`.
- `AgentContext` (branch / base_branch / pr_url / diff / files) → `DiveOverlay.enter`/`update_context`.

**State semantics (from `SummerUI.state_palette` / `awaits_approval`):** `done` is the
"awaiting review" state — it drives every Approve affordance and the merge eligibility.
`blocked` drives the lock badge + `lock_slam`. Components key all visuals off `state`.

**Polling discipline (production checklist):** components **upsert in place** keyed by
`agent_id` / `repo_id` / `project_id`; they rebuild a list ONLY when the membership set
changes; never clear-and-refill (that flickers and drops focus/scroll). Zero per-frame
allocations — reuse the `_chips` / `_rows` / `_order` mirrors.

---

## 3. Component APIs (DOWN = shell calls; UP = signals to shell)

### `SummerUI` — `scripts/ui_theme.gd` (theme)
Static design-token + builder library. Single source of the look (warm "sun" accent over dark
glass). All components style through it; no inline colors.
- **Tokens:** `BG_GLASS/BG_GLASS_SOFT/BG_SOLID/BG_INPUT/BG_CHIP`, `BORDER/BORDER_HI/BORDER_FOCUS`,
  `TEXT/TEXT_DIM/TEXT_FAINT`, `ACCENT/ACCENT_HI/ACCENT_LO/ACCENT_TEXT`, `BLUE*`, `OK_GREEN`,
  `DANGER`, `DIFF_ADD/DIFF_DEL/DIFF_META/DIFF_CTX/DIFF_FAINT`.
- **StyleBoxes:** `sb(bg, radius, border, border_w, pad)`, `pill(bg, radius, padx, pady)`.
- **Buttons:** `accent_button / primary_button / ghost_button / success_button / icon_button`
  (each sets normal/hover/pressed/focus/disabled + font colors).
- **Semantics:** `state_palette(state) -> {bg, fg, label, dot}`, `awaits_approval(state) -> bool`,
  `kind_color(kind) -> Color`, `kind_glyph(kind) -> String`, `s(v, def) -> String` (null-safe).
- **Additive (planned):** `theme() -> Theme` (a generated Theme resource), a custom-font loader
  (falls back to the default font when absent), and a `reduced_motion` flag mirror that `Juice`
  reads. Add these to `ui_theme.gd` only; do not fork the tokens elsewhere.

### `Juice` — `scripts/ui/juice.gd` (motion)
Static, allocation-light tween helpers. **Honours `Juice.reduced_motion`** — when true every
helper applies the END state instantly. The convention is "Juice for motion, UiSounds for sound"
at the same call site; Juice never plays audio.
- `reduced_motion: bool` (static) — master accessibility switch.
- `pop(node, time=POP_TIME)` — appear (scale-up + fade, back-ease). New chip / opening card.
- `pulse(node, strength=1.06, time=PULSE_TIME)` — "something changed here" bump. State flips.
- `slide_in(node, from: Vector2, time=SLIDE_TIME)` — slide from an edge + fade. Card / tray.
- `flash(node: CanvasItem, color, time=FLASH_TIME)` — brief tint then back. Fresh diff / error row.
- `done_cheer(node)` — pop + warm accent flash (+ hop). Agent → `done`. Pairs `UiSounds "done_cheer"`.
- `lock_slam(node)` — heavy overshoot + danger flash. Agent → `blocked`. Pairs `UiSounds "blocked"`.
- `idle_bob(node, amplitude=3, time=BOB_TIME) -> Tween` — looping gentle bob; returns the Tween to
  `.kill()` on leaving idle; `null` under reduced motion.
- `stop(tw: Tween)` — safely kill a stored looping tween before starting a new one.

### `UiSounds` — `scripts/ui/ui_sounds.gd` (the sound board) — see §4 for the full vocabulary
- `play(event: String, pitch := 1.0)` — the ONLY entry point every component calls. Silent no-op
  if the asset is missing/unknown. Lazily bootstraps an AudioStreamPlayer pool under the scene-tree
  root — **no autoload needed**. `ResourceLoader.exists()`-guarded; never errors on missing assets.
- `path_for(event) -> String`, `has_asset(event) -> bool`, `EVENTS` (the self-documenting table).

### `FleetRoster` — `scripts/ui/fleet_roster.gd` + `scenes/ui/fleet_roster.tscn`
Left-rail fleet list + project-overview tabs. Upserts chips in place (no flicker / no focus loss).
- **DOWN:** `set_world(snapshot)`, `set_selected(agent_id)`, `set_locks(locks)`,
  `focus_project(project_id)`, `selected() -> String`.
- **UP:** `chip_selected(agent_id)` → shell `Hud.show_agent`; `approve_pressed(agent_id)` → shell
  `approve`; `project_selected(project_id)` (additive) → shell may scope the tray.
- Chips show: kind dot (`kind_color`), name, status sub-line, state pill (`state_palette`),
  blocked/locked badge (from `locks[]`), Approve ✓ when `awaits_approval(state)`.

### `DiffView` — `scripts/ui/diff_view.gd` + `scenes/ui/diff_view.tscn`
Unified-diff renderer; hosted by the card (and reusable in the dive). No sidecar comms.
- **DOWN:** `set_diff(text, truncated_hint := false)`, `set_loading()`, `set_error(message)`,
  `clear()`, `stat() -> Vector2i` (adds, dels).
- Renders per-file sections, +/- gutter colors (`DIFF_*`), hunk headers, mono font, an
  additions/deletions stat, loading/empty/error states, and truncates past `MAX_LINES (≈800)`
  with a "+N more lines" notice.
- **UP:** none — it is a pure renderer; the request for fresh text is the host's job.

### `PendingTray` — `scripts/ui/pending_tray.gd` + `scenes/ui/pending_tray.tscn`
The "what needs me" surface: awaiting-review queue, blocked-on-lock surfacing, and the per-project
town-hall MERGE RITUAL. Upserts rows in place.
- **DOWN:** `set_world(snapshot)`, `set_open(open: bool)`, `pending_count() -> int`.
- **UP:** `approve(agent_id)` → shell `approve`; `reject(agent_id)` (additive); `merge_project(project_id)`
  → shell `merge_requested`; `focus_agent(agent_id)` → shell `Hud.show_agent`.
- Review rows = `state == done`; blocked rows = `state == blocked` × `locks[]` (shows holder);
  a project shows a Merge button once it has reviewable work.

### `DiveOverlay` — `scripts/ui/dive_overlay.gd` + `scenes/ui/dive_overlay.tscn`
The first-person conversation surface. Driven by the shell from the frozen feed + C's context +
the WS relay caption/speaking events.
- **DOWN:** `enter(agent_id, view, context := {})`, `exit()`, `push_caption(text)`,
  `set_speaking(on)`, `update_context(view, context := {})`, `agent_id() -> String`.
- **UP:** `exit_requested(agent_id)` → shell `dive_exit_requested` / `Hud.exit_dive` (B reverses camera).
- Shows: context ribbon (label · persona · branch · PR · task · diff-stat), caption HISTORY
  (last `CAPTION_HISTORY ≈ 6` lines, older fading), a speaking visualiser, a cinematic vignette,
  smooth enter/exit tweens.

### `InteractionPanel` (card) — `scripts/interaction_panel.gd` + `scenes/interaction_panel.tscn`
The per-agent command card shell + transcript; **hosts a `DiffView`** at `DiffSection/DiffHost`.
**Frozen local API (KEEP — B is mid-migration):**
- **DOWN:** `show_agent(agent)`, `update_agent(agent)`, `hide_panel()`, `append_line(text)`,
  `get_agent_id() -> String`, `set_compact(on)`, `show_diff(text)`.
- **UP:** `send_prompt(agent_id, prompt)`, `request_voice(agent_id)`, `diff_requested(agent_id)`,
  `approve_requested(agent_id)`, `merge_requested(project_id)`, `closed()`.
- Owns the header (label · persona · repo · task · status pill · close), the role-coloured
  transcript (autoscroll + optimistic "you: …" echo merge that survives the poll), the actions
  row (Diff / Approve / Merge) and the input (Send + Talk). `show_diff(text)` forwards to the
  hosted `DiffView`. `set_compact(true)` folds the transcript for the dive.

---

## 4. The sound-event vocabulary (the SINGLE source of truth)

Defined in `scripts/ui/ui_sounds.gd` as `const EVENTS`. Every component calls
`UiSounds.play("<key>")` at the named site; **no component plays audio itself.** Assets live at
`res://audio/ui/<key>.ogg` (Mathias adds them later; missing = silent, never an error).

| key            | asset                          | PURPOSE — WHEN IT FIRES |
|----------------|--------------------------------|-------------------------|
| `click`        | `res://audio/ui/click.ogg`        | Primary button press — Send / Diff / tab / any committing tap. The workhorse. |
| `hover`        | `res://audio/ui/hover.ogg`        | Pointer enters an interactive control. Soft, very quiet; fires often. |
| `select`       | `res://audio/ui/select.ogg`       | A fleet chip / agent is selected and its card opens. |
| `panel_open`   | `res://audio/ui/panel_open.ogg`   | The card / a tray slides into view. Pairs `Juice.slide_in`/`pop`. |
| `panel_close`  | `res://audio/ui/panel_close.ogg`  | The card / tray is dismissed (close button, deselect). |
| `send`         | `res://audio/ui/send.ogg`         | A typed prompt is submitted (Send button or Enter). |
| `approve`      | `res://audio/ui/approve.ogg`      | An awaiting-review item is approved (card / roster / tray ✓). |
| `reject`       | `res://audio/ui/reject.ogg`       | An awaiting-review item is rejected / sent back (tray ✗). |
| `merge`        | `res://audio/ui/merge.ogg`        | The town-hall MERGE RITUAL fires for a project. Ceremonial. |
| `tab_switch`   | `res://audio/ui/tab_switch.ogg`   | The active project/overview tab changes. A quick flick. |
| `state_working`| `res://audio/ui/state_working.ogg`| An agent transitions INTO `working` (chip/card pulse). |
| `done_cheer`   | `res://audio/ui/done_cheer.ogg`   | An agent finishes → `done`/REVIEW. Pairs `Juice.done_cheer`. |
| `blocked`      | `res://audio/ui/blocked.ogg`      | An agent becomes `blocked` (lost a lock). Pairs `Juice.lock_slam`. |
| `dive_in`      | `res://audio/ui/dive_in.ogg`      | The first-person dive begins (`enter_dive`). Cinematic whoosh. |
| `dive_out`     | `res://audio/ui/dive_out.ogg`     | The dive ends (`exit_dive` / Leave). Reverse whoosh. |
| `caption_tick` | `res://audio/ui/caption_tick.ogg` | A new voice caption lands in the dive history. Tiny tick. |
| `error`        | `res://audio/ui/error.ogg`        | A surfaced error (ServerEvent `error` / failed action). |

To add/replace a sound: drop the `.ogg` at the path above — no code change. To rename/redirect,
edit the `path` in `EVENTS`. The `doc` field on each entry restates PURPOSE + WHEN inline so the
file alone is the briefing.

---

## 5. Production checklist (every component satisfies)

- **Responsive** at portrait `720x1280` and landscape projector — anchors/containers, not magic px.
- **Zero per-frame allocations** — reuse state mirrors; upsert in place; rebuild only on membership change.
- **No flicker / no focus loss** on the 1s poll — never clear-and-refill a live list.
- **Graceful empty / missing / stale data** — explicit empty states; `SummerUI.s()` on every nullable.
- **Legible across a room** — fixed-size crisp labels, generous spacing, the state obvious at a glance.
- **Juice on every state change** + a **`UiSounds.play(...)` at every interaction site.**
- **Theme ONLY via `SummerUI`, motion ONLY via `Juice`, UI sound ONLY via `UiSounds`.**
