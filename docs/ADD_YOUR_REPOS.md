# Put your agents on your own repos

By default SummerCraft runs on three throwaway sandbox repos (`web`, `engine`, `templates`) that live
under `sidecar/runtime/demo-repos/`. They're auto-created as real little git repos so you can type a task,
watch an agent do real work, and see a real `git diff` — **without ever touching your own code.** Great for
a first run and for demos.

When you're ready to point the agents at **your actual repos**, it's one JSON file. No GUI yet — the config
*is* the onboarding.

## The model

> **A project = one repo + a name + the agents (NPCs) that work in it.**

Each agent you list becomes one character in the world, standing at that repo's building.

## How to add your repos

1. Copy the example into place:
   ```bash
   cp sidecar/projects.example.json sidecar/runtime/projects.json
   ```
2. Edit `sidecar/runtime/projects.json` — set each `repo_path` to a real folder on your machine, and name
   the projects/agents however you like:
   ```json
   [
     {
       "id": "summerengine",
       "name": "Summer Engine",
       "repo_path": "/Users/you/development/summerengine",
       "agents": [
         { "agent_id": "a1", "label": "Vinny", "character_kind": "viking" }
       ]
     }
   ]
   ```
3. Restart the backend:
   ```bash
   cd sidecar && npm run demo
   ```

That's it. `/projects` and the world now show your repos, and a typed (or spoken) task runs a real Claude
agent against that code.

## The rules (so nothing surprises you)

- **`repo_path` is an absolute path to a git repo.** Each agent works in its **own isolated git worktree**
  branched off your repo — it never edits your working tree, never switches your branch, and you review the
  diff before anything merges. If you point at a path that isn't a git repo, the agent has nowhere safe to
  worktree, so keep it to real repos.
- **`character_kind`** is one of `viking | wizard | dwarf | barbarian` (just the look).
- **`agent_id`** is any unique short id (`a1`, `a4`, `frontend`, …). Add as many agents as you want — each
  one spawns its own NPC. The 3-live-session cap means only 3 run at once; the rest stand idle until tapped.
- **Nothing about your code leaves your machine.** Only anonymized activity (a state + a magnitude, no paths,
  no diffs, no transcripts) is ever published to the shared Aiven world. See `docs/DATA_MODEL.md`.
- **No restart needed for your edits to land** — the file is read at boot, so changing the *roster* needs a
  restart, but the agents' actual work streams live over `/world`.

## Two other ways to set it (same shape)

- **`AGENTCRAFT_PROJECTS`** env var holding the same JSON — wins over the file. Handy for a one-off stage
  config without editing files.
- The built-in default (the three sandbox repos) is the fallback when neither is present — so a fresh clone
  always boots into a safe, demoable state.

Order of precedence: `AGENTCRAFT_PROJECTS` env → `sidecar/runtime/projects.json` → built-in sandbox default.
