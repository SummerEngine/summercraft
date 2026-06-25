-- 0005 — multiplayer owner identity (Lane A "front door"). The HACK, not real auth.
--
-- Each shared world gets an `owner_code` so the directory can show WHO owns a world and a (future) UI can
-- tell "mine" from "theirs" without any login. It is sourced server-side (env AGENTCRAFT_OWNER_CODE, else a
-- stable per-machine value — the hostname) and stamped on every publishWorldSnapshot UPSERT. ADDITIVE +
-- defaulted ('' for any pre-existing row), so the proven 0003 directory behavior (list/visit) is unchanged.
--
-- Privacy: owner_code is a coarse, user-chosen/machine-stable label — NOT a secret, NOT a credential. It is
-- safe to show in the public directory (same bar as world name). It grants NO authority; nothing trusts it.

ALTER TABLE world_state.world_snapshots ADD COLUMN IF NOT EXISTS owner_code TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS world_snapshots_owner_idx ON world_state.world_snapshots (owner_code);
