// Quota-envelope conformance: does a planned job fit within the account's live per-queue limits?
// Replaces the per-submission human-approval token for autonomous submission (see ADR 0004).

import type { PbsQueueLimit, ParsedFilesystem, NodeLimitPool } from "./quota-limits.js";
import { parseWalltimeSeconds, effectiveUserLimit, inferNodeFamily, computeNodePoolOccupancy, nodeInPool } from "./quota-limits.js";

// A filesystem at or above this observed capacity is treated as out of headroom. Storage on
// the UTS platforms is shared NFS with no per-user quota (ADR 0004), so this is a "don't write
// to a full disk" guard, not a quota gate; the scheduler/filesystem remains authoritative.
const DEFAULT_CAPACITY_CEILING_PERCENT = 99;

export interface StorageHeadroomOptions {
  capacityCeilingPercent?: number;
  minAvailBytes?: number;
  targetPath?: string;
}

// Pick the filesystem whose mount point is the longest prefix of the target path — the mount
// the target actually lives on. Returns null when nothing matches.
function filesystemForTarget(filesystems: ParsedFilesystem[], targetPath: string): ParsedFilesystem | null {
  let best: ParsedFilesystem | null = null;
  for (const filesystem of filesystems) {
    const mount = filesystem.mounted_on;
    const matches = targetPath === mount || targetPath.startsWith(mount.endsWith("/") ? mount : `${mount}/`);
    if (matches && (!best || mount.length > best.mounted_on.length)) {
      best = filesystem;
    }
  }
  return best;
}

// Advisory storage-headroom conformance: refuses only when the relevant filesystem is
// observably out of headroom. A no-op when no availability was observed (where observable).
export function checkStorageHeadroom(
  filesystems: ParsedFilesystem[] | undefined,
  options: StorageHeadroomOptions = {}
): ConformanceViolation[] {
  if (!filesystems || filesystems.length === 0) {
    return [];
  }
  const ceiling = options.capacityCeilingPercent ?? DEFAULT_CAPACITY_CEILING_PERCENT;
  const scope = options.targetPath
    ? ((match) => (match ? [match] : []))(filesystemForTarget(filesystems, options.targetPath))
    : filesystems;
  const violations: ConformanceViolation[] = [];
  for (const filesystem of scope) {
    if (Number.isFinite(filesystem.capacity_percent) && filesystem.capacity_percent >= ceiling) {
      violations.push({
        code: "storage-full",
        limit: "storage.capacity",
        requested: filesystem.mounted_on,
        allowed: `<${ceiling}%`,
        message: `filesystem ${filesystem.mounted_on} is ${filesystem.capacity_percent}% full (ceiling ${ceiling}%)`
      });
      continue;
    }
    if (
      typeof options.minAvailBytes === "number" &&
      typeof filesystem.avail_bytes === "number" &&
      filesystem.avail_bytes < options.minAvailBytes
    ) {
      violations.push({
        code: "storage-headroom",
        limit: "storage.avail_bytes",
        requested: options.minAvailBytes,
        allowed: filesystem.avail_bytes,
        message: `filesystem ${filesystem.mounted_on} has ${filesystem.avail_bytes} bytes free, below the requested ${options.minAvailBytes}`
      });
    }
  }
  return violations;
}

export interface ConformanceViolation {
  code: string;
  limit: string;
  requested?: string | number;
  allowed?: string | number;
  message: string;
}

export interface ConformanceInput {
  queue: string;
  ncpus?: number;
  memory_gb?: number;
  walltime?: string;
  ngpus?: number;
  username: string;
  groups?: string[];
  queueLimit?: PbsQueueLimit;
  // Whether the snapshot positively observed the queue's structured limits (`qstat -Qf`). When
  // explicitly false, autonomous conformance is refused — we won't pass a job on missing limit data.
  limitsObserved?: boolean;
  runningInQueue: number;
  queuedInQueue: number;
  storage?: {
    filesystems?: ParsedFilesystem[];
    targetPath?: string;
    minAvailBytes?: number;
  };
}

export interface ConformanceResult {
  conforms: boolean;
  queue: string;
  violations: ConformanceViolation[];
}

// A queue ACL permits the account if no ACL gate is active, or if the user or group gate grants access.
function aclPermits(queueLimit: PbsQueueLimit, username: string, groups: string[]): boolean {
  const userGate = queueLimit.acl_user_enable ? (queueLimit.acl_users ?? []).includes(username) : null;
  const groupGate = queueLimit.acl_group_enable
    ? (queueLimit.acl_groups ?? []).some((group) => groups.includes(group))
    : null;
  if (userGate === null && groupGate === null) {
    return true;
  }
  return userGate === true || groupGate === true;
}

export function checkPbsConformance(input: ConformanceInput): ConformanceResult {
  const violations: ConformanceViolation[] = [];
  const { queue, queueLimit } = input;
  const groups = input.groups ?? [];

  // Fail-safe: only auto-submit when the snapshot positively observed the queue's structured limits.
  // If `qstat -Qf` was not captured, conformance is unverifiable, so refuse (the caller falls back to
  // requiring an explicit approval) rather than letting the job through on the scheduler backstop.
  if (input.limitsObserved === false) {
    violations.push({
      code: "limits-unverified",
      limit: "queue",
      requested: queue,
      message: `Queue ${queue} resource limits were not observed in the quota snapshot; cannot verify conformance for autonomous submission`
    });
    return { conforms: false, queue, violations };
  }

  if (!queueLimit) {
    violations.push({
      code: "unknown-queue",
      limit: "queue",
      requested: queue,
      message: `Queue ${queue} is not present in the account's live quota snapshot`
    });
    return { conforms: false, queue, violations };
  }

  if (!queueLimit.enabled || !queueLimit.started) {
    violations.push({
      code: "queue-disabled",
      limit: "queue",
      message: `Queue ${queue} is not both enabled and started`
    });
  }

  if (!aclPermits(queueLimit, input.username, groups)) {
    violations.push({
      code: "acl-denied",
      limit: "acl",
      requested: input.username,
      message: `Account ${input.username} is not permitted to submit to queue ${queue}`
    });
  }

  const max = queueLimit.resources_max;
  if (typeof input.ncpus === "number" && typeof max.ncpus === "number" && input.ncpus > max.ncpus) {
    violations.push({
      code: "ncpus-exceeded",
      limit: "resources_max.ncpus",
      requested: input.ncpus,
      allowed: max.ncpus,
      message: `ncpus ${input.ncpus} exceeds queue ${queue} max ${max.ncpus}`
    });
  }
  if (typeof input.memory_gb === "number" && typeof max.mem_gb === "number" && input.memory_gb > max.mem_gb) {
    violations.push({
      code: "mem-exceeded",
      limit: "resources_max.mem",
      requested: input.memory_gb,
      allowed: max.mem_gb,
      message: `memory ${input.memory_gb}gb exceeds queue ${queue} max ${max.mem_gb}gb`
    });
  }
  if (typeof input.ngpus === "number" && typeof max.ngpus === "number" && input.ngpus > max.ngpus) {
    violations.push({
      code: "ngpus-exceeded",
      limit: "resources_max.ngpus",
      requested: input.ngpus,
      allowed: max.ngpus,
      message: `ngpus ${input.ngpus} exceeds queue ${queue} max ${max.ngpus}`
    });
  }
  if (input.walltime && typeof max.walltime_seconds === "number") {
    const requested = parseWalltimeSeconds(input.walltime);
    if (typeof requested === "number" && requested > max.walltime_seconds) {
      violations.push({
        code: "walltime-exceeded",
        limit: "resources_max.walltime",
        requested: input.walltime,
        allowed: max.walltime_seconds,
        message: `walltime ${input.walltime} exceeds queue ${queue} max`
      });
    }
  }

  const maxRun = effectiveUserLimit(queueLimit.max_run, input.username, groups);
  if (typeof maxRun === "number" && input.runningInQueue + 1 > maxRun) {
    violations.push({
      code: "max-run-exceeded",
      limit: "max_run",
      requested: input.runningInQueue + 1,
      allowed: maxRun,
      message: `submitting would exceed the per-user running cap ${maxRun} in queue ${queue}`
    });
  }
  const maxQueued = effectiveUserLimit(queueLimit.max_queued, input.username, groups);
  if (typeof maxQueued === "number" && input.queuedInQueue + 1 > maxQueued) {
    violations.push({
      code: "max-queued-exceeded",
      limit: "max_queued",
      requested: input.queuedInQueue + 1,
      allowed: maxQueued,
      message: `submitting would exceed the per-user queued cap ${maxQueued} in queue ${queue}`
    });
  }

  if (input.storage) {
    violations.push(
      ...checkStorageHeadroom(input.storage.filesystems, {
        targetPath: input.storage.targetPath,
        minAvailBytes: input.storage.minAvailBytes
      })
    );
  }

  return { conforms: violations.length === 0, queue, violations };
}

export interface IhpcNodePoolConformanceInput {
  // The iHPC compute node a supervised run will use (e.g. "turing3").
  targetNode: string;
  // The profile's own per-pool simultaneous node-occupation caps (`defaults.node_limits`), read from
  // the portal "My Node Limits". Unset => no enforceable cap (operator must configure it).
  nodeLimits?: NodeLimitPool[];
  // The nodes THIS account currently holds (from its own fresh quota snapshot). NEVER the union of
  // other accounts' nodes — this check is strictly per-profile.
  activeNodes?: Array<{ node?: string; family?: string }>;
}

export interface IhpcNodePoolConformanceResult {
  conforms: boolean;
  targetNode: string;
  violations: ConformanceViolation[];
}

// HARD per-account iHPC node-pool gate (ENFORCEMENT, not evasion). A single account exceeding its
// OWN node-pool cap is exactly what triggers an iHPC ban; this check structurally prevents it.
//
// Pure: given the target node, the profile's own node_limits, and the nodes THIS account currently
// holds, find the pool the target belongs to and refuse if using it would push that pool over its
// cap (`held + 1 > limit`, mirroring checkPbsConformance's `runningInQueue + 1 > maxRun`). When the
// target is already among the held nodes (a supervised run launches a process ON an already-held
// node) it is excluded from `held` so legitimately reusing a held node is not falsely +1'd.
//
// This NEVER sums usage across accounts: `activeNodes` is one profile's own held set. With no
// node_limits configured there is no enforceable cap (the portal limits are not SSH-queryable).
export function checkIhpcNodePoolConformance(input: IhpcNodePoolConformanceInput): IhpcNodePoolConformanceResult {
  const targetNode = input.targetNode;
  const pools = input.nodeLimits ?? [];
  const activeNodes = input.activeNodes ?? [];
  const violations: ConformanceViolation[] = [];

  const targetFamily = inferNodeFamily(targetNode);
  // The independent pool whose families contain the target node (pools are independent; the target
  // belongs to at most one). If the target is in no configured pool there is no cap to enforce.
  const pool = pools.find((candidate) => nodeInPool(targetNode, targetFamily, candidate.families));
  if (!pool) {
    return { conforms: true, targetNode, violations };
  }

  // Count the account's OWN currently-held nodes in this pool, EXCLUDING the target node itself so a
  // process launched on an already-held node is not double-counted as a fresh acquisition.
  const otherHeld = activeNodes.filter((node) => (typeof node.node === "string" ? node.node : "") !== targetNode);
  const [occupancy] = computeNodePoolOccupancy([pool], otherHeld);
  const held = occupancy.held;
  if (held + 1 > pool.limit) {
    violations.push({
      code: "node-pool-exceeded",
      limit: "node_limits",
      requested: held + 1,
      allowed: pool.limit,
      message: `using node ${targetNode} would exceed this account's iHPC node-pool cap ${pool.limit} for families [${pool.families.join(", ")}] (held ${held})`
    });
  }

  return { conforms: violations.length === 0, targetNode, violations };
}
