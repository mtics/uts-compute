import assert from "node:assert/strict";
import test from "node:test";
import { planNextBatch } from "../../../dist/ops/scheduler/control/plan.js";
import { assertIhpcPlan } from "../../../dist/ops/scheduler/seam/protocol.js";

const me = { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" };
const node = { node_id: "mars01", gpu_indices: [0, 1], max_slots_per_gpu: 1 };

function jobRec(run_id, queue_position) {
  return {
    run_id, status: "planned", queue_position, campaign_id: "c1", profile_id: "p1",
    command_argv: ["python", "train.py", "--lr", "0.01"], workdir: "/home/user/p",
    env: { UTS_RUN_ID: "$RUN_ID$", CUDA_VISIBLE_DEVICES: "$GPU_INDEX$" }, timeout_seconds: 3600
  };
}

function baseInput(overrides = {}) {
  return {
    campaignId: "c1", profileId: "p1", node,
    me, lease: { action: "acquire" },
    maxConcurrent: 4, slotCount: 2,
    allowedRoots: ["/home/user/p"],
    envKeyAllowlist: ["UTS_RUN_ID", "CUDA_VISIBLE_DEVICES"],
    nodeLimits: [{ families: ["mars"], limit: 2 }],
    activeNodes: [],
    records: [jobRec("run_a", 0), jobRec("run_b", 1), jobRec("run_c", 2)],
    held: [],
    ...overrides
  };
}

test("planNextBatch emits a schema-valid PLAN + aligned placements for the launchable batch", () => {
  const { plan, placements } = planNextBatch(baseInput());
  assert.doesNotThrow(() => assertIhpcPlan(plan));
  assert.equal(plan.campaign_id, "c1");
  assert.equal(plan.node_id, "mars01");
  assert.deepEqual(plan.lease_owner, me);
  // slot_count=2 / 2 GPUs → 只有 run_a,run_b 进 plan(run_c 留 pending)
  assert.deepEqual(plan.jobs.map((j) => j.run_id), ["run_a", "run_b"]);
  assert.deepEqual(plan.jobs.map((j) => j.gpu_index), [0, 1]);
  // placements 与 jobs 按下标对齐,且携带 gpu_slot(B-2:gpu_slot 的写路径起点)
  assert.equal(placements.length, plan.jobs.length);
  assert.deepEqual(placements.map((p) => p.gpu_index), [0, 1]);
  assert.deepEqual(placements.map((p) => p.gpu_slot), [0, 0]); // 每 GPU 第 0 个 slot(max_slots_per_gpu=1)
  // queue_id 是内容 hash
  assert.match(plan.queue_id, /^sha256:[0-9a-f]+$/);
});

test("planNextBatch returns null when the lease is blocked (a live other holder)", () => {
  const result = planNextBatch(baseInput({ lease: { action: "blocked", holder: { client: "codex", device_id: "d" } } }));
  assert.equal(result, null);
});

test("planNextBatch refuses when the node-pool quota gate fails (ban-critical)", () => {
  // 已持有 2 个 mars 节点 + 目标 mars01 → 第 3 个 → 超 limit 2
  assert.throws(
    () => planNextBatch(baseInput({ activeNodes: [{ node: "mars02" }, { node: "mars03" }] })),
    /node-pool|conformance/i
  );
});

test("planNextBatch caps placement at slotCount even when GPU capacity is larger (I3)", () => {
  // node has 2 GPUs x 2 slots = 4 GPU-capacity, but slotCount=1 must cap the batch to 1 job.
  const wideNode = { node_id: "mars01", gpu_indices: [0, 1], max_slots_per_gpu: 2 };
  const { plan, placements } = planNextBatch(baseInput({ node: wideNode, slotCount: 1, maxConcurrent: 4 }));
  assert.equal(plan.jobs.length, 1, "slot_count=1 must cap to one placed job");
  assert.equal(placements.length, 1);
  assert.deepEqual(plan.jobs.map((j) => j.run_id), ["run_a"]);
});

test("planNextBatch is deterministic: same input → same queue_id", () => {
  const a = planNextBatch(baseInput());
  const b = planNextBatch(baseInput());
  assert.equal(a.plan.queue_id, b.plan.queue_id);
});
