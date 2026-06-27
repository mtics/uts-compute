import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import { cancelJob, getJobLogs, getJobStatus } from "../../dist/ops/jobs/jobs.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import { readExample, tempRuntimeDir, runtimeRoot } from "../helpers/index.mjs";

// iHPC-specific quota snapshot: hardcodes uts-ihpc platform and carries node_families/sessions
// summary blocks that the shared writeQuotaSnapshot fixture does not — kept inline by design.
function writeIhpcQuotaSnapshot(snapshotId, profileId, observedAt) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${snapshotId}.json`),
    `${JSON.stringify(
      {
        snapshot_id: snapshotId,
        profile_id: profileId,
        platform: "uts-ihpc",
        observed_at: observedAt,
        source: "quotas.refresh",
        freshness: "fresh",
        summary: {
          identity: {
            remote_user_observed: true
          },
          node_families: {
            observed: true,
            available_families: ["mars"],
            all_families: ["mars", "mercury"]
          },
          sessions: {
            observed: true,
            active_session_count: 1,
            active_nodes: [{ node: "mars001", family: "mars" }]
          }
        },
        commands: [],
        warnings: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function approvedIhpcPlan(runId) {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const approvalDir = tempRuntimeDir("test-approvals");
  const job = readExample("ihpc-background.json");
  job.run_id = runId;
  job.workdir = `/data/\${USER}/experiments/${runId}`;
  const plan = planJob(job, { planDir, auditDir });
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  writeIhpcQuotaSnapshot(quotaSnapshotId, plan.profile_id, now.toISOString());
  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      operation: "jobs.submit",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      reasons: plan.approval.reasons,
      commandSummary: plan.normalized_job_spec.command,
      resourceSummary: plan.normalized_job_spec.resources
    },
    { approvalDir, now }
  ).approval;
  const approval = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      confirmationToken: "ihpc-token"
    },
    { approvalDir, now, confirmationToken: "ihpc-token" }
  ).approval;
  return { plan, approval, planDir, auditDir, approvalDir, quotaSnapshotId, now };
}

async function runningIhpcRun(runId) {
  const fixture = approvedIhpcPlan(runId);
  // The iHPC supervised start now requires a CONSUME-TIME-FRESH quotaSnapshotId for the ban-critical
  // node-pool gate even on the approval path (the approval's bound snapshot may be up to 24h stale).
  // The fixture's snapshot is observed at `now` (fresh) and the approval binding stays on it, so
  // re-supplying it as the gate evidence is the conforming case.
  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      now: fixture.now,
      executor: async (program, args, timeoutMs, stdin) => {
        assert.equal(program, "ssh");
        assert.equal(timeoutMs, 10000);
        assert.equal(args.at(-7), "ssh");
        assert.equal(args.at(-6), "-o");
        assert.equal(args.at(-5), "StrictHostKeyChecking=accept-new");
        assert.equal(args.at(-4), "mars001");
        assert.equal(args.at(-3), "python3");
        assert.equal(args.at(-2), "-");
        assert.match(stdin, /subprocess\.Popen/);
        return {
          exitCode: 0,
          stdout:
            '{"pid":9876,"metadata_path":"/data/alice/experiments/' +
            runId +
            "/logs/" +
            runId +
            '.supervisor.json","stdout_path":"/data/alice/experiments/' +
            runId +
            "/logs/" +
            runId +
            '.out","stderr_path":"/data/alice/experiments/' +
            runId +
            "/logs/" +
            runId +
            '.err"}\n',
          stderr: ""
        };
      }
    }
  );
  return { ...fixture, submission: result.submission };
}

function approvedIhpcCancel(fixture, now = fixture.now) {
  const requested = requestApproval(
    {
      runId: fixture.plan.run_id,
      profileId: fixture.plan.profile_id,
      platform: fixture.plan.platform,
      operation: "jobs.cancel",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      reasons: ["User requested explicit iHPC cancellation"],
      commandSummary: `cancel supervised run ${fixture.plan.run_id}`
    },
    { approvalDir: fixture.approvalDir, now }
  ).approval;
  return decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      confirmationToken: "ihpc-token"
    },
    { approvalDir: fixture.approvalDir, now, confirmationToken: "ihpc-token" }
  ).approval;
}

test("jobs.status checks an iHPC supervisor through the fixed nested Python adapter", async () => {
  const fixture = await runningIhpcRun("ops-ihpc-status");
  const calls = [];
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (program, args, timeoutMs, stdin) => {
        calls.push({ program, args, timeoutMs, stdin });
        assert.equal(program, "ssh");
        assert.equal(args.at(-7), "ssh");
        assert.equal(args.at(-6), "-o");
        assert.equal(args.at(-5), "StrictHostKeyChecking=accept-new");
        assert.equal(args.at(-4), "mars001");
        assert.equal(args.at(-3), "python3");
        assert.equal(args.at(-2), "-");
        assert.match(stdin, /os\.kill\(pid, 0\)/);
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.deepEqual(spec, { pid: 9876 });
        return { exitCode: 0, stdout: '{"alive":true}\n', stderr: "" };
      }
    }
  );

  assert.equal(result.status.status, "running");
  assert.equal(result.status.command.args.includes("uts-ihpc-access"), false);
  assert.equal(result.status.command.args.includes("mars001"), false);
  assert.equal(result.status.command.remote_argv.join(" "), "ssh <ihpc-compute-node> python3 - <supervisor-spec>");
  assert.equal(calls.length, 1);

  const runRecord = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(runRecord.events.at(-1).kind, "ihpc-status");
  assert.equal(runRecord.events.at(-1).artifact_path, result.status.evidence_path);
});

test("jobs.status maps a stopped iHPC supervisor to finished", async () => {
  const fixture = await runningIhpcRun("ops-ihpc-finished");
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({ exitCode: 0, stdout: '{"alive":false}\n', stderr: "" })
    }
  );

  assert.equal(result.status.status, "finished");
  const runRecord = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(runRecord.status, "finished");
});

test("jobs.logs reads only persisted iHPC supervisor log paths with a byte bound", async () => {
  const fixture = await runningIhpcRun("ops-ihpc-logs");
  const result = await getJobLogs(
    { runId: fixture.plan.run_id, stream: "stdout", maxBytes: 64 },
    {
      auditDir: fixture.auditDir,
      now: new Date("2026-06-15T00:06:00.000Z"),
      executor: async (program, args, timeoutMs, stdin) => {
        assert.equal(program, "ssh");
        assert.match(stdin, /getsize/);
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.equal(spec.max_bytes, 64);
        assert.deepEqual(spec.streams, [
          {
            stream: "stdout",
            path: "/data/${USER}/experiments/ops-ihpc-logs/logs/ops-ihpc-logs.out"
          }
        ]);
        return {
          exitCode: 0,
          stdout:
            '{"streams":[{"stream":"stdout","status":"passed","content":"epoch=1 token=secret-value\\n","truncated":false,"summary":"stdout log tail completed"}]}\n',
          stderr: ""
        };
      }
    }
  );

  assert.equal(result.logs.streams.length, 1);
  assert.equal(result.logs.streams[0].stream, "stdout");
  assert.equal(result.logs.streams[0].content.includes("secret-value"), false);
  assert.equal(result.logs.streams[0].path.includes("${USER}"), false);
  assert.equal(result.logs.streams[0].command.remote_argv.at(-1), "<supervisor-spec>");

  const runRecord = JSON.parse(fs.readFileSync(result.logs.run_record_path, "utf8"));
  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.events.at(-1).kind, "ihpc-logs");
});

test("jobs.cancel terminates an iHPC process group only after a jobs.cancel approval", async () => {
  const fixture = await runningIhpcRun("ops-ihpc-cancel");
  const cancelApproval = approvedIhpcCancel(fixture);
  const calls = [];
  const result = await cancelJob(
    { runId: fixture.plan.run_id, approvalId: cancelApproval.approval_id },
    {
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      now: new Date("2026-06-15T00:07:00.000Z"),
      executor: async (program, args, timeoutMs, stdin) => {
        calls.push({ program, args, timeoutMs, stdin });
        assert.equal(program, "ssh");
        assert.match(stdin, /os\.killpg\(pid, signal\.SIGTERM\)/);
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.deepEqual(spec, { pid: 9876 });
        return { exitCode: 0, stdout: '{"result":"cancelled"}\n', stderr: "" };
      }
    }
  );

  assert.equal(result.cancellation.status, "cancelled");
  assert.equal(result.cancellation.command.args.includes("uts-ihpc-access"), false);
  assert.equal(result.cancellation.command.args.includes("mars001"), false);
  assert.equal(calls.length, 1);

  const runRecord = JSON.parse(fs.readFileSync(result.cancellation.run_record_path, "utf8"));
  assert.equal(runRecord.status, "cancelled");
  assert.equal(runRecord.events.at(-1).kind, "ihpc-live-cancel");

  const consumed = readApproval(cancelApproval.approval_id, { approvalDir: fixture.approvalDir });
  assert.ok(consumed.used_at);
  assert.equal(consumed.consumed_by, "jobs.cancel:ihpc-ops-ihpc-cancel-9876");
});

test("jobs.cancel rejects an iHPC submit approval before command execution", async () => {
  const fixture = await runningIhpcRun("ops-ihpc-cancel-wrong-approval");
  let calls = 0;

  await assert.rejects(
    () =>
      cancelJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
        {
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /not jobs.cancel/
  );
  assert.equal(calls, 0);
});

test("iHPC job operations reject missing supervisor metadata before command execution", async () => {
  const fixture = await runningIhpcRun("ops-ihpc-missing-supervisor");
  const runRecordPath = fixture.submission.run_record_path;
  const runRecord = JSON.parse(fs.readFileSync(runRecordPath, "utf8"));
  delete runRecord.supervisor;
  fs.writeFileSync(runRecordPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
  let calls = 0;

  await assert.rejects(
    () =>
      getJobStatus(
        { runId: fixture.plan.run_id },
        {
          auditDir: fixture.auditDir,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /supervisor metadata/
  );
  assert.equal(calls, 0);
});
