import assert from "node:assert/strict";
import test from "node:test";
import { isIhpcPlanShape, isLeaseOwnerShape } from "../../../dist/ops/scheduler/seam/protocol.js";

// 这两个轻量 type-guard 在 protocol.ts(Task 5)实现;此 Task 仅靠它们间接断言 types 的字段存在,
// 因为 .d.ts 类型本身不可在运行时断言。先建 guard 的桩失败,Task 1 落 types,Task 5 落 guard。
test("LeaseOwner shape: client/device_id/issued_at", () => {
  assert.equal(isLeaseOwnerShape({ client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" }), true);
  assert.equal(isLeaseOwnerShape({ client: "claude" }), false);
  assert.equal(isLeaseOwnerShape({ client: "x", device_id: "d", issued_at: "t" }), false); // client 非 claude|codex
});

test("IhpcPlan shape: top + limits + security + policy + jobs", () => {
  const plan = {
    schema_version: "1.0.0", schema_compat_min: "1.0.0",
    campaign_id: "campaign_x", queue_id: "sha256:abcdef",
    lease_owner: { client: "claude", device_id: "d1", issued_at: "2026-06-20T14:32:10Z" },
    node_id: "mars01", profile_id: "utsihpc_user_01",
    limits: { slot_count: 2, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/home/user/p"], env_key_allowlist: ["UTS_RUN_ID"] },
    policy: {
      on_job_failure: "continue",
      failure_breaker: { max_consecutive_failures: 5, require_one_success: true },
      idle_definition: "no_running_and_no_launchable_pending",
      idle_exit_seconds: 604800, restart_throttle_seconds: 2
    },
    jobs: [{ seq: 0, run_id: "run_a", command_argv: ["python", "t.py"], workdir: "/home/user/p",
             env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 0, gpu_count: 1, timeout_seconds: 3600 }]
  };
  assert.equal(isIhpcPlanShape(plan), true);
  assert.equal(isIhpcPlanShape({ ...plan, jobs: [] }), false); // 空 jobs 非法
});
