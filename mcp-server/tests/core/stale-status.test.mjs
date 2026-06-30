// Tests for the 'stale' terminal run status (T1 — schema + types + terminal sets).
//
// Assertions:
//  (a) The run-record schema validator accepts a RunRecord with status:"stale" (+ stale_reason).
//  (b) The jobs.track terminal-set treats 'stale' as non-active so stale records are skipped
//      by the fleet sweep (count shows up in skipped_terminal, not polled).
//
// Import pattern mirrored exactly from mcp-server/tests/ops/migrations.test.mjs which is the
// canonical example of validateRunRecord usage in this test suite.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateRunRecord } from "../../dist/core/validation.js";
import { trackActiveJobs } from "../../dist/ops/jobs/jobs.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import { requestApproval, decideApproval } from "../../dist/ops/approvals/approvals.js";
import { repoRoot, readExample, tempRuntimeDir, writeQuotaSnapshot, writeResolvedHpcConfig, resolvedHpcWorkdir } from "../helpers/index.mjs";

const observedAt = "2026-06-29T00:00:00.000Z";

// Minimal valid RunRecord shape (mirrors migrations.test.mjs runRecord() fixture).
function makeRecord(extra = {}) {
  return {
    run_id: "stale-status-test",
    profile_id: "uts-ihpc-account-a",
    platform: "uts-ihpc",
    remote_job_id: null,
    status: "planned",
    created_at: observedAt,
    updated_at: observedAt,
    events: [{ at: observedAt, kind: "dry-run-plan", summary: "stale status fixture" }],
    ...extra
  };
}

// ── (a) Schema validation ──────────────────────────────────────────────────────

test("run-record schema validator accepts status:'stale' (a new terminal status)", () => {
  const record = makeRecord({ status: "stale" });
  const result = validateRunRecord(record);
  assert.equal(result.valid, true, `expected valid; errors: ${result.errors.join("; ")}`);
});

test("run-record schema validator accepts status:'stale' with stale_reason string", () => {
  const record = makeRecord({ status: "stale", stale_reason: "run no longer visible on any held node" });
  const result = validateRunRecord(record);
  assert.equal(result.valid, true, `expected valid; errors: ${result.errors.join("; ")}`);
});

test("run-record schema validator still rejects an unknown status (sanity-check)", () => {
  const record = makeRecord({ status: "completely-made-up" });
  const result = validateRunRecord(record);
  assert.equal(result.valid, false, "unknown status should be rejected");
});

// ── (b) Terminal-set membership: jobs.track skips stale runs ──────────────────
//
// Approach: seed one submitted (active) run and one run force-written to status:"stale",
// run trackActiveJobs, and confirm the stale run is in skipped_terminal (not polled).
// This mirrors exactly the approach in mcp-server/tests/ops/jobs-track.test.mjs.

async function seedSubmittedRun(runId, planDir, auditDir, approvalDir, configPath) {
  const now = new Date("2026-06-29T00:00:00.000Z");
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.workdir = resolvedHpcWorkdir(runId);
  const plan = planJob(job, { planDir, auditDir, configPath });
  const quotaSnapshotId = `quota-${runId}-2026-06-29`;
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());
  const submitRequest = requestApproval(
    { runId: plan.run_id, profileId: plan.profile_id, platform: plan.platform, operation: "jobs.submit", planHash: plan.plan_hash, quotaSnapshotId },
    { approvalDir, now }
  ).approval;
  const submitApproval = decideApproval(
    { approvalId: submitRequest.approval_id, decision: "approved", planHash: plan.plan_hash, quotaSnapshotId, confirmationToken: "ops-token" },
    { approvalDir, now, confirmationToken: "ops-token" }
  ).approval;
  await submitJob(
    { runId: plan.run_id, approvalId: submitApproval.approval_id },
    {
      planDir, auditDir, approvalDir, configPath, now,
      executor: async () => ({ stdout: "1234.hpc\n", stderr: "", exitCode: 0, timedOut: false })
    }
  );
  return plan;
}

test("jobs.track treats 'stale' as terminal and skips it (not polled, counted as skipped_terminal)", async () => {
  const configPath = writeResolvedHpcConfig("stale-terminal");
  const planDir = tempRuntimeDir("stale-terminal-plans");
  const auditDir = tempRuntimeDir("stale-terminal-runs");
  const approvalDir = tempRuntimeDir("stale-terminal-approvals");

  // Seed an active run that should be polled.
  await seedSubmittedRun("stale-active-run", planDir, auditDir, approvalDir, configPath);

  // Seed a second run, then force its status to 'stale' (with stale_reason).
  await seedSubmittedRun("stale-marked-run", planDir, auditDir, approvalDir, configPath);
  const stalePath = path.join(auditDir, "stale-marked-run.json");
  const staleRec = JSON.parse(fs.readFileSync(stalePath, "utf8"));
  staleRec.status = "stale";
  staleRec.stale_reason = "node released from account between reconcile windows";
  // Give it usage so the usage-backfill path doesn't re-select it either.
  staleRec.usage = { walltime_seconds: 60, ncpus: 1, ngpus: 0, core_hours: 0.02, gpu_hours: 0, cpu_efficiency_percent: 90 };
  fs.writeFileSync(stalePath, `${JSON.stringify(staleRec, null, 2)}\n`, "utf8");

  let pollCount = 0;
  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: new Date("2026-06-29T00:05:00.000Z"),
      executor: async (_program, _args) => {
        pollCount += 1;
        // Return a running qstat for the active run.
        return { stdout: "Job Id: 1234.hpc\n    job_state = R\n", stderr: "", exitCode: 0, timedOut: false };
      }
    }
  );

  // The stale run must NOT have been polled.
  assert.equal(pollCount, 1, "only the active (non-stale) run should be polled");
  assert.equal(result.tracking.counts.skipped_terminal, 1, "stale run should be counted as skipped_terminal");
});
