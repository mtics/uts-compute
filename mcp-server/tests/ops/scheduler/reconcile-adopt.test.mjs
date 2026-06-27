import assert from "node:assert/strict";
import test from "node:test";
import { reconcileIhpcCampaign } from "../../../dist/ops/scheduler/seam/reconcile.js";
import { makeLineageAdoptHook } from "../../../dist/ops/jobs/adopt.js";
import { readRunRecord, readRunRecordSafe, writeRunRecord } from "../../../dist/core/audit.js";
import { tempRuntimeDir } from "../../helpers/index.mjs";

// Mirror the jobs.ts adapter's persistRunRecord: merge a (possibly partial) update into the held record
// before writing, so the status-sync loop's {run_id,status} partials and the adopt hook's full records
// both round-trip through the schema-validated audit path.
function mergingPersist(auditDir) {
  return (rec) => {
    const existing = readRunRecordSafe(rec.run_id, auditDir);
    writeRunRecord({ ...(existing ?? {}), ...rec }, auditDir);
  };
}

// A STATE whose progressor.pid (44000) is DEAD (progressorAlive stub returns false) but jobs[0] is still
// running. pid=12345 is the inner job; wrapper_pid=54321 is the slot's long-lived wrapper (supervisor of
// record, CP-3) — it outlives the dead progressor, so it (not progressor.pid) must become supervisor.pid.
function deadProgressorState() {
  return {
    schema_version: "1.0.0",
    campaign_id: "campaign_x",
    queue_id: "sha256:deadbeef",
    lease_owner: { client: "claude", device_id: "laptop-7f3a" },
    observed_at_node: "2026-06-20T14:45:30Z",
    node_clock_epoch: 1781966730,
    slot_count: 1,
    // progressor.pid (44000) is the DEAD progressor — it must NOT become the supervisor pid (CP-3).
    progressor: { pid: 44000, started_at_node: "2026-06-20T14:32:11Z", heartbeat_node: "2026-06-20T14:32:30Z" },
    health: { degraded: null, breaker_tripped: false },
    jobs: {
      "0": { seq: 0, run_id: "run-abc123", status: "running", pid: 12345, wrapper_pid: 54321, gpu_index: 0,
             started_at_node: "2026-06-20T14:32:15Z", log: "/home/u/proj/.uts/slot_0/stdout.log" }
    },
    counts: { pending: 0, running: 1, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  };
}

const profile = { profile_id: "uts-ihpc-account-a", platform: "uts-ihpc", login: { host_alias: "ihpc" } };

test("reconcile: dead progressor + live job adopts lineage-proven (wrapper_pid, CP-3) and requests relaunch", async () => {
  const auditDir = tempRuntimeDir("reconcile-deadprog");
  // The plugin holds the RunRecord (lineage anchor): same campaign_id, found by run_id.
  const at = "2026-06-20T14:32:11.000Z";
  writeRunRecord({
    run_id: "run-abc123", profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    campaign_id: "campaign_x",
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    events: [{ at, kind: "launched", summary: "x" }]
  }, auditDir);

  let restarted = false;
  const out = await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "uts-ihpc-account-a", profile, node: "mars01",
      runRecords: [{ run_id: "run-abc123", status: "running" }] },
    {
      now: new Date("2026-06-20T14:45:30.000Z"),
      auditDir,
      readState: async () => deadProgressorState(),
      progressorAlive: async () => false,    // dead progressor
      // D supplies the real lineage-proving adopt hook (Task 5); reconcile persists what it returns.
      adoptLiveJob: makeLineageAdoptHook({ auditDir }),
      persistRunRecord: mergingPersist(auditDir),
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; }
    }
  );

  // The live job is adopted lineage-proven (real supervisor block synthesized via ihpcStateJobToRunRecord).
  const onDisk = readRunRecord("run-abc123", auditDir);
  assert.equal(onDisk.adoption.lineage, "lineage_proven");
  assert.equal(onDisk.adoption.terminal_record, "agent_authored");
  assert.equal(onDisk.adoption.intent, "user_declared");
  assert.equal(onDisk.adoption.queue_id, "sha256:deadbeef");
  // supervisor.pid comes from the slot wrapper_pid (54321), NOT the dead progressor.pid (44000) — CP-3.
  assert.equal(onDisk.supervisor.pid, 54321);
  assert.notEqual(onDisk.supervisor.pid, 44000);
  // supervisor paths derive from the slot dir of job.log (full realpath gate applied).
  assert.equal(onDisk.supervisor.stdout_path, "/home/u/proj/.uts/slot_0/stdout.log");
  assert.equal(onDisk.supervisor.metadata_path, "/home/u/proj/.uts/slot_0/result.json");
  // And a relaunch was requested so refill resumes from on-disk markers (spec §2.6).
  assert.equal(restarted, true);
  assert.equal(out.progressor_restarted, true);
});

test("reconcile: a held record whose lease_owner MISMATCHES the STATE lease_owner is NOT adopted lineage-proven", async () => {
  const auditDir = tempRuntimeDir("reconcile-lease-mismatch");
  const at = "2026-06-20T14:32:11.000Z";
  // The held RunRecord HAS a lease_owner, but it belongs to a DIFFERENT writer than the STATE reports
  // (STATE lease_owner is claude/laptop-7f3a; held is codex/other-box). Even though campaign_id matches,
  // the lease_owner check must fail the proof so reconcile falls to the §5b history-only path.
  writeRunRecord({
    run_id: "run-abc123", profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    campaign_id: "campaign_x",
    lease_owner: { client: "codex", device_id: "other-box", issued_at: at },
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    events: [{ at, kind: "launched", summary: "x" }]
  }, auditDir);

  let restarted = false;
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "uts-ihpc-account-a", profile, node: "mars01",
      runRecords: [{ run_id: "run-abc123", status: "running" }] },
    {
      now: new Date("2026-06-20T14:45:30.000Z"),
      auditDir,
      readState: async () => deadProgressorState(),
      progressorAlive: async () => false,
      adoptLiveJob: makeLineageAdoptHook({ auditDir }),
      persistRunRecord: mergingPersist(auditDir),
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; }
    }
  );

  // The job was NOT adopted as lineage_proven: the held record kept its original (non-adopted) shape,
  // i.e. no adoption block was written over it. Relaunch still fires to resume the campaign.
  const onDisk = readRunRecord("run-abc123", auditDir);
  assert.equal(onDisk.adoption, undefined, "a lease_owner mismatch must NOT be laundered into lineage_proven");
  assert.equal(restarted, true);
});

test("reconcile: a held record whose lease_owner MATCHES the STATE lease_owner IS adopted lineage-proven", async () => {
  const auditDir = tempRuntimeDir("reconcile-lease-match");
  const at = "2026-06-20T14:32:11.000Z";
  // Held lease_owner matches the STATE lease_owner (claude/laptop-7f3a) -> the stronger check passes and
  // the job is adopted lineage-proven exactly as the campaign_id-only path did.
  writeRunRecord({
    run_id: "run-abc123", profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    campaign_id: "campaign_x",
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: at },
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    events: [{ at, kind: "launched", summary: "x" }]
  }, auditDir);

  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "uts-ihpc-account-a", profile, node: "mars01",
      runRecords: [{ run_id: "run-abc123", status: "running" }] },
    {
      now: new Date("2026-06-20T14:45:30.000Z"),
      auditDir,
      readState: async () => deadProgressorState(),
      progressorAlive: async () => false,
      adoptLiveJob: makeLineageAdoptHook({ auditDir }),
      persistRunRecord: mergingPersist(auditDir),
      relaunchProgressor: async () => ({ pid: 9999 })
    }
  );

  const onDisk = readRunRecord("run-abc123", auditDir);
  assert.equal(onDisk.adoption.lineage, "lineage_proven");
  assert.equal(onDisk.supervisor.pid, 54321);
});

test("reconcile: a held record whose recorded started_at_node MISMATCHES the STATE job is NOT adopted lineage-proven (pid reuse)", async () => {
  const auditDir = tempRuntimeDir("reconcile-startedat-mismatch");
  const at = "2026-06-20T14:32:11.000Z";
  // The held record recorded the job's original launch evidence in supervisor.started_at ("2026-06-20T14:32:15Z").
  // The STATE now reports the SAME run still running but with a DIFFERENT started_at_node — a node reboot
  // recycled the pid onto a foreign process. Even though campaign_id + lease_owner match, the started_at_node
  // disagreement must FAIL the proof so reconcile never launders a reused pid into lineage_proven.
  writeRunRecord({
    run_id: "run-abc123", profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    campaign_id: "campaign_x",
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: at },
    supervisor: { pid: 54321, node_id: "mars01", metadata_path: "/m", stdout_path: "/o", stderr_path: "/o",
                  started_at: "2026-06-20T01:02:03Z" }, // recorded evidence that the STATE will NOT match (STATE job = 14:32:15Z)
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    events: [{ at, kind: "launched", summary: "x" }]
  }, auditDir);

  let restarted = false;
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "uts-ihpc-account-a", profile, node: "mars01",
      runRecords: [{ run_id: "run-abc123", status: "running" }] },
    {
      now: new Date("2026-06-20T14:45:30.000Z"),
      auditDir,
      readState: async () => deadProgressorState(), // job started_at_node = "2026-06-20T14:32:15Z"
      progressorAlive: async () => false,
      adoptLiveJob: makeLineageAdoptHook({ auditDir }),
      persistRunRecord: mergingPersist(auditDir),
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; }
    }
  );

  const onDisk = readRunRecord("run-abc123", auditDir);
  assert.notEqual(onDisk.adoption?.lineage, "lineage_proven",
    "a started_at_node mismatch (recycled pid) must NOT be laundered into lineage_proven");
  assert.equal(restarted, true);
});

test("reconcile: an adopted lineage-proven record persists the node started_at_node as durable evidence", async () => {
  const auditDir = tempRuntimeDir("reconcile-startedat-persist");
  const at = "2026-06-20T14:32:11.000Z";
  // First adopt: the held record has no recorded started_at yet. After adoption the supervisor block must
  // carry the STATE job's started_at_node so a LATER reconcile can compare against it (anti-pid-reuse).
  writeRunRecord({
    run_id: "run-abc123", profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    campaign_id: "campaign_x",
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: at },
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    events: [{ at, kind: "launched", summary: "x" }]
  }, auditDir);

  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "uts-ihpc-account-a", profile, node: "mars01",
      runRecords: [{ run_id: "run-abc123", status: "running" }] },
    {
      now: new Date("2026-06-20T14:45:30.000Z"),
      auditDir,
      readState: async () => deadProgressorState(),
      progressorAlive: async () => false,
      adoptLiveJob: makeLineageAdoptHook({ auditDir }),
      persistRunRecord: mergingPersist(auditDir),
      relaunchProgressor: async () => ({ pid: 9999 })
    }
  );

  const onDisk = readRunRecord("run-abc123", auditDir);
  assert.equal(onDisk.adoption.lineage, "lineage_proven");
  // The node's started_at_node is now durable on the supervisor block as anti-pid-reuse evidence.
  assert.equal(onDisk.supervisor.started_at, "2026-06-20T14:32:15Z",
    "the adopted record must persist the node started_at_node so a future reconcile can verify pid continuity");
});

test("reconcile: a live job with NO held RunRecord (foreign) is NOT adopted lineage-proven", async () => {
  const auditDir = tempRuntimeDir("reconcile-foreign");
  // No RunRecord on disk for run-foreign => the lineage proof fails, the hook returns null, and the
  // dead-progressor branch leaves it to the §5b history-only path (it is never written as lineage_proven).
  const state = deadProgressorState();
  state.jobs = {
    "0": { seq: 0, run_id: "run-foreign", status: "running", pid: 12345, wrapper_pid: 54321, gpu_index: 0,
           started_at_node: "2026-06-20T14:32:15Z", log: "/home/u/proj/.uts/slot_0/stdout.log" }
  };

  let restarted = false;
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "uts-ihpc-account-a", profile, node: "mars01",
      runRecords: [] },
    {
      now: new Date("2026-06-20T14:45:30.000Z"),
      auditDir,
      readState: async () => state,
      progressorAlive: async () => false,
      adoptLiveJob: makeLineageAdoptHook({ auditDir }),
      persistRunRecord: mergingPersist(auditDir),
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; }
    }
  );

  // Foreign job was NOT adopted (no record on disk), but relaunch still fires to resume the campaign.
  assert.throws(() => readRunRecord("run-foreign", auditDir));
  assert.equal(restarted, true);
});
