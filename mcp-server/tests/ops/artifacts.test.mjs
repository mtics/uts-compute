import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import {
  executeArtifactCleanup,
  fetchArtifact,
  fetchArtifactsBatch,
  listArtifacts,
  planArtifactCleanup,
  summarizeArtifacts,
  summarizeRemoteArtifact
} from "../../dist/ops/data/artifacts.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import {
  validateArtifactCleanupPlan,
  validateArtifactCleanupExecutionRecord,
  validateArtifactFetchBatchRecord,
  validateArtifactFetchRecord,
  validateArtifactManifest,
  validateArtifactSummary
} from "../../dist/core/validation.js";
import { repoRoot, readExample, tempRuntimeDir, writeProfileConfig, writeQuotaSnapshot } from "../helpers/index.mjs";

async function submittedArtifactRun(runId = "artifact-run") {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const approvalDir = tempRuntimeDir("test-approvals");
  const artifactDir = tempRuntimeDir("test-artifacts");
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.workdir = `/shared/homes/\${USER}/experiments/${runId}`;
  const plan = planJob(job, { planDir, auditDir });
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());
  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      operation: "jobs.submit",
      planHash: plan.plan_hash,
      quotaSnapshotId
    },
    { approvalDir, planDir, now }
  ).approval;
  const approval = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      confirmationToken: "artifact-token"
    },
    { approvalDir, now, confirmationToken: "artifact-token" }
  ).approval;
  // This artifacts fixture deliberately keeps the bundled bare-alias profile and its LITERAL ${USER}
  // workdir — the artifact list/fetch/cleanup redaction assertions below pin the `${USER}` -> `<user>`
  // masking and the bare `uts-hpc` SSH alias. jobs.submit now (correctly) FAILS CLOSED on a literal
  // ${USER} workdir for a LIVE submit, so we cannot drive submit here. The submit path is not under test
  // in this suite (it has its own coverage), so we transition the planned record to "submitted" directly
  // — exactly the state these artifact tests need — rather than exercise the guarded live qsub.
  const recordPath = path.join(auditDir, `${plan.run_id}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.status = "submitted";
  record.remote_job_id = "9876.hpc";
  record.plan_hash = plan.plan_hash;
  record.quota_snapshot_id = quotaSnapshotId;
  record.updated_at = now.toISOString();
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { plan, planDir, auditDir, approvalDir, artifactDir, quotaSnapshotId, now };
}

function approveArtifactFetch(
  fixture,
  now = fixture.now,
  resourceSummary = undefined,
  reason = "Fetch selected metrics artifact",
  operation = "artifacts.fetch"
) {
  const requested = requestApproval(
    {
      runId: fixture.plan.run_id,
      profileId: fixture.plan.profile_id,
      platform: fixture.plan.platform,
      operation,
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      reasons: [reason],
      ...(resourceSummary ? { resourceSummary } : {})
    },
    { approvalDir: fixture.approvalDir, planDir: fixture.planDir, now }
  ).approval;
  return decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      confirmationToken: "artifact-token"
    },
    { approvalDir: fixture.approvalDir, now, confirmationToken: "artifact-token" }
  ).approval;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

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

function markRunStatus(auditDir, runId, status) {
  const filePath = path.join(auditDir, `${runId}.json`);
  const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  record.status = status;
  record.updated_at = "2026-06-15T00:20:00.000Z";
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

test("artifacts.list inspects only saved plan outputs through a fixed Python helper", async () => {
  const fixture = await submittedArtifactRun("artifact-list");
  const result = await listArtifacts(
    { runId: fixture.plan.run_id, maxEntries: 20, checksumMaxBytes: 1024 },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      now: new Date("2026-06-15T00:10:00.000Z"),
      executor: async (program, args, timeoutMs, stdin) => {
        assert.equal(program, "ssh");
        assert.equal(args.at(-4), "uts-hpc");
        assert.equal(args.at(-3), "python3");
        assert.equal(args.at(-2), "-");
        assert.match(stdin, /os\.walk/);
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.equal(spec.max_entries, 20);
        assert.equal(spec.checksum_max_bytes, 1024);
        assert.equal(spec.workdir, "/shared/homes/${USER}/experiments/artifact-list");
        assert.deepEqual(
          spec.outputs.map((entry) => entry.path),
          [
            "/shared/homes/${USER}/experiments/artifact-list/logs",
            "/shared/homes/${USER}/experiments/artifact-list/metrics.json"
          ]
        );
        assert.match(stdin, /os\.path\.realpath/);
        assert.match(stdin, /commonpath/);
        return {
          exitCode: 0,
          stdout:
            '{"artifacts":[{"path":"/shared/homes/${USER}/experiments/artifact-list/metrics.json","relative_path":"metrics.json","kind":"file","size_bytes":17,"sha256":"' +
            sha256(Buffer.from('{"acc":0.9}\\n')) +
            '","checksum_status":"captured","source_output":"/shared/homes/${USER}/experiments/artifact-list/metrics.json"}],"truncated":false}\n',
          stderr: ""
        };
      }
    }
  );

  assert.equal(result.artifacts.artifacts.length, 1);
  assert.match(result.artifacts.artifacts[0].artifact_id, /^artifact-[a-f0-9]{24}$/);
  assert.equal(result.artifacts.artifacts[0].path.includes("${USER}"), false);
  assert.equal(result.artifacts.command.args.includes("uts-hpc"), false);

  const manifestPath = path.join(fixture.artifactDir, fixture.plan.run_id, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(validateArtifactManifest(manifest).valid, true);
  assert.equal(manifest.artifacts[0].remote_path, "/shared/homes/${USER}/experiments/artifact-list/metrics.json");
});

test("artifacts.fetch uses a manifest artifact id, verifies checksum, and consumes approval", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch");
  const payload = Buffer.from('{"loss":1}\n');
  const list = await listArtifacts(
    { runId: fixture.plan.run_id },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      executor: async () => ({
        exitCode: 0,
        stdout:
          '{"artifacts":[{"path":"/shared/homes/${USER}/experiments/artifact-fetch/metrics.json","relative_path":"metrics.json","kind":"file","size_bytes":' +
          payload.length +
          ',"sha256":"' +
          sha256(payload) +
          '","checksum_status":"captured","source_output":"/shared/homes/${USER}/experiments/artifact-fetch/metrics.json"}],"truncated":false}\n',
        stderr: ""
      })
    }
  );
  const approval = approveArtifactFetch(fixture);
  const artifactId = list.artifacts.artifacts[0].artifact_id;

  const result = await fetchArtifact(
    { runId: fixture.plan.run_id, artifactId, approvalId: approval.approval_id, maxBytes: 1024 },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      artifactDir: fixture.artifactDir,
      now: new Date("2026-06-15T00:14:00.000Z"),
      executor: async (program, args, timeoutMs, stdin) => {
        assert.equal(program, "ssh");
        assert.match(stdin, /hashlib\.sha256/);
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.deepEqual(spec, {
          workdir: "/shared/homes/${USER}/experiments/artifact-fetch",
          path: "/shared/homes/${USER}/experiments/artifact-fetch/metrics.json",
          allowed_root: "/shared/homes/${USER}/experiments/artifact-fetch/metrics.json",
          max_bytes: 1024
        });
        assert.match(stdin, /allowed_root/);
        assert.match(stdin, /realpath/);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            content_b64: payload.toString("base64"),
            size_bytes: payload.length,
            sha256: sha256(payload)
          })}\n`,
          stderr: ""
        };
      }
    }
  );

  assert.equal(fs.readFileSync(result.fetch.local_path, "utf8"), '{"loss":1}\n');
  assert.equal(result.fetch.sha256, sha256(payload));
  assert.equal(result.fetch.artifact_id, artifactId);
  assert.equal(result.fetch.artifact_path.includes("${USER}"), false);
  const fetchRecord = latestRecord(fixture.artifactDir, fixture.plan.run_id, "fetch-");
  assert.equal(validateArtifactFetchRecord(fetchRecord).valid, true);
  assert.equal(fetchRecord.artifact_id, artifactId);
  assert.equal(fetchRecord.approval_id, approval.approval_id);
  assert.equal(fetchRecord.profile_id, fixture.plan.profile_id);

  const consumed = readApproval(approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.ok(consumed.used_at);
  assert.equal(consumed.operation, "artifacts.fetch");

  const runRecord = JSON.parse(fs.readFileSync(result.fetch.run_record_path, "utf8"));
  assert.equal(runRecord.events.at(-1).kind, "artifact-fetch");
});

test("artifacts.fetch.batch fetches explicit manifest ids under one total-byte approval", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-batch");
  const metricsPayload = Buffer.from('{"loss":1}\n');
  const logPayload = Buffer.from("epoch=1\n");
  const list = await listArtifacts(
    { runId: fixture.plan.run_id },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      executor: async () => ({
        exitCode: 0,
        stdout:
          '{"artifacts":[' +
          '{"path":"/shared/homes/${USER}/experiments/artifact-fetch-batch/metrics.json","relative_path":"metrics.json","kind":"file","size_bytes":' +
          metricsPayload.length +
          ',"sha256":"' +
          sha256(metricsPayload) +
          '","checksum_status":"captured","source_output":"/shared/homes/${USER}/experiments/artifact-fetch-batch/metrics.json"},' +
          '{"path":"/shared/homes/${USER}/experiments/artifact-fetch-batch/logs/run.out","relative_path":"run.out","kind":"file","size_bytes":' +
          logPayload.length +
          ',"sha256":"' +
          sha256(logPayload) +
          '","checksum_status":"captured","source_output":"/shared/homes/${USER}/experiments/artifact-fetch-batch/logs"}' +
          '],"truncated":false}\n',
        stderr: ""
      })
    }
  );
  const artifactIds = list.artifacts.artifacts.map((artifact) => artifact.artifact_id);
  const approval = approveArtifactFetch(
    fixture,
    fixture.now,
    {
      fetch_mode: "batch",
      artifact_ids: artifactIds,
      artifact_count: artifactIds.length,
      manifest_hash: list.artifacts.manifest_hash,
      max_bytes_per_file: 1024,
      max_total_bytes: 2048
    },
    "Fetch selected metrics and log artifacts",
    "artifacts.fetch.batch"
  );
  const calls = [];

  const result = await fetchArtifactsBatch(
    {
      runId: fixture.plan.run_id,
      manifestHash: list.artifacts.manifest_hash,
      artifactIds,
      approvalId: approval.approval_id,
      maxBytesPerFile: 1024,
      maxTotalBytes: 2048
    },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      artifactDir: fixture.artifactDir,
      now: new Date("2026-06-15T00:14:00.000Z"),
      executor: async (program, args, timeoutMs, stdin) => {
        assert.equal(program, "ssh");
        assert.match(stdin, /artifact fetch spec/);
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        calls.push(spec);
        const payload = spec.path.endsWith("/metrics.json") ? metricsPayload : logPayload;
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            content_b64: payload.toString("base64"),
            size_bytes: payload.length,
            sha256: sha256(payload)
          })}\n`,
          stderr: ""
        };
      }
    }
  );

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/shared/homes/${USER}/experiments/artifact-fetch-batch/metrics.json",
      "/shared/homes/${USER}/experiments/artifact-fetch-batch/logs/run.out"
    ]
  );
  assert.equal(result.fetch_batch.files.length, 2);
  assert.equal(result.fetch_batch.total_size_bytes, metricsPayload.length + logPayload.length);
  assert.equal(fs.readFileSync(result.fetch_batch.files[0].local_path, "utf8"), metricsPayload.toString("utf8"));
  assert.equal(fs.readFileSync(result.fetch_batch.files[1].local_path, "utf8"), logPayload.toString("utf8"));
  assert.equal(result.fetch_batch.files.some((file) => file.artifact_path.includes("${USER}")), false);

  const batchRecord = latestRecord(fixture.artifactDir, fixture.plan.run_id, "fetch-batch-");
  assert.equal(validateArtifactFetchBatchRecord(batchRecord).valid, true);
  assert.deepEqual(batchRecord.evidence.artifact_ids, artifactIds);
  assert.equal(batchRecord.evidence.manifest_hash, list.artifacts.manifest_hash);
  assert.equal(batchRecord.evidence.total_size_bytes, metricsPayload.length + logPayload.length);

  const consumed = readApproval(approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.ok(consumed.used_at);
  assert.equal(consumed.operation, "artifacts.fetch.batch");
  assert.equal(consumed.consumed_by, `artifacts.fetch.batch:2:2048:${list.artifacts.manifest_hash.slice(0, 12)}`);

  const runRecord = JSON.parse(fs.readFileSync(result.fetch_batch.run_record_path, "utf8"));
  assert.equal(runRecord.events.at(-1).kind, "artifact-fetch-batch");
});

test("artifacts.fetch.batch approval scope hash changes when manifest ids or limits change", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-batch-scope");
  const common = {
    fetch_mode: "batch",
    manifest_hash: "a".repeat(64),
    max_bytes_per_file: 1024,
    max_total_bytes: 2048
  };
  const first = requestApproval(
    {
      runId: fixture.plan.run_id,
      profileId: fixture.plan.profile_id,
      platform: fixture.plan.platform,
      operation: "artifacts.fetch.batch",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      resourceSummary: {
        ...common,
        artifact_ids: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"]
      }
    },
    { approvalDir: fixture.approvalDir, planDir: fixture.planDir, now: fixture.now }
  ).approval;
  const second = requestApproval(
    {
      runId: fixture.plan.run_id,
      profileId: fixture.plan.profile_id,
      platform: fixture.plan.platform,
      operation: "artifacts.fetch.batch",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      resourceSummary: {
        ...common,
        artifact_ids: ["artifact-bbbbbbbbbbbbbbbbbbbbbbbb"]
      }
    },
    { approvalDir: fixture.approvalDir, planDir: fixture.planDir, now: fixture.now }
  ).approval;

  assert.match(first.scope_hash, /^[a-f0-9]{64}$/);
  assert.match(second.scope_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.scope_hash, second.scope_hash);
  assert.notEqual(first.approval_id, second.approval_id);
});

test("artifacts.fetch.batch requires approval resource summary to match ids and total bytes", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-batch-approval");
  const manifestDir = path.join(fixture.artifactDir, fixture.plan.run_id);
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        run_id: fixture.plan.run_id,
        profile_id: fixture.plan.profile_id,
        platform: fixture.plan.platform,
        created_at: fixture.now.toISOString(),
        artifacts: [
          {
            artifact_id: "artifact-aaaaaaaaaaaaaaaaaaaaaaaa",
            remote_path: "/shared/homes/${USER}/experiments/artifact-fetch-batch-approval/metrics.json",
            path: "/shared/homes/<user>/experiments/artifact-fetch-batch-approval/metrics.json",
            relative_path: "metrics.json",
            kind: "file",
            size_bytes: 12,
            sha256: "a".repeat(64),
            checksum_status: "captured",
            source_output: "metrics.json"
          }
        ],
        truncated: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const manifestHash = fileSha256(manifestPath);
  const approval = approveArtifactFetch(fixture, fixture.now, undefined, "Fetch selected metrics artifact batch", "artifacts.fetch.batch");
  let calls = 0;

  await assert.rejects(
    () =>
      fetchArtifactsBatch(
        {
          runId: fixture.plan.run_id,
          manifestHash,
          artifactIds: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"],
          approvalId: approval.approval_id,
          maxBytesPerFile: 1024,
          maxTotalBytes: 1024
        },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: new Date("2026-06-15T00:14:00.000Z"),
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

test("artifacts.fetch.batch rejects manifest totals before command execution", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-batch-total");
  const manifestDir = path.join(fixture.artifactDir, fixture.plan.run_id);
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        run_id: fixture.plan.run_id,
        profile_id: fixture.plan.profile_id,
        platform: fixture.plan.platform,
        created_at: fixture.now.toISOString(),
        artifacts: [
          {
            artifact_id: "artifact-aaaaaaaaaaaaaaaaaaaaaaaa",
            remote_path: "/shared/homes/${USER}/experiments/artifact-fetch-batch-total/metrics.json",
            path: "/shared/homes/<user>/experiments/artifact-fetch-batch-total/metrics.json",
            relative_path: "metrics.json",
            kind: "file",
            size_bytes: 1500,
            sha256: "a".repeat(64),
            checksum_status: "captured",
            source_output: "metrics.json"
          },
          {
            artifact_id: "artifact-bbbbbbbbbbbbbbbbbbbbbbbb",
            remote_path: "/shared/homes/${USER}/experiments/artifact-fetch-batch-total/logs/run.out",
            path: "/shared/homes/<user>/experiments/artifact-fetch-batch-total/logs/run.out",
            relative_path: "run.out",
            kind: "file",
            size_bytes: 800,
            sha256: "b".repeat(64),
            checksum_status: "captured",
            source_output: "logs"
          }
        ],
        truncated: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const manifestHash = fileSha256(manifestPath);
  const artifactIds = ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa", "artifact-bbbbbbbbbbbbbbbbbbbbbbbb"];
  const approval = approveArtifactFetch(fixture, fixture.now, {
    fetch_mode: "batch",
    artifact_ids: artifactIds,
    artifact_count: artifactIds.length,
    manifest_hash: manifestHash,
    max_bytes_per_file: 2000,
    max_total_bytes: 2000
  }, "Fetch selected metrics artifact batch", "artifacts.fetch.batch");
  let calls = 0;

  await assert.rejects(
    () =>
      fetchArtifactsBatch(
        {
          runId: fixture.plan.run_id,
          manifestHash,
          artifactIds,
          approvalId: approval.approval_id,
          maxBytesPerFile: 2000,
          maxTotalBytes: 2000
        },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: new Date("2026-06-15T00:14:00.000Z"),
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /maxTotalBytes/
  );
  assert.equal(calls, 0);
});

test("artifacts.fetch rejects a corrupted artifact manifest before command execution", async () => {
  const fixture = await submittedArtifactRun("artifact-corrupt-manifest");
  const manifestDir = path.join(fixture.artifactDir, fixture.plan.run_id);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "manifest.json"),
    `${JSON.stringify(
      {
        run_id: fixture.plan.run_id,
        profile_id: fixture.plan.profile_id,
        platform: fixture.plan.platform,
        created_at: fixture.now.toISOString(),
        artifacts: [
          {
            artifact_id: "artifact-not-valid",
            remote_path: "/shared/homes/${USER}/experiments/artifact-corrupt-manifest/metrics.json",
            path: "/shared/homes/<user>/experiments/artifact-corrupt-manifest/metrics.json",
            relative_path: "metrics.json",
            kind: "file",
            source_output: "metrics.json"
          }
        ],
        truncated: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const approval = approveArtifactFetch(fixture);
  let calls = 0;

  await assert.rejects(
    () =>
      fetchArtifact(
        {
          runId: fixture.plan.run_id,
          artifactId: "artifact-aaaaaaaaaaaaaaaaaaaaaaaa",
          approvalId: approval.approval_id
        },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: new Date("2026-06-15T00:14:00.000Z"),
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /Invalid artifact manifest/
  );
  assert.equal(calls, 0);
});

test("artifacts.fetch rejects wrong approvals and unsafe artifact ids before command execution", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-reject");
  let calls = 0;

  await assert.rejects(
    () =>
      fetchArtifact(
        { runId: fixture.plan.run_id, artifactId: "../metrics", approvalId: "approval-bad" },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /artifact_id|approval_id/
  );
  assert.equal(calls, 0);
});

test("artifacts.list rejects unsafe planned outputs before command execution", async () => {
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const artifactDir = tempRuntimeDir("test-artifacts");
  const job = readExample("hpc-cpu.json");
  job.run_id = "artifact-unsafe-output";
  job.workdir = "/shared/homes/${USER}/experiments/artifact-unsafe-output";
  job.outputs = ["../secret"];
  const plan = planJob(job, { planDir, auditDir });
  let calls = 0;

  await assert.rejects(
    () =>
      listArtifacts(
        { runId: plan.run_id },
        {
          planDir,
          artifactDir,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /Unsafe artifact output path/
  );
  assert.equal(calls, 0);
});

test("artifacts.summarize and artifacts.cleanup.plan operate only on local state", async () => {
  const fixture = await submittedArtifactRun("artifact-summary");
  const filesDir = path.join(fixture.artifactDir, fixture.plan.run_id, "files");
  fs.mkdirSync(filesDir, { recursive: true });
  fs.writeFileSync(
    path.join(filesDir, "metrics.json"),
    `${JSON.stringify(
      {
        accuracy: 0.91,
        api_key: "should-not-appear",
        nested: { loss: 0.12 },
        history: [0.7, 0.8, 0.91],
        long_note: "x".repeat(250)
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(filesDir, "eval-results.json"), '{"f1":0.83,"token":"should-not-appear"}\n', "utf8");
  fs.writeFileSync(path.join(filesDir, "train_metrics.json"), '{"loss":0.42,"epoch":3}\n', "utf8");
  fs.writeFileSync(
    path.join(filesDir, "validation-results.ndjson"),
    ['{"fold":1,"accuracy":0.84}', '{"fold":2,"accuracy":0.86}'].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(filesDir, "fold_0_scores.tsv"), ["metric\tvalue", "f1\t0.81", "auc\t0.89"].join("\n"), "utf8");
  fs.writeFileSync(path.join(filesDir, "wandb-summary.json"), '{"best_accuracy":0.92}\n', "utf8");
  fs.writeFileSync(path.join(filesDir, "config.json"), '{"accuracy":0.01}\n', "utf8");
  fs.writeFileSync(path.join(filesDir, "train.json"), '{"loss":0.99}\n', "utf8");
  fs.writeFileSync(path.join(filesDir, "metrics.log"), '{"accuracy":0.99}\n', "utf8");
  fs.writeFileSync(path.join(filesDir, "results.txt"), "accuracy=0.99\n", "utf8");
  fs.writeFileSync(path.join(filesDir, "checkpoint-metrics.pt"), "not a metric table\n", "utf8");
  fs.writeFileSync(path.join(filesDir, "token-metrics.json"), '{"leak":1}\n', "utf8");
  fs.writeFileSync(path.join(filesDir, "summary-bad.json"), '{"accuracy":', "utf8");
  fs.writeFileSync(
    path.join(filesDir, "scores.jsonl"),
    [
      '{"step":1,"accuracy":0.8,"phase":"eval","token":"hidden"}',
      '{"step":2,"accuracy":0.9,"phase":"eval","token":"hidden"}',
      "not-json"
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(filesDir, "results.csv"),
    ["epoch,loss,comment,api_key", "1,0.5,ok,hidden", "2,0.4,better,hidden"].join("\n"),
    "utf8"
  );
  fs.writeFileSync(path.join(filesDir, "eval-large.json"), `{"blob":"${"x".repeat(1_000_001)}"}`, "utf8");
  const outsideDir = path.join(fixture.artifactDir, fixture.plan.run_id, "outside");
  fs.mkdirSync(outsideDir, { recursive: true });
  const outsideMetrics = path.join(outsideDir, "outside-metrics.json");
  fs.writeFileSync(outsideMetrics, '{"leak":1}\n', "utf8");
  fs.symlinkSync(outsideMetrics, path.join(filesDir, "metrics-link.json"));

  const summary = summarizeArtifacts(
    { runId: fixture.plan.run_id },
    { planDir: fixture.planDir, auditDir: fixture.auditDir, artifactDir: fixture.artifactDir, now: fixture.now }
  ).summary;
  assert.equal(validateArtifactSummary(summary).valid, true);
  assert.equal(summary.metrics["metrics.json"].accuracy, 0.91);
  assert.equal(summary.metrics["metrics.json"].api_key, undefined);
  assert.equal(summary.metrics["metrics.json"].nested.loss, 0.12);
  assert.equal(summary.metrics["metrics.json"].history.count, 3);
  assert.equal(summary.metrics["metrics.json"].long_note, undefined);
  assert.equal(summary.metrics["eval-results.json"].f1, 0.83);
  assert.equal(summary.metrics["eval-results.json"].token, undefined);
  assert.equal(summary.metrics["train_metrics.json"].loss, 0.42);
  assert.equal(summary.metrics["validation-results.ndjson"].format, "jsonl");
  assert.equal(summary.metrics["validation-results.ndjson"].numeric_columns.accuracy.mean, 0.85);
  assert.equal(summary.metrics["fold_0_scores.tsv"].format, "tsv");
  assert.equal(summary.metrics["fold_0_scores.tsv"].numeric_columns.value.max, 0.89);
  assert.equal(summary.metrics["wandb-summary.json"].best_accuracy, 0.92);
  assert.equal(Object.hasOwn(summary.metrics, "config.json"), false);
  assert.equal(Object.hasOwn(summary.metrics, "train.json"), false);
  assert.equal(Object.hasOwn(summary.metrics, "metrics.log"), false);
  assert.equal(Object.hasOwn(summary.metrics, "results.txt"), false);
  assert.equal(Object.hasOwn(summary.metrics, "checkpoint-metrics.pt"), false);
  assert.equal(Object.hasOwn(summary.metrics, "token-metrics.json"), false);
  assert.equal(summary.metrics["summary-bad.json"].parse_error, true);
  assert.equal(summary.metrics["eval-large.json"].skipped, true);
  assert.match(summary.metrics["eval-large.json"].reason, /exceeds/);
  assert.equal(summary.metrics["metrics-link.json"].skipped, true);
  assert.match(summary.metrics["metrics-link.json"].reason, /symbolic links/);
  assert.equal(summary.metrics["scores.jsonl"].format, "jsonl");
  assert.equal(summary.metrics["scores.jsonl"].row_count, 2);
  assert.equal(summary.metrics["scores.jsonl"].parse_errors, 1);
  assert.equal(summary.metrics["scores.jsonl"].numeric_columns.accuracy.mean, 0.85);
  assert.equal(summary.metrics["scores.jsonl"].scalar_columns.phase.last, "eval");
  assert.equal(Object.hasOwn(summary.metrics["scores.jsonl"].scalar_columns, "token"), false);
  assert.equal(summary.metrics["results.csv"].format, "csv");
  assert.equal(summary.metrics["results.csv"].numeric_columns.loss.last, 0.4);
  assert.equal(summary.metrics["results.csv"].scalar_columns.comment.last, "better");
  assert.equal(Object.hasOwn(summary.metrics["results.csv"].scalar_columns, "api_key"), false);
  assert.match(fs.readFileSync(summary.summary_path, "utf8"), /UTS Artifact Summary/);

  const cleanup = planArtifactCleanup(
    { runId: fixture.plan.run_id },
    { planDir: fixture.planDir, artifactDir: fixture.artifactDir, now: fixture.now }
  ).cleanup;
  assert.equal(validateArtifactCleanupPlan(cleanup).valid, true);
  assert.equal(validateArtifactCleanupPlan(JSON.parse(fs.readFileSync(cleanup.cleanup_plan_path, "utf8"))).valid, true);
  assert.ok(cleanup.remote_candidates.some((candidate) => candidate.includes("/shared/homes/<user>/")));
  assert.ok(cleanup.local_candidates.some((candidate) => candidate.endsWith("metrics.json")));
  assert.match(fs.readFileSync(cleanup.cleanup_plan_path, "utf8"), /Dry-run cleanup/);
});

test("artifacts.cleanup.execute deletes explicit manifest files after scoped approval", async () => {
  const fixture = await submittedArtifactRun("artifact-cleanup-execute");
  markRunStatus(fixture.auditDir, fixture.plan.run_id, "finished");
  const listed = await listArtifacts(
    { runId: fixture.plan.run_id, maxEntries: 20, checksumMaxBytes: 1024 },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      now: new Date("2026-06-15T00:10:00.000Z"),
      executor: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          artifacts: [
            {
              path: "/shared/homes/${USER}/experiments/artifact-cleanup-execute/metrics.json",
              relative_path: "metrics.json",
              kind: "file",
              size_bytes: 12,
              sha256: sha256("metric-clean"),
              checksum_status: "captured",
              source_output: "/shared/homes/${USER}/experiments/artifact-cleanup-execute/metrics.json"
            }
          ],
          truncated: false
        })}\n`,
        stderr: ""
      })
    }
  );
  const artifactId = listed.artifacts.artifacts[0].artifact_id;
  const localFile = path.join(fixture.artifactDir, fixture.plan.run_id, "files", "metrics.json");
  fs.mkdirSync(path.dirname(localFile), { recursive: true });
  fs.writeFileSync(localFile, "metric-clean", "utf8");
  const approval = approveArtifactFetch(
    fixture,
    fixture.now,
    {
      manifest_hash: listed.artifacts.manifest_hash,
      artifact_ids: [artifactId],
      delete_mode: "unlink-regular-files-only",
      max_artifacts: 1,
      max_total_bytes: 12
    },
    "Delete one manifest artifact file",
    "artifacts.cleanup.execute"
  );
  const calls = [];

  const result = await executeArtifactCleanup(
    {
      runId: fixture.plan.run_id,
      manifestHash: listed.artifacts.manifest_hash,
      artifactIds: [artifactId],
      approvalId: approval.approval_id
    },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      artifactDir: fixture.artifactDir,
      now: fixture.now,
      executor: async (program, args, timeoutMs, stdin) => {
        calls.push({ program, args, timeoutMs, stdin });
        assert.equal(program, "ssh");
        assert.match(stdin, /os\.unlink/);
        const spec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        assert.equal(spec.workdir, "/shared/homes/${USER}/experiments/artifact-cleanup-execute");
        assert.equal(spec.max_entries, 2000);
        assert.equal(spec.max_total_bytes, 12);
        assert.deepEqual(spec.targets, [
          {
            artifact_id: artifactId,
            path: "/shared/homes/${USER}/experiments/artifact-cleanup-execute/metrics.json",
            allowed_root: "/shared/homes/${USER}/experiments/artifact-cleanup-execute/metrics.json",
            size_bytes: 12,
            sha256: sha256("metric-clean")
          }
        ]);
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            deleted_files: ["/shared/homes/${USER}/experiments/artifact-cleanup-execute/metrics.json"],
            missing: [],
            total_deleted_bytes: 12
          })}\n`,
          stderr: ""
        };
      }
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(fs.existsSync(localFile), false);
  assert.equal(result.cleanup_execute.remote_total_deleted_bytes, 12);
  assert.deepEqual(result.cleanup_execute.artifact_ids, [artifactId]);
  assert.equal(result.cleanup_execute.remote_deleted_files[0], "/shared/homes/<user>/experiments/artifact-cleanup-execute/metrics.json");
  const evidence = latestRecord(fixture.artifactDir, fixture.plan.run_id, "cleanup-execute-");
  assert.equal(validateArtifactCleanupExecutionRecord(evidence).valid, true);
  assert.equal(JSON.stringify(evidence).includes("${USER}"), false);
  assert.equal(JSON.stringify(evidence).includes(repoRoot), false);
  assert.ok(readApproval(approval.approval_id, { approvalDir: fixture.approvalDir }).used_at);
  const runRecord = JSON.parse(fs.readFileSync(path.join(fixture.auditDir, `${fixture.plan.run_id}.json`), "utf8"));
  assert.equal(runRecord.events.at(-1).kind, "artifact-cleanup-execute");
});

test("artifacts.cleanup.execute rejects non-terminal runs before deletion", async () => {
  const fixture = await submittedArtifactRun("artifact-cleanup-running");
  const listed = await listArtifacts(
    { runId: fixture.plan.run_id, maxEntries: 20, checksumMaxBytes: 1024 },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      now: fixture.now,
      executor: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          artifacts: [
            {
              path: "/shared/homes/${USER}/experiments/artifact-cleanup-running/metrics.json",
              relative_path: "metrics.json",
              kind: "file",
              size_bytes: 12,
              sha256: sha256("metric-clean"),
              checksum_status: "captured",
              source_output: "/shared/homes/${USER}/experiments/artifact-cleanup-running/metrics.json"
            }
          ],
          truncated: false
        })}\n`,
        stderr: ""
      })
    }
  );
  const artifactId = listed.artifacts.artifacts[0].artifact_id;
  const approval = approveArtifactFetch(
    fixture,
    fixture.now,
    {
      manifest_hash: listed.artifacts.manifest_hash,
      artifact_ids: [artifactId],
      delete_mode: "unlink-regular-files-only",
      max_artifacts: 1,
      max_total_bytes: 12
    },
    "Delete one manifest artifact file",
    "artifacts.cleanup.execute"
  );
  let calls = 0;

  await assert.rejects(
    () =>
      executeArtifactCleanup(
        {
          runId: fixture.plan.run_id,
          manifestHash: listed.artifacts.manifest_hash,
          artifactIds: [artifactId],
          approvalId: approval.approval_id
        },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /terminal run status/
  );
  assert.equal(calls, 0);
  assert.equal(readApproval(approval.approval_id, { approvalDir: fixture.approvalDir }).used_at, undefined);
});

test("artifacts.cleanup.execute rejects artifacts without captured checksum evidence", async () => {
  const fixture = await submittedArtifactRun("artifact-cleanup-no-checksum");
  markRunStatus(fixture.auditDir, fixture.plan.run_id, "failed");
  const listed = await listArtifacts(
    { runId: fixture.plan.run_id, maxEntries: 20, checksumMaxBytes: 1 },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      now: fixture.now,
      executor: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          artifacts: [
            {
              path: "/shared/homes/${USER}/experiments/artifact-cleanup-no-checksum/metrics.json",
              relative_path: "metrics.json",
              kind: "file",
              size_bytes: 12,
              checksum_status: "skipped-large",
              source_output: "/shared/homes/${USER}/experiments/artifact-cleanup-no-checksum/metrics.json"
            }
          ],
          truncated: false
        })}\n`,
        stderr: ""
      })
    }
  );
  const artifactId = listed.artifacts.artifacts[0].artifact_id;
  const approval = approveArtifactFetch(
    fixture,
    fixture.now,
    {
      manifest_hash: listed.artifacts.manifest_hash,
      artifact_ids: [artifactId],
      delete_mode: "unlink-regular-files-only",
      max_artifacts: 1,
      max_total_bytes: 12
    },
    "Delete one manifest artifact file",
    "artifacts.cleanup.execute"
  );
  let calls = 0;

  await assert.rejects(
    () =>
      executeArtifactCleanup(
        {
          runId: fixture.plan.run_id,
          manifestHash: listed.artifacts.manifest_hash,
          artifactIds: [artifactId],
          approvalId: approval.approval_id
        },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /captured SHA-256/
  );
  assert.equal(calls, 0);
  assert.equal(readApproval(approval.approval_id, { approvalDir: fixture.approvalDir }).used_at, undefined);
});

test("artifacts.fetch consumes the approval before the remote read so a failed fetch cannot reuse it", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-fail-consume");
  const payload = Buffer.from('{"loss":1}\n');
  const list = await listArtifacts(
    { runId: fixture.plan.run_id },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      executor: async () => ({
        exitCode: 0,
        stdout:
          '{"artifacts":[{"path":"/shared/homes/${USER}/experiments/artifact-fetch-fail-consume/metrics.json","relative_path":"metrics.json","kind":"file","size_bytes":' +
          payload.length +
          ',"sha256":"' +
          sha256(payload) +
          '","checksum_status":"captured","source_output":"/shared/homes/${USER}/experiments/artifact-fetch-fail-consume/metrics.json"}],"truncated":false}\n',
        stderr: ""
      })
    }
  );
  const approval = approveArtifactFetch(fixture);
  const artifactId = list.artifacts.artifacts[0].artifact_id;
  let calls = 0;

  await assert.rejects(
    () =>
      fetchArtifact(
        { runId: fixture.plan.run_id, artifactId, approvalId: approval.approval_id, maxBytes: 1024 },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: new Date("2026-06-15T00:14:00.000Z"),
          executor: async () => {
            calls += 1;
            return { exitCode: 1, stdout: "", stderr: "remote fetch boom" };
          }
        }
      ),
    /artifact fetch failed/
  );

  assert.equal(calls, 1);
  const consumed = readApproval(approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.ok(consumed.used_at, "approval must be consumed even when the remote fetch fails");
});

test("artifacts.fetch.batch requires manifest size evidence before consuming the approval", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-batch-no-size");
  const manifestDir = path.join(fixture.artifactDir, fixture.plan.run_id);
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        run_id: fixture.plan.run_id,
        profile_id: fixture.plan.profile_id,
        platform: fixture.plan.platform,
        created_at: fixture.now.toISOString(),
        artifacts: [
          {
            artifact_id: "artifact-aaaaaaaaaaaaaaaaaaaaaaaa",
            remote_path: "/shared/homes/${USER}/experiments/artifact-fetch-batch-no-size/metrics.json",
            path: "/shared/homes/<user>/experiments/artifact-fetch-batch-no-size/metrics.json",
            relative_path: "metrics.json",
            kind: "file",
            sha256: "a".repeat(64),
            checksum_status: "captured",
            source_output: "metrics.json"
          }
        ],
        truncated: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const manifestHash = fileSha256(manifestPath);
  const artifactIds = ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"];
  const approval = approveArtifactFetch(
    fixture,
    fixture.now,
    {
      fetch_mode: "batch",
      artifact_ids: artifactIds,
      artifact_count: artifactIds.length,
      manifest_hash: manifestHash,
      max_bytes_per_file: 1024,
      max_total_bytes: 1024
    },
    "Fetch selected metrics artifact batch",
    "artifacts.fetch.batch"
  );
  let calls = 0;

  await assert.rejects(
    () =>
      fetchArtifactsBatch(
        {
          runId: fixture.plan.run_id,
          manifestHash,
          artifactIds,
          approvalId: approval.approval_id,
          maxBytesPerFile: 1024,
          maxTotalBytes: 1024
        },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: new Date("2026-06-15T00:14:00.000Z"),
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /size evidence/
  );
  assert.equal(calls, 0);
  assert.equal(readApproval(approval.approval_id, { approvalDir: fixture.approvalDir }).used_at, undefined);
});

test("artifacts.cleanup.execute rejects an approval whose max_artifacts is not exactly the request count", async () => {
  const fixture = await submittedArtifactRun("artifact-cleanup-maxartifacts");
  markRunStatus(fixture.auditDir, fixture.plan.run_id, "finished");
  const listed = await listArtifacts(
    { runId: fixture.plan.run_id, maxEntries: 20, checksumMaxBytes: 1024 },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      now: fixture.now,
      executor: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          artifacts: [
            {
              path: "/shared/homes/${USER}/experiments/artifact-cleanup-maxartifacts/metrics.json",
              relative_path: "metrics.json",
              kind: "file",
              size_bytes: 12,
              sha256: sha256("metric-clean"),
              checksum_status: "captured",
              source_output: "/shared/homes/${USER}/experiments/artifact-cleanup-maxartifacts/metrics.json"
            }
          ],
          truncated: false
        })}\n`,
        stderr: ""
      })
    }
  );
  const artifactId = listed.artifacts.artifacts[0].artifact_id;
  const approval = approveArtifactFetch(
    fixture,
    fixture.now,
    {
      manifest_hash: listed.artifacts.manifest_hash,
      artifact_ids: [artifactId],
      delete_mode: "unlink-regular-files-only",
      max_artifacts: 2,
      max_total_bytes: 12
    },
    "Delete one manifest artifact file",
    "artifacts.cleanup.execute"
  );
  let calls = 0;

  await assert.rejects(
    () =>
      executeArtifactCleanup(
        {
          runId: fixture.plan.run_id,
          manifestHash: listed.artifacts.manifest_hash,
          artifactIds: [artifactId],
          approvalId: approval.approval_id
        },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          artifactDir: fixture.artifactDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /max_artifacts/
  );
  assert.equal(calls, 0);
  assert.equal(readApproval(approval.approval_id, { approvalDir: fixture.approvalDir }).used_at, undefined);
});

test("artifacts.list redacts the username under a profile-declared non-standard mount root", async () => {
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const artifactDir = tempRuntimeDir("test-artifacts");
  const configPath = writeProfileConfig("project-mount", [
    {
      profile_id: "uts-hpc-project-mount",
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
  const job = readExample("hpc-cpu.json");
  job.run_id = "artifact-list-project-mount";
  job.profile_id = "uts-hpc-project-mount";
  job.workdir = "/projects/labx/${USER}/experiments/artifact-list-project-mount";
  job.outputs = ["metrics.json"];
  const plan = planJob(job, { planDir, auditDir, configPath });

  const result = await listArtifacts(
    { runId: plan.run_id },
    {
      planDir,
      artifactDir,
      configPath,
      executor: async () => ({
        exitCode: 0,
        stdout:
          '{"artifacts":[{"path":"/projects/labx/${USER}/experiments/artifact-list-project-mount/metrics.json","relative_path":"metrics.json","kind":"file","size_bytes":12,"sha256":"' +
          sha256("metric") +
          '","checksum_status":"captured","source_output":"/projects/labx/${USER}/experiments/artifact-list-project-mount/metrics.json"}],"truncated":false}\n',
        stderr: ""
      })
    }
  );

  const entry = result.artifacts.artifacts[0];
  assert.equal(entry.path.includes("${USER}"), false, "profile-declared mount username must be redacted in the result");
  assert.match(entry.path, /^\/projects\/labx\/<user>\/experiments\//);

  const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, plan.run_id, "manifest.json"), "utf8"));
  assert.equal(manifest.artifacts[0].path.includes("${USER}"), false, "manifest public path must be redacted");
});

test("artifacts.fetch runs autonomously with no approval (manifest binding + checksum are the gate)", async () => {
  const fixture = await submittedArtifactRun("artifact-fetch-auto");
  const payload = Buffer.from('{"loss":1}\n');
  const list = await listArtifacts(
    { runId: fixture.plan.run_id },
    {
      planDir: fixture.planDir,
      artifactDir: fixture.artifactDir,
      executor: async () => ({
        exitCode: 0,
        stdout:
          '{"artifacts":[{"path":"/shared/homes/${USER}/experiments/artifact-fetch-auto/metrics.json","relative_path":"metrics.json","kind":"file","size_bytes":' +
          payload.length +
          ',"sha256":"' +
          sha256(payload) +
          '","checksum_status":"captured","source_output":"/shared/homes/${USER}/experiments/artifact-fetch-auto/metrics.json"}],"truncated":false}\n',
        stderr: ""
      })
    }
  );
  const artifactId = list.artifacts.artifacts[0].artifact_id;

  const result = await fetchArtifact(
    { runId: fixture.plan.run_id, artifactId, maxBytes: 1024 },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      artifactDir: fixture.artifactDir,
      now: new Date("2026-06-15T00:14:00.000Z"),
      executor: async () => ({
        exitCode: 0,
        stdout: `${JSON.stringify({
          content_b64: payload.toString("base64"),
          size_bytes: payload.length,
          sha256: sha256(payload)
        })}\n`,
        stderr: ""
      })
    }
  );

  assert.equal(fs.readFileSync(result.fetch.local_path, "utf8"), '{"loss":1}\n');
  assert.equal(result.fetch.approval_id, undefined);
  const fetchRecord = latestRecord(fixture.artifactDir, fixture.plan.run_id, "fetch-");
  assert.equal(validateArtifactFetchRecord(fetchRecord).valid, true);
  assert.equal(Object.prototype.hasOwnProperty.call(fetchRecord, "approval_id"), false);
});

test("artifacts.summarize remote mode reads a confined remote metric file and matches the local summary", async () => {
  const fixture = await submittedArtifactRun("artifact-summary-remote");
  const payload = Buffer.from(
    `${JSON.stringify({
      accuracy: 0.91,
      api_key: "should-not-appear",
      nested: { loss: 0.12 },
      history: [0.7, 0.8, 0.91],
      long_note: "x".repeat(250)
    })}\n`
  );
  // Same JSON parsed locally must yield identical metrics so we can prove the remote byte source
  // feeds the EXISTING summarize logic.
  const localFixture = await submittedArtifactRun("artifact-summary-remote-local");
  const localFilesDir = path.join(localFixture.artifactDir, localFixture.plan.run_id, "files");
  fs.mkdirSync(localFilesDir, { recursive: true });
  fs.writeFileSync(path.join(localFilesDir, "mainhpo-results.json"), payload);
  const localSummary = summarizeArtifacts(
    { runId: localFixture.plan.run_id },
    {
      planDir: localFixture.planDir,
      auditDir: localFixture.auditDir,
      artifactDir: localFixture.artifactDir,
      now: localFixture.now
    }
  ).summary;

  let observedStdin;
  let observedSpec;
  const result = await summarizeRemoteArtifact(
    {
      runId: fixture.plan.run_id,
      remotePath: "/scratch/${USER}/optuna/mainhpo-results.json"
    },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      artifactDir: fixture.artifactDir,
      now: new Date("2026-06-15T00:20:00.000Z"),
      executor: async (program, args, timeoutMs, stdin) => {
        assert.equal(program, "ssh");
        observedStdin = stdin;
        observedSpec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({
            content_b64: payload.toString("base64"),
            size_bytes: payload.length,
            sha256: sha256(payload)
          })}\n`,
          stderr: ""
        };
      }
    }
  );
  const summary = result.summary;

  // It reuses the bounded remote read seam (the same ARTIFACT_FETCH_PY helper).
  assert.match(observedStdin, /hashlib\.sha256/);
  assert.match(observedStdin, /allowed_root/);
  assert.match(observedStdin, /realpath/);
  // The remote read is pinned to the profile root that contains the path (here /scratch/${USER}).
  assert.equal(observedSpec.path, "/scratch/${USER}/optuna/mainhpo-results.json");
  assert.equal(observedSpec.allowed_root, "/scratch/${USER}");
  assert.equal(observedSpec.workdir, "/scratch/${USER}");
  assert.equal(typeof observedSpec.max_bytes, "number");

  assert.equal(validateArtifactSummary(summary).valid, true);
  assert.equal(summary.mode, "remote");
  // Provenance: the evidence shows a confined remote read, not a checksummed local fetch.
  assert.equal(summary.source, "remote");
  assert.equal(summary.remote_path.includes("${USER}"), false);
  assert.equal(summary.remote_path, "/scratch/<user>/optuna/mainhpo-results.json");
  assert.equal(summary.remote_sha256, sha256(payload));
  assert.equal(summary.remote_size_bytes, payload.length);

  // Same parse/desecret/summarize logic as a local file would produce.
  const remoteMetrics = summary.metrics["mainhpo-results.json"];
  const localMetrics = localSummary.metrics["mainhpo-results.json"];
  assert.deepEqual(remoteMetrics, localMetrics);
  assert.equal(remoteMetrics.accuracy, 0.91);
  assert.equal(remoteMetrics.api_key, undefined);
  assert.equal(remoteMetrics.nested.loss, 0.12);
  assert.equal(remoteMetrics.history.count, 3);
  assert.equal(remoteMetrics.long_note, undefined);

  // The markdown + metrics outputs are written to local state exactly as the local path does.
  assert.match(fs.readFileSync(summary.summary_path, "utf8"), /UTS Artifact Summary/);
  assert.equal(JSON.parse(fs.readFileSync(summary.metrics_path, "utf8"))["mainhpo-results.json"].accuracy, 0.91);
});

test("artifacts.summarize remote mode refuses a remotePath outside the profile roots", async () => {
  const fixture = await submittedArtifactRun("artifact-summary-remote-escape");
  let executorCalled = false;
  await assert.rejects(
    summarizeRemoteArtifact(
      {
        runId: fixture.plan.run_id,
        remotePath: "/etc/passwd-metrics.json"
      },
      {
        planDir: fixture.planDir,
        auditDir: fixture.auditDir,
        artifactDir: fixture.artifactDir,
        now: new Date("2026-06-15T00:20:00.000Z"),
        executor: async () => {
          executorCalled = true;
          return { exitCode: 0, stdout: "{}\n", stderr: "" };
        }
      }
    ),
    /profile (?:workspace|scratch|project|root)/i
  );
  // Confinement is enforced BEFORE any SSH read is attempted.
  assert.equal(executorCalled, false);
});

test("artifacts.summarize remote mode enforces the metric-stem allowlist on the remote filename", async () => {
  const fixture = await submittedArtifactRun("artifact-summary-remote-allowlist");
  let executorCalled = false;
  const options = {
    planDir: fixture.planDir,
    auditDir: fixture.auditDir,
    artifactDir: fixture.artifactDir,
    now: new Date("2026-06-15T00:20:00.000Z"),
    executor: async () => {
      executorCalled = true;
      return { exitCode: 0, stdout: "{}\n", stderr: "" };
    }
  };
  // Non-metric stem (config.json) is rejected by the same allowlist the local path applies.
  await assert.rejects(
    summarizeRemoteArtifact({ runId: fixture.plan.run_id, remotePath: "/scratch/${USER}/optuna/config.json" }, options),
    /metric/i
  );
  // Secret-like filename is skipped/rejected by the same secret filter.
  await assert.rejects(
    summarizeRemoteArtifact({ runId: fixture.plan.run_id, remotePath: "/scratch/${USER}/optuna/token-metrics.json" }, options),
    /metric|secret/i
  );
  // Non-metric extension is rejected too.
  await assert.rejects(
    summarizeRemoteArtifact({ runId: fixture.plan.run_id, remotePath: "/scratch/${USER}/optuna/metrics.log" }, options),
    /metric/i
  );
  assert.equal(executorCalled, false);
});

// M1: the MCP input schema advertised maxBytes up to 50 MB, but the remote read is capped at the
// 1 MB metric-file ceiling. A caller-supplied maxBytes in (1 MB, 50 MB] used to die with a confusing
// "must be an integer between 1 and 1000000" range error AFTER passing Zod. The remote path now CLAMPS
// to the 1 MB ceiling — a clean bounded read — instead of throwing, and the 1 MB read cap is unchanged.
test("artifacts.summarize remote mode clamps a maxBytes just above 1MB to the 1MB ceiling (no range throw)", async () => {
  const fixture = await submittedArtifactRun("artifact-summary-remote-clamp");
  const payload = Buffer.from(`${JSON.stringify({ accuracy: 0.5 })}\n`);
  let observedSpec;
  const result = await summarizeRemoteArtifact(
    { runId: fixture.plan.run_id, remotePath: "/scratch/${USER}/optuna/clamp-results.json", maxBytes: 1_000_001 },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      artifactDir: fixture.artifactDir,
      now: new Date("2026-06-15T00:40:00.000Z"),
      executor: async (program, args) => {
        assert.equal(program, "ssh");
        observedSpec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ content_b64: payload.toString("base64"), size_bytes: payload.length, sha256: sha256(payload) })}\n`,
          stderr: ""
        };
      }
    }
  );
  // Clamped to the 1 MB read cap, not thrown — the enforced ceiling is unchanged.
  assert.equal(observedSpec.max_bytes, 1_000_000);
  assert.equal(result.summary.mode, "remote");
  assert.equal(validateArtifactSummary(result.summary).valid, true);
});

// An ADOPTED foreign campaign has a run RECORD but NO saved plan artifact — and remote-summarize is
// exactly the tool for reading a foreign campaign's head-node metric file. Requiring a verified plan
// broke that case (P1-b intent). The profile/run context is derivable from the run record (the same
// way jobs.status reads adopted runs), so remote-summarize must work with a run record and no plan.
function writeAdoptedRunRecord(auditDir, runId, now) {
  const at = now.toISOString();
  const record = {
    run_id: runId,
    profile_id: "uts-hpc-account-a", // bundled example profile (declares /scratch/${USER} root)
    platform: "uts-hpc",
    remote_job_id: `ihpc-${runId}-4242`,
    rev: 0,
    status: "running",
    created_at: at,
    updated_at: at,
    submission: { account_label: "hpc-a", cluster: "uts-hpc", node: "venus01", requested: {}, submitted_at: at },
    observed: { node: "venus01", pid: 4242 },
    adoption: {
      terminal_record: "external_observed",
      intent: "unverified",
      lineage: "not_lineage_proven",
      discovered_via: "node_observed",
      adopted_at: at
    },
    events: [{ at, kind: "adopted-external", summary: "Adopted external run (history-only)" }]
  };
  fs.writeFileSync(path.join(auditDir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

test("artifacts.summarize remote mode works for an adopted run record with NO plan", async () => {
  const auditDir = tempRuntimeDir("test-runs");
  const artifactDir = tempRuntimeDir("test-artifacts");
  const planDir = tempRuntimeDir("test-plans"); // deliberately EMPTY: no plan artifact for this run
  const now = new Date("2026-06-15T00:30:00.000Z");
  const runId = "AdoptedFedRec_Cards_lr0.001_mainhpo";
  writeAdoptedRunRecord(auditDir, runId, now);

  const payload = Buffer.from(`${JSON.stringify({ accuracy: 0.88, api_key: "should-not-appear", nested: { loss: 0.2 } })}\n`);
  let observedSpec;
  let executorCalled = false;
  const result = await summarizeRemoteArtifact(
    { runId, remotePath: "/scratch/${USER}/optuna/adopted-results.json" },
    {
      planDir,
      auditDir,
      artifactDir,
      now,
      executor: async (program, args, _timeoutMs, _stdin) => {
        executorCalled = true;
        assert.equal(program, "ssh");
        observedSpec = JSON.parse(Buffer.from(args.at(-1), "base64url").toString("utf8"));
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ content_b64: payload.toString("base64"), size_bytes: payload.length, sha256: sha256(payload) })}\n`,
          stderr: ""
        };
      }
    }
  );
  const summary = result.summary;

  // It ran end-to-end with NO plan, deriving profile/run context from the run record.
  assert.equal(executorCalled, true);
  assert.equal(validateArtifactSummary(summary).valid, true);
  assert.equal(summary.mode, "remote");
  assert.equal(summary.run_id, runId);
  assert.equal(summary.profile_id, "uts-hpc-account-a");
  assert.equal(summary.platform, "uts-hpc");
  // ALL safety preserved: profile-root confinement pins the read to /scratch/${USER}, the secret key is
  // dropped, and the redacted provenance masks ${USER}.
  assert.equal(observedSpec.allowed_root, "/scratch/${USER}");
  assert.equal(observedSpec.workdir, "/scratch/${USER}");
  assert.equal(typeof observedSpec.max_bytes, "number");
  assert.equal(summary.remote_path, "/scratch/<user>/optuna/adopted-results.json");
  const metrics = summary.metrics["adopted-results.json"];
  assert.equal(metrics.accuracy, 0.88);
  assert.equal(metrics.api_key, undefined);
  assert.equal(metrics.nested.loss, 0.2);
});

test("artifacts.summarize remote mode still confines an adopted run's remotePath to the profile roots", async () => {
  const auditDir = tempRuntimeDir("test-runs");
  const artifactDir = tempRuntimeDir("test-artifacts");
  const planDir = tempRuntimeDir("test-plans");
  const now = new Date("2026-06-15T00:30:00.000Z");
  const runId = "AdoptedEscape_run";
  writeAdoptedRunRecord(auditDir, runId, now);
  let executorCalled = false;
  await assert.rejects(
    summarizeRemoteArtifact(
      { runId, remotePath: "/etc/passwd-metrics.json" },
      {
        planDir,
        auditDir,
        artifactDir,
        now,
        executor: async () => {
          executorCalled = true;
          return { exitCode: 0, stdout: "{}\n", stderr: "" };
        }
      }
    ),
    /profile (?:workspace|scratch|project|root)/i
  );
  assert.equal(executorCalled, false);
});

// L1: artifact-summary schema symmetry. The remote-provenance fields (source/remote_*) are REQUIRED
// when mode:"remote" — but a mode:"local" record carrying stray remote fields used to validate too
// (the if/then had no else). A local summary must now FORBID those fields, so a record can't claim a
// confined-remote read while declaring mode:"local".
function baseLocalSummary() {
  return {
    mode: "local",
    run_id: "schema-symmetry-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    generated_at: "2026-06-15T00:00:00.000Z",
    summary_path: "/tmp/summary.md",
    metrics_path: "/tmp/metrics.json",
    metrics: {}
  };
}

test("artifact-summary schema: a clean mode:local record validates", () => {
  assert.equal(validateArtifactSummary(baseLocalSummary()).valid, true);
});

test("artifact-summary schema: mode:local forbids stray remote-provenance fields (symmetry)", () => {
  // source:"remote" on a local record.
  assert.equal(validateArtifactSummary({ ...baseLocalSummary(), source: "remote" }).valid, false);
  // any remote_* field on a local record.
  assert.equal(validateArtifactSummary({ ...baseLocalSummary(), remote_path: "/scratch/x.json" }).valid, false);
  assert.equal(
    validateArtifactSummary({ ...baseLocalSummary(), remote_sha256: "a".repeat(64) }).valid,
    false
  );
  assert.equal(validateArtifactSummary({ ...baseLocalSummary(), remote_size_bytes: 10 }).valid, false);
});
