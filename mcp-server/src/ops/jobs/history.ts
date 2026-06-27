// Read-only cross-run history over saved local run records. Surfaces a compact, secret-free
// summary per run (no events, commands, or paths) with optional filters — the "show my last N
// runs" view that complements the single-record uts://run-records/{runId} resource.

import { listRunRecordIds, readRunRecordSafe } from "../../core/audit.js";
import { UNASSIGNED_PROJECT, canonicalizeProjectName } from "../profiles/project.js";
import type { Platform, RunRecord } from "../../core/types.js";

export interface JobsHistoryInput {
  profileId?: string;
  platform?: Platform;
  status?: string;
  project?: string;
  since?: string;
  limit?: number;
  auditDir?: string;
}

export interface JobHistoryEntry {
  run_id: string;
  profile_id: string;
  platform: Platform;
  status: RunRecord["status"];
  project: string;
  project_hash?: string;
  job_type?: string;
  account_label?: string;
  cluster?: string;
  node?: string;
  // Scheduler-reported placement (iHPC observability, H8); absent for PBS records.
  placement?: RunRecord["placement"];
  created_at: string;
  updated_at: string;
  remote_job_id: string | null;
  retry_of?: string;
  event_count: number;
}

export interface JobsHistoryResult {
  total: number;
  returned: number;
  runs: JobHistoryEntry[];
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// `since` is compared lexically against ISO-8601 `created_at` strings, so a malformed value
// (e.g. "2026/06/05" or "yesterday") would compare as a raw string and silently mis-filter.
// The well-formed-ISO regex is the shape guard; Date.parse is a defensive range check. Note we
// do NOT reject calendar-day rollover (Date.parse("2026-02-30T00:00:00.000Z") is finite) — a
// well-formed-but-rolled-over date is acceptable.
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export function validateSinceFilter(since: string | undefined): string | undefined {
  if (since === undefined) return undefined;
  if (!ISO_8601_UTC.test(since) || !Number.isFinite(Date.parse(since))) {
    throw new Error(`Invalid 'since' filter "${since}": expected an ISO-8601 UTC datetime like 2026-06-05T00:00:00.000Z.`);
  }
  return since;
}

export function jobsHistory(input: JobsHistoryInput = {}): JobsHistoryResult {
  const since = validateSinceFilter(input.since);
  const ids = input.auditDir ? listRunRecordIds(input.auditDir) : listRunRecordIds();

  let entries = ids
    .map((id) => readRunRecordSafe(id, input.auditDir))
    .filter((record): record is RunRecord => record !== null)
    .map(summarize);

  if (input.profileId) {
    entries = entries.filter((entry) => entry.profile_id === input.profileId);
  }
  if (input.platform) {
    entries = entries.filter((entry) => entry.platform === input.platform);
  }
  if (input.status) {
    entries = entries.filter((entry) => entry.status === input.status);
  }
  if (input.project) {
    // Match either the canonical slug (so a human-typed name resolves) or the exact project hash.
    const wantedSlug = canonicalizeProjectName(input.project);
    entries = entries.filter((entry) => entry.project === wantedSlug || entry.project_hash === input.project);
  }
  if (since) {
    entries = entries.filter((entry) => entry.created_at >= since);
  }

  entries.sort((left, right) => right.created_at.localeCompare(left.created_at) || left.run_id.localeCompare(right.run_id));

  const total = entries.length;
  const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const runs = entries.slice(0, limit);
  return { total, returned: runs.length, runs };
}

function summarize(record: RunRecord): JobHistoryEntry {
  // SECURITY (spec §5): this compact projection is an explicit field allowlist — it MUST NOT spread the
  // whole RunRecord. adoption{} and supervisor{} are intentionally EXCLUDED: adoption.queue_id is a
  // content-hash and supervisor.*_path are absolute paths. If provenance must ever surface here, expose
  // ONLY the three flags (terminal_record/intent/lineage) — never queue_id, never any *_path.
  return {
    run_id: record.run_id,
    profile_id: record.profile_id,
    platform: record.platform,
    status: record.status,
    project: record.project ?? UNASSIGNED_PROJECT,
    ...(record.project_hash ? { project_hash: record.project_hash } : {}),
    ...(record.job_type ? { job_type: record.job_type } : {}),
    ...(record.submission?.account_label ? { account_label: record.submission.account_label } : {}),
    ...(record.submission?.cluster ? { cluster: record.submission.cluster } : {}),
    ...(record.submission?.node ? { node: record.submission.node } : {}),
    ...(record.placement ? { placement: record.placement } : {}),
    created_at: record.created_at,
    updated_at: record.updated_at,
    remote_job_id: record.remote_job_id,
    ...(record.retry_of ? { retry_of: record.retry_of.source_run_id } : {}),
    event_count: record.events.length
  };
}
