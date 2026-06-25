# Getting started

Let's get you from nothing to watching a real agent do real work in the world. There are two ways in —
**play a build** or **build from source** — and they land in the same place.

The only account you need is your **Claude Pro or Max** subscription. No SummerCraft signup, no API key,
and (for solo play) no cloud. Nice and simple.

---

## What you'll need

- A **Claude Pro or Max** subscription, logged in:
  ```sh
  claude login
  ```
  This is what your in-world agents actually run on — locally, on your plan. (We scrub the metered
  API-key environment from every agent we spawn, so they can't quietly bill a metered key. Not on a
  subscription? The app tells you up front instead of silently doing the wrong thing.)
- **macOS or Windows.**
- _Only if you're building from source:_ **Node.js 20.12+** and
  **[Summer Engine](https://summerengine.com)** (a Godot-based editor), or a compatible Godot 4.6 build.

## Option 1: just play it

1. `claude login` — once.
2. Download the build for your OS from [Releases](../../releases) and open it.
3. First launch asks for a **project** — a folder or repo on your machine you want agents to work in.
4. Hit play, then skip to [your first five minutes](#your-first-five-minutes).

No build for your platform yet? It's an early project — Option 2 is quick.

## Option 2: build from source

```sh
git clone <this-repo> summercraft
cd summercraft

# Start the brain (the local sidecar).
cd sidecar
npm install
npm start
# -> [sidecar] http+ws listening on http://127.0.0.1:8787
```

Leave that running. In another terminal, make sure it's happy:

```sh
curl -s 127.0.0.1:8787/health
# {"ok":true,"auth":"subscription",...}
```

That `"auth":"subscription"` is the bit that matters — it means your Claude login is wired up and agents
will run on your plan. (See [troubleshooting](#when-things-go-sideways) if it says `apikey` or `unknown`.)

Now open the **game**: open this project folder in **Summer Engine** (or Godot 4.6) and press **Play**
(F5). It finds the sidecar on `127.0.0.1:8787` by itself.

Out of the box the world is seeded with a few agents working in *this* repo — each in its own isolated
git worktree, so your actual files are never touched. To point them at your own repos, see
[choosing what agents work on](#choosing-what-agents-work-on).

## Your first five minutes

You'll see a small world with a few characters standing around. Each character is one **agent** (one
Claude session). Each place is a **project**. The whole thing is the **Agent → Project → Repo → Group**
tree, drawn through whatever theme is on.

Try this:

1. **Click an agent.** A panel opens — name, status, live transcript, a box to type in.
2. **Give it a task.** Something like "add a `goodbye()` function to `main.ts`." Send it.
3. **Watch it work.** The real Claude session goes at it. The character animates idle → working → done,
   and the **diff** it produced shows up in the panel for you to read.
4. **Get closer and talk.** Hit the dive key to drop in front of the agent and just *talk to it* — it
   already knows its branch, task, and diff, and it'll do real work from what you say and report back.
   (It uses your mic; allow the permission when asked.)
5. **Make two agents fight over a file.** When two reach for the same one, one wins the lock and the
   other visibly backs off and greys out. Coordination you can actually see.

## Choosing what agents work on

The sidecar reads a project config. **Out of the box it uses three throwaway sandbox repos** (auto-created
under `sidecar/runtime/demo-repos/`) so your first run does real work without touching your code. To put
agents on **your own repos**, drop a `sidecar/runtime/projects.json` (or set `AGENTCRAFT_PROJECTS`) with the
same shape:

```json
[
  {
    "id": "web",
    "name": "Web Platform",
    "repo_path": "/Users/you/code/your-web-app",
    "agents": [{ "agent_id": "a1", "label": "Vinny", "character_kind": "viking" }]
  }
]
```

A `repo_path` pointing at a real repo is only ever touched inside an isolated worktree — never your live
tree, and never auto-created. There's a copy-paste starter at `sidecar/projects.example.json`, and
the full walkthrough (rules, multiple agents, precedence) is in **[ADD_YOUR_REPOS.md](ADD_YOUR_REPOS.md)**.

## Want it to stick around, or go multiplayer?

Solo play needs no cloud at all. But if you want a world that persists, an activity stream, the in-world
data engineer, or (down the line) to share your world with other people, that's where Aiven comes in.
It's pure config — the same code lights up. Walkthrough, including a free local-Docker setup:
**[AIVEN_SETUP.md](AIVEN_SETUP.md)**.

## When things go sideways

- **`/health` says `auth:"apikey"`, or the app stops on boot.** An agent leaned on a metered API key.
  Run `claude login` so it uses your subscription instead. (Dev-only escape hatch:
  `AGENTCRAFT_ALLOW_APIKEY=1` — please don't put that on a real machine.)
- **`/health` says `auth:"unknown"`.** The login check hasn't finished (it can take up to a minute) or
  you're not logged in. Run `claude login` and check again.
- **Port 8787 is taken.** Something else grabbed it — stop that, or change the sidecar's host/port.
- **The world looks empty.** Confirm the sidecar's up (`curl /health`) and the game connected — the
  game's console prints the connection line.
- **I prompted an agent and nothing happened.** Either the 3-live-agents cap is full, or the repo
  couldn't be isolated. The agent's status line tells you which.

Still stuck? Open an issue with your OS, the `/health` output, and what you saw. We don't bite.
