// campaign/submit.ts — the campaign.submit ORCHESTRATION (Phase E). This is the business flow that
// turns "a campaign's planned runs" into "a launched campaign": a careful composition of the existing
// pure primitives with exactly ONE side-effect seam (the SSH launch), injected via `deps` so the flow
// is fully testable offline. Structure carries the semantics — each step is a named function and the
// order below IS the spec §3.3 pipeline:
//
//   selectPlannedRuns (pure)      — which saved runs are launch candidates for this campaign
//     -> decideLease (pure)        — may we write a PLAN for this (profile, node)?  blocked => refuse
//     -> checkIhpcNodePoolConformance (pure) — would this node push the account OVER its OWN cap? (ban gate)
//     -> enrichRun (injected)      — resolve each candidate's launch fields (argv/workdir/env/timeout)
//     -> planNextBatch (pure)      — fuse lease+queue+placement into the immutable PLAN + placements
//     -> launchPlan (THE SSH SEAM) — write PLAN, start the progressor, persist running RunRecords
//
// Only launchPlan does IO. Every other step is pure or pure-with-injected-data. Errors are returned
// IN-BAND as { ok:false, reason } (the plugin tool convention) so the agent gets a structured verdict
// for each refusal class instead of an opaque throw; the only thing that can still throw is a genuine
// programming error (e.g. a malformed enriched record failing assertIhpcPlan inside planNextBatch).

import { decideLease } from "../control/lease.js";
import { checkIhpcNodePoolConformance } from "../../quotas/conformance.js";
import { planNextBatch, type QueueRunRecord } from "../control/plan.js";
import { selectPlannedRuns } from "./select.js";
import type { NodeTopology } from "../control/placement.js";
import type { LaunchResult } from "../seam/launch.js";
import type { ComputeProfile, LeaseOwner, NodeSchedulerConfig, RunRecord } from "../../../core/types.js";

export interface CampaignSubmitInput {
  campaignId: string;
  // The candidate run records (the caller reads them from the store; this keeps campaignSubmit pure
  // over its inputs). selectPlannedRuns filters them to this campaign's planned iHPC runs.
  records: RunRecord[];
}

// The injected dependency surface: the data the pure steps need plus the ONE side-effect seam
// (launchPlan) and the per-run launch-field resolver (enrichRun). The tool handler binds launchPlan to
// the real SSH launchIhpcCampaign and enrichRun to a plan-artifact reader; tests bind mocks.
export interface CampaignSubmitDeps {
  me: LeaseOwner;
  node: NodeTopology;
  profile: ComputeProfile & { node_scheduler?: NodeSchedulerConfig };
  // Lease staleness inputs (node-clock only; spec §2.3). `held` is the current on-node holder or null.
  lease: { nodeNowEpoch: number; heartbeatEpoch: number | null; staleSeconds: number; held: LeaseOwner | null };
  maxConcurrent: number;
  slotCount: number;
  allowedRoots: string[];
  envKeyAllowlist: string[];
  nodeLimits?: Array<{ families: string[]; limit: number }>;
  // The nodes THIS account currently holds (its own snapshot), for the per-account node-pool gate.
  activeNodes?: Array<{ node?: string; family?: string }>;
  // Placements already held by running work, for placement pre-accounting.
  held?: Array<{ gpu_index?: number }>;
  // Resolve a selected planned RunRecord into a QueueRunRecord (attach command_argv/workdir/env/
  // timeout_seconds from the saved plan artifact). Pure-ish: it reads a local artifact; never SSH.
  enrichRun: (record: RunRecord) => QueueRunRecord;
  // THE side-effect seam: write the PLAN over SSH, start the progressor, persist running RunRecords.
  launchPlan: (plan: NonNullable<ReturnType<typeof planNextBatch>>["plan"], profile: CampaignSubmitDeps["profile"]) => Promise<LaunchResult>;
}

export type CampaignSubmitResult =
  | { ok: true; launched: number; plan_queue_id: string; run_ids: string[] }
  | { ok: false; reason: "no-planned-runs" | "lease-blocked" | "conformance-failed" | "launch-failed"; detail?: string };

export async function campaignSubmit(input: CampaignSubmitInput, deps: CampaignSubmitDeps): Promise<CampaignSubmitResult> {
  // STEP 1 (pure): which saved runs are this campaign's launch candidates?
  const candidates = selectPlannedRuns(input.campaignId, input.records);
  if (candidates.length === 0) {
    return { ok: false, reason: "no-planned-runs" };
  }

  // STEP 2 (pure): may we write a PLAN for this (profile, node)? A LIVE other holder => refuse (never
  // clobber its queue). acquire/refresh/takeover all proceed; planNextBatch consumes the same decision.
  const leaseDecision = decideLease({ ...deps.lease, me: deps.me });
  if (leaseDecision.action === "blocked") {
    return { ok: false, reason: "lease-blocked", detail: `node held by ${leaseDecision.holder.client}/${leaseDecision.holder.device_id}` };
  }

  // STEP 3 (pure): the HARD per-account node-pool gate (the ban-prevention). Checked explicitly here so
  // a refusal is REPORTED in-band (planNextBatch would throw on the same condition); never sums across
  // accounts — activeNodes is this profile's own held set.
  const conformance = checkIhpcNodePoolConformance({
    targetNode: deps.node.node_id,
    nodeLimits: deps.nodeLimits,
    activeNodes: deps.activeNodes ?? []
  });
  if (!conformance.conforms) {
    return { ok: false, reason: "conformance-failed", detail: conformance.violations.map((v) => v.message).join("; ") };
  }

  // STEP 4 (injected, local): resolve each candidate's launch fields into QueueRunRecords. STEP 5
  // (pure): fuse lease + queue + placement + quota into the immutable PLAN + aligned placements.
  const queueRecords = candidates.map(deps.enrichRun);
  const planned = planNextBatch({
    campaignId: input.campaignId,
    profileId: deps.profile.profile_id,
    node: deps.node,
    me: deps.me,
    lease: leaseDecision,
    maxConcurrent: deps.maxConcurrent,
    slotCount: deps.slotCount,
    allowedRoots: deps.allowedRoots,
    envKeyAllowlist: deps.envKeyAllowlist,
    nodeLimits: deps.nodeLimits,
    activeNodes: deps.activeNodes,
    records: queueRecords,
    held: deps.held ?? []
  });
  // planNextBatch returns null only when the lease forbids writing — already handled by STEP 2, so a
  // null here means the placement produced no jobs to launch (no free slots / cap reached this batch).
  if (!planned || planned.plan.jobs.length === 0) {
    return { ok: false, reason: "no-planned-runs", detail: "no launchable slots this batch (concurrency cap reached)" };
  }

  // STEP 6 (THE SSH SEAM): write the PLAN, start the progressor once, persist running RunRecords. The
  // ONLY IO in the flow. A seam failure (ssh/start) is reported in-band as launch-failed. The seam has
  // already persisted the running RunRecords (incl. the resident progressor pid), so the orchestration
  // only summarizes what it launched — its LaunchResult return value is not needed here.
  try {
    await deps.launchPlan(planned.plan, deps.profile);
  } catch (error) {
    return { ok: false, reason: "launch-failed", detail: error instanceof Error ? error.message : String(error) };
  }

  return {
    ok: true,
    launched: planned.plan.jobs.length,
    plan_queue_id: planned.plan.queue_id,
    run_ids: planned.plan.jobs.map((job) => job.run_id)
  };
}
