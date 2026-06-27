import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAdoptedCancelApproval,
  assertApprovalBoundTo,
  assertApprovalUsable,
  assertConfirmationToken,
  assertQuotaSnapshotMatches
} from "../../dist/lib/auth.js";

// These are the security-sensitive approval / confirmation-token / quota-snapshot gate primitives that
// p3-step-2 extracted out of the four per-tool approval guards (jobs.assertCancelApproval,
// transfer.assertTransferApproval, artifacts.assertArtifactApprovalIdentity,
// submission-approval.assertApprovalUsableForPlan), the two env-token gates (approvals.decideApproval,
// migrations.applyStateMigration) and the two quota-snapshot readers (approvals.assertFreshMatchingQuotaSnapshot,
// approvals.readFreshQuotaSnapshot). The thrown STRINGS are part of the contract — these tests pin them
// byte-for-byte so a future edit to lib/auth.ts cannot silently reword an auth-gate error.

function approval(overrides = {}) {
  return {
    approval_id: "approval-xyz",
    run_id: "1234.hpc",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    operation: "jobs.cancel",
    state: "approved",
    plan_hash: "a".repeat(64),
    quota_snapshot_id: "quota-1",
    reasons: [],
    requested_at: "2026-06-15T00:00:00.000Z",
    expires_at: "2026-06-16T00:00:00.000Z",
    warnings: [],
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    snapshot_id: "quota-1",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    observed_at: "2026-06-15T00:00:00.000Z",
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {},
    commands: [],
    warnings: [],
    ...overrides
  };
}

test("assertApprovalUsable: operation mismatch throws the for/not message with both operations", () => {
  assert.throws(
    () => assertApprovalUsable(approval({ operation: "artifacts.fetch" }), { operation: "jobs.cancel" }),
    /^Error: Approval approval-xyz is for artifacts\.fetch, not jobs\.cancel$/
  );
});

test("assertApprovalUsable: non-approved state throws the state;operation requires approved message", () => {
  assert.throws(
    () =>
      assertApprovalUsable(approval({ operation: "transfers.execute", state: "required" }), {
        operation: "transfers.execute"
      }),
    /^Error: Approval approval-xyz is required; transfers\.execute requires approved$/
  );
});

test("assertApprovalUsable: already-consumed (used_at set) throws the consumed message", () => {
  assert.throws(
    () => assertApprovalUsable(approval({ used_at: "2026-06-15T01:00:00.000Z" }), { operation: "jobs.cancel" }),
    /^Error: Approval approval-xyz has already been consumed$/
  );
});

test("assertApprovalUsable: a clean approved/matching record does not throw", () => {
  assert.doesNotThrow(() => assertApprovalUsable(approval(), { operation: "jobs.cancel" }));
});

// assertApprovalBoundTo = the identity-binding spine the effectful per-tool gates now share. It runs
// assertApprovalUsable, then run/profile/platform identity, then plan_hash, then (only when the caller
// passes quotaSnapshotId) quota_snapshot_id. The three message strings are caller-threaded and must come
// out byte-for-byte (they vary three ways across jobs/artifacts/submission/transfer).
const boundScope = (overrides = {}) => ({
  operation: "jobs.cancel",
  runId: "1234.hpc",
  profileId: "uts-hpc-account-a",
  platform: "uts-hpc",
  planHash: "a".repeat(64),
  identityMessage: "Approval does not match the run record identity",
  planHashMessage: "Approval plan_hash does not match the run record",
  quotaSnapshot: { expected: "quota-1", message: "Approval quota_snapshot_id does not match the run record" },
  ...overrides
});

test("assertApprovalBoundTo: delegates the operation-mismatch throw to assertApprovalUsable", () => {
  assert.throws(
    () => assertApprovalBoundTo(approval({ operation: "artifacts.fetch" }), boundScope()),
    /^Error: Approval approval-xyz is for artifacts\.fetch, not jobs\.cancel$/
  );
});

test("assertApprovalBoundTo: run_id identity mismatch throws the caller's identityMessage", () => {
  assert.throws(
    () => assertApprovalBoundTo(approval({ run_id: "9999.hpc" }), boundScope()),
    /^Error: Approval does not match the run record identity$/
  );
});

test("assertApprovalBoundTo: profile/platform mismatch also throws identityMessage (transfer wording)", () => {
  assert.throws(
    () =>
      assertApprovalBoundTo(
        approval({ platform: "uts-ihpc" }),
        boundScope({ identityMessage: "Transfer approval does not match the plan identity" })
      ),
    /^Error: Transfer approval does not match the plan identity$/
  );
});

test("assertApprovalBoundTo: plan_hash mismatch throws the caller's planHashMessage (submission wording)", () => {
  assert.throws(
    () =>
      assertApprovalBoundTo(
        approval({ plan_hash: "b".repeat(64) }),
        boundScope({ planHashMessage: "Approval plan_hash does not match the planned job" })
      ),
    /^Error: Approval plan_hash does not match the planned job$/
  );
});

test("assertApprovalBoundTo: quota_snapshot_id mismatch throws quotaSnapshotMessage when scope carries one", () => {
  assert.throws(
    () => assertApprovalBoundTo(approval({ quota_snapshot_id: "quota-other" }), boundScope()),
    /^Error: Approval quota_snapshot_id does not match the run record$/
  );
});

test("assertApprovalBoundTo: omitting the quotaSnapshot field skips the quota check (submission/transfer path)", () => {
  // submission and transfer never bind quota_snapshot_id; a mismatching snapshot on the approval must
  // NOT throw when the caller leaves the quotaSnapshot field off.
  const { quotaSnapshot, ...noQuota } = boundScope();
  assert.doesNotThrow(() => assertApprovalBoundTo(approval({ quota_snapshot_id: "quota-other" }), noQuota));
});

test("assertApprovalBoundTo: quota check still runs when the bound expected value is undefined", () => {
  // jobs binds runRecord.quota_snapshot_id, which is itself optional; the prior code compared even when
  // it was undefined. An approval carrying a snapshot id must still throw against an undefined expected.
  assert.throws(
    () => assertApprovalBoundTo(approval({ quota_snapshot_id: "quota-1" }), boundScope({ quotaSnapshot: { expected: undefined, message: "Approval quota_snapshot_id does not match the run record" } })),
    /^Error: Approval quota_snapshot_id does not match the run record$/
  );
});

test("assertApprovalBoundTo: a fully-matching run-record-bound approval does not throw", () => {
  assert.doesNotThrow(() => assertApprovalBoundTo(approval(), boundScope()));
});

// assertAdoptedCancelApproval = the Option A adopted-identity cancel binding. It runs assertApprovalUsable
// (operation jobs.cancel + approved state + not-consumed), then run/profile/platform identity, then a
// REQUIRED remote_job_id match. plan_hash plays no part. The remote_job_id binding is fail-closed.
const adoptedScope = (overrides = {}) => ({
  runId: "adopt-4321-cetus",
  profileId: "uts-hpc-account-a",
  platform: "uts-hpc",
  remoteJobId: "4321.cetus",
  identityMessage: "Approval does not match the adopted run record identity",
  remoteJobIdMessage: "Approval remote_job_id does not match the adopted run record",
  ...overrides
});

function adoptedApproval(overrides = {}) {
  // An adopted-cancel approval carries remote_job_id and NO plan_hash/quota_snapshot_id.
  const { plan_hash, quota_snapshot_id, ...rest } = approval();
  return {
    ...rest,
    run_id: "adopt-4321-cetus",
    remote_job_id: "4321.cetus",
    ...overrides
  };
}

test("assertAdoptedCancelApproval: a clean adopted-cancel approval bound to the run's remote_job_id passes", () => {
  assert.doesNotThrow(() => assertAdoptedCancelApproval(adoptedApproval(), adoptedScope()));
});

test("assertAdoptedCancelApproval: an approval bound to a DIFFERENT remote_job_id is rejected", () => {
  assert.throws(
    () => assertAdoptedCancelApproval(adoptedApproval({ remote_job_id: "9999.cetus" }), adoptedScope()),
    /^Error: Approval remote_job_id does not match the adopted run record$/
  );
});

test("assertAdoptedCancelApproval: an approval MISSING remote_job_id is rejected (fail-closed)", () => {
  const noJobId = adoptedApproval();
  delete noJobId.remote_job_id;
  assert.throws(
    () => assertAdoptedCancelApproval(noJobId, adoptedScope()),
    /^Error: Approval remote_job_id does not match the adopted run record$/
  );
});

test("assertAdoptedCancelApproval: a cross-run identity mismatch is rejected", () => {
  assert.throws(
    () => assertAdoptedCancelApproval(adoptedApproval({ run_id: "some-other-run" }), adoptedScope()),
    /^Error: Approval does not match the adopted run record identity$/
  );
});

test("assertAdoptedCancelApproval: a non-approved (pending) approval is rejected via assertApprovalUsable", () => {
  assert.throws(
    () => assertAdoptedCancelApproval(adoptedApproval({ state: "required" }), adoptedScope()),
    /^Error: Approval approval-xyz is required; jobs\.cancel requires approved$/
  );
});

test("assertConfirmationToken: missing expected token throws the caller's missingMessage", () => {
  delete process.env.UTS_COMPUTING_APPROVAL_TOKEN;
  assert.throws(
    () =>
      assertConfirmationToken(undefined, undefined, {
        missingMessage: "Approval decisions require a trusted confirmation token",
        mismatchMessage: "Invalid approval confirmation token"
      }),
    /^Error: Approval decisions require a trusted confirmation token$/
  );
});

test("assertConfirmationToken: wrong provided token throws the caller's mismatchMessage", () => {
  assert.throws(
    () =>
      assertConfirmationToken("nope", "secret", {
        missingMessage: "state.migrate.apply requires a trusted confirmation token",
        mismatchMessage: "Invalid migration confirmation token"
      }),
    /^Error: Invalid migration confirmation token$/
  );
});

test("assertConfirmationToken: override precedes env, matching provided token passes", () => {
  process.env.UTS_COMPUTING_APPROVAL_TOKEN = "env-token";
  try {
    assert.doesNotThrow(() =>
      assertConfirmationToken("override-token", "override-token", {
        missingMessage: "missing",
        mismatchMessage: "mismatch"
      })
    );
    // env var alone (no override) is honoured as the expected value
    assert.doesNotThrow(() =>
      assertConfirmationToken("env-token", undefined, {
        missingMessage: "missing",
        mismatchMessage: "mismatch"
      })
    );
  } finally {
    delete process.env.UTS_COMPUTING_APPROVAL_TOKEN;
  }
});

test("assertQuotaSnapshotMatches: snapshot_id mismatch throws the id-mismatch message", () => {
  assert.throws(
    () =>
      assertQuotaSnapshotMatches(snapshot({ snapshot_id: "quota-other" }), {
        quotaSnapshotId: "quota-1",
        profileId: "uts-hpc-account-a",
        platform: "uts-hpc"
      }),
    /^Error: Quota snapshot id mismatch: expected quota-1, got quota-other$/
  );
});

test("assertQuotaSnapshotMatches: profile_id mismatch throws the profile_id message", () => {
  assert.throws(
    () =>
      assertQuotaSnapshotMatches(snapshot({ profile_id: "uts-hpc-account-b" }), {
        quotaSnapshotId: "quota-1",
        profileId: "uts-hpc-account-a",
        platform: "uts-hpc"
      }),
    /^Error: Quota snapshot profile_id uts-hpc-account-b does not match uts-hpc-account-a$/
  );
});

test("assertQuotaSnapshotMatches: platform mismatch throws the platform message", () => {
  assert.throws(
    () =>
      assertQuotaSnapshotMatches(snapshot({ platform: "uts-ihpc" }), {
        quotaSnapshotId: "quota-1",
        profileId: "uts-hpc-account-a",
        platform: "uts-hpc"
      }),
    /^Error: Quota snapshot platform uts-ihpc does not match uts-hpc$/
  );
});

test("assertQuotaSnapshotMatches: invalid observed_at throws the invalid observed_at message", () => {
  assert.throws(
    () =>
      assertQuotaSnapshotMatches(snapshot({ observed_at: "not-a-date" }), {
        quotaSnapshotId: "quota-1",
        profileId: "uts-hpc-account-a",
        platform: "uts-hpc"
      }),
    /^Error: Quota snapshot quota-1 has invalid observed_at$/
  );
});

test("assertQuotaSnapshotMatches: a matching snapshot returns the parsed observed_at epoch (ms)", () => {
  const observedAt = assertQuotaSnapshotMatches(snapshot(), {
    quotaSnapshotId: "quota-1",
    profileId: "uts-hpc-account-a",
    platform: "uts-hpc"
  });
  assert.equal(observedAt, Date.parse("2026-06-15T00:00:00.000Z"));
});
