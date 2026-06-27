import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { adoptExternalRun, pbsRowToRunRecord } from "../../dist/ops/jobs/adopt.js";
import { cancelJob } from "../../dist/ops/jobs/jobs.js";
import { readRunRecord } from "../../dist/core/audit.js";
import { requestApproval, decideApproval, readApproval, consumeApproval } from "../../dist/ops/approvals/approvals.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

// Option A — make an ADOPTED bare-qsub PBS job cancellable via an approval bound to its ADOPTED IDENTITY
// (run_id + profile_id + platform + remote_job_id), NOT plan_hash. The adoption block's PRESENCE on an
// HPC record is the discriminator that unlocks the relaxed cancel; the plan_hash path for planned jobs is
// untouched, and iHPC adopted jobs stay read-only.

const QSTAT = `Job Id: 4321.cetus\n    job_state = R\n    exec_host = node07/0*4\n    resources_used.walltime = 01:00:00\n    resources_used.ncpus = 4\n`;
const NOW = new Date("2026-06-20T10:00:00.000Z");

function pbsExecutor(stdout) {
  const calls = [];
  return {
    calls,
    exec: async (program, args) => {
      calls.push({ program, args });
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    }
  };
}

// ---------------------------------------------------------------------------------------------------
// 1. pbsRowToRunRecord stamps an adoption block (PBS-appropriate provenance, no overclaimed lineage).
// ---------------------------------------------------------------------------------------------------
test("pbsRowToRunRecord stamps an adoption block: external_observed / unverified / not_lineage_proven", () => {
  const rec = pbsRowToRunRecord(QSTAT, {
    runId: "adopt-4321-cetus",
    profileId: "uts-hpc-account-a",
    platform: "uts-hpc",
    remoteJobId: "4321.cetus",
    accountLabel: "hpc-a",
    cluster: "uts-hpc",
    now: NOW
  });
  assert.ok(rec.adoption, "PBS adopt must set an adoption block");
  assert.equal(rec.adoption.terminal_record, "external_observed");
  assert.equal(rec.adoption.intent, "unverified");
  assert.equal(rec.adoption.lineage, "not_lineage_proven");
  assert.equal(rec.adoption.discovered_via, "qstat");
  assert.equal(rec.adoption.adopted_at, NOW.toISOString());
  // PBS adopt does NOT claim plugin lineage: no plan_hash, no quota_snapshot_id.
  assert.equal(rec.plan_hash, undefined);
  assert.equal(rec.quota_snapshot_id, undefined);
});

// Helper: adopt a PBS job (writes a discoverable record with an adoption block + no plan_hash).
async function adoptedPbsRun(auditDir, runId = "adopt-4321-cetus", remoteJobId = "4321.cetus") {
  const { exec } = pbsExecutor(QSTAT);
  await adoptExternalRun(
    { runId, profileId: "uts-hpc-account-a", remoteJobId },
    { auditDir, executor: exec, now: NOW }
  );
  return readRunRecord(runId, auditDir);
}

// Mint a jobs.cancel approval bound to the adopted identity + remote_job_id (no plan_hash / quota).
function approvedAdoptedCancel(approvalDir, record, overrides = {}) {
  const requested = requestApproval(
    {
      runId: overrides.runId ?? record.run_id,
      profileId: overrides.profileId ?? record.profile_id,
      platform: overrides.platform ?? record.platform,
      operation: "jobs.cancel",
      remoteJobId: overrides.remoteJobId ?? record.remote_job_id,
      reasons: ["User requested explicit cancellation of an adopted PBS job"]
    },
    { approvalDir, now: NOW }
  ).approval;
  return decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      remoteJobId: overrides.remoteJobId ?? record.remote_job_id,
      confirmationToken: "ops-token"
    },
    { approvalDir, now: NOW, confirmationToken: "ops-token" }
  ).approval;
}

// ---------------------------------------------------------------------------------------------------
// 2. Happy path: adopt -> mint approval bound to identity+remote_job_id -> cancelJob runs qdel, cancelled.
// ---------------------------------------------------------------------------------------------------
test("adopted PBS cancel: approval bound to remote_job_id authorizes qdel and lands cancelled", async () => {
  const auditDir = tempRuntimeDir("adopt-cancel-happy");
  const approvalDir = tempRuntimeDir("adopt-cancel-happy-appr");
  const record = await adoptedPbsRun(auditDir);
  assert.ok(record.adoption, "adopted record must carry an adoption block");
  assert.equal(record.plan_hash, undefined);

  const approval = approvedAdoptedCancel(approvalDir, record);
  assert.equal(approval.operation, "jobs.cancel");
  assert.equal(approval.state, "approved");
  assert.equal(approval.remote_job_id, "4321.cetus");

  const qdel = pbsExecutor("");
  const result = await cancelJob(
    { runId: record.run_id, approvalId: approval.approval_id },
    { auditDir, approvalDir, now: NOW, executor: qdel.exec }
  );
  assert.equal(result.cancellation.status, "cancelled");
  assert.equal(result.cancellation.remote_job_id, "4321.cetus");
  // qdel target confinement: the record's OWN id.
  const sentArgv = qdel.calls.at(-1).args;
  assert.ok(sentArgv.includes("qdel"), "must invoke qdel");
  assert.ok(sentArgv.some((a) => a.includes("4321.cetus")), "qdel must target the record's own remote_job_id");

  const onDisk = readRunRecord(record.run_id, auditDir);
  assert.equal(onDisk.status, "cancelled");

  // The approval is consumed (one-shot).
  const consumed = readApproval(approval.approval_id, { approvalDir });
  assert.ok(consumed.used_at, "adopted-cancel approval must be consumed after qdel");
});

// ---------------------------------------------------------------------------------------------------
// 3a. Rejection: an approval bound to a DIFFERENT remote_job_id is rejected.
// ---------------------------------------------------------------------------------------------------
test("adopted PBS cancel: approval bound to a different remote_job_id is rejected", async () => {
  const auditDir = tempRuntimeDir("adopt-cancel-wrong-id");
  const approvalDir = tempRuntimeDir("adopt-cancel-wrong-id-appr");
  const record = await adoptedPbsRun(auditDir);
  // Mint an approval bound to a DIFFERENT job id (a different account/job).
  const approval = approvedAdoptedCancel(approvalDir, record, { remoteJobId: "9999.cetus" });

  const qdel = pbsExecutor("");
  await assert.rejects(
    () =>
      cancelJob(
        { runId: record.run_id, approvalId: approval.approval_id },
        { auditDir, approvalDir, now: NOW, executor: qdel.exec }
      ),
    /remote_job_id|does not match/i
  );
  assert.equal(qdel.calls.length, 0, "qdel must not run when the approval binds a different remote_job_id");
});

// ---------------------------------------------------------------------------------------------------
// 3b. Rejection: a NON-adopted PBS record without plan_hash is STILL rejected with the existing error.
// ---------------------------------------------------------------------------------------------------
test("non-adopted PBS record without plan_hash is still rejected (relaxed path is adoption-gated, not absence-gated)", async () => {
  const auditDir = tempRuntimeDir("adopt-cancel-nonadopt");
  const approvalDir = tempRuntimeDir("adopt-cancel-nonadopt-appr");
  const record = await adoptedPbsRun(auditDir, "nonadopt-1", "5555.cetus");
  // Strip the adoption block: now it's a plain PBS record that happens to lack plan_hash.
  delete record.adoption;
  fs.writeFileSync(
    `${auditDir}/${record.run_id}.json`,
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
  const approval = approvedAdoptedCancel(approvalDir, { ...record, remote_job_id: "5555.cetus" });

  const qdel = pbsExecutor("");
  await assert.rejects(
    () =>
      cancelJob(
        { runId: record.run_id, approvalId: approval.approval_id },
        { auditDir, approvalDir, now: NOW, executor: qdel.exec }
      ),
    /plan_hash and quota_snapshot_id/
  );
  assert.equal(qdel.calls.length, 0, "qdel must not run for a non-adopted record lacking plan_hash");
});

// ---------------------------------------------------------------------------------------------------
// 3c. Rejection: an unapproved/pending approval is rejected (human approved-state requirement retained).
// ---------------------------------------------------------------------------------------------------
test("adopted PBS cancel: a pending (un-decided) approval is rejected", async () => {
  const auditDir = tempRuntimeDir("adopt-cancel-pending");
  const approvalDir = tempRuntimeDir("adopt-cancel-pending-appr");
  const record = await adoptedPbsRun(auditDir);
  const requested = requestApproval(
    {
      runId: record.run_id,
      profileId: record.profile_id,
      platform: record.platform,
      operation: "jobs.cancel",
      remoteJobId: record.remote_job_id,
      reasons: ["pending"]
    },
    { approvalDir, now: NOW }
  ).approval;
  assert.equal(requested.state, "required");

  const qdel = pbsExecutor("");
  await assert.rejects(
    () =>
      cancelJob(
        { runId: record.run_id, approvalId: requested.approval_id },
        { auditDir, approvalDir, now: NOW, executor: qdel.exec }
      ),
    /requires approved|is required/
  );
  assert.equal(qdel.calls.length, 0, "qdel must not run for a pending approval");
});

// ---------------------------------------------------------------------------------------------------
// 3d. Rejection: a cross-profile / cross-run approval is rejected.
// ---------------------------------------------------------------------------------------------------
test("adopted PBS cancel: a cross-run approval is rejected", async () => {
  const auditDir = tempRuntimeDir("adopt-cancel-crossrun");
  const approvalDir = tempRuntimeDir("adopt-cancel-crossrun-appr");
  const record = await adoptedPbsRun(auditDir);
  // Approval minted for a DIFFERENT run_id (but same remote_job_id) must not authorize this run.
  const approval = approvedAdoptedCancel(approvalDir, record, { runId: "some-other-run" });

  const qdel = pbsExecutor("");
  await assert.rejects(
    () =>
      cancelJob(
        { runId: record.run_id, approvalId: approval.approval_id },
        { auditDir, approvalDir, now: NOW, executor: qdel.exec }
      ),
    /identity|does not match/i
  );
  assert.equal(qdel.calls.length, 0, "qdel must not run for a cross-run approval");
});

// ---------------------------------------------------------------------------------------------------
// NIT-1 (defense-in-depth): consumeApproval is FAIL-CLOSED on the adopted-cancel remote_job_id binding.
// An approval carrying a remote_job_id REQUIRES the consume call to pass a matching remoteJobId — the
// binding check must be UNCONDITIONAL (like plan_hash / quota_snapshot_id for the planned path), not
// guarded behind `input.remoteJobId !== undefined`. The undefined-case assertion is RED against the old
// code, which skipped the binding when no remoteJobId was supplied.
// ---------------------------------------------------------------------------------------------------
test("NIT-1: consumeApproval throws when an adopted-cancel approval is consumed WITHOUT a remoteJobId (fail-closed)", () => {
  const auditDir = tempRuntimeDir("adopt-cancel-consume-missing");
  const approvalDir = tempRuntimeDir("adopt-cancel-consume-missing-appr");
  // adoptedPbsRun writes to auditDir but only the approval matters here.
  const approval = approvedAdoptedCancel(approvalDir, {
    run_id: "adopt-4321-cetus",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: "4321.cetus"
  });
  assert.equal(approval.state, "approved");
  assert.equal(approval.remote_job_id, "4321.cetus");

  assert.throws(
    () =>
      consumeApproval(
        {
          approvalId: approval.approval_id,
          // remoteJobId intentionally omitted — old code SKIPPED the binding check here.
          consumedBy: "test"
        },
        { approvalDir, now: NOW }
      ),
    /remote_job_id|does not match/i
  );
  void auditDir;
});

test("NIT-1: consumeApproval throws when an adopted-cancel approval is consumed with a MISMATCHED remoteJobId", () => {
  const approvalDir = tempRuntimeDir("adopt-cancel-consume-mismatch-appr");
  const approval = approvedAdoptedCancel(approvalDir, {
    run_id: "adopt-4321-cetus",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: "4321.cetus"
  });

  assert.throws(
    () =>
      consumeApproval(
        {
          approvalId: approval.approval_id,
          remoteJobId: "9999.cetus",
          consumedBy: "test"
        },
        { approvalDir, now: NOW }
      ),
    /remote_job_id|does not match/i
  );
});

test("NIT-1: consumeApproval still SUCCEEDS for an adopted-cancel approval with the matching remoteJobId (happy path stays green)", () => {
  const approvalDir = tempRuntimeDir("adopt-cancel-consume-match-appr");
  const approval = approvedAdoptedCancel(approvalDir, {
    run_id: "adopt-4321-cetus",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: "4321.cetus"
  });

  const consumed = consumeApproval(
    {
      approvalId: approval.approval_id,
      remoteJobId: "4321.cetus",
      consumedBy: "test"
    },
    { approvalDir, now: NOW }
  ).approval;
  assert.ok(consumed.used_at, "matching adopted-cancel consume must mark used_at");
});
