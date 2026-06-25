/**
 * AgentCraft — world routes (Track A / Brain, plan §3 L3).
 *
 *   GET /world  -> WorldSnapshot   (Godot polls @1s — the demo-default transport)
 *   GET /agents -> AgentView[]     (== world.agents)
 *
 * buildWorld() is the behavioral heart kept VERBATIM from the pre-refactor server: the Aiven projection
 * is the base; this host's live + seeded store records overlay it (local wins per agent_id). A projection
 * failure publishes {type:"error"} on the bus but NEVER throws — /world must keep animating from local
 * records. When Aiven is OFF the local seeded records ARE the world (no MOCK fallback at this layer).
 */
import http from "node:http";

import type { WorldSnapshot } from "../contract.ts";
import { store } from "../session-store.ts";
import { getPg } from "../aiven/pg.ts";
import { worldProjection } from "../aiven/projection.ts";
import { json, msg } from "./router.ts";
import { parseLimit } from "./validate.ts";
import { buildHierarchy } from "../hierarchy.ts";
import { listWorlds, getWorldSnapshot, getWorldId, getOwnerCode } from "../multiplayer.ts";
import { buildCharacters } from "../characters.ts";
import { STALE_AFTER_S } from "../aiven/projection.ts";

/**
 * Safety cap on how many events/locks /world returns when the client doesn't ask for fewer. The shape
 * (WorldSnapshot.events/locks arrays) is FROZEN — we don't add fields — but an unbounded projection
 * could return tens of thousands of rows and bloat the 1s poll. We keep the MOST RECENT N events (a HUD
 * only renders the tail anyway) and bound locks too. A client may request fewer via ?events_limit= /
 * ?locks_limit= (DOWN TO 0 — an agents-only HUD can omit the arrays); it can never request MORE than the
 * hard cap (gap inventory §2 "pagination/limits").
 */
const DEFAULT_EVENTS_CAP = 500;
const DEFAULT_LOCKS_CAP = 500;

/**
 * Build a WorldSnapshot: the Aiven Postgres projection as the base (when Aiven is configured), this
 * host's live + seeded records merged on top (local wins for ids we run, since we own their live
 * state/transcript). When Aiven is OFF the local seeded records ARE the world — we do NOT fall back to
 * the mock snapshot, so /world reflects the real project model, not fake a1/a2/a3.
 */
export async function buildWorld(): Promise<WorldSnapshot> {
  const pg = getPg();
  let projection: WorldSnapshot = { agents: [], locks: [], events: [], characters: [] };
  if (pg) {
    try {
      projection = await worldProjection({ pg });
    } catch (e) {
      // Projection must never take down /world (the world keeps animating from local records).
      store.publish({ type: "error", message: `world projection failed: ${msg(e)}` });
    }
  }

  // Overlay: our locally-managed agents are authoritative for their own live state/transcript.
  const local = store.list().map((r) => store.toView(r));
  const localIds = new Set(local.map((a) => a.agent_id));
  const byId = new Map(projection.agents.map((a) => [a.agent_id, a]));
  for (const a of local) byId.set(a.agent_id, a); // local wins for ids we run
  // Drop stale EXTERNAL agents (in the Aiven projection but not in our local store) — these are the
  // tombstones of past MCP smoke tests (e.g. mcp_a/mcp_b) that, being stale >15s, the projection forces
  // to `blocked` and would otherwise surface as stuck NPCs forever. A *live* external agent (heartbeating
  // within STALE_AFTER_S) is real and kept; our own local records are ALWAYS kept (they may be legitimately
  // slept/idle and stale, but they are the authoritative character layer).
  const agents = [...byId.values()].filter(
    (a) => localIds.has(a.agent_id) || a.heartbeat_age_s <= STALE_AFTER_S,
  );
  return {
    agents,
    locks: projection.locks,
    events: projection.events,
    // The persistent CHARACTER layer (character-session model): one NPC per local record, `working` with a
    // live active_session_id when the session-manager is running a session for it, else `asleep`. Built from
    // local records (the authoritative character layer lives here, not in the anonymized Aiven projection),
    // so a SLEEPING character is still drawn — `agents` only carries LIVE Sessions. Additive: [] by default.
    characters: buildCharacters(),
  };
}

/**
 * GET /world -> WorldSnapshot. Bounds the events/locks arrays to a hard cap (keeping the most-recent
 * events) so a large projection can't bloat the 1s poll. Optional ?events_limit= / ?locks_limit= let a
 * client request fewer (down to 0 — `min=0`, so an agents-only HUD can omit the arrays entirely); neither
 * can exceed the cap. The frozen shape is unchanged — same fields, just a bounded number of rows.
 */
export async function handleWorld(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const world = await buildWorld();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const eventsLimit = parseLimit(url.searchParams.get("events_limit"), DEFAULT_EVENTS_CAP, DEFAULT_EVENTS_CAP, 0);
  const locksLimit = parseLimit(url.searchParams.get("locks_limit"), DEFAULT_LOCKS_CAP, DEFAULT_LOCKS_CAP, 0);
  json(res, 200, {
    agents: world.agents,
    // Keep the MOST RECENT N of each (tail) — that's what a HUD renders. Locks use the same tail policy
    // as events: if the projection orders locks oldest-first, the cap must keep the NEWEST contention
    // (what the lock overlay wants), not the stalest. The frozen shape is unchanged — just bounded rows.
    locks: world.locks.slice(Math.max(0, world.locks.length - locksLimit)),
    events: world.events.slice(Math.max(0, world.events.length - eventsLimit)),
    // The persistent characters are small (one per known agent) and unbounded by the events/locks caps —
    // a slept NPC must always be drawable, so they are never truncated.
    characters: world.characters,
  } satisfies WorldSnapshot);
}

/** GET /agents -> AgentView[] (the world's agents). */
export async function handleAgents(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const world = await buildWorld();
  json(res, 200, world.agents);
}

/**
 * GET /hierarchy -> HierarchySnapshot. The theme-agnostic Agent → Project → Repo → Group tree (B renders
 * it through the active theme; D navigates it). DATA_MODEL.md. Derived from the live records, so it always
 * agrees with /world's agents.
 */
export async function handleHierarchy(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  json(res, 200, await buildHierarchy());
}

/**
 * GET /worlds -> { you, you_owner_code, worlds }. The shared-world directory (multiplayer): every world that
 * has published, newest first, with `you` flagging this instance's own world_id and `you_owner_code` this
 * instance's owner label so a UI can tell "mine" (worlds[i].owner_code === you_owner_code) from "theirs"
 * without a login. Each world carries { world_id, owner_code, name, last_seen, agent_count, online }. Empty
 * `worlds` without Aiven (additive: `you_owner_code` is new alongside the existing `you`).
 */
export async function handleWorlds(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  json(res, 200, { you: getWorldId(), you_owner_code: getOwnerCode(), worlds: await listWorlds() });
}

/**
 * GET /worlds/:id -> SharedWorldSnapshot. "Visit" a world: its anonymized hierarchy + agent states (no
 * code, no paths, no transcripts). 404 when the world is unknown or Aiven is off.
 */
export async function handleVisitWorld(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  worldId: string,
): Promise<void> {
  const snap = await getWorldSnapshot(worldId);
  if (!snap) {
    json(res, 404, { error: `unknown world: ${worldId}` });
    return;
  }
  json(res, 200, snap);
}
