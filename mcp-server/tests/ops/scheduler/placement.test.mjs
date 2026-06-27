import assert from "node:assert/strict";
import test from "node:test";
import { initVirtualGpuCounts, allocateGpuSlot, reserveSlots } from "../../../dist/ops/scheduler/control/placement.js";

const node = { node_id: "mars01", gpu_indices: [0, 1], max_slots_per_gpu: 1 };

test("initVirtualGpuCounts seeds from currently running placements", () => {
  // 一个已 running 的作业占着 gpu 0 → counts {0:1}
  const counts = initVirtualGpuCounts(node, [{ gpu_index: 0 }]);
  assert.deepEqual(counts, { 0: 1, 1: 0 });
});

test("allocateGpuSlot picks the least-loaded GPU under max_slots_per_gpu", () => {
  const counts = { 0: 1, 1: 0 };
  const slot = allocateGpuSlot(node, counts);
  assert.deepEqual(slot, { node_id: "mars01", gpu_index: 1, gpu_slot: 0 });
  // 记账递增后,gpu 1 现也占 1
  assert.equal(counts[1], 1);
});

test("allocateGpuSlot returns null when every GPU is at max_slots_per_gpu (no over-subscription)", () => {
  const counts = { 0: 1, 1: 1 };
  assert.equal(allocateGpuSlot(node, counts), null);
});

test("reserveSlots pre-accounts N jobs and refuses to exceed capacity (16 jobs / 2 GPUs)", () => {
  const placements = reserveSlots(node, 16, []);
  assert.equal(placements.length, 2); // slot_count=2 capacity (2 GPUs x 1 slot); rest stay pending
  assert.deepEqual(placements.map((p) => p.gpu_index), [0, 1]);
});

test("initVirtualGpuCounts THROWS on a held placement with a gpu_index not in topology (I3 fail-closed)", () => {
  // gpu 9 is not in node.gpu_indices → must refuse to plan rather than silently drop it.
  assert.throws(() => initVirtualGpuCounts(node, [{ gpu_index: 9 }]), /gpu_index|topology|held/i);
});

test("initVirtualGpuCounts THROWS on a held placement with an undefined gpu_index (I3 fail-closed)", () => {
  assert.throws(() => initVirtualGpuCounts(node, [{}]), /gpu_index|topology|held/i);
});

test("reserveSlots honors slots already held by running work", () => {
  const placements = reserveSlots(node, 4, [{ gpu_index: 0 }]); // gpu0 已占
  assert.equal(placements.length, 1); // 只剩 gpu1 一个空 slot
  assert.equal(placements[0].gpu_index, 1);
});
