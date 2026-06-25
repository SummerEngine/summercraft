/**
 * AgentCraft — world hierarchy builder (Track A / Brain, DATA_MODEL.md).
 *
 * Assembles the GET /hierarchy snapshot: the theme-agnostic Agent → Project → Repo → Group tree that B
 * renders (through the active theme) and D navigates. This is the DATA layer only — no visuals, no theme.
 *
 * It is derived from the LIVE store records (which carry project_id / repo_id / group_id parent links,
 * stamped at seed time) so the tree always agrees with /world, plus the project config for human names +
 * real repo paths (a live agent's record repo_path is its worktree, not the repo root — so names/paths
 * come from the config when known). Pure, cheap, never throws.
 *
 * Demo shape is degenerate-but-real: one Group ("Summer") → one Repo per project → one Project per repo
 * (project_id == repo_id) → the agents. The override config / the gated next workstream expresses richer,
 * nested groups and split project/repo levels; the shape here doesn't change, only the data does.
 */
import { store } from "./session-store.ts";
import { loadProjects, DEFAULT_GROUP } from "./projects.ts";
import type { Group, Repo, Project, HierarchySnapshot, AgentView } from "./contract.ts";

export async function buildHierarchy(): Promise<HierarchySnapshot> {
  const cfg = await loadProjects().catch(() => []);
  const nameById = new Map<string, string>();
  const pathById = new Map<string, string>();
  for (const p of cfg) {
    nameById.set(p.id, p.name);
    pathById.set(p.id, p.repo_path);
  }

  const records = store.list();
  const agents: AgentView[] = records.map((r) => store.toView(r));

  const groups = new Map<string, Group>();
  const repos = new Map<string, Repo>();
  const projects = new Map<string, Project>();

  for (const r of records) {
    const gid = r.group_id ?? DEFAULT_GROUP.id;
    const rid = r.repo_id;
    const pid = r.project_id ?? r.repo_id;

    if (!groups.has(gid)) {
      // The default group keeps its human name; any other id surfaces as itself until config names it.
      groups.set(gid, {
        id: gid,
        name: gid === DEFAULT_GROUP.id ? DEFAULT_GROUP.name : gid,
        parent_group_id: null,
      });
    }
    if (!repos.has(rid)) {
      repos.set(rid, {
        id: rid,
        name: nameById.get(rid) ?? rid,
        group_id: gid,
        repo_path: pathById.get(rid) ?? r.repo_path, // config path (repo root), not a live worktree
      });
    }
    if (!projects.has(pid)) {
      projects.set(pid, {
        id: pid,
        name: nameById.get(pid) ?? pid,
        repo_id: rid,
        working_dir: pathById.get(pid) ?? r.repo_path,
      });
    }
  }

  return {
    groups: [...groups.values()],
    repos: [...repos.values()],
    projects: [...projects.values()],
    agents,
  };
}
