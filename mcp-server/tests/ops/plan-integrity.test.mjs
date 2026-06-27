import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { planJob } from "../../dist/ops/plans/planner.js";
import { readVerifiedPlan } from "../../dist/ops/plans/plan-store.js";
import { readExample, tempRuntimeDir } from "../helpers/index.mjs";

// The plan self-integrity gate now lives once in plan-store.readVerifiedPlan
// (docs/archive/layering-audit-2026-06.md finding 13). These pin both directions: a faithful artifact reads
// back, and a tampered plan_hash throws the single shared mismatch message.

function seedPlan(jobName = "hpc-cpu.json") {
  const planDir = tempRuntimeDir("test-plan-integrity-plans");
  const auditDir = tempRuntimeDir("test-plan-integrity-runs");
  const plan = planJob(readExample(jobName), { planDir, auditDir });
  return { plan, planDir };
}

test("readVerifiedPlan returns the plan when the artifact's plan_hash matches its content", () => {
  const { plan, planDir } = seedPlan();
  const verified = readVerifiedPlan(plan.run_id, planDir);
  assert.equal(verified.run_id, plan.run_id);
  assert.equal(verified.plan_hash, plan.plan_hash);
});

test("readVerifiedPlan throws the shared mismatch message on a tampered plan_hash", () => {
  const { plan, planDir } = seedPlan();
  const planPath = path.join(planDir, `${plan.run_id}.json`);
  const tampered = JSON.parse(fs.readFileSync(planPath, "utf8"));
  tampered.plan_hash = "0".repeat(64);
  fs.writeFileSync(planPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  assert.throws(
    () => readVerifiedPlan(plan.run_id, planDir),
    /Planned job artifact plan_hash does not match its rendered content/
  );
});

test("readVerifiedPlan throws when the rendered content is altered out from under the hash", () => {
  const { plan, planDir } = seedPlan();
  const planPath = path.join(planDir, `${plan.run_id}.json`);
  const tampered = JSON.parse(fs.readFileSync(planPath, "utf8"));
  // Mutate a hashed field while leaving plan_hash intact -> recompute must diverge.
  tampered.normalized_job_spec.experiment.description = `${tampered.normalized_job_spec.experiment.description} (edited)`;
  fs.writeFileSync(planPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  assert.throws(
    () => readVerifiedPlan(plan.run_id, planDir),
    /Planned job artifact plan_hash does not match its rendered content/
  );
});
