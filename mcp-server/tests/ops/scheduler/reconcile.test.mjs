import test from "node:test";
import assert from "node:assert/strict";
import { reconcileIhpcCampaign } from "../../../dist/ops/scheduler/seam/reconcile.js";
import { pickIhpcReconciler } from "../../../dist/ops/jobs/jobs.js";

test("pickIhpcReconciler routes campaign runs to the seam and single runs to per-pid", () => {
  assert.equal(pickIhpcReconciler({ platform: "uts-ihpc", campaign_id: "campaign_x" }), "campaign");
  assert.equal(pickIhpcReconciler({ platform: "uts-ihpc" }), "per-pid");
  // a non-iHPC run is never a campaign-seam consumer
  assert.equal(pickIhpcReconciler({ platform: "uts-hpc", campaign_id: "campaign_x" }), "per-pid");
});

function stateWith(jobs, progressor = { pid: 5000, started_at_node: "x", heartbeat_node: "2026-06-20T14:45:30Z" }) {
  return {
    schema_version: "1.0.0", campaign_id: "campaign_x", queue_id: "sha256:abcdef",
    lease_owner: { client: "claude", device_id: "dev-1" },
    observed_at_node: "2026-06-20T14:45:30Z", node_clock_epoch: 1781966730, slot_count: 2,
    progressor, health: { degraded: null, breaker_tripped: false },
    jobs, counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  };
}

// CP-2: the canonical reconcile seam takes { campaignId, profileId, profile, node, runRecords } and deps
// { readState, persistRunRecord, relaunchProgressor, progressorAlive?, adoptLiveJob?, auditDir? }. These
// names are shared verbatim with Phase D Task 5 (D only WIRES this signature, never reshapes it).
test("reconcileIhpcCampaign maps STATE job statuses onto RunRecords (one SSH read)", async () => {
  let reads = 0;
  const persisted = [];
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [
        { run_id: "run_0", status: "running" }, { run_id: "run_1", status: "running" }
      ] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      readState: async () => { reads += 1; return stateWith({
        "0": { seq: 0, run_id: "run_0", status: "done", pid: 1, gpu_index: 0, exit_code: 0, started_at_node: "a", finished_at_node: "b", log: "/l/0" },
        "1": { seq: 1, run_id: "run_1", status: "running", pid: 2, gpu_index: 1, started_at_node: "a", log: "/l/1" }
      }); },
      persistRunRecord: (rec) => persisted.push(rec),
      relaunchProgressor: async () => ({ pid: 9999 })
    }
  );
  assert.equal(reads, 1, "must read state.json exactly once (never tail)");
  const r0 = persisted.find((r) => r.run_id === "run_0");
  const r1 = persisted.find((r) => r.run_id === "run_1");
  assert.equal(r0.status, "finished");  // STATE done -> RunRecord finished
  assert.equal(r1.status, "running");
});

test("anti-pid-reuse (status sync): a running STATE job whose started_at_node MISMATCHES the held evidence is NOT marked running", async () => {
  // The held RunRecord recorded started_at_node "A" the first time we saw the job live. The node now
  // reports the same run_id still "running" but with started_at_node "B" — a node reboot recycled the
  // pid onto a DIFFERENT process. The brain must NOT keep asserting `running` (the original job is dead);
  // it downgrades to needs_reconciliation rather than silently believing a recycled pid (spec 2.5).
  const persisted = [];
  const out = await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_r", status: "running", started_at_node: "A" }] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      readState: async () => stateWith({
        "0": { seq: 0, run_id: "run_r", status: "running", pid: 7, gpu_index: 0, started_at_node: "B", log: "/l" }
      }),
      persistRunRecord: (rec) => persisted.push(rec),
      relaunchProgressor: async () => ({ pid: 1 })
    }
  );
  const r = persisted.find((x) => x.run_id === "run_r");
  // The brain must NOT persist `running` for a reused pid.
  assert.notEqual(r?.status, "running", "a started_at_node mismatch must not be persisted as running");
  assert.ok(out.needs_reconciliation.some((n) => n.run_id === "run_r"),
    "a reused-pid running job must surface as needs_reconciliation");
});

test("anti-pid-reuse (status sync): a running STATE job with NO started_at_node fails closed (needs_reconciliation)", async () => {
  // The node reports `running` but omits the started_at_node pairing evidence entirely. With no evidence
  // we cannot prove the pid is still our process, so the brain fails closed instead of asserting running.
  const persisted = [];
  const out = await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_r", status: "running", started_at_node: "A" }] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      readState: async () => stateWith({
        "0": { seq: 0, run_id: "run_r", status: "running", pid: 7, gpu_index: 0, log: "/l" }
      }),
      persistRunRecord: (rec) => persisted.push(rec),
      relaunchProgressor: async () => ({ pid: 1 })
    }
  );
  const r = persisted.find((x) => x.run_id === "run_r");
  assert.notEqual(r?.status, "running", "absent started_at_node evidence must not be asserted running");
  assert.ok(out.needs_reconciliation.some((n) => n.run_id === "run_r"));
});

test("anti-pid-reuse (status sync): a running STATE job whose started_at_node MATCHES the held evidence stays running", async () => {
  // The happy path: the node reports the same started_at_node we recorded, proving pid continuity. The
  // brain keeps it running (no spurious downgrade of a genuinely-live job).
  const persisted = [];
  const out = await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_r", status: "running", started_at_node: "A" }] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      readState: async () => stateWith({
        "0": { seq: 0, run_id: "run_r", status: "running", pid: 7, gpu_index: 0, started_at_node: "A", log: "/l" }
      }),
      persistRunRecord: (rec) => persisted.push(rec),
      relaunchProgressor: async () => ({ pid: 1 })
    }
  );
  const r = persisted.find((x) => x.run_id === "run_r");
  assert.equal(r?.status, "running", "matching started_at_node evidence proves continuity -> stays running");
  assert.equal(out.needs_reconciliation.some((n) => n.run_id === "run_r"), false);
});

test("reconcile maps placement_conflict/failed/cancelled and does NOT do laptop-vs-node clock math", async () => {
  const persisted = [];
  const out = await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_c", status: "running" }] },
    { now: new Date("1999-01-01T00:00:00Z"), // laptop clock far in the past — must be ignored
      readState: async () => stateWith({
        "0": { seq: 0, run_id: "run_c", status: "placement_conflict", gpu_index: 0, started_at_node: "z", log: "/l" }
      }),
      persistRunRecord: (rec) => persisted.push(rec),
      relaunchProgressor: async () => ({ pid: 1 }) });
  assert.equal(persisted[0].status, "unknown"); // placement_conflict surfaces as needs-reconciliation
  assert.ok(out.needs_reconciliation.some((n) => n.run_id === "run_c"));
});

test("dead progressor but live jobs: reconcile adopts live jobs then relaunches the progressor (spec 5c)", async () => {
  let restarted = false;
  const adopted = [];
  const persisted = [];
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_0", status: "running" }] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      // progressor.pid reported dead by the node-side liveness probe (deps.progressorAlive=false)
      readState: async () => stateWith(
        { "0": { seq: 0, run_id: "run_0", status: "running", pid: 12345, wrapper_pid: 12300, gpu_index: 0, started_at_node: "a", log: "/l" } },
        { pid: 5000, started_at_node: "x", heartbeat_node: "2026-06-19T00:00:00Z" }),
      progressorAlive: async () => false,
      // CP-3/D-3: when an adopt hook is supplied, each live STATE job is adopted (lineage-proven) before
      // relaunch. C's standalone test exercises the hook with a stub; D supplies the real ihpcStateJobToRunRecord.
      adoptLiveJob: (job) => { adopted.push(job.run_id); return { run_id: job.run_id, status: "running" }; },
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; },
      persistRunRecord: (rec) => persisted.push(rec)
    }
  );
  assert.equal(restarted, true, "dead progressor + live jobs must relaunch the progressor to resume refill");
  assert.deepEqual(adopted, ["run_0"], "each live STATE job must be adopted (lineage-proven) before relaunch");
  assert.ok(persisted.some((r) => r.run_id === "run_0"), "the adopted RunRecord must be persisted");
});

test("dead progressor with NO adopt hook: relaunch-only (C standalone behavior, spec 5c)", async () => {
  let restarted = false;
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_0", status: "running" }] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      readState: async () => stateWith(
        { "0": { seq: 0, run_id: "run_0", status: "running", pid: 12345, gpu_index: 0, started_at_node: "a", log: "/l" } },
        { pid: 5000, started_at_node: "x", heartbeat_node: "2026-06-19T00:00:00Z" }),
      progressorAlive: async () => false,
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; },
      persistRunRecord: () => {}
    }
  );
  assert.equal(restarted, true, "without an adopt hook, the dead-progressor branch still relaunches");
});

test("reconcile rejects a STATE that fails the protocol schema", async () => {
  await assert.rejects(
    () => reconcileIhpcCampaign(
      { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
        node: "mars01", runRecords: [] },
      { now: new Date(), readState: async () => ({ schema_version: "1.0.0", jobs: "not-an-object" }),
        persistRunRecord: () => {}, relaunchProgressor: async () => ({ pid: 1 }) }),
    /schema|invalid|state/i
  );
});
