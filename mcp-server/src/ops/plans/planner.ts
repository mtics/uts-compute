import { createHash } from "node:crypto";
import { isInsideRemoteRoot, stableJson } from "../../lib/shared.js";
import { getProfile } from "../../core/config.js";
import { buildRunRecord, writeRunRecord, listRunRecordIds, readRunRecordSafe } from "../../core/audit.js";
import { writePlanArtifact, readPlanArtifact } from "./plan-store.js";
import { diffJobSpecs } from "./spec-diff.js";
import { parseCommandArgv } from "./command-argv.js";
import { approvalReasonsForJobSpec } from "../approvals/approval-policy.js";
import { assertJobSpec } from "../../core/validation.js";
import { renderTemplate, shellSingleQuote, type TemplateId } from "../catalog/templates.js";
import { captureReproducibility, makeGitRunner, type EnvRunner, type GitRunner } from "./reproducibility.js";
import { resolveProjectIdentity, UNASSIGNED_PROJECT } from "../profiles/project.js";
import { projectRoot } from "../../core/paths.js";
import { PLATFORM } from "../../core/types.js";
import type { ComputeProfile, JobSpec, PlannedJob, RunRecord } from "../../core/types.js";

export interface PlanOptions {
  configPath?: string;
  writeAudit?: boolean;
  auditDir?: string;
  writePlan?: boolean;
  planDir?: string;
  gitRunner?: GitRunner;
  envRunner?: EnvRunner;
  // Optional campaign attribution threaded from the jobs.plan/sweep.plan tool input. It lands on the
  // RunRecord metadata ONLY (parallel to project) — never on the hashed normalized_job_spec, so it
  // cannot perturb plan_hash. DISCLOSURE for the campaign ledger, never a cap input.
  campaignId?: string;
}

export function planJob(rawJobSpec: unknown, options: PlanOptions = {}): PlannedJob {
  assertJobSpec(rawJobSpec);
  const profile = getProfile(rawJobSpec.profile_id, options.configPath);

  if (profile.platform !== rawJobSpec.platform) {
    throw new Error(
      `Profile ${profile.profile_id} is for ${profile.platform}, but job spec requested ${rawJobSpec.platform}`
    );
  }

  const remoteUser = resolveRemoteUser(profile);
  const normalized = normalizeJobSpec(rawJobSpec, profile, remoteUser);
  validateDryRunBoundaries(normalized, profile, remoteUser);

  const templateId = chooseTemplate(normalized);
  const approvalReasons = approvalReasonsForJobSpec(normalized);
  const approval = {
    required: approvalReasons.length > 0 || Boolean(normalized.approval?.required),
    reasons: uniqueSorted([...(normalized.approval?.reasons ?? []), ...approvalReasons])
  };
  const normalizedWithApproval: JobSpec = {
    ...normalized,
    approval
  };
  const warnings = warningsFor(normalized, profile);
  const script = renderTemplate(templateId, templateVariables(normalizedWithApproval, templateId));
  const planHash = buildPlanHash(normalizedWithApproval, templateId, script);
  const quotaSnapshotId = quotaSnapshotIdFor(profile);

  const plan: PlannedJob = {
    mode: "dry-run",
    run_id: normalized.run_id,
    profile_id: normalized.profile_id,
    platform: normalized.platform,
    plan_hash: planHash,
    ...(quotaSnapshotId ? { quota_snapshot_id: quotaSnapshotId } : {}),
    template: templateId,
    script,
    ...(normalized.platform === PLATFORM.IHPC ? { command_argv: parseCommandArgv(normalized.command) } : {}),
    normalized_job_spec: normalizedWithApproval,
    // The hashed spec keeps approval = { required, reasons }; the plan surfaces the same
    // reasons tagged advisory (ADR 0004 demotion) without perturbing plan_hash.
    approval: { ...approval, policy: "advisory" },
    warnings
  };

  // One git probe serves both the project identity and the reproducibility block; neither feeds
  // plan_hash (project is organizational metadata, exactly like the reproducibility block).
  const gitRunner = options.gitRunner ?? makeGitRunner(projectRoot);
  const projectIdentity = resolveProjectIdentity(gitRunner);

  if (options.writeAudit ?? true) {
    const now = new Date();
    const record = buildRunRecord(normalizedWithApproval, `Rendered ${templateId} in local dry-run mode`, now, {
      planHash,
      quotaSnapshotId,
      approvalState: approval.required ? "required" : "not_required",
      approvalReasons: approval.reasons,
      reproducibility: captureReproducibility(normalized.command, now, {
        gitRunner,
        ...(options.envRunner ? { envRunner: options.envRunner } : {})
      }),
      project: projectIdentity.project,
      projectHash: projectIdentity.project_hash,
      ...(options.campaignId ? { campaignId: options.campaignId } : {}),
      ...(normalized.experiment?.job_type ? { jobType: normalized.experiment.job_type } : {})
    });
    plan.audit_path = writeRunRecord(record, options.auditDir);
  }
  if (options.writePlan ?? true) {
    plan.plan_path = writePlanArtifact(plan, options.planDir);
  }

  // Advisory: diff against the latest prior run of the same project. Attached to the returned plan
  // only (never persisted, never hashed) so an accidental resource/command change is visible before
  // submission. Excludes this run; skips priors whose plan artifact is unavailable.
  const specDiff = latestProjectSpecDiff(plan, projectIdentity.project, options);
  if (specDiff) {
    plan.spec_diff = specDiff;
  }

  return plan;
}

function latestProjectSpecDiff(
  plan: PlannedJob,
  project: string,
  options: PlanOptions
): PlannedJob["spec_diff"] | undefined {
  const ids = options.auditDir ? listRunRecordIds(options.auditDir) : listRunRecordIds();
  const priors = ids
    .map((id) => readRunRecordSafe(id, options.auditDir))
    .filter((record): record is RunRecord => record !== null)
    .filter((record) => record.run_id !== plan.run_id && (record.project ?? UNASSIGNED_PROJECT) === project)
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
  for (const prior of priors) {
    try {
      const priorPlan = readPlanArtifact(prior.run_id, options.planDir);
      return { against_run_id: prior.run_id, changes: diffJobSpecs(priorPlan.normalized_job_spec, plan.normalized_job_spec) };
    } catch {
      // No readable plan artifact for this prior run; try the next-most-recent.
    }
  }
  return undefined;
}

export interface PlanHashLineage {
  approvalOperation?: PlannedJob["approval_operation"];
  retryOf?: PlannedJob["retry_of"];
  sweepRetryOf?: PlannedJob["sweep_retry_of"];
}

export function buildPlanHash(jobSpec: JobSpec, templateId: string, script: string, lineage: PlanHashLineage = {}): string {
  return createHash("sha256")
    .update(
      stableJson({
        normalized_job_spec: jobSpec,
        template: templateId,
        script,
        ...(lineage.approvalOperation ? { approval_operation: lineage.approvalOperation } : {}),
        ...(lineage.retryOf ? { retry_of: lineage.retryOf } : {}),
        ...(lineage.sweepRetryOf ? { sweep_retry_of: lineage.sweepRetryOf } : {})
      })
    )
    .digest("hex");
}

// Hash that commits to the plan's operation class (jobs.submit vs jobs.retry) and retry lineage
// (single-job retry_of OR sweep sweep_retry_of), so flipping approval_operation/retry_of/sweep_retry_of
// in saved local state is detected as a plan_hash mismatch. A plan with no lineage hashes identically
// to the base payload, keeping submit-plan hashes stable.
export function planHashForPlan(plan: PlannedJob): string {
  return buildPlanHash(plan.normalized_job_spec, plan.template, plan.script, {
    approvalOperation: plan.approval_operation,
    retryOf: plan.retry_of,
    sweepRetryOf: plan.sweep_retry_of
  });
}

// Resolve ${USER} to the concrete account login so PBS -o/-e directives (which PBS does NOT
// shell-expand, unlike the script body) point at a real path. The username comes from a
// "user@host" host_alias; profiles without one keep ${USER} literal (account-agnostic dry-runs).
function resolveRemoteUser(profile: ComputeProfile): string | undefined {
  const alias = profile.login.host_alias;
  const at = alias.indexOf("@");
  if (at > 0) {
    const user = alias.slice(0, at);
    if (/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
      return user;
    }
  }
  return undefined;
}

function substituteRemoteUser(value: string, remoteUser: string | undefined): string {
  return remoteUser ? value.replaceAll("${USER}", remoteUser) : value;
}

function normalizeJobSpec(jobSpec: JobSpec, profile: ComputeProfile, remoteUser: string | undefined): JobSpec {
  const resources = { ...jobSpec.resources };
  const defaults = profile.defaults;
  const ngpus = resources.ngpus ?? 0;

  if (jobSpec.platform === PLATFORM.HPC) {
    // Respect an explicitly-requested queue. The live cluster exposes small_gpuq/med_gpuq/large_gpuq
    // (qstat) — there is no bare routing `gpuq` in live snapshots, so clobbering an explicit GPU queue
    // made jobs.plan disagree with submit-time conformance ("Queue gpuq is not present..."). Only a
    // queue-less GPU job is defaulted, to a REAL GPU queue (small_gpuq); CPU jobs use the profile default.
    resources.queue = resources.queue ?? (ngpus > 0 ? "small_gpuq" : defaults.queue);
    resources.ngpus = ngpus;
  } else {
    resources.node_family = resources.node_family ?? defaults.node_family;
    resources.ngpus = ngpus;
  }

  const baseWorkdir = defaults.workspace ?? defaults.scratch;
  const rawWorkdir = jobSpec.workdir ?? (baseWorkdir ? `${baseWorkdir.replace(/\/$/, "")}/${jobSpec.run_id}` : undefined);
  const workdir = rawWorkdir !== undefined ? substituteRemoteUser(rawWorkdir, remoteUser) : rawWorkdir;

  return {
    ...jobSpec,
    resources,
    workdir
  };
}

function chooseTemplate(jobSpec: JobSpec): TemplateId {
  if (jobSpec.platform === PLATFORM.IHPC) {
    return "ihpc-background";
  }

  if (jobSpec.resources.array) {
    // GPU arrays (sweeps) need the select-chunk syntax with ngpus, like single GPU jobs — a dedicated
    // template since the flat {{var}} renderer can't branch. CPU arrays keep the separate-resource form.
    return (jobSpec.resources.ngpus ?? 0) > 0 ? "pbs-array-gpu" : "pbs-array";
  }

  return (jobSpec.resources.ngpus ?? 0) > 0 ? "pbs-gpu" : "pbs-cpu";
}

function validateDryRunBoundaries(jobSpec: JobSpec, profile: ComputeProfile, remoteUser: string | undefined): void {
  if (!jobSpec.workdir) {
    throw new Error("Job spec requires workdir or profile default workspace/scratch");
  }
  assertSafePath(jobSpec.workdir, "workdir");
  assertSafeCommand(jobSpec.command);

  const roots = [profile.defaults.workspace, profile.defaults.scratch]
    .filter((value): value is string => Boolean(value))
    .map((root) => substituteRemoteUser(root, remoteUser));
  if (roots.length > 0 && !roots.some((root) => isInsideRemoteRoot(jobSpec.workdir!, root))) {
    throw new Error(`workdir must be inside profile workspace or scratch roots: ${jobSpec.workdir}`);
  }

  if (jobSpec.platform === PLATFORM.HPC) {
    if (!jobSpec.resources.queue) {
      throw new Error("UTS HPC job specs require a queue or profile default queue");
    }
    if (!jobSpec.resources.ncpus || !jobSpec.resources.memory_gb || !jobSpec.resources.walltime) {
      throw new Error("UTS HPC job specs require ncpus, memory_gb, and walltime");
    }
  }

  if (jobSpec.platform === PLATFORM.IHPC && !jobSpec.resources.node_family) {
    throw new Error("UTS iHPC job specs require node_family or profile default node_family");
  }

  if (jobSpec.resources.array && jobSpec.resources.array.end < jobSpec.resources.array.start) {
    throw new Error("Array end must be greater than or equal to array start");
  }
  if (
    jobSpec.resources.array?.max_concurrent &&
    jobSpec.resources.array.max_concurrent > jobSpec.resources.array.end - jobSpec.resources.array.start + 1
  ) {
    throw new Error("Array max_concurrent cannot exceed array size");
  }
}

function warningsFor(jobSpec: JobSpec, profile: ComputeProfile): string[] {
  const warnings: string[] = ["M1 local dry-run only: no SSH, qsub, cnode, rsync, or remote writes were performed"];

  if (!profile.quota_snapshot) {
    warnings.push("No live quota snapshot is attached to this profile; live submission must wait for M2 quota refresh");
  }
  if (jobSpec.resources.ngpus && jobSpec.command.toLowerCase().includes("cpu")) {
    warnings.push("GPU was requested, but the command text looks CPU-oriented; verify before live submission");
  }

  return warnings;
}

function quotaSnapshotIdFor(profile: ComputeProfile): string | undefined {
  const snapshot = profile.quota_snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const candidate = (snapshot as { snapshot_id?: unknown }).snapshot_id;
  return typeof candidate === "string" ? candidate : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function templateVariables(jobSpec: JobSpec, templateId: TemplateId): Record<string, string | number> {
  const logDir = `${jobSpec.workdir}/logs`;
  const resources = jobSpec.resources;

  const base: Record<string, string | number> = {
    command_argv_json: JSON.stringify(jobSpec.platform === PLATFORM.IHPC ? parseCommandArgv(jobSpec.command) : []),
    command_argv_json_single_quoted: shellSingleQuote(
      JSON.stringify(jobSpec.platform === PLATFORM.IHPC ? parseCommandArgv(jobSpec.command) : [])
    ),
    run_id: jobSpec.run_id,
    workdir: jobSpec.workdir ?? "",
    log_dir: logDir,
    command: jobSpec.command,
    command_single_quoted: shellSingleQuote(jobSpec.command),
    ncpus: resources.ncpus ?? 1,
    memory_gb: resources.memory_gb ?? 1,
    walltime: resources.walltime ?? "01:00:00",
    queue: resources.queue ?? "",
    ngpus: resources.ngpus ?? 0
  };

  if ((templateId === "pbs-array" || templateId === "pbs-array-gpu") && resources.array) {
    base.array_start = resources.array.start;
    base.array_end = resources.array.end;
    base.array_max_concurrent = resources.array.max_concurrent ?? 1;
  }

  return base;
}

export function assertSafePath(candidate: string, label: string): void {
  if (!candidate.startsWith("/")) {
    throw new Error(`${label} must be an absolute path`);
  }
  if (candidate.split("/").includes("..")) {
    throw new Error(`${label} must not contain path traversal segments`);
  }
  if (/[\n\r"`;&|<>]/.test(candidate) || candidate.includes("$(") || candidate.includes("`")) {
    throw new Error(`${label} contains shell-active or control characters`);
  }
}

// The PBS job body is a shell script, so for uts-hpc the command is interpolated raw and shell
// metacharacters (; | && $(...) etc.) are intentionally permitted — they are legitimate job-script
// syntax. The trust boundary for "what an agent may run on the cluster" is therefore the approval /
// live-quota gate (plus the argv-allowlisted remote `qsub` and local spawn(shell:false)), NOT command
// sanitization. We reject only NUL/control chars and `#PBS` directive injection (which could smuggle
// scheduler options past the rendered template). uts-ihpc instead routes through parseCommandArgv with
// no shell. This trust boundary is pinned by tests in dry-run.test.mjs.
function assertSafeCommand(command: string): void {
  if (!command.trim()) {
    throw new Error("command must not be empty");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) {
    throw new Error("command contains unsupported control characters");
  }
  if (/^#PBS\b/m.test(command)) {
    throw new Error("command must not inject PBS directives");
  }
}
