import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { planRetryJob } from "../../dist/ops/jobs/retry.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import { readExample, tempRuntimeDir, runtimeRoot } from "../helpers/index.mjs";

// iHPC-specific quota snapshot with an `options` override hook — kept inline by design.
function writeIhpcQuotaSnapshot(snapshotId, profileId, observedAt, options = {}) {
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
            active_session_count: options.activeSessions ?? 1,
            active_nodes:
              options.activeSessions === 0
                ? []
                : options.activeNodes ?? [{ node: "mars001", family: "mars" }]
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

function approvedIhpcPlan(runId, options = {}) {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const approvalDir = tempRuntimeDir("test-approvals");
  const job = readExample("ihpc-background.json");
  job.run_id = runId;
  job.workdir = `/data/\${USER}/experiments/${runId}`;
  if (options.command) {
    job.command = options.command;
  }
  if (options.resources) {
    job.resources = { ...job.resources, ...options.resources };
  }
  const plan = planJob(job, { planDir, auditDir });
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  writeIhpcQuotaSnapshot(quotaSnapshotId, plan.profile_id, now.toISOString(), {
    activeSessions: options.activeSessions,
    activeNodes: options.activeNodes
  });
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

function failedIhpcSourceRun(runId) {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-ihpc-retry-plans");
  const auditDir = tempRuntimeDir("test-ihpc-retry-runs");
  const job = readExample("ihpc-background.json");
  job.run_id = runId;
  job.workdir = `/data/\${USER}/experiments/${runId}`;
  const plan = planJob(job, { planDir, auditDir });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  record.status = "failed";
  record.updated_at = "2026-06-15T00:01:00.000Z";
  fs.writeFileSync(plan.audit_path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { plan, planDir, auditDir, now };
}

test("jobs.submit starts an approved iHPC plan through the fixed Python supervisor", async () => {
  const fixture = approvedIhpcPlan("submit-ihpc-start");
  const calls = [];
  const executor = async (program, args, timeoutMs, stdin) => {
    calls.push({ program, args, timeoutMs, stdin });
    assert.equal(program, "ssh");
    assert.equal(args.at(-7), "ssh");
    assert.equal(args.at(-6), "-o");
    assert.equal(args.at(-5), "StrictHostKeyChecking=accept-new");
    assert.equal(args.at(-4), "mars001");
    assert.equal(args.at(-3), "python3");
    assert.equal(args.at(-2), "-");
    assert.doesNotMatch(args.join(" "), /bash|nohup|cnode/);
    assert.match(stdin, /subprocess\.Popen/);
    assert.match(stdin, /shell=False|start_new_session=True/);

    const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
    assert.deepEqual(spec.command_argv, ["python", "interactive_experiment.py", "--quick"]);
    assert.equal(spec.workdir, "/data/${USER}/experiments/submit-ihpc-start");
    assert.equal(spec.allowed_roots.includes("/data/${USER}/experiments"), true);
    return {
      exitCode: 0,
      stdout:
        '{"pid":9876,"metadata_path":"/data/alice/experiments/submit-ihpc-start/logs/submit-ihpc-start.supervisor.json","stdout_path":"/data/alice/experiments/submit-ihpc-start/logs/submit-ihpc-start.out","stderr_path":"/data/alice/experiments/submit-ihpc-start/logs/submit-ihpc-start.err"}\n',
      stderr: ""
    };
  };

  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      now: fixture.now,
      executor
    }
  );

  assert.equal(result.submission.platform, "uts-ihpc");
  assert.equal(result.submission.status, "running");
  assert.equal(result.submission.remote_job_id, "ihpc-submit-ihpc-start-9876");
  assert.equal(result.submission.command.remote_argv.join(" "), "ssh <ihpc-compute-node> python3 - <supervisor-spec>");
  assert.equal(result.submission.command.args.includes("uts-ihpc-access"), false);
  assert.equal(result.submission.command.args.includes("mars001"), false);
  assert.equal(result.submission.supervisor.pid, 9876);
  assert.equal(result.submission.supervisor.node_id, "mars001");
  assert.equal(result.submission.supervisor.stdout_path.includes("alice"), false);
  assert.equal(calls.length, 1);

  const runRecord = JSON.parse(fs.readFileSync(result.submission.run_record_path, "utf8"));
  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.remote_job_id, "ihpc-submit-ihpc-start-9876");
  assert.equal(runRecord.supervisor.pid, 9876);
  assert.equal(runRecord.supervisor.node_id, "mars001");
  assert.equal(runRecord.supervisor.stdout_path, "/data/${USER}/experiments/submit-ihpc-start/logs/submit-ihpc-start.out");
  assert.equal(runRecord.events.at(-1).kind, "ihpc-live-start");

  const consumed = readApproval(fixture.approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.ok(consumed.used_at);
  assert.equal(consumed.consumed_by, "jobs.submit:ihpc-submit-ihpc-start-9876");
});

test("jobs.submit starts an iHPC plan autonomously with no approval (active-cnode conformance)", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const job = readExample("ihpc-background.json");
  job.run_id = "ihpc-auto-start";
  job.workdir = "/data/${USER}/experiments/ihpc-auto-start";
  const plan = planJob(job, { planDir, auditDir, now });
  const quotaSnapshotId = "quota-ihpc-auto-start-2026-06-15T00-00-00-000Z";
  writeIhpcQuotaSnapshot(quotaSnapshotId, plan.profile_id, now.toISOString());

  let calls = 0;
  const result = await submitJob(
    { runId: plan.run_id, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      executor: async (program, args) => {
        calls += 1;
        assert.equal(program, "ssh");
        assert.equal(args.at(-4), "mars001");
        return {
          exitCode: 0,
          stdout:
            '{"pid":4242,"metadata_path":"/data/${USER}/experiments/ihpc-auto-start/logs/ihpc-auto-start.supervisor.json","stdout_path":"/data/${USER}/experiments/ihpc-auto-start/logs/ihpc-auto-start.out","stderr_path":"/data/${USER}/experiments/ihpc-auto-start/logs/ihpc-auto-start.err"}\n',
          stderr: ""
        };
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(result.submission.status, "running");
  assert.equal(result.submission.remote_job_id, "ihpc-ihpc-auto-start-4242");
  assert.equal(result.submission.approval_id, undefined);
  assert.equal(result.submission.quota_snapshot_id, quotaSnapshotId);
  const runRecord = JSON.parse(fs.readFileSync(path.join(auditDir, `${plan.run_id}.json`), "utf8"));
  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.approval.state, "not_required");
});

test("jobs.submit starts iHPC retry plans only with jobs.retry approval", async () => {
  const source = failedIhpcSourceRun("retry-ihpc-source-start");
  const approvalDir = tempRuntimeDir("test-ihpc-retry-approvals");
  const retry = planRetryJob(
    {
      sourceRunId: source.plan.run_id,
      retryRunId: "retry-ihpc-next-start",
      reason: "fixed interactive dependency"
    },
    {
      planDir: source.planDir,
      auditDir: source.auditDir,
      now: source.now
    }
  ).retry.plan;
  const quotaSnapshotId = "quota-retry-ihpc-start-2026-06-15T00-00-00-000Z";
  writeIhpcQuotaSnapshot(quotaSnapshotId, retry.profile_id, source.now.toISOString());

  assert.throws(
    () =>
      requestApproval(
        {
          runId: retry.run_id,
          profileId: retry.profile_id,
          platform: retry.platform,
          operation: "jobs.submit",
          planHash: retry.plan_hash,
          quotaSnapshotId,
          reasons: retry.approval.reasons
        },
        { approvalDir, planDir: source.planDir, now: source.now }
      ),
    /requires jobs.retry approval/
  );

  const wrongRequested = requestApproval(
    {
      runId: retry.run_id,
      profileId: retry.profile_id,
      platform: retry.platform,
      operation: "jobs.submit",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      reasons: retry.approval.reasons
    },
    { approvalDir, now: source.now }
  ).approval;
  const wrongApproval = decideApproval(
    {
      approvalId: wrongRequested.approval_id,
      decision: "approved",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      confirmationToken: "ihpc-retry-token"
    },
    { approvalDir, now: source.now, confirmationToken: "ihpc-retry-token" }
  ).approval;
  let calls = 0;
  await assert.rejects(
    () =>
      submitJob(
        { runId: retry.run_id, approvalId: wrongApproval.approval_id },
        {
          planDir: source.planDir,
          auditDir: source.auditDir,
          approvalDir,
          now: source.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /not jobs.retry/
  );
  assert.equal(calls, 0);

  const retryRequested = requestApproval(
    {
      runId: retry.run_id,
      profileId: retry.profile_id,
      platform: retry.platform,
      operation: "jobs.retry",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      reasons: retry.approval.reasons
    },
    { approvalDir, planDir: source.planDir, now: source.now }
  ).approval;
  const retryApproval = decideApproval(
    {
      approvalId: retryRequested.approval_id,
      decision: "approved",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      confirmationToken: "ihpc-retry-token"
    },
    { approvalDir, now: source.now, confirmationToken: "ihpc-retry-token" }
  ).approval;

  const result = await submitJob(
    { runId: retry.run_id, approvalId: retryApproval.approval_id, quotaSnapshotId },
    {
      planDir: source.planDir,
      auditDir: source.auditDir,
      approvalDir,
      now: source.now,
      executor: async (program, args, timeoutMs, stdin) => {
        calls += 1;
        assert.equal(program, "ssh");
        assert.equal(args.at(-7), "ssh");
        assert.equal(args.at(-6), "-o");
        assert.equal(args.at(-5), "StrictHostKeyChecking=accept-new");
        assert.equal(args.at(-4), "mars001");
        assert.equal(args.at(-3), "python3");
        assert.equal(args.at(-2), "-");
        assert.match(stdin, /subprocess\.Popen/);

        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.deepEqual(spec.command_argv, ["python", "interactive_experiment.py", "--quick"]);
        assert.equal(spec.workdir, "/data/${USER}/experiments/retry-ihpc-next-start");
        return {
          exitCode: 0,
          stdout:
            '{"pid":4321,"metadata_path":"/data/alice/experiments/retry-ihpc-next-start/logs/retry-ihpc-next-start.supervisor.json","stdout_path":"/data/alice/experiments/retry-ihpc-next-start/logs/retry-ihpc-next-start.out","stderr_path":"/data/alice/experiments/retry-ihpc-next-start/logs/retry-ihpc-next-start.err"}\n',
          stderr: ""
        };
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(result.submission.remote_job_id, "ihpc-retry-ihpc-next-start-4321");
  assert.equal(result.submission.status, "running");

  const runRecord = JSON.parse(fs.readFileSync(result.submission.run_record_path, "utf8"));
  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.events.at(-1).kind, "ihpc-live-retry-start");
  assert.deepEqual(runRecord.retry_of, retry.retry_of);

  const consumed = readApproval(retryApproval.approval_id, { approvalDir });
  assert.equal(consumed.consumed_by, "jobs.retry:ihpc-retry-ihpc-next-start-4321");
});

test("jobs.submit rejects iHPC retry plans with mismatched retry lineage before command execution", async () => {
  const source = failedIhpcSourceRun("retry-ihpc-source-mismatch");
  const approvalDir = tempRuntimeDir("test-ihpc-retry-mismatch-approvals");
  const retry = planRetryJob(
    {
      sourceRunId: source.plan.run_id,
      retryRunId: "retry-ihpc-next-mismatch",
      reason: "fixed dependency"
    },
    {
      planDir: source.planDir,
      auditDir: source.auditDir,
      now: source.now
    }
  ).retry.plan;
  const quotaSnapshotId = "quota-retry-ihpc-mismatch-2026-06-15T00-00-00-000Z";
  writeIhpcQuotaSnapshot(quotaSnapshotId, retry.profile_id, source.now.toISOString());
  const requested = requestApproval(
    {
      runId: retry.run_id,
      profileId: retry.profile_id,
      platform: retry.platform,
      operation: "jobs.retry",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      reasons: retry.approval.reasons
    },
    { approvalDir, planDir: source.planDir, now: source.now }
  ).approval;
  const approval = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      confirmationToken: "ihpc-retry-token"
    },
    { approvalDir, now: source.now, confirmationToken: "ihpc-retry-token" }
  ).approval;

  const recordPath = path.join(source.auditDir, `${retry.run_id}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.retry_of.reason = "different reason";
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  let calls = 0;
  await assert.rejects(
    () =>
      submitJob(
        { runId: retry.run_id, approvalId: approval.approval_id },
        {
          planDir: source.planDir,
          auditDir: source.auditDir,
          approvalDir,
          now: source.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /Retry lineage mismatch/
  );
  assert.equal(calls, 0);
  const stillApproved = readApproval(approval.approval_id, { approvalDir });
  assert.equal(stillApproved.used_at, undefined);
});

test("jobs.submit rejects iHPC starts when the quota snapshot has no active cnode session", async () => {
  const fixture = approvedIhpcPlan("submit-ihpc-no-session", { activeSessions: 0 });
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /active cnode session/
  );
  assert.equal(calls, 0);
});

test("jobs.plan rejects shell-style iHPC commands before live start can be approved", () => {
  assert.throws(
    () => approvedIhpcPlan("submit-ihpc-shell", { command: "bash -lc 'python interactive_experiment.py --quick'" }),
    /shell interpreters|shell operators/
  );
});

test("jobs.submit rejects legacy iHPC plan artifacts without saved command_argv", async () => {
  const fixture = approvedIhpcPlan("submit-ihpc-legacy");
  const legacyPlan = JSON.parse(fs.readFileSync(fixture.plan.plan_path, "utf8"));
  delete legacyPlan.command_argv;
  fs.writeFileSync(fixture.plan.plan_path, `${JSON.stringify(legacyPlan, null, 2)}\n`, "utf8");
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /command_argv/
  );
  assert.equal(calls, 0);
});

test("ihpc-start hard-stops a multi-GPU spec and points to the scheduler (H6/H7)", async () => {
  const fixture = approvedIhpcPlan("submit-ihpc-multigpu", { resources: { ngpus: 2 } });
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /scheduler|ihpc\.scheduler\.deploy|ihpc-sched/i
  );
  assert.equal(calls, 0);
});

test("ihpc-start hard-stops an array/sweep spec (H6/H7)", async () => {
  const fixture = approvedIhpcPlan("submit-ihpc-array", {
    resources: { ngpus: 0, array: { start: 0, end: 3 } }
  });
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /scheduler/i
  );
  assert.equal(calls, 0);
});

test("ihpc-start HARD-blocks a start that would exceed THIS account's own iHPC node-pool cap", async () => {
  // uts-ihpc-account-a's general pool {mars,mercury,venus} has limit 1. The account already holds a
  // mercury node; starting a process on a (newly-selected) mars node would put the pool at 2 > 1 —
  // exactly the over-cap condition that triggers an iHPC ban. The gate refuses BEFORE any ssh.
  const fixture = approvedIhpcPlan("submit-ihpc-pool-overflow", {
    activeNodes: [
      { node: "mars001", family: "mars" },
      { node: "mercury002", family: "mercury" }
    ]
  });
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /node-pool|node-pool conformance|node-pool cap/i
  );
  assert.equal(calls, 0);
});

test("ihpc-start allows a legitimate single-process run (ngpus=1, no array)", async () => {
  const fixture = approvedIhpcPlan("submit-ihpc-single-gpu", { resources: { ngpus: 1 } });
  let calls = 0;

  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.quotaSnapshotId },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      now: fixture.now,
      executor: async () => {
        calls += 1;
        return {
          exitCode: 0,
          stdout:
            '{"pid":5151,"metadata_path":"/data/${USER}/experiments/submit-ihpc-single-gpu/logs/submit-ihpc-single-gpu.supervisor.json","stdout_path":"/data/${USER}/experiments/submit-ihpc-single-gpu/logs/submit-ihpc-single-gpu.out","stderr_path":"/data/${USER}/experiments/submit-ihpc-single-gpu/logs/submit-ihpc-single-gpu.err"}\n',
          stderr: ""
        };
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(result.submission.status, "running");
});
