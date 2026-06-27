import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { makeWithMcpClient } from "../helpers/index.mjs";

// ---------------------------------------------------------------------------------------------------
// Step 9 — table-driven tool registration pin.
//
// index.ts replaced its 38 explicit registerTool(...) calls + the separate TOOL_META map with one
// declarative TOOLS table iterated by a loop. The single most important invariant of that refactor is
// that the set of REGISTERED TOOL NAMES is byte-identical to before — no tool added, dropped, renamed,
// or duplicated. This test pins that set against the real stdio server (the exact surface MCP clients
// see), independently of the broader inventory/annotation assertions in mcp-protocol.test.mjs, so the
// table can never silently drift.
// ---------------------------------------------------------------------------------------------------

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "uts-tool-reg-"));
after(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// The exact set the prior explicit registerTool(...) calls produced was 38 distinct tools (one per
// registerTool call); (C1) adds jobs.adopt, and (M14) adds approvals.list, growing the declarative
// TOOLS table, sorted below. The iHPC scheduler internalization retired ihpc.scheduler.version +
// ihpc.scheduler.deploy (node-resident deploy model replaced by an inline-shipped progressor).
const EXPECTED_TOOL_NAMES = [
  "access.check",
  "access.confirm_usage",
  "access.doctor",
  "approvals.decide",
  "approvals.list",
  "approvals.request",
  "approvals.status",
  "artifacts.cleanup.execute",
  "artifacts.cleanup.plan",
  "artifacts.fetch",
  "artifacts.fetch.batch",
  "artifacts.list",
  "artifacts.summarize",
  "campaign.audit",
  "campaign.status",
  "campaign.submit",
  "docs.refresh",
  "docs.search",
  "ihpc.campaign.generate",
  "ihpc.campaign.preflight",
  "ihpc.node.usage",
  "jobs.adopt",
  "jobs.cancel",
  "jobs.diagnose",
  "jobs.history",
  "jobs.logs",
  "jobs.plan",
  "jobs.retry.plan",
  "jobs.rightsize",
  "jobs.status",
  "jobs.submit",
  "jobs.track",
  "jobs.usage",
  "profiles.list",
  "profiles.onboard",
  "profiles.validate",
  "projects.list",
  "quotas.capacity",
  "quotas.refresh",
  "state.migrate.apply",
  "state.migrate.plan",
  "sweep.plan",
  "sweep.rank",
  "sweep.retry.plan",
  "templates.list",
  "transfers.execute",
  "transfers.plan"
];

// Bind the shared stdio harness to this file's relocated TEST_HOME + client name.
const withMcpClient = makeWithMcpClient({ home: TEST_HOME, clientName: "uts-compute-tool-reg-test" });

test("table-driven registration produces the byte-identical tool-name set", async () => {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    // No duplicate registrations (a loop bug could double-register a name).
    assert.equal(new Set(names).size, names.length, "every registered tool name must be unique");

    // Exact set, byte-for-byte, sorted for a stable comparison.
    assert.deepEqual([...names].sort(), EXPECTED_TOOL_NAMES);

    // Originally the 38 distinct tools the explicit registerTool(...) calls registered before the
    // table-driven refactor; (C1) adds jobs.adopt, and (M14) adds approvals.list; Phase E adds
    // campaign.submit. The iHPC scheduler internalization then retired ihpc.scheduler.version +
    // ihpc.scheduler.deploy, dropping the count to 45. ihpc.node.usage (the read-only one-shot per-GPU
    // utilization probe over the canary seam) then brought it to 46; ihpc.campaign.generate (the dry-run
    // queue-YAML generator, the preflight-clean GENERATE counterpart to ihpc.campaign.preflight) brings
    // it to 47 — one table entry per tool, no collisions.
    assert.equal(names.length, EXPECTED_TOOL_NAMES.length);
    assert.equal(names.length, 47, "47 table entries map to 47 unique tool names");
  });
});

test("jobs.adopt description states the two-axis trust level (foreign=history-only, ours=lineage-proven via reconcile)", async () => {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "jobs.adopt");
    assert.ok(tool, "jobs.adopt must be registered");
    // foreign iHPC adopts are history-only / not lineage-proven...
    assert.match(tool.description, /history-only|not[- ]lineage[- ]proven|foreign/i);
    // ...and the description must point at the lineage-proven path (reconciliation), so an agent knows
    // when it gets execution authority vs. history-only.
    assert.match(tool.description, /lineage[- ]proven|reconcil/i);
  });
});

test("every registered tool keeps the shared { ok: boolean } output schema", async () => {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    for (const tool of tools.tools) {
      assert.equal(
        tool.outputSchema?.properties?.ok?.type,
        "boolean",
        `${tool.name} must keep the default TOOL_OUTPUT_SCHEMA ({ ok: boolean })`
      );
      const title = tool.title ?? tool.annotations?.title;
      assert.ok(typeof title === "string" && title.length > 0, `${tool.name} must keep a human-readable title`);
    }
  });
});
