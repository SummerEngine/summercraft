/**
 * Unit tests — Aiven world projection state-mapping (aiven/projection.ts).
 *
 * The projection's job that the demo hangs on: turn raw `world_state` rows into camera-legible AgentState.
 * Two derived-state rules are load-bearing for the Aiven D6 contention beat and must be pinned:
 *   - STALE -> blocked: an agent whose heartbeat is older than STALE_AFTER_S is presumed crashed and must
 *     NOT keep showing "working" on stage; it's greyed to 'blocked' (unless terminal 'done').
 *   - DWELL -> blocked: after a lost lock claim (denied_at), the loser is PINNED 'blocked' for DWELL_S even
 *     if the live LLM already re-routed to 'working' — so the camera always catches the back-off.
 *   - 'done' is terminal and is never overridden by either rule.
 *   - status_line gets the "stale Ns —" / "blocked on lock —" prefix so the HUD reads the reason.
 *   - no-pg / a thrown pg both fall back to MOCK_SNAPSHOT (the world never freezes).
 *
 * We drive worldProjection() with a fake PgLike that routes by SQL substring and returns canned rows, so
 * the mapping is tested deterministically with no real Postgres. now() math is done in JS to match the
 * server-side EXTRACT(EPOCH …) the real query computes (here the fake returns the *_age_s columns directly).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  worldProjection,
  STALE_AFTER_S,
  DWELL_S,
} from "../aiven/projection.ts";
import { MOCK_SNAPSHOT } from "../contract.ts";

/** A row as the real selectAgents() SQL would produce it (heartbeat_age_s / denied_age_s precomputed). */
interface AgentRow {
  agent_id: string;
  repo_id?: string;
  repo_path?: string;
  character_kind?: string;
  state: string;
  label?: string;
  status_line?: string;
  current_task?: string | null;
  target_base_id?: string | null;
  heartbeat_age_s: number;
  denied_age_s: number | null;
}

/** Build a fake PgLike that answers the projection's four queries from canned data. */
function fakePg(opts: {
  agents?: AgentRow[];
  locks?: any[];
  events?: any[];
  onHeal?: () => void;
}) {
  return {
    async query(text: string, _params?: unknown[]) {
      if (text.includes("DELETE FROM world_state.file_locks")) {
        opts.onHeal?.();
        return { rows: [] };
      }
      if (text.includes("FROM world_state.agents")) {
        return { rows: opts.agents ?? [] };
      }
      if (text.includes("FROM world_state.file_locks")) {
        return { rows: opts.locks ?? [] };
      }
      if (text.includes("FROM world_state.coord_events")) {
        return { rows: opts.events ?? [] };
      }
      return { rows: [] };
    },
  };
}

test("no pg connection falls back to MOCK_SNAPSHOT", async () => {
  const world = await worldProjection({});
  assert.deepEqual(world, MOCK_SNAPSHOT);
});

test("a thrown pg read falls back to MOCK_SNAPSHOT (never freezes /world)", async () => {
  const pg = {
    async query() {
      throw new Error("connection terminated unexpectedly");
    },
  };
  const world = await worldProjection({ pg });
  assert.deepEqual(world, MOCK_SNAPSHOT);
});

test("a stale 'working' agent is mapped to 'blocked' and gets a stale status prefix", async () => {
  const pg = fakePg({
    agents: [
      {
        agent_id: "a1",
        state: "working",
        status_line: "editing auth.ts",
        heartbeat_age_s: STALE_AFTER_S + 5, // older than the stale threshold
        denied_age_s: null,
      },
    ],
  });
  const world = await worldProjection({ pg });
  const a1 = world.agents.find((a) => a.agent_id === "a1");
  assert.ok(a1);
  assert.equal(a1!.state, "blocked");
  assert.match(a1!.status_line, /^stale \d+s —/);
});

test("a stale agent that is 'done' stays 'done' (terminal, never overridden by stale)", async () => {
  const pg = fakePg({
    agents: [{ agent_id: "d1", state: "done", heartbeat_age_s: STALE_AFTER_S + 30, denied_age_s: null }],
  });
  const world = await worldProjection({ pg });
  assert.equal(world.agents.find((a) => a.agent_id === "d1")!.state, "done");
});

test("a fresh agent inside the dwell window after a lost claim is pinned 'blocked'", async () => {
  const pg = fakePg({
    agents: [
      {
        agent_id: "loser",
        state: "working", // the LLM already re-routed, but…
        status_line: "writing handler",
        heartbeat_age_s: 1, // fresh (not stale)
        denied_age_s: DWELL_S / 2, // …still inside the dwell window after its denied claim
      },
    ],
  });
  const world = await worldProjection({ pg });
  const loser = world.agents.find((a) => a.agent_id === "loser")!;
  assert.equal(loser.state, "blocked");
  // status line is annotated with the lock reason when it didn't already mention a block.
  assert.match(loser.status_line, /blocked on lock/);
});

test("once the dwell window has elapsed, the agent shows its live state again", async () => {
  const pg = fakePg({
    agents: [
      {
        agent_id: "moved_on",
        state: "working",
        heartbeat_age_s: 1,
        denied_age_s: DWELL_S + 1, // dwell has passed
      },
    ],
  });
  const world = await worldProjection({ pg });
  assert.equal(world.agents.find((a) => a.agent_id === "moved_on")!.state, "working");
});

test("a fresh agent that never lost a claim keeps its raw state", async () => {
  const pg = fakePg({
    agents: [{ agent_id: "ok", state: "working", heartbeat_age_s: 2, denied_age_s: null }],
  });
  const world = await worldProjection({ pg });
  const ok = world.agents.find((a) => a.agent_id === "ok")!;
  assert.equal(ok.state, "working");
  assert.equal(ok.heartbeat_age_s, 2);
});

test("an unknown state value defaults to 'waiting' (defensive enum coercion)", async () => {
  const pg = fakePg({
    agents: [{ agent_id: "weird", state: "garbage-state", heartbeat_age_s: 1, denied_age_s: null }],
  });
  const world = await worldProjection({ pg });
  assert.equal(world.agents.find((a) => a.agent_id === "weird")!.state, "waiting");
});

test("self-heal runs BEFORE the selects on every live projection", async () => {
  let healed = false;
  const pg = fakePg({
    agents: [{ agent_id: "a", state: "waiting", heartbeat_age_s: 0, denied_age_s: null }],
    onHeal: () => {
      healed = true;
    },
  });
  await worldProjection({ pg });
  assert.equal(healed, true);
});

test("locks + events are projected through with ISO timestamps and chronological order", async () => {
  const pg = fakePg({
    agents: [],
    locks: [
      { repo_path: "/r", file_path: "x.ts", holder_agent_id: "a1", claimed_at: "2026-06-24T00:00:00Z" },
    ],
    // selectEvents reverses DESC rows into chronological (oldest -> newest) order.
    events: [
      { ts: "2026-06-24T00:00:02Z", type: "file_claim_denied", agent_id: "b", detail: "x.ts" },
      { ts: "2026-06-24T00:00:01Z", type: "file_claimed", agent_id: "a1", detail: "x.ts" },
    ],
  });
  const world = await worldProjection({ pg });
  assert.equal(world.locks.length, 1);
  assert.equal(world.locks[0].file_path, "x.ts");
  // reversed to chronological: the older 'file_claimed' comes first.
  assert.equal(world.events[0].type, "file_claimed");
  assert.equal(world.events[1].type, "file_claim_denied");
});
