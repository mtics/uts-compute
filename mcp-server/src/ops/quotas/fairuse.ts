// Fair-use primitives: ENFORCEMENT + DISCLOSURE, never evasion.
//
// `accountKey`/`buildCampaignLedger` DISCLOSE that a campaign legitimately spans different owners'
// allocations — for audit and attribution — they never hide or circumvent anything. The ledger is a
// pure derivation over the run records (no second store); it groups runs by campaign, then by account.
//
// `fairUseVerdict` checks ONE account against its OWN caps only (PBS per-user run cap via
// effectiveUserLimit; iHPC node-pool cap via computeNodePoolOccupancy). It takes a single profile plus
// that profile's own counts and has NO parameter through which a caller could hand it a cross-account
// union — so there is structurally no path by which it could sum usage across accounts to compute a
// cap. Summing across accounts would be both wrong and an evasion vector; it is deliberately impossible
// here.

import type { ComputeProfile, Platform, RunRecord } from "../../core/types.js";
import type { ConformanceViolation } from "./conformance.js";
import {
  computeNodePoolOccupancy,
  effectiveUserLimit,
  type NodeLimitPool,
  type PbsLimitSpec
} from "./quota-limits.js";

// Per-account, per-platform identity. Two collaborators each own one HPC + one iHPC account, so the
// (account_label, platform) pair uniquely names an allocation source. Never a credential.
export function accountKey(profile: Pick<ComputeProfile, "account_label" | "platform">): string {
  return `${profile.account_label}@${profile.platform}`;
}

// One account's slice of a campaign: which allocation contributed which runs. Attribution only.
export interface CampaignAllocation {
  account_key: string;
  profile_id: string;
  account_label: string;
  platform: Platform;
  owner?: string;
  allocation?: string;
  run_ids: string[];
  run_count: number;
  status_breakdown: Record<string, number>;
  last_updated: string | null;
}

// One campaign's full attribution: the set of allocations (possibly across different owners) that ran
// work under it. That a campaign spans multiple accounts is DISCLOSED here, never hidden.
export interface CampaignLedgerEntry {
  campaign_id: string;
  run_count: number;
  allocations: CampaignAllocation[];
}

// Derived campaign ledger over the run records — no second store. Runs without a campaign_id are
// skipped (adopted/external/plain runs declare no campaign). Within a campaign, runs are grouped by
// the account that ran them (keyed by profile_id), so an operator can see, per campaign, exactly which
// allocation contributed which runs. This attributes a multi-allocation campaign; it never sums usage
// across accounts and never computes a cap.
export function buildCampaignLedger(
  runs: RunRecord[],
  profilesById: Record<string, Pick<ComputeProfile, "account_label" | "platform" | "defaults">>
): CampaignLedgerEntry[] {
  const byCampaign = new Map<string, Map<string, CampaignAllocation>>();

  for (const record of runs) {
    const campaignId = record.campaign_id;
    if (!campaignId) {
      continue; // no declared campaign — not part of any campaign attribution
    }
    const byAccount = byCampaign.get(campaignId) ?? new Map<string, CampaignAllocation>();
    byCampaign.set(campaignId, byAccount);

    const profile = profilesById[record.profile_id];
    const allocation =
      byAccount.get(record.profile_id) ?? newAllocation(record, profile);
    byAccount.set(record.profile_id, allocation);

    allocation.run_ids.push(record.run_id);
    allocation.run_count += 1;
    allocation.status_breakdown[record.status] = (allocation.status_breakdown[record.status] ?? 0) + 1;
    const updated = record.updated_at ?? record.created_at;
    if (updated && (allocation.last_updated === null || updated > allocation.last_updated)) {
      allocation.last_updated = updated;
    }
  }

  return [...byCampaign.entries()]
    .map(([campaignId, byAccount]) => {
      const allocations = [...byAccount.values()].sort((a, b) => a.profile_id.localeCompare(b.profile_id));
      return {
        campaign_id: campaignId,
        run_count: allocations.reduce((sum, a) => sum + a.run_count, 0),
        allocations
      };
    })
    .sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
}

function newAllocation(
  record: RunRecord,
  profile: Pick<ComputeProfile, "account_label" | "platform" | "defaults"> | undefined
): CampaignAllocation {
  const accountLabel = profile?.account_label ?? record.profile_id;
  return {
    account_key: accountKey({ account_label: accountLabel, platform: record.platform }),
    profile_id: record.profile_id,
    account_label: accountLabel,
    platform: record.platform,
    ...(profile?.defaults?.owner ? { owner: profile.defaults.owner } : {}),
    ...(profile?.defaults?.allocation ? { allocation: profile.defaults.allocation } : {}),
    run_ids: [],
    run_count: 0,
    status_breakdown: {},
    last_updated: null
  };
}

// One account's OWN current occupancy, supplied by the caller from THAT account's own fresh quota
// snapshot. The two halves are independent (a profile is either PBS or iHPC); each is the account's
// own counts only — NEVER a union across accounts.
export interface OwnAccountCounts {
  // iHPC: this account's own node-pool caps + the nodes IT currently holds.
  nodeLimits?: NodeLimitPool[];
  activeNodes?: Array<{ node?: string; family?: string }>;
  // PBS: this account's own per-user run cap spec + how many of ITS jobs are running in the queue.
  pbs?: {
    username: string;
    groups?: string[];
    maxRunSpec?: PbsLimitSpec;
    runningInQueue: number;
    queue: string;
  };
}

// Verdict for ONE account against its OWN caps. Returns violations only when this single account is
// already at/over its own cap (PBS per-user run cap, or any iHPC node pool over limit). It takes one
// profile + that profile's own counts; there is no parameter for cross-account data, so it cannot and
// does not aggregate usage across accounts. A single account over its own cap is ALWAYS flagged — the
// campaign ledger surfaces it, never excuses it.
export function fairUseVerdict(profile: ComputeProfile, counts: OwnAccountCounts): ConformanceViolation[] {
  const violations: ConformanceViolation[] = [];

  // iHPC: each configured pool independently — held already at/over its own limit is a violation.
  if (counts.nodeLimits && counts.nodeLimits.length > 0) {
    const occupancy = computeNodePoolOccupancy(counts.nodeLimits, counts.activeNodes ?? []);
    for (const pool of occupancy) {
      if (pool.held > pool.limit) {
        violations.push({
          code: "node-pool-exceeded",
          limit: "node_limits",
          requested: pool.held,
          allowed: pool.limit,
          message: `account ${accountKey(profile)} holds ${pool.held} nodes in pool [${pool.families.join(", ")}], over its own cap ${pool.limit}`
        });
      }
    }
  }

  // PBS: this account's own per-user running cap in its queue.
  if (counts.pbs) {
    const maxRun = effectiveUserLimit(counts.pbs.maxRunSpec, counts.pbs.username, counts.pbs.groups ?? []);
    if (typeof maxRun === "number" && counts.pbs.runningInQueue > maxRun) {
      violations.push({
        code: "max-run-exceeded",
        limit: "max_run",
        requested: counts.pbs.runningInQueue,
        allowed: maxRun,
        message: `account ${accountKey(profile)} runs ${counts.pbs.runningInQueue} jobs in queue ${counts.pbs.queue}, over its own per-user cap ${maxRun}`
      });
    }
  }

  return violations;
}
