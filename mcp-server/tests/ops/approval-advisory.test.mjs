import assert from "node:assert/strict";
import test from "node:test";
import { planJob } from "../../dist/ops/plans/planner.js";
import { readExample, tempRuntimeDir } from "../helpers/index.mjs";

// ADR 0004 line 32: the hardcoded risk thresholds in approval-policy.ts are demoted to
// display-only metadata in jobs.plan; they no longer gate. A GPU job still surfaces its
// risk reasons, but the plan marks them advisory — submission proceeds via conformance.
test("jobs.plan marks risk reasons as advisory display-only metadata", () => {
  const planDir = tempRuntimeDir("test-advisory-plans");
  const auditDir = tempRuntimeDir("test-advisory-runs");
  const job = readExample("hpc-gpu.json");
  job.run_id = "advisory-gpu";
  const plan = planJob(job, { planDir, auditDir });

  // The GPU reason is still surfaced (useful advisory signal for the planner/human).
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("GPU")));
  // But it is explicitly advisory metadata, not a hard gate.
  assert.equal(plan.approval.policy, "advisory");
});
