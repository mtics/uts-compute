import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redactCommand } from "../../core/audit.js";
import { assertConfirmationToken, assertQuotaSnapshotMatches } from "../../lib/auth.js";
import { boundedInteger, isHexDigest, stableJson } from "../../lib/shared.js";
import { assertSafeApprovalId, assertSafeRunId, isSafePbsJobId, isSafeRemoteJobId } from "../../core/ids.js";
import { approvalReasonsForJobSpec } from "./approval-policy.js";
import { assertInsideRuntime, assertRealPathInside, RUNTIME_DIRS } from "../../core/paths.js";
import { readPlanArtifact } from "../plans/plan-store.js";
import { planHashForPlan } from "../plans/planner.js";
import { assertApprovalRecord, assertQuotaSnapshot } from "../../core/validation.js";
import type { ApprovalOperation, ApprovalRecord, ApprovalState, PlannedJob, Platform, QuotaSnapshot } from "../../core/types.js";

export interface ApprovalRequestInput {
  runId: string;
  profileId: string;
  previousProfileId?: string;
  platform: Platform;
  operation?: ApprovalOperation;
  // planHash / quotaSnapshotId are REQUIRED for every planned-job approval (the default). They are
  // OPTIONAL only for an adopted-PBS jobs.cancel approval (Option A), which binds `remoteJobId` instead
  // — a bare-qsub job the plugin never planned has no plan_hash. assertAdoptedCancelRequest enforces
  // that the relaxation is taken ONLY for operation === "jobs.cancel" WITH a remoteJobId.
  planHash?: string;
  quotaSnapshotId?: string;
  remoteJobId?: string;
  reasons?: string[];
  commandSummary?: string;
  resourceSummary?: Record<string, unknown>;
  expiresInHours?: number;
}

export interface ApprovalDecisionInput {
  approvalId: string;
  decision: "approved" | "rejected";
  // Mirror the request: optional for the adopted-PBS jobs.cancel path (verified against remoteJobId
  // instead), required otherwise. decideApproval verifies whichever binding the approval actually carries.
  planHash?: string;
  quotaSnapshotId?: string;
  remoteJobId?: string;
  decidedBy?: string;
  reason?: string;
  confirmationToken?: string;
}

export interface ApprovalStatusInput {
  approvalId: string;
}

export interface ApprovalConsumeInput {
  approvalId: string;
  runId?: string;
  profileId?: string;
  platform?: Platform;
  operation?: ApprovalOperation;
  // Optional for the adopted-PBS jobs.cancel path (bound to remoteJobId). When provided, each is
  // compared against the approved record; when omitted, that field's check is skipped.
  planHash?: string;
  quotaSnapshotId?: string;
  remoteJobId?: string;
  consumedBy: string;
}

export interface ApprovalOptions {
  approvalDir?: string;
  planDir?: string;
  now?: Date;
  confirmationToken?: string;
  quotaMaxAgeMinutes?: number;
}

const DEFAULT_APPROVAL_DIR = RUNTIME_DIRS.approvals;
const QUOTA_DIR = RUNTIME_DIRS.quotas;
const DEFAULT_EXPIRY_HOURS = 24;
const MAX_EXPIRY_HOURS = 168;
const DEFAULT_QUOTA_MAX_AGE_MINUTES = 15;

// Option A — an adopted-PBS jobs.cancel approval binds the run's real remote_job_id instead of a
// plan_hash/quota_snapshot_id. This is the SOLE relaxation; it is taken ONLY when operation is
// "jobs.cancel" AND a remoteJobId is supplied AND no planHash is supplied (fail-closed: a planHash
// present means the caller wants the planned-job binding, so we keep it). Any other operation that
// somehow carries a remoteJobId is rejected by assertAdoptedCancelRequest.
function isAdoptedCancelRequest(input: ApprovalRequestInput, operation: ApprovalOperation): boolean {
  return operation === "jobs.cancel" && input.remoteJobId !== undefined && input.planHash === undefined;
}

function assertAdoptedCancelRequest(input: ApprovalRequestInput, operation: ApprovalOperation): void {
  if (operation !== "jobs.cancel") {
    throw new Error("remoteJobId binding is only valid for a jobs.cancel approval");
  }
  if (input.planHash !== undefined || input.quotaSnapshotId !== undefined) {
    throw new Error("An adopted jobs.cancel approval binds remoteJobId, not plan_hash/quota_snapshot_id");
  }
  if (!input.remoteJobId || !isAdoptedRemoteJobId(input.remoteJobId)) {
    throw new Error(`Invalid remoteJobId for adopted cancel approval: ${String(input.remoteJobId)}`);
  }
}

export function requestApproval(input: ApprovalRequestInput, options: ApprovalOptions = {}): { approval: ApprovalRecord } {
  const now = options.now ?? new Date();
  const operation = input.operation ?? "jobs.submit";
  assertSafeRunId(input.runId, "runId");
  assertSafeId(input.profileId, "profileId");
  if (input.previousProfileId !== undefined) {
    assertSafeId(input.previousProfileId, "previousProfileId");
  }
  // The adopted-identity binding path: no plan_hash/quota_snapshot to validate, identity is the
  // remote_job_id. Everything else (effectful op, human-decided state requirement) is unchanged.
  if (input.remoteJobId !== undefined || isAdoptedCancelRequest(input, operation)) {
    return requestAdoptedCancelApproval(input, operation, now, options);
  }
  if (input.planHash === undefined || input.quotaSnapshotId === undefined) {
    throw new Error("Approval request requires planHash and quotaSnapshotId (or remoteJobId for an adopted jobs.cancel)");
  }
  assertPlanHash(input.planHash);
  assertSafeId(input.quotaSnapshotId, "quotaSnapshotId");
  const scopeHash = approvalScopeHashFor(input, operation);
  const approvalId = approvalIdFor(input.runId, operation, input.planHash, input.quotaSnapshotId, scopeHash);
  const existing = readApprovalIfExists(approvalId, options);
  if (existing) {
    assertExistingApprovalMatchesRequest(existing, input, operation);
    const refreshed = refreshExpiryState(existing, now);
    if (refreshed.state !== existing.state) {
      writeApprovalRecord(refreshed, options);
    }
    return { approval: refreshed };
  }

  // Freshness gate AT MINT: the snapshot must be fresh when the approval is requested (this throws if
  // it is stale). The returned expiry is intentionally NOT used to bound the approval lifetime.
  assertFreshMatchingQuotaSnapshot(input.quotaSnapshotId, input.profileId, input.platform, now, options);

  const expiryHours = normalizeExpiryHours(input.expiresInHours);
  // The approval lives its full expiryHours (default 24h) — decoupled from the snapshot's 15-min
  // capacity TTL. Clamping the two (the old `Math.min(..., quotaExpiresAt)`) made a human approver who
  // took longer than the remaining snapshot window hit an already-expired approval. The binding to the
  // exact (plan_hash, quota_snapshot_id) is unchanged; only the lifetime is decoupled. The real
  // over-subscription guard is PBS at qsub / the iHPC node-pool conformance gate at start.
  const approvalExpiresAt = now.getTime() + expiryHours * 60 * 60 * 1000;
  const planContext = approvalContextFromPlan(input, operation, options);
  const reasons = uniqueReasons([
    ...operationDefaultReasons(operation),
    ...profileSwitchReasons(input.previousProfileId, input.profileId),
    ...planContext.reasons,
    ...(input.reasons ?? [])
  ]);
  const commandSummary = input.commandSummary ?? planContext.commandSummary;
  const resourceSummary = input.resourceSummary ?? planContext.resourceSummary;
  const approval: ApprovalRecord = {
    approval_id: approvalId,
    run_id: input.runId,
    profile_id: input.profileId,
    platform: input.platform,
    operation,
    state: "required",
    plan_hash: input.planHash,
    quota_snapshot_id: input.quotaSnapshotId,
    ...(scopeHash ? { scope_hash: scopeHash } : {}),
    reasons,
    requested_at: now.toISOString(),
    expires_at: new Date(approvalExpiresAt).toISOString(),
    ...(commandSummary ? { command_summary: redactCommand(commandSummary) } : {}),
    ...(resourceSummary ? { resource_summary: resourceSummary } : {}),
    warnings: [
      "Approval is valid only for the exact plan_hash and quota_snapshot_id recorded here",
      "Changing profile, resources, command, paths, or quota snapshot requires a new approval"
    ]
  };
  writeApprovalRecord(approval, options);
  return { approval };
}

// Mint (or idempotently re-read) an adopted-PBS jobs.cancel approval bound to the run's identity +
// remote_job_id. No plan_hash, no quota snapshot freshness gate (there is no planned job and no
// capacity reservation to validate — the only protection here is target confinement + fresh human
// intent, both of which the cancelJob gate enforces). The approval_id embeds the remote_job_id so the
// id itself is per-job; assertExistingAdoptedCancelMatches catches any conflicting re-request.
function requestAdoptedCancelApproval(
  input: ApprovalRequestInput,
  operation: ApprovalOperation,
  now: Date,
  options: ApprovalOptions
): { approval: ApprovalRecord } {
  assertAdoptedCancelRequest(input, operation);
  const remoteJobId = input.remoteJobId as string;
  const approvalId = adoptedCancelApprovalIdFor(input.runId, remoteJobId);
  const existing = readApprovalIfExists(approvalId, options);
  if (existing) {
    assertExistingAdoptedCancelMatches(existing, input);
    const refreshed = refreshExpiryState(existing, now);
    if (refreshed.state !== existing.state) {
      writeApprovalRecord(refreshed, options);
    }
    return { approval: refreshed };
  }
  const expiryHours = normalizeExpiryHours(input.expiresInHours);
  const approvalExpiresAt = now.getTime() + expiryHours * 60 * 60 * 1000;
  const reasons = uniqueReasons([
    ...operationDefaultReasons(operation),
    ...profileSwitchReasons(input.previousProfileId, input.profileId),
    ...(input.reasons ?? [])
  ]);
  const commandSummary = input.commandSummary;
  const approval: ApprovalRecord = {
    approval_id: approvalId,
    run_id: input.runId,
    profile_id: input.profileId,
    platform: input.platform,
    operation,
    state: "required",
    remote_job_id: remoteJobId,
    ...(commandSummary ? { command_summary: redactCommand(commandSummary) } : {}),
    reasons,
    requested_at: now.toISOString(),
    expires_at: new Date(approvalExpiresAt).toISOString(),
    warnings: [
      "Approval is valid only for the exact adopted run_id, profile, platform, and remote_job_id recorded here",
      "It authorizes cancelling ONLY this adopted job; it cannot be reused for a different job or account"
    ]
  };
  writeApprovalRecord(approval, options);
  return { approval };
}

function assertExistingAdoptedCancelMatches(existing: ApprovalRecord, input: ApprovalRequestInput): void {
  if (
    existing.run_id !== input.runId ||
    existing.profile_id !== input.profileId ||
    existing.platform !== input.platform ||
    existing.operation !== "jobs.cancel" ||
    existing.remote_job_id !== input.remoteJobId ||
    existing.plan_hash !== undefined ||
    existing.quota_snapshot_id !== undefined
  ) {
    throw new Error("Existing approval record does not match the adopted cancel request identity");
  }
}

interface ApprovalPlanContext {
  reasons: string[];
  commandSummary?: string;
  resourceSummary?: Record<string, unknown>;
}

function approvalContextFromPlan(
  input: ApprovalRequestInput,
  operation: ApprovalOperation,
  options: ApprovalOptions
): ApprovalPlanContext {
  if (operation !== "jobs.submit" && operation !== "jobs.retry") {
    return { reasons: [] };
  }
  const plan = readPlanArtifactIfExists(input.runId, options.planDir);
  if (!plan) {
    return { reasons: [] };
  }
  assertPlanMatchesApprovalRequest(plan, input, operation);
  return {
    reasons: approvalReasonsForJobSpec(plan.normalized_job_spec),
    commandSummary: plan.normalized_job_spec.command,
    resourceSummary: plan.normalized_job_spec.resources as Record<string, unknown>
  };
}

function readPlanArtifactIfExists(runId: string, planDir: string | undefined): PlannedJob | null {
  try {
    return readPlanArtifact(runId, planDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// NOT routed through plan-store.readVerifiedPlan (finding 13): this is the divergent no-read assert
// form. It already holds a plan read via ENOENT-tolerant readPlanArtifactIfExists, and its
// self-consistency throw uses distinct "Saved plan artifact ..." wording interleaved with the
// request-identity and request-hash checks; the audit forbids flattening that divergence.
function assertPlanMatchesApprovalRequest(plan: PlannedJob, input: ApprovalRequestInput, operation: ApprovalOperation): void {
  if (plan.run_id !== input.runId || plan.profile_id !== input.profileId || plan.platform !== input.platform) {
    throw new Error("Saved plan artifact does not match the approval request identity");
  }
  const recomputedPlanHash = planHashForPlan(plan);
  if (recomputedPlanHash !== plan.plan_hash) {
    throw new Error("Saved plan artifact plan_hash does not match its rendered content");
  }
  if (plan.plan_hash !== input.planHash) {
    throw new Error("Saved plan artifact plan_hash does not match the approval request");
  }
  const expectedOperation = plan.approval_operation ?? (plan.retry_of ? "jobs.retry" : "jobs.submit");
  if ((operation === "jobs.submit" || operation === "jobs.retry") && operation !== expectedOperation) {
    throw new Error(`Saved plan requires ${expectedOperation} approval, not ${operation}`);
  }
  if (expectedOperation === "jobs.retry" && !plan.retry_of) {
    throw new Error("Saved retry approval operation requires retry_of metadata");
  }
}

function assertExistingApprovalMatchesRequest(
  existing: ApprovalRecord,
  input: ApprovalRequestInput,
  operation: ApprovalOperation
): void {
  if (
    existing.run_id !== input.runId ||
    existing.profile_id !== input.profileId ||
    existing.platform !== input.platform ||
    existing.operation !== operation ||
    existing.plan_hash !== input.planHash ||
    existing.quota_snapshot_id !== input.quotaSnapshotId ||
    existing.scope_hash !== approvalScopeHashFor(input, operation)
  ) {
    throw new Error("Existing approval record does not match the approval request identity");
  }
  for (const reason of profileSwitchReasons(input.previousProfileId, input.profileId)) {
    if (!existing.reasons.includes(reason)) {
      throw new Error("Existing approval record does not include the requested profile-switch approval reason");
    }
  }
}

function operationDefaultReasons(operation: ApprovalOperation): string[] {
  switch (operation) {
    case "jobs.submit":
      return ["Live compute action requires explicit approval"];
    case "jobs.cancel":
      return ["Cancellation requires explicit approval"];
    case "jobs.retry":
      return ["Retry consumes additional compute and requires explicit approval"];
    case "transfers.execute":
      return ["Transfer execution requires explicit approval"];
    case "artifacts.fetch":
      return ["Artifact fetch requires explicit approval"];
    case "artifacts.fetch.batch":
      return ["Batch artifact fetch requires explicit approval"];
    case "artifacts.cleanup.execute":
      return ["Destructive artifact cleanup requires explicit approval"];
  }
}

function profileSwitchReasons(previousProfileId: string | undefined, profileId: string): string[] {
  if (!previousProfileId || previousProfileId === profileId) {
    return [];
  }
  return [`Cross-account profile switch: ${previousProfileId} -> ${profileId}`];
}

export function approvalStatus(input: ApprovalStatusInput, options: ApprovalOptions = {}): { approval: ApprovalRecord } {
  const approval = readApproval(input.approvalId, options);
  const refreshed = refreshExpiryState(approval, options.now ?? new Date());
  if (refreshed.state !== approval.state) {
    writeApprovalRecord(refreshed, options);
  }
  return { approval: refreshed };
}

export function decideApproval(input: ApprovalDecisionInput, options: ApprovalOptions = {}): { approval: ApprovalRecord } {
  const now = options.now ?? new Date();
  assertConfirmationToken(input.confirmationToken, options.confirmationToken, {
    missingMessage: "Approval decisions require a trusted confirmation token",
    mismatchMessage: "Invalid approval confirmation token"
  });
  const approval = refreshExpiryState(readApproval(input.approvalId, options), now);
  if (approval.state !== "required") {
    throw new Error(`Approval ${input.approvalId} is ${approval.state}; only required approvals can be decided`);
  }
  if (approval.remote_job_id !== undefined && approval.plan_hash === undefined) {
    // Adopted-PBS cancel approval: verify the decision against the remote_job_id binding, not plan_hash.
    if (approval.remote_job_id !== input.remoteJobId) {
      throw new Error("Approval decision remote_job_id does not match the requested approval");
    }
  } else {
    if (approval.plan_hash !== input.planHash) {
      throw new Error("Approval decision plan_hash does not match the requested approval");
    }
    if (approval.quota_snapshot_id !== input.quotaSnapshotId) {
      throw new Error("Approval decision quota_snapshot_id does not match the requested approval");
    }
  }

  const decided: ApprovalRecord = {
    ...approval,
    state: input.decision,
    decided_at: now.toISOString(),
    decided_by: input.decidedBy ? redactCommand(input.decidedBy) : "explicit-user-confirmation",
    ...(input.reason ? { decision_reason: redactCommand(input.reason) } : {})
  };
  writeApprovalRecord(decided, options);
  return { approval: decided };
}

export function consumeApproval(input: ApprovalConsumeInput, options: ApprovalOptions = {}): { approval: ApprovalRecord } {
  const now = options.now ?? new Date();
  const approval = refreshExpiryState(readApproval(input.approvalId, options), now);
  if (approval.state !== "approved") {
    throw new Error(`Approval ${input.approvalId} is ${approval.state}; only approved records can be consumed`);
  }
  if (input.operation && approval.operation !== input.operation) {
    throw new Error(`Approval ${input.approvalId} is for ${approval.operation}, not ${input.operation}`);
  }
  if (input.runId && approval.run_id !== input.runId) {
    throw new Error("Approval consume run_id does not match the approved record");
  }
  if (input.profileId && approval.profile_id !== input.profileId) {
    throw new Error("Approval consume profile_id does not match the approved record");
  }
  if (input.platform && approval.platform !== input.platform) {
    throw new Error("Approval consume platform does not match the approved record");
  }
  if (approval.used_at) {
    throw new Error(`Approval ${input.approvalId} has already been consumed`);
  }
  if (approval.remote_job_id !== undefined && approval.plan_hash === undefined) {
    // Adopted-PBS cancel approval: consume binds the remote_job_id, not plan_hash/quota_snapshot_id.
    // Fail-closed (NIT-1): the binding is checked UNCONDITIONALLY, exactly like plan_hash /
    // quota_snapshot_id below — consuming an approval that carries a remote_job_id REQUIRES the caller
    // to pass the matching remoteJobId. Omitting it must NOT silently skip the binding.
    if (input.remoteJobId === undefined || approval.remote_job_id !== input.remoteJobId) {
      throw new Error("Approval consume remote_job_id does not match the approved record");
    }
  } else {
    if (approval.plan_hash !== input.planHash) {
      throw new Error("Approval consume plan_hash does not match the approved record");
    }
    if (approval.quota_snapshot_id !== input.quotaSnapshotId) {
      throw new Error("Approval consume quota_snapshot_id does not match the approved record");
    }
  }
  const consumed: ApprovalRecord = {
    ...approval,
    used_at: now.toISOString(),
    consumed_by: redactCommand(input.consumedBy)
  };
  writeApprovalRecord(consumed, options);
  return { approval: consumed };
}

export function listApprovalRecords(options: ApprovalOptions = {}): ApprovalRecord[] {
  const dir = approvalDirectory(options);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readApproval(entry.name.slice(0, -".json".length), options))
    .sort((left, right) => right.requested_at.localeCompare(left.requested_at) || left.approval_id.localeCompare(right.approval_id));
}

// Redaction-safe enumeration for the approvals.list tool (M14). Deliberately projects ONLY identity and
// lifecycle fields so an operator/agent can find the approval id a token-gated op needs, without ever
// surfacing command_summary, resource_summary, or any decision secrets in the listing.
export interface ApprovalSummary {
  approval_id: string;
  run_id: string;
  profile_id: string;
  platform: Platform;
  operation: ApprovalOperation;
  state: ApprovalState;
  requested_at: string;
  expires_at: string;
  decided_at?: string;
}

export function listApprovals(options: ApprovalOptions = {}): { approvals: ApprovalSummary[] } {
  const records = listApprovalRecords(options); // existing enumerator, sorted requested_at desc
  return {
    approvals: records.map((record) => ({
      approval_id: record.approval_id,
      run_id: record.run_id,
      profile_id: record.profile_id,
      platform: record.platform,
      operation: record.operation,
      state: record.state,
      requested_at: record.requested_at,
      expires_at: record.expires_at,
      ...(record.decided_at ? { decided_at: record.decided_at } : {})
    }))
  };
}

function refreshExpiryState(approval: ApprovalRecord, now: Date): ApprovalRecord {
  if ((approval.state === "required" || approval.state === "approved") && Date.parse(approval.expires_at) <= now.getTime()) {
    return {
      ...approval,
      state: "expired"
    };
  }
  return approval;
}

function readApprovalIfExists(approvalId: string, options: ApprovalOptions): ApprovalRecord | null {
  const filePath = approvalPath(approvalId, options);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readApproval(approvalId, options);
}

export function readApproval(approvalId: string, options: ApprovalOptions = {}): ApprovalRecord {
  const filePath = approvalPath(approvalId, options);
  assertRealPathInside(filePath, approvalDirectory(options), "Approval file");
  const approval = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  assertApprovalRecord(approval);
  return approval;
}

function writeApprovalRecord(approval: ApprovalRecord, options: ApprovalOptions): void {
  assertApprovalRecord(approval);
  const dir = approvalDirectory(options);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${approval.approval_id}.json`), `${JSON.stringify(approval, null, 2)}\n`, "utf8");
}

function approvalPath(approvalId: string, options: ApprovalOptions): string {
  assertSafeApprovalId(approvalId);
  const dir = approvalDirectory(options);
  const candidate = path.join(dir, `${approvalId}.json`);
  const relative = path.relative(dir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Approval path must stay inside the approval directory");
  }
  return candidate;
}

function approvalDirectory(options: ApprovalOptions): string {
  return assertInsideRuntime(options.approvalDir ?? DEFAULT_APPROVAL_DIR, "Approval directory");
}

function assertFreshMatchingQuotaSnapshot(
  quotaSnapshotId: string,
  profileId: string,
  platform: Platform,
  now: Date,
  options: ApprovalOptions
): number {
  const snapshot = readQuotaSnapshot(quotaSnapshotId);
  const observedAt = assertQuotaSnapshotMatches(snapshot, { quotaSnapshotId, profileId, platform });
  const maxAgeMs = (options.quotaMaxAgeMinutes ?? DEFAULT_QUOTA_MAX_AGE_MINUTES) * 60 * 1000;
  if (now.getTime() - observedAt > maxAgeMs) {
    throw new Error(`Quota snapshot ${quotaSnapshotId} is stale for approval`);
  }
  return observedAt + maxAgeMs;
}

export function readQuotaSnapshot(quotaSnapshotId: string): QuotaSnapshot {
  assertSafeId(quotaSnapshotId, "quotaSnapshotId");
  const quotaDir = assertInsideRuntime(QUOTA_DIR, "Quota snapshot directory");
  const filePath = path.join(quotaDir, `${quotaSnapshotId}.json`);
  const relative = path.relative(quotaDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Quota snapshot path must stay inside the quota directory");
  }
  assertRealPathInside(filePath, quotaDir, "Quota snapshot file");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  const snapshot =
    raw && typeof raw === "object" && !Array.isArray(raw) && "snapshot" in raw
      ? (raw as { snapshot: unknown }).snapshot
      : raw;
  assertQuotaSnapshot(snapshot);
  return snapshot;
}

export function readFreshQuotaSnapshot(
  quotaSnapshotId: string,
  profileId: string,
  platform: Platform,
  now: Date,
  maxAgeMinutes: number = DEFAULT_QUOTA_MAX_AGE_MINUTES
): QuotaSnapshot {
  const snapshot = readQuotaSnapshot(quotaSnapshotId);
  const observedAt = assertQuotaSnapshotMatches(snapshot, { quotaSnapshotId, profileId, platform });
  if (now.getTime() - observedAt > maxAgeMinutes * 60 * 1000) {
    throw new Error(`Quota snapshot ${quotaSnapshotId} is stale (older than ${maxAgeMinutes} minutes)`);
  }
  return snapshot;
}

function approvalIdFor(
  runId: string,
  operation: ApprovalOperation,
  planHash: string,
  quotaSnapshotId: string,
  scopeHash?: string
): string {
  assertSafeRunId(runId, "runId");
  assertSafeId(operation, "operation");
  assertPlanHash(planHash);
  assertSafeId(quotaSnapshotId, "quotaSnapshotId");
  if (scopeHash) {
    assertPlanHash(scopeHash);
  }
  const operationPart = createHash("sha256").update(operation).digest("hex").slice(0, 8);
  const quotaPart = createHash("sha256").update(quotaSnapshotId).digest("hex").slice(0, 16);
  return `approval-${runId}-${operationPart}-${planHash.slice(0, 16)}-${quotaPart}${scopeHash ? `-${scopeHash.slice(0, 16)}` : ""}`;
}

// The remote_job_id binding accepts BOTH the PBS grammar (incl. the array `[]`/`[i]` forms) and the
// broad scheduler-token grammar (so the same primitive could bind any adopted id). The brackets are not
// in the approval_id charset, so adoptedCancelApprovalIdFor HASHES the id rather than embedding it raw.
function isAdoptedRemoteJobId(value: string): boolean {
  return isSafePbsJobId(value) || isSafeRemoteJobId(value);
}

// approval_id for an adopted-cancel approval: per-run + per-remote_job_id. The remote_job_id is HASHED
// (it may carry `[]` array brackets that the approval_id pattern forbids), so the id stays inside
// `^approval-[A-Za-z0-9_.:-]{1,220}$`. A `-adopt-` tag distinguishes it from the planned-job id shape.
function adoptedCancelApprovalIdFor(runId: string, remoteJobId: string): string {
  assertSafeRunId(runId, "runId");
  if (!isAdoptedRemoteJobId(remoteJobId)) {
    throw new Error(`Invalid remoteJobId for adopted cancel approval: ${remoteJobId}`);
  }
  const operationPart = createHash("sha256").update("jobs.cancel").digest("hex").slice(0, 8);
  const jobPart = createHash("sha256").update(remoteJobId).digest("hex").slice(0, 24);
  return `approval-${runId}-adopt-${operationPart}-${jobPart}`;
}

function approvalScopeHashFor(input: ApprovalRequestInput, operation: ApprovalOperation): string | undefined {
  if (
    (operation !== "artifacts.fetch" &&
      operation !== "artifacts.fetch.batch" &&
      operation !== "artifacts.cleanup.execute" &&
      operation !== "transfers.execute") ||
    !input.resourceSummary
  ) {
    return undefined;
  }
  // Uses the shared stableJson (lib/shared) for the canonical serialization. NOTE: stableJson
  // drops undefined-valued keys before hashing (canonicalize filters them) whereas the prior
  // local canonicalJson emitted `"key":undefined`; this is the intended consolidation and changes
  // the computed scope_hash (and any approval_id embedding it) for scope-bearing operations.
  return createHash("sha256").update(stableJson(input.resourceSummary)).digest("hex");
}

function normalizeExpiryHours(value: number | undefined): number {
  return boundedInteger(value, { default: DEFAULT_EXPIRY_HOURS, min: 1, max: MAX_EXPIRY_HOURS, label: "expiresInHours" });
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons.map((reason) => redactCommand(reason).trim()).filter(Boolean))].sort();
}

function assertPlanHash(planHash: string): void {
  if (!isHexDigest(planHash)) {
    throw new Error(`Invalid plan_hash: ${planHash}`);
  }
}

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(value) || value.startsWith(".") || value.includes("..")) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

