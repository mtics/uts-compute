// Read-only per-project rollup over saved local run records. Groups runs by their project (the
// git-derived grouping written at plan time), so an operator juggling several projects can see, in
// one view, how many runs each project has and how many are still live. Local state only; no SSH.

import { listRunRecordIds, readRunRecordSafe } from "../../core/audit.js";
import { UNASSIGNED_PROJECT, projectHashFor } from "./project.js";
import type { Platform, RunRecord } from "../../core/types.js";

export interface ProjectsListInput {
  platform?: Platform;
  profileId?: string;
  auditDir?: string;
}

export interface ProjectSummary {
  project: string;
  project_hash: string;
  total: number;
  active: number; // submitted + running + unknown
  by_status: Record<string, number>;
  profiles: string[];
  platforms: Platform[];
  last_updated: string | null;
}

export interface ProjectsListResult {
  total_projects: number;
  total_runs: number;
  projects: ProjectSummary[];
}

const ACTIVE_STATUSES = new Set<RunRecord["status"]>(["submitted", "running", "unknown"]);

export function listProjects(input: ProjectsListInput = {}): ProjectsListResult {
  const ids = input.auditDir ? listRunRecordIds(input.auditDir) : listRunRecordIds();
  let records = ids
    .map((id) => readRunRecordSafe(id, input.auditDir))
    .filter((record): record is RunRecord => record !== null);
  if (input.platform) {
    records = records.filter((record) => record.platform === input.platform);
  }
  if (input.profileId) {
    records = records.filter((record) => record.profile_id === input.profileId);
  }

  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const project = record.project ?? UNASSIGNED_PROJECT;
    const group = groups.get(project) ?? [];
    group.push(record);
    groups.set(project, group);
  }

  const projects: ProjectSummary[] = [...groups.entries()].map(([project, group]) => summarizeGroup(project, group));
  // Most live work first, then most recently touched, then name — the operator's natural triage order.
  projects.sort(
    (left, right) =>
      right.active - left.active ||
      (right.last_updated ?? "").localeCompare(left.last_updated ?? "") ||
      left.project.localeCompare(right.project)
  );

  return { total_projects: projects.length, total_runs: records.length, projects };
}

function summarizeGroup(project: string, group: RunRecord[]): ProjectSummary {
  const byStatus: Record<string, number> = {};
  const profiles = new Set<string>();
  const platforms = new Set<Platform>();
  let active = 0;
  let lastUpdated: string | null = null;
  for (const record of group) {
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    if (ACTIVE_STATUSES.has(record.status)) {
      active += 1;
    }
    profiles.add(record.profile_id);
    platforms.add(record.platform);
    const updated = record.updated_at ?? record.created_at;
    if (updated && (lastUpdated === null || updated > lastUpdated)) {
      lastUpdated = updated;
    }
  }
  return {
    project,
    project_hash: group[0].project_hash ?? projectHashFor(project),
    total: group.length,
    active,
    by_status: byStatus,
    profiles: [...profiles].sort(),
    platforms: [...platforms].sort(),
    last_updated: lastUpdated
  };
}
