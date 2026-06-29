import assert from "node:assert/strict";
import test from "node:test";
import { adoptExternalRun } from "../../../dist/ops/jobs/adopt.js";
import { readRunRecord } from "../../../dist/core/audit.js";
import { reconcileStaleHeldNodes, trackActiveJobs } from "../../../dist/ops/jobs/jobs.js";
import { tempRuntimeDir } from "../../helpers/index.mjs";

const SEED_NOW = new Date("2026-06-29T00:00:00.000Z");
const NOW = new Date("2026-06-29T00:05:00.000Z");

// Seed an ACTIVE adopted/observable iHPC run (status "running", observed node+pid, no supervisor) — the
// natural fixture: it carries observed.node + submission.node, which the stale-held-node reconcile reads.
async function seedIhpcRun(auditDir, { runId, node, pid, profileId = "uts-ihpc-account-a" }) {
  await adoptExternalRun({ runId, profileId, node, pid }, { auditDir, now: SEED_NOW });
}

// Build a stub fetchHeldNodes that records each profile it was asked about and answers from a fixed map.
function stubHeldNodes(answers, calls = []) {
  return async (profileId) => {
    calls.push(profileId);
    const answer = answers[profileId];
    if (!answer) {
      return { ok: false, heldNodes: new Set(), observedAt: NOW.toISOString(), reason: "no fixture" };
    }
    return {
      ok: answer.ok,
      heldNodes: new Set(answer.held ?? []),
      observedAt: NOW.toISOString(),
      ...(answer.ok ? {} : { reason: answer.reason ?? "probe failed" })
    };
  };
}

test("reconcileStaleHeldNodes: ok+held -> a run on a no-longer-held node becomes stale; a held one stays running", async () => {
  const auditDir = tempRuntimeDir("stale-ok-held");
  await seedIhpcRun(auditDir, { runId: "stale-on-venus6", node: "venus6", pid: 1001 });
  await seedIhpcRun(auditDir, { runId: "held-on-mars11", node: "mars11", pid: 1002 });

  const records = [readRunRecord("stale-on-venus6", auditDir), readRunRecord("held-on-mars11", auditDir)];
  const fetchHeldNodes = stubHeldNodes({ "uts-ihpc-account-a": { ok: true, held: ["mars11"] } });

  await reconcileStaleHeldNodes(records, { fetchHeldNodes, auditDir, now: NOW });

  const venus = readRunRecord("stale-on-venus6", auditDir);
  assert.equal(venus.status, "stale", "a run on a no-longer-held node is retired to stale");
  assert.ok(venus.stale_reason, "stale_reason is set");
  assert.match(venus.stale_reason, /venus6/, "stale_reason mentions the node");
  assert.equal(
    venus.events.some((e) => /reconcile|stale/i.test(e.kind)),
    true,
    "a reconcile/stale event was appended"
  );

  const mars = readRunRecord("held-on-mars11", auditDir);
  assert.equal(mars.status, "running", "a run on a still-held node is unchanged");
  assert.equal(mars.stale_reason, undefined);
});

test("reconcileStaleHeldNodes: ok=false (probe failed) marks NOTHING (audit-P0 — definite-only)", async () => {
  const auditDir = tempRuntimeDir("stale-probe-fail");
  await seedIhpcRun(auditDir, { runId: "probefail-venus6", node: "venus6", pid: 2001 });

  const before = readRunRecord("probefail-venus6", auditDir);
  const records = [readRunRecord("probefail-venus6", auditDir)];
  const fetchHeldNodes = stubHeldNodes({ "uts-ihpc-account-a": { ok: false, reason: "VPN down" } });

  await reconcileStaleHeldNodes(records, { fetchHeldNodes, auditDir, now: NOW });

  const after = readRunRecord("probefail-venus6", auditDir);
  assert.equal(after.status, "running", "a failed probe must NOT change status");
  assert.equal(after.stale_reason, undefined, "no stale_reason on a failed probe");
});

test("reconcileStaleHeldNodes: fetchHeldNodes is called ONCE per distinct profile, not per run", async () => {
  const auditDir = tempRuntimeDir("stale-onceperprofile");
  await seedIhpcRun(auditDir, { runId: "p1-run-a", node: "venus6", pid: 3001, profileId: "uts-ihpc-account-a" });
  await seedIhpcRun(auditDir, { runId: "p1-run-b", node: "venus7", pid: 3002, profileId: "uts-ihpc-account-a" });

  const records = [readRunRecord("p1-run-a", auditDir), readRunRecord("p1-run-b", auditDir)];
  const calls = [];
  const fetchHeldNodes = stubHeldNodes({ "uts-ihpc-account-a": { ok: true, held: ["mars11"] } }, calls);

  await reconcileStaleHeldNodes(records, { fetchHeldNodes, auditDir, now: NOW });

  assert.equal(calls.length, 1, "two runs on one profile => exactly one fetchHeldNodes call");
  assert.deepEqual(calls, ["uts-ihpc-account-a"]);
});

test("reconcileStaleHeldNodes: ok=true with EMPTY held set -> any active iHPC run is marked stale (holds-nothing boundary)", async () => {
  const auditDir = tempRuntimeDir("stale-empty-held");
  await seedIhpcRun(auditDir, { runId: "empty-held-venus6", node: "venus6", pid: 5001 });

  const records = [readRunRecord("empty-held-venus6", auditDir)];
  // held is empty — the account holds no nodes at all
  const fetchHeldNodes = stubHeldNodes({ "uts-ihpc-account-a": { ok: true, held: [] } });

  await reconcileStaleHeldNodes(records, { fetchHeldNodes, auditDir, now: NOW });

  const after = readRunRecord("empty-held-venus6", auditDir);
  assert.equal(after.status, "stale", "ok+empty-held-set: run on any node must become stale");
  assert.ok(after.stale_reason, "stale_reason is set");
  assert.match(after.stale_reason, /venus6/, "stale_reason mentions the node");
});

test("trackActiveJobs (integration): a staled run is excluded from the active/tracked output and persisted as stale", async () => {
  const auditDir = tempRuntimeDir("stale-track-integration");
  await seedIhpcRun(auditDir, { runId: "trk-stale-venus6", node: "venus6", pid: 4001 });
  await seedIhpcRun(auditDir, { runId: "trk-held-mars11", node: "mars11", pid: 4002 });

  // Stub fetchHeldNodes (held = {mars11}) so venus6 is no-longer-held. The per-run reconcile executor
  // answers the iHPC liveness probe alive (so a non-staled run would otherwise stay running).
  const fetchHeldNodes = stubHeldNodes({ "uts-ihpc-account-a": { ok: true, held: ["mars11"] } });
  const result = await trackActiveJobs(
    {},
    {
      auditDir,
      now: NOW,
      fetchHeldNodes,
      executor: async (_program, _args, _timeoutMs, stdin) => {
        if (typeof stdin === "string" && /os\.kill\(pid, 0\)/.test(stdin)) {
          return { exitCode: 0, stdout: `${JSON.stringify({ alive: true })}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "{}", stderr: "" };
      }
    }
  );

  const trackedIds = result.tracking.tracked.map((e) => e.run_id);
  assert.equal(trackedIds.includes("trk-stale-venus6"), false, "the freshly-staled run is NOT tracked as active");
  assert.equal(trackedIds.includes("trk-held-mars11"), true, "the still-held run is still tracked");

  const staled = readRunRecord("trk-stale-venus6", auditDir);
  assert.equal(staled.status, "stale", "the staled run is persisted as stale");
  assert.match(staled.stale_reason, /venus6/);
});
