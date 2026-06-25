#!/usr/bin/env bash
# One command to run the live demo backend: the Aiven MCP shim (so Ada can query the real Aiven world)
# + the sidecar wired to it. The MCP URL is only set AFTER the shim ANSWERS, so agents never point at a
# dead MCP. Reads AIVEN_PG_URI etc. from sidecar/.env (the sidecar loads it; the shim inherits it here).
set -euo pipefail
cd "$(dirname "$0")"

# Export the Aiven Postgres URI from .env so the shim (which connects to the real world DB) has it.
# Strip surrounding single/double quotes: the sidecar loads .env via Node's loadEnvFile() which honours
# dotenv quoting, but this raw grep|cut does NOT — a quoted AIVEN_PG_URI="postgres://..." would otherwise
# pass literal quotes into the shim's connection string and silently break its DB connect (world_pulse dies
# on stage while the sidecar itself still connects fine). Keep the two loaders byte-for-byte consistent.
if [ -f .env ]; then
  _raw_pg_uri="$(grep '^AIVEN_PG_URI=' .env | head -n1 | cut -d= -f2- || true)"
  _raw_pg_uri="${_raw_pg_uri%\"}"; _raw_pg_uri="${_raw_pg_uri#\"}"
  _raw_pg_uri="${_raw_pg_uri%\'}"; _raw_pg_uri="${_raw_pg_uri#\'}"
  export AIVEN_PG_URI="$_raw_pg_uri"
fi

MCP_PORT="${MCP_PORT:-8765}"
MCP_URL="http://127.0.0.1:${MCP_PORT}/mcp"

mkdir -p runtime
echo "[demo] starting the Aiven MCP shim on :${MCP_PORT} ..."
MCP_PORT="$MCP_PORT" node mcp-aiven-local.mjs > runtime/shim.log 2>&1 &
SHIM_PID=$!
trap 'kill "$SHIM_PID" 2>/dev/null || true' EXIT

# READINESS GATE (not a blind sleep): poll the shim with a tiny MCP initialize POST until it ANSWERS
# (any HTTP status proves it's alive and serving), or give up after ~10s. We export the MCP URL only
# AFTER the shim answers, so the sidecar/Ada never attach a not-yet-listening (or crashed) endpoint —
# a slow/dead shim was the known killer that wedges a session's startup handshake.
probe_body='{"jsonrpc":"2.0","id":"probe","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"demo-probe","version":"0"}}}'
ready=0
for i in $(seq 1 50); do
  # The shim died before becoming ready -> bail loudly instead of looping for 10s.
  if ! kill -0 "$SHIM_PID" 2>/dev/null; then
    echo "[demo] ERROR: the MCP shim exited during startup. Last log lines:" >&2
    tail -n 20 runtime/shim.log >&2 || true
    exit 1
  fi
  if curl -fsS -o /dev/null --max-time 1 \
        -H 'content-type: application/json' \
        -H 'accept: application/json, text/event-stream' \
        -d "$probe_body" "$MCP_URL" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done

if [ "$ready" -ne 1 ]; then
  echo "[demo] ERROR: the MCP shim never answered on ${MCP_URL} after ~10s. Not starting the sidecar" >&2
  echo "       (would leave Ada pointed at a dead MCP). Check runtime/shim.log." >&2
  tail -n 20 runtime/shim.log >&2 || true
  exit 1
fi

echo "[demo] MCP shim is answering on ${MCP_URL} — starting the sidecar (Ada wired to the shim) ..."

# DEMO TRIGGER: the deterministic world_pulse readout has no on-screen button yet, so
# the ONLY in-game trigger today is a free-form spoken/typed ask to Ada (her persona now carries the exact
# schema + 3 queries, so that lands the real numbers). For the EXACTLY-reproducible stage number, fire the
# fixed world_pulse mission directly. Pre-stage this command — it returns the deterministic
# 'N worlds online, M agents working, K events this hour.' from the live Aiven world DB.
# The sidecar's HTTP port is fixed in contract.ts (HOST 127.0.0.1, PORT 8787) — no env override — so this
# command is correct as printed; if contract.ts PORT ever changes, update this line.
SIDECAR_PORT=8787
echo "[demo] ---------------------------------------------------------------------------"
echo "[demo] Aiven #2 (deterministic world_pulse) — run this on stage once the sidecar is up:"
echo "[demo]   curl -fsS -XPOST http://127.0.0.1:${SIDECAR_PORT}/operator/run \\"
echo "[demo]     -H 'content-type: application/json' -d '{\"mission_id\":\"world_pulse\"}'"
echo "[demo] (Or walk to Ada and ask 'what's happening across the worlds?' — her persona runs the same 3 queries.)"
echo "[demo] ---------------------------------------------------------------------------"

AGENTCRAFT_AIVEN_MCP_URL="$MCP_URL" exec npx tsx server.ts
