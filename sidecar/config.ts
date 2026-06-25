/**
 * AgentCraft — central config loader (Track A / Brain, plan §4.2 seam 2, lane L4).
 *
 * SEAM (stable signature — bootstrap calls `load()` ONCE and passes the result down; L4 owns the real
 * impl): `load(): Promise<SidecarConfig>` returning a validated `{ env, projects, aiven, voice }`.
 *
 * PHASE-1 SKELETON: reads the SAME env vars the rest of the sidecar reads inline today, with the SAME
 * defaults, and returns them as a structured object. It changes NO default and adds NO validation, so
 * boot behavior is byte-identical. L4 later (a) adds fail-fast validation on clearly-invalid values and
 * (b) migrates server.ts / pg.ts / operator.ts / openai paths off their scattered `process.env` reads
 * onto this single source. Nothing in Phase-1 is rewired to consume it yet — the seam just exists.
 *
 * `ProjectConfig` is re-exported FROM projects.ts (its owner) to avoid a second definition / circular
 * ownership — projects.ts stays the source of truth for the project shape + the load precedence.
 */
import fsSync from "node:fs";

import { HOST, PORT } from "./contract.ts";
import { loadProjects, type ProjectConfig } from "./projects.ts";

export type { ProjectConfig };

/** The fully-resolved config the bootstrap threads through the process. */
export interface SidecarConfig {
  env: {
    host: string;
    port: number;
    /** the `claude` binary the auth probe + sessions spawn (AGENTCRAFT_CLAUDE_BIN, default "claude"). */
    claudeBin: string;
    /** per-launch WS auth token; the bootstrap mints this (randomUUID) and writes runtime/auth.token. */
    authToken: string;
  };
  projects: ProjectConfig[];
  aiven: {
    /** AIVEN_PG_URI || DATABASE_URL — null when Aiven is OFF. */
    pgUri: string | null;
    /** AGENTCRAFT_AIVEN_MCP_URL — null when the operator MCP is unconfigured. */
    mcpUrl: string | null;
    /** AIVEN_PG_CA — path to Aiven's ca.pem for TLS verification, or null. */
    caPath: string | null;
    /** AIVEN_PG_SSL_INSECURE=1 — last-resort TLS-verification escape hatch (MITM-exposed). */
    sslInsecure: boolean;
  };
  voice: {
    /** ELEVENLABS_API_KEY — server-side only, never sent to the client. null when unset. */
    elevenLabsApiKey: string | null;
    /** ELEVENLABS_AGENT_ID — the single shared custom-LLM agent id. null when unset. */
    elevenLabsAgentId: string | null;
  };
}

/** A single config problem found by validateConfig — `fatal` ones make loadValidated() fail fast. */
export interface ConfigIssue {
  /** dotted path of the offending field, e.g. "aiven.caPath" or "voice.elevenLabsAgentId". */
  field: string;
  /** human-readable, actionable message (no secret values — only names/paths). */
  message: string;
  /** true -> a half-configured boot we refuse to start; false -> a degraded-but-OK warning. */
  fatal: boolean;
}

/** Treat an empty / whitespace-only env var as "unset" (null), mirroring the inline `?? ""` reads. */
function envOrNull(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

/**
 * Load + structure the sidecar config. Phase-1: same reads, same defaults, no validation, never throws
 * for config reasons (project parsing already degrades to defaults inside projects.ts). `authToken` is
 * supplied by the bootstrap (it owns minting/persisting the token) rather than read from env.
 */
export async function load(authToken = ""): Promise<SidecarConfig> {
  const projects = await loadProjects();
  return {
    env: {
      host: HOST,
      port: PORT,
      claudeBin: process.env.AGENTCRAFT_CLAUDE_BIN ?? "claude",
      authToken,
    },
    projects,
    aiven: {
      pgUri: envOrNull("AIVEN_PG_URI") ?? envOrNull("DATABASE_URL"),
      mcpUrl: envOrNull("AGENTCRAFT_AIVEN_MCP_URL"),
      caPath: envOrNull("AIVEN_PG_CA"),
      sslInsecure: process.env.AIVEN_PG_SSL_INSECURE === "1",
    },
    voice: {
      elevenLabsApiKey: envOrNull("ELEVENLABS_API_KEY"),
      elevenLabsAgentId: envOrNull("ELEVENLABS_AGENT_ID"),
    },
  };
}

/**
 * Validate a loaded config and return every problem found (does NOT throw). `fatal:true` issues are
 * half-configured states we should refuse to boot on; `fatal:false` issues are degraded-but-runnable
 * warnings (e.g. voice partially configured -> voice just stays off). Messages reference only env-var
 * NAMES and file PATHS, never secret VALUES, so the result is safe to log and to surface on /ready.
 *
 * Rules (the half-config traps the charter §2 calls out):
 *   - port out of range / non-loopback host           -> fatal (we only ever bind 127.0.0.1:8787)
 *   - AIVEN_PG_URI set but its CA path doesn't exist   -> fatal (TLS verify will fail at query time;
 *       fail fast at boot instead of degrading silently on the first /world)
 *   - AIVEN_PG_SSL_INSECURE=1                           -> warn (MITM-exposed escape hatch)
 *   - exactly one of ELEVENLABS_API_KEY / _AGENT_ID set -> warn (voice will report configured:false)
 *   - no projects resolved                              -> warn (/world will be empty but valid)
 *   - LOG_LEVEL / LOG_FORMAT set to an unknown value    -> warn (logger falls back to info/pretty)
 */
export function validateConfig(cfg: SidecarConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  if (!Number.isInteger(cfg.env.port) || cfg.env.port < 1 || cfg.env.port > 65535) {
    issues.push({ field: "env.port", message: `port ${cfg.env.port} is out of range`, fatal: true });
  }
  if (cfg.env.host !== "127.0.0.1" && cfg.env.host !== "localhost") {
    issues.push({
      field: "env.host",
      message: `host "${cfg.env.host}" is not loopback — the sidecar must bind 127.0.0.1 only`,
      fatal: true,
    });
  }

  if (cfg.aiven.pgUri) {
    if (cfg.aiven.caPath && !fileReadable(cfg.aiven.caPath)) {
      issues.push({
        field: "aiven.caPath",
        message: `AIVEN_PG_CA points at "${cfg.aiven.caPath}" which is not a readable file — TLS verify will fail`,
        fatal: true,
      });
    }
    if (cfg.aiven.sslInsecure) {
      issues.push({
        field: "aiven.sslInsecure",
        message: "AIVEN_PG_SSL_INSECURE=1 disables TLS verification (MITM-exposed) — never use on the demo machine",
        fatal: false,
      });
    }
  }

  // Voice is all-or-nothing: a key without an agent id (or vice-versa) silently yields configured:false.
  const haveKey = !!cfg.voice.elevenLabsApiKey;
  const haveAgent = !!cfg.voice.elevenLabsAgentId;
  if (haveKey !== haveAgent) {
    issues.push({
      field: haveKey ? "voice.elevenLabsAgentId" : "voice.elevenLabsApiKey",
      message: "ElevenLabs is half-configured (need BOTH ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID) — voice will stay off",
      fatal: false,
    });
  }

  if (cfg.projects.length === 0) {
    issues.push({ field: "projects", message: "no projects resolved — /world will be empty", fatal: false });
  }

  // logger.ts reads LOG_LEVEL / LOG_FORMAT directly at module load and silently falls back to info/pretty
  // on an unrecognized value. The fallback is safe, but a typo (LOG_LEVEL=warning, =verbose) would then be
  // ignored with no hint. Surface it as a non-fatal issue so the "fail-fast with clear messages" goal
  // covers these too — without changing logger's safe default. Read from env (not cfg) because these vars
  // aren't part of SidecarConfig; env is the same source logger.ts reads.
  const logLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (logLevel && !["debug", "info", "warn", "error"].includes(logLevel)) {
    issues.push({
      field: "env.LOG_LEVEL",
      message: `LOG_LEVEL="${logLevel}" is not one of debug|info|warn|error — logger falls back to "info"`,
      fatal: false,
    });
  }
  const logFormat = process.env.LOG_FORMAT?.trim().toLowerCase();
  if (logFormat && !["pretty", "json"].includes(logFormat)) {
    issues.push({
      field: "env.LOG_FORMAT",
      message: `LOG_FORMAT="${logFormat}" is not one of pretty|json — logger falls back to "pretty"`,
      fatal: false,
    });
  }

  return issues;
}

/** True if `p` is an existing, readable regular file. Never throws. */
function fileReadable(p: string): boolean {
  try {
    fsSync.accessSync(p, fsSync.constants.R_OK);
    return fsSync.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Load + fail-fast validate in one call. Logs every issue (fatal as error, warn as warn) and, if any
 * fatal issue exists, EXITS the process (code 78 = EX_CONFIG) with a clear message — the "one-command
 * boot with fail-fast config validation" the charter §0 wants. Pass `{ exit:false }` so a test can
 * inspect the issues without killing the runner; in that mode a fatal config returns the cfg with the
 * issues attached via the second tuple element instead of exiting.
 *
 * Returns the validated config (when there are no fatal issues, or when exit is suppressed).
 */
export async function loadValidated(
  authToken = "",
  opts: { exit?: boolean; log?: (level: "warn" | "error", m: string) => void } = {},
): Promise<{ config: SidecarConfig; issues: ConfigIssue[] }> {
  const exit = opts.exit ?? true;
  const log = opts.log ?? ((level, m) => (level === "error" ? console.error(m) : console.warn(m)));

  const config = await load(authToken);
  const issues = validateConfig(config);
  for (const i of issues) {
    log(i.fatal ? "error" : "warn", `[config] ${i.fatal ? "FATAL" : "warn"}: ${i.field} — ${i.message}`);
  }
  const fatal = issues.filter((i) => i.fatal);
  if (fatal.length > 0) {
    log("error", `[config] refusing to boot: ${fatal.length} fatal config issue(s). Fix the above and retry.`);
    if (exit) process.exit(78);
  }
  return { config, issues };
}
