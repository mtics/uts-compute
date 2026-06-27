import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { jobsHistory } from "../../dist/ops/jobs/history.js";
import { projectHashFor } from "../../dist/ops/profiles/project.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

function writeRecord(auditDir, overrides) {
  const record = {
    run_id: "hist-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: null,
    status: "finished",
    created_at: "2026-06-10T01:00:00.000Z",
    updated_at: "2026-06-10T02:00:00.000Z",
    events: [{ at: "2026-06-10T01:00:00.000Z", kind: "planned", summary: "planned" }],
    ...overrides
  };
  fs.writeFileSync(path.join(auditDir, `${record.run_id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

test("jobs.history lists newest-first with summary fields only", () => {
  const auditDir = tempRuntimeDir("test-history");
  writeRecord(auditDir, { run_id: "hist-old", created_at: "2026-06-01T00:00:00.000Z", platform: "uts-hpc", profile_id: "uts-hpc-account-a", status: "finished" });
  writeRecord(auditDir, { run_id: "hist-mid", created_at: "2026-06-05T00:00:00.000Z", platform: "uts-ihpc", profile_id: "uts-ihpc-account-a", status: "failed" });
  writeRecord(auditDir, { run_id: "hist-new", created_at: "2026-06-09T00:00:00.000Z", platform: "uts-hpc", profile_id: "uts-hpc-account-b", status: "running", remote_job_id: "2002.pbs" });

  const all = jobsHistory({ auditDir });
  assert.equal(all.total, 3);
  assert.equal(all.returned, 3);
  assert.deepEqual(all.runs.map((run) => run.run_id), ["hist-new", "hist-mid", "hist-old"]);
  assert.equal(all.runs[0].event_count, 1);
  assert.equal(all.runs[0].remote_job_id, "2002.pbs");
  // summary only: no raw events array is leaked
  assert.equal(Object.hasOwn(all.runs[0], "events"), false);
});

test("jobs.history filters by profile, platform, status, and since", () => {
  const auditDir = tempRuntimeDir("test-history-filter");
  writeRecord(auditDir, { run_id: "hist-old", created_at: "2026-06-01T00:00:00.000Z", platform: "uts-hpc", profile_id: "uts-hpc-account-a", status: "finished" });
  writeRecord(auditDir, { run_id: "hist-mid", created_at: "2026-06-05T00:00:00.000Z", platform: "uts-ihpc", profile_id: "uts-ihpc-account-a", status: "failed" });
  writeRecord(auditDir, { run_id: "hist-new", created_at: "2026-06-09T00:00:00.000Z", platform: "uts-hpc", profile_id: "uts-hpc-account-b", status: "running" });

  assert.deepEqual(jobsHistory({ auditDir, platform: "uts-hpc" }).runs.map((r) => r.run_id), ["hist-new", "hist-old"]);
  assert.deepEqual(jobsHistory({ auditDir, status: "failed" }).runs.map((r) => r.run_id), ["hist-mid"]);
  assert.deepEqual(jobsHistory({ auditDir, profileId: "uts-hpc-account-b" }).runs.map((r) => r.run_id), ["hist-new"]);
  assert.deepEqual(jobsHistory({ auditDir, since: "2026-06-05T00:00:00.000Z" }).runs.map((r) => r.run_id), ["hist-new", "hist-mid"]);
});

test("jobs.history rejects a non-ISO 'since' with a clear error", () => {
  const auditDir = tempRuntimeDir("test-history-since-bad");
  writeRecord(auditDir, { run_id: "hist-x", created_at: "2026-06-09T00:00:00.000Z" });
  assert.throws(() => jobsHistory({ since: "2026/06/05", auditDir }), /ISO-8601|since/i); // wrong separators
  assert.throws(() => jobsHistory({ since: "yesterday", auditDir }), /ISO-8601|since/i); // not a datetime
});

test("jobs.history still accepts a valid ISO 'since'", () => {
  const auditDir = tempRuntimeDir("test-history-since-ok");
  writeRecord(auditDir, { run_id: "hist-old", created_at: "2026-06-01T00:00:00.000Z" });
  writeRecord(auditDir, { run_id: "hist-new", created_at: "2026-06-09T00:00:00.000Z" });
  assert.deepEqual(jobsHistory({ auditDir, since: "2026-06-05T00:00:00.000Z" }).runs.map((r) => r.run_id), ["hist-new"]);
});

test("jobs.history surfaces job_type lineage when present", () => {
  const auditDir = tempRuntimeDir("test-history-jobtype");
  writeRecord(auditDir, { run_id: "jt-a", job_type: "eval", status: "finished" });
  const entry = jobsHistory({ auditDir }).runs.find((r) => r.run_id === "jt-a");
  assert.equal(entry.job_type, "eval");
});

test("jobs.history filters by project (slug or hash) and reports project per run", () => {
  const auditDir = tempRuntimeDir("test-history-project");
  writeRecord(auditDir, { run_id: "hp-a", project: "alpha", project_hash: projectHashFor("alpha"), status: "running" });
  writeRecord(auditDir, { run_id: "hp-b", project: "beta", project_hash: projectHashFor("beta"), status: "finished" });
  writeRecord(auditDir, { run_id: "hp-legacy", status: "failed" }); // no project -> unassigned

  // a human-typed name is canonicalized before matching
  assert.deepEqual(jobsHistory({ auditDir, project: "Alpha" }).runs.map((r) => r.run_id), ["hp-a"]);
  // the exact project hash also matches
  assert.deepEqual(jobsHistory({ auditDir, project: projectHashFor("beta") }).runs.map((r) => r.run_id), ["hp-b"]);
  // a record written before projects existed surfaces as unassigned
  const legacy = jobsHistory({ auditDir }).runs.find((r) => r.run_id === "hp-legacy");
  assert.equal(legacy.project, "unassigned");
});

test("jobs.history limit caps returned rows but reports the full total", () => {
  const auditDir = tempRuntimeDir("test-history-limit");
  writeRecord(auditDir, { run_id: "hist-a", created_at: "2026-06-01T00:00:00.000Z" });
  writeRecord(auditDir, { run_id: "hist-b", created_at: "2026-06-02T00:00:00.000Z" });
  writeRecord(auditDir, { run_id: "hist-c", created_at: "2026-06-03T00:00:00.000Z" });

  const limited = jobsHistory({ auditDir, limit: 1 });
  assert.equal(limited.total, 3);
  assert.equal(limited.returned, 1);
  assert.deepEqual(limited.runs.map((r) => r.run_id), ["hist-c"]);
});

test("jobs.history surfaces scheduler-reported placement when present", () => {
  const auditDir = tempRuntimeDir("test-history-placement");
  writeRecord(auditDir, {
    run_id: "pl-a",
    platform: "uts-ihpc",
    profile_id: "uts-ihpc-account-a",
    status: "running",
    placement: { hostname: "venus01", node_id: "venus01", gpu_index: 1 }
  });
  writeRecord(auditDir, { run_id: "pl-pbs", status: "finished" }); // PBS: no placement
  const entries = jobsHistory({ auditDir }).runs;
  const ihpc = entries.find((r) => r.run_id === "pl-a");
  assert.deepEqual(ihpc.placement, { hostname: "venus01", node_id: "venus01", gpu_index: 1 });
  const pbs = entries.find((r) => r.run_id === "pl-pbs");
  assert.equal(Object.hasOwn(pbs, "placement"), false); // absent when the record has none
});

test("jobs.history returns an empty result for a directory with no records", () => {
  const auditDir = tempRuntimeDir("test-history-empty");
  const result = jobsHistory({ auditDir });
  assert.deepEqual(result, { total: 0, returned: 0, runs: [] });
});
