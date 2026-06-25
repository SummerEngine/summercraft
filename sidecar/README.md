# SummerCraft Sidecar — Demo Runbook

The local **Brain** for SummerCraft (Chat A): one Node process on `127.0.0.1:8787` that runs a fleet of
real Claude Code agents, projects their world for the Godot client, and is the **Aiven Autonomous Data
Operator**. This is the demo-machine runbook — env vars, one-command boot, and how to prove each sponsor
beat on stage.

> Billing safety is the whole ballgame: every spawned Claude child runs with the metered `ANTHROPIC_*`
> vars **scrubbed** so it bills the user's Pro/Max subscription, never a metered key. `npm run
> billing-check` proves it; `GET /auth/status` must report `subscription` (an `apikey` answer is a hard
> stop the UI surfaces).

---

## 0. Prerequisites

- **Node ≥ 20.12** (`node -v`). Deps are vendored — `sidecar/node_modules` is already installed.
- **Claude logged in on the subscription** (`claude` on PATH, Pro/Max). No `ANTHROPIC_API_KEY` needed —
  and if one is set in the environment for the web app, the sidecar scrubs it from every agent child.
- **git** (and optionally **gh**, authed) on PATH — agents work in real git worktrees; `gh` enables the
  PR/approve beat (degrades cleanly to "no PR" when absent).
- Everything runs from the `sidecar/` directory. All `npm` scripts assume that cwd.

---

## 1. Environment variables

All optional — the sidecar boots and serves with **none** set (Aiven OFF, voice OFF, default project =
this repo with agents `a1/a2/a3`). Set them to light up the sponsor beats. Empty/whitespace is treated as
unset. Config is fail-fast validated on boot — a half-configured state (see below) refuses to start with a
clear message rather than failing silently on the first request.

### Aiven (data plane — the MAIN track)
| Var | Purpose |
| --- | --- |
| `AIVEN_PG_URI` | Aiven Postgres connection string, e.g. `postgres://avnadmin:...@pg-xxx.aivencloud.com:port/defaultdb?sslmode=require`. Enables the live `/world` projection, file-lock contention (D6), migrations, and the operator audit log. (`DATABASE_URL` is accepted as a fallback.) |
| `AIVEN_PG_CA` | Path to Aiven's `ca.pem` for TLS verification. **Fatal if `AIVEN_PG_URI` is set and this path isn't a readable file** — fail fast instead of failing on the first query. |
| `AIVEN_PG_CA_PEM` | Inline CA PEM contents (alternative to a file path). |
| `AIVEN_PG_SSL_INSECURE=1` | Last-resort escape hatch that disables TLS verification (MITM-exposed). Warns loudly — never use on the demo machine. |
| `AGENTCRAFT_AIVEN_MCP_URL` | The **Aiven MCP** endpoint URL the data-operator agent (Ada) works through. Must be **reachable** — an unreachable MCP hangs SDK session startup. Unset = the operator refuses cleanly (`/operator/missions` → `ready:false`). |
| `AIVEN_KAFKA_BROKERS` | Comma-separated Kafka brokers for the `agent.coordination` consumer (folds live coordination beats into `/world`). With `AIVEN_KAFKA_USERNAME` / `AIVEN_KAFKA_PASSWORD` / `AIVEN_KAFKA_SASL_MECHANISM` / `AIVEN_KAFKA_CA`. Unset = Kafka consumer OFF (no hang). |

### ElevenLabs (voice — the realtime dive)
| Var | Purpose |
| --- | --- |
| `ELEVENLABS_API_KEY` | Server-side only; **never** sent to the client (and never scrubbed — the scrub strips only `ANTHROPIC_*`). The game receives a short-lived signed URL. |
| `ELEVENLABS_AGENT_ID` | The shared ElevenLabs Conversational-AI agent id (reuse Bob's to start). |

Voice is **all-or-nothing**: set both, or neither. Exactly one set is a warning and `/voice/signed-url`
reports `configured:false` so the client falls back gracefully.

### Misc
| Var | Purpose |
| --- | --- |
| `AGENTCRAFT_PROJECTS` | JSON override for the project model (else `runtime/projects.json`, else the in-code default of this repo + `a1/a2/a3`). Shape: `[{ id, name, repo_path, agents:[{ agent_id, label, character_kind }] }]`. A `repo_path` under `runtime/demo-repos/` is auto-provisioned as a clean sandbox git repo; any other path is treated as a real repo and never auto-created. |
| `AGENTCRAFT_CLAUDE_BIN` | The `claude` binary the auth probe + sessions spawn (default `claude`). |
| `AGENTCRAFT_TURN_TIMEOUT_MS` | Per-turn SDK timeout. |
| `AGENTCRAFT_ALLOW_APIKEY=1` | Escape hatch to allow `apikey` auth mode (off by default — apikey is normally a hard stop). |
| `LOG_LEVEL` / `LOG_FORMAT` | `debug|info|warn|error` and `json|text` for the structured logger. |

---

## 2. One-command boot

```bash
cd sidecar
npm start            # tsx server.ts — http + ws on http://127.0.0.1:8787
```

Expected first lines:

```
[sidecar] http+ws listening on http://127.0.0.1:8787
[sidecar] WS auth token -> .../runtime/auth.token
[projects] seeded 3 idle agent(s) across 1 project(s).
```

`npm run dev` is the same with `tsx watch` (auto-restart on edit). The per-launch WS auth token is written
to `runtime/auth.token`; a WS client is inert until it sends `{type:"hello",token}`.

Smoke it without a browser:

```bash
curl -s localhost:8787/health    | jq    # { ok:true, live_sessions, auth, aiven, operator }
curl -s localhost:8787/auth/status | jq  # { mode:"subscription" }  <- the billing-honesty check
curl -s localhost:8787/world     | jq '.agents[].agent_id'
curl -s localhost:8787/ready     | jq    # 200 when deps usable; 503 when a configured dep is down
curl -s localhost:8787/metrics          # Prometheus text (live_sessions, turn latency, error rate, …)
```

> **Never leave a server blocking a terminal you need.** To boot just for a check: run it backgrounded to a
> log, `sleep 5`, `curl`, then kill it — `kill $(lsof -ti:8787)`. The automated tests already do this
> teardown for you (see §4).

---

## 3. Verify each sponsor beat

### Anthropic — a real agent does real work
1. Boot (`npm start`). Confirm `curl -s localhost:8787/auth/status` → `{"mode":"subscription"}`.
2. Prompt a seeded agent (lazy-spawns the live session on first prompt):
   ```bash
   curl -s -XPOST localhost:8787/agents/a1/prompt \
     -H 'content-type: application/json' \
     -d '{"prompt":"Create a file HELLO.txt containing exactly: HELLO_SUMMERCRAFT. Then you are done."}'
   ```
3. Watch the work land: `curl -s localhost:8787/agents/a1/diff | jq -r .diff` shows the real `git diff`
   in the agent's isolated worktree. `curl -s localhost:8787/agents/a1/context | jq` shows
   branch / base / PR / task / diff (the voice-dive context).
4. Fully self-contained proof (spawn → real tool calls → file written), no HTTP:
   ```bash
   npx tsx spine-test.ts        # prints "SPINE PASS — real agent did real work …"
   ```

### ElevenLabs — the realtime voice dive
1. `export ELEVENLABS_API_KEY=... ELEVENLABS_AGENT_ID=...` then boot.
2. The native Godot voice client calls the local relay; verify it mints a signed URL (the key never leaves
   the process):
   ```bash
   curl -s 'localhost:8787/voice/signed-url?agent_id='"$ELEVENLABS_AGENT_ID" | jq
   # configured:true + a signed_url  ->  the dive can connect
   # configured:false + reason       ->  graceful local fallback (HTTP is ALWAYS 200 here)
   ```
3. With voice unset, the same endpoint returns `{configured:false,...}` (200) — the client degrades, never
   hangs.

### Aiven — D6 lock contention + an operator mission
1. `export AIVEN_PG_URI='postgres://...?sslmode=require' AIVEN_PG_CA=/path/to/ca.pem`.
2. **D6 contention, reproducible from one command** (provisions schema via the versioned migration runner,
   has two agents fight over one file, asserts the loser is visibly `blocked`, then released):
   ```bash
   npx tsx aiven-smoke.ts        # -> AIVEN_SMOKE_OK   (or a clean AIVEN_SMOKE_SKIP if AIVEN_PG_URI unset)
   ```
3. **The data operator** (needs a reachable `AGENTCRAFT_AIVEN_MCP_URL`): list and run a mission. Ada (the
   operator NPC) executes it through the Aiven MCP and the run is captured into her transcript + the
   `world_state.operations_audit` audit log.
   ```bash
   curl -s localhost:8787/operator/missions | jq           # { ready:true, missions:[…5 named beats…] }
   # Dry-run first (read/plan-only — safe to rehearse), then live:
   curl -s -XPOST localhost:8787/operator/run -H 'content-type: application/json' \
     -d '{"mission_id":"triage_pg"}'                        # 202 + { op_id, dry_run, … }
   ```
4. Live `/world` is now the Postgres projection: `curl -s localhost:8787/world | jq '.locks, .events'`.

---

## 4. Tests

```bash
npm test               # unit (node:test via tsx) + integration boot + aiven-smoke (skips w/o a PG URI)
npm run test:unit      # pure-logic units only: env-scrub, validation, projection mapping, projects parse,
                       #   operator prompts, config validation, agent diff/branch/context
npm run test:integration   # boots the sidecar on a TEST port (8799), curls /health + /world + /projects +
                           #   /operator/missions, asserts shapes; proves the validators are WIRED on live
                           #   routes (path-traversal id + over-cap prompt -> 400; hostile ?limit/?offset
                           #   clamps); the PR/approve gate returns its documented envelopes offline; and
                           #   the /v1/chat/completions shim streams text/event-stream ending in [DONE].
                           #   Then tears the server down (< 60s, leaves nothing running). Aiven + voice
                           #   forced OFF — a pure local-records boot.
npm run test:aiven-smoke   # the D6 contention proof; a clean SKIP (exit 0) when AIVEN_PG_URI is unset
```

`npm test` is green with **no** external services configured (the Aiven step skips cleanly). With a live
Aiven Postgres the `aiven-smoke` step additionally proves the versioned migrations (idempotent) + the D6
lock-contention beat. The operator path is covered at unit level (`resolveMissionPrompt` + the
`/operator/missions` integration assertion) and run end-to-end manually via §3 — `npm test` does not
execute a live operator mission.

---

## 5. Endpoints (frozen contract — see `contract.ts`)

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/world` | `WorldSnapshot` (Godot polls @1s) |
| GET | `/agents` | `AgentView[]` |
| GET | `/projects` | `ProjectView[]` (project = repo + name + agents) |
| POST | `/agents/:id/prompt` | 202 — dispatch a task (lazy-spawns the live session) |
| GET | `/agents/:id/diff` | `AgentDiff` (git diff in the worktree) |
| GET | `/agents/:id/context` | `AgentContext` (branch/base/PR/task/diff — the voice dive) |
| GET | `/agents/:id/transcript?limit=&offset=` | `TranscriptPage` (paginated) |
| POST | `/agents/:id/pr` | `PrResult` (open a real PR via `gh`; best-effort) |
| POST | `/agents/:id/approve` | `ApproveResult` (release a pending/awaiting agent) |
| GET | `/operator/missions` | `{ ready, missions }` (the Autonomous Data Operator beats) |
| POST | `/operator/run` | 202 — run a mission via the Aiven MCP |
| GET | `/voice/signed-url?agent_id=` | `VoiceSignedUrl` (always 200; branch on `configured`) |
| POST | `/v1/chat/completions` | OpenAI-compatible SSE (ElevenLabs custom-LLM) |
| GET | `/auth/status` | `{ mode: subscription \| apikey \| unknown }` |
| GET | `/health` `/ready` `/live` `/metrics` | liveness / readiness / liveness / metrics |
| WS | `/` | `ServerEvent` stream; accepts `ClientCommand` frames after hello-auth |

Bound to `127.0.0.1` only. The public contract is additive-only — B/C/D (Godot world, voice, HUD) are live
against it.
