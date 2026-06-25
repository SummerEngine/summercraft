/**
 * Test-only boot harness for the integration test (test/integration.mjs spawns this).
 *
 * It assembles the sidecar from the SAME real boot pieces server.ts uses — seedProjects() + the real
 * http/router + the WS server — but listens on a TEST port (argv[2]) instead of the frozen 8787 in
 * contract.ts, so the integration test never collides with a real sidecar and never has to edit the
 * frozen contract. This exercises the real route handlers (/health, /world, /projects, /operator/missions)
 * against real seeded records.
 *
 * It is intentionally minimal: no Aiven (left unconfigured -> local seeded records ARE the world), no auth
 * probe spawn, no fake-status timer. The parent kills it; it also self-arms a hard watchdog so a wedged
 * boot can never outlive the test (defense-in-depth against the "no long blocking command" rule).
 */
import http from "node:http";

import { store } from "../session-store.ts";
import { seedProjects } from "../projects.ts";
import { createRouter } from "../http/router.ts";
import { attachWebSocket } from "../http/ws.ts";

const PORT = Number(process.argv[2] || 0);

// Hard watchdog: even if something wedges, this process exits well under the test's 60s budget.
const watchdog = setTimeout(() => {
  console.error("[boot-for-test] watchdog fired — exiting");
  process.exit(3);
}, 45_000);
watchdog.unref();

async function main(): Promise<void> {
  await store.whenReady();
  await seedProjects(); // populates /world + /projects with the configured agents

  const server = http.createServer(createRouter());
  attachWebSocket(server, "test-token");

  server.on("error", (e) => {
    console.error("[boot-for-test] server error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });

  server.listen(PORT, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : PORT;
    // Sentinel the parent waits for, carrying the actual bound port.
    console.log(`BOOT_READY ${port}`);
  });

  const shutdown = () => {
    clearTimeout(watchdog);
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch((e) => {
  console.error("[boot-for-test] boot failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
