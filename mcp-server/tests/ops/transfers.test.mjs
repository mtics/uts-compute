import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import { executeTransfer, planTransfer } from "../../dist/ops/data/transfer.js";
import { validatePlannedTransfer, validateTransferExecutionRecord } from "../../dist/core/validation.js";
import { repoRoot, tempRuntimeDir, writeProfileConfig, writeQuotaSnapshot, runtimeRoot } from "../helpers/index.mjs";

// Upload sources must live under the project root (assertExistingDirectoryInsideProject), so they
// can't be relocated to the isolated runtime root; remove them in teardown so the repo's .uts-computing
// doesn't retain test scratch (Bug P2).
after(() => {
  const transfersRoot = path.join(repoRoot, ".uts-computing", "transfers");
  for (const runId of ["transfer-upload-fixed", "transfer-upload-checksum-mismatch"]) {
    fs.rmSync(path.join(transfersRoot, runId), { recursive: true, force: true });
  }
  try {
    fs.rmdirSync(transfersRoot); // remove the now-empty parent; rmdirSync throws (caught) if not empty
  } catch {
    /* leave a non-empty transfers dir untouched */
  }
});

function latestRecord(dir, runId, prefix) {
  const runDir = path.join(dir, runId);
  const file = fs
    .readdirSync(runDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .at(-1);
  assert.ok(file, `expected ${prefix} record in ${runDir}`);
  return JSON.parse(fs.readFileSync(path.join(runDir, file), "utf8"));
}

function approveTransfer(plan, transferDir, quotaSnapshotId, resourceSummary, now = new Date("2026-06-15T00:00:00.000Z")) {
  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      operation: "transfers.execute",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      reasons: ["Execute fixed-file rsync transfer"],
      resourceSummary
    },
    { approvalDir: transferDir, now }
  ).approval;
  return decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      confirmationToken: "transfer-token"
    },
    { approvalDir: transferDir, now, confirmationToken: "transfer-token" }
  ).approval;
}

function writeSizedFile(filePath, size) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(size, "x"));
}

function sha256SizedFile(size, fill = "x") {
  return crypto.createHash("sha256").update(Buffer.alloc(size, fill)).digest("hex");
}

function preflightFile(filePath, size, fill = "x") {
  return {
    path: filePath,
    size_bytes: size,
    sha256: sha256SizedFile(size, fill),
    checksum_status: "captured"
  };
}

function writeSparseFile(filePath, size) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "w");
  try {
    fs.ftruncateSync(fd, size);
  } finally {
    fs.closeSync(fd);
  }
}

test("transfers.plan persists a hashed fixed-file transfer plan", () => {
  const transferDir = tempRuntimeDir("test-transfers");
  const plan = planTransfer(
    {
      run_id: "transfer-plan-fixed",
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: "/shared/homes/${USER}/experiments/transfer-plan-fixed",
      destination: path.join(runtimeRoot, "transfers", "transfer-plan-fixed", "files"),
      files: ["logs/run.out", "metrics.json"],
      max_total_bytes: 4096
    },
    { transferDir }
  );

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.platform, "uts-hpc");
  assert.match(plan.plan_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.files, ["logs/run.out", "metrics.json"]);
  assert.ok(plan.plan_path);
  assert.equal(fs.existsSync(plan.plan_path), true);
  const persisted = JSON.parse(fs.readFileSync(plan.plan_path, "utf8"));
  assert.equal(validatePlannedTransfer(persisted).valid, true);
  assert.equal(validatePlannedTransfer({ ...persisted, rsync_flags: ["--delete"] }).valid, false);
});

test("transfers.plan rejects unsafe fixed-file lists before persisting", () => {
  const transferDir = tempRuntimeDir("test-transfers");
  const base = {
    run_id: "transfer-unsafe-files",
    profile_id: "uts-hpc-account-a",
    direction: "download",
    source: "/shared/homes/${USER}/experiments/transfer-unsafe-files",
    destination: path.join(runtimeRoot, "transfers", "transfer-unsafe-files", "files"),
    max_total_bytes: 4096
  };

  assert.throws(() => planTransfer({ ...base, files: ["../secret.txt"] }, { transferDir }), /Invalid transfer plan|Unsafe/);
  assert.throws(() => planTransfer({ ...base, files: ["metrics.json", "metrics.json"] }, { transferDir }), /Invalid transfer plan|unique/);
  assert.equal(fs.existsSync(path.join(transferDir, "transfer-unsafe-files", "plan.json")), false);
});

test("transfer execution schema preserves checksum evidence invariants while accepting old records", () => {
  const baseRecord = {
    run_id: "transfer-schema-checksum",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    approval_id: "approval-transfer-schema",
    kind: "transfer-execute",
    observed_at: "2026-06-15T00:00:00.000Z",
    evidence: {
      direction: "download",
      source: "/shared/homes/<user>/experiments/transfer-schema-checksum",
      destination: ".uts-computing/transfers/transfer-schema-checksum/files",
      files: [{ path: "metrics.json", size_bytes: 32, sha256: sha256SizedFile(32), checksum_status: "verified" }],
      checksum_policy: { algorithm: "sha256", max_file_bytes: 50000000 },
      total_size_bytes: 32,
      max_total_bytes: 1024,
      command: { program: "rsync", args: ["--files-from=-"] }
    }
  };

  assert.equal(validateTransferExecutionRecord(baseRecord).valid, true);
  assert.equal(
    validateTransferExecutionRecord({
      ...baseRecord,
      evidence: { ...baseRecord.evidence, files: [{ path: "metrics.json", size_bytes: 32 }] }
    }).valid,
    true
  );
  assert.equal(
    validateTransferExecutionRecord({
      ...baseRecord,
      evidence: { ...baseRecord.evidence, files: [{ path: "metrics.json", size_bytes: 32, checksum_status: "verified" }] }
    }).valid,
    false
  );
  assert.equal(
    validateTransferExecutionRecord({
      ...baseRecord,
      evidence: {
        ...baseRecord.evidence,
        files: [{ path: "metrics.json", size_bytes: 32, sha256: sha256SizedFile(32), checksum_status: "skipped-large" }]
      }
    }).valid,
    false
  );
  assert.equal(
    validateTransferExecutionRecord({
      ...baseRecord,
      evidence: { ...baseRecord.evidence, files: [{ path: "metrics.json", size_bytes: 32, sha256: sha256SizedFile(32) }] }
    }).valid,
    false
  );
});

test("transfers.execute downloads explicit files through preflight and fixed rsync argv", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const quotaSnapshotId = "quota-transfer-download-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const destination = path.join(runtimeRoot, "transfers", "transfer-download-fixed", "files");
  const plan = planTransfer(
    {
      run_id: "transfer-download-fixed",
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: "/shared/homes/${USER}/experiments/transfer-download-fixed",
      destination,
      files: ["logs/run.out", "metrics.json"],
      max_total_bytes: 4096
    },
    { transferDir, now }
  );
  const resourceSummary = {
    direction: plan.direction,
    source: plan.source,
    destination: plan.destination,
    files: plan.files,
    max_total_bytes: plan.max_total_bytes
  };
  const approval = approveTransfer(plan, transferDir, quotaSnapshotId, resourceSummary, now);
  const calls = [];

  const result = await executeTransfer(
    { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
    {
      transferDir,
      approvalDir: transferDir,
      now,
      executor: async (program, args, timeoutMs, stdin) => {
        calls.push({ program, args, stdin, timeoutMs });
        if (program === "ssh") {
          assert.equal(args.at(-4), "uts-hpc");
          assert.equal(args.at(-3), "python3");
          assert.match(stdin, /realpath/);
          const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
          assert.deepEqual(spec, {
            root: "/shared/homes/${USER}/experiments/transfer-download-fixed",
            files: ["logs/run.out", "metrics.json"],
            max_total_bytes: 4096,
            checksum_max_bytes: 50000000
          });
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              files: [
                preflightFile("logs/run.out", 1200),
                preflightFile("metrics.json", 32)
              ],
              total_size_bytes: 1232
            })}\n`,
            stderr: ""
          };
        }
        assert.equal(program, "rsync");
        assert.equal(args.includes("--files-from=-"), true);
        assert.equal(args.includes("--delete"), false);
        assert.equal(args.some((arg) => arg.includes("--remove-source-files")), false);
        assert.equal(stdin, "logs/run.out\nmetrics.json\n");
        assert.ok(args.some((arg) => arg.startsWith("uts-hpc:/shared/homes/${USER}/experiments/transfer-download-fixed/")));
        assert.ok(args.some((arg) => arg === `${destination}/`));
        writeSizedFile(path.join(destination, "logs/run.out"), 1200);
        writeSizedFile(path.join(destination, "metrics.json"), 32);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.equal(result.transfer.total_size_bytes, 1232);
  assert.equal(result.transfer.command.args.some((arg) => arg.includes("uts-hpc")), false);
  assert.equal(result.transfer.command.args.some((arg) => arg.includes("${USER}")), false);
  const record = latestRecord(transferDir, plan.run_id, "execute-");
  assert.equal(validateTransferExecutionRecord(record).valid, true);
  assert.equal(record.evidence.total_size_bytes, 1232);
  assert.deepEqual(record.evidence.checksum_policy, { algorithm: "sha256", max_file_bytes: 50000000 });
  assert.equal(record.evidence.files[0].checksum_status, "verified");
  assert.equal(record.evidence.files[0].sha256, sha256SizedFile(1200));
  assert.equal(record.evidence.files[1].checksum_status, "verified");
  assert.equal(record.evidence.files[1].sha256, sha256SizedFile(32));
  assert.equal(JSON.stringify(record.evidence).includes("uts-hpc:"), false);
  assert.equal(JSON.stringify(record.evidence).includes("${USER}"), false);
  assert.equal(JSON.stringify(record.evidence).includes(repoRoot), false);

  const consumed = readApproval(approval.approval_id, { approvalDir: transferDir });
  assert.ok(consumed.used_at);
  assert.equal(consumed.operation, "transfers.execute");
});

test("transfers.execute uploads explicit files and verifies remote checksums", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const quotaSnapshotId = "quota-transfer-upload-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  // Upload sources are confined to the project root (assertExistingDirectoryInsideProject), not the
  // runtime root, so they stay under the repo's .uts-computing. Fixed path, pre-cleaned each run.
  const source = path.join(repoRoot, ".uts-computing", "transfers", "transfer-upload-fixed", "source");
  fs.rmSync(source, { recursive: true, force: true });
  writeSizedFile(path.join(source, "logs/run.out"), 1200);
  writeSizedFile(path.join(source, "metrics.json"), 32);
  const destination = "/shared/homes/${USER}/experiments/transfer-upload-fixed";
  const plan = planTransfer(
    {
      run_id: "transfer-upload-fixed",
      profile_id: "uts-hpc-account-a",
      direction: "upload",
      source,
      destination,
      files: ["logs/run.out", "metrics.json"],
      max_total_bytes: 4096
    },
    { transferDir, now }
  );
  const approval = approveTransfer(
    plan,
    transferDir,
    quotaSnapshotId,
    {
      direction: plan.direction,
      source: plan.source,
      destination: plan.destination,
      files: plan.files,
      max_total_bytes: plan.max_total_bytes
    },
    now
  );
  const calls = [];

  await executeTransfer(
    { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
    {
      transferDir,
      approvalDir: transferDir,
      now,
      executor: async (program, args, timeoutMs, stdin) => {
        calls.push({ program, args, stdin, timeoutMs });
        if (program === "rsync") {
          assert.equal(args.includes("--files-from=-"), true);
          assert.equal(stdin, "logs/run.out\nmetrics.json\n");
          assert.ok(args.some((arg) => arg === `${fs.realpathSync(source)}/`));
          assert.ok(args.some((arg) => arg.startsWith("uts-hpc:/shared/homes/${USER}/experiments/transfer-upload-fixed/")));
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        assert.equal(program, "ssh");
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.deepEqual(spec, {
          root: destination,
          files: ["logs/run.out", "metrics.json"],
          max_total_bytes: 4096,
          checksum_max_bytes: 50000000
        });
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            files: [preflightFile("logs/run.out", 1200), preflightFile("metrics.json", 32)],
            total_size_bytes: 1232
          })}\n`,
          stderr: ""
        };
      }
    }
  );

  assert.deepEqual(calls.map((call) => call.program), ["rsync", "ssh"]);
  const record = latestRecord(transferDir, plan.run_id, "execute-");
  assert.equal(validateTransferExecutionRecord(record).valid, true);
  assert.equal(record.evidence.files[0].checksum_status, "verified");
  assert.equal(record.evidence.files[0].sha256, sha256SizedFile(1200));
  assert.equal(record.evidence.files[1].checksum_status, "verified");
  assert.equal(record.evidence.files[1].sha256, sha256SizedFile(32));
  assert.equal(JSON.stringify(record.evidence).includes("uts-hpc:"), false);
  assert.equal(JSON.stringify(record.evidence).includes("${USER}"), false);
  assert.equal(JSON.stringify(record.evidence).includes(repoRoot), false);
  assert.ok(readApproval(approval.approval_id, { approvalDir: transferDir }).used_at);
});

test("transfers.execute rejects uploaded file checksum mismatches before writing evidence", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const runId = "transfer-upload-checksum-mismatch";
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  // Upload source confined to the project root (see above), not the runtime root.
  const source = path.join(repoRoot, ".uts-computing", "transfers", runId, "source");
  fs.rmSync(source, { recursive: true, force: true });
  writeSizedFile(path.join(source, "metrics.json"), 32);
  const plan = planTransfer(
    {
      run_id: runId,
      profile_id: "uts-hpc-account-a",
      direction: "upload",
      source,
      destination: `/shared/homes/\${USER}/experiments/${runId}`,
      files: ["metrics.json"],
      max_total_bytes: 1024
    },
    { transferDir, now }
  );
  const approval = approveTransfer(
    plan,
    transferDir,
    quotaSnapshotId,
    {
      direction: plan.direction,
      source: plan.source,
      destination: plan.destination,
      files: plan.files,
      max_total_bytes: plan.max_total_bytes
    },
    now
  );

  await assert.rejects(
    () =>
      executeTransfer(
        { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
        {
          transferDir,
          approvalDir: transferDir,
          now,
          executor: async (program) => {
            if (program === "rsync") {
              return { exitCode: 0, stdout: "", stderr: "" };
            }
            assert.equal(program, "ssh");
            return {
              exitCode: 0,
              stdout: `${JSON.stringify({
                files: [preflightFile("metrics.json", 32, "y")],
                total_size_bytes: 32
              })}\n`,
              stderr: ""
            };
          }
        }
      ),
    /checksum does not match/
  );
  assert.ok(readApproval(approval.approval_id, { approvalDir: transferDir }).used_at);
  assert.throws(() => latestRecord(transferDir, plan.run_id, "execute-"), /expected execute-/);
});

test("transfers.execute records skipped-large checksum evidence for oversized downloads", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const runId = "transfer-download-skipped-large";
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  const size = 50_000_001;
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const destination = path.join(runtimeRoot, "transfers", runId, "files");
  const plan = planTransfer(
    {
      run_id: runId,
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: `/shared/homes/\${USER}/experiments/${runId}`,
      destination,
      files: ["large.bin"],
      max_total_bytes: 60_000_000
    },
    { transferDir, now }
  );
  const approval = approveTransfer(
    plan,
    transferDir,
    quotaSnapshotId,
    {
      direction: plan.direction,
      source: plan.source,
      destination: plan.destination,
      files: plan.files,
      max_total_bytes: plan.max_total_bytes
    },
    now
  );

  await executeTransfer(
    { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
    {
      transferDir,
      approvalDir: transferDir,
      now,
      executor: async (program) => {
        if (program === "ssh") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({
              files: [{ path: "large.bin", size_bytes: size, checksum_status: "skipped-large" }],
              total_size_bytes: size
            })}\n`,
            stderr: ""
          };
        }
        assert.equal(program, "rsync");
        writeSparseFile(path.join(destination, "large.bin"), size);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  );

  const record = latestRecord(transferDir, plan.run_id, "execute-");
  assert.equal(validateTransferExecutionRecord(record).valid, true);
  assert.equal(record.evidence.files[0].checksum_status, "skipped-large");
  assert.equal(Object.hasOwn(record.evidence.files[0], "sha256"), false);
  assert.deepEqual(record.evidence.checksum_policy, { algorithm: "sha256", max_file_bytes: 50000000 });
});

test("transfers.execute verifies downloaded files before writing execution evidence", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const cases = [
    {
      name: "missing",
      files: ["metrics.json"],
      prepareDestination: () => {},
      error: /missing after rsync/
    },
    {
      name: "size-mismatch",
      files: ["metrics.json"],
      prepareDestination: (destination) => {
        writeSizedFile(path.join(destination, "metrics.json"), 31);
      },
      error: /size does not match/
    },
    {
      name: "symlink",
      files: ["metrics.json"],
      prepareDestination: (destination, transferDir) => {
        const outside = path.join(transferDir, "outside-metrics.json");
        writeSizedFile(outside, 32);
        fs.mkdirSync(destination, { recursive: true });
        fs.symlinkSync(outside, path.join(destination, "metrics.json"));
      },
      error: /symbolic link/
    },
    {
      name: "directory",
      files: ["metrics.json"],
      prepareDestination: (destination) => {
        fs.mkdirSync(path.join(destination, "metrics.json"), { recursive: true });
      },
      error: /not a regular file/
    },
    {
      name: "parent-symlink",
      files: ["linked/metrics.json"],
      prepareDestination: (destination, transferDir) => {
        const outsideDir = path.join(transferDir, "outside-linked");
        writeSizedFile(path.join(outsideDir, "metrics.json"), 32);
        fs.mkdirSync(destination, { recursive: true });
        fs.symlinkSync(outsideDir, path.join(destination, "linked"));
      },
      error: /stay inside/
    },
    {
      name: "partial-multi-file",
      files: ["logs/run.out", "metrics.json"],
      prepareDestination: (destination) => {
        writeSizedFile(path.join(destination, "logs/run.out"), 1200);
      },
      error: /missing after rsync/
    }
  ];

  for (const testCase of cases) {
    const transferDir = tempRuntimeDir("test-transfers");
    const runId = `transfer-download-verify-${testCase.name}`;
    const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
    writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
    const destination = path.join(runtimeRoot, "transfers", runId, "files");
    fs.rmSync(destination, { recursive: true, force: true });
    const plan = planTransfer(
      {
        run_id: runId,
        profile_id: "uts-hpc-account-a",
        direction: "download",
        source: `/shared/homes/\${USER}/experiments/${runId}`,
        destination,
        files: testCase.files,
        max_total_bytes: 4096
      },
      { transferDir, now }
    );
    const approval = approveTransfer(
      plan,
      transferDir,
      quotaSnapshotId,
      {
        direction: plan.direction,
        source: plan.source,
        destination: plan.destination,
        files: plan.files,
        max_total_bytes: plan.max_total_bytes
      },
      now
    );
    const calls = [];

    try {
      await assert.rejects(
        () =>
          executeTransfer(
            { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
            {
              transferDir,
              approvalDir: transferDir,
              now,
              executor: async (program, args, timeoutMs, stdin) => {
                calls.push({ program, args, timeoutMs, stdin });
                if (program === "ssh") {
                  const files = testCase.files.map((file) => preflightFile(file, file === "logs/run.out" ? 1200 : 32));
                  return {
                    exitCode: 0,
                    stdout: `${JSON.stringify({
                      files,
                      total_size_bytes: files.reduce((total, file) => total + file.size_bytes, 0)
                    })}\n`,
                    stderr: ""
                  };
                }
                assert.equal(program, "rsync");
                testCase.prepareDestination(destination, transferDir);
                return { exitCode: 0, stdout: "", stderr: "" };
              }
            }
          ),
        testCase.error
      );
    } catch (error) {
      if (testCase.name === "symlink" && error?.code === "EPERM") {
        continue;
      }
      throw error;
    }

    assert.deepEqual(calls.map((call) => call.program), ["ssh", "rsync"]);
    assert.ok(readApproval(approval.approval_id, { approvalDir: transferDir }).used_at);
    assert.throws(() => latestRecord(transferDir, plan.run_id, "execute-"), /expected execute-/);
  }
});

test("transfers.execute does not run download verification when rsync fails", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const runId = "transfer-download-rsync-fails";
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const destination = path.join(runtimeRoot, "transfers", runId, "files");
  const plan = planTransfer(
    {
      run_id: runId,
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: `/shared/homes/\${USER}/experiments/${runId}`,
      destination,
      files: ["metrics.json"],
      max_total_bytes: 1024
    },
    { transferDir, now }
  );
  const approval = approveTransfer(
    plan,
    transferDir,
    quotaSnapshotId,
    {
      direction: plan.direction,
      source: plan.source,
      destination: plan.destination,
      files: plan.files,
      max_total_bytes: plan.max_total_bytes
    },
    now
  );
  const calls = [];

  await assert.rejects(
    () =>
      executeTransfer(
        { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
        {
          transferDir,
          approvalDir: transferDir,
          now,
          executor: async (program, args, timeoutMs, stdin) => {
            calls.push({ program, args, timeoutMs, stdin });
            if (program === "ssh") {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({
                  files: [preflightFile("metrics.json", 32)],
                  total_size_bytes: 32
                })}\n`,
                stderr: ""
              };
            }
            assert.equal(program, "rsync");
            return { exitCode: 23, stdout: "", stderr: "simulated rsync failure" };
          }
        }
      ),
    /transfer rsync failed/
  );
  assert.deepEqual(calls.map((call) => call.program), ["ssh", "rsync"]);
  assert.ok(readApproval(approval.approval_id, { approvalDir: transferDir }).used_at);
  assert.throws(() => latestRecord(transferDir, plan.run_id, "execute-"), /expected execute-/);
});

test("transfers.execute rejects downloaded file checksum mismatches before writing evidence", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const runId = "transfer-download-checksum-mismatch";
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const destination = path.join(runtimeRoot, "transfers", runId, "files");
  const plan = planTransfer(
    {
      run_id: runId,
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: `/shared/homes/\${USER}/experiments/${runId}`,
      destination,
      files: ["metrics.json"],
      max_total_bytes: 1024
    },
    { transferDir, now }
  );
  const approval = approveTransfer(
    plan,
    transferDir,
    quotaSnapshotId,
    {
      direction: plan.direction,
      source: plan.source,
      destination: plan.destination,
      files: plan.files,
      max_total_bytes: plan.max_total_bytes
    },
    now
  );

  await assert.rejects(
    () =>
      executeTransfer(
        { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
        {
          transferDir,
          approvalDir: transferDir,
          now,
          executor: async (program) => {
            if (program === "ssh") {
              return {
                exitCode: 0,
                stdout: `${JSON.stringify({
                  files: [preflightFile("metrics.json", 32)],
                  total_size_bytes: 32
                })}\n`,
                stderr: ""
              };
            }
            assert.equal(program, "rsync");
            fs.mkdirSync(destination, { recursive: true });
            fs.writeFileSync(path.join(destination, "metrics.json"), Buffer.alloc(32, "y"));
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /checksum does not match/
  );
  assert.ok(readApproval(approval.approval_id, { approvalDir: transferDir }).used_at);
  assert.throws(() => latestRecord(transferDir, plan.run_id, "execute-"), /expected execute-/);
});

test("transfers.execute rejects remote preflight metadata that does not match the saved file plan", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const cases = [
    {
      name: "missing",
      payload: { files: [preflightFile("metrics.json", 32)], total_size_bytes: 32 },
      error: /file list does not match/
    },
    {
      name: "extra",
      payload: {
        files: [
          preflightFile("logs/run.out", 1200),
          preflightFile("metrics.json", 32),
          preflightFile("extra.json", 1)
        ],
        total_size_bytes: 1233
      },
      error: /file list does not match/
    },
    {
      name: "duplicate",
      payload: {
        files: [
          preflightFile("logs/run.out", 1200),
          preflightFile("logs/run.out", 1200)
        ],
        total_size_bytes: 2400
      },
      error: /file list does not match/
    },
    {
      name: "wrong-total",
      payload: {
        files: [
          preflightFile("logs/run.out", 1200),
          preflightFile("metrics.json", 32)
        ],
        total_size_bytes: 1200
      },
      error: /total_size_bytes does not match/
    },
    {
      name: "negative-size",
      payload: {
        files: [
          { path: "logs/run.out", size_bytes: -1 },
          preflightFile("metrics.json", 32)
        ],
        total_size_bytes: 31
      },
      error: /invalid file metadata/
    },
    {
      name: "fractional-size",
      payload: {
        files: [
          { path: "logs/run.out", size_bytes: 1200.5 },
          preflightFile("metrics.json", 32)
        ],
        total_size_bytes: 1232.5
      },
      error: /invalid metadata|invalid file metadata/
    },
    {
      name: "invalid-checksum",
      payload: {
        files: [
          preflightFile("logs/run.out", 1200),
          { path: "metrics.json", size_bytes: 32, sha256: "not-a-checksum", checksum_status: "captured" }
        ],
        total_size_bytes: 1232
      },
      error: /invalid checksum/
    },
    {
      name: "missing-checksum-status",
      payload: {
        files: [preflightFile("logs/run.out", 1200), { path: "metrics.json", size_bytes: 32 }],
        total_size_bytes: 1232
      },
      error: /invalid checksum status/
    },
    {
      name: "skipped-small",
      payload: {
        files: [preflightFile("logs/run.out", 1200), { path: "metrics.json", size_bytes: 32, checksum_status: "skipped-large" }],
        total_size_bytes: 1232
      },
      error: /skipped checksum/
    },
    {
      name: "captured-large",
      payload: {
        files: [
          preflightFile("logs/run.out", 1200),
          {
            path: "metrics.json",
            size_bytes: 50_000_001,
            sha256: sha256SizedFile(32),
            checksum_status: "captured"
          }
        ],
        total_size_bytes: 50_001_201
      },
      error: /over checksum limit/
    }
  ];

  for (const testCase of cases) {
    const transferDir = tempRuntimeDir("test-transfers");
    const runId = `transfer-preflight-${testCase.name}`;
    const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
    writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
    const plan = planTransfer(
      {
        run_id: runId,
        profile_id: "uts-hpc-account-a",
        direction: "download",
        source: `/shared/homes/\${USER}/experiments/${runId}`,
        destination: path.join(runtimeRoot, "transfers", runId, "files"),
        files: ["logs/run.out", "metrics.json"],
        max_total_bytes: 4096
      },
      { transferDir, now }
    );
    const approval = approveTransfer(
      plan,
      transferDir,
      quotaSnapshotId,
      {
        direction: plan.direction,
        source: plan.source,
        destination: plan.destination,
        files: plan.files,
        max_total_bytes: plan.max_total_bytes
      },
      now
    );
    const calls = [];

    await assert.rejects(
      () =>
        executeTransfer(
          { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
          {
            transferDir,
            approvalDir: transferDir,
            now,
            executor: async (program, args, timeoutMs, stdin) => {
              calls.push({ program, args, timeoutMs, stdin });
              assert.equal(program, "ssh");
              return {
                exitCode: 0,
                stdout: `${JSON.stringify(testCase.payload)}\n`,
                stderr: ""
              };
            }
          }
        ),
      testCase.error
    );
    assert.equal(calls.length, 1);
    assert.equal(readApproval(approval.approval_id, { approvalDir: transferDir }).used_at, undefined);
  }
});

test("transfers.execute rejects missing approval resource scope before preflight or rsync", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const quotaSnapshotId = "quota-transfer-reject-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const plan = planTransfer(
    {
      run_id: "transfer-reject-scope",
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: "/shared/homes/${USER}/experiments/transfer-reject-scope",
      destination: path.join(runtimeRoot, "transfers", "transfer-reject-scope", "files"),
      files: ["metrics.json"],
      max_total_bytes: 1024
    },
    { transferDir, now }
  );
  const approval = approveTransfer(plan, transferDir, quotaSnapshotId, undefined, now);
  let calls = 0;

  await assert.rejects(
    () =>
      executeTransfer(
        { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
        {
          transferDir,
          approvalDir: transferDir,
          now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /resource_summary/
  );
  assert.equal(calls, 0);
});

test("transfers.execute rejects tampered saved plans before preflight or rsync", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const quotaSnapshotId = "quota-transfer-tamper-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const plan = planTransfer(
    {
      run_id: "transfer-tampered-plan",
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: "/shared/homes/${USER}/experiments/transfer-tampered-plan",
      destination: path.join(runtimeRoot, "transfers", "transfer-tampered-plan", "files"),
      files: ["metrics.json"],
      max_total_bytes: 1024
    },
    { transferDir, now }
  );
  const approval = approveTransfer(
    plan,
    transferDir,
    quotaSnapshotId,
    {
      direction: plan.direction,
      source: plan.source,
      destination: plan.destination,
      files: plan.files,
      max_total_bytes: plan.max_total_bytes
    },
    now
  );
  const saved = JSON.parse(fs.readFileSync(plan.plan_path, "utf8"));
  saved.source = "/shared/homes/${USER}/experiments/different-run";
  fs.writeFileSync(plan.plan_path, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  let calls = 0;

  await assert.rejects(
    () =>
      executeTransfer(
        { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
        {
          transferDir,
          approvalDir: transferDir,
          now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /plan_hash does not match/
  );
  assert.equal(calls, 0);
});

test("transfers.execute approval scope hash changes when file list changes", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const quotaSnapshotId = "quota-transfer-scope-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const common = {
    run_id: "transfer-scope",
    profile_id: "uts-hpc-account-a",
    direction: "download",
    source: "/shared/homes/${USER}/experiments/transfer-scope",
    destination: path.join(runtimeRoot, "transfers", "transfer-scope", "files"),
    max_total_bytes: 1024
  };
  const first = planTransfer({ ...common, files: ["a.txt"] }, { transferDir, now });
  const second = requestApproval(
    {
      runId: first.run_id,
      profileId: first.profile_id,
      platform: first.platform,
      operation: "transfers.execute",
      planHash: first.plan_hash,
      quotaSnapshotId,
      resourceSummary: {
        direction: first.direction,
        source: first.source,
        destination: first.destination,
        files: ["b.txt"],
        max_total_bytes: first.max_total_bytes
      }
    },
    { approvalDir: transferDir, now }
  ).approval;
  const firstApproval = requestApproval(
    {
      runId: first.run_id,
      profileId: first.profile_id,
      platform: first.platform,
      operation: "transfers.execute",
      planHash: first.plan_hash,
      quotaSnapshotId,
      resourceSummary: {
        direction: first.direction,
        source: first.source,
        destination: first.destination,
        files: first.files,
        max_total_bytes: first.max_total_bytes
      }
    },
    { approvalDir: transferDir, now }
  ).approval;

  assert.match(firstApproval.scope_hash, /^[a-f0-9]{64}$/);
  assert.match(second.scope_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(firstApproval.scope_hash, second.scope_hash);
  assert.notEqual(firstApproval.approval_id, second.approval_id);
});

test("transfers.execute redacts the username under a profile-declared non-standard mount", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const configPath = writeProfileConfig("transfer-projmount", [
    {
      profile_id: "uts-hpc-transfer-projmount",
      platform: "uts-hpc",
      account_label: "hpc-proj",
      login: {
        host_alias: "uts-hpc",
        username_ref: "UTS_HPC_PROJECT_USER",
        ssh_agent: true,
        requires_vpn: true
      },
      defaults: {
        queue: "workq",
        workspace: "/projects/labx/${USER}/experiments",
        scratch: "/scratch/${USER}"
      },
      quota_snapshot: null
    }
  ]);
  const quotaSnapshotId = "quota-transfer-projmount-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-transfer-projmount", "uts-hpc", now.toISOString());
  const destination = path.join(runtimeRoot, "transfers", "transfer-projmount", "files");
  const plan = planTransfer(
    {
      run_id: "transfer-projmount",
      profile_id: "uts-hpc-transfer-projmount",
      direction: "download",
      source: "/projects/labx/${USER}/experiments/transfer-projmount",
      destination,
      files: ["metrics.json"],
      max_total_bytes: 4096
    },
    { transferDir, now, configPath }
  );
  const approval = approveTransfer(
    plan,
    transferDir,
    quotaSnapshotId,
    {
      direction: plan.direction,
      source: plan.source,
      destination: plan.destination,
      files: plan.files,
      max_total_bytes: plan.max_total_bytes
    },
    now
  );

  const result = await executeTransfer(
    { runId: plan.run_id, approvalId: approval.approval_id, timeoutMs: 2000 },
    {
      transferDir,
      approvalDir: transferDir,
      configPath,
      now,
      executor: async (program) => {
        if (program === "ssh") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ files: [preflightFile("metrics.json", 32)], total_size_bytes: 32 })}\n`,
            stderr: ""
          };
        }
        writeSizedFile(path.join(destination, "metrics.json"), 32);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  );

  assert.equal(result.transfer.command.args.some((arg) => arg.includes("${USER}")), false);
  const record = latestRecord(transferDir, plan.run_id, "execute-");
  assert.equal(validateTransferExecutionRecord(record).valid, true);
  assert.equal(record.evidence.source.includes("${USER}"), false, "profile-declared mount username must be redacted in evidence");
  assert.match(record.evidence.source, /^\/projects\/labx\/<user>\/experiments\//);
  assert.equal(JSON.stringify(record.evidence).includes("${USER}"), false);
});

test("transfers.execute runs autonomously with no approval (structural safety is the gate)", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const destination = path.join(runtimeRoot, "transfers", "transfer-auto-download", "files");
  const plan = planTransfer(
    {
      run_id: "transfer-auto-download",
      profile_id: "uts-hpc-account-a",
      direction: "download",
      source: "/shared/homes/${USER}/experiments/transfer-auto-download",
      destination,
      files: ["metrics.json"],
      max_total_bytes: 4096
    },
    { transferDir, now }
  );

  const result = await executeTransfer(
    { runId: plan.run_id, timeoutMs: 2000 },
    {
      transferDir,
      now,
      executor: async (program) => {
        if (program === "ssh") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ files: [preflightFile("metrics.json", 32)], total_size_bytes: 32 })}\n`,
            stderr: ""
          };
        }
        writeSizedFile(path.join(destination, "metrics.json"), 32);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  );

  assert.equal(result.transfer.total_size_bytes, 32);
  assert.equal(result.transfer.approval_id, undefined);
  const record = latestRecord(transferDir, plan.run_id, "execute-");
  assert.equal(validateTransferExecutionRecord(record).valid, true);
  assert.equal(Object.prototype.hasOwnProperty.call(record, "approval_id"), false);
});

test("transfers.execute accepts the per-module 10-minute (600000ms) timeout cap and rejects above it", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const transferDir = tempRuntimeDir("test-transfers");
  const quotaSnapshotId = "quota-transfer-timeout-2026-06-15T00-00-00-000Z";
  writeQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString());
  const destination = path.join(runtimeRoot, "transfers", "transfer-timeout-cap", "files");
  fs.rmSync(destination, { recursive: true, force: true });

  function planFor(runId) {
    const plan = planTransfer(
      {
        run_id: runId,
        profile_id: "uts-hpc-account-a",
        direction: "download",
        source: "/shared/homes/${USER}/experiments/transfer-timeout-cap",
        destination,
        files: ["metrics.json"],
        max_total_bytes: 4096
      },
      { transferDir, now }
    );
    const approval = approveTransfer(
      plan,
      transferDir,
      quotaSnapshotId,
      {
        direction: plan.direction,
        source: plan.source,
        destination: plan.destination,
        files: plan.files,
        max_total_bytes: plan.max_total_bytes
      },
      now
    );
    return { plan, approval };
  }

  // 600000ms (transfer's 10-minute cap) must be ACCEPTED and threaded to the executor — this is the
  // load-bearing divergence vs the 30000ms cap every other module uses.
  const accepted = planFor("transfer-timeout-cap-ok");
  const seenTimeouts = [];
  await executeTransfer(
    { runId: accepted.plan.run_id, approvalId: accepted.approval.approval_id, timeoutMs: 600000 },
    {
      transferDir,
      approvalDir: transferDir,
      now,
      executor: async (program, args, timeoutMs, stdin) => {
        seenTimeouts.push(timeoutMs);
        if (program === "ssh") {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ files: [preflightFile("metrics.json", 32)], total_size_bytes: 32 })}\n`,
            stderr: ""
          };
        }
        writeSizedFile(path.join(destination, "metrics.json"), 32);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  );
  assert.ok(seenTimeouts.length > 0);
  assert.ok(
    seenTimeouts.every((value) => value === 600000),
    `expected every executor call to use the 600000ms timeout, saw ${JSON.stringify(seenTimeouts)}`
  );

  // One millisecond over the 10-minute cap must be REJECTED.
  const tooHigh = planFor("transfer-timeout-cap-over");
  await assert.rejects(
    () =>
      executeTransfer(
        { runId: tooHigh.plan.run_id, approvalId: tooHigh.approval.approval_id, timeoutMs: 600001 },
        { transferDir, approvalDir: transferDir, now, executor: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }
      ),
    /timeoutMs must be an integer between 1000 and 600000/
  );
});
