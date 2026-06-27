// Functional-primitive layer for C1 (open the closed world). These turn EXTERNAL evidence — a qstat -x
// row, or an observed iHPC node+pid — into a schema-valid RunRecord. Pure: no SSH, no disk. The tool
// (adoptExternalRun) fetches the evidence and persists the record; these only build it.
import {
  parsePbsUsage,
  parsePbsRequested,
  computeUsageMetrics,
  parseExecNodes,
  metricsToRunUsage
} from "./accounting.js";
import { parseQstatStatus } from "./jobs.js";
import type { Platform, RunRecord } from "../../core/types.js";
// CP-4 / cross-phase correction: the node-status -> RunRecord-status map has ONE canonical source
// (seam/protocol.ts), re-exported through seam/status.js. We import it here and in seam/reconcile.ts —
// never a private copy. The status TYPE is IhpcJobStatus (core/types.ts), not a local NodeJobStatus.
import { nodeStatusToRunStatus, type IhpcJobStatus } from "../scheduler/seam/status.js";
import { assertSafeRunId, isSafePbsJobId, isSafeRemoteToken } from "../../core/ids.js";
import { getProfile } from "../../core/config.js";
import { readRunRecordSafe, writeRunRecord } from "../../core/audit.js";
import { PLATFORM } from "../../core/types.js";
import { sshJobArgs } from "../../lib/ssh.js";
import { assertSafeRemotePath } from "../../lib/shared.js";
// Only these three genuinely live in jobs.ts (Task 3 step 3 added the exports):
import { assertAllowedHpcJobRemoteArgv, defaultJobCommandExecutor, type JobCommandExecutor } from "./jobs.js";

export interface PbsAdoptContext {
  runId: string;
  profileId: string;
  platform: Platform; // "uts-hpc"
  remoteJobId: string;
  now: Date;
  project?: string;
  accountLabel?: string; // tool passes profile.account_label
  cluster?: string;      // tool passes the login host
}

export function pbsRowToRunRecord(qstatText: string, ctx: PbsAdoptContext): RunRecord {
  const parsed = parseQstatStatus(qstatText, "", 0); // { status, schedulerState?, summary }
  const usageRaw = parsePbsUsage(qstatText);
  const usage = usageRaw ? metricsToRunUsage(computeUsageMetrics(usageRaw)) : undefined;
  const execNodes = parseExecNodes(qstatText);
  const node = execNodes.length > 0 ? execNodes.join("+") : undefined;
  const requested = parsePbsRequested(qstatText); // Track 2.5: Resource_List.* -> submission.requested
  const at = ctx.now.toISOString();
  return {
    run_id: ctx.runId,
    profile_id: ctx.profileId,
    platform: ctx.platform,
    remote_job_id: ctx.remoteJobId,
    rev: 0,
    ...(ctx.project ? { project: ctx.project } : {}),
    status: parsed.status,
    created_at: at,
    updated_at: at,
    ...(usage ? { usage } : {}),
    // Track 2.5: carry the requested resources parsed from the qstat Resource_List.*, instead of {}. The
    // submission block now also appears for a queued adopted job (no exec_host yet) when it declared
    // resources — submission.node is optional, and requested is the value the dashboard needs.
    ...(node || Object.keys(requested).length > 0
      ? { submission: { account_label: ctx.accountLabel ?? ctx.profileId, cluster: ctx.cluster ?? ctx.profileId, ...(node ? { node } : {}), requested, submitted_at: at } }
      : {}),
    // Feature B / Option A (spec §5): a bare-qsub PBS job we DISCOVERED via `qstat`, never planned. Both
    // trust axes are weak and lineage is unproven — exactly like the iHPC §5b observed path. The block's
    // PRESENCE (with platform === uts-hpc) is what unlocks jobs.cancel's relaxed, adopted-identity gate;
    // we do NOT overclaim plugin lineage: terminal_record is the PBS scheduler's (not our wrapper's),
    // the argv was never declared by us (intent unverified), and there is no plan_hash/quota_snapshot_id.
    adoption: {
      terminal_record: "external_observed",
      intent: "unverified",
      lineage: "not_lineage_proven",
      discovered_via: "qstat",
      adopted_at: at
    },
    events: [
      {
        at,
        kind: "adopted-external",
        summary: `Adopted external PBS job ${ctx.remoteJobId} (scheduler state ${parsed.schedulerState ?? "?"})`
      }
    ]
  };
}

export interface IhpcAdoptContext {
  runId: string;
  profileId: string;
  node: string;
  pid: number;
  now: Date;
  status?: RunRecord["status"]; // default "running"
  project?: string;
  accountLabel?: string;
  cluster?: string;
  // Scheduler-reported placement (H8). Optional: callers supply gpu_index/hostname (and optionally
  // slots_per_gpu); node_id defaults to `node`. We never inject a default started_at/placement_hash.
  placement?: {
    hostname: string;
    node_id?: string;
    gpu_index?: number;
    slots_per_gpu?: number;
  };
}

export function ihpcPidToRunRecord(ctx: IhpcAdoptContext): RunRecord {
  const at = ctx.now.toISOString();
  // Feature B (b): HISTORY-ONLY, not_lineage_proven (spec §5b). We give the record the canonical iHPC remote_job_id shape that
  // requireIhpcSupervisor (jobs.ts:1036) expects, but we do NOT synthesize a supervisor block —
  // an externally-started ihpc-sched process does not expose its metadata/stdout/stderr paths, and
  // requireIhpcSupervisor also validates those paths live inside the profile roots. So the adopted
  // iHPC run is DISCOVERABLE (jobs.history, WebUI) but jobs.status/logs/cancel will raise the clear
  // "does not include iHPC supervisor metadata" error until Phase 4 builds proper iHPC supervision.
  const remoteJobId = `ihpc-${ctx.runId}-${ctx.pid}`;
  // Carry scheduler-reported placement (H8) when supplied; default node_id to the observed node.
  // We do NOT synthesize started_at/placement_hash — only what the scheduler/operator actually reports.
  const placement = ctx.placement
    ? {
        hostname: ctx.placement.hostname,
        node_id: ctx.placement.node_id ?? ctx.node,
        ...(typeof ctx.placement.gpu_index === "number" ? { gpu_index: ctx.placement.gpu_index } : {}),
        ...(typeof ctx.placement.slots_per_gpu === "number" ? { slots_per_gpu: ctx.placement.slots_per_gpu } : {})
      }
    : undefined;
  return {
    run_id: ctx.runId,
    profile_id: ctx.profileId,
    platform: "uts-ihpc",
    remote_job_id: remoteJobId,
    rev: 0,
    ...(ctx.project ? { project: ctx.project } : {}),
    status: ctx.status ?? "running",
    created_at: at,
    updated_at: at,
    submission: { account_label: ctx.accountLabel ?? ctx.profileId, cluster: ctx.cluster ?? ctx.profileId, node: ctx.node, requested: {}, submitted_at: at },
    // P2-a: durably record the operator-supplied node+pid as the OBSERVE anchor. submission.node already
    // carries the node, but the pid was previously only encoded inside remote_job_id (ihpc-<run>-<pid>),
    // where run_id's own dashes make it fragile to parse back. The discrete `observed` block is the honest
    // home jobs.status reads to probe liveness — it is NOT a supervisor block (no log/metadata paths), so
    // it does not unlock the supervised read/cancel path; it only opens the read-only observe path.
    observed: { node: ctx.node, pid: ctx.pid },
    ...(placement ? { placement } : {}),
    // Feature B (b) (spec §5): a foreign job we only OBSERVED (bare `ihpc-sched start`, or pre-
    // internalization). Both trust axes are weak and lineage is unproven. No supervisor block is
    // synthesized, so requireIhpcSupervisor (jobs.ts) keeps jobs.status/logs/cancel refused —
    // history-only until a later trust path proves lineage.
    adoption: {
      terminal_record: "external_observed",
      intent: "unverified",
      lineage: "not_lineage_proven",
      discovered_via: "node_observed",
      adopted_at: at
    },
    events: [{ at, kind: "adopted-external", summary: `Adopted external iHPC process pid ${ctx.pid} on ${ctx.node} (history-only)` }]
  };
}

// One STATE jobs[<seq>] entry (spec §2.3, grouped). started_at_node/finished_at_node are NODE-clock
// opaque labels — never differenced against the laptop clock (spec §2.3 clock-skew rule).
// wrapper_pid (CP-3) = the slot's long-lived per-job wrapper pid (the "supervisor of record"); it
// outlives the progressor, so it — not the progressor pid — is what status/logs/cancel target. pid is
// the inner job pid (informational only).
export interface IhpcStateJobEntry {
  seq: number;
  run_id: string;
  status: IhpcJobStatus;
  pid: number;
  wrapper_pid: number;
  gpu_index: number;
  exit_code?: number;
  started_at_node: string;
  finished_at_node?: string;
  log: string;
}

export interface IhpcStateAdoptContext {
  runId: string;
  profileId: string;
  node: string;
  queueId: string;          // STATE top-level queue_id — the lineage proof anchor (spec §5a)
  now: Date;
  supervisorPid: number;    // the slot wrapper_pid (CP-3) — supervisor of record, NOT the progressor pid
  job: IhpcStateJobEntry;
  supervisorPaths: { metadata_path: string; stdout_path: string; stderr_path: string };
  accountLabel?: string;
  cluster?: string;
}

// nodeStatusToRunStatus is imported from seam/status.js -> seam/protocol.ts (CP-4) — spec §2.3 vocab is
// encoded ONCE. Mapping: pending→submitted, launching/running→running, done→finished, failed→failed,
// cancelled→cancelled, placement_conflict→unknown (deferred, not a failure — the brain re-places).

// Feature B (a) (spec §5): a job OUR progressor launched from OUR PLAN, proven by lineage. Synthesizes a
// REAL supervisor block (so requireIhpcSupervisor at jobs.ts admits jobs.status/logs/cancel on our own
// pid/log paths) and a two-axis adoption block. Pure: no SSH, no disk. The caller (seam/reconcile.ts)
// reads state.json once, proves lineage (STATE queue_id + lease_owner == a RunRecord we hold), and resolves
// the per-slot supervisor paths from the PLAN/slot directory before calling this.
export function ihpcStateJobToRunRecord(ctx: IhpcStateAdoptContext): RunRecord {
  const at = ctx.now.toISOString();
  // remote_job_id MUST be the canonical ihpc-<run_id>-<pid> shape requireIhpcSupervisor expects; the pid
  // is the slot wrapper_pid (supervisor of record, CP-3), not the inner job pid and not the (possibly
  // dead) progressor pid.
  const remoteJobId = `ihpc-${ctx.runId}-${ctx.supervisorPid}`;
  const runStatus = nodeStatusToRunStatus(ctx.job.status);
  return {
    run_id: ctx.runId,
    profile_id: ctx.profileId,
    platform: "uts-ihpc",
    remote_job_id: remoteJobId,
    rev: 0,
    status: runStatus,
    created_at: at,
    updated_at: at,
    submission: {
      account_label: ctx.accountLabel ?? ctx.profileId,
      cluster: ctx.cluster ?? ctx.profileId,
      node: ctx.node,
      requested: {},
      submitted_at: at
    },
    supervisor: {
      pid: ctx.supervisorPid,
      node_id: ctx.node,
      metadata_path: ctx.supervisorPaths.metadata_path,
      stdout_path: ctx.supervisorPaths.stdout_path,
      stderr_path: ctx.supervisorPaths.stderr_path,
      // Persist the node's started_at_node (node-clock label) as DURABLE anti-pid-reuse evidence (spec
      // 2.5): a later reconcile pairs the freshly-reported started_at_node against this stored value to
      // prove the live pid is the SAME process before re-asserting `running`. We record only what the
      // node reported — never a synthesized timestamp; omitted when the node did not report one.
      ...(ctx.job.started_at_node ? { started_at: ctx.job.started_at_node } : {})
    },
    placement: {
      hostname: ctx.node,
      node_id: ctx.node,
      gpu_index: ctx.job.gpu_index
    },
    // Two independent trust axes (spec §5): the terminal record IS ours (the wrapper wrote it), but the
    // intent was only shape+root validated — keep them separate, do not let "we launched it" launder argv.
    adoption: {
      terminal_record: "agent_authored",
      intent: "user_declared",
      lineage: "lineage_proven",
      queue_id: ctx.queueId,
      adopted_at: at
    },
    events: [
      {
        at,
        kind: "adopted-lineage",
        summary: `Adopted lineage-proven iHPC run ${ctx.runId} (seq ${ctx.job.seq}, queue ${ctx.queueId}, node status ${ctx.job.status})`
      }
    ]
  };
}

// Resolve the per-slot supervisor paths from the STATE-reported job.log path (spec §5a). The node writes
// each slot's stdout to <slot_dir>/stdout.log and its terminal result to <slot_dir>/result.json; we derive
// both from job.log's directory rather than trusting separately-reported paths. FULL realpath gate: the
// log path must be an absolute, traversal-free, shell-inert remote path (assertSafeRemotePath) — any
// `..`/metachar fails closed before the path is ever used to read/cancel.
// NB: this is the ADOPT-side path derivation (input = the STATE-reported job.log). It is deliberately a
// DIFFERENT mechanism from seam/launch.ts's `resolveSlotSupervisorPaths` (input = campaign_id + seq); the
// two must stay convention-compatible but do not share a signature, hence the distinct name.
export function slotPathsFromLog(job: { log: string }): { metadata_path: string; stdout_path: string; stderr_path: string } {
  assertSafeRemotePath(job.log, "iHPC slot log path");
  const slash = job.log.lastIndexOf("/");
  const slotDir = slash > 0 ? job.log.slice(0, slash) : job.log;
  const stdout = `${slotDir}/stdout.log`;
  // stderr_path is intentionally aliased to stdout_path: the node merges both streams into stdout.log.
  return { metadata_path: `${slotDir}/result.json`, stdout_path: stdout, stderr_path: stdout };
}

// Feature B (c) (spec §5c / §2.6): the dead-progressor-but-live-jobs adopt hook D injects into
// reconcileIhpcCampaign's dead-progressor branch. For each live STATE job, it PROVES lineage — STATE
// queue_id + lease_owner must match the RunRecord we already hold for that run — and only then synthesizes
// a lineage-proven RunRecord via ihpcStateJobToRunRecord, using the slot wrapper_pid (CP-3) as the
// supervisor of record (NEVER the dead progressor pid). A job we cannot prove lineage for returns null, so
// reconcile leaves it to the §5b history-only path rather than laundering a foreign job into lineage_proven.
// Broad STATE-job shape matching seam/reconcile.ts's NodeStateJob (status:string, pid:number|null,
// wrapper_pid optional) so the returned hook is assignable to ReconcileDeps.adoptLiveJob without an
// import cycle on the NodeStateJob type itself. The hook narrows status/pid before building the record.
interface NodeStateJobLike {
  seq: number; run_id: string; status: string; pid: number | null; wrapper_pid?: number;
  gpu_index: number; exit_code?: number; started_at_node: string; finished_at_node?: string; log: string;
}

export function makeLineageAdoptHook(deps: { auditDir?: string }):
  (
    job: NodeStateJobLike,
    ctx: { campaignId: string; profileId: string; node: string; now: Date; queueId: string; leaseOwner: { client: string; device_id: string } }
  ) => (RunRecord | null) {
  return (job, ctx) => {
    // Lineage proof (spec §5a): the STATE run_id must find a RunRecord WE durably hold whose campaign_id
    // matches the campaign the node is reporting. campaign_id + the run_id lookup itself are the baseline
    // persisted lineage anchors; a job with no matching held record (foreign / pre-internalization) fails
    // the proof. The STATE queue_id is recorded as the adoption hash.
    //
    // lease_owner check (conditional, additive): the held RunRecord now persists lease_owner (run-record
    // schema fix A), so when the held record HAS one AND the caller threads ctx.leaseOwner, we ALSO require
    // the writer identity to match (client + device_id) — a record authored under a DIFFERENT lease is not
    // ours to launder into lineage_proven, so it returns null and falls to the §5b history-only path. An
    // older held record WITHOUT a lease_owner keeps the campaign_id-only behavior (backward-compatible).
    const held = readRunRecordSafe(job.run_id, deps.auditDir);
    if (!held || held.campaign_id !== ctx.campaignId) return null; // foreign / unproven — §5b history-only
    if (held.lease_owner && ctx.leaseOwner &&
        (held.lease_owner.client !== ctx.leaseOwner.client ||
         held.lease_owner.device_id !== ctx.leaseOwner.device_id)) {
      return null; // a different writer's lease held this run — not lineage-proven for us
    }
    // ANTI-PID-REUSE agreement (spec 2.5): if the held record already recorded this run's launch evidence
    // (supervisor.started_at, written on a prior adopt/observation) and the STATE now reports a DIFFERENT
    // started_at_node, the OS pid was recycled onto a foreign process after a node reboot — NOT our job.
    // Refuse to launder a reused pid into lineage_proven (return null -> §5b history-only). A first-ever
    // adoption (no recorded evidence yet) proceeds and persists started_at_node for the next pass to check.
    if (held.supervisor?.started_at && job.started_at_node &&
        held.supervisor.started_at !== job.started_at_node) {
      return null; // started_at_node mismatch — recycled pid, not the same process we launched
    }
    if (typeof job.wrapper_pid !== "number") return null; // no supervisor of record => cannot supervise (fail-closed)
    const entry: IhpcStateJobEntry = {
      seq: job.seq,
      run_id: job.run_id,
      status: job.status as IhpcJobStatus, // narrowed from the node's string; unknown -> nodeStatusToRunStatus maps to "unknown"
      pid: job.pid ?? job.wrapper_pid, // inner-job pid is informational; fall back to the wrapper pid if null
      wrapper_pid: job.wrapper_pid,
      gpu_index: job.gpu_index,
      ...(typeof job.exit_code === "number" ? { exit_code: job.exit_code } : {}),
      started_at_node: job.started_at_node,
      ...(job.finished_at_node ? { finished_at_node: job.finished_at_node } : {}),
      log: job.log
    };
    return ihpcStateJobToRunRecord({
      runId: job.run_id,
      profileId: ctx.profileId,
      node: ctx.node,
      queueId: ctx.queueId,
      now: ctx.now,
      // CP-3: the slot wrapper pid is the supervisor of record; the dead progressor pid is NEVER used here.
      supervisorPid: job.wrapper_pid,
      job: entry,
      supervisorPaths: slotPathsFromLog(job)
    });
  };
}

// Business-flow tool (C1). Derives the platform from the profile, fetches the EXTERNAL evidence (a PBS
// qstat row over SSH, or the caller-supplied iHPC node+pid), turns it into a schema-valid RunRecord via
// the primitives above, and persists it through the canonical audit path. Idempotent on run_id +
// remote_job_id: a matching re-adopt returns the existing record untouched; a conflicting remote_job_id
// on an existing run is refused rather than silently overwritten.
export interface AdoptInput {
  runId: string;
  profileId: string;
  remoteJobId?: string; // PBS: required
  node?: string;        // iHPC: required
  pid?: number;         // iHPC: required
  // Optional scheduler-reported placement (iHPC only, H8). When hostname/gpuIndex are supplied the
  // adopted record carries a `placement` for observability; PBS ignores these.
  gpuIndex?: number;
  hostname?: string;
  slotsPerGpu?: number;
  timeoutMs?: number;
}

export interface AdoptOptions {
  auditDir?: string;
  configPath?: string;
  executor?: JobCommandExecutor;
  now?: Date;
}

export interface AdoptResult {
  adopted: {
    run_id: string;
    remote_job_id: string;
    platform: Platform;
    status: RunRecord["status"];
    idempotent: boolean;
  };
}

export async function adoptExternalRun(input: AdoptInput, options: AdoptOptions = {}): Promise<AdoptResult> {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const profile = getProfile(input.profileId, options.configPath);

  let record: RunRecord;
  if (profile.platform === PLATFORM.HPC) {
    if (!input.remoteJobId || !isSafePbsJobId(input.remoteJobId)) {
      throw new Error("jobs.adopt for a PBS profile requires a valid remoteJobId");
    }
    const timeoutMs = input.timeoutMs ?? 15000;
    const executor = options.executor ?? defaultJobCommandExecutor;
    const remoteArgv = ["qstat", "-x", "-f", input.remoteJobId];
    assertAllowedHpcJobRemoteArgv(remoteArgv);
    const args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
    const res = await executor("ssh", args, timeoutMs);
    if (res.exitCode !== 0) {
      throw new Error(`qstat for ${input.remoteJobId} failed (exit ${res.exitCode}); cannot adopt`);
    }
    record = pbsRowToRunRecord(res.stdout, {
      runId: input.runId,
      profileId: input.profileId,
      platform: PLATFORM.HPC,
      remoteJobId: input.remoteJobId,
      accountLabel: profile.account_label,
      cluster: profile.login.host_alias,
      now
    });
  } else {
    if (!input.node || typeof input.pid !== "number") {
      throw new Error("jobs.adopt for an iHPC profile requires node and pid");
    }
    // Finding 5 (defense-in-depth): validate the observed node/pid at WRITE time, not only at read time,
    // so a shell-metachar / leading-dash node or a pid<=1 can never be persisted into the `observed`
    // block. node must be a safe remote token and must not look like an SSH option flag; pid must be a
    // real (>1) integer process id.
    if (!isSafeRemoteToken(input.node) || input.node.startsWith("-")) {
      throw new Error(`jobs.adopt observed node is not a safe remote token: ${input.node}`);
    }
    if (!Number.isInteger(input.pid) || input.pid <= 1) {
      throw new Error(`jobs.adopt observed pid must be an integer greater than 1: ${input.pid}`);
    }
    // Build placement only when the caller supplied at least a hostname or a gpu index; default the
    // placement hostname to the observed node when only a gpuIndex is given.
    const placement =
      input.hostname !== undefined || typeof input.gpuIndex === "number"
        ? {
            hostname: input.hostname ?? input.node,
            ...(typeof input.gpuIndex === "number" ? { gpu_index: input.gpuIndex } : {}),
            ...(typeof input.slotsPerGpu === "number" ? { slots_per_gpu: input.slotsPerGpu } : {})
          }
        : undefined;
    record = ihpcPidToRunRecord({
      runId: input.runId,
      profileId: input.profileId,
      node: input.node,
      pid: input.pid,
      accountLabel: profile.account_label,
      cluster: profile.login.host_alias,
      now,
      ...(placement ? { placement } : {})
    });
  }

  // Idempotency keyed by run_id + remote_job_id.
  const existing = readRunRecordSafe(input.runId, options.auditDir);
  if (existing) {
    if (existing.remote_job_id === record.remote_job_id) {
      return {
        adopted: {
          run_id: existing.run_id,
          remote_job_id: existing.remote_job_id ?? "",
          platform: existing.platform,
          status: existing.status,
          idempotent: true
        }
      };
    }
    throw new Error(
      `Run ${input.runId} already exists with remote_job_id ${existing.remote_job_id}; refusing to overwrite (conflict)`
    );
  }

  writeRunRecord(record, options.auditDir);
  return {
    adopted: {
      run_id: record.run_id,
      remote_job_id: record.remote_job_id ?? "",
      platform: record.platform,
      status: record.status,
      idempotent: false
    }
  };
}
