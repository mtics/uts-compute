import fs from "node:fs";
import type { AnySchema, ErrorObject } from "ajv";
import * as Ajv2020Module from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import { resolveProjectPath } from "./paths.js";
import type {
  AccessCheckResult,
  ArtifactCleanupExecutionRecord,
  ApprovalRecord,
  ArtifactCleanupPlanRecord,
  ArtifactFetchBatchRecord,
  ArtifactFetchRecord,
  ArtifactManifest,
  ArtifactSummaryRecord,
  ComputeProfile,
  DocsCacheRecord,
  JobSpec,
  OnboardingRecord,
  PlannedJob,
  PlannedTransfer,
  QuotaSnapshot,
  RunRecord,
  TransferExecutionRecord,
  TransferPlan
} from "./types.js";

const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module.Ajv2020 }).default;
const addFormats = (addFormatsModule as unknown as { default: (ajv: InstanceType<typeof Ajv2020>) => void }).default;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(name: string): AnySchema {
  const schemaPath = resolveProjectPath(`schemas/${name}`);
  return JSON.parse(fs.readFileSync(schemaPath, "utf8")) as AnySchema;
}

const validateProfileSchema = ajv.compile(loadSchema("profile.schema.json"));
const validateApprovalRecordSchema = ajv.compile(loadSchema("approval-record.schema.json"));
const validateAccessCheckResultSchema = ajv.compile(loadSchema("access-check-result.schema.json"));
const validateQuotaSnapshotSchema = ajv.compile(loadSchema("quota-snapshot.schema.json"));
const validateOnboardingRecordSchema = ajv.compile(loadSchema("onboarding-record.schema.json"));
const validateJobSpecSchema = ajv.compile(loadSchema("job-spec.schema.json"));
const validatePlannedJobSchema = ajv.compile(loadSchema("planned-job.schema.json"));
const validateRunRecordSchema = ajv.compile(loadSchema("run-record.schema.json"));
const validateTransferPlanSchema = ajv.compile(loadSchema("transfer-plan.schema.json"));
const validatePlannedTransferSchema = ajv.compile(loadSchema("planned-transfer.schema.json"));
const validateTransferExecutionRecordSchema = ajv.compile(loadSchema("transfer-execution-record.schema.json"));
const validateArtifactManifestSchema = ajv.compile(loadSchema("artifact-manifest.schema.json"));
const validateArtifactFetchRecordSchema = ajv.compile(loadSchema("artifact-fetch-record.schema.json"));
const validateArtifactFetchBatchRecordSchema = ajv.compile(loadSchema("artifact-fetch-batch-record.schema.json"));
const validateArtifactSummarySchema = ajv.compile(loadSchema("artifact-summary.schema.json"));
const validateArtifactCleanupPlanSchema = ajv.compile(loadSchema("artifact-cleanup-plan.schema.json"));
const validateArtifactCleanupExecutionRecordSchema = ajv.compile(loadSchema("artifact-cleanup-execution-record.schema.json"));
const validateDocsCacheRecordSchema = ajv.compile(loadSchema("docs-cache-record.schema.json"));
const validateStateMigrationPlanSchema = ajv.compile(loadSchema("state-migration-plan.schema.json"));
const validateStateMigrationApplySchema = ajv.compile(loadSchema("state-migration-apply-record.schema.json"));

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const pathPrefix = error.instancePath || "/";
    return `${pathPrefix} ${error.message ?? "is invalid"}`;
  });
}

export function validateProfile(profile: unknown): ValidationResult {
  const valid = validateProfileSchema(profile) === true;
  return { valid, errors: formatErrors(validateProfileSchema.errors) };
}

export function assertProfile(profile: unknown): asserts profile is ComputeProfile {
  const result = validateProfile(profile);
  if (!result.valid) {
    throw new Error(`Invalid profile: ${result.errors.join("; ")}`);
  }
}

export function validateApprovalRecord(approvalRecord: unknown): ValidationResult {
  const valid = validateApprovalRecordSchema(approvalRecord) === true;
  return { valid, errors: formatErrors(validateApprovalRecordSchema.errors) };
}

export function assertApprovalRecord(approvalRecord: unknown): asserts approvalRecord is ApprovalRecord {
  const result = validateApprovalRecord(approvalRecord);
  if (!result.valid) {
    throw new Error(`Invalid approval record: ${result.errors.join("; ")}`);
  }
}

export function validateAccessCheckResult(accessCheck: unknown): ValidationResult {
  const valid = validateAccessCheckResultSchema(accessCheck) === true;
  return { valid, errors: formatErrors(validateAccessCheckResultSchema.errors) };
}

export function assertAccessCheckResult(accessCheck: unknown): asserts accessCheck is AccessCheckResult {
  const result = validateAccessCheckResult(accessCheck);
  if (!result.valid) {
    throw new Error(`Invalid access check result: ${result.errors.join("; ")}`);
  }
}

export function validateQuotaSnapshot(quotaSnapshot: unknown): ValidationResult {
  const valid = validateQuotaSnapshotSchema(quotaSnapshot) === true;
  return { valid, errors: formatErrors(validateQuotaSnapshotSchema.errors) };
}

export function assertQuotaSnapshot(quotaSnapshot: unknown): asserts quotaSnapshot is QuotaSnapshot {
  const result = validateQuotaSnapshot(quotaSnapshot);
  if (!result.valid) {
    throw new Error(`Invalid quota snapshot: ${result.errors.join("; ")}`);
  }
}

export function validateOnboardingRecord(record: unknown): ValidationResult {
  const valid = validateOnboardingRecordSchema(record) === true;
  return { valid, errors: formatErrors(validateOnboardingRecordSchema.errors) };
}

export function assertOnboardingRecord(record: unknown): asserts record is OnboardingRecord {
  const result = validateOnboardingRecord(record);
  if (!result.valid) {
    throw new Error(`Invalid onboarding record: ${result.errors.join("; ")}`);
  }
}

export function validateJobSpec(jobSpec: unknown): ValidationResult {
  const valid = validateJobSpecSchema(jobSpec) === true;
  return { valid, errors: formatErrors(validateJobSpecSchema.errors) };
}

export function assertJobSpec(jobSpec: unknown): asserts jobSpec is JobSpec {
  const result = validateJobSpec(jobSpec);
  if (!result.valid) {
    throw new Error(`Invalid job spec: ${result.errors.join("; ")}`);
  }
}

export function validatePlannedJob(plan: unknown): ValidationResult {
  const valid = validatePlannedJobSchema(plan) === true;
  return { valid, errors: formatErrors(validatePlannedJobSchema.errors) };
}

export function assertPlannedJob(plan: unknown): asserts plan is PlannedJob {
  const result = validatePlannedJob(plan);
  if (!result.valid) {
    throw new Error(`Invalid planned job artifact: ${result.errors.join("; ")}`);
  }
}

export function validateRunRecord(runRecord: unknown): ValidationResult {
  const valid = validateRunRecordSchema(runRecord) === true;
  return { valid, errors: formatErrors(validateRunRecordSchema.errors) };
}

export function assertRunRecord(runRecord: unknown): asserts runRecord is RunRecord {
  const result = validateRunRecord(runRecord);
  if (!result.valid) {
    throw new Error(`Invalid run record: ${result.errors.join("; ")}`);
  }
}

export function validateTransferPlan(transferPlan: unknown): ValidationResult {
  const valid = validateTransferPlanSchema(transferPlan) === true;
  return { valid, errors: formatErrors(validateTransferPlanSchema.errors) };
}

export function assertTransferPlan(transferPlan: unknown): asserts transferPlan is TransferPlan {
  const result = validateTransferPlan(transferPlan);
  if (!result.valid) {
    throw new Error(`Invalid transfer plan: ${result.errors.join("; ")}`);
  }
}

export function validatePlannedTransfer(transferPlan: unknown): ValidationResult {
  const valid = validatePlannedTransferSchema(transferPlan) === true;
  return { valid, errors: formatErrors(validatePlannedTransferSchema.errors) };
}

export function assertPlannedTransfer(transferPlan: unknown): asserts transferPlan is PlannedTransfer {
  const result = validatePlannedTransfer(transferPlan);
  if (!result.valid) {
    throw new Error(`Invalid planned transfer artifact: ${result.errors.join("; ")}`);
  }
}

export function validateTransferExecutionRecord(record: unknown): ValidationResult {
  const valid = validateTransferExecutionRecordSchema(record) === true;
  return { valid, errors: formatErrors(validateTransferExecutionRecordSchema.errors) };
}

export function assertTransferExecutionRecord(record: unknown): asserts record is TransferExecutionRecord {
  const result = validateTransferExecutionRecord(record);
  if (!result.valid) {
    throw new Error(`Invalid transfer execution record: ${result.errors.join("; ")}`);
  }
}

export function validateArtifactManifest(manifest: unknown): ValidationResult {
  const valid = validateArtifactManifestSchema(manifest) === true;
  return { valid, errors: formatErrors(validateArtifactManifestSchema.errors) };
}

export function assertArtifactManifest(manifest: unknown): asserts manifest is ArtifactManifest {
  const result = validateArtifactManifest(manifest);
  if (!result.valid) {
    throw new Error(`Invalid artifact manifest: ${result.errors.join("; ")}`);
  }
}

export function validateArtifactFetchRecord(record: unknown): ValidationResult {
  const valid = validateArtifactFetchRecordSchema(record) === true;
  return { valid, errors: formatErrors(validateArtifactFetchRecordSchema.errors) };
}

export function assertArtifactFetchRecord(record: unknown): asserts record is ArtifactFetchRecord {
  const result = validateArtifactFetchRecord(record);
  if (!result.valid) {
    throw new Error(`Invalid artifact fetch record: ${result.errors.join("; ")}`);
  }
}

export function validateArtifactFetchBatchRecord(record: unknown): ValidationResult {
  const valid = validateArtifactFetchBatchRecordSchema(record) === true;
  return { valid, errors: formatErrors(validateArtifactFetchBatchRecordSchema.errors) };
}

export function assertArtifactFetchBatchRecord(record: unknown): asserts record is ArtifactFetchBatchRecord {
  const result = validateArtifactFetchBatchRecord(record);
  if (!result.valid) {
    throw new Error(`Invalid artifact batch fetch record: ${result.errors.join("; ")}`);
  }
}

export function validateArtifactSummary(summary: unknown): ValidationResult {
  const valid = validateArtifactSummarySchema(summary) === true;
  return { valid, errors: formatErrors(validateArtifactSummarySchema.errors) };
}

export function assertArtifactSummary(summary: unknown): asserts summary is ArtifactSummaryRecord {
  const result = validateArtifactSummary(summary);
  if (!result.valid) {
    throw new Error(`Invalid artifact summary: ${result.errors.join("; ")}`);
  }
}

export function validateArtifactCleanupPlan(cleanupPlan: unknown): ValidationResult {
  const valid = validateArtifactCleanupPlanSchema(cleanupPlan) === true;
  return { valid, errors: formatErrors(validateArtifactCleanupPlanSchema.errors) };
}

export function assertArtifactCleanupPlan(cleanupPlan: unknown): asserts cleanupPlan is ArtifactCleanupPlanRecord {
  const result = validateArtifactCleanupPlan(cleanupPlan);
  if (!result.valid) {
    throw new Error(`Invalid artifact cleanup plan: ${result.errors.join("; ")}`);
  }
}

export function validateArtifactCleanupExecutionRecord(record: unknown): ValidationResult {
  const valid = validateArtifactCleanupExecutionRecordSchema(record) === true;
  return { valid, errors: formatErrors(validateArtifactCleanupExecutionRecordSchema.errors) };
}

export function assertArtifactCleanupExecutionRecord(record: unknown): asserts record is ArtifactCleanupExecutionRecord {
  const result = validateArtifactCleanupExecutionRecord(record);
  if (!result.valid) {
    throw new Error(`Invalid artifact cleanup execution record: ${result.errors.join("; ")}`);
  }
}

export function validateDocsCacheRecord(record: unknown): ValidationResult {
  const valid = validateDocsCacheRecordSchema(record) === true;
  return { valid, errors: formatErrors(validateDocsCacheRecordSchema.errors) };
}

export function assertDocsCacheRecord(record: unknown): asserts record is DocsCacheRecord {
  const result = validateDocsCacheRecord(record);
  if (!result.valid) {
    throw new Error(`Invalid docs cache record: ${result.errors.join("; ")}`);
  }
}

export function validateStateMigrationPlan(plan: unknown): ValidationResult {
  const valid = validateStateMigrationPlanSchema(plan) === true;
  return { valid, errors: formatErrors(validateStateMigrationPlanSchema.errors) };
}

export function validateStateMigrationApply(apply: unknown): ValidationResult {
  const valid = validateStateMigrationApplySchema(apply) === true;
  return { valid, errors: formatErrors(validateStateMigrationApplySchema.errors) };
}
