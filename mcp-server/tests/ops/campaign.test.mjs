import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { campaignStatus, campaignAudit } from "../../dist/ops/quotas/campaign.js";
import { tempRuntimeDir, runtimeRoot, writeProfileConfig } from "../helpers/index.mjs";

// Seed a minimal schema-valid run record into the audit dir. campaign_id is organizational metadata
// that lives ONLY on the run record (DISCLOSURE, not a cap input); fairUseBasis (when given) is an
// optional operator attestation recorded as a `fair-use-basis` event on the record — no second store.
function writeRecord(
  auditDir,
  runId,
  { campaign, profile, platform, status = "running", updatedAt = "2026-06-20T00:00:00.000Z", fairUseBasis }
) {
  const events = [{ at: "2026-06-20T00:00:00.000Z", kind: "dry-run-plan", summary: "seed" }];
  if (fairUseBasis) {
    events.push({ at: "2026-06-20T00:00:00.000Z", kind: "fair-use-basis", summary: fairUseBasis });
  }
  const record = {
    run_id: runId,
    profile_id: profile,
    platform,
    remote_job_id: `${runId}.host`,
    ...(campaign ? { campaign_id: campaign } : {}),
    status,
    created_at: "2026-06-20T00:00:00.000Z",
    updated_at: updatedAt,
    events
  };
  fs.writeFileSync(path.join(auditDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

// Two collaborators, one iHPC account each — the policy-permitted multi-allocation shape. Real ids
// never appear; owner/allocation are placeholder attribution labels.
const PROFILES = [
  {
    profile_id: "uts-ihpc-account-a",
    platform: "uts-ihpc",
    account_label: "ihpc-a",
    login: { host_alias: "ihpc-a", username_ref: "UTS_IHPC_A_USER", requires_vpn: true },
    defaults: { node_family: "turing", node_limits: [{ families: ["turing"], limit: 2 }], owner: "owner-a", allocation: "alloc-a" }
  },
  {
    profile_id: "uts-ihpc-account-b",
    platform: "uts-ihpc",
    account_label: "ihpc-b",
    login: { host_alias: "ihpc-b", username_ref: "UTS_IHPC_B_USER", requires_vpn: true },
    defaults: { node_family: "turing", node_limits: [{ families: ["turing"], limit: 2 }], owner: "owner-b", allocation: "alloc-b" }
  }
];

// An iHPC snapshot for a profile, holding the given active nodes. quotaDir is overridable so each
// test composes the audit against THAT account's own snapshot — never a cross-account union.
function writeSnapshot(quotaDir, snapshotId, profileId, activeNodes, observedAt = "2026-06-20T00:00:00.000Z") {
  fs.mkdirSync(quotaDir, { recursive: true });
  const snapshot = {
    snapshot_id: snapshotId,
    profile_id: profileId,
    platform: "uts-ihpc",
    observed_at: observedAt,
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      identity: { remote_user_observed: true },
      node_families: { available_families: ["turing"], all_families: ["turing"] },
      sessions: { active_nodes: activeNodes },
      running_work: { active_session_count: activeNodes.length },
      storage: { filesystems: [] }
    },
    commands: [],
    warnings: []
  };
  fs.writeFileSync(path.join(quotaDir, `${snapshotId}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

test("campaignStatus discloses per-owner allocations for a campaign (derived rollup, no second store)", () => {
  const auditDir = tempRuntimeDir("campaign-status");
  const configPath = writeProfileConfig("campaign-status", PROFILES);
  // camp-x legitimately spans two DIFFERENT owners' allocations (disclosure, not evasion).
  writeRecord(auditDir, "x-a1", { campaign: "camp-x", profile: "uts-ihpc-account-a", platform: "uts-ihpc", status: "running" });
  writeRecord(auditDir, "x-a2", { campaign: "camp-x", profile: "uts-ihpc-account-a", platform: "uts-ihpc", status: "finished", updatedAt: "2026-06-20T02:00:00.000Z" });
  writeRecord(auditDir, "x-b1", { campaign: "camp-x", profile: "uts-ihpc-account-b", platform: "uts-ihpc", status: "running" });
  // A different campaign and an uncampaigned run must NOT bleed into camp-x.
  writeRecord(auditDir, "y-a1", { campaign: "camp-y", profile: "uts-ihpc-account-a", platform: "uts-ihpc", status: "running" });
  writeRecord(auditDir, "plain-1", { profile: "uts-ihpc-account-a", platform: "uts-ihpc", status: "running" });

  const { campaign } = campaignStatus({ campaignId: "camp-x", auditDir, configPath });
  assert.equal(campaign.campaign_id, "camp-x");
  assert.equal(campaign.run_count, 3);
  assert.equal(campaign.allocations.length, 2);

  const accA = campaign.allocations.find((a) => a.profile_id === "uts-ihpc-account-a");
  assert.equal(accA.account_key, "ihpc-a@uts-ihpc");
  assert.equal(accA.owner, "owner-a");
  assert.equal(accA.allocation, "alloc-a");
  assert.equal(accA.run_count, 2);
  assert.deepEqual(accA.run_ids.sort(), ["x-a1", "x-a2"]);
  assert.equal(accA.last_updated, "2026-06-20T02:00:00.000Z");

  const accB = campaign.allocations.find((a) => a.profile_id === "uts-ihpc-account-b");
  assert.equal(accB.owner, "owner-b");
  assert.equal(accB.run_count, 1);

  // status never carries audit findings — it only discloses attribution.
  assert.equal(Object.hasOwn(campaign, "findings"), false);
});

test("campaignStatus returns an empty campaign when nothing matches", () => {
  const auditDir = tempRuntimeDir("campaign-empty");
  const configPath = writeProfileConfig("campaign-empty", PROFILES);
  const { campaign } = campaignStatus({ campaignId: "no-such-campaign", auditDir, configPath });
  assert.equal(campaign.campaign_id, "no-such-campaign");
  assert.equal(campaign.run_count, 0);
  assert.deepEqual(campaign.allocations, []);
});

test("campaignAudit FLAGS an account over its OWN cap and CLEARS one within its own cap", () => {
  const auditDir = tempRuntimeDir("campaign-audit");
  const quotaDir = path.join(tempRuntimeDir("campaign-audit-q"), "quotas");
  const configPath = writeProfileConfig("campaign-audit", PROFILES);
  writeRecord(auditDir, "x-a1", { campaign: "camp-x", profile: "uts-ihpc-account-a", platform: "uts-ihpc", status: "running" });
  writeRecord(auditDir, "x-b1", { campaign: "camp-x", profile: "uts-ihpc-account-b", platform: "uts-ihpc", status: "running" });

  // Account A holds THREE turing nodes against its OWN cap of 2 → over its own cap (ban-trigger shape).
  writeSnapshot(quotaDir, "snap-a", "uts-ihpc-account-a", [
    { node: "turing1", family: "turing" },
    { node: "turing2", family: "turing" },
    { node: "turing3", family: "turing" }
  ]);
  // Account B holds ONE node against its own cap of 2 → within its own cap.
  writeSnapshot(quotaDir, "snap-b", "uts-ihpc-account-b", [{ node: "turing1", family: "turing" }]);

  const { campaign } = campaignAudit({ campaignId: "camp-x", auditDir, configPath, quotaDir });
  assert.equal(campaign.campaign_id, "camp-x");
  assert.ok(Array.isArray(campaign.findings), "audit surfaces a findings array");

  const findA = campaign.findings.find((f) => f.profile_id === "uts-ihpc-account-a");
  assert.equal(findA.over_cap, true);
  assert.ok(findA.violations.some((v) => v.code === "node-pool-exceeded"));

  const findB = campaign.findings.find((f) => f.profile_id === "uts-ihpc-account-b");
  assert.equal(findB.over_cap, false);
  assert.deepEqual(findB.violations, []);
});

test("campaignAudit composes each account against its OWN snapshot — it NEVER sums across accounts", () => {
  const auditDir = tempRuntimeDir("campaign-no-sum");
  const quotaDir = path.join(tempRuntimeDir("campaign-no-sum-q"), "quotas");
  const configPath = writeProfileConfig("campaign-no-sum", PROFILES);
  writeRecord(auditDir, "x-a1", { campaign: "camp-x", profile: "uts-ihpc-account-a", platform: "uts-ihpc", status: "running" });
  writeRecord(auditDir, "x-b1", { campaign: "camp-x", profile: "uts-ihpc-account-b", platform: "uts-ihpc", status: "running" });

  // Each account holds 1 of its own 2-node cap. A naive cross-account sum (1+1=2, or families pooled)
  // could look large, but each is checked against its OWN cap only → NO account is flagged.
  writeSnapshot(quotaDir, "snap-a", "uts-ihpc-account-a", [{ node: "turing1", family: "turing" }]);
  writeSnapshot(quotaDir, "snap-b", "uts-ihpc-account-b", [{ node: "turing1", family: "turing" }]);

  const { campaign } = campaignAudit({ campaignId: "camp-x", auditDir, configPath, quotaDir });
  assert.equal(campaign.over_cap_count, 0);
  for (const finding of campaign.findings) {
    assert.equal(finding.over_cap, false);
    assert.deepEqual(finding.violations, []);
  }
});

test("campaignAudit surfaces the latest snapshot per account and notes a missing snapshot", () => {
  const auditDir = tempRuntimeDir("campaign-latest");
  const quotaDir = path.join(tempRuntimeDir("campaign-latest-q"), "quotas");
  const configPath = writeProfileConfig("campaign-latest", PROFILES);
  writeRecord(auditDir, "x-a1", { campaign: "camp-x", profile: "uts-ihpc-account-a", platform: "uts-ihpc", status: "running" });
  writeRecord(auditDir, "x-b1", { campaign: "camp-x", profile: "uts-ihpc-account-b", platform: "uts-ihpc", status: "running" });

  // Account A: an old (under-cap) snapshot and a NEWER (over-cap) one — the latest must win.
  writeSnapshot(quotaDir, "snap-a-old", "uts-ihpc-account-a", [{ node: "turing1", family: "turing" }], "2026-06-20T00:00:00.000Z");
  writeSnapshot(
    quotaDir,
    "snap-a-new",
    "uts-ihpc-account-a",
    [
      { node: "turing1", family: "turing" },
      { node: "turing2", family: "turing" },
      { node: "turing3", family: "turing" }
    ],
    "2026-06-20T05:00:00.000Z"
  );
  // Account B: no snapshot at all → audit cannot assert it is within cap; surface that, never assume OK.

  const { campaign } = campaignAudit({ campaignId: "camp-x", auditDir, configPath, quotaDir });
  const findA = campaign.findings.find((f) => f.profile_id === "uts-ihpc-account-a");
  assert.equal(findA.snapshot_id, "snap-a-new");
  assert.equal(findA.over_cap, true);

  const findB = campaign.findings.find((f) => f.profile_id === "uts-ihpc-account-b");
  assert.equal(findB.snapshot_id, null);
  assert.equal(findB.over_cap, false);
  assert.ok(findB.note && /snapshot/i.test(findB.note), "a missing snapshot is noted, not silently passed");
});

test("campaignStatus surfaces an optional operator fair-use attestation recorded on the runs", () => {
  const auditDir = tempRuntimeDir("campaign-basis");
  const configPath = writeProfileConfig("campaign-basis", PROFILES);
  writeRecord(auditDir, "x-a1", {
    campaign: "camp-x",
    profile: "uts-ihpc-account-a",
    platform: "uts-ihpc",
    status: "running",
    fairUseBasis: "two collaborators, one iHPC account each; each within its own cap"
  });
  writeRecord(auditDir, "x-b1", { campaign: "camp-x", profile: "uts-ihpc-account-b", platform: "uts-ihpc", status: "running" });

  const { campaign } = campaignStatus({ campaignId: "camp-x", auditDir, configPath });
  assert.ok(campaign.fair_use_basis && /two collaborators/.test(campaign.fair_use_basis));
});
