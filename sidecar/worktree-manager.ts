/**
 * AgentCraft — git worktree manager (Track A, plan §7 Phase 1).
 *
 * Each character ideally runs in its OWN git worktree of the target repo, so parallel agents don't
 * stomp each other's working tree. But for the demo, isolation is a nice-to-have, not a hard
 * requirement (plan §3 STRETCH + §8 risk): if anything about the worktree errors — target isn't a
 * git repo, working tree is dirty, `git worktree add` fails — we MUST NOT crash. We fall back to
 * running the agent directly in the repo cwd and surface a non-fatal {error} the caller can log.
 *
 * Contract: prepareWorktree() ALWAYS resolves (never rejects) and always returns a usable `path`.
 * `error` is informational; `isolated` tells the caller whether they got a real worktree or the
 * fallback. Worktrees are created under <repo>/.agentcraft-worktrees/<agent_id>.
 */
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { scrubAnthropicEnv } from "./env-scrub.mjs";
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";

const pexec = promisify(exec);

/** Subdir (inside the target repo) that holds per-agent worktrees. Exported so the manager can strip it
 *  off a record's `repo_path` (which is the worktree dir, not the root) to recover the repo ROOT. */
export const WORKTREE_SUBDIR = ".agentcraft-worktrees";

/**
 * Hard per-call timeout (ms) for every `git` invocation. A huge / network-backed / locked repo can make
 * `git worktree add`, `prune`, or `rev-parse` hang indefinitely; without a bound that wedges
 * prepareWorktree (and thus spawn) forever. `exec`'s own `timeout` SIGKILLs the child if it overruns, so
 * the promise always settles. (gap: "Missing per-call timeouts on … git subprocesses".)
 */
const GIT_TIMEOUT_MS = 60_000;

export interface WorktreeResult {
  /** The directory the agent should use as cwd. Always set. */
  path: string;
  /** True only if a dedicated git worktree was successfully created. */
  isolated: boolean;
  /** Branch name when isolated; null on fallback. */
  branch: string | null;
  /** Non-fatal explanation when we fell back to repo cwd. Absent on full success. */
  error?: string;
  /**
   * True when we could NOT isolate a real git repo and the only fallback would be editing its live tree.
   * The caller (session-manager) MUST refuse to spawn in this case — bypassPermissions agents must never
   * run directly in a real working tree. A non-git scratch dir (nothing to protect) is never unsafe.
   */
  unsafe?: boolean;
}

/**
 * Run a git command in `cwd` with metered Anthropic vars scrubbed (defense-in-depth) and a hard
 * timeout so a wedged/locked repo can never hang the caller. `exec`'s `timeout` option SIGKILLs the
 * git child on overrun (the rejection is then handled by every call site's `.catch`/try-catch — none
 * of them let a git failure escape).
 */
async function git(args: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return pexec(`git ${args}`, {
    cwd,
    env: scrubAnthropicEnv() as NodeJS.ProcessEnv,
    maxBuffer: 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
  });
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await git("rev-parse --is-inside-work-tree", repoPath);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function currentBranchOrHead(repoPath: string): Promise<string> {
  try {
    const { stdout } = await git("rev-parse --abbrev-ref HEAD", repoPath);
    const ref = stdout.trim();
    return ref && ref !== "HEAD" ? ref : "HEAD";
  } catch {
    return "HEAD";
  }
}

function fallback(repoPath: string, error: string, unsafe = false): WorktreeResult {
  return { path: repoPath, isolated: false, branch: null, error, unsafe };
}

/**
 * Prepare an isolated worktree for `agentId` rooted at `repoPath`. Never throws.
 *
 * Safety contract:
 *   - non-git scratch dir            -> run in cwd (nothing to protect; unsafe=false)
 *   - git repo, worktree created     -> isolated=true (the normal path; works even on a DIRTY main tree —
 *                                       `git worktree add` checks out a fresh copy of the base branch and
 *                                       leaves the main tree's uncommitted changes untouched)
 *   - git repo, isolation FAILED     -> unsafe=true; the caller MUST refuse rather than edit the live tree
 *
 * We deliberately do NOT fall back to running a bypassPermissions agent inside a real working tree.
 */
export async function prepareWorktree(
  agentId: string,
  repoPath: string,
): Promise<WorktreeResult> {
  const repo = path.resolve(repoPath);

  // 0. path sanity
  try {
    const st = await fs.stat(repo);
    if (!st.isDirectory()) return fallback(repo, `target is not a directory: ${repo}`);
  } catch {
    return fallback(repo, `target does not exist: ${repo}`);
  }

  // 1. git repo? A non-git scratch dir is safe to run in directly (nothing to clobber).
  if (!(await isGitRepo(repo))) {
    return fallback(repo, `not a git repo, running in cwd: ${repo}`);
  }

  // 2. Resolve to the MAIN working tree. If repoPath is itself a LINKED WORKTREE (e.g. a session record
  // whose repo_path got overwritten with a prior spawn's worktree dir), branching from it would create a
  // worktree-of-a-worktree and fail ("could not create an isolated worktree…"). git's common dir always
  // points at the main repo's .git, so its parent is the main working tree. Best-effort; keep repo on failure.
  let base = repo;
  try {
    const { stdout } = await git("rev-parse --path-format=absolute --git-common-dir", repo);
    const common = stdout.trim();
    if (common.endsWith("/.git")) base = path.dirname(common);
  } catch {
    /* not resolvable as a worktree — branch from the path as given */
  }

  // 3. create the worktree (works on a dirty main tree — see safety contract above). Collision-proof: a
  // UNIQUE branch (`agentcraft/<id>-<ts>`) created with `-B` into a UNIQUE dir, after pruning stale
  // registrations a busy repo accumulated. Rooted at `base` (the main tree) — never a worktree-of-a-worktree.
  const baseBranch = await currentBranchOrHead(base);
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const branch = `agentcraft/${safe(agentId)}-${stamp}`;
  const worktreeDir = path.join(base, WORKTREE_SUBDIR, `${safe(agentId)}-${stamp}`);

  try {
    await fs.mkdir(path.join(base, WORKTREE_SUBDIR), { recursive: true });

    // Ensure the worktrees dir is git-ignored so the agent doesn't try to commit it.
    await ensureIgnored(base).catch(() => {});

    // Drop dangling worktree registrations a prior crash / busy repo left behind, so `worktree add`
    // below can't trip over "<dir> already exists" / "already registered". Best-effort.
    await git("worktree prune", base).catch(() => {});

    // Fresh, collision-proof worktree. `-B` force-creates/resets the unique branch (it never exists yet,
    // so this is just a robust create); the dir is unique per spawn so it can never already be registered.
    try {
      await git(
        `worktree add -B ${shellSafe(branch)} ${shellSafe(worktreeDir)} ${shellSafe(baseBranch)}`,
        base,
      );
    } catch (firstErr) {
      // One retry after a hard prune + dir cleanup — covers a transient lock in a busy repo.
      await git("worktree prune", base).catch(() => {});
      await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
      try {
        await git(
          `worktree add -B ${shellSafe(branch)} ${shellSafe(worktreeDir)} ${shellSafe(baseBranch)}`,
          base,
        );
      } catch {
        throw firstErr;
      }
    }

    return { path: worktreeDir, isolated: true, branch };
  } catch (e) {
    // Real git repo, isolation failed — do NOT edit the live tree. Caller refuses on unsafe.
    return fallback(base, `git worktree add failed (${msg(e)}); refusing to edit the live tree`, true);
  }
}

/**
 * Resolve any path (a repo root OR a linked worktree) to its MAIN working tree. Used to KEY a repo (so two
 * agents on the same repo are detected even through different worktree paths) and to run on main. Best-effort.
 */
export async function mainRepoOf(repoPath: string): Promise<string> {
  const repo = path.resolve(repoPath);
  try {
    const { stdout } = await git("rev-parse --path-format=absolute --git-common-dir", repo);
    const common = stdout.trim();
    if (common.endsWith("/.git")) return path.dirname(common);
  } catch {
    /* not a git worktree — keep the input */
  }
  return repo;
}

/**
 * Run an agent DIRECTLY on the repo's main working tree / current branch — no worktree. This is the DEFAULT
 * for the FIRST agent on a repo so its edits are visible LIVE in the user's files (like a normal Claude Code
 * session). Never isolated, never unsafe (intentional); cleanupWorktree no-ops on it. Always resolves.
 */
export async function useMainTree(repoPath: string): Promise<WorktreeResult> {
  const base = await mainRepoOf(repoPath);
  const branch = (await isGitRepo(base)) ? await currentBranchOrHead(base) : null;
  return { path: base, isolated: false, branch, unsafe: false };
}

/**
 * Tear down a worktree created by prepareWorktree. Best-effort; never throws. Safe to call on a
 * fallback result (it just no-ops because the dir is the repo root).
 */
export async function cleanupWorktree(
  repoPath: string,
  result: WorktreeResult,
): Promise<void> {
  if (!result.isolated || result.path === path.resolve(repoPath)) return;
  const repo = path.resolve(repoPath);
  // Fully reclaim the throwaway worktree so nothing accumulates in a REAL repo: drop the registration,
  // prune, guarantee the dir is gone, then delete the per-agent branch. Every step is best-effort so
  // cleanup never throws during shutdown (and a still-closing child can't wedge it).
  await git(`worktree remove --force ${shellSafe(result.path)}`, repo).catch(() => {});
  await git("worktree prune", repo).catch(() => {});
  await fs.rm(result.path, { recursive: true, force: true }).catch(() => {});
  if (result.branch) {
    await git(`branch -D ${shellSafe(result.branch)}`, repo).catch(() => {});
  }
}

/**
 * Boot-time orphan-worktree GC. A crash can leave `.agentcraft-worktrees/<id>` dirs + `agentcraft/<id>`
 * branches behind for agents that will NEVER re-spawn (e.g. one-shot voice ids), and prepareWorktree only
 * ever re-attaches the EXACT agent being spawned — so the leftovers accumulate inside the REAL repo. This
 * reclaims every per-agent worktree/branch whose id is not in `keepAgentIds` (the agents that are still
 * seeded/live and may legitimately re-attach). Always best-effort: a single failure logs + continues, and
 * the whole thing degrades to a no-op on a non-git / missing repo rather than throwing into boot.
 *
 * Returns the agent ids it reclaimed (informational; safe to ignore). NEVER throws.
 * (gap: "No boot-time orphan-worktree GC".)
 */
export async function reclaimOrphanWorktrees(
  repoPath: string,
  keepAgentIds: Iterable<string>,
): Promise<string[]> {
  const repo = path.resolve(repoPath);
  const reclaimed: string[] = [];
  const keep = new Set<string>();
  for (const id of keepAgentIds) keep.add(safe(id));

  // A worktree dir / branch is now named `<safeId>-<stamp>` (collision-proof per spawn), so an exact
  // match against the bare kept id no longer works. A name belongs to a kept agent if it equals the id
  // OR begins with `<id>-` (its stamped variant). This guards a live agent's in-use worktree from GC.
  const keptBy = (name: string): boolean => {
    const n = safe(name);
    if (keep.has(n)) return true;
    for (const id of keep) {
      if (n.startsWith(`${id}-`)) return true;
    }
    return false;
  };

  try {
    // Only operate on a real git repo (a non-git scratch dir has no worktrees/branches to reclaim).
    if (!(await isGitRepo(repo))) return reclaimed;

    // First drop any dangling registrations from a crash so `worktree remove` below is clean.
    await git("worktree prune", repo).catch(() => {});

    // 1. Reclaim leftover worktree directories under .agentcraft-worktrees/.
    const wtRoot = path.join(repo, WORKTREE_SUBDIR);
    let entries: string[] = [];
    try {
      entries = await fs.readdir(wtRoot);
    } catch {
      /* no worktree dir at all — nothing to GC on the dir side */
    }
    for (const name of entries) {
      if (keptBy(name)) continue; // a still-seeded/live agent owns this stamped worktree — leave it
      const dir = path.join(wtRoot, name);
      try {
        const st = await fs.stat(dir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      // Deregister + delete the dir + delete its branch. Each step best-effort.
      await git(`worktree remove --force ${shellSafe(dir)}`, repo).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await git(`branch -D ${shellSafe(`agentcraft/${name}`)}`, repo).catch(() => {});
      reclaimed.push(name);
      metrics.inc("orphan_worktree_reclaimed");
    }

    // 2. Reclaim any orphaned `agentcraft/*` branch with no surviving worktree dir / keep entry. A branch
    //    can outlive its dir if the dir was already removed but `branch -D` failed on the prior pass.
    let branches: string[] = [];
    try {
      const { stdout } = await git(
        "for-each-ref --format=%(refname:short) refs/heads/agentcraft",
        repo,
      );
      branches = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      /* no agentcraft/* branches — done */
    }
    await git("worktree prune", repo).catch(() => {});
    for (const ref of branches) {
      const id = ref.replace(/^agentcraft\//, "");
      if (keptBy(id)) continue;
      // Skip a branch still backed by a live worktree (checked-out branches refuse -D anyway, but avoid
      // even attempting it so we don't log a spurious failure).
      const dir = path.join(wtRoot, id);
      const dirAlive = await fs.stat(dir).then(() => true).catch(() => false);
      if (dirAlive) continue;
      await git(`branch -D ${shellSafe(ref)}`, repo).catch(() => {});
    }

    if (reclaimed.length) {
      logger.info("worktree GC reclaimed orphaned worktrees", {
        repo,
        count: reclaimed.length,
        ids: reclaimed,
      });
    }
  } catch (e) {
    // Never let GC crash or hang boot — it is pure cleanup.
    logger.warn("worktree GC skipped (non-fatal)", { repo, error: msg(e) });
  }
  return reclaimed;
}

/** Add WORKTREE_SUBDIR to the repo's .git/info/exclude so agent-created worktrees stay untracked. */
async function ensureIgnored(repo: string): Promise<void> {
  const excludePath = path.join(repo, ".git", "info", "exclude");
  let body = "";
  try {
    body = await fs.readFile(excludePath, "utf8");
  } catch {
    /* file may not exist in a worktree/submodule layout; skip silently */
    return;
  }
  if (!body.split("\n").some((l) => l.trim() === `${WORKTREE_SUBDIR}/`)) {
    await fs.appendFile(excludePath, `\n${WORKTREE_SUBDIR}/\n`, "utf8");
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Minimal arg quoting for paths/branches passed to the shell via exec. */
function shellSafe(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
