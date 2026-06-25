-- 0004 — character-session model: persistent per-character SESSION history (ratified
-- the persistent per-character session model).
--
-- A persistent CHARACTER (NPC) owns ephemeral SESSIONS (each = one Claude Code run / chat). When a session
-- ends ("send away", or replaced by a "new chat") its transcript is archived + summarized to a row here so a
-- character's history survives a sidecar restart. ADDITIVE + separate from the coordination layer (agents /
-- file_locks / coord_events) — it does not touch any proven table.
--
-- Privacy: `summary` is a short human line built locally (no code, no diffs). This is per-WORLD/local history,
-- NOT the anonymized shared-world snapshot; it is never published to the multiplayer directory.

CREATE TABLE IF NOT EXISTS world_state.sessions (
  session_id    TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL,                         -- the owning character (== agent_id in the current model)
  summary       TEXT NOT NULL DEFAULT '',
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ                            -- null while the session is still live (the active one)
);

CREATE INDEX IF NOT EXISTS sessions_character_idx ON world_state.sessions (character_id, started_at DESC);
