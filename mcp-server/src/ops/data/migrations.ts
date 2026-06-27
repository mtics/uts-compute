import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertInsideRuntime } from "../../core/paths.js";
import { assertConfirmationToken } from "../../lib/auth.js";
import { isHexDigest, safeTimestamp, stableJson } from "../../lib/shared.js";
import {
  type ValidationResult,
  validateAccessCheckResult,
  validateArtifactCleanupExecutionRecord,
  validateApprovalRecord,
  validateArtifactCleanupPlan,
  validateArtifactFetchBatchRecord,
  validateArtifactFetchRecord,
  validateArtifactManifest,
  validatePlannedJob,
  validatePlannedTransfer,
  validateQuotaSnapshot,
  validateRunRecord,
  validateStateMigrationApply,
  validateStateMigrationPlan,
  validateTransferExecutionRecord
} from "../../core/validation.js";
import type { JsonObject } from "../../core/types.js";

export type MigrationRecordStatus = "current" | "would-update" | "manual-review" | "blocked";
export type MigrationRecordAction = "none" | "add-schema-version" | "manual-review" | "invalid" | "blocked";

export interface MigrationRecordPlan {
  kind: string;
  path: string;
  id?: string;
  current_schema_version: string | null;
  target_schema_version: string;
  status: MigrationRecordStatus;
  action: MigrationRecordAction;
  valid: boolean;
  would_change_fields: string[];
  errors: string[];
  warnings: string[];
}

export interface StateMigrationPlan {
  mode: "dry-run";
  generated_at: string;
  target_schema_version: string;
  plan_hash: string;
  writes_planned: false;
  files_read: string[];
  files_would_write: string[];
  detected_schema_versions: string[];
  approval_state_would_change: false;
  run_state_would_change: false;
  summary: {
    total_records: number;
    current: number;
    would_update: number;
    manual_review: number;
    blocked: number;
    missing_schema_version: number;
    invalid: number;
  };
  records: MigrationRecordPlan[];
  cannot_migrate: Array<{
    kind: string;
    path: string;
    errors: string[];
  }>;
  warnings: string[];
}

export interface StateMigrationApplyInput {
  planHash: string;
  confirmationToken: string;
}

export interface StateMigrationApply {
  mode: "apply";
  generated_at: string;
  target_schema_version: string;
  plan_hash: string;
  writes_applied: boolean;
  backup_path?: string;
  files_backed_up: string[];
  files_written: string[];
  records_updated: Array<{
    kind: string;
    path: string;
    action: "add-schema-version";
    changed_fields: string[];
  }>;
  approval_state_changed: false;
  run_state_changed: false;
  rollback: {
    restore_from?: string;
    validation_command: "npm test";
  };
  warnings: string[];
}

export interface StateMigrationOptions {
  runtimeRoot?: string;
  now?: Date;
  confirmationToken?: string;
}

const TARGET_SCHEMA_VERSION = "0.1.0";
const DEFAULT_RUNTIME_ROOT = ".uts-computing";

export function planStateMigration(options: StateMigrationOptions = {}): { migration: StateMigrationPlan } {
  const runtimeRoot = assertInsideRuntime(options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "Migration runtime root");
  const records: MigrationRecordPlan[] = [];
  const filesRead: string[] = [];
  const rootExists = fs.existsSync(runtimeRoot);
  if (rootExists) {
    const realRoot = fs.realpathSync(runtimeRoot);
    scanRuntimeTree(runtimeRoot, realRoot, records, filesRead);
  }

  const filesWouldWrite = records
    .filter((record) => record.action === "add-schema-version")
    .map((record) => record.path)
    .sort();
  const detectedVersions = [
    ...new Set(records.map((record) => record.current_schema_version).filter((version): version is string => Boolean(version)))
  ].sort();
  const blockedRecords = records.filter((record) => record.status === "blocked");
  const migrationWithoutHash = {
    mode: "dry-run",
    generated_at: (options.now ?? new Date()).toISOString(),
    target_schema_version: TARGET_SCHEMA_VERSION,
    plan_hash: "",
    writes_planned: false,
    files_read: [...new Set(filesRead)].sort(),
    files_would_write: filesWouldWrite,
    detected_schema_versions: detectedVersions,
    approval_state_would_change: false,
    run_state_would_change: false,
    summary: {
      total_records: records.length,
      current: records.filter((record) => record.status === "current").length,
      would_update: records.filter((record) => record.status === "would-update").length,
      manual_review: records.filter((record) => record.status === "manual-review").length,
      blocked: blockedRecords.length,
      missing_schema_version: records.filter((record) => record.current_schema_version === null).length,
      invalid: records.filter((record) => record.action === "invalid" || record.action === "blocked").length
    },
    records: records.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)),
    cannot_migrate: blockedRecords.map((record) => ({
      kind: record.kind,
      path: record.path,
      errors: record.errors
    })),
    warnings: [
      "Dry-run only: no files were created, modified, deleted, or backed up",
      "No SSH, VPN, DNS, TCP, UTS scheduler, iHPC, rsync, or approval state transitions are performed",
      "files_would_write lists future apply candidates only; state.migrate.apply remains deferred",
      "Profile config, credentials, client manifests, and local secret files are not mutated by this tool"
    ]
  } satisfies StateMigrationPlan;
  const migration: StateMigrationPlan = {
    ...migrationWithoutHash,
    plan_hash: migrationPlanHash(migrationWithoutHash)
  };
  assertValidMigrationPlan(migration);

  return { migration };
}

export function applyStateMigration(
  input: StateMigrationApplyInput,
  options: StateMigrationOptions = {}
): { migration: StateMigrationApply } {
  assertConfirmationToken(input.confirmationToken, options.confirmationToken, {
    missingMessage: "state.migrate.apply requires a trusted confirmation token",
    mismatchMessage: "Invalid migration confirmation token"
  });
  const now = options.now ?? new Date();
  const runtimeRoot = assertInsideRuntime(options.runtimeRoot ?? DEFAULT_RUNTIME_ROOT, "Migration runtime root");
  const plan = planStateMigration({ ...options, now }).migration;
  assertPlanHash(input.planHash);
  if (input.planHash !== plan.plan_hash) {
    throw new Error("state.migrate.apply planHash does not match the current migration dry-run plan");
  }
  if (plan.cannot_migrate.length > 0) {
    throw new Error(`state.migrate.apply blocked by ${plan.cannot_migrate.length} record(s) requiring manual review`);
  }

  const recordsToUpdate = plan.records.filter((record) => record.action === "add-schema-version");
  if (recordsToUpdate.length === 0) {
    return {
      migration: assertValidMigrationApply({
        mode: "apply",
        generated_at: now.toISOString(),
        target_schema_version: TARGET_SCHEMA_VERSION,
        plan_hash: plan.plan_hash,
        writes_applied: false,
        files_backed_up: [],
        files_written: [],
        records_updated: [],
        approval_state_changed: false,
        run_state_changed: false,
        rollback: {
          validation_command: "npm test"
        },
        warnings: [
          "No migration writes were needed",
          "No SSH, VPN, DNS, TCP, UTS scheduler, iHPC, rsync, or approval state transitions were performed"
        ]
      })
    };
  }

  const realRoot = fs.realpathSync(runtimeRoot);
  const preparedRecords = recordsToUpdate.map((record) => {
    const candidate = candidateFromRuntimeRelativePath(record.path, runtimeRoot, realRoot);
    const original = JSON.parse(fs.readFileSync(candidate.absolutePath, "utf8")) as unknown;
    const migrated = withSchemaVersion(original, record);
    const validation = validateMigratedRecord(record.kind, migrated);
    if (!validation.valid) {
      throw new Error(`Migrated ${record.path} would be invalid: ${validation.errors.join("; ")}`);
    }
    return { record, candidate, migrated };
  });

  const backupDir = createBackupDirectory(runtimeRoot, now);
  const filesBackedUp: string[] = [];
  const filesWritten: string[] = [];
  const recordsUpdated: StateMigrationApply["records_updated"] = [];

  for (const { record, candidate, migrated } of preparedRecords) {
    const backupPath = backupStateFile(candidate.absolutePath, runtimeRoot, backupDir);
    filesBackedUp.push(relativeRuntimePath(backupPath, runtimeRoot));
    writeJsonAtomically(candidate.absolutePath, migrated);
    filesWritten.push(record.path);
    recordsUpdated.push({
      kind: record.kind,
      path: record.path,
      action: "add-schema-version",
      changed_fields: record.would_change_fields
    });
  }

  return {
    migration: assertValidMigrationApply({
      mode: "apply",
      generated_at: now.toISOString(),
      target_schema_version: TARGET_SCHEMA_VERSION,
      plan_hash: plan.plan_hash,
      writes_applied: true,
      backup_path: relativeRuntimePath(backupDir, runtimeRoot),
      files_backed_up: filesBackedUp.sort(),
      files_written: filesWritten.sort(),
      records_updated: recordsUpdated.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)),
      approval_state_changed: false,
      run_state_changed: false,
      rollback: {
        restore_from: relativeRuntimePath(backupDir, runtimeRoot),
        validation_command: "npm test"
      },
      warnings: [
        "Applied only additive schema_version fields to already-valid local state files",
        "Backups were written before mutation and can be restored from rollback.restore_from",
        "No SSH, VPN, DNS, TCP, UTS scheduler, iHPC, rsync, or approval state transitions were performed"
      ]
    })
  };
}

function scanRuntimeTree(
  runtimeRoot: string,
  realRoot: string,
  records: MigrationRecordPlan[],
  filesRead: string[]
): void {
  scanFlatJson(runtimeRoot, realRoot, "access", "access-check-result", validateAccessCheckResult, records, filesRead);
  scanFlatJson(runtimeRoot, realRoot, "approvals", "approval-record", validateApprovalRecord, records, filesRead);
  scanFlatJson(runtimeRoot, realRoot, "runs", "run-record", validateRunRecord, records, filesRead);
  scanQuotas(runtimeRoot, realRoot, records, filesRead);
  scanPlans(runtimeRoot, realRoot, records, filesRead);
  scanTransfers(runtimeRoot, realRoot, records, filesRead);
  scanArtifacts(runtimeRoot, realRoot, records, filesRead);
}

function scanFlatJson(
  runtimeRoot: string,
  realRoot: string,
  subdir: string,
  kind: string,
  validator: (value: unknown) => ValidationResult,
  records: MigrationRecordPlan[],
  filesRead: string[]
): void {
  for (const candidate of listJsonCandidates(path.join(runtimeRoot, subdir), runtimeRoot, realRoot)) {
    addValidatedRecord(candidate, kind, validator, records, filesRead);
  }
}

function scanQuotas(runtimeRoot: string, realRoot: string, records: MigrationRecordPlan[], filesRead: string[]): void {
  for (const candidate of listJsonCandidates(path.join(runtimeRoot, "quotas"), runtimeRoot, realRoot)) {
    addJsonRecord(candidate, records, filesRead, (value) => {
      if (isObject(value) && isObject(value.snapshot)) {
        return recordFromValidation(candidate.path, "quota-snapshot-wrapper", value.snapshot, validateQuotaSnapshot(value.snapshot), {
          versionField: "snapshot.schema_version"
        });
      }
      return recordFromValidation(candidate.path, "quota-snapshot", value, validateQuotaSnapshot(value));
    });
  }
}

function scanPlans(runtimeRoot: string, realRoot: string, records: MigrationRecordPlan[], filesRead: string[]): void {
  for (const candidate of listJsonCandidates(path.join(runtimeRoot, "plans"), runtimeRoot, realRoot)) {
    addValidatedRecord(candidate, "planned-job", validatePlannedJob, records, filesRead);
  }
}

function scanTransfers(runtimeRoot: string, realRoot: string, records: MigrationRecordPlan[], filesRead: string[]): void {
  const transferRoot = path.join(runtimeRoot, "transfers");
  for (const runDir of listRunDirectories(transferRoot, runtimeRoot, realRoot)) {
    const planCandidate = fileCandidate(path.join(runDir.absolutePath, "plan.json"), runtimeRoot, realRoot);
    if (planCandidate) {
      addValidatedRecord(planCandidate, "planned-transfer", validatePlannedTransfer, records, filesRead);
    }
    for (const candidate of listJsonCandidates(runDir.absolutePath, runtimeRoot, realRoot)) {
      if (!path.basename(candidate.absolutePath).startsWith("execute-")) {
        continue;
      }
      addValidatedRecord(candidate, "transfer-execution-record", validateTransferExecutionRecord, records, filesRead);
    }
  }
}

function scanArtifacts(runtimeRoot: string, realRoot: string, records: MigrationRecordPlan[], filesRead: string[]): void {
  const artifactRoot = path.join(runtimeRoot, "artifacts");
  for (const runDir of listRunDirectories(artifactRoot, runtimeRoot, realRoot)) {
    const manifestCandidate = fileCandidate(path.join(runDir.absolutePath, "manifest.json"), runtimeRoot, realRoot);
    if (manifestCandidate) {
      addValidatedRecord(manifestCandidate, "artifact-manifest", validateArtifactManifest, records, filesRead);
    }
    for (const candidate of listJsonCandidates(runDir.absolutePath, runtimeRoot, realRoot)) {
      const filename = path.basename(candidate.absolutePath);
      if (filename.startsWith("fetch-batch-")) {
        addValidatedRecord(candidate, "artifact-fetch-batch-record", validateArtifactFetchBatchRecord, records, filesRead);
      } else if (filename.startsWith("fetch-")) {
        addValidatedRecord(candidate, "artifact-fetch-record", validateArtifactFetchRecord, records, filesRead);
      } else if (filename.startsWith("cleanup-plan-")) {
        addValidatedRecord(candidate, "artifact-cleanup-plan", validateArtifactCleanupPlan, records, filesRead);
      } else if (filename.startsWith("cleanup-execute-")) {
        addValidatedRecord(candidate, "artifact-cleanup-execution-record", validateArtifactCleanupExecutionRecord, records, filesRead);
      }
    }
  }
}

interface CandidateFile {
  absolutePath: string;
  path: string;
  error?: string;
}

interface RuntimeDirectory {
  absolutePath: string;
  path: string;
}

function listJsonCandidates(dirPath: string, runtimeRoot: string, realRoot: string): CandidateFile[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const dirCandidate = fileSystemEntryInsideRoot(dirPath, realRoot);
  if (dirCandidate.error || !fs.lstatSync(dirPath).isDirectory()) {
    return [
      {
        absolutePath: dirPath,
        path: relativeRuntimePath(dirPath, runtimeRoot),
        error: dirCandidate.error ?? "Runtime state path is not a directory"
      }
    ];
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => fileCandidate(path.join(dirPath, entry.name), runtimeRoot, realRoot))
    .filter((candidate): candidate is CandidateFile => Boolean(candidate))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function listRunDirectories(dirPath: string, runtimeRoot: string, realRoot: string): RuntimeDirectory[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const dirCandidate = fileSystemEntryInsideRoot(dirPath, realRoot);
  if (dirCandidate.error || !fs.lstatSync(dirPath).isDirectory()) {
    return [];
  }
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const absolutePath = path.join(dirPath, entry.name);
      return {
        absolutePath,
        path: relativeRuntimePath(absolutePath, runtimeRoot)
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function fileCandidate(filePath: string, runtimeRoot: string, realRoot: string): CandidateFile | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const boundary = fileSystemEntryInsideRoot(filePath, realRoot);
  if (boundary.error) {
    return {
      absolutePath: filePath,
      path: relativeRuntimePath(filePath, runtimeRoot),
      error: boundary.error
    };
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    return {
      absolutePath: filePath,
      path: relativeRuntimePath(filePath, runtimeRoot),
      error: "Symlinked state files are not read by migration dry-run"
    };
  }
  if (!stat.isFile()) {
    return {
      absolutePath: filePath,
      path: relativeRuntimePath(filePath, runtimeRoot),
      error: "Runtime state entry is not a regular file"
    };
  }
  return {
    absolutePath: filePath,
    path: relativeRuntimePath(filePath, runtimeRoot)
  };
}

function candidateFromRuntimeRelativePath(
  runtimeRelativePath: string,
  runtimeRoot: string,
  realRoot: string
): CandidateFile {
  const candidate = fileCandidate(path.resolve(runtimeRoot, runtimeRelativePath), runtimeRoot, realRoot);
  if (!candidate || candidate.error) {
    throw new Error(candidate?.error ?? `Migration candidate is missing: ${runtimeRelativePath}`);
  }
  return candidate;
}

function fileSystemEntryInsideRoot(candidatePath: string, realRoot: string): { error?: string } {
  try {
    const realCandidate = fs.realpathSync(candidatePath);
    const relative = path.relative(realRoot, realCandidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { error: "Runtime state path resolves outside .uts-computing" };
    }
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function addValidatedRecord(
  candidate: CandidateFile,
  kind: string,
  validator: (value: unknown) => ValidationResult,
  records: MigrationRecordPlan[],
  filesRead: string[]
): void {
  addJsonRecord(candidate, records, filesRead, (value) => recordFromValidation(candidate.path, kind, value, validator(value)));
}

function addJsonRecord(
  candidate: CandidateFile,
  records: MigrationRecordPlan[],
  filesRead: string[],
  buildRecord: (value: unknown) => MigrationRecordPlan
): void {
  if (candidate.error) {
    records.push(blockedRecord(candidate.path, "unknown-state-file", [candidate.error]));
    return;
  }
  let rawText = "";
  try {
    rawText = fs.readFileSync(candidate.absolutePath, "utf8");
    filesRead.push(candidate.path);
    records.push(buildRecord(JSON.parse(rawText) as unknown));
  } catch (error) {
    records.push(blockedRecord(candidate.path, "unknown-state-file", [
      error instanceof Error ? error.message : String(error)
    ]));
  }
}

function recordFromValidation(
  filePath: string,
  kind: string,
  value: unknown,
  validation: ValidationResult,
  options: { versionField?: string } = {}
): MigrationRecordPlan {
  const version = schemaVersionOf(value);
  const id = idFromRecord(value);
  if (!validation.valid) {
    return {
      kind,
      path: filePath,
      ...(id ? { id } : {}),
      current_schema_version: version,
      target_schema_version: TARGET_SCHEMA_VERSION,
      status: "blocked",
      action: "invalid",
      valid: false,
      would_change_fields: [],
      errors: validation.errors,
      warnings: []
    };
  }
  if (version === TARGET_SCHEMA_VERSION) {
    return {
      kind,
      path: filePath,
      ...(id ? { id } : {}),
      current_schema_version: version,
      target_schema_version: TARGET_SCHEMA_VERSION,
      status: "current",
      action: "none",
      valid: true,
      would_change_fields: [],
      errors: [],
      warnings: []
    };
  }
  return {
    kind,
    path: filePath,
    ...(id ? { id } : {}),
    current_schema_version: null,
    target_schema_version: TARGET_SCHEMA_VERSION,
    status: "would-update",
    action: "add-schema-version",
    valid: true,
    would_change_fields: [options.versionField ?? "schema_version"],
    errors: [],
    warnings: []
  };
}

function blockedRecord(filePath: string, kind: string, errors: string[]): MigrationRecordPlan {
  return {
    kind,
    path: filePath,
    current_schema_version: null,
    target_schema_version: TARGET_SCHEMA_VERSION,
    status: "blocked",
    action: "blocked",
    valid: false,
    would_change_fields: [],
    errors,
    warnings: []
  };
}

function schemaVersionOf(value: unknown): string | null {
  if (!isObject(value)) {
    return null;
  }
  return typeof value.schema_version === "string" ? value.schema_version : null;
}

function idFromRecord(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  for (const key of ["run_id", "approval_id", "snapshot_id", "artifact_id", "profile_id"]) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withSchemaVersion(value: unknown, record: MigrationRecordPlan): unknown {
  if (!isObject(value)) {
    throw new Error(`Migration candidate is not an object: ${record.path}`);
  }
  if (record.kind === "quota-snapshot-wrapper") {
    if (!isObject(value.snapshot)) {
      throw new Error(`Quota snapshot wrapper is missing snapshot object: ${record.path}`);
    }
    return {
      ...value,
      snapshot: {
        ...value.snapshot,
        schema_version: TARGET_SCHEMA_VERSION
      }
    };
  }
  return {
    ...value,
    schema_version: TARGET_SCHEMA_VERSION
  };
}

function validateMigratedRecord(kind: string, value: unknown): ValidationResult {
  switch (kind) {
    case "access-check-result":
      return validateAccessCheckResult(value);
    case "approval-record":
      return validateApprovalRecord(value);
    case "run-record":
      return validateRunRecord(value);
    case "quota-snapshot":
      return validateQuotaSnapshot(value);
    case "quota-snapshot-wrapper":
      return isObject(value) ? validateQuotaSnapshot(value.snapshot) : invalidValidation("Quota snapshot wrapper is not an object");
    case "planned-job":
      return validatePlannedJob(value);
    case "planned-transfer":
      return validatePlannedTransfer(value);
    case "transfer-execution-record":
      return validateTransferExecutionRecord(value);
    case "artifact-manifest":
      return validateArtifactManifest(value);
    case "artifact-fetch-record":
      return validateArtifactFetchRecord(value);
    case "artifact-fetch-batch-record":
      return validateArtifactFetchBatchRecord(value);
    case "artifact-cleanup-plan":
      return validateArtifactCleanupPlan(value);
    case "artifact-cleanup-execution-record":
      return validateArtifactCleanupExecutionRecord(value);
    default:
      return invalidValidation(`Unsupported migration record kind: ${kind}`);
  }
}

function invalidValidation(message: string): ValidationResult {
  return {
    valid: false,
    errors: [message]
  };
}

function assertValidMigrationPlan(plan: StateMigrationPlan): void {
  const validation = validateStateMigrationPlan(plan);
  if (!validation.valid) {
    throw new Error(`Invalid state migration plan: ${validation.errors.join("; ")}`);
  }
}

function assertValidMigrationApply(apply: StateMigrationApply): StateMigrationApply {
  const validation = validateStateMigrationApply(apply);
  if (!validation.valid) {
    throw new Error(`Invalid state migration apply result: ${validation.errors.join("; ")}`);
  }
  return apply;
}

function createBackupDirectory(runtimeRoot: string, now: Date): string {
  const backupDir = path.join(runtimeRoot, "backups", safeTimestamp(now));
  // backupDir is built by joining runtimeRoot, so compare it against that same (non-realpath'd) root —
  // matching backupStateFile below. Realpath'ing runtimeRoot here would spuriously fail when the runtime
  // root contains a symlink (e.g. a /var -> /private/var per-user temp dir), because the freshly chosen
  // backupDir does not yet exist to realpath against.
  const relative = path.relative(runtimeRoot, backupDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Migration backup directory must stay inside the runtime root");
  }
  if (fs.existsSync(backupDir)) {
    throw new Error(`Migration backup directory already exists: ${relativeRuntimePath(backupDir, runtimeRoot)}`);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  return backupDir;
}

function backupStateFile(filePath: string, runtimeRoot: string, backupDir: string): string {
  const relative = path.relative(runtimeRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Migration backup source must stay inside the runtime root");
  }
  const backupPath = path.join(backupDir, relative);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function assertPlanHash(value: string): void {
  if (!isHexDigest(value)) {
    throw new Error("state.migrate.apply requires a valid migration planHash");
  }
}

function migrationPlanHash(plan: StateMigrationPlan): string {
  return createHash("sha256")
    .update(
      stableJson({
        target_schema_version: plan.target_schema_version,
        files_would_write: plan.files_would_write,
        records: plan.records.map((record) => ({
          kind: record.kind,
          path: record.path,
          id: record.id,
          current_schema_version: record.current_schema_version,
          target_schema_version: record.target_schema_version,
          status: record.status,
          action: record.action,
          valid: record.valid,
          would_change_fields: record.would_change_fields,
          errors: record.errors,
          warnings: record.warnings
        })),
        cannot_migrate: plan.cannot_migrate
      })
    )
    .digest("hex");
}

// Report a candidate path RELATIVE TO THE RUNTIME ROOT (e.g. "runs/<id>.json"), not projectRoot. The
// runtime root defaults to a per-user dir (core/paths.ts:runtimeBaseDir), so anchoring on projectRoot
// would render every path as "<outside-project>" on a real install and break apply's re-resolution.
// `runtimeRoot` is the same in-scope resolved root used to build the candidate's absolute path, so the
// result is a clean subpath that candidateFromRuntimeRelativePath can resolve back.
function relativeRuntimePath(candidatePath: string, runtimeRoot: string): string {
  const relative = path.relative(runtimeRoot, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "<outside-runtime>";
  }
  return relative;
}
