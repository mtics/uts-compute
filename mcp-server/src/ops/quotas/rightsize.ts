// Right-size advisor: compare what a project's runs REQUESTED against what they actually USED
// (persisted run-record usage) and recommend a saner request — so a researcher stops burning their
// fixed allocation on 10x-over-requested jobs. Pure + read-only, over local run records only.

import { listRunRecordIds, readRunRecordSafe } from "../../core/audit.js";
import { round2 } from "../../lib/shared.js";
import { UNASSIGNED_PROJECT, canonicalizeProjectName } from "../profiles/project.js";
import { parseWalltimeSeconds } from "./quota-limits.js";
import type { RunRecord } from "../../core/types.js";

export interface ResourceAdvice {
  requested_typical: number | null;
  used_peak: number | null;
  used_median: number | null;
  headroom_ratio: number | null;
  recommendation: string;
}

export interface RightsizeReport {
  mode: "read-only";
  project: string;
  samples: number;
  mem_gb: ResourceAdvice;
  walltime_hours: ResourceAdvice;
  gpus: ResourceAdvice;
  cpu_efficiency_percent: { median: number | null };
  notes: string[];
}

export function rightsizeProject(project: string, records: RunRecord[]): RightsizeReport {
  const samples = records.filter((record) => record.usage);
  const memUsed: number[] = [];
  const memReq: number[] = [];
  const wtUsed: number[] = [];
  const wtReq: number[] = [];
  const gpuUsed: number[] = [];
  const gpuReq: number[] = [];
  const eff: number[] = [];
  for (const record of samples) {
    const usage = record.usage!;
    if (usage.mem_gb !== undefined) memUsed.push(usage.mem_gb);
    if (record.submission?.requested.memory_gb !== undefined) memReq.push(record.submission.requested.memory_gb);
    wtUsed.push(usage.walltime_seconds / 3600);
    const reqWalltime = record.submission?.requested.walltime
      ? parseWalltimeSeconds(record.submission.requested.walltime)
      : undefined;
    if (reqWalltime !== undefined) wtReq.push(reqWalltime / 3600);
    if (usage.ngpus !== undefined) gpuUsed.push(usage.ngpus);
    if (record.submission?.requested.ngpus !== undefined) gpuReq.push(record.submission.requested.ngpus);
    if (usage.cpu_efficiency_percent !== null && usage.cpu_efficiency_percent !== undefined) {
      eff.push(usage.cpu_efficiency_percent);
    }
  }
  return {
    mode: "read-only",
    project,
    samples: samples.length,
    mem_gb: advise(memReq, memUsed, "GB"),
    walltime_hours: advise(wtReq, wtUsed, "h"),
    gpus: advise(gpuReq, gpuUsed, "GPU"),
    cpu_efficiency_percent: { median: median(eff) },
    notes:
      samples.length === 0
        ? ["No finished runs with usage data yet for this project; run some jobs (and let jobs.status observe them) first."]
        : []
  };
}

function advise(requested: number[], used: number[], unit: string): ResourceAdvice {
  const requestedTypical = median(requested);
  const usedPeak = used.length > 0 ? round2(Math.max(...used)) : null;
  const usedMedian = median(used);
  const ratio = requestedTypical !== null && usedPeak !== null && usedPeak > 0 ? round2(requestedTypical / usedPeak) : null;
  let recommendation = "insufficient data";
  if (ratio !== null && usedPeak !== null && requestedTypical !== null) {
    if (ratio >= 2) {
      recommendation = `over-requested ~${ratio}x (peak ${usedPeak}${unit} vs requested ${requestedTypical}${unit}); consider requesting ~${round2(usedPeak * 1.3)}${unit}`;
    } else if (ratio < 1.1) {
      recommendation = `tight (peak ${usedPeak}${unit} vs requested ${requestedTypical}${unit}); add headroom to avoid OOM/timeout`;
    } else {
      recommendation = `about right (peak ${usedPeak}${unit} vs requested ${requestedTypical}${unit})`;
    }
  }
  return { requested_typical: requestedTypical, used_peak: usedPeak, used_median: usedMedian, headroom_ratio: ratio, recommendation };
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return round2(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

export interface JobsRightsizeInput {
  project: string;
  profileId?: string;
}

// Tool entry: read the project's run records and advise. Read-only, local state only.
export function jobsRightsize(input: JobsRightsizeInput, options: { auditDir?: string } = {}): { rightsize: RightsizeReport } {
  const project = canonicalizeProjectName(input.project);
  const ids = options.auditDir ? listRunRecordIds(options.auditDir) : listRunRecordIds();
  let records = ids
    .map((id) => readRunRecordSafe(id, options.auditDir))
    .filter((record): record is RunRecord => record !== null)
    .filter((record) => (record.project ?? UNASSIGNED_PROJECT) === project);
  if (input.profileId) {
    records = records.filter((record) => record.profile_id === input.profileId);
  }
  return { rightsize: rightsizeProject(project, records) };
}
