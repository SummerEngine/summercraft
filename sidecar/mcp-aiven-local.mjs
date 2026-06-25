/**
 * Local Aiven-MCP stand-in (Track A / Brain). A minimal, WRITABLE Streamable-HTTP MCP server exposing the
 * subset of real-Aiven-MCP tools the demo path needs — `claim_file`, `release_file`, and the SQL tools
 * `aiven_pg_read` / `aiven_pg_write` (real-Aiven tool names) — backed by Postgres. It proves the
 * agent → MCP → data-infra path on real infra; the real Aiven MCP is the same protocol at a different URL,
 * and additionally serves the Kafka/service-control tools (aiven_kafka_*, aiven_service_*) that this shim
 * does NOT — point AGENTCRAFT_AIVEN_MCP_URL at the hosted Aiven MCP for those. Stateless (a fresh transport
 * per request), JSON responses.
 *
 * Run:  AIVEN_PG_URI='postgres://postgres:summercraft@localhost:5433/summercraft' node mcp-aiven-local.mjs
 * Endpoint: POST http://127.0.0.1:${MCP_PORT|8765}/mcp
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import pg from "pg";

const PORT = Number(process.env.MCP_PORT || 8765);
// Match the sidecar's pg.ts SSL handling: strip sslmode (so pg can't force verify-full and reject
// Aiven's private CA) and use encrypt-without-verify for real Aiven, plaintext for loopback.
const _RAW = process.env.AIVEN_PG_URI || "";
const _LOCAL = /@(localhost|127\.0\.0\.1)/.test(_RAW) || process.env.AGENTCRAFT_PG_NO_SSL === "1";
const _CS = _RAW.replace(/([?&])sslmode=[a-z0-9-]+/i, "$1").replace(/[?&]$/, "");
const pool = new pg.Pool({ connectionString: _CS, ssl: _LOCAL ? false : { rejectUnauthorized: false }, max: 4 });

function buildServer() {
  const server = new McpServer({ name: "aiven-local", version: "0.0.1" });

  server.registerTool(
    "claim_file",
    {
      description:
        "Claim a file lock — the authoritative coordination primitive (read-before-write CAS). Returns { got_lock }.",
      inputSchema: { agent_id: z.string(), repo_path: z.string(), file_path: z.string() },
    },
    async ({ agent_id, repo_path, file_path }) => {
      const { rows } = await pool.query("SELECT world_state.claim_file($1,$2,$3) AS got_lock", [
        agent_id,
        repo_path,
        file_path,
      ]);
      return { content: [{ type: "text", text: JSON.stringify({ got_lock: rows[0].got_lock }) }] };
    },
  );

  server.registerTool(
    "release_file",
    {
      description: "Release a file lock you hold.",
      inputSchema: { agent_id: z.string(), repo_path: z.string(), file_path: z.string() },
    },
    async ({ agent_id, repo_path, file_path }) => {
      await pool.query("SELECT world_state.release_file($1,$2,$3)", [agent_id, repo_path, file_path]);
      return { content: [{ type: "text", text: JSON.stringify({ released: true }) }] };
    },
  );

  server.registerTool(
    "aiven_pg_read",
    { description: "Run a read-only SQL query against the Aiven Postgres (matches the real Aiven MCP tool name).", inputSchema: { query: z.string() } },
    async ({ query }) => {
      const { rows } = await pool.query(query);
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  );

  // aiven_pg_write — direct mutating SQL (matches the real Aiven MCP tool name). Makes the deploy_pgvector
  // mission real against the local shim too (CREATE EXTENSION / CREATE TABLE / similarity query): without
  // this, Ada was told the tool exists but the shim didn't register it, so the mission could only improvise.
  // Same pool as read; pg returns rowCount for non-SELECT and rows for RETURNING/SELECT, so we surface both.
  server.registerTool(
    "aiven_pg_write",
    { description: "Run a mutating SQL statement (DDL/DML) against the Aiven Postgres (matches the real Aiven MCP tool name).", inputSchema: { query: z.string() } },
    async ({ query }) => {
      const res = await pool.query(query);
      return {
        content: [
          { type: "text", text: JSON.stringify({ rowCount: res.rowCount ?? 0, rows: res.rows ?? [] }) },
        ],
      };
    },
  );

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && (req.url === "/mcp" || req.url === "/")) {
    try {
      let body = "";
      for await (const c of req) body += c;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      const server = buildServer();
      await server.connect(transport);
      res.on("close", () => transport.close());
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[mcp-aiven-local] listening on http://127.0.0.1:${PORT}/mcp`);
});
