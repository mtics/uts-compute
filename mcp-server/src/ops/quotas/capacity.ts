// Capacity advisor: turn a quota snapshot into per-queue headroom and a recommended parallelism, so
// the agent knows BEFORE submitting how many jobs it can run now and which queue has room. This is
// the same live data the conformance gate uses (running/queued counts + per-user max_run), surfaced
// as advice instead of a binary pass/fail. Pure and read-only — no SSH, no mutation.

import { getProfile } from "../../core/config.js";
import { readQuotaSnapshot } from "../approvals/approvals.js";
import { refreshQuotas } from "./quotas.js";
import type { CommandExecutor } from "../../core/access.js";
import {
  computeNodePoolOccupancy,
  effectiveUserLimit,
  totalNodeHeadroom,
  type NodeLimitPool,
  type NodePoolOccupancy,
  type ParsedFilesystem,
  type PbsQueueLimit
} from "./quota-limits.js";
import { PLATFORM } from "../../core/types.js";
import type { Platform, QuotaSnapshot } from "../../core/types.js";

const FRESH_MINUTES = 15;

export interface QuotaCapacityInput {
  profileId: string;
  snapshotId: string;
  // Opt-in: when true, capture a FRESH snapshot via quotas.refresh first, then advise on it (no
  // stale-age note). Default/absent reads the saved snapshotId. The annotation flips to READ_REMOTE
  // because this path contacts the cluster over SSH (read-only quota probes only).
  refresh?: boolean;
}

export interface QuotaCapacityOptions {
  configPath?: string;
  now?: Date;
  // Executor seam mirroring the job ops: lets the protocol/unit tests drive the refresh path with a
  // mock SSH executor. Only used when input.refresh is true; defaults to the real SSH executor.
  executor?: CommandExecutor;
}

// Tool entry: report capacity for a profile. Two paths:
//   - refresh:false/absent (default) — read the saved snapshot quotas.refresh captured; read-only and
//     local, contacts nothing. A stale snapshot is reported (age_minutes + a note), not rejected.
//   - refresh:true — capture a fresh snapshot first (live quotas.refresh, executor seam), then advise
//     on it. Contacts the cluster over SSH (read-only). Returns a Promise.
// Overloaded so the default path keeps its synchronous `{ capacity }` return (existing callers don't
// await) while the refresh path is async.
export function quotaCapacity(
  input: QuotaCapacityInput & { refresh: true },
  options?: QuotaCapacityOptions
): Promise<{ capacity: CapacityReport }>;
export function quotaCapacity(
  input: QuotaCapacityInput & { refresh?: false | undefined },
  options?: QuotaCapacityOptions
): { capacity: CapacityReport };
export function quotaCapacity(
  input: QuotaCapacityInput,
  options?: QuotaCapacityOptions
): { capacity: CapacityReport } | Promise<{ capacity: CapacityReport }>;
export function quotaCapacity(
  input: QuotaCapacityInput,
  options: QuotaCapacityOptions = {}
): { capacity: CapacityReport } | Promise<{ capacity: CapacityReport }> {
  if (input.refresh) {
    return refreshAndReport(input, options);
  }
  const profile = getProfile(input.profileId, options.configPath);
  const snapshot = readQuotaSnapshot(input.snapshotId);
  return { capacity: reportFromSnapshot(input, profile, snapshot, options) };
}

async function refreshAndReport(
  input: QuotaCapacityInput,
  options: QuotaCapacityOptions
): Promise<{ capacity: CapacityReport }> {
  const now = options.now ?? new Date();
  const profile = getProfile(input.profileId, options.configPath);
  const { snapshot } = await refreshQuotas(input.profileId, {
    configPath: options.configPath,
    // Persist the snapshot: refreshAndReport returns its snapshot_id (CapacityReport.snapshot_id), and
    // downstream tools (sweep.plan -> capacityTune -> readQuotaSnapshot) read `<id>.json` back from
    // disk. Leaving it in memory only made the returned id a dangling reference (a late ENOENT).
    writeEvidence: true,
    executor: options.executor,
    now
  });
  // The fresh snapshot is for input.profileId by construction; share the same advisory builder so the
  // freshness/platform invariants stay identical to the saved-snapshot path.
  return { capacity: reportFromSnapshot(input, profile, snapshot, { ...options, now }) };
}

function reportFromSnapshot(
  input: QuotaCapacityInput,
  profile: ReturnType<typeof getProfile>,
  snapshot: QuotaSnapshot,
  options: QuotaCapacityOptions
): CapacityReport {
  const now = options.now ?? new Date();
  if (snapshot.profile_id !== input.profileId) {
    throw new Error(`Quota snapshot ${input.snapshotId} is for ${snapshot.profile_id}, not ${input.profileId}`);
  }
  if (snapshot.platform !== profile.platform) {
    throw new Error(`Quota snapshot ${input.snapshotId} platform ${snapshot.platform} does not match profile ${profile.platform}`);
  }
  const identity = (snapshot.summary.identity ?? {}) as { groups?: string[] };
  const groups = Array.isArray(identity.groups) ? identity.groups : [];
  const nodeLimits = Array.isArray(profile.defaults.node_limits) ? profile.defaults.node_limits : null;
  return computeCapacity(snapshot, remoteUserFromHostAlias(profile.login.host_alias), groups, now, nodeLimits);
}

function remoteUserFromHostAlias(hostAlias: string): string {
  const at = hostAlias.indexOf("@");
  return at >= 0 ? hostAlias.slice(0, at) : hostAlias;
}

export interface QueueCapacity {
  queue: string;
  enabled: boolean;
  started: boolean;
  running: number;
  queued: number;
  max_run: number | null;
  max_queued: number | null;
  run_headroom: number | null;
  queued_headroom: number | null;
  recommended_parallel: number | null;
  acceptable: boolean;
  note?: string;
}

export interface StorageCapacity {
  filesystem: string;
  mounted_on: string;
  capacity_percent: number;
  avail: string;
}

export interface IhpcCapacity {
  available_families: string[];
  all_families: string[];
  active_sessions: number;
  // Per-pool held/limit/headroom from the profile's defaults.node_limits, computed by the shared
  // node-limit primitives (quota-limits.ts). Empty when not configured (the caps are not
  // SSH-queryable; see the portal "My Node Limits"). Pools are independent — never one total cap.
  segments: NodePoolOccupancy[];
}

export interface CapacityReport {
  mode: "read-only";
  profile_id: string;
  platform: Platform;
  snapshot_id: string;
  observed_at: string;
  freshness: QuotaSnapshot["freshness"];
  age_minutes: number | null;
  queues: QueueCapacity[];
  ihpc?: IhpcCapacity;
  storage: StorageCapacity[];
  best_queue: string | null;
  recommended_parallel: number | null;
  notes: string[];
}

export function computeCapacity(
  snapshot: QuotaSnapshot,
  username: string,
  groups: string[],
  now: Date,
  nodeLimits: NodeLimitPool[] | null = null
): CapacityReport {
  const observedMs = Date.parse(snapshot.observed_at);
  const ageMinutes = Number.isFinite(observedMs) ? Math.max(0, Math.round((now.getTime() - observedMs) / 60000)) : null;
  const notes: string[] = [];
  if (ageMinutes !== null && ageMinutes > FRESH_MINUTES) {
    notes.push(`Snapshot is ${ageMinutes} min old (> ${FRESH_MINUTES}); refresh quotas before relying on these numbers.`);
  }

  const storage = extractStorage(snapshot).map((fs) => ({
    filesystem: fs.filesystem,
    mounted_on: fs.mounted_on,
    capacity_percent: fs.capacity_percent,
    avail: fs.avail
  }));

  const base = {
    mode: "read-only" as const,
    profile_id: snapshot.profile_id,
    platform: snapshot.platform,
    snapshot_id: snapshot.snapshot_id,
    observed_at: snapshot.observed_at,
    freshness: snapshot.freshness,
    age_minutes: ageMinutes,
    storage
  };

  if (snapshot.platform === PLATFORM.IHPC) {
    const ihpc = extractIhpc(snapshot, nodeLimits);
    notes.push("iHPC is interactive: capacity is the available cnode families and active sessions, not PBS queue headroom.");
    if (ihpc.segments.length > 0) {
      const parts = ihpc.segments.map((seg) => `${seg.families.join("/")}: ${seg.held}/${seg.limit} held (${seg.headroom} free)`);
      notes.push(
        `iHPC node limits (independent pools) — ${parts.join("; ")}. Do not exceed any pool's cap; ` +
          "exceeding an iHPC node limit can disable the account."
      );
    } else {
      notes.push(
        'iHPC node limits not configured for this profile; set defaults.node_limits from the portal "My Node Limits" ' +
          "so capacity can advise held-vs-limit headroom per pool."
      );
    }
    // When pools are known, parallelism is the total remaining headroom across the independent pools
    // (e.g. 2 general + 2 turing); otherwise fall back to the count of available families.
    return {
      ...base,
      queues: [],
      ihpc,
      best_queue: null,
      recommended_parallel: ihpc.segments.length > 0 ? totalNodeHeadroom(ihpc.segments) : ihpc.available_families.length,
      notes
    };
  }

  const byQueue = extractByQueue(snapshot);
  const queues = extractQueueLimits(snapshot).map((limit) => toQueueCapacity(limit, byQueue, username, groups));

  // Best queue = the acceptable queue with the most finite run-headroom; recommended parallelism is
  // that headroom. When every acceptable queue is uncapped (no per-user max_run), fall back to the
  // first acceptable one with an unknown (null) recommendation.
  const acceptable = queues.filter((queue) => queue.acceptable);
  const withHeadroom = acceptable.filter((queue) => queue.run_headroom !== null);
  let best: QueueCapacity | undefined;
  if (withHeadroom.length > 0) {
    best = withHeadroom.reduce((top, queue) => ((queue.run_headroom ?? 0) > (top.run_headroom ?? 0) ? queue : top));
  } else if (acceptable.length > 0) {
    best = acceptable[0];
    notes.push("No per-user max_run cap observed on the acceptable queues; parallelism is not bounded by quota here.");
  }
  if (acceptable.length === 0) {
    notes.push("No queue currently has run headroom for this account; wait for running jobs to finish or pick another queue.");
  }

  return {
    ...base,
    queues,
    best_queue: best?.queue ?? null,
    recommended_parallel: best ? best.recommended_parallel : null,
    notes
  };
}

function toQueueCapacity(
  limit: PbsQueueLimit,
  byQueue: Record<string, { running: number; queued: number }>,
  username: string,
  groups: string[]
): QueueCapacity {
  const counts = lookupQueueCounts(byQueue, limit.name);
  const maxRun = effectiveUserLimit(limit.max_run, username, groups) ?? null;
  const maxQueued = effectiveUserLimit(limit.max_queued, username, groups) ?? null;
  const runHeadroom = maxRun === null ? null : Math.max(0, maxRun - counts.running);
  const queuedHeadroom = maxQueued === null ? null : Math.max(0, maxQueued - counts.queued);
  const open = limit.enabled && limit.started;
  const acceptable = open && runHeadroom !== 0 && queuedHeadroom !== 0;
  let note: string | undefined;
  if (!limit.enabled || !limit.started) {
    note = "queue disabled or not started";
  } else if (runHeadroom === 0) {
    note = "at per-user max_run";
  } else if (queuedHeadroom === 0) {
    note = "at per-user max_queued";
  }
  return {
    queue: limit.name,
    enabled: limit.enabled,
    started: limit.started,
    running: counts.running,
    queued: counts.queued,
    max_run: maxRun,
    max_queued: maxQueued,
    run_headroom: runHeadroom,
    queued_headroom: queuedHeadroom,
    recommended_parallel: acceptable ? runHeadroom : 0,
    acceptable,
    ...(note ? { note } : {})
  };
}

function lookupQueueCounts(
  byQueue: Record<string, { running: number; queued: number }>,
  queue: string
): { running: number; queued: number } {
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

function extractQueueLimits(snapshot: QuotaSnapshot): PbsQueueLimit[] {
  const queues = (snapshot.summary.queues ?? {}) as { queue_limits?: PbsQueueLimit[] };
  return Array.isArray(queues.queue_limits) ? queues.queue_limits : [];
}

function extractByQueue(snapshot: QuotaSnapshot): Record<string, { running: number; queued: number }> {
  const running = (snapshot.summary.running_work ?? {}) as {
    by_queue?: Record<string, { running: number; queued: number }>;
  };
  return running.by_queue ?? {};
}

function extractStorage(snapshot: QuotaSnapshot): ParsedFilesystem[] {
  const storage = (snapshot.summary.storage ?? {}) as { filesystems?: ParsedFilesystem[] };
  return Array.isArray(storage.filesystems) ? storage.filesystems : [];
}

// Business function: read the iHPC node/session/family evidence from the snapshot and compose the
// node-limit primitives (computeNodePoolOccupancy) into the per-pool advisory view. The pure pool
// math lives in quota-limits.ts so the same logic can back a future submission/conformance gate.
function extractIhpc(snapshot: QuotaSnapshot, nodeLimits: NodeLimitPool[] | null): IhpcCapacity {
  const families = (snapshot.summary.node_families ?? {}) as { available_families?: string[]; all_families?: string[] };
  const running = (snapshot.summary.running_work ?? {}) as { active_session_count?: number };
  const activeSessions = typeof running.active_session_count === "number" ? running.active_session_count : 0;
  const sessions = (snapshot.summary.sessions ?? {}) as { active_nodes?: Array<{ node?: string; family?: string }> };
  const activeNodes = Array.isArray(sessions.active_nodes) ? sessions.active_nodes : [];

  return {
    available_families: Array.isArray(families.available_families) ? families.available_families : [],
    all_families: Array.isArray(families.all_families) ? families.all_families : [],
    active_sessions: activeSessions,
    segments: computeNodePoolOccupancy(nodeLimits ?? [], activeNodes)
  };
}
