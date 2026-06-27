// Pre-submit spec diff: compare a new job spec against the most recent prior run of the same project,
// so an accidental fat-fingered resource bump or a silently-changed command is caught in the dry-run
// output before it hits the quota envelope. Pure and advisory — never affects plan_hash.

import type { JobSpec, SpecChange } from "../../core/types.js";

const RESOURCE_KEYS: Array<keyof JobSpec["resources"]> = [
  "queue",
  "node_family",
  "ncpus",
  "memory_gb",
  "walltime",
  "ngpus"
];

export function diffJobSpecs(prev: JobSpec, next: JobSpec): SpecChange[] {
  const changes: SpecChange[] = [];
  for (const key of RESOURCE_KEYS) {
    const before = prev.resources[key];
    const after = next.resources[key];
    if (before !== after) {
      changes.push({ field: `resources.${key}`, from: before ?? null, to: after ?? null });
    }
  }
  if (prev.command !== next.command) {
    // Commands can be large (a sweep's case statement); report the change with truncated context.
    changes.push({ field: "command", from: truncate(prev.command), to: truncate(next.command) });
  }
  if (prev.experiment.name !== next.experiment.name) {
    changes.push({ field: "experiment.name", from: prev.experiment.name, to: next.experiment.name });
  }
  return changes;
}

function truncate(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > 80 ? `${single.slice(0, 77)}...` : single;
}
