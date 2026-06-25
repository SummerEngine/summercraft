/**
 * AgentCraft — project model + boot seeding (Track A / Brain, plan §3, §4-A).
 *
 * A **project = one repo + a display name + N agents**; each agent = one NPC in the world. This module
 * owns that config and turns it into the world's starting state:
 *   - `loadProjects()`   — the configured projects (default in-code, overridable by runtime/projects.json
 *                          or the AGENTCRAFT_PROJECTS env JSON).
 *   - `ensureDemoRepos()`— for the default sandbox repos, create a real git repo + seed commit so a typed
 *                          prompt does REAL work and `git diff` is meaningful — without touching any of
 *                          the user's real code. Only ever auto-creates paths under runtime/demo-repos.
 *   - `seedProjects()`   — create an IDLE store record per configured agent (records ≠ live sessions; the
 *                          live Claude session lazy-spawns on first prompt, so booting burns no quota).
 *   - `listProjects()`   — the /projects view: each project with its agents' live AgentViews.
 *
 * The 3-live-session cap lives in session-manager; seeding is unbounded (idle records are cheap).
 */
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { store, RUNTIME_DIR, type AgentRecord } from "./session-store.ts";
import { scrubAnthropicEnv } from "./env-scrub.mjs";
import { OPERATOR_SEED } from "./aiven/operator.ts";
import type { AgentView, CharacterKind } from "./contract.ts";

const pexec = promisify(exec);

/**
 * The default top-level Group every seeded repo rolls up into (DATA_MODEL.md hierarchy: Group → Repo →
 * Project → Agent). The demo is one group; the override config / later workstream can express richer,
 * nested groups. Overridable via env so a stage demo can label the group.
 */
export const DEFAULT_GROUP = {
  id: (process.env.AGENTCRAFT_GROUP_ID || "summer").trim(),
  name: (process.env.AGENTCRAFT_GROUP_NAME || "Summer").trim(),
};
/** Where auto-provisioned sandbox repos live (only when an override points here). */
const DEMO_REPOS_DIR = path.join(RUNTIME_DIR, "demo-repos");
/** Optional on-disk override for the project config. */
const PROJECTS_JSON = path.join(RUNTIME_DIR, "projects.json");

/** One seeded agent (NPC) inside a project. */
export interface AgentSeed {
  agent_id: string;
  label: string;
  character_kind: CharacterKind;
}

/** A project = repo + name + its agents. */
export interface ProjectConfig {
  id: string; // repo_id, e.g. "web"
  name: string; // display name, e.g. "Web Platform"
  repo_path: string; // absolute path to the repo the agents work in
  agents: AgentSeed[];
}

/** /projects response item: a project with its agents' current world views. */
export interface ProjectView {
  id: string;
  name: string;
  repo_path: string;
  agents: AgentView[];
}

/**
 * Default projects: three DISPOSABLE sandbox repos under runtime/demo-repos (web / engine / templates), one
 * agent each. ensureDemoRepos() auto-provisions each as a real git repo (README + main.ts + seed commit), so
 * a typed/spoken "add X" does REAL work and `git diff` is meaningful — WITHOUT ever touching the AgentCraft
 * checkout being presented. The default used to point at REPO_ROOT (the live AgentCraft repo): on stage that
 * mutated the demo's own source and any uncommitted/dirty state polluted the agent's base branch. The
 * sandbox default removes that hazard at the source, so it holds on a fresh clone too (the runtime/projects.json
 * override is gitignored and would silently fall back to this default if absent — so this default MUST be safe).
 *
 * agent_ids/labels/kinds (a1 Vinny viking / a2 Merlin wizard / a3 Durin dwarf) are UNCHANGED so the Godot
 * tracks (B/C/D) built against a1/a2/a3 keep working. Paths are anchored to RUNTIME_DIR (not cwd-relative)
 * so they resolve identically however the sidecar is launched, and so they sort UNDER DEMO_REPOS_DIR for the
 * ensureDemoRepos() auto-provision gate.
 *
 * Override (e.g. a multi-repo stage demo, or pointing an agent at a real repo) by writing runtime/projects.json
 * or setting AGENTCRAFT_PROJECTS (same shape). A repo_path under runtime/demo-repos is auto-provisioned as a
 * clean sandbox; any other path is treated as a real repo and never auto-created.
 */
export const DEFAULT_PROJECTS: ProjectConfig[] = [
  {
    id: "web",
    name: "Web",
    repo_path: path.join(DEMO_REPOS_DIR, "web"),
    agents: [{ agent_id: "a1", label: "Vinny", character_kind: "viking" }],
  },
  {
    id: "engine",
    name: "Engine",
    repo_path: path.join(DEMO_REPOS_DIR, "engine"),
    agents: [{ agent_id: "a2", label: "Merlin", character_kind: "wizard" }],
  },
  {
    id: "templates",
    name: "Templates",
    repo_path: path.join(DEMO_REPOS_DIR, "templates"),
    agents: [{ agent_id: "a3", label: "Durin", character_kind: "dwarf" }],
  },
];

const VALID_KINDS: CharacterKind[] = ["viking", "wizard", "dwarf", "barbarian"];

/** Load the project config: AGENTCRAFT_PROJECTS env JSON > runtime/projects.json > DEFAULT_PROJECTS. */
export async function loadProjects(): Promise<ProjectConfig[]> {
  const envJson = process.env.AGENTCRAFT_PROJECTS?.trim();
  if (envJson) {
    const parsed = parseProjects(envJson);
    if (parsed) return parsed;
    console.warn("[projects] AGENTCRAFT_PROJECTS is set but not valid JSON; ignoring.");
  }
  try {
    const raw = await fs.readFile(PROJECTS_JSON, "utf8");
    const parsed = parseProjects(raw);
    if (parsed) return parsed;
    console.warn(`[projects] ${PROJECTS_JSON} is not valid project JSON; using defaults.`);
  } catch {
    /* no override file — defaults */
  }
  return DEFAULT_PROJECTS;
}

/** Parse + validate a project-config JSON blob. Returns null on anything malformed (never throws). */
function parseProjects(raw: string): ProjectConfig[] | null {
  try {
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : Array.isArray(data?.projects) ? data.projects : null;
    if (!arr) return null;
    const out: ProjectConfig[] = [];
    for (const p of arr) {
      if (!p?.id || !p?.repo_path || !Array.isArray(p?.agents)) continue;
      out.push({
        id: String(p.id),
        name: String(p.name ?? p.id),
        repo_path: path.resolve(String(p.repo_path)),
        agents: p.agents
          .filter((a: any) => a?.agent_id)
          .map((a: any) => ({
            agent_id: String(a.agent_id),
            label: String(a.label ?? a.agent_id),
            character_kind: asKind(a.character_kind),
          })),
      });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function asKind(k: unknown): CharacterKind {
  return VALID_KINDS.includes(k as CharacterKind) ? (k as CharacterKind) : "viking";
}

/** Run a git command in `cwd` with metered Anthropic vars scrubbed (defense-in-depth). */
async function git(args: string, cwd: string): Promise<void> {
  await pexec(`git ${args}`, { cwd, env: scrubAnthropicEnv() as NodeJS.ProcessEnv, maxBuffer: 1 << 20 });
}

/**
 * For every project repo UNDER runtime/demo-repos that doesn't exist yet, create a real git repo with a
 * seed source file + initial commit, so agents have a clean base branch to worktree off and produce real
 * diffs. We ONLY auto-create inside DEMO_REPOS_DIR — a project pointed at a real repo is never touched.
 */
export async function ensureDemoRepos(projects: ProjectConfig[]): Promise<void> {
  await fs.mkdir(DEMO_REPOS_DIR, { recursive: true });
  for (const p of projects) {
    const repo = path.resolve(p.repo_path);
    if (!repo.startsWith(DEMO_REPOS_DIR + path.sep)) continue; // real repo — hands off
    const gitDir = path.join(repo, ".git");
    if (await exists(gitDir)) continue; // already provisioned
    try {
      await fs.mkdir(repo, { recursive: true });
      await fs.writeFile(
        path.join(repo, "README.md"),
        `# ${p.name}\n\nSummerCraft demo sandbox repo for project "${p.id}". Real git, safe to edit.\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(repo, "main.ts"),
        `// ${p.name} — demo source. Agents edit this and the diff shows up in the world.\nexport function hello(): string {\n  return "hello from ${p.id}";\n}\n`,
        "utf8",
      );
      await git("init -q", repo);
      await git("config user.email summercraft@local", repo);
      await git("config user.name SummerCraft", repo);
      await git("add -A", repo);
      await git('commit -q -m "seed: SummerCraft demo sandbox"', repo);
      console.log(`[projects] provisioned demo repo: ${repo}`);
    } catch (e) {
      console.warn(`[projects] could not provision demo repo ${repo}: ${msg(e)}`);
    }
  }
}

/**
 * Seed an IDLE store record per configured agent (if not already present). Records are NOT live
 * sessions — the world shows them immediately, and the live Claude session lazy-spawns on first prompt.
 * Returns the seeded/known projects so the caller can log/expose them.
 */
export async function seedProjects(): Promise<ProjectConfig[]> {
  const projects = await loadProjects();
  await ensureDemoRepos(projects);
  for (const p of projects) {
    for (const seed of p.agents) {
      if (store.has(seed.agent_id)) continue; // keep any rehydrated/live record as-is
      const rec: AgentRecord = {
        agent_id: seed.agent_id,
        repo_id: p.id,
        repo_path: path.resolve(p.repo_path),
        character_kind: seed.character_kind,
        label: seed.label,
        state: "waiting",
        status_line: "idle",
        current_task: null,
        target_base_id: p.id,
        last_seen_ms: Date.now(),
        transcript_tail: [],
        created_at: new Date().toISOString(),
        // Hierarchy parent links: in the demo a Project maps 1:1 to its Repo (project_id == repo_id);
        // both roll up into the default Group. A richer override can split project from repo.
        project_id: p.id,
        group_id: DEFAULT_GROUP.id,
      };
      await store.create(rec);
    }
  }
  // Seed Ada — the Autonomous Data Operator — as an IDLE record too, so the Aiven-main-track NPC is visible
  // in /world, /agents and /projects BEFORE her first mission (she previously only got a record once
  // runMission() spawned her, leaving the headline operator beat with no on-screen anchor). Record only:
  // lazy-spawn is preserved (no live session until a mission dispatches), so booting still burns no quota.
  // Her repo_path is a scratch dir under runtime/, never a real repo — the diff endpoint's index-mutation
  // gate leaves the live tree untouched for her.
  await seedOperator();

  const agents = projects.reduce((n, p) => n + p.agents.length, 0);
  console.log(`[projects] seeded ${agents} idle agent(s) across ${projects.length} project(s) + Ada (data operator).`);
  return projects;
}

/** Seed Ada's idle record (idempotent: keep any rehydrated/live record as-is). Best-effort. */
async function seedOperator(): Promise<void> {
  if (store.has(OPERATOR_SEED.agent_id)) return;
  // Ensure the operator scratch cwd exists so her read-only /diff has a directory to run in.
  await fs.mkdir(OPERATOR_SEED.repo_path, { recursive: true }).catch(() => {});
  const rec: AgentRecord = {
    agent_id: OPERATOR_SEED.agent_id,
    repo_id: OPERATOR_SEED.repo_id,
    repo_path: path.resolve(OPERATOR_SEED.repo_path),
    character_kind: OPERATOR_SEED.character_kind,
    label: OPERATOR_SEED.label,
    state: "waiting",
    status_line: OPERATOR_SEED.status_line,
    current_task: null,
    target_base_id: OPERATOR_SEED.repo_id,
    last_seen_ms: Date.now(),
    transcript_tail: [],
    created_at: new Date().toISOString(),
    project_id: OPERATOR_SEED.repo_id,
    group_id: DEFAULT_GROUP.id,
  };
  await store.create(rec);
}

/**
 * Build the /projects view: each configured project with the live AgentViews of its agents (so D can
 * render project tabs with current state without joining /world itself). Agents missing a record are
 * skipped (should not happen after seedProjects()).
 */
export async function listProjects(): Promise<ProjectView[]> {
  const projects = await loadProjects();
  const views: ProjectView[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    repo_path: path.resolve(p.repo_path),
    agents: p.agents
      .map((seed) => {
        const rec = store.get(seed.agent_id);
        return rec ? store.toView(rec) : null;
      })
      .filter((v): v is AgentView => v != null),
  }));
  // Surface the Aiven-ops "project" (Ada the data operator) so /projects has the operator beat's tab, with
  // Ada's live view. Appended (not in DEFAULT_PROJECTS) because Ada isn't a code-repo agent — she operates
  // infra; skipped silently if her record somehow isn't seeded.
  const ada = store.get(OPERATOR_SEED.agent_id);
  if (ada) {
    views.push({
      id: OPERATOR_SEED.repo_id,
      name: "Aiven Ops",
      repo_path: path.resolve(OPERATOR_SEED.repo_path),
      agents: [store.toView(ada)],
    });
  }
  return views;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
