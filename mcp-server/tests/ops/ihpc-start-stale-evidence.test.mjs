import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import { readExample, tempRuntimeDir, runtimeRoot } from "../helpers/index.mjs";

// P0 (ban prevention): the iHPC node-pool conformance gate (checkIhpcNodePoolConformance in
// ihpc-start.ts) is the ONLY thing standing between an over-subscribed account and an iHPC ban.
// On the APPROVAL path the gate USED TO evaluate against the snapshot the approval was bound to,
// read raw (no freshness check). Since approval lifetime was decoupled from the 15-min snapshot
// TTL (approvals now live up to 24h), that held-nodes evidence could be up to 24h stale. These
// tests pin the fix: the ban-critical gate must use consume-time-FRESH held-node evidence even on
// the approval path, while the approval's identity binding stays on its ORIGINAL snapshot.

// uts-ihpc-account-a (profiles.example.yaml) pool {mars, mercury, venus} is capped at 1.
//
// `activeNodes` is the account's OWN held set, the held-nodes evidence the gate consumes. We let the
// caller control both observed_at (to make a snapshot stale or fresh vs `now`) and active_nodes (to
// model "0 held at mint" vs "at cap now"). The fresh snapshot must still expose an active session for
// a `mars` node so selectActiveComputeNode picks the planned compute node (mars001).
function writeIhpcQuotaSnapshot(snapshotId, profileId, observedAt, activeNodes) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  const nodes = activeNodes ?? [];
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
          node_families: { observed: true, available_families: ["mars"], all_families: ["mars", "mercury", "venus"] },
          sessions: {
            observed: true,
            active_session_count: nodes.length,
            active_nodes: nodes
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

// Plan + approve an iHPC run. The approval is minted against `mintSnapshotId` observed at `mintNow`
// (when the account held the nodes in `mintActiveNodes`). The approval lifetime is 24h, decoupled
// from the snapshot's 15-min TTL.
function approvedIhpcPlan(runId, { mintNow, mintActiveNodes }) {
  const planDir = tempRuntimeDir("test-stale-plans");
  const auditDir = tempRuntimeDir("test-stale-runs");
  const approvalDir = tempRuntimeDir("test-stale-approvals");
  const job = readExample("ihpc-background.json");
  job.run_id = runId;
  job.workdir = `/data/\${USER}/experiments/${runId}`;
  const plan = planJob(job, { planDir, auditDir });
  const mintSnapshotId = `quota-${runId}-mint`;
  writeIhpcQuotaSnapshot(mintSnapshotId, plan.profile_id, mintNow.toISOString(), mintActiveNodes);
  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      operation: "jobs.submit",
      planHash: plan.plan_hash,
      quotaSnapshotId: mintSnapshotId,
      reasons: plan.approval.reasons,
      commandSummary: plan.normalized_job_spec.command,
      resourceSummary: plan.normalized_job_spec.resources
    },
    { approvalDir, now: mintNow }
  ).approval;
  const approval = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId: mintSnapshotId,
      confirmationToken: "ihpc-token"
    },
    { approvalDir, now: mintNow, confirmationToken: "ihpc-token" }
  ).approval;
  return { plan, approval, planDir, auditDir, approvalDir, mintSnapshotId };
}

// A supervisor-start executor that always returns a valid daemon metadata line (so a launch that
// reaches the SSH seam succeeds — letting us prove the regression case consumes the approval). Tests
// that EXPECT a refusal also count calls to prove the gate refused BEFORE any SSH.
function startExecutor(runId, counter) {
  return async (program, args, timeoutMs, stdin) => {
    counter.calls += 1;
    return {
      exitCode: 0,
      stdout:
        `{"pid":9876,"metadata_path":"/data/alice/experiments/${runId}/logs/${runId}.supervisor.json",` +
        `"stdout_path":"/data/alice/experiments/${runId}/logs/${runId}.out",` +
        `"stderr_path":"/data/alice/experiments/${runId}/logs/${runId}.err"}\n`,
      stderr: ""
    };
  };
}

// ---------------------------------------------------------------------------------------------------
// THE BAN. Approval minted at T0 when the account held 0 nodes (snapshot now stale at T0+30min); a
// FRESH snapshot at `now` shows the account already holds venus01 — AT the cap-1 {mars,mercury,venus}
// pool. Starting onto mars001 (same pool) would push it to 2 > 1: the exact over-cap that bans the
// account. With the fix, startIhpcRun evaluates the gate against the FRESH snapshot and REFUSES before
// any SSH. The "would have wrongly passed" half is proven by submitting with NO fresh snapshot using
// the OLD behavior's evidence (the stale 0-held approval snapshot), which the test below also covers.
// ---------------------------------------------------------------------------------------------------
test("startIhpcRun REFUSES (ban prevention) when fresh held-nodes evidence shows the account is at its iHPC pool cap, even with a valid approval bound to a stale 0-held snapshot", async () => {
  const runId = "ihpc-stale-ban";
  const mintNow = new Date("2026-06-21T00:00:00.000Z");
  // At mint the account held NOTHING.
  const fixture = approvedIhpcPlan(runId, { mintNow, mintActiveNodes: [] });

  // 30 minutes later the approval is still valid (24h lifetime) but the mint snapshot is stale (>15m).
  const now = new Date("2026-06-21T00:30:00.000Z");
  // A FRESH snapshot at `now`: the account NOW holds venus01 (cap-1 pool full) AND has an active mars
  // session the plan can land on. Starting onto mars001 would push the pool to 2 > 1 => BAN.
  const freshSnapshotId = `quota-${runId}-fresh`;
  writeIhpcQuotaSnapshot(freshSnapshotId, fixture.plan.profile_id, now.toISOString(), [
    { node: "mars001", family: "mars" },
    { node: "venus01", family: "venus" }
  ]);

  const counter = { calls: 0 };
  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: freshSnapshotId },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now,
          executor: startExecutor(runId, counter)
        }
      ),
    /node-pool conformance failed|node-pool cap|would exceed/i,
    "the ban-critical gate must refuse against fresh held-nodes evidence"
  );
  assert.equal(counter.calls, 0, "no SSH supervisor start when the node-pool cap is already reached");

  // The approval was NOT consumed (the refusal happened before launch), so it remains usable.
  const approval = readApproval(fixture.approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.equal(approval.used_at, undefined, "a refused start must not consume the approval");
});

// ---------------------------------------------------------------------------------------------------
// OUTCOME-CHANGED PROOF. The SAME stale 0-held approval snapshot, fed as the gate evidence (the OLD
// behavior), would have WRONGLY PASSED: 0 held + 1 = 1 <= cap 1. We prove the old outcome by pointing
// the gate at the stale 0-held snapshot id (what the pre-fix code used) — it launches. The fix changes
// the outcome by requiring/using the FRESH snapshot id instead (covered by the test above).
// ---------------------------------------------------------------------------------------------------
test("the stale 0-held approval snapshot would have WRONGLY passed the gate (the pre-fix outcome the fix corrects)", async () => {
  const runId = "ihpc-stale-would-pass";
  const mintNow = new Date("2026-06-21T00:00:00.000Z");
  const fixture = approvedIhpcPlan(runId, { mintNow, mintActiveNodes: [] });

  // Re-stamp the SAME mint snapshot id as "fresh" at `now` but STILL 0-held — this is the stale
  // evidence the pre-fix code trusted (0 held => the gate passes and the run launches).
  const now = new Date("2026-06-21T00:30:00.000Z");
  writeIhpcQuotaSnapshot(fixture.mintSnapshotId, fixture.plan.profile_id, now.toISOString(), [
    { node: "mars001", family: "mars" }
  ]);

  const counter = { calls: 0 };
  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: fixture.mintSnapshotId },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      now,
      executor: startExecutor(runId, counter)
    }
  );

  // With 0 held, the gate passes and the run launches — demonstrating that the EVIDENCE chosen (stale
  // 0-held vs fresh at-cap) decides ban-vs-launch. The fix makes the FRESH evidence authoritative.
  assert.equal(result.submission.status, "running");
  assert.equal(counter.calls, 1);
});

// ---------------------------------------------------------------------------------------------------
// FAIL-CLOSED. An approval is present but NO fresh quotaSnapshotId is supplied. Pre-fix this silently
// fell back to the (possibly 24h stale) approval snapshot for the ban-critical gate. The fix REFUSES
// and demands a fresh snapshot — matching the codebase's fail-closed posture.
// ---------------------------------------------------------------------------------------------------
test("startIhpcRun REFUSES an approval with NO fresh quotaSnapshotId, demanding fresh held-nodes evidence for the ban-critical gate", async () => {
  const runId = "ihpc-no-fresh";
  const mintNow = new Date("2026-06-21T00:00:00.000Z");
  const fixture = approvedIhpcPlan(runId, { mintNow, mintActiveNodes: [{ node: "mars001", family: "mars" }] });

  const now = new Date("2026-06-21T00:30:00.000Z");
  const counter = { calls: 0 };
  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now,
          executor: startExecutor(runId, counter)
        }
      ),
    /fresh quotaSnapshotId|fresh quota snapshot/i,
    "an approval without a fresh snapshot must be refused for the ban-critical gate"
  );
  assert.equal(counter.calls, 0, "no SSH when fresh held-nodes evidence is missing");

  const approval = readApproval(fixture.approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.equal(approval.used_at, undefined, "a refused start must not consume the approval");
});

// ---------------------------------------------------------------------------------------------------
// REGRESSION (conforming). Fresh evidence shows held < cap (0 held in the pool, only an active mars
// session): the start SUCCEEDS, and the approval is consumed against its ORIGINAL snapshot id — the
// identity binding (plan_hash + quota_snapshot_id) is intact, NOT moved to the fresh snapshot.
// ---------------------------------------------------------------------------------------------------
test("startIhpcRun SUCCEEDS on the approval path with fresh under-cap evidence and consumes the approval against its ORIGINAL snapshot id (binding intact)", async () => {
  const runId = "ihpc-fresh-ok";
  const mintNow = new Date("2026-06-21T00:00:00.000Z");
  const fixture = approvedIhpcPlan(runId, { mintNow, mintActiveNodes: [{ node: "mars001", family: "mars" }] });

  const now = new Date("2026-06-21T00:30:00.000Z");
  const freshSnapshotId = `quota-${runId}-fresh`;
  // Fresh, under cap: only an active mars session, no held venus/mercury — held in pool = 0 < 1.
  writeIhpcQuotaSnapshot(freshSnapshotId, fixture.plan.profile_id, now.toISOString(), [
    { node: "mars001", family: "mars" }
  ]);

  const counter = { calls: 0 };
  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id, quotaSnapshotId: freshSnapshotId },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      now,
      executor: startExecutor(runId, counter)
    }
  );

  assert.equal(result.submission.status, "running");
  assert.equal(result.submission.approval_id, fixture.approval.approval_id);
  assert.equal(counter.calls, 1, "the start reached the SSH seam exactly once");

  // The approval is consumed, and its identity binding stays on the ORIGINAL mint snapshot — the fresh
  // snapshot supplied only the gate evidence, it did NOT rebind the approval.
  const consumed = readApproval(fixture.approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.ok(consumed.used_at, "the approval was consumed on a successful start");
  assert.equal(consumed.quota_snapshot_id, fixture.mintSnapshotId, "approval binding stays on its ORIGINAL snapshot id");

  // The persisted run record records the approval's original bound snapshot, not the fresh one.
  const runRecord = JSON.parse(fs.readFileSync(path.join(fixture.auditDir, `${runId}.json`), "utf8"));
  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.approval.bound_quota_snapshot_id, fixture.mintSnapshotId);
});
