/**
 * AgentCraft — PR / approve / pending flow (Track A / Brain, plan §2 "API surface", §3 Phase-3, lane L3).
 *
 * The human-gate seam: an agent's work can pause for review, open a REAL pull request via `gh`, and be
 * released by an operator. Three pieces:
 *   - openPr(agentId, opts)   -> push the worktree branch + `gh pr create` (best-effort, NO-OP when gh
 *                                is absent/unauthed or there's no remote); broadcasts `pr_opened`.
 *   - approveAgent(agentId)   -> mark a parked agent approved; broadcasts `approved`.
 *   - markPending / markAwaiting -> the events A emits so D's HUD can render the gate.
 *
 * DESIGN RULES (all defensive — nothing here may crash /world or hang boot):
 *   - EVERY child process runs with `scrubAnthropicEnv()` (billing safety is sacrosanct) AND a hard
 *     timeout (a wedged `gh`/`git` push must never hang the route).
 *   - openPr NEVER throws and NEVER returns a non-2xx: it returns { opened:false, reason } so the HTTP
 *     layer always answers 200 and the client branches on `opened` (same pattern as /voice/signed-url).
 *   - We only ever read/append store records + git in the agent's OWN worktree; we never touch B/C/D.
 *
 * This is ADDITIVE to the contract (PrResult / ApproveResult / pending|awaiting_approval|pr_opened|
 * approved ServerEvents). It changes no existing shape.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { scrubAnthropicEnv } from "./env-scrub.mjs";
import { store } from "./session-store.ts";
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";
import type { PrResult, ApproveResult } from "./contract.ts";

const pexec = promisify(exec);

/** Hard per-subprocess timeout (ms). A locked/slow repo or a hung `gh` must not wedge the route. */
const GIT_TIMEOUT_MS = 8_000;
const GH_TIMEOUT_MS = 15_000;

/** Run a child in the agent's worktree with metered Anthropic vars scrubbed + a hard timeout. */
async function run(cmd: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string }> {
  return pexec(cmd, {
    cwd,
    env: scrubAnthropicEnv() as NodeJS.ProcessEnv,
    maxBuffer: 1 << 20,
    timeout,
  });
}

/** Is `gh` installed + authenticated? Cheap probe; never throws. */
async function ghReady(cwd: string): Promise<boolean> {
  try {
    await run("gh auth status", cwd, GH_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** Current branch of the worktree, or null at a detached HEAD / non-repo. */
async function branchOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("git rev-parse --abbrev-ref HEAD", cwd, GIT_TIMEOUT_MS);
    const b = stdout.trim();
    return b && b !== "HEAD" ? b : null;
  } catch {
    return null;
  }
}

/** Does the repo have an `origin` remote we can push a PR branch to? */
async function hasOrigin(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run("git remote", cwd, GIT_TIMEOUT_MS);
    return stdout.split("\n").map((s) => s.trim()).includes("origin");
  } catch {
    return false;
  }
}

/** If a PR already exists for this branch, return its url (so openPr is idempotent). */
async function existingPrUrl(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("gh pr view --json url -q .url", cwd, GH_TIMEOUT_MS);
    const url = stdout.trim();
    return url || null;
  } catch {
    return null;
  }
}

export interface OpenPrOptions {
  title?: string;
  body?: string;
}

/**
 * Open a real PR for an agent's worktree branch via `gh` (best-effort). Sequence (each guarded):
 *   1) resolve the agent's worktree + branch; refuse cleanly if unknown / detached / no remote / no gh,
 *   2) if a PR already exists for the branch, return it (idempotent — no duplicate PRs),
 *   3) push the branch (`-u origin <branch>`), then `gh pr create --fill` (title/body override --fill),
 *   4) broadcast `pr_opened` + park the agent in `awaiting_approval`.
 *
 * NEVER throws; ALWAYS returns a PrResult. `opened:false` carries a `reason` for the no-op cases so the
 * HTTP route answers 200 and the client branches on `opened`.
 */
export async function openPr(agentId: string, opts: OpenPrOptions = {}): Promise<PrResult> {
  const rec = store.get(agentId);
  if (!rec) return { agent_id: agentId, opened: false, url: null, branch: null, reason: "unknown agent" };
  const cwd = rec.repo_path;

  const branch = await branchOf(cwd);
  if (!branch) {
    return { agent_id: agentId, opened: false, url: null, branch: null, reason: "no branch (detached HEAD or non-git worktree)" };
  }

  if (!(await ghReady(cwd))) {
    logger.info("pr: gh unavailable, skipping", { agent_id: agentId });
    return { agent_id: agentId, opened: false, url: null, branch, reason: "gh not installed or not authenticated" };
  }
  if (!(await hasOrigin(cwd))) {
    return { agent_id: agentId, opened: false, url: null, branch, reason: "no origin remote to open a PR against" };
  }

  // Idempotent: if a PR is already open for this branch, return it instead of creating a duplicate.
  const already = await existingPrUrl(cwd);
  if (already) {
    await markAwaiting(agentId, already, opts.title);
    return { agent_id: agentId, opened: true, url: already, branch };
  }

  try {
    // Push the branch first; --set-upstream so gh can find the head. Quote the branch defensively
    // (validated upstream, but never interpolate raw user text into a shell without bounding it).
    await run(`git push -u origin ${shellArg(branch)}`, cwd, GH_TIMEOUT_MS);

    const titleArg = opts.title ? ` --title ${shellArg(opts.title)}` : "";
    const bodyArg = opts.body ? ` --body ${shellArg(opts.body)}` : "";
    // --fill derives title/body from commits when not overridden; explicit title/body win.
    const fillArg = opts.title || opts.body ? "" : " --fill";
    const { stdout } = await run(`gh pr create${fillArg}${titleArg}${bodyArg}`, cwd, GH_TIMEOUT_MS);
    const url = extractUrl(stdout) ?? (await existingPrUrl(cwd));
    if (!url) {
      return { agent_id: agentId, opened: false, url: null, branch, reason: "gh pr create returned no url" };
    }

    metrics.inc("pr_opened");
    store.publish({ type: "pr_opened", agent_id: agentId, pr_url: url, branch });
    await markAwaiting(agentId, url, opts.title);
    logger.info("pr opened", { agent_id: agentId, branch });
    return { agent_id: agentId, opened: true, url, branch };
  } catch (e) {
    // Best-effort: a push/create failure (no perms, protected branch, offline) is a clean no-op, not a
    // crash. Keep the reason short + client-safe (don't echo raw gh stderr, which can carry tokens/urls).
    logger.warn("pr: gh pr create failed", { agent_id: agentId, branch });
    return { agent_id: agentId, opened: false, url: null, branch, reason: "could not open PR (push/create failed)" };
  }
}

/**
 * Release an agent parked in `pending`/`awaiting_approval`. Marks the record approved (status only — we
 * don't merge here) and broadcasts an `approved` ServerEvent D's HUD consumes. Returns ok:false (the
 * route maps to 404) for an unknown agent.
 */
export async function approveAgent(agentId: string, by?: string): Promise<ApproveResult> {
  const rec = store.get(agentId);
  if (!rec) return { agent_id: agentId, ok: false, approved: false, by: by ?? null };
  await store.update(agentId, { status_line: by ? `approved by ${by}` : "approved" });
  store.publish({ type: "approved", agent_id: agentId, by });
  metrics.inc("agent_approved");
  logger.info("agent approved", { agent_id: agentId, by: by ?? null });
  return { agent_id: agentId, ok: true, approved: true, by: by ?? null };
}

/** Emit a `pending` gate event (the agent needs review before continuing). Best-effort; never throws. */
export function markPending(agentId: string, reason?: string): void {
  if (!store.get(agentId)) return;
  store.publish({ type: "pending", agent_id: agentId, reason });
}

/**
 * Park an agent in `awaiting_approval` (a PR is ready/open). Updates the status line + broadcasts the
 * event. Best-effort; never throws (a disk hiccup on the status update is swallowed by store.update).
 */
export async function markAwaiting(agentId: string, prUrl?: string, summary?: string): Promise<void> {
  if (!store.get(agentId)) return;
  await store.update(agentId, { status_line: prUrl ? `awaiting approval — ${prUrl}` : "awaiting approval" });
  store.publish({ type: "awaiting_approval", agent_id: agentId, pr_url: prUrl, summary });
}

// --------------------------------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------------------------------

/** Single-quote-escape a string for safe shell interpolation (POSIX). */
function shellArg(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Pull the first https URL out of `gh pr create` stdout (it prints the PR url on success). */
function extractUrl(out: string): string | null {
  const m = out.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}
