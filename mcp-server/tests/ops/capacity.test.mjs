import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { computeCapacity, quotaCapacity } from "../../dist/ops/quotas/capacity.js";
import { readQuotaSnapshot } from "../../dist/ops/approvals/approvals.js";
import { hpcProfile, runtimeRoot, writeProfileConfig } from "../helpers/index.mjs";

function ihpcSnapshot(snapshotId, profileId, activeNodes = []) {
  return {
    snapshot_id: snapshotId,
    profile_id: profileId,
    platform: "uts-ihpc",
    observed_at: "2026-06-15T00:00:00.000Z",
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      identity: { remote_user_observed: true },
      node_families: { available_families: ["mars", "venus"], all_families: ["mars", "venus", "turing"] },
      sessions: { active_nodes: activeNodes },
      running_work: { active_session_count: activeNodes.length },
      storage: { filesystems: [] }
    },
    commands: [],
    warnings: []
  };
}

const TURING_SEGMENTS = [
  { families: ["mars", "venus", "mercury"], limit: 2 },
  { families: ["turing"], limit: 2 }
];

function writeSnapshot(snapshot) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${snapshot.snapshot_id}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function pbsSnapshot({ running, queued, maxRun, maxQueued }) {
  return {
    snapshot_id: "q1",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    observed_at: "2026-06-15T00:00:00.000Z",
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      identity: { remote_user_observed: true },
      queues: {
        queue_limits: [
          {
            name: "smallq",
            enabled: true,
            started: true,
            resources_max: {},
            max_run: { perUserGeneric: maxRun },
            max_queued: { perUserGeneric: maxQueued }
          },
          { name: "gpuq", enabled: true, started: true, resources_max: {}, max_run: { perUserGeneric: 1 } }
        ]
      },
      running_work: { by_queue: { smallq: { running, queued }, gpuq: { running: 1, queued: 0 } } },
      storage: {
        filesystems: [
          {
            filesystem: "/dev/home",
            mounted_on: "/home",
            capacity_percent: 80,
            avail: "100G",
            size: "500G",
            used: "400G",
            avail_bytes: null
          }
        ]
      }
    },
    commands: [],
    warnings: []
  };
}

test("computeCapacity reports per-queue run headroom and recommended parallelism", () => {
  const report = computeCapacity(
    pbsSnapshot({ running: 2, queued: 1, maxRun: 6, maxQueued: 10 }),
    "alice",
    [],
    new Date("2026-06-15T00:05:00.000Z")
  );
  const small = report.queues.find((q) => q.queue === "smallq");
  assert.equal(small.running, 2);
  assert.equal(small.max_run, 6);
  assert.equal(small.run_headroom, 4);
  assert.equal(small.recommended_parallel, 4);
  assert.equal(small.acceptable, true);

  const gpu = report.queues.find((q) => q.queue === "gpuq");
  assert.equal(gpu.run_headroom, 0);
  assert.equal(gpu.acceptable, false);

  assert.equal(report.best_queue, "smallq");
  assert.equal(report.recommended_parallel, 4);
  assert.equal(report.storage[0].capacity_percent, 80);
});

test("computeCapacity flags a stale snapshot in notes", () => {
  const report = computeCapacity(
    pbsSnapshot({ running: 0, queued: 0, maxRun: 5, maxQueued: 5 }),
    "alice",
    [],
    new Date("2026-06-15T01:00:00.000Z")
  );
  assert.ok(report.age_minutes >= 60);
  assert.ok(report.notes.some((n) => /stale|old|refresh/i.test(n)));
});

test("computeCapacity treats a disabled or stopped queue as unacceptable", () => {
  const snap = pbsSnapshot({ running: 0, queued: 0, maxRun: 5, maxQueued: 5 });
  snap.summary.queues.queue_limits[0].started = false;
  const report = computeCapacity(snap, "alice", [], new Date("2026-06-15T00:05:00.000Z"));
  assert.equal(report.queues.find((q) => q.queue === "smallq").acceptable, false);
});

test("quotas.capacity reads a saved snapshot for a profile and reports headroom", () => {
  const snap = pbsSnapshot({ running: 1, queued: 0, maxRun: 4, maxQueued: 8 });
  snap.snapshot_id = "cap-tool-snap";
  snap.profile_id = "uts-hpc-account-a";
  writeSnapshot(snap);
  const { capacity } = quotaCapacity(
    { profileId: "uts-hpc-account-a", snapshotId: "cap-tool-snap" },
    { now: new Date("2026-06-15T00:05:00.000Z") }
  );
  assert.equal(capacity.profile_id, "uts-hpc-account-a");
  assert.equal(capacity.best_queue, "smallq");
  assert.equal(capacity.recommended_parallel, 3);
});

test("quotas.capacity rejects a snapshot that belongs to a different profile", () => {
  const snap = pbsSnapshot({ running: 0, queued: 0, maxRun: 4, maxQueued: 8 });
  snap.snapshot_id = "cap-tool-wrong-profile";
  snap.profile_id = "uts-hpc-account-b";
  writeSnapshot(snap);
  assert.throws(
    () => quotaCapacity({ profileId: "uts-hpc-account-a", snapshotId: "cap-tool-wrong-profile" }),
    /is for uts-hpc-account-b/
  );
});

test("computeCapacity handles iHPC families and sessions", () => {
  const snap = {
    snapshot_id: "i1",
    profile_id: "uts-ihpc-account-a",
    platform: "uts-ihpc",
    observed_at: "2026-06-15T00:00:00.000Z",
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      node_families: { available_families: ["mars", "venus"], all_families: ["mars", "venus", "pluto"] },
      sessions: { active_nodes: ["mars001"] },
      running_work: { active_session_count: 1 },
      storage: { filesystems: [] }
    },
    commands: [],
    warnings: []
  };
  const report = computeCapacity(snap, "alice", [], new Date("2026-06-15T00:05:00.000Z"));
  assert.deepEqual(report.ihpc.available_families, ["mars", "venus"]);
  assert.equal(report.ihpc.active_sessions, 1);
  assert.equal(report.recommended_parallel, 2);
  assert.equal(report.queues.length, 0);
});

test("computeCapacity reports per-segment held/headroom when node limits are configured", () => {
  // One mars node held (general pool); turing pool untouched. Held is computed per segment from the
  // node's family — the general pool's 2 is SHARED across mars/venus/mercury, separate from turing's 2.
  const snap = ihpcSnapshot("i-seg", "uts-ihpc-account-a", [{ node: "mars001", family: "mars" }]);
  const report = computeCapacity(snap, "alice", [], new Date("2026-06-15T00:05:00.000Z"), TURING_SEGMENTS);
  assert.equal(report.ihpc.active_sessions, 1);
  const general = report.ihpc.segments.find((s) => s.families.includes("mars"));
  const turing = report.ihpc.segments.find((s) => s.families.includes("turing"));
  assert.deepEqual([general.held, general.limit, general.headroom], [1, 2, 1]);
  assert.deepEqual([turing.held, turing.limit, turing.headroom], [0, 2, 2]);
  // Total claimable across both independent pools.
  assert.equal(report.recommended_parallel, 3);
  assert.ok(
    report.notes.some((note) => /turing.*0\/2|do not exceed/i.test(note)),
    "expected a per-segment advisory note"
  );
});

test("computeCapacity notes when iHPC node limits are not configured", () => {
  const snap = ihpcSnapshot("i-noseg", "uts-ihpc-account-a", []);
  const report = computeCapacity(snap, "alice", [], new Date("2026-06-15T00:05:00.000Z"));
  assert.deepEqual(report.ihpc.segments, []);
  assert.equal(report.recommended_parallel, 2); // falls back to available-families count
  assert.ok(
    report.notes.some((note) => /node limits not configured|My Node Limits/i.test(note)),
    "expected an unconfigured-limits note"
  );
});

// Mock HPC SSH executor that yields a snapshot with a fresh per-user max_run headroom, distinct from
// any stale saved snapshot — so a refresh:true call demonstrably reports the FRESH numbers.
function freshHpcExecutor(calls) {
  return async (program, args) => {
    calls.push({ program, args });
    const remote = args.slice(args.indexOf("uts-hpc") + 1);
    if (remote.length === 1 && remote[0] === "whoami") {
      return { exitCode: 0, stdout: "abc123\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "id") {
      return { exitCode: 0, stdout: "uid=1000(abc123) gid=1000(research)\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "groups") {
      return { exitCode: 0, stdout: "research hpcusers\n", stderr: "" };
    }
    if (remote.length === 2 && remote.join(" ") === "qstat -Q") {
      return { exitCode: 0, stdout: "Queue Max Run\n----- ---\nsmallq 0\n", stderr: "" };
    }
    if (remote.length === 2 && remote.join(" ") === "qstat -Qf") {
      return {
        exitCode: 0,
        stdout:
          "Queue: smallq\n    enabled = True\n    started = True\n    max_run = [u:PBS_GENERIC=5]\n    max_queued = [u:PBS_GENERIC=10]\n",
        stderr: ""
      };
    }
    if (remote.length === 3 && remote[0] === "qstat" && remote[1] === "-u") {
      // qstat -u columns: JobID Username Queue Jobname ... S Time. One running job in smallq → fresh
      // run_headroom = 5 - 1 = 4 (queue at field[2], state at second-to-last).
      return { exitCode: 0, stdout: "1234.hpc abc123 smallq job 9999 1 1 -- 01:00 R 00:01\n", stderr: "" };
    }
    if (remote.length === 4 && remote.join(" ") === "pbsnodes -F json -a") {
      return { exitCode: 0, stdout: JSON.stringify({ nodes: { node001: { state: "free" } } }), stderr: "" };
    }
    if (remote.length === 2 && remote.join(" ") === "quota -s") {
      return { exitCode: 0, stdout: "Disk quotas for user abc123\n", stderr: "" };
    }
    if (remote.length === 3 && remote[0] === "df" && remote[1] === "-hP") {
      return { exitCode: 0, stdout: `Filesystem Size Used Avail Use% Mounted on\nstorage 1T 10G 990G 1% ${remote[2]}\n`, stderr: "" };
    }
    throw new Error(`Unexpected command: ${program} ${args.join(" ")}`);
  };
}

test("quotas.capacity refresh:true re-runs quotas.refresh and reports the fresh snapshot", async () => {
  const configPath = writeProfileConfig("cap-refresh", [hpcProfile]);
  // A stale saved snapshot that, if read, would flag staleness and show different headroom.
  const stale = pbsSnapshot({ running: 4, queued: 0, maxRun: 5, maxQueued: 10 });
  stale.snapshot_id = "cap-refresh-stale";
  stale.profile_id = "uts-hpc-account-a";
  stale.observed_at = "2026-06-15T00:00:00.000Z";
  writeSnapshot(stale);

  const calls = [];
  const now = new Date("2026-06-15T03:00:00.000Z");
  const { capacity } = await quotaCapacity(
    { profileId: "uts-hpc-account-a", snapshotId: "cap-refresh-stale", refresh: true },
    { configPath, now, executor: freshHpcExecutor(calls) }
  );

  // The refresh executor ran (SSH commands issued), not a stale-snapshot read.
  assert.ok(calls.length > 0, "expected the refresh executor to be invoked");
  assert.equal(capacity.profile_id, "uts-hpc-account-a");
  // observed_at == now ⇒ age 0, no stale note despite `now` being 3h after the saved snapshot.
  assert.equal(capacity.age_minutes, 0);
  assert.ok(!capacity.notes.some((n) => /stale|old/i.test(n)), "fresh snapshot must not be flagged stale");
  // Fresh headroom: max_run 5 - 1 running = 4 (the stale snapshot had 1).
  const small = capacity.queues.find((q) => q.queue === "smallq");
  assert.equal(small.run_headroom, 4);
  assert.equal(capacity.recommended_parallel, 4);

  // The refreshed snapshot must be PERSISTED so downstream tools (sweep.plan -> readQuotaSnapshot) can
  // read <id>.json back — previously refresh:true returned an id for an in-memory-only snapshot (ENOENT).
  assert.ok(capacity.snapshot_id, "a refreshed snapshot must carry an id");
  assert.doesNotThrow(() => readQuotaSnapshot(capacity.snapshot_id), "the refreshed snapshot must be on disk");
});

test("quotas.capacity without refresh reads the saved snapshot and does not contact the cluster", () => {
  const snap = pbsSnapshot({ running: 1, queued: 0, maxRun: 4, maxQueued: 8 });
  snap.snapshot_id = "cap-no-refresh";
  snap.profile_id = "uts-hpc-account-a";
  writeSnapshot(snap);
  const calls = [];
  const { capacity } = quotaCapacity(
    { profileId: "uts-hpc-account-a", snapshotId: "cap-no-refresh" },
    { now: new Date("2026-06-15T00:05:00.000Z"), executor: freshHpcExecutor(calls) }
  );
  assert.equal(calls.length, 0, "the saved-snapshot path must not invoke the executor");
  assert.equal(capacity.recommended_parallel, 3);
});

test("quotas.capacity threads the profile's node_limits segments into the iHPC advisory", () => {
  const configPath = writeProfileConfig("ihpc-node-limits", [
    {
      profile_id: "uts-ihpc-account-a",
      platform: "uts-ihpc",
      account_label: "ihpc-test",
      login: { host_alias: "ihpc-test", username_ref: "UTS_IHPC_TEST_USER", requires_vpn: true },
      defaults: { node_family: "turing", node_limits: TURING_SEGMENTS }
    }
  ]);
  // One turing node held → turing pool 1/2, general pool 0/2.
  const snap = ihpcSnapshot("cap-ihpc-seg", "uts-ihpc-account-a", [{ node: "turing1", family: "turing" }]);
  writeSnapshot(snap);
  const { capacity } = quotaCapacity(
    { profileId: "uts-ihpc-account-a", snapshotId: "cap-ihpc-seg" },
    { configPath, now: new Date("2026-06-15T00:05:00.000Z") }
  );
  const general = capacity.ihpc.segments.find((s) => s.families.includes("mars"));
  const turing = capacity.ihpc.segments.find((s) => s.families.includes("turing"));
  assert.deepEqual([turing.held, turing.limit, turing.headroom], [1, 2, 1]);
  assert.deepEqual([general.held, general.limit, general.headroom], [0, 2, 2]);
  assert.equal(capacity.recommended_parallel, 3);
});
