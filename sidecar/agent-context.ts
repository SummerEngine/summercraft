/**
 * AgentCraft — agent context + diff (Track A / Brain, plan §4-A, §5 seam 5).
 *
 * Read-only git introspection of an agent's worktree, surfaced over HTTP so the other tracks can show
 * "what this agent changed" without ever touching the sidecar internals:
 *   - GET /agents/:id/diff     -> { agent_id, diff, files }            (D's diff section)
 *   - GET /agents/:id/context  -> branch / base / PR / task / diff …   (C's voice dive context)
 *
 * Everything here runs `git` in the agent's resolved repo_path (a worktree, or the repo cwd fallback)
 * with metered Anthropic vars scrubbed. It NEVER mutates working-tree content — the one concession is
 * `add --intent-to-add` so brand-new untracked files appear in `git diff` as additions (the agents
 * mostly Write new files); that records intent only, not content, and the agent's own commit is
 * unaffected. Bounded output so a huge diff can't wedge the panel.
 */
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { scrubAnthropicEnv } from "./env-scrub.mjs";
import { store } from "./session-store.ts";
import { RUNTIME_DIR } from "./session-store.ts";
import { sessionManager } from "./session-manager.ts";
import { loadProjects } from "./projects.ts";
import type { TranscriptPage, TranscriptLine } from "./contract.ts";

const pexec = promisify(exec);

/**
 * Is it SAFE to mutate `.git/index` (the `add --intent-to-add -A` step) for this agent's `cwd`?
 *
 * The ONE hazard (A-2): a SEEDED-but-never-spawned agent's repo_path is a CONFIGURED PROJECT'S repo ROOT —
 * for the default config that is the developer's REAL live SummerCraft repo (DEFAULT_PROJECTS repo_path =
 * REPO_ROOT). D polls /agents/:id/diff ~1s the moment a HUD card opens, so without this gate, opening an
 * idle agent's card would run `git add --intent-to-add -A` against the live working tree every second —
 * staging intent-to-add entries for every untracked file and corrupting in-progress manual git state.
 *
 * So we SKIP staging ONLY when BOTH hold: (a) no live session owns this agent (a spawned agent runs in its
 * OWN isolated worktree, where staging is correct and expected), and (b) cwd is exactly one of the shared
 * project repo roots. Every other case stages as before — an isolated worktree, a runtime/ sandbox/ops dir,
 * or a dedicated throwaway repo that belongs to this agent alone. When we skip, the diff degrades to tracked
 * changes vs HEAD (brand-new untracked files won't show as additions) but the live tree is never touched.
 */
async function indexMutationSafe(agentId: string, cwd: string): Promise<boolean> {
  // A live session => spawned => repo_path is its isolated worktree. Staging there is the intended behavior.
  if (sessionManager.has(agentId)) return true;
  const resolved = path.resolve(cwd);
  // Sidecar-owned scratch/sandbox (demo-repos + the operator ops cwd) is always safe to stage in.
  if (resolved === RUNTIME_DIR || resolved.startsWith(RUNTIME_DIR + path.sep)) return true;
  // Skip ONLY when this is a shared project repo root with no live owner — the live-tree hazard.
  try {
    const projects = await loadProjects();
    const isSharedRoot = projects.some((p) => path.resolve(p.repo_path) === resolved);
    return !isSharedRoot;
  } catch {
    // If we can't resolve the project config, fail SAFE: don't stage (never risk the live tree on uncertainty).
    return false;
  }
}

/** Hard cap on diff text returned to the UI (chars). A 4-minute pitch doesn't need 200KB of diff. */
const MAX_DIFF_CHARS = 20_000;

/**
 * Hard per-git timeout (ms). A huge / locked / slow repo must NOT hang /diff or /context forever — the
 * gap inventory flagged that only prUrlOf had a timeout. Every git() call now bounds itself; on timeout
 * safeGit swallows the error and returns "" so the panel degrades to "no diff" instead of wedging.
 */
const GIT_TIMEOUT_MS = 8_000;

/**
 * Perf guard: cap how many changed file paths we enumerate / process on a single /diff. On a huge repo a
 * full `name-status` can be enormous; we keep the first N and flag truncation rather than walk them all.
 */
const MAX_FILES = 500;

export interface AgentDiff {
  agent_id: string;
  repo_path: string;
  branch: string | null;
  /** unified `git diff` vs HEAD (tracked + intent-to-added new files), truncated to MAX_DIFF_CHARS. */
  diff: string;
  /** changed file paths (porcelain), for a quick "N files" summary. */
  files: string[];
  truncated: boolean;
}

export interface AgentContext {
  agent_id: string;
  repo_id: string;
  repo_path: string;
  label: string;
  state: string;
  status_line: string;
  current_task: string | null;
  branch: string | null;
  base_branch: string | null;
  pr_url: string | null;
  diff: string;
  files: string[];
  transcript_tail: string[];
}

async function git(args: string, cwd: string): Promise<string> {
  const { stdout } = await pexec(`git ${args}`, {
    cwd,
    env: scrubAnthropicEnv() as NodeJS.ProcessEnv,
    maxBuffer: 8 << 20,
    // Bound every git call so a wedged/locked/huge repo can't hang /diff or /context (gap inventory).
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout;
}

async function safeGit(args: string, cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return "";
  }
}

async function branchOf(cwd: string): Promise<string | null> {
  const b = (await safeGit("rev-parse --abbrev-ref HEAD", cwd)).trim();
  return b && b !== "HEAD" ? b : null;
}

/** Best-effort base branch (the branch the worktree was cut from): default branch or main/master. */
async function baseBranchOf(cwd: string): Promise<string | null> {
  const head = (await safeGit("symbolic-ref --short refs/remotes/origin/HEAD", cwd)).trim();
  if (head) return head.replace(/^origin\//, "");
  for (const cand of ["main", "master"]) {
    if ((await safeGit(`rev-parse --verify ${cand}`, cwd)).trim()) return cand;
  }
  return null;
}

/** Best-effort PR URL via gh (if installed + authed). Never throws; returns null when unavailable. */
async function prUrlOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("gh pr view --json url -q .url", {
      cwd,
      env: scrubAnthropicEnv() as NodeJS.ProcessEnv,
      maxBuffer: 1 << 20,
      timeout: 4000,
    });
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Compute the diff for an agent's worktree. Hardened (gap inventory §2 "diff endpoint hardening"):
 *   - BINARY FILES are detected via `--numstat` (binary rows report `-` for added/deleted) and EXCLUDED
 *     from the textual diff (`-- . ':(exclude)<binary>'`), so a committed image/blob can't dump raw
 *     bytes into the UID or blow past the char cap; their paths still appear in `files` (flagged).
 *   - HUGE DIFFS stay capped at MAX_DIFF_CHARS (existing behavior) AND the file list is capped at
 *     MAX_FILES so a massive changeset can't build a giant JSON array.
 *   - PERF: a single `--numstat` pass yields both the file list and the binary set; we only run the
 *     (bounded) textual `diff` once. Every git call is timeout-bounded by git() above.
 */
export async function agentDiff(agentId: string): Promise<AgentDiff | null> {
  const rec = store.get(agentId);
  if (!rec) return null;
  const cwd = rec.repo_path;

  // Make untracked files visible in the diff as additions (records intent only, not content).
  // SAFETY GATE: this is the one write on an otherwise read-only GET — it touches `.git/index`. We ONLY run
  // it for an isolated agent worktree (or a sidecar scratch/sandbox dir under runtime/). For a SEEDED agent
  // whose repo_path is the REAL repo ROOT, D's ~1s /diff poll would otherwise stage `add --intent-to-add -A`
  // against the developer's LIVE working tree every second; we skip the stage there and diff read-only.
  // CONCURRENCY NOTE: in a worktree, if the agent's own session is committing at this instant the two git
  // processes can contend on `.git/index.lock`; that surfaces as a transient lock error which safeGit
  // swallows to "" — a graceful degradation (this poll returns an empty diff), NOT a crash; the next poll
  // succeeds once the commit releases the lock. GIT_TIMEOUT_MS (via git()) bounds even a stuck lock.
  const canStage = await indexMutationSafe(agentId, cwd);
  if (canStage) await safeGit("add --intent-to-add -A", cwd);

  // One numstat pass: "<added>\t<deleted>\t<path>"; a binary row reports "-\t-\t<path>".
  // `--no-renames` keeps each row to a SINGLE real path: without it git emits a rename as
  // "0\t0\told => new" (or a brace form), which would (a) put a bogus path in `files` and (b) make the
  // ':(exclude)<path>' pathspec never match a renamed BINARY — letting its raw bytes slip into the
  // textual diff. `-c core.quotepath=false` keeps non-ASCII paths literal (not octal-escaped + quoted)
  // so the path we exclude is the path git diffs. Split on the LITERAL tab (paths may contain spaces).
  const numstat = (await safeGit("-c core.quotepath=false diff --numstat --no-renames HEAD", cwd))
    .split("\n")
    .filter(Boolean);

  const allFiles: string[] = [];
  const binaryFiles: string[] = [];
  for (const line of numstat) {
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const added = line.slice(0, tab1);
    const deleted = line.slice(tab1 + 1, tab2);
    const file = line.slice(tab2 + 1).trim();
    if (!file) continue;
    allFiles.push(file);
    if (added === "-" && deleted === "-") binaryFiles.push(file);
  }

  // Perf/size guard: cap the enumerated file list.
  const filesTruncated = allFiles.length > MAX_FILES;
  const files = filesTruncated ? allFiles.slice(0, MAX_FILES) : allFiles;

  // Build the textual diff EXCLUDING binary files so raw bytes never reach the UI. Excludes are bounded
  // (MAX_FILES) so the command line can't grow unboundedly on a pathological changeset.
  const excludes = binaryFiles
    .slice(0, MAX_FILES)
    .map((f) => ` ':(exclude)${f.replace(/'/g, "'\\''")}'`)
    .join("");
  // Match the numstat pass (`--no-renames`, quotepath off) so the ':(exclude)<path>' specs built from the
  // numstat file list line up with the paths this diff actually emits.
  let diff = await safeGit(`-c core.quotepath=false diff --no-renames HEAD -- .${excludes}`, cwd);

  // Note any binary files inline so the panel can tell the agent touched them without rendering bytes.
  if (binaryFiles.length) {
    const note = binaryFiles.slice(0, 20).map((f) => `binary file changed: ${f}`).join("\n");
    const more = binaryFiles.length > 20 ? `\n… +${binaryFiles.length - 20} more binary files` : "";
    diff = `${note}${more}\n${diff}`;
  }

  const truncated = diff.length > MAX_DIFF_CHARS || filesTruncated;
  if (diff.length > MAX_DIFF_CHARS) diff = diff.slice(0, MAX_DIFF_CHARS) + "\n… (diff truncated)";

  return {
    agent_id: agentId,
    repo_path: cwd,
    branch: await branchOf(cwd),
    diff,
    files,
    truncated,
  };
}

// --------------------------------------------------------------------------------------------------
// Paginated transcript (gap inventory §2 "pagination/limits on transcripts & events").
// --------------------------------------------------------------------------------------------------

/**
 * Match the store's filesystem-safe id mapping (session-store.ts `safe()`) so we read the right JSONL
 * file. The transcript route ALREADY runs validateId (validate.ts ID_RE = the same [A-Za-z0-9._-] slug)
 * before reaching here, so for any id that gets this far this is a defense-in-depth no-op — every char is
 * already in the safe set. It is kept (not removed) so a future direct caller can't smuggle a traversal
 * id into the JSONL path. NOTE: three copies of this charset exist (store.safe, validate.ID_RE, here);
 * session-store.ts owns the on-disk filename mapping and is the canonical source — it is L1-owned, so
 * collapsing all three behind one exported sanitizer is an L1 change, out of this lane's scope. Until
 * then, if that charset is ever changed it MUST be changed in all three in lockstep.
 */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Read a bounded, paginated window of an agent's transcript from its persisted JSONL. The JSONL is
 * oldest-first, and a page is always returned oldest-first (so `lines` is "most-recent-last", matching
 * the contract). `limit` bounds the page.
 *
 * `offset` semantics — this is the fix for the "default returns the start, not the tail" defect:
 *   - `offset === null` (the query param was NOT supplied) → return the TAIL: the most-recent `limit`
 *     lines (`start = max(0, total - limit)`). This is what a HUD/voice-dive calling with defaults wants
 *     ("recent activity"), and the page is still most-recent-last.
 *   - `offset` is an explicit number → page from the START (oldest first) at that offset, so a client
 *     that wants to walk history forward still can (`?offset=0` = the very beginning).
 * The returned `offset` field always reflects the actual start index used, so a client can page
 * deterministically regardless of which branch it hit.
 *
 * Returns null for an unknown agent; an agent with no transcript yet returns an empty page (NOT null).
 * Never throws — a read error degrades to an empty page so the endpoint can't crash.
 *
 * Note: this reads the full JSONL into memory then slices. The store already caps transcript growth in
 * L1; for the demo's volumes this is bounded and simple. If transcripts grow large, a streaming reader
 * is the follow-up — but correctness + a hard page cap matter more here than streaming.
 */
/**
 * Read + parse an agent's full persisted transcript JSONL (oldest-first). Each line is `{ts,role,text}`;
 * corrupt lines are skipped. Returns [] when the agent has no JSONL yet or on any read error — never throws.
 * Shared by agentTranscript (the paginated page) and agentTranscriptWindow (the per-session slice).
 */
async function readTranscriptLines(agentId: string): Promise<TranscriptLine[]> {
  const file = path.join(RUNTIME_DIR, "sessions", `${safeId(agentId)}.jsonl`);
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          const e = JSON.parse(l) as TranscriptLine;
          if (e && typeof e.text === "string") return e;
        } catch {
          /* skip a corrupt line */
        }
        return null;
      })
      .filter((e): e is TranscriptLine => e !== null);
  } catch {
    // No JSONL yet (agent hasn't produced transcript) or a read error — degrade to empty.
    return [];
  }
}

/**
 * Read the transcript lines that fall inside a SESSION's time window — the source for D's "view archived
 * chat" (GET /agents/:id/sessions/:session_id/transcript). The transcript JSONL is per-AGENT and carries NO
 * session_id (the SDK appends `{ts,role,text}` only), so a session is reconstructed by its `[startedAt,
 * endedAt]` bounds: a line belongs to the session iff startedAt <= ts < endedAt (endedAt null/omitted = the
 * live session, so the window is open-ended to "now"). Lines are returned oldest-first (most-recent-last),
 * bounded by `limit` keeping the TAIL when the window overflows (what a chat view wants). A line with an
 * unparseable `ts` is conservatively EXCLUDED (it can't be proven to belong to this session). Never throws.
 */
export async function agentTranscriptWindow(
  agentId: string,
  startedAt: string,
  endedAt: string | null,
  limit: number,
): Promise<TranscriptLine[]> {
  const all = await readTranscriptLines(agentId);
  const startMs = Date.parse(startedAt);
  const endMs = endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(endedAt);
  const inWindow = all.filter((l) => {
    const t = Date.parse(l.ts);
    if (Number.isNaN(t)) return false;
    // Half-open [start, end): the next session's first line (== its start) must not bleed into this one.
    return (Number.isNaN(startMs) || t >= startMs) && t < endMs;
  });
  // Keep the tail when the window overflows the limit — a chat view shows the most recent lines.
  return inWindow.slice(Math.max(0, inWindow.length - limit));
}

export async function agentTranscript(
  agentId: string,
  limit: number,
  offset: number | null,
): Promise<TranscriptPage | null> {
  const rec = store.get(agentId);
  if (!rec) return null;

  const lines = await readTranscriptLines(agentId);
  const total = lines.length;
  // Default (offset omitted) -> the tail (most-recent `limit` lines); explicit offset -> from the start.
  const start = offset === null ? Math.max(0, total - limit) : offset;
  const page = lines.slice(start, start + limit);
  return { agent_id: agentId, total, offset: start, limit, lines: page };
}

/** Compute full voice-dive context for an agent (branch/base/PR/task/diff/transcript). */
export async function agentContext(agentId: string): Promise<AgentContext | null> {
  const rec = store.get(agentId);
  if (!rec) return null;
  const cwd = rec.repo_path;
  const [d, base, pr] = await Promise.all([agentDiff(agentId), baseBranchOf(cwd), prUrlOf(cwd)]);
  return {
    agent_id: agentId,
    repo_id: rec.repo_id,
    repo_path: cwd,
    label: rec.label,
    state: rec.state,
    status_line: rec.status_line,
    current_task: rec.current_task,
    branch: d?.branch ?? null,
    base_branch: base,
    pr_url: pr,
    diff: d?.diff ?? "",
    files: d?.files ?? [],
    transcript_tail: [...rec.transcript_tail],
  };
}
