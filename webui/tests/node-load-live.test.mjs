// T4: iHPC live node truth — the node-load panel probes live held nodes (cnode mynodes) instead of
// frozen submission.node fields from run records. Tests inject fetchHeldNodes + reconcileStaleHeldNodes
// stubs to avoid real SSH; nodeUsageExecutor is also stubbed so no live probing occurs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebuiServer } from "../server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE_CONFIG = path.join(repoRoot, "profiles/profiles.example.yaml");
const testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uts-node-live-")));
process.once("exit", () => {
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* OS reclaims temp */ }
});

function tmp(prefix) {
  const dir = path.join(
    testHome,
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Seed an iHPC run record with the given status and submission.node
function seedIhpc(auditDir, runId, node, profileId = "uts-ihpc-account-a", status = "running") {
  const rec = {
    run_id: runId,
    profile_id: profileId,
    platform: "uts-ihpc",
    remote_job_id: `ihpc-${runId}-1234`,
    status,
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: "2026-06-20T00:00:00.000Z",
    submission: {
      account_label: "a",
      cluster: "uts-ihpc-access",
      node,
      requested: {},
      submitted_at: "2026-06-20T00:00:00.000Z"
    },
    observed: { node, pid: 1234 },
    events: [{ at: "2026-06-20T00:00:00.000Z", kind: "adopted-external", summary: "seeded" }]
  };
  fs.writeFileSync(
    path.join(auditDir, `${runId}.json`),
    `${JSON.stringify(rec, null, 2)}\n`,
    "utf8"
  );
}

// A crafted node-usage executor: always succeeds, reports 30% GPU util
function craftedUsageExecutor() {
  return async (_program, _args) => {
    const report = {
      ok: true,
      gpus: [{ index: 0, name: "A100", utilization_gpu_percent: 30, memory_used_mb: 5000, memory_total_mb: 40960 }],
      processes: [{ pid: 1234, used_memory_mb: 4000 }],
      errors: []
    };
    return { stdout: `${JSON.stringify(report)}\n`, stderr: "", exitCode: 0, timedOut: false };
  };
}

// A stub fetchHeldNodes that returns deterministic held sets per profile
function makeFetchHeldNodes(heldByProfile, failProfiles = new Set()) {
  return async (profileId, _opts) => {
    if (failProfiles.has(profileId)) {
      return { ok: false, heldNodes: new Set(), observedAt: new Date().toISOString(), reason: `probe-failed-${profileId}` };
    }
    const nodes = heldByProfile[profileId] ?? new Set();
    return { ok: true, heldNodes: new Set(nodes), observedAt: new Date().toISOString() };
  };
}

// A spy wrapper around reconcileStaleHeldNodes
function makeReconcileSpy() {
  const spy = { calls: 0, lastArgs: null };
  const fn = async (records, deps) => {
    spy.calls++;
    spy.lastArgs = { records, deps };
    return { staled: [] };
  };
  fn.spy = spy;
  return fn;
}

async function withServer(opts, fn) {
  const server = createWebuiServer(opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const postRefresh = (base) =>
  fetch(`${base}/api/ihpc/node-usage/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).then((r) => r.json());

// ---- Test 1: live held nodes replace stale submission.node ----
test("node set = live held nodes, NOT stale submission.node from run records", async () => {
  const auditDir = tmp("runs");
  const nodeUsageDir = tmp("node-usage");

  // Records say venus6+mars15 (liyou) — those are the stale frozen nodes
  seedIhpc(auditDir, "run-venus6", "venus6", "uts-ihpc-account-a");
  seedIhpc(auditDir, "run-mars15", "mars15", "uts-ihpc-account-a");

  // But held nodes say mars11+venus2 (the real ones)
  const fetchHeldNodes = makeFetchHeldNodes({
    "uts-ihpc-account-a": ["mars11", "venus2"]
  });
  const reconcileSpy = makeReconcileSpy();

  await withServer({
    auditDir,
    nodeUsageDir,
    configPath: EXAMPLE_CONFIG,
    nodeUsageExecutor: craftedUsageExecutor(),
    fetchHeldNodes,
    reconcileStaleHeldNodes: reconcileSpy
  }, async (base) => {
    const refreshed = await postRefresh(base);
    assert.equal(refreshed.ok, true, "refresh should succeed");

    const probedNodes = refreshed.nodes.map((n) => n.node).sort();
    assert.deepEqual(probedNodes, ["mars11", "venus2"], "snapshot nodes = live held nodes, NOT venus6/mars15");

    // Confirm venus6/mars15 are NOT in the snapshot
    assert.ok(!refreshed.nodes.some((n) => n.node === "venus6"), "venus6 (stale) must NOT be probed");
    assert.ok(!refreshed.nodes.some((n) => n.node === "mars15"), "mars15 (stale) must NOT be probed");
  });
});

// ---- Test 2: held_no_run flag ----
test("held node with no active run record has held_no_run=true; one that does has held_no_run=false", async () => {
  const auditDir = tmp("runs");
  const nodeUsageDir = tmp("node-usage");

  // mars11 = live run exists; venus2 = held but no run record
  seedIhpc(auditDir, "run-mars11", "mars11", "uts-ihpc-account-a");

  const fetchHeldNodes = makeFetchHeldNodes({
    "uts-ihpc-account-a": ["mars11", "venus2"]
  });
  const reconcileSpy = makeReconcileSpy();

  await withServer({
    auditDir,
    nodeUsageDir,
    configPath: EXAMPLE_CONFIG,
    nodeUsageExecutor: craftedUsageExecutor(),
    fetchHeldNodes,
    reconcileStaleHeldNodes: reconcileSpy
  }, async (base) => {
    const refreshed = await postRefresh(base);
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.node_count, 2);

    const mars11 = refreshed.nodes.find((n) => n.node === "mars11");
    const venus2 = refreshed.nodes.find((n) => n.node === "venus2");

    assert.ok(mars11, "mars11 should appear in nodes");
    assert.ok(venus2, "venus2 should appear in nodes");

    assert.equal(mars11.held_no_run, false, "mars11 has an active run record => held_no_run=false");
    assert.equal(venus2.held_no_run, true, "venus2 has NO run record => held_no_run=true");
  });
});

// ---- Test 3: fetchHeldNodes ok:false => profile_errors, no throw ----
test("fetchHeldNodes ok:false => response has profile_errors entry and call does not throw", async () => {
  const auditDir = tmp("runs");
  const nodeUsageDir = tmp("node-usage");

  // One profile fails probe, another succeeds
  seedIhpc(auditDir, "run-mars4", "mars4", "uts-ihpc-account-a");
  seedIhpc(auditDir, "run-saturn10", "saturn10", "uts-ihpc-account-b");

  const fetchHeldNodes = makeFetchHeldNodes(
    { "uts-ihpc-account-b": ["saturn10"] },
    new Set(["uts-ihpc-account-a"]) // account-a probe fails
  );
  const reconcileSpy = makeReconcileSpy();

  await withServer({
    auditDir,
    nodeUsageDir,
    configPath: EXAMPLE_CONFIG,
    nodeUsageExecutor: craftedUsageExecutor(),
    fetchHeldNodes,
    reconcileStaleHeldNodes: reconcileSpy
  }, async (base) => {
    // Must NOT throw
    const refreshed = await postRefresh(base);
    assert.equal(refreshed.ok, true, "refresh completes even with a probe failure");

    // The error surfaces in profile_errors
    assert.ok(Array.isArray(refreshed.profile_errors), "profile_errors must be an array");
    const err = refreshed.profile_errors.find((e) => e.profile_id === "uts-ihpc-account-a");
    assert.ok(err, "the failing profile appears in profile_errors");
    assert.ok(err.probe_error, "profile_errors entry has a probe_error message");
    assert.match(err.probe_error, /probe-failed-uts-ihpc-account-a/);

    // The successful profile's node IS probed
    const probedNodes = refreshed.nodes.map((n) => n.node);
    assert.ok(probedNodes.includes("saturn10"), "saturn10 (successful profile) is probed");
  });
});

// ---- Test 4: reconcileStaleHeldNodes is called exactly once per refresh ----
test("refreshNodeUsage invokes the injected reconcileStaleHeldNodes exactly once", async () => {
  const auditDir = tmp("runs");
  const nodeUsageDir = tmp("node-usage");
  seedIhpc(auditDir, "run-turing2", "turing2", "uts-ihpc-account-a");

  const fetchHeldNodes = makeFetchHeldNodes({
    "uts-ihpc-account-a": ["turing2"]
  });
  const reconcileSpy = makeReconcileSpy();

  await withServer({
    auditDir,
    nodeUsageDir,
    configPath: EXAMPLE_CONFIG,
    nodeUsageExecutor: craftedUsageExecutor(),
    fetchHeldNodes,
    reconcileStaleHeldNodes: reconcileSpy
  }, async (base) => {
    await postRefresh(base);
    assert.equal(reconcileSpy.spy.calls, 1, "reconcileStaleHeldNodes called exactly once per refresh");
  });
});

// ---- Test 5: new iHPC profile (no runs) surfaces its held nodes ----
test("an iHPC profile with zero run records still surfaces its held nodes from listProfiles union", async () => {
  const auditDir = tmp("runs"); // empty — no run records at all
  const nodeUsageDir = tmp("node-usage");

  // Both iHPC profiles from the example config have no run records, but uts-ihpc-account-b holds mars99
  const fetchHeldNodes = makeFetchHeldNodes({
    "uts-ihpc-account-a": [],
    "uts-ihpc-account-b": ["mars99"]
  });
  const reconcileSpy = makeReconcileSpy();

  await withServer({
    auditDir,
    nodeUsageDir,
    configPath: EXAMPLE_CONFIG,
    nodeUsageExecutor: craftedUsageExecutor(),
    fetchHeldNodes,
    reconcileStaleHeldNodes: reconcileSpy
  }, async (base) => {
    const refreshed = await postRefresh(base);
    assert.equal(refreshed.ok, true);
    const probedNodes = refreshed.nodes.map((n) => n.node);
    assert.ok(probedNodes.includes("mars99"), "mars99 surfaces even though no run records exist for this profile");
    const mars99 = refreshed.nodes.find((n) => n.node === "mars99");
    assert.equal(mars99.held_no_run, true, "no run exists for mars99 => held_no_run=true");
  });
});

// ---- Test 6: fetchHeldNodes is called at most once per profile per refresh ----
test("fetchHeldNodes is called at most once per profile per refresh (deduplication)", async () => {
  const auditDir = tmp("runs");
  const nodeUsageDir = tmp("node-usage");

  // Multiple runs on the same profile
  seedIhpc(auditDir, "run-1", "mars1", "uts-ihpc-account-a");
  seedIhpc(auditDir, "run-2", "mars2", "uts-ihpc-account-a");
  seedIhpc(auditDir, "run-3", "mars3", "uts-ihpc-account-a");

  let callCount = 0;
  const fetchHeldNodes = async (profileId, _opts) => {
    if (profileId === "uts-ihpc-account-a") callCount++;
    return { ok: true, heldNodes: new Set(["mars1"]), observedAt: new Date().toISOString() };
  };
  const reconcileSpy = makeReconcileSpy();

  await withServer({
    auditDir,
    nodeUsageDir,
    configPath: EXAMPLE_CONFIG,
    nodeUsageExecutor: craftedUsageExecutor(),
    fetchHeldNodes,
    reconcileStaleHeldNodes: reconcileSpy
  }, async (base) => {
    await postRefresh(base);
    assert.equal(callCount, 1, "fetchHeldNodes called at most once per profile — not once per run record");
  });
});
