/**
 * AgentCraft — FROZEN STATE CONTRACT (scaffold step S4).
 *
 * The single seam between the four build tracks:
 *   A) Node sidecar      B) Godot client      C) voice shim      D) Aiven projection
 *
 * EVERY track builds against THIS. Do NOT change a shape without updating all four tracks.
 * The Godot mirror of this contract lives in scripts/sidecar_bridge.gd — keep them in sync.
 */

export const HOST = "127.0.0.1";
export const PORT = 8787;

export type CharacterKind = "viking" | "wizard" | "dwarf" | "barbarian";

/**
 * Animation status enum — drives the EXISTING Godot `_match_clip` substring system. No new art.
 *   waiting  -> idle clip
 *   moving   -> walk clip + lerp toward the target building
 *   working  -> attack / cast / hammer clip, looped
 *   blocked  -> idle clip + grey tint (lost an Aiven lock)
 *   done     -> one attack/cheer pulse + procedural hop -> idle
 */
export type AgentState = "waiting" | "moving" | "working" | "blocked" | "done";

export interface AgentView {
  agent_id: string;
  repo_id: string;
  repo_path: string;
  character_kind: CharacterKind;
  state: AgentState;
  label: string; // display name, e.g. "Vinny"
  status_line: string; // one-line human-readable status
  current_task: string | null;
  target_base_id: string | null;
  heartbeat_age_s: number; // seconds since last heartbeat; > 15 = stale
  transcript_tail: string[]; // last few transcript lines
  // Hierarchy parent links (DATA_MODEL.md: Agent → Project → Repo → Group). repo_id (above) already
  // names the agent's repo; project_id is the agent's DIRECT parent (the Claude Code project / working
  // dir it runs in); group_id is the group its repo rolls up to. ADDITIVE + optional: A populates them
  // where known; a consumer that predates the hierarchy simply ignores the extra fields. The theme maps
  // (level → asset); these ids never carry a theme.
  project_id?: string;
  group_id?: string | null;
  /**
   * The persistent CHARACTER (NPC) this Session belongs to (character-session model, ratified
   * 2026-06-25-character-session-model-design.md). ADDITIVE + optional — added exactly like project_id
   * above: a consumer that predates the character layer ignores it. In the current model each known agent
   * IS a character, so character_id == agent_id; the field is explicit so B/D can join a live Session
   * (AgentView) back to its Character in `characters[]` without assuming that identity.
   */
  character_id?: string;
}

/**
 * A persistent CHARACTER — the NPC you have a relationship with (name, persona, home). It OWNS ephemeral
 * Sessions (each = one Claude Code run / chat). It is ALWAYS present in the world: `asleep` at its home
 * project when idle, `working` while a Session is live. One active Session at a time (active_session_id).
 * "New chat" tears down the current Session + starts a fresh one; "send away" archives it + sleeps the
 * character. The character record + its session history survive both. See the ratified design doc.
 */
export interface Character {
  character_id: string;
  name: string; // display name, e.g. "Vinny" (mirrors the Session's `label`)
  persona: string; // short persona/role line; "" when none is configured
  home_project_id: string; // the project (HOUSE) the character lives at; B draws it there when asleep
  lifecycle: "asleep" | "working";
  /** The id of the live Session this character is running, or null when asleep (no live run). */
  active_session_id: string | null;
}

/**
 * One archived SESSION in a character's history (GET /agents/:id/sessions). A Session is one Claude Code
 * run; when it ends (send-away, or replaced by a new-session) its transcript is archived and summarized to
 * this. `ended_at` is null while the session is still live (it is the active one).
 */
export interface SessionSummary {
  session_id: string;
  character_id: string;
  summary: string; // short human summary of what the session did
  started_at: string; // ISO 8601
  ended_at: string | null; // ISO 8601; null while the session is still live
}

export interface LockView {
  repo_path: string;
  file_path: string;
  holder_agent_id: string;
  claimed_at: string; // ISO 8601
}

export interface CoordEvent {
  ts: string; // ISO 8601
  type: string; // file_claimed | file_claim_denied | released | heartbeat | ...
  agent_id: string;
  detail: string;
}

/** GET /world response. Godot polls this every ~1s (the demo-default transport). */
export interface WorldSnapshot {
  agents: AgentView[];
  locks: LockView[];
  events: CoordEvent[];
  /**
   * The persistent CHARACTERS (NPCs) in this world (character-session model). ADDITIVE — defaults to []
   * for any consumer/projection that predates it, so the frozen agents/locks/events behavior is unchanged.
   * B draws ONE NPC per character at its `home_project_id` (asleep when active_session_id is null; working,
   * driven by the linked AgentView Session, when set). This is the only thing that lets a SLEEPING character
   * be rendered — `agents` only carries LIVE Sessions, so without this a slept NPC would vanish.
   */
  characters: Character[];
}

/** WS: sidecar -> client. */
export type ServerEvent =
  | { type: "status"; agent_id: string; state: AgentState; status_line?: string }
  | { type: "text"; agent_id: string; text: string }
  | { type: "tool_start"; agent_id: string; tool: string; detail?: string }
  | { type: "tool_end"; agent_id: string; tool: string; ok: boolean }
  | { type: "aiven"; agent_id: string; event: CoordEvent }
  | { type: "activity"; agent_id: string; event: ActivityEvent } // anonymized work pulse -> Aiven/world
  /**
   * Mid-turn WORK PULSE for the HUD (Lane A observability). One per tool use the SDK streams during a
   * turn — `tool` is the SDK tool name (Bash/Edit/Read/…), `summary` a short human line ("Bash: npm run
   * dev", "Edit: index.html"). This is what D renders as "what it's doing" live. PRIVACY: NEVER carries
   * code, diffs, or file contents — only the tool name + a tiny path/command summary (same redaction as
   * tool_start's `detail`). Distinct from the anonymized `activity`/ActivityEvent above (which is the
   * content-free Aiven world pulse keyed by level_path); this one is local-HUD-only and per-tool.
   */
  | { type: "tool_activity"; agent_id: string; tool: string; summary: string; ts: string }
  /**
   * SERVICE event (Lane A): the agent's turn started/announced a local server (a localhost URL). Lets D
   * surface a clickable "open it" affordance and the voice tell the user the dev server is up. Best-effort
   * — parsed from the turn's result text; `port` is derived from the URL when present (else 0). Additive.
   */
  | { type: "service"; agent_id: string; url: string; port: number; ts: string }
  | { type: "result"; agent_id: string; summary: string }
  | { type: "speaking"; agent_id: string; speaking: boolean } // voice tell
  | { type: "caption"; agent_id: string; text: string } // voice caption
  /**
   * PR / approve / pending flow (ADDITIVE — L3, announced; does NOT change any existing shape). The
   * agent's work can pause for a human gate before it lands: A emits `pending` when an agent reaches a
   * point that needs review, `awaiting_approval` once a real PR has been opened (or is ready to open)
   * and the agent is parked, and `pr_opened` with the PR url when `gh` actually created one. D's HUD
   * renders these; an operator unblocks via POST /agents/:id/approve. All fields are optional beyond
   * the discriminant + agent_id so a client that doesn't know them ignores them harmlessly.
   */
  | { type: "pending"; agent_id: string; reason?: string }
  | { type: "awaiting_approval"; agent_id: string; pr_url?: string; summary?: string }
  | { type: "pr_opened"; agent_id: string; pr_url: string; branch?: string }
  | { type: "approved"; agent_id: string; by?: string }
  | { type: "error"; agent_id?: string; message: string };

/** WS: client -> sidecar. */
export type ClientCommand =
  | { type: "hello"; token: string }
  | { type: "spawn"; repo_id: string; repo_path: string; character_kind?: CharacterKind; label?: string }
  | { type: "command"; agent_id: string; prompt: string }
  | { type: "interrupt"; agent_id: string }
  | { type: "subscribe"; agent_id?: string }
  | { type: "list" }
  /**
   * Voice relay (ADDITIVE — does not change any existing shape). An authed client (the voice path:
   * either the native Godot VoiceWebSocket or the legacy voice-web page) re-emits a `speaking`/
   * `caption` ServerEvent it observed locally so the sidecar re-broadcasts it through the normal
   * store.onEvent fan-out to every other subscribed client (so in-world speaking tells + captions
   * appear on the agent the player clicked). Handled only AFTER hello-auth. server.ts: `store.publish`.
   */
  | { type: "relay"; event: ServerEvent };

/**
 * HTTP routes (all on http://127.0.0.1:8787):
 *   GET  /world                      -> WorldSnapshot
 *   GET  /agents                     -> AgentView[]
 *   GET  /projects                   -> ProjectView[]                 (project = repo + name + agents)
 *   GET  /hierarchy                  -> HierarchySnapshot             (Agent→Project→Repo→Group tree) [B/D]
 *   GET  /worlds                     -> { you, worlds: WorldSummary[] } (multiplayer directory)
 *   GET  /worlds/:id                 -> SharedWorldSnapshot            (visit a world; anonymized) [B/D]
 *   POST /agents/:id/prompt {prompt} -> 202 Accepted
 *   GET  /agents/:id/diff            -> AgentDiff                      (git diff in the worktree) [D]
 *   GET  /agents/:id/context         -> AgentContext                  (branch/base/PR/task/diff) [C dive]
 *   GET  /agents/:id/transcript?limit=&offset= -> TranscriptPage      (paginated JSONL transcript)
 *   POST /agents/:id/pr {title?,body?} -> PrResult                    (open a real PR via gh; best-effort)
 *   POST /agents/:id/approve {by?}   -> ApproveResult                 (release a pending/awaiting agent)
 *   POST /agents/:id/new-session     -> { character_id, session_id }   (start a FRESH chat; archive prior) [A]
 *   POST /agents/:id/send-away       -> { character_id, was_active }   (archive active session + sleep)   [A]
 *   GET  /agents/:id/sessions        -> SessionSummary[]               (a character's session history)    [A]
 *   GET  /agents/:id/sessions/:session_id/transcript -> SessionTranscript (one archived session's chat)    [A]
 *   GET  /operator/missions          -> { ready, missions: OperatorMission[] }  (Aiven data operator)
 *   POST /operator/run {mission_id?|prompt?} -> 202 Accepted          (run a data-operator mission)
 *   POST /v1/chat/completions        -> OpenAI-compatible SSE (model = characterId) [voice shim]
 *   GET  /voice/signed-url?agent_id= -> { signed_url, agent_id } | { configured:false } [native voice]
 *   GET  /auth/status                -> { mode: "subscription" | "apikey" | "unknown" }
 *   WS   /                           -> ServerEvent stream; accepts ClientCommand frames
 *
 * ADDITIVE (A, announced): /projects, /agents/:id/diff, /agents/:id/context, /operator/*,
 * /agents/:id/transcript, /agents/:id/pr, /agents/:id/approve, /hierarchy. New shapes Group/Repo/Project/
 * HierarchySnapshot/ActivityEvent + optional AgentView.project_id/group_id + ServerEvent "activity"
 * variant — all additive (DATA_MODEL.md alignment). No existing shape changed.
 * ADDITIVE (A, Lane-A observability): ServerEvent "tool_activity" (mid-turn per-tool HUD pulse) and
 * "service" (a localhost URL the turn surfaced) variants — additive, no existing shape changed.
 * ProjectView/AgentDiff/AgentContext/OperatorMission/TranscriptPage/PrResult/ApproveResult below.
 *
 * GET /voice/signed-url is the AgentCraft-local relay the native Godot VoiceWebSocket calls to obtain
 * a short-lived ElevenLabs Conversational-AI signed URL (port of a prior voice prototype's pipeline). The
 * ELEVENLABS_API_KEY lives ONLY here, server-side; the game never sees it. It reads
 * ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID from env; if either is unset it returns
 * { configured:false } (200) so the client can fall back gracefully instead of hanging.
 * NOTE: scrubAnthropicEnv() only strips ANTHROPIC_* — the ElevenLabs key is intentionally NOT scrubbed.
 */
export interface AuthStatus {
  mode: "subscription" | "apikey" | "unknown";
}

/** GET /projects item — a project (repo + name) with its agents' current world views. */
export interface ProjectView {
  id: string; // repo_id
  name: string; // display name
  repo_path: string;
  agents: AgentView[];
}

// --------------------------------------------------------------------------------------------------
// The world HIERARCHY (DATA_MODEL.md) — the DATA layer (never themed). Agent → Project → Repo → Group.
// Each container level is a tree node: stable id + human name + parent link. Agents (leaves) are
// AgentView (parent links above). B maps (level → asset) through the active theme; nothing here knows
// which theme is active. These shapes are ADDITIVE (announced) — they don't change any existing shape.
// --------------------------------------------------------------------------------------------------

/** A named bundle of repos and/or other groups (nestable: region → country). The top of the tree. */
export interface Group {
  id: string;
  name: string;
  parent_group_id: string | null; // null = a top-level group
}

/** A git repository; holds one or more projects. Rolls up into a Group. */
export interface Repo {
  id: string;
  name: string;
  group_id: string | null;
  repo_path: string;
}

/** A Claude Code project = a connected working directory holding agents. Lives in a Repo. */
export interface Project {
  id: string;
  name: string;
  repo_id: string;
  working_dir: string; // the project's working directory (usually the repo root; may be a sub-folder)
}

/** GET /hierarchy — the whole themed-agnostic tree the renderer (B) + HUD (D) navigate. */
export interface HierarchySnapshot {
  groups: Group[];
  repos: Repo[];
  projects: Project[];
  agents: AgentView[]; // the leaves, carrying project_id / repo_id / group_id parent links
}

/**
 * Anonymized activity event (DATA_MODEL.md "Activity → shared world") — the unit that streams to Aiven
 * (Kafka → Postgres) to drive the persistent / multiplayer world. Emitted when an agent does real work.
 * NO code, NO diffs, NO file contents ever leave the machine — only this. `level_path` is the dotted
 * hierarchy path the activity rolls up (group.repo.project.agent); `magnitude` is a unitless,
 * anonymized activity size (e.g. clamped lines-touched); `state` is the agent's state at emit time.
 * Because only this is shared, the world is safe to be public + open-source.
 */
export interface ActivityEvent {
  level_path: string; // e.g. "summer.summercraft.summercraft.a1"
  magnitude: number; // unitless, anonymized
  state: AgentState;
  ts: string; // ISO 8601
}

// --------------------------------------------------------------------------------------------------
// Multiplayer — shared worlds (DATA_MODEL.md). Each sidecar is one WORLD; it publishes an ANONYMIZED
// snapshot to the shared directory so others can see + visit it. NO code/paths/transcripts are shared —
// only renderable structure. Additive (announced). GET /worlds + GET /worlds/:id; no existing shape changed.
// --------------------------------------------------------------------------------------------------

/** A world in the directory (GET /worlds -> { you, worlds: WorldSummary[] }). */
export interface WorldSummary {
  world_id: string;
  name: string;
  agent_count: number;
  last_seen: string; // ISO 8601
  online: boolean; // published recently (within the freshness window)
  /**
   * Coarse OWNER label (the multiplayer "front door" hack — NOT auth, NOT a secret). Sourced server-side
   * (env AGENTCRAFT_OWNER_CODE, else a stable per-machine value), stamped on every published snapshot. Lets
   * the directory show who owns a world and a UI tell "mine" from "theirs". ADDITIVE — "" for any pre-0005
   * row or a world published without one; a consumer that predates it ignores the field. It grants NO
   * authority; nothing trusts it.
   */
  owner_code: string;
}

/** An anonymized agent in a visited world (a strict, safe subset of AgentView — no path/task/transcript). */
export interface SharedAgent {
  agent_id: string;
  label: string;
  character_kind: CharacterKind;
  state: AgentState;
  project_id?: string;
  repo_id: string;
  group_id?: string | null;
  /**
   * The agent's REAL world coordinate in the publishing world, so a visitor renders it at its actual spot
   * instead of stacked on its building. ADDITIVE + optional: AgentCraft computes layout CLIENT-side (the
   * octagon-slot allotment in world_manager.gd), so the sidecar has no canonical coordinate to stamp and
   * leaves this UNSET today — the Godot consumer falls back to a deterministic building-relative spawn,
   * which already lands every agent sensibly. The field exists so a future layout-aware producer (or a
   * client that round-trips its own positions back up) can fill it without a contract change. Coordinates
   * are theme-agnostic world units; y is implied 0 (ground plane).
   */
  position?: { x: number; z: number };
}

/**
 * One planted tree in a visited world — the visible record of a repo's commits (B's "commit → plant" beat).
 * Anonymized: carries only the owning repo, the (optional) commit subject as a floating label, and an
 * OPTIONAL coordinate. Coordinate is optional ON PURPOSE: the publisher has no canonical world layout (see
 * SharedAgent.position), so it omits `position` and the Godot consumer drops each plant onto the matching
 * repo's farm field via FarmField.claim_plot() (the field self-assigns the next free plot). A future
 * layout-aware publisher MAY stamp `position` to pin a plant to an exact spot; the consumer honors it.
 */
export interface SharedPlant {
  repo_id: string;
  message?: string; // commit subject (or ""); rendered as the floating Label3D above the tree
  position?: { x: number; z: number };
}

/** A visited world (GET /worlds/:id). The anonymized hierarchy + agent states — safe to render publicly. */
export interface SharedWorldSnapshot {
  world_id: string;
  name: string;
  groups: Array<{ id: string; name: string; parent_group_id: string | null }>;
  repos: Array<{ id: string; name: string; group_id: string | null }>; // no repo_path
  projects: Array<{ id: string; name: string; repo_id: string }>; // no working_dir
  agents: SharedAgent[];
  /**
   * The visited world's planted trees — one per recent commit per repo (capped). ADDITIVE: defaults to []
   * for any pre-this-field snapshot row or a publisher that predates it, so an old consumer ignores it and
   * a new consumer that reads an old snapshot simply renders no visited trees. Privacy: only repo_id +
   * commit subject (already public on the user's own machine) — NO diff, NO file paths, NO author email.
   */
  plants: SharedPlant[];
}

/** GET /agents/:id/diff — what an agent changed in its worktree (D's diff section). */
export interface AgentDiff {
  agent_id: string;
  repo_path: string;
  branch: string | null;
  diff: string; // unified git diff vs HEAD, truncated for the UI
  files: string[]; // changed file paths
  truncated: boolean;
}

/** GET /agents/:id/context — full context for the voice dive (C). */
export interface AgentContext {
  agent_id: string;
  repo_id: string;
  repo_path: string;
  label: string;
  state: AgentState;
  status_line: string;
  current_task: string | null;
  branch: string | null;
  base_branch: string | null;
  pr_url: string | null;
  diff: string;
  files: string[];
  transcript_tail: string[];
}

/** One reproducible Autonomous Data Operator mission (GET /operator/missions). */
export interface OperatorMission {
  id: string;
  title: string;
  prompt: string;
}

/** One transcript line surfaced over HTTP (mirrors the persisted JSONL entry; ADDITIVE). */
export interface TranscriptLine {
  ts: string; // ISO 8601
  role: "user" | "agent" | "tool" | "system";
  text: string;
}

/**
 * GET /agents/:id/transcript?limit=&offset= — a bounded, paginated window over an agent's transcript
 * (ADDITIVE). `lines` is the requested page, always most-recent-last; `total` is the full count so a
 * client can page. `offset` in the response is the actual start index used (page deterministically off
 * it). Defaults: limit 100 (max 1000). When `offset` is OMITTED the page is the TAIL — the most-recent
 * `limit` lines (what a HUD/voice-dive wants); pass an explicit `?offset=0` to read from the very start.
 */
export interface TranscriptPage {
  agent_id: string;
  total: number;
  offset: number;
  limit: number;
  lines: TranscriptLine[];
}

/**
 * GET /agents/:id/sessions/:session_id/transcript — the archived transcript of ONE past (or live) session,
 * for D's History "view archived chat" (completes the new-chat feature). The per-agent transcript JSONL has
 * no session_id, so the session is reconstructed from its [started_at, ended_at] window (see SessionSummary):
 * `lines` are this session's transcript, oldest-first (most-recent-last), bounded by `limit` (TAIL kept on
 * overflow). `ended_at` null means the session is still live (window open to now). ADDITIVE.
 */
export interface SessionTranscript {
  agent_id: string;
  session_id: string;
  started_at: string; // ISO 8601 — the session window start
  ended_at: string | null; // ISO 8601, or null while the session is still live
  limit: number;
  lines: TranscriptLine[];
}

/**
 * POST /agents/:id/pr — result of asking the agent's worktree to open a real PR via `gh` (ADDITIVE).
 * Best-effort: when `gh` is absent/unauthed or the repo has no remote, `opened:false` with a `reason`
 * (NEVER an error status — the caller branches on `opened`). When it succeeds, `url` is the PR url and
 * A also broadcasts a `pr_opened` ServerEvent.
 */
export interface PrResult {
  agent_id: string;
  opened: boolean;
  url: string | null;
  branch: string | null;
  /** present when opened:false — why we couldn't open a PR (gh missing, no remote, etc.). */
  reason?: string;
}

/**
 * POST /agents/:id/approve — release an agent parked in `pending`/`awaiting_approval` (ADDITIVE). Marks
 * the agent approved and broadcasts an `approved` ServerEvent. `ok:false` (404) for an unknown agent.
 */
export interface ApproveResult {
  agent_id: string;
  ok: boolean;
  approved: boolean;
  by: string | null;
}

/** GET /voice/signed-url response (native-voice signed-url relay). */
export type VoiceSignedUrl =
  | { configured: true; signed_url: string; agent_id: string }
  | { configured: false; reason: string };

/** Used by MOCK_FEED (Godot) and the stub projection until Track D wires real Aiven. */
export const MOCK_SNAPSHOT: WorldSnapshot = {
  agents: [
    { agent_id: "a1", repo_id: "web", repo_path: "/tmp/web", character_kind: "viking", state: "working", label: "Vinny", status_line: "editing auth.ts", current_task: "add health endpoint", target_base_id: "web", heartbeat_age_s: 1, transcript_tail: ["reading auth.ts", "writing handler"] },
    { agent_id: "a2", repo_id: "engine", repo_path: "/tmp/engine", character_kind: "wizard", state: "blocked", label: "Merlin", status_line: "blocked on lock: auth.ts", current_task: "refactor auth", target_base_id: "web", heartbeat_age_s: 2, transcript_tail: ["wanted auth.ts", "denied"] },
    { agent_id: "a3", repo_id: "templates", repo_path: "/tmp/templates", character_kind: "dwarf", state: "waiting", label: "Durin", status_line: "idle", current_task: null, target_base_id: null, heartbeat_age_s: 0, transcript_tail: [] },
  ],
  locks: [{ repo_path: "/tmp/web", file_path: "auth.ts", holder_agent_id: "a1", claimed_at: "2026-06-24T00:00:00Z" }],
  events: [{ ts: "2026-06-24T00:00:00Z", type: "file_claimed", agent_id: "a1", detail: "auth.ts" }],
  characters: [],
};
