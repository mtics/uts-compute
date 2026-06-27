// Project grouping for experiments. A "project" groups runs that belong to the same body of work
// (distinct from a profile, which is an account, and from profile.defaults.project, a cluster path).
// The project is derived at plan time from the local git repository and written to the run record as
// organizational metadata only — never folded into plan_hash (same rule as the reproducibility block).

import { createHash } from "node:crypto";
import type { GitRunner } from "../plans/reproducibility.js";

export type ProjectSource = "git" | "unassigned";

export interface ProjectIdentity {
  project: string; // canonical slug
  project_hash: string; // "proj-" + sha256(slug)[:12]
  source: ProjectSource;
}

export const UNASSIGNED_PROJECT = "unassigned";

// Normalize a free-form project label to a canonical slug: lowercase, runs of whitespace/underscore
// become a single hyphen, anything outside [a-z0-9-] is dropped, repeats collapse, edges trim, length
// caps at 64. An empty result falls back to the unassigned sentinel so every run lands in some bucket.
export function canonicalizeProjectName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : UNASSIGNED_PROJECT;
}

// Deterministic, registry-free project id: the same canonical name always yields the same hash on any
// machine. Content-addressed, mirroring plan_hash. Callers pass an already-canonical slug.
export function projectHashFor(canonicalSlug: string): string {
  return `proj-${createHash("sha256").update(canonicalSlug).digest("hex").slice(0, 12)}`;
}

// Best-effort project name from the local git repo: the basename of `git rev-parse --show-toplevel`.
// Returns null outside a repo (the runner reports not-ok) so the caller can fall back.
export function gitProjectName(runner: GitRunner): string | null {
  const top = runner(["rev-parse", "--show-toplevel"]);
  if (!top.ok || top.stdout.length === 0) {
    return null;
  }
  const base = top.stdout.split("/").filter((segment) => segment.length > 0).pop();
  return base && base.length > 0 ? base : null;
}

// Resolve a run's project identity: the local git repository name, or the unassigned bucket when the
// plan was made outside a git repo. (An explicit override is a deliberate future addition; it would be
// resolved here first, and likewise kept out of plan_hash.)
export function resolveProjectIdentity(runner: GitRunner): ProjectIdentity {
  const gitName = gitProjectName(runner);
  if (gitName) {
    const project = canonicalizeProjectName(gitName);
    return { project, project_hash: projectHashFor(project), source: "git" };
  }
  return { project: UNASSIGNED_PROJECT, project_hash: projectHashFor(UNASSIGNED_PROJECT), source: "unassigned" };
}
