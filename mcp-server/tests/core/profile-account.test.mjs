import assert from "node:assert/strict";
import test from "node:test";
import { profileAccountName, redactProfile } from "../../dist/core/config.js";
import { validateProfile } from "../../dist/core/validation.js";

const userAtHost = {
  profile_id: "uts-hpc-cetus",
  platform: "uts-hpc",
  account_label: "cetus-u00000001",
  login: { host_alias: "u00000001@hpc-login.example.invalid", username_ref: "UTS_HPC_CETUS_USER" },
  defaults: { queue: "smallq" },
  quota_snapshot: null
};

const bareAlias = {
  profile_id: "uts-ihpc",
  platform: "uts-ihpc",
  account_label: "ihpc-ihpc-user-a",
  login: { host_alias: "ihpc-user-a", username_ref: "UTS_IHPC_USER_A" },
  defaults: { node_family: "turing" },
  quota_snapshot: null
};

test("profileAccountName returns the user part of a user@host alias", () => {
  assert.equal(profileAccountName(userAtHost), "u00000001");
});

test("profileAccountName returns a bare alias as the account name", () => {
  assert.equal(profileAccountName(bareAlias), "ihpc-user-a");
});

test("redactProfile exposes the derived account and keeps the host redacted, not the label", () => {
  const redacted = redactProfile(userAtHost);
  assert.equal(redacted.account, "u00000001");
  assert.equal(Object.hasOwn(redacted, "account_label"), false);
  assert.equal(redacted.login.has_host_alias, true);
  assert.equal(Object.hasOwn(redacted.login, "host_alias"), false);
});

// profiles.list must reflect a persisted quota snapshot: refresh writes a snapshot to the store, and
// the list must derive freshness from that snapshot's age (not only from an embedded YAML field,
// which is never populated in practice — the cause of "always shows unverified").
test("redactProfile derives 'fresh' from a recent persisted quota snapshot", () => {
  const now = new Date("2026-06-18T23:10:00.000Z");
  const snapshot = { observed_at: "2026-06-18T23:08:00.000Z", source: "quotas.refresh", summary: { identity: {} } };
  const redacted = redactProfile(bareAlias, snapshot, now);
  assert.equal(redacted.quota_snapshot.freshness, "fresh");
  assert.equal(redacted.quota_snapshot.observed_at, "2026-06-18T23:08:00.000Z");
  assert.equal(redacted.quota_snapshot.has_summary, true);
});

test("redactProfile derives 'stale' from a persisted quota snapshot older than the freshness window", () => {
  const now = new Date("2026-06-18T23:40:00.000Z");
  const snapshot = { observed_at: "2026-06-18T23:08:00.000Z", source: "quotas.refresh", summary: {} };
  const redacted = redactProfile(bareAlias, snapshot, now);
  assert.equal(redacted.quota_snapshot.freshness, "stale");
});

test("redactProfile reports 'missing' when neither a persisted nor embedded snapshot exists", () => {
  const redacted = redactProfile(bareAlias);
  assert.equal(redacted.quota_snapshot.freshness, "missing");
});

// owner/allocation are campaign-ledger attribution labels: schema-valid, and SURFACED by
// redactProfile (disclosure, not secrets — unlike host_alias which is redacted).
test("a profile carrying owner/allocation attribution labels passes schema validation", () => {
  const result = validateProfile({
    profile_id: "uts-ihpc-attr",
    platform: "uts-ihpc",
    account_label: "ihpc-attr",
    login: { host_alias: "ihpc-attr-host", username_ref: "UTS_IHPC_ATTR_USER", requires_vpn: true },
    defaults: { node_family: "turing", owner: "owner-a", allocation: "alloc-a" },
    quota_snapshot: null
  });
  assert.equal(result.valid, true, result.errors.join("; "));
});

test("redactProfile surfaces owner/allocation attribution labels (disclosure, not redaction)", () => {
  const withAttribution = {
    ...bareAlias,
    defaults: { ...bareAlias.defaults, owner: "owner-a", allocation: "alloc-a" }
  };
  const redacted = redactProfile(withAttribution);
  assert.equal(redacted.defaults.owner, "owner-a");
  assert.equal(redacted.defaults.allocation, "alloc-a");
});

test("redactProfile discloses has_node_scheduler + runner (reduced node_scheduler shape)", () => {
  const withScheduler = {
    profile_id: "ihpc-sched-p",
    platform: "uts-ihpc",
    account_label: "ihpc-s",
    login: { host_alias: "ihpc-sched-host", username_ref: "UTS_IHPC_S_USER", requires_vpn: true },
    defaults: {
      node_family: "mars",
      node_scheduler: { runner: "uv" }
    }
  };
  // The field reduced to just `runner` post-internalization (uv_bin/dir were dropped); a profile that
  // still carries those sub-options must be rejected by additionalProperties:false.
  assert.equal(validateProfile(withScheduler).valid, true);
  const redacted = redactProfile(withScheduler);
  assert.equal(redacted.defaults.has_node_scheduler, true);
  assert.equal(redacted.defaults.node_scheduler_runner, "uv");
  const withDroppedSubOptions = {
    ...withScheduler,
    profile_id: "ihpc-sched-q",
    defaults: { node_family: "mars", node_scheduler: { runner: "uv", uv_bin: "/home/secret/.local/bin/uv" } }
  };
  assert.equal(validateProfile(withDroppedSubOptions).valid, false);
});

test("redactProfile reports has_node_scheduler:false when absent (default console path)", () => {
  const bare = {
    profile_id: "ihpc-bare-p",
    platform: "uts-ihpc",
    account_label: "ihpc-b",
    login: { host_alias: "ihpc-bare-host", username_ref: "UTS_IHPC_B_USER", requires_vpn: true },
    defaults: { node_family: "mars" }
  };
  const redacted = redactProfile(bare);
  assert.equal(redacted.defaults.has_node_scheduler, false);
  assert.equal(redacted.defaults.node_scheduler_runner, "console");
});

test("a profile WITHOUT node_scheduler still validates (Codex profiles unchanged)", () => {
  const bare = {
    profile_id: "ihpc-bare-q",
    platform: "uts-ihpc",
    account_label: "ihpc-b",
    login: { host_alias: "ihpc-bare-host", username_ref: "UTS_IHPC_B_USER", requires_vpn: true },
    defaults: { node_family: "mars" }
  };
  assert.equal(validateProfile(bare).valid, true);
});

test("node_scheduler with an out-of-whitelist runner is rejected", () => {
  const bad = {
    profile_id: "ihpc-bad-r",
    platform: "uts-ihpc",
    account_label: "ihpc-b",
    login: { host_alias: "ihpc-bad-host", username_ref: "UTS_IHPC_B_USER", requires_vpn: true },
    defaults: { node_family: "mars", node_scheduler: { runner: "systemd" } }
  };
  assert.equal(validateProfile(bad).valid, false);
});
