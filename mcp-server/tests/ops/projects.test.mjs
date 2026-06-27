import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { listProjects } from "../../dist/ops/profiles/projects.js";
import { projectHashFor } from "../../dist/ops/profiles/project.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

// Write a minimal schema-valid run record straight into the audit dir.
function writeRecord(auditDir, runId, { project, status, profile = "uts-hpc-account-a", platform = "uts-hpc", updatedAt }) {
  const record = {
    run_id: runId,
    profile_id: profile,
    platform,
    remote_job_id: status === "planned" ? null : `${runId}.hpc`,
    ...(project ? { project, project_hash: projectHashFor(project) } : {}),
    status,
    created_at: "2026-06-15T00:00:00.000Z",
    updated_at: updatedAt ?? "2026-06-15T00:00:00.000Z",
    events: [{ at: "2026-06-15T00:00:00.000Z", kind: "dry-run-plan", summary: "seed" }]
  };
  fs.writeFileSync(path.join(auditDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

test("listProjects groups runs by project with status and active counts", () => {
  const auditDir = tempRuntimeDir("projlist");
  writeRecord(auditDir, "alpha-1", { project: "alpha", status: "running", updatedAt: "2026-06-15T03:00:00.000Z" });
  writeRecord(auditDir, "alpha-2", { project: "alpha", status: "finished" });
  writeRecord(auditDir, "alpha-3", { project: "alpha", status: "submitted" });
  writeRecord(auditDir, "beta-1", { project: "beta", status: "failed" });
  writeRecord(auditDir, "legacy-1", { status: "running" }); // no project -> unassigned

  const result = listProjects({ auditDir });

  assert.equal(result.total_projects, 3);
  assert.equal(result.total_runs, 5);

  const alpha = result.projects.find((p) => p.project === "alpha");
  assert.equal(alpha.total, 3);
  assert.equal(alpha.active, 2); // running + submitted
  assert.equal(alpha.by_status.finished, 1);
  assert.equal(alpha.project_hash, projectHashFor("alpha"));
  assert.equal(alpha.last_updated, "2026-06-15T03:00:00.000Z");

  const unassigned = result.projects.find((p) => p.project === "unassigned");
  assert.equal(unassigned.total, 1);
  assert.equal(unassigned.active, 1);

  // Most active first: alpha (2) before beta (0) and unassigned (1).
  assert.equal(result.projects[0].project, "alpha");
});

test("listProjects filters by platform", () => {
  const auditDir = tempRuntimeDir("projlist-plat");
  writeRecord(auditDir, "h-1", { project: "alpha", status: "running", platform: "uts-hpc" });
  writeRecord(auditDir, "i-1", { project: "alpha", status: "running", platform: "uts-ihpc", profile: "uts-ihpc-account-a" });

  const onlyHpc = listProjects({ auditDir, platform: "uts-hpc" });
  assert.equal(onlyHpc.total_runs, 1);
  assert.deepEqual(onlyHpc.projects[0].platforms, ["uts-hpc"]);
});
