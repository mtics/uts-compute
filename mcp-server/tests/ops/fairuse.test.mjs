import assert from "node:assert/strict";
import test from "node:test";
import { accountKey, buildCampaignLedger, fairUseVerdict } from "../../dist/ops/quotas/fairuse.js";

// --- accountKey ----------------------------------------------------------------------------------

test("accountKey is account_label@platform (per-account, per-platform)", () => {
  assert.equal(accountKey({ account_label: "ihpc-a", platform: "uts-ihpc" }), "ihpc-a@uts-ihpc");
  assert.equal(accountKey({ account_label: "hpc-b", platform: "uts-hpc" }), "hpc-b@uts-hpc");
});

// --- buildCampaignLedger -------------------------------------------------------------------------

function run(runId, profileId, campaignId, status = "running", updatedAt = "2026-06-20T00:00:00.000Z") {
  return { run_id: runId, profile_id: profileId, platform: "uts-ihpc", campaign_id: campaignId, status, updated_at: updatedAt };
}

const profilesById = {
  "uts-ihpc-account-a": { profile_id: "uts-ihpc-account-a", platform: "uts-ihpc", account_label: "ihpc-a", defaults: { owner: "owner-a", allocation: "alloc-a" } },
  "uts-ihpc-account-b": { profile_id: "uts-ihpc-account-b", platform: "uts-ihpc", account_label: "ihpc-b", defaults: { owner: "owner-b", allocation: "alloc-b" } }
};

test("buildCampaignLedger groups runs by campaign into per-owner allocations (derived, no second source)", () => {
  const runs = [
    run("r1", "uts-ihpc-account-a", "camp-x", "running"),
    run("r2", "uts-ihpc-account-a", "camp-x", "finished", "2026-06-20T01:00:00.000Z"),
    run("r3", "uts-ihpc-account-b", "camp-x", "running"),
    run("r4", "uts-ihpc-account-a", "camp-y", "running")
  ];
  const ledger = buildCampaignLedger(runs, profilesById);

  // Two campaigns surface.
  assert.equal(ledger.length, 2);
  const campX = ledger.find((entry) => entry.campaign_id === "camp-x");
  assert.ok(campX);
  // camp-x legitimately spans two DIFFERENT accounts (disclosure/attribution, not evasion).
  assert.equal(campX.allocations.length, 2);
  assert.equal(campX.run_count, 3);

  const accA = campX.allocations.find((a) => a.profile_id === "uts-ihpc-account-a");
  assert.equal(accA.account_key, "ihpc-a@uts-ihpc");
  assert.equal(accA.account_label, "ihpc-a");
  assert.equal(accA.owner, "owner-a");
  assert.equal(accA.allocation, "alloc-a");
  assert.equal(accA.run_count, 2);
  assert.deepEqual(accA.run_ids.sort(), ["r1", "r2"]);
  assert.equal(accA.status_breakdown.running, 1);
  assert.equal(accA.status_breakdown.finished, 1);
  assert.equal(accA.last_updated, "2026-06-20T01:00:00.000Z");

  const accB = campX.allocations.find((a) => a.profile_id === "uts-ihpc-account-b");
  assert.equal(accB.account_key, "ihpc-b@uts-ihpc");
  assert.equal(accB.owner, "owner-b");
  assert.equal(accB.run_count, 1);
});

test("buildCampaignLedger ignores runs with no campaign_id (adopted/external runs declare no campaign)", () => {
  const runs = [run("r1", "uts-ihpc-account-a", "camp-x"), { run_id: "r2", profile_id: "uts-ihpc-account-a", platform: "uts-ihpc", status: "running", updated_at: "2026-06-20T00:00:00.000Z" }];
  const ledger = buildCampaignLedger(runs, profilesById);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].run_count, 1);
});

// --- fairUseVerdict ------------------------------------------------------------------------------

test("fairUseVerdict flags an account over its OWN iHPC node-pool cap", () => {
  const profile = profilesById["uts-ihpc-account-a"];
  const violations = fairUseVerdict(profile, {
    nodeLimits: [{ families: ["turing"], limit: 2 }],
    activeNodes: [{ node: "turing1", family: "turing" }, { node: "turing2", family: "turing" }, { node: "turing3", family: "turing" }]
  });
  assert.ok(violations.some((v) => v.code === "node-pool-exceeded"));
});

test("fairUseVerdict flags an account over its OWN pbs per-user run cap", () => {
  const profile = { profile_id: "uts-hpc-account-a", platform: "uts-hpc", account_label: "hpc-a", defaults: {} };
  // 3 running against an own cap of 2 — this account is over its OWN cap.
  const violations = fairUseVerdict(profile, {
    pbs: { username: "alice", maxRunSpec: { perUserGeneric: 2 }, runningInQueue: 3, queue: "workq" }
  });
  assert.ok(violations.some((v) => v.code === "max-run-exceeded"));
  // At exactly the cap (2 == 2) the account is AT but not OVER its own cap — no violation.
  const atCap = fairUseVerdict(profile, {
    pbs: { username: "alice", maxRunSpec: { perUserGeneric: 2 }, runningInQueue: 2, queue: "workq" }
  });
  assert.deepEqual(atCap, []);
});

test("fairUseVerdict NEVER sums across accounts: two accounts each under their own cap -> NO violation", () => {
  // Each account holds 1 of its own 2-node pool. Summed (1+1+1+1 across pools/accounts) would look
  // large, but fairUseVerdict is called per-account against that account's OWN cap only.
  const profileA = profilesById["uts-ihpc-account-a"];
  const profileB = profilesById["uts-ihpc-account-b"];
  const vA = fairUseVerdict(profileA, { nodeLimits: [{ families: ["turing"], limit: 2 }], activeNodes: [{ node: "turing1", family: "turing" }] });
  const vB = fairUseVerdict(profileB, { nodeLimits: [{ families: ["turing"], limit: 2 }], activeNodes: [{ node: "turing1", family: "turing" }] });
  assert.deepEqual(vA, []);
  assert.deepEqual(vB, []);
  // Proof the function takes exactly ONE profile + that profile's OWN counts — it has no parameter by
  // which a caller could hand it a cross-account union, so no aggregation path exists.
  assert.equal(fairUseVerdict.length, 2);
});
