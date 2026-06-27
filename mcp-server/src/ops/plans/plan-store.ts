import fs from "node:fs";
import { assertSafeRunId } from "../../core/ids.js";
import path from "node:path";
import { assertInsideRuntime, resolveRecordPath, RUNTIME_DIRS } from "../../core/paths.js";
import { planHashForPlan } from "./planner.js";
import { assertPlannedJob } from "../../core/validation.js";
import type { PlannedJob } from "../../core/types.js";

const DEFAULT_PLAN_DIR: string = RUNTIME_DIRS.plans;

export function writePlanArtifact(plan: PlannedJob, planDir = DEFAULT_PLAN_DIR): string {
  assertValidPlannedJobArtifact(plan);
  const resolvedDir = assertInsideRuntime(planDir, "Plan directory");
  fs.mkdirSync(resolvedDir, { recursive: true });
  const outputPath = path.join(resolvedDir, `${plan.run_id}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return outputPath;
}

export function readPlanArtifact(runId: string, planDir = DEFAULT_PLAN_DIR): PlannedJob {
  assertSafeRunId(runId);
  const resolvedDir = assertInsideRuntime(planDir, "Plan directory");
  const filePath = resolveRecordPath(resolvedDir, runId, {
    containmentMessage: "Plan path must stay inside the plan directory",
    realpathLabel: "Plan file"
  });
  const plan = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  assertValidPlannedJobArtifact(plan);
  return plan;
}

// The plan self-integrity gate: read the saved plan artifact, recompute its plan_hash from the
// rendered content, and reject a tampered artifact whose stored hash no longer matches. This is the
// single home for the "does the artifact's plan_hash match its own content" check that was
// re-implemented byte-for-byte across jobs/artifacts/ihpc-start/submit (the mismatch message lives
// once here). It is ONLY a self-consistency check: cross-entity identity/operation/approval policy
// stays in each caller. See docs/archive/layering-audit-2026-06.md finding 13.
export function readVerifiedPlan(runId: string, planDir = DEFAULT_PLAN_DIR): PlannedJob {
  const plan = readPlanArtifact(runId, planDir);
  if (planHashForPlan(plan) !== plan.plan_hash) {
    throw new Error("Planned job artifact plan_hash does not match its rendered content");
  }
  return plan;
}

function assertValidPlannedJobArtifact(value: unknown): asserts value is PlannedJob {
  assertPlannedJob(value);
  const plan = value;
  if (!plan.normalized_job_spec || plan.normalized_job_spec.run_id !== plan.run_id) {
    throw new Error("Planned job artifact must include matching normalized_job_spec");
  }
}


