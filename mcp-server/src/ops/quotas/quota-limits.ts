// Structured per-queue PBS limits parsed from `qstat -Qf`, used by the quota-envelope
// conformance check that lets the Agent submit autonomously within real account limits.

// The strict HH:MM:SS walltime parser now lives in the shared lib/walltime.ts codec; re-exported
// here so existing `./quota-limits.js` importers (conformance, retry, rightsize) keep their import.
export { parseWalltimeSeconds } from "../../lib/walltime.js";
import { parseWalltimeSeconds } from "../../lib/walltime.js";

// The iHPC compute-node families (login-node name prefixes). Hardcoded byte-identically in quotas.ts
// and ihpc-start.ts, plus the `inferNodeFamily` matcher that walked the list; centralised here so a
// new family is added in one place and the two parsers can't drift. The match is a lowercase
// startsWith over this ordered list (first match wins), preserving the prior behaviour exactly.
export const IHPC_NODE_FAMILIES = ["mars", "mercury", "venus", "jupiter", "saturn", "neptune"] as const;

export function inferNodeFamily(node: string): string | undefined {
  return IHPC_NODE_FAMILIES.find((family) => node.toLowerCase().startsWith(family));
}

// --- iHPC node-limit pool primitives -------------------------------------------------------------
// iHPC caps the number of nodes a user holds at once, segmented into INDEPENDENT pools (a group of
// node families sharing one cap), e.g. a Research general pool {mars,mercury,venus}=2 plus a
// special-group {turing}=2. The per-user caps are authoritative only from the portal "My Node
// Limits" (not SSH-queryable), so a pool list is configured on the profile (defaults.node_limits).
// These pure primitives turn (pools + the user's currently-held nodes) into per-pool occupancy; the
// capacity advisor and any future submission/conformance gate compose them rather than re-deriving.

export interface NodeLimitPool {
  families: string[];
  limit: number;
}

export interface NodePoolOccupancy extends NodeLimitPool {
  held: number;
  headroom: number;
}

// Does a held node belong to this pool? Prefer its parsed family; fall back to inferNodeFamily and
// then to a raw node-id prefix match (so a held "turing1" classifies even when its family was not
// tagged by the snapshot parser).
export function nodeInPool(nodeId: string, family: string | undefined, families: string[]): boolean {
  const resolved = family ?? inferNodeFamily(nodeId);
  if (resolved && families.includes(resolved)) {
    return true;
  }
  const id = nodeId.toLowerCase();
  return families.some((candidate) => id.startsWith(candidate.toLowerCase()));
}

// Per-pool held count and remaining headroom for the user's currently-held nodes. Pools are
// independent: held is counted per pool, never summed into one global cap (the general pool's 2 is
// shared across its families, separate from a turing pool's 2).
export function computeNodePoolOccupancy(
  pools: NodeLimitPool[],
  activeNodes: Array<{ node?: string; family?: string }>
): NodePoolOccupancy[] {
  return pools.map((pool) => {
    const held = activeNodes.filter((node) =>
      nodeInPool(typeof node.node === "string" ? node.node : "", node.family, pool.families)
    ).length;
    return { families: pool.families, limit: pool.limit, held, headroom: Math.max(0, pool.limit - held) };
  });
}

// Total nodes still claimable across the independent pools (e.g. 2 general + 2 turing = 4).
export function totalNodeHeadroom(occupancy: NodePoolOccupancy[]): number {
  return occupancy.reduce((sum, pool) => sum + pool.headroom, 0);
}

export interface PbsLimitSpec {
  perUserGeneric?: number;
  perUser?: Record<string, number>;
  perGroup?: Record<string, number>;
  overall?: number;
}

export interface PbsQueueLimit {
  name: string;
  queue_type?: string;
  enabled: boolean;
  started: boolean;
  resources_max: { ncpus?: number; mem_gb?: number; walltime_seconds?: number; ngpus?: number };
  max_run?: PbsLimitSpec;
  max_queued?: PbsLimitSpec;
  acl_user_enable?: boolean;
  acl_users?: string[];
  acl_group_enable?: boolean;
  acl_groups?: string[];
}

const MEM_UNIT_TO_GB: Record<string, number> = {
  b: 1 / 1024 / 1024 / 1024,
  kb: 1 / 1024 / 1024,
  mb: 1 / 1024,
  gb: 1,
  tb: 1024
};

export function parseMemGb(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * MEM_UNIT_TO_GB[match[2].toLowerCase()];
}

// Parse PBS scoped limit syntax like "[u:PBS_GENERIC=60]" or "[u:alice=10,u:PBS_GENERIC=4]".
export function parsePbsLimitSpec(value: string): PbsLimitSpec {
  const spec: PbsLimitSpec = {};
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  for (const part of inner.split(",")) {
    const match = /^([ugo]):([^=]+)=(\d+)$/.exec(part.trim());
    if (!match) {
      continue;
    }
    const [, scope, rawName, rawNum] = match;
    const name = rawName.trim();
    const num = Number(rawNum);
    if (scope === "u") {
      if (name === "PBS_GENERIC") {
        spec.perUserGeneric = num;
      } else {
        (spec.perUser ??= {})[name] = num;
      }
    } else if (scope === "g") {
      (spec.perGroup ??= {})[name] = num;
    } else if (scope === "o") {
      spec.overall = num;
    }
  }
  return spec;
}

// The cap that actually binds this user: user-specific, else group-specific, else generic, else overall.
export function effectiveUserLimit(spec: PbsLimitSpec | undefined, username: string, groups: string[] = []): number | undefined {
  if (!spec) {
    return undefined;
  }
  if (spec.perUser && spec.perUser[username] !== undefined) {
    return spec.perUser[username];
  }
  if (spec.perGroup) {
    const matches = groups
      .map((group) => spec.perGroup![group])
      .filter((value): value is number => typeof value === "number");
    if (matches.length > 0) {
      return Math.min(...matches);
    }
  }
  if (spec.perUserGeneric !== undefined) {
    return spec.perUserGeneric;
  }
  if (spec.overall !== undefined) {
    return spec.overall;
  }
  return undefined;
}

function parseAclList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.split("@")[0].trim())
    .filter(Boolean);
}

export function parsePbsQueueLimits(qstatQfText: string): PbsQueueLimit[] {
  const queues: PbsQueueLimit[] = [];
  let current: PbsQueueLimit | undefined;
  for (const rawLine of qstatQfText.split("\n")) {
    const queueMatch = /^Queue:\s*(\S+)/.exec(rawLine);
    if (queueMatch) {
      current = { name: queueMatch[1], enabled: false, started: false, resources_max: {} };
      queues.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    const kv = /^\s+([^=]+?)\s*=\s*(.*)$/.exec(rawLine);
    if (!kv) {
      continue;
    }
    const key = kv[1].trim();
    const value = kv[2].trim();
    switch (key) {
      case "queue_type":
        current.queue_type = value;
        break;
      case "enabled":
        current.enabled = value === "True";
        break;
      case "started":
        current.started = value === "True";
        break;
      case "resources_max.ncpus":
        current.resources_max.ncpus = Number(value);
        break;
      case "resources_max.ngpus":
        current.resources_max.ngpus = Number(value);
        break;
      case "resources_max.mem":
        current.resources_max.mem_gb = parseMemGb(value);
        break;
      case "resources_max.walltime":
        current.resources_max.walltime_seconds = parseWalltimeSeconds(value);
        break;
      case "max_run":
        current.max_run = parsePbsLimitSpec(value);
        break;
      case "max_queued":
        current.max_queued = parsePbsLimitSpec(value);
        break;
      case "acl_user_enable":
        current.acl_user_enable = value === "True";
        break;
      case "acl_users":
        current.acl_users = parseAclList(value);
        break;
      case "acl_group_enable":
        current.acl_group_enable = value === "True";
        break;
      case "acl_groups":
        current.acl_groups = parseAclList(value);
        break;
      default:
        break;
    }
  }
  return queues;
}

export interface ParsedFilesystem {
  filesystem: string;
  size: string;
  used: string;
  avail: string;
  capacity_percent: number;
  mounted_on: string;
  avail_bytes: number | null;
}

const HUMAN_BYTE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5
};

// Convert a `df -h` human size (e.g. "400G", "1.2T", "512", "0") to bytes. Returns null for
// the "-" placeholder some filesystems report and for unparseable values.
export function parseHumanBytes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([BKMGTP]?)i?B?$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude)) {
    return null;
  }
  const unit = match[2].toUpperCase();
  const multiplier = unit ? HUMAN_BYTE_UNITS[unit] : 1;
  return Math.round(magnitude * multiplier);
}

// Parse `df -hP <root>` output (one row per filesystem, POSIX format) into structured
// availability. The header row and any blank lines are dropped; the mount point is taken as
// everything after the capacity percentage so mount paths with spaces survive.
export function parseDfAvailable(stdout: string): ParsedFilesystem[] {
  const rows: ParsedFilesystem[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Filesystem")) {
      continue;
    }
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+(.+)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, filesystem, size, used, avail, capacity, mountedOn] = match;
    rows.push({
      filesystem,
      size,
      used,
      avail,
      capacity_percent: Number(capacity),
      mounted_on: mountedOn.trim(),
      avail_bytes: parseHumanBytes(avail)
    });
  }
  return rows;
}
