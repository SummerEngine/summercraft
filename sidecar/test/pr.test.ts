/**
 * Unit tests — the PR / approve / pending gate (pr.ts), offline.
 *
 * README §5 + the master plan call out the PR/approve/pending flow D's HUD renders; the charter lists it
 * as a named deliverable. The contract D depends on is: these never throw and never return a non-2xx
 * envelope — opening a PR with no gh / no remote is a clean { opened:false, reason } no-op, and the gate
 * events (pending/awaiting_approval/approved) carry a stable shape. We pin the parts that need no gh and
 * no live worktree (the unknown-agent + degrade paths), which is exactly the "gh is best-effort" guarantee:
 *   - openPr(unknown) -> opened:false with the documented PrResult shape (never throws),
 *   - approveAgent(unknown) -> ok:false / approved:false (the route maps this to 404),
 *   - markPending / markAwaiting on an unknown agent are safe no-ops (never throw).
 *
 * We use a throwaway agent id that can't exist in the store, so no gh/git/worktree is ever touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { store } from "../session-store.ts";
import { openPr, approveAgent, markPending, markAwaiting } from "../pr.ts";

const MISSING = "pr_test_missing_" + Date.now();

test("openPr on an unknown agent degrades to a clean { opened:false } PrResult (never throws)", async () => {
  await store.whenReady();
  assert.equal(store.get(MISSING), undefined, "precondition: the agent must not exist");

  const r = await openPr(MISSING);
  // Documented no-op shape the HTTP route returns as 200; the client branches on `opened`.
  assert.equal(r.agent_id, MISSING);
  assert.equal(r.opened, false);
  assert.equal(r.url, null);
  assert.equal(r.branch, null);
  assert.equal(typeof r.reason, "string");
  assert.match(r.reason!, /unknown agent/);
});

test("approveAgent on an unknown agent returns ok:false / approved:false (route -> 404)", async () => {
  const r = await approveAgent(MISSING, "stan");
  assert.equal(r.agent_id, MISSING);
  assert.equal(r.ok, false);
  assert.equal(r.approved, false);
  // `by` echoes back even on the miss so the HUD can attribute the attempt.
  assert.equal(r.by, "stan");
});

test("markPending / markAwaiting on an unknown agent are safe no-ops (never throw)", async () => {
  // Both early-return when store.get() is empty — calling them must not throw or publish a bogus event.
  assert.doesNotThrow(() => markPending(MISSING, "needs review"));
  await assert.doesNotReject(() => markAwaiting(MISSING, "https://example/pr/1", "summary"));
});
