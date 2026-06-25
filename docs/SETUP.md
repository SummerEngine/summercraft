# SummerCraft — Setup (what you provide)

> Three independent tiers. The game works with **tier 1 alone**. Voice (2) and Aiven (3) are optional
> add-ons, each off by default and degrade-safe.
>
> ⚠️ DRAFT — exact env var names are finalized at consolidation from each subsystem's README
> (`sidecar/README`, `voice-web/README`). The *concepts* below are stable.

## Tier 1 — REQUIRED: Claude (this is the whole engine)
- A **Claude Pro/Max subscription**. Run **`claude login`**. No API key.
- This is how your agents do real coding work — billed to your plan, env-scrubbed so it can never hit a
  metered API key.
- **Without it: nothing runs** (agents can't think).
- Verify: `cd sidecar && npm install && npm run billing-check` → should print `subscription`.

## Tier 2 — OPTIONAL: ElevenLabs (realtime voice)
- Want to **talk** to your agents instead of typing? Get an **ElevenLabs API key** and create one
  Conversational-AI agent with the `run_task` client tool (config in `voice-web/README`).
- Set `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID`.
- **Without it: voice is disabled — you just TYPE to your agents** in the panel. The agents still do
  real work; you only lose the spoken conversation. You do NOT need this to play.

## Tier 3 — OPTIONAL: Aiven (shared/multiplayer world + the data-operator agent)
- Want the **persistent/shared/multiplayer world** and the **data-ops agent**? Two pieces:
  - An **Aiven API token** (Aiven Console → Tokens) = `AIVEN_TOKEN` → powers the **Aiven MCP** (agents
    operate/query your data infra). One token does everything.
  - An **Aiven for PostgreSQL** service (Service URI + CA cert) and optionally **Kafka** → the world
    data plane (the sidecar's direct connection).
- **Without it: the world is local single-player** — no shared world, no data-ops agent. The core game
  still runs.

## The thing people get wrong
**Voice and the Aiven MCP are separate, both optional.** Turning voice off does NOT route the chat
"through the MCP" — voice off just means you *type* to the agent (still a real Claude session on your
subscription). The Aiven MCP is the *agents' tool for touching Aiven data infra* (tier 3) and has
nothing to do with the chat or the voice path.

## Quick start (tier 1 only)
1. `claude login` (Pro/Max plan).
2. `cd sidecar && npm install && npm run billing-check` → `subscription`.
3. Start the sidecar, open the game, **type a task to an agent** → watch it do real work. Done.
4. *(optional)* add ElevenLabs keys → now you can **talk** to it.
5. *(optional)* add the Aiven token + Postgres → shared world + the data-ops agent.
