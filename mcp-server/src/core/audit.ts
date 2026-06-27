import fs from "node:fs";
import { assertSafeRunId } from "./ids.js";
import path from "node:path";
import { assertInsideRuntime, resolveRecordPath, RUNTIME_DIRS } from "./paths.js";
import { assertRunRecord } from "./validation.js";
import type { ApprovalState, JobSpec, Reproducibility, RunRecord } from "./types.js";

const DEFAULT_AUDIT_DIR: string = RUNTIME_DIRS.runs;

// Run-record ids (audit-dir filenames without the .json suffix), sorted. Used for prompt-argument
// and future jobs.history completions/listing without exposing file contents or paths.
export function listRunRecordIds(auditDir = DEFAULT_AUDIT_DIR): string[] {
  const resolved = assertInsideRuntime(auditDir, "Audit directory");
  if (!fs.existsSync(resolved)) {
    return [];
  }
  return fs
    .readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort();
}

export interface RunRecordMetadata {
  planHash?: string;
  quotaSnapshotId?: string;
  approvalState?: ApprovalState;
  approvalReasons?: string[];
  reproducibility?: Reproducibility;
  project?: string;
  projectHash?: string;
  // Campaign attribution, threaded from the jobs.plan/sweep.plan tool input onto the RunRecord only
  // (never the hashed spec, never JobSpec). DISCLOSURE for the campaign ledger, not a cap input.
  campaignId?: string;
  jobType?: string;
}

export function redactCommand(command: string): string {
  return command
    .replace(
      /((?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|mfa|otp)=)([^\s]+)/gi,
      "$1<redacted>"
    )
    .replace(
      /(--(?:password|passwd|pwd|token|secret|api-key|api_key|access-token|access_token|refresh-token|refresh_token|client-secret|client_secret|secret-access-key|secret_access_key|private-key|private_key|mfa|otp)(?:=|\s+))([^\s]+)/gi,
      "$1<redacted>"
    )
    // Secret inside a JSON/quoted "key": "value" (or 'key' = 'value'): redact only the value.
    .replace(
      /(["'](?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|mfa|otp)["']\s*[:=]\s*["'])([^"']+)(["'])/gi,
      "$1<redacted>$3"
    )
    .replace(/(Authorization:\s*Bearer\s+)([^\s]+)/gi, "$1<redacted>")
    .replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi, "$1<redacted>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi, "$1<redacted>$3")
    // Multiline PEM / private-key blocks: keep the BEGIN/END markers, drop the key body.
    .replace(
      /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
      "$1<redacted>$2"
    )
    // Well-known opaque credential prefixes (precise, negligible false-positive risk).
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "<redacted>")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted>")
    .replace(/\bgh[posru]_[A-Za-z0-9]{20,}\b/g, "<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted>")
    // Generic high-entropy opaque token (a bare API token or unkeyed base64 blob). Conservative
    // by construction: it only matches a separatorless run (no -, _, ., / — so run-ids, snapshot
    // ids, ISO timestamps, and paths break apart and are spared), and within that run it keeps
    // hex digests (plan_hash) and anything lacking either base64 padding or mixed-case-with-digit.
    .replace(/[A-Za-z0-9+=]{24,}/g, (token) => {
      if (/^[A-Fa-f0-9]+$/.test(token)) return token;
      const base64Padded = token.endsWith("=");
      const mixedAlnum = /[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token);
      return base64Padded || mixedAlnum ? "<redacted>" : token;
    });
}

export function buildRunRecord(
  jobSpec: JobSpec,
  summary: string,
  now = new Date(),
  metadata: RunRecordMetadata = {}
): RunRecord {
  const timestamp = now.toISOString();
  const record: RunRecord = {
    run_id: jobSpec.run_id,
    profile_id: jobSpec.profile_id,
    platform: jobSpec.platform,
    remote_job_id: null,
    rev: 0,
    ...(metadata.project ? { project: metadata.project } : {}),
    ...(metadata.projectHash ? { project_hash: metadata.projectHash } : {}),
    ...(metadata.campaignId ? { campaign_id: metadata.campaignId } : {}),
    ...(metadata.jobType ? { job_type: metadata.jobType } : {}),
    ...(metadata.planHash ? { plan_hash: metadata.planHash } : {}),
    ...(metadata.quotaSnapshotId ? { quota_snapshot_id: metadata.quotaSnapshotId } : {}),
    ...(metadata.approvalState
      ? {
          approval: {
            state: metadata.approvalState,
            ...(metadata.planHash ? { bound_plan_hash: metadata.planHash } : {}),
            ...(metadata.quotaSnapshotId ? { bound_quota_snapshot_id: metadata.quotaSnapshotId } : {}),
            ...(metadata.approvalReasons?.length ? { reason: metadata.approvalReasons.join("; ") } : {})
          }
        }
      : {}),
    status: "planned",
    created_at: timestamp,
    updated_at: timestamp,
    events: [
      {
        at: timestamp,
        kind: "dry-run-plan",
        summary,
        redacted_command: redactCommand(jobSpec.command)
      }
    ],
    ...(metadata.reproducibility ? { reproducibility: metadata.reproducibility } : {})
  };
  assertRunRecord(record);
  return record;
}

export function writeRunRecord(runRecord: RunRecord, auditDir = DEFAULT_AUDIT_DIR): string {
  assertRunRecord(runRecord);
  const resolvedDir = assertInsideRuntime(auditDir, "Audit directory");
  fs.mkdirSync(resolvedDir, { recursive: true });
  const outputPath = path.join(resolvedDir, `${runRecord.run_id}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
  return outputPath;
}

export function readRunRecord(runId: string, auditDir = DEFAULT_AUDIT_DIR): RunRecord {
  assertSafeRunId(runId);
  const resolvedDir = assertInsideRuntime(auditDir, "Audit directory");
  const filePath = resolveRecordPath(resolvedDir, runId, {
    containmentMessage: "Run record path must stay inside the audit directory",
    realpathLabel: "Run record file"
  });
  const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  assertRunRecord(record);
  return record;
}

// Update a run record with optimistic concurrency: if the on-disk record advanced past the rev this
// one was read at, another writer changed it since (e.g. a concurrent jobs.track vs jobs.cancel), so
// refuse instead of silently clobbering. Records without a rev (created before this field) skip the
// check; every write bumps rev so subsequent writes are guarded.
export function updateRunRecord(runRecord: RunRecord, auditDir = DEFAULT_AUDIT_DIR): string {
  const resolvedDir = assertInsideRuntime(auditDir, "Audit directory");
  const filePath = path.join(resolvedDir, `${runRecord.run_id}.json`);
  if (fs.existsSync(filePath)) {
    let onDiskRev: number | undefined;
    try {
      const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8")) as { rev?: unknown };
      onDiskRev = typeof onDisk.rev === "number" ? onDisk.rev : undefined;
    } catch {
      onDiskRev = undefined; // unreadable/corrupt on-disk record — fall through and overwrite
    }
    if (onDiskRev !== undefined && typeof runRecord.rev === "number" && onDiskRev !== runRecord.rev) {
      throw new Error(
        `Run record ${runRecord.run_id} changed concurrently (expected rev ${runRecord.rev}, on disk ${onDiskRev}); re-read and retry`
      );
    }
  }
  runRecord.rev = (typeof runRecord.rev === "number" ? runRecord.rev : 0) + 1;
  return writeRunRecord(runRecord, auditDir);
}

// Transactional read-mutate-write bracket. The caller has already read the record (records flow by
// reference through the status-reconcile path, so a read-by-id seam would break that decoupling); this
// seam owns ONLY the write half: run the caller's mutation, then a SINGLE updateRunRecord so a record
// advances by exactly one rev. It owns no status-transition or event policy — those stay in the mutator.
// This is what eliminates the stray duplicate updateRunRecord writes that bumped rev by 2 per poll.
export function withRunRecordWrite(
  runRecord: RunRecord,
  mutate: (record: RunRecord) => void,
  auditDir?: string
): string {
  mutate(runRecord);
  return auditDir === undefined ? updateRunRecord(runRecord) : updateRunRecord(runRecord, auditDir);
}

// Evidence-bound update tail, layered on withRunRecordWrite: given an already-written evidence file
// path and a caller-computed half-built event ({ kind, summary, redacted_command }), set updated_at,
// push the event with artifact_path: evidencePath attached, and write ONCE. The event's wording and
// any status mutation that must precede it (e.g. status = "cancelled") stay caller-side — this seam
// only collapses the identical updated_at + events.push{artifact_path} + updateRunRecord mechanics.
export function recordOperationEvidence(
  runRecord: RunRecord,
  event: { kind: string; summary: string; redacted_command?: string },
  evidencePath: string,
  now: Date,
  auditDir?: string
): string {
  return withRunRecordWrite(
    runRecord,
    (record) => {
      record.updated_at = now.toISOString();
      record.events.push({
        at: now.toISOString(),
        kind: event.kind,
        summary: event.summary,
        ...(event.redacted_command !== undefined ? { redacted_command: event.redacted_command } : {}),
        artifact_path: evidencePath
      });
    },
    auditDir
  );
}

// Read a run record, returning null instead of throwing on a missing, unreadable, or schema-invalid
// file — for bulk listings (jobs.history, jobs.track) that must skip a bad record, not abort the sweep.
export function readRunRecordSafe(runId: string, auditDir?: string): RunRecord | null {
  try {
    return auditDir === undefined ? readRunRecord(runId) : readRunRecord(runId, auditDir);
  } catch {
    return null;
  }
}


