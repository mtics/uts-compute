// control/plan.ts — planNextBatch(): the brain's online decision that fuses lease + queue + placement +
// quota gate into an immutable PLAN (spec §3.3 pipeline). It RETURNS the IhpcPlan object (self-validated
// via assertIhpcPlan); it does NOT write to the node or start the progressor — that is seam/launch.ts in
// Phase C. queue_id is a sha256 of the canonical plan content (minus itself), so the same campaign state
// yields the same immutable plan (seq-keyed resume requires per-queue_id immutability, spec §2.2).

import { createHash } from "node:crypto";
import { stableJson } from "../../../lib/shared.js";
import { checkIhpcNodePoolConformance } from "../../quotas/conformance.js";
import { launchableBatch } from "./queue.js";
import { reserveSlots, type GpuSlotAllocation, type NodeTopology } from "./placement.js";
import { assertIhpcPlan } from "../seam/protocol.js";
import type { IhpcPlan, IhpcPlanJob, LeaseOwner, RunRecord } from "../../../core/types.js";
import type { LeaseDecision } from "./lease.js";

const SCHEMA_VERSION = "1.0.0";
const SCHEMA_COMPAT_MIN = "1.0.0";

// A queue entry: a RunRecord plus the node-launch fields the brain has resolved for it.
// PRODUCER (review B-3): these four per-run launch fields are stamped onto the record by the PLAN-job
// producer at enqueue time — `jobs.plan` / `sweep_plan` (ops/plans/planner.ts, ops/sweep.ts), which
// already expand sweep params into a concrete argv + workdir + env + timeout per run. `planNextBatch`
// is a pure CONSUMER: it never derives argv from sweep params itself. So a caller MUST pass
// QueueRunRecord[] (records already carrying these fields), not bare RunRecord[]; passing a record that
// lacks command_argv yields an `assertIhpcPlan` failure (empty/undefined argv) — fail-loud, by design.
// The fields are launch inputs, NOT persisted RunRecord columns: they live on the queue entry the brain
// holds in memory while planning, and flow into PLAN.jobs[] — they are not added to core/types.ts
// RunRecord (which stays the persisted shape). Phase C's seam/launch.ts reads PLAN.jobs[] for them.
export type QueueRunRecord = RunRecord & {
  command_argv: string[];
  workdir: string;
  env: Record<string, string>;
  timeout_seconds: number;
};

export interface PlanNextBatchInput {
  campaignId: string;
  profileId: string;
  node: NodeTopology;
  me: LeaseOwner;
  lease: LeaseDecision;
  maxConcurrent: number;
  slotCount: number;
  allowedRoots: string[];
  envKeyAllowlist: string[];
  nodeLimits?: Array<{ families: string[]; limit: number }>;
  activeNodes?: Array<{ node?: string; family?: string }>;
  records: QueueRunRecord[];
  // placements already held by running work (for placement pre-accounting).
  held: Array<{ gpu_index?: number }>;
  // policy knobs with spec §2.2 defaults.
  logMaxBytes?: number;
  idleExitSeconds?: number;
  restartThrottleSeconds?: number;
  maxConsecutiveFailures?: number;
}

// The brain's plan output: the immutable PLAN plus the per-job slot allocations (placements[i] aligns
// with plan.jobs[i] by index). placements carries gpu_slot, which Phase C seam/launch.ts stamps onto
// each RunRecord.placement.gpu_slot (review B-2 — the field must actually be written, not left dead).
export interface PlanNextBatchResult {
  plan: IhpcPlan;
  placements: GpuSlotAllocation[];
}

// Returns null when the lease forbids writing (blocked by a live other holder). Throws when the
// ban-critical node-pool quota gate refuses. Otherwise returns the immutable PLAN + aligned placements.
export function planNextBatch(input: PlanNextBatchInput): PlanNextBatchResult | null {
  if (input.lease.action === "blocked") {
    return null;
  }

  // HARD per-account node-pool gate (the ban-prevention) BEFORE placing anything (spec §3.3 GATE step).
  const poolConformance = checkIhpcNodePoolConformance({
    targetNode: input.node.node_id,
    nodeLimits: input.nodeLimits,
    activeNodes: input.activeNodes ?? []
  });
  if (!poolConformance.conforms) {
    const detail = poolConformance.violations.map((violation) => violation.message).join("; ");
    throw new Error(`iHPC node-pool conformance failed for ${input.profileId}: ${detail}`);
  }

  const batch = launchableBatch(input.records, {
    maxConcurrent: input.maxConcurrent,
    campaignId: input.campaignId
  });
  // slot_count is a hard placement cap (spec §3.3), independent of GPU-derived capacity. reserveSlots is
  // otherwise bounded only by max_slots_per_gpu × |gpu_indices|, so without this min() a node with more
  // GPU capacity than slot_count would over-place. Cap the requested count to slotCount.
  const placements = reserveSlots(input.node, Math.min(batch.length, input.slotCount), input.held);

  const jobs: IhpcPlanJob[] = [];
  placements.forEach((placement, index) => {
    const record = batch[index];
    jobs.push({
      seq: index,
      run_id: record.run_id,
      command_argv: record.command_argv,
      workdir: record.workdir,
      env: record.env,
      gpu_index: placement.gpu_index,
      gpu_count: 1,
      timeout_seconds: record.timeout_seconds
    });
  });

  const planWithoutQueueId = {
    schema_version: SCHEMA_VERSION,
    schema_compat_min: SCHEMA_COMPAT_MIN,
    campaign_id: input.campaignId,
    lease_owner: input.me,
    node_id: input.node.node_id,
    profile_id: input.profileId,
    limits: {
      slot_count: input.slotCount,
      max_slots_per_gpu: input.node.max_slots_per_gpu,
      log_max_bytes: input.logMaxBytes ?? 209715200
    },
    security: { allowed_roots: input.allowedRoots, env_key_allowlist: input.envKeyAllowlist },
    policy: {
      on_job_failure: "continue" as const,
      failure_breaker: {
        max_consecutive_failures: input.maxConsecutiveFailures ?? 5,
        require_one_success: true
      },
      idle_definition: "no_running_and_no_launchable_pending",
      idle_exit_seconds: input.idleExitSeconds ?? 604800,
      restart_throttle_seconds: input.restartThrottleSeconds ?? 2
    },
    jobs
  };
  const queueId = `sha256:${createHash("sha256").update(stableJson(planWithoutQueueId)).digest("hex")}`;
  const plan: IhpcPlan = { ...planWithoutQueueId, queue_id: queueId };

  assertIhpcPlan(plan);
  // placements is the slice actually consumed (one per emitted job, gpu_slot-carrying); Phase C threads
  // each onto its RunRecord.placement.gpu_slot. queue_id is hashed over the PLAN only — placements are a
  // brain-side by-product and are NOT part of the immutable plan content (so they never perturb the hash).
  return { plan, placements: placements.slice(0, jobs.length) };
}
