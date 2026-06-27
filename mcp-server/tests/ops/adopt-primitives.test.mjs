import assert from "node:assert/strict";
import test from "node:test";
import { pbsRowToRunRecord, ihpcPidToRunRecord, ihpcStateJobToRunRecord } from "../../dist/ops/jobs/adopt.js";
import { assertRunRecord } from "../../dist/core/validation.js";

const QSTAT_RUNNING = `Job Id: 4321.cetus
    Job_Name = hpo-trial-7
    job_state = R
    queue = workq
    exec_host = node07/0*4
    resources_used.walltime = 01:00:00
    resources_used.ncpus = 4
    resources_used.cpupercent = 380
    Resource_List.ncpus = 4
`;

const now = new Date("2026-06-20T10:00:00.000Z");

test("pbsRowToRunRecord synthesizes a valid running RunRecord from qstat text", () => {
  const rec = pbsRowToRunRecord(QSTAT_RUNNING, {
    runId: "adopt-4321-cetus",
    profileId: "uts-hpc-account-a",
    platform: "uts-hpc",
    remoteJobId: "4321.cetus",
    now
  });
  assert.equal(rec.run_id, "adopt-4321-cetus");
  assert.equal(rec.platform, "uts-hpc");
  assert.equal(rec.remote_job_id, "4321.cetus");
  assert.equal(rec.status, "running");
  assert.equal(rec.rev, 0);
  assert.equal(rec.created_at, now.toISOString());
  assert.equal(rec.usage?.ncpus, 4);
  assert.ok(rec.usage?.core_hours > 0);
  assert.equal(rec.submission?.node, "node07");
  assert.equal(rec.events[0].kind, "adopted-external");
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("pbsRowToRunRecord fills submission.requested from Resource_List (Track 2.5)", () => {
  const rec = pbsRowToRunRecord(`Job Id: 8800.cetus
    job_state = R
    exec_host = node09/0*8
    Resource_List.ncpus = 8
    Resource_List.mem = 32gb
    Resource_List.walltime = 12:00:00
    Resource_List.ngpus = 1
    resources_used.walltime = 01:00:00
    resources_used.ncpus = 8
`, { runId: "adopt-8800", profileId: "uts-hpc-account-a", platform: "uts-hpc", remoteJobId: "8800.cetus", now });
  assert.deepEqual(rec.submission?.requested, { ncpus: 8, memory_gb: 32, walltime: "12:00:00", ngpus: 1 });
  assert.equal(rec.submission?.node, "node09");
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("pbsRowToRunRecord gives a QUEUED adopted job a submission carrying requested but no node", () => {
  const rec = pbsRowToRunRecord(`Job Id: 8801.cetus
    job_state = Q
    Resource_List.ncpus = 4
    Resource_List.mem = 16gb
    Resource_List.walltime = 04:00:00
`, { runId: "adopt-8801", profileId: "uts-hpc-account-a", platform: "uts-hpc", remoteJobId: "8801.cetus", now });
  assert.deepEqual(rec.submission?.requested, { ncpus: 4, memory_gb: 16, walltime: "04:00:00" });
  assert.equal(rec.submission?.node, undefined);
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("pbsRowToRunRecord tolerates queued jobs (no exec_host / no usage)", () => {
  const rec = pbsRowToRunRecord("Job Id: 99.cetus\n    job_state = Q\n", {
    runId: "adopt-99-cetus",
    profileId: "uts-hpc-account-a",
    platform: "uts-hpc",
    remoteJobId: "99.cetus",
    now
  });
  assert.equal(rec.status, "submitted"); // Q maps to submitted
  assert.equal(rec.usage, undefined);
  assert.equal(rec.submission?.node, undefined);
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("ihpcPidToRunRecord synthesizes a history-only iHPC record with the canonical remote_job_id", () => {
  const rec = ihpcPidToRunRecord({
    runId: "adopt-venus01-31245",
    profileId: "uts-ihpc-account-a",
    node: "venus01",
    pid: 31245,
    now
  });
  assert.equal(rec.platform, "uts-ihpc");
  // remote_job_id MUST match the format requireIhpcSupervisor expects (jobs.ts:1036) so the id is
  // well-formed even though Phase 1 leaves the run history-only (no supervisor block).
  assert.equal(rec.remote_job_id, "ihpc-adopt-venus01-31245-31245");
  assert.equal(rec.status, "running");
  assert.equal(rec.submission?.node, "venus01");
  assert.equal(rec.supervisor, undefined); // history-only in Phase 1 — see Task 4 scoping note
  assert.equal(rec.events[0].kind, "adopted-external");
  assert.equal(rec.placement, undefined); // no placement supplied -> field absent
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("ihpcPidToRunRecord carries scheduler-reported placement (H8 observability)", () => {
  const rec = ihpcPidToRunRecord({
    runId: "adopt-venus01-31245",
    profileId: "uts-ihpc-account-a",
    node: "venus01",
    pid: 31245,
    now,
    placement: { gpu_index: 1, hostname: "venus01" }
  });
  // node_id defaults to node when absent; no default started_at/placement_hash is injected.
  assert.deepEqual(rec.placement, { gpu_index: 1, hostname: "venus01", node_id: "venus01" });
  assert.doesNotThrow(() => assertRunRecord(rec)); // schema must accept the placement object
});

// --- Phase D (Feature B, spec §5): two-axis adoption provenance block on the RunRecord. ---

test("a RunRecord carrying a two-axis adoption block validates against the schema", () => {
  const rec = {
    run_id: "run-abc123",
    profile_id: "utsihpc_user_01",
    platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-12345",
    status: "running",
    created_at: "2026-06-20T10:00:00.000Z",
    updated_at: "2026-06-20T10:00:00.000Z",
    adoption: {
      terminal_record: "agent_authored",
      intent: "user_declared",
      lineage: "lineage_proven",
      queue_id: "sha256:deadbeef",
      adopted_at: "2026-06-20T10:00:00.000Z"
    },
    events: [{ at: "2026-06-20T10:00:00.000Z", kind: "adopted-lineage", summary: "x" }]
  };
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("the schema rejects an unknown adoption.lineage value", () => {
  const rec = {
    run_id: "run-bad", profile_id: "p", platform: "uts-ihpc", status: "running",
    created_at: "2026-06-20T10:00:00.000Z", updated_at: "2026-06-20T10:00:00.000Z",
    adoption: { terminal_record: "agent_authored", intent: "user_declared", lineage: "totally_invalid", adopted_at: "2026-06-20T10:00:00.000Z" },
    events: []
  };
  assert.throws(() => assertRunRecord(rec), /Invalid run record/);
});

const NODE_CLOCK = "2026-06-20T14:32:15.000Z";

test("ihpcStateJobToRunRecord builds a lineage-proven RunRecord with a real supervisor block", () => {
  const rec = ihpcStateJobToRunRecord({
    runId: "run-abc123",
    profileId: "utsihpc_user_01",
    node: "mars01",
    queueId: "sha256:deadbeef",
    accountLabel: "utsihpc_user_01",
    cluster: "ihpc.example",
    now: new Date("2026-06-20T14:45:30.000Z"),
    // supervisorPid = the slot's long-lived wrapper pid (CP-3), NOT the dead progressor pid.
    supervisorPid: 54321,
    job: {
      seq: 0, run_id: "run-abc123", status: "running", pid: 12345, wrapper_pid: 54321, gpu_index: 0,
      started_at_node: NODE_CLOCK, log: "/home/user/project/.uts/slot_0/stdout.log"
    },
    supervisorPaths: {
      metadata_path: "/home/user/project/.uts/slot_0/result.json",
      stdout_path: "/home/user/project/.uts/slot_0/stdout.log",
      stderr_path: "/home/user/project/.uts/slot_0/stdout.log"
    }
  });
  assert.equal(rec.platform, "uts-ihpc");
  // remote_job_id must match the ihpc-<run_id>-<pid> shape requireIhpcSupervisor expects.
  assert.equal(rec.remote_job_id, "ihpc-run-abc123-54321");
  assert.equal(rec.supervisor.pid, 54321);
  assert.equal(rec.supervisor.node_id, "mars01");
  assert.equal(rec.status, "running");
  assert.equal(rec.adoption.terminal_record, "agent_authored");
  assert.equal(rec.adoption.intent, "user_declared");
  assert.equal(rec.adoption.lineage, "lineage_proven");
  assert.equal(rec.adoption.queue_id, "sha256:deadbeef");
  assert.equal(rec.placement.gpu_index, 0);
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("ihpcStateJobToRunRecord maps node status 'done' to finished and carries exit_code event", () => {
  const rec = ihpcStateJobToRunRecord({
    runId: "run-def456", profileId: "p", node: "mars01", queueId: "sha256:q",
    now: new Date("2026-06-20T15:00:00.000Z"), supervisorPid: 60000,
    job: { seq: 1, run_id: "run-def456", status: "done", pid: 59000, wrapper_pid: 60000, gpu_index: 1, exit_code: 0,
           started_at_node: NODE_CLOCK, finished_at_node: "2026-06-20T14:55:00.000Z", log: "/r/slot_1/stdout.log" },
    supervisorPaths: { metadata_path: "/r/slot_1/result.json", stdout_path: "/r/slot_1/stdout.log", stderr_path: "/r/slot_1/stdout.log" }
  });
  assert.equal(rec.status, "finished");
  assert.equal(rec.adoption.terminal_record, "agent_authored");
});

test("ihpcStateJobToRunRecord maps placement_conflict to unknown (deferred, not failed)", () => {
  const rec = ihpcStateJobToRunRecord({
    runId: "run-c", profileId: "p", node: "mars01", queueId: "sha256:q",
    now: new Date("2026-06-20T15:00:00.000Z"), supervisorPid: 70000,
    job: { seq: 2, run_id: "run-c", status: "placement_conflict", pid: 69000, wrapper_pid: 70000, gpu_index: 0,
           started_at_node: NODE_CLOCK, log: "/r/slot_2/stdout.log" },
    supervisorPaths: { metadata_path: "/r/slot_2/result.json", stdout_path: "/r/slot_2/stdout.log", stderr_path: "/r/slot_2/stdout.log" }
  });
  assert.equal(rec.status, "unknown");
});

// --- Phase B/C seam: a campaign RunRecord shaped like seam/launch.ts persists it (queue_position +
// lease_owner) MUST validate. Before fix A the run-record schema had top-level additionalProperties:false
// but no lease_owner/queue_position/auto_progressed/attempt/queue_id, so writeRunRecord/assertRunRecord
// THREW the moment a campaign run flowed through. This is the regression guard. ---
test("a campaign RunRecord shaped like seam/launch.ts persists it validates against the schema", () => {
  // Mirror buildRunRecord() in seam/launch.ts: a campaign run carries queue_position + lease_owner + a
  // path-based supervisor block, alongside the campaign_id/queue_id lineage anchors.
  const rec = {
    run_id: "run-seq0",
    profile_id: "utsihpc_user_01",
    platform: "uts-ihpc",
    remote_job_id: "ihpc-run-seq0-44000",
    campaign_id: "campaign_x",
    queue_id: "sha256:deadbeef",
    status: "running",
    queue_position: 0,
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" },
    supervisor: {
      pid: 44000, node_id: "mars01",
      metadata_path: "~/.uts-computing/scheduler/state/campaign_x/slot_0/result.json",
      stdout_path: "~/.uts-computing/scheduler/state/campaign_x/slot_0/stdout.log",
      stderr_path: "~/.uts-computing/scheduler/state/campaign_x/slot_0/stdout.log",
      started_at: "2026-06-20T14:32:11.000Z"
    },
    created_at: "2026-06-20T14:32:11.000Z",
    updated_at: "2026-06-20T14:32:11.000Z",
    events: [{ at: "2026-06-20T14:32:11.000Z", kind: "ihpc-progressor-launch", summary: "Queued run run-seq0 (seq 0)" }]
  };
  assert.doesNotThrow(() => assertRunRecord(rec), "a launch.ts-shaped campaign record must validate");
});

test("the run-record schema accepts all five Phase B/C campaign fields (auto_progressed + attempt too)", () => {
  const base = {
    run_id: "run-seq1", profile_id: "p", platform: "uts-ihpc", status: "running",
    created_at: "2026-06-20T14:32:11.000Z", updated_at: "2026-06-20T14:32:11.000Z", events: []
  };
  // Each field, individually, must be accepted by the (top-level additionalProperties:false) schema.
  assert.doesNotThrow(() => assertRunRecord({ ...base, lease_owner: { client: "codex", device_id: "box-1" } }));
  assert.doesNotThrow(() => assertRunRecord({ ...base, lease_owner: { client: "claude", device_id: "box-1", issued_at: "2026-06-20T14:32:10Z" } }));
  assert.doesNotThrow(() => assertRunRecord({ ...base, queue_position: 3 }));
  assert.doesNotThrow(() => assertRunRecord({ ...base, auto_progressed: { by_node_agent: true } }));
  assert.doesNotThrow(() => assertRunRecord({ ...base, auto_progressed: { by_node_agent: true, freed_by_run_id: "run-seq0" } }));
  assert.doesNotThrow(() => assertRunRecord({ ...base, attempt: 2 }));
  assert.doesNotThrow(() => assertRunRecord({ ...base, queue_id: "sha256:deadbeef" }));
});

// The FULL campaign record buildRunRecord() in seam/launch.ts actually persists carries a populated
// placement block — placement.gpu_slot (Phase B) is the field the schema missed. Before this fix the
// schema had additionalProperties:false on `placement` but no gpu_slot property, so assertRunRecord
// THREW ("/placement must NOT have additional properties") the moment a campaign run was persisted.
// This is the regression guard for the last drift point: the full launch.ts-shaped record must validate.
test("the FULL campaign RunRecord (placement.gpu_slot + attempt + auto_progressed) round-trips through the schema", () => {
  // Mirror buildRunRecord() in seam/launch.ts exactly: placement = { hostname, node_id, gpu_index,
  // gpu_slot, slots_per_gpu, started_at }; plus the queue/lease/auto-progression attribution.
  const rec = {
    run_id: "run-seq0",
    profile_id: "utsihpc_user_01",
    platform: "uts-ihpc",
    remote_job_id: "ihpc-run-seq0-44000",
    campaign_id: "campaign_x",
    queue_id: "sha256:deadbeef",
    status: "running",
    queue_position: 0,
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" },
    attempt: 0,
    auto_progressed: { by_node_agent: true, freed_by_run_id: "run-prev" },
    supervisor: {
      pid: 44000, node_id: "mars01",
      metadata_path: "~/.uts-computing/scheduler/state/campaign_x/slot_0/result.json",
      stdout_path: "~/.uts-computing/scheduler/state/campaign_x/slot_0/stdout.log",
      stderr_path: "~/.uts-computing/scheduler/state/campaign_x/slot_0/stdout.log",
      started_at: "2026-06-20T14:32:11.000Z"
    },
    placement: {
      hostname: "mars01", node_id: "mars01", gpu_index: 1, gpu_slot: 1,
      slots_per_gpu: 2, started_at: "2026-06-20T14:32:11.000Z"
    },
    created_at: "2026-06-20T14:32:11.000Z",
    updated_at: "2026-06-20T14:32:11.000Z",
    events: [{ at: "2026-06-20T14:32:11.000Z", kind: "ihpc-progressor-launch", summary: "Queued run run-seq0 (seq 0) under campaign campaign_x" }]
  };
  assert.doesNotThrow(() => assertRunRecord(rec), "the full launch.ts-shaped campaign record (with placement.gpu_slot) must validate");
});

test("the run-record schema rejects a genuinely-unknown key inside placement (additionalProperties:false stays)", () => {
  const rec = {
    run_id: "run-z", profile_id: "p", platform: "uts-ihpc", status: "running",
    created_at: "2026-06-20T14:32:11.000Z", updated_at: "2026-06-20T14:32:11.000Z", events: [],
    placement: { hostname: "mars01", gpu_index: 0, totally_unknown_placement_field: "nope" }
  };
  assert.throws(() => assertRunRecord(rec), /Invalid run record/);
});

test("the run-record schema still rejects a genuinely-unknown top-level key", () => {
  const rec = {
    run_id: "run-x", profile_id: "p", platform: "uts-ihpc", status: "running",
    created_at: "2026-06-20T14:32:11.000Z", updated_at: "2026-06-20T14:32:11.000Z", events: [],
    totally_unknown_field: "nope"
  };
  assert.throws(() => assertRunRecord(rec), /Invalid run record/);
});

test("the run-record schema rejects an unknown key inside lease_owner / auto_progressed (additionalProperties:false)", () => {
  const base = {
    run_id: "run-y", profile_id: "p", platform: "uts-ihpc", status: "running",
    created_at: "2026-06-20T14:32:11.000Z", updated_at: "2026-06-20T14:32:11.000Z", events: []
  };
  assert.throws(() => assertRunRecord({ ...base, lease_owner: { client: "claude", device_id: "d", secret: "x" } }), /Invalid run record/);
  assert.throws(() => assertRunRecord({ ...base, auto_progressed: { by_node_agent: true, bogus: 1 } }), /Invalid run record/);
});
