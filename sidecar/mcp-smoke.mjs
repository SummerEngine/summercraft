/**
 * MCP call smoke (Track A / Brain). Proves a REAL Aiven-MCP call executing a lock claim against real
 * Postgres: connect an MCP client to the local Aiven-MCP stand-in, call the `claim_file` tool twice on the
 * same file (contention) — first agent wins, second is blocked — and verify the lock row in Postgres.
 *
 * Run (with mcp-aiven-local.mjs already listening + AIVEN_PG_URI set):
 *   AIVEN_PG_URI='postgres://postgres:summercraft@localhost:5433/summercraft' node mcp-smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";

const URL_ = process.env.MCP_URL || "http://127.0.0.1:8765/mcp";
const REPO = "/mcp-smoke";
const FILE = "contended.ts";
let failures = 0;
const ok = (c, l) => (c ? console.log("  ✓ " + l) : (console.error("  ✗ " + l), failures++));

async function callClaim(client, agent) {
  const r = await client.callTool({
    name: "claim_file",
    arguments: { agent_id: agent, repo_path: REPO, file_path: FILE },
  });
  return JSON.parse(r.content[0].text).got_lock;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.AIVEN_PG_URI, ssl: false });
  await pool.query("DELETE FROM world_state.file_locks WHERE repo_path=$1", [REPO]).catch(() => {});
  await pool.query("DELETE FROM world_state.agents WHERE agent_id = ANY($1)", [["mcp_a", "mcp_b"]]).catch(() => {});

  const client = new Client({ name: "mcp-smoke", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_)));
  console.log("connected to MCP server");

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  ok(names.includes("claim_file"), "MCP exposes claim_file (got: " + names.join(",") + ")");

  // The real Aiven-MCP call executing a lock claim — agent A wins, agent B contends + is blocked.
  const aWon = await callClaim(client, "mcp_a");
  ok(aWon === true, "MCP call: mcp_a claims the file (got_lock=true)");
  const bWon = await callClaim(client, "mcp_b");
  ok(bWon === false, "MCP call: mcp_b is blocked on the same file (got_lock=false)");

  // Verify the authoritative lock row landed in real Postgres via the MCP write.
  const { rows } = await pool.query(
    "SELECT holder_agent_id FROM world_state.file_locks WHERE repo_path=$1 AND file_path=$2",
    [REPO, FILE],
  );
  ok(rows.length === 1 && rows[0].holder_agent_id === "mcp_a", "Postgres shows the lock held by mcp_a (via MCP)");

  // Release via the MCP, then B can take it — full lifecycle through the MCP.
  await client.callTool({ name: "release_file", arguments: { agent_id: "mcp_a", repo_path: REPO, file_path: FILE } });
  const bAfter = await callClaim(client, "mcp_b");
  ok(bAfter === true, "MCP call: after release, mcp_b claims the freed file");

  await pool.query("DELETE FROM world_state.file_locks WHERE repo_path=$1", [REPO]).catch(() => {});
  await pool.query("DELETE FROM world_state.agents WHERE agent_id = ANY($1)", [["mcp_a", "mcp_b"]]).catch(() => {});
  await client.close();
  await pool.end();
}

main()
  .catch((e) => {
    console.error("mcp-smoke crashed:", e?.message ?? e);
    failures++;
  })
  .finally(() => {
    if (failures === 0) {
      console.log("\nMCP_SMOKE_OK — a real MCP call executed a lock claim (+ contention + release) on real Postgres.");
      process.exit(0);
    } else {
      console.error(`\nMCP_SMOKE_FAIL — ${failures} assertion(s) failed.`);
      process.exit(1);
    }
  });
