-- 0002_operations_audit — durable audit trail for the Autonomous Data Operator (plan §2 L2).
--
-- Every operator mission run (POST /operator/run) writes one row here at dispatch (status='dispatched'
-- or 'dry_run'), then the row is updated as the run resolves ('succeeded' / 'failed') and the verify
-- step records its outcome. This is the operation audit log §2 calls out as a gap: coord_events only
-- captured file-lock beats, never data-operator actions. Best-effort — a failed audit write must NEVER
-- block or fail the mission itself (operator.ts wraps every call defensively).
--
-- Idempotent: CREATE … IF NOT EXISTS only, safe to re-run.

CREATE SCHEMA IF NOT EXISTS world_state;

CREATE TABLE IF NOT EXISTS world_state.operations_audit (
  id           BIGSERIAL PRIMARY KEY,
  op_id        TEXT NOT NULL,                       -- caller-supplied/generated id; idempotency key (one logical run)
  agent_id     TEXT NOT NULL DEFAULT 'ada',         -- the operator NPC that ran it
  mission_id   TEXT,                                -- one of OPERATOR_MISSIONS ids, or NULL for a free-form prompt
  title        TEXT NOT NULL DEFAULT '',            -- human title for the mission
  prompt       TEXT NOT NULL DEFAULT '',            -- the exact prompt dispatched (the operator instruction)
  dry_run      BOOLEAN NOT NULL DEFAULT false,      -- a dry-run plans/reads only, takes no mutating action
  status       TEXT NOT NULL DEFAULT 'dispatched',  -- dry_run | dispatched | succeeded | failed
  result       TEXT NOT NULL DEFAULT '',            -- captured streamed result summary (filled when the turn ends)
  verify       TEXT NOT NULL DEFAULT '',            -- the per-mission verify step + its observed outcome
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One logical run == one op_id. The runner upserts on this so a double-clicked /operator/run with the
-- same op_id refreshes the existing audit row instead of forking a duplicate (idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS operations_audit_op_id_uniq
  ON world_state.operations_audit (op_id);

CREATE INDEX IF NOT EXISTS operations_audit_created_idx
  ON world_state.operations_audit (created_at DESC);
