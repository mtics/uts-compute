import assert from "node:assert/strict";
import test from "node:test";
import { requestApproval, listApprovals } from "../../dist/ops/approvals/approvals.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { readExample, writeQuotaSnapshot, tempRuntimeDir } from "../helpers/index.mjs";

// Seed one approval via the real requestApproval path (mirrors tests/ops/approval.test.mjs): it needs a
// plan (for plan_hash/profile/platform) plus a fresh matching quota snapshot in the global quota dir.
function seedApproval(approvalDir, { now = new Date("2026-06-15T00:00:00.000Z") } = {}) {
  const quotaSnapshotId = `quota-appr-list-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const plan = planJob(readExample("hpc-gpu.json"), { writeAudit: false });
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());
  return requestApproval(
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
}

test("approvals.list returns a summary of saved approval records", () => {
  const approvalDir = tempRuntimeDir("appr-list");
  const seeded = seedApproval(approvalDir);

  const { approvals } = listApprovals({ approvalDir });
  assert.ok(Array.isArray(approvals));
  assert.ok(approvals.length >= 1);

  const a = approvals.find((entry) => entry.approval_id === seeded.approval_id);
  assert.ok(a, "seeded approval must appear in the list");
  for (const k of [
    "approval_id",
    "run_id",
    "profile_id",
    "platform",
    "operation",
    "state",
    "requested_at",
    "expires_at"
  ]) {
    assert.ok(k in a, `missing ${k}`);
  }
  assert.equal(a.run_id, seeded.run_id);
  assert.equal(a.profile_id, seeded.profile_id);
  assert.equal(a.platform, seeded.platform);
  assert.equal(a.operation, seeded.operation);
  assert.equal(a.state, seeded.state);

  // Redaction-safe summary: no secrets / no full command or resource bodies.
  assert.equal("resource_summary" in a, false);
  assert.equal("command_summary" in a, false);
});

test("approvals.list is empty (not an error) when no approvals exist", () => {
  const approvalDir = tempRuntimeDir("appr-empty");
  const { approvals } = listApprovals({ approvalDir });
  assert.deepEqual(approvals, []);
});
