# Aiven MCP — Grounded Reference (the REAL tools + setup)

> Source: `github.com/Aiven-Open/mcp-aiven` + `aiven.io/docs/tools/mcp-server`. This is the **actual**
> tool surface. A built the operator missions + coordination prompt *blind* (guessed tool names) —
> align them to these exact names. This doc also serves as the agent-side "how to use Aiven" skill.

## Connect (two options)
- **Hosted (HTTP):** `claude mcp add --scope user --transport http aiven-mcp "https://mcp.aiven.live/mcp"`
  (OAuth handshake on add). Agent SDK shape: `mcpServers: { aiven: { type: "http", url: "https://mcp.aiven.live/mcp" } }`.
  ⚠️ Headless OAuth from spawned agents is fiddly.
- **Local (stdio) — RECOMMENDED for the sidecar's headless agents** (deterministic auth):
  `mcpServers: { aiven: { command: "npx", args: ["-y", "mcp-aiven"], env: { AIVEN_TOKEN } } }`.
- Flags: `AIVEN_READ_ONLY=true` (safe for read-mostly agents), `AIVEN_ALLOW_SECRETS` (off by default),
  `AIVEN_SERVICES_SCOPE` (limit to specific services).

Note: A's guessed default URL `https://mcp.aiven.live/mcp` is **correct** for the hosted transport.

## What Mathias actually provides
- **One Aiven API token** (Console → Tokens) = `AIVEN_TOKEN`. **This single token lets the MCP do
  everything** — list services, run SQL, produce/read Kafka, deploy extensions, read metrics/logs —
  all via the Aiven API. That's the only thing the MCP needs.
- *(Separate, for the sidecar's DIRECT data plane — faster world writes:* the Postgres **Service URI +
  CA cert**, and the Kafka connection details. These are NOT the MCP; they're the `pg`/Kafka client.)*

## The real tools (use these EXACT names)
**Core / ops:** `aiven_project_list`, `aiven_service_list`, `aiven_service_get`, `aiven_service_create`,
`aiven_service_update`, `aiven_service_metrics_fetch`, `aiven_project_get_service_logs`,
`aiven_service_query_activity`, `aiven_project_get_event_logs`, `aiven_docs_search`.
**Postgres:** `aiven_pg_read`, `aiven_pg_write`, `aiven_pg_optimize_query`,
`aiven_pg_service_available_extensions`, `aiven_pg_service_query_statistics`, `aiven_pg_bouncer_create`/`_update`/`_delete`.
**Kafka:** `aiven_kafka_topic_list`/`_create`/`_get`/`_update`/`_delete`, `aiven_kafka_topic_message_produce`,
`aiven_kafka_topic_message_list`, `aiven_kafka_connect_*` (connectors), `aiven_kafka_schema_registry_*`.

## Map our uses → real tools
**Coordination / locks (agents claim files):**
- claim → `aiven_pg_write` (INSERT a lock row); check → `aiven_pg_read`; signal → `aiven_kafka_topic_message_produce`
  (`file_claimed`/`released`); observe → `aiven_kafka_topic_message_list`. The lock "table" is just a Postgres table.

**Activity stream (commits → world → HUD, multiplayer):**
- agents push anonymized activity via `aiven_kafka_topic_message_produce` — OR the sidecar writes directly
  (more reliable). Either satisfies the flow; the sidecar-direct path is the safe default.

**The data-operator (Ada) — the SCORED differentiator, now with REAL tools:**
- "deploy pgvector" → `aiven_pg_service_available_extensions` then `aiven_pg_write` (`CREATE EXTENSION vector`).
- "what's wrong with my Postgres?" → `aiven_service_metrics_fetch` + `aiven_project_get_service_logs` + `aiven_pg_service_query_statistics`.
- "optimize this query" → `aiven_pg_optimize_query`.
- "spin up / inspect a service" → `aiven_service_create` / `aiven_service_get` + `aiven_service_query_activity`.
These ARE the self-driving data engineer. Ada's missions must call these exact tools.

## Action for A
1. Rewrite `operator.ts` missions + the coordination prompt to the exact tool names above (they were guessed).
2. Use the **local stdio** MCP (`npx mcp-aiven` + `AIVEN_TOKEN`) for the spawned agents — deterministic auth,
   no OAuth dance. Keep the hosted URL as a fallback.
3. The MCP needs only `AIVEN_TOKEN`; the sidecar's direct `pg`/Kafka still needs the URI + CA.

## Sources
- https://github.com/Aiven-Open/mcp-aiven
- https://aiven.io/docs/tools/mcp-server
- https://aiven.io/mcp
