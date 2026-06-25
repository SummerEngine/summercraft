/**
 * Integration test — boots the sidecar on a TEST port, hits the read endpoints, asserts their shapes,
 * then tears the server down. The charter's "integration tests (boot -> endpoints)" gate (plan §2, §5
 * Phase 4) at the cheapest honest level: real router + real seeded records, no Aiven, no live agent quota.
 *
 * It NEVER leaves a server running and finishes well under 60s:
 *   - spawns test/_boot-for-test.ts via tsx on a free TEST port, in an isolated temp cwd (so runtime/ is
 *     sandboxed) with AGENTCRAFT_PROJECTS pointed at a sandbox demo-repo (so /world + /projects are
 *     populated with a known agent we can assert on),
 *   - waits for the BOOT_READY sentinel (bounded), curls /health, /world, /projects, /operator/missions
 *     via fetch and asserts each shape,
 *   - on success OR failure: SIGTERM the child, then belt-and-braces `lsof -ti:<port>` kill so the port
 *     is always freed (the same teardown the charter mandates for any booted check).
 *
 * Run: `node test/integration.mjs`  (or `npm run test:integration`). Exit 0 = PASS, non-zero = a failure.
 */
import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_DIR = path.resolve(__dirname, "..");
const BOOT_SCRIPT = path.join(__dirname, "_boot-for-test.ts");

/**
 * Resolve tsx's ESM loader to an ABSOLUTE file URL from the sidecar's node_modules, so the boot child can
 * run .ts even though its cwd is an isolated temp dir with no node_modules (a bare `--import tsx` resolves
 * the loader relative to cwd and would fail there).
 */
const require = createRequire(path.join(SIDECAR_DIR, "package.json"));
const TSX_LOADER = pathToFileURL(require.resolve("tsx")).href;

/** Pick a high test port unlikely to collide with the real 8787 sidecar. */
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 30_000;
/** Per-request ceiling so a wedged handler can't hang a fetch indefinitely (the <60s guarantee). */
const REQUEST_TIMEOUT_MS = 10_000;
/** Outer wall-clock watchdog: self-bound the WHOLE harness regardless of child/handler behavior. The
 *  _boot-for-test watchdog only kills the child; this guarantees the PARENT test process exits too, so
 *  README §4's "< 60s, leaves nothing running" holds even if a future live dep wedges a route handler. */
const HARNESS_DEADLINE_MS = 50_000;

let failures = 0;
function ok(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

/** Belt-and-braces: free the test port no matter how we exit (the charter's mandated teardown). */
function freePort() {
  try {
    const pids = execSync(`lsof -ti:${PORT} || true`, { encoding: "utf8" }).trim();
    if (pids) for (const pid of pids.split(/\s+/)) execSync(`kill -9 ${pid} || true`);
  } catch {
    /* nothing listening — fine */
  }
}

async function waitForReady(child) {
  let buf = "";
  return await new Promise((resolve, reject) => {
    // Single bounded timeout source; cleared on success so no unref'd timer dangles past resolution.
    const t = setTimeout(() => reject(new Error("boot did not become ready in time")), BOOT_TIMEOUT_MS);
    t.unref();
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/BOOT_READY (\d+)/);
      if (m) {
        clearTimeout(t);
        child.stdout.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => process.stderr.write(`[boot] ${d}`));
    child.once("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`boot child exited early (code ${code})`));
    });
  });
}

async function getJson(pathname) {
  // AbortSignal.timeout bounds each request so a wedged handler can't hang the harness past its budget.
  const res = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const body = await res.json();
  return { status: res.status, body };
}

async function postJson(pathname, payload) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Some routes (the SSE shim) don't return JSON; callers that need the body decode it themselves.
  return res;
}

async function main() {
  // Outer wall-clock watchdog: free the port and hard-exit non-zero if the whole harness ever exceeds its
  // budget, so a wedged handler can't blow past README §4's "< 60s, leaves nothing running" guarantee. The
  // per-request AbortSignal timeouts are the first line; this is the belt-and-braces backstop for the parent.
  const watchdog = setTimeout(() => {
    console.error(`\nINTEGRATION_FAIL — harness exceeded ${HARNESS_DEADLINE_MS}ms wall clock; forcing teardown.`);
    freePort();
    process.exit(1);
  }, HARNESS_DEADLINE_MS);
  watchdog.unref();

  // Isolated cwd so RUNTIME_DIR (cwd/runtime) doesn't touch the real one; a sandbox demo-repo project so
  // seeding provisions a clean git repo and /world + /projects have a known agent to assert on.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agentcraft-int-"));
  const sandboxRepo = path.join(tmp, "runtime", "demo-repos", "intproj");
  const projectsJson = JSON.stringify([
    {
      id: "intproj",
      name: "Integration Project",
      repo_path: sandboxRepo,
      agents: [{ agent_id: "int1", label: "Tester", character_kind: "viking" }],
    },
  ]);

  freePort(); // start from a clean port

  const child = spawn(process.execPath, ["--import", TSX_LOADER, BOOT_SCRIPT, String(PORT)], {
    cwd: tmp,
    env: {
      ...process.env,
      AGENTCRAFT_PROJECTS: projectsJson,
      // Keep Aiven + the operator MCP OFF so this is a pure local-records boot (no external deps, no hang).
      AIVEN_PG_URI: "",
      DATABASE_URL: "",
      AGENTCRAFT_AIVEN_MCP_URL: "",
      // BILLING SAFETY for CI/the demo machine: point the Claude binary at a guaranteed-missing path so
      // the live /v1/chat/completions POST below (and the auth probe) FAIL FAST with ENOENT and never
      // spawn a real, metered Claude session / burn a live-session slot. The shim still streams its full
      // SSE framing (buffer words + unconditional [DONE]) on a failed turn, so the wire-shape assertions
      // hold offline. Without this, on a box where `claude` is installed+authed every run would bill quota.
      AGENTCRAFT_CLAUDE_BIN: path.join(tmp, "no-such-claude-bin"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const boundPort = await waitForReady(child);
    ok(boundPort === PORT, `sidecar booted on test port ${PORT}`);

    // /health -> { ok, live_sessions, auth, aiven, operator }
    {
      const { status, body } = await getJson("/health");
      ok(status === 200, "/health 200");
      ok(body.ok === true, "/health ok:true");
      ok(typeof body.live_sessions === "number", "/health live_sessions is a number");
      ok(body.aiven === "off", "/health reports aiven off (no AIVEN_PG_URI)");
      ok(body.operator === false, "/health reports operator off (no AIVEN_MCP_URL)");
    }

    // /world -> { agents, locks, events } with our seeded agent present
    {
      const { status, body } = await getJson("/world");
      ok(status === 200, "/world 200");
      ok(Array.isArray(body.agents), "/world agents is an array");
      ok(Array.isArray(body.locks), "/world locks is an array");
      ok(Array.isArray(body.events), "/world events is an array");
      const int1 = body.agents.find((a) => a.agent_id === "int1");
      ok(!!int1, "/world includes the seeded agent int1");
      if (int1) {
        ok(typeof int1.state === "string", "agent has a state");
        ok(int1.repo_id === "intproj", "agent carries its repo_id");
        ok(typeof int1.heartbeat_age_s === "number", "agent has heartbeat_age_s");
        ok(Array.isArray(int1.transcript_tail), "agent has transcript_tail array");
      }
    }

    // /projects -> ProjectView[] grouping agents by repo
    {
      const { status, body } = await getJson("/projects");
      ok(status === 200, "/projects 200");
      ok(Array.isArray(body), "/projects is an array");
      const proj = body.find((p) => p.id === "intproj");
      ok(!!proj, "/projects includes intproj");
      if (proj) {
        ok(proj.name === "Integration Project", "project carries its display name");
        ok(Array.isArray(proj.agents) && proj.agents.some((a) => a.agent_id === "int1"), "project lists its agent");
      }
    }

    // /operator/missions -> { ready, missions: OperatorMission[] }
    {
      const { status, body } = await getJson("/operator/missions");
      ok(status === 200, "/operator/missions 200");
      ok(body.ready === false, "operator not ready (no MCP configured)");
      ok(Array.isArray(body.missions) && body.missions.length >= 5, "exposes >= 5 reproducible missions");
      const m = body.missions[0];
      ok(m && typeof m.id === "string" && typeof m.title === "string" && typeof m.prompt === "string", "mission has id/title/prompt");
    }

    // A 404 still returns the frozen { error } envelope.
    {
      const { status, body } = await getJson("/no/such/route");
      ok(status === 404, "unknown route -> 404");
      ok(typeof body.error === "string", "404 body is { error: string }");
    }

    // Validators are actually WIRED on live routes (not just unit-tested as pure functions). Hit real
    // routes with hostile input and assert the bound behavior + the consistent { error } envelope.
    {
      // Path-traversal / unsafe id on POST /agents/:id/prompt -> 400 { error } (validateId is mounted).
      const res = await postJson("/agents/..%2F..%2Fetc/prompt", { prompt: "hi" });
      const body = await res.json();
      ok(res.status === 400, "POST /agents/<path-traversal id>/prompt -> 400");
      ok(typeof body.error === "string", "bad-id 400 body is { error: string }");
    }
    {
      // An over-cap prompt -> 400 (validatePrompt's length bound is mounted). MAX_PROMPT_CHARS is 16 KiB;
      // 32 KiB is comfortably over so this never tracks the exact constant.
      const res = await postJson("/agents/int1/prompt", { prompt: "x".repeat(32 * 1024) });
      const body = await res.json();
      ok(res.status === 400, "POST /agents/int1/prompt with an over-cap prompt -> 400");
      ok(typeof body.error === "string", "over-cap 400 body is { error: string }");
    }
    {
      // Hostile pagination clamps rather than erroring: ?limit=-1&offset=abc -> 200 with a bounded page.
      const { status, body } = await getJson("/agents/int1/transcript?limit=-1&offset=abc");
      ok(status === 200, "GET /agents/int1/transcript?limit=-1&offset=abc -> 200 (clamped, not 500)");
      ok(Array.isArray(body.lines), "transcript page has a lines[] array");
      ok(body.limit >= 1, "limit clamped into a positive bound");
      ok(body.offset >= 0, "offset clamped to a non-negative integer");
    }

    // PR / approve / pending flow (a named charter deliverable D's HUD renders) degrades cleanly offline:
    // gh is best-effort, so these must return the documented envelope shapes, never a 500.
    {
      // /pr on a known agent with no gh/remote -> ALWAYS 200 with { opened:false, reason } (no-op pattern).
      const res = await postJson("/agents/int1/pr", {});
      const body = await res.json();
      ok(res.status === 200, "POST /agents/int1/pr -> 200 (best-effort, never a 500)");
      ok(body.agent_id === "int1" && typeof body.opened === "boolean", "pr result has { agent_id, opened }");
      if (body.opened === false) ok(typeof body.reason === "string", "no-op pr carries a reason");
    }
    {
      // /approve on a known agent -> 200 ApproveResult (status-only release; never a 500).
      const res = await postJson("/agents/int1/approve", { by: "tester" });
      const body = await res.json();
      ok(res.status === 200, "POST /agents/int1/approve -> 200");
      ok(body.agent_id === "int1" && typeof body.approved === "boolean", "approve result has { agent_id, approved }");
    }
    {
      // /approve on an unknown agent -> 404 { error } (the documented miss envelope).
      const res = await postJson("/agents/nope_does_not_exist/approve", {});
      const body = await res.json();
      ok(res.status === 404, "POST /agents/<unknown>/approve -> 404");
      ok(typeof body.error === "string", "unknown-approve 404 body is { error: string }");
    }

    // The openai-shim (/v1/chat/completions) public SSE shape — "never break" per the charter. Assert the
    // live route streams text/event-stream and terminates with [DONE]. The session spawn fails fast (the
    // missing AGENTCRAFT_CLAUDE_BIN above), so NO billable Claude turn runs — the shim's error path still
    // emits buffer words + the unconditional [DONE], giving the same wire framing with zero quota burn.
    {
      const res = await postJson("/v1/chat/completions", {
        model: "int1",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      ok(res.status === 200, "POST /v1/chat/completions -> 200");
      ok(/text\/event-stream/.test(res.headers.get("content-type") ?? ""), "shim content-type is text/event-stream");
      const text = await res.text();
      ok(/^data: /m.test(text), "shim emits `data:`-framed SSE chunks");
      ok(text.includes("data: [DONE]"), "shim terminates the stream with [DONE]");
    }

    // Teardown: graceful SIGTERM, await exit (bounded), then free the port unconditionally.
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    freePort();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  clearTimeout(watchdog); // we reached a clean verdict — disarm the wall-clock backstop
  if (failures === 0) {
    console.log("\nINTEGRATION_OK — boot -> /health + /world + /projects + /operator/missions shapes all pass; server torn down.");
    process.exit(0);
  } else {
    console.error(`\nINTEGRATION_FAIL — ${failures} assertion(s) failed.`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("integration test crashed:", e?.message ?? e);
  freePort();
  process.exit(1);
});
