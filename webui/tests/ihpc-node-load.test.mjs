// L1 iHPC node-load: the webui orchestrates the committed ihpc.node.usage probe across the nodes our
// active iHPC runs sit on, persists a snapshot, and serves it with a balance summary. The probe is live
// SSH, so these tests inject a crafted executor (no real cluster) — getProfile still resolves a real
// iHPC profile from the bundled example config.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebuiServer } from "../server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE_CONFIG = path.join(repoRoot, "profiles/profiles.example.yaml");
const testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uts-nodeload-")));
process.once("exit", () => {
  try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* OS reclaims temp */ }
});

function tmp(prefix) {
  const dir = path.join(testHome, `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A crafted NODE_USAGE_PY stub: an honest per-GPU reading, or a non-zero exit (=> node-unverifiable) for
// any node in `downNodes`. The node id appears verbatim in the inner-hop ssh argv probeNodeUsage builds.
function craftedExecutor(downNodes = new Set()) {
  return async (_program, args) => {
    if ([...downNodes].some((n) => args.includes(n))) {
      return { stdout: "", stderr: "nvidia-smi: command not found", exitCode: 1, timedOut: false };
    }
    const report = { ok: true, gpus: [{ index: 0, name: "A100-SXM4-40GB", utilization_gpu_percent: 42, memory_used_mb: 8200, memory_total_mb: 40960 }], processes: [{ pid: 1234, used_memory_mb: 7000 }], errors: [] };
    return { stdout: `${JSON.stringify(report)}\n`, stderr: "", exitCode: 0, timedOut: false };
  };
}

// A stub fetchHeldNodes: returns a deterministic held-node set per profile.
// Used by tests that must control which nodes are "currently held" without real SSH.
function makeFetchHeldNodesStub(heldByProfile) {
  return async (profileId, _opts) => {
    const nodes = heldByProfile[profileId] ?? [];
    return { ok: true, heldNodes: new Set(nodes), observedAt: new Date().toISOString() };
  };
}

// A no-op reconcileStaleHeldNodes stub: prevents the production function from attempting real SSH.
const noopReconcile = async () => ({ staled: [] });

function seedIhpc(auditDir, runId, node, status = "running") {
  const rec = {
    run_id: runId, profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
    remote_job_id: `ihpc-${runId}-1234`, status,
    created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z",
    submission: { account_label: "a", cluster: "uts-ihpc-access", node, requested: {}, submitted_at: "2026-06-20T00:00:00.000Z" },
    observed: { node, pid: 1234 },
    events: [{ at: "2026-06-20T00:00:00.000Z", kind: "adopted-external", summary: "seeded observe run" }]
  };
  fs.writeFileSync(path.join(auditDir, `${runId}.json`), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

function seedHpc(auditDir, runId) {
  const rec = {
    run_id: runId, profile_id: "uts-hpc-account-a", platform: "uts-hpc",
    remote_job_id: "3686.hpc", status: "running",
    created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z", events: []
  };
  fs.writeFileSync(path.join(auditDir, `${runId}.json`), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
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

const postRefresh = (base) => fetch(`${base}/api/ihpc/node-usage/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
const getUsage = (base) => fetch(`${base}/api/ihpc/node-usage`).then((r) => r.json());

test("refresh probes only ACTIVE iHPC nodes, persists an ok snapshot, and serves it with a balance summary", async () => {
  const auditDir = tmp("runs");
  const nodeUsageDir = tmp("node-usage");
  seedIhpc(auditDir, "run-mars6", "mars6");
  seedIhpc(auditDir, "run-mars7", "mars7");
  seedIhpc(auditDir, "run-terminal", "mars8", "finished"); // terminal => not probed
  seedHpc(auditDir, "run-hpc"); // wrong platform => not probed

  // Inject fetchHeldNodes stub: the live held-node set for uts-ihpc-account-a is mars6+mars7 (same
  // as the run records say, but now sourced from cnode mynodes rather than frozen submission.node).
  // mars8 is NOT in the held set (already released after finishing).
  const fetchHeldNodes = makeFetchHeldNodesStub({ "uts-ihpc-account-a": ["mars6", "mars7"] });

  await withServer({ auditDir, nodeUsageDir, configPath: EXAMPLE_CONFIG, nodeUsageExecutor: craftedExecutor(), fetchHeldNodes, reconcileStaleHeldNodes: noopReconcile }, async (base) => {
    const refreshed = await postRefresh(base);
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.node_count, 2, "only the two live held iHPC nodes are probed");
    const probedNodes = refreshed.nodes.map((n) => n.node).sort();
    assert.deepEqual(probedNodes, ["mars6", "mars7"]);
    for (const n of refreshed.nodes) {
      assert.equal(n.status, "ok");
      assert.equal(n.gpus.length, 1);
      assert.equal(n.gpus[0].utilization_gpu_percent, 42);
      assert.deepEqual(n.processes, [{ pid: 1234, used_memory_mb: 7000 }], "L2: per-PID GPU memory flows into the snapshot");
    }
    assert.equal(refreshed.balance.max_util, 42);
    assert.equal(refreshed.balance.util_spread, 0);
    assert.deepEqual(refreshed.balance.idle_nodes, []);

    // the snapshot is persisted, and GET serves it back with freshness
    assert.ok(fs.existsSync(path.join(nodeUsageDir, "latest.json")), "snapshot persisted");
    const got = await getUsage(base);
    assert.equal(got.available, true);
    assert.equal(got.node_count, 2);
    assert.equal(typeof got.age_minutes, "number");
    assert.ok(got.age_minutes >= 0);
  });
});

test("an unreadable node is reported node-unverifiable (empty gpus, never counted as idle)", async () => {
  const auditDir = tmp("runs");
  const nodeUsageDir = tmp("node-usage");
  seedIhpc(auditDir, "run-saturn9", "saturn9");

  // Inject fetchHeldNodes stub: saturn9 is currently held by uts-ihpc-account-a
  const fetchHeldNodes = makeFetchHeldNodesStub({ "uts-ihpc-account-a": ["saturn9"] });

  await withServer({ auditDir, nodeUsageDir, configPath: EXAMPLE_CONFIG, nodeUsageExecutor: craftedExecutor(new Set(["saturn9"])), fetchHeldNodes, reconcileStaleHeldNodes: noopReconcile }, async (base) => {
    const refreshed = await postRefresh(base);
    assert.equal(refreshed.node_count, 1);
    const node = refreshed.nodes[0];
    assert.equal(node.status, "node-unverifiable");
    assert.deepEqual(node.gpus, []);
    assert.match(node.reason, /nvidia-smi|probe/i);
    assert.equal(refreshed.balance.unverifiable_count, 1);
    assert.equal(refreshed.balance.verifiable_count, 0);
    assert.equal(refreshed.balance.max_util, null);
    assert.deepEqual(refreshed.balance.idle_nodes, [], "an unreadable node is NOT idle — honesty over a fake 0%");
  });
});

test("GET node-usage before any refresh reports unavailable, not an error", async () => {
  await withServer({ auditDir: tmp("runs"), nodeUsageDir: tmp("node-usage"), configPath: EXAMPLE_CONFIG }, async (base) => {
    const got = await getUsage(base);
    assert.equal(got.ok, true);
    assert.equal(got.available, false);
    assert.deepEqual(got.nodes, []);
  });
});

test("Node load is folded into the Runs view (section + redirect route + live-probe refresh)", () => {
  const app = fs.readFileSync(path.join(repoRoot, "webui/public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(repoRoot, "webui/public/index.html"), "utf8");
  // No longer a standalone page: no nav tab, no dedicated page renderer; the route redirects to Runs.
  assert.doesNotMatch(html, /data-nav-link="node-load"/);
  assert.doesNotMatch(app, /async function renderNodeLoad\(\)/);
  assert.ok(app.includes("[/^\\/node-load$/, () => navigateTo(\"/runs\", routeQuery(), { replace: true })]"));
  // Rendered as a section of Runs (after the project glance), wired to re-render Runs on a live probe.
  assert.match(app, /class="card runs-node-load w-100"/);
  assert.match(app, /nodeLoadBody\(nodeUsage \|\| \{ available: false \}\)/);
  assert.match(app, /if \(showNodeLoad\) wireNodeLoadRefresh\(renderRunsList\)/);
  assert.match(app, /\/api\/ihpc\/node-usage\/refresh/);
});

test("the static node-load assets serve over HTTP (module import + nav resolve)", async () => {
  await withServer({ auditDir: tmp("runs"), nodeUsageDir: tmp("node-usage"), configPath: EXAMPLE_CONFIG }, async (base) => {
    const sem = await fetch(`${base}/run-semantics.js`);
    assert.equal(sem.status, 200, "run-semantics.js module is served");
    assert.match(sem.headers.get("content-type") || "", /javascript/);
    const index = await fetch(`${base}/`).then((r) => r.text());
    // Node load folded into Runs — the nav exposes Runs, not a standalone node-load tab.
    assert.doesNotMatch(index, /data-nav-link="node-load"/);
    assert.match(index, /data-nav-link="runs"/);
  });
});

test("L2: the run detail wires a per-run node-hardware panel for adopted iHPC runs", () => {
  const app = fs.readFileSync(path.join(repoRoot, "webui/public/app.js"), "utf8");
  assert.match(app, /function nodeHardwarePanel\(run, nodeUsage\)/);
  assert.match(app, /\+ nodeHardwarePanel\(run, context\.nodeUsage\) \+/, "the overview composes the panel");
  assert.match(app, /run\.platform === "uts-ihpc" && runIsAdopted\(run\)/, "adopted iHPC runs fetch the node snapshot");
  assert.match(app, /\(entry\.processes \|\| \[\]\)\.find\(\(p\) => p\.pid === pid\)/, "L2: the panel attributes GPU memory to the run's observed pid");
  assert.match(app, /Per-process attribution is by GPU memory/, "per-PID memory is shown (utilization stays node-level)");
});
