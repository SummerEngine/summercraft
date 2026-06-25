/**
 * AgentCraft — observability + meta routes (Track A / Brain, lane L4: obs & security).
 *
 * NEW, L4-owned (so it does not collide with L3's route modules). It serves the three operational
 * endpoints the charter §0 "Observable" box requires, split apart on purpose:
 *
 *   GET /metrics  -> Prometheus/OpenMetrics text (live_sessions, turn latency, error rate, lock
 *                    contention, token usage). Also accepts Accept: application/json for the raw snapshot.
 *   GET /ready    -> READINESS: are dependencies actually usable? Probes Postgres with a bounded
 *                    `SELECT 1` (not just `getPg()!=null`), reports config validity + auth mode. 200 when
 *                    ready, 503 when a required dependency is down. This is what an orchestrator gates on.
 *   GET /live     -> LIVENESS: is the process up and the event loop responsive? Always 200 unless the
 *                    process is wedged. Never probes a dependency, so a slow Postgres can't fail liveness.
 *
 * MOUNTING: this module is owned by L4 but the router is owned by L3. To avoid editing L3's files, this
 * exports a single `tryMetaRoute(req, res, url) => Promise<boolean>` the L3 router can call near the top
 * of its dispatch (returns true once it has handled the request). The individual handlers are also
 * exported so L3 can wire them branch-by-branch if it prefers. Until L3 mounts it, the routes are
 * inert — importing this file has no side effects and changes no existing behavior.
 *
 * Defensive: nothing here may hang boot or crash. The pg probe is wrapped in a hard timeout; every
 * handler is try/caught into a degraded-but-valid response. Secrets are redacted out of every field.
 */
import http from "node:http";

import { metrics, METRIC } from "../metrics.ts";
import { sessionManager } from "../session-manager.ts";
import { getPg, aivenConfigured } from "../aiven/pg.ts";
import { operatorReady } from "../aiven/operator.ts";
import { authMode } from "../auth.ts";
import { redact } from "../security.ts";
import { json } from "./router.ts";

/** Max time the readiness pg probe may take before we declare Postgres unhealthy. */
const PG_PROBE_TIMEOUT_MS = 2000;

type PgHealth = "off" | "configured" | "up" | "down";

/**
 * Probe Postgres health for readiness. Returns:
 *   - "off"        Aiven isn't configured at all (no URI) -> not a readiness failure; /world uses local.
 *   - "configured" configured but no live pool yet (initPg not called) -> treated as not-ready.
 *   - "up"         a `SELECT 1` succeeded within the timeout.
 *   - "down"       configured + pool exists but the probe errored or timed out.
 * Never throws; the timeout guarantees it can't hang /ready even against a black-holed DB.
 */
async function probePg(): Promise<PgHealth> {
  if (!aivenConfigured()) return "off";
  const pg = getPg();
  if (!pg) return "configured";
  try {
    const probe = pg.query("SELECT 1");
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("pg probe timeout")), PG_PROBE_TIMEOUT_MS),
    );
    // NOTE: the race bounds /ready at 2s, but the SELECT 1 itself keeps running until the pool's own
    // connectionTimeoutMillis (~8s) elapses. We intentionally issue a fresh probe rather than reuse
    // pg.ts's cached pgHealth(): that helper returns a {ok,...} object and can't express the off /
    // configured / up / down states /ready reports. Sustained polling of a black-holed DB could pin
    // pool connections for up to that window — acceptable for a readiness probe; the pool bound caps it.
    await Promise.race([probe, timeout]);
    return "up";
  } catch {
    return "down";
  }
}

/**
 * GET /metrics. Refreshes the gauges that are cheap to read on demand (live_sessions), then serves the
 * Prometheus text exposition — or the raw JSON snapshot when the client asks for application/json.
 */
export function handleMetrics(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    // Pull-time gauge refresh: live_sessions is authoritative on the manager, so read it here rather
    // than relying on every spawn/stop path to remember to setGauge.
    metrics.setGauge(METRIC.LIVE_SESSIONS, sessionManager.liveCount);

    const wantsJson = /application\/json/i.test(req.headers["accept"] ?? "");
    if (wantsJson) {
      json(res, 200, metrics.snapshot());
      return;
    }
    const body = metrics.prometheus();
    // The JSON branch above delegates to json() (which also sets Allow-Headers/Allow-Methods); this prom
    // branch sets only Allow-Origin on purpose. A Prometheus scrape is a simple GET with no custom headers,
    // so it never triggers a CORS preflight and needs none of the extra headers — keeping them off avoids
    // implying a preflight contract this read-only text endpoint doesn't have.
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  } catch (e) {
    // /metrics must never crash the process or the request loop.
    json(res, 500, { error: "metrics render failed" });
    void e;
  }
}

/**
 * GET /ready. Readiness = dependencies usable. Aiven "off" is still ready (the sidecar runs fine without
 * it). Not-ready only when a CONFIGURED dependency is actually down (pg "down"/"configured"), or auth
 * resolved to the apikey hard-stop. Returns 200 {ready:true,...} or 503 {ready:false,...}.
 */
export async function handleReady(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const pg = await probePg();
    const auth = authMode().mode;
    // apikey is a billing hard-stop; it is never "ready" even though the process is alive.
    const authReady = auth !== "apikey";
    const pgReady = pg === "off" || pg === "up";
    const ready = pgReady && authReady;
    json(res, ready ? 200 : 503, {
      ready,
      checks: {
        pg, // off | configured | up | down
        auth, // subscription | apikey | unknown
        operator: operatorReady(),
      },
    });
  } catch (e) {
    // A probe failure is itself a not-ready signal, not a crash. Redact the REAL error message — a pg
    // driver error can embed the connection URI (password and all), so this redact() is load-bearing.
    json(res, 503, { ready: false, error: redact(e instanceof Error ? e.message : String(e)) });
  }
}

/**
 * GET /live. Liveness = the process is up and the event loop turned this handler. Deliberately does NO
 * dependency probe so a slow/dead Postgres or a rate-limited Anthropic account can't make us look dead
 * to a supervisor that would then restart us into the same wedge. Always 200 unless truly wedged.
 */
export function handleLive(_req: http.IncomingMessage, res: http.ServerResponse): void {
  json(res, 200, { live: true, uptime_s: Math.round(process.uptime()) });
}

/**
 * Dispatcher the L3 router calls near the top of its table. Handles GET /metrics, GET /ready, GET /live
 * and returns true once it has written a response; returns false (without touching res) for anything
 * else so the router falls through to its own routes. This is the seam that lets L4 own these routes
 * without editing the L3-owned router.
 */
export async function tryMetaRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (method !== "GET") return false;
  switch (url.pathname) {
    case "/metrics":
      handleMetrics(req, res);
      return true;
    case "/ready":
      await handleReady(req, res);
      return true;
    case "/live":
      handleLive(req, res);
      return true;
    default:
      return false;
  }
}
