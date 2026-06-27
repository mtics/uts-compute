// Single home for the security-sensitive approval / confirmation-token / quota-snapshot gate primitives.
//
// Before this module, four per-tool approval guards (jobs.assertCancelApproval,
// transfer.assertTransferApproval, artifacts.assertArtifactApprovalIdentity,
// submission-approval.assertApprovalUsableForPlan) each open-coded the SAME three throws — operation
// mismatch, not-approved state, and already-consumed — before layering their own identity / plan_hash /
// quota checks. Likewise two env-backed confirmation-token gates (approvals.decideApproval and
// migrations.state.migrate.apply) each read process.env.UTS_COMPUTING_APPROVAL_TOKEN and threw their own
// two messages, and two quota-snapshot identity guards (approvals.assertFreshMatchingQuotaSnapshot and
// approvals.readFreshQuotaSnapshot) each re-emitted the same four id / profile_id / platform /
// observed_at throws before their (differing) staleness check.
//
// These are auth gates, so the thrown STRINGS are part of the contract that tests pin. This module emits
// each shared message from EXACTLY ONE place; every caller keeps its own extra checks (quota_snapshot_id,
// resource_summary, staleness window) and its own message wording for those. The byte-for-byte messages
// below must NOT change — they are asserted in tests/approval.test.mjs, tests/jobs.test.mjs,
// tests/submit.test.mjs, tests/migrations.test.mjs and the lib/auth unit tests.
//
// Leaf module: only type-imports from ./types (a pure leaf), so no import cycle.

import type { ApprovalRecord, QuotaSnapshot } from "../core/types.js";

// The operation/state/used_at triad shared verbatim by every per-tool approval guard. `operation` is the
// expected approval operation for this tool — callers pass either a literal ("jobs.cancel",
// "transfers.execute") or the ApprovalOperation they were handed; the rendered strings are identical
// either way. This emits ONLY the three shared throws; the caller still asserts run/profile/platform
// identity, plan_hash, and (where applicable) quota_snapshot_id / resource_summary with its own wording.
export function assertApprovalUsable(
  approval: ApprovalRecord,
  scope: { operation: string }
): void {
  const { operation } = scope;
  if (approval.operation !== operation) {
    throw new Error(`Approval ${approval.approval_id} is for ${approval.operation}, not ${operation}`);
  }
  if (approval.state !== "approved") {
    throw new Error(`Approval ${approval.approval_id} is ${approval.state}; ${operation} requires approved`);
  }
  if (approval.used_at) {
    throw new Error(`Approval ${approval.approval_id} has already been consumed`);
  }
}

// The approval identity-binding spine shared by every effectful per-tool gate (jobs.cancel,
// transfers.execute, artifacts.fetch / .batch / .cleanup.execute, jobs.submit / .retry). Each of those
// gates first ran assertApprovalUsable, then re-derived the SAME three checks — run/profile/platform
// identity, plan_hash, and (for run-record-bound gates only) quota_snapshot_id — before layering its
// own per-op resource-scope assertions (resource_summary, manifest_hash, operation selection), which
// STAY in the caller.
//
// The thrown wording is NOT uniform and must NOT be flattened: the identity noun varies three ways
// (jobs/artifacts "Approval does not match the run record identity", submission "Approval does not
// match the planned run identity", transfer "Transfer approval does not match the plan identity") and
// the plan_hash message likewise (… "the run record" / "the planned job" / "the saved plan"). So each
// caller threads its OWN messages here; this primitive only owns the comparison sequence and the single
// emission point for each throw. The quota_snapshot_id check is OPTIONAL — only the run-record-bound
// gates (jobs.cancel, artifacts.*) opt into the quota_snapshot_id check, exactly as before; submission
// and transfer omit it. The compared identity tuple is run_id/profile_id/platform + plan_hash
// [+ quota_snapshot_id], against the values the caller has already pulled off its own run record / saved
// plan. The quota check is gated by the PRESENCE of the `quotaSnapshot` field, NOT by the value being
// defined — jobs binds `runRecord.quota_snapshot_id`, which is itself `string | undefined`, and must
// still compare it (the prior `approval.quota_snapshot_id !== runRecord.quota_snapshot_id` ran even when
// the record's value was undefined). So callers that want the check pass `quotaSnapshot: { expected,
// message }`; callers that don't simply leave the field off.
export function assertApprovalBoundTo(
  approval: ApprovalRecord,
  scope: {
    operation: string;
    runId: string;
    profileId: string;
    platform: string;
    planHash: string | undefined;
    identityMessage: string;
    planHashMessage: string;
    quotaSnapshot?: { expected: string | undefined; message: string };
  }
): void {
  assertApprovalUsable(approval, { operation: scope.operation });
  if (
    approval.run_id !== scope.runId ||
    approval.profile_id !== scope.profileId ||
    approval.platform !== scope.platform
  ) {
    throw new Error(scope.identityMessage);
  }
  if (approval.plan_hash !== scope.planHash) {
    throw new Error(scope.planHashMessage);
  }
  if (scope.quotaSnapshot && approval.quota_snapshot_id !== scope.quotaSnapshot.expected) {
    throw new Error(scope.quotaSnapshot.message);
  }
}

// Option A — the adopted-identity cancel binding. A bare-qsub PBS job the plugin never planned has no
// plan_hash, so its jobs.cancel approval cannot use assertApprovalBoundTo's plan_hash spine. Instead the
// approval is bound to the run's ADOPTED IDENTITY: operation + run_id + profile_id + platform + the run's
// own remote_job_id. This keeps BOTH real protections — target confinement (the bound remote_job_id is
// the record's own, qstat-confirmed id) and fresh human intent (the approved-state requirement carried
// by assertApprovalUsable). The remote_job_id binding is REQUIRED and fail-closed: an approval missing
// it, or bound to a DIFFERENT id, is rejected; this primitive deliberately rejects an approval that
// carries a plan_hash (that one belongs on the planned-job path, not here). Caller threads the messages.
export function assertAdoptedCancelApproval(
  approval: ApprovalRecord,
  scope: {
    runId: string;
    profileId: string;
    platform: string;
    remoteJobId: string;
    identityMessage: string;
    remoteJobIdMessage: string;
  }
): void {
  assertApprovalUsable(approval, { operation: "jobs.cancel" });
  if (
    approval.run_id !== scope.runId ||
    approval.profile_id !== scope.profileId ||
    approval.platform !== scope.platform
  ) {
    throw new Error(scope.identityMessage);
  }
  // Fail-closed: the remote_job_id binding is REQUIRED and must match the run's own id exactly. An
  // approval with no remote_job_id (or one bound to a different job/account) is rejected.
  if (!approval.remote_job_id || approval.remote_job_id !== scope.remoteJobId) {
    throw new Error(scope.remoteJobIdMessage);
  }
}

// The env-backed confirmation-token gate. Owns the single read of UTS_COMPUTING_APPROVAL_TOKEN; the
// `override` (an explicit options.confirmationToken) takes precedence over the env var, exactly as both
// former copies did. Callers pass their own two messages — the prefix wording ("Approval decisions ..."
// vs "state.migrate.apply ...", "Invalid approval ..." vs "Invalid migration ...") is the only intended
// divergence.
export function assertConfirmationToken(
  provided: string | undefined,
  override: string | undefined,
  messages: { missingMessage: string; mismatchMessage: string }
): void {
  const expected = override ?? process.env.UTS_COMPUTING_APPROVAL_TOKEN;
  if (!expected) {
    throw new Error(messages.missingMessage);
  }
  if (provided !== expected) {
    throw new Error(messages.mismatchMessage);
  }
}

// The quota-snapshot identity guard shared by both approval-time snapshot readers. Emits the four
// id / profile_id / platform / observed_at throws once, then returns the parsed observed_at epoch (ms) so
// each caller can apply its OWN staleness window + message ("stale for approval" vs
// "stale (older than N minutes)") without re-parsing the timestamp.
export function assertQuotaSnapshotMatches(
  snapshot: QuotaSnapshot,
  scope: { quotaSnapshotId: string; profileId: string; platform: string }
): number {
  const { quotaSnapshotId, profileId, platform } = scope;
  if (snapshot.snapshot_id !== quotaSnapshotId) {
    throw new Error(`Quota snapshot id mismatch: expected ${quotaSnapshotId}, got ${snapshot.snapshot_id}`);
  }
  if (snapshot.profile_id !== profileId) {
    throw new Error(`Quota snapshot profile_id ${snapshot.profile_id} does not match ${profileId}`);
  }
  if (snapshot.platform !== platform) {
    throw new Error(`Quota snapshot platform ${snapshot.platform} does not match ${platform}`);
  }
  const observedAt = Date.parse(snapshot.observed_at);
  if (!Number.isFinite(observedAt)) {
    throw new Error(`Quota snapshot ${quotaSnapshotId} has invalid observed_at`);
  }
  return observedAt;
}
