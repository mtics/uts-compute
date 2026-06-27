// Regression: state migration must work when the runtime root lives OUTSIDE the project root.
//
// The v0.1.1 P2 fix defaults `.uts-computing` to a per-user dir (core/paths.ts:runtimeBaseDir), so on a
// real install the runtime base != projectRoot. The migration tool must therefore report AND re-resolve
// candidate paths relative to the RUNTIME root — not projectRoot. Before the fix, planStateMigration
// rendered every records[].path / files_read / files_would_write as "<outside-project>", and
// applyStateMigration could not re-resolve them (path.resolve(projectRoot, "<outside-project>")), which
// broke apply for any real install. This test drives UTS_COMPUTING_STATE_DIR at a temp dir outside the
// repo and asserts the paths are sane and apply succeeds.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planStateMigration, applyStateMigration } from "../../dist/ops/data/migrations.js";
import { repoRoot } from "../helpers/index.mjs";

const ENV_KEYS = ["UTS_COMPUTING_STATE_DIR", "UTS_COMPUTING_HOME", "XDG_STATE_HOME"];
const ORIG = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const tmpDirs = [];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  while (tmpDirs.length) {
    try {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const observedAt = "2026-06-15T00:00:00.000Z";
function runRecord() {
  // A valid run-record WITHOUT schema_version, so the migration classifies it "would-update".
  return {
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: null,
    plan_hash: "a".repeat(64),
    quota_snapshot_id: "quota-migration",
    status: "planned",
    created_at: observedAt,
    updated_at: observedAt,
    events: [{ at: observedAt, kind: "dry-run-plan", summary: "migration fixture" }]
  };
}

// A reported migration path must be runtime-RELATIVE and sane: never the broken "<outside-...>" fallback,
// never absolute, never an escaping "..", and never leaking the projectRoot/repo path.
const sane = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !path.isAbsolute(p) &&
  !p.startsWith("..") &&
  !p.includes("<outside") &&
  !p.includes(repoRoot);

test("state migration plan+apply work when UTS_COMPUTING_STATE_DIR is OUTSIDE the repo", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "uts-mig-statedir-"));
  tmpDirs.push(stateDir);
  process.env.UTS_COMPUTING_STATE_DIR = stateDir; // runtime base -> outside projectRoot (real-install shape)
  const runtimeRoot = path.join(stateDir, ".uts-computing");
  fs.mkdirSync(path.join(runtimeRoot, "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(runtimeRoot, "runs", "migration-run.json"),
    `${JSON.stringify(runRecord(), null, 2)}\n`,
    "utf8"
  );

  // dry-run: paths must be runtime-relative and sane (NOT "<outside-project>", NOT absolute/leaking repo).
  const plan = planStateMigration({ now: new Date(observedAt) }).migration;
  assert.equal(plan.cannot_migrate.length, 0, JSON.stringify(plan.cannot_migrate));
  const planPaths = [...plan.files_read, ...plan.files_would_write, ...plan.records.map((r) => r.path)];
  assert.ok(planPaths.length > 0, "expected the seeded record to be discovered");
  for (const p of planPaths) {
    assert.ok(sane(p), `plan path not runtime-relative/sane: ${p}`);
  }
  assert.ok(
    plan.files_would_write.includes(path.join("runs", "migration-run.json")),
    `files_would_write=${JSON.stringify(plan.files_would_write)}`
  );

  // apply: must SUCCEED end-to-end (this is what was broken outside the test harness).
  const applied = applyStateMigration(
    { planHash: plan.plan_hash, confirmationToken: "migration-token" },
    { now: new Date(observedAt), confirmationToken: "migration-token" }
  ).migration;
  assert.equal(applied.writes_applied, true);
  assert.ok(applied.files_written.includes(path.join("runs", "migration-run.json")));
  for (const p of [...applied.files_written, ...applied.files_backed_up, applied.backup_path]) {
    assert.ok(sane(p), `apply path not runtime-relative/sane: ${p}`);
  }

  // the on-disk file now carries schema_version, and a backup exists inside the runtime root.
  const migrated = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "runs", "migration-run.json"), "utf8"));
  assert.equal(migrated.schema_version, "0.1.0");
  assert.ok(
    fs.existsSync(path.join(runtimeRoot, applied.backup_path, "runs", "migration-run.json")),
    "expected a backup of the migrated file inside the runtime root"
  );
});
