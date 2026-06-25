/**
 * AgentCraft — operator + status routes (Track A / Brain, plan §3 L3, §4-A).
 *
 *   GET  /operator/missions          -> { ready, missions: OperatorMission[] }
 *   POST /operator/run {mission_id?|prompt?} -> 202 RunResult | {error} at r.code (400/404/503)
 *   GET  /auth/status                -> { mode: 'subscription'|'apikey'|'unknown' }
 *   GET  /health                     -> { ok, live_sessions, auth, aiven, operator }
 *
 * The auth probe itself lives in ../auth.ts (the scrubAnthropicEnv() child probe + apikey-first ordering);
 * these routes only READ its cached result via authMode().
 */
import http from "node:http";

import { sessionManager } from "../session-manager.ts";
import { getPg, aivenConfigured } from "../aiven/pg.ts";
import {
  listMissions,
  runMission,
  operatorReady,
  usingLocalShim,
  missionServableByLocalShim,
} from "../aiven/operator.ts";
import { authMode } from "../auth.ts";
import { json, readBody, safeJson } from "./router.ts";
import { validateId } from "./validate.ts";

/** GET /operator/missions -> { ready, missions }  (the reproducible Autonomous Data Operator beats). */
export function handleMissions(_req: http.IncomingMessage, res: http.ServerResponse): void {
  // HONESTY: never advertise a beat the *currently configured* MCP can't actually serve.
  //   - NO MCP configured (operatorReady() false): there is no endpoint at all, so EVERY mission is
  //     un-servable. Report mcp:"none" + servable:false rather than defaulting to "hosted"/all-servable
  //     (the old bug: an empty URL isn't loopback, so usingLocalShim() was false and the else-branch marked
  //     all 6 servable — including the Kafka/service-control missions no attached MCP could run). runMission
  //     already 503s in this state, so nothing flailed, but the JSON itself must not overclaim.
  //   - LOCAL shim (loopback :8765): serves only the SQL tools, so flag each mission by its required tools.
  //   - HOSTED Aiven MCP (remote URL): assumed to serve every mission.
  // ADDITIVE: the frozen contract shape {id,title,prompt} is preserved verbatim; `servable` is extra.
  const ready = operatorReady();
  const localShim = usingLocalShim();
  const mcp = !ready ? "none" : localShim ? "local-shim" : "hosted";
  const missions = listMissions().map((m) => ({
    id: m.id,
    title: m.title,
    prompt: m.prompt,
    servable: !ready ? false : localShim ? missionServableByLocalShim(m) : true,
  }));
  json(res, 200, { ready, mcp, missions });
}

/**
 * POST /operator/run {mission_id?|prompt?|dry_run?|op_id?} -> 202  (run a data-operator mission via the
 * Aiven MCP). `dry_run` requests the read/plan-only safety rehearsal (no mutating MCP action); `op_id` is the
 * client-supplied idempotency key so a double-clicked run can be de-duplicated. Both are forwarded (they were
 * previously dropped, making the dry-run beat + idempotency unreachable over HTTP) with the same bounded
 * validation the other routes apply — a bad op_id is rejected rather than silently ignored.
 */
export async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req).then(safeJson);

  // op_id (optional): when present it MUST be a safe, bounded id (it keys the idempotency/audit row). Reject
  // a malformed one instead of falling back to a fresh uuid, so a client that relies on dedup gets told.
  let opId: string | null = null;
  if (body?.op_id !== undefined && body?.op_id !== null) {
    const v = validateId(body.op_id, "op_id");
    if (!v.ok) {
      json(res, 400, { error: v.error });
      return;
    }
    opId = v.value;
  }

  const r = await runMission({
    missionId: typeof body?.mission_id === "string" ? body.mission_id : null,
    prompt: typeof body?.prompt === "string" ? body.prompt : null,
    dryRun: body?.dry_run === true,
    opId,
  });
  if (!r.ok) {
    json(res, r.code, { error: r.error });
    return;
  }
  json(res, 202, r);
}

/** GET /auth/status -> { mode }. */
export function handleAuthStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  json(res, 200, authMode());
}

/** GET /health -> liveness (handy for the Godot bridge to detect the sidecar). */
export function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  json(res, 200, {
    ok: true,
    live_sessions: sessionManager.liveCount,
    auth: authMode().mode,
    aiven: aivenConfigured() ? (getPg() ? "on" : "configured") : "off",
    operator: operatorReady(),
  });
}
