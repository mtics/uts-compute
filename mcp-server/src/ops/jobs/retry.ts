import fs from "node:fs";
import { assertSafeRunId } from "../../core/ids.js";
import path from "node:path";
import { redactCommand, readRunRecord, updateRunRecord } from "../../core/audit.js";
import { assertInsideRuntime, RUNTIME_DIRS } from "../../core/paths.js";
import { readPlanArtifact, writePlanArtifact } from "../plans/plan-store.js";
import { assertSafePath, planHashForPlan, planJob, type PlanOptions } from "../plans/planner.js";
import { parseWalltimeSeconds, formatWalltime } from "../../lib/walltime.js";
import type { JobSpec, PlannedJob, RetryLineage, RunRecord } from "../../core/types.js";

export interface RetryEscalation {
  memory_factor?: number;
  walltime_factor?: number;
}

export interface RetryPlanInput {
  sourceRunId: string;
  retryRunId: string;
  reason?: string;
  // F3: bump resources for an OOM/timeout retry (a same-size retry rarely helps). Bounded 1-4x; the
  // submit-time conformance gate still caps it at the queue's resources_max, so this can't overshoot.
  escalate?: RetryEscalation;
  // F6: for a session-timeout retry, resume from the source spec's declared checkpoint by appending
  // "<resume_flag> <checkpoint_path>" to the command (both declared + validated; never a path scan).
  resume?: boolean;
}

const MAX_ESCALATION_FACTOR = 4;

export interface RetryPlanOptions extends PlanOptions {
  now?: Date;
}

export interface RetryPlanResult {
  mode: "dry-run";
  source_run_id: string;
  source_status: RetryLineage["source_status"];
  retry_run_id: string;
  plan: PlannedJob;
  warnings: string[];
}

export function planRetryJob(input: RetryPlanInput, options: RetryPlanOptions = {}): { retry: RetryPlanResult } {
  assertSafeRunId(input.sourceRunId, "sourceRunId");
  assertSafeRunId(input.retryRunId, "retryRunId");
  if (options.writeAudit === false || options.writePlan === false) {
    throw new Error("jobs.retry.plan requires writing a new local retry plan and run record");
  }
  if (input.sourceRunId === input.retryRunId) {
    throw new Error("retryRunId must differ from sourceRunId");
  }
  const reason = normalizeReason(input.reason);
  assertRetryTargetAvailable(input.retryRunId, options);

  const sourcePlan = readPlanArtifact(input.sourceRunId, options.planDir);
  const sourceRecord = readRunRecord(input.sourceRunId, options.auditDir);
  assertSourceRecordMatchesPlan(sourceRecord, sourcePlan);
  const sourceStatus = retryableSourceStatus(sourceRecord, reason);
  assertSourcePlanHash(sourcePlan);

  const retrySpec = buildRetryJobSpec(
    sourcePlan.normalized_job_spec,
    input.retryRunId,
    reason,
    input.escalate,
    input.resume ?? false
  );
  const retryPlan = planJob(retrySpec, options);
  const retryOf: RetryLineage = {
    source_run_id: sourceRecord.run_id,
    source_status: sourceStatus,
    source_plan_hash: sourcePlan.plan_hash,
    planned_at: (options.now ?? new Date()).toISOString(),
    ...(reason ? { reason } : {})
  };
  retryPlan.approval_operation = "jobs.retry";
  retryPlan.retry_of = retryOf;
  retryPlan.plan_hash = planHashForPlan(retryPlan);
  retryPlan.plan_path = writePlanArtifact(retryPlan, options.planDir);
  appendRetryAuditEvent(retryPlan, retryOf, options);

  return {
    retry: {
      mode: "dry-run",
      source_run_id: input.sourceRunId,
      source_status: sourceStatus,
      retry_run_id: input.retryRunId,
      plan: retryPlan,
      warnings: [
        "Retry planning only: no SSH, qsub, cnode, rsync, or remote writes were performed",
        "The retry plan is a new run and still requires fresh quota evidence plus explicit approval before live submission"
      ]
    }
  };
}

function assertRetryTargetAvailable(runId: string, options: PlanOptions): void {
  const planPath = path.join(assertInsideRuntime(options.planDir ?? RUNTIME_DIRS.plans, "Plan directory"), `${runId}.json`);
  const runPath = path.join(assertInsideRuntime(options.auditDir ?? RUNTIME_DIRS.runs, "Audit directory"), `${runId}.json`);
  if (fs.existsSync(planPath) || fs.existsSync(runPath)) {
    throw new Error(`Retry run ${runId} already has local plan or run state`);
  }
}

function assertSourceRecordMatchesPlan(record: RunRecord, plan: PlannedJob): void {
  if (record.run_id !== plan.run_id || record.profile_id !== plan.profile_id || record.platform !== plan.platform) {
    throw new Error("Source run record does not match the saved plan identity");
  }
  if (!record.plan_hash || record.plan_hash !== plan.plan_hash) {
    throw new Error("Source run record plan_hash does not match the saved plan");
  }
}

function retryableSourceStatus(record: RunRecord, reason: string | undefined): RetryLineage["source_status"] {
  if (record.status === "failed") {
    return record.status;
  }
  if (record.status === "cancelled") {
    if (!reason) {
      throw new Error(`Run ${record.run_id} is cancelled; retry planning cancelled runs requires an explicit reason`);
    }
    return record.status;
  }
  throw new Error(`Run ${record.run_id} is ${record.status}; only failed or cancelled runs can be retry-planned`);
}

function assertSourcePlanHash(plan: PlannedJob): void {
  const recomputed = planHashForPlan(plan);
  if (recomputed !== plan.plan_hash) {
    throw new Error("Source planned job artifact plan_hash does not match its rendered content");
  }
}

function buildRetryJobSpec(
  source: JobSpec,
  retryRunId: string,
  reason: string | undefined,
  escalate: RetryEscalation | undefined,
  resume: boolean
): JobSpec {
  const workdir = deriveRetryWorkdir(source.workdir, source.run_id, retryRunId);
  const retryReason = reason ? `Retry reason: ${reason}` : `Retry of run ${source.run_id}`;
  return {
    ...source,
    run_id: retryRunId,
    workdir,
    ...(escalate ? { resources: escalateResources(source.resources, escalate) } : {}),
    ...(resume ? { command: resumeCommand(source) } : {}),
    experiment: {
      ...source.experiment,
      description: appendSentence(source.experiment.description, `Retry of run ${source.run_id}.`),
      tags: uniqueSorted([...(source.experiment.tags ?? []), "retry"])
    },
    approval: {
      required: true,
      reasons: uniqueSorted([...(source.approval?.reasons ?? []), `Retry of run ${source.run_id}`, retryReason])
    }
  };
}

// Append the declared resume flag + checkpoint path so a timeout retry continues from its checkpoint.
// Both are validated as a single safe argv token and a fixed absolute path — no glob, no remote scan.
function resumeCommand(source: JobSpec): string {
  const resumable = source.resumable;
  if (!resumable) {
    throw new Error(`Run ${source.run_id} has no resumable { checkpoint_path, resume_flag } declared; cannot resume`);
  }
  assertSafeResumeFlag(resumable.resume_flag);
  assertSafePath(resumable.checkpoint_path, "resumable.checkpoint_path");
  return `${source.command} ${resumable.resume_flag} ${resumable.checkpoint_path}`;
}

function assertSafeResumeFlag(flag: string): void {
  if (!/^-{0,2}[A-Za-z0-9][A-Za-z0-9._=-]{0,63}$/.test(flag)) {
    throw new Error(`Unsafe resume_flag (must be a single allowlisted token): ${flag}`);
  }
}

function escalateResources(resources: JobSpec["resources"], escalate: RetryEscalation): JobSpec["resources"] {
  const next = { ...resources };
  const memFactor = clampFactor(escalate.memory_factor);
  const wtFactor = clampFactor(escalate.walltime_factor);
  if (memFactor !== undefined && resources.memory_gb !== undefined) {
    next.memory_gb = Math.max(1, Math.round(resources.memory_gb * memFactor));
  }
  if (wtFactor !== undefined && resources.walltime) {
    const seconds = parseWalltimeSeconds(resources.walltime);
    if (seconds !== undefined) {
      next.walltime = formatWalltime(Math.round(seconds * wtFactor));
    }
  }
  return next;
}

function clampFactor(factor: number | undefined): number | undefined {
  if (factor === undefined) {
    return undefined;
  }
  if (!Number.isFinite(factor) || factor < 1 || factor > MAX_ESCALATION_FACTOR) {
    throw new Error(`escalation factor must be between 1 and ${MAX_ESCALATION_FACTOR}`);
  }
  return factor;
}

function deriveRetryWorkdir(workdir: string | undefined, sourceRunId: string, retryRunId: string): string {
  if (!workdir) {
    throw new Error("Source plan must include workdir before retry planning");
  }
  const parts = workdir.split("/");
  if (parts.at(-1) !== sourceRunId) {
    throw new Error("Source plan workdir must end with sourceRunId so retry workdir can be derived safely");
  }
  parts[parts.length - 1] = retryRunId;
  return parts.join("/");
}

function appendRetryAuditEvent(plan: PlannedJob, retryOf: RetryLineage, options: RetryPlanOptions): void {
  const retryRecord = readRunRecord(plan.run_id, options.auditDir);
  retryRecord.retry_of = retryOf;
  retryRecord.plan_hash = plan.plan_hash;
  retryRecord.updated_at = retryOf.planned_at;
  retryRecord.events.push({
    at: retryOf.planned_at,
    kind: "retry-plan",
    summary: retryOf.reason
      ? `Retry planned from ${retryOf.source_run_id}: ${retryOf.reason}`
      : `Retry planned from ${retryOf.source_run_id}`,
    redacted_command: retryRecord.events[0]?.redacted_command
  });
  updateRunRecord(retryRecord, options.auditDir);
}

function appendSentence(value: string | undefined, sentence: string): string {
  return value ? `${value.replace(/\s+$/, "")} ${sentence}` : sentence;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
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

