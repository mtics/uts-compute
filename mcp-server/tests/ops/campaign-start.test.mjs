import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { planJob } from "../../dist/ops/plans/planner.js";
import { campaignStart, walltimeSecondsFor } from "../../dist/ops/scheduler/campaign/start.js";
import { readRunRecord } from "../../dist/core/audit.js";
import { readExample, tempRuntimeDir, runtimeRoot } from "../helpers/index.mjs";

const DEFAULT_TIMEOUT_SECONDS = 86400;

// A fresh iHPC quota snapshot for a profile, written to the fixed runtime quotas dir (where
// readFreshQuotaSnapshot looks). activeNodes is the account's OWN held set — the held-nodes evidence the
// ban-critical node-pool conformance gate consumes (C1). observedAt must be within the freshness window.
function writeIhpcQuotaSnapshot(snapshotId, profileId, observedAt, options = {}) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${snapshotId}.json`),
    `${JSON.stringify(
      {
        snapshot_id: snapshotId,
        profile_id: profileId,
        platform: "uts-ihpc",
        observed_at: observedAt,
        source: "quotas.refresh",
        freshness: "fresh",
        summary: {
          identity: { remote_user_observed: true },
          node_families: { observed: true, available_families: ["mars"], all_families: ["mars", "mercury"] },
          sessions: {
            observed: true,
            active_session_count: options.activeNodes ? options.activeNodes.length : 0,
            active_nodes: options.activeNodes ?? []
          }
        },
        commands: [],
        warnings: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

// Seed N planned iHPC runs sharing one campaign, each via the real planJob (so command_argv + plan
// artifacts + planned RunRecords exist), into shared temp plan/audit dirs. Also write a fresh quota
// snapshot (the held-nodes evidence the conformance gate now REQUIRES) keyed off `now`.
function seedCampaign(campaignId, runIds, options = {}) {
  const planDir = tempRuntimeDir("camp-plans");
  const auditDir = tempRuntimeDir("camp-runs");
  const profileId = options.profileId ?? "uts-ihpc-account-a";
  for (const runId of runIds) {
    const job = readExample("ihpc-background.json");
    job.run_id = runId;
    job.workdir = `/data/\${USER}/experiments/${runId}`;
    planJob(job, { planDir, auditDir, campaignId });
  }
  const now = options.now ?? new Date("2026-06-21T00:00:00.000Z");
  const quotaSnapshotId = options.quotaSnapshotId ?? `quota-${campaignId}-2026-06-21T00-00-00-000Z`;
  if (profileId.startsWith("uts-ihpc")) {
    writeIhpcQuotaSnapshot(quotaSnapshotId, profileId, now.toISOString(), { activeNodes: options.activeNodes });
  }
  return { planDir, auditDir, quotaSnapshotId, now, profileId };
}

// The default real SSH lease-read seam reads the on-node STATE; absent STATE => no holder (acquire). A
// test stub returns a STATE the way the node would write it, so the lease decision sees a REAL holder.
function stateExecutor(statePy, stdout) {
  return async (program, args, _timeoutMs, stdin) => {
    if (stdin === statePy) {
      return { exitCode: stdout === null ? 1 : 0, stdout: stdout ?? "", stderr: stdout === null ? "no state.json" : "" };
    }
    // PLAN write or progressor start.
    if (stdin.includes("reconcile") || stdin.includes("def main")) {
      return { exitCode: 0, stdout: JSON.stringify({ pid: 9090 }), stderr: "" };
    }
    return { exitCode: 0, stdout: JSON.stringify({ path: "ok", bytes: 1 }), stderr: "" };
  };
}

test("campaignStart drives the real seams: reads the campaign's planned runs, plans, launches via SSH, persists running", async () => {
  const { planDir, auditDir, quotaSnapshotId, now } = seedCampaign("camp_e", ["camp-e-r0", "camp-e-r1"]);
  const sshCalls = [];
  const result = await campaignStart(
    { campaignId: "camp_e", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 2, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      // mock the ONE launch SSH seam: the PLAN write returns ok, the progressor start returns a pid.
      // The lease-read seam (no state.json on the node => absent holder => acquire) returns exit 1.
      executor: async (program, args, _timeoutMs, stdin) => {
        sshCalls.push({ program, stdin });
        if (stdin.includes("no state.json for campaign") || stdin.includes("state/{campaign_id}/state.json")) {
          return { exitCode: 1, stdout: "", stderr: "no state.json for campaign" };
        }
        if (stdin.includes("reconcile") || stdin.includes("def main")) {
          return { exitCode: 0, stdout: JSON.stringify({ pid: 9090 }), stderr: "" };
        }
        return { exitCode: 0, stdout: JSON.stringify({ path: "ok", bytes: 1 }), stderr: "" };
      }
    }
  );

  assert.equal(result.campaign.ok, true);
  assert.equal(result.campaign.launched, 2, "both planned campaign runs were launched");
  assert.deepEqual([...result.campaign.run_ids].sort(), ["camp-e-r0", "camp-e-r1"]);
  assert.ok(result.campaign.plan_queue_id.startsWith("sha256:"));

  // the launch seam persisted each run as running, with the resident progressor pid.
  const r0 = readRunRecord("camp-e-r0", auditDir);
  assert.equal(r0.status, "running");
  assert.equal(r0.supervisor.pid, 9090);
  assert.equal(r0.campaign_id, "camp_e");
});

test("campaignStart reports no-planned-runs in-band for an empty/unknown campaign", async () => {
  const { planDir, auditDir, quotaSnapshotId, now } = seedCampaign("camp_other", ["camp-other-r0"]);
  const result = await campaignStart(
    { campaignId: "camp_absent", profileId: "uts-ihpc-account-a", node: "mars001", quotaSnapshotId },
    { planDir, auditDir, now, executor: async () => ({ exitCode: 1, stdout: "", stderr: "no state.json for campaign" }) }
  );
  assert.deepEqual(result.campaign, { ok: false, reason: "no-planned-runs" });
});

test("campaignStart surfaces a launch-failed verdict when the SSH seam errors", async () => {
  const { planDir, auditDir, quotaSnapshotId, now } = seedCampaign("camp_fail", ["camp-fail-r0"]);
  const result = await campaignStart(
    { campaignId: "camp_fail", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 1, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      executor: async (program, args, _timeoutMs, stdin) => {
        // lease read finds no holder; the launch seam then fails.
        if (stdin.includes("no state.json for campaign") || stdin.includes("state/{campaign_id}/state.json")) {
          return { exitCode: 1, stdout: "", stderr: "no state.json for campaign" };
        }
        return { exitCode: 255, stdout: "", stderr: "ssh: connect to host failed" };
      }
    }
  );
  assert.equal(result.campaign.ok, false);
  assert.equal(result.campaign.reason, "launch-failed");
});

test("campaignStart rejects a non-iHPC profile", async () => {
  const { planDir, auditDir } = seedCampaign("camp_hpc", [], { profileId: "uts-hpc-account-a" });
  await assert.rejects(
    campaignStart(
      { campaignId: "camp_hpc", profileId: "uts-hpc-account-a", node: "mars001", quotaSnapshotId: "x" },
      { planDir, auditDir, executor: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) }
    ),
    /requires uts-ihpc/
  );
});

// ---------------------------------------------------------------------------------------------------
// C1 (CRITICAL — ban prevention). The conformance gate must see THIS account's REAL held nodes (from the
// fresh quota snapshot), NOT a placeholder empty set. uts-ihpc-account-a's pool {mars,mercury,venus} is
// capped at 1; the account already holds venus01 in that pool, so launching onto mars001 would put the
// pool at 2 > 1 — the exact over-cap condition that triggers an iHPC ban. The gate must refuse IN-BAND
// (conformance-failed) and never reach the launch SSH seam.
// ---------------------------------------------------------------------------------------------------
test("campaignStart HARD-blocks (conformance-failed) when the account already holds nodes at its iHPC pool cap", async () => {
  const { planDir, auditDir, quotaSnapshotId, now } = seedCampaign("camp_pool", ["camp-pool-r0"], {
    quotaSnapshotId: "quota-camp_pool-2026-06-21T00-00-00-000Z",
    // held = limit: the account already holds one node (venus01) in the cap-1 pool.
    activeNodes: [{ node: "venus01", family: "venus" }]
  });
  let launchCalls = 0;
  const result = await campaignStart(
    { campaignId: "camp_pool", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 1, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      executor: async (program, args, _timeoutMs, stdin) => {
        // The only SSH allowed before the gate is the lease read (no holder). Any launch SSH is a bug.
        if (stdin.includes("no state.json for campaign") || stdin.includes("state/{campaign_id}/state.json")) {
          return { exitCode: 1, stdout: "", stderr: "no state.json for campaign" };
        }
        launchCalls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ pid: 1 }), stderr: "" };
      }
    }
  );

  assert.equal(result.campaign.ok, false);
  assert.equal(result.campaign.reason, "conformance-failed", "the ban-critical gate refuses on real held-nodes evidence");
  assert.ok(typeof result.campaign.detail === "string" && result.campaign.detail.length > 0);
  assert.equal(launchCalls, 0, "no PLAN write / progressor start when the node-pool cap is already reached");
});

// ---------------------------------------------------------------------------------------------------
// I1 (Important — single-writer lease). A LIVE different holder on the node => lease-blocked (no launch).
// The on-node STATE names a different client/device with a FRESH heartbeat; decideLease must return
// blocked and the launch seam must never run (two brains both writing the PLAN = double placement).
// ---------------------------------------------------------------------------------------------------
function nodeState(campaignId, { client, device_id, nodeClockEpoch, heartbeatIso }) {
  return JSON.stringify({
    schema_version: "1.0.0",
    campaign_id: campaignId,
    queue_id: "sha256:deadbeef",
    lease_owner: { client, device_id },
    observed_at_node: heartbeatIso,
    node_clock_epoch: nodeClockEpoch,
    slot_count: 1,
    progressor: { pid: 4242, started_at_node: heartbeatIso, heartbeat_node: heartbeatIso },
    health: { degraded: null, breaker_tripped: false },
    jobs: {},
    counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  });
}

test("campaignStart reports lease-blocked when a LIVE different holder owns the node (no launch)", async () => {
  const now = new Date("2026-06-21T00:00:00.000Z");
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const { planDir, auditDir, quotaSnapshotId } = seedCampaign("camp_lease", ["camp-lease-r0"], { now });
  let launchCalls = 0;
  const result = await campaignStart(
    { campaignId: "camp_lease", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 1, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      // a different client+device with a FRESH node-clock heartbeat (== node clock now) => live holder.
      readNodeLease: async () => ({
        held: { client: "codex", device_id: "other-laptop" },
        heartbeatEpoch: nowEpoch,
        nodeNowEpoch: nowEpoch
      }),
      executor: async () => {
        launchCalls += 1;
        return { exitCode: 0, stdout: JSON.stringify({ pid: 1 }), stderr: "" };
      }
    }
  );

  assert.equal(result.campaign.ok, false);
  assert.equal(result.campaign.reason, "lease-blocked", "a live other holder must block the launch");
  assert.equal(launchCalls, 0, "a blocked lease must not clobber the live holder's PLAN over SSH");
});

test("campaignStart acquires + launches when the on-node holder is STALE (heartbeat past the window)", async () => {
  const now = new Date("2026-06-21T00:00:00.000Z");
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const { planDir, auditDir, quotaSnapshotId } = seedCampaign("camp_stale", ["camp-stale-r0"], { now });
  const result = await campaignStart(
    { campaignId: "camp_stale", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 1, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      // a different holder whose last heartbeat is far older than the staleness window => takeover/launch.
      readNodeLease: async () => ({
        held: { client: "codex", device_id: "dead-laptop" },
        heartbeatEpoch: nowEpoch - 100000,
        nodeNowEpoch: nowEpoch
      }),
      executor: async (program, args, _timeoutMs, stdin) => {
        if (stdin.includes("reconcile") || stdin.includes("def main")) {
          return { exitCode: 0, stdout: JSON.stringify({ pid: 7070 }), stderr: "" };
        }
        return { exitCode: 0, stdout: JSON.stringify({ path: "ok", bytes: 1 }), stderr: "" };
      }
    }
  );

  assert.equal(result.campaign.ok, true, "a stale holder is taken over, the campaign launches");
  assert.equal(result.campaign.launched, 1);
});

// ---------------------------------------------------------------------------------------------------
// I2 (Important — phantom GPUs). maxConcurrent must not fabricate GPU indices beyond the node's real GPU
// count. uts-ihpc nodes have a conservative per-node GPU count; a maxConcurrent above it must be clamped
// (or refused) so the brain never places jobs onto non-existent GPU indices.
// ---------------------------------------------------------------------------------------------------
test("campaignStart does not place onto phantom GPUs: maxConcurrent above the node GPU count is bounded", async () => {
  const { planDir, auditDir, quotaSnapshotId, now } = seedCampaign(
    "camp_gpus",
    ["camp-gpus-r0", "camp-gpus-r1", "camp-gpus-r2", "camp-gpus-r3", "camp-gpus-r4", "camp-gpus-r5"],
    { now: new Date("2026-06-21T00:00:00.000Z") }
  );
  const writtenPlans = [];
  const result = await campaignStart(
    // ask for 64 concurrent — far beyond any real per-node GPU count.
    { campaignId: "camp_gpus", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 64, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      executor: async (program, args, _timeoutMs, stdin) => {
        if (stdin.includes("no state.json for campaign") || stdin.includes("state/{campaign_id}/state.json")) {
          return { exitCode: 1, stdout: "", stderr: "no state.json for campaign" };
        }
        if (stdin.includes("reconcile") || stdin.includes("def main")) {
          return { exitCode: 0, stdout: JSON.stringify({ pid: 9191 }), stderr: "" };
        }
        // capture the PLAN written over SSH (the atomic-write spec base64 carries it).
        const encoded = args.at(-1);
        try {
          const spec = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
          if (spec && typeof spec.contents === "string") writtenPlans.push(JSON.parse(spec.contents));
        } catch {
          // not the write call
        }
        return { exitCode: 0, stdout: JSON.stringify({ path: "ok", bytes: 1 }), stderr: "" };
      }
    }
  );

  assert.equal(result.campaign.ok, true);
  assert.equal(writtenPlans.length, 1, "one PLAN written");
  const plan = writtenPlans[0];
  // every placed gpu_index must be < the node GPU count (no phantom indices).
  const NODE_GPU_CEILING = 8; // the conservative documented per-node ceiling
  for (const job of plan.jobs) {
    assert.ok(job.gpu_index < NODE_GPU_CEILING, `gpu_index ${job.gpu_index} must be below the node GPU count`);
  }
  assert.ok(plan.limits.slot_count <= NODE_GPU_CEILING, "slot_count is bounded by the node GPU count");
  assert.ok(plan.jobs.length <= NODE_GPU_CEILING, "no more jobs than real GPUs are placed");
});

// ---------------------------------------------------------------------------------------------------
// P1 (crash-safety — invisible-orphan prevention). The campaign launch path must bracket its SSH side
// effects (PLAN write + progressor start) with a durable pre-launch marker, EXACTLY like the single-run
// submit paths persist "submitting" before qsub/start. A crash mid-launch (PLAN written and/or progressor
// maybe started, but the final "running" persist never lands) must leave a RECONCILABLE record on disk —
// status "submitting" with the campaign_id — NOT an absent record and NOT a falsely-"running" one.
// ---------------------------------------------------------------------------------------------------
test("campaignStart persists each selected run as a reconcilable 'submitting' marker BEFORE the launch SSH side effects", async () => {
  const { planDir, auditDir, quotaSnapshotId, now } = seedCampaign("camp_brk", ["camp-brk-r0", "camp-brk-r1"]);
  const result = await campaignStart(
    { campaignId: "camp_brk", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 2, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      executor: async (program, args, _timeoutMs, stdin) => {
        // lease read: no holder => acquire.
        if (stdin.includes("no state.json for campaign") || stdin.includes("state/{campaign_id}/state.json")) {
          return { exitCode: 1, stdout: "", stderr: "no state.json for campaign" };
        }
        // The progressor start TIMES OUT (the SSH channel dies after the PLAN write but before a daemon
        // pid is reported) — exactly the mid-launch crash window. The PLAN write itself returns ok so the
        // remote side effect already happened; the final "running" persist must therefore NOT have landed.
        if (stdin.includes("reconcile") || stdin.includes("def main")) {
          return { exitCode: 124, stdout: "", stderr: "ssh: progressor start timed out", timedOut: true };
        }
        return { exitCode: 0, stdout: JSON.stringify({ path: "ok", bytes: 1 }), stderr: "" };
      }
    }
  );

  // The orchestration surfaces a launch-failed verdict in-band.
  assert.equal(result.campaign.ok, false);
  assert.equal(result.campaign.reason, "launch-failed");

  // CRITICAL: each selected run's RunRecord exists on disk at the reconcilable pre-launch marker —
  // "submitting" WITH the campaign_id — never absent, never falsely "running".
  for (const runId of ["camp-brk-r0", "camp-brk-r1"]) {
    const rec = readRunRecord(runId, auditDir);
    assert.equal(rec.status, "submitting", `${runId} must be left at the durable pre-launch marker, not running`);
    assert.equal(rec.campaign_id, "camp_brk", `${runId} marker must carry the campaign_id so jobs.track can reconcile it`);
    // the node must be recoverable from the marker so the campaign reconcile path knows which STATE to read.
    assert.equal(rec.placement?.node_id, "mars001", `${runId} marker must record the target node for reconciliation`);
    assert.notEqual(rec.status, "running");
  }
});

test("campaignStart advances the pre-launch markers to 'running' with the real supervisor pid after a successful launch", async () => {
  const { planDir, auditDir, quotaSnapshotId, now } = seedCampaign("camp_adv", ["camp-adv-r0", "camp-adv-r1"]);
  const result = await campaignStart(
    { campaignId: "camp_adv", profileId: "uts-ihpc-account-a", node: "mars001", maxConcurrent: 2, quotaSnapshotId },
    {
      planDir,
      auditDir,
      now,
      executor: async (program, args, _timeoutMs, stdin) => {
        if (stdin.includes("no state.json for campaign") || stdin.includes("state/{campaign_id}/state.json")) {
          return { exitCode: 1, stdout: "", stderr: "no state.json for campaign" };
        }
        if (stdin.includes("reconcile") || stdin.includes("def main")) {
          return { exitCode: 0, stdout: JSON.stringify({ pid: 8181 }), stderr: "" };
        }
        return { exitCode: 0, stdout: JSON.stringify({ path: "ok", bytes: 1 }), stderr: "" };
      }
    }
  );

  assert.equal(result.campaign.ok, true);
  assert.equal(result.campaign.launched, 2);
  for (const runId of ["camp-adv-r0", "camp-adv-r1"]) {
    const rec = readRunRecord(runId, auditDir);
    assert.equal(rec.status, "running", `${runId} must advance from the marker to running`);
    assert.equal(rec.supervisor.pid, 8181, `${runId} carries the real supervisor (progressor) pid`);
    assert.equal(rec.campaign_id, "camp_adv");
  }
});

// ---------------------------------------------------------------------------------------------------
// M1 — walltimeSecondsFor rejects malformed HH:MM:SS components (negatives, minutes/seconds >= 60) and
// falls back to the advisory default rather than producing a negative or nonsense idle budget.
// ---------------------------------------------------------------------------------------------------
test("walltimeSecondsFor: valid HH:MM:SS converts; malformed components fall back to the default", () => {
  assert.equal(walltimeSecondsFor("01:02:03"), 3723, "1h2m3s");
  assert.equal(walltimeSecondsFor("100:00:00"), 360000, "100h");
  assert.equal(walltimeSecondsFor(undefined), DEFAULT_TIMEOUT_SECONDS, "no walltime => default");
  // negatives must not produce a negative budget.
  assert.equal(walltimeSecondsFor("1:-5:00"), DEFAULT_TIMEOUT_SECONDS, "negative minutes => default");
  assert.equal(walltimeSecondsFor("-1:00:00"), DEFAULT_TIMEOUT_SECONDS, "negative hours => default");
  // minutes/seconds >= 60 are malformed.
  assert.equal(walltimeSecondsFor("0:99:00"), DEFAULT_TIMEOUT_SECONDS, "minutes >= 60 => default");
  assert.equal(walltimeSecondsFor("0:00:99"), DEFAULT_TIMEOUT_SECONDS, "seconds >= 60 => default");
  // wrong shape.
  assert.equal(walltimeSecondsFor("3600"), DEFAULT_TIMEOUT_SECONDS, "not HH:MM:SS => default");
});
