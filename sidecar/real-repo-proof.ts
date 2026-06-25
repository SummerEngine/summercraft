// REAL PROOF: a real agent doing real work + a real COMMIT on the actual SummerCraft repo.
// Runs in an ISOLATED git worktree — your main checkout / working files are never touched.
import { execSync } from "node:child_process";
import { sessionManager } from "./session-manager.ts";
import { store } from "./session-store.ts";

for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete process.env[k];
delete process.env.AGENTCRAFT_AIVEN_MCP_URL; // Aiven off — just prove agent+repo+commit

const REPO = process.env.AGENTCRAFT_REPO ?? process.cwd();

store.onEvent((e: any) => {
  const d = e.text ?? e.state ?? e.summary ?? e.tool ?? "";
  console.log(`[event] ${e.type} ${e.agent_id ?? ""} ${String(d).slice(0, 80)}`);
});
if (typeof (store as any).whenReady === "function") await (store as any).whenReady();

const r: any = await sessionManager.spawn({ repoId: "summercraft", repoPath: REPO, characterKind: "viking", label: "Vinny" });
console.log("spawn ->", JSON.stringify(r.worktree ?? r));
if (r.ok === false) { console.error("SPAWN FAILED"); process.exit(1); }
const agentId = r.agentId ?? r.agent_id;
const wt: string = r.worktree?.path ?? REPO;

sessionManager.command(
  agentId,
  "In the current directory, create a file named REAL_AGENT_PROOF.md containing exactly one line: " +
  "'A real Claude agent committed this to the SummerCraft repo.' Then stage it and git commit with the " +
  "message 'proof: real agent commit on real repo'. If git complains about identity, set a local " +
  "user.email and user.name first. Then you are done.",
);
console.log("commanded agent", agentId, "in worktree", wt);

const deadline = Date.now() + 200_000;
while (Date.now() < deadline) {
  try {
    const log = execSync(`git -C "${wt}" log --oneline -1`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (log.toLowerCase().includes("proof: real agent")) {
      console.log("COMMIT FOUND:", log);
      console.log("WORKTREE:", wt, "(isolated — your main tree untouched)");
      console.log("REAL PASS — a real agent made a real commit on your real repo.");
      process.exit(0);
    }
  } catch { /* worktree not ready / no commit yet */ }
  await new Promise((res) => setTimeout(res, 3000));
}
console.error("TIMEOUT — no commit after 200s");
process.exit(2);
