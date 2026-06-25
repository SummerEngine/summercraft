/**
 * AgentCraft — billing-honesty auth probe (Track A / Brain, plan §2).
 *
 * Split out of server.ts verbatim in the Phase-1 refactor: same scrubbed-env child probe, same
 * apikey-first HARD-STOP ordering, same cached result. Behavior is UNCHANGED — this is a file move.
 *
 * Probe whether spawned Claude children run on the subscription. If `claude -p` answers with the metered
 * ANTHROPIC_* vars scrubbed (env-scrub.mjs), it must be using the Pro/Max OAuth subscription. If it fails
 * complaining about a missing key/credit, the app was leaning on the metered key -> apikey (the HARD STOP
 * the UI surfaces). The result feeds GET /auth/status and GET /health.
 *
 * scrubAnthropicEnv() on the probe child is sacrosanct (plan §1 rule 4) — never weaken it.
 */
import { spawn } from "node:child_process";

import type { AuthStatus } from "./contract.ts";
import { scrubAnthropicEnv } from "./env-scrub.mjs";

const CLAUDE_BIN = process.env.AGENTCRAFT_CLAUDE_BIN ?? "claude";

/** Cached auth-mode probe so /auth/status is instant after the first check. */
let cachedAuth: AuthStatus = { mode: "unknown" };

/** The current cached auth mode (read by GET /auth/status and GET /health). */
export function authMode(): AuthStatus {
  return cachedAuth;
}

/**
 * Probe whether spawned Claude children run on the subscription. If `claude -p` answers with the
 * metered ANTHROPIC_* vars scrubbed, it must be using the Pro/Max OAuth subscription -> subscription.
 * If it fails complaining about a missing key, the app was leaning on the metered key -> apikey.
 * Cached; refreshed on boot. Never throws.
 */
export function probeAuthMode(): void {
  const child = spawn(CLAUDE_BIN, ["-p", "Reply with exactly: SUBSCRIPTION_OK"], {
    env: scrubAnthropicEnv() as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    cachedAuth = { mode: "unknown" };
  }, 60_000);

  child.on("error", () => {
    clearTimeout(timer);
    cachedAuth = { mode: "unknown" };
  });

  child.on("close", () => {
    clearTimeout(timer);
    const combined = out + err;
    // A metered key/credit complaint is the HARD STOP — check it FIRST so a rate-limit reply that also
    // mentions billing can't be misread as a clean subscription.
    if (/api[\s_-]?key|ANTHROPIC_API_KEY|credit balance|insufficient[\s_-]?credit|authentication/i.test(combined)) {
      cachedAuth = { mode: "apikey" };
      console.error("[sidecar] auth probe: APIKEY — HARD STOP. Child leaned on a metered key.");
    } else if (out.includes("SUBSCRIPTION_OK")) {
      cachedAuth = { mode: "subscription" };
      console.log("[sidecar] auth probe: subscription (scrubbed env, claude answered)");
    } else if (/rate[\s_-]?limit|429|overloaded|usage limit|too many requests/i.test(combined)) {
      // Rate-limited on the scrubbed env means we ARE on the subscription (no metered key present), the
      // account is just throttled. Surface it distinctly instead of silently downgrading to unknown so
      // the on-stage HARD-STOP check isn't weakened.
      cachedAuth = { mode: "subscription" };
      console.warn("[sidecar] auth probe: subscription but RATE-LIMITED — billing is safe, account throttled.");
    } else {
      cachedAuth = { mode: "unknown" };
      console.warn("[sidecar] auth probe: unknown (claude did not confirm).", err.slice(0, 200));
    }
  });
}
