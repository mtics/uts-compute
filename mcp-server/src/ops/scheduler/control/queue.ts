// control/queue.ts — brain-side pending-queue progression POLICY (spec §3.1/§3.4, ports
// scheduler.py run_forever/_dispatch_pending ordering + max_concurrent). Pure: takes a campaign's run
// records and decides WHICH pending runs are launchable this batch. No SSH, no node observation, no
// placement (that is control/placement.ts) — purely "what does the queue say to start next".

import type { RunRecord } from "../../../core/types.js";

// The non-terminal statuses that occupy a concurrency slot or are eligible to start. Every literal here
// MUST be a member of the live RunRecord["status"] union (core/types.ts:260):
// "planned"|"submitting"|"submitted"|"running"|"finished"|"failed"|"cancelled"|"unknown"|"stale" — verified
// against source (review CP-6). If that union changes, this set and every node→RunRecord mapper break.
// `satisfies ReadonlySet<RunRecord["status"]>` is a compile-time guard: if RunRecord["status"] ever
// drops a literal these sets reference (e.g. "submitting" is renamed), the build breaks here rather than
// the sets silently going stale and mis-classifying a status at runtime (review CP-6).
const RUNNING = new Set<RunRecord["status"]>(["submitting", "submitted", "running"]) satisfies ReadonlySet<RunRecord["status"]>;
const LAUNCHABLE = new Set<RunRecord["status"]>(["planned"]) satisfies ReadonlySet<RunRecord["status"]>;

export interface QueueProgressionOptions {
  maxConcurrent: number;
  // when set, only runs of this campaign participate (others are ignored, never started).
  campaignId?: string;
}

// FIFO by queue_position (the brain's monotonic enqueue order), ties broken by run_id for determinism.
// Records without a queue_position sort last (treated as +Infinity) so an unattributed run never jumps
// the queue.
export function orderQueue<T extends Pick<RunRecord, "run_id" | "queue_position">>(records: T[]): T[] {
  return [...records].sort((left, right) => {
    const lp = typeof left.queue_position === "number" ? left.queue_position : Number.POSITIVE_INFINITY;
    const rp = typeof right.queue_position === "number" ? right.queue_position : Number.POSITIVE_INFINITY;
    if (lp !== rp) return lp - rp;
    return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
  });
}

// The runs to launch THIS batch: FIFO-ordered launchable pending runs, capped so that
// (currently running + newly launched) never exceeds maxConcurrent. Terminal runs and runs of other
// campaigns are excluded. Returns [] when the campaign is already at its concurrency cap. Generic over
// the record element type so a caller passing a richer queue entry (control/plan.ts's QueueRunRecord,
// which carries the resolved per-run launch fields) gets that exact type back, not a widened RunRecord.
export function launchableBatch<T extends RunRecord>(
  records: T[],
  options: QueueProgressionOptions
): T[] {
  const scoped = options.campaignId
    ? records.filter((record) => record.campaign_id === options.campaignId)
    : records;
  const running = scoped.filter((record) => RUNNING.has(record.status)).length;
  const room = Math.max(0, options.maxConcurrent - running);
  if (room === 0) return [];
  const pending = orderQueue(scoped.filter((record) => LAUNCHABLE.has(record.status)));
  return pending.slice(0, room);
}
