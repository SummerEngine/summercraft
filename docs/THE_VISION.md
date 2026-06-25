# SummerCraft — The Vision (north star)

**SummerCraft is a multi-agent game system.** Your real Claude coding agents run on your machine;
their work becomes living symbols in a world you can theme — and, when we're ready, share with
others, live.

## The whole thing in one breath
Real agents (local, your subscription, your code) → their work abstracted into a concrete hierarchy
(**Agent → Project → Repo → Group**) → rendered as assets through a **swappable theme** (fortress /
garden / city) → with the world state living in **Aiven** so it's persistent, streamed, and ready for
**concurrent multiplayer worlds** you can visit. Only anonymized symbols are shared; code never leaves
your machine. Open source.

## The five truths it's built on
1. **Local compute, your subscription.** Agents run on your machine via your Claude plan. (Proven.)
2. **Code → symbols.** The hierarchy is the data; a theme maps each level to an asset. Same data, any skin.
3. **Aiven = the world + the multiplayer substrate.** Postgres holds the persistent world state; Kafka
   streams activity. Agents also use the **Aiven MCP** (coordination + a data-ops agent in the fleet).
   One coherent Aiven story — it *is* the "Autonomous Data Operator" (agents controlling / streaming /
   querying data infra) **and** the multiplayer backbone. Not two things.
4. **The loop:** agent does real work → anonymized activity event (no code) → Aiven → your themed world
   updates live → others can watch / visit.
5. **Three clean layers — never coupled:** Data (hierarchy + events) · Theme (level→asset) · Infra
   (Aiven / local). Build behind these seams so any one can change without touching the others.

## Build principle
**First-principles toward the FULL vision — multiplayer included.** We may well ship it multiplayer;
build so multiplayer is a *flip*, not a rewrite. Don't hardcode the theme, the hierarchy, or the infra.
This is not "demo vs product" — it's one architecture, sequenced.

## The first milestone (Thursday, on a Mac)
The full architecture, running as its first instance: a real agent does real work → its symbol updates
in a themed world → you talk to it (voice) → Aiven holds the world state → the data-operator beat proves
the Aiven MCP. Single-machine is fine for the demo; the architecture underneath is the multiplayer one.

## Challenges this satisfies
**Aiven** (a multiagent system on the MCP + concurrent worlds) · **Anthropic** (working agents) ·
**ElevenLabs** (talk to your agents).

## Reference docs
- `DATA_MODEL.md` — the hierarchy + themes + activity flow (the data spec).
- This doc — the north star tying them together.
