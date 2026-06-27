import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { planJob, buildPlanHash } from "../../dist/ops/plans/planner.js";
import { writePlanArtifact } from "../../dist/ops/plans/plan-store.js";
import { approvalStatus, decideApproval, requestApproval } from "../../dist/ops/approvals/approvals.js";
import { assertApprovalRecord } from "../../dist/core/validation.js";
import { readExample, writeQuotaSnapshot, runtimeRoot } from "../helpers/index.mjs";

function tempApprovalDir() {
  const dir = path.join(runtimeRoot, `test-approvals-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function tempPlanDir() {
  const dir = path.join(runtimeRoot, `test-plans-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("jobs.plan computes a deterministic plan_hash and writes it to run records", () => {
  const job = readExample("hpc-cpu.json");
  const reorderedJob = {
    command: job.command,
    resources: { ...job.resources },
    experiment: { ...job.experiment },
    platform: job.platform,
    profile_id: job.profile_id,
    run_id: job.run_id,
    outputs: [...job.outputs],
    inputs: [...job.inputs],
    workdir: job.workdir
  };

  const plan = planJob(job, { auditDir: tempApprovalDir() });
  const repeated = planJob(reorderedJob, { writeAudit: false });
  const changed = planJob({ ...job, command: `${job.command} --lr 0.01` }, { writeAudit: false });

  assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);
  assert.equal(repeated.plan_hash, plan.plan_hash);
  assert.notEqual(changed.plan_hash, plan.plan_hash);

  const runRecord = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  assert.equal(runRecord.plan_hash, plan.plan_hash);
  assert.equal(runRecord.approval.state, "not_required");
  assert.equal(runRecord.approval.bound_plan_hash, plan.plan_hash);
});

test("jobs.plan records approval-required reasons deterministically", () => {
  const plan = planJob(readExample("hpc-gpu.json"), { writeAudit: false });

  assert.equal(plan.approval.required, true);
  assert.deepEqual([...plan.approval.reasons].sort(), plan.approval.reasons);
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("GPU resource request")));
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("Restricted or special queue: gpuq")));
});

test("approval state machine requests status and approves with a trusted token", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const quotaSnapshotId = "quota-approval-happy-2026-06-15T00-00-00-000Z";
  const plan = planJob(readExample("hpc-gpu.json"), { writeAudit: false });
  const approvalDir = tempApprovalDir();
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());

  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId,
      reasons: plan.approval.reasons,
      commandSummary: plan.normalized_job_spec.command,
      resourceSummary: plan.normalized_job_spec.resources
    },
    { approvalDir, now, confirmationToken: "test-confirm" }
  ).approval;
  const repeated = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId,
      reasons: plan.approval.reasons
    },
    { approvalDir, now }
  ).approval;

  assert.equal(repeated.approval_id, requested.approval_id);
  assert.equal(requested.state, "required");
  assert.equal(requested.quota_snapshot_id, quotaSnapshotId);
  assert.ok(requested.reasons.some((reason) => reason.includes("Live compute action")));

  const status = approvalStatus({ approvalId: requested.approval_id }, { approvalDir, now }).approval;
  assert.equal(status.state, "required");

  assert.throws(
    () =>
      decideApproval(
        {
          approvalId: requested.approval_id,
          decision: "approved",
          planHash: plan.plan_hash,
          quotaSnapshotId,
          confirmationToken: "wrong"
        },
        { approvalDir, now, confirmationToken: "test-confirm" }
      ),
    /Invalid approval confirmation token/
  );

  const approved = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      decidedBy: "user",
      reason: "approved in test",
      confirmationToken: "test-confirm"
    },
    { approvalDir, now, confirmationToken: "test-confirm" }
  ).approval;
  assert.equal(approved.state, "approved");
  assert.equal(approved.plan_hash, plan.plan_hash);
  assert.equal(approved.quota_snapshot_id, quotaSnapshotId);
});

test("requestApproval validates run_id with the canonical grammar (runId rule unified across modules)", () => {
  // The approval path routes run_id through the canonical assertSafeRunId, so an unsafe id that other
  // modules reject can't slip in here. The grammar admits mixed-case, underscores, and dots (real
  // campaign names like MMPFedRec_Cards_lr0.001_mainhpo validate), but still rejects shell
  // metacharacters: "Run;1" (semicolon) is refused. runId is checked first, so the dummy remaining
  // fields never matter.
  assert.throws(
    () =>
      requestApproval(
        {
          runId: "Run;1",
          profileId: "uts-hpc-account-a",
          platform: "uts-hpc",
          planHash: "a".repeat(64),
          quotaSnapshotId: "quota-x-2026-06-15T00-00-00-000Z",
          reasons: []
        },
        { approvalDir: tempApprovalDir() }
      ),
    /Unsafe runId: Run;1/
  );
});

test("approval requests add operation-specific and profile-switch reasons", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const job = readExample("hpc-gpu.json");
  job.run_id = "approval-profile-switch";
  job.profile_id = "uts-hpc-account-b";
  job.workdir = "/shared/homes/${USER}/experiments/approval-profile-switch";
  const planDir = tempPlanDir();
  const plan = planJob(job, { planDir, writeAudit: false });
  plan.approval_operation = "jobs.retry";
  plan.retry_of = {
    source_run_id: "approval-source-failed",
    source_status: "failed",
    source_plan_hash: plan.plan_hash,
    planned_at: now.toISOString(),
    reason: "Retry after environment fix"
  };
  plan.plan_hash = buildPlanHash(plan.normalized_job_spec, plan.template, plan.script, {
    approvalOperation: plan.approval_operation,
    retryOf: plan.retry_of
  });
  plan.plan_path = writePlanArtifact(plan, planDir);
  const approvalDir = tempApprovalDir();
  const quotaSnapshotId = "quota-approval-profile-switch-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());

  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      previousProfileId: "uts-hpc-account-a",
      platform: plan.platform,
      operation: "jobs.retry",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      reasons: ["Retry after environment fix"]
    },
    { approvalDir, planDir, now }
  ).approval;

  assert.equal(requested.operation, "jobs.retry");
  assert.ok(requested.reasons.some((reason) => reason.includes("Retry consumes additional compute")));
  assert.ok(requested.reasons.some((reason) => reason.includes("Cross-account profile switch: uts-hpc-account-a -> uts-hpc-account-b")));
  assert.ok(requested.reasons.some((reason) => reason.includes("GPU resource request")));
  assert.ok(requested.reasons.some((reason) => reason.includes("Restricted or special queue: gpuq")));
  assert.ok(requested.reasons.some((reason) => reason.includes("Retry after environment fix")));
  assert.equal(requested.command_summary, "python train_gpu.py --device cuda --epochs 1");
  assert.equal(requested.resource_summary.ngpus, 1);
});

test("approval request refuses to reuse an existing record for a new profile-switch context", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const plan = planJob(readExample("hpc-cpu.json"), { writeAudit: false });
  const approvalDir = tempApprovalDir();
  const quotaSnapshotId = "quota-approval-reuse-switch-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());

  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId
    },
    { approvalDir, now }
  ).approval;

  assert.throws(
    () =>
      requestApproval(
        {
          runId: plan.run_id,
          profileId: plan.profile_id,
          previousProfileId: "uts-hpc-account-b",
          platform: plan.platform,
          planHash: plan.plan_hash,
          quotaSnapshotId
        },
        { approvalDir, now }
      ),
    /profile-switch approval reason/
  );
  assert.equal(requested.reasons.some((reason) => reason.includes("Cross-account profile switch")), false);
});

test("approval request rejects stale or mismatched quota snapshots", () => {
  const now = new Date("2026-06-15T01:00:00.000Z");
  const plan = planJob(readExample("hpc-cpu.json"), { writeAudit: false });
  const staleSnapshotId = "quota-approval-stale-2026-06-15T00-00-00-000Z";
  const mismatchSnapshotId = "quota-approval-mismatch-2026-06-15T01-00-00-000Z";
  writeQuotaSnapshot(staleSnapshotId, plan.profile_id, plan.platform, "2026-06-15T00:00:00.000Z");
  writeQuotaSnapshot(mismatchSnapshotId, "uts-hpc-account-b", plan.platform, now.toISOString());

  assert.throws(
    () =>
      requestApproval(
        {
          runId: plan.run_id,
          profileId: plan.profile_id,
          platform: plan.platform,
          planHash: plan.plan_hash,
          quotaSnapshotId: staleSnapshotId
        },
        { approvalDir: tempApprovalDir(), now }
      ),
    /stale/
  );
  assert.throws(
    () =>
      requestApproval(
        {
          runId: plan.run_id,
          profileId: plan.profile_id,
          platform: plan.platform,
          planHash: plan.plan_hash,
          quotaSnapshotId: mismatchSnapshotId
        },
        { approvalDir: tempApprovalDir(), now }
      ),
    /does not match/
  );
});

test("expired and rejected approvals cannot be approved later", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const plan = planJob(readExample("hpc-cpu.json"), { writeAudit: false });
  const approvalDir = tempApprovalDir();
  const quotaSnapshotId = "quota-approval-expire-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());

  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId,
      expiresInHours: 1
    },
    { approvalDir, now }
  ).approval;
  const expired = approvalStatus(
    { approvalId: requested.approval_id },
    { approvalDir, now: new Date("2026-06-15T01:01:00.000Z") }
  ).approval;
  assert.equal(expired.state, "expired");
  assert.throws(
    () =>
      decideApproval(
        {
          approvalId: requested.approval_id,
          decision: "approved",
          planHash: plan.plan_hash,
          quotaSnapshotId,
          confirmationToken: "test-confirm"
        },
        { approvalDir, now: new Date("2026-06-15T01:01:00.000Z"), confirmationToken: "test-confirm" }
      ),
    /only required approvals/
  );

  const rejectedSnapshotId = "quota-approval-reject-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(rejectedSnapshotId, plan.profile_id, plan.platform, now.toISOString());
  const rejectedRequest = requestApproval(
    {
      runId: "approval-reject-run",
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId: rejectedSnapshotId
    },
    { approvalDir, now }
  ).approval;
  decideApproval(
    {
      approvalId: rejectedRequest.approval_id,
      decision: "rejected",
      planHash: plan.plan_hash,
      quotaSnapshotId: rejectedSnapshotId,
      confirmationToken: "test-confirm"
    },
    { approvalDir, now, confirmationToken: "test-confirm" }
  );
  assert.throws(
    () =>
      decideApproval(
        {
          approvalId: rejectedRequest.approval_id,
          decision: "approved",
          planHash: plan.plan_hash,
          quotaSnapshotId: rejectedSnapshotId,
          confirmationToken: "test-confirm"
        },
        { approvalDir, now, confirmationToken: "test-confirm" }
      ),
    /only required approvals/
  );
});

test("an approval lives its full expiry, decoupled from the snapshot's 15-min capacity TTL (P2)", () => {
  const snapshotAt = new Date("2026-06-15T00:00:00.000Z");
  const mintAt = new Date("2026-06-15T00:14:00.000Z"); // requested 14 min later — snapshot still fresh
  const plan = planJob(readExample("hpc-cpu.json"), { writeAudit: false });
  const approvalDir = tempApprovalDir();
  const quotaSnapshotId = "quota-approval-ttl-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, snapshotAt.toISOString());

  const approval = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId,
      expiresInHours: 24
    },
    { approvalDir, now: mintAt }
  ).approval;

  // expires_at is mintAt + 24h, NOT clamped to snapshotAt + 15 min.
  assert.equal(approval.expires_at, new Date(mintAt.getTime() + 24 * 60 * 60 * 1000).toISOString());

  // 31 min after mint — well past the 15-min snapshot window — the approval is still usable, so a slow
  // human reviewer can still approve it (the collision the field report hit).
  const decideAt = new Date("2026-06-15T00:45:00.000Z");
  assert.equal(
    approvalStatus({ approvalId: approval.approval_id }, { approvalDir, now: decideAt }).approval.state,
    "required"
  );
  assert.doesNotThrow(() =>
    decideApproval(
      {
        approvalId: approval.approval_id,
        decision: "approved",
        planHash: plan.plan_hash,
        quotaSnapshotId,
        confirmationToken: "test-confirm"
      },
      { approvalDir, now: decideAt, confirmationToken: "test-confirm" }
    )
  );
});

// ---------------------------------------------------------------------------------------------------
// NIT-2 (schema invariant): the two approval shapes are MUTUALLY EXCLUSIVE on disk.
//   - planned approval      = plan_hash + quota_snapshot_id, NO remote_job_id
//   - adopted-cancel        = remote_job_id, NO plan_hash / quota_snapshot_id
// A record carrying BOTH plan_hash AND remote_job_id must be schema-INVALID. The both-fields assertion
// is RED against the old schema (which only required plan_hash/quota when remote_job_id was ABSENT, and
// otherwise left a both-fields record valid).
// ---------------------------------------------------------------------------------------------------
function approvalRecordBase(overrides = {}) {
  return {
    approval_id: "approval-nit2-run-aaaaaaaa-bbbbbbbbbbbbbbbb-cccccccccccccccc",
    run_id: "nit2-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    operation: "jobs.cancel",
    state: "required",
    reasons: ["Cancellation requires explicit approval"],
    requested_at: "2026-06-15T00:00:00.000Z",
    expires_at: "2026-06-16T00:00:00.000Z",
    warnings: ["test"],
    ...overrides
  };
}

test("NIT-2: an approval record carrying BOTH plan_hash and remote_job_id is schema-invalid", () => {
  const both = approvalRecordBase({
    operation: "jobs.cancel",
    plan_hash: "a".repeat(64),
    quota_snapshot_id: "quota-x-2026-06-15T00-00-00-000Z",
    remote_job_id: "4321.cetus"
  });
  assert.throws(() => assertApprovalRecord(both), /Invalid approval record/);

  // Even a both-fields record that omits quota (just plan_hash + remote_job_id) must be invalid.
  const bothNoQuota = approvalRecordBase({
    operation: "jobs.cancel",
    plan_hash: "a".repeat(64),
    remote_job_id: "4321.cetus"
  });
  assert.throws(() => assertApprovalRecord(bothNoQuota), /Invalid approval record/);
});

test("NIT-2: a pure adopted-cancel approval (remote_job_id only, no plan_hash/quota) stays schema-valid", () => {
  const adopted = approvalRecordBase({
    operation: "jobs.cancel",
    remote_job_id: "4321.cetus"
  });
  assert.doesNotThrow(() => assertApprovalRecord(adopted));
});

test("NIT-2: a pure planned approval (plan_hash + quota, no remote_job_id) stays schema-valid", () => {
  const planned = approvalRecordBase({
    operation: "jobs.submit",
    plan_hash: "a".repeat(64),
    quota_snapshot_id: "quota-x-2026-06-15T00-00-00-000Z"
  });
  assert.doesNotThrow(() => assertApprovalRecord(planned));
});
