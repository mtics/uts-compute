// control/placement.ts — brain-side placement ACCOUNTING (spec §3.1, §9). Common-path placement is
// pure in-brain pre-accounting ported from the vendored scheduler.py `_dispatch_pending`
// (`virtual_gpu_counts` init :265-266, post-dispatch increment :324-325): a job decrements an
// available slot AT THE MOMENT it is placed into a PLAN, never by observing the node afterwards. This
// is what keeps the brain from over-subscribing its OWN slots ("16 jobs onto 4 GPUs"). SSH nvidia-smi
// is NOT run here — the launch-time GPU idle guard (the node's only nvidia-smi, Phase C wrapper) is
// what protects against FOREIGN processes (other accounts) and is the only cross-account-safe point.
// A `probe` executor is injectable for the cold-start/adopt/drift paths only; default undefined ⇒
// pure accounting, zero SSH, matching spec §3.1 "记账优先,非探测优先".

export interface NodeTopology {
  node_id: string;
  // GPU indices physically present on the node (static, from hardware.yaml-derived queue config).
  gpu_indices: number[];
  // per-GPU slot cap (PLAN.limits.max_slots_per_gpu).
  max_slots_per_gpu: number;
}

// Per-GPU running-job count (the TS analogue of state.gpu_job_counts(hostname): {gpu_index -> count}).
export type VirtualGpuCounts = Record<number, number>;

export interface GpuSlotAllocation {
  node_id: string;
  gpu_index: number;
  gpu_slot: number; // 0-based slot index on the chosen GPU
}

// Seed virtual counts from the placements currently held by running work (mirrors scheduler.py:265-266
// initialising virtual_gpu_counts from state.gpu_job_counts). Every present GPU is keyed (0 when free)
// so allocateGpuSlot can iterate deterministically.
export function initVirtualGpuCounts(node: NodeTopology, held: Array<{ gpu_index?: number }>): VirtualGpuCounts {
  const counts: VirtualGpuCounts = {};
  for (const gpu of node.gpu_indices) {
    counts[gpu] = 0;
  }
  for (const placement of held) {
    // FAIL-CLOSED: a held placement whose gpu_index is undefined or not in the node's topology cannot be
    // accounted for. Silently dropping it would make the brain believe a GPU is freer than it is and
    // over-subscribe a fresh job onto it. Refuse to plan instead (spec §3.1 accounting integrity).
    if (typeof placement.gpu_index !== "number" || !(placement.gpu_index in counts)) {
      throw new Error(
        `held placement has gpu_index ${String(placement.gpu_index)} not in node ${node.node_id} topology ` +
          `[${node.gpu_indices.join(", ")}]; refusing to plan (fail-closed)`
      );
    }
    counts[placement.gpu_index] += 1;
  }
  return counts;
}

// Pick the least-loaded GPU still under max_slots_per_gpu, increment its virtual count (the placement-
// time decrement of available capacity, scheduler.py:324-325), and return the slot. Returns null when
// every GPU is saturated — the brain then leaves the job pending rather than over-subscribing.
export function allocateGpuSlot(node: NodeTopology, counts: VirtualGpuCounts): GpuSlotAllocation | null {
  let best: number | null = null;
  for (const gpu of node.gpu_indices) {
    const used = counts[gpu] ?? 0;
    if (used >= node.max_slots_per_gpu) continue;
    if (best === null || used < (counts[best] ?? 0)) best = gpu;
  }
  if (best === null) return null;
  const slotIndex = counts[best] ?? 0;
  counts[best] = slotIndex + 1;
  return { node_id: node.node_id, gpu_index: best, gpu_slot: slotIndex };
}

// Pre-account up to `want` jobs onto a node's free slots, given the placements already held by running
// work. Stops when capacity is exhausted (jobs beyond capacity stay pending). Pure: no SSH, no node
// observation. This is the brain's "reserve N slots" used by control/plan.ts's planNextBatch.
export function reserveSlots(
  node: NodeTopology,
  want: number,
  held: Array<{ gpu_index?: number }>
): GpuSlotAllocation[] {
  const counts = initVirtualGpuCounts(node, held);
  const placements: GpuSlotAllocation[] = [];
  for (let i = 0; i < want; i += 1) {
    const slot = allocateGpuSlot(node, counts);
    if (!slot) break;
    placements.push(slot);
  }
  return placements;
}
