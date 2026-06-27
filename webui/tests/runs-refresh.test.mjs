// Live status reconcile: POST /api/runs/refresh runs jobs.track (trackActiveJobs) to re-poll active runs
// over SSH and write fresh usage/status onto the records — what fills the usage columns that otherwise
// stay "—" until a run is polled. The probe is live SSH, so the test injects a crafted qstat executor;
// getProfile still resolves the run's profile from the bundled example config.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebuiServer } from "../server.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE_CONFIG = path.join(repoRoot, "profiles/profiles.example.yaml");
const testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uts-reconcile-")));
// trackActiveJobs reads records through listRunRecordIds, which enforces the runtime-containment guard
// (auditDir must live under <runtime>/.uts-computing). Point the runtime home at our temp tree and seed
// inside its .uts-computing, mirroring webui.test.mjs.
process.env.UTS_COMPUTING_HOME = testHome;
process.once("exit", () => { try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* OS reclaims */ } });

function tmp(prefix) {
  const dir = path.join(testHome, ".uts-computing", `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A crafted qstat -f executor: a running PBS job with resources_used.* so parsePbsUsage yields usage.
function qstatExecutor() {
  return async () => ({
    stdout: [
      "Job Id: 9001.cetus",
      "    job_state = R",
      "    exec_host = node07/0*8",
      "    resources_used.walltime = 02:00:00",
      "    resources_used.ncpus = 8",
      "    resources_used.cput = 12:00:00",
      "    resources_used.mem = 8388608kb",
      "    Resource_List.ncpus = 8",
      ""
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    timedOut: false
  });
}

function seedRunningHpc(auditDir, runId) {
  const rec = {
    run_id: runId, profile_id: "uts-hpc-account-a", platform: "uts-hpc",
    remote_job_id: "9001.cetus", status: "running",
    created_at: "2026-06-20T00:00:00.000Z", updated_at: "2026-06-20T00:00:00.000Z",
    submission: { account_label: "a", cluster: "c", node: "node07", requested: {}, submitted_at: "2026-06-20T00:00:00.000Z" },
    events: [{ at: "2026-06-20T00:00:00.000Z", kind: "jobs.submit", summary: "seeded running run with no usage yet" }]
  };
  fs.writeFileSync(path.join(auditDir, `${runId}.json`), `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

async function withServer(opts, fn) {
  const server = createWebuiServer(opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const postRefresh = (base) =>
  fetch(`${base}/api/runs/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());

test("POST /api/runs/refresh reconciles active runs over SSH and writes fresh usage onto the record", async () => {
  const auditDir = tmp("runs");
  seedRunningHpc(auditDir, "reconcile-hpc");
  // before: no usage on disk
  assert.equal(JSON.parse(fs.readFileSync(path.join(auditDir, "reconcile-hpc.json"), "utf8")).usage, undefined);

  await withServer({ auditDir, configPath: EXAMPLE_CONFIG, jobTrackExecutor: qstatExecutor() }, async (base) => {
    const refreshed = await postRefresh(base);
    assert.equal(refreshed.ok, true);
    assert.ok((refreshed.counts?.polled ?? 0) >= 1, "at least one active run was re-polled");

    // after: usage reconciled onto the record (8 cpus * 2h = 16 core-hours), and the API serves it
    const rec = JSON.parse(fs.readFileSync(path.join(auditDir, "reconcile-hpc.json"), "utf8"));
    assert.ok(rec.usage, "usage was written onto the record by the live reconcile");
    assert.equal(rec.usage.core_hours, 16);
    assert.equal(rec.usage.ncpus, 8);

    const runs = await fetch(`${base}/api/runs`).then((r) => r.json());
    const row = (runs.runs || []).find((x) => x.run_id === "reconcile-hpc");
    assert.equal(row.usage?.core_hours, 16, "the refreshed usage now shows in /api/runs (no longer missing)");
  });
});

test("the live reconcile controls are wired into the Runs and Explore views (default-off auto toggle)", () => {
  const app = fs.readFileSync(path.join(repoRoot, "webui/public/app.js"), "utf8");
  assert.match(app, /function liveReconcileControls\(\)/);
  assert.match(app, /function wireLiveReconcile\(reRender\)/);
  assert.match(app, /post\("\/api\/runs\/refresh"/, "the button POSTs the live reconcile");
  assert.match(app, /refreshControls\("runs"\) \+ liveReconcileControls\(\)/, "Runs header carries the control");
  assert.match(app, /header\("Explore", "Resource-fit analysis from existing run evidence", liveReconcileControls\(\)\)/, "Explore header carries the control");
  assert.match(app, /localStorage\.getItem\("uts-live-reconcile"\) === "1"/, "auto toggle persists, default off");
  // The failure toast distinguishes an unreachable LOCAL server ("Failed to fetch") from a real SSH/cluster
  // failure, instead of always blaming the VPN.
  assert.match(app, /const unreachable = \/failed to fetch\|networkerror\|load failed\|fetch failed\/i\.test\(message\)/);
  assert.match(app, /the local dashboard server isn't responding/);
  assert.doesNotMatch(app, /\$\{message\} — is the VPN up\?/, "no longer reflexively blames the VPN");
});
