import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval } from "../../dist/ops/approvals/approvals.js";
import { getJobStatus, parseQstatStatus, trackActiveJobs } from "../../dist/ops/jobs/jobs.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { readExample, tempRuntimeDir, writeQuotaSnapshot } from "../helpers/index.mjs";

// P0 audit reliability: (1) an INDETERMINATE 'unknown' probe must never overwrite a DEFINITE ledger
// state, and (2) a running PBS ARRAY job reports job_state = B, which must map to 'running'.

const SEED_NOW = new Date("2026-06-15T00:00:00.000Z");

// Seed one fully-submitted PBS run (status "submitted", remote_job_id = jobId) into shared dirs.
async function seedSubmittedRun(runId, jobId) {
  const planDir = tempRuntimeDir("rel-plans");
  const auditDir = tempRuntimeDir("rel-runs");
  const approvalDir = tempRuntimeDir("rel-approvals");
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.workdir = `/shared/homes/\${USER}/experiments/${runId}`;
  const plan = planJob(job, { planDir, auditDir });
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
  // The reconcile-reliability subject is the status/track ledger logic, not submission. We transition the
  // planned record straight to "submitted" rather than driving the live submit: the bundled bare-alias
  // profile keeps a LITERAL ${USER} workdir, which jobs.submit now (correctly) FAILS CLOSED on for a live
  // submit. This still yields exactly the "submitted" + remote_job_id record these tests reconcile.
  const recordPath = path.join(auditDir, `${plan.run_id}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.status = "submitted";
  record.remote_job_id = jobId;
  record.plan_hash = plan.plan_hash;
  record.quota_snapshot_id = quotaSnapshotId;
  record.updated_at = SEED_NOW.toISOString();
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { plan, planDir, auditDir, approvalDir };
}

// Force the on-disk record into 'running' (a DEFINITE state) before the failing-probe poll.
function forceStatus(auditDir, runId, status) {
  const recordPath = path.join(auditDir, `${runId}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.status = status;
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

// ---- Defect #2: PBS Pro array job_state = B -> running (unit) ----

test("parseQstatStatus maps PBS array begun-state B to running", () => {
  const parsed = parseQstatStatus("Job Id: 3852[].hpc-head01\n    job_state = B\n", "", 0, false);
  assert.equal(parsed.status, "running");
  assert.equal(parsed.schedulerState, "B");
});

// ---- Defect #2 end-to-end: array remote_job_id drives qstat -f -> -x -f and is shell-quoted ----

test("jobs.status reconciles an array remote_job_id, falling back to qstat -x and quoting the bracketed id", async () => {
  const arrayId = "3852[].hpc-head01";
  const { plan, auditDir } = await seedSubmittedRun("rel-array", arrayId);
  const argvCalls = [];
  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:30:00.000Z"),
      executor: async (_program, args) => {
        argvCalls.push(args);
        // qstat -f errors for a job that has left the live queue; the reconcile must fall back to -x.
        if (args.includes("-x")) {
          return { exitCode: 0, stdout: "Job Id: 3852[].hpc-head01\n    job_state = F\n    Exit_status = 0\n", stderr: "" };
        }
        return { exitCode: 153, stdout: "", stderr: "qstat: 3852[].hpc-head01 Job has finished, use -x or -H\n" };
      }
    }
  );

  assert.equal(result.status.status, "finished");
  assert.equal(result.status.scheduler_state, "F");
  assert.equal(argvCalls.length, 2, "the -f probe must fall back to the history read");
  // The bracketed array id must be single-quoted through sshJobArgs so the remote shell does not glob it.
  assert.equal(argvCalls[0].at(-1), "'3852[].hpc-head01'", "qstat -f receives the shell-quoted array id");
  // Array jobs use `qstat -x -t -f` so the history read expands sub-jobs (the array parent carries no usage).
  assert.deepEqual(argvCalls[1].slice(-4), ["-x", "-t", "-f", "'3852[].hpc-head01'"], "the array history probe is qstat -x -t -f <id>");

  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "finished");
});

// ---- Defect #1: an indeterminate probe must NOT overwrite a definite ledger status ----

test("jobs.status: a timed-out probe does not overwrite a running record with unknown", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-timeout", "7001.hpc");
  forceStatus(auditDir, plan.run_id, "running");

  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true })
    }
  );

  assert.equal(result.status.status, "running", "the definite running status must survive an indeterminate probe");
  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "running", "the ledger must not be regressed to unknown");
  const failEvent = record.events.find((e) => e.kind === "observation_failed");
  assert.ok(failEvent, "the failed observation must be recorded as evidence");
  assert.match(failEvent.summary, /timed out/i);
});

test("jobs.status: a nonzero-exit qstat does not overwrite a running record with unknown", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-nonzero", "7002.hpc");
  forceStatus(auditDir, plan.run_id, "running");

  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({ exitCode: 7, stdout: "", stderr: "qstat: transient cluster error token=node-secret\n" })
    }
  );

  assert.equal(result.status.status, "running", "a transient nonzero qstat must not regress the ledger");
  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "running");
  const failEvent = record.events.find((e) => e.kind === "observation_failed");
  assert.ok(failEvent, "the failed observation must be recorded as evidence");
  assert.doesNotMatch(JSON.stringify(record.events), /node-secret/, "the probe error must be redacted in the event");
});

test("jobs.track: a failed probe leaves the run 'running' and surfaces the failed observation", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-track", "7003.hpc");
  forceStatus(auditDir, plan.run_id, "running");

  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true })
    }
  );

  const entry = result.tracking.tracked.find((e) => e.run_id === plan.run_id);
  assert.equal(entry.status, "running", "track must not flip a running run to unknown on a failed probe");
  assert.equal(entry.transitioned, false);
  const record = JSON.parse(fs.readFileSync(path.join(auditDir, `${plan.run_id}.json`), "utf8"));
  assert.equal(record.status, "running");
  assert.ok(record.events.find((e) => e.kind === "observation_failed"));
});

// ---- STRONG history fallback: an instant-fail job that is GONE from the live queue must reach 'failed' ----
//
// Real CETUS incident: a bad-command PBS job instant-fails and vanishes from the live queue in seconds.
// `qstat -f <id>` then returns a BARE "Unknown Job Id" error (NOT the "use -x / -H / finished" wording the
// old narrow regex keyed on). The reconcile must still consult PBS history once (`qstat -x -f <id>`), where
// the terminal record shows job_state = F + nonzero Exit_status, so the run reliably lands 'failed' and
// jobs.retry.plan can adopt it.

test("jobs.status: a GONE-from-queue 'Unknown Job Id' on live qstat -f consults history and lands failed", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-instantfail", "9100.hpc");
  const argvCalls = [];
  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:10:00.000Z"),
      executor: async (_program, args) => {
        argvCalls.push(args);
        if (args.includes("-x")) {
          // PBS history: the instant-fail job exited nonzero -> F + Exit_status != 0.
          return { exitCode: 0, stdout: "Job Id: 9100.hpc\n    job_state = F\n    Exit_status = 127\n", stderr: "" };
        }
        // Bare "Unknown Job Id" — the job already left the live queue. This DOES NOT match the old
        // /finished|use -x|-H\b/ trigger, so against old code the -x fallback never fired and the run
        // stayed 'submitted'/'unknown'.
        return { exitCode: 153, stdout: "", stderr: "qstat: Unknown Job Id 9100.hpc\n" };
      }
    }
  );

  assert.equal(result.status.status, "failed", "the instant-fail job must reach 'failed' via the history query");
  assert.equal(result.status.scheduler_state, "F");
  assert.equal(argvCalls.length, 2, "the bare 'Unknown Job Id' live probe must fall back to qstat -x -f");
  assert.deepEqual(argvCalls[1].slice(-3), ["-x", "-f", "9100.hpc"], "the history probe is qstat -x -f <id>");
  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "failed", "the ledger must record the terminal failed state");
});

// ---- Fail-closed: a TIMEOUT must NOT be treated as 'gone' (no history query, run stays put) ----

test("jobs.status: a timed-out live qstat -f does NOT trigger the history query and keeps 'running'", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-timeout-nofallback", "9200.hpc");
  forceStatus(auditDir, plan.run_id, "running");
  const argvCalls = [];
  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:10:00.000Z"),
      executor: async (_program, args) => {
        argvCalls.push(args);
        // A timeout is indeterminate: the job may well be running. Never treat it as gone.
        return { exitCode: null, stdout: "", stderr: "", timedOut: true };
      }
    }
  );

  assert.equal(argvCalls.length, 1, "a timeout must NOT fall back to the history query");
  assert.ok(!argvCalls.some((c) => c.includes("-x")), "qstat -x must never run after a timeout");
  assert.equal(result.status.status, "running", "a timeout must not mark a definite running run terminal");
  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "running");
  assert.ok(record.events.find((e) => e.kind === "observation_failed"), "the failed probe is logged, not a regression");
});

// ---- Fail-closed: an SSH transport/auth error must NOT be treated as 'gone' ----

test("jobs.status: an SSH transport error (exit 255) does NOT trigger the history query", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-transport-nofallback", "9300.hpc");
  forceStatus(auditDir, plan.run_id, "running");
  const argvCalls = [];
  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:10:00.000Z"),
      executor: async (_program, args) => {
        argvCalls.push(args);
        // ssh itself failed to connect — qstat never ran, so the queue says nothing. Not 'gone'.
        return { exitCode: 255, stdout: "", stderr: "ssh: connect to host port 22: Connection refused\n" };
      }
    }
  );

  assert.equal(argvCalls.length, 1, "a transport error must NOT fall back to the history query");
  assert.ok(!argvCalls.some((c) => c.includes("-x")), "qstat -x must never run after an SSH transport error");
  assert.equal(result.status.status, "running", "a transport error must not mark a definite running run terminal");
  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "running");
});

// ---- Fall-through: history that ALSO returns unknown leaves the T2 guard intact ----

test("jobs.status: when history (-x) also returns unknown, a definite running record is preserved", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-history-unknown", "9400.hpc");
  forceStatus(auditDir, plan.run_id, "running");
  const argvCalls = [];
  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:10:00.000Z"),
      executor: async (_program, args) => {
        argvCalls.push(args);
        // Both the live and the history query miss the job — fall through to the T2 unknown-preservation.
        return { exitCode: 153, stdout: "", stderr: "qstat: Unknown Job Id 9400.hpc\n" };
      }
    }
  );

  assert.equal(argvCalls.length, 2, "the live probe still attempts history once");
  assert.ok(argvCalls[1].includes("-x"), "the history query was attempted");
  assert.equal(result.status.status, "running", "with no terminal evidence, the definite running status survives");
  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "running");
  assert.ok(record.events.find((e) => e.kind === "observation_failed"), "the indeterminate observation is logged");
});

// ---- Guard: a first-ever 'unknown' (no prior definite state) is still allowed to land ----

test("jobs.status: an unknown observation on a still-submitting record (no definite prior) may persist", async () => {
  const { plan, auditDir } = await seedSubmittedRun("rel-firstunknown", "7004.hpc");
  // A 'submitting' record has no definite running/submitted state to protect.
  forceStatus(auditDir, plan.run_id, "submitting");

  const result = await getJobStatus(
    { runId: plan.run_id },
    {
      auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({ exitCode: 1, stdout: "", stderr: "qstat: unknown job\n" })
    }
  );

  assert.equal(result.status.status, "unknown", "an indeterminate observation may land when there is no definite prior state");
  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.status, "unknown");
});
