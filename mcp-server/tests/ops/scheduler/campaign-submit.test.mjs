import assert from "node:assert/strict";
import test from "node:test";
import { campaignSubmit } from "../../../dist/ops/scheduler/campaign/submit.js";

// ---------------------------------------------------------------------------------------------------
// campaignSubmit is an ORCHESTRATION of pure primitives with exactly ONE side-effect seam (launch,
// which the tool binds to the SSH launchIhpcCampaign). These tests compose it with a MOCK launch seam
// + a MOCK store writer and assert: (1) the happy path selects -> plans -> launches -> persists, and
// (2) each in-band error path returns a structured { ok:false, reason } WITHOUT touching the seam.
// ---------------------------------------------------------------------------------------------------

const ME = { client: "claude", device_id: "dev-1", issued_at: "2026-06-21T00:00:00Z" };

// A planned iHPC run record carrying the launch fields the enrich step would resolve from the plan
// artifact. (campaignSubmit asks the injected enrichRun to turn a RunRecord into a QueueRunRecord; the
// fixture's enrichRun just attaches these.)
const plannedRun = (run_id, queue_position) => ({
  run_id,
  profile_id: "p1",
  platform: "uts-ihpc",
  campaign_id: "camp_1",
  status: "planned",
  queue_position,
  remote_job_id: null,
  created_at: "2026-06-21T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z",
  events: []
});

const LAUNCH_FIELDS = {
  command_argv: ["python3", "train.py"],
  workdir: "/home/u/proj",
  env: { UTS_RUN_ID: "$RUN_ID$" },
  timeout_seconds: 3600
};

function baseDeps(overrides = {}) {
  const persisted = [];
  const launched = [];
  return {
    persisted,
    launched,
    deps: {
      me: ME,
      node: { node_id: "mars01", gpu_indices: [0, 1], max_slots_per_gpu: 1 },
      profile: {
        profile_id: "p1",
        platform: "uts-ihpc",
        login: { host_alias: "ihpc" },
        defaults: {}
      },
      lease: { nodeNowEpoch: 1000, heartbeatEpoch: null, staleSeconds: 60, held: null },
      maxConcurrent: 2,
      slotCount: 2,
      allowedRoots: ["/home/u/proj"],
      envKeyAllowlist: ["UTS_RUN_ID"],
      nodeLimits: undefined,
      activeNodes: [],
      held: [],
      enrichRun: (rec) => ({ ...rec, ...LAUNCH_FIELDS }),
      launchPlan: async (plan, profile) => {
        launched.push({ plan, profile });
        // mirror the real seam: persist a running RunRecord per plan job, return a LaunchResult.
        for (const job of plan.jobs) {
          persisted.push({ run_id: job.run_id, status: "running", supervisor: { pid: 7777 } });
        }
        return { mode: "campaign", campaign_id: plan.campaign_id, progressor: { pid: 7777 } };
      },
      ...overrides
    }
  };
}

test("campaignSubmit composes select -> lease -> conformance -> plan -> launch (happy path)", async () => {
  const { deps, launched } = baseDeps();
  const records = [plannedRun("r0", 0), plannedRun("r1", 1)];
  const result = await campaignSubmit({ campaignId: "camp_1", records }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.launched, 2, "both planned runs were launched");
  assert.ok(result.plan_queue_id.startsWith("sha256:"), "returns the immutable plan queue_id");
  assert.deepEqual([...result.run_ids].sort(), ["r0", "r1"]);

  // the ONE side-effect seam ran exactly once, with a campaign PLAN carrying both jobs + our identity.
  assert.equal(launched.length, 1, "launch seam invoked exactly once");
  assert.equal(launched[0].plan.campaign_id, "camp_1");
  assert.equal(launched[0].plan.jobs.length, 2);
  assert.deepEqual(launched[0].plan.lease_owner, ME);
  // launch fields flowed through enrichRun into the PLAN jobs.
  assert.deepEqual(launched[0].plan.jobs[0].command_argv, ["python3", "train.py"]);
  assert.equal(launched[0].plan.jobs[0].workdir, "/home/u/proj");
});

test("campaignSubmit reports no-planned-runs without touching the launch seam", async () => {
  const { deps, launched } = baseDeps();
  const result = await campaignSubmit({ campaignId: "camp_1", records: [] }, deps);
  assert.deepEqual(result, { ok: false, reason: "no-planned-runs" });
  assert.equal(launched.length, 0, "no SSH when there is nothing to launch");
});

test("campaignSubmit reports lease-blocked when a live other holder owns the node", async () => {
  const { deps, launched } = baseDeps({
    // a LIVE other holder (fresh heartbeat, different owner) => decideLease => blocked.
    lease: {
      nodeNowEpoch: 1000,
      heartbeatEpoch: 990,
      staleSeconds: 60,
      held: { client: "codex", device_id: "dev-2", issued_at: "2026-06-21T00:00:00Z" }
    }
  });
  const records = [plannedRun("r0", 0)];
  const result = await campaignSubmit({ campaignId: "camp_1", records }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lease-blocked");
  assert.equal(launched.length, 0, "a blocked lease must not clobber the live holder's PLAN");
});

test("campaignSubmit reports conformance-failed when the node-pool cap would be exceeded", async () => {
  const { deps, launched } = baseDeps({
    // target node mars01 is in a pool capped at 1, and the account already holds venus01 in that pool.
    nodeLimits: [{ families: ["mars", "venus"], limit: 1 }],
    activeNodes: [{ node: "venus01" }]
  });
  const records = [plannedRun("r0", 0)];
  const result = await campaignSubmit({ campaignId: "camp_1", records }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "conformance-failed");
  assert.ok(typeof result.detail === "string" && result.detail.length > 0, "surfaces the violation detail");
  assert.equal(launched.length, 0, "the ban-critical gate refuses BEFORE any SSH");
});

test("campaignSubmit reports launch-failed when the SSH seam throws", async () => {
  const { deps } = baseDeps({
    launchPlan: async () => {
      throw new Error("ssh: connection refused");
    }
  });
  const records = [plannedRun("r0", 0)];
  const result = await campaignSubmit({ campaignId: "camp_1", records }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "launch-failed");
  assert.match(result.detail ?? "", /connection refused/);
});
