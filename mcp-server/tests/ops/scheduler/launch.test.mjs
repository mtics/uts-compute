import test from "node:test";
import assert from "node:assert/strict";
import { launchIhpcCampaign } from "../../../dist/ops/scheduler/seam/launch.js";

function basePlan(jobs) {
  return {
    schema_version: "1.0.0", schema_compat_min: "1.0.0",
    campaign_id: "campaign_x", queue_id: "sha256:abcdef",
    lease_owner: { client: "claude", device_id: "dev-1", issued_at: "2026-06-20T00:00:00Z" },
    node_id: "mars01", profile_id: "p1",
    limits: { slot_count: 2, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/home/u/proj"], env_key_allowlist: ["UTS_RUN_ID"] },
    policy: { on_job_failure: "continue",
      failure_breaker: { max_consecutive_failures: 5, require_one_success: true },
      idle_definition: "no_running_and_no_launchable_pending",
      idle_exit_seconds: 604800, restart_throttle_seconds: 2 },
    jobs
  };
}

test("launchIhpcCampaign writes PLAN atomically then starts the progressor once", async () => {
  const calls = [];
  const writes = [];
  const result = await launchIhpcCampaign(
    {
      plan: basePlan([
        { seq: 0, run_id: "run_0", command_argv: ["python3", "t.py"], workdir: "/home/u/proj",
          env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 0, gpu_count: 1, timeout_seconds: 60 },
        { seq: 1, run_id: "run_1", command_argv: ["python3", "t.py"], workdir: "/home/u/proj",
          env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 1, gpu_count: 1, timeout_seconds: 60 }
      ]),
      profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" },
        defaults: {}, node_scheduler: { runner: "console" } }
    },
    {
      now: new Date("2026-06-20T00:00:00Z"),
      sshWriteAtomicJson: async (host, node, remotePath, obj) => { calls.push({ wrote: remotePath }); writes.push({ host, node, remotePath, obj }); },
      startProgressor: async (host, node, stdin) => { calls.push({ host, node, stdin }); return { pid: 4242 }; },
      auditDir: undefined,
      persistRunRecord: (rec) => calls.push({ persisted: rec.run_id, status: rec.status, rec })
    }
  );
  // wrote exactly one plan.json under the campaign state dir (never /tmp)
  assert.equal(writes.length, 1);
  assert.match(writes[0].remotePath, /\.uts-computing\/scheduler\/state\/campaign_x\/plan\.json$/);
  assert.doesNotMatch(writes[0].remotePath, /^\/tmp/);
  // started the progressor exactly once for the node
  assert.equal(calls.filter((c) => c.stdin).length, 1);
  assert.match(calls.find((c) => c.stdin).stdin, /reconcile_slots|def main/);

  // P1 (crash-safety bracket): each run is persisted at the durable "submitting" pre-launch marker BEFORE
  // any SSH side effect (the PLAN write AND the progressor start), then advanced to "running" after.
  const markers = calls.filter((c) => c.status === "submitting");
  assert.equal(markers.length, 2, "one pre-launch marker per selected run");
  const firstWriteIdx = calls.findIndex((c) => c.wrote);
  const firstProgressorIdx = calls.findIndex((c) => c.stdin);
  const lastMarkerIdx = calls.map((c) => c.status === "submitting").lastIndexOf(true);
  assert.ok(lastMarkerIdx < firstWriteIdx, "markers are persisted BEFORE the PLAN write (first SSH side effect)");
  assert.ok(lastMarkerIdx < firstProgressorIdx, "markers are persisted BEFORE the progressor start");
  const m0 = markers.find((c) => c.persisted === "run_0").rec;
  assert.equal(m0.campaign_id, "campaign_x", "the marker carries the recoverable campaign_id");
  assert.equal(m0.placement.node_id, "mars01", "the marker records the target node for reconciliation");
  assert.equal(m0.supervisor, undefined, "the pre-launch marker has no supervisor (progressor pid unknown yet)");

  // persisted supervisor.pid + placement.gpu_index + queue_position + lease_owner on each running RunRecord
  const persisted = calls.filter((c) => c.persisted && c.status === "running");
  assert.equal(persisted.length, 2);
  const r0 = persisted.find((c) => c.persisted === "run_0").rec;
  assert.equal(r0.supervisor.pid, 4242);
  // C-6: campaign supervisor paths are slot-dir path-based, NOT empty strings
  assert.match(r0.supervisor.metadata_path, /scheduler\/state\/campaign_x\/slot_0\/result\.json$/);
  assert.match(r0.supervisor.stdout_path, /scheduler\/state\/campaign_x\/slot_0\/stdout\.log$/);
  assert.equal(r0.placement.gpu_index, 0);
  assert.equal(r0.placement.gpu_slot, 0); // CP-3: gpu_slot threaded onto placement, not dead
  assert.equal(r0.queue_position, 0);
  assert.deepEqual(r0.lease_owner, { client: "claude", device_id: "dev-1", issued_at: "2026-06-20T00:00:00Z" });
  assert.equal(result.progressor.pid, 4242);
});

// P0 (daemonize): the progressor is the FOREGROUND command of a two-hop SSH channel whose timeout is
// capped at 30s. The OLD foreground design left the resident loop AS that command, so runProcess SIGTERMs
// it at the timeout and the channel close yields {exitCode:null/code, stdout:"", timedOut:true} with NO
// pid line — and parseProgressorPid falls back to 0. A launch that records supervisor pid=0 while the
// queue silently stalls is exactly the bug. With the python-side fork/setsid fix the parent prints the
// daemon's pid promptly and the channel closes clean; the launch seam must REQUIRE a real (non-zero) pid
// and surface a failure when the start seam times out / reports no pid, instead of a silent pid-0 success.

test("startProgressor that TIMES OUT (foreground-killed) surfaces a launch failure — never a silent pid=0", async () => {
  await assert.rejects(
    launchIhpcCampaign(
      {
        plan: basePlan([
          { seq: 0, run_id: "run_0", command_argv: ["python3", "t.py"], workdir: "/home/u/proj",
            env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 0, gpu_count: 1, timeout_seconds: 60 }
        ]),
        profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" },
          defaults: {}, node_scheduler: { runner: "console" } }
      },
      {
        now: new Date("2026-06-20T00:00:00Z"),
        sshWriteAtomicJson: async () => {},
        // model the OLD foreground-killed behavior: the channel timed out, no pid line was ever printed.
        // The real runProcess resolves a timed-out child cleanly (no throw), so the launch seam itself
        // must reject when the started progressor reports no real pid — otherwise pid=0 is recorded silently.
        startProgressor: async () => ({ pid: 0 }),
        persistRunRecord: () => {}
      }
    ),
    /pid|daemon|progressor/i,
    "a timed-out / pid-less progressor start must surface a launch failure, not record supervisor pid=0"
  );
});

test("startProgressor that returns a prompt {\"pid\":N} (daemonized) records the real non-zero supervisor pid", async () => {
  const persisted = [];
  const result = await launchIhpcCampaign(
    {
      plan: basePlan([
        { seq: 0, run_id: "run_0", command_argv: ["python3", "t.py"], workdir: "/home/u/proj",
          env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 0, gpu_count: 1, timeout_seconds: 60 }
      ]),
      profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" },
        defaults: {}, node_scheduler: { runner: "console" } }
    },
    {
      now: new Date("2026-06-20T00:00:00Z"),
      sshWriteAtomicJson: async () => {},
      // the daemonizing parent prints the child's real pid and the channel closes promptly.
      startProgressor: async () => ({ pid: 31337 }),
      persistRunRecord: (rec) => persisted.push(rec)
    }
  );
  assert.equal(result.progressor.pid, 31337);
  // P1: the bracket persists the run TWICE — first the durable "submitting" pre-launch marker (no
  // supervisor yet), then the "running" record with the real daemon pid.
  const running = persisted.filter((rec) => rec.status === "running");
  const marker = persisted.filter((rec) => rec.status === "submitting");
  assert.equal(marker.length, 1, "one pre-launch marker written before the progressor start");
  assert.equal(marker[0].supervisor, undefined, "the marker carries no supervisor pid");
  assert.equal(running.length, 1);
  assert.equal(running[0].supervisor.pid, 31337, "the real daemon pid must be recorded, not 0");
});

test("single-run fast path: jobs==1 + no campaign routes to direct supervisor, NOT the progressor", async () => {
  let progressorStarted = false;
  let fastPathUsed = false;
  await launchIhpcCampaign(
    {
      plan: { ...basePlan([{ seq: 0, run_id: "run_only", command_argv: ["python3", "t.py"],
        workdir: "/home/u/proj", env: {}, gpu_index: 0, gpu_count: 1, timeout_seconds: 60 }]),
        campaign_id: null, limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 1 } },
      profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" },
        defaults: {}, node_scheduler: { runner: "console" } }
    },
    {
      now: new Date("2026-06-20T00:00:00Z"),
      sshWriteAtomicJson: async () => {},
      startProgressor: async () => { progressorStarted = true; return { pid: 1 }; },
      startSingleSupervisor: async () => { fastPathUsed = true; return { pid: 7, node_id: "mars01" }; },
      persistRunRecord: () => {}
    }
  );
  assert.equal(fastPathUsed, true, "single non-campaign run must use the SUPERVISOR_PY fast path (spec 6 D1)");
  assert.equal(progressorStarted, false, "must NOT start the resident progressor for a single run");
});
