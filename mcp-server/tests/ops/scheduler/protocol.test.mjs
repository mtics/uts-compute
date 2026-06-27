import assert from "node:assert/strict";
import test from "node:test";
import {
  isLeaseOwnerShape, isIhpcPlanShape, assertIhpcPlan, assertIhpcState, brainCanReadState,
  nodeStatusToRunStatus
} from "../../../dist/ops/scheduler/seam/protocol.js";

function validPlan() {
  return {
    schema_version: "1.0.0", schema_compat_min: "1.0.0",
    campaign_id: "campaign_x", queue_id: "sha256:abcdef",
    lease_owner: { client: "claude", device_id: "d1", issued_at: "2026-06-20T14:32:10Z" },
    node_id: "mars01", profile_id: "p1",
    limits: { slot_count: 2, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/home/user/p"], env_key_allowlist: ["UTS_RUN_ID", "CUDA_VISIBLE_DEVICES"] },
    policy: { on_job_failure: "continue",
              failure_breaker: { max_consecutive_failures: 5, require_one_success: true },
              idle_definition: "no_running_and_no_launchable_pending",
              idle_exit_seconds: 604800, restart_throttle_seconds: 2 },
    jobs: [{ seq: 0, run_id: "run_a", command_argv: ["python", "t.py"], workdir: "/home/user/p",
             env: { UTS_RUN_ID: "$RUN_ID$", CUDA_VISIBLE_DEVICES: "$GPU_INDEX$" },
             gpu_index: 0, gpu_count: 1, timeout_seconds: 3600 }]
  };
}

test("isLeaseOwnerShape / isIhpcPlanShape type guards", () => {
  assert.equal(isLeaseOwnerShape({ client: "codex", device_id: "d", issued_at: "t" }), true);
  assert.equal(isLeaseOwnerShape({ client: "nope", device_id: "d", issued_at: "t" }), false);
  assert.equal(isIhpcPlanShape(validPlan()), true);
  assert.equal(isIhpcPlanShape({ ...validPlan(), jobs: [] }), false);
});

test("assertIhpcPlan accepts a well-formed plan", () => {
  assert.doesNotThrow(() => assertIhpcPlan(validPlan()));
});

test("assertIhpcPlan rejects bash -lc style (command_argv must be argv, schema minItems)", () => {
  const p = validPlan();
  p.jobs[0].command_argv = []; // empty → invalid argv
  assert.throws(() => assertIhpcPlan(p), /command_argv|jobs/i);
});

test("assertIhpcPlan rejects an env key outside env_key_allowlist", () => {
  const p = validPlan();
  p.jobs[0].env.LD_PRELOAD = "/evil.so"; // not in allowlist
  assert.throws(() => assertIhpcPlan(p), /env key .* not in env_key_allowlist|LD_PRELOAD/);
});

test("assertIhpcPlan rejects an unknown $TOKEN$ sentinel in an env value", () => {
  const p = validPlan();
  p.security.env_key_allowlist.push("UTS_SECRET");
  p.jobs[0].env.UTS_SECRET = "$NOPE$"; // unknown sentinel
  assert.throws(() => assertIhpcPlan(p), /unknown token sentinel|\$NOPE\$/);
});

test("assertIhpcPlan rejects a workdir outside allowed_roots", () => {
  const p = validPlan();
  p.jobs[0].workdir = "/etc"; // outside /home/user/p
  assert.throws(() => assertIhpcPlan(p), /workdir .* outside allowed_roots/);
});

test("assertIhpcPlan rejects a workdir containing .. traversal segments (C1)", () => {
  const p = validPlan();
  // string-prefix-passes /home/user/p but escapes via .. → must be rejected (realpath-style)
  p.jobs[0].workdir = "/home/user/p/../../../etc";
  assert.throws(() => assertIhpcPlan(p), /workdir .* outside allowed_roots/);
});

test("assertIhpcPlan: a root of \"/\" does NOT make an arbitrary workdir pass unless genuinely under it (C1)", () => {
  // A workdir genuinely under "/" (everything is) is allowed only when the workdir itself is clean.
  const ok = validPlan();
  ok.security.allowed_roots = ["/"];
  ok.jobs[0].workdir = "/srv/run";
  assert.doesNotThrow(() => assertIhpcPlan(ok));
  // But a "/" root must NOT let a traversal workdir through.
  const bad = validPlan();
  bad.security.allowed_roots = ["/"];
  bad.jobs[0].workdir = "/srv/../../etc";
  assert.throws(() => assertIhpcPlan(bad), /workdir .* outside allowed_roots/);
});

test("assertIhpcPlan rejects env values with shell-expansion metachars $(...) ${...} backticks (I2)", () => {
  for (const evil of ["$(id)", "${HOME}", "`id`"]) {
    const p = validPlan();
    p.security.env_key_allowlist.push("UTS_SECRET");
    p.jobs[0].env.UTS_SECRET = evil;
    assert.throws(() => assertIhpcPlan(p), /\$|backtick|shell|metachar|expansion|sentinel/i,
      `expected rejection of env value ${evil}`);
  }
});

test("assertIhpcPlan rejects a misspelled key inside a brain-authored job item (schema additionalProperties:false)", () => {
  const p = validPlan();
  p.jobs[0].commnad_argv = ["python", "t.py"]; // typo of command_argv — must be rejected, not silently ignored
  assert.throws(() => assertIhpcPlan(p), /commnad_argv|additional|jobs/i);
});

test("assertIhpcPlan rejects a misspelled key inside security/limits/policy (schema additionalProperties:false)", () => {
  const p1 = validPlan();
  p1.security.allowed_root = ["/x"]; // typo of allowed_roots
  assert.throws(() => assertIhpcPlan(p1), /allowed_root|additional|security/i);
  const p2 = validPlan();
  p2.limits.slot_counts = 2; // typo of slot_count
  assert.throws(() => assertIhpcPlan(p2), /slot_counts|additional|limits/i);
});

test("assertIhpcPlan keeps the TOP-LEVEL object lenient for forward-compat (§2.7)", () => {
  const p = validPlan();
  p.future_top_level_field = { anything: true }; // unknown top-level key tolerated
  assert.doesNotThrow(() => assertIhpcPlan(p));
});

test("assertIhpcState validates a node STATE document", () => {
  const state = {
    schema_version: "1.0.0", campaign_id: "campaign_x", queue_id: "sha256:abcdef",
    lease_owner: { client: "claude", device_id: "d1" },
    observed_at_node: "2026-06-20T14:45:30Z", node_clock_epoch: 1781966730, slot_count: 2,
    progressor: { pid: 54321, started_at_node: "2026-06-20T14:32:11Z", heartbeat_node: "2026-06-20T14:45:30Z" },
    health: { degraded: null, breaker_tripped: false },
    jobs: { "0": { seq: 0, run_id: "run_a", status: "running", log: "/x/stdout.log" } },
    counts: { pending: 0, running: 1, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  };
  assert.doesNotThrow(() => assertIhpcState(state));
});

test("nodeStatusToRunStatus is the single node→RunRecord status table (CP-4)", () => {
  // every node status maps to a live RunRecord status; placement_conflict + unknown input → "unknown"
  assert.equal(nodeStatusToRunStatus("pending"), "submitted");
  assert.equal(nodeStatusToRunStatus("launching"), "running");
  assert.equal(nodeStatusToRunStatus("running"), "running");
  assert.equal(nodeStatusToRunStatus("done"), "finished");
  assert.equal(nodeStatusToRunStatus("failed"), "failed");
  assert.equal(nodeStatusToRunStatus("cancelled"), "cancelled");
  assert.equal(nodeStatusToRunStatus("placement_conflict"), "unknown");
  assert.equal(nodeStatusToRunStatus("some_future_status"), "unknown"); // no throw on newer-node STATE
});

test("brainCanReadState enforces schema_compat_min forward-compat (§2.7)", () => {
  // 大脑自身 1.2.0;STATE 由 schema_compat_min 1.0.0 的 PLAN 产出 → 可读
  assert.equal(brainCanReadState({ planCompatMin: "1.0.0", brainVersion: "1.2.0" }), true);
  // PLAN 要求最低 1.3.0,但大脑只有 1.2.0 → 不可读(死锁破除器:大脑太旧)
  assert.equal(brainCanReadState({ planCompatMin: "1.3.0", brainVersion: "1.2.0" }), false);
  // 大版本跳(v2) → 不可读
  assert.equal(brainCanReadState({ planCompatMin: "2.0.0", brainVersion: "1.9.0" }), false);
});
