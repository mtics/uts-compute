import { runProcess } from "../../lib/process.js";
import { assertSafeApprovalId, assertSafeRunId, isSafePbsJobId } from "../../core/ids.js";
import { isInsideRemoteRoot, isSafeRemotePath, normalizeTimeout, sshTimeoutSeconds } from "../../lib/shared.js";
import { sshJobArgs, sshSingleHopArgs } from "../../lib/ssh.js";
import { redactCommand, readRunRecord, updateRunRecord } from "../../core/audit.js";
import { maskHostAlias, summarizeRemoteFailure } from "../../lib/redact.js";
import { consumeApproval, approvalStatus, readFreshQuotaSnapshot } from "../approvals/approvals.js";
import { getProfile, buildSubmissionContext } from "../../core/config.js";
import { assertProfileOnboarded } from "../profiles/onboarding.js";
import { startIhpcRun } from "./ihpc-start.js";
import { assertAllowedHpcJobRemoteArgv } from "./jobs.js";
import { readVerifiedPlan } from "../plans/plan-store.js";
import { assertSafePath } from "../plans/planner.js";
import { checkPbsConformance, type ConformanceResult } from "../quotas/conformance.js";
import type { PbsQueueLimit, ParsedFilesystem } from "../quotas/quota-limits.js";
import { assertApprovalUsableForPlan, expectedApprovalOperationForPlan, type SubmitApprovalOperation } from "../approvals/submission-approval.js";
import { PLATFORM } from "../../core/types.js";
import type { ApprovalRecord, ComputeProfile, PlannedJob, QuotaSnapshot, RunRecord, SubmitResult } from "../../core/types.js";

export interface SubmitOptions {
  timeoutMs?: number;
  executor?: SubmitExecutor;
  planDir?: string;
  auditDir?: string;
  approvalDir?: string;
  onboardingDir?: string;
  configPath?: string;
  now?: Date;
}

export type SubmitExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin: string
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }>;

// Timeout policy (per-module, deliberate): standard 10s default / 30s cap shared by the middle
// modules. Named consts so the policy stays explicit, not folded into a shared bound.
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;

export async function submitJob(
  input: { runId: string; approvalId?: string; quotaSnapshotId?: string },
  options: SubmitOptions = {}
): Promise<{ submission: SubmitResult }> {
  assertSafeRunId(input.runId);
  if (input.approvalId !== undefined) {
    assertSafeApprovalId(input.approvalId);
  }
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultSubmitExecutor;

  const plan = readVerifiedPlan(input.runId, options.planDir);
  // First-run gate: the profile must have completed onboarding (a confirmed live connection that
  // captured its limits) before any live submission. Dry-run planning is unaffected.
  assertProfileOnboarded(plan.profile_id, options.onboardingDir);
  if (plan.platform === PLATFORM.IHPC) {
    return startIhpcRun({ runId: input.runId, approvalId: input.approvalId, quotaSnapshotId: input.quotaSnapshotId }, options);
  }
  if (plan.platform !== PLATFORM.HPC) {
    throw new Error(`jobs.submit does not support platform ${String(plan.platform)}`);
  }
  const runRecord = readRunRecord(plan.run_id, options.auditDir);
  const profile = getProfile(plan.profile_id, options.configPath);
  if (profile.platform !== plan.platform) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but plan requested ${plan.platform}`);
  }
  const expectedOperation = expectedApprovalOperationForPlan(plan, runRecord);

  let approval: ApprovalRecord | undefined;
  let quotaSnapshotId: string | undefined;
  let authorizationNote: string;
  if (input.approvalId) {
    approval = approvalStatus({ approvalId: input.approvalId }, { approvalDir: options.approvalDir, now }).approval;
    assertApprovalUsableForPlan(approval, plan.run_id, plan.profile_id, plan.platform, plan.plan_hash, expectedOperation);
    quotaSnapshotId = approval.quota_snapshot_id;
    authorizationNote = `approval ${approval.approval_id}`;
  } else {
    if (!input.quotaSnapshotId) {
      throw new Error("jobs.submit requires either an approvalId or a fresh quotaSnapshotId for autonomous conformance");
    }
    const snapshot = readFreshQuotaSnapshot(input.quotaSnapshotId, plan.profile_id, plan.platform, now);
    const conformance = conformanceForPlan(plan, snapshot, profile);
    if (!conformance.conforms) {
      throw new Error(
        `Job ${plan.run_id} does not conform to the live quota envelope (${snapshot.snapshot_id}): ${conformance.violations
          .map((violation) => violation.message)
          .join("; ")}`
      );
    }
    quotaSnapshotId = snapshot.snapshot_id;
    authorizationNote = `autonomous conformance vs ${snapshot.snapshot_id} (queue ${conformance.queue})`;
  }

  if (runRecord.status !== "planned") {
    // Re-submitting a non-planned run directly stays FORBIDDEN — retry.plan is the supported re-run path
    // (it mints a fresh run_id + retry lineage + new plan_hash; it does NOT re-fire this run record). For a
    // failed/cancelled run, NAME that path so operators stop hand-resetting runs to 'planned' (the CETUS
    // instant-fail workaround). A PBS-array sweep retries via sweep.retry.plan (only its failed members).
    if (runRecord.status === "failed" || runRecord.status === "cancelled") {
      const retryPath =
        plan.template === "pbs-array"
          ? "use sweep.retry.plan (re-plans only the failed array members) — or jobs.retry.plan"
          : "use jobs.retry.plan";
      throw new Error(
        `Run ${plan.run_id} is ${runRecord.status}; it cannot be re-submitted directly — ${retryPath} to re-run it (a fresh run_id + retry lineage). Do NOT hand-reset the run to 'planned'.`
      );
    }
    throw new Error(`Run ${plan.run_id} is ${runRecord.status}; only planned runs can be submitted`);
  }

  // Persist a durable "submitting" marker BEFORE the remote qsub. If the process dies between a
  // successful qsub and the final record write, the record reads "submitting" (not "planned"), so
  // jobs.track surfaces it for reconciliation instead of it looking like an un-submitted job whose
  // live cluster counterpart is orphaned.
  runRecord.status = "submitting";
  runRecord.plan_hash = plan.plan_hash;
  if (quotaSnapshotId) {
    runRecord.quota_snapshot_id = quotaSnapshotId;
  }
  runRecord.updated_at = now.toISOString();
  runRecord.events.push({
    at: now.toISOString(),
    kind: "live-submit-attempt",
    summary: `Submitting UTS HPC PBS job (${authorizationNote})`,
    redacted_command: "ssh <profile-host> qsub"
  });
  updateRunRecord(runRecord, options.auditDir);

  // P0 (real CETUS incident): PBS opens the `-o`/`-e` files at job START — BEFORE the script runs — and
  // does NOT create their parent directory. A missing log_dir therefore yields ZERO logs, and the
  // script's own `cd "<workdir>"` under `set -e` into a missing workdir instant-fails (the job vanishes
  // from qstat in seconds). The script's in-script `mkdir` (templates) is too late for PBS's -o/-e open,
  // so we create BOTH dirs over SSH BEFORE qsub. Placed AFTER the durable "submitting" marker so a crash
  // between mkdir and qsub stays reconcilable; fail-closed so we never qsub a job that would just vanish.
  // The marker (runRecord/auditDir/now) is threaded so the mkdir attempt leaves an audit event.
  await ensureRemoteWorkdirs(plan, profile, timeoutMs, executor, runRecord, now, options.auditDir);

  const args = sshSubmitArgs(profile.login.host_alias, timeoutMs);
  const result = await executor("ssh", args, timeoutMs, plan.script);
  if (result.exitCode !== 0) {
    throw new Error(summarizeSubmitFailure(result));
  }
  // qsub exited 0, so the job IS on the cluster — the side effect already happened. If its id does not
  // parse we must NEVER return a clean failure that discards it (that invites a duplicate submit):
  // persist the raw qsub output as a reconcile event (status stays "submitting", which jobs.track
  // already surfaces) so the real id is recoverable, THEN surface the parse failure.
  let remoteJobId: string;
  try {
    remoteJobId = parseRemoteJobId(result.stdout);
  } catch (error) {
    runRecord.updated_at = now.toISOString();
    runRecord.events.push({
      at: now.toISOString(),
      kind: "live-submit-unparsed",
      summary: `qsub exited 0 but its job id did not parse — the job may be queued; reconcile before resubmitting. Raw: ${
        redactCommand(result.stdout.trim()).slice(0, 200) || "<empty>"
      }`,
      redacted_command: "ssh <profile-host> qsub"
    });
    updateRunRecord(runRecord, options.auditDir);
    throw error;
  }

  // Persist the remote job id immediately — before consuming the approval — so a crash in the rest
  // of this function cannot leave a live cluster job that jobs.track can never see.
  runRecord.remote_job_id = remoteJobId;
  runRecord.updated_at = now.toISOString();
  updateRunRecord(runRecord, options.auditDir);

  if (approval) {
    consumeApproval(
      {
        approvalId: approval.approval_id,
        runId: plan.run_id,
        profileId: plan.profile_id,
        platform: plan.platform,
        operation: expectedOperation,
        planHash: plan.plan_hash,
        quotaSnapshotId: approval.quota_snapshot_id,
        consumedBy: `${expectedOperation}:${remoteJobId}`
      },
      { approvalDir: options.approvalDir, now }
    );
  }

  runRecord.status = "submitted";
  runRecord.remote_job_id = remoteJobId;
  runRecord.submission = buildSubmissionContext(profile, plan.normalized_job_spec.resources, now.toISOString());
  runRecord.updated_at = now.toISOString();
  runRecord.plan_hash = plan.plan_hash;
  if (quotaSnapshotId) {
    runRecord.quota_snapshot_id = quotaSnapshotId;
  }
  runRecord.approval = approval
    ? {
        state: "approved",
        approved_at: approval.decided_at,
        approved_by: approval.decided_by,
        bound_plan_hash: plan.plan_hash,
        bound_quota_snapshot_id: approval.quota_snapshot_id
      }
    : {
        state: "not_required",
        reason: authorizationNote,
        bound_plan_hash: plan.plan_hash,
        ...(quotaSnapshotId ? { bound_quota_snapshot_id: quotaSnapshotId } : {})
      };
  runRecord.events.push({
    at: now.toISOString(),
    kind: expectedOperation === "jobs.retry" ? "live-retry-submit" : "live-submit",
    summary: `Submitted ${expectedOperation === "jobs.retry" ? "retry " : ""}UTS HPC PBS job ${remoteJobId} (${authorizationNote})`,
    redacted_command: "ssh <profile-host> qsub"
  });
  const runRecordPath = updateRunRecord(runRecord, options.auditDir);

  return {
    submission: {
      mode: "live",
      run_id: plan.run_id,
      profile_id: plan.profile_id,
      platform: plan.platform,
      status: "submitted",
      remote_job_id: remoteJobId,
      ...(approval ? { approval_id: approval.approval_id } : {}),
      plan_hash: plan.plan_hash,
      ...(quotaSnapshotId ? { quota_snapshot_id: quotaSnapshotId } : {}),
      submitted_at: now.toISOString(),
      command: {
        program: "ssh",
        args: redactSshArgs(args, profile.login.host_alias),
        remote_argv: ["qsub"]
      },
      run_record_path: runRecordPath
    }
  };
}

function conformanceForPlan(plan: PlannedJob, snapshot: QuotaSnapshot, profile: ComputeProfile): ConformanceResult {
  const resources = plan.normalized_job_spec.resources;
  const queue = resources.queue ?? "";
  const queuesSummary = (snapshot.summary.queues ?? {}) as { queue_limits?: PbsQueueLimit[]; qstat_qf_observed?: boolean };
  const queueLimits = Array.isArray(queuesSummary.queue_limits) ? queuesSummary.queue_limits : [];
  const queueLimit = queueLimits.find((entry) => entry.name === queue);
  const runningWork = (snapshot.summary.running_work ?? {}) as {
    by_queue?: Record<string, { running: number; queued: number }>;
  };
  const counts = lookupQueueCounts(runningWork.by_queue, queue);
  const storageSummary = (snapshot.summary.storage ?? {}) as { filesystems?: ParsedFilesystem[] };
  const filesystems = Array.isArray(storageSummary.filesystems) ? storageSummary.filesystems : [];
  const identity = (snapshot.summary.identity ?? {}) as { groups?: string[] };
  const groups = Array.isArray(identity.groups) ? identity.groups : [];
  const targetPath = plan.normalized_job_spec.workdir;
  return checkPbsConformance({
    queue,
    ncpus: resources.ncpus,
    memory_gb: resources.memory_gb,
    walltime: resources.walltime,
    ngpus: resources.ngpus,
    username: remoteUserFromHostAlias(profile.login.host_alias),
    groups,
    queueLimit,
    ...(typeof queuesSummary.qstat_qf_observed === "boolean" ? { limitsObserved: queuesSummary.qstat_qf_observed } : {}),
    runningInQueue: counts.running,
    queuedInQueue: counts.queued,
    ...(filesystems.length > 0 ? { storage: { filesystems, ...(targetPath ? { targetPath } : {}) } } : {})
  });
}

function remoteUserFromHostAlias(hostAlias: string): string {
  return hostAlias.includes("@") ? hostAlias.split("@")[0] : hostAlias;
}

function lookupQueueCounts(
  byQueue: Record<string, { running: number; queued: number }> | undefined,
  queue: string
): { running: number; queued: number } {
  if (!byQueue) {
    return { running: 0, queued: 0 };
  }
  if (byQueue[queue]) {
    return byQueue[queue];
  }
  for (const [display, counts] of Object.entries(byQueue)) {
    if (display.endsWith("*") && queue.startsWith(display.slice(0, -1))) {
      return counts;
    }
  }
  return { running: 0, queued: 0 };
}

// Create the workdir + log_dir on the cluster BEFORE qsub, fixed-argv, over SSH, confined to the
// profile's allowed roots. log_dir/workdir are derived from `plan.normalized_job_spec.workdir` — the
// EXACT resolved path the template renders into `-o`/`-e` and `cd` — so the dirs we create are precisely
// the ones PBS opens and the script cds to (`log_dir = <workdir>/logs`, matching the planner's
// templateVariables). `${USER}` is left intact when the planner left it intact (account-agnostic alias);
// the remote login shell expands it for mkdir exactly as it does for the existing `tail` log-path argv,
// because sshJobArgs.shellQuoteRemoteToken leaves `$`/`/` unquoted. Fail-closed: a nonzero/timed-out
// mkdir THROWS and qsub never runs (a missing-dir job would only vanish anyway).
async function ensureRemoteWorkdirs(
  plan: PlannedJob,
  profile: ComputeProfile,
  timeoutMs: number,
  executor: SubmitExecutor,
  runRecord: RunRecord,
  now: Date,
  auditDir: string | undefined
): Promise<void> {
  const workdir = plan.normalized_job_spec.workdir;
  if (!workdir) {
    throw new Error(`Run ${plan.run_id} has no workdir to create before qsub`);
  }
  const logDir = `${workdir}/logs`;

  // Item 1 (IMPORTANT, HPC-PBS-ONLY): fail closed on an UNRESOLVED shell expansion in the workdir/log_dir.
  // This path only runs for a LIVE UTS HPC PBS submit (iHPC is already routed away at submit.ts:59-61, and
  // its on-node progressor legitimately expands `${USER}` via os.path.expandvars). For PBS, the planner
  // leaves a LITERAL `${USER}` whenever the profile's host_alias has no `user@` prefix (or the user is
  // rejected by resolveRemoteUser). That is UNFIXABLE here: the pre-qsub mkdir runs in an SSH login shell
  // that EXPANDS `${USER}` and creates the RESOLVED dir, but PBS opens the LITERAL `${USER}` path for
  // `-o`/`-e` (PBS does NOT expand it) — two different dirs → zero logs again, silently. So we refuse
  // BEFORE the mkdir and qsub instead of recreating the incident. The `$` test catches `${USER}`, any
  // other `${...}`, and a bare `$VAR` — every shell expansion PBS leaves intact in -o/-e while the login
  // shell expands it for mkdir. NOTE: isSafeRemotePath below DELIBERATELY ALLOWS `${}` (so legitimate
  // remote-expansion paths pass), which is exactly why the incident shipped — so THIS guard is the only
  // thing that catches the PBS-unfixable literal-${USER} case, and it is the explicit fail-closed for it.
  for (const [label, candidate] of [["workdir", workdir], ["log_dir", logDir]] as const) {
    if (candidate.includes("$")) {
      throw new Error(
        `Run ${plan.run_id} ${label} still contains an unresolved shell expansion (${candidate}): a live UTS HPC ` +
          `PBS submit needs a FULLY-RESOLVED ${label} because PBS opens the -o/-e files (and this pre-qsub mkdir ` +
          `runs in a login shell) — a literal \${USER} would make PBS and mkdir target different dirs and produce ` +
          `zero logs. Use a profile whose host_alias is "user@host" so \${USER} resolves at plan time identically ` +
          `for both the pre-qsub mkdir and PBS's -o/-e open, then re-plan and resubmit.`
      );
    }
  }

  // Re-assert the SAME safety + confinement the planner used: absolute, no traversal, no shell-active
  // chars (assertSafePath), safe remote-path grammar (isSafeRemotePath), and INSIDE the profile's
  // declared workspace/scratch roots. mkdir only ever runs inside an allowed root, never an arbitrary
  // path. With the unresolved-${USER} guard above the workdir is already concrete, so the roots are
  // resolved through the same `${USER}` substitution to keep the containment check apples-to-apples.
  const remoteUser = remoteUserForConfinement(profile.login.host_alias);
  for (const [label, candidate] of [["log_dir", logDir], ["workdir", workdir]] as const) {
    assertSafePath(candidate, label);
    if (!isSafeRemotePath(candidate)) {
      throw new Error(`${label} contains unsupported remote path characters: ${candidate}`);
    }
    const roots = [profile.defaults.workspace, profile.defaults.scratch]
      .filter((value): value is string => Boolean(value))
      .map((root) => substituteRemoteUser(root, remoteUser));
    const resolved = substituteRemoteUser(candidate, remoteUser);
    if (roots.length > 0 && !roots.some((root) => isInsideRemoteRoot(resolved, root))) {
      throw new Error(`${label} must be inside profile workspace or scratch roots: ${candidate}`);
    }
  }

  // log_dir first so its parent exists; `-p` makes both idempotent. `--` ends option parsing.
  const remoteArgv = ["mkdir", "-p", "--", logDir, workdir];
  assertAllowedHpcJobRemoteArgv(remoteArgv);

  // Item 3 (NIT): record the pre-qsub mkdir attempt so an operator reconciling a failure between the
  // "submitting" marker and qsub can see a mkdir was attempted. Recorded BEFORE the SSH call (consistent
  // with the existing live-submit-attempt event style) and leaks no real path/id — only "ssh
  // <profile-host> mkdir -p", matching how the existing events redact.
  runRecord.updated_at = now.toISOString();
  runRecord.events.push({
    at: now.toISOString(),
    kind: "pre-submit-mkdir",
    summary: `Creating UTS HPC PBS workdir + log_dir before qsub for ${plan.run_id}`,
    redacted_command: "ssh <profile-host> mkdir -p"
  });
  updateRunRecord(runRecord, auditDir);

  const args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
  const result = await executor("ssh", args, timeoutMs, "");
  if (result.timedOut) {
    throw new Error(`Pre-qsub mkdir of workdir/log_dir timed out before submission of ${plan.run_id}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Pre-qsub mkdir of workdir/log_dir failed (exit ${String(result.exitCode)}) for ${plan.run_id}; not submitting: ${
        redactCommand(result.stderr.trim()).slice(0, 200) || "<no stderr>"
      }`
    );
  }
}

// Mirror of the planner's ${USER} resolution (kept local, per-module, like the planner's own copy): a
// "user@host" host_alias yields the concrete login; an alias without one keeps ${USER} literal (the
// account-agnostic case). Used ONLY for the containment check so roots and workdir resolve identically.
function remoteUserForConfinement(hostAlias: string): string | undefined {
  const at = hostAlias.indexOf("@");
  if (at > 0) {
    const user = hostAlias.slice(0, at);
    if (/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
      return user;
    }
  }
  return undefined;
}

function substituteRemoteUser(value: string, remoteUser: string | undefined): string {
  return remoteUser ? value.replaceAll("${USER}", remoteUser) : value;
}

function sshSubmitArgs(hostAlias: string, timeoutMs: number): string[] {
  // The shared single-hop primitive owns the hardening prelude + `-T` + host-alias guard; the
  // qsub remote-argv tail (stdin carries the PBS script) is this builder's policy.
  return sshSingleHopArgs(hostAlias, sshTimeoutSeconds(timeoutMs), { tty: true, trailing: ["qsub"] });
}

function parseRemoteJobId(stdout: string): string {
  const candidate = stdout.trim().split(/\s+/)[0] ?? "";
  // PBS Pro returns `<seq>.<server>` for a normal job and `<seq>[].<server>` for an array job (the
  // server is the executing host, e.g. `hpc-head01`, not only `pbsserver`). isSafePbsJobId admits the
  // array-bracket grammar the broad token predicate rejects; this is what made a successful array
  // submit look like a failure.
  if (!isSafePbsJobId(candidate)) {
    throw new Error(`qsub did not return a safe PBS job id: ${redactCommand(stdout.trim()) || "<empty>"}`);
  }
  return candidate;
}

function summarizeSubmitFailure(result: { exitCode: number | null; stderr: string; timedOut?: boolean }): string {
  return summarizeRemoteFailure(result, {
    timedOut: "qsub submission timed out",
    failed: (stderr) => `qsub submission failed: ${stderr}`,
    exited: (exitCode) => `qsub submission exited with ${String(exitCode)}`
  });
}

function redactSshArgs(args: string[], hostAlias: string): string[] {
  return maskHostAlias(args, hostAlias);
}

const defaultSubmitExecutor: SubmitExecutor = runProcess;
