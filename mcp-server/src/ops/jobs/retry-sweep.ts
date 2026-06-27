// sweep.retry.plan (M10): a dry-run re-planner that re-plans ONLY the failed array members of a
// finished sweep into a new, smaller PBS array job (new run_id, new plan_hash, sweep_retry_of lineage).
// This turns O(failures) manual round-trips into ONE re-plan; re-submission still flows through the
// existing autonomous, conformance-gated jobs.submit. PLANNER ONLY — no SSH, no source mutation, no
// orchestration/auto-submit (the layering audit rejected the god-object).
//
// The index->params table is NOT persisted on the saved plan (only resources.array{start,end} + the
// params embedded in the generated case block; the table is returned only in the tool response). So
// this planner takes the ORIGINAL parameters grid + failedIndices as inputs and re-runs expandGrid to
// re-select the failed members — exactly as sweep.rank already requires the original parameters. The
// source sweep run is read+verified only for lineage/escalation context.

import { assertSafeRunId } from "../../core/ids.js";
import { redactCommand, readRunRecord, updateRunRecord } from "../../core/audit.js";
import { readPlanArtifact, writePlanArtifact } from "../plans/plan-store.js";
import { planHashForPlan, planJob, type PlanOptions } from "../plans/planner.js";
import { expandGrid, type SweepScalar } from "./sweep.js";
import { PLATFORM } from "../../core/types.js";
import type { PlannedJob, RunRecord, SweepRetryLineage } from "../../core/types.js";

const MAX_SWEEP_SIZE = 256;
const DEFAULT_MAX_CONCURRENT = 5;
const SAFE_STRING_VALUE = /^[A-Za-z0-9._:=+/-]+$/;
const SAFE_PARAM_NAME = /^[A-Za-z0-9_]+$/;

export interface RetrySweepInput {
  // The finished sweep whose failed members we are re-planning. Required and explicit — lineage is
  // ONE level per call; we never infer the source from history.
  sourceRunId: string;
  // The new run id for the compacted retry sweep (a fresh run, like jobs.retry.plan's retryRunId).
  retryRunId: string;
  // The ORIGINAL parameters grid that produced the source sweep (re-expanded here, not persisted).
  parameters: Record<string, SweepScalar[]>;
  // The original array indices that failed; compacted into a new [0..n-1] array.
  failedIndices: number[];
  maxConcurrent?: number;
  reason?: string;
}

export interface RetrySweepOptions extends PlanOptions {
  now?: Date;
}

export interface RetrySweepResult {
  retry_sweep: {
    mode: "dry-run";
    source_run_id: string;
    retry_run_id: string;
    failed_indices_count: number;
    planned_sweep_size: number;
    // original failed index -> new compacted index
    index_map: Record<string, number>;
    plan: PlannedJob;
    warnings: string[];
  };
}

export function planRetrySweep(input: RetrySweepInput, options: RetrySweepOptions = {}): RetrySweepResult {
  assertSafeRunId(input.sourceRunId, "sourceRunId");
  assertSafeRunId(input.retryRunId, "retryRunId");
  if (input.sourceRunId === input.retryRunId) {
    throw new Error("retryRunId must differ from sourceRunId");
  }
  if (options.writeAudit === false || options.writePlan === false) {
    throw new Error("sweep.retry.plan requires writing a new local retry plan and run record");
  }

  // 1. Read + verify the source sweep run/plan FOR LINEAGE ONLY (no mutation of the source).
  const sourcePlan = readPlanArtifact(input.sourceRunId, options.planDir);
  const sourceRecord = readRunRecord(input.sourceRunId, options.auditDir);
  assertSourceRecordMatchesPlan(sourceRecord, sourcePlan);
  assertFinishedSweepSource(sourceRecord, sourcePlan);

  // 2. Re-expand the ORIGINAL grid and re-select the failed members (the index->params table is not
  // persisted, so the operator must supply the same grid — like sweep.rank). Recover the base command
  // template (with {placeholders}) from the source case block's index-0 line + the grid's index-0
  // assignment, then re-validate it so the re-substituted members still cannot inject shell.
  const assignments = expandGrid(input.parameters);
  assertGridMatchesSource(assignments.length, sourcePlan);
  const command = recoverBaseCommand(sourcePlan, assignments[0]);
  validateParameters(input.parameters, command);

  // 3. Validate the failed indices and compact them into a new [0..n-1] array + index_map.
  const failedIndices = normalizeFailedIndices(input.failedIndices, assignments.length);
  const indexMap: Record<string, number> = {};
  const selected = failedIndices.map((original, compacted) => {
    indexMap[String(original)] = compacted;
    return assignments[original];
  });

  // 4. Build a fresh array job spec over ONLY the compacted failed members and plan it.
  const baseSpec = stripSourceArray(sourcePlan.normalized_job_spec);
  const requested = input.maxConcurrent ?? Math.min(selected.length, DEFAULT_MAX_CONCURRENT);
  const maxConcurrent = Math.max(1, Math.min(requested, selected.length));
  const retrySpec = {
    ...baseSpec,
    run_id: input.retryRunId,
    workdir: deriveRetryWorkdir(baseSpec.workdir, input.sourceRunId, input.retryRunId),
    command: buildSweepCommand(command, selected),
    resources: {
      ...baseSpec.resources,
      array: { start: 0, end: selected.length - 1, max_concurrent: maxConcurrent }
    }
  };

  // campaignId carries the source run's campaign forward (DISCLOSURE) so the retry stays attributed to
  // the same campaign in the ledger. It lands on the run record metadata only, never on plan_hash.
  const retryPlan = planJob(retrySpec, {
    ...options,
    ...(sourceRecord.campaign_id ? { campaignId: sourceRecord.campaign_id } : {})
  });

  const reason = normalizeReason(input.reason);
  const sweepRetryOf: SweepRetryLineage = {
    source_run_id: sourceRecord.run_id,
    source_status: "finished",
    source_plan_hash: sourcePlan.plan_hash,
    failed_indices: failedIndices,
    index_map: indexMap,
    planned_at: (options.now ?? new Date()).toISOString(),
    ...(reason ? { reason } : {})
  };
  // Align approval_operation to the autonomous model: re-submission is gated by live conformance, not a
  // token — same operation class as a single retry; conformance is the gate.
  retryPlan.approval_operation = "jobs.retry";
  retryPlan.sweep_retry_of = sweepRetryOf;
  retryPlan.plan_hash = planHashForPlan(retryPlan);
  rewritePlanArtifact(retryPlan, options);
  recordRetryLineage(retryPlan, sweepRetryOf, options);

  return {
    retry_sweep: {
      mode: "dry-run",
      source_run_id: input.sourceRunId,
      retry_run_id: input.retryRunId,
      failed_indices_count: failedIndices.length,
      planned_sweep_size: selected.length,
      index_map: indexMap,
      plan: retryPlan,
      warnings: [
        "Sweep retry planning only: no SSH, qsub, cnode, rsync, or remote writes were performed",
        "The source sweep run was not mutated; this is a new, independent array plan",
        "Re-submission still requires fresh quota evidence and passes live conformance through jobs.submit"
      ]
    }
  };
}

function assertSourceRecordMatchesPlan(record: RunRecord, plan: PlannedJob): void {
  if (record.run_id !== plan.run_id || record.profile_id !== plan.profile_id || record.platform !== plan.platform) {
    throw new Error("Source run record does not match the saved plan identity");
  }
  if (!record.plan_hash || record.plan_hash !== plan.plan_hash) {
    throw new Error("Source run record plan_hash does not match the saved plan");
  }
  const recomputed = planHashForPlan(plan);
  if (recomputed !== plan.plan_hash) {
    throw new Error("Source planned job artifact plan_hash does not match its rendered content");
  }
}

function assertFinishedSweepSource(record: RunRecord, plan: PlannedJob): void {
  if (record.status !== "finished") {
    throw new Error(`Run ${record.run_id} is ${record.status}; only a finished sweep run can be retry-planned`);
  }
  if (plan.platform !== PLATFORM.HPC || plan.template !== "pbs-array" || !plan.normalized_job_spec.resources.array) {
    throw new Error(`Run ${record.run_id} is not a sweep (PBS array) run; sweep.retry.plan re-plans sweeps only`);
  }
  if (!/^case \$\{PBS_ARRAY_INDEX\} in/.test(plan.normalized_job_spec.command)) {
    throw new Error(`Run ${record.run_id} is not a sweep run (its command is not a $PBS_ARRAY_INDEX case block)`);
  }
}

// Recover the base command template ("...--lr {lr}...") shared by every array member. The source plan
// persists only the SUBSTITUTED case block, so we take its index-0 member line ("0) <substituted> ;;")
// and reverse-substitute the grid's index-0 assignment values back into {name} placeholders. We then
// re-validate the recovered template against the supplied parameters (validateParameters) so a value
// collision or tamper is caught before re-substituting the failed members.
function recoverBaseCommand(plan: PlannedJob, firstAssignment: Record<string, SweepScalar>): string {
  const lines = plan.normalized_job_spec.command.split("\n");
  const member0 = lines.find((line) => /^0\) /.test(line));
  if (!member0) {
    throw new Error("Source sweep command has no index-0 array member to recover the base template from");
  }
  let template = member0.replace(/^0\) /, "").replace(/ ;;\s*$/, "");
  // Replace each concrete index-0 value back with its {name} placeholder (longest values first so a
  // value that is a substring of another is not partially replaced).
  const entries = Object.entries(firstAssignment).sort(
    (left, right) => String(right[1]).length - String(left[1]).length
  );
  for (const [name, value] of entries) {
    template = template.split(String(value)).join(`{${name}}`);
  }
  return template;
}

function assertGridMatchesSource(gridSize: number, plan: PlannedJob): void {
  const array = plan.normalized_job_spec.resources.array;
  const sourceSize = array ? array.end - array.start + 1 : 0;
  if (gridSize !== sourceSize) {
    throw new Error(
      `Supplied parameters expand to ${gridSize} members but the source sweep array size is ${sourceSize}; the grid must match the one that produced the source run`
    );
  }
}

function normalizeFailedIndices(indices: number[], size: number): number[] {
  if (!Array.isArray(indices) || indices.length === 0) {
    throw new Error("failedIndices must be a non-empty array (at least one failed member to re-plan)");
  }
  const seen = new Set<number>();
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      throw new Error(`failedIndices contains ${index}, which is outside the source array bounds [0, ${size - 1}]`);
    }
    if (seen.has(index)) {
      throw new Error(`failedIndices contains a duplicate index: ${index}`);
    }
    seen.add(index);
  }
  // Compact in ascending original order so index_map is deterministic.
  return [...indices].sort((left, right) => left - right);
}

function stripSourceArray(jobSpec: PlannedJob["normalized_job_spec"]): PlannedJob["normalized_job_spec"] {
  const resources = { ...jobSpec.resources };
  delete resources.array;
  return { ...jobSpec, resources };
}

function deriveRetryWorkdir(workdir: string | undefined, sourceRunId: string, retryRunId: string): string {
  if (!workdir) {
    throw new Error("Source plan must include workdir before sweep-retry planning");
  }
  const parts = workdir.split("/");
  if (parts.at(-1) !== sourceRunId) {
    throw new Error("Source plan workdir must end with sourceRunId so the retry workdir can be derived safely");
  }
  parts[parts.length - 1] = retryRunId;
  return parts.join("/");
}

// Mirror sweep.ts's safety-validated parameter handling so the re-selected members cannot inject shell.
function validateParameters(parameters: unknown, command: string): void {
  if (!isObject(parameters) || Object.keys(parameters).length === 0) {
    throw new Error("sweep.retry.plan requires the original non-empty parameters object");
  }
  for (const [name, values] of Object.entries(parameters)) {
    if (!SAFE_PARAM_NAME.test(name)) {
      throw new Error(`Unsafe sweep parameter name: ${name}`);
    }
    if (!command.includes(`{${name}}`)) {
      throw new Error(`Source sweep command has no {${name}} placeholder for sweep parameter "${name}"`);
    }
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`Sweep parameter "${name}" must be a non-empty array of values`);
    }
    for (const value of values) {
      assertSafeValue(name, value);
    }
  }
  const size = Object.values(parameters as Record<string, SweepScalar[]>).reduce(
    (product, values) => product * values.length,
    1
  );
  if (size > MAX_SWEEP_SIZE) {
    throw new Error(`sweep grid size ${size} exceeds the cap of ${MAX_SWEEP_SIZE}`);
  }
}

function assertSafeValue(name: string, value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Sweep parameter "${name}" has a non-finite number`);
    }
    return;
  }
  if (typeof value === "boolean") {
    return;
  }
  if (typeof value === "string" && SAFE_STRING_VALUE.test(value)) {
    return;
  }
  throw new Error(`Sweep parameter "${name}" has an unsafe value: ${JSON.stringify(value)}`);
}

function buildSweepCommand(baseCommand: string, assignments: Array<Record<string, SweepScalar>>): string {
  const lines = ["case ${PBS_ARRAY_INDEX} in"];
  assignments.forEach((params, index) => {
    lines.push(`${index}) ${substitute(baseCommand, params)} ;;`);
  });
  lines.push('*) echo "unknown sweep index ${PBS_ARRAY_INDEX}" >&2; exit 2 ;;');
  lines.push("esac");
  return lines.join("\n");
}

function substitute(command: string, params: Record<string, SweepScalar>): string {
  let out = command;
  for (const [name, value] of Object.entries(params)) {
    out = out.split(`{${name}}`).join(String(value));
  }
  const leftover = out.match(/\{[A-Za-z0-9_]+\}/);
  if (leftover) {
    throw new Error(`Unsubstituted placeholder ${leftover[0]} remains in the sweep retry command`);
  }
  return out;
}

function rewritePlanArtifact(plan: PlannedJob, options: PlanOptions): void {
  // planJob already wrote a plan artifact with the base (lineage-free) hash; rewrite it with the
  // lineage-bound hash + sweep_retry_of so the saved plan matches the returned plan.
  plan.plan_path = writePlanArtifact(plan, options.planDir);
}

function recordRetryLineage(plan: PlannedJob, sweepRetryOf: SweepRetryLineage, options: RetrySweepOptions): void {
  const record = readRunRecord(plan.run_id, options.auditDir);
  record.sweep_retry_of = sweepRetryOf;
  record.plan_hash = plan.plan_hash;
  record.updated_at = sweepRetryOf.planned_at;
  record.events.push({
    at: sweepRetryOf.planned_at,
    kind: "sweep-retry-plan",
    summary: sweepRetryOf.reason
      ? `Sweep retry planned from ${sweepRetryOf.source_run_id} (${sweepRetryOf.failed_indices.length} members): ${sweepRetryOf.reason}`
      : `Sweep retry planned from ${sweepRetryOf.source_run_id} (${sweepRetryOf.failed_indices.length} members)`,
    redacted_command: record.events[0]?.redacted_command
  });
  updateRunRecord(record, options.auditDir);
}

function normalizeReason(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value.trim() || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("reason must be a non-empty string under 500 characters without control characters");
  }
  return redactCommand(value.trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

