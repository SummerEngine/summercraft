#!/usr/bin/env node
/**
 * Billing smoke test — prove spawned Claude children run on the user's SUBSCRIPTION, not a
 * metered key. Logic: if the metered ANTHROPIC_* vars are scrubbed and `claude -p` STILL works,
 * it must be authenticating via the Pro/Max subscription. Re-run this on the demo machine before
 * going on stage (`npm run billing-check` from the sidecar dir).
 */
import { spawn } from "node:child_process";
import { scrubAnthropicEnv, scrubbedVarsPresent } from "./env-scrub.mjs";

const present = scrubbedVarsPresent();
console.log("[billing-check] metered vars present in this shell:", present.length ? present.join(", ") : "(none)");
console.log("[billing-check] spawning `claude -p` with those vars SCRUBBED ...");

const child = spawn("claude", ["-p", "Reply with exactly: SUBSCRIPTION_OK"], {
  env: scrubAnthropicEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (err += d.toString()));

const timer = setTimeout(() => {
  console.error("[billing-check] TIMEOUT after 60s — killing.");
  child.kill("SIGKILL");
  process.exit(2);
}, 60_000);

child.on("error", (e) => {
  clearTimeout(timer);
  console.error("[billing-check] could not spawn `claude`:", e.message);
  process.exit(3);
});

child.on("close", (code) => {
  clearTimeout(timer);
  if (out.includes("SUBSCRIPTION_OK")) {
    console.log("[billing-check] PASS — claude ran with NO metered key => on subscription.");
    process.exit(0);
  }
  console.error("[billing-check] FAIL — exit", code);
  console.error("[billing-check] stdout:", out.slice(0, 600));
  console.error("[billing-check] stderr:", err.slice(0, 600));
  console.error("[billing-check] If this complains about a missing API key, the app was leaning on the metered key — that's exactly the trap this guards.");
  process.exit(1);
});
