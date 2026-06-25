/**
 * THE SINGLE LOAD-BEARING SAFETY RULE (plan §2).
 *
 * This machine has ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL set for the
 * web app. Every Claude child process the sidecar spawns MUST run with these DELETED, or it
 * silently bills the metered key / gateway instead of the user's Pro/Max subscription.
 *
 * agent-session.ts (Track A) MUST import and use scrubAnthropicEnv() for every spawned child.
 * billing-check.mjs proves it works. Do not duplicate this logic anywhere — import it.
 */
export const ANTHROPIC_METERED_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
];

/** Return a copy of env with all metered Anthropic vars removed. */
export function scrubAnthropicEnv(env = process.env) {
  const e = { ...env };
  for (const k of ANTHROPIC_METERED_VARS) delete e[k];
  return e;
}

/** Which metered vars are currently set (for logging / smoke tests). */
export function scrubbedVarsPresent(env = process.env) {
  return ANTHROPIC_METERED_VARS.filter((k) => env[k] != null && env[k] !== "");
}
