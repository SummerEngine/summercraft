# SummerCraft

**Watch your AI coding agents work — in a little game world you can talk to.**

> **Made with [Summer Engine](https://summerengine.com)** · MIT licensed

You're already running coding agents. Probably too many, in too many terminal tabs, and you've lost the
thread on which one is doing what. SummerCraft takes those same agents — real Claude Code sessions on
your machine — and turns them into characters in a small, themeable world. You can see them working. You
can walk up and talk to one out loud. And when it changes something, the diff is right there.

It runs locally, on your Claude subscription and your code. Your code never leaves your laptop — only
anonymized "something happened over here" signals do. It's open source, built on
[Summer Engine](https://summerengine.com), and it's meant to be hacked on.

---

## The 30-second version

Real agents (local, your plan, your code) → mapped onto a plain hierarchy, **Agent → Project → Repo →
Group** → drawn through a **theme you can swap** (fortress, garden, city, whatever you build) → with the
shared world living in **Aiven** so it sticks around, streams, and one day lets you visit other people's
worlds. Only the anonymized symbols travel. Code stays home.

## Why bother

Chat is a terrible interface for running a *fleet*. You can't see who's working, who's stuck, or which
two agents are about to edit the same file and clobber each other. A world shows all of that at a glance
— and honestly it's just nicer to be in than a wall of scrolling logs. That's the whole pitch.

## Get it running

You need a **Claude Pro or Max** subscription with the CLI logged in (`claude login`). That's the only
account in the whole thing. No SummerCraft signup, no API key, no cloud.

**Just want to play:**

1. `claude login`
2. Grab a build from [Releases](../../releases) and open it.
3. Point it at a repo on your machine and hit play.

No build for your OS yet? It's early — [build from source](docs/GETTING_STARTED.md), it takes a few
minutes.

**Want to hack on it:** head to [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md). The short version:
clone, `cd sidecar && npm install && npm start`, open the project in
[Summer Engine](https://summerengine.com), press play.

Single-player needs zero cloud — no Aiven, no backend, nothing to sign up for.

## How it's built: three layers that don't touch each other

| Layer | What it owns | Swap it? |
|---|---|---|
| **Data** | the hierarchy (Agent / Project / Repo / Group) + anonymized activity | nope — this is the truth, never themed |
| **Theme** | which asset each level looks like | yep — fortress, garden, city, yours |
| **Infra** | Aiven (the shared/persistent world + activity stream) and your local machine (the compute) | yep — it's behind a seam |

Two moving parts. The **sidecar** (`sidecar/`) is the brain: a little Node process that spawns and drives
the real agents, serves the world to the game on `127.0.0.1:8787`, and syncs to Aiven when you've set it
up. The **game** (Summer Engine / Godot) draws that world through whatever theme is active and is where
you click, talk, and watch. More in [THE_VISION.md](docs/THE_VISION.md) and
[DATA_MODEL.md](docs/DATA_MODEL.md).

## The deal with your code

This only works if you trust it, so the boundaries are simple and hard:

- Agents run on **your machine**, on **your subscription**. The metered API key is stripped from every
  agent we spawn, so nothing can quietly run up a bill behind your back.
- The **first agent on a repo works directly in your working tree, on your current branch** — like a
  normal Claude Code session, so you *see* its edits live and your dev server hot-reloads. git is your undo.
  Spin up a **second** agent on the *same* repo and it gets an **isolated worktree** so the two can't
  clobber each other. Nothing is ever pushed or merged without you approving it.
- The only thing that ever leaves for the shared world is one anonymized pulse: a path, a size, a state.
  No code, no diffs, no file contents — ever. That's the rule that makes a public world safe.

## Aiven: the part that makes it a *world* (and later, multiplayer)

Totally optional for solo play. When you want it: Postgres holds the world, Kafka streams the activity
between worlds, and the Aiven MCP lets one of your agents *actually run the data infra* — spin up a
service, deploy pgvector, tell you what's wrong with your Postgres. A data engineer that lives in your
world. Setup walkthrough (with a free local-Docker option): [docs/AIVEN_SETUP.md](docs/AIVEN_SETUP.md).

## Honest status — what works, what's rough, what you wire yourself

Born at a hackathon, built fast. Here's the truth so nothing surprises you:

**Works today (verified):**
- Real local Claude Code sessions as NPCs — talk by text or voice, and they **actually edit your code**.
- The first agent on a repo works on your **live working tree**, so you watch files change and your
  localhost hot-reloads. That's the core loop, and it's real.
- **"New chat"** reliably resets an agent, even mid-task (no restart needed).
- Aiven **Postgres + Kafka** stream the shared world; the **Aiven MCP** lets the operator NPC (Ada) run
  data infra (in demo mode via the bundled local shim).

**Rough edges (known):**
- The live "watch each tool run" feed is minimal — you see the *result* clearly, less the per-tool stream.
- Voice can lag or treat a long task loosely; world/NPC animation has rough spots.
- A stale agent session occasionally needs a sidecar restart (`cd sidecar && npm run demo`).

**You wire this yourself — it's config, not hardwired:**
- **`sidecar/runtime/projects.json`** — maps the agents to *your* repos (`id`, `name`, `repo_path`,
  `agents[]`). This is the one file that points the world at your code. Copy/edit it; the in-code defaults
  are throwaway demo repos.
- **`.env`** — only for the cloud bits: Aiven Postgres/Kafka creds + the Aiven MCP URL, and ElevenLabs keys
  for voice. **Solo single-player needs none of this** — just `claude login` and a repo.

**Multiplayer is NOT fully out of the box (yet).** The shared world only works if everyone points at the
**same Aiven instance**, and there is **no real authentication** — identity is an arbitrary owner code
(your hostname by default), so anyone with the shared creds could write. *Visiting* other worlds is
read-only and works; *public, secured* multiplayer needs an auth layer we haven't built. Treat it as a
proof of the concept, not a shipped feature.

**The downloadable build may be flaky** per-OS and might not "just run" for everyone yet. The reliable path
is **from source**: `cd sidecar && npm install && npm run demo`, then open the project in Summer Engine and
press play. If a build doesn't work for you, that's the fallback.

**Setting it up with Claude:** this repo is meant to be handed to Claude Code. Open it, point Claude at this
README + [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) + `sidecar/runtime/projects.json`, and ask it to
wire the agents to your repos and start the sidecar. It'll handle the boring parts.

## Docs

- **[Getting started](docs/GETTING_STARTED.md)** — install and play, or build from source
- **[The vision](docs/THE_VISION.md)** — where this is going and why
- **[Data model](docs/DATA_MODEL.md)** — the hierarchy, themes, and the activity flow
- **[Aiven setup](docs/AIVEN_SETUP.md)** — stand up the shared-world backend (optional)
- **[Sidecar README](sidecar/README.md)** — run the brain, prove each piece works

## Contributing

New themes, agent personas, world juice, a typo you spotted — all welcome. The three layers are
deliberately decoupled, so you can add a theme without learning the data model, or improve the data
without touching the renderer. Open an issue to say hi or float an idea before anything big. Be kind —
it's a small, friendly project, and we'd love the company.

## License

See [LICENSE](LICENSE).
