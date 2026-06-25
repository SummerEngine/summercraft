-- 0001_init — AgentCraft Aiven coordination schema (Track A / Brain, plan §7 Phase 3 + §2.8).
--
-- This is migration 0001: the baseline world_state coordination schema, lifted VERBATIM (behaviour-
-- identical) from the pre-migration single schema.sql so an already-applied database re-applies cleanly.
-- It is the AUTHORITATIVE coordination state. Postgres is the source of truth; Kafka
-- (topic agent.coordination) is ONLY the reaction signal that lets agents notice each other fast — it
-- never decides who holds a lock.
--
-- Every statement is idempotent (CREATE … IF NOT EXISTS / CREATE OR REPLACE) so the migration runner can
-- re-run it harmlessly on a DB that already had the old apply-the-whole-file-on-boot schema applied. The
-- runner records it as applied in world_state.schema_migrations so it never re-runs once recorded.
--
-- THE LOCK MODEL (read this before touching file_locks):
--   The UNIQUE constraint on file_locks(repo_path, file_path) makes the INSERT itself the lock.
--   An agent claims a file by INSERT-ing a row; the unique index means exactly one INSERT wins
--   and every contender loses with a unique-violation (SQLSTATE 23505). That is the read-before-
--   write / compare-and-swap: the database arbitrates, not the application, not Kafka. An agent
--   that catches 23505 goes status='blocked' and re-routes. This is the Aiven main-track beat.
--
-- KAFKA: topic `agent.coordination`, 1 partition (total order, simplest consume), short retention
--   (~10 min / a few MB — this is a live demo bus, not a durable log). Messages mirror coord_events
--   rows: {ts, type, agent_id, detail}. Consumed best-effort by aiven/kafka.ts into /world.

CREATE SCHEMA IF NOT EXISTS world_state;

-- ---------------------------------------------------------------------------
-- agents — presence + per-agent live status. last_seen drives heartbeat_age_s.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_state.agents (
  agent_id       TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  repo_path      TEXT NOT NULL,
  character_kind TEXT NOT NULL DEFAULT 'viking',   -- viking|wizard|dwarf|barbarian
  label          TEXT NOT NULL DEFAULT '',         -- display name, e.g. "Vinny"
  state          TEXT NOT NULL DEFAULT 'waiting',  -- waiting|moving|working|blocked|done
  status_line    TEXT NOT NULL DEFAULT '',
  current_task   TEXT,
  target_base_id TEXT,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- heartbeat; projection flags stale at >15s
  denied_at      TIMESTAMPTZ                          -- last lost-claim time; projection pins state='blocked' for a brief dwell after this so the camera always catches the back-off (see claim_file + projection.ts DWELL_S). NULL once the agent wins a lock again.
);

-- Additive for existing/already-applied DBs: bring the dwell column in without a full re-create.
ALTER TABLE world_state.agents ADD COLUMN IF NOT EXISTS denied_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agents_last_seen_idx ON world_state.agents (last_seen);

-- ---------------------------------------------------------------------------
-- file_locks — THE AUTHORITATIVE LOCK. One row == one held file. The UNIQUE
-- constraint below is the whole coordination primitive: the INSERT is the lock.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_state.file_locks (
  id              BIGSERIAL PRIMARY KEY,
  repo_path       TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  holder_agent_id TEXT NOT NULL REFERENCES world_state.agents(agent_id) ON DELETE CASCADE,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- THE lock primitive: a (repo, file) can be held by exactly one row. A second INSERT
-- for the same (repo_path, file_path) raises unique_violation (23505) → the loser is blocked.
CREATE UNIQUE INDEX IF NOT EXISTS file_locks_repo_file_uniq
  ON world_state.file_locks (repo_path, file_path);

CREATE INDEX IF NOT EXISTS file_locks_holder_idx
  ON world_state.file_locks (holder_agent_id);

-- ---------------------------------------------------------------------------
-- coord_events — append-only coordination log. Mirrors what is produced to the
-- Kafka topic agent.coordination so /world can show recent events even if a
-- Kafka consumer missed them (Postgres is the source of truth, Kafka the signal).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS world_state.coord_events (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
  type      TEXT NOT NULL,        -- file_claimed | file_claim_denied | released | heartbeat | registered | ...
  agent_id  TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS coord_events_ts_idx ON world_state.coord_events (ts DESC);

-- ---------------------------------------------------------------------------
-- claim_file(agent, repo, file) — convenience CAS used by the coordination prompt.
-- Returns TRUE if this agent now holds the lock, FALSE if someone else already does.
-- The unique index does the arbitration; this just turns 23505 into a boolean so the
-- agent doesn't have to special-case the SQLSTATE. Self-heal of abandoned locks lives
-- in the projection (TTL on holder.last_seen), not here.
--
-- ROBUSTNESS FOR UNRELIABLE LLM CALLERS: file_locks.holder_agent_id is a NOT NULL FK to
-- agents(agent_id). An LLM agent that skips §1 (register-on-start) and calls claim_file first
-- would otherwise trip a foreign_key_violation (23503) — a raw SQL error, NOT the clean
-- got_lock=false the blocked path expects. So we up-front upsert a minimal presence row for
-- the caller (ON CONFLICT DO NOTHING — an already-registered agent is left exactly as-is, its
-- real label/state/character_kind from §1 untouched). The agent then exists for the FK, and the
-- only failure left for the lock INSERT is the intended unique_violation (someone else holds it).
-- p_repo seeds repo_id too (the only repo identifier we have here); §1's upsert overwrites it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION world_state.claim_file(
  p_agent TEXT, p_repo TEXT, p_file TEXT
) RETURNS BOOLEAN AS $$
BEGIN
  -- Ensure the caller has a presence row so the holder_agent_id FK is satisfiable.
  -- DO NOTHING preserves a real registration if one already exists.
  INSERT INTO world_state.agents (agent_id, repo_id, repo_path, status_line)
  VALUES (p_agent, p_repo, p_repo, 'auto-registered on claim')
  ON CONFLICT (agent_id) DO NOTHING;

  INSERT INTO world_state.file_locks (repo_path, file_path, holder_agent_id)
  VALUES (p_repo, p_file, p_agent);
  INSERT INTO world_state.coord_events (type, agent_id, detail)
  VALUES ('file_claimed', p_agent, p_file);
  -- Won the lock: clear any prior dwell so the projection stops pinning this agent blocked.
  UPDATE world_state.agents SET denied_at = NULL WHERE agent_id = p_agent;
  RETURN TRUE;
EXCEPTION WHEN unique_violation THEN
  -- Lost the race. Someone holds (repo, file). Caller goes blocked + re-routes.
  -- Stamp denied_at so the projection can hold this agent visibly 'blocked' for a minimum
  -- dwell (projection.ts DWELL_S) REGARDLESS of how fast the LLM re-routes — the on-stage
  -- back-off beat must not depend on the agent voluntarily sleeping. We also force state to
  -- 'blocked' here so the very next /world poll already shows the yield, even before the
  -- agent's own §5 heartbeat lands.
  UPDATE world_state.agents
     SET denied_at = now(),
         state = 'blocked',
         status_line = 'blocked on lock: ' || p_file
   WHERE agent_id = p_agent;
  INSERT INTO world_state.coord_events (type, agent_id, detail)
  VALUES ('file_claim_denied', p_agent, p_file);
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- release_file(agent, repo, file) — drop a lock you hold (release-on-finish).
CREATE OR REPLACE FUNCTION world_state.release_file(
  p_agent TEXT, p_repo TEXT, p_file TEXT
) RETURNS VOID AS $$
BEGIN
  DELETE FROM world_state.file_locks
   WHERE repo_path = p_repo AND file_path = p_file AND holder_agent_id = p_agent;
  INSERT INTO world_state.coord_events (type, agent_id, detail)
  VALUES ('released', p_agent, p_file);
END;
$$ LANGUAGE plpgsql;
