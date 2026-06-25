// Decisive test: does @anthropic-ai/claude-agent-sdk query() run on the SUBSCRIPTION
// with the metered ANTHROPIC_* vars scrubbed? If yes, the sidecar's agent-session path is viable.
import { query } from "@anthropic-ai/claude-agent-sdk";

for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete process.env[k];

const timer = setTimeout(() => { console.error("TIMEOUT (90s)"); process.exit(2); }, 90_000);
let got = "";
try {
  for await (const m of query({ prompt: "Reply with exactly: SDK_OK", options: { maxTurns: 1 } })) {
    if (m.type === "assistant") {
      got += (m.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    } else if (m.type === "result") {
      got += (m.result ?? "");
    }
  }
  clearTimeout(timer);
  console.log("SDK output:", JSON.stringify(got).slice(0, 200));
  console.log(got.includes("SDK_OK") ? "SDK PASS — query() ran on subscription (scrubbed env)" : "SDK ran but produced no SDK_OK");
  process.exit(0);
} catch (e) {
  clearTimeout(timer);
  console.error("SDK ERROR:", e?.message ?? String(e));
  process.exit(1);
}
