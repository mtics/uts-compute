// Campaign disclosure tools: read-only, local rollups over saved run records. ENFORCEMENT + DISCLOSURE,
// never evasion.
//
// `campaign.status` DISCLOSES, per campaign, which owner's allocation contributed which runs — the
// attribution that makes a legitimately multi-allocation campaign auditable. `campaign.audit` adds a
// per-account fair-use verdict: it composes `fairUseVerdict` against EACH account's OWN latest quota
// snapshot to FLAG any account already over its own cap. It never sums usage across accounts (there is
// no parameter through which it could), and it never excuses an over-cap account — the ledger surfaces
// it. These mirror `projects.list` (listRunRecordIds + readRunRecordSafe, then a derived rollup); no
// SSH, no second store.

import fs from "node:fs";
import path from "node:path";

import { listRunRecordIds, readRunRecordSafe } from "../../core/audit.js";
import { listProfiles } from "../../core/config.js";
import { assertInsideRuntime, RUNTIME_DIRS } from "../../core/paths.js";
import { assertQuotaSnapshot } from "../../core/validation.js";
import type { ComputeProfile, QuotaSnapshot, RunRecord } from "../../core/types.js";
import {
  buildCampaignLedger,
  fairUseVerdict,
  type CampaignAllocation,
  type OwnAccountCounts
} from "./fairuse.js";
import type { ConformanceViolation } from "./conformance.js";
import {
  parsePbsLimitSpec,
  type NodeLimitPool,
  type PbsLimitSpec,
  type PbsQueueLimit
} from "./quota-limits.js";

export interface CampaignStatusInput {
  campaignId: string;
  // Overridable for tests; default to the live runtime dirs.
  auditDir?: string;
  configPath?: string;
}

export interface CampaignAuditInput extends CampaignStatusInput {
  quotaDir?: string;
}

export interface CampaignStatusResult {
  campaign: {
    campaign_id: string;
    run_count: number;
    allocations: CampaignAllocation[];
    // An optional operator attestation recorded on the campaign's runs (the most recent
    // `fair-use-basis` event). DISCLOSURE for audit — present only if an operator recorded one.
    fair_use_basis?: string;
  };
}

// One account's fair-use verdict against its OWN latest snapshot. over_cap is a FLAG, never an excuse.
export interface CampaignFinding {
  account_key: string;
  profile_id: string;
  account_label: string;
  owner?: string;
  allocation?: string;
  // The latest snapshot this account's verdict was composed against (null when none was found — the
  // audit then cannot assert the account is within cap, so it notes that rather than assuming OK).
  snapshot_id: string | null;
  over_cap: boolean;
  violations: ConformanceViolation[];
  note?: string;
}

export interface CampaignAuditResult {
  campaign: CampaignStatusResult["campaign"] & {
    findings: CampaignFinding[];
    over_cap_count: number;
  };
}

// The run records that declare this campaign. Mirrors listProjects: enumerate ids, read each safely,
// drop nulls, then filter. campaign_id lives only on the record (DISCLOSURE), so this is the sole join.
function campaignRuns(campaignId: string, auditDir?: string): RunRecord[] {
  const ids = auditDir ? listRunRecordIds(auditDir) : listRunRecordIds();
  return ids
    .map((id) => readRunRecordSafe(id, auditDir))
    .filter((record): record is RunRecord => record !== null)
    .filter((record) => record.campaign_id === campaignId);
}

// Index profiles by id so the ledger can attach account_label/owner/allocation attribution.
function profilesById(
  configPath?: string
): Record<string, Pick<ComputeProfile, "account_label" | "platform" | "defaults">> {
  const map: Record<string, Pick<ComputeProfile, "account_label" | "platform" | "defaults">> = {};
  for (const profile of listProfiles(configPath)) {
    map[profile.profile_id] = profile;
  }
  return map;
}

// The most recent operator `fair-use-basis` attestation across the campaign's runs (by event time),
// if any operator recorded one. Kept on the records — no second store.
function latestFairUseBasis(runs: RunRecord[]): string | undefined {
  let latestAt: string | null = null;
  let basis: string | undefined;
  for (const record of runs) {
    for (const event of record.events ?? []) {
      if (event.kind === "fair-use-basis" && (latestAt === null || event.at > latestAt)) {
        latestAt = event.at;
        basis = event.summary;
      }
    }
  }
  return basis;
}

export function campaignStatus(input: CampaignStatusInput): CampaignStatusResult {
  const runs = campaignRuns(input.campaignId, input.auditDir);
  const ledger = buildCampaignLedger(runs, profilesById(input.configPath));
  const entry = ledger.find((candidate) => candidate.campaign_id === input.campaignId);
  const basis = latestFairUseBasis(runs);
  return {
    campaign: {
      campaign_id: input.campaignId,
      run_count: entry?.run_count ?? 0,
      allocations: entry?.allocations ?? [],
      ...(basis ? { fair_use_basis: basis } : {})
    }
  };
}

export function campaignAudit(input: CampaignAuditInput): CampaignAuditResult {
  const { campaign } = campaignStatus(input);
  const byId = listProfiles(input.configPath).reduce<Record<string, ComputeProfile>>((map, profile) => {
    map[profile.profile_id] = profile;
    return map;
  }, {});

  const findings: CampaignFinding[] = campaign.allocations.map((allocation) => {
    const base: CampaignFinding = {
      account_key: allocation.account_key,
      profile_id: allocation.profile_id,
      account_label: allocation.account_label,
      ...(allocation.owner ? { owner: allocation.owner } : {}),
      ...(allocation.allocation ? { allocation: allocation.allocation } : {}),
      snapshot_id: null,
      over_cap: false,
      violations: []
    };

    const profile = byId[allocation.profile_id];
    if (!profile) {
      return { ...base, note: `profile ${allocation.profile_id} is not configured; cannot audit its caps` };
    }

    const snapshot = latestSnapshotFor(allocation.profile_id, input.quotaDir);
    if (!snapshot) {
      // No own snapshot → the audit CANNOT assert this account is within cap. Surface that explicitly;
      // never assume OK (and never substitute another account's snapshot — that would be summing).
      return { ...base, note: "no quota snapshot found for this account; run quotas.refresh to audit its caps" };
    }

    // Compose the verdict against THIS account's OWN counts only — never a cross-account union.
    const violations = fairUseVerdict(profile, ownCountsFromSnapshot(profile, snapshot));
    return {
      ...base,
      snapshot_id: snapshot.snapshot_id,
      over_cap: violations.length > 0,
      violations
    };
  });

  return {
    campaign: {
      ...campaign,
      findings,
      over_cap_count: findings.filter((finding) => finding.over_cap).length
    }
  };
}

// --- snapshot helpers ----------------------------------------------------------------------------

function quotaDirFor(quotaDir?: string): string {
  const dir = assertInsideRuntime(quotaDir ?? RUNTIME_DIRS.quotas, "Quota snapshot directory");
  return dir;
}

// The latest valid quota snapshot saved for a profile (by observed_at). Reads only this profile's own
// snapshots; a malformed file is skipped. Returns null when the account has no snapshot.
function latestSnapshotFor(profileId: string, quotaDir?: string): QuotaSnapshot | null {
  const dir = quotaDirFor(quotaDir);
  if (!fs.existsSync(dir)) {
    return null;
  }
  let latest: QuotaSnapshot | null = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    let snapshot: QuotaSnapshot;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")) as unknown;
      const candidate =
        raw && typeof raw === "object" && !Array.isArray(raw) && "snapshot" in raw
          ? (raw as { snapshot: unknown }).snapshot
          : raw;
      assertQuotaSnapshot(candidate);
      snapshot = candidate;
    } catch {
      continue; // a malformed snapshot is skipped, never audited
    }
    if (snapshot.profile_id !== profileId) {
      continue;
    }
    if (latest === null || snapshot.observed_at > latest.observed_at) {
      latest = snapshot;
    }
  }
  return latest;
}

// This account's OWN counts for the fair-use verdict, read from its own snapshot. The iHPC half and
// the PBS half are independent (a profile is either one or the other); each is strictly this account's
// own held nodes / its own running jobs — NEVER a union across accounts.
function ownCountsFromSnapshot(profile: ComputeProfile, snapshot: QuotaSnapshot): OwnAccountCounts {
  const counts: OwnAccountCounts = {};

  // iHPC: this account's own node-pool caps (defaults.node_limits) + the nodes IT currently holds.
  const nodeLimits: NodeLimitPool[] | undefined = Array.isArray(profile.defaults.node_limits)
    ? profile.defaults.node_limits
    : undefined;
  if (nodeLimits && nodeLimits.length > 0) {
    const sessions = (snapshot.summary.sessions ?? {}) as {
      active_nodes?: Array<{ node?: string; family?: string }>;
    };
    counts.nodeLimits = nodeLimits;
    counts.activeNodes = Array.isArray(sessions.active_nodes) ? sessions.active_nodes : [];
  }

  // PBS: this account's own per-user run cap in its default queue + how many of ITS jobs are running.
  const queue = typeof profile.defaults.queue === "string" ? profile.defaults.queue : undefined;
  if (queue) {
    const queueLimit = extractQueueLimit(snapshot, queue);
    const running = extractRunningInQueue(snapshot, queue);
    if (queueLimit) {
      const identity = (snapshot.summary.identity ?? {}) as { groups?: string[] };
      counts.pbs = {
        username: remoteUserFromHostAlias(profile.login.host_alias),
        groups: Array.isArray(identity.groups) ? identity.groups : [],
        ...(queueLimit.max_run ? { maxRunSpec: normalizeLimitSpec(queueLimit.max_run) } : {}),
        runningInQueue: running,
        queue
      };
    }
  }

  return counts;
}

function remoteUserFromHostAlias(hostAlias: string): string {
  const at = hostAlias.indexOf("@");
  return at >= 0 ? hostAlias.slice(0, at) : hostAlias;
}

function extractQueueLimit(snapshot: QuotaSnapshot, queue: string): PbsQueueLimit | undefined {
  const queues = (snapshot.summary.queues ?? {}) as { queue_limits?: PbsQueueLimit[] };
  return Array.isArray(queues.queue_limits)
    ? queues.queue_limits.find((limit) => limit.name === queue)
    : undefined;
}

function extractRunningInQueue(snapshot: QuotaSnapshot, queue: string): number {
  const running = (snapshot.summary.running_work ?? {}) as {
    by_queue?: Record<string, { running?: number }>;
  };
  const byQueue = running.by_queue ?? {};
  const counts = byQueue[queue];
  return typeof counts?.running === "number" ? counts.running : 0;
}

// A saved snapshot may carry max_run either as a structured PbsLimitSpec (the captured shape) or as a
// raw PBS scope string; accept both so the audit reads whatever quotas.refresh recorded.
function normalizeLimitSpec(spec: PbsLimitSpec | string): PbsLimitSpec {
  return typeof spec === "string" ? parsePbsLimitSpec(spec) : spec;
}
