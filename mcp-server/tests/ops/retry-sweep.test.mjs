import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { planSweep } from "../../dist/ops/jobs/sweep.js";
import { planJob, buildPlanHash } from "../../dist/ops/plans/planner.js";
import { planRetrySweep } from "../../dist/ops/jobs/retry-sweep.js";
import { readExample, tempRuntimeDir } from "../helpers/index.mjs";

const noGit = () => ({ ok: false, stdout: "" });

function baseJobSpec(command, runId) {
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.command = command;
  job.workdir = `/shared/homes/\${USER}/experiments/${runId}`;
  return job;
}

// Build a FINISHED sweep source run: plan it (one PBS array job over the grid), then mark the saved
// run record finished, exactly like a completed campaign the agent now wants to retry the failures of.
function finishedSweepSource({ runId = "sweep-src", parameters, status = "finished" } = {}) {
  const planDir = tempRuntimeDir("test-retry-sweep-plans");
  const auditDir = tempRuntimeDir("test-retry-sweep-runs");
  const { sweep, plan } = planSweep(
    {
      jobSpec: baseJobSpec("python train.py --lr {lr}", runId),
      parameters,
      campaignId: "camp-retry"
    },
    { planDir, auditDir, gitRunner: noGit }
  );
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  record.status = status;
  record.updated_at = "2026-06-15T00:01:00.000Z";
  fs.writeFileSync(plan.audit_path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { sweep, plan, planDir, auditDir };
}

function planOptions(source) {
  return { planDir: source.planDir, auditDir: source.auditDir, gitRunner: noGit };
}

test("planRetrySweep compacts failed indices into a new [0..n-1] array and returns an index_map", () => {
  const source = finishedSweepSource({ runId: "sweep-compact", parameters: { lr: [0.1, 0.01, 0.001, 0.0001, 0.05] } });
  // original size 5; failures at the original indices [1, 3, 4]
  const { retry_sweep } = planRetrySweep(
    { sourceRunId: "sweep-compact", retryRunId: "sweep-compact-retry", parameters: { lr: [0.1, 0.01, 0.001, 0.0001, 0.05] }, failedIndices: [1, 3, 4] },
    planOptions(source)
  );

  assert.equal(retry_sweep.mode, "dry-run");
  assert.equal(retry_sweep.source_run_id, "sweep-compact");
  assert.equal(retry_sweep.failed_indices_count, 3);
  assert.equal(retry_sweep.planned_sweep_size, 3);
  // original failed index -> new compacted index
  assert.deepEqual(retry_sweep.index_map, { 1: 0, 3: 1, 4: 2 });

  const plan = retry_sweep.plan;
  assert.equal(plan.template, "pbs-array");
  assert.deepEqual(plan.normalized_job_spec.resources.array, { start: 0, end: 2, max_concurrent: plan.normalized_job_spec.resources.array.max_concurrent });
  assert.equal(plan.normalized_job_spec.resources.array.end, 2);
  // the new case block re-selects only the failed members' params, in compacted order
  assert.match(plan.normalized_job_spec.command, /0\) python train\.py --lr 0\.01 ;;/);
  assert.match(plan.normalized_job_spec.command, /1\) python train\.py --lr 0\.0001 ;;/);
  assert.match(plan.normalized_job_spec.command, /2\) python train\.py --lr 0\.05 ;;/);
});

test("planRetrySweep binds sweep_retry_of into a NEW independent plan_hash", () => {
  const source = finishedSweepSource({ runId: "sweep-hash", parameters: { lr: [0.1, 0.01, 0.001] } });
  const { retry_sweep } = planRetrySweep(
    { sourceRunId: "sweep-hash", retryRunId: "sweep-hash-retry", parameters: { lr: [0.1, 0.01, 0.001] }, failedIndices: [0, 2] },
    planOptions(source)
  );
  const plan = retry_sweep.plan;

  // the lineage is present and points at the source sweep
  assert.equal(plan.sweep_retry_of.source_run_id, "sweep-hash");
  assert.equal(plan.sweep_retry_of.source_plan_hash, source.plan.plan_hash);
  assert.deepEqual(plan.sweep_retry_of.failed_indices, [0, 2]);
  assert.deepEqual(plan.sweep_retry_of.index_map, { 0: 0, 2: 1 });

  // the plan_hash is independent of the source sweep
  assert.notEqual(plan.plan_hash, source.plan.plan_hash);

  // and the lineage is hash-bound: recomputing the hash WITH the lineage matches, WITHOUT it does not
  assert.equal(
    plan.plan_hash,
    buildPlanHash(plan.normalized_job_spec, plan.template, plan.script, {
      approvalOperation: plan.approval_operation,
      sweepRetryOf: plan.sweep_retry_of
    })
  );
  assert.notEqual(plan.plan_hash, buildPlanHash(plan.normalized_job_spec, plan.template, plan.script));

  // persisted run record carries the same lineage
  const retryRecord = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  assert.deepEqual(retryRecord.sweep_retry_of, plan.sweep_retry_of);
  assert.equal(retryRecord.plan_hash, plan.plan_hash);
});

test("planRetrySweep is dry-run only and returns no-remote-write warnings", () => {
  const source = finishedSweepSource({ runId: "sweep-dry", parameters: { lr: [0.1, 0.01] } });
  const { retry_sweep } = planRetrySweep(
    { sourceRunId: "sweep-dry", retryRunId: "sweep-dry-retry", parameters: { lr: [0.1, 0.01] }, failedIndices: [0] },
    planOptions(source)
  );
  assert.equal(retry_sweep.mode, "dry-run");
  assert.ok(retry_sweep.warnings.length > 0);
  assert.ok(retry_sweep.warnings.some((w) => /no SSH|remote writes/i.test(w)));
  // source record is untouched (no mutation of the source run)
  const sourceRecord = JSON.parse(fs.readFileSync(source.plan.audit_path, "utf8"));
  assert.equal(sourceRecord.status, "finished");
});

test("planRetrySweep accepts only a finished sweep source run", () => {
  // not finished
  const running = finishedSweepSource({ runId: "sweep-running", parameters: { lr: [0.1, 0.01] }, status: "running" });
  assert.throws(
    () =>
      planRetrySweep(
        { sourceRunId: "sweep-running", retryRunId: "sweep-running-retry", parameters: { lr: [0.1, 0.01] }, failedIndices: [0] },
        planOptions(running)
      ),
    /finished/i
  );

  // a plain (non-sweep, non-array) source run is rejected
  const planDir = tempRuntimeDir("test-retry-sweep-plain-plans");
  const auditDir = tempRuntimeDir("test-retry-sweep-plain-runs");
  const job = baseJobSpec("python train.py --lr 0.1", "plain-src");
  const plan = planJob(job, { planDir, auditDir, gitRunner: noGit });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  record.status = "finished";
  fs.writeFileSync(plan.audit_path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  assert.throws(
    () =>
      planRetrySweep(
        { sourceRunId: "plain-src", retryRunId: "plain-src-retry", parameters: { lr: [0.1] }, failedIndices: [0] },
        { planDir, auditDir, gitRunner: noGit }
      ),
    /sweep/i
  );
});

test("planRetrySweep validates failedIndices are within the original array bounds", () => {
  const source = finishedSweepSource({ runId: "sweep-bounds", parameters: { lr: [0.1, 0.01, 0.001] } });

  // out of range
  assert.throws(
    () =>
      planRetrySweep(
        { sourceRunId: "sweep-bounds", retryRunId: "sweep-bounds-retry", parameters: { lr: [0.1, 0.01, 0.001] }, failedIndices: [0, 3] },
        planOptions(source)
      ),
    /bounds|range/i
  );

  // empty
  assert.throws(
    () =>
      planRetrySweep(
        { sourceRunId: "sweep-bounds", retryRunId: "sweep-bounds-retry2", parameters: { lr: [0.1, 0.01, 0.001] }, failedIndices: [] },
        planOptions(source)
      ),
    /non-empty|at least one/i
  );

  // duplicate
  assert.throws(
    () =>
      planRetrySweep(
        { sourceRunId: "sweep-bounds", retryRunId: "sweep-bounds-retry3", parameters: { lr: [0.1, 0.01, 0.001] }, failedIndices: [1, 1] },
        planOptions(source)
      ),
    /duplicate/i
  );

  // parameters whose cardinality does not match the source sweep's array size are rejected (the grid
  // must be the same one that produced the source run, like sweep.rank requires)
  assert.throws(
    () =>
      planRetrySweep(
        { sourceRunId: "sweep-bounds", retryRunId: "sweep-bounds-retry4", parameters: { lr: [0.1, 0.01] }, failedIndices: [0] },
        planOptions(source)
      ),
    /does not match|cardinality|array size/i
  );
});
