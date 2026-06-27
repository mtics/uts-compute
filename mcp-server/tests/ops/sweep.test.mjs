import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { expandGrid, planSweep } from "../../dist/ops/jobs/sweep.js";
import { repoRoot, tempRuntimeDir, runtimeRoot } from "../helpers/index.mjs";

const noGit = () => ({ ok: false, stdout: "" });

function baseJobSpec(command) {
  const job = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs", "hpc-cpu.json"), "utf8"));
  return { ...job, command };
}

function planOptions() {
  return {
    configPath: "profiles/profiles.example.yaml",
    auditDir: tempRuntimeDir("test-sweep-runs"),
    planDir: tempRuntimeDir("test-sweep-plans"),
    gitRunner: noGit
  };
}

function writeSnapshot(snapshot) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${snapshot.snapshot_id}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

test("planSweep caps max_concurrent to the live queue run headroom when a snapshot is supplied", () => {
  writeSnapshot({
    snapshot_id: "sweep-cap-snap",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    observed_at: "2026-06-15T00:00:00.000Z",
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      identity: { remote_user_observed: true },
      queues: {
        queue_limits: [{ name: "smallq", enabled: true, started: true, resources_max: {}, max_run: { perUserGeneric: 6 } }]
      },
      running_work: { by_queue: { smallq: { running: 4, queued: 0 } } },
      storage: { filesystems: [] }
    },
    commands: [],
    warnings: []
  });

  const { sweep, plan } = planSweep(
    {
      jobSpec: baseJobSpec("python train.py --lr {lr}"),
      parameters: { lr: [0.1, 0.01, 0.001, 0.0001, 0.05] },
      snapshotId: "sweep-cap-snap",
      campaignId: "camp-cap"
    },
    planOptions()
  );

  assert.equal(sweep.size, 5);
  assert.equal(sweep.max_concurrent, 2);
  assert.equal(plan.normalized_job_spec.resources.array.max_concurrent, 2);
  assert.equal(sweep.capacity.target_queue, "smallq");
  assert.equal(sweep.capacity.run_headroom, 2);
});

test("expandGrid produces the cross-product in odometer order (last axis fastest)", () => {
  assert.deepEqual(expandGrid({ a: [1, 2], b: ["x", "y"] }), [
    { a: 1, b: "x" },
    { a: 1, b: "y" },
    { a: 2, b: "x" },
    { a: 2, b: "y" }
  ]);
});

test("planSweep expands a grid into one PBS array plan with an index->params table", () => {
  const { sweep, plan } = planSweep(
    {
      jobSpec: baseJobSpec("python train.py --lr {lr} --batch_size {batch_size}"),
      parameters: { lr: [0.1, 0.01], batch_size: [32, 64] },
      maxConcurrent: 2,
      campaignId: "camp-grid"
    },
    planOptions()
  );

  assert.equal(sweep.method, "grid");
  assert.equal(sweep.size, 4);
  assert.deepEqual(sweep.table[0], { index: 0, params: { lr: 0.1, batch_size: 32 } });
  assert.deepEqual(sweep.table[3], { index: 3, params: { lr: 0.01, batch_size: 64 } });

  assert.equal(plan.template, "pbs-array");
  assert.deepEqual(plan.normalized_job_spec.resources.array, { start: 0, end: 3, max_concurrent: 2 });
  assert.match(plan.normalized_job_spec.command, /^case \$\{PBS_ARRAY_INDEX\} in/);
  assert.match(plan.normalized_job_spec.command, /0\) python train\.py --lr 0\.1 --batch_size 32 ;;/);
  assert.match(plan.normalized_job_spec.command, /3\) python train\.py --lr 0\.01 --batch_size 64 ;;/);
  assert.match(plan.script, /#PBS -J 0-3%2/);
  // -o/-e use PBS Pro's parse-time ^array_index^ (NOT the shell-only ${PBS_ARRAY_INDEX}, which PBS does
  // not expand on directive lines), so each subtask writes a distinct log file instead of clobbering one.
  assert.match(plan.script, /#PBS -o \S*\^array_index\^\.out/);
  assert.doesNotMatch(plan.script, /#PBS -[oe][^\n]*PBS_ARRAY_INDEX/);
});

test("planSweep produces a deterministic plan_hash for identical input", () => {
  const input = {
    jobSpec: baseJobSpec("python train.py --lr {lr}"),
    parameters: { lr: [0.1, 0.01, 0.001] },
    campaignId: "camp-hash"
  };
  const a = planSweep(input, planOptions());
  const b = planSweep(input, planOptions());
  assert.equal(a.sweep.size, 3);
  assert.equal(a.plan.plan_hash, b.plan.plan_hash);
});

test("planSweep requires an explicit campaignId (fan-out must declare identity); campaign_id never enters plan_hash", () => {
  // campaignId is a planSweep ARGUMENT (not a JobSpec field); omitting it throws.
  assert.throws(
    () => planSweep({ jobSpec: baseJobSpec("python train.py --lr {lr}"), parameters: { lr: [0.1, 0.01] } }, planOptions()),
    /campaign/i
  );

  // Two otherwise-identical sweeps with DIFFERENT campaign ids produce the SAME plan_hash: campaign_id
  // is organizational metadata on the run record, never hashed into the spec.
  const base = { jobSpec: baseJobSpec("python train.py --lr {lr}"), parameters: { lr: [0.1, 0.01, 0.001] } };
  const a = planSweep({ ...base, campaignId: "camp-1" }, planOptions());
  const b = planSweep({ ...base, campaignId: "camp-2" }, planOptions());
  assert.equal(a.plan.plan_hash, b.plan.plan_hash);
});

test("planSweep rejects a grid larger than the cap before materializing it", () => {
  // 4 axes x 5 values = 625 > 256; must throw from the axis-length product check, not OOM in expandGrid.
  const parameters = { a: [1, 2, 3, 4, 5], b: [1, 2, 3, 4, 5], c: [1, 2, 3, 4, 5], d: [1, 2, 3, 4, 5] };
  assert.throws(
    () => planSweep({ jobSpec: baseJobSpec("python t.py --a {a} --b {b} --c {c} --d {d}"), parameters, campaignId: "camp" }, planOptions()),
    /exceeds the cap/
  );
});

test("planSweep rejects unsafe values, missing placeholders, and non-HPC platforms", () => {
  assert.throws(
    () => planSweep({ jobSpec: baseJobSpec("python t.py --lr {lr}"), parameters: { lr: ["0.1; rm -rf /"] }, campaignId: "camp" }, planOptions()),
    /unsafe value/i
  );
  assert.throws(
    () => planSweep({ jobSpec: baseJobSpec("python t.py"), parameters: { lr: [0.1] }, campaignId: "camp" }, planOptions()),
    /placeholder/i
  );
  assert.throws(
    () => planSweep({ jobSpec: { ...baseJobSpec("python t.py --lr {lr}"), platform: "uts-ihpc" }, parameters: { lr: [0.1] }, campaignId: "camp" }, planOptions()),
    /UTS HPC PBS array/i
  );
});
