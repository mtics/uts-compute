import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval } from "../../dist/ops/approvals/approvals.js";
import { trackActiveJobs } from "../../dist/ops/jobs/jobs.js";
import { adoptExternalRun } from "../../dist/ops/jobs/adopt.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { projectHashFor } from "../../dist/ops/profiles/project.js";
import { readRunRecord } from "../../dist/core/audit.js";
import { readExample, tempRuntimeDir, writeQuotaSnapshot } from "../helpers/index.mjs";

const SEED_NOW = new Date("2026-06-15T00:00:00.000Z");

function sharedDirs(prefix) {
  return {
    planDir: tempRuntimeDir(`${prefix}-plans`),
    auditDir: tempRuntimeDir(`${prefix}-runs`),
    approvalDir: tempRuntimeDir(`${prefix}-approvals`)
  };
}

function planFor(runId, planDir, auditDir) {
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.workdir = `/shared/homes/\${USER}/experiments/${runId}`;
  return planJob(job, { planDir, auditDir });
}

// Seed one fully-submitted PBS run (status "submitted", remote_job_id = jobId) into the shared dirs.
async function seedSubmittedRun({ runId, jobId, planDir, auditDir, approvalDir }) {
  const plan = planFor(runId, planDir, auditDir);
  const quotaSnapshotId = `quota-${runId}`;
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, SEED_NOW.toISOString());
  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      operation: "jobs.submit",
      planHash: plan.plan_hash,
      quotaSnapshotId
    },
    { approvalDir, now: SEED_NOW }
  ).approval;
  decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      confirmationToken: "ops-token"
    },
    { approvalDir, now: SEED_NOW, confirmationToken: "ops-token" }
  );
  // jobs.track (the subject under test here) only needs a "submitted" run record with a remote_job_id.
  // We transition the planned record directly rather than driving the live submit: the bundled bare-alias
  // profile keeps a LITERAL ${USER} workdir, which jobs.submit now (correctly) FAILS CLOSED on for a live
  // submit — and the submit path is not what this suite exercises.
  const recordPath = path.join(auditDir, `${plan.run_id}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.status = "submitted";
  record.remote_job_id = jobId;
  record.plan_hash = plan.plan_hash;
  record.quota_snapshot_id = quotaSnapshotId;
  record.updated_at = SEED_NOW.toISOString();
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return plan;
}

const runningQstat = async () => ({ exitCode: 0, stdout: "Job Id: x\n    job_state = R\n", stderr: "" });

function setProject(auditDir, runId, project) {
  const recordPath = path.join(auditDir, `${runId}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.project = project;
  record.project_hash = projectHashFor(project);
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

test("jobs.track polls every active run and reconciles each persisted record", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk1");
  await seedSubmittedRun({ runId: "trk1-a", jobId: "1001.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk1-b", jobId: "1002.hpc", planDir, auditDir, approvalDir });

  const polled = [];
  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (_program, args) => {
        polled.push(args.at(-1));
        return runningQstat();
      }
    }
  );

  assert.equal(result.tracking.counts.polled, 2);
  assert.equal(result.tracking.counts.transitioned, 2);
  assert.equal(result.tracking.counts.errors, 0);
  assert.equal(
    result.tracking.tracked.every((entry) => entry.status === "running" && entry.previous_status === "submitted"),
    true
  );
  assert.deepEqual(polled.sort(), ["1001.hpc", "1002.hpc"]);
  for (const runId of ["trk1-a", "trk1-b"]) {
    const record = JSON.parse(fs.readFileSync(path.join(auditDir, `${runId}.json`), "utf8"));
    assert.equal(record.status, "running");
  }
});

test("jobs.track skips terminal and planned runs without polling them", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk2");
  await seedSubmittedRun({ runId: "trk2-active", jobId: "2001.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk2-term", jobId: "2002.hpc", planDir, auditDir, approvalDir });
  planFor("trk2-planned", planDir, auditDir); // planned only — no remote_job_id

  const termPath = path.join(auditDir, "trk2-term.json");
  const term = JSON.parse(fs.readFileSync(termPath, "utf8"));
  term.status = "cancelled";
  // A terminal run that already captured usage is skipped — only terminal runs MISSING usage are backfilled.
  term.usage = { walltime_seconds: 60, ncpus: 1, ngpus: 0, core_hours: 0.02, gpu_hours: 0, cpu_efficiency_percent: 90 };
  fs.writeFileSync(termPath, `${JSON.stringify(term, null, 2)}\n`, "utf8");

  let calls = 0;
  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (_program, args) => {
        calls += 1;
        assert.equal(args.at(-1), "2001.hpc");
        return runningQstat();
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(result.tracking.counts.polled, 1);
  assert.equal(result.tracking.counts.skipped_terminal, 1);
  assert.equal(result.tracking.counts.skipped_planned, 1);
  assert.equal(result.tracking.tracked[0].run_id, "trk2-active");
});

test("jobs.track backfills usage for a terminal HPC run that never captured it (qstat -x history)", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk-backfill");
  await seedSubmittedRun({ runId: "bf-term-nousage", jobId: "7001.hpc", planDir, auditDir, approvalDir });
  const recPath = path.join(auditDir, "bf-term-nousage.json");
  const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
  rec.status = "finished"; // terminal, but no usage was ever captured
  delete rec.usage;
  fs.writeFileSync(recPath, `${JSON.stringify(rec, null, 2)}\n`, "utf8");

  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      // Live qstat -f says gone -> reconcile reads history (qstat -x -f) which carries resources_used.
      executor: async (_program, args) => {
        if (args.includes("-x")) {
          return {
            exitCode: 0,
            stdout:
              "Job Id: 7001.hpc\n    job_state = F\n    Exit_status = 0\n" +
              "    resources_used.walltime = 01:00:00\n    resources_used.ncpus = 8\n    resources_used.cput = 06:00:00\n",
            stderr: ""
          };
        }
        return { exitCode: 153, stdout: "", stderr: "qstat: 7001.hpc Job has finished, use -x or -H\n" };
      }
    }
  );

  assert.equal(result.tracking.counts.polled, 1, "the terminal-without-usage run was re-polled");
  assert.equal(result.tracking.counts.skipped_terminal, 0);
  const after = JSON.parse(fs.readFileSync(recPath, "utf8"));
  assert.ok(after.usage, "usage was backfilled onto the terminal run");
  assert.equal(after.usage.core_hours, 8, "8 cpus * 1h = 8 core-hours");
});

test("jobs.track isolates one run's failure and redacts the error", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk3");
  await seedSubmittedRun({ runId: "trk3-ok", jobId: "3001.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk3-bad", jobId: "3002.hpc", planDir, auditDir, approvalDir });

  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (_program, args) => {
        if (args.at(-1) === "3002.hpc") {
          throw new Error("ssh connection refused token=trk-secret");
        }
        return runningQstat();
      }
    }
  );

  assert.equal(result.tracking.counts.polled, 2);
  assert.equal(result.tracking.counts.errors, 1);
  const ok = result.tracking.tracked.find((entry) => entry.run_id === "trk3-ok");
  const bad = result.tracking.tracked.find((entry) => entry.run_id === "trk3-bad");
  assert.equal(ok.status, "running");
  assert.ok(bad.error);
  assert.doesNotMatch(bad.error, /trk-secret/);
  assert.match(bad.error, /<redacted>/);
  assert.equal(bad.status, "submitted");
});

test("jobs.track filters by project and reports each run's project", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk5");
  await seedSubmittedRun({ runId: "trk5-a", jobId: "5001.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk5-b", jobId: "5002.hpc", planDir, auditDir, approvalDir });
  setProject(auditDir, "trk5-a", "alpha");
  setProject(auditDir, "trk5-b", "beta");

  const polled = [];
  const result = await trackActiveJobs(
    { project: "Alpha" },
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (_program, args) => {
        polled.push(args.at(-1));
        return runningQstat();
      }
    }
  );

  assert.equal(result.tracking.counts.polled, 1);
  assert.equal(result.tracking.tracked[0].run_id, "trk5-a");
  assert.equal(result.tracking.tracked[0].project, "alpha");
  assert.deepEqual(polled, ["5001.hpc"]);
});

test("jobs.track digests runs that crossed into a terminal state this sweep", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk6");
  await seedSubmittedRun({ runId: "trk6-done", jobId: "6001.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk6-running", jobId: "6002.hpc", planDir, auditDir, approvalDir });

  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (_program, args) => {
        if (args.at(-1) === "6001.hpc") {
          return { exitCode: 0, stdout: "Job Id: x\n    job_state = F\n    Exit_status = 0\n", stderr: "" };
        }
        return runningQstat();
      }
    }
  );

  assert.equal(result.tracking.counts.newly_terminal, 1);
  assert.equal(result.tracking.terminal_transitions.length, 1);
  assert.equal(result.tracking.terminal_transitions[0].run_id, "trk6-done");
  assert.equal(result.tracking.terminal_transitions[0].status, "finished");
});

// ---------------------------------------------------------------------------------------------------
// P1 (crash-safety — reconcile the pre-launch marker). A campaign run left at the durable pre-launch
// marker (status "submitting", carries a campaign_id, no remote_job_id yet) by a mid-launch crash must be
// PICKED UP by jobs.track's campaign reconcile path (read node STATE by campaign_id), not dropped into
// the manual "needs_reconciliation" bucket. This mirrors the single-run "submitting + no remote_job_id"
// surfacing, but for campaigns we can actively reconcile against the node STATE the progressor wrote.
// ---------------------------------------------------------------------------------------------------
function seedPreLaunchCampaignMarker(auditDir, { runId, campaignId, node }) {
  const job = readExample("ihpc-background.json");
  job.run_id = runId;
  job.workdir = `/data/\${USER}/experiments/${runId}`;
  const planDir = tempRuntimeDir(`${runId}-plans`);
  planJob(job, { planDir, auditDir, campaignId });
  // Flip the planned record to the durable pre-launch marker shape the launch seam now writes BEFORE its
  // SSH side effects: "submitting" + campaign_id + placement.node_id, but no remote_job_id / supervisor.
  const recPath = path.join(auditDir, `${runId}.json`);
  const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
  rec.status = "submitting";
  rec.campaign_id = campaignId;
  rec.placement = { hostname: node, node_id: node };
  delete rec.remote_job_id;
  delete rec.supervisor;
  fs.writeFileSync(recPath, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
}

function ihpcStateJson(campaignId, { runId, status }) {
  return JSON.stringify({
    schema_version: "1.0.0",
    campaign_id: campaignId,
    queue_id: "sha256:deadbeef",
    lease_owner: { client: "claude", device_id: "local" },
    observed_at_node: "2026-06-15T00:04:00Z",
    node_clock_epoch: 1750000000,
    slot_count: 1,
    progressor: { pid: 4242, started_at_node: "2026-06-15T00:00:00Z", heartbeat_node: "2026-06-15T00:04:30Z" },
    health: { degraded: null, breaker_tripped: false },
    jobs: {
      "0": { seq: 0, run_id: runId, status, pid: 5555, wrapper_pid: 5554, gpu_index: 0, started_at_node: "2026-06-15T00:01:00Z", log: `slot_0/${runId}.log` }
    },
    counts: { pending: 0, running: 1, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  });
}

test("jobs.track reconciles a campaign run left at the pre-launch 'submitting' marker against node STATE", async () => {
  const auditDir = tempRuntimeDir("trk-prelaunch-runs");
  seedPreLaunchCampaignMarker(auditDir, { runId: "trk-prelaunch-r0", campaignId: "camp_track_brk", node: "mars001" });

  let stateReads = 0;
  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (_program, _args, _timeoutMs, stdin) => {
        // the campaign reconcile path reads the whole state.json once (IHPC_STATE_READ_PY).
        if (typeof stdin === "string" && stdin.includes("state.json")) {
          stateReads += 1;
          // the node STATE reports the job running, with a started_at_node matching the marker's evidence
          // for the anti-pid-reuse pairing (first-ever observation here, so any value is accepted).
          return { exitCode: 0, stdout: ihpcStateJson("camp_track_brk", { runId: "trk-prelaunch-r0", status: "running" }), stderr: "" };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
    }
  );

  // The pre-launch marker was actively reconciled, NOT pushed into the manual needs_reconciliation bucket.
  assert.equal(stateReads >= 1, true, "the campaign STATE was read to reconcile the pre-launch marker");
  assert.equal(result.tracking.counts.needs_reconciliation, 0, "a campaign pre-launch marker is reconcilable, not a manual-verify");
  assert.equal(result.tracking.counts.polled, 1, "the marker was polled, not skipped");
  const entry = result.tracking.tracked.find((e) => e.run_id === "trk-prelaunch-r0");
  assert.ok(entry, "the pre-launch run appears in the tracked table");
  assert.equal(entry.status, "running", "STATE-reported running advances the marker to running");
  assert.equal(entry.previous_status, "submitting");
  const persisted = readRunRecord("trk-prelaunch-r0", auditDir);
  assert.equal(persisted.status, "running", "the reconciled status is persisted to the ledger");
});

test("jobs.track caps polled runs at the limit and flags truncation", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk4");
  await seedSubmittedRun({ runId: "trk4-a", jobId: "4001.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk4-b", jobId: "4002.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk4-c", jobId: "4003.hpc", planDir, auditDir, approvalDir });

  const result = await trackActiveJobs(
    { limit: 2 },
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: runningQstat
    }
  );

  assert.equal(result.tracking.counts.polled, 2);
  assert.equal(result.tracking.truncated, true);
  assert.equal(result.tracking.tracked.length, 2);
});

test("jobs.track tags each entry with a network_hint when the whole sweep is VPN-down", async () => {
  const { NETWORK_DROP_HINT } = await import("../../dist/lib/net-errors.js");
  const { planDir, auditDir, approvalDir } = sharedDirs("trk-vpn");
  await seedSubmittedRun({ runId: "trk-vpn-a", jobId: "9001.hpc", planDir, auditDir, approvalDir });
  await seedSubmittedRun({ runId: "trk-vpn-b", jobId: "9002.hpc", planDir, auditDir, approvalDir });

  // Every poll fails with the ssh connect-timeout banner (VPN dropped mid-sweep).
  const vpnDown = async () => ({
    exitCode: 255,
    stdout: "",
    stderr: "ssh: connect to host hpc-host01 port 22: Network is unreachable\n"
  });
  const result = await trackActiveJobs(
    {},
    { auditDir, now: new Date("2026-06-15T00:05:00.000Z"), executor: vpnDown }
  );

  assert.equal(result.tracking.counts.polled, 2);
  // The indeterminate probe preserves the definite 'submitted' status (no false transition)...
  assert.equal(result.tracking.tracked.every((e) => e.status === "submitted" && !e.transitioned), true);
  // ...but each entry carries the actionable VPN hint + kind.
  for (const entry of result.tracking.tracked) {
    assert.equal(entry.error_kind, "unreachable", `entry ${entry.run_id} should be unreachable`);
    assert.equal(entry.network_hint, NETWORK_DROP_HINT, `entry ${entry.run_id} should carry the VPN hint`);
  }
  // A sweep-level signal so a caller doesn't have to scan every row.
  assert.equal(result.tracking.network_hint, NETWORK_DROP_HINT);
});

test("jobs.track sets no network_hint on a healthy sweep", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk-ok");
  await seedSubmittedRun({ runId: "trk-ok-a", jobId: "8001.hpc", planDir, auditDir, approvalDir });

  const result = await trackActiveJobs(
    {},
    { auditDir, now: new Date("2026-06-15T00:05:00.000Z"), executor: runningQstat }
  );

  assert.equal(result.tracking.network_hint, undefined);
  assert.equal(result.tracking.tracked.every((e) => e.network_hint === undefined && e.error_kind === undefined), true);
});

// ---------------------------------------------------------------------------------------------------
// P1-a — fuse live node GPU usage into jobs.track (one-call fleet status).
//
// Every active iHPC run sits on a compute node. With nodeUsage:true, jobs.track ALSO attaches that
// node's live per-GPU snapshot (probeNodeUsage) to the entry — replacing the manual per-node nvidia-smi
// step. The probe is OPT-IN (default off keeps cost/behavior), DE-DUPED per distinct node (N runs on one
// node => one probe), and FAIL-CLOSED per node (a node it cannot read => node-unverifiable, never a
// fabricated reading; one bad node never fails the whole sweep). PBS entries are unchanged.
// ---------------------------------------------------------------------------------------------------

const NOW_TRACK = new Date("2026-06-20T10:05:00.000Z");

function gpuReport(util) {
  return {
    ok: true,
    gpus: [{ index: 0, name: "Tesla T4", utilization_gpu_percent: util, memory_used_mb: 2048, memory_total_mb: 16000 }],
    errors: []
  };
}

// Seed an ACTIVE adopted/observable iHPC run (status "running", observed node+pid, no supervisor). Its
// jobs.status takes the read-only OBSERVE path (liveness + node GPU), so it is the natural fixture for
// the per-node GPU fusion in jobs.track.
async function seedAdoptedIhpcRun(auditDir, { runId, node, pid }) {
  await adoptExternalRun({ runId, profileId: "uts-ihpc-account-a", node, pid }, { auditDir, now: SEED_NOW });
}

// An executor that routes by what it is shipped: a PBS qstat (no stdin), the os.kill liveness probe, or
// the nvidia-smi GPU probe. The gpuByNode map lets the test answer per-node and COUNT probes per node.
function fleetExecutor({ gpuByNode = {}, probedNodes = [] } = {}) {
  return async (_program, args, _timeoutMs, stdin) => {
    if (typeof stdin === "string" && /os\.kill\(pid, 0\)/.test(stdin)) {
      return { exitCode: 0, stdout: `${JSON.stringify({ alive: true })}\n`, stderr: "" };
    }
    if (typeof stdin === "string" && /nvidia-smi/.test(stdin)) {
      // The compute node id is the second arg of the two-hop ssh seam: ssh <host> ssh <node> ...
      const node = args.find((a) => Object.prototype.hasOwnProperty.call(gpuByNode, a));
      probedNodes.push(node);
      const fixture = gpuByNode[node];
      if (fixture === "fail") {
        return { exitCode: 255, stdout: "", stderr: "ssh: node unreachable\n" };
      }
      return { exitCode: 0, stdout: `${JSON.stringify(fixture)}\n`, stderr: "" };
    }
    // PBS qstat — running.
    return { exitCode: 0, stdout: "Job Id: x\n    job_state = R\n", stderr: "" };
  };
}

test("jobs.track {nodeUsage:true} attaches each active iHPC run's node GPU snapshot and de-dupes shared-node probes", async () => {
  const auditDir = tempRuntimeDir("trk-gpu-runs");
  // Two runs SHARE node mars001; a third is on venus01. De-dup => mars001 is probed once, not twice.
  await seedAdoptedIhpcRun(auditDir, { runId: "trk-gpu-a", node: "mars001", pid: 31245 });
  await seedAdoptedIhpcRun(auditDir, { runId: "trk-gpu-b", node: "mars001", pid: 31246 });
  await seedAdoptedIhpcRun(auditDir, { runId: "trk-gpu-c", node: "venus01", pid: 9001 });

  const probedNodes = [];
  const result = await trackActiveJobs(
    { nodeUsage: true },
    {
      auditDir,
      now: NOW_TRACK,
      executor: fleetExecutor({
        gpuByNode: { mars001: gpuReport(42), venus01: gpuReport(7) },
        probedNodes
      })
    }
  );

  assert.equal(result.tracking.counts.polled, 3);
  const byId = Object.fromEntries(result.tracking.tracked.map((e) => [e.run_id, e]));
  // Every active iHPC entry carries its node's GPU snapshot.
  assert.equal(byId["trk-gpu-a"].gpu_usage.status, "ok");
  assert.equal(byId["trk-gpu-a"].gpu_usage.node, "mars001");
  assert.equal(byId["trk-gpu-a"].gpu_usage.gpus[0].utilization_gpu_percent, 42);
  // Runs sharing mars001 get the SAME (shared) snapshot.
  assert.deepEqual(byId["trk-gpu-b"].gpu_usage.gpus, byId["trk-gpu-a"].gpu_usage.gpus);
  assert.equal(byId["trk-gpu-c"].gpu_usage.node, "venus01");
  assert.equal(byId["trk-gpu-c"].gpu_usage.gpus[0].utilization_gpu_percent, 7);
  // DE-DUP: each distinct node probed at most once (mars001 once though two runs sit on it).
  assert.equal(probedNodes.filter((n) => n === "mars001").length, 1, "mars001 probed once for two runs");
  assert.equal(probedNodes.filter((n) => n === "venus01").length, 1);
});

test("jobs.track {nodeUsage:true} is fail-closed per node: an unreadable node is node-unverifiable and does not fail the sweep", async () => {
  const auditDir = tempRuntimeDir("trk-gpu-failclosed");
  await seedAdoptedIhpcRun(auditDir, { runId: "trk-gpu-good", node: "mars001", pid: 31245 });
  await seedAdoptedIhpcRun(auditDir, { runId: "trk-gpu-bad", node: "saturn09", pid: 4242 });

  const result = await trackActiveJobs(
    { nodeUsage: true },
    {
      auditDir,
      now: NOW_TRACK,
      executor: fleetExecutor({ gpuByNode: { mars001: gpuReport(55), saturn09: "fail" } })
    }
  );

  // One bad node never fails the whole sweep; the bad node is node-unverifiable with EMPTY gpus[].
  assert.equal(result.tracking.counts.polled, 2);
  const byId = Object.fromEntries(result.tracking.tracked.map((e) => [e.run_id, e]));
  assert.equal(byId["trk-gpu-good"].gpu_usage.status, "ok");
  assert.equal(byId["trk-gpu-bad"].gpu_usage.status, "node-unverifiable");
  assert.deepEqual(byId["trk-gpu-bad"].gpu_usage.gpus, []);
  assert.equal(byId["trk-gpu-bad"].status, "running", "the run status is unaffected by a GPU-probe failure");
});

test("jobs.track defaults nodeUsage OFF: no GPU probe runs and entries carry no gpu_usage", async () => {
  const auditDir = tempRuntimeDir("trk-gpu-default-off");
  await seedAdoptedIhpcRun(auditDir, { runId: "trk-gpu-off", node: "mars001", pid: 31245 });

  let nvidiaProbes = 0;
  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: NOW_TRACK,
      executor: async (_program, _args, _timeoutMs, stdin) => {
        if (typeof stdin === "string" && /nvidia-smi/.test(stdin)) {
          nvidiaProbes += 1;
        }
        if (typeof stdin === "string" && /os\.kill\(pid, 0\)/.test(stdin)) {
          return { exitCode: 0, stdout: `${JSON.stringify({ alive: true })}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "Job Id: x\n    job_state = R\n", stderr: "" };
      }
    }
  );

  assert.equal(nvidiaProbes, 0, "no GPU probe when nodeUsage is off");
  assert.equal(result.tracking.tracked.every((e) => e.gpu_usage === undefined), true);
});

test("jobs.track {nodeUsage:true} leaves PBS entries unchanged (no gpu_usage)", async () => {
  const { planDir, auditDir, approvalDir } = sharedDirs("trk-gpu-pbs");
  await seedSubmittedRun({ runId: "trk-gpu-pbs-a", jobId: "7001.hpc", planDir, auditDir, approvalDir });

  let nvidiaProbes = 0;
  const result = await trackActiveJobs(
    { nodeUsage: true },
    {
      auditDir,
      now: NOW_TRACK,
      executor: async (_program, _args, _timeoutMs, stdin) => {
        if (typeof stdin === "string" && /nvidia-smi/.test(stdin)) {
          nvidiaProbes += 1;
        }
        return { exitCode: 0, stdout: "Job Id: x\n    job_state = R\n", stderr: "" };
      }
    }
  );

  assert.equal(nvidiaProbes, 0, "a PBS run has no compute node to GPU-probe");
  assert.equal(result.tracking.tracked[0].platform, "uts-hpc");
  assert.equal(result.tracking.tracked[0].gpu_usage, undefined);
});
