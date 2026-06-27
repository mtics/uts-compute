// sweep.plan: expand a declared hyperparameter grid into a deterministic index->params table and a
// single PBS array job (one plan_hash), reusing the existing array primitive and planJob. Each array
// element selects its params via an inline `case ${PBS_ARRAY_INDEX}` statement built from the base
// command's {placeholders} — values are safety-validated so the generated command can't inject shell.

import { planJob, type PlanOptions } from "../plans/planner.js";
import { quotaCapacity } from "../quotas/capacity.js";
import { PLATFORM } from "../../core/types.js";
import type { PlannedJob } from "../../core/types.js";

export type SweepScalar = string | number | boolean;

export interface SweepInput {
  jobSpec: Record<string, unknown>;
  parameters: Record<string, SweepScalar[]>;
  method?: "grid";
  maxConcurrent?: number;
  snapshotId?: string;
  // REQUIRED: the fan-out operator must declare the campaign identity for the runs this sweep spawns
  // (DISCLOSURE/attribution). It is a planSweep ARGUMENT, never a JobSpec field, so it lands on each
  // run record's metadata without entering plan_hash. accounts-and-safety.md forbids inferring it.
  campaignId?: string;
}

export interface SweepResult {
  sweep: {
    method: "grid";
    size: number;
    max_concurrent: number;
    parameters: Record<string, SweepScalar[]>;
    table: Array<{ index: number; params: Record<string, SweepScalar> }>;
    capacity?: { snapshot_id: string; target_queue: string | null; run_headroom: number | null; notes: string[] };
  };
  plan: PlannedJob;
}

const MAX_SWEEP_SIZE = 256;
const DEFAULT_MAX_CONCURRENT = 5;
const SAFE_STRING_VALUE = /^[A-Za-z0-9._:=+/-]+$/;
const SAFE_PARAM_NAME = /^[A-Za-z0-9_]+$/;

// Cross-product of the parameter axes in insertion order; the last axis varies fastest (odometer
// order), so the index->params mapping is stable and reproducible.
export function expandGrid(parameters: Record<string, SweepScalar[]>): Array<Record<string, SweepScalar>> {
  let combos: Array<Record<string, SweepScalar>> = [{}];
  for (const name of Object.keys(parameters)) {
    const next: Array<Record<string, SweepScalar>> = [];
    for (const combo of combos) {
      for (const value of parameters[name]) {
        next.push({ ...combo, [name]: value });
      }
    }
    combos = next;
  }
  return combos;
}

export function planSweep(input: SweepInput, options: PlanOptions = {}): SweepResult {
  if (!input.campaignId) {
    throw new Error(
      "sweep.plan requires an explicit campaignId — the fan-out operator must declare campaign identity (accounts-and-safety.md forbids inferring it)"
    );
  }
  const method = input.method ?? "grid";
  if (method !== "grid") {
    throw new Error('sweep.plan only supports method "grid"');
  }
  const jobSpec = input.jobSpec;
  if (!isObject(jobSpec) || typeof jobSpec.command !== "string") {
    throw new Error("sweep.plan requires a base jobSpec with a string command");
  }
  if (jobSpec.platform !== PLATFORM.HPC) {
    throw new Error("sweep.plan supports UTS HPC PBS array jobs only");
  }
  if (isObject(jobSpec.resources) && "array" in jobSpec.resources) {
    throw new Error("sweep.plan builds the array dimension; the base jobSpec must not set resources.array");
  }

  validateParameters(input.parameters, jobSpec.command);
  // Bound the product from the axis lengths BEFORE materializing the cross-product, so a large
  // grid (e.g. 10 axes x 8 values = 1e9) is rejected without an OOM in expandGrid.
  const size = Object.values(input.parameters).reduce((product, values) => product * values.length, 1);
  if (size > MAX_SWEEP_SIZE) {
    throw new Error(`sweep size ${size} exceeds the cap of ${MAX_SWEEP_SIZE}`);
  }
  const assignments = expandGrid(input.parameters);
  const requested = input.maxConcurrent ?? Math.min(assignments.length, DEFAULT_MAX_CONCURRENT);

  const resources = isObject(jobSpec.resources) ? jobSpec.resources : {};
  // When a fresh quota snapshot is supplied, cap the array's concurrency to the live per-user run
  // headroom of its queue, so the sweep never tries to start more parallel jobs than the account can
  // actually run. Advisory: it only lowers concurrency (and floors at 1), never raises it.
  let maxConcurrent = requested;
  let capacity: SweepResult["sweep"]["capacity"];
  if (input.snapshotId) {
    capacity = capacityTune(jobSpec, resources, input.snapshotId, options, (capped) => {
      maxConcurrent = Math.max(1, Math.min(requested, capped));
    });
  }

  const sweepJobSpec = {
    ...jobSpec,
    command: buildSweepCommand(jobSpec.command, assignments),
    resources: {
      ...resources,
      array: { start: 0, end: assignments.length - 1, max_concurrent: maxConcurrent }
    }
  };

  // Thread the declared campaign identity onto every spawned run record (metadata only; never the
  // hashed spec). campaignId is required above, so this is always set.
  const plan = planJob(sweepJobSpec, { ...options, campaignId: input.campaignId });
  return {
    sweep: {
      method: "grid",
      size: assignments.length,
      max_concurrent: maxConcurrent,
      parameters: input.parameters,
      table: assignments.map((params, index) => ({ index, params })),
      ...(capacity ? { capacity } : {})
    },
    plan
  };
}

// Read the supplied snapshot's capacity for this job's queue and report the run headroom; invoke
// `applyCap(headroom)` so the caller can lower concurrency. Falls back to the snapshot's best queue
// when the base jobSpec hasn't pinned a queue yet (planJob fills the default later).
function capacityTune(
  jobSpec: Record<string, unknown>,
  resources: Record<string, unknown>,
  snapshotId: string,
  options: PlanOptions,
  applyCap: (headroom: number) => void
): SweepResult["sweep"]["capacity"] {
  const report = quotaCapacity(
    { profileId: String(jobSpec.profile_id), snapshotId },
    { configPath: options.configPath }
  ).capacity;
  const targetQueue = typeof resources.queue === "string" ? resources.queue : report.best_queue;
  const queueCap = targetQueue ? report.queues.find((queue) => queue.queue === targetQueue) : undefined;
  const runHeadroom = queueCap ? queueCap.run_headroom : report.recommended_parallel;
  const notes = [...report.notes];
  if (runHeadroom !== null && runHeadroom !== undefined) {
    applyCap(runHeadroom);
    notes.push(`Capped max_concurrent to the live run headroom (${runHeadroom}) of queue "${targetQueue}".`);
  } else {
    notes.push(`No finite run headroom for queue "${targetQueue ?? "?"}"; left max_concurrent unchanged.`);
  }
  return { snapshot_id: snapshotId, target_queue: targetQueue ?? null, run_headroom: runHeadroom ?? null, notes };
}

export interface SweepRankInput {
  parameters: Record<string, SweepScalar[]>;
  results: Array<{ index: number; value: number }>;
  mode?: "min" | "max";
  topK?: number;
}

export interface SweepRankEntry {
  index: number;
  params: Record<string, SweepScalar>;
  value: number;
}

export interface SweepRankResult {
  metric_mode: "min" | "max";
  total: number;
  ranked: SweepRankEntry[];
  top_k_params: Array<Record<string, SweepScalar>>;
  note: string;
}

// Read-only ranking advisor over a finished sweep: join each array member's metric value (supplied by
// the caller from artifacts.summarize) back to its config, rank, and name the top-k winners so the
// agent can propose a higher-budget follow-up rung (manual successive-halving). It never cancels or
// resubmits anything — that stays an explicit, approved action.
export function rankSweep(input: SweepRankInput): SweepRankResult {
  const mode = input.mode ?? "max";
  if (!isObject(input.parameters) || Object.keys(input.parameters).length === 0) {
    throw new Error("sweep.rank requires the original non-empty parameters grid");
  }
  const size = Object.values(input.parameters).reduce((product, values) => product * values.length, 1);
  if (size > MAX_SWEEP_SIZE) {
    throw new Error(`sweep grid size ${size} exceeds the cap of ${MAX_SWEEP_SIZE}`);
  }
  const assignments = expandGrid(input.parameters);
  const ranked: SweepRankEntry[] = [];
  for (const result of input.results) {
    if (!Number.isInteger(result.index) || result.index < 0 || result.index >= assignments.length) {
      continue; // skip a metric for an index outside this grid
    }
    if (typeof result.value !== "number" || !Number.isFinite(result.value)) {
      continue;
    }
    ranked.push({ index: result.index, params: assignments[result.index], value: result.value });
  }
  ranked.sort((left, right) => (mode === "max" ? right.value - left.value : left.value - right.value));
  const topK = Math.max(1, Math.min(input.topK ?? 3, ranked.length));
  const topKParams = ranked.slice(0, topK).map((entry) => entry.params);
  return {
    metric_mode: mode,
    total: ranked.length,
    ranked,
    top_k_params: topKParams,
    note: "Advisory only: re-run the top-k configs at a higher budget via a follow-up sweep.plan; do not auto-cancel running members."
  };
}

function validateParameters(parameters: unknown, command: string): void {
  if (!isObject(parameters) || Object.keys(parameters).length === 0) {
    throw new Error("sweep.plan requires a non-empty parameters object");
  }
  for (const [name, values] of Object.entries(parameters)) {
    if (!SAFE_PARAM_NAME.test(name)) {
      throw new Error(`Unsafe sweep parameter name: ${name}`);
    }
    if (!command.includes(`{${name}}`)) {
      throw new Error(`Base command has no {${name}} placeholder for sweep parameter "${name}"`);
    }
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`Sweep parameter "${name}" must be a non-empty array of values`);
    }
    for (const value of values) {
      assertSafeValue(name, value);
    }
  }
}

function assertSafeValue(name: string, value: unknown): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Sweep parameter "${name}" has a non-finite number`);
    }
    return;
  }
  if (typeof value === "boolean") {
    return;
  }
  if (typeof value === "string" && SAFE_STRING_VALUE.test(value)) {
    return;
  }
  throw new Error(`Sweep parameter "${name}" has an unsafe value: ${JSON.stringify(value)}`);
}

function buildSweepCommand(baseCommand: string, assignments: Array<Record<string, SweepScalar>>): string {
  const lines = ["case ${PBS_ARRAY_INDEX} in"];
  assignments.forEach((params, index) => {
    lines.push(`${index}) ${substitute(baseCommand, params)} ;;`);
  });
  lines.push('*) echo "unknown sweep index ${PBS_ARRAY_INDEX}" >&2; exit 2 ;;');
  lines.push("esac");
  return lines.join("\n");
}

function substitute(command: string, params: Record<string, SweepScalar>): string {
  let out = command;
  for (const [name, value] of Object.entries(params)) {
    out = out.split(`{${name}}`).join(String(value));
  }
  const leftover = out.match(/\{[A-Za-z0-9_]+\}/);
  if (leftover) {
    throw new Error(`Unsubstituted placeholder ${leftover[0]} remains in the sweep command`);
  }
  return out;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
