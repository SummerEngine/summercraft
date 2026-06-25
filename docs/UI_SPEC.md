# SummerCraft — 2D UI Spec (Chat D target)

The single source of truth for what the 2D HUD should look + behave like. Every D component is brought to
THIS. Reference point: **Apple / Linear / OpenAI / Claude's own chat** — calm, precise, expensive. Built in
Godot 4.6 GDScript; all screen-space (CanvasLayer). NOT the 3D world (that's B).

---

## 1. Design language (non-negotiable)
- **Near-monochrome frosted glass.** Panels are translucent cool-charcoal (the `ui_frost.gdshader` blurs +
  desaturates the diorama behind them). NEVER opaque slabs, never muddy "playdough" mid-tones.
- **One accent.** A single cool indigo (`SummerUI.ACCENT`) for the primary action + selection ONLY. No gold.
- **Colour = signal, not decoration.** State is a small crisp status dot; labels stay neutral. No colored
  pills/borders sprayed around.
- **Type hierarchy is real + legible across a room.** Names pop (bold, large), meta recedes (muted, small).
  Bigger than before — `FS_BODY` ≥ 18. Section headers tiny + tracked.
- **Everything tweens** (Juice): selection pop, state pulse, done cheer, lock slam — but subtle, never janky.
- **Edges are clean.** Borderless frost with an AA'd shader rim (the mobile renderer has no 2D MSAA — a 1px
  stylebox border aliases on rounded corners). Generous padding, hairline separators.
- **A `UiSounds.play()` at every interaction site** (registry in `ui_sounds.gd`; silent until assets added).

## 2. The agent card + chat (`interaction_panel.gd` — the centerpiece)
This is the screenshot that has to look like Claude's chat.
- **Hard width clamp ~560px**, bottom-right, content-height capped, scrolls. NOTHING (path, long line) can
  ever expand it off-screen.
- **Header:** name (bold, `FS_TITLE`) · persona (muted, one line) · **SHORT repo name** (`repo_id`, clipped —
  NEVER the raw filesystem path) · a small state dot + neutral label top-right, **vertically aligned with the
  ✕ close**. No `⚠ stale · …` line. Stale ≠ a red warning.
- **Chat = real message bubbles:**
  - User turn → a rounded bubble, wrapped, **no `user:`/`you:` prefix shown**.
  - Agent turn → `✦` mark + full-width wrapped text, **no `agent:` prefix shown**.
  - Parser strips `you:` / `user:` / `agent:` / `(voice)` prefixes (server tail uses `user:`/`agent:`).
  - **`✦ thinking…`** row after you send, auto-hidden when the reply lands.
  - Autoscroll only when parked at bottom; wraps inside the card; never overflows.
- **Streaming-ready:** expose a render-in-place hook so partial agent text updates the last bubble in place
  (wire the D side; C emits partials — flag, don't fake).
- **Diff:** opens cleanly — NO "fly up then pop". Wrapped, syntax-coloured (softened DIFF_* tokens), scrolls.
- **Actions:** Diff · Approve (only when awaiting review). Merge hidden. Input: clean "Tell this agent…" + Send.

## 3. Fleet roster (`fleet_roster.gd`) — left rail
- Compact **content-hugging** card, floated inset, rounded — not a full-height slab.
- **Active = more visible:** working/moving/blocked/done chips read brighter + a small state-colour dot; idle
  recedes (dimmer fill). Selected = subtle accent hairline. No loud blocked-bar.
- In-place upsert (no flicker / no focus loss), legible at distance.

## 4. Pending tray (`pending_tray.gd`) — right
- Compact content-hugging card. Clean rows, **consistent padding + row height** (no cramped buttons, no
  "weird blocks"). Section headers quiet + tracked. Approve = the one accent; reject/focus = ghost.
- Merge ritual hidden. Empty state never collides with a section header/count.

## 5. Dive (`dive_overlay.gd`) — conversation
- Entering a dive **hides the roster + tray + card** — only the conversation shows (no overlay-box clutter).
- Centered ~720px reading column (not full width). Big legible type. Caption history with fade. Leave button.

## 6. Shell + theme (`hud.gd`, `ui_theme.gd`, `juice.gd`, `ui_sounds.gd`)
- `hud.gd`: thin shell, composes the components, frozen seam intact, content-hugging holders, connection pill
  (`Connecting…`/`Live`/`Offline`), tiny brand mark (no bloated top bar).
- `ui_theme.gd` (`SummerUI`): the ONLY palette/type/frost source. Bigger type scale. Frosted-ghost buttons,
  one filled-indigo primary.

## 7. Robustness gate (every component)
- Parse-clean (`summer_get_script_errors` = 0) AND runtime-clean (`summer_play hud_demo` → `summer_get_diagnostics`
  → 0 errors, not breaked). Null-safe on every AgentView field. Zero per-frame allocation on a steady poll.
  Responsive portrait 720x1280 + landscape. Preserve the preload-const binding (NO global class_name for
  Juice/UiSounds/DiffView).

## 8. Known bugs this pass must kill
- repo-path overflow expanding the card · the `⚠ stale · <prompt>` red line · bubble parser missing
  `user:`/`agent:` (prefixes showing) · diff "fly up then pop" · header status/close misalignment · tray
  cramped padding · text too small.

## 9. OUT OF SCOPE — cross-lane, do NOT touch (flag only)
- **B:** 3D world-space Label3D billboards overflowing (giant `current_task` / "op world_pulse succeeded"
  text across the field) — cap width + truncate; that's the 3D layer, not the 2D card.
- **C:** `voice_websocket.gd` `String(...)` crash on talk → `str(...)`; emit partial captions for streaming.
- **A:** the operator/Aiven "stale op … succeeded" log.
