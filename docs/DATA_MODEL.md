# SummerCraft — Data Model (canonical)

The world is a **fixed, concretely-named hierarchy**. No abstract "nodes" — just the real things,
called what they are. The visual representation is a separate, swappable layer (see Themes).

## The hierarchy (small → big)

| Level | What it is | Example | Default visual |
|---|---|---|---|
| **Agent** | one Claude session (one chat). The unit that does work. | "Vinny" working in `web/` | an NPC / character |
| **Project** | a connected folder (working directory) holding one or more agents. **= a Claude Code project.** Usually a repo root; can be a sub-folder. | `web/` with Vinny + Merlin | a building / house |
| **Repo** | a git repository; holds one or more projects. | `summerengine` (web app) | a city / cluster |
| **Group** | a named bundle of related repos (and/or other groups). Nestable for region → country. | "Summer" = `web` + `engine` | a country / region |

Rules:
- Every entity has a stable `id`, a human `name`, and a `parent` link. That's the whole tree.
- A **Project** maps to a real working directory; agents in it run there (each in its own worktree).
- A **Group** can contain repos OR other groups, so you can nest as deep as you want — but the names
  stay concrete (it's still "a group of repos," not a "node").
- This hierarchy is the **DATA**. It never changes per theme.

## Themes (the swappable skin)

A theme maps **(level → visual asset)**. Same data, different look:
- **Fortress:** Group→territory, Repo→keep, Project→tower, Agent→soldier.
- **Garden:** Group→region, Repo→field, Project→bed, Agent→plant.
- **City:** Group→country, Repo→city, Project→building, Agent→peon.

The user picks the theme. The renderer reads the hierarchy + the theme and draws it. Nothing in the
data model knows or cares which theme is active.

## Activity → shared world (local compute, cloud world)

- An agent does real work **locally** (your machine, your subscription, your code).
- On a save/commit it emits an **anonymized activity event**: `{ level_path, magnitude, state, ts }` —
  **no code, no diffs ever leave the machine.**
- The event streams up via **Aiven Kafka** → durable shared state in **Aiven Postgres** (each user's
  hierarchy + accumulated activity).
- Clients read the shared state + subscribe to the stream → render their own world AND other users'
  worlds (each through its chosen theme). "Visiting a garden" = reading another user's hierarchy.
- Because only anonymized activity is shared, the world is safe to be **public and open-source.**

## Three layers — keep them separate (do not couple)

| Layer | Owns | Swappable |
|---|---|---|
| **Data** | the hierarchy (Agent/Project/Repo/Group) + activity events | the truth, never themed |
| **Theme** | (level → visual asset) mapping | fortress / garden / city — any |
| **Infra** | Aiven (shared/persistent + Kafka stream) + local (compute) | behind a seam; could be swapped |

## Build ownership

- **A (Brain):** implements the hierarchy + activity events + the Aiven Postgres/Kafka sync. Adds the
  shapes to `contract.ts` (additive): `Project`, `Repo`, `Group`, and `ActivityEvent`. The agent (leaf)
  shape already exists (`AgentView`); add its `project_id` / `repo_id` / `group_id` parent links.
- **B (World):** renders the hierarchy in 3D **through the active theme** — not hardcoded to houses.
- **D (Interface):** the theme picker + the world/visiting UI.
- The proven local agents just **emit activity events**; everything visual is downstream of that.
