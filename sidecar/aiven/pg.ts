/**
 * AgentCraft — Aiven Postgres connection (Track A / Brain, plan §4-A).
 *
 * Owns the single `pg` Pool the sidecar uses to (a) run the coordination migrations on boot and (b) feed
 * the GET /world projection (projection.ts SELECTs through it). The Godot game NEVER holds these creds —
 * it only ever reads the sidecar's /world.
 *
 * Connection string comes from AIVEN_PG_URI (preferred) or DATABASE_URL. If neither is set, Aiven is
 * simply OFF: getPg() returns null and /world falls back to the local seeded records. A short connection
 * timeout means a bad/unreachable URL degrades to OFF instead of hanging boot.
 *
 * ROBUSTNESS (lane L2 hardening):
 *   - query() goes through a retry/reconnect wrapper (queryWithRetry): a transient connection error is
 *     retried with a short backoff, so a brief Postgres blip doesn't immediately drop /world to MOCK.
 *   - a lightweight healthcheck (pingPg / pgHealth) runs `SELECT 1` with a timeout and caches the last
 *     result + latency, so /health and /metrics can surface real DB reachability instead of inferring
 *     "on" from getPg()!=null even when the server is unreachable.
 *   - every wrapper is best-effort and bounded — nothing here may crash /world or hang boot.
 *
 * TLS: Aiven Postgres requires TLS. Point AIVEN_PG_CA at the CA cert Aiven gives you in the console
 * (or inline it via AIVEN_PG_CA_PEM) and the connection is fully verified. As a last-resort demo
 * escape hatch, AIVEN_PG_SSL_INSECURE=1 disables verification (MITM-exposed — logged loudly, never the
 * default). With no CA and no insecure flag we still require TLS but fall back to the system trust store.
 */
import fsSync from "node:fs";
import { Pool } from "pg";
import { logger } from "../logger.ts";
import { metrics } from "../metrics.ts";
import { runMigrations } from "./migrations.ts";

/** Minimal structural type the projection consumes — matches pg.Pool's query(). */
export interface PgLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Minimal structural type of a checked-out pg client (pool.connect()) — query + release. */
interface PoolClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

let pool: Pool | null = null;
let initialized = false;

/** Cached health of the last ping so /health + /metrics read it without each issuing their own probe. */
export interface PgHealth {
  /** true once at least one successful ping landed; false before the first probe or after a failure. */
  ok: boolean;
  /** epoch ms of the last ping attempt (success or failure), or 0 before the first probe. */
  checkedAt: number;
  /** round-trip latency of the last successful ping in ms, or null. */
  latencyMs: number | null;
  /** last ping error message (redacted of the conn string by pg), or null when healthy. */
  error: string | null;
}
let health: PgHealth = { ok: false, checkedAt: 0, latencyMs: null, error: null };

/** How long a single ping is allowed to take before we call the DB unreachable. */
const PING_TIMEOUT_MS = 4000;
/** True while a ping is outstanding — so repeated /health + /metrics probes can't stack pings on a slow DB. */
let pingInFlight = false;
/** Per-query retry policy for transient connection errors (NOT for SQL/logic errors — those bubble). */
const QUERY_MAX_ATTEMPTS = 2;
const QUERY_RETRY_DELAY_MS = 250;

/**
 * How often this sidecar refreshes last_seen for the LIVE agents it owns in Postgres. MUST be well under
 * the projection's STALE_AFTER_S (15s) so a live agent never trips the stale/self-heal gate between beats.
 * registerAgent() is the only OTHER writer of last_seen and it fires once per agent at boot — without this
 * periodic bump every live agent would go stale ~15s after boot and the projection would block it AND reap
 * its locks. This is the in-lane keep-alive that makes the live multi-process Aiven path correct.
 *
 * CRITICAL: the bump is SCOPED to the agent_ids whose in-process Claude SDK session is actually live (see
 * startHeartbeat's liveIds provider). It MUST NOT blanket-bump every row: that would keep a crashed/wedged
 * in-process session's row — AND any external agent's auto-registered row (claim_file upserts one) — fresh
 * forever, so it never goes stale and the projection's abandoned-lock self-heal (selfHealAbandonedLocks)
 * could never reap its lock. The whole "agent-child crash → the file frees, the loser proceeds" resilience
 * guarantee (charter §0) lives or dies on this scoping.
 */
const HEARTBEAT_INTERVAL_MS = 5000;
/** The periodic last_seen-refresh timer, or null when not running. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
/** True while a heartbeat UPDATE is outstanding so a slow DB can't stack overlapping beats. */
let heartbeatInFlight = false;
/** Returns the agent_ids whose in-process session is live RIGHT NOW — only these get their last_seen bumped. */
let liveAgentIds: (() => string[]) | null = null;

/** The connection string, if Aiven is configured. */
function connString(): string {
  return (process.env.AIVEN_PG_URI || process.env.DATABASE_URL || "").trim();
}

/** True when a Postgres connection string is configured (Aiven is meant to be ON). */
export function aivenConfigured(): boolean {
  return connString() !== "";
}

/**
 * Create the pool (idempotent). Does NOT connect yet — pg connects lazily on first query — but a bad URL
 * surfaces on the first query, not here, so boot never hangs. Returns null when unconfigured.
 */
export function initPg(): PgLike | null {
  if (initialized) return pool;
  initialized = true;
  const cs = connString();
  if (!cs) {
    logger.info("[aiven/pg] no AIVEN_PG_URI/DATABASE_URL — Aiven OFF, /world uses local records.");
    return null;
  }
  // resolveSsl(cs) reads the ORIGINAL sslmode to decide verify-vs-not; then we STRIP sslmode from the
  // string we hand pg. Newer pg treats `sslmode=require` in the connection string as full verification
  // (rejecting Aiven's private CA), which would override our explicit ssl option — so removing it lets
  // our `ssl` config be the single source of truth (encrypt-without-verify for require, verified with a CA).
  const sslConf = resolveSsl(cs);
  pool = new Pool({
    connectionString: stripSslMode(cs),
    ssl: sslConf,
    max: 4,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30_000,
  });
  // A pool-level error (e.g. server drop) must never crash the process; log and let queries fall back.
  // We also mark health down so /health reflects the drop until the next successful ping/query.
  pool.on("error", (e) => {
    health = { ok: false, checkedAt: Date.now(), latencyMs: null, error: e.message };
    metrics.inc("aiven_pg_pool_errors");
    logger.error("[aiven/pg] pool error:", { error: e.message });
  });
  logger.info("[aiven/pg] Aiven ON — pool created.");
  return pool;
}

/**
 * Resolve the TLS config for the pool. Prefer a CA-verified connection (AIVEN_PG_CA = path to Aiven's
 * ca.pem, or AIVEN_PG_CA_PEM = inline PEM). Only disable verification behind the explicit
 * AIVEN_PG_SSL_INSECURE=1 escape hatch (logged loudly). Otherwise require TLS via the system trust store.
 */
function resolveSsl(cs: string): false | { ca?: string; rejectUnauthorized: boolean } {
  // Local / non-TLS Postgres (docker, dev): plaintext. Detected by an explicit `sslmode=disable`, a
  // loopback host, or AGENTCRAFT_PG_NO_SSL=1. Aiven always speaks TLS, so this only ever fires locally —
  // it's how the same code path proves the full loop on local infra before a real Aiven URL is swapped in.
  if (isLocalNoSsl(cs)) {
    logger.info("[aiven/pg] local/no-SSL Postgres detected — plaintext connection (loopback).");
    return false;
  }
  const inlineCa = process.env.AIVEN_PG_CA_PEM?.trim();
  const caPath = process.env.AIVEN_PG_CA?.trim();
  if (inlineCa) return { ca: inlineCa, rejectUnauthorized: true };
  if (caPath) {
    try {
      return { ca: fsSync.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
    } catch (e) {
      logger.warn(`[aiven/pg] could not read AIVEN_PG_CA (${caPath}): ${msg(e)} — falling back.`);
    }
  }
  if (process.env.AIVEN_PG_SSL_INSECURE === "1") {
    logger.warn("[aiven/pg] ⚠ AIVEN_PG_SSL_INSECURE=1 — TLS verification DISABLED (MITM-exposed). Set AIVEN_PG_CA for the real demo.");
    return { rejectUnauthorized: false };
  }
  // Honour libpq sslmode semantics from the URI: `require`/`prefer`/`allow` mean "encrypt, but don't
  // verify the CA" — so an Aiven Service URI (which ships ?sslmode=require) works with NO cert download.
  // `verify-ca`/`verify-full` (or pointing AIVEN_PG_CA at the cert above) is the verified production path.
  const sslmode = sslModeOf(cs);
  if (sslmode === "require" || sslmode === "prefer" || sslmode === "allow") {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true }; // verify against the system trust store (sslmode=verify-* / unset)
}

/**
 * Remove the `sslmode` query param so pg can't impose its own TLS policy over our explicit `ssl` option.
 * Pure string surgery — we deliberately do NOT round-trip through URL(), which would re-encode the
 * password (and break auth on passwords with characters URL() escapes differently).
 */
function stripSslMode(cs: string): string {
  return cs
    .replace(/([?&])sslmode=[a-z0-9-]+/i, "$1") // drop sslmode=...
    .replace(/\?&/, "?") // ?& -> ?
    .replace(/&&/g, "&") // && -> &
    .replace(/[?&]$/, ""); // tidy a trailing ? or &
}

/** The sslmode query param of a connection string, lowercased ("" if absent/unparseable). */
function sslModeOf(cs: string): string {
  try {
    return (new URL(cs).searchParams.get("sslmode") || "").toLowerCase();
  } catch {
    const m = cs.match(/sslmode=([a-z-]+)/i);
    return m ? m[1].toLowerCase() : "";
  }
}

/** True for a loopback / sslmode=disable / AGENTCRAFT_PG_NO_SSL connection — local infra, plaintext OK. */
function isLocalNoSsl(cs: string): boolean {
  if (process.env.AGENTCRAFT_PG_NO_SSL === "1") return true;
  try {
    const u = new URL(cs);
    if ((u.searchParams.get("sslmode") || "").toLowerCase() === "disable") return true;
    const h = u.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return /sslmode=disable/i.test(cs);
  }
}

/** The live pool, or null when Aiven is unconfigured. Call initPg() once on boot first. */
export function getPg(): PgLike | null {
  return pool;
}

/** True when an error looks like a transient connection problem worth one reconnect/retry. */
function isTransient(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  // pg surfaces these on a dropped/restarting server / pool teardown; SQL errors (syntax, unique, FK)
  // never match, so logic errors bubble immediately instead of being uselessly retried.
  // "cannot use a pool after calling end()" is a teardown error, not a transient blip — exclude it so a
  // retry during shutdown doesn't spin.
  if (m.includes("after calling end")) return false;
  return (
    m.includes("econnrefused") ||
    m.includes("econnreset") ||
    m.includes("etimedout") ||
    m.includes("connection terminated") ||
    m.includes("connection ended") ||
    m.includes("server closed the connection") ||
    m.includes("terminating connection") ||
    m.includes("timeout")
  );
}

/**
 * Run a query through the pool with a single reconnect/retry on a TRANSIENT connection error. pg already
 * reconnects pooled clients lazily, so the retry simply re-issues the query after a short backoff to ride
 * over a momentary blip without dropping /world to the mock. SQL/logic errors are NOT retried — they
 * bubble on the first attempt. Returns null when Aiven is unconfigured (caller falls back).
 *
 * `opts.stampHealth` (default true): a successful FOREGROUND query is a real liveness signal, so it refreshes
 * pgHealth. The BACKGROUND keep-alive heartbeat passes false: it must NOT stamp health, or it would
 * continuously paint health ok=true off a trivial write even while read-path projection queries are timing
 * out — masking a half-wedged DB from /health + /metrics. pgHealth stays authoritatively driven by pingPg +
 * foreground queries only (the heartbeat reports its own liveness via the aiven_pg_heartbeat_ok gauge).
 */
export async function queryWithRetry(
  text: string,
  params?: unknown[],
  opts: { stampHealth?: boolean } = {},
): Promise<{ rows: any[] } | null> {
  const pg = pool;
  if (!pg) return null;
  const stampHealth = opts.stampHealth !== false;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= QUERY_MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await pg.query(text, params);
      // A successful FOREGROUND query is also a liveness signal — keep health fresh without a separate ping.
      // Measure THIS query's real round-trip rather than reusing the last ping's latency, so /health +
      // /metrics never present a stale number as a freshly-measured one (the round-trip is a true liveness
      // latency). The background heartbeat opts out (stampHealth=false) so it can't mask a half-wedged DB.
      if (stampHealth) {
        health = { ok: true, checkedAt: Date.now(), latencyMs: Date.now() - startedAt, error: null };
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < QUERY_MAX_ATTEMPTS && isTransient(e)) {
        metrics.inc("aiven_pg_query_retries");
        logger.warn("[aiven/pg] transient query error — retrying", {
          attempt,
          error: msg(e),
        });
        await sleep(QUERY_RETRY_DELAY_MS);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Lightweight healthcheck: `SELECT 1` bounded by PING_TIMEOUT_MS. Updates + returns the cached PgHealth.
 * Never throws — a failure is reported as { ok:false }. No-op (ok:false) when Aiven is unconfigured.
 */
export async function pingPg(): Promise<PgHealth> {
  const pg = pool;
  if (!pg) {
    health = { ok: false, checkedAt: Date.now(), latencyMs: null, error: "unconfigured" };
    return health;
  }
  // Don't stack pings: if one is already outstanding (slow/wedged DB), return the cached health rather than
  // checking out another pooled connection — a burst of /health + /metrics probes could otherwise exhaust
  // the max:4 pool and starve /world. Self-corrects once the in-flight ping settles.
  if (pingInFlight) return health;
  pingInFlight = true;
  const startedAt = Date.now();
  // Pin the ping to a dedicated client and bound it at the DRIVER level (statement_timeout) so a wedged
  // SELECT 1 is actually CANCELLED server-side and the connection released, not left holding a pooled slot
  // until pg's own socket timeout fires. withTimeout still caps the wall-clock so connect() itself can't hang.
  try {
    const client: PoolClient = await withTimeout(pg.connect(), PING_TIMEOUT_MS, "pg ping connect timeout");
    try {
      await withTimeout(
        client.query(`SET statement_timeout TO ${PING_TIMEOUT_MS}`).then(() => client.query("SELECT 1")),
        PING_TIMEOUT_MS,
        "pg ping timeout",
      );
      const latencyMs = Date.now() - startedAt;
      health = { ok: true, checkedAt: Date.now(), latencyMs, error: null };
      metrics.observe("aiven_pg_ping_ms", latencyMs);
    } finally {
      client.release();
    }
  } catch (e) {
    health = { ok: false, checkedAt: Date.now(), latencyMs: null, error: msg(e) };
    metrics.inc("aiven_pg_ping_failures");
  } finally {
    pingInFlight = false;
  }
  return health;
}

/** The cached health from the last ping/successful query (no I/O). For /health + /metrics. */
export function pgHealth(): PgHealth {
  return health;
}

/**
 * Start the periodic last_seen heartbeat (idempotent; no-op when Aiven is unconfigured). A bounded
 * setInterval bumps last_seen=now() ONLY for the agent_ids whose in-process session is live right now, as
 * reported by the `liveIds` provider, so a live agent never trips the projection's stale/self-heal gate
 * (STALE_AFTER_S) — while a crashed/wedged session's row (and any external agent's row we don't own) is
 * left to legitimately go stale so selfHealAbandonedLocks can reap its abandoned lock.
 *
 * Why SCOPED, not a blanket `UPDATE … SET last_seen = now()` over every row: a single in-process Claude SDK
 * session can crash/wedge while still holding a Postgres lock. If the surviving sidecar kept bumping that
 * dead agent's row, it would never go stale and its lock would never be reaped — silently neutering the
 * exact single-agent-crash case the self-heal exists for (charter §0: "the file frees, the loser proceeds").
 * One bounded round-trip is preserved: `UPDATE … WHERE agent_id = ANY($1)` with the live id list (a no-op
 * when the list is empty). The bump is best-effort (queryWithRetry, never throws) and the interval is
 * unref()'d so it can never hold the process open.
 *
 * `liveIds` is INJECTED (not imported) to keep pg.ts decoupled from the session subsystem — the projection
 * passes `() => sessionManager.list().map(s => s.agentId)`. Lazily started from worldProjection() (mirrors
 * the Kafka consumer's lazy start) so the L2 lane needs no extra bootstrap wiring; stopped in closePg().
 */
export function startHeartbeat(liveIds: () => string[]): void {
  if (heartbeatTimer || !pool) return;
  liveAgentIds = liveIds;
  heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return; // a prior beat is still draining against a slow DB — skip this tick
    // Scope the bump to live sessions only. No live ids (provider missing or fleet idle) -> skip the round
    // trip entirely, so a crashed agent's row is never refreshed and the self-heal gate stays honest.
    const ids = liveAgentIds ? liveAgentIds() : [];
    if (ids.length === 0) return;
    heartbeatInFlight = true;
    // stampHealth:false — a keep-alive write must not refresh pgHealth (that would mask a half-wedged DB
    // whose read path is timing out). The heartbeat reports its OWN liveness via aiven_pg_heartbeat_ok.
    void queryWithRetry("UPDATE world_state.agents SET last_seen = now() WHERE agent_id = ANY($1)", [ids], {
      stampHealth: false,
    })
      .then(() => metrics.setGauge("aiven_pg_heartbeat_ok", 1))
      .catch((e) => {
        metrics.setGauge("aiven_pg_heartbeat_ok", 0);
        logger.warn("[aiven/pg] heartbeat last_seen bump failed", { error: msg(e) });
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, HEARTBEAT_INTERVAL_MS);
  // Never keep the event loop (and thus the process) alive solely for the heartbeat.
  heartbeatTimer.unref?.();
  logger.info("[aiven/pg] last_seen heartbeat started", { intervalMs: HEARTBEAT_INTERVAL_MS });
}

/** Stop the periodic heartbeat (idempotent). Called from closePg() on shutdown. */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatInFlight = false;
  liveAgentIds = null;
}

/**
 * Run the versioned migrations (idempotent — see aiven/migrations.ts). KEEPS THE NAME `applySchema` so
 * server.ts and aiven-smoke.ts keep importing it unchanged; the implementation is now the migration
 * runner instead of applying schema.sql whole. Returns false (and logs) on any failure so boot continues
 * with Aiven degraded rather than crashing. No-op when unconfigured.
 */
export async function applySchema(): Promise<boolean> {
  const pg = getPg();
  if (!pg) return false;
  try {
    const ok = await runMigrations(pg);
    if (ok) logger.info("[aiven/pg] migrations applied (world_state).");
    return ok;
  } catch (e) {
    logger.error("[aiven/pg] migration run failed (Aiven degraded):", { error: msg(e) });
    return false;
  }
}

/**
 * Upsert a presence row for an agent into world_state.agents so a seeded/idle NPC also exists in the
 * Aiven projection (not just the local store). Best-effort; never throws. No-op when unconfigured.
 *
 * The ON CONFLICT refreshes last_seen (so a freshly re-registered agent isn't immediately flagged stale by
 * the projection's STALE_AFTER_S gate on the very first /world after a restart) and the IDENTITY columns
 * (repo/path/kind/label) — but DELIBERATELY does NOT overwrite the coordination columns
 * (state/status_line/current_task/denied_at). On a boot re-seed, if a separate process/agent legitimately
 * holds 'working' + a fresh lock in Postgres, clobbering its state back to 'waiting'/'idle' would stomp
 * authoritative multi-writer coordination state. We refresh presence/identity and let the live owner (or
 * the projection's last_seen-driven stale gate) decide the coordination state.
 */
export async function registerAgent(rec: {
  agent_id: string;
  repo_id: string;
  repo_path: string;
  character_kind: string;
  label: string;
  state?: string;
  status_line?: string;
}): Promise<void> {
  if (!pool) return;
  try {
    await queryWithRetry(
      `INSERT INTO world_state.agents
         (agent_id, repo_id, repo_path, character_kind, label, state, status_line, last_seen)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (agent_id) DO UPDATE
         SET repo_id = EXCLUDED.repo_id,
             repo_path = EXCLUDED.repo_path,
             character_kind = EXCLUDED.character_kind,
             label = EXCLUDED.label,
             last_seen = now()`,
      [
        rec.agent_id,
        rec.repo_id,
        rec.repo_path,
        rec.character_kind,
        rec.label,
        rec.state ?? "waiting",
        rec.status_line ?? "idle",
      ],
    );
  } catch (e) {
    logger.warn(`[aiven/pg] registerAgent(${rec.agent_id}) failed: ${msg(e)}`);
  }
}

/**
 * Push a locally-owned agent's live coordination state (current_task / target_base_id / status_line /
 * state) into world_state.agents so the Aiven PROJECTION renders real values for OTHER processes reading
 * /world — not current_task=null / target_base_id=null (A-4). registerAgent() is presence-only (it
 * deliberately never clobbers coordination columns on conflict), so without this writer a row that exists in
 * Postgres but isn't live on the READING host always projected a null task/target. This is the in-lane
 * status writer the projection needs: the agent's OWN host calls it when its task changes, last_seen is
 * refreshed too (so the update doubles as a heartbeat), and the row must already exist — a missing agent is a
 * no-op (registerAgent seeds presence first). Best-effort; never throws. No-op when Aiven is OFF.
 *
 * Only the host that OWNS the live agent should call this (it writes authoritative task state); a non-owning
 * host never calls it, so it can't stomp the owner's state. Coordination columns NOT supplied are left as-is.
 */
export async function syncAgentTask(rec: {
  agent_id: string;
  current_task?: string | null;
  target_base_id?: string | null;
  status_line?: string;
  state?: string;
  /** Force current_task back to NULL (mission finished). Distinguishes "clear" from "leave unchanged". */
  clearTask?: boolean;
}): Promise<void> {
  if (!pool) return;
  try {
    // COALESCE($n, col) means an omitted (null) field is LEFT UNCHANGED, so a partial sync only touches what
    // it sets. current_task is special: a null arg normally means "leave it", so an explicit `clearTask` is
    // needed to actually null it on completion (otherwise a finished mission would linger cross-process).
    await queryWithRetry(
      `UPDATE world_state.agents
          SET current_task   = CASE WHEN $6 THEN NULL ELSE COALESCE($2, current_task) END,
              target_base_id = COALESCE($3, target_base_id),
              status_line    = COALESCE($4, status_line),
              state          = COALESCE($5, state),
              last_seen      = now()
        WHERE agent_id = $1`,
      [
        rec.agent_id,
        rec.current_task ?? null,
        rec.target_base_id ?? null,
        rec.status_line ?? null,
        rec.state ?? null,
        rec.clearTask === true,
      ],
    );
  } catch (e) {
    logger.warn(`[aiven/pg] syncAgentTask(${rec.agent_id}) failed: ${msg(e)}`);
  }
}

/** Close the pool on shutdown. Best-effort. */
export async function closePg(): Promise<void> {
  stopHeartbeat();
  try {
    await pool?.end();
  } catch {
    /* ignore */
  }
  pool = null;
  initialized = false;
  health = { ok: false, checkedAt: 0, latencyMs: null, error: null };
}

/** Resolve once `ms` elapses. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Race a promise against a timeout so a wedged query can't hang the healthcheck. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
