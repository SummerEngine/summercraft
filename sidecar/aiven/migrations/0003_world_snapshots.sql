-- 0003 — multiplayer: the shared-world directory + per-world activity (DATA_MODEL.md "shared world").
--
-- "Seeing other people's worlds" rides on a SEPARATE, additive table — it deliberately does NOT touch the
-- within-world coordination layer (agents / file_locks / claim_file / the D6 contention beat), which stays
-- exactly as proven. Each world periodically UPSERTs an ANONYMIZED snapshot of itself (hierarchy + agent
-- states only — NO code, NO repo paths, NO transcripts). Visiting a world = reading its snapshot row.
--
-- Privacy: the snapshot JSONB is built by the sidecar to be safe-to-share (multiplayer.ts buildSharedSnapshot).
-- The DB just stores whatever anonymized blob it's handed, keyed by world_id.

CREATE TABLE IF NOT EXISTS world_state.world_snapshots (
  world_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),   -- a world goes "offline" in the directory when this is stale
  snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb     -- the anonymized {groups,repos,projects,agents} blob
);

CREATE INDEX IF NOT EXISTS world_snapshots_last_seen_idx ON world_state.world_snapshots (last_seen DESC);

-- The activity stream gets a world_id so a visitor can filter the pulse feed to the world they're watching.
-- Additive + defaulted ('local' for existing single-world rows), so the existing /world feed is unchanged.
ALTER TABLE world_state.coord_events ADD COLUMN IF NOT EXISTS world_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS coord_events_world_idx ON world_state.coord_events (world_id);
