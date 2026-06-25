/**
 * AgentCraft — multiplayer / shared worlds (Track A / Brain, DATA_MODEL.md "Activity → shared world").
 *
 * "Seeing other people's worlds." Each running sidecar is one WORLD with a stable `world_id`. It
 * periodically publishes an ANONYMIZED snapshot of itself — the hierarchy + agent states, and nothing
 * else — into the shared Aiven Postgres (`world_state.world_snapshots`). Visiting another world = reading
 * its snapshot row. The within-world coordination layer (locks/contention) is untouched; this is a
 * separate, additive, read-mostly directory.
 *
 * PRIVACY IS THE WHOLE POINT: the shared snapshot carries NO code, NO diffs, NO repo paths, NO working
 * dirs, NO transcripts, NO task text. Only ids, display names, character kinds, states, and parent links —
 * the stuff you need to draw a world, and nothing you'd mind a stranger seeing. buildSharedSnapshot() is
 * the single chokepoint that strips everything sensitive; if it's safe here, the shared world is safe.
 *
 * Single-player needs none of this: with no Aiven configured, publish/list/get are clean no-ops.
 */
import fsSync from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { RUNTIME_DIR } from "./session-store.ts";
import { getPg } from "./aiven/pg.ts";
import { buildHierarchy } from "./hierarchy.ts";
import { logger } from "./logger.ts";
import { metrics } from "./metrics.ts";
import { scrubAnthropicEnv } from "./env-scrub.mjs";
import type { SharedAgent, SharedPlant, SharedWorldSnapshot, WorldSummary } from "./contract.ts";

const pexec = promisify(exec);
/** Bound every git call so a wedged/locked/huge repo can't hang the 8s publish loop. */
const GIT_TIMEOUT_MS = 5_000;
/** Most trees we publish per repo — one per recent commit, newest first. Caps payload + render cost. */
const MAX_PLANTS_PER_REPO = 12;

/** A world is considered "online" in the directory if it published within this window (seconds). */
export const WORLD_ONLINE_WINDOW_S = 30;

let cachedWorldId: string | null = null;

/** This instance's stable world id: env override > persisted runtime/world_id > freshly generated. */
export function getWorldId(): string {
  if (cachedWorldId) return cachedWorldId;
  const fromEnv = process.env.SUMMERCRAFT_WORLD_ID?.trim();
  if (fromEnv) return (cachedWorldId = fromEnv);
  const file = path.join(RUNTIME_DIR, "world_id");
  try {
    const existing = fsSync.readFileSync(file, "utf8").trim();
    if (existing) return (cachedWorldId = existing);
  } catch {
    /* not generated yet */
  }
  const id = "world_" + randomUUID().slice(0, 8);
  try {
    fsSync.mkdirSync(RUNTIME_DIR, { recursive: true });
    fsSync.writeFileSync(file, id, "utf8");
  } catch {
    /* couldn't persist — still usable for this run */
  }
  return (cachedWorldId = id);
}

/** This world's human display name (env override > hostname). */
export function getWorldName(): string {
  return (process.env.SUMMERCRAFT_WORLD_NAME?.trim() || `${os.hostname()}'s world`).slice(0, 80);
}

/**
 * This world's OWNER CODE — the multiplayer "front door" hack (NOT auth, NOT a secret, grants no authority).
 * Env AGENTCRAFT_OWNER_CODE wins; otherwise a STABLE per-machine value (the hostname) so the same machine
 * always owns the same worlds without any login or config. Bounded to 80 chars (same bar as the world name).
 */
export function getOwnerCode(): string {
  return (process.env.AGENTCRAFT_OWNER_CODE?.trim() || os.hostname() || "unknown").slice(0, 80);
}

// The anonymized, safe-to-share shapes live in contract.ts (the B/D seam): SharedAgent / SharedWorldSnapshot
// / WorldSummary. Imported above.

/**
 * Build THIS world's anonymized snapshot. The single privacy chokepoint: every field that could leak the
 * user's machine, code, or intent (repo_path, working_dir, transcript_tail, current_task, status_line) is
 * dropped here. What remains is purely renderable structure.
 */
export async function buildSharedSnapshot(): Promise<SharedWorldSnapshot> {
  const h = await buildHierarchy();
  return {
    world_id: getWorldId(),
    name: getWorldName(),
    groups: h.groups.map((g) => ({ id: g.id, name: g.name, parent_group_id: g.parent_group_id })),
    repos: h.repos.map((r) => ({ id: r.id, name: r.name, group_id: r.group_id })),
    projects: h.projects.map((p) => ({ id: p.id, name: p.name, repo_id: p.repo_id })),
    agents: h.agents.map((a) => ({
      agent_id: a.agent_id,
      label: a.label,
      character_kind: a.character_kind,
      state: a.state,
      project_id: a.project_id,
      repo_id: a.repo_id,
      group_id: a.group_id,
      // position: UNSET on purpose — layout is computed client-side, so there's no canonical coordinate to
      // stamp here. The visited-world consumer falls back to a building-relative spawn. See SharedAgent.
    })),
    // The visible commit history as trees: one plant per recent commit per repo, derived from the REAL git
    // log of each repo's working tree. No coordinate is published (no server-side layout) — the consumer
    // drops each onto the repo's farm field. Built in parallel; any repo that fails contributes nothing.
    plants: await buildSharedPlants(h.repos),
  };
}

/**
 * Build the visited world's trees from the REAL git history of each repo. For every repo with a readable
 * working tree we read up to MAX_PLANTS_PER_REPO recent commit subjects and emit one SharedPlant each
 * (repo_id + subject, no coordinate). This is the live counterpart of the mock's plants[] — a visitor now
 * sees a tree for every real commit the owner has made. Best-effort + bounded: a missing/locked/huge repo
 * times out and simply yields no trees for that repo; the publish never throws or stalls.
 */
async function buildSharedPlants(
  repos: Array<{ id: string; repo_path?: string }>,
): Promise<SharedPlant[]> {
  const per = await Promise.all(
    repos.map(async (r): Promise<SharedPlant[]> => {
      const cwd = r.repo_path;
      if (!cwd || !fsSync.existsSync(cwd)) return [];
      try {
        // %s = subject only. NUL-delimited so subjects with newlines can't split a record.
        const { stdout } = await pexec(
          `git log -n ${MAX_PLANTS_PER_REPO} --no-merges --format=%s%x00 HEAD`,
          { cwd, env: scrubAnthropicEnv() as NodeJS.ProcessEnv, maxBuffer: 1 << 20, timeout: GIT_TIMEOUT_MS },
        );
        return stdout
          .split("\0")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .map((message): SharedPlant => ({ repo_id: r.id, message: message.slice(0, 120) }));
      } catch {
        return []; // not a git repo / locked / timed out — no trees for this repo, never fatal
      }
    }),
  );
  return per.flat();
}

/** Publish (UPSERT) this world's anonymized snapshot to the shared directory. No-op without Aiven. */
export async function publishWorldSnapshot(): Promise<void> {
  const pg = getPg();
  if (!pg) return;
  try {
    const snap = await buildSharedSnapshot();
    await pg.query(
      `INSERT INTO world_state.world_snapshots (world_id, name, owner_code, last_seen, snapshot)
       VALUES ($1, $2, $3, now(), $4::jsonb)
       ON CONFLICT (world_id) DO UPDATE
         SET name = EXCLUDED.name, owner_code = EXCLUDED.owner_code, last_seen = now(), snapshot = EXCLUDED.snapshot`,
      [snap.world_id, snap.name, getOwnerCode(), JSON.stringify(snap)],
    );
    metrics.inc("world_snapshot_published");
  } catch (e) {
    logger.warn("[multiplayer] publish snapshot failed (skipped)", { error: msg(e) });
  }
}

/** The world directory: every world that has published, newest activity first. No-op (empty) without Aiven. */
export async function listWorlds(): Promise<WorldSummary[]> {
  const pg = getPg();
  if (!pg) return [];
  try {
    const { rows } = await pg.query(
      `SELECT world_id, name, COALESCE(owner_code, '') AS owner_code, last_seen,
              COALESCE(jsonb_array_length(snapshot->'agents'), 0) AS agent_count,
              EXTRACT(EPOCH FROM (now() - last_seen)) AS age_s
         FROM world_state.world_snapshots
        ORDER BY last_seen DESC`,
    );
    return rows.map((r): WorldSummary => ({
      world_id: String(r.world_id),
      name: String(r.name ?? ""),
      owner_code: String(r.owner_code ?? ""),
      agent_count: Number(r.agent_count) || 0,
      last_seen: r.last_seen instanceof Date ? r.last_seen.toISOString() : String(r.last_seen),
      online: (Number(r.age_s) || 1e9) <= WORLD_ONLINE_WINDOW_S,
    }));
  } catch (e) {
    logger.warn("[multiplayer] list worlds failed", { error: msg(e) });
    return [];
  }
}

/** Read one world's anonymized snapshot (a "visit"). Null when unknown or Aiven is off. */
export async function getWorldSnapshot(worldId: string): Promise<SharedWorldSnapshot | null> {
  const pg = getPg();
  if (!pg) return null;
  try {
    const { rows } = await pg.query(
      `SELECT snapshot FROM world_state.world_snapshots WHERE world_id = $1`,
      [worldId],
    );
    if (!rows.length) return null;
    const snap = rows[0].snapshot;
    return typeof snap === "string" ? JSON.parse(snap) : snap;
  } catch (e) {
    logger.warn("[multiplayer] get world failed", { world_id: worldId, error: msg(e) });
    return null;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
