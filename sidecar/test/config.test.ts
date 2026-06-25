/**
 * Unit tests — fail-fast config validation (config.ts validateConfig / loadValidated).
 *
 * The "one-command boot with fail-fast config validation" the charter §0 requires lives here. validateConfig
 * returns every problem WITHOUT throwing or leaking secret values, classifying each as fatal (refuse to
 * boot) or warn (degraded-but-runnable). We pin the half-config traps the charter calls out:
 *   - a non-loopback host / out-of-range port -> fatal,
 *   - AIVEN_PG_URI set with a CA path that isn't a readable file -> fatal,
 *   - AIVEN_PG_SSL_INSECURE -> warn (MITM escape hatch),
 *   - exactly one of ELEVENLABS_API_KEY / _AGENT_ID -> warn (voice half-configured),
 *   - zero projects -> warn,
 *   - a clean config -> no issues,
 *   - loadValidated({exit:false}) surfaces the issues without killing the runner.
 *
 * Messages must reference only names/paths, never secret VALUES (safe to log + surface on /ready).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateConfig, loadValidated, type SidecarConfig } from "../config.ts";

/** A minimal, fully-valid config we can clone + mutate per case. */
function baseConfig(): SidecarConfig {
  return {
    env: { host: "127.0.0.1", port: 8787, claudeBin: "claude", authToken: "tok" },
    projects: [{ id: "p", name: "P", repo_path: "/tmp/p", agents: [] }],
    aiven: { pgUri: null, mcpUrl: null, caPath: null, sslInsecure: false },
    voice: { elevenLabsApiKey: null, elevenLabsAgentId: null },
  };
}

test("a clean default config produces zero issues", () => {
  assert.deepEqual(validateConfig(baseConfig()), []);
});

test("a non-loopback host is fatal", () => {
  const cfg = baseConfig();
  cfg.env.host = "0.0.0.0";
  const issues = validateConfig(cfg);
  const hostIssue = issues.find((i) => i.field === "env.host");
  assert.ok(hostIssue);
  assert.equal(hostIssue!.fatal, true);
});

test("an out-of-range port is fatal", () => {
  for (const port of [0, -1, 70000, 1.5]) {
    const cfg = baseConfig();
    cfg.env.port = port;
    const issue = validateConfig(cfg).find((i) => i.field === "env.port");
    assert.ok(issue, `port ${port} should be flagged`);
    assert.equal(issue!.fatal, true);
  }
});

test("localhost host is accepted (loopback)", () => {
  const cfg = baseConfig();
  cfg.env.host = "localhost";
  assert.equal(validateConfig(cfg).some((i) => i.field === "env.host"), false);
});

test("AIVEN_PG_URI set with an unreadable CA path is fatal", () => {
  const cfg = baseConfig();
  cfg.aiven.pgUri = "postgres://user:pw@host:5432/db?sslmode=require";
  cfg.aiven.caPath = path.join(os.tmpdir(), "definitely-not-here-" + Date.now() + ".pem");
  const issue = validateConfig(cfg).find((i) => i.field === "aiven.caPath");
  assert.ok(issue);
  assert.equal(issue!.fatal, true);
  // The message names the PATH but must not contain the connection-string secret.
  assert.doesNotMatch(issue!.message, /pw@host/);
});

test("AIVEN_PG_URI with a readable CA file passes", () => {
  const ca = path.join(os.tmpdir(), "fake-ca-" + Date.now() + ".pem");
  fs.writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
  try {
    const cfg = baseConfig();
    cfg.aiven.pgUri = "postgres://host/db";
    cfg.aiven.caPath = ca;
    assert.equal(validateConfig(cfg).some((i) => i.field === "aiven.caPath"), false);
  } finally {
    fs.rmSync(ca, { force: true });
  }
});

test("AIVEN_PG_SSL_INSECURE is a warn, not a fatal", () => {
  const cfg = baseConfig();
  cfg.aiven.pgUri = "postgres://host/db";
  cfg.aiven.sslInsecure = true;
  const issue = validateConfig(cfg).find((i) => i.field === "aiven.sslInsecure");
  assert.ok(issue);
  assert.equal(issue!.fatal, false);
});

test("half-configured ElevenLabs (key without agent id) is a warn", () => {
  const cfg = baseConfig();
  cfg.voice.elevenLabsApiKey = "el-key";
  // agent id left null
  const issue = validateConfig(cfg).find((i) => i.field.startsWith("voice."));
  assert.ok(issue);
  assert.equal(issue!.fatal, false);
  // never echo the key value.
  assert.doesNotMatch(issue!.message, /el-key/);
});

test("fully-configured ElevenLabs (both set) is fine", () => {
  const cfg = baseConfig();
  cfg.voice.elevenLabsApiKey = "el-key";
  cfg.voice.elevenLabsAgentId = "agent_123";
  assert.equal(validateConfig(cfg).some((i) => i.field.startsWith("voice.")), false);
});

test("zero projects is a warn (empty but valid world)", () => {
  const cfg = baseConfig();
  cfg.projects = [];
  const issue = validateConfig(cfg).find((i) => i.field === "projects");
  assert.ok(issue);
  assert.equal(issue!.fatal, false);
});

test("loadValidated({exit:false}) surfaces issues without killing the runner", async () => {
  const logged: string[] = [];
  const { config, issues } = await loadValidated("test-token", {
    exit: false,
    log: (_lvl, m) => logged.push(m),
  });
  // It loaded a real config (env-derived) and returned the issue list rather than process.exit().
  assert.ok(config);
  assert.equal(config.env.authToken, "test-token");
  assert.ok(Array.isArray(issues));
});
