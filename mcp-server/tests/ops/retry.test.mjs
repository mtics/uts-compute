import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import { planJob, buildPlanHash } from "../../dist/ops/plans/planner.js";
import { planRetryJob } from "../../dist/ops/jobs/retry.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import {
  readExample,
  tempRuntimeDir,
  writeQuotaSnapshot,
  writeResolvedHpcConfig,
  resolvedHpcWorkdir
} from "../helpers/index.mjs";

// By default the source plans against the bundled bare-alias profile, keeping a LITERAL ${USER} workdir
// (the dry-run retry.plan tests assert that literal form). Pass { resolved: true } for the LIVE-submit
// test: it plans against the resolved-user profile (user@host) so the workdir is concrete — jobs.submit
// now fails closed on an unresolved ${USER}, so the live path requires a fully-resolved source workdir.
function plannedSourceRun(status = "failed", runId = "retry-source", { resolved = false } = {}) {
  const planDir = tempRuntimeDir("test-retry-plans");
  const auditDir = tempRuntimeDir("test-retry-runs");
  const configPath = resolved ? writeResolvedHpcConfig("retry") : undefined;
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.workdir = resolved ? resolvedHpcWorkdir(runId) : `/shared/homes/\${USER}/experiments/${runId}`;
  const plan = planJob(job, { planDir, auditDir, ...(configPath ? { configPath } : {}) });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  record.status = status;
  record.updated_at = "2026-06-15T00:01:00.000Z";
  fs.writeFileSync(plan.audit_path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { plan, planDir, auditDir, configPath };
}

test("jobs.retry.plan escalates memory and walltime when escalate factors are given", () => {
  const { plan, planDir, auditDir } = plannedSourceRun("failed", "retry-esc-source");
  const { retry } = planRetryJob(
    {
      sourceRunId: "retry-esc-source",
      retryRunId: "retry-esc-target",
      reason: "OOM",
      escalate: { memory_factor: 2, walltime_factor: 1.5 }
    },
    { planDir, auditDir }
  );
  const srcRes = plan.normalized_job_spec.resources;
  const res = retry.plan.normalized_job_spec.resources;
  assert.equal(res.memory_gb, srcRes.memory_gb * 2);
  assert.equal(res.walltime, "01:30:00");
  assert.notEqual(retry.plan.plan_hash, plan.plan_hash);
});

test("jobs.retry.plan appends the declared resume flag + checkpoint path when resume is requested", () => {
  const planDir = tempRuntimeDir("retry-resume-plans");
  const auditDir = tempRuntimeDir("retry-resume-runs");
  const job = readExample("hpc-cpu.json");
  job.run_id = "retry-resume-source";
  job.workdir = `/shared/homes/\${USER}/experiments/retry-resume-source`;
  job.command = "python train.py";
  job.resumable = { checkpoint_path: "/scratch/ckpt/latest", resume_flag: "--resume-from" };
  const plan = planJob(job, { planDir, auditDir });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  record.status = "failed";
  fs.writeFileSync(plan.audit_path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const { retry } = planRetryJob(
    { sourceRunId: "retry-resume-source", retryRunId: "retry-resume-target", reason: "timeout", resume: true },
    { planDir, auditDir }
  );
  assert.match(retry.plan.normalized_job_spec.command, /python train\.py --resume-from \/scratch\/ckpt\/latest/);
  assert.notEqual(retry.plan.plan_hash, plan.plan_hash);
});

test("jobs.retry.plan rejects resume when the source declared no resumable contract", () => {
  const { planDir, auditDir } = plannedSourceRun("failed", "retry-noresume-source");
  assert.throws(
    () =>
      planRetryJob(
        { sourceRunId: "retry-noresume-source", retryRunId: "retry-noresume-target", reason: "timeout", resume: true },
        { planDir, auditDir }
      ),
    /no resumable/i
  );
});

function plannedIhpcSourceRun(status = "failed", runId = "retry-ihpc-source") {
  const planDir = tempRuntimeDir("test-retry-ihpc-plans");
  const auditDir = tempRuntimeDir("test-retry-ihpc-runs");
  const job = readExample("ihpc-background.json");
  job.run_id = runId;
  job.workdir = `/data/\${USER}/experiments/${runId}`;
  const plan = planJob(job, { planDir, auditDir });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  record.status = status;
  record.updated_at = "2026-06-15T00:01:00.000Z";
  fs.writeFileSync(plan.audit_path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { plan, planDir, auditDir };
}

test("jobs.retry.plan creates a new local retry plan from a failed run", () => {
  const source = plannedSourceRun("failed", "retry-source-failed");
  const result = planRetryJob(
    {
      sourceRunId: source.plan.run_id,
      retryRunId: "retry-next-failed",
      reason: "fixed dependency module"
    },
    {
      planDir: source.planDir,
      auditDir: source.auditDir
    }
  ).retry;

  assert.equal(result.mode, "dry-run");
  assert.equal(result.source_run_id, "retry-source-failed");
  assert.equal(result.source_status, "failed");
  assert.equal(result.retry_run_id, "retry-next-failed");
  assert.equal(result.plan.run_id, "retry-next-failed");
  assert.equal(result.plan.normalized_job_spec.workdir, "/shared/homes/${USER}/experiments/retry-next-failed");
  assert.equal(result.plan.approval.required, true);
  assert.equal(result.plan.approval_operation, "jobs.retry");
  assert.equal(result.plan.retry_of.source_run_id, "retry-source-failed");
  assert.equal(result.plan.retry_of.source_status, "failed");
  assert.equal(result.plan.retry_of.source_plan_hash, source.plan.plan_hash);
  assert.ok(result.plan.approval.reasons.some((reason) => reason.includes("Retry of run retry-source-failed")));
  assert.ok(result.plan.approval.reasons.some((reason) => reason.includes("fixed dependency module")));
  assert.equal(
    result.plan.plan_hash,
    buildPlanHash(result.plan.normalized_job_spec, result.plan.template, result.plan.script, {
      approvalOperation: result.plan.approval_operation,
      retryOf: result.plan.retry_of
    })
  );
  assert.equal(fs.existsSync(result.plan.plan_path), true);

  const retryRecord = JSON.parse(fs.readFileSync(result.plan.audit_path, "utf8"));
  assert.equal(retryRecord.status, "planned");
  assert.equal(retryRecord.plan_hash, result.plan.plan_hash);
  assert.deepEqual(retryRecord.retry_of, result.plan.retry_of);
  assert.equal(retryRecord.events.at(-1).kind, "retry-plan");
  assert.match(retryRecord.events.at(-1).summary, /retry-source-failed/);
});

test("jobs.retry.plan preserves iHPC supervised-start argv for retry plans", () => {
  const source = plannedIhpcSourceRun("failed", "retry-ihpc-source-failed");
  const result = planRetryJob(
    {
      sourceRunId: source.plan.run_id,
      retryRunId: "retry-ihpc-next-failed",
      reason: "interactive dependency rebuilt"
    },
    {
      planDir: source.planDir,
      auditDir: source.auditDir
    }
  ).retry;

  assert.equal(result.plan.platform, "uts-ihpc");
  assert.equal(result.plan.approval_operation, "jobs.retry");
  assert.deepEqual(result.plan.command_argv, ["python", "interactive_experiment.py", "--quick"]);
  assert.equal(result.plan.normalized_job_spec.workdir, "/data/${USER}/experiments/retry-ihpc-next-failed");
  assert.equal(result.plan.retry_of.source_run_id, "retry-ihpc-source-failed");
  assert.equal(fs.existsSync(result.plan.plan_path), true);

  const retryRecord = JSON.parse(fs.readFileSync(result.plan.audit_path, "utf8"));
  assert.equal(retryRecord.status, "planned");
  assert.deepEqual(retryRecord.retry_of, result.plan.retry_of);
});

test("jobs.retry.plan rejects non-terminal source runs and existing retry targets", () => {
  const source = plannedSourceRun("running", "retry-source-running");

  assert.throws(
    () =>
      planRetryJob(
        {
          sourceRunId: source.plan.run_id,
          retryRunId: source.plan.run_id
        },
        {
          planDir: source.planDir,
          auditDir: source.auditDir
        }
      ),
    /must differ/
  );

  assert.throws(
    () =>
      planRetryJob(
        {
          sourceRunId: source.plan.run_id,
          retryRunId: "retry-next-running"
        },
        {
          planDir: source.planDir,
          auditDir: source.auditDir
        }
      ),
    /only failed or cancelled/
  );

  const failed = plannedSourceRun("cancelled", "retry-source-existing");
  planRetryJob(
    {
      sourceRunId: failed.plan.run_id,
      retryRunId: "retry-next-existing",
      reason: "operator cancelled stale allocation"
    },
    {
      planDir: failed.planDir,
      auditDir: failed.auditDir
    }
  );
  assert.throws(
    () =>
      planRetryJob(
        {
          sourceRunId: failed.plan.run_id,
          retryRunId: "retry-next-existing"
        },
        {
          planDir: failed.planDir,
          auditDir: failed.auditDir
        }
      ),
    /already has local plan or run state/
  );
});

test("jobs.retry.plan requires an explicit reason for cancelled source runs", () => {
  const source = plannedSourceRun("cancelled", "retry-source-cancelled");

  assert.throws(
    () =>
      planRetryJob(
        {
          sourceRunId: source.plan.run_id,
          retryRunId: "retry-next-cancelled"
        },
        {
          planDir: source.planDir,
          auditDir: source.auditDir
        }
      ),
    /cancelled runs requires an explicit reason/
  );
});

test("HPC retry submission requires jobs.retry approval and consumes it", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const source = plannedSourceRun("failed", "retry-source-submit", { resolved: true });
  const approvalDir = tempRuntimeDir("test-retry-approvals");
  const retry = planRetryJob(
    {
      sourceRunId: source.plan.run_id,
      retryRunId: "retry-next-submit",
      reason: "fixed dependency token=secret-value"
    },
    {
      planDir: source.planDir,
      auditDir: source.auditDir,
      configPath: source.configPath,
      now
    }
  ).retry.plan;
  const quotaSnapshotId = "quota-retry-submit-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, retry.profile_id, retry.platform, now.toISOString());

  assert.equal(retry.retry_of.reason.includes("secret-value"), false);

  assert.throws(
    () =>
      requestApproval(
        {
          runId: retry.run_id,
          profileId: retry.profile_id,
          platform: retry.platform,
          planHash: retry.plan_hash,
          quotaSnapshotId,
          reasons: retry.approval.reasons
        },
        { approvalDir, planDir: source.planDir, now }
      ),
    /requires jobs.retry approval/
  );

  const wrongRequested = requestApproval(
    {
      runId: retry.run_id,
      profileId: retry.profile_id,
      platform: retry.platform,
      planHash: retry.plan_hash,
      quotaSnapshotId,
      reasons: retry.approval.reasons
    },
    { approvalDir, now }
  ).approval;
  const wrongApproval = decideApproval(
    {
      approvalId: wrongRequested.approval_id,
      decision: "approved",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      confirmationToken: "retry-token"
    },
    { approvalDir, now, confirmationToken: "retry-token" }
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
          configPath: source.configPath,
          now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "2222.hpc\n", stderr: "" };
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
    { approvalDir, planDir: source.planDir, now }
  ).approval;
  const retryApproval = decideApproval(
    {
      approvalId: retryRequested.approval_id,
      decision: "approved",
      planHash: retry.plan_hash,
      quotaSnapshotId,
      confirmationToken: "retry-token"
    },
    { approvalDir, now, confirmationToken: "retry-token" }
  ).approval;
  const submitted = await submitJob(
    { runId: retry.run_id, approvalId: retryApproval.approval_id },
    {
      planDir: source.planDir,
      auditDir: source.auditDir,
      approvalDir,
      configPath: source.configPath,
      now,
      executor: async (_program, _args, _t, stdin) => {
        // The pre-qsub workdir/log_dir mkdir carries no stdin; only the qsub ships the PBS script.
        if (!stdin) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        calls += 1;
        return { exitCode: 0, stdout: "3333.hpc\n", stderr: "" };
      }
    }
  );

  assert.equal(calls, 1);
  assert.equal(submitted.submission.remote_job_id, "3333.hpc");
  const retryRecord = JSON.parse(fs.readFileSync(submitted.submission.run_record_path, "utf8"));
  assert.equal(retryRecord.status, "submitted");
  assert.equal(retryRecord.events.at(-1).kind, "live-retry-submit");
  assert.deepEqual(retryRecord.retry_of, retry.retry_of);
  const consumed = readApproval(retryApproval.approval_id, { approvalDir });
  assert.equal(consumed.consumed_by, "jobs.retry:3333.hpc");
});

test("jobs.retry.plan rejects tampered source plan hashes before writing retry state", () => {
  const source = plannedSourceRun("failed", "retry-source-tampered");
  const savedPlan = JSON.parse(fs.readFileSync(source.plan.plan_path, "utf8"));
  savedPlan.command_argv = ["unexpected"];
  savedPlan.script = `${savedPlan.script}\n# tampered\n`;
  fs.writeFileSync(source.plan.plan_path, `${JSON.stringify(savedPlan, null, 2)}\n`, "utf8");

  assert.throws(
    () =>
      planRetryJob(
        {
          sourceRunId: source.plan.run_id,
          retryRunId: "retry-next-tampered"
        },
        {
          planDir: source.planDir,
          auditDir: source.auditDir
        }
      ),
    /plan_hash does not match/
  );
  assert.equal(fs.existsSync(path.join(source.planDir, "retry-next-tampered.json")), false);
});

test("jobs.retry.plan rejects ambiguous source workdirs before writing retry state", () => {
  const source = plannedSourceRun("failed", "retry-source-ambiguous");
  const savedPlan = JSON.parse(fs.readFileSync(source.plan.plan_path, "utf8"));
  savedPlan.normalized_job_spec.workdir = "/shared/homes/${USER}/experiments/shared";
  savedPlan.script = savedPlan.script.replaceAll("retry-source-ambiguous", "shared");
  savedPlan.plan_hash = buildPlanHash(savedPlan.normalized_job_spec, savedPlan.template, savedPlan.script);
  fs.writeFileSync(source.plan.plan_path, `${JSON.stringify(savedPlan, null, 2)}\n`, "utf8");
  const sourceRecord = JSON.parse(fs.readFileSync(source.plan.audit_path, "utf8"));
  sourceRecord.plan_hash = savedPlan.plan_hash;
  fs.writeFileSync(source.plan.audit_path, `${JSON.stringify(sourceRecord, null, 2)}\n`, "utf8");

  assert.throws(
    () =>
      planRetryJob(
        {
          sourceRunId: source.plan.run_id,
          retryRunId: "retry-next-ambiguous"
        },
        {
          planDir: source.planDir,
          auditDir: source.auditDir
        }
      ),
    /workdir must end with sourceRunId/
  );
  assert.equal(fs.existsSync(path.join(source.planDir, "retry-next-ambiguous.json")), false);
});

test("plan hash covers approval_operation and retry_of so the operation class is tamper-evident", () => {
  const planDir = tempRuntimeDir("test-retry-plans");
  const auditDir = tempRuntimeDir("test-retry-runs");
  const job = readExample("hpc-cpu.json");
  job.run_id = "retry-hash-lineage";
  job.workdir = "/shared/homes/${USER}/experiments/retry-hash-lineage";
  const plan = planJob(job, { planDir, auditDir });

  const base = buildPlanHash(plan.normalized_job_spec, plan.template, plan.script);
  assert.equal(plan.plan_hash, base, "a submit plan with no lineage must hash identically to the base payload");

  const flipped = buildPlanHash(plan.normalized_job_spec, plan.template, plan.script, {
    approvalOperation: "jobs.retry",
    retryOf: {
      source_run_id: "ghost",
      source_status: "failed",
      source_plan_hash: base,
      planned_at: "2026-06-15T00:00:00.000Z"
    }
  });
  assert.notEqual(flipped, base, "folding retry lineage into the plan must change the hash");
});

test("jobs.submit rejects a plan whose retry lineage was injected without rehashing", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-retry-plans");
  const auditDir = tempRuntimeDir("test-retry-runs");
  const approvalDir = tempRuntimeDir("test-retry-approvals");
  const job = readExample("hpc-cpu.json");
  job.run_id = "retry-inject-submit";
  job.workdir = "/shared/homes/${USER}/experiments/retry-inject-submit";
  const plan = planJob(job, { planDir, auditDir, now });

  const savedPlan = JSON.parse(fs.readFileSync(plan.plan_path, "utf8"));
  savedPlan.approval_operation = "jobs.retry";
  savedPlan.retry_of = {
    source_run_id: "ghost",
    source_status: "failed",
    source_plan_hash: plan.plan_hash,
    planned_at: now.toISOString()
  };
  fs.writeFileSync(plan.plan_path, `${JSON.stringify(savedPlan, null, 2)}\n`, "utf8");
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: plan.run_id, approvalId: "approval-ghost" },
        {
          planDir,
          auditDir,
          approvalDir,
          now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "1.hpc\n", stderr: "" };
          }
        }
      ),
    /plan_hash does not match its rendered content/
  );
  assert.equal(calls, 0);
});
