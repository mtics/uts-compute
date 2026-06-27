import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { applyStateMigration, planStateMigration } from "../../dist/ops/data/migrations.js";
import {
  validateAccessCheckResult,
  validateApprovalRecord,
  validateArtifactCleanupExecutionRecord,
  validateArtifactCleanupPlan,
  validateArtifactFetchBatchRecord,
  validateArtifactFetchRecord,
  validateArtifactManifest,
  validateArtifactSummary,
  validatePlannedJob,
  validatePlannedTransfer,
  validateQuotaSnapshot,
  validateRunRecord,
  validateStateMigrationApply,
  validateStateMigrationPlan,
  validateTransferExecutionRecord
} from "../../dist/core/validation.js";
import { runtimeRoot as testStateRoot } from "../helpers/index.mjs";

// The migration tool reports/re-resolves candidate paths relative to the RUNTIME root (core/paths.ts),
// which on a real install is a per-user dir OUTSIDE the project. This file therefore runs under the
// helper's per-process isolated runtime root (testStateRoot — a temp dir outside the repo) and asserts
// runtime-relative paths. No projectRoot pin is needed: that is exactly what the v0.1.1 path fix enables.
const observedAt = "2026-06-15T00:00:00.000Z";
const hash = "a".repeat(64);

const seededRuntimeRoots = [];
function tempRuntimeRoot() {
  const dir = path.join(testStateRoot, `test-migrations-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  seededRuntimeRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of seededRuntimeRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function snapshotTree(root) {
  const entries = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const fullPath = path.join(dir, name);
      const stat = fs.lstatSync(fullPath);
      const entry = {
        path: path.relative(root, fullPath),
        mode: stat.mode,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      };
      if (stat.isDirectory()) {
        entries.push({ ...entry, type: "directory" });
        walk(fullPath);
      } else if (stat.isSymbolicLink()) {
        entries.push({ ...entry, type: "symlink", target: fs.readlinkSync(fullPath) });
      } else if (stat.isFile()) {
        entries.push({
          ...entry,
          type: "file",
          sha256: crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")
        });
      } else {
        entries.push({ ...entry, type: "other" });
      }
    }
  }
  walk(root);
  return entries;
}

function runRecord(extra = {}) {
  return {
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: null,
    plan_hash: hash,
    quota_snapshot_id: "quota-migration",
    status: "planned",
    created_at: observedAt,
    updated_at: observedAt,
    events: [
      {
        at: observedAt,
        kind: "dry-run-plan",
        summary: "migration fixture"
      }
    ],
    ...extra
  };
}

function approvalRecord(extra = {}) {
  return {
    approval_id: "approval-migration",
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    operation: "jobs.submit",
    state: "required",
    plan_hash: hash,
    quota_snapshot_id: "quota-migration",
    reasons: ["migration fixture"],
    requested_at: observedAt,
    expires_at: "2000-01-01T00:00:00.000Z",
    warnings: [],
    ...extra
  };
}

function quotaSnapshot(extra = {}) {
  return {
    snapshot_id: "quota-migration",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    observed_at: observedAt,
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      identity: {
        remote_user_observed: true
      }
    },
    commands: [],
    warnings: [],
    ...extra
  };
}

function normalizedJobSpec(extra = {}) {
  return {
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    experiment: {
      name: "migration fixture"
    },
    resources: {
      queue: "smallq",
      ncpus: 1,
      memory_gb: 1,
      walltime: "01:00:00",
      ngpus: 0
    },
    command: "python train.py --epochs 1",
    workdir: "/shared/homes/${USER}/experiments/migration-run",
    outputs: ["metrics.json"],
    approval: {
      required: false,
      reasons: []
    },
    ...extra
  };
}

test("persisted record schemas accept optional current schema_version and reject unsupported versions", () => {
  const artifactId = "artifact-aaaaaaaaaaaaaaaaaaaaaaaa";
  const fixtures = [
    [
      validateAccessCheckResult,
      {
        mode: "read-only",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        observed_at: observedAt,
        requires_vpn: true,
        host_alias: "uts-hpc",
        overall_status: "passed",
        checks: [],
        warnings: []
      }
    ],
    [validateApprovalRecord, approvalRecord()],
    [
      validateArtifactCleanupPlan,
      {
        mode: "dry-run",
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        plan_hash: hash,
        cleanup_plan_hash: hash,
        generated_at: observedAt,
        remote_candidates: [],
        local_candidates: [],
        cleanup_plan_path: ".uts-computing/artifacts/migration-run/cleanup-plan.json",
        warnings: []
      }
    ],
    [
      validateArtifactCleanupExecutionRecord,
      {
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        approval_id: "approval-migration",
        kind: "cleanup-execute",
        observed_at: observedAt,
        evidence: {
          manifest_hash: hash,
          artifact_ids: [artifactId],
          remote_deleted_files: ["/shared/homes/<user>/experiments/migration-run/metrics.json"],
          remote_missing: [],
          remote_total_deleted_bytes: 12,
          local_deleted_files: ["<artifact-cache>/files/metrics.json"],
          command: {
            program: "ssh",
            args: ["<redacted>"],
            remote_argv: ["python3", "-", "<artifact-spec>"]
          }
        }
      }
    ],
    [
      validateArtifactFetchBatchRecord,
      {
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        approval_id: "approval-migration",
        kind: "fetch-batch",
        observed_at: observedAt,
        evidence: {
          approval_id: "approval-migration",
          artifact_ids: [artifactId],
          manifest_hash: hash,
          max_bytes_per_file: 1024,
          max_total_bytes: 1024,
          total_size_bytes: 12,
          files: [
            {
              artifact_id: artifactId,
              artifact_path: "metrics.json",
              local_path: "files/metrics.json",
              size_bytes: 12,
              sha256: hash,
              command: {
                program: "ssh",
                args: ["<redacted>"],
                remote_argv: ["python3", "-"]
              }
            }
          ]
        }
      }
    ],
    [
      validateArtifactFetchRecord,
      {
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        artifact_id: artifactId,
        approval_id: "approval-migration",
        kind: "fetch",
        observed_at: observedAt,
        evidence: {
          command: {
            program: "ssh",
            args: ["<redacted>"],
            remote_argv: ["python3", "-"]
          },
          artifact_path: "metrics.json",
          local_path: "files/metrics.json",
          size_bytes: 12,
          sha256: hash
        }
      }
    ],
    [
      validateArtifactManifest,
      {
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        created_at: observedAt,
        artifacts: [
          {
            artifact_id: artifactId,
            remote_path: "/shared/homes/${USER}/experiments/migration-run/metrics.json",
            path: "/shared/homes/<user>/experiments/migration-run/metrics.json",
            relative_path: "metrics.json",
            kind: "file",
            size_bytes: 12,
            sha256: hash,
            checksum_status: "captured",
            source_output: "metrics.json"
          }
        ],
        truncated: false
      }
    ],
    [
      validateArtifactSummary,
      {
        mode: "local",
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        generated_at: observedAt,
        summary_path: ".uts-computing/artifacts/migration-run/summary.md",
        metrics_path: ".uts-computing/artifacts/migration-run/metrics.json",
        metrics: {}
      }
    ],
    [
      validatePlannedJob,
      {
        mode: "dry-run",
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        plan_hash: hash,
        template: "pbs-cpu",
        script: "#!/bin/bash\ntrue\n",
        normalized_job_spec: normalizedJobSpec(),
        approval: {
          required: false,
          reasons: []
        },
        warnings: []
      }
    ],
    [
      validatePlannedTransfer,
      {
        mode: "dry-run",
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        direction: "download",
        plan_hash: hash,
        source: "/shared/homes/${USER}/experiments/migration-run",
        destination: ".uts-computing/transfers/migration-run/files",
        files: ["metrics.json"],
        max_total_bytes: 1024,
        script: "# transfer dry-run\n",
        warnings: []
      }
    ],
    [validateQuotaSnapshot, quotaSnapshot()],
    [validateRunRecord, runRecord()],
    [
      validateTransferExecutionRecord,
      {
        run_id: "migration-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        approval_id: "approval-migration",
        kind: "transfer-execute",
        observed_at: observedAt,
        evidence: {
          direction: "download",
          source: "/shared/homes/<user>/experiments/migration-run",
          destination: ".uts-computing/transfers/migration-run/files",
          files: [{ path: "metrics.json", size_bytes: 12 }],
          total_size_bytes: 12,
          max_total_bytes: 1024,
          command: {
            program: "rsync",
            args: ["--files-from=-"]
          }
        }
      }
    ]
  ];

  for (const [validator, fixture] of fixtures) {
    assert.equal(validator(fixture).valid, true);
    assert.equal(validator({ ...fixture, schema_version: "0.1.0" }).valid, true);
    assert.equal(validator({ ...fixture, schema_version: "9.9.9" }).valid, false);
  }
});

test("state migration dry-run reports candidates without mutating local state", () => {
  const root = tempRuntimeRoot();
  const runtimeRoot = root; // absolute resolved runtime root; reported paths are relative to it
  writeJson(path.join(root, "runs", "migration-run.json"), runRecord());
  fs.writeFileSync(path.join(root, "runs", "corrupt.json"), "{not-json\n", "utf8");
  writeJson(path.join(root, "approvals", "approval-migration.json"), approvalRecord({ schema_version: "0.1.0" }));
  writeJson(
    path.join(root, "quotas", "quota-migration.json"),
    {
      snapshot: quotaSnapshot(),
      command_outputs: [
        {
          id: "identity.whoami",
          stdout: "<redacted>",
          stderr: ""
        }
      ]
    }
  );
  writeJson(path.join(root, "plans", "migration-run.json"), {
    mode: "dry-run",
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    plan_hash: hash,
    template: "pbs-cpu",
    script: "#!/bin/bash\ntrue\n",
    normalized_job_spec: normalizedJobSpec(),
    approval: {
      required: false,
      reasons: []
    },
    warnings: []
  });
  const transferRunRoot = path.join(root, "transfers", "migration-run");
  writeJson(path.join(transferRunRoot, "plan.json"), {
    mode: "dry-run",
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    direction: "download",
    plan_hash: hash,
    source: "/shared/homes/${USER}/experiments/migration-run",
    destination: ".uts-computing/transfers/migration-run/files",
    files: ["metrics.json"],
    max_total_bytes: 1024,
    script: "# transfer dry-run\n",
    warnings: []
  });
  writeJson(path.join(transferRunRoot, "execute-2026-06-15T00-00-00-000Z.json"), {
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    approval_id: "approval-migration",
    kind: "transfer-execute",
    observed_at: observedAt,
    evidence: {
      direction: "download",
      source: "/shared/homes/<user>/experiments/migration-run",
      destination: ".uts-computing/transfers/migration-run/files",
      files: [{ path: "metrics.json", size_bytes: 12 }],
      total_size_bytes: 12,
      max_total_bytes: 1024,
      command: {
        program: "rsync",
        args: ["--files-from=-"]
      }
    }
  });
  const artifactRunRoot = path.join(root, "artifacts", "migration-run");
  writeJson(path.join(artifactRunRoot, "cleanup-execute-2026-06-15T00-00-00-000Z.json"), {
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    approval_id: "approval-migration",
    kind: "cleanup-execute",
    observed_at: observedAt,
    evidence: {
      manifest_hash: hash,
      artifact_ids: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"],
      remote_deleted_files: ["/shared/homes/<user>/experiments/migration-run/metrics.json"],
      remote_missing: [],
      remote_total_deleted_bytes: 12,
      local_deleted_files: ["<artifact-cache>/files/metrics.json"],
      command: {
        program: "ssh",
        args: ["<redacted>"],
        remote_argv: ["python3", "-", "<artifact-spec>"]
      }
    }
  });

  const outside = path.join(root, "..", `outside-${process.pid}.json`);
  fs.writeFileSync(outside, "{}\n", "utf8");
  seededRuntimeRoots.push(outside); // sibling of root (outside the runtime root); clean it in teardown too
  fs.symlinkSync(outside, path.join(root, "runs", "escape.json"));

  const before = snapshotTree(root);
  const migration = planStateMigration({ runtimeRoot, now: new Date(observedAt) }).migration;
  const after = snapshotTree(root);

  assert.deepEqual(after, before);
  assert.equal(validateStateMigrationPlan(migration).valid, true);
  assert.equal(migration.mode, "dry-run");
  assert.equal(migration.writes_planned, false);
  assert.equal(migration.approval_state_would_change, false);
  assert.equal(migration.run_state_would_change, false);
  assert.ok(migration.files_read.every((file) => !path.isAbsolute(file) && !file.startsWith("..")));
  assert.ok(migration.files_would_write.includes(path.join("runs", "migration-run.json")));
  assert.ok(migration.files_would_write.includes(path.join("quotas", "quota-migration.json")));

  const approval = JSON.parse(fs.readFileSync(path.join(root, "approvals", "approval-migration.json"), "utf8"));
  assert.equal(approval.state, "required");
  assert.equal(Object.hasOwn(approval, "used_at"), false);

  const currentApproval = migration.records.find((record) => record.kind === "approval-record");
  assert.equal(currentApproval.status, "current");
  const plannedJob = migration.records.find((record) => record.kind === "planned-job");
  assert.equal(plannedJob.status, "would-update");
  assert.deepEqual(plannedJob.would_change_fields, ["schema_version"]);
  const plannedTransfer = migration.records.find((record) => record.kind === "planned-transfer");
  assert.equal(plannedTransfer.status, "would-update");
  assert.deepEqual(plannedTransfer.would_change_fields, ["schema_version"]);
  const cleanupExecution = migration.records.find((record) => record.kind === "artifact-cleanup-execution-record");
  assert.equal(cleanupExecution.status, "would-update");
  assert.deepEqual(cleanupExecution.would_change_fields, ["schema_version"]);
  assert.ok(migration.cannot_migrate.some((record) => record.path.endsWith("corrupt.json")));
  assert.ok(migration.cannot_migrate.some((record) => record.path.endsWith("escape.json")));
});

test("state migration apply backs up files and adds only schema versions", () => {
  const root = tempRuntimeRoot();
  const runtimeRoot = root; // absolute resolved runtime root; reported paths are relative to it
  const now = new Date(observedAt);
  const runPath = path.join(root, "runs", "migration-run.json");
  const approvalPath = path.join(root, "approvals", "approval-migration.json");
  const quotaPath = path.join(root, "quotas", "quota-migration.json");
  const planPath = path.join(root, "plans", "migration-run.json");

  writeJson(runPath, runRecord());
  writeJson(approvalPath, approvalRecord());
  writeJson(quotaPath, {
    snapshot: quotaSnapshot(),
    command_outputs: [
      {
        id: "identity.whoami",
        stdout: "<redacted>",
        stderr: ""
      }
    ]
  });
  writeJson(planPath, {
    mode: "dry-run",
    run_id: "migration-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    plan_hash: hash,
    template: "pbs-cpu",
    script: "#!/bin/bash\ntrue\n",
    normalized_job_spec: normalizedJobSpec(),
    approval: {
      required: false,
      reasons: []
    },
    warnings: []
  });

  const originalRunText = fs.readFileSync(runPath, "utf8");
  const originalApprovalText = fs.readFileSync(approvalPath, "utf8");
  const originalQuotaText = fs.readFileSync(quotaPath, "utf8");
  const plan = planStateMigration({ runtimeRoot, now }).migration;
  assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);
  assert.ok(plan.files_would_write.includes(path.join("runs", "migration-run.json")));

  const applied = applyStateMigration(
    { planHash: plan.plan_hash, confirmationToken: "migration-token" },
    { runtimeRoot, now, confirmationToken: "migration-token" }
  ).migration;

  assert.equal(validateStateMigrationApply(applied).valid, true);
  assert.equal(applied.mode, "apply");
  assert.equal(applied.writes_applied, true);
  assert.equal(applied.plan_hash, plan.plan_hash);
  assert.equal(applied.approval_state_changed, false);
  assert.equal(applied.run_state_changed, false);
  assert.ok(applied.backup_path);
  assert.ok(applied.files_written.includes(path.join("runs", "migration-run.json")));
  assert.ok(applied.files_backed_up.every((file) => file.startsWith(applied.backup_path)));

  const backupRoot = path.join(runtimeRoot, applied.backup_path);
  assert.equal(fs.readFileSync(path.join(backupRoot, "runs", "migration-run.json"), "utf8"), originalRunText);
  assert.equal(fs.readFileSync(path.join(backupRoot, "approvals", "approval-migration.json"), "utf8"), originalApprovalText);
  assert.equal(fs.readFileSync(path.join(backupRoot, "quotas", "quota-migration.json"), "utf8"), originalQuotaText);

  const migratedRun = JSON.parse(fs.readFileSync(runPath, "utf8"));
  assert.equal(migratedRun.schema_version, "0.1.0");
  assert.equal(migratedRun.status, "planned");
  assert.equal(migratedRun.plan_hash, hash);
  assert.equal(migratedRun.quota_snapshot_id, "quota-migration");
  assert.deepEqual(migratedRun.events, runRecord().events);

  const migratedApproval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  assert.equal(migratedApproval.schema_version, "0.1.0");
  assert.equal(migratedApproval.state, "required");
  assert.equal(Object.hasOwn(migratedApproval, "used_at"), false);

  const migratedQuota = JSON.parse(fs.readFileSync(quotaPath, "utf8"));
  assert.equal(Object.hasOwn(migratedQuota, "schema_version"), false);
  assert.equal(migratedQuota.snapshot.schema_version, "0.1.0");
  assert.equal(migratedQuota.command_outputs[0].stdout, "<redacted>");

  const afterPlan = planStateMigration({ runtimeRoot, now }).migration;
  assert.equal(afterPlan.files_would_write.length, 0);
  const noop = applyStateMigration(
    { planHash: afterPlan.plan_hash, confirmationToken: "migration-token" },
    { runtimeRoot, now: new Date("2026-06-15T00:01:00.000Z"), confirmationToken: "migration-token" }
  ).migration;
  assert.equal(noop.writes_applied, false);
  assert.equal(noop.files_written.length, 0);
});

test("state migration apply rejects stale plans, invalid confirmation, and blockers before writing", () => {
  const root = tempRuntimeRoot();
  const runtimeRoot = root; // absolute resolved runtime root; reported paths are relative to it
  const now = new Date(observedAt);
  writeJson(path.join(root, "runs", "migration-run.json"), runRecord());

  const plan = planStateMigration({ runtimeRoot, now }).migration;
  const beforeWrongToken = snapshotTree(root);
  assert.throws(
    () =>
      applyStateMigration(
        { planHash: plan.plan_hash, confirmationToken: "wrong" },
        { runtimeRoot, now, confirmationToken: "migration-token" }
      ),
    /Invalid migration confirmation token/
  );
  assert.deepEqual(snapshotTree(root), beforeWrongToken);

  const beforeWrongHash = snapshotTree(root);
  assert.throws(
    () =>
      applyStateMigration(
        { planHash: "0".repeat(64), confirmationToken: "migration-token" },
        { runtimeRoot, now, confirmationToken: "migration-token" }
      ),
    /planHash does not match/
  );
  assert.deepEqual(snapshotTree(root), beforeWrongHash);

  fs.writeFileSync(path.join(root, "runs", "corrupt.json"), "{not-json\n", "utf8");
  const blockedPlan = planStateMigration({ runtimeRoot, now }).migration;
  const beforeBlocked = snapshotTree(root);
  assert.throws(
    () =>
      applyStateMigration(
        { planHash: blockedPlan.plan_hash, confirmationToken: "migration-token" },
        { runtimeRoot, now, confirmationToken: "migration-token" }
      ),
    /blocked by 1 record/
  );
  assert.deepEqual(snapshotTree(root), beforeBlocked);
  assert.equal(fs.existsSync(path.join(root, "backups")), false);
});
