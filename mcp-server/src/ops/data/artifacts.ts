import crypto from "node:crypto";
import { assertSafeApprovalId, assertSafeRunId } from "../../core/ids.js";
import fs from "node:fs";
import path from "node:path";
import { runProcess } from "../../lib/process.js";
import {
  pyImports,
  PY_FAIL_FIXED,
  PY_FAIL_CODED,
  PY_DECODE_SPEC,
  PY_INSIDE_REALPATH,
  PY_SHA256_FILE
} from "../../lib/remote-python.js";
import { assertApprovalBoundTo } from "../../lib/auth.js";
import { approvalStatus, consumeApproval } from "../approvals/approvals.js";
import { redactCommand, readRunRecord, recordOperationEvidence } from "../../core/audit.js";
import { maskHostAlias, summarizeRemoteFailure } from "../../lib/redact.js";
import {
  assertSafeRemotePath,
  boundedInteger,
  canonicalize,
  encodeSpec,
  isHexDigest,
  isInsideRemoteRoot,
  isSafeRemotePath,
  normalizeTimeout,
  parseJsonLastLine,
  safeTimestamp,
  sha256Hex,
  sshTimeoutSeconds,
  stableJson,
  stripTrailingSlash
} from "../../lib/shared.js";
import { sshSingleHopArgs } from "../../lib/ssh.js";
import type { CommandResult } from "../../core/access.js";
import { getProfile, maskUserRootPath, userRootPrefixes } from "../../core/config.js";
import { assertInsideRuntime, assertRealPathInsideRealRoot, RUNTIME_DIRS } from "../../core/paths.js";
import { runRecordRoot, writeEvidenceJson } from "../../lib/evidence.js";
import { readVerifiedPlan } from "../plans/plan-store.js";
import type {
  ArtifactCleanupExecutionRecord,
  ApprovalRecord,
  ArtifactCleanupPlanRecord,
  ArtifactEntry,
  ArtifactFetchRecord,
  ArtifactKind,
  ArtifactManifest,
  ArtifactManifestEntry,
  ArtifactSummaryRecord,
  ComputeProfile,
  PlannedJob,
  RunRecord
} from "../../core/types.js";
import {
  assertArtifactCleanupExecutionRecord,
  assertArtifactCleanupPlan,
  assertArtifactFetchBatchRecord,
  assertArtifactFetchRecord,
  assertArtifactManifest,
  assertArtifactSummary
} from "../../core/validation.js";

export interface ArtifactOptions {
  timeoutMs?: number;
  executor?: ArtifactExecutor;
  planDir?: string;
  auditDir?: string;
  approvalDir?: string;
  artifactDir?: string;
  configPath?: string;
  now?: Date;
}

export type ArtifactExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin?: string
) => Promise<CommandResult>;

interface ArtifactListResult {
  mode: "read-only";
  run_id: string;
  profile_id: string;
  platform: string;
  observed_at: string;
  max_entries: number;
  checksum_max_bytes: number;
  manifest_hash: string;
  artifacts: ArtifactEntry[];
  truncated: boolean;
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
  evidence_path?: string;
}

interface ArtifactFetchResult {
  mode: "live";
  run_id: string;
  profile_id: string;
  platform: string;
  artifact_id: string;
  artifact_path: string;
  local_path: string;
  size_bytes: number;
  sha256: string;
  approval_id?: string;
  fetched_at: string;
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
  run_record_path?: string;
  evidence_path?: string;
}

interface ArtifactBatchFetchFile {
  artifact_id: string;
  artifact_path: string;
  local_path: string;
  size_bytes: number;
  sha256: string;
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
}

interface ArtifactBatchFetchResult {
  mode: "live";
  run_id: string;
  profile_id: string;
  platform: string;
  artifact_ids: string[];
  manifest_hash: string;
  approval_id?: string;
  max_bytes_per_file: number;
  max_total_bytes: number;
  total_size_bytes: number;
  fetched_at: string;
  files: ArtifactBatchFetchFile[];
  run_record_path?: string;
  evidence_path?: string;
}

interface ArtifactCleanupExecutionResult {
  mode: "live";
  run_id: string;
  profile_id: string;
  platform: string;
  approval_id: string;
  manifest_hash: string;
  artifact_ids: string[];
  cleaned_at: string;
  remote_deleted_files: string[];
  remote_missing: string[];
  remote_total_deleted_bytes: number;
  local_deleted_files: string[];
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
  evidence_path: string;
  run_record_path: string;
}

interface RemoteCleanupTarget {
  artifact_id: string;
  path: string;
  allowed_root: string;
  size_bytes: number;
  sha256: string;
}

interface RemoteCleanupResult {
  deleted_files: string[];
  missing: string[];
  total_deleted_bytes: number;
}

// Timeout policy (per-module, deliberate): standard 10s default / 30s cap shared by the middle
// modules. Named consts so the policy stays explicit, not folded into a shared bound.
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_MAX_ENTRIES = 200;
const MAX_ENTRIES = 2000;
const DEFAULT_CHECKSUM_MAX_BYTES = 5_000_000;
const MAX_CHECKSUM_MAX_BYTES = 50_000_000;
const DEFAULT_FETCH_MAX_BYTES = 10_000_000;
const MAX_FETCH_BYTES = 50_000_000;
const MAX_BATCH_ARTIFACTS = 100;
const DEFAULT_BATCH_TOTAL_BYTES = 50_000_000;
const MAX_BATCH_TOTAL_BYTES = 50_000_000;
const DEFAULT_ARTIFACT_DIR: string = RUNTIME_DIRS.artifacts;
const MAX_CLEANUP_REMOTE_ENTRIES = 2000;

export async function listArtifacts(
  input: { runId: string; maxEntries?: number; checksumMaxBytes?: number },
  options: ArtifactOptions = {}
): Promise<{ artifacts: ArtifactListResult }> {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const maxEntries = normalizeMaxEntries(input.maxEntries);
  const checksumMaxBytes = normalizeByteLimit(input.checksumMaxBytes, DEFAULT_CHECKSUM_MAX_BYTES, MAX_CHECKSUM_MAX_BYTES, "checksumMaxBytes");
  const executor = options.executor ?? defaultArtifactExecutor;
  const plan = readVerifiedPlan(input.runId, options.planDir);
  const profile = getProfile(plan.profile_id, options.configPath);
  const outputPaths = plannedOutputPaths(plan, profile);
  const spec = encodeSpec({
    workdir: plan.normalized_job_spec.workdir,
    outputs: outputPaths,
    max_entries: maxEntries,
    checksum_max_bytes: checksumMaxBytes
  });
  const args = sshArtifactArgs(profile.login.host_alias, timeoutMs, spec);
  const result = await executor("ssh", args, timeoutMs, ARTIFACT_LIST_PY);
  if (result.exitCode !== 0) {
    throw new Error(`artifact listing failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  const parsed = parseArtifactList(result.stdout, outputPaths, userRootPrefixes(profile));
  const manifestPath = writeArtifactManifest(plan, now, parsed.artifacts, parsed.truncated, options.artifactDir);
  const manifestHash = sha256Hex(fs.readFileSync(manifestPath));
  const publicArtifacts = parsed.artifacts.map(publicArtifactEntry);
  const evidencePath = writeArtifactEvidence(
    "list",
    plan.run_id,
    now,
    {
      command: redactedArtifactCommand(args, profile.login.host_alias, spec),
      exit_code: result.exitCode,
      timed_out: Boolean(result.timedOut),
      stdout: redactCommand(result.stdout),
      stderr: redactCommand(result.stderr),
      manifest_path: manifestPath,
      artifacts: publicArtifacts,
      truncated: parsed.truncated
    },
    options.artifactDir
  );

  return {
    artifacts: {
      mode: "read-only",
      run_id: plan.run_id,
      profile_id: plan.profile_id,
      platform: plan.platform,
      observed_at: now.toISOString(),
      max_entries: maxEntries,
      checksum_max_bytes: checksumMaxBytes,
      manifest_hash: manifestHash,
      artifacts: publicArtifacts,
      truncated: parsed.truncated,
      command: redactedArtifactCommand(args, profile.login.host_alias, spec),
      evidence_path: evidencePath
    }
  };
}

export async function fetchArtifact(
  input: { runId: string; artifactId: string; approvalId?: string; maxBytes?: number },
  options: ArtifactOptions = {}
): Promise<{ fetch: ArtifactFetchResult }> {
  assertSafeRunId(input.runId);
  assertSafeArtifactId(input.artifactId);
  if (input.approvalId !== undefined) {
    assertSafeApprovalId(input.approvalId);
  }
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const maxBytes = normalizeByteLimit(input.maxBytes, DEFAULT_FETCH_MAX_BYTES, MAX_FETCH_BYTES, "maxBytes");
  const executor = options.executor ?? defaultArtifactExecutor;
  const plan = readVerifiedPlan(input.runId, options.planDir);
  const profile = getProfile(plan.profile_id, options.configPath);
  const runRecord = readRunRecord(plan.run_id, options.auditDir);
  const planHash = requireRunPlanHash(runRecord);
  const quotaSnapshotId = requireRunQuotaSnapshotId(runRecord);
  if (planHash !== plan.plan_hash) {
    throw new Error("Run record plan_hash does not match the saved plan artifact");
  }
  // artifacts.fetch is autonomous: the verified plan_hash, latest manifest, opaque artifact id,
  // byte cap, and SHA-256 verification are the gate. A token approval is accepted but not required.
  let approval: ApprovalRecord | undefined;
  if (input.approvalId) {
    approval = approvalStatus({ approvalId: input.approvalId }, { approvalDir: options.approvalDir, now }).approval;
    assertArtifactFetchApproval(approval, runRecord, planHash, quotaSnapshotId);
  }

  const outputPaths = plannedOutputPaths(plan, profile);
  const userPrefixes = userRootPrefixes(profile);
  const manifestEntry = readArtifactManifestEntry(plan.run_id, input.artifactId, options.artifactDir);
  if (manifestEntry.kind !== "file") {
    throw new Error("artifacts.fetch can only fetch file artifacts from the latest manifest");
  }
  const artifactPath = resolveArtifactPath(manifestEntry.remote_path, plan, outputPaths);
  const allowedRoot = containingOutputRoot(artifactPath, outputPaths);
  const spec = encodeSpec({
    workdir: plan.normalized_job_spec.workdir,
    path: artifactPath,
    allowed_root: allowedRoot,
    max_bytes: maxBytes
  });
  const args = sshArtifactArgs(profile.login.host_alias, timeoutMs, spec);

  if (approval) {
    consumeApproval(
      {
        approvalId: approval.approval_id,
        runId: runRecord.run_id,
        profileId: runRecord.profile_id,
        platform: runRecord.platform,
        operation: "artifacts.fetch",
        planHash,
        quotaSnapshotId,
        consumedBy: `artifacts.fetch:${redactRemotePath(artifactPath, userPrefixes)}`
      },
      { approvalDir: options.approvalDir, now }
    );
  }

  const result = await executor("ssh", args, timeoutMs, ARTIFACT_FETCH_PY);
  if (result.exitCode !== 0) {
    throw new Error(`artifact fetch failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  const fetched = parseArtifactFetch(result.stdout, maxBytes);
  const content = Buffer.from(fetched.content_b64, "base64");
  if (content.length !== fetched.size_bytes) {
    throw new Error("Fetched artifact content length did not match the remote size");
  }
  const localPath = localArtifactPath(plan.run_id, artifactPath, plan, options.artifactDir);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, content);
  const localSha256 = sha256Hex(content);
  if (localSha256 !== fetched.sha256) {
    throw new Error("Fetched artifact checksum did not match the remote checksum");
  }
  if (manifestEntry.sha256 && manifestEntry.sha256 !== fetched.sha256) {
    throw new Error("Fetched artifact checksum did not match the manifest checksum");
  }

  const evidencePath = writeArtifactEvidence(
    "fetch",
    plan.run_id,
    now,
    {
      command: redactedArtifactCommand(args, profile.login.host_alias, spec),
      artifact_path: redactRemotePath(artifactPath, userPrefixes),
      local_path: localPath,
      size_bytes: fetched.size_bytes,
      sha256: fetched.sha256
    },
    options.artifactDir,
    {
      profile_id: plan.profile_id,
      platform: plan.platform,
      artifact_id: input.artifactId,
      ...(approval ? { approval_id: approval.approval_id } : {})
    }
  );

  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "artifact-fetch",
      summary: `Fetched artifact ${redactRemotePath(artifactPath, userPrefixes)}`,
      redacted_command: "ssh <profile-host> python3 - <artifact-fetch-spec>"
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    fetch: {
      mode: "live",
      run_id: plan.run_id,
      profile_id: plan.profile_id,
      platform: plan.platform,
      artifact_id: input.artifactId,
      artifact_path: redactRemotePath(artifactPath, userPrefixes),
      local_path: localPath,
      size_bytes: fetched.size_bytes,
      sha256: fetched.sha256,
      ...(approval ? { approval_id: approval.approval_id } : {}),
      fetched_at: now.toISOString(),
      command: redactedArtifactCommand(args, profile.login.host_alias, spec),
      run_record_path: runRecordPath,
      evidence_path: evidencePath
    }
  };
}

export async function fetchArtifactsBatch(
  input: {
    runId: string;
    manifestHash: string;
    artifactIds: string[];
    approvalId?: string;
    maxBytesPerFile?: number;
    maxTotalBytes?: number;
  },
  options: ArtifactOptions = {}
): Promise<{ fetch_batch: ArtifactBatchFetchResult }> {
  assertSafeRunId(input.runId);
  assertSha256(input.manifestHash, "manifestHash");
  const artifactIds = normalizeArtifactIds(input.artifactIds);
  if (input.approvalId !== undefined) {
    assertSafeApprovalId(input.approvalId);
  }
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const maxBytesPerFile = normalizeByteLimit(input.maxBytesPerFile, DEFAULT_FETCH_MAX_BYTES, MAX_FETCH_BYTES, "maxBytesPerFile");
  const maxTotalBytes = normalizeByteLimit(
    input.maxTotalBytes,
    Math.min(DEFAULT_BATCH_TOTAL_BYTES, maxBytesPerFile * artifactIds.length),
    MAX_BATCH_TOTAL_BYTES,
    "maxTotalBytes"
  );
  const executor = options.executor ?? defaultArtifactExecutor;
  const plan = readVerifiedPlan(input.runId, options.planDir);
  const profile = getProfile(plan.profile_id, options.configPath);
  const runRecord = readRunRecord(plan.run_id, options.auditDir);
  const planHash = requireRunPlanHash(runRecord);
  const quotaSnapshotId = requireRunQuotaSnapshotId(runRecord);
  if (planHash !== plan.plan_hash) {
    throw new Error("Run record plan_hash does not match the saved plan artifact");
  }
  const outputPaths = plannedOutputPaths(plan, profile);
  const userPrefixes = userRootPrefixes(profile);
  const manifest = readArtifactManifest(plan.run_id, options.artifactDir);
  const manifestHash = artifactManifestHash(plan.run_id, options.artifactDir);
  if (manifestHash !== input.manifestHash) {
    throw new Error("Artifact manifest hash does not match the batch fetch request");
  }
  // artifacts.fetch.batch is autonomous: the manifest hash binding, per-file and total byte caps,
  // and SHA-256 verification are the gate. A token approval is accepted but not required.
  let approval: ApprovalRecord | undefined;
  if (input.approvalId) {
    approval = approvalStatus({ approvalId: input.approvalId }, { approvalDir: options.approvalDir, now }).approval;
    assertArtifactBatchFetchApproval(approval, runRecord, planHash, quotaSnapshotId, {
      artifactIds,
      manifestHash,
      maxBytesPerFile,
      maxTotalBytes
    });
  }
  const prepared = artifactIds.map((artifactId) => {
    const manifestEntry = findArtifactManifestEntry(manifest, artifactId);
    if (manifestEntry.kind !== "file") {
      throw new Error("artifacts.fetch.batch can only fetch file artifacts from the latest manifest");
    }
    if (typeof manifestEntry.size_bytes !== "number" || manifestEntry.size_bytes < 0) {
      throw new Error(`Artifact ${artifactId} is missing manifest size evidence required for batch fetch`);
    }
    if (manifestEntry.size_bytes > maxBytesPerFile) {
      throw new Error(`Artifact ${artifactId} exceeds maxBytesPerFile before fetch`);
    }
    const artifactPath = resolveArtifactPath(manifestEntry.remote_path, plan, outputPaths);
    return {
      artifactId,
      artifactPath,
      allowedRoot: containingOutputRoot(artifactPath, outputPaths),
      expectedSha256: manifestEntry.sha256
    };
  });
  const manifestTotal = artifactIds.reduce((total, artifactId) => {
    const size = findArtifactManifestEntry(manifest, artifactId).size_bytes;
    return typeof size === "number" ? total + size : total;
  }, 0);
  if (manifestTotal > maxTotalBytes) {
    throw new Error("Requested artifact manifest sizes exceed maxTotalBytes before fetch");
  }

  if (approval) {
    consumeApproval(
      {
        approvalId: approval.approval_id,
        runId: runRecord.run_id,
        profileId: runRecord.profile_id,
        platform: runRecord.platform,
        operation: "artifacts.fetch.batch",
        planHash,
        quotaSnapshotId,
        consumedBy: `artifacts.fetch.batch:${artifactIds.length}:${maxTotalBytes}:${manifestHash.slice(0, 12)}`
      },
      { approvalDir: options.approvalDir, now }
    );
  }

  const fetchedFiles: Array<ArtifactBatchFetchFile & { content: Buffer }> = [];
  let totalSizeBytes = 0;
  for (const entry of prepared) {
    const spec = encodeSpec({
      workdir: plan.normalized_job_spec.workdir,
      path: entry.artifactPath,
      allowed_root: entry.allowedRoot,
      max_bytes: maxBytesPerFile
    });
    const args = sshArtifactArgs(profile.login.host_alias, timeoutMs, spec);
    const result = await executor("ssh", args, timeoutMs, ARTIFACT_FETCH_PY);
    if (result.exitCode !== 0) {
      throw new Error(`artifact fetch failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`);
    }
    const fetched = parseArtifactFetch(result.stdout, maxBytesPerFile);
    totalSizeBytes += fetched.size_bytes;
    if (totalSizeBytes > maxTotalBytes) {
      throw new Error("Fetched artifacts exceeded maxTotalBytes");
    }
    const content = Buffer.from(fetched.content_b64, "base64");
    if (content.length !== fetched.size_bytes) {
      throw new Error("Fetched artifact content length did not match the remote size");
    }
    const localSha256 = sha256Hex(content);
    if (localSha256 !== fetched.sha256) {
      throw new Error("Fetched artifact checksum did not match the remote checksum");
    }
    if (entry.expectedSha256 && entry.expectedSha256 !== fetched.sha256) {
      throw new Error("Fetched artifact checksum did not match the manifest checksum");
    }
    fetchedFiles.push({
      artifact_id: entry.artifactId,
      artifact_path: redactRemotePath(entry.artifactPath, userPrefixes),
      local_path: localArtifactPath(plan.run_id, entry.artifactPath, plan, options.artifactDir),
      size_bytes: fetched.size_bytes,
      sha256: fetched.sha256,
      command: redactedArtifactCommand(args, profile.login.host_alias, spec),
      content
    });
  }

  for (const file of fetchedFiles) {
    fs.mkdirSync(path.dirname(file.local_path), { recursive: true });
    fs.writeFileSync(file.local_path, file.content);
  }
  const publicFiles = fetchedFiles.map(({ content: _content, ...file }) => file);
  const evidencePath = writeArtifactEvidence(
    "fetch-batch",
    plan.run_id,
    now,
    {
      ...(approval ? { approval_id: approval.approval_id } : {}),
      artifact_ids: artifactIds,
      manifest_hash: manifestHash,
      max_bytes_per_file: maxBytesPerFile,
      max_total_bytes: maxTotalBytes,
      total_size_bytes: totalSizeBytes,
      files: publicFiles
    },
    options.artifactDir,
    {
      profile_id: plan.profile_id,
      platform: plan.platform,
      ...(approval ? { approval_id: approval.approval_id } : {})
    }
  );

  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "artifact-fetch-batch",
      summary: `Fetched ${artifactIds.length} artifacts with total ${totalSizeBytes} bytes`,
      redacted_command: "ssh <profile-host> python3 - <artifact-fetch-spec>"
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    fetch_batch: {
      mode: "live",
      run_id: plan.run_id,
      profile_id: plan.profile_id,
      platform: plan.platform,
      artifact_ids: artifactIds,
      manifest_hash: manifestHash,
      ...(approval ? { approval_id: approval.approval_id } : {}),
      max_bytes_per_file: maxBytesPerFile,
      max_total_bytes: maxTotalBytes,
      total_size_bytes: totalSizeBytes,
      fetched_at: now.toISOString(),
      files: publicFiles,
      run_record_path: runRecordPath,
      evidence_path: evidencePath
    }
  };
}

export function summarizeArtifacts(input: { runId: string }, options: ArtifactOptions = {}): { summary: ArtifactSummaryRecord } {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const plan = readVerifiedPlan(input.runId, options.planDir);
  const runRecord = readRunRecord(plan.run_id, options.auditDir);
  const artifactRoot = runArtifactRoot(plan.run_id, options.artifactDir);
  const filesRoot = path.join(artifactRoot, "files");
  const metrics = fs.existsSync(filesRoot) ? collectMetrics(filesRoot) : {};
  const metricsPath = path.join(artifactRoot, `metrics-${safeTimestamp(now)}.json`);
  const summaryPath = path.join(artifactRoot, `summary-${safeTimestamp(now)}.md`);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const summary: ArtifactSummaryRecord = {
    mode: "local",
    run_id: plan.run_id,
    profile_id: plan.profile_id,
    platform: plan.platform,
    generated_at: now.toISOString(),
    summary_path: summaryPath,
    metrics_path: metricsPath,
    metrics
  };
  assertArtifactSummary(summary);
  fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  fs.writeFileSync(summaryPath, renderSummary(plan, runRecord, metrics), "utf8");
  return { summary };
}

// Opt-in remote mode for artifacts.summarize. The real experiment metric files (optuna journals,
// aggregated result tables) live on the cluster head/login node and are too large/numerous to fetch
// first, so the local fetched-dir summarizer never gets used. This reads a SINGLE allowlisted metric
// file from a profile-root-confined remote path over the EXISTING bounded SSH read seam
// (ARTIFACT_FETCH_PY — the same helper artifacts.fetch uses), then applies the EXISTING parse/desecret/
// summarize logic. It adds NO arbitrary cluster-side execution: only a fixed, bounded remote byte read.
export async function summarizeRemoteArtifact(
  input: { runId: string; remotePath: string; maxBytes?: number },
  options: ArtifactOptions = {}
): Promise<{ summary: ArtifactSummaryRecord }> {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  // The remote byte cap is the SAME per-file cap the local summarizer enforces (MAX_METRIC_FILE_BYTES).
  // M1: the MCP input schema advertises a larger maxBytes (the shared 50 MB artifact-byte field), so a
  // caller-supplied value above the 1 MB metric ceiling is CLAMPED down to it (a clean bounded read)
  // rather than thrown as a confusing range error. The 1 MB read cap itself is never loosened; only
  // non-integer / non-positive values still fail via normalizeByteLimit.
  const clampedMaxBytes =
    typeof input.maxBytes === "number" && Number.isInteger(input.maxBytes) && input.maxBytes > MAX_METRIC_FILE_BYTES
      ? MAX_METRIC_FILE_BYTES
      : input.maxBytes;
  const maxBytes = normalizeByteLimit(clampedMaxBytes, MAX_METRIC_FILE_BYTES, MAX_METRIC_FILE_BYTES, "maxBytes");
  const executor = options.executor ?? defaultArtifactExecutor;
  // P1-b: remote-summarize is exactly the tool for reading a foreign campaign's head-node metric file,
  // and an ADOPTED run has a run RECORD but NO saved plan artifact. The run record is the authoritative
  // source of the profile/run context (run_id/profile_id/platform) — the same context jobs.status reads
  // for adopted runs — so we derive everything from it and do NOT require a plan. (This function never
  // used the plan's workdir: the remote read is pinned to the profile root containing remotePath, not a
  // run's output dir.)
  const runRecord = readRunRecord(input.runId, options.auditDir);
  const profile = getProfile(runRecord.profile_id, options.configPath);
  const userPrefixes = userRootPrefixes(profile);

  // Confine remotePath: shell-safe, absolute, no traversal, and inside one of the profile's declared
  // roots (workspace / scratch / project). This is BROADER than a single run's workdir on purpose —
  // head-node metric files commonly live in the user's home/scratch, not inside one run's output dir.
  if (typeof input.remotePath !== "string" || !input.remotePath) {
    throw new Error("artifacts.summarize remote mode requires a remotePath");
  }
  assertSafeRemotePath(input.remotePath, "remotePath");
  const allowedRoot = containingProfileRoot(input.remotePath, profile);

  // Enforce the SAME metric-stem allowlist + secret-filename filter the local path applies, on the
  // remote basename, BEFORE any read.
  const remoteBasename = path.posix.basename(stripTrailingSlash(input.remotePath));
  if (!isMetricCandidateName(remoteBasename)) {
    throw new Error(
      `remotePath basename ${remoteBasename} is not an allowlisted metric file (metric/result/summary/eval/score stem with a JSON/JSONL/NDJSON/CSV/TSV extension, secret-like names skipped)`
    );
  }

  // Read the bytes via the existing bounded remote read seam. ARTIFACT_FETCH_PY stats the file size
  // first and rejects oversize (exit 4) BEFORE returning the body, realpath-confines path inside
  // allowed_root and workdir, and rejects non-regular files / symlink escapes — all unchanged.
  const spec = encodeSpec({
    workdir: allowedRoot,
    path: input.remotePath,
    allowed_root: allowedRoot,
    max_bytes: maxBytes
  });
  const args = sshArtifactArgs(profile.login.host_alias, timeoutMs, spec);
  const result = await executor("ssh", args, timeoutMs, ARTIFACT_FETCH_PY);
  if (result.exitCode !== 0) {
    throw new Error(`remote metric read failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  const fetched = parseArtifactFetch(result.stdout, maxBytes);
  const content = Buffer.from(fetched.content_b64, "base64");
  if (content.length !== fetched.size_bytes) {
    throw new Error("Remote metric content length did not match the remote size");
  }
  if (sha256Hex(content) !== fetched.sha256) {
    throw new Error("Remote metric checksum did not match the remote checksum");
  }

  // Apply the EXISTING parse/desecret/summarize logic on the bytes, keyed by the remote basename.
  const extension = path.posix.extname(remoteBasename).toLowerCase();
  const metrics: Record<string, unknown> = {
    [remoteBasename]: extractMetricText(content.toString("utf8"), extension)
  };

  const artifactRoot = runArtifactRoot(runRecord.run_id, options.artifactDir);
  const metricsPath = path.join(artifactRoot, `metrics-${safeTimestamp(now)}.json`);
  const summaryPath = path.join(artifactRoot, `summary-${safeTimestamp(now)}.md`);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const redactedRemotePath = redactRemotePath(input.remotePath, userPrefixes);
  const summary: ArtifactSummaryRecord = {
    mode: "remote",
    run_id: runRecord.run_id,
    profile_id: runRecord.profile_id,
    platform: runRecord.platform,
    generated_at: now.toISOString(),
    summary_path: summaryPath,
    metrics_path: metricsPath,
    metrics,
    source: "remote",
    remote_path: redactedRemotePath,
    remote_sha256: fetched.sha256,
    remote_size_bytes: fetched.size_bytes
  };
  assertArtifactSummary(summary);
  fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  fs.writeFileSync(summaryPath, renderRemoteSummary(runRecord, metrics, redactedRemotePath, fetched), "utf8");
  return { summary };
}

export function planArtifactCleanup(input: { runId: string }, options: ArtifactOptions = {}): { cleanup: ArtifactCleanupPlanRecord } {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const plan = readVerifiedPlan(input.runId, options.planDir);
  const profile = getProfile(plan.profile_id, options.configPath);
  const userPrefixes = userRootPrefixes(profile);
  const remoteCandidates = plannedOutputPaths(plan, profile).map((entry) => redactRemotePath(entry.path, userPrefixes));
  const artifactRoot = runArtifactRoot(plan.run_id, options.artifactDir);
  const localCandidates = fs.existsSync(artifactRoot) ? listLocalFiles(artifactRoot) : [];
  const cleanupPlanPath = path.join(artifactRoot, `cleanup-plan-${safeTimestamp(now)}.json`);
  const cleanupPlanHash = artifactCleanupPlanHash(plan, remoteCandidates, localCandidates);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const cleanup: ArtifactCleanupPlanRecord = {
    mode: "dry-run",
    run_id: plan.run_id,
    profile_id: plan.profile_id,
    platform: plan.platform,
    plan_hash: plan.plan_hash,
    cleanup_plan_hash: cleanupPlanHash,
    generated_at: now.toISOString(),
    remote_candidates: remoteCandidates,
    local_candidates: localCandidates,
    cleanup_plan_path: cleanupPlanPath,
    warnings: [
      "Dry-run cleanup plan only; no remote or local files were deleted",
      "Cleanup execution requires the latest manifest_hash, explicit artifact_ids, and a separate artifacts.cleanup.execute approval"
    ]
  };
  assertArtifactCleanupPlan(cleanup);
  fs.writeFileSync(cleanupPlanPath, `${JSON.stringify(cleanup, null, 2)}\n`, "utf8");
  return { cleanup };
}

export async function executeArtifactCleanup(
  input: { runId: string; manifestHash: string; artifactIds: string[]; approvalId: string },
  options: ArtifactOptions = {}
): Promise<{ cleanup_execute: ArtifactCleanupExecutionResult }> {
  assertSafeRunId(input.runId);
  assertSha256(input.manifestHash, "manifestHash");
  const artifactIds = normalizeArtifactIds(input.artifactIds);
  assertSafeApprovalId(input.approvalId);
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultArtifactExecutor;
  const plan = readVerifiedPlan(input.runId, options.planDir);
  const profile = getProfile(plan.profile_id, options.configPath);
  const runRecord = readRunRecord(plan.run_id, options.auditDir);
  const planHash = requireRunPlanHash(runRecord);
  const quotaSnapshotId = requireRunQuotaSnapshotId(runRecord);
  if (planHash !== plan.plan_hash) {
    throw new Error("Run record plan_hash does not match the saved plan artifact");
  }
  assertTerminalRunForCleanup(runRecord);
  const manifest = readArtifactManifest(plan.run_id, options.artifactDir);
  const manifestHash = artifactManifestHash(plan.run_id, options.artifactDir);
  if (manifestHash !== input.manifestHash) {
    throw new Error("Artifact manifest hash does not match the cleanup request");
  }
  const outputPaths = plannedOutputPaths(plan, profile);
  const userPrefixes = userRootPrefixes(profile);
  const remoteTargets = artifactIds.map((artifactId) => {
    const manifestEntry = findArtifactManifestEntry(manifest, artifactId);
    if (manifestEntry.kind !== "file") {
      throw new Error("artifacts.cleanup.execute can only delete file artifacts from the latest manifest");
    }
    if (!manifestEntry.sha256 || manifestEntry.checksum_status !== "captured") {
      throw new Error("artifacts.cleanup.execute requires captured SHA-256 manifest evidence");
    }
    if (typeof manifestEntry.size_bytes !== "number" || manifestEntry.size_bytes < 0) {
      throw new Error("artifacts.cleanup.execute requires manifest file size evidence");
    }
    const artifactPath = resolveArtifactPath(manifestEntry.remote_path, plan, outputPaths);
    return {
      artifact_id: artifactId,
      path: artifactPath,
      allowed_root: containingOutputRoot(artifactPath, outputPaths),
      size_bytes: manifestEntry.size_bytes,
      sha256: manifestEntry.sha256
    };
  });
  const manifestTotal = remoteTargets.reduce((total, target) => total + target.size_bytes, 0);
  if (manifestTotal > MAX_BATCH_TOTAL_BYTES) {
    throw new Error("Cleanup artifact manifest sizes exceed max cleanup bytes before deletion");
  }
  const approval = approvalStatus({ approvalId: input.approvalId }, { approvalDir: options.approvalDir, now }).approval;
  assertArtifactCleanupApproval(approval, runRecord, planHash, quotaSnapshotId, {
    manifestHash,
    artifactIds,
    maxTotalBytes: manifestTotal
  });
  const localTargets = remoteTargets
    .map((target) => localArtifactPathIfExists(plan.run_id, target.path, plan, options.artifactDir))
    .filter((target): target is string => Boolean(target))
    .map((target) => assertLocalCleanupTarget(target, plan.run_id, options.artifactDir));
  const spec = encodeSpec({
    workdir: plan.normalized_job_spec.workdir,
    targets: remoteTargets,
    max_entries: MAX_CLEANUP_REMOTE_ENTRIES,
    max_total_bytes: manifestTotal
  });
  const args = sshArtifactArgs(profile.login.host_alias, timeoutMs, spec);

  consumeApproval(
    {
      approvalId: approval.approval_id,
      runId: runRecord.run_id,
      profileId: runRecord.profile_id,
      platform: runRecord.platform,
      operation: "artifacts.cleanup.execute",
      planHash,
      quotaSnapshotId,
      consumedBy: `artifacts.cleanup.execute:${artifactIds.length}:${manifestHash.slice(0, 12)}`
    },
    { approvalDir: options.approvalDir, now }
  );

  const result = await executor("ssh", args, timeoutMs, ARTIFACT_CLEANUP_EXECUTE_PY);
  if (result.exitCode !== 0) {
    throw new Error(`artifact cleanup failed: ${summarizeBareFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  const remote = parseRemoteCleanup(result.stdout);
  const localDeletedFiles = deleteLocalCleanupTargets(localTargets);
  const command = redactedArtifactCommand(args, profile.login.host_alias, spec);
  const evidencePath = writeArtifactEvidence(
    "cleanup-execute",
    plan.run_id,
    now,
    {
      manifest_hash: manifestHash,
      artifact_ids: artifactIds,
      remote_deleted_files: remote.deleted_files.map((value) => redactRemotePath(value, userPrefixes)),
      remote_missing: remote.missing.map((value) => redactRemotePath(value, userPrefixes)),
      remote_total_deleted_bytes: remote.total_deleted_bytes,
      local_deleted_files: localDeletedFiles.map((candidate) => redactLocalArtifactPath(candidate, plan.run_id, options.artifactDir)),
      command
    },
    options.artifactDir,
    {
      profile_id: plan.profile_id,
      platform: plan.platform,
      approval_id: approval.approval_id
    }
  );

  const runRecordPath = recordOperationEvidence(
    runRecord,
    {
      kind: "artifact-cleanup-execute",
      summary: `Deleted ${artifactIds.length} manifest artifacts from cleanup scope ${manifestHash.slice(0, 12)}`,
      redacted_command: "ssh <profile-host> python3 - <artifact-cleanup-spec>"
    },
    evidencePath,
    now,
    options.auditDir
  );

  return {
    cleanup_execute: {
      mode: "live",
      run_id: plan.run_id,
      profile_id: plan.profile_id,
      platform: plan.platform,
      approval_id: approval.approval_id,
      manifest_hash: manifestHash,
      artifact_ids: artifactIds,
      cleaned_at: now.toISOString(),
      remote_deleted_files: remote.deleted_files.map((value) => redactRemotePath(value, userPrefixes)),
      remote_missing: remote.missing.map((value) => redactRemotePath(value, userPrefixes)),
      remote_total_deleted_bytes: remote.total_deleted_bytes,
      local_deleted_files: localDeletedFiles.map((candidate) => redactLocalArtifactPath(candidate, plan.run_id, options.artifactDir)),
      command,
      evidence_path: evidencePath,
      run_record_path: runRecordPath
    }
  };
}


interface PlannedOutputPath {
  label: string;
  path: string;
}

function plannedOutputPaths(plan: PlannedJob, profile: ComputeProfile): PlannedOutputPath[] {
  const workdir = plan.normalized_job_spec.workdir;
  if (!workdir) {
    throw new Error("Artifact operations require a planned workdir");
  }
  assertSafeRemotePath(workdir, "workdir");
  const roots = [profile.defaults.workspace, profile.defaults.scratch, profile.defaults.project].filter((value): value is string =>
    Boolean(value)
  );
  if (roots.length && !roots.some((root) => isInsideRemoteRoot(workdir, root))) {
    throw new Error("Artifact workdir must stay inside profile workspace, scratch, or project roots");
  }
  const outputs = plan.normalized_job_spec.outputs ?? [];
  if (!outputs.length) {
    throw new Error("Artifact operations require planned outputs");
  }
  return uniqueOutputs(
    outputs.map((output) => {
      assertSafeOutputToken(output);
      const outputPath = output.startsWith("/") ? stripTrailingSlash(output) : `${stripTrailingSlash(workdir)}/${output}`;
      const normalizedOutputPath = stripTrailingSlash(outputPath);
      assertSafeRemotePath(normalizedOutputPath, "output");
      if (!isInsideRemoteRoot(normalizedOutputPath, workdir)) {
        throw new Error("Planned output path must stay inside the planned workdir");
      }
      return {
        label: output,
        path: normalizedOutputPath
      };
    })
  );
}

// Resolve the profile-declared root (workspace / scratch / project) that contains a concrete remote
// path, or throw. Used by the remote summarize mode to confine the read to declared roots and to pin
// the ARTIFACT_FETCH_PY allowed_root/workdir. Longest match wins so a nested root is preferred.
function containingProfileRoot(remotePath: string, profile: ComputeProfile): string {
  const normalized = stripTrailingSlash(remotePath);
  const roots = [profile.defaults.workspace, profile.defaults.scratch, profile.defaults.project]
    .filter((value): value is string => Boolean(value))
    .map((root) => stripTrailingSlash(root))
    .sort((left, right) => right.length - left.length);
  if (!roots.length) {
    throw new Error("Profile must declare a workspace, scratch, or project root for remote summarize");
  }
  const match = roots.find((root) => isInsideRemoteRoot(normalized, root));
  if (!match) {
    throw new Error("remotePath must stay inside the profile workspace, scratch, or project root");
  }
  return match;
}

function uniqueOutputs(outputs: PlannedOutputPath[]): PlannedOutputPath[] {
  const seen = new Set<string>();
  return outputs.filter((entry) => {
    if (seen.has(entry.path)) {
      return false;
    }
    seen.add(entry.path);
    return true;
  });
}

function resolveArtifactPath(artifactPath: string, plan: PlannedJob, outputPaths: PlannedOutputPath[]): string {
  assertSafeOutputToken(artifactPath);
  const workdir = plan.normalized_job_spec.workdir;
  if (!workdir) {
    throw new Error("Artifact fetch requires a planned workdir");
  }
  const resolved = artifactPath.startsWith("/")
    ? stripTrailingSlash(artifactPath)
    : `${stripTrailingSlash(workdir)}/${artifactPath}`;
  assertSafeRemotePath(resolved, "artifactPath");
  if (!outputPaths.some((output) => isInsideRemoteRoot(resolved, output.path))) {
    throw new Error("artifactPath must be inside one of the planned output paths");
  }
  return resolved;
}

function containingOutputRoot(artifactPath: string, outputPaths: PlannedOutputPath[]): string {
  const output = outputPaths.find((entry) => isInsideRemoteRoot(artifactPath, entry.path));
  if (!output) {
    throw new Error("artifactPath must be inside one of the planned output paths");
  }
  return output.path;
}

function parseArtifactList(stdout: string, outputPaths: PlannedOutputPath[], userPrefixes: string[] = []): { artifacts: ArtifactManifestEntry[]; truncated: boolean } {
  const parsed = parseJsonLastLine(stdout, "artifact list") as { artifacts?: unknown; truncated?: unknown };
  if (!Array.isArray(parsed.artifacts)) {
    throw new Error("Artifact list helper did not return artifacts");
  }
  const outputByPath = new Map(outputPaths.map((entry) => [entry.path, entry.label]));
  const artifacts = parsed.artifacts.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Artifact list helper returned invalid artifact entry");
    }
    const record = entry as {
      path?: unknown;
      relative_path?: unknown;
      kind?: unknown;
      size_bytes?: unknown;
      sha256?: unknown;
      checksum_status?: unknown;
      source_output?: unknown;
    };
    if (typeof record.path !== "string" || !isSafeRemotePath(record.path)) {
      throw new Error("Artifact list helper returned unsafe path");
    }
    const kind = record.kind;
    if (kind !== "file" && kind !== "directory" && kind !== "missing" && kind !== "other") {
      throw new Error("Artifact list helper returned invalid artifact kind");
    }
    const artifactKind = kind as ArtifactKind;
    const sourceOutput =
      typeof record.source_output === "string" && outputByPath.has(record.source_output)
        ? outputByPath.get(record.source_output)!
        : "";
    const artifactId = artifactIdFor(record.path);
    return {
      artifact_id: artifactId,
      remote_path: record.path,
      path: redactRemotePath(record.path, userPrefixes),
      relative_path: typeof record.relative_path === "string" ? record.relative_path : "",
      kind: artifactKind,
      ...(typeof record.size_bytes === "number" ? { size_bytes: record.size_bytes } : {}),
      ...(typeof record.sha256 === "string" ? { sha256: record.sha256 } : {}),
      ...(typeof record.checksum_status === "string"
        ? { checksum_status: record.checksum_status as ArtifactEntry["checksum_status"] }
        : {}),
      source_output: sourceOutput
    };
  });
  return { artifacts, truncated: Boolean(parsed.truncated) };
}

function parseArtifactFetch(stdout: string, maxBytes: number): { content_b64: string; size_bytes: number; sha256: string } {
  const parsed = parseJsonLastLine(stdout, "artifact fetch") as { content_b64?: unknown; size_bytes?: unknown; sha256?: unknown };
  if (typeof parsed.content_b64 !== "string" || typeof parsed.size_bytes !== "number" || typeof parsed.sha256 !== "string") {
    throw new Error("Artifact fetch helper returned invalid metadata");
  }
  if (parsed.size_bytes > maxBytes) {
    throw new Error("Artifact fetch helper returned more bytes than requested");
  }
  if (!isHexDigest(parsed.sha256)) {
    throw new Error("Artifact fetch helper returned invalid checksum");
  }
  return {
    content_b64: parsed.content_b64,
    size_bytes: parsed.size_bytes,
    sha256: parsed.sha256
  };
}

function parseRemoteCleanup(stdout: string): RemoteCleanupResult {
  const parsed = parseJsonLastLine(stdout, "artifact cleanup") as {
    deleted_files?: unknown;
    missing?: unknown;
    total_deleted_bytes?: unknown;
  };
  if (
    !Array.isArray(parsed.deleted_files) ||
    !Array.isArray(parsed.missing) ||
    typeof parsed.total_deleted_bytes !== "number" ||
    !Number.isInteger(parsed.total_deleted_bytes) ||
    parsed.total_deleted_bytes < 0
  ) {
    throw new Error("Artifact cleanup helper returned invalid metadata");
  }
  if (!parsed.deleted_files.every((value) => typeof value === "string" && isSafeRemotePath(value))) {
    throw new Error("Artifact cleanup helper returned unsafe deleted file path");
  }
  if (!parsed.missing.every((value) => typeof value === "string" && isSafeRemotePath(value))) {
    throw new Error("Artifact cleanup helper returned unsafe missing file path");
  }
  return {
    deleted_files: parsed.deleted_files,
    missing: parsed.missing,
    total_deleted_bytes: parsed.total_deleted_bytes
  };
}

function writeArtifactManifest(
  plan: PlannedJob,
  now: Date,
  artifacts: ArtifactManifestEntry[],
  truncated: boolean,
  artifactDir: string | undefined
): string {
  const root = runArtifactRoot(plan.run_id, artifactDir);
  const manifest: ArtifactManifest = {
    run_id: plan.run_id,
    profile_id: plan.profile_id,
    platform: plan.platform,
    created_at: now.toISOString(),
    artifacts,
    truncated
  };
  assertArtifactManifest(manifest);
  return writeEvidenceJson(root, "manifest.json", manifest, "Artifact manifest");
}

function readArtifactManifestEntry(runId: string, artifactId: string, artifactDir: string | undefined): ArtifactManifestEntry {
  return findArtifactManifestEntry(readArtifactManifest(runId, artifactDir), artifactId);
}

function readArtifactManifest(runId: string, artifactDir: string | undefined): ArtifactManifest {
  const manifestPath = artifactManifestPath(runId, artifactDir);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ArtifactManifest;
  assertArtifactManifest(manifest);
  if (manifest.run_id !== runId || !Array.isArray(manifest.artifacts)) {
    throw new Error("Artifact manifest does not match the requested run");
  }
  return manifest;
}

function artifactManifestPath(runId: string, artifactDir: string | undefined): string {
  return path.join(runArtifactRoot(runId, artifactDir), "manifest.json");
}

function artifactManifestHash(runId: string, artifactDir: string | undefined): string {
  return sha256Hex(fs.readFileSync(artifactManifestPath(runId, artifactDir)));
}

function findArtifactManifestEntry(manifest: ArtifactManifest, artifactId: string): ArtifactManifestEntry {
  const entry = manifest.artifacts.find((artifact) => artifact.artifact_id === artifactId);
  if (!entry) {
    throw new Error(`Artifact id ${artifactId} was not found in the latest artifact manifest`);
  }
  if (!entry.remote_path || !isSafeRemotePath(entry.remote_path)) {
    throw new Error("Artifact manifest contains an unsafe remote path");
  }
  return entry;
}

function publicArtifactEntry(entry: ArtifactManifestEntry): ArtifactEntry {
  const { remote_path: _remotePath, ...publicEntry } = entry;
  return publicEntry;
}

function artifactCleanupPlanHash(plan: PlannedJob, remoteCandidates: string[], localCandidates: string[]): string {
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        run_id: plan.run_id,
        profile_id: plan.profile_id,
        platform: plan.platform,
        plan_hash: plan.plan_hash,
        remote_candidates: remoteCandidates,
        local_candidates: localCandidates
      })
    )
    .digest("hex");
}

function assertArtifactFetchApproval(approval: ApprovalRecord, runRecord: RunRecord, planHash: string, quotaSnapshotId: string): void {
  assertArtifactApprovalIdentity(approval, runRecord, planHash, quotaSnapshotId, "artifacts.fetch");
}

function assertArtifactApprovalIdentity(
  approval: ApprovalRecord,
  runRecord: RunRecord,
  planHash: string,
  quotaSnapshotId: string,
  expectedOperation: "artifacts.fetch" | "artifacts.fetch.batch" | "artifacts.cleanup.execute"
): void {
  assertApprovalBoundTo(approval, {
    operation: expectedOperation,
    runId: runRecord.run_id,
    profileId: runRecord.profile_id,
    platform: runRecord.platform,
    planHash,
    identityMessage: "Approval does not match the run record identity",
    planHashMessage: "Approval plan_hash does not match the run record",
    quotaSnapshot: {
      expected: quotaSnapshotId,
      message: "Approval quota_snapshot_id does not match the run record"
    }
  });
}

interface ArtifactBatchApprovalScope {
  artifactIds: string[];
  manifestHash: string;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

interface ArtifactCleanupApprovalScope {
  artifactIds: string[];
  manifestHash: string;
  maxTotalBytes: number;
}

function assertArtifactBatchFetchApproval(
  approval: ApprovalRecord,
  runRecord: RunRecord,
  planHash: string,
  quotaSnapshotId: string,
  scope: ArtifactBatchApprovalScope
): void {
  assertArtifactApprovalIdentity(approval, runRecord, planHash, quotaSnapshotId, "artifacts.fetch.batch");
  const resourceSummary = approval.resource_summary;
  if (!resourceSummary || typeof resourceSummary !== "object" || Array.isArray(resourceSummary)) {
    throw new Error("Batch artifact fetch approval must include resource_summary");
  }
  const approvedArtifactIds = resourceSummary.artifact_ids;
  if (!Array.isArray(approvedArtifactIds) || !approvedArtifactIds.every((value) => typeof value === "string")) {
    throw new Error("Batch artifact fetch approval must include artifact_ids");
  }
  if (JSON.stringify(approvedArtifactIds) !== JSON.stringify(scope.artifactIds)) {
    throw new Error("Batch artifact fetch approval artifact_ids do not match the request");
  }
  if (resourceSummary.manifest_hash !== scope.manifestHash) {
    throw new Error("Batch artifact fetch approval manifest_hash does not match the request");
  }
  const approvedMaxBytesPerFile = resourceSummary.max_bytes_per_file;
  if (typeof approvedMaxBytesPerFile !== "number" || approvedMaxBytesPerFile < scope.maxBytesPerFile) {
    throw new Error("Batch artifact fetch approval max_bytes_per_file does not cover the request");
  }
  const approvedMaxTotalBytes = resourceSummary.max_total_bytes;
  if (typeof approvedMaxTotalBytes !== "number" || approvedMaxTotalBytes < scope.maxTotalBytes) {
    throw new Error("Batch artifact fetch approval max_total_bytes does not cover the request");
  }
}

function assertArtifactCleanupApproval(
  approval: ApprovalRecord,
  runRecord: RunRecord,
  planHash: string,
  quotaSnapshotId: string,
  scope: ArtifactCleanupApprovalScope
): void {
  assertArtifactApprovalIdentity(approval, runRecord, planHash, quotaSnapshotId, "artifacts.cleanup.execute");
  const resourceSummary = approval.resource_summary;
  if (!resourceSummary || typeof resourceSummary !== "object" || Array.isArray(resourceSummary)) {
    throw new Error("Artifact cleanup approval must include resource_summary");
  }
  const approvedArtifactIds = resourceSummary.artifact_ids;
  if (!Array.isArray(approvedArtifactIds) || !approvedArtifactIds.every((value) => typeof value === "string")) {
    throw new Error("Artifact cleanup approval must include artifact_ids");
  }
  if (JSON.stringify(approvedArtifactIds) !== JSON.stringify(scope.artifactIds)) {
    throw new Error("Artifact cleanup approval artifact_ids do not match the request");
  }
  if (resourceSummary.manifest_hash !== scope.manifestHash) {
    throw new Error("Artifact cleanup approval manifest_hash does not match the request");
  }
  if (resourceSummary.delete_mode !== "unlink-regular-files-only") {
    throw new Error("Artifact cleanup approval delete_mode must be unlink-regular-files-only");
  }
  const approvedMaxArtifacts = resourceSummary.max_artifacts;
  if (typeof approvedMaxArtifacts !== "number" || approvedMaxArtifacts !== scope.artifactIds.length) {
    throw new Error("Artifact cleanup approval max_artifacts must match the request count");
  }
  const approvedMaxTotalBytes = resourceSummary.max_total_bytes;
  if (typeof approvedMaxTotalBytes !== "number" || approvedMaxTotalBytes !== scope.maxTotalBytes) {
    throw new Error("Artifact cleanup approval max_total_bytes must match the request");
  }
}

function requireRunPlanHash(runRecord: RunRecord): string {
  if (!runRecord.plan_hash) {
    throw new Error("Run record must include plan_hash before artifact fetch");
  }
  return runRecord.plan_hash;
}

function assertTerminalRunForCleanup(runRecord: RunRecord): void {
  if (runRecord.status !== "finished" && runRecord.status !== "failed" && runRecord.status !== "cancelled") {
    throw new Error(`artifacts.cleanup.execute requires a terminal run status, not ${runRecord.status}`);
  }
}

function requireRunQuotaSnapshotId(runRecord: RunRecord): string {
  if (!runRecord.quota_snapshot_id) {
    throw new Error("Run record must include quota_snapshot_id before artifact fetch");
  }
  return runRecord.quota_snapshot_id;
}

function sshArtifactArgs(hostAlias: string, timeoutMs: number, encodedSpec: string): string[] {
  // The encodedSpec-safety regex (and its artifact-specific wording) stays here — it is this tool's
  // policy. The shared single-hop primitive owns the hardening prelude + `-T` + host-alias guard.
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSpec)) {
    throw new Error("Artifact spec encoding is not safe for SSH argv");
  }
  return sshSingleHopArgs(hostAlias, sshTimeoutSeconds(timeoutMs), {
    tty: true,
    trailing: ["python3", "-", encodedSpec]
  });
}

function redactedArtifactCommand(args: string[], hostAlias: string, encodedSpec: string) {
  return {
    program: "ssh",
    args: maskHostAlias(args, hostAlias, [{ match: encodedSpec, replace: "<artifact-spec>" }]),
    remote_argv: ["python3", "-", "<artifact-spec>"]
  };
}

function localArtifactPath(runId: string, artifactPath: string, plan: PlannedJob, artifactDir: string | undefined): string {
  const filesRoot = path.join(runArtifactRoot(runId, artifactDir), "files");
  const workdir = plan.normalized_job_spec.workdir ?? "/";
  const relative = artifactPath.startsWith(`${stripTrailingSlash(workdir)}/`)
    ? artifactPath.slice(stripTrailingSlash(workdir).length + 1)
    : path.posix.basename(artifactPath);
  const safeRelative = relative
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_"))
    .join("/");
  const localPath = path.join(filesRoot, safeRelative || "artifact");
  const resolvedRoot = assertInsideRuntime(filesRoot, "Artifact file directory");
  const relativeLocal = path.relative(resolvedRoot, localPath);
  if (relativeLocal.startsWith("..") || path.isAbsolute(relativeLocal)) {
    throw new Error("Local artifact path must stay inside the artifact directory");
  }
  return localPath;
}

function localArtifactPathIfExists(runId: string, artifactPath: string, plan: PlannedJob, artifactDir: string | undefined): string | undefined {
  const localPath = localArtifactPath(runId, artifactPath, plan, artifactDir);
  return fs.existsSync(localPath) ? localPath : undefined;
}

function assertLocalCleanupTarget(candidate: string, runId: string, artifactDir: string | undefined): string {
  const filesRoot = path.join(runArtifactRoot(runId, artifactDir), "files");
  const resolvedRoot = assertInsideRuntime(filesRoot, "Artifact cleanup file directory");
  const relative = path.relative(resolvedRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Local cleanup target must stay inside fetched artifact files");
  }
  const lstat = fs.lstatSync(candidate);
  if (lstat.isSymbolicLink()) {
    throw new Error("Local cleanup target must not be a symbolic link");
  }
  if (!lstat.isFile()) {
    throw new Error("Local cleanup target must be a regular file");
  }
  const realCandidate = fs.realpathSync(candidate);
  const realRelative = path.relative(fs.realpathSync(resolvedRoot), realCandidate);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error("Local cleanup target realpath must stay inside fetched artifact files");
  }
  return candidate;
}

function deleteLocalCleanupTargets(targets: string[]): string[] {
  for (const target of targets) {
    fs.unlinkSync(target);
  }
  return targets;
}

function redactLocalArtifactPath(value: string, runId: string, artifactDir: string | undefined): string {
  const artifactRoot = runArtifactRoot(runId, artifactDir);
  const relative = path.relative(artifactRoot, value);
  return relative.startsWith("..") || path.isAbsolute(relative) ? "<artifact-cache>" : `<artifact-cache>/${relative.split(path.sep).join("/")}`;
}

function runArtifactRoot(runId: string, artifactDir = DEFAULT_ARTIFACT_DIR): string {
  return runRecordRoot(artifactDir, runId, "Artifact directory");
}

function writeArtifactEvidence(
  kind: string,
  runId: string,
  now: Date,
  evidence: Record<string, unknown>,
  artifactDir = DEFAULT_ARTIFACT_DIR,
  metadata: Record<string, unknown> = {}
): string {
  const root = runArtifactRoot(runId, artifactDir);
  const record = {
    run_id: runId,
    ...metadata,
    kind,
    observed_at: now.toISOString(),
    evidence
  };
  if (kind === "fetch") {
    assertArtifactFetchRecord(record);
  } else if (kind === "fetch-batch") {
    assertArtifactFetchBatchRecord(record);
  } else if (kind === "cleanup-execute") {
    assertArtifactCleanupExecutionRecord(record);
  }
  return writeEvidenceJson(root, `${kind}-${safeTimestamp(now)}.json`, record, "Artifact evidence");
}

const METRIC_FILE_EXTENSION_RE = /\.(?:json|jsonl|ndjson|csv|tsv)$/i;
const METRIC_NAME_TOKENS = new Set(["metric", "metrics", "result", "results", "summary", "eval", "evaluation", "score", "scores"]);
const SECRET_FILENAME_RE = /(?:password|passwd|token|secret|api[_-]?key|credential|private[_-]?key|mfa|otp)/i;
const MAX_METRIC_FILE_BYTES = 1_000_000;
const MAX_METRIC_TOTAL_BYTES = 5_000_000;
const MAX_METRIC_FILES = 100;
const MAX_JSON_METRIC_DEPTH = 4;
const MAX_JSON_METRIC_KEYS = 500;
const MAX_JSON_ARRAY_ITEMS = 50;
const MAX_TABULAR_ROWS = 1_000;
const MAX_TABULAR_COLUMNS = 100;
const MAX_SHORT_STRING = 200;
const SECRET_KEY_RE = /(?:password|passwd|token|secret|api[_-]?key|credential|private[_-]?key|mfa|otp)/i;
const SECRET_VALUE_RE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,})/;

interface MetricCandidate {
  filePath: string;
  relativePath: string;
  size: number;
  skipped?: string;
}

interface JsonMetricContext {
  keys: number;
  truncated: boolean;
}

interface ColumnStats {
  count: number;
  min: number;
  max: number;
  sum: number;
  last: number;
}

interface ScalarStats {
  count: number;
  last: string | boolean | null;
  samples: Array<string | boolean | null>;
}

function collectMetrics(filesRoot: string): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  const candidates = listMetricCandidates(filesRoot);
  let processedFiles = 0;
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (candidate.skipped) {
      metrics[candidate.relativePath] = {
        skipped: true,
        reason: candidate.skipped
      };
      continue;
    }
    if (processedFiles >= MAX_METRIC_FILES) {
      metrics[candidate.relativePath] = {
        skipped: true,
        reason: `metric file count exceeded ${MAX_METRIC_FILES}`
      };
      continue;
    }
    if (candidate.size > MAX_METRIC_FILE_BYTES) {
      metrics[candidate.relativePath] = {
        skipped: true,
        reason: `metric file exceeds ${MAX_METRIC_FILE_BYTES} bytes`,
        size_bytes: candidate.size
      };
      continue;
    }
    if (totalBytes + candidate.size > MAX_METRIC_TOTAL_BYTES) {
      metrics[candidate.relativePath] = {
        skipped: true,
        reason: `metric total byte limit exceeded ${MAX_METRIC_TOTAL_BYTES}`,
        size_bytes: candidate.size
      };
      continue;
    }
    processedFiles += 1;
    totalBytes += candidate.size;
    metrics[candidate.relativePath] = extractMetricFile(candidate.filePath);
  }
  return metrics;
}

function listMetricCandidates(filesRoot: string): MetricCandidate[] {
  const resolvedRoot = path.resolve(filesRoot);
  const rootReal = fs.realpathSync(resolvedRoot);
  const results: MetricCandidate[] = [];
  const stack = [resolvedRoot];

  while (stack.length) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      const relativePath = metricRelativePath(resolvedRoot, filePath);
      const lstat = fs.lstatSync(filePath);
      if (lstat.isSymbolicLink()) {
        if (isMetricCandidateName(entry.name) && isSafeMetricRelativePath(relativePath)) {
          results.push({
            filePath,
            relativePath,
            size: 0,
            skipped: "symbolic links are not read by artifacts.summarize"
          });
        }
        continue;
      }
      if (lstat.isDirectory()) {
        assertRealPathInsideRealRoot(filePath, rootReal, "Metric artifact directory");
        stack.push(filePath);
        continue;
      }
      if (!lstat.isFile() || !isMetricCandidateName(entry.name) || !isSafeMetricRelativePath(relativePath)) {
        continue;
      }
      assertRealPathInsideRealRoot(filePath, rootReal, "Metric artifact file");
      results.push({
        filePath,
        relativePath,
        size: lstat.size
      });
    }
  }
  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function isMetricCandidateName(fileName: string): boolean {
  if (SECRET_FILENAME_RE.test(fileName) || !METRIC_FILE_EXTENSION_RE.test(fileName)) {
    return false;
  }
  const stem = fileName.replace(METRIC_FILE_EXTENSION_RE, "");
  const tokens = stem
    .split(/[-_.]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
  return tokens.some((token) => METRIC_NAME_TOKENS.has(token));
}

function extractMetricFile(filePath: string): unknown {
  return extractMetricText(fs.readFileSync(filePath, "utf8"), path.extname(filePath).toLowerCase());
}

// The byte-source-agnostic core of metric extraction: given the decoded text and a lowercased
// extension, apply the same parse/desecret/summarize logic. Shared by the local fetched-file path
// (extractMetricFile) and the confined remote read (summarizeRemoteArtifact) so both desecret and
// shape metrics identically — only the byte source differs.
function extractMetricText(text: string, extension: string): unknown {
  if (extension === ".json") {
    return extractJsonMetricFile(text);
  }
  if (extension === ".jsonl" || extension === ".ndjson") {
    return extractJsonLinesMetricFile(text);
  }
  if (extension === ".csv" || extension === ".tsv") {
    return extractDelimitedMetricFile(text, extension === ".tsv" ? "\t" : ",");
  }
  return {
    skipped: true,
    reason: "unsupported metric file extension"
  };
}

function extractJsonMetricFile(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as unknown;
    const context: JsonMetricContext = { keys: 0, truncated: false };
    const metrics = sanitizeJsonMetric(parsed, 0, context);
    return context.truncated && isPlainObject(metrics) ? { ...metrics, __truncated: true } : metrics;
  } catch {
    return { parse_error: true };
  }
}

function sanitizeJsonMetric(value: unknown, depth: number, context: JsonMetricContext): unknown {
  if (depth > MAX_JSON_METRIC_DEPTH) {
    context.truncated = true;
    return undefined;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    if (value.length > MAX_SHORT_STRING || SECRET_VALUE_RE.test(value)) {
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const numeric = value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
    if (numeric.length === value.length && numeric.length > 0) {
      return summarizeNumberList(numeric);
    }
    const items = value
      .slice(0, MAX_JSON_ARRAY_ITEMS)
      .map((entry) => sanitizeJsonMetric(entry, depth + 1, context))
      .filter((entry) => entry !== undefined);
    if (value.length > MAX_JSON_ARRAY_ITEMS) {
      context.truncated = true;
    }
    return items;
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      continue;
    }
    context.keys += 1;
    if (context.keys > MAX_JSON_METRIC_KEYS) {
      context.truncated = true;
      break;
    }
    const sanitized = sanitizeJsonMetric(entry, depth + 1, context);
    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }
  return output;
}

function extractJsonLinesMetricFile(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: Record<string, unknown>[] = [];
  let parse_errors = 0;
  for (const line of lines.slice(0, MAX_TABULAR_ROWS)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isPlainObject(parsed)) {
        rows.push(parsed);
      }
    } catch {
      parse_errors += 1;
    }
  }
  return {
    format: "jsonl",
    row_count: rows.length,
    truncated: lines.length > MAX_TABULAR_ROWS,
    ...(parse_errors > 0 ? { parse_errors } : {}),
    ...aggregateMetricRows(rows)
  };
}

function extractDelimitedMetricFile(text: string, delimiter: "," | "\t"): Record<string, unknown> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) {
    return {
      format: delimiter === "\t" ? "tsv" : "csv",
      row_count: 0,
      truncated: false,
      numeric_columns: {},
      scalar_columns: {}
    };
  }
  const headers = parseDelimitedLine(lines[0], delimiter)
    .slice(0, MAX_TABULAR_COLUMNS)
    .map((header, index) => header.trim() || `column_${index + 1}`);
  const rows = lines.slice(1, MAX_TABULAR_ROWS + 1).map((line) => {
    const cells = parseDelimitedLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
  return {
    format: delimiter === "\t" ? "tsv" : "csv",
    row_count: rows.length,
    truncated: lines.length - 1 > MAX_TABULAR_ROWS || parseDelimitedLine(lines[0], delimiter).length > MAX_TABULAR_COLUMNS,
    ...aggregateMetricRows(rows)
  };
}

function aggregateMetricRows(rows: Record<string, unknown>[]): Record<string, unknown> {
  const numeric = new Map<string, ColumnStats>();
  const scalar = new Map<string, ScalarStats>();
  for (const row of rows) {
    for (const [key, raw] of Object.entries(flattenMetricRow(row))) {
      if (SECRET_KEY_RE.test(key)) {
        continue;
      }
      const value = normalizeMetricScalar(raw);
      if (value === undefined) {
        continue;
      }
      if (typeof value === "number") {
        updateNumberStats(numeric, key, value);
      } else {
        updateScalarStats(scalar, key, value);
      }
    }
  }
  return {
    numeric_columns: Object.fromEntries(
      [...numeric.entries()].map(([key, value]) => [
        key,
        {
          count: value.count,
          min: value.min,
          max: value.max,
          mean: Number((value.sum / value.count).toFixed(12)),
          last: value.last
        }
      ])
    ),
    scalar_columns: Object.fromEntries(
      [...scalar.entries()].map(([key, value]) => [
        key,
        {
          count: value.count,
          last: value.last,
          samples: value.samples
        }
      ])
    )
  };
}

function flattenMetricRow(value: Record<string, unknown>, prefix = "", depth = 0): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (depth > MAX_JSON_METRIC_DEPTH) {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      continue;
    }
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(entry)) {
      Object.assign(output, flattenMetricRow(entry, nextKey, depth + 1));
    } else {
      output[nextKey] = entry;
    }
  }
  return output;
}

function normalizeMetricScalar(value: unknown): number | string | boolean | null | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SHORT_STRING || SECRET_VALUE_RE.test(trimmed)) {
    return undefined;
  }
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed) ? numeric : trimmed;
}

function updateNumberStats(stats: Map<string, ColumnStats>, key: string, value: number): void {
  const current = stats.get(key);
  if (!current) {
    stats.set(key, {
      count: 1,
      min: value,
      max: value,
      sum: value,
      last: value
    });
    return;
  }
  current.count += 1;
  current.min = Math.min(current.min, value);
  current.max = Math.max(current.max, value);
  current.sum += value;
  current.last = value;
}

function updateScalarStats(stats: Map<string, ScalarStats>, key: string, value: string | boolean | null): void {
  const current = stats.get(key);
  if (!current) {
    stats.set(key, {
      count: 1,
      last: value,
      samples: [value]
    });
    return;
  }
  current.count += 1;
  current.last = value;
  if (current.samples.length < 5 && !current.samples.includes(value)) {
    current.samples.push(value);
  }
}

function summarizeNumberList(values: number[]): Record<string, number> {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: Number((sum / values.length).toFixed(12)),
    last: values[values.length - 1]
  };
}

function parseDelimitedLine(line: string, delimiter: "," | "\t"): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

function metricRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isSafeMetricRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..") && !/[\0\r\n]/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function renderSummary(plan: PlannedJob, runRecord: RunRecord, metrics: Record<string, unknown>): string {
  return [
    `# UTS Artifact Summary: ${plan.run_id}`,
    "",
    `- Profile: ${plan.profile_id}`,
    `- Platform: ${plan.platform}`,
    `- Run status: ${runRecord.status}`,
    `- Plan hash: ${plan.plan_hash}`,
    `- Remote job id: ${runRecord.remote_job_id ?? "<none>"}`,
    `- Expected outputs: ${(plan.normalized_job_spec.outputs ?? []).join(", ") || "<none>"}`,
    "",
    "## Metrics",
    "",
    Object.keys(metrics).length ? "```json\n" + JSON.stringify(metrics, null, 2) + "\n```" : "No local metrics JSON files were found.",
    ""
  ].join("\n");
}

// Renders from the RUN RECORD only (no plan): an adopted run has a run record but no saved plan, and
// remote-summarize must work for it. plan_hash is shown when the run carries one (a plugin-authored
// run), or `<none>` for an adopted/plan-less run.
function renderRemoteSummary(
  runRecord: RunRecord,
  metrics: Record<string, unknown>,
  redactedRemotePath: string,
  fetched: { size_bytes: number; sha256: string }
): string {
  return [
    `# UTS Artifact Summary: ${runRecord.run_id}`,
    "",
    `- Profile: ${runRecord.profile_id}`,
    `- Platform: ${runRecord.platform}`,
    `- Run status: ${runRecord.status}`,
    `- Plan hash: ${runRecord.plan_hash ?? "<none>"}`,
    `- Remote job id: ${runRecord.remote_job_id ?? "<none>"}`,
    `- Source: remote (confined bounded SSH read)`,
    `- Remote path: ${redactedRemotePath}`,
    `- Remote size (bytes): ${fetched.size_bytes}`,
    `- Remote SHA-256: ${fetched.sha256}`,
    "",
    "## Metrics",
    "",
    Object.keys(metrics).length ? "```json\n" + JSON.stringify(metrics, null, 2) + "\n```" : "No metrics were extracted from the remote file.",
    ""
  ].join("\n");
}

function listLocalFiles(root: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) {
    return results;
  }
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        stack.push(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      results.push(current);
    }
  }
  return results.sort();
}

function artifactIdFor(remotePath: string): string {
  return `artifact-${crypto.createHash("sha256").update(remotePath).digest("hex").slice(0, 24)}`;
}

// artifacts' bare failure wording ("command timed out" / scrubbed stderr / "exit N"), threaded into
// the shared summarizer. A thin local adapter keeps the existing positional call sites unchanged.
function summarizeBareFailure(stderr: string, exitCode: number | null, timedOut?: boolean): string {
  return summarizeRemoteFailure(
    { stderr, exitCode, timedOut },
    {
      timedOut: "command timed out",
      failed: (summary) => summary,
      exited: (code) => `exit ${String(code)}`
    }
  );
}

function redactRemotePath(value: string, userPrefixes: string[] = []): string {
  return maskUserRootPath(value, userPrefixes);
}

function assertSafeOutputToken(value: string): void {
  if (!value || value.split("/").includes("..") || /[\s`"';&|<>()[\]]/.test(value) || !/^[A-Za-z0-9_./${}-]+$/.test(value)) {
    throw new Error(`Unsafe artifact output path: ${value}`);
  }
}

function assertSafeArtifactId(value: string): void {
  if (!/^artifact-[a-f0-9]{24}$/.test(value)) {
    throw new Error(`Unsafe artifact_id: ${value}`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!isHexDigest(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function normalizeMaxEntries(value?: number): number {
  return boundedInteger(value, { default: DEFAULT_MAX_ENTRIES, min: 1, max: MAX_ENTRIES, label: "maxEntries" });
}

function normalizeByteLimit(value: number | undefined, defaultValue: number, maxValue: number, label: string): number {
  return boundedInteger(value, { default: defaultValue, min: 1, max: maxValue, label });
}

function normalizeArtifactIds(value: string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_ARTIFACTS) {
    throw new Error(`artifactIds must contain between 1 and ${MAX_BATCH_ARTIFACTS} ids`);
  }
  const ids = value.map((artifactId) => {
    assertSafeArtifactId(artifactId);
    return artifactId;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("artifactIds must be unique");
  }
  return ids;
}

const defaultArtifactExecutor: ArtifactExecutor = runProcess;

export const ARTIFACT_LIST_PY = String.raw`${pyImports(["base64", "hashlib", "json", "os", "sys"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("artifact list")}
outputs = spec.get("outputs")
workdir = spec.get("workdir")
max_entries = spec.get("max_entries")
checksum_max_bytes = spec.get("checksum_max_bytes")
if not isinstance(outputs, list) or not isinstance(workdir, str) or not isinstance(max_entries, int) or not isinstance(checksum_max_bytes, int):
    fail("invalid artifact list spec fields")

artifacts = []
truncated = False
workdir_real = os.path.realpath(os.path.expandvars(workdir))

${PY_INSIDE_REALPATH}
${PY_SHA256_FILE}
def append_entry(entry):
    global truncated
    if len(artifacts) >= max_entries:
        truncated = True
        return False
    artifacts.append(entry)
    return True

for output in outputs:
    if not isinstance(output, dict):
        fail("invalid output entry")
    raw_path = output.get("path")
    if not isinstance(raw_path, str) or not raw_path.startswith("/"):
        fail("invalid output path")
    root = os.path.expandvars(raw_path)
    root_real = os.path.realpath(root)
    if os.path.exists(root) and not inside_realpath(root_real, workdir_real):
        fail("output realpath escapes planned workdir")
    source_output = raw_path
    if not os.path.exists(root):
        append_entry({
            "path": raw_path,
            "relative_path": "",
            "kind": "missing",
            "checksum_status": "missing",
            "source_output": source_output,
        })
        continue
    if os.path.isfile(root):
        if not inside_realpath(root_real, workdir_real):
            fail("file output realpath escapes planned workdir")
        size = os.path.getsize(root)
        entry = {
            "path": raw_path,
            "relative_path": os.path.basename(root),
            "kind": "file",
            "size_bytes": size,
            "checksum_status": "skipped-large" if size > checksum_max_bytes else "captured",
            "source_output": source_output,
        }
        if size <= checksum_max_bytes:
            entry["sha256"] = sha256_file(root)
        append_entry(entry)
        continue
    if not os.path.isdir(root):
        append_entry({
            "path": raw_path,
            "relative_path": "",
            "kind": "other",
            "checksum_status": "not-file",
            "source_output": source_output,
        })
        continue
    append_entry({
        "path": raw_path,
        "relative_path": "",
        "kind": "directory",
        "checksum_status": "not-file",
        "source_output": source_output,
    })
    for current, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        for filename in filenames:
            full = os.path.join(current, filename)
            full_real = os.path.realpath(full)
            if not inside_realpath(full_real, root_real) or not inside_realpath(full_real, workdir_real):
                fail("artifact realpath escapes declared output")
            rel = os.path.relpath(full, root)
            size = os.path.getsize(full)
            entry = {
                "path": raw_path.rstrip("/") + "/" + rel,
                "relative_path": rel,
                "kind": "file",
                "size_bytes": size,
                "checksum_status": "skipped-large" if size > checksum_max_bytes else "captured",
                "source_output": source_output,
            }
            if size <= checksum_max_bytes:
                entry["sha256"] = sha256_file(full)
            if not append_entry(entry):
                break
        if truncated:
            break
    if truncated:
        break

print(json.dumps({"artifacts": artifacts, "truncated": truncated}, sort_keys=True))
`;

export const ARTIFACT_FETCH_PY = String.raw`${pyImports(["base64", "hashlib", "json", "os", "sys"])}
${PY_FAIL_CODED}
${PY_DECODE_SPEC("artifact fetch")}
raw_path = spec.get("path")
allowed_root = spec.get("allowed_root")
workdir = spec.get("workdir")
max_bytes = spec.get("max_bytes")
if not isinstance(raw_path, str) or not raw_path.startswith("/") or not isinstance(allowed_root, str) or not allowed_root.startswith("/") or not isinstance(workdir, str) or not workdir.startswith("/") or not isinstance(max_bytes, int):
    fail("invalid artifact fetch spec fields")

path = os.path.expandvars(raw_path)
allowed_root_real = os.path.realpath(os.path.expandvars(allowed_root))
workdir_real = os.path.realpath(os.path.expandvars(workdir))
path_real = os.path.realpath(path)

${PY_INSIDE_REALPATH}
if not inside_realpath(allowed_root_real, workdir_real):
    fail("allowed root realpath escapes planned workdir")
if not inside_realpath(path_real, allowed_root_real) or not inside_realpath(path_real, workdir_real):
    fail("artifact realpath escapes declared output")
if not os.path.isfile(path_real):
    fail("artifact path is not a regular file", 3)
size = os.path.getsize(path_real)
if size > max_bytes:
    fail(f"artifact exceeds max_bytes: {size}", 4)

with open(path_real, "rb") as handle:
    content = handle.read()

print(json.dumps({
    "content_b64": base64.b64encode(content).decode("ascii"),
    "size_bytes": size,
    "sha256": hashlib.sha256(content).hexdigest(),
}, sort_keys=True))
`;

export const ARTIFACT_CLEANUP_EXECUTE_PY = String.raw`${pyImports(["base64", "hashlib", "json", "os", "sys"])}
${PY_FAIL_CODED}
${PY_DECODE_SPEC("artifact cleanup")}
workdir = spec.get("workdir")
targets = spec.get("targets")
max_entries = spec.get("max_entries")
max_total_bytes = spec.get("max_total_bytes")
if not isinstance(workdir, str) or not workdir.startswith("/") or not isinstance(targets, list) or not isinstance(max_entries, int) or not isinstance(max_total_bytes, int):
    fail("invalid artifact cleanup spec fields")
if len(targets) > max_entries:
    fail("artifact cleanup target count exceeds max_entries")

workdir_real = os.path.realpath(os.path.expandvars(workdir))

${PY_INSIDE_REALPATH}
${PY_SHA256_FILE}
prepared = []
total_deleted_bytes = 0
for target in targets:
    if not isinstance(target, dict):
        fail("invalid artifact cleanup target")
    raw_path = target.get("path")
    allowed_root = target.get("allowed_root")
    size_bytes = target.get("size_bytes")
    sha256 = target.get("sha256")
    if not isinstance(raw_path, str) or not raw_path.startswith("/") or not isinstance(allowed_root, str) or not allowed_root.startswith("/") or not isinstance(size_bytes, int) or not isinstance(sha256, str):
        fail("invalid artifact cleanup target fields")
    path = os.path.expandvars(raw_path)
    allowed_root_real = os.path.realpath(os.path.expandvars(allowed_root))
    if not inside_realpath(allowed_root_real, workdir_real):
        fail("allowed cleanup root realpath escapes planned workdir")
    if not os.path.exists(path):
        fail("artifact cleanup target is missing")
    if os.path.islink(path):
        fail("artifact cleanup target must not be a symbolic link")
    path_real = os.path.realpath(path)
    if not inside_realpath(path_real, allowed_root_real) or not inside_realpath(path_real, workdir_real):
        fail("artifact cleanup target realpath escapes declared output")
    if not os.path.isfile(path_real):
        fail("artifact cleanup target is not a regular file")
    observed_size = os.path.getsize(path_real)
    if observed_size != size_bytes:
        fail("artifact cleanup target size does not match manifest")
    observed_sha256 = sha256_file(path_real)
    if observed_sha256 != sha256:
        fail("artifact cleanup target checksum does not match manifest")
    total_deleted_bytes += observed_size
    if total_deleted_bytes > max_total_bytes:
        fail("artifact cleanup target bytes exceed max_total_bytes")
    prepared.append((raw_path, path_real))

deleted_files = []
for raw_path, path_real in prepared:
    os.unlink(path_real)
    deleted_files.append(raw_path)

print(json.dumps({
    "deleted_files": deleted_files,
    "missing": [],
    "total_deleted_bytes": total_deleted_bytes,
}, sort_keys=True))
`;
