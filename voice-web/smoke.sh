#!/usr/bin/env bash
# AgentCraft voice — no-voice smoke test (Track C).
#
# Proves the exact localhost path the `run_task` client tool hits, without ElevenLabs or a mic:
#   /health  ->  /voice/signed-url  ->  /world  ->  POST /agents/<id>/prompt  (expect 202)
#
# Usage:  bash voice-web/smoke.sh [character_id]      (defaults to a1)
set -u

BASE="${SIDECAR_HTTP:-http://127.0.0.1:8787}"
ID="${1:-a1}"
PROMPT="${2:-Add a /health endpoint that returns ok. Keep it tiny.}"

echo "== sidecar: $BASE  character: $ID =="

echo; echo "1) GET /health"
if ! curl -s -m 3 "$BASE/health"; then
  echo "  -> sidecar NOT reachable. Start it first: (in sidecar/) npm run sidecar"
  exit 1
fi

echo; echo; echo "2) GET /voice/signed-url   (configured:true needs ELEVENLABS_API_KEY + ELEVENLABS_AGENT_ID in the sidecar env)"
curl -s -m 5 "$BASE/voice/signed-url" | sed 's/\(signed_url":"[^"]\{0,24\}\)[^"]*/\1.../'

echo; echo; echo "3) GET /world   (agent_ids you can target)"
curl -s -m 3 "$BASE/world" | tr ',' '\n' | grep -E '"agent_id"|"label"|"state"' || echo "  (no world / empty)"

echo; echo "4) POST /agents/$ID/prompt   (this is exactly what run_task does)"
CODE=$(curl -s -o /tmp/agentcraft_runtask.out -w '%{http_code}' -m 10 \
  -X POST "$BASE/agents/$ID/prompt" \
  -H 'content-type: application/json' \
  -d "{\"prompt\": $(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")
echo "   HTTP $CODE"
echo "   body: $(cat /tmp/agentcraft_runtask.out)"

echo
if [ "$CODE" = "202" ]; then
  echo "PASS — run_task dispatch reaches a live session. Watch the sidecar log / GET /world for the work."
else
  echo "FAIL — expected 202. 404 = no such agent id (pick one from /world); 400 = empty prompt;"
  echo "       503 = could not dispatch (is Claude logged in? is the repo/worktree set up?)."
  exit 1
fi
