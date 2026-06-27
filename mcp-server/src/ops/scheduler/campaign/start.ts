// campaign/start.ts — the campaign.submit TOOL-FACING ops function: it binds the REAL local-store
// reads and the REAL SSH launch seam, then drives the pure campaignSubmit orchestration. It is the
// thin "wire the seams" layer (mirroring jobs/ihpc-start.ts for the single-run path); all decision
// logic lives in campaignSubmit + the primitives it composes.
//
// Autonomous + conformance-gated (ADR-0004, mirroring jobs.submit): the HARD ban-critical gate is
// checkIhpcNodePoolConformance inside campaignSubmit, fed from THIS profile's own held-nodes set
// (never a cross-account sum). There is NO approval token — campaign launch is an autonomous submit.

import { runProcess } from "../../../lib/process.js";
import { assertSafeRemotePathTemplate, encodeSpec, normalizeTimeout, parseJsonLastLine } from "../../../lib/shared.js";
import { sshSupervisorArgs, sshWriteAtomicJsonArgs, ATOMIC_WRITE_PY } from "../../../lib/ssh.js";
import { isSafeRemoteToken } from "../../../core/ids.js";
import { listRunRecordIds, readRunRecordSafe, writeRunRecord } from "../../../core/audit.js";
import { getProfile } from "../../../core/config.js";
import { readFreshQuotaSnapshot } from "../../approvals/approvals.js";
import { inferNodeFamily } from "../../quotas/quota-limits.js";
import { readVerifiedPlan } from "../../plans/plan-store.js";
import { IHPC_STATE_READ_PY } from "../seam/protocol-py.js";
import { launchIhpcCampaign, type LaunchResult } from "../seam/launch.js";
import { campaignSubmit, type CampaignSubmitResult } from "./submit.js";
import type { QueueRunRecord } from "../control/plan.js";
import type { NodeTopology } from "../control/placement.js";
import { PLATFORM } from "../../../core/types.js";
import type { ComputeProfile, LeaseOwner, QuotaSnapshot, RunRecord } from "../../../core/types.js";

// Same per-module timeout policy as jobs/ihpc-start.ts (standard 10s / 30s cap).
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
// Lease staleness window: a node-clock heartbeat older than this presumes the holder dead (spec §3.2).
const DEFAULT_LEASE_STALE_SECONDS = 900;
// PLAN idle/timeout default when a planned iHPC run carried no walltime (background process; advisory).
const DEFAULT_TIMEOUT_SECONDS = 86400;
// Conservative per-node GPU ceiling used when a profile does not declare `defaults.node_gpu_count`. The
// live quota snapshot does not expose GPU topology, so this is the documented default that bounds the
// brain's fabricated gpu_indices [0..N-1] (I2): without it a large maxConcurrent would plan jobs onto
// non-existent GPU indices. Real iHPC GPU nodes are typically 1–8 GPUs; 8 is the safe upper bound. Set
// `node_gpu_count` in the profile to the node's real count for tighter placement.
const DEFAULT_NODE_GPU_COUNT = 8;

export type CampaignStartExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin: string
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }>;

export interface CampaignStartInput {
  campaignId: string;
  profileId: string;
  // The iHPC compute node to target (e.g. "mars01"). Required: the brain places onto a known node.
  node: string;
  maxConcurrent?: number;
  // REQUIRED fresh quota snapshot id for this profile (mirrors jobs.submit's autonomous conformance):
  // it supplies the account's REAL held-nodes evidence that the ban-critical node-pool gate consumes.
  // Without it the gate would see an empty held set and never fire (C1).
  quotaSnapshotId: string;
  timeoutMs?: number;
}

// The on-node lease the brain reads before planning (I1): who currently holds the (profile, node) lease
// and how fresh their heartbeat is, on the NODE clock (spec §2.3 — never a laptop-now subtraction).
export interface NodeLeaseRead {
  held: LeaseOwner | null;
  heartbeatEpoch: number | null;
  nodeNowEpoch: number;
}

export interface CampaignStartOptions {
  executor?: CampaignStartExecutor;
  auditDir?: string;
  planDir?: string;
  configPath?: string;
  now?: Date;
  // This brain's identity (the PLAN lease_owner). device_id is non-secret (mirrors the node holder).
  me?: LeaseOwner;
  // Override the per-account held-nodes set the conformance gate sees. Normally DERIVED from the required
  // fresh quota snapshot (C1); kept injectable for tests. NEVER a cross-account union.
  activeNodes?: Array<{ node?: string; family?: string }>;
  // THE on-node lease read seam (I1): read the current (profile, node) holder + node-clock heartbeat from
  // the node STATE over SSH. Defaults to the real SSH read (readNodeLeaseOverSsh); tests inject a stub.
  readNodeLease?: (host: string, node: string) => Promise<NodeLeaseRead>;
}

export async function campaignStart(
  input: CampaignStartInput,
  options: CampaignStartOptions = {}
): Promise<{ campaign: CampaignSubmitResult }> {
  if (!input.campaignId) {
    throw new Error("campaign.submit requires a campaignId");
  }
  if (!isSafeRemoteToken(input.node)) {
    throw new Error(`Unsafe iHPC compute node id: ${input.node}`);
  }
  if (!input.quotaSnapshotId) {
    throw new Error("campaign.submit requires a fresh quotaSnapshotId for autonomous node-pool conformance");
  }
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(input.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? runProcess;

  const profile = getProfile(input.profileId, options.configPath);
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but campaign.submit requires uts-ihpc`);
  }

  // C1 (ban prevention): obtain THIS account's REAL held nodes BEFORE launch, exactly like jobs/ihpc-
  // start.ts — require a fresh quota snapshot for (profileId, iHPC) and feed its active_nodes into the
  // conformance gate. `activeNodes` may be overridden for tests; otherwise it is the snapshot's own held
  // set (NEVER a cross-account union). Without this the gate sees [] and never fires (held+1 > limit).
  const quotaSnapshot = readFreshQuotaSnapshot(input.quotaSnapshotId, profile.profile_id, PLATFORM.IHPC, now);
  const activeNodes = options.activeNodes ?? snapshotActiveNodes(quotaSnapshot);

  // Read THIS campaign's saved run records (the orchestration's input). The same list-then-filter join
  // campaign.status/audit use; selectPlannedRuns inside campaignSubmit narrows to planned iHPC runs.
  const records = listRunRecordIds(options.auditDir)
    .map((id) => readRunRecordSafe(id, options.auditDir))
    .filter((record): record is RunRecord => record !== null && record.campaign_id === input.campaignId);

  const me: LeaseOwner = options.me ?? { client: "claude", device_id: "local", issued_at: now.toISOString() };

  // I1 (single-writer lease): read the REAL on-node lease for (profile, node) over SSH BEFORE planning, so
  // decideLease sees the true holder + node-clock heartbeat. A LIVE different holder => lease-blocked (no
  // launch); a stale/absent holder => acquire/takeover. Default reads the node STATE; tests inject a stub.
  const readNodeLease = options.readNodeLease ?? ((host, targetNode) => readNodeLeaseOverSsh(host, targetNode, input.campaignId, executor, timeoutMs, now));
  const nodeLease = await readNodeLease(profile.login.host_alias, input.node);

  // I2 (no phantom GPUs): bound the fabricated topology by the node's real GPU count. The brain places at
  // most one job per GPU index, so gpu_indices are [0..N-1] with N <= the node's GPU count (from the
  // profile, else a conservative default). maxConcurrent is CLAMPED to that ceiling so a large request can
  // never plan jobs onto GPU indices the node does not have. max_slots_per_gpu stays 1.
  const nodeGpuCount = Math.max(1, profile.defaults.node_gpu_count ?? DEFAULT_NODE_GPU_COUNT);
  const requested = Math.max(1, input.maxConcurrent ?? (records.length || 1));
  const slotCount = Math.min(requested, nodeGpuCount);
  const node: NodeTopology = {
    node_id: input.node,
    gpu_indices: Array.from({ length: slotCount }, (_value, index) => index),
    max_slots_per_gpu: 1
  };

  const campaign = await campaignSubmit(
    { campaignId: input.campaignId, records },
    {
      me,
      node,
      profile,
      lease: {
        nodeNowEpoch: nodeLease.nodeNowEpoch,
        heartbeatEpoch: nodeLease.heartbeatEpoch,
        staleSeconds: DEFAULT_LEASE_STALE_SECONDS,
        held: nodeLease.held
      },
      maxConcurrent: slotCount,
      slotCount,
      allowedRoots: allowedRootsFor(profile),
      envKeyAllowlist: [],
      nodeLimits: profile.defaults.node_limits,
      activeNodes,
      held: [],
      enrichRun: (record) => enrichRunFromPlan(record, options.planDir),
      launchPlan: (plan) => realLaunch(plan, profile, executor, timeoutMs, now, options.auditDir)
    }
  );

  return { campaign };
}

// The nodes THIS account currently holds, for the per-account node-pool gate (C1). Reuses the same
// sessions.active_nodes evidence ihpc-start.ts trusts; returns [] when none is observed (no held nodes =>
// no pool pressure). Strictly this profile's own snapshot — never another account's.
function snapshotActiveNodes(snapshot: QuotaSnapshot): Array<{ node: string; family?: string }> {
  const sessions = snapshot.summary.sessions as { active_nodes?: unknown } | undefined;
  if (!sessions || !Array.isArray(sessions.active_nodes)) {
    return [];
  }
  return sessions.active_nodes
    .map((entry) => {
      if (typeof entry === "string") {
        return { node: entry, family: inferNodeFamily(entry) };
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as { node?: unknown; family?: unknown };
        return {
          node: typeof record.node === "string" ? record.node : "",
          ...(typeof record.family === "string" ? { family: record.family } : {})
        };
      }
      return { node: "" };
    })
    .filter((entry) => isSafeRemoteToken(entry.node));
}

// THE on-node lease read seam (I1, real SSH). Reads the campaign's node STATE once (IHPC_STATE_READ_PY,
// whole-file, never tail — spec §2.3), and extracts the current lease holder + the node-clock heartbeat.
// STATE absence (no progressor has ever run for this campaign on this node) => no holder => acquire. The
// progressor rewrites STATE every loop with node_clock_epoch = the node's clock at that write, so we treat
// node_clock_epoch as BOTH the freshest node-clock reading AND the holder's last heartbeat: a STATE whose
// node_clock_epoch is older than the staleness window (vs now) presumes the holder dead (takeover).
async function readNodeLeaseOverSsh(
  host: string,
  node: string,
  campaignId: string,
  executor: CampaignStartExecutor,
  timeoutMs: number,
  now: Date
): Promise<NodeLeaseRead> {
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const spec = encodeSpec({ campaign_id: campaignId, kind: "state" });
  const args = sshSupervisorArgs(host, node, timeoutMs, spec);
  const result = await executor("ssh", args, timeoutMs, IHPC_STATE_READ_PY);
  if (result.exitCode !== 0) {
    // No STATE for this campaign on the node (or the read failed): treat as unheld. The node-side atomic
    // O_CREAT|O_EXCL PLAN write is the real tie-breaker if two brains both see "unheld" (lease.ts note).
    return { held: null, heartbeatEpoch: null, nodeNowEpoch: nowEpoch };
  }
  let state: { lease_owner?: { client?: unknown; device_id?: unknown }; node_clock_epoch?: unknown };
  try {
    state = parseJsonLastLine(result.stdout, "iHPC campaign state") as typeof state;
  } catch {
    return { held: null, heartbeatEpoch: null, nodeNowEpoch: nowEpoch };
  }
  const owner = state.lease_owner;
  const client = owner && typeof owner.client === "string" ? owner.client : undefined;
  const deviceId = owner && typeof owner.device_id === "string" ? owner.device_id : undefined;
  if (!client || !deviceId) {
    return { held: null, heartbeatEpoch: null, nodeNowEpoch: nowEpoch };
  }
  const nodeClockEpoch = typeof state.node_clock_epoch === "number" ? state.node_clock_epoch : null;
  return {
    held: { client: client as LeaseOwner["client"], device_id: deviceId, issued_at: now.toISOString() },
    // The STATE's node_clock_epoch is the holder's freshest node-clock heartbeat moment.
    heartbeatEpoch: nodeClockEpoch,
    // Compare against the node clock: prefer the node's own clock if it is AHEAD of our last-seen epoch,
    // else our wall clock as epoch. Using max() avoids a negative age from clock skew making a live holder
    // look stale.
    nodeNowEpoch: nodeClockEpoch === null ? nowEpoch : Math.max(nodeClockEpoch, nowEpoch)
  };
}

// enrichRun (local, no SSH): resolve a planned run's launch fields from its verified plan artifact —
// command_argv (saved for iHPC plans) + workdir (normalized spec) + env + timeout.
function enrichRunFromPlan(record: RunRecord, planDir: string | undefined): QueueRunRecord {
  const plan = readVerifiedPlan(record.run_id, planDir);
  const argv = plan.command_argv;
  const workdir = plan.normalized_job_spec.workdir;
  if (!argv?.length || !workdir) {
    throw new Error(`Planned iHPC run ${record.run_id} is missing command_argv/workdir for launch`);
  }
  // M2: defense-in-depth parity with the single-run path (jobs/ihpc-start.ts buildSupervisorSpec) — reject
  // a workdir carrying shell-active or traversal characters before it ever reaches a node command line. It
  // is inert today (the PLAN ships a clean argv and the node validates allowed_roots), but keeping the
  // campaign workdir under the SAME guard removes the asymmetry.
  assertSafeRemotePathTemplate(workdir, "campaign workdir");
  return {
    ...record,
    command_argv: argv,
    workdir,
    env: {},
    timeout_seconds: walltimeSecondsFor(plan.normalized_job_spec.resources.walltime)
  };
}

// THE SSH SEAM: bind launchIhpcCampaign with the real durable PLAN write + progressor start + store
// persistence. This is the only IO in the whole flow. Tests inject a mock executor.
async function realLaunch(
  plan: Parameters<typeof launchIhpcCampaign>[0]["plan"],
  profile: ComputeProfile,
  executor: CampaignStartExecutor,
  timeoutMs: number,
  now: Date,
  auditDir: string | undefined
): Promise<LaunchResult> {
  return launchIhpcCampaign(
    { plan, profile },
    {
      now,
      sshWriteAtomicJson: async (host, targetNode, remotePath, obj) => {
        const encoded = encodeSpec({ path: remotePath, contents: JSON.stringify(obj) });
        const args = sshWriteAtomicJsonArgs(host, targetNode, timeoutMs, encoded);
        const result = await executor("ssh", args, timeoutMs, ATOMIC_WRITE_PY);
        if (result.exitCode !== 0) {
          throw new Error(`campaign PLAN write failed: ${result.stderr || `exit ${String(result.exitCode)}`}`);
        }
      },
      startProgressor: async (host, targetNode, stdin) => {
        const encoded = encodeSpec({ campaign_id: plan.campaign_id });
        const args = sshSupervisorArgs(host, targetNode, timeoutMs, encoded);
        const result = await executor("ssh", args, timeoutMs, stdin);
        if (result.exitCode !== 0) {
          throw new Error(`campaign progressor start failed: ${result.stderr || `exit ${String(result.exitCode)}`}`);
        }
        // The progressor DAEMONIZES on the node (python-side fork/setsid): the foreground `python3 -`
        // parent prints `{"pid":<daemon child>}` on stdout and exits 0, so the SSH channel closes well
        // under the timeout while the detached loop survives the channel teardown. A real, non-zero pid
        // is therefore REQUIRED for a successful launch: a clean exit with pid 0/absent means the parent
        // never reported a daemon (e.g. it was foreground-killed at the timeout), which is a launch
        // FAILURE to surface — not a silent success that records supervisor pid=0 over a stalled queue.
        const pid = parseProgressorPid(result.stdout);
        if (pid <= 0) {
          throw new Error(
            `campaign progressor start did not report a daemon pid (got ${pid}); the node-side fork/setsid ` +
            `daemonization must print {"pid":N} before the SSH channel closes — refusing to record a stalled launch`
          );
        }
        return { pid };
      },
      persistRunRecord: (rec) => {
        writeRunRecord(rec, auditDir);
      },
      auditDir
    }
  );
}

// The PLAN's idle/timeout budget: the planned walltime in seconds, or the default when none was set.
// M1: validate the HH:MM:SS components — reject negatives and minutes/seconds >= 60 (a malformed walltime
// like "1:-5:00" or "0:99:00" must not silently produce a nonsense or negative budget). Falls back to the
// default when the shape is not a clean three-part time.
export function walltimeSecondsFor(walltime: string | undefined): number {
  if (!walltime) return DEFAULT_TIMEOUT_SECONDS;
  const parts = walltime.split(":").map((value) => Number.parseInt(value, 10));
  if (
    parts.length === 3 &&
    parts.every((value) => Number.isFinite(value) && value >= 0) &&
    parts[1] < 60 &&
    parts[2] < 60
  ) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return DEFAULT_TIMEOUT_SECONDS;
}

function allowedRootsFor(profile: ComputeProfile): string[] {
  return [profile.defaults.workspace, profile.defaults.scratch, profile.defaults.project].filter(
    (value): value is string => Boolean(value)
  );
}

// Parse the daemon pid the progressor's foreground parent prints right before it forks+exits. On the
// node the parent emits a single `{"pid":<daemon child>}` line on the ORIGINAL stdout (before the child
// redirects to <state_dir>/progressor.log), so the LAST clean JSON line carrying an integer pid > 1 is
// the detached daemon's real pid. Returns 0 when no such line is present (a foreground-killed / non-
// daemonizing start); the caller treats 0 as a LAUNCH FAILURE, never a silent "started, pid unknown".
function parseProgressorPid(stdout: string): number {
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (line) {
    try {
      const parsed = JSON.parse(line) as { pid?: unknown };
      if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 1) {
        return parsed.pid;
      }
    } catch {
      // fall through to the not-reported sentinel
    }
  }
  return 0;
}
