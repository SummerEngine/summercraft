// SPINE PROOF: spawn a real agent through the sidecar's session layer and have it do
// real work (write a file) in a real repo on the subscription. If PROOF.txt appears with
// the right content, the entire backend spine is real — not a shell.
import { sessionManager } from "./session-manager.ts";
import { store } from "./session-store.ts";
import { promises as fs } from "node:fs";

for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete process.env[k];

const PROOF = "/tmp/agentcraft-test-repo/PROOF.txt";

store.onEvent((e: any) => {
  const d = e.text ?? e.state ?? e.summary ?? e.message ?? e.tool ?? "";
  console.log(`[event] ${e.type} ${e.agent_id ?? ""} ${String(d).slice(0, 90)}`);
});

if (typeof (store as any).whenReady === "function") await (store as any).whenReady();

const r: any = await sessionManager.spawn({
  repoId: "test",
  repoPath: "/tmp/agentcraft-test-repo",
  characterKind: "viking",
  label: "Tester",
});
console.log("spawn ->", JSON.stringify(r));
if (!r || r.ok === false) {
  console.error("SPAWN FAILED");
  process.exit(1);
}
const agentId = r.agentId ?? r.agent_id ?? r.id;
const dispatched = sessionManager.command(
  agentId,
  "Use your tools to create a file at the absolute path /tmp/agentcraft-test-repo/PROOF.txt whose contents are exactly: HELLO_AGENTCRAFT — nothing else. Then you are done.",
);
console.log("command dispatched ->", dispatched, "agentId:", agentId);

const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  try {
    const c = await fs.readFile(PROOF, "utf8");
    console.log("FILE CONTENT:", JSON.stringify(c));
    console.log(c.includes("HELLO_AGENTCRAFT") ? "SPINE PASS — real agent did real work in the repo via the sidecar" : "file created but wrong content");
    process.exit(0);
  } catch { /* not yet */ }
  await new Promise((res) => setTimeout(res, 2000));
}
console.error("TIMEOUT — no PROOF.txt after 150s");
process.exit(2);
