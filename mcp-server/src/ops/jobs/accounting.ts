// PBS per-job usage accounting. Pure parser over `qstat -f` / `qstat -x -f` output plus a metrics
// computation: core-hours, GPU-hours, and CPU efficiency. Framed as usage against a fixed academic
// allocation (hours, not dollars) — UTS HPC has no spot market or bill.

import { round2 } from "../../lib/shared.js";
import { parseHmsSeconds } from "../../lib/walltime.js";
import { parseMemGb } from "../quotas/quota-limits.js";
import type { RunUsage } from "../../core/types.js";

export interface PbsUsageRaw {
  walltime_seconds: number;
  cpu_seconds: number;
  ncpus: number;
  ngpus: number;
  mem?: string;
}

export interface UsageMetrics extends PbsUsageRaw {
  core_hours: number;
  gpu_hours: number;
  cpu_efficiency_percent: number | null;
}

// Parse the `key = value` lines of a `qstat -f` job record into a map. The "Job Id:" header and
// any non `key = value` lines are ignored. Returns null when no usage (resources_used.walltime +
// ncpus) is present — i.e. the job has not produced usage yet.
export function parsePbsUsage(qstatText: string): PbsUsageRaw | null {
  const fields = parseQstatFields(qstatText);
  const walltime = fields.get("resources_used.walltime");
  const ncpusRaw = fields.get("resources_used.ncpus");
  if (!walltime || !ncpusRaw) {
    return null;
  }
  const ncpus = Number.parseInt(ncpusRaw, 10);
  if (!Number.isFinite(ncpus) || ncpus <= 0) {
    return null;
  }
  const cput = fields.get("resources_used.cput");
  const mem = fields.get("resources_used.mem");
  return {
    walltime_seconds: parseHmsSeconds(walltime),
    cpu_seconds: cput ? parseHmsSeconds(cput) : 0,
    ncpus,
    ngpus: parseNgpus(fields),
    ...(mem ? { mem } : {})
  };
}

export interface PbsRequested {
  ncpus?: number;
  memory_gb?: number;
  walltime?: string;
  ngpus?: number;
}

// The REQUESTED resources (Resource_List.*) from a `qstat -f` record — what the job asked for, as opposed
// to parsePbsUsage's resources_used.* (what it consumed). Returns only the schema-allowed
// submission.requested keys (ncpus/memory_gb/walltime/ngpus); a field the record does not declare is
// omitted, so an empty object means "no requested resources were declared". Used to fill an adopted PBS
// run's submission.requested instead of leaving it {} (Track 2.5).
export function parsePbsRequested(qstatText: string): PbsRequested {
  const fields = parseQstatFields(qstatText);
  const out: PbsRequested = {};
  const ncpus = positiveInt(fields.get("Resource_List.ncpus"));
  if (ncpus !== undefined) out.ncpus = ncpus;
  const mem = fields.get("Resource_List.mem");
  if (mem) {
    const gb = parseMemGb(mem);
    if (gb !== undefined && gb > 0) out.memory_gb = round2(gb);
  }
  const walltime = fields.get("Resource_List.walltime");
  if (walltime) out.walltime = walltime;
  const ngpus = nonNegativeInt(fields.get("Resource_List.ngpus"));
  if (ngpus !== undefined) out.ngpus = ngpus;
  return out;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function computeUsageMetrics(raw: PbsUsageRaw): UsageMetrics {
  const denom = raw.ncpus * raw.walltime_seconds;
  return {
    ...raw,
    core_hours: round2((raw.ncpus * raw.walltime_seconds) / 3600),
    gpu_hours: round2((raw.ngpus * raw.walltime_seconds) / 3600),
    cpu_efficiency_percent: denom > 0 ? round1((100 * raw.cpu_seconds) / denom) : null
  };
}

// Split a multi-record qstat output (e.g. `qstat -x -t -f`, which expands a PBS array job into one
// block per sub-job) into per-job blocks. Each record starts with an unindented "Job Id:" header.
function splitQstatJobBlocks(text: string): string[] {
  const blocks = text.split(/^(?=Job Id:)/m).map((block) => block.trim()).filter(Boolean);
  return blocks.length ? blocks : [text];
}

// A finished PBS *array* job keeps resources_used on each sub-job, NOT on the array parent record, so
// `qstat -x -t -f` returns one block per sub-job. Total core/GPU-hours across all sub-jobs (handling a
// non-uniform per-task shape); CPU efficiency is aggregate cput over aggregate core-seconds; ncpus/ngpus
// report the per-task shape (max) and mem the peak per-task RSS. Returns null when no sub-job has produced
// usage yet — same contract as parsePbsUsage.
export function parsePbsArrayUsage(qstatText: string): UsageMetrics | null {
  const subs = splitQstatJobBlocks(qstatText)
    .map(parsePbsUsage)
    .filter((usage): usage is PbsUsageRaw => usage !== null);
  if (!subs.length) {
    return null;
  }
  let walltimeSeconds = 0;
  let cpuSeconds = 0;
  let coreSeconds = 0;
  let gpuSeconds = 0;
  let ncpus = 0;
  let ngpus = 0;
  let peakMemGb = -1;
  let mem: string | undefined;
  for (const sub of subs) {
    walltimeSeconds += sub.walltime_seconds;
    cpuSeconds += sub.cpu_seconds;
    coreSeconds += sub.ncpus * sub.walltime_seconds;
    gpuSeconds += sub.ngpus * sub.walltime_seconds;
    ncpus = Math.max(ncpus, sub.ncpus);
    ngpus = Math.max(ngpus, sub.ngpus);
    if (sub.mem) {
      const gb = parseMemGb(sub.mem);
      if (gb !== undefined && gb > peakMemGb) {
        peakMemGb = gb;
        mem = sub.mem;
      }
    }
  }
  return {
    walltime_seconds: walltimeSeconds,
    cpu_seconds: cpuSeconds,
    ncpus,
    ngpus,
    core_hours: round2(coreSeconds / 3600),
    gpu_hours: round2(gpuSeconds / 3600),
    cpu_efficiency_percent: coreSeconds > 0 ? round1((100 * cpuSeconds) / coreSeconds) : null,
    ...(mem ? { mem } : {})
  };
}

// Extract usage metrics from a qstat record by job kind: a PBS array job sums its sub-job blocks
// (`qstat -x -t -f`), a plain job reads its single record. One seam so the live status path and the
// jobs.usage reporter stay consistent on arrays.
export function parseQstatUsageMetrics(qstatText: string, isArrayJob: boolean): UsageMetrics | null {
  if (isArrayJob) {
    return parsePbsArrayUsage(qstatText);
  }
  const raw = parsePbsUsage(qstatText);
  return raw ? computeUsageMetrics(raw) : null;
}

// True when a PBS job id denotes an array job (`1234[]` parent or `1234[7]` sub-job): its consumed
// resources live on the sub-jobs, so usage must be read with `qstat -x -t -f` and summed.
export function isPbsArrayJobId(remoteJobId: string): boolean {
  return /\[\d*\]/.test(remoteJobId);
}

// Project a UsageMetrics into the durable RunUsage shape written onto a run record. Shared so both the
// live status path (jobs.ts) and the adopt primitives (adopt.ts) compose the same mem_gb parse + field
// projection from one place (the body relocated from jobs.ts's private toRunUsage).
export function metricsToRunUsage(metrics: UsageMetrics): RunUsage {
  const memGb = metrics.mem ? parseMemGb(metrics.mem) : undefined;
  return {
    walltime_seconds: metrics.walltime_seconds,
    ...(memGb !== undefined ? { mem_gb: round2(memGb) } : {}),
    ncpus: metrics.ncpus,
    ngpus: metrics.ngpus,
    core_hours: metrics.core_hours,
    gpu_hours: metrics.gpu_hours,
    cpu_efficiency_percent: metrics.cpu_efficiency_percent
  };
}

// The compute node(s) a PBS job is running on, from exec_host (or exec_vnode). "node07/0*2+node08/0*2"
// -> ["node07", "node08"]. Empty for a queued job (no exec_host yet).
export function parseExecNodes(qstatText: string): string[] {
  const fields = parseQstatFields(qstatText);
  const execHost = fields.get("exec_host") ?? fields.get("exec_vnode");
  if (!execHost) {
    return [];
  }
  const nodes = new Set<string>();
  for (const chunk of execHost.split("+")) {
    const host = chunk.split("/")[0]?.split(":")[0]?.replace(/^\(/, "").trim();
    if (host) {
      nodes.add(host);
    }
  }
  return [...nodes];
}

// The shared `qstat -f` / `qstat -x -f` record reader: turn the "  key = value" lines into a map.
// Exported so jobs.ts reads job_state / Exit_status from the one reader instead of re-scanning the
// record with its own raw regexes (docs/archive/layering-audit-2026-06.md finding 12). Grammar is unchanged:
// keys are case-sensitive (real PBS and every fixture emit canonical case), and only indented
// `key = value` lines with a non-blank value are captured.
export function parseQstatFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s+([A-Za-z0-9_.]+)\s*=\s*(.*\S)\s*$/);
    if (match) {
      fields.set(match[1], match[2]);
    }
  }
  return fields;
}

// ngpus from Resource_List.ngpus when present, else summed from the exec_vnode "ngpus=N" tokens.
function parseNgpus(fields: Map<string, string>): number {
  const declared = fields.get("Resource_List.ngpus");
  if (declared) {
    const parsed = Number.parseInt(declared, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const execVnode = fields.get("exec_vnode");
  if (!execVnode) {
    return 0;
  }
  let total = 0;
  for (const match of execVnode.matchAll(/ngpus=(\d+)/g)) {
    total += Number.parseInt(match[1], 10);
  }
  return total;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
