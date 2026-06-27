import crypto from "node:crypto";
import { assertSafeApprovalId, assertSafeRunId } from "../../core/ids.js";
import fs from "node:fs";
import path from "node:path";
import { runProcess } from "../../lib/process.js";
import { pyImports, PY_FAIL_FIXED, PY_DECODE_SPEC, PY_INSIDE_REALPATH, PY_SHA256_FILE } from "../../lib/remote-python.js";
import { assertApprovalBoundTo } from "../../lib/auth.js";
import { approvalStatus, consumeApproval } from "../approvals/approvals.js";
import { maskCommandArgs, summarizeRemoteFailure } from "../../lib/redact.js";
import {
  assertSafeSshTarget,
  boundedInteger,
  canonicalize,
  encodeSpec,
  isHexDigest,
  isInsideRemoteRoot,
  normalizeTimeout,
  parseJsonLastLine,
  safeTimestamp,
  sha256File,
  sshTimeoutSeconds,
  stableJson,
  stripTrailingSlash
} from "../../lib/shared.js";
import { sshOuterHopFlags, sshSingleHopArgs } from "../../lib/ssh.js";
import type { CommandResult } from "../../core/access.js";
import { getProfile, maskUserRootPath, userRootPrefixes } from "../../core/config.js";
import { assertInsideProject, assertInsideRuntime, projectRoot, assertRealPathInside, RUNTIME_DIRS } from "../../core/paths.js";
import { runRecordRoot, writeEvidenceJson } from "../../lib/evidence.js";
import { assertSafePath } from "../plans/planner.js";
import { renderTemplate, shellSingleQuote } from "../catalog/templates.js";
import { assertPlannedTransfer, assertTransferExecutionRecord, assertTransferPlan } from "../../core/validation.js";
import type { ApprovalRecord, ComputeProfile, PlannedTransfer, TransferExecutionRecord, TransferPlan } from "../../core/types.js";

export interface TransferOptions {
  configPath?: string;
  transferDir?: string;
  writePlan?: boolean;
  now?: Date;
  timeoutMs?: number;
  approvalDir?: string;
  executor?: TransferExecutor;
}

export type TransferExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin?: string
) => Promise<CommandResult>;

interface TransferPreflightFile {
  path: string;
  size_bytes: number;
  sha256?: string;
  checksum_status?: "verified" | "captured" | "skipped-large";
}

interface TransferPreflight {
  files: TransferPreflightFile[];
  total_size_bytes: number;
}

interface TransferExecutionOutput {
  mode: "live";
  run_id: string;
  profile_id: string;
  platform: string;
  direction: "upload" | "download";
  approval_id?: string;
  plan_hash: string;
  transferred_at: string;
  files: TransferPreflightFile[];
  total_size_bytes: number;
  max_total_bytes: number;
  command: {
    program: "rsync";
    args: string[];
  };
  evidence_path: string;
}

const DEFAULT_TRANSFER_DIR: string = RUNTIME_DIRS.transfers;
// Timeout policy (per-module, deliberate): transfers move large datasets over rsync, so this module
// defaults HIGH (30s) and caps at 10 minutes — far above the 30s cap of every other module. This
// generous ceiling is policy, not an accident; flattening it to the shared 30000ms cap would break
// long-running transfers. Keep these named module-local consts.
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TRANSFER_FILES = 1000;
const MAX_TRANSFER_BYTES = 50_000_000_000;
const TRANSFER_CHECKSUM_MAX_BYTES = 50_000_000;

export function planTransfer(rawTransferPlan: unknown, options: TransferOptions = {}): PlannedTransfer {
  assertTransferPlan(rawTransferPlan);
  const profile = getProfile(rawTransferPlan.profile_id, options.configPath);

  assertSafePath(rawTransferPlan.source, "source");
  assertSafePath(rawTransferPlan.destination, "destination");
  assertTransferRootCharacters(rawTransferPlan.source, "source");
  assertTransferRootCharacters(rawTransferPlan.destination, "destination");

  const files = rawTransferPlan.files ? normalizeTransferFiles(rawTransferPlan.files) : undefined;
  const maxTotalBytes = normalizeMaxTotalBytes(rawTransferPlan.max_total_bytes);
  const script = renderTemplate("transfer-rsync", {
    source: rawTransferPlan.source,
    destination: rawTransferPlan.destination,
    source_single_quoted: shellSingleQuote(rawTransferPlan.source),
    destination_single_quoted: shellSingleQuote(rawTransferPlan.destination)
  });
  const quotaSnapshotId = quotaSnapshotIdFor(profile);
  const planForHash = {
    run_id: rawTransferPlan.run_id,
    profile_id: rawTransferPlan.profile_id,
    platform: profile.platform,
    direction: rawTransferPlan.direction,
    source: rawTransferPlan.source,
    destination: rawTransferPlan.destination,
    ...(files ? { files } : {}),
    ...(maxTotalBytes ? { max_total_bytes: maxTotalBytes } : {}),
    template: "transfer-rsync",
    script
  };
  const planHash = buildTransferPlanHash(planForHash);

  const plan: PlannedTransfer = {
    mode: "dry-run",
    run_id: rawTransferPlan.run_id,
    profile_id: rawTransferPlan.profile_id,
    platform: profile.platform,
    direction: rawTransferPlan.direction,
    plan_hash: planHash,
    ...(quotaSnapshotId ? { quota_snapshot_id: quotaSnapshotId } : {}),
    source: rawTransferPlan.source,
    destination: rawTransferPlan.destination,
    ...(files ? { files } : {}),
    ...(maxTotalBytes ? { max_total_bytes: maxTotalBytes } : {}),
    script,
    warnings: [
      `M1 transfer plan only renders rsync text for profile ${profile.profile_id}; it does not run rsync or contact UTS systems`,
      "Live transfer execution requires explicit files, max_total_bytes, and a matching transfers.execute approval"
    ]
  };

  if (options.writePlan ?? true) {
    plan.plan_path = writeTransferPlanArtifact(plan, options.transferDir);
  }
  return plan;
}

export function buildTransferPlanHash(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

export async function executeTransfer(
  input: { runId: string; approvalId?: string; timeoutMs?: number },
  options: TransferOptions = {}
): Promise<{ transfer: TransferExecutionOutput }> {
  assertSafeRunId(input.runId);
  if (input.approvalId !== undefined) {
    assertSafeApprovalId(input.approvalId);
  }
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(input.timeoutMs ?? options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultTransferExecutor;
  const plan = readTransferPlanArtifact(input.runId, options.transferDir);
  const profile = getProfile(plan.profile_id, options.configPath);
  const recomputedHash = buildTransferPlanHash(transferPlanHashPayload(plan));
  if (recomputedHash !== plan.plan_hash) {
    throw new Error("Planned transfer artifact plan_hash does not match its rendered content");
  }
  // transfers.execute is autonomous: the saved plan_hash, fixed file list, max_total_bytes, and
  // checksum verification are the gate. A transfers.execute approval is accepted but not required.
  let approval: ApprovalRecord | undefined;
  if (input.approvalId) {
    approval = approvalStatus({ approvalId: input.approvalId }, { approvalDir: options.approvalDir, now }).approval;
    assertTransferApproval(approval, plan);
  }
  const files = requireTransferFiles(plan);
  const maxTotalBytes = requireMaxTotalBytes(plan);
  const sourceRoot = stripTrailingSlash(plan.source);
  const destinationRoot = stripTrailingSlash(plan.destination);
  let preflight =
    plan.direction === "download"
      ? await preflightRemoteDownload(plan, profile, files, maxTotalBytes, timeoutMs, executor)
      : preflightLocalUpload(plan, profile, files, maxTotalBytes);

  if (approval) {
    consumeApproval(
      {
        approvalId: approval.approval_id,
        runId: plan.run_id,
        profileId: plan.profile_id,
        platform: plan.platform,
        operation: "transfers.execute",
        planHash: plan.plan_hash,
        quotaSnapshotId: approval.quota_snapshot_id,
        consumedBy: `transfers.execute:${plan.direction}:${files.length}:${maxTotalBytes}`
      },
      { approvalDir: options.approvalDir, now }
    );
  }

  if (plan.direction === "download") {
    fs.mkdirSync(destinationRoot, { recursive: true });
  }
  const args = rsyncArgs(plan, profile, timeoutMs);
  const result = await executor("rsync", args, timeoutMs, `${files.join("\n")}\n`);
  if (result.exitCode !== 0) {
    throw new Error(`transfer rsync failed: ${summarizeFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  if (plan.direction === "download") {
    verifyDownloadedFiles(destinationRoot, preflight);
  } else {
    const remotePostflight = await inspectRemoteTransferFiles(plan.destination, profile, files, maxTotalBytes, timeoutMs, executor);
    verifyUploadedFiles(preflight, remotePostflight);
    preflight = remotePostflight;
  }
  const userPrefixes = userRootPrefixes(profile);
  const redactedCommand = redactedRsyncCommand(args, profile.login.host_alias, sourceRoot, destinationRoot, userPrefixes);
  const evidencePath = writeTransferEvidence(plan, approval, preflight, redactedCommand, now, options.transferDir, userPrefixes);

  return {
    transfer: {
      mode: "live",
      run_id: plan.run_id,
      profile_id: plan.profile_id,
      platform: plan.platform,
      direction: plan.direction,
      ...(approval ? { approval_id: approval.approval_id } : {}),
      plan_hash: plan.plan_hash,
      transferred_at: now.toISOString(),
      files: preflight.files,
      total_size_bytes: preflight.total_size_bytes,
      max_total_bytes: maxTotalBytes,
      command: redactedCommand,
      evidence_path: evidencePath
    }
  };
}

function transferPlanHashPayload(plan: PlannedTransfer): Record<string, unknown> {
  return {
    run_id: plan.run_id,
    profile_id: plan.profile_id,
    platform: plan.platform,
    direction: plan.direction,
    source: plan.source,
    destination: plan.destination,
    ...(plan.files ? { files: plan.files } : {}),
    ...(plan.max_total_bytes ? { max_total_bytes: plan.max_total_bytes } : {}),
    template: "transfer-rsync",
    script: plan.script
  };
}

function writeTransferPlanArtifact(plan: PlannedTransfer, transferDir = DEFAULT_TRANSFER_DIR): string {
  assertPlannedTransfer(plan);
  const root = transferRunRoot(plan.run_id, transferDir);
  return writeEvidenceJson(root, "plan.json", plan, "Transfer plan artifact");
}

function readTransferPlanArtifact(runId: string, transferDir = DEFAULT_TRANSFER_DIR): PlannedTransfer {
  const root = transferRunRoot(runId, transferDir);
  const filePath = path.join(root, "plan.json");
  assertRealPathInside(filePath, root, "Transfer plan artifact");
  const plan = JSON.parse(fs.readFileSync(filePath, "utf8")) as PlannedTransfer;
  assertPlannedTransfer(plan);
  if (plan.run_id !== runId || plan.mode !== "dry-run") {
    throw new Error("Transfer plan artifact does not match the requested run");
  }
  return plan;
}

function transferRunRoot(runId: string, transferDir = DEFAULT_TRANSFER_DIR): string {
  return runRecordRoot(transferDir, runId, "Transfer directory");
}

function preflightLocalUpload(
  plan: PlannedTransfer,
  profile: ComputeProfile,
  files: string[],
  maxTotalBytes: number
): TransferPreflight {
  assertRemoteRootInsideProfile(plan.destination, profile, "destination");
  const sourceRoot = assertExistingDirectoryInsideProject(plan.source, "Transfer source");
  const preflightFiles = files.map((file) => {
    const candidate = path.join(sourceRoot, file);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(sourceRoot, realCandidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Transfer upload file must stay inside the planned source");
    }
    const stat = fs.statSync(realCandidate);
    if (!stat.isFile()) {
      throw new Error(`Transfer upload file is not a regular file: ${file}`);
    }
    return {
      path: file,
      size_bytes: stat.size,
      ...checksumForFile(realCandidate, stat.size)
    };
  });
  const totalSizeBytes = preflightFiles.reduce((total, file) => total + file.size_bytes, 0);
  if (totalSizeBytes > maxTotalBytes) {
    throw new Error("Transfer upload file sizes exceed max_total_bytes before rsync");
  }
  return { files: preflightFiles, total_size_bytes: totalSizeBytes };
}

async function preflightRemoteDownload(
  plan: PlannedTransfer,
  profile: ComputeProfile,
  files: string[],
  maxTotalBytes: number,
  timeoutMs: number,
  executor: TransferExecutor
): Promise<TransferPreflight> {
  assertRemoteRootInsideProfile(plan.source, profile, "source");
  assertDestinationInsideRuntime(plan.destination);
  return inspectRemoteTransferFiles(plan.source, profile, files, maxTotalBytes, timeoutMs, executor);
}

async function inspectRemoteTransferFiles(
  remoteRoot: string,
  profile: ComputeProfile,
  files: string[],
  maxTotalBytes: number,
  timeoutMs: number,
  executor: TransferExecutor
): Promise<TransferPreflight> {
  assertRemoteRootInsideProfile(remoteRoot, profile, "transfer root");
  const spec = encodeSpec({
    root: remoteRoot,
    files,
    max_total_bytes: maxTotalBytes,
    checksum_max_bytes: TRANSFER_CHECKSUM_MAX_BYTES
  });
  const args = sshPreflightArgs(profile.login.host_alias, timeoutMs, spec);
  const result = await executor("ssh", args, timeoutMs, TRANSFER_PREFLIGHT_PY);
  if (result.exitCode !== 0) {
    throw new Error(`transfer preflight failed: ${summarizeFailure(result.stderr, result.exitCode, result.timedOut)}`);
  }
  return parseTransferPreflight(result.stdout, files, maxTotalBytes, TRANSFER_CHECKSUM_MAX_BYTES);
}

function parseTransferPreflight(
  stdout: string,
  expectedFiles: string[],
  maxTotalBytes: number,
  checksumMaxBytes: number
): TransferPreflight {
  const parsed = parseJsonLastLine(stdout, "transfer preflight") as { files?: unknown; total_size_bytes?: unknown };
  const totalSizeBytes = parsed.total_size_bytes;
  if (!Array.isArray(parsed.files) || typeof totalSizeBytes !== "number" || !Number.isInteger(totalSizeBytes) || totalSizeBytes < 0) {
    throw new Error("transfer preflight helper returned invalid metadata");
  }
  const files = parsed.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("transfer preflight helper returned invalid file entry");
    }
    const record = entry as { path?: unknown; size_bytes?: unknown; sha256?: unknown; checksum_status?: unknown };
    const sizeBytes = record.size_bytes;
    if (typeof record.path !== "string" || typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error("transfer preflight helper returned invalid file metadata");
    }
    assertSafeTransferFile(record.path);
    const checksum = parseTransferChecksum(record, sizeBytes, checksumMaxBytes);
    return {
      path: record.path,
      size_bytes: sizeBytes,
      ...checksum
    };
  });
  if (JSON.stringify(files.map((entry) => entry.path)) !== JSON.stringify(expectedFiles)) {
    throw new Error("transfer preflight helper file list does not match the saved transfer plan");
  }
  const summedSizeBytes = files.reduce((total, entry) => total + entry.size_bytes, 0);
  if (summedSizeBytes !== totalSizeBytes) {
    throw new Error("transfer preflight helper total_size_bytes does not match returned files");
  }
  if (totalSizeBytes > maxTotalBytes) {
    throw new Error("transfer preflight helper returned more bytes than requested");
  }
  return {
    files,
    total_size_bytes: totalSizeBytes
  };
}

function verifyDownloadedFiles(destinationRoot: string, preflight: TransferPreflight): void {
  const resolvedDestinationRoot = assertDestinationInsideRuntime(destinationRoot);
  for (const file of preflight.files) {
    assertSafeTransferFile(file.path);
    const candidate = path.join(resolvedDestinationRoot, file.path);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Transfer download file is missing after rsync: ${file.path}`);
    }
    const lstat = fs.lstatSync(candidate);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Transfer download file must not be a symbolic link: ${file.path}`);
    }
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(resolvedDestinationRoot, realCandidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Transfer download file must stay inside the planned destination");
    }
    const stat = fs.statSync(realCandidate);
    if (!stat.isFile()) {
      throw new Error(`Transfer download file is not a regular file: ${file.path}`);
    }
    if (stat.size !== file.size_bytes) {
      throw new Error(`Transfer download file size does not match preflight metadata: ${file.path}`);
    }
    if (file.checksum_status === "captured") {
      if (!file.sha256) {
        throw new Error(`Transfer download checksum metadata is missing: ${file.path}`);
      }
      const localSha256 = sha256File(realCandidate);
      if (localSha256 !== file.sha256) {
        throw new Error(`Transfer download file checksum does not match preflight metadata: ${file.path}`);
      }
      file.checksum_status = "verified";
    }
  }
}

function verifyUploadedFiles(localPreflight: TransferPreflight, remotePostflight: TransferPreflight): void {
  if (remotePostflight.total_size_bytes !== localPreflight.total_size_bytes) {
    throw new Error("Transfer upload remote verification total_size_bytes does not match local preflight metadata");
  }
  for (let index = 0; index < localPreflight.files.length; index += 1) {
    const localFile = localPreflight.files[index];
    const remoteFile = remotePostflight.files[index];
    if (!remoteFile || remoteFile.path !== localFile.path) {
      throw new Error("Transfer upload remote verification file list does not match local preflight metadata");
    }
    if (remoteFile.size_bytes !== localFile.size_bytes) {
      throw new Error(`Transfer upload remote file size does not match local preflight metadata: ${localFile.path}`);
    }
    if (localFile.checksum_status === "skipped-large") {
      if (remoteFile.checksum_status !== "skipped-large" || remoteFile.sha256 !== undefined) {
        throw new Error(`Transfer upload remote checksum status does not match local preflight metadata: ${localFile.path}`);
      }
      continue;
    }
    if (localFile.checksum_status !== "captured" || !localFile.sha256) {
      throw new Error(`Transfer upload local checksum metadata is missing: ${localFile.path}`);
    }
    if (remoteFile.checksum_status !== "captured" || !remoteFile.sha256) {
      throw new Error(`Transfer upload remote checksum metadata is missing: ${localFile.path}`);
    }
    if (remoteFile.sha256 !== localFile.sha256) {
      throw new Error(`Transfer upload remote file checksum does not match local preflight metadata: ${localFile.path}`);
    }
    remoteFile.checksum_status = "verified";
  }
}

function parseTransferChecksum(
  record: { sha256?: unknown; checksum_status?: unknown },
  sizeBytes: number,
  checksumMaxBytes: number
): Pick<TransferPreflightFile, "sha256" | "checksum_status"> {
  if (record.checksum_status !== "captured" && record.checksum_status !== "skipped-large") {
    throw new Error("transfer preflight helper returned invalid checksum status");
  }
  if (sizeBytes <= checksumMaxBytes && record.checksum_status === "skipped-large") {
    throw new Error("transfer preflight helper skipped checksum for checksum-eligible file");
  }
  if (sizeBytes > checksumMaxBytes && record.checksum_status === "captured") {
    throw new Error("transfer preflight helper returned checksum for file over checksum limit");
  }
  if (record.checksum_status === "captured") {
    if (typeof record.sha256 !== "string" || !isHexDigest(record.sha256)) {
      throw new Error("transfer preflight helper returned invalid checksum");
    }
    return {
      sha256: record.sha256,
      checksum_status: "captured"
    };
  }
  if (record.sha256 !== undefined) {
    throw new Error("transfer preflight helper returned checksum for skipped-large file");
  }
  return {
    checksum_status: "skipped-large"
  };
}

function checksumForFile(filePath: string, sizeBytes: number): Pick<TransferPreflightFile, "sha256" | "checksum_status"> {
  if (sizeBytes > TRANSFER_CHECKSUM_MAX_BYTES) {
    return { checksum_status: "skipped-large" };
  }
  return {
    sha256: sha256File(filePath),
    checksum_status: "captured"
  };
}

function transferChecksumPolicy() {
  return {
    algorithm: "sha256" as const,
    max_file_bytes: TRANSFER_CHECKSUM_MAX_BYTES
  };
}

function rsyncArgs(plan: PlannedTransfer, profile: ComputeProfile, timeoutMs: number): string[] {
  // rsync is structurally unlike the single-hop argv builders: the host alias is embedded in the
  // source/destination tokens (`host:/root/...`), NOT in the `-e` ssh string — so this guard stays
  // here and we compose the shared outer-hop prelude into the `-e` string by hand (no host alias,
  // trailing `-T`). Only the 7-pair hardening prelude is shared; the rest is rsync policy.
  assertSafeSshTarget(profile.login.host_alias);
  const sshCommand = ["ssh", ...sshOuterHopFlags(sshTimeoutSeconds(timeoutMs)), "-T"].join(" ");
  const source =
    plan.direction === "download"
      ? `${profile.login.host_alias}:${ensureTrailingSlash(plan.source)}`
      : ensureTrailingSlash(assertExistingDirectoryInsideProject(plan.source, "Transfer source"));
  const destination =
    plan.direction === "download"
      ? ensureTrailingSlash(assertDestinationInsideRuntime(plan.destination))
      : `${profile.login.host_alias}:${ensureTrailingSlash(plan.destination)}`;
  return ["-a", "--checksum", "--files-from=-", "-e", sshCommand, source, destination];
}

function sshPreflightArgs(hostAlias: string, timeoutMs: number, encodedSpec: string): string[] {
  // The encodedSpec-safety regex (and its transfer-preflight wording) stays here — it is this tool's
  // policy. The shared single-hop primitive owns the hardening prelude + `-T` + host-alias guard.
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSpec)) {
    throw new Error("Transfer preflight spec encoding is not safe for SSH argv");
  }
  return sshSingleHopArgs(hostAlias, sshTimeoutSeconds(timeoutMs), {
    tty: true,
    trailing: ["python3", "-", encodedSpec]
  });
}

function assertTransferApproval(approval: ApprovalRecord, plan: PlannedTransfer): void {
  assertApprovalBoundTo(approval, {
    operation: "transfers.execute",
    runId: plan.run_id,
    profileId: plan.profile_id,
    platform: plan.platform,
    planHash: plan.plan_hash,
    identityMessage: "Transfer approval does not match the plan identity",
    planHashMessage: "Transfer approval plan_hash does not match the saved plan"
  });
  const summary = approval.resource_summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("Transfer approval must include resource_summary");
  }
  const expectedFiles = requireTransferFiles(plan);
  if (
    summary.direction !== plan.direction ||
    summary.source !== plan.source ||
    summary.destination !== plan.destination ||
    summary.max_total_bytes !== requireMaxTotalBytes(plan) ||
    JSON.stringify(summary.files) !== JSON.stringify(expectedFiles)
  ) {
    throw new Error("Transfer approval resource_summary does not match the saved plan");
  }
}

function writeTransferEvidence(
  plan: PlannedTransfer,
  approval: ApprovalRecord | undefined,
  preflight: TransferPreflight,
  command: TransferExecutionOutput["command"],
  now: Date,
  transferDir = DEFAULT_TRANSFER_DIR,
  userPrefixes: string[] = []
): string {
  const root = transferRunRoot(plan.run_id, transferDir);
  const record: TransferExecutionRecord = {
    run_id: plan.run_id,
    profile_id: plan.profile_id,
    platform: plan.platform,
    ...(approval ? { approval_id: approval.approval_id } : {}),
    kind: "transfer-execute",
    observed_at: now.toISOString(),
    evidence: {
      direction: plan.direction,
      source: redactEndpoint(plan.source, userPrefixes),
      destination: redactEndpoint(plan.destination, userPrefixes),
      files: preflight.files,
      checksum_policy: transferChecksumPolicy(),
      total_size_bytes: preflight.total_size_bytes,
      max_total_bytes: requireMaxTotalBytes(plan),
      command
    }
  };
  assertTransferExecutionRecord(record);
  return writeEvidenceJson(root, `execute-${safeTimestamp(now)}.json`, record, "Transfer execution evidence");
}

function redactedRsyncCommand(args: string[], hostAlias: string, sourceRoot: string, destinationRoot: string, userPrefixes: string[] = []) {
  return {
    program: "rsync" as const,
    // SUBSTRING mode: rsync argv elements embed the host alias and source/destination roots as
    // substrings of a single `host:/root/…` token, so every occurrence is masked (not just whole-arg
    // matches). Order is load-bearing: host alias first, then each root's endpoint mask, then the
    // local project root — exactly the prior replaceAll chain.
    args: maskCommandArgs(
      args,
      [
        { match: hostAlias, replace: "<profile-host>" },
        { match: sourceRoot, replace: redactEndpoint(sourceRoot, userPrefixes) },
        { match: destinationRoot, replace: redactEndpoint(destinationRoot, userPrefixes) },
        { match: projectRoot, replace: "<project>" }
      ],
      { mode: "substring" }
    )
  };
}

function requireTransferFiles(plan: PlannedTransfer): string[] {
  if (!plan.files?.length) {
    throw new Error("transfers.execute requires an explicit files list in the saved transfer plan");
  }
  return normalizeTransferFiles(plan.files);
}

function requireMaxTotalBytes(plan: PlannedTransfer): number {
  if (!plan.max_total_bytes) {
    throw new Error("transfers.execute requires max_total_bytes in the saved transfer plan");
  }
  const normalized = normalizeMaxTotalBytes(plan.max_total_bytes);
  if (!normalized) {
    throw new Error("transfers.execute requires max_total_bytes in the saved transfer plan");
  }
  return normalized;
}

function normalizeTransferFiles(files: string[]): string[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_TRANSFER_FILES) {
    throw new Error(`transfer files must contain between 1 and ${MAX_TRANSFER_FILES} entries`);
  }
  const normalized = files.map((file) => {
    assertSafeTransferFile(file);
    return file.replace(/^\.\/+/, "");
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("transfer files must be unique");
  }
  return normalized;
}

function assertSafeTransferFile(file: string): void {
  if (
    !file ||
    file.startsWith("/") ||
    file.split("/").includes("..") ||
    /[\s`"';&|<>()[\]{}$\\]/.test(file) ||
    !/^[A-Za-z0-9_./-]+$/.test(file)
  ) {
    throw new Error(`Unsafe transfer file path: ${file}`);
  }
}

// Thin undefined-passthrough wrapper: absence means "unlimited", so we do NOT impose a numeric
// default. Only a supplied value is bounds-checked (1 .. 50GB).
function normalizeMaxTotalBytes(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return boundedInteger(value, { default: value, min: 1, max: MAX_TRANSFER_BYTES, label: "max_total_bytes" });
}

function assertRemoteRootInsideProfile(remoteRoot: string, profile: ComputeProfile, label: string): void {
  assertSafePath(remoteRoot, label);
  assertTransferRootCharacters(remoteRoot, label);
  const roots = [profile.defaults.workspace, profile.defaults.scratch, profile.defaults.project].filter((value): value is string =>
    Boolean(value)
  );
  if (roots.length > 0 && !roots.some((root) => isInsideRemoteRoot(remoteRoot, root))) {
    throw new Error(`Transfer ${label} must stay inside profile workspace, scratch, or project roots`);
  }
}

function assertTransferRootCharacters(value: string, label: string): void {
  if (/[\s]/.test(value)) {
    throw new Error(`Transfer ${label} must not contain whitespace`);
  }
}

function assertExistingDirectoryInsideProject(candidatePath: string, label: string): string {
  const resolved = assertInsideProject(candidatePath, label);
  const realCandidate = fs.realpathSync(resolved);
  const realRoot = fs.realpathSync(projectRoot);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the project root`);
  }
  const stat = fs.statSync(realCandidate);
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be an existing directory`);
  }
  return realCandidate;
}

function assertDestinationInsideRuntime(candidatePath: string): string {
  const resolved = assertInsideRuntime(candidatePath, "Transfer destination");
  fs.mkdirSync(resolved, { recursive: true });
  const realCandidate = fs.realpathSync(resolved);
  const runtimeRoot = fs.realpathSync(assertInsideRuntime(DEFAULT_TRANSFER_DIR, "Transfer directory"));
  const relative = path.relative(runtimeRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Transfer destination must stay inside the transfer runtime directory");
  }
  return realCandidate;
}

function ensureTrailingSlash(value: string): string {
  return `${stripTrailingSlash(value)}/`;
}

function quotaSnapshotIdFor(profile: ComputeProfile): string | undefined {
  const snapshot = profile.quota_snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const candidate = (snapshot as { snapshot_id?: unknown }).snapshot_id;
  return typeof candidate === "string" ? candidate : undefined;
}

function redactEndpoint(value: string, userPrefixes: string[] = []): string {
  const projectRelative = path.isAbsolute(value) ? path.relative(projectRoot, value) : value;
  if (path.isAbsolute(value) && !projectRelative.startsWith("..") && !path.isAbsolute(projectRelative)) {
    return `<project>/${projectRelative}`;
  }
  return maskUserRootPath(value, userPrefixes);
}

// transfer's bare failure wording ("command timed out" / scrubbed stderr / "exit N"), threaded into
// the shared summarizer. A thin local adapter keeps the existing positional call sites unchanged.
function summarizeFailure(stderr: string, exitCode: number | null, timedOut?: boolean): string {
  return summarizeRemoteFailure(
    { stderr, exitCode, timedOut },
    {
      timedOut: "command timed out",
      failed: (summary) => summary,
      exited: (code) => `exit ${String(code)}`
    }
  );
}

const defaultTransferExecutor: TransferExecutor = runProcess;

export const TRANSFER_PREFLIGHT_PY = String.raw`${pyImports(["base64", "hashlib", "json", "os", "sys"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("transfer preflight")}
root = spec.get("root")
files = spec.get("files")
max_total_bytes = spec.get("max_total_bytes")
checksum_max_bytes = spec.get("checksum_max_bytes")
if not isinstance(root, str) or not root.startswith("/") or not isinstance(files, list) or not isinstance(max_total_bytes, int) or not isinstance(checksum_max_bytes, int):
    fail("invalid transfer preflight spec fields")

root_expanded = os.path.expandvars(root)
root_real = os.path.realpath(root_expanded)
if not os.path.isdir(root_real):
    fail("transfer root is not a directory")

${PY_INSIDE_REALPATH}
${PY_SHA256_FILE}
results = []
total = 0
for rel in files:
    if not isinstance(rel, str) or rel.startswith("/") or ".." in rel.split("/"):
        fail("invalid transfer file entry")
    full = os.path.join(root_expanded, rel)
    real = os.path.realpath(full)
    if not inside_realpath(real, root_real):
        fail("transfer file realpath escapes root")
    if not os.path.isfile(real):
        fail(f"transfer file is not regular: {rel}")
    size = os.path.getsize(real)
    total += size
    if total > max_total_bytes:
        fail("transfer files exceed max_total_bytes")
    entry = {
        "path": rel,
        "size_bytes": size,
        "checksum_status": "skipped-large" if size > checksum_max_bytes else "captured",
    }
    if size <= checksum_max_bytes:
        entry["sha256"] = sha256_file(real)
    results.append(entry)

print(json.dumps({"files": results, "total_size_bytes": total}, sort_keys=True))
`;
