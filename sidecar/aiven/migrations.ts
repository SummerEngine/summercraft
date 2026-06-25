/**
 * AgentCraft — versioned, idempotent migration runner (Track A / Brain, lane L2, plan §2 L2).
 *
 * Replaces the old "apply the whole schema.sql on every boot" with a real migration runner:
 *   - migrations live in aiven/migrations/NNNN_name.sql, applied in lexical (== numeric) order;
 *   - a version-tracking table (world_state.schema_migrations) records which versions are applied,
 *     so a migration runs exactly once and a non-idempotent/destructive change can be added safely;
 *   - each pending migration runs inside its OWN transaction ON A SINGLE PINNED CONNECTION (a client
 *     checked out of the Pool, NOT pool.query() which can spread BEGIN/COMMIT across connections) — a
 *     failing migration rolls back and STOPS the run (no half-applied schema), leaving everything before it
 *     committed.
 *
 * SAFETY CONTRACT (this never crashes /world or hangs boot):
 *   - runMigrations() is best-effort: any failure logs through the shared logger and returns false so
 *     boot continues with Aiven *degraded* rather than crashing (same contract the old applySchema had).
 *   - the version table bootstrap is itself idempotent (CREATE … IF NOT EXISTS), so a brand-new DB and a
 *     DB that already had the pre-migration schema applied both converge: 0001_init is fully
 *     idempotent (CREATE … IF NOT EXISTS / CREATE OR REPLACE), so recording it as applied on a legacy DB
 *     is harmless.
 *
 * KEEPS the existing seam stable: pg.ts re-exports applySchema() as a thin wrapper over runMigrations()
 * so aiven-smoke.ts and server.ts keep importing { applySchema } unchanged.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.ts";
import { metrics } from "../metrics.ts";
import type { PgLike } from "./pg.ts";

/**
 * A checked-out client: a single physical connection with query() + release(). The migration transaction
 * MUST run on one of these, never on a Pool — see the PoolLike note + applyOne() below.
 */
interface ClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

/**
 * A Pool that can hand out a pinned client. node-pg's Pool.query() acquires a DIFFERENT client per call and
 * releases it immediately, so BEGIN/…/COMMIT issued as separate pool.query() calls can land on separate
 * physical connections — the transaction (and its ROLLBACK) would be a no-op, allowing a half-applied
 * multi-statement migration. We therefore pin a client via connect() for the transactional DDL. The runner
 * still accepts a query-only PgLike (a test double, or a single Client) and degrades to the non-pinned path.
 */
interface PoolLike extends PgLike {
  connect(): Promise<ClientLike>;
}

function canPinClient(pg: PgLike): pg is PoolLike {
  return typeof (pg as PoolLike).connect === "function";
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** A migration file resolved off disk: its version key (the leading number) and full SQL text. */
interface Migration {
  /** the full filename, e.g. "0001_init.sql" — also the recorded version key (stable, ordered). */
  version: string;
  sql: string;
}

/** Only files like 0001_init.sql / 0002_operations_audit.sql are migrations; everything else is ignored. */
function isMigrationFile(name: string): boolean {
  return /^\d{4}_.+\.sql$/.test(name);
}

/** Read + lexically sort the migration files. Returns [] (logged) if the dir is missing/unreadable. */
async function loadMigrations(): Promise<Migration[]> {
  let files: string[];
  try {
    files = await fs.readdir(MIGRATIONS_DIR);
  } catch (e) {
    logger.warn("[aiven/migrations] migrations dir unreadable — no migrations applied", {
      error: msg(e),
    });
    return [];
  }
  const ordered = files.filter(isMigrationFile).sort(); // 0001 < 0002 < … lexical == numeric here
  const out: Migration[] = [];
  for (const f of ordered) {
    try {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), "utf8");
      out.push({ version: f, sql });
    } catch (e) {
      // A single unreadable file must not silently reorder/skip the rest — stop loading so we never
      // apply a later migration before an earlier one that couldn't be read.
      logger.error("[aiven/migrations] could not read migration — stopping load", {
        version: f,
        error: msg(e),
      });
      break;
    }
  }
  return out;
}

/** Bootstrap the version table. Idempotent; lives in world_state alongside the rest of the schema. */
async function ensureVersionTable(pg: PgLike): Promise<void> {
  await pg.query("CREATE SCHEMA IF NOT EXISTS world_state");
  await pg.query(
    `CREATE TABLE IF NOT EXISTS world_state.schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** The set of already-applied versions. Empty set on any read error (we'll just try to apply). */
async function appliedVersions(pg: PgLike): Promise<Set<string>> {
  try {
    const { rows } = await pg.query("SELECT version FROM world_state.schema_migrations");
    return new Set(rows.map((r) => String(r.version)));
  } catch (e) {
    logger.warn("[aiven/migrations] could not read schema_migrations — treating none as applied", {
      error: msg(e),
    });
    return new Set();
  }
}

/**
 * Apply all pending migrations in order. Returns true iff every pending migration applied (or there were
 * none). On the first failure it logs, leaves prior migrations committed, and returns false (boot
 * continues, Aiven degraded). No-op-safe to call on every boot — applied migrations are skipped.
 *
 * Each migration runs in its own transaction on a single pinned connection (applyOne) so a partial file
 * can't leave half a schema behind. We use the simple-query protocol (client.query(text) with no params)
 * so a multi-statement .sql file runs as one round-trip, exactly like the old applySchema did.
 */
export async function runMigrations(pg: PgLike): Promise<boolean> {
  try {
    await ensureVersionTable(pg);
  } catch (e) {
    logger.error("[aiven/migrations] could not ensure version table (Aiven degraded)", {
      error: msg(e),
    });
    return false;
  }

  const [migrations, applied] = await Promise.all([loadMigrations(), appliedVersions(pg)]);
  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    logger.info("[aiven/migrations] schema up to date", { applied: applied.size });
    return true;
  }

  for (const m of pending) {
    try {
      await applyOne(pg, m);
      metrics.inc("aiven_migrations_applied");
      logger.info("[aiven/migrations] applied", { version: m.version });
    } catch (e) {
      logger.error("[aiven/migrations] migration failed — stopping (Aiven degraded)", {
        version: m.version,
        error: msg(e),
      });
      return false;
    }
  }
  return true;
}

/**
 * Apply ONE migration inside a real transaction. When `pg` is a Pool (can hand out a pinned client) the
 * BEGIN / migration body / version INSERT / COMMIT all run on the SAME physical connection, so a failure
 * mid-migration ROLLs BACK the partial work — no half-applied schema. The version row is written inside the
 * same transaction so "applied" and "recorded" commit atomically. Falls back to the query-only path for a
 * non-pool PgLike (e.g. a single Client or a test double), where the calls already share one connection.
 */
async function applyOne(pg: PgLike, m: Migration): Promise<void> {
  if (canPinClient(pg)) {
    const client = await pg.connect();
    try {
      await client.query("BEGIN");
      await client.query(m.sql);
      await client.query(
        "INSERT INTO world_state.schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
        [m.version],
      );
      await client.query("COMMIT");
    } catch (e) {
      // Roll back the failed migration on the SAME pinned connection so the schema is never half-applied.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the connection may already be unusable — nothing more to do */
      }
      throw e;
    } finally {
      client.release();
    }
    return;
  }
  // Fallback: a query-only PgLike (single Client / test double). Calls already share one connection here.
  try {
    await pg.query("BEGIN");
    await pg.query(m.sql);
    await pg.query(
      "INSERT INTO world_state.schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
      [m.version],
    );
    await pg.query("COMMIT");
  } catch (e) {
    try {
      await pg.query("ROLLBACK");
    } catch {
      /* the connection may already be unusable — nothing more to do */
    }
    throw e;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
