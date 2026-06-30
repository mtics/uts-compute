import assert from "node:assert/strict";
import test from "node:test";
import { checkPbsConformance, checkIhpcNodePoolConformance } from "../../dist/ops/quotas/conformance.js";

const smallq = {
  name: "smallq",
  enabled: true,
  started: true,
  resources_max: { ncpus: 4, mem_gb: 32, walltime_seconds: 86400 },
  max_run: { perUserGeneric: 60 },
  max_queued: { perUserGeneric: 100 }
};
const gpuq = {
  name: "small_gpuq",
  enabled: true,
  started: true,
  acl_user_enable: false,
  resources_max: { walltime_seconds: 48 * 3600 },
  max_run: { perUserGeneric: 12 }
};
const aclq = {
  name: "aclq",
  enabled: true,
  started: true,
  acl_user_enable: true,
  acl_users: ["alice", "bob"],
  resources_max: {},
  max_run: { perUserGeneric: 4 }
};
const disabledq = { name: "disabledq", enabled: true, started: false, resources_max: {} };

const base = { username: "u00000001", groups: [], runningInQueue: 0, queuedInQueue: 0 };

test("a PBS routing queue (queue_type Route) is refused — its own limits are not the ones that apply", () => {
  const routeq = { name: "defaultq", queue_type: "Route", enabled: true, started: true, resources_max: {} };
  const r = checkPbsConformance({
    ...base, queue: "defaultq", ncpus: 4, memory_gb: 8, walltime: "01:00:00", queueLimit: routeq
  });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((v) => v.code === "routing-queue"));
});

test("an execution queue is not flagged as a routing queue", () => {
  const r = checkPbsConformance({
    ...base, queue: "smallq", ncpus: 4, memory_gb: 32, walltime: "24:00:00", queueLimit: smallq
  });
  assert.ok(!r.violations.some((v) => v.code === "routing-queue"));
});

test("a job within smallq limits conforms", () => {
  const r = checkPbsConformance({
    ...base, queue: "smallq", ncpus: 4, memory_gb: 32, walltime: "24:00:00", queueLimit: smallq
  });
  assert.equal(r.conforms, true);
  assert.deepEqual(r.violations, []);
});

test("unobserved queue limits refuse autonomous conformance (fail-safe, not fail-open)", () => {
  // Even a job that fits smallq must be refused when the snapshot did not capture the queue limits:
  // conformance is unverifiable, so the caller must fall back to an explicit approval.
  const r = checkPbsConformance({
    ...base, queue: "smallq", ncpus: 4, memory_gb: 32, walltime: "24:00:00", queueLimit: smallq, limitsObserved: false
  });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((v) => v.code === "limits-unverified"));
});

test("explicitly observed limits conform normally (limitsObserved:true is a no-op)", () => {
  const r = checkPbsConformance({
    ...base, queue: "smallq", ncpus: 4, memory_gb: 32, walltime: "24:00:00", queueLimit: smallq, limitsObserved: true
  });
  assert.equal(r.conforms, true);
  assert.deepEqual(r.violations, []);
});

test("ncpus over the queue cap fails", () => {
  const r = checkPbsConformance({
    ...base, queue: "smallq", ncpus: 8, memory_gb: 8, walltime: "01:00:00", queueLimit: smallq
  });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((v) => v.code === "ncpus-exceeded"));
});

test("memory and walltime over the queue caps both fail", () => {
  const r = checkPbsConformance({
    ...base, queue: "smallq", ncpus: 2, memory_gb: 64, walltime: "48:00:00", queueLimit: smallq
  });
  const codes = r.violations.map((v) => v.code);
  assert.ok(codes.includes("mem-exceeded"));
  assert.ok(codes.includes("walltime-exceeded"));
  assert.equal(r.conforms, false);
});

test("submitting at the per-user max_run fails with max-run-exceeded", () => {
  const r = checkPbsConformance({
    ...base, queue: "smallq", ncpus: 1, memory_gb: 1, walltime: "00:05:00", queueLimit: smallq, runningInQueue: 60
  });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((v) => v.code === "max-run-exceeded"));
});

test("an unknown queue fails with unknown-queue and skips resource checks", () => {
  const r = checkPbsConformance({ ...base, queue: "nope", ncpus: 999, queueLimit: undefined });
  assert.equal(r.conforms, false);
  assert.deepEqual(r.violations.map((v) => v.code), ["unknown-queue"]);
});

test("a not-started queue fails with queue-disabled", () => {
  const r = checkPbsConformance({ ...base, queue: "disabledq", ncpus: 1, walltime: "00:05:00", queueLimit: disabledq });
  assert.ok(r.violations.some((v) => v.code === "queue-disabled"));
  assert.equal(r.conforms, false);
});

test("an ACL-restricted queue denies a non-listed account", () => {
  const r = checkPbsConformance({ ...base, queue: "aclq", ncpus: 1, walltime: "00:05:00", queueLimit: aclq });
  assert.ok(r.violations.some((v) => v.code === "acl-denied"));
});

test("an open GPU queue with unset cpu/mem caps accepts a within-walltime job", () => {
  const r = checkPbsConformance({
    ...base, queue: "small_gpuq", ncpus: 12, memory_gb: 48, ngpus: 1, walltime: "10:00:00", queueLimit: gpuq, runningInQueue: 5
  });
  assert.equal(r.conforms, true);
  assert.deepEqual(r.violations, []);
});

// --- iHPC node-pool conformance (own-cap, per-account, ENFORCEMENT not evasion) -------------------
// A single account exceeding its OWN iHPC node-pool cap is the exact condition that triggers a ban;
// this gate structurally prevents it. The check is per-profile: it NEVER sums across accounts.

test("checkIhpcNodePoolConformance hard-blocks a node-pool overflow (own-cap)", () => {
  // pool {families:["turing"], limit:2}, already 2 held -> starting a 3rd turing node violates
  const r = checkIhpcNodePoolConformance({
    targetNode: "turing3",
    nodeLimits: [{ families: ["turing"], limit: 2 }],
    activeNodes: [{ node: "turing1", family: "turing" }, { node: "turing2", family: "turing" }]
  });
  assert.equal(r.conforms, false);
  assert.ok(r.violations.some((v) => v.code === "node-pool-exceeded"));
});

test("conforms when the pool has headroom", () => {
  const r = checkIhpcNodePoolConformance({
    targetNode: "turing2",
    nodeLimits: [{ families: ["turing"], limit: 2 }],
    activeNodes: [{ node: "turing1", family: "turing" }]
  });
  assert.equal(r.conforms, true);
});

test("conforms when the target node is already an active held node (no double-count)", () => {
  // A supervised run launches a process ON an already-held node; using it must not falsely
  // count it as a +1 acquisition against its own pool.
  const r = checkIhpcNodePoolConformance({
    targetNode: "mars001",
    nodeLimits: [{ families: ["mars", "mercury", "venus"], limit: 1 }],
    activeNodes: [{ node: "mars001", family: "mars" }]
  });
  assert.equal(r.conforms, true);
  assert.deepEqual(r.violations, []);
});

test("no enforceable cap when node_limits is unset (operator must set it from the portal)", () => {
  const r = checkIhpcNodePoolConformance({ targetNode: "turing3", nodeLimits: undefined, activeNodes: [] });
  assert.equal(r.conforms, true);
});

test("a target node in an untracked family is not gated by an unrelated pool", () => {
  const r = checkIhpcNodePoolConformance({
    targetNode: "jupiter1",
    nodeLimits: [{ families: ["turing"], limit: 2 }],
    activeNodes: [{ node: "turing1", family: "turing" }, { node: "turing2", family: "turing" }]
  });
  assert.equal(r.conforms, true);
});

test("NEVER sums across accounts: two accounts each under their own cap is NOT a violation", () => {
  // Two collaborators, each owning ONE iHPC account, each holding exactly 1 turing node under a
  // per-account cap of 2. Summing them (1+1=2 each, +1 = over) would be both wrong AND an evasion
  // vector. Each account is checked against its OWN pool only — account A starting a 2nd turing
  // node sees only ITS OWN held node, so held(1)+1=2 <= 2 conforms.
  const accountA = checkIhpcNodePoolConformance({
    targetNode: "turing2",
    nodeLimits: [{ families: ["turing"], limit: 2 }],
    activeNodes: [{ node: "turing1", family: "turing" }] // only account A's own held node
  });
  assert.equal(accountA.conforms, true);
  const accountB = checkIhpcNodePoolConformance({
    targetNode: "turing4",
    nodeLimits: [{ families: ["turing"], limit: 2 }],
    activeNodes: [{ node: "turing3", family: "turing" }] // only account B's own held node
  });
  assert.equal(accountB.conforms, true);
});
