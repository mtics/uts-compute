import { PLATFORM } from "../../core/types.js";
import type { JobSpec } from "../../core/types.js";
import { parseHmsSeconds } from "../../lib/walltime.js";

const RESTRICTED_QUEUES = new Set(["gpuq", "expressq", "riskyq", "testq", "ciq", "priv05_08"]);
const HIGH_CPU_THRESHOLD = 16;
const HIGH_MEMORY_GB_THRESHOLD = 64;
const LONG_WALLTIME_HOURS = 24;
const ARRAY_CONCURRENCY_APPROVAL_THRESHOLD = 1;

export function approvalReasonsForJobSpec(jobSpec: JobSpec): string[] {
  const reasons: string[] = [];
  const resources = jobSpec.resources;

  if ((resources.ngpus ?? 0) > 0) {
    reasons.push("GPU resource request");
  }
  if (resources.queue && RESTRICTED_QUEUES.has(resources.queue)) {
    reasons.push(`Restricted or special queue: ${resources.queue}`);
  }
  if ((resources.ncpus ?? 0) > HIGH_CPU_THRESHOLD) {
    reasons.push(`High CPU request: ${resources.ncpus} CPUs`);
  }
  if ((resources.memory_gb ?? 0) > HIGH_MEMORY_GB_THRESHOLD) {
    reasons.push(`High memory request: ${resources.memory_gb} GB`);
  }
  if (resources.walltime && walltimeHours(resources.walltime) > LONG_WALLTIME_HOURS) {
    reasons.push(`Long walltime: ${resources.walltime}`);
  }
  if (resources.array) {
    const size = resources.array.end - resources.array.start + 1;
    reasons.push(`Array job with ${size} tasks`);
    if ((resources.array.max_concurrent ?? 1) > ARRAY_CONCURRENCY_APPROVAL_THRESHOLD) {
      reasons.push(`Concurrent array execution: ${resources.array.max_concurrent} tasks`);
    }
  }
  if (jobSpec.platform === PLATFORM.IHPC) {
    reasons.push("iHPC supervised interactive run requires user confirmation before live start");
  }

  return reasons;
}

// The LONG_WALLTIME_HOURS threshold + "Long walltime" reason stay here (policy); only the
// HH:MM:SS -> seconds parse is the shared mechanism. parseHmsSeconds folds the same colon-groups
// the prior inline `split(":").map(Number)` did, so the fractional-hours value is unchanged.
function walltimeHours(walltime: string): number {
  return parseHmsSeconds(walltime) / 3600;
}
