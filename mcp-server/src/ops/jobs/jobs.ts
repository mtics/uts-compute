import fs from "node:fs";
import { assertSafeApprovalId, assertSafeRunId, isSafePbsJobId, isSafeRemoteJobId, isSafeRemoteToken } from "../../core/ids.js";
import path from "node:path";
import { runProcess } from "../../lib/process.js";
import { pyImports, PY_FAIL_FIXED, PY_DECODE_SPEC } from "../../lib/remote-python.js";
import { assertApprovalBoundTo, assertAdoptedCancelApproval } from "../../lib/auth.js";
import { approvalStatus, consumeApproval } from "../approvals/approvals.js";
import {
  redactCommand,
  readRunRecord,
  readRunRecordSafe,
  listRunRecordIds,
  recordOperationEvidence,
  updateRunRecord
} from "../../core/audit.js";
import { reconcileIhpcCampaign } from "../scheduler/seam/reconcile.js";
// P2-a: the observe path reuses the EXISTING ihpc.node.usage probe for the GPU snapshot (same two-hop
// seam, same fixed NODE_USAGE_PY, same fail-closed node-unverifiable contract) — no new SSH assembler.
import { probeNodeUsage } from "./ihpc-node-usage.js";
// The node-side campaign STATE wire Python now lives in the scheduler seam (its single owner), so the
// single-run iHPC reconcile path below ships the SAME bytes the campaign brain does. Re-exported here so
// the existing jobs.ts consumers/tests keep importing IHPC_STATE_READ_PY from this module unchanged.
import { IHPC_STATE_READ_PY } from "../scheduler/seam/protocol-py.js";
export { IHPC_STATE_READ_PY };
// makeLineageAdoptHook is called at runtime inside the reconcile deps (not at module init), so the
// adopt.ts <-> jobs.ts import cycle resolves safely (the binding is only dereferenced when invoked).
import { makeLineageAdoptHook } from "./adopt.js";
import { maskHostAlias, redactWithTokens, summarizeRemoteFailure } from "../../lib/redact.js";
import { classifyRemoteFailure } from "../../lib/net-errors.js";
import {
  assertSafeRemotePath,
  assertSafeSshTarget,
  boundedInteger,
  encodeSpec,
  isInsideRemoteRoot,
  isSafeRemotePath,
  normalizeTimeout,
  parseJsonLastLine,
  safeTimestamp,
  sshTimeoutSeconds
} from "../../lib/shared.js";
import { UNASSIGNED_PROJECT, canonicalizeProjectName } from "../profiles/project.js";
import type { CommandResult } from "../../lib/process.js";
import { sshJobArgs, sshSupervisorArgs } from "../../lib/ssh.js";
import { getProfile, maskUserRootPath, userRootPrefixes } from "../../core/config.js";
import { assertInsideRuntime, RUNTIME_DIRS } from "../../core/paths.js";
import { writeEvidenceJson } from "../../lib/evidence.js";
import { readVerifiedPlan } from "../plans/plan-store.js";
import { PLATFORM } from "../../core/types.js";
import type {
  ApprovalRecord,
  ComputeProfile,
  JobCancelResult,
  JobLogsResult,
  JobLogStreamResult,
  JobStatusResult,
  JobTrackEntry,
  JobTrackResult,
  JobUsageSummary,
  NodeUsageView,
  Platform,
  RunRecord,
  RunUsage
} from "../../core/types.js";
import { isPbsArrayJobId, metricsToRunUsage, parseExecNodes, parseQstatFields, parseQstatUsageMetrics, type UsageMetrics } from "./accounting.js";

// P1-a: a per-node live GPU probe the adopted-iHPC OBSERVE path uses to attach gpu_usage. Resolves a
// node id to its NodeUsageView (fail-closed: a node it cannot read => node-unverifiable, empty gpus[]).
export type NodeUsageProbe = (profile: ComputeProfile, node: string) => Promise<NodeUsageView>;

export interface JobOperationOptions {
  timeoutMs?: number;
  executor?: JobCommandExecutor;
  planDir?: string;
  auditDir?: string;
  approvalDir?: string;
  evidenceDir?: string;
  configPath?: string;
  now?: Date;
  // P1-a (jobs.track node-GPU fusion): control whether the adopted-iHPC OBSERVE path attaches the node's
  // live GPU snapshot, and through which probe.
  //   undefined -> probe directly via probeNodeUsage (the jobs.status default; gpu_usage attached).
  //   a function -> use this (caller-supplied, de-duped/shared) probe (jobs.track nodeUsage:true).
  //   false      -> SKIP the GPU probe entirely; gpu_usage is omitted (jobs.track default-off, so the
  //                 sweep's cost/behavior is unchanged from before P1-a). The GPU snapshot, if any, is
  //                 then attached at the track level by the de-duped per-node pass.
  nodeUsageProbe?: NodeUsageProbe | false;
}

export type JobCommandExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin?: string
) => Promise<CommandResult>;

interface IhpcSupervisorDescriptor {
  pid: number;
  node_id: string;
  metadata_path: string;
  stdout_path: string;
  stderr_path: string;
  started_at?: string;
}

// Timeout policy (per-module, deliberate): standard 10s default / 30s cap shared by the middle
// modules. Named consts so the policy stays explicit, not folded into a shared bound.
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_LOG_BYTES = 16384;
const MAX_LOG_BYTES = 200000;
const DEFAULT_EVIDENCE_DIR: string = RUNTIME_DIRS.jobOps;

export async function getJobStatus(
  input: { runId: string },
  options: JobOperationOptions = {}
): Promise<{ status: JobStatusResult }> {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultJobCommandExecutor;
  const runRecord = readRunRecord(input.runId, options.auditDir);
  return { status: await reconcileRunStatus(runRecord, now, timeoutMs, executor, options) };
}

// Poll one run's platform, reconcile its persisted status, and return the read-only status result.
// Shared by jobs.status (one run) and jobs.track (every active run) so the scheduler-state -> run-status
// mapping and the evidence/update side effects live in exactly one place.
async function reconcileRunStatus(
  runRecord: RunRecord,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<JobStatusResult> {
  const profile = getProfile(runRecord.profile_id, options.configPath);
  if (runRecord.platform === PLATFORM.IHPC) {
    // P2-a: an ADOPTED/FOREIGN iHPC run (adoption block, platform iHPC, NO supervisor) that carries the
    // operator-observed node+pid gets the READ-ONLY observe path: report pid liveness + the node's GPU
    // snapshot WITHOUT requiring supervisor metadata. requireIhpcSupervisor would otherwise throw — so
    // for the operational norm (foreign work), this is the difference between visible and invisible.
    if (isAdoptedObservableIhpc(runRecord)) {
      return reconcileAdoptedIhpcRunStatus(runRecord, profile, now, timeoutMs, executor, options);
    }
    if (pickIhpcReconciler(runRecord) === "campaign") {
      // delegate to seam/reconcile.ts: read state.json once, sync this run's RunRecord, return its
      // status. The campaign-wide sync (sibling runs) is driven by jobs.track's batch path.
      // P1 (crash-safety): a campaign run can be at the durable PRE-LAUNCH marker ("submitting" with a
      // campaign_id but no remote_job_id yet) — the launch seam writes it before the SSH side effects. It
      // is reconcilable against node STATE (keyed by campaign_id), so do NOT require a remote_job_id here;
      // the per-pid paths below still do (requireRemoteJobId). The marker's display id falls back to "".
      const remoteJobIdForCampaign = runRecord.remote_job_id ?? "";
      return reconcileIhpcCampaignRunStatus(runRecord, profile, remoteJobIdForCampaign, now, timeoutMs, executor, options);
    }
    return reconcileIhpcRunStatus(runRecord, profile, requireRemoteJobId(runRecord), now, timeoutMs, executor, options);
  }
  const remoteJobId = requireRemoteJobId(runRecord);
  if (profile.platform !== PLATFORM.HPC || runRecord.platform !== PLATFORM.HPC) {
    throw new Error("jobs.status currently supports UTS HPC PBS run records only");
  }
  return reconcilePbsRunStatus(runRecord, profile, remoteJobId, now, timeoutMs, executor, options);
}

async function reconcilePbsRunStatus(
  runRecord: RunRecord,
  profile: ComputeProfile,
  remoteJobId: string,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<JobStatusResult> {
  let remoteArgv = ["qstat", "-f", remoteJobId];
  assertAllowedHpcJobRemoteArgv(remoteArgv);
  let args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
  let result = await executor("ssh", args, timeoutMs);
  // A finished/instant-failed PBS job leaves the live queue within seconds; `qstat -f <id>` then errors
  // with a job-gone signal ("Unknown Job Id" / "Job has finished, use -x or -H"). When the LIVE probe
  // says the job is GONE we ALWAYS read the historical record once (`qstat -x -f <id>`), so an
  // instant-fail (F + nonzero Exit_status) reliably lands `failed` and jobs.retry.plan can adopt it —
  // instead of the run getting stuck at `submitted`/`unknown`. This is BROADER than the prior narrow
  // `/finished|use -x|-H\b/` trigger, which missed a bare "Unknown Job Id" response.
  //
  // Fail-closed: a TIMEOUT or an SSH transport/auth error must NOT be read as "gone" — that would
  // mis-mark a still-running job. pbsLiveQstatSaysJobGone POSITIVELY matches a qstat-emitted job-gone
  // signal and returns false for timeouts and for transport/auth failures (qstat never ran, so the
  // queue said nothing). When it returns false we keep the live `result`, and parseQstatStatus +
  // updateRunStatus's T2 guard preserve the prior definite status.
  // A finished array job keeps resources_used on its sub-jobs, so the history read expands them with -t
  // (the array parent record carries no usage). The status parse still resolves from the same output.
  const isArrayJob = isPbsArrayJobId(remoteJobId);
  if (pbsLiveQstatSaysJobGone(result)) {
    remoteArgv = isArrayJob ? ["qstat", "-x", "-t", "-f", remoteJobId] : ["qstat", "-x", "-f", remoteJobId];
    assertAllowedHpcJobRemoteArgv(remoteArgv);
    args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
    result = await executor("ssh", args, timeoutMs);
  }
  const parsed = parseQstatStatus(result.stdout, result.stderr, result.exitCode, result.timedOut);
  // The qstat -f / -x -f output already fetched carries resources_used.* and exec_host, so usage and
  // the compute node come for free — no extra SSH. exec_host is absent until the job starts running.
  const usageMetrics = parseQstatUsageMetrics(result.stdout, isArrayJob);
  const usage = usageMetrics ? toUsageSummary(usageMetrics) : null;
  if (usageMetrics) {
    runRecord.usage = toRunUsage(usageMetrics);
  }
  const execNodes = parseExecNodes(result.stdout);
  const node = execNodes.length > 0 ? execNodes.join("+") : undefined;
  if (node && runRecord.submission) {
    runRecord.submission.node = node;
  }
  const evidencePath = writeJobEvidence(
    "status",
    runRecord.run_id,
    now,
    {
      command: redactedCommand(args, profile.login.host_alias, remoteArgv, [remoteJobId]),
      exit_code: result.exitCode,
      timed_out: Boolean(result.timedOut),
      stdout: redactCommand(result.stdout),
      stderr: redactCommand(result.stderr),
      parsed_status: parsed
    },
    options.evidenceDir
  );
  const runRecordPath = updateRunStatus(
    runRecord,
    parsed.status,
    now,
    parsed.summary,
    "ssh <profile-host> qstat -f <remote-job-id>",
    "pbs-status",
    evidencePath,
    options.auditDir
  );

  return {
    mode: "read-only",
    run_id: runRecord.run_id,
    profile_id: runRecord.profile_id,
    platform: runRecord.platform,
    remote_job_id: remoteJobId,
    observed_at: now.toISOString(),
    status: runRecord.status,
    ...(parsed.schedulerState ? { scheduler_state: parsed.schedulerState } : {}),
    ...(node ? { node } : {}),
    ...(runRecord.placement ? { placement: runRecord.placement } : {}),
    usage,
    summary: parsed.summary,
    // P4: enrich a VPN-down probe with a classified kind + actionable hint (no-op spread when the probe
    // ran). The status stays whatever the reconcile decided (an indeterminate probe preserved the prior
    // definite state via updateRunStatus); the hint just tells the operator WHY the probe was indeterminate.
    ...networkDropFields(result),
    command: redactedCommand(args, profile.login.host_alias, remoteArgv, [remoteJobId]),
    run_record_path: runRecordPath,
    evidence_path: evidencePath
  };
}

function toUsageSummary(metrics: UsageMetrics): JobUsageSummary {
  return {
    core_hours: metrics.core_hours,
    gpu_hours: metrics.gpu_hours,
    cpu_efficiency_percent: metrics.cpu_efficiency_percent
  };
}

function toRunUsage(metrics: UsageMetrics): RunUsage {
  return metricsToRunUsage(metrics);
}

export interface JobsTrackInput {
  profileId?: string;
  platform?: Platform;
  project?: string;
  limit?: number;
  // P1-a: OPT-IN one-call fleet status. When true, ALSO attach each ACTIVE iHPC run's compute-node live
  // GPU snapshot (probeNodeUsage) to its track entry — replacing the manual per-node nvidia-smi step.
  // De-duped per distinct node and fail-closed per node. Default false to keep the sweep's cost/behavior.
  nodeUsage?: boolean;
}

const DEFAULT_TRACK_LIMIT = 100;
const MAX_TRACK_LIMIT = 200;
const TRACK_CONCURRENCY = 4;

// Read-only fleet sweep: re-poll every non-terminal run that already has a remote_job_id, reconcile
// each persisted record through the same path as jobs.status, and return one table. A single run's
// failure is captured in its entry rather than aborting the sweep; the SSH fan-out is bounded by
// TRACK_CONCURRENCY, and the polled set is capped at `limit` (truncation is flagged, never silent).
export async function trackActiveJobs(
  input: JobsTrackInput = {},
  options: JobOperationOptions = {}
): Promise<{ tracking: JobTrackResult }> {
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultJobCommandExecutor;

  const ids = options.auditDir ? listRunRecordIds(options.auditDir) : listRunRecordIds();
  let records = ids
    .map((id) => readRunRecordSafe(id, options.auditDir))
    .filter((record): record is RunRecord => record !== null);
  if (input.profileId) {
    records = records.filter((record) => record.profile_id === input.profileId);
  }
  if (input.platform) {
    records = records.filter((record) => record.platform === input.platform);
  }
  if (input.project) {
    const wantedSlug = canonicalizeProjectName(input.project);
    records = records.filter(
      (record) => (record.project ?? UNASSIGNED_PROJECT) === wantedSlug || record.project_hash === input.project
    );
  }

  const terminal = new Set<RunRecord["status"]>(["finished", "failed", "cancelled"]);
  let skippedTerminal = 0;
  let skippedPlanned = 0;
  const active: RunRecord[] = [];
  const needsReconciliation: Array<{ run_id: string; project: string; message: string }> = [];
  for (const record of records) {
    if (terminal.has(record.status)) {
      // Backfill: a terminal HPC run that never captured usage but still has a remote job id can be read
      // from PBS history (`qstat -x`; array jobs via the -t sub-job sum), so re-poll it once more to fill
      // usage instead of leaving the Explore/usage view blank. Once usage is written it is no longer
      // selected; a run whose history genuinely has none keeps retrying (bounded by the track limit) —
      // acceptable for the small terminal-without-usage tail.
      if (!record.usage && record.remote_job_id && record.platform === PLATFORM.HPC) {
        active.push(record);
      } else {
        skippedTerminal += 1;
      }
    } else if (!record.remote_job_id) {
      if (record.status === "submitting" && pickIhpcReconciler(record) === "campaign") {
        // P1 (crash-safety): a CAMPAIGN run left at the durable pre-launch marker ("submitting" with a
        // campaign_id but no remote_job_id yet) is ACTIVELY RECONCILABLE — the launch seam wrote the
        // marker before its SSH side effects, and the campaign path can read the node STATE (keyed by
        // campaign_id) to advance it. So poll it through reconcileRunStatus like any active run rather
        // than dropping it into the manual needs_reconciliation bucket (unlike the single-run path below,
        // where there is no resident STATE to reconcile against without a remote_job_id).
        active.push(record);
      } else if (record.status === "submitting") {
        // An in-flight single-run submission reached the remote qsub/start but no remote_job_id was ever
        // recorded — the job may be live on the cluster. Surface it for manual reconciliation
        // (qstat / cnode) rather than silently skipping it or blindly resubmitting.
        needsReconciliation.push({
          run_id: record.run_id,
          project: record.project ?? UNASSIGNED_PROJECT,
          message:
            "status 'submitting' with no remote_job_id: a submission may have reached the scheduler; verify on the cluster before resubmitting"
        });
      } else {
        skippedPlanned += 1;
      }
    } else {
      active.push(record);
    }
  }
  active.sort(
    (left, right) => right.created_at.localeCompare(left.created_at) || left.run_id.localeCompare(right.run_id)
  );

  const limit = Math.min(input.limit ?? DEFAULT_TRACK_LIMIT, MAX_TRACK_LIMIT);
  const truncated = active.length > limit;
  const selected = active.slice(0, limit);

  // P1-a: the per-run reconcile MUST NOT probe node GPU itself during a sweep — the adopted-iHPC OBSERVE
  // path would otherwise probe per run (no de-dup, and even when nodeUsage is off). We suppress it here
  // (nodeUsageProbe:false) and do ONE de-duped per-node GPU pass below, so default-off keeps the prior
  // cost and nodeUsage:true reads each distinct node at most once.
  const reconcileOptions: JobOperationOptions = { ...options, nodeUsageProbe: false };
  const tracked = await mapBounded(selected, TRACK_CONCURRENCY, (record) =>
    trackOneRun(record, now, timeoutMs, executor, reconcileOptions)
  );

  // P1-a: opt-in node-GPU fusion. For each ACTIVE iHPC entry that resolved a node, attach that node's
  // live GPU snapshot, probing each DISTINCT node at most once per sweep (a node shared by several runs is
  // read once and the result shared). Fail-closed: probeNodeUsage returns node-unverifiable (empty gpus[])
  // for a node it cannot read, and a single node's failure never aborts the sweep.
  if (input.nodeUsage) {
    await attachNodeGpuUsage(tracked, selected, executor, timeoutMs, options);
  }

  // Digest of runs that crossed from non-terminal into a terminal state during this sweep, so the
  // caller can immediately triage (retry/investigate) the ones that just finished or failed.
  const terminalTransitions = tracked
    .filter((entry) => !terminal.has(entry.previous_status) && terminal.has(entry.status))
    .map((entry) => ({ run_id: entry.run_id, project: entry.project, status: entry.status }));

  // P4: a sweep-level VPN-down hint — set when ANY tracked run failed network-unreachable, so a caller
  // sees the VPN is down without scanning every row. The per-run hints stay on each entry. All entries
  // share the same canonical NETWORK_DROP_HINT wording, so the first one is representative.
  const sweepNetworkHint = tracked.find((entry) => entry.network_hint)?.network_hint;

  return {
    tracking: {
      mode: "read-only",
      observed_at: now.toISOString(),
      counts: {
        polled: tracked.length,
        transitioned: tracked.filter((entry) => entry.transitioned).length,
        errors: tracked.filter((entry) => entry.error !== undefined).length,
        skipped_planned: skippedPlanned,
        skipped_terminal: skippedTerminal,
        newly_terminal: terminalTransitions.length,
        needs_reconciliation: needsReconciliation.length
      },
      truncated,
      tracked,
      terminal_transitions: terminalTransitions,
      needs_reconciliation: needsReconciliation,
      ...(sweepNetworkHint ? { network_hint: sweepNetworkHint } : {})
    }
  };
}

async function trackOneRun(
  record: RunRecord,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<JobTrackEntry> {
  const previousStatus = record.status;
  try {
    const status = await reconcileRunStatus(record, now, timeoutMs, executor, options);
    return {
      run_id: status.run_id,
      profile_id: status.profile_id,
      platform: status.platform,
      project: record.project ?? UNASSIGNED_PROJECT,
      remote_job_id: status.remote_job_id,
      previous_status: previousStatus,
      status: status.status,
      ...(status.scheduler_state ? { scheduler_state: status.scheduler_state } : {}),
      ...(status.node ? { node: status.node } : {}),
      ...(status.usage !== undefined ? { usage: status.usage } : {}),
      transitioned: previousStatus !== status.status,
      summary: status.summary,
      // P4: carry the per-run VPN-down classification from the reconciled status onto the tracked entry.
      ...(status.error_kind ? { error_kind: status.error_kind } : {}),
      ...(status.network_hint ? { network_hint: status.network_hint } : {}),
      ...(status.evidence_path ? { evidence_path: status.evidence_path } : {})
    };
  } catch (error) {
    const message = redactCommand(error instanceof Error ? error.message : String(error));
    return {
      run_id: record.run_id,
      profile_id: record.profile_id,
      platform: record.platform,
      project: record.project ?? UNASSIGNED_PROJECT,
      remote_job_id: record.remote_job_id ?? "",
      previous_status: previousStatus,
      status: previousStatus,
      transitioned: false,
      summary: `tracking failed: ${message}`,
      error: message
    };
  }
}

// P1-a: the de-duped per-node GPU pass for jobs.track {nodeUsage:true}. For every ACTIVE iHPC entry that
// resolved a compute node, attach that node's live GPU snapshot (probeNodeUsage). A node is probed AT MOST
// ONCE per sweep (keyed by profile_id + node id, since the two-hop seam routes a node id through its
// profile's host) and the result is shared across every run on it. Fail-closed end to end: probeNodeUsage
// returns a `node-unverifiable` view (empty gpus[]) for any node it cannot read, and each probe is wrapped
// so a single node's failure becomes a node-unverifiable view rather than aborting the whole sweep. PBS
// entries (no compute node) and entries that errored out (no node) are left untouched.
async function attachNodeGpuUsage(
  tracked: JobTrackEntry[],
  selected: RunRecord[],
  executor: JobCommandExecutor,
  timeoutMs: number,
  options: JobOperationOptions
): Promise<void> {
  const cache = new Map<string, Promise<NodeUsageView>>();
  const profiles = new Map<string, ComputeProfile>();
  const profileFor = (profileId: string): ComputeProfile => {
    let profile = profiles.get(profileId);
    if (!profile) {
      profile = getProfile(profileId, options.configPath);
      profiles.set(profileId, profile);
    }
    return profile;
  };
  await mapBounded(tracked, TRACK_CONCURRENCY, async (entry) => {
    if (entry.platform !== PLATFORM.IHPC || !entry.node || entry.error !== undefined) {
      return;
    }
    const node = entry.node;
    const key = `${entry.profile_id}::${node}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = (async (): Promise<NodeUsageView> => {
        try {
          return await probeNodeUsage(profileFor(entry.profile_id), node, executor, timeoutMs);
        } catch (error) {
          // Fail-closed: a thrown probe (bad profile/token) is reported as node-unverifiable for THIS
          // node only — never a fabricated reading and never an aborted sweep.
          const reason = redactCommand(error instanceof Error ? error.message : String(error));
          return { node, status: "node-unverifiable", gpus: [], probed_at: new Date().toISOString(), reason };
        }
      })();
      cache.set(key, pending);
    }
    entry.gpu_usage = await pending;
  });
}

// Run an async mapper over items with at most `concurrency` promises in flight, preserving order.
async function mapBounded<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export interface JobUsageResult {
  mode: "read-only";
  run_id: string;
  profile_id: string;
  platform: Platform;
  remote_job_id: string | null;
  observed_at: string;
  usage: UsageMetrics | null;
  summary: string;
  command?: { program: string; args: string[]; remote_argv: string[] };
}

// Read-only PBS usage accounting for one run: core-hours, GPU-hours, and CPU efficiency parsed from
// `qstat -x -f` (which carries resources_used.* for finished and running jobs). iHPC supervised runs
// have no batch scheduler, so usage is null there.
export async function getJobUsage(
  input: { runId: string },
  options: JobOperationOptions = {}
): Promise<{ usage: JobUsageResult }> {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultJobCommandExecutor;
  const runRecord = readRunRecord(input.runId, options.auditDir);
  const profile = getProfile(runRecord.profile_id, options.configPath);

  const base = {
    mode: "read-only" as const,
    run_id: runRecord.run_id,
    profile_id: runRecord.profile_id,
    platform: runRecord.platform,
    remote_job_id: runRecord.remote_job_id,
    observed_at: now.toISOString()
  };

  if (runRecord.platform === PLATFORM.IHPC) {
    return { usage: { ...base, usage: null, summary: "iHPC supervised runs have no PBS scheduler accounting" } };
  }
  if (profile.platform !== PLATFORM.HPC || runRecord.platform !== PLATFORM.HPC) {
    throw new Error("jobs.usage currently supports UTS HPC PBS run records only");
  }

  const remoteJobId = requireRemoteJobId(runRecord);
  // A finished PBS array job keeps resources_used on its sub-jobs, not the array parent, so expand
  // sub-jobs with -t for array ids (then sum them); a plain job reads its parent record directly.
  const isArrayJob = isPbsArrayJobId(remoteJobId);
  const remoteArgv = isArrayJob
    ? ["qstat", "-x", "-t", "-f", remoteJobId]
    : ["qstat", "-x", "-f", remoteJobId];
  assertAllowedHpcJobRemoteArgv(remoteArgv);
  const args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
  const result = await executor("ssh", args, timeoutMs);

  const usage = result.exitCode === 0 ? parseQstatUsageMetrics(result.stdout, isArrayJob) : null;
  const summary = usage
    ? `Used ${usage.core_hours} core-hours${usage.ngpus > 0 ? `, ${usage.gpu_hours} GPU-hours` : ""}` +
      (usage.cpu_efficiency_percent !== null ? `, ${usage.cpu_efficiency_percent}% CPU efficiency` : "")
    : result.exitCode === 0
      ? "No PBS usage is recorded for this job yet"
      : `qstat -x failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`;

  return {
    usage: {
      ...base,
      remote_job_id: remoteJobId,
      usage,
      summary,
      command: redactedCommand(args, profile.login.host_alias, remoteArgv, [remoteJobId])
    }
  };
}

export async function getJobLogs(
  input: { runId: string; stream?: "stdout" | "stderr" | "both"; maxBytes?: number },
  options: JobOperationOptions = {}
): Promise<{ logs: JobLogsResult }> {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const maxBytes = normalizeLogBytes(input.maxBytes);
  const executor = options.executor ?? defaultJobCommandExecutor;
  const runRecord = readRunRecord(input.runId, options.auditDir);
  // P2-a: an adopted/foreign iHPC run is observe-only — it has no supervisor log paths to read. Refuse
  // with the clear, specific message BEFORE requireRemoteJobId / any SSH, instead of the generic
  // supervisor-missing throw. (jobs.status takes the observe path; logs stay unavailable.)
  if (isAdoptedObservableIhpc(runRecord)) {
    throw new Error(ADOPTED_IHPC_OBSERVE_ONLY);
  }
  const remoteJobId = requireRemoteJobId(runRecord);
  const profile = getProfile(runRecord.profile_id, options.configPath);
  if (runRecord.platform === PLATFORM.IHPC) {
    return getIhpcJobLogs(runRecord, profile, remoteJobId, input.stream ?? "both", maxBytes, now, timeoutMs, executor, options);
  }
  if (profile.platform !== PLATFORM.HPC || runRecord.platform !== PLATFORM.HPC) {
    throw new Error("jobs.logs currently supports UTS HPC PBS run records only");
  }
  // P2-b: an ADOPTED bare-qsub PBS job (an `adoption` block, never planned, so NO saved plan/plan_hash)
  // completes the adopt->control chain for logs: it has no plan artifact to read -o/-e from, so derive the
  // stdout/stderr file paths from `qstat -f` (Output_Path / Error_Path) and tail them via the SAME bounded
  // allowlisted `tail -c ... -- <path>` the plan path uses. Gated SOLELY on the adoption-block PRESENCE on
  // an HPC record (mirrors jobs.cancel's isAdoptedHpcCancel) — never on "plan_hash happens to be absent".
  if (isAdoptedHpcLogs(runRecord)) {
    return getAdoptedPbsJobLogs(runRecord, profile, remoteJobId, input.stream ?? "both", maxBytes, now, timeoutMs, executor, options);
  }
  const plan = readVerifiedPlan(input.runId, options.planDir);
  if (plan.platform !== PLATFORM.HPC) {
    throw new Error("jobs.logs currently supports UTS HPC PBS plan artifacts only");
  }
  const logPaths = parsePbsLogPaths(plan.script);
  const requestedStreams = input.stream === "stdout" ? ["stdout"] : input.stream === "stderr" ? ["stderr"] : ["stdout", "stderr"];
  const streams: JobLogStreamResult[] = [];

  for (const stream of requestedStreams as Array<"stdout" | "stderr">) {
    const logPath = logPaths[stream];
    if (!logPath) {
      streams.push({
        stream,
        path: "",
        status: "failed",
        content: "",
        truncated: false,
        summary: `No ${stream} path was found in the saved PBS plan`,
        command: {
          program: "ssh",
          args: [],
          remote_argv: []
        }
      });
      continue;
    }
    const remoteArgv = ["tail", "-c", String(maxBytes), "--", logPath];
    assertAllowedHpcJobRemoteArgv(remoteArgv);
    const args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
    const result = await executor("ssh", args, timeoutMs);
    const content = redactAndLimitLog(result.stdout, maxBytes);
    streams.push({
      stream,
      path: maskUserRootPath(logPath, userRootPrefixes(profile)),
      status: result.exitCode === 0 ? "passed" : "failed",
      content: content.text,
      truncated: content.truncated,
      summary:
        result.exitCode === 0
          ? `${stream} log tail completed`
          : `${stream} log tail failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`,
      command: redactedCommand(args, profile.login.host_alias, remoteArgv, [logPath])
    });
  }

  const evidencePath = writeJobEvidence(
    "logs",
    runRecord.run_id,
    now,
    {
      max_bytes: maxBytes,
      streams
    },
    options.evidenceDir
  );
  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "pbs-logs",
      summary: `Fetched ${requestedStreams.join(" and ")} log tail for UTS HPC PBS job ${remoteJobId}`,
      redacted_command: `ssh <profile-host> tail -c ${maxBytes} -- <plan-log-path>`
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    logs: {
      mode: "read-only",
      run_id: runRecord.run_id,
      profile_id: runRecord.profile_id,
      platform: runRecord.platform,
      remote_job_id: remoteJobId,
      observed_at: now.toISOString(),
      max_bytes: maxBytes,
      streams,
      run_record_path: runRecordPath,
      evidence_path: evidencePath
    }
  };
}

// P2-b: an ADOPTED bare-qsub PBS run gets jobs.logs even though it has NO saved plan — the adopt path
// (pbsRowToRunRecord) never wrote a plan artifact, so the -o/-e directives are not available locally. We
// discriminate exactly like jobs.cancel's adopted-cancel gate: the `adoption` block's PRESENCE on an HPC
// record (NOT "plan_hash happens to be absent" — a plain PBS record lacking a plan still takes the plan
// path and fails honestly). A planned run that ALSO has an adoption block keeps its plan-based path because
// plan_hash is present; the relaxed derive-from-qstat path is only for a genuinely plan-less adopted job.
export function isAdoptedHpcLogs(runRecord: RunRecord): boolean {
  return runRecord.platform === PLATFORM.HPC && Boolean(runRecord.adoption) && !runRecord.plan_hash;
}

// The READ-ONLY logs path for an adopted PBS run (spec P2-b). It derives the stdout/stderr file paths from
// `qstat -f <id>` (the Output_Path / Error_Path attributes PBS reports, format `host:/abs/path`) instead
// of a saved plan, then tails each via the SAME bounded `tail -c <n> -- <path>` allowlisted remote command
// the plan path uses. No new SSH assembler: it reuses sshJobArgs + assertAllowedHpcJobRemoteArgv for both
// the qstat-f read and the tail. Every derived path is shell-safety + profile-root confined (the SAME
// confinement the supervised iHPC path applies in requireIhpcSupervisor) BEFORE it can enter a tail argv;
// a path that fails confinement returns a clear FAILED stream (never a silent skip, never a tail).
async function getAdoptedPbsJobLogs(
  runRecord: RunRecord,
  profile: ComputeProfile,
  remoteJobId: string,
  stream: "stdout" | "stderr" | "both",
  maxBytes: number,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<{ logs: JobLogsResult }> {
  // (1) read the live record so PBS reports Output_Path / Error_Path. Same allowlisted `qstat -f <id>`
  // shape + sshJobArgs the status path uses; no history (-x) read — an adopted job we are tailing is one
  // we still want the live -o/-e attributes for (they survive into the historical record too, but the
  // live read is the common case and matches jobs.status's adopted-reconcile probe).
  const qstatArgv = ["qstat", "-f", remoteJobId];
  assertAllowedHpcJobRemoteArgv(qstatArgv);
  const qstatArgs = sshJobArgs(profile.login.host_alias, timeoutMs, qstatArgv);
  const qstatResult = await executor("ssh", qstatArgs, timeoutMs);
  if (qstatResult.exitCode !== 0) {
    throw new Error(
      `qstat -f for adopted PBS job ${remoteJobId} failed: ${summarizeBareFailure(qstatResult.stderr, qstatResult.exitCode, qstatResult.timedOut)}`
    );
  }
  const reportedPaths = parsePbsAttrLogPaths(qstatResult.stdout);
  const userPrefixes = userRootPrefixes(profile);
  const roots = resolvedProfileRoots(profile);
  const requestedStreams = stream === "stdout" ? ["stdout"] : stream === "stderr" ? ["stderr"] : ["stdout", "stderr"];
  const streams: JobLogStreamResult[] = [];

  for (const name of requestedStreams as Array<"stdout" | "stderr">) {
    const reported = reportedPaths[name];
    if (!reported) {
      // Output_Path / Error_Path absent or unparseable for this stream — return what's available with a
      // clear note rather than failing the whole call (the other stream may still be tailable).
      streams.push(failedAdoptedLogStream(name, "", `No ${name === "stdout" ? "Output_Path" : "Error_Path"} was reported by qstat -f for this adopted PBS job`));
      continue;
    }
    // Confinement: the reported path is EXTERNAL (a foreign job can write -o/-e anywhere). Apply the SAME
    // shell-safety + profile-root confinement the supervised iHPC path applies. A path that fails is a
    // clear FAILED stream, never a silent skip and never a tail of an unconfined path.
    const confinement = confineAdoptedLogPath(reported, roots);
    if (!confinement.ok) {
      streams.push(failedAdoptedLogStream(name, reported, confinement.reason));
      continue;
    }
    const logPath = confinement.path;
    const remoteArgv = ["tail", "-c", String(maxBytes), "--", logPath];
    assertAllowedHpcJobRemoteArgv(remoteArgv);
    const args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
    const result = await executor("ssh", args, timeoutMs);
    const content = redactAndLimitLog(result.stdout, maxBytes);
    streams.push({
      stream: name,
      path: maskUserRootPath(logPath, userPrefixes),
      status: result.exitCode === 0 ? "passed" : "failed",
      content: content.text,
      truncated: content.truncated,
      summary:
        result.exitCode === 0
          ? `${name} log tail completed`
          : `${name} log tail failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`,
      command: redactedCommand(args, profile.login.host_alias, remoteArgv, [logPath])
    });
  }

  const evidencePath = writeJobEvidence(
    "logs",
    runRecord.run_id,
    now,
    {
      max_bytes: maxBytes,
      derived_from: "qstat-f",
      streams
    },
    options.evidenceDir
  );
  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "pbs-logs",
      summary: `Fetched ${requestedStreams.join(" and ")} log tail for adopted UTS HPC PBS job ${remoteJobId} (paths from qstat -f)`,
      redacted_command: `ssh <profile-host> qstat -f <remote-job-id>; ssh <profile-host> tail -c ${maxBytes} -- <plan-log-path>`
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    logs: {
      mode: "read-only",
      run_id: runRecord.run_id,
      profile_id: runRecord.profile_id,
      platform: runRecord.platform,
      remote_job_id: remoteJobId,
      observed_at: now.toISOString(),
      max_bytes: maxBytes,
      streams,
      run_record_path: runRecordPath,
      evidence_path: evidencePath
    }
  };
}

function failedAdoptedLogStream(stream: "stdout" | "stderr", reportedPath: string, summary: string): JobLogStreamResult {
  return {
    stream,
    // Never echo an unconfined/foreign path back unmasked; the redacted command below carries no path.
    path: reportedPath ? maskUserRootPath(reportedPath) : "",
    status: "failed",
    content: "",
    truncated: false,
    summary: redactCommand(summary),
    command: { program: "ssh", args: [], remote_argv: [] }
  };
}

export async function cancelJob(
  input: { runId: string; approvalId: string },
  options: JobOperationOptions = {}
): Promise<{ cancellation: JobCancelResult }> {
  assertSafeRunId(input.runId);
  assertSafeApprovalId(input.approvalId);
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultJobCommandExecutor;
  const runRecord = readRunRecord(input.runId, options.auditDir);
  // P2-a: an adopted/foreign iHPC run is observe-only — the plugin holds no supervisor cancel path for a
  // process it never launched. Refuse with the clear, specific message (cancel on the node directly)
  // BEFORE requireRemoteJobId / the approval gate / any SSH, instead of the generic plan_hash throw.
  if (isAdoptedObservableIhpc(runRecord)) {
    throw new Error(ADOPTED_IHPC_OBSERVE_ONLY);
  }
  const remoteJobId = requireRemoteJobId(runRecord);
  const profile = getProfile(runRecord.profile_id, options.configPath);
  if (runRecord.platform === PLATFORM.IHPC) {
    return cancelIhpcJob(runRecord, profile, remoteJobId, input.approvalId, now, timeoutMs, executor, options);
  }
  if (runRecord.platform !== PLATFORM.HPC) {
    throw new Error("jobs.cancel currently supports UTS HPC PBS run records only");
  }
  if (["finished", "failed", "cancelled"].includes(runRecord.status)) {
    throw new Error(`Run ${runRecord.run_id} is ${runRecord.status}; terminal runs cannot be cancelled`);
  }
  if (profile.platform !== runRecord.platform) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but run record is ${runRecord.platform}`);
  }
  // Option A — an ADOPTED bare-qsub PBS job (the plugin never planned it, so it has NO plan_hash) is
  // cancellable via an approval bound to its ADOPTED IDENTITY (run_id + profile + platform + the run's
  // OWN remote_job_id) instead of the meaningless plan_hash binding. The relaxed path is gated SOLELY on
  // the PRESENCE of a legitimate `adoption` block on an HPC record — never on "plan_hash happens to be
  // absent" (a plain PBS record lacking plan_hash still hits the requirement below). Both real
  // protections are kept: target confinement (qdel still targets the record's own id) + fresh human
  // intent (the approval must still be in the human-decided `approved` state).
  const isAdoptedHpcCancel = Boolean(runRecord.adoption) && runRecord.platform === PLATFORM.HPC;
  if (!isAdoptedHpcCancel && (!runRecord.plan_hash || !runRecord.quota_snapshot_id)) {
    throw new Error("Run record must include plan_hash and quota_snapshot_id before cancellation");
  }
  const approval = approvalStatus({ approvalId: input.approvalId }, { approvalDir: options.approvalDir, now }).approval;
  if (isAdoptedHpcCancel) {
    assertAdoptedCancelApproval(approval, {
      runId: runRecord.run_id,
      profileId: runRecord.profile_id,
      platform: runRecord.platform,
      remoteJobId,
      identityMessage: "Approval does not match the adopted run record identity",
      remoteJobIdMessage: "Approval remote_job_id does not match the adopted run record"
    });
  } else {
    assertCancelApproval(approval, runRecord);
  }

  const remoteArgv = ["qdel", remoteJobId];
  assertAllowedHpcJobRemoteArgv(remoteArgv);
  const args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
  const result = await executor("ssh", args, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(`qdel cancellation failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  const evidencePath = writeJobEvidence(
    "cancel",
    runRecord.run_id,
    now,
    {
      command: redactedCommand(args, profile.login.host_alias, remoteArgv, [remoteJobId]),
      exit_code: result.exitCode,
      timed_out: Boolean(result.timedOut),
      stdout: redactCommand(result.stdout),
      stderr: redactCommand(result.stderr)
    },
    options.evidenceDir
  );

  consumeApproval(
    {
      approvalId: approval.approval_id,
      runId: runRecord.run_id,
      profileId: runRecord.profile_id,
      platform: runRecord.platform,
      operation: "jobs.cancel",
      // Adopted cancel: consume binds the remote_job_id (no plan_hash/quota_snapshot to compare).
      // Planned cancel: consume binds plan_hash + quota_snapshot_id, exactly as before.
      ...(isAdoptedHpcCancel
        ? { remoteJobId }
        : { planHash: runRecord.plan_hash, quotaSnapshotId: runRecord.quota_snapshot_id }),
      consumedBy: `jobs.cancel:${remoteJobId}`
    },
    { approvalDir: options.approvalDir, now }
  );

  runRecord.status = "cancelled";
  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "live-cancel",
      summary: `Cancelled UTS HPC PBS job ${remoteJobId}`,
      redacted_command: "ssh <profile-host> qdel <remote-job-id>"
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    cancellation: {
      mode: "live",
      run_id: runRecord.run_id,
      profile_id: runRecord.profile_id,
      platform: runRecord.platform,
      status: "cancelled",
      remote_job_id: remoteJobId,
      approval_id: approval.approval_id,
      ...(runRecord.plan_hash ? { plan_hash: runRecord.plan_hash } : {}),
      ...(runRecord.quota_snapshot_id ? { quota_snapshot_id: runRecord.quota_snapshot_id } : {}),
      cancelled_at: now.toISOString(),
      command: redactedCommand(args, profile.login.host_alias, remoteArgv, [remoteJobId]),
      run_record_path: runRecordPath,
      evidence_path: evidencePath
    }
  };
}

// The discriminator that decides whether a LIVE `qstat -f <id>` failure means the job has GONE from the
// active queue (so we should consult PBS history) vs an indeterminate/transport failure (so we must NOT).
// This is the fail-closed guard for the broadened history fallback:
//   - timeout              -> NOT gone: the job may well be running; the probe just didn't return.
//   - exit 0               -> NOT gone: qstat answered; the job is in the live queue, parse it directly.
//   - SSH transport/auth   -> NOT gone: qstat never ran (ssh exits 255 on connect/auth failure, or the
//     failure                stderr carries an `ssh:`/connection/auth banner instead of qstat output), so
//                            the queue said nothing — treating it as gone would mis-mark a running job.
//   - qstat job-gone signal -> GONE: qstat itself ran and said the id is no longer in the live queue
//                            ("Unknown Job Id", "Job has finished", "use -x"/"-H", "not in queue"). Only
//                            this case fires the one-shot `qstat -x -f` history read.
// We match the job-gone signal POSITIVELY (rather than enumerating every transport error) so an
// unrecognized stderr defaults to NOT-gone — the safe direction.
export function pbsLiveQstatSaysJobGone(result: {
  exitCode: number | null;
  stderr: string;
  timedOut?: boolean;
}): boolean {
  if (result.timedOut || result.exitCode === 0) {
    return false;
  }
  const stderr = result.stderr ?? "";
  // ssh exits 255 on a transport/auth failure; an `ssh:` banner or a connection/auth message means the
  // remote qstat never executed. Fail closed — this is not a queue-miss.
  if (result.exitCode === 255 || /\bssh:|connection (refused|closed|timed out)|could not resolve hostname|permission denied|host key verification/i.test(stderr)) {
    return false;
  }
  // PBS qstat's own "this id is no longer in the live queue" wording. `qstat:` anchors it to qstat's
  // output (not a generic error), and the alternatives cover the instant-fail "Unknown Job Id" case the
  // narrow trigger missed plus the finished/use-history wording.
  return /unknown job id|job has finished|use -x\b|-H\b|not in queue|no such job/i.test(stderr);
}

export function parseQstatStatus(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut?: boolean
): { status: RunRecord["status"]; schedulerState?: string; summary: string } {
  if (timedOut) {
    return { status: "unknown", summary: "qstat timed out" };
  }
  if (exitCode !== 0) {
    return { status: "unknown", summary: `qstat failed: ${summarizeBareFailure(stderr, exitCode, timedOut)}` };
  }
  // The record -> field-map read is the shared mechanism (accounting.parseQstatFields); the
  // PBS-state -> lifecycle mapping below (and every summary string) stays here as policy. The
  // single-letter slice + uppercase preserves the prior raw-regex behaviour for the job_state value.
  const fields = parseQstatFields(stdout);
  const state = fields.get("job_state")?.trim().charAt(0).toUpperCase();
  if (!state) {
    return { status: "unknown", summary: "qstat output did not include job_state" };
  }
  if (["Q", "H", "W", "T"].includes(state)) {
    return { status: "submitted", schedulerState: state, summary: `PBS job is queued or held (${state})` };
  }
  // B = a PBS Pro ARRAY job that has begun (one or more subjobs are running); it is an active/running
  // state, NOT an unmapped one — without this, a healthy running array job regresses to 'unknown'.
  if (["R", "E", "S", "B"].includes(state)) {
    return { status: "running", schedulerState: state, summary: `PBS job is active (${state})` };
  }
  if (["C", "F"].includes(state)) {
    const exitStatusText = fields.get("Exit_status")?.trim();
    const exitStatus = exitStatusText === undefined ? null : Number(exitStatusText);
    if (exitStatus !== null && Number.isFinite(exitStatus) && exitStatus !== 0) {
      return { status: "failed", schedulerState: state, summary: `PBS job completed with nonzero exit ${exitStatus}` };
    }
    return { status: "finished", schedulerState: state, summary: `PBS job is complete (${state})` };
  }
  return { status: "unknown", schedulerState: state, summary: `PBS job_state ${state} is not mapped yet` };
}

// A run is in a DEFINITE (authoritative) ledger state when the scheduler/supervisor has told us, at
// least once, where it actually is. The non-definite states are the pre-observation marker
// ("planned"/"submitting") and the indeterminate observation itself ("unknown"). An 'unknown' probe
// (timeout / nonzero qstat / unparseable) must never clobber one of these definite states.
const DEFINITE_LEDGER_STATUSES = new Set<RunRecord["status"]>([
  "submitted",
  "running",
  "finished",
  "failed",
  "cancelled"
]);

// Status-reconcile transition: apply the terminal-state clamp policy (kept here, NOT folded — only a
// non-terminal record advances, except an observed 'finished' may still land), then route the evidence
// tail through the single-write seam and RETURN the written path. Returning the path lets the caller use
// it directly instead of issuing a second updateRunRecord (the stray write that bumped rev by 2 per poll).
//
// First principle (audit P0): an INDETERMINATE observation must never overwrite a DEFINITE ledger state.
// When the probe could not determine state (observedStatus === "unknown") and the record already holds a
// definite status, we KEEP the prior status and record the failed probe as an `observation_failed` event
// (not a status regression) so the failure is visible without the ledger lying about the run's state. A
// first-ever 'unknown' (no definite prior, e.g. a "submitting" record) is still allowed to land. A
// DEFINITE terminal/failed observation is never suppressed — only 'unknown' is treated as non-authoritative.
function updateRunStatus(
  runRecord: RunRecord,
  observedStatus: RunRecord["status"],
  now: Date,
  summary: string,
  redactedCommandText: string,
  eventKind: string,
  artifactPath: string,
  auditDir: string | undefined
): string {
  if (observedStatus === "unknown" && DEFINITE_LEDGER_STATUSES.has(runRecord.status)) {
    // Non-authoritative probe: preserve the prior definite status, but log the failed observation so it
    // is auditable. The status itself is left untouched.
    return recordOperationEvidence(
      runRecord,
      {
        kind: "observation_failed",
        summary: `Probe could not determine state; kept prior status '${runRecord.status}' (${summary})`,
        redacted_command: redactedCommandText
      },
      artifactPath,
      now,
      auditDir
    );
  }
  const terminal = new Set(["finished", "failed", "cancelled"]);
  if (!terminal.has(runRecord.status) || observedStatus === "finished") {
    runRecord.status = observedStatus;
  }
  return recordOperationEvidence(
    runRecord,
    { kind: eventKind, summary, redacted_command: redactedCommandText },
    artifactPath,
    now,
    auditDir
  );
}

export const IHPC_STATUS_PY = String.raw`${pyImports(["base64", "json", "os", "sys"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("status")}
pid = spec.get("pid")
if not isinstance(pid, int) or pid <= 1:
    fail("invalid pid")

try:
    os.kill(pid, 0)
    alive = True
except ProcessLookupError:
    alive = False
except PermissionError:
    alive = True

print(json.dumps({"alive": alive}, sort_keys=True))
`;

export const IHPC_LOGS_PY = String.raw`${pyImports(["base64", "json", "os", "sys"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("logs")}
max_bytes = spec.get("max_bytes")
streams = spec.get("streams")
if not isinstance(max_bytes, int) or max_bytes < 1:
    fail("invalid max_bytes")
if not isinstance(streams, list):
    fail("invalid streams")

results = []
for entry in streams:
    if not isinstance(entry, dict):
        fail("invalid stream entry")
    name = entry.get("stream")
    raw_path = entry.get("path")
    if name not in ("stdout", "stderr") or not isinstance(raw_path, str) or not raw_path.startswith("/"):
        fail("invalid stream path")
    path = os.path.expandvars(raw_path)
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > max_bytes:
                handle.seek(-max_bytes, os.SEEK_END)
            data = handle.read(max_bytes + 1)
        truncated = size > max_bytes or len(data) > max_bytes
        if len(data) > max_bytes:
            data = data[-max_bytes:]
        content = data.decode("utf-8", errors="replace")
        results.append({
            "stream": name,
            "status": "passed",
            "content": content,
            "truncated": truncated,
            "summary": f"{name} log tail completed",
        })
    except FileNotFoundError:
        results.append({
            "stream": name,
            "status": "failed",
            "content": "",
            "truncated": False,
            "summary": f"{name} log path was not found",
        })
    except Exception as exc:
        results.append({
            "stream": name,
            "status": "failed",
            "content": "",
            "truncated": False,
            "summary": f"{name} log tail failed: {exc}",
        })

print(json.dumps({"streams": results}, sort_keys=True))
`;

export const IHPC_CANCEL_PY = String.raw`${pyImports(["base64", "json", "os", "signal", "sys"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("cancel")}
pid = spec.get("pid")
if not isinstance(pid, int) or pid <= 1:
    fail("invalid pid")

try:
    os.killpg(pid, signal.SIGTERM)
    result = "cancelled"
except ProcessLookupError:
    result = "already_stopped"
except PermissionError as exc:
    fail(f"permission denied: {exc}")

print(json.dumps({"result": result}, sort_keys=True))
`;

async function reconcileIhpcRunStatus(
  runRecord: RunRecord,
  profile: ComputeProfile,
  remoteJobId: string,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<JobStatusResult> {
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but run record is uts-ihpc`);
  }
  const supervisor = requireIhpcSupervisor(runRecord, profile);
  const spec = encodeSpec({ pid: supervisor.pid });
  const args = sshSupervisorArgs(profile.login.host_alias, supervisor.node_id, timeoutMs, spec);
  const result = await executor("ssh", args, timeoutMs, IHPC_STATUS_PY);
  const parsed = parseIhpcStatus(result.stdout, result.stderr, result.exitCode, result.timedOut);
  const evidencePath = writeJobEvidence(
    "ihpc-status",
    runRecord.run_id,
    now,
    {
      command: redactedIhpcCommand(args, profile.login.host_alias, supervisor.node_id, spec),
      exit_code: result.exitCode,
      timed_out: Boolean(result.timedOut),
      stdout: redactCommand(result.stdout),
      stderr: redactCommand(result.stderr),
      parsed_status: parsed
    },
    options.evidenceDir
  );
  const runRecordPath = updateRunStatus(
    runRecord,
    parsed.status,
    now,
    parsed.summary,
    "ssh <profile-host> ssh <ihpc-compute-node> python3 - <status-spec>",
    "ihpc-status",
    evidencePath,
    options.auditDir
  );

  return {
    mode: "read-only",
    run_id: runRecord.run_id,
    profile_id: runRecord.profile_id,
    platform: runRecord.platform,
    remote_job_id: remoteJobId,
    observed_at: now.toISOString(),
    status: runRecord.status,
    ...(supervisor.node_id ? { node: supervisor.node_id } : {}),
    ...(runRecord.placement ? { placement: runRecord.placement } : {}),
    usage: null,
    summary: parsed.summary,
    // P4: same VPN-down enrichment as the PBS path (the two-hop supervisor probe fails identically when
    // the VPN drops on the outer hop to the login gateway).
    ...networkDropFields(result),
    command: redactedIhpcCommand(args, profile.login.host_alias, supervisor.node_id, spec),
    run_record_path: runRecordPath,
    evidence_path: evidencePath
  };
}

// spec 6 C: an iHPC run that belongs to a campaign reconciles via the node STATE seam (one read of
// state.json), not the per-pid IHPC_STATUS_PY path. A single non-campaign iHPC run keeps the legacy
// per-pid path (the fast-path behavior, spec 6 D1).
export function pickIhpcReconciler(runRecord: { platform: string; campaign_id?: string }): "campaign" | "per-pid" {
  return runRecord.platform === PLATFORM.IHPC && runRecord.campaign_id ? "campaign" : "per-pid";
}

// Thin adapter: build reconcileIhpcCampaign's injected deps from the jobs.ts SSH/audit primitives, run
// it for THIS run, and map the resulting transition back to a JobStatusResult. readState reads the whole
// state.json once (IHPC_STATE_READ_PY); persistRunRecord folds the mapped status into the existing run
// record; relaunchProgressor is a no-op keep-pid here (the full dead-progressor adopt+relaunch is the
// batch path's job, Phase D). The supervisor node_id is the only field this path needs (campaign
// supervisor paths are slot-dir based and validated by the launch/adopt paths, not the per-pid contract).
async function reconcileIhpcCampaignRunStatus(
  runRecord: RunRecord,
  profile: ComputeProfile,
  remoteJobId: string,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<JobStatusResult> {
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but run record is uts-ihpc`);
  }
  // P1 (crash-safety): a launched run carries the node on supervisor.node_id; a run still at the durable
  // pre-launch marker has no supervisor yet (the progressor pid is unknown pre-launch), so fall back to
  // placement.node_id — the launch seam records the target node there before the SSH side effects.
  const node = runRecord.supervisor?.node_id ?? runRecord.placement?.node_id;
  if (!node || !isSafeRemoteToken(node)) {
    throw new Error(`Run ${runRecord.run_id} has unsafe or missing iHPC compute node id`);
  }
  const campaignId = runRecord.campaign_id as string;
  const out = await reconcileIhpcCampaign(
    { campaignId, profileId: runRecord.profile_id, profile,
      node,
      // Thread the held record's recorded launch evidence (supervisor.started_at) as started_at_node so
      // the seam can run the anti-pid-reuse agreement check: a node-reported running pid is only believed
      // when its freshly-reported started_at_node matches what we recorded (spec 2.5).
      runRecords: [{ run_id: runRecord.run_id, status: runRecord.status,
                     ...(runRecord.supervisor?.started_at ? { started_at_node: runRecord.supervisor.started_at } : {}) }] },
    {
      now,
      readState: async (host, computeNode, cid) => {
        const spec = encodeSpec({ campaign_id: cid, kind: "state" });
        const args = sshSupervisorArgs(host, computeNode, timeoutMs, spec);
        const result = await executor("ssh", args, timeoutMs, IHPC_STATE_READ_PY);
        // parseJsonLastLine already returns the parsed object (whole state.json, one line); no JSON.parse.
        return parseJsonLastLine(result.stdout, "iHPC campaign state");
      },
      // Sibling-safe: merge the (possibly partial) update into the TARGET run's own held record, not
      // always into runRecord — the dead-progressor adopt loop (D) may persist sibling-job records too.
      persistRunRecord: (rec) => {
        const base = rec.run_id === runRecord.run_id ? runRecord : readRunRecordSafe(rec.run_id, options.auditDir);
        updateRunRecord({ ...(base ?? {}), ...rec } as RunRecord, options.auditDir);
      },
      // CP-2: relaunchProgressor (canonical name). jobs.track's single-run reconcile keeps the existing
      // progressor pid; the full dead-progressor adopt+relaunch is exercised by jobs.track's batch path (D).
      relaunchProgressor: async () => ({ pid: runRecord.supervisor?.pid ?? 0 }),
      // D Task 5: the real lineage-proving adopt hook (spec §5c). The dead-progressor branch only fires
      // when progressorAlive is supplied AND reports the progressor dead; this single-run adapter does not
      // supply a liveness probe (Phase C deferred it to the batch path), so wiring the hook here is
      // behavior-neutral today and ready for the batch path to enable. It adopts ONLY lineage-proven jobs
      // (held RunRecord + matching campaign_id), using each slot's wrapper_pid as the supervisor of record.
      adoptLiveJob: makeLineageAdoptHook({ auditDir: options.auditDir }),
      auditDir: options.auditDir
    }
  );
  const transition = out.transitions.find((x) => x.run_id === runRecord.run_id);
  const status = transition?.status ?? runRecord.status;
  const spec = encodeSpec({ campaign_id: campaignId, kind: "state" });
  return {
    mode: "read-only",
    run_id: runRecord.run_id,
    profile_id: runRecord.profile_id,
    platform: runRecord.platform,
    remote_job_id: remoteJobId,
    observed_at: now.toISOString(),
    status,
    node,
    ...(runRecord.placement ? { placement: runRecord.placement } : {}),
    usage: null,
    summary: `reconciled campaign run ${runRecord.run_id} -> ${status}`,
    command: redactedIhpcCommand(sshSupervisorArgs(profile.login.host_alias, node, timeoutMs, spec), profile.login.host_alias, node, spec)
  };
}

async function getIhpcJobLogs(
  runRecord: RunRecord,
  profile: ComputeProfile,
  remoteJobId: string,
  stream: "stdout" | "stderr" | "both",
  maxBytes: number,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<{ logs: JobLogsResult }> {
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but run record is uts-ihpc`);
  }
  const supervisor = requireIhpcSupervisor(runRecord, profile);
  const requestedStreams = stream === "stdout" ? ["stdout"] : stream === "stderr" ? ["stderr"] : ["stdout", "stderr"];
  const spec = encodeSpec({
    max_bytes: maxBytes,
    streams: requestedStreams.map((name) => ({
      stream: name,
      path: name === "stdout" ? supervisor.stdout_path : supervisor.stderr_path
    }))
  });
  const args = sshSupervisorArgs(profile.login.host_alias, supervisor.node_id, timeoutMs, spec);
  const result = await executor("ssh", args, timeoutMs, IHPC_LOGS_PY);
  const streams = parseIhpcLogs(result.stdout, result.stderr, result.exitCode, result.timedOut, maxBytes, {
    stdout: supervisor.stdout_path,
    stderr: supervisor.stderr_path
  }, userRootPrefixes(profile)).map((entry) => ({
    ...entry,
    command: redactedIhpcCommand(args, profile.login.host_alias, supervisor.node_id, spec)
  }));
  const evidencePath = writeJobEvidence(
    "ihpc-logs",
    runRecord.run_id,
    now,
    {
      max_bytes: maxBytes,
      streams
    },
    options.evidenceDir
  );
  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "ihpc-logs",
      summary: `Fetched ${requestedStreams.join(" and ")} log tail for UTS iHPC supervised run ${remoteJobId}`,
      redacted_command: `ssh <profile-host> ssh <ihpc-compute-node> python3 - <logs-spec>`
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    logs: {
      mode: "read-only",
      run_id: runRecord.run_id,
      profile_id: runRecord.profile_id,
      platform: runRecord.platform,
      remote_job_id: remoteJobId,
      observed_at: now.toISOString(),
      max_bytes: maxBytes,
      streams,
      run_record_path: runRecordPath,
      evidence_path: evidencePath
    }
  };
}

async function cancelIhpcJob(
  runRecord: RunRecord,
  profile: ComputeProfile,
  remoteJobId: string,
  approvalId: string,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<{ cancellation: JobCancelResult }> {
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but run record is uts-ihpc`);
  }
  if (["finished", "failed", "cancelled"].includes(runRecord.status)) {
    throw new Error(`Run ${runRecord.run_id} is ${runRecord.status}; terminal runs cannot be cancelled`);
  }
  if (!runRecord.plan_hash || !runRecord.quota_snapshot_id) {
    throw new Error("Run record must include plan_hash and quota_snapshot_id before cancellation");
  }
  const supervisor = requireIhpcSupervisor(runRecord, profile);
  const approval = approvalStatus({ approvalId }, { approvalDir: options.approvalDir, now }).approval;
  assertCancelApproval(approval, runRecord);
  const spec = encodeSpec({ pid: supervisor.pid });
  const args = sshSupervisorArgs(profile.login.host_alias, supervisor.node_id, timeoutMs, spec);
  const result = await executor("ssh", args, timeoutMs, IHPC_CANCEL_PY);
  if (result.exitCode !== 0) {
    throw new Error(`iHPC cancellation failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  const parsed = parseIhpcCancel(result.stdout);
  const evidencePath = writeJobEvidence(
    "ihpc-cancel",
    runRecord.run_id,
    now,
    {
      command: redactedIhpcCommand(args, profile.login.host_alias, supervisor.node_id, spec),
      exit_code: result.exitCode,
      timed_out: Boolean(result.timedOut),
      stdout: redactCommand(result.stdout),
      stderr: redactCommand(result.stderr),
      result: parsed
    },
    options.evidenceDir
  );

  consumeApproval(
    {
      approvalId: approval.approval_id,
      runId: runRecord.run_id,
      profileId: runRecord.profile_id,
      platform: runRecord.platform,
      operation: "jobs.cancel",
      planHash: runRecord.plan_hash,
      quotaSnapshotId: runRecord.quota_snapshot_id,
      consumedBy: `jobs.cancel:${remoteJobId}`
    },
    { approvalDir: options.approvalDir, now }
  );

  runRecord.status = "cancelled";
  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "ihpc-live-cancel",
      summary: `Cancelled UTS iHPC supervised run ${remoteJobId}`,
      redacted_command: "ssh <profile-host> ssh <ihpc-compute-node> python3 - <cancel-spec>"
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    cancellation: {
      mode: "live",
      run_id: runRecord.run_id,
      profile_id: runRecord.profile_id,
      platform: runRecord.platform,
      status: "cancelled",
      remote_job_id: remoteJobId,
      approval_id: approval.approval_id,
      plan_hash: runRecord.plan_hash,
      quota_snapshot_id: runRecord.quota_snapshot_id,
      cancelled_at: now.toISOString(),
      command: redactedIhpcCommand(args, profile.login.host_alias, supervisor.node_id, spec),
      run_record_path: runRecordPath,
      evidence_path: evidencePath
    }
  };
}

// P2-a: an ADOPTED/FOREIGN iHPC run is OBSERVABLE (not history-only) when it carries an `adoption` block,
// is platform iHPC, has NO supervisor block (so it is NOT a lineage-proven run we launched — those keep
// the supervised path), and recorded the operator-observed node+pid at adopt time. The `observed` block
// is the ONLY input the observe path uses; without it (an older adopt record predating P2-a) the run
// stays history-only and requireIhpcSupervisor's clear error still fires.
export function isAdoptedObservableIhpc(runRecord: RunRecord): boolean {
  return (
    runRecord.platform === PLATFORM.IHPC &&
    Boolean(runRecord.adoption) &&
    !runRecord.supervisor &&
    typeof runRecord.observed?.pid === "number" &&
    Boolean(runRecord.observed?.node)
  );
}

// The READ-ONLY observe path for an adopted/foreign iHPC run (spec P2-a). It reports TWO honest
// observations WITHOUT any supervisor metadata:
//   1. process liveness — ships the SAME fixed IHPC_STATUS_PY (`os.kill(pid, 0)`) the supervised path
//      uses, over the SAME two-hop sshSupervisorArgs seam, targeting the operator-recorded observed.pid.
//      alive => running, dead => finished, indeterminate => unknown (which never clobbers a definite
//      prior status, via updateRunStatus's T2 guard).
//   2. the node's live GPU snapshot — REUSES probeNodeUsage (ihpc.node.usage) on observed.node, which is
//      fail-closed: a node it cannot read returns status "node-unverifiable" with an EMPTY gpus[], never
//      a fabricated reading.
// It NEVER reads/writes a log/result path (it has none) — logs/cancel stay observe-only-refused. The
// node id is validated by the seam (sshSupervisorArgs -> isSafeRemoteToken) and by probeNodeUsage's own
// leading-dash + safe-token guard before any SSH; the pid is validated by IHPC_STATUS_PY (pid > 1).
async function reconcileAdoptedIhpcRunStatus(
  runRecord: RunRecord,
  profile: ComputeProfile,
  now: Date,
  timeoutMs: number,
  executor: JobCommandExecutor,
  options: JobOperationOptions
): Promise<JobStatusResult> {
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but run record is uts-ihpc`);
  }
  const observed = runRecord.observed;
  if (!observed || typeof observed.pid !== "number" || !observed.node) {
    // Defensive: the caller (isAdoptedObservableIhpc) already gated this, but never SSH on a bad shape.
    throw new Error(`Run ${runRecord.run_id} is an adopted iHPC run with no observed node+pid to probe`);
  }
  const node = observed.node;
  if (!isSafeRemoteToken(node) || node.startsWith("-")) {
    throw new Error(`Run ${runRecord.run_id} has unsafe or missing iHPC compute node id`);
  }
  if (!Number.isInteger(observed.pid) || observed.pid <= 1) {
    throw new Error(`Run ${runRecord.run_id} has unsafe observed iHPC pid`);
  }

  // (1) liveness — the same fixed os.kill(pid, 0) probe the supervised path ships, over the same seam.
  const spec = encodeSpec({ pid: observed.pid });
  const args = sshSupervisorArgs(profile.login.host_alias, node, timeoutMs, spec);
  const liveResult = await executor("ssh", args, timeoutMs, IHPC_STATUS_PY);
  const parsed = parseIhpcStatus(liveResult.stdout, liveResult.stderr, liveResult.exitCode, liveResult.timedOut);
  const liveness: "alive" | "dead" | "unknown" =
    parsed.status === "running" ? "alive" : parsed.status === "finished" ? "dead" : "unknown";

  // (2) GPU snapshot — REUSE probeNodeUsage (fail-closed: a node it cannot read => node-unverifiable,
  // empty gpus[]). It runs its own NODE_USAGE_PY over the same two-hop seam with the SAME executor.
  // P1-a: the probe is now controllable. jobs.status leaves nodeUsageProbe undefined (probe directly, as
  // before). jobs.track passes `false` to SKIP it (default-off cost) or a de-duped shared probe (when
  // nodeUsage:true) so a node shared by several runs is read at most once per sweep.
  const gpuUsage: NodeUsageView | undefined =
    options.nodeUsageProbe === false
      ? undefined
      : options.nodeUsageProbe
        ? await options.nodeUsageProbe(profile, node)
        : await probeNodeUsage(profile, node, executor, timeoutMs);

  const evidencePath = writeJobEvidence(
    "ihpc-observe",
    runRecord.run_id,
    now,
    {
      command: redactedIhpcCommand(args, profile.login.host_alias, node, spec),
      exit_code: liveResult.exitCode,
      timed_out: Boolean(liveResult.timedOut),
      stdout: redactCommand(liveResult.stdout),
      stderr: redactCommand(liveResult.stderr),
      parsed_status: parsed,
      liveness,
      gpu_status: gpuUsage ? gpuUsage.status : "skipped",
      gpu_count: gpuUsage ? gpuUsage.gpus.length : 0
    },
    options.evidenceDir
  );
  const runRecordPath = updateRunStatus(
    runRecord,
    parsed.status,
    now,
    `adopted iHPC observe: pid ${liveness}; GPU ${gpuUsage ? gpuUsage.status : "skipped"}`,
    "ssh <profile-host> ssh <ihpc-compute-node> python3 - <observe-spec>",
    "ihpc-observe",
    evidencePath,
    options.auditDir
  );

  return {
    mode: "read-only",
    run_id: runRecord.run_id,
    profile_id: runRecord.profile_id,
    platform: runRecord.platform,
    remote_job_id: runRecord.remote_job_id ?? "",
    observed_at: now.toISOString(),
    status: runRecord.status,
    node,
    ...(runRecord.placement ? { placement: runRecord.placement } : {}),
    usage: null,
    liveness,
    ...(gpuUsage ? { gpu_usage: gpuUsage } : {}),
    summary: `adopted iHPC run observed: recorded pid is ${liveness}; node GPU snapshot is ${gpuUsage ? gpuUsage.status : "not probed"}`,
    // Same VPN-down enrichment as the supervised path — the liveness hop fails identically when the VPN
    // drops on the outer hop to the login gateway.
    ...networkDropFields(liveResult),
    command: redactedIhpcCommand(args, profile.login.host_alias, node, spec),
    run_record_path: runRecordPath,
    evidence_path: evidencePath
  };
}

// P2-a: the clear, specific refusal for jobs.logs / jobs.cancel on an adopted/foreign iHPC run. These
// genuinely need supervisor log/metadata paths that an externally-started process does not expose, so
// they stay unavailable — but the operator gets an ACTIONABLE message (observe-only; cancel on the node
// directly) instead of the generic "does not include iHPC supervisor metadata" throw.
const ADOPTED_IHPC_OBSERVE_ONLY =
  "adopted iHPC runs are observe-only: no supervisor log/cancel path; cancel on the node directly";

function requireIhpcSupervisor(runRecord: RunRecord, profile: ComputeProfile): IhpcSupervisorDescriptor {
  if (runRecord.platform !== PLATFORM.IHPC) {
    throw new Error("iHPC supervisor metadata requires an uts-ihpc run record");
  }
  const supervisor = runRecord.supervisor;
  if (!supervisor) {
    throw new Error(`Run ${runRecord.run_id} does not include iHPC supervisor metadata`);
  }
  if (!Number.isInteger(supervisor.pid) || supervisor.pid <= 1) {
    throw new Error(`Run ${runRecord.run_id} has unsafe iHPC supervisor pid`);
  }
  if (!supervisor.node_id || !isSafeRemoteToken(supervisor.node_id)) {
    throw new Error(`Run ${runRecord.run_id} has unsafe or missing iHPC compute node id`);
  }
  const expectedRemoteJobId = `ihpc-${runRecord.run_id}-${supervisor.pid}`;
  if (runRecord.remote_job_id !== expectedRemoteJobId) {
    throw new Error("iHPC run record remote_job_id does not match persisted supervisor pid");
  }

  const roots = profileRoots(profile);
  if (!roots.length) {
    throw new Error(`Profile ${profile.profile_id} does not declare an iHPC workspace, scratch, or project root`);
  }
  for (const root of roots) {
    assertSafeRemotePath(root, "profile root");
  }
  for (const [label, value] of [
    ["metadata_path", supervisor.metadata_path],
    ["stdout_path", supervisor.stdout_path],
    ["stderr_path", supervisor.stderr_path]
  ] as const) {
    assertSafeRemotePath(value, label);
    if (!roots.some((root) => isInsideRemoteRoot(value, root))) {
      throw new Error(`iHPC supervisor ${label} must stay inside profile roots`);
    }
  }

  return {
    pid: supervisor.pid,
    node_id: supervisor.node_id,
    metadata_path: supervisor.metadata_path,
    stdout_path: supervisor.stdout_path,
    stderr_path: supervisor.stderr_path,
    ...(supervisor.started_at ? { started_at: supervisor.started_at } : {})
  };
}

function parseIhpcStatus(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut?: boolean
): { status: RunRecord["status"]; summary: string } {
  if (timedOut) {
    return { status: "unknown", summary: "iHPC supervisor status probe timed out" };
  }
  if (exitCode !== 0) {
    return { status: "unknown", summary: `iHPC supervisor status probe failed: ${summarizeBareFailure(stderr, exitCode, timedOut)}` };
  }
  const parsed = parseJsonLastLine(stdout, "iHPC supervisor status") as { alive?: unknown };
  if (parsed.alive === true) {
    return { status: "running", summary: "iHPC supervisor process is active" };
  }
  if (parsed.alive === false) {
    return { status: "finished", summary: "iHPC supervisor process is no longer active" };
  }
  return { status: "unknown", summary: "iHPC supervisor status output did not include alive state" };
}

function parseIhpcLogs(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  timedOut: boolean | undefined,
  maxBytes: number,
  planPaths: Record<"stdout" | "stderr", string>,
  userPrefixes: string[]
): Array<Omit<JobLogStreamResult, "command">> {
  if (timedOut || exitCode !== 0) {
    return [
      {
        stream: "stderr",
        path: maskUserRootPath(planPaths.stderr, userPrefixes),
        status: "failed",
        content: "",
        truncated: false,
        summary: `iHPC log helper failed: ${summarizeBareFailure(stderr, exitCode, timedOut)}`
      }
    ];
  }
  const parsed = parseJsonLastLine(stdout, "iHPC logs") as { streams?: unknown };
  if (!Array.isArray(parsed.streams)) {
    throw new Error("iHPC logs helper did not return stream results");
  }
  return parsed.streams.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("iHPC logs helper returned an invalid stream result");
    }
    const record = entry as {
      stream?: unknown;
      status?: unknown;
      content?: unknown;
      truncated?: unknown;
      summary?: unknown;
    };
    if (record.stream !== "stdout" && record.stream !== "stderr") {
      throw new Error("iHPC logs helper returned an unknown stream");
    }
    if (record.status !== "passed" && record.status !== "failed") {
      throw new Error("iHPC logs helper returned an invalid stream status");
    }
    const content = redactAndLimitLog(typeof record.content === "string" ? record.content : "", maxBytes);
    return {
      stream: record.stream,
      path: maskUserRootPath(planPaths[record.stream], userPrefixes),
      status: record.status,
      content: content.text,
      truncated: Boolean(record.truncated) || content.truncated,
      summary: typeof record.summary === "string" ? redactCommand(record.summary) : `${record.stream} log tail completed`
    };
  });
}

function parseIhpcCancel(stdout: string): Record<string, unknown> {
  const parsed = parseJsonLastLine(stdout, "iHPC cancel");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("iHPC cancel helper returned invalid metadata");
  }
  const result = (parsed as { result?: unknown }).result;
  if (result !== "cancelled" && result !== "already_stopped") {
    throw new Error("iHPC cancel helper returned an unknown result");
  }
  return parsed as Record<string, unknown>;
}

function redactedIhpcCommand(args: string[], hostAlias: string, computeNode: string, encodedSpec: string) {
  return {
    program: "ssh",
    args: args.map((arg) => {
      if (arg === hostAlias) {
        return "<profile-host>";
      }
      if (arg === computeNode) {
        return "<ihpc-compute-node>";
      }
      if (arg === encodedSpec) {
        return "<supervisor-spec>";
      }
      return arg;
    }),
    remote_argv: ["ssh", "<ihpc-compute-node>", "python3", "-", "<supervisor-spec>"]
  };
}

function profileRoots(profile: ComputeProfile): string[] {
  return [profile.defaults.workspace, profile.defaults.scratch, profile.defaults.project].filter((value): value is string =>
    Boolean(value)
  );
}

function assertCancelApproval(approval: ApprovalRecord, runRecord: RunRecord): void {
  assertApprovalBoundTo(approval, {
    operation: "jobs.cancel",
    runId: runRecord.run_id,
    profileId: runRecord.profile_id,
    platform: runRecord.platform,
    planHash: runRecord.plan_hash,
    identityMessage: "Approval does not match the run record identity",
    planHashMessage: "Approval plan_hash does not match the run record",
    quotaSnapshot: {
      expected: runRecord.quota_snapshot_id,
      message: "Approval quota_snapshot_id does not match the run record"
    }
  });
}

function parsePbsLogPaths(script: string): Partial<Record<"stdout" | "stderr", string>> {
  const paths: Partial<Record<"stdout" | "stderr", string>> = {};
  for (const line of script.split(/\r?\n/)) {
    const match = line.match(/^#PBS\s+-(o|e)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1] === "o" ? "stdout" : "stderr";
    const value = match[2].trim();
    if (!isSafeRemotePath(value)) {
      throw new Error(`Unsafe ${key} log path in saved PBS plan`);
    }
    paths[key] = value;
  }
  return paths;
}

// P2-b: derive the stdout/stderr file paths for an ADOPTED PBS job from `qstat -f`'s Output_Path /
// Error_Path attributes (format `host:/abs/path`). PBS folds long attribute values onto continuation
// lines (a `\n` + leading tab), so we unfold first, then read the two attrs off the shared field map and
// strip the `host:` prefix. Returns ONLY the host-stripped absolute path (or undefined when the attribute
// is absent / not a `host:/abs` shape); shell-safety + root confinement is the caller's job (the SAME
// staging the plan path / requireIhpcSupervisor use). Validation is deliberately split out so a bad path
// can become a clear failed-stream note rather than throwing the whole call.
export function parsePbsAttrLogPaths(qstatText: string): Partial<Record<"stdout" | "stderr", string>> {
  // Unfold PBS continuation lines: PBS wraps a long attribute value onto continuation lines. A
  // continuation line is an indented line that does NOT itself open a new `key = value` attribute — we
  // glue it onto the prior line. An indented `key = value` line is a NEW attribute and is left intact, so
  // the shared parseQstatFields reads each attribute correctly (spaces-or-tabs indentation, fixtures and
  // real PBS alike). This is narrower than a blanket `\n<ws>` collapse, which would wrongly merge the
  // normally-indented attribute lines into one.
  const fields = parseQstatFields(unfoldPbsRecord(qstatText));
  const paths: Partial<Record<"stdout" | "stderr", string>> = {};
  for (const [stream, attr] of [
    ["stdout", "Output_Path"],
    ["stderr", "Error_Path"]
  ] as const) {
    const raw = fields.get(attr);
    if (!raw) {
      continue;
    }
    const stripped = stripPbsPathHost(raw.trim());
    if (stripped) {
      paths[stream] = stripped;
    }
  }
  return paths;
}

// Join PBS continuation lines back onto their attribute. A line that opens a `key = value` attribute (the
// shared parseQstatFields grammar: indented, `name = ...`) starts a fresh logical line; any other indented
// line is a wrapped continuation of the value and is appended (PBS strips the fold, so no separator). The
// "Job Id:" header and blank lines pass through unchanged.
function unfoldPbsRecord(text: string): string {
  const attrStart = /^\s+[A-Za-z0-9_.]+\s*=\s*/;
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (out.length > 0 && /^\s+\S/.test(line) && !attrStart.test(line)) {
      out[out.length - 1] += line.trim();
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// Strip the leading `host:` from a PBS Output_Path/Error_Path, returning the absolute path. PBS reports
// `<host>:/abs/path`; the host segment is shell-safe-token shaped. Returns "" for any value that does not
// resolve to a leading-`/` absolute path (e.g. a relative path or a missing host segment) so the caller
// fails closed with a clear note instead of feeding a malformed token to confinement.
function stripPbsPathHost(value: string): string {
  if (value.startsWith("/")) {
    return value; // already absolute (no host prefix)
  }
  const colon = value.indexOf(":");
  if (colon <= 0) {
    return "";
  }
  const host = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  // The host is a hostname token; if it carries shell-active chars treat the whole value as malformed.
  if (!/^[A-Za-z0-9._-]+$/.test(host) || !rest.startsWith("/")) {
    return "";
  }
  return rest;
}

// Confine an externally-reported (adopted-PBS) log path: shell-safety (isSafeRemotePath) AND containment
// inside one of the profile's resolved roots — the SAME two-part guard requireIhpcSupervisor applies to
// supervisor log paths. A path that fails either check returns a clear reason (never a throw, so the
// caller can surface it as a failed stream and still tail the other stream).
function confineAdoptedLogPath(
  candidate: string,
  roots: string[]
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!isSafeRemotePath(candidate)) {
    return { ok: false, reason: "log path from qstat -f contains shell-active, relative, or unsupported characters" };
  }
  if (!roots.length) {
    return { ok: false, reason: "profile declares no resolvable workspace/scratch/project root to confine the log path to" };
  }
  if (!roots.some((root) => isInsideRemoteRoot(candidate, root))) {
    return { ok: false, reason: "log path from qstat -f is outside the profile roots; refusing to tail an unconfined path" };
  }
  return { ok: true, path: candidate };
}

// The profile's declared roots with ${USER} substituted by the concrete account login (resolved from a
// `user@host` host_alias, exactly like the planner's resolveRemoteUser). A bare-alias profile (no user@)
// cannot resolve ${USER}, so a templated root is dropped — confinement then fails closed for any concrete
// reported path, which is the safe direction (we never confine against an unresolved ${USER} literal).
function resolvedProfileRoots(profile: ComputeProfile): string[] {
  const alias = profile.login.host_alias;
  const at = alias.indexOf("@");
  const remoteUser = at > 0 && /^[A-Za-z0-9._-]{1,64}$/.test(alias.slice(0, at)) ? alias.slice(0, at) : undefined;
  return profileRoots(profile)
    .map((root) => (remoteUser ? root.replaceAll("${USER}", remoteUser) : root))
    .filter((root) => !root.includes("${USER}"));
}

function requireRemoteJobId(runRecord: RunRecord): string {
  if (!runRecord.remote_job_id) {
    throw new Error(`Run ${runRecord.run_id} does not have a remote_job_id yet`);
  }
  // Platform-agnostic (this runs before the PBS/iHPC routing): accept a PBS job id including the
  // array `[]`/`[i]` forms, OR the broad token grammar that also covers iHPC supervised ids
  // (`ihpc-<run>-<pid>`).
  if (!isSafePbsJobId(runRecord.remote_job_id) && !isSafeRemoteJobId(runRecord.remote_job_id)) {
    throw new Error(`Run ${runRecord.run_id} has unsafe remote_job_id`);
  }
  return runRecord.remote_job_id;
}

export function assertAllowedHpcJobRemoteArgv(remoteArgv: string[]): void {
  // These are PBS commands (qstat/qdel), so the job-id token must satisfy the PBS grammar incl. the
  // array `[]`/`[i]` forms. The bracket chars are shell-glob significant, so sshJobArgs shell-quotes
  // each remote token before transmission.
  if (remoteArgv.length === 3 && remoteArgv[0] === "qstat" && remoteArgv[1] === "-f" && isSafePbsJobId(remoteArgv[2])) {
    return;
  }
  if (
    remoteArgv.length === 4 &&
    remoteArgv[0] === "qstat" &&
    remoteArgv[1] === "-x" &&
    remoteArgv[2] === "-f" &&
    isSafePbsJobId(remoteArgv[3])
  ) {
    return;
  }
  // `qstat -x -t -f <array-id>` expands a finished PBS array job into its sub-jobs, each carrying its own
  // resources_used.* (the array parent record does not), so a sweep's total usage can be summed.
  if (
    remoteArgv.length === 5 &&
    remoteArgv[0] === "qstat" &&
    remoteArgv[1] === "-x" &&
    remoteArgv[2] === "-t" &&
    remoteArgv[3] === "-f" &&
    isSafePbsJobId(remoteArgv[4])
  ) {
    return;
  }
  if (remoteArgv.length === 2 && remoteArgv[0] === "qdel" && isSafePbsJobId(remoteArgv[1])) {
    return;
  }
  if (
    remoteArgv.length === 5 &&
    remoteArgv[0] === "tail" &&
    remoteArgv[1] === "-c" &&
    /^[1-9][0-9]{0,5}$/.test(remoteArgv[2]) &&
    remoteArgv[3] === "--" &&
    isSafeRemotePath(remoteArgv[4])
  ) {
    return;
  }
  // Pre-qsub `mkdir -p -- <log_dir> <workdir>` (jobs.submit): PBS opens its -o/-e files BEFORE the job
  // script runs and does NOT create their parent dir, so without this the log_dir is missing (zero logs)
  // and the script's `cd "<workdir>"` under `set -e` instant-fails. ONLY the fixed `mkdir -p --` shape is
  // admitted, with EXACTLY two safe-path operands (length 5) — ensureRemoteWorkdirs only ever builds the
  // <log_dir> <workdir> pair, so the allowlist matches reality exactly rather than admitting other counts.
  // The `--` end-of-options guard means a path that somehow began with `-` could never be read as a flag;
  // isSafeRemotePath rejects shell metachars, traversal, and non-absolute tokens, so an injection like
  // `dir; rm -rf /` or a non-path operand fails. NOTE: this allowlist only guarantees the fixed SHAPE +
  // safe-path tokens — roots-confinement of the two operands is the CALLER's (ensureRemoteWorkdirs)
  // responsibility, asserted there before this argv is built.
  if (
    remoteArgv.length === 5 &&
    remoteArgv[0] === "mkdir" &&
    remoteArgv[1] === "-p" &&
    remoteArgv[2] === "--" &&
    remoteArgv.slice(3).every((token) => isSafeRemotePath(token))
  ) {
    return;
  }
  throw new Error(`jobs remote command is not allowlisted: ${remoteArgv.join(" ")}`);
}

function redactedCommand(args: string[], hostAlias: string, remoteArgv: string[], redactTokens: string[]) {
  const hostMasked = maskHostAlias(args, hostAlias);
  return {
    program: "ssh",
    args: hostMasked.map((arg) => redactJobText(arg, redactTokens)),
    remote_argv: remoteArgv.map((arg) => redactJobText(arg, redactTokens))
  };
}

function redactAndLimitLog(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const redacted = redactCommand(value);
  if (redacted.length <= maxBytes) {
    return { text: redacted, truncated: false };
  }
  return { text: redacted.slice(-maxBytes), truncated: true };
}

function redactJobText(value: string, redactTokens: string[]): string {
  return redactWithTokens(value, redactTokens, (token) =>
    token.startsWith("/") ? "<plan-log-path>" : "<remote-job-id>"
  );
}

// P4 (VPN/network-drop resilience): map an SSH CommandResult to the optional { error_kind, network_hint }
// pair to spread into a JobStatusResult / JobTrackEntry. Returns {} when the probe ran (success or a real
// remote/app error) so a genuine remote failure is never mislabelled a VPN drop. When the host was
// unreachable (timeout/unreachable/dns) it carries the classified kind + the one actionable next step.
export function networkDropFields(
  result: CommandResult
): { error_kind?: "timeout" | "unreachable" | "dns"; network_hint?: string } {
  const c = classifyRemoteFailure(result);
  if (!c.network_unreachable || (c.kind !== "timeout" && c.kind !== "unreachable" && c.kind !== "dns")) {
    return {};
  }
  return { error_kind: c.kind, network_hint: c.hint };
}

// jobs' bare failure wording ("command timed out" / scrubbed stderr / "exit N"), threaded into the
// shared summarizer. A thin local adapter keeps the existing positional call sites unchanged.
function summarizeBareFailure(stderr: string, exitCode: number | null, timedOut?: boolean): string {
  return summarizeRemoteFailure(
    { stderr, exitCode, timedOut },
    {
      timedOut: "command timed out",
      failed: (summary) => summary,
      exited: (code) => `exit ${String(code)}`
    }
  );
}

function normalizeLogBytes(maxBytes?: number): number {
  return boundedInteger(maxBytes, { default: DEFAULT_LOG_BYTES, min: 1, max: MAX_LOG_BYTES, label: "maxBytes" });
}

export const defaultJobCommandExecutor: JobCommandExecutor = runProcess;

function writeJobEvidence(kind: string, runId: string, now: Date, evidence: Record<string, unknown>, evidenceDir = DEFAULT_EVIDENCE_DIR): string {
  assertSafeRunId(runId);
  const safeKind = kind.replace(/[^a-z0-9-]/g, "-");
  const dir = assertInsideRuntime(evidenceDir, "Job operation evidence directory");
  const safeObservedAt = safeTimestamp(now);
  // FLAT layout: the run id is embedded in the filename rather than a nesting directory. Migrating
  // this to runRecordRoot's per-run nesting is an on-disk-layout change and is deliberately deferred.
  return writeEvidenceJson(
    dir,
    `${runId}-${safeKind}-${safeObservedAt}.json`,
    {
      run_id: runId,
      kind: safeKind,
      observed_at: now.toISOString(),
      evidence
    },
    "Job operation evidence"
  );
}
