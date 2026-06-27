import assert from "node:assert/strict";
import test from "node:test";
import {
  parseWalltimeSeconds,
  parseMemGb,
  parsePbsLimitSpec,
  effectiveUserLimit,
  parsePbsQueueLimits,
  nodeInPool,
  computeNodePoolOccupancy,
  totalNodeHeadroom
} from "../../dist/ops/quotas/quota-limits.js";

// Real qstat -Qf shape observed on CETUS (hpc-login) 2026-06-16, plus a synthetic ACL queue.
const QSTAT_QF = `Queue: smallq
    queue_type = Execution
    total_jobs = 3
    state_count = Transit:0 Queued:0 Held:0 Waiting:0 Running:3 Exiting:0
    max_queued = [u:PBS_GENERIC=100]
    resources_max.mem = 32gb
    resources_max.ncpus = 4
    resources_max.walltime = 24:00:00
    resources_default.walltime = 24:00:00
    max_run = [u:PBS_GENERIC=60]
    enabled = True
    started = True

Queue: small_gpuq
    queue_type = Execution
    acl_user_enable = False
    resources_max.walltime = 48:00:00
    max_run = [u:PBS_GENERIC=12]
    enabled = True
    started = True

Queue: privq
    queue_type = Execution
    acl_user_enable = True
    acl_users = alice,bob
    resources_max.ncpus = 8
    resources_max.ngpus = 2
    max_run = [u:alice=10,u:PBS_GENERIC=4]
    enabled = True
    started = False
`;

test("parseWalltimeSeconds converts HH:MM:SS to seconds", () => {
  assert.equal(parseWalltimeSeconds("24:00:00"), 86400);
  assert.equal(parseWalltimeSeconds("02:00:00"), 7200);
  assert.equal(parseWalltimeSeconds("200:00:00"), 720000);
  assert.equal(parseWalltimeSeconds("00:05:30"), 330);
  assert.equal(parseWalltimeSeconds("nonsense"), undefined);
});

test("parseMemGb converts PBS memory strings to GB", () => {
  assert.equal(parseMemGb("32gb"), 32);
  assert.equal(parseMemGb("100gb"), 100);
  assert.equal(parseMemGb("512mb"), 0.5);
  assert.equal(parseMemGb("1tb"), 1024);
  assert.equal(parseMemGb("2048kb"), 2048 / 1024 / 1024);
  assert.equal(parseMemGb("weird"), undefined);
});

test("parsePbsLimitSpec parses PBS scoped limit syntax", () => {
  assert.deepEqual(parsePbsLimitSpec("[u:PBS_GENERIC=60]"), { perUserGeneric: 60 });
  assert.deepEqual(parsePbsLimitSpec("[o:PBS_ALL=50]"), { overall: 50 });
  assert.deepEqual(parsePbsLimitSpec("[u:alice=5]"), { perUser: { alice: 5 } });
  assert.deepEqual(parsePbsLimitSpec("[g:research=3]"), { perGroup: { research: 3 } });
  assert.deepEqual(parsePbsLimitSpec("[u:alice=10,u:PBS_GENERIC=4]"), {
    perUser: { alice: 10 },
    perUserGeneric: 4
  });
});

test("effectiveUserLimit prefers a user-specific cap over the generic one", () => {
  const spec = { perUser: { alice: 10 }, perUserGeneric: 4 };
  assert.equal(effectiveUserLimit(spec, "alice"), 10);
  assert.equal(effectiveUserLimit(spec, "bob"), 4);
  assert.equal(effectiveUserLimit({ perUserGeneric: 60 }, "anyone"), 60);
  assert.equal(effectiveUserLimit(undefined, "anyone"), undefined);
});

test("parsePbsQueueLimits parses real qstat -Qf into structured per-queue limits", () => {
  const queues = parsePbsQueueLimits(QSTAT_QF);
  const byName = Object.fromEntries(queues.map((q) => [q.name, q]));

  const small = byName.smallq;
  assert.ok(small, "smallq parsed");
  assert.equal(small.enabled, true);
  assert.equal(small.started, true);
  assert.equal(small.resources_max.ncpus, 4);
  assert.equal(small.resources_max.mem_gb, 32);
  assert.equal(small.resources_max.walltime_seconds, 86400);
  assert.deepEqual(small.max_run, { perUserGeneric: 60 });
  assert.deepEqual(small.max_queued, { perUserGeneric: 100 });

  const gpu = byName.small_gpuq;
  assert.equal(gpu.acl_user_enable, false);
  assert.equal(gpu.resources_max.walltime_seconds, 48 * 3600);
  assert.equal(gpu.resources_max.ncpus, undefined, "gpu queue has no ncpus cap");
  assert.deepEqual(gpu.max_run, { perUserGeneric: 12 });

  const priv = byName.privq;
  assert.equal(priv.started, false);
  assert.equal(priv.acl_user_enable, true);
  assert.deepEqual(priv.acl_users, ["alice", "bob"]);
  assert.equal(priv.resources_max.ngpus, 2);
  assert.equal(effectiveUserLimit(priv.max_run, "alice"), 10);
  assert.equal(effectiveUserLimit(priv.max_run, "u00000001"), 4);
});

// iHPC node-limit pool primitives (reused by the capacity advisory and any future conformance gate).
test("nodeInPool matches by parsed family and falls back to node-id prefix", () => {
  assert.equal(nodeInPool("mars5", "mars", ["mars", "mercury", "venus"]), true);
  // No explicit family -> inferNodeFamily / prefix still classifies it.
  assert.equal(nodeInPool("saturn2", undefined, ["saturn", "neptune"]), true);
  assert.equal(nodeInPool("turing1", undefined, ["turing"]), true);
  assert.equal(nodeInPool("mars1", "mars", ["turing"]), false);
});

test("computeNodePoolOccupancy counts held nodes per independent pool", () => {
  const pools = [
    { families: ["mars", "mercury", "venus"], limit: 1 },
    { families: ["saturn", "neptune"], limit: 1 },
    { families: ["turing"], limit: 2 }
  ];
  const occ = computeNodePoolOccupancy(pools, [
    { node: "mars1", family: "mars" },
    { node: "turing1", family: "turing" }
  ]);
  assert.deepEqual(occ[0], { families: ["mars", "mercury", "venus"], limit: 1, held: 1, headroom: 0 });
  assert.deepEqual(occ[1], { families: ["saturn", "neptune"], limit: 1, held: 0, headroom: 1 });
  assert.deepEqual(occ[2], { families: ["turing"], limit: 2, held: 1, headroom: 1 });
});

test("totalNodeHeadroom sums remaining headroom across independent pools", () => {
  const occ = computeNodePoolOccupancy(
    [
      { families: ["mars", "mercury", "venus"], limit: 1 },
      { families: ["turing"], limit: 2 }
    ],
    [{ node: "mars1", family: "mars" }]
  );
  assert.equal(totalNodeHeadroom(occ), 2); // general 0 free + turing 2 free
});
