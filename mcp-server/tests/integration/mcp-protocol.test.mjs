import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test, { after } from "node:test";
import { repoRoot, makeWithMcpClient } from "../helpers/index.mjs";

// Isolated runtime root for the harness server + this file's fixtures, so its default-`.uts-computing`
// usage can't contend with parallel test files or live MCP servers. UTS_COMPUTING_HOME relocates the
// server's `.uts-computing`; the fixtures below are written under the same relocated root.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "uts-proto-"));
// The runner interleaves this file's top-level tests over the shared TEST_HOME. A test that snapshots
// the WHOLE runtime tree (to prove an operation has no side effects) therefore needs its OWN isolated
// home, or a sibling test's evidence write races into the window and the snapshot flakes.
const ISOLATED_HOMES = [];
function isolatedHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ISOLATED_HOMES.push(dir);
  return dir;
}
after(() => {
  for (const dir of [TEST_HOME, ...ISOLATED_HOMES]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of the per-run isolated runtime roots
    }
  }
});

// Bind the shared stdio harness to this file's relocated TEST_HOME + client name. The returned
// withMcpClient(fn, env?) supports the per-call env override this file relies on for some tools.
const withMcpClient = makeWithMcpClient({ home: TEST_HOME, clientName: "uts-compute-test" });

function parseTextResult(result) {
  assert.equal(result.isError, false);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

function parseToolError(result) {
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

async function assertRejectsExtraToolArgument(client, name, args, extraField) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} should reject extra argument ${extraField}`);
  assert.equal(result.structuredContent, undefined, `${name} should fail before tool handler structured output is created`);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Input validation error|Invalid arguments|Unrecognized key/);
  assert.match(result.content[0].text, new RegExp(extraField.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

function parseJsonResource(result) {
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].mimeType, "application/json");
  return JSON.parse(result.contents[0].text);
}

function readTextResource(result) {
  assert.equal(result.contents.length, 1);
  assert.equal(typeof result.contents[0].text, "string");
  return result.contents[0].text;
}

function snapshotRuntimeState(home = TEST_HOME) {
  const root = path.join(home, ".uts-computing");
  if (!fs.existsSync(root)) {
    return [];
  }
  const entries = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const fullPath = path.join(dir, name);
      const stat = fs.lstatSync(fullPath);
      const relativePath = path.relative(root, fullPath);
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mtimeMs: stat.mtimeMs });
        walk(fullPath);
      } else if (stat.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          sha256: crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex")
        });
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "symlink", target: fs.readlinkSync(fullPath) });
      } else {
        entries.push({ path: relativePath, type: "other", mtimeMs: stat.mtimeMs });
      }
    }
  }
  walk(root);
  return entries;
}

function writeProtocolResourceFixtures() {
  const quotaDir = path.join(TEST_HOME, ".uts-computing", "quotas");
  const runDir = path.join(TEST_HOME, ".uts-computing", "runs");
  const artifactDir = path.join(TEST_HOME, ".uts-computing", "artifacts", "protocol-artifact-run");
  const transferDir = path.join(TEST_HOME, ".uts-computing", "transfers", "protocol-transfer-run");
  fs.mkdirSync(quotaDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(transferDir, { recursive: true });

  fs.writeFileSync(
    path.join(quotaDir, "quota-protocol-test-2026-06-15T00-00-00-000Z.json"),
    `${JSON.stringify(
      {
        snapshot: {
          snapshot_id: "quota-protocol-test-2026-06-15T00-00-00-000Z",
          profile_id: "uts-hpc-account-a",
          platform: "uts-hpc",
          observed_at: "2026-06-15T00:00:00.000Z",
          source: "quotas.refresh",
          freshness: "fresh",
          summary: {
            identity: {
              username_ref: "UTS_HPC_ACCOUNT_A_USER",
              remote_user_observed: true
            }
          },
          commands: [],
          warnings: []
        },
        command_outputs: [
          {
            id: "identity.whoami",
            status: "passed",
            command: {
              program: "ssh",
              args: ["uts-hpc", "whoami"],
              remote_argv: ["whoami"]
            },
            summary: "identity.whoami completed",
            stdout: "<redacted-remote-user>\\n",
            stderr: ""
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(runDir, "protocol-run-record.json"),
    `${JSON.stringify(
      {
        run_id: "protocol-run-record",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        remote_job_id: null,
        status: "planned",
        created_at: "2026-06-15T00:00:00.000Z",
        updated_at: "2026-06-15T00:00:00.000Z",
        events: [
          {
            at: "2026-06-15T00:00:00.000Z",
            kind: "dry-run-plan",
            summary: "protocol resource fixture",
            redacted_command: "python train.py --token <redacted>"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(artifactDir, "manifest.json"),
    `${JSON.stringify(
      {
        run_id: "protocol-artifact-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        created_at: "2026-06-15T00:00:00.000Z",
        artifacts: [
          {
            artifact_id: "artifact-aaaaaaaaaaaaaaaaaaaaaaaa",
            remote_path: "/shared/homes/${USER}/experiments/protocol-artifact-run/metrics.json",
            path: "/shared/homes/<user>/experiments/protocol-artifact-run/metrics.json",
            relative_path: "metrics.json",
            kind: "file",
            size_bytes: 12,
            sha256: "a".repeat(64),
            checksum_status: "captured",
            source_output: "/shared/homes/${USER}/experiments/protocol-artifact-run/metrics.json",
            local_path: "/Users/example/should-not-leak",
            stdout: "secret stdout",
            content_b64: "c2VjcmV0"
          }
        ],
        truncated: false
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(artifactDir, "cleanup-plan-2026-06-15T00-00-01-000Z.json"),
    `${JSON.stringify(
      {
        mode: "dry-run",
        run_id: "protocol-artifact-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        plan_hash: "b".repeat(64),
        cleanup_plan_hash: "e".repeat(64),
        generated_at: "2026-06-15T00:00:01.000Z",
        remote_candidates: ["/shared/homes/${USER}/experiments/protocol-artifact-run/metrics.json"],
        local_candidates: [
          path.join(artifactDir, "files", "metrics.json"),
          "/Users/example/should-not-leak"
        ],
        cleanup_plan_path: path.join(artifactDir, "cleanup-plan-2026-06-15T00-00-01-000Z.json"),
        warnings: [
          "Dry-run cleanup plan only; no remote or local files were deleted",
          "Cleanup execution requires the latest manifest_hash, explicit artifact_ids, and a separate artifacts.cleanup.execute approval"
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(artifactDir, "cleanup-execute-2026-06-15T00-00-02-000Z.json"),
    `${JSON.stringify(
      {
        run_id: "protocol-artifact-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        approval_id: "approval-protocol-artifact-cleanup",
        kind: "cleanup-execute",
        observed_at: "2026-06-15T00:00:02.000Z",
        evidence: {
          manifest_hash: "f".repeat(64),
          artifact_ids: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"],
          remote_deleted_files: ["/shared/homes/${USER}/experiments/protocol-artifact-run/metrics.json"],
          remote_missing: [],
          remote_total_deleted_bytes: 12,
          local_deleted_files: [
            "<artifact-cache>/files/metrics.json",
            path.join(artifactDir, "files", "metrics.json")
          ],
          command: {
            program: "ssh",
            args: ["-o", "BatchMode=yes", "uts-hpc-account-a", "python3", "-", "raw-base64-spec-should-not-leak"],
            remote_argv: ["python3", "-", "<artifact-spec>"]
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(transferDir, "plan.json"),
    `${JSON.stringify(
      {
        mode: "dry-run",
        run_id: "protocol-transfer-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        direction: "download",
        plan_hash: "b".repeat(64),
        source: "/shared/homes/${USER}/experiments/protocol-transfer-run",
        destination: path.join(TEST_HOME, ".uts-computing", "transfers", "protocol-transfer-run", "files"),
        files: ["logs/run.out", "metrics.json"],
        max_total_bytes: 4096,
        script: `rsync uts-hpc:/shared/homes/\${USER}/experiments/protocol-transfer-run ${path.join(TEST_HOME, ".uts-computing", "transfers", "protocol-transfer-run", "files")}`,
        warnings: ["protocol transfer fixture"],
        plan_path: path.join(transferDir, "plan.json")
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(transferDir, "execute-2026-06-15T00-00-00-000Z.json"),
    `${JSON.stringify(
      {
        run_id: "protocol-transfer-run",
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        approval_id: "approval-protocol-transfer",
        kind: "transfer-execute",
        observed_at: "2026-06-15T00:00:00.000Z",
        evidence: {
          direction: "download",
          // A genuine local /Users/<home> source path: the resource-display redactor must mask the
          // OS username to <local-home> (previously leaked — closed in lib/redact step).
          source: "/Users/protocol-local-user/local-source/protocol-transfer-run",
          destination: path.join(TEST_HOME, ".uts-computing", "transfers", "protocol-transfer-run", "files"),
          files: [
            { path: "logs/run.out", size_bytes: 1200, sha256: "c".repeat(64), checksum_status: "verified" },
            { path: "metrics.json", size_bytes: 32, sha256: "d".repeat(64), checksum_status: "verified" }
          ],
          checksum_policy: { algorithm: "sha256", max_file_bytes: 50000000 },
          total_size_bytes: 1232,
          max_total_bytes: 4096,
          command: {
            program: "rsync",
            args: [
              "--files-from=-",
              "uts-hpc:/shared/homes/${USER}/experiments/protocol-transfer-run/",
              `${path.join(TEST_HOME, ".uts-computing", "transfers", "protocol-transfer-run", "files")}/`
            ]
          }
        }
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function writeProtocolQuotaSnapshot(snapshotId, profileId, platform, observedAt) {
  const quotaDir = path.join(TEST_HOME, ".uts-computing", "quotas");
  fs.mkdirSync(quotaDir, { recursive: true });
  fs.writeFileSync(
    path.join(quotaDir, `${snapshotId}.json`),
    `${JSON.stringify(
      {
        snapshot_id: snapshotId,
        profile_id: profileId,
        platform,
        observed_at: observedAt,
        source: "quotas.refresh",
        freshness: "fresh",
        summary: {
          identity: {
            remote_user_observed: true
          }
        },
        commands: [],
        warnings: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function writeProtocolIhpcRunFixture(runId, { includeSupervisor = true } = {}) {
  const runDir = path.join(TEST_HOME, ".uts-computing", "runs");
  const approvalDir = path.join(TEST_HOME, ".uts-computing", "approvals");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(approvalDir, { recursive: true });
  const planHash = "b".repeat(64);
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  const approvalId = `approval-${runId}-cancel`;
  const supervisor = {
    pid: 2468,
    node_id: "mars001",
    metadata_path: `/data/\${USER}/experiments/${runId}/logs/${runId}.supervisor.json`,
    stdout_path: `/data/\${USER}/experiments/${runId}/logs/${runId}.out`,
    stderr_path: `/data/\${USER}/experiments/${runId}/logs/${runId}.err`,
    started_at: "2026-06-15T00:01:00.000Z"
  };

  fs.writeFileSync(
    path.join(runDir, `${runId}.json`),
    `${JSON.stringify(
      {
        run_id: runId,
        profile_id: "uts-ihpc-account-a",
        platform: "uts-ihpc",
        remote_job_id: `ihpc-${runId}-${supervisor.pid}`,
        plan_hash: planHash,
        quota_snapshot_id: quotaSnapshotId,
        approval: {
          state: "approved",
          approved_at: "2026-06-15T00:00:30.000Z",
          approved_by: "protocol-test",
          bound_plan_hash: planHash,
          bound_quota_snapshot_id: quotaSnapshotId
        },
        ...(includeSupervisor ? { supervisor } : {}),
        status: "running",
        created_at: "2026-06-15T00:00:00.000Z",
        updated_at: "2026-06-15T00:01:00.000Z",
        events: [
          {
            at: "2026-06-15T00:01:00.000Z",
            kind: "ihpc-live-start",
            summary: "protocol iHPC fixture",
            redacted_command: "ssh <profile-host> ssh <ihpc-compute-node> python3 -"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(approvalDir, `${approvalId}.json`),
    `${JSON.stringify(
      {
        approval_id: approvalId,
        run_id: runId,
        profile_id: "uts-ihpc-account-a",
        platform: "uts-ihpc",
        operation: "jobs.cancel",
        state: "approved",
        plan_hash: planHash,
        quota_snapshot_id: quotaSnapshotId,
        reasons: ["Protocol test cancellation approval"],
        requested_at: "2026-06-15T00:00:00.000Z",
        expires_at: "2999-01-01T00:00:00.000Z",
        decided_at: "2026-06-15T00:00:30.000Z",
        decided_by: "protocol-test",
        warnings: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  return { approvalId, planHash, quotaSnapshotId };
}

test("MCP stdio server exposes the implemented tool inventory", async () => {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "access.check",
      "access.confirm_usage",
      "access.doctor",
      "approvals.decide",
      "approvals.list",
      "approvals.request",
      "approvals.status",
      "artifacts.cleanup.execute",
      "artifacts.cleanup.plan",
      "artifacts.fetch",
      "artifacts.fetch.batch",
      "artifacts.list",
      "artifacts.summarize",
      "campaign.audit",
      "campaign.status",
      "campaign.submit",
      "docs.refresh",
      "docs.search",
      "ihpc.campaign.generate",
      "ihpc.campaign.preflight",
      "ihpc.node.usage",
      "jobs.adopt",
      "jobs.cancel",
      "jobs.diagnose",
      "jobs.history",
      "jobs.logs",
      "jobs.plan",
      "jobs.retry.plan",
      "jobs.rightsize",
      "jobs.status",
      "jobs.submit",
      "jobs.track",
      "jobs.usage",
      "profiles.list",
      "profiles.onboard",
      "profiles.validate",
      "projects.list",
      "quotas.capacity",
      "quotas.refresh",
      "state.migrate.apply",
      "state.migrate.plan",
      "sweep.plan",
      "sweep.rank",
      "sweep.retry.plan",
      "templates.list",
      "transfers.execute",
      "transfers.plan"
    ]);

    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.get("jobs.status").inputSchema.required, ["runId"]);
    assert.equal(byName.get("jobs.status").inputSchema.properties.timeoutMs.maximum, 30000);
    assert.equal(byName.get("jobs.status").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("jobs.logs").inputSchema.required, ["runId"]);
    assert.deepEqual(byName.get("jobs.logs").inputSchema.properties.stream.enum, ["stdout", "stderr", "both"]);
    assert.equal(byName.get("jobs.logs").inputSchema.properties.maxBytes.maximum, 200000);
    assert.equal(byName.get("jobs.logs").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("jobs.cancel").inputSchema.required, ["runId", "approvalId"]);
    assert.equal(byName.get("jobs.cancel").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("jobs.retry.plan").inputSchema.required, ["sourceRunId", "retryRunId"]);
    assert.equal(Object.hasOwn(byName.get("jobs.retry.plan").inputSchema.properties ?? {}, "command"), false);
    assert.equal(Object.hasOwn(byName.get("jobs.retry.plan").inputSchema.properties ?? {}, "resources"), false);
    assert.equal(Object.hasOwn(byName.get("jobs.retry.plan").inputSchema.properties ?? {}, "workdir"), false);
    assert.equal(byName.get("jobs.retry.plan").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("artifacts.fetch.batch").inputSchema.required, ["runId", "manifestHash", "artifactIds"]);
    assert.equal(byName.get("artifacts.fetch.batch").inputSchema.properties.manifestHash.type, "string");
    assert.equal(byName.get("artifacts.fetch.batch").inputSchema.properties.artifactIds.maxItems, 100);
    assert.equal(byName.get("artifacts.fetch.batch").inputSchema.properties.maxTotalBytes.maximum, 50000000);
    assert.equal(byName.get("artifacts.fetch.batch").outputSchema.properties.ok.type, "boolean");
    // M1: artifacts.summarize advertises the 1 MB metric ceiling its remote read enforces, NOT the
    // 50 MB artifact-byte ceiling — the advertised range must equal the enforced one.
    assert.equal(byName.get("artifacts.summarize").inputSchema.properties.maxBytes.maximum, 1000000);
    assert.deepEqual(byName.get("artifacts.cleanup.execute").inputSchema.required, [
      "runId",
      "manifestHash",
      "artifactIds",
      "approvalId"
    ]);
    assert.equal(byName.get("artifacts.cleanup.execute").inputSchema.properties.artifactIds.maxItems, 100);
    assert.equal(byName.get("artifacts.cleanup.execute").inputSchema.properties.timeoutMs.maximum, 30000);
    for (const forbidden of ["path", "paths", "remotePath", "localPath", "host", "sshOptions", "command", "glob", "force", "rmArgs"]) {
      assert.equal(Object.hasOwn(byName.get("artifacts.cleanup.execute").inputSchema.properties ?? {}, forbidden), false);
    }
    assert.equal(byName.get("artifacts.cleanup.execute").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("transfers.execute").inputSchema.required, ["runId"]);
    assert.equal(byName.get("transfers.execute").inputSchema.properties.timeoutMs.maximum, 600000);
    assert.equal(byName.get("transfers.execute").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("docs.search").inputSchema.required, ["query"]);
    assert.equal(byName.get("docs.search").inputSchema.properties.query.maxLength, 200);
    assert.equal(byName.get("docs.search").inputSchema.properties.maxResults.maximum, 20);
    assert.equal(byName.get("docs.search").inputSchema.properties.maxSnippetChars.maximum, 500);
    assert.equal(Object.hasOwn(byName.get("docs.search").inputSchema.properties ?? {}, "path"), false);
    assert.equal(Object.hasOwn(byName.get("docs.search").inputSchema.properties ?? {}, "url"), false);
    assert.equal(Object.hasOwn(byName.get("docs.search").inputSchema.properties ?? {}, "host"), false);
    assert.equal(Object.hasOwn(byName.get("docs.search").inputSchema.properties ?? {}, "live"), false);
    assert.equal(Object.hasOwn(byName.get("docs.search").inputSchema.properties ?? {}, "timeoutMs"), false);
    assert.equal(byName.get("docs.search").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("docs.refresh").inputSchema.required ?? [], []);
    assert.equal(byName.get("docs.refresh").inputSchema.properties.sourceIds.maxItems, 10);
    assert.equal(byName.get("docs.refresh").inputSchema.properties.maxBytes.maximum, 2000000);
    assert.equal(byName.get("docs.refresh").inputSchema.properties.timeoutMs.maximum, 30000);
    assert.equal(Object.hasOwn(byName.get("docs.refresh").inputSchema.properties ?? {}, "path"), false);
    assert.equal(Object.hasOwn(byName.get("docs.refresh").inputSchema.properties ?? {}, "url"), false);
    assert.equal(Object.hasOwn(byName.get("docs.refresh").inputSchema.properties ?? {}, "host"), false);
    assert.equal(Object.hasOwn(byName.get("docs.refresh").inputSchema.properties ?? {}, "headers"), false);
    assert.equal(Object.hasOwn(byName.get("docs.refresh").inputSchema.properties ?? {}, "profileId"), false);
    assert.equal(Object.hasOwn(byName.get("docs.refresh").inputSchema.properties ?? {}, "proxy"), false);
    assert.equal(Object.hasOwn(byName.get("docs.refresh").inputSchema.properties ?? {}, "live"), false);
    assert.equal(byName.get("docs.refresh").outputSchema.properties.ok.type, "boolean");
    assert.equal(Object.hasOwn(byName.get("state.migrate.plan").inputSchema.properties ?? {}, "write"), false);
    assert.equal(Object.hasOwn(byName.get("state.migrate.plan").inputSchema.properties ?? {}, "apply"), false);
    assert.equal(byName.get("state.migrate.plan").outputSchema.properties.ok.type, "boolean");
    assert.deepEqual(byName.get("state.migrate.apply").inputSchema.required, ["planHash", "confirmationToken"]);
    assert.equal(Object.hasOwn(byName.get("state.migrate.apply").inputSchema.properties ?? {}, "runtimeRoot"), false);
    assert.equal(Object.hasOwn(byName.get("state.migrate.apply").inputSchema.properties ?? {}, "files"), false);
    assert.equal(Object.hasOwn(byName.get("state.migrate.apply").inputSchema.properties ?? {}, "path"), false);
    assert.equal(byName.get("state.migrate.apply").outputSchema.properties.ok.type, "boolean");
  });
});

const EXPECTED_TOOL_ANNOTATIONS = {
  // local read-only (no remote contact)
  "profiles.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "profiles.validate": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "profiles.onboard": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "templates.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "docs.search": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "jobs.plan": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "jobs.retry.plan": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "jobs.history": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "jobs.rightsize": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "projects.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "campaign.status": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "campaign.audit": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "jobs.diagnose": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "transfers.plan": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "artifacts.cleanup.plan": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "state.migrate.plan": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "sweep.plan": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "sweep.rank": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  // ihpc.campaign.generate is a pure-local, deterministic, dry-run queue-YAML generator (no SSH, no GPU
  // probing) — the GENERATE counterpart to ihpc.campaign.preflight, same class as jobs.plan / sweep.plan.
  "ihpc.campaign.generate": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "sweep.retry.plan": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "approvals.status": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  "approvals.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  // read-only but contacts UTS systems
  "access.check": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  // ihpc.campaign.preflight is read-only and pure-local by DEFAULT, but its OPT-IN node canary
  // (profileId+node) SSHes to a compute node to probe GPU/CUDA — so openWorldHint:true (it CAN contact
  // an external host), while readOnlyHint stays true (a pure probe, no mutation).
  "ihpc.campaign.preflight": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  // ihpc.node.usage is a read-only one-shot per-GPU utilization probe that ALWAYS SSHes to the named
  // node (the same canary two-hop seam) — openWorldHint:true (contacts an external host), readOnlyHint
  // true (a pure nvidia-smi read, never a mutation).
  "ihpc.node.usage": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  // artifacts.summarize is read-only and pure-local by DEFAULT (source="local" reads only fetched
  // files), but its OPT-IN remote mode (source="remote" + remotePath) reads ONE confined metric file
  // over the bounded read-only SSH seam — so openWorldHint:true (it CAN contact an external host),
  // while readOnlyHint stays true (a pure bounded read, no mutation, no arbitrary remote command).
  "artifacts.summarize": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "access.doctor": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "docs.refresh": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "quotas.capacity": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "quotas.refresh": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "jobs.status": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "jobs.track": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "jobs.logs": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "jobs.usage": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  "artifacts.list": { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  // effectful but non-destructive
  "access.confirm_usage": { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  "jobs.adopt": { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  "jobs.submit": { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  "campaign.submit": { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  "approvals.request": { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  "approvals.decide": { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  "artifacts.fetch": { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  "artifacts.fetch.batch": { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  // destructive: terminates jobs, deletes files, overwrites transfer targets, or rewrites local state
  "jobs.cancel": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "transfers.execute": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "artifacts.cleanup.execute": { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  "state.migrate.apply": { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
};

test("MCP tools carry safety annotations and human-readable titles", async () => {
  await withMcpClient(async (client) => {
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));

    for (const [name, expected] of Object.entries(EXPECTED_TOOL_ANNOTATIONS)) {
      const tool = byName.get(name);
      assert.ok(tool, `tool ${name} is missing`);
      const title = tool.title ?? tool.annotations?.title;
      assert.ok(typeof title === "string" && title.length > 0, `${name} needs a human-readable title`);
      const annotations = tool.annotations ?? {};
      assert.equal(annotations.readOnlyHint, expected.readOnlyHint, `${name} readOnlyHint`);
      assert.equal(annotations.destructiveHint, expected.destructiveHint, `${name} destructiveHint`);
      assert.equal(annotations.openWorldHint, expected.openWorldHint, `${name} openWorldHint`);
    }

    // every implemented tool must be classified in the table above
    for (const tool of tools.tools) {
      assert.ok(Object.hasOwn(EXPECTED_TOOL_ANNOTATIONS, tool.name), `tool ${tool.name} has no annotation classification`);
    }
  });
});

test("prompt arguments complete profile and run ids", async () => {
  await withMcpClient(
    async (client) => {
      const allProfiles = await client.complete({
        ref: { type: "ref/prompt", name: "plan-experiment" },
        argument: { name: "profileId", value: "" }
      });
      assert.deepEqual([...allProfiles.completion.values].sort(), [
        "uts-hpc-account-a",
        "uts-hpc-account-b",
        "uts-ihpc-account-a",
        "uts-ihpc-account-b"
      ]);

      const ihpcOnly = await client.complete({
        ref: { type: "ref/prompt", name: "stage-transfer" },
        argument: { name: "profileId", value: "uts-ihpc" }
      });
      assert.deepEqual([...ihpcOnly.completion.values].sort(), ["uts-ihpc-account-a", "uts-ihpc-account-b"]);

      // runId completion is wired (returns an array even when no run records exist)
      const runs = await client.complete({
        ref: { type: "ref/prompt", name: "triage-run" },
        argument: { name: "runId", value: "" }
      });
      assert.ok(Array.isArray(runs.completion.values));
    },
    { UTS_COMPUTING_CONFIG: "profiles/profiles.example.yaml" }
  );
});

test("access.check returns its populated result through the tool handler (await, not a dropped promise)", async () => {
  await withMcpClient(
    async (client) => {
      // checks:[] skips every network probe, so the result is deterministic and offline, while
      // still exercising the async handler path that previously dropped the unawaited promise.
      const result = parseTextResult(
        await client.callTool({ name: "access.check", arguments: { profileId: "uts-hpc-account-a", checks: [] } })
      );
      assert.equal(result.ok, true);
      assert.equal(result.access.profile_id, "uts-hpc-account-a");
      assert.equal(result.access.overall_status, "partial");
      assert.ok(Array.isArray(result.access.checks) && result.access.checks.length > 0);
    },
    { UTS_COMPUTING_CONFIG: "profiles/profiles.example.yaml" }
  );
});

test("access.doctor exportSsh emits a secret-free ssh-config snippet through the tool handler", async () => {
  await withMcpClient(
    async (client) => {
      const result = parseTextResult(
        await client.callTool({ name: "access.doctor", arguments: { profileId: "uts-hpc-account-a", exportSsh: true } })
      );
      assert.equal(result.ok, true);
      assert.equal(result.access.mode, "export-ssh");
      assert.equal(result.access.profile_id, "uts-hpc-account-a");
      assert.equal(typeof result.access.login_host, "string");
      assert.match(result.access.ssh_config_snippet, /^Host /m);
      assert.match(result.access.ssh_config_snippet, /User \$\{UTS_HPC_ACCOUNT_A_USER\}/);
      assert.ok(
        Array.isArray(result.access.required_env_names) && result.access.required_env_names.length > 0,
        "required_env_names must be a non-empty array of NAMES"
      );
      // Secret-free: the serialized envelope carries env-var NAMES + host only, never any env value.
      const serialized = JSON.stringify(result);
      for (const name of result.access.required_env_names) {
        assert.match(name, /^[A-Z0-9_]+$/, `env name ${name} must be a NAME, not a value`);
        assert.equal(name in process.env, false, "test env must not define the credential vars");
      }
      assert.equal(/password|secret|private[_-]?key|-----BEGIN/i.test(serialized), false, "must not leak any secret value");

      // exportSsh without a profileId is rejected (a single profileId is required for the export path).
      const err = parseToolError(
        await client.callTool({ name: "access.doctor", arguments: { exportSsh: true } })
      );
      assert.equal(err.ok, false);
      assert.match(err.error, /single profileId/i);
    },
    { UTS_COMPUTING_CONFIG: "profiles/profiles.example.yaml" }
  );
});

test("jobs.history and sweep.plan return populated results through the tool handler", async () => {
  await withMcpClient(
    async (client) => {
      const history = parseTextResult(await client.callTool({ name: "jobs.history", arguments: { limit: 5 } }));
      assert.equal(history.ok, true);
      assert.ok(Array.isArray(history.runs));
      assert.equal(typeof history.total, "number");

      const baseJob = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs", "hpc-cpu.json"), "utf8"));
      const sweep = parseTextResult(
        await client.callTool({
          name: "sweep.plan",
          arguments: { jobSpec: { ...baseJob, command: "python train.py --lr {lr}" }, parameters: { lr: [0.1, 0.01] }, campaignId: "camp-proto" }
        })
      );
      assert.equal(sweep.ok, true);
      assert.equal(sweep.sweep.size, 2);
      assert.equal(sweep.plan.template, "pbs-array");
    },
    { UTS_COMPUTING_CONFIG: "profiles/profiles.example.yaml" }
  );
});

test("MCP stdio server exposes guided workflow prompts without live side effects", async () => {
  // Snapshotting the whole runtime tree to prove getPrompt has no side effects only works in isolation:
  // give this test its own home so the other interleaved tests' evidence writes can't enter the window.
  const promptHome = isolatedHome("uts-proto-prompt-");
  await withMcpClient(async (client) => {
    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((prompt) => prompt.name).sort();

    assert.deepEqual(names, [
      "client-smoke-evidence",
      "collect-artifacts",
      "plan-experiment",
      "stage-transfer",
      "triage-run"
    ]);

    const byName = new Map(prompts.prompts.map((prompt) => [prompt.name, prompt]));
    assert.equal(byName.get("plan-experiment").description.includes("experiment plan"), true);
    assert.ok(byName.get("plan-experiment").arguments.some((argument) => argument.name === "platform"));
    assert.ok(byName.get("triage-run").arguments.some((argument) => argument.name === "runId" && argument.required === true));
    assert.ok(byName.get("stage-transfer").arguments.some((argument) => argument.name === "direction"));
    assert.ok(byName.get("client-smoke-evidence").arguments.some((argument) => argument.name === "client"));

    const beforePromptState = snapshotRuntimeState(promptHome);

    const planPrompt = await client.getPrompt({
      name: "plan-experiment",
      arguments: {
        goal: "train a small CPU baseline",
        platform: "uts-hpc",
        profileId: "uts-hpc-account-a",
        intent: "dry-run"
      }
    });
    assert.equal(planPrompt.messages.length, 1);
    assert.equal(planPrompt.messages[0].role, "user");
    assert.equal(planPrompt.messages[0].content.type, "text");
    assert.match(planPrompt.messages[0].content.text, /profiles\.list/);
    assert.match(planPrompt.messages[0].content.text, /jobs\.plan/);
    assert.match(planPrompt.messages[0].content.text, /never self-approve/i);
    assert.match(planPrompt.messages[0].content.text, /Do not use direct shell/);
    assert.doesNotMatch(planPrompt.messages[0].content.text, /UTS_COMPUTING_APPROVAL_TOKEN/);
    assert.doesNotMatch(planPrompt.messages[0].content.text, /profiles\.local\.yaml/);

    const triagePrompt = await client.getPrompt({
      name: "triage-run",
      arguments: {
        runId: "run-123",
        symptom: "stalled in queue",
        desiredOutcome: "retry-review"
      }
    });
    assert.match(triagePrompt.messages[0].content.text, /monitor-and-recover/);
    assert.match(triagePrompt.messages[0].content.text, /operation-specific approval/);
    assert.match(triagePrompt.messages[0].content.text, /jobs\.retry\.plan/);

    const artifactPrompt = await client.getPrompt({
      name: "collect-artifacts",
      arguments: {
        runId: "run-123",
        purpose: "inspect-outputs"
      }
    });
    assert.match(artifactPrompt.messages[0].content.text, /analyze-artifacts/);
    assert.match(artifactPrompt.messages[0].content.text, /artifacts\.list/);
    assert.match(artifactPrompt.messages[0].content.text, /approval/);

    const smokePrompt = await client.getPrompt({
      name: "client-smoke-evidence",
      arguments: {
        client: "codex"
      }
    });
    assert.match(smokePrompt.messages[0].content.text, /installed plugin/);
    assert.match(smokePrompt.messages[0].content.text, /client-smoke:validate/);
    assert.match(smokePrompt.messages[0].content.text, /Do not call access\.check/);

    const transferPrompt = await client.getPrompt({
      name: "stage-transfer",
      arguments: {
        profileId: "uts-hpc-account-a",
        direction: "download-from-uts",
        purpose: "download explicit metric files"
      }
    });
    assert.match(transferPrompt.messages[0].content.text, /transfers\.plan/);
    assert.match(transferPrompt.messages[0].content.text, /transfers\.execute/);
    assert.match(transferPrompt.messages[0].content.text, /max_total_bytes/);
    assert.match(transferPrompt.messages[0].content.text, /Do not generate rsync flags/);

    const redactedPrompt = await client.getPrompt({
      name: "plan-experiment",
      arguments: {
        goal: "token=abc123 in /Users/example/private",
        profileId: "profiles/profiles.local.yaml"
      }
    });
    assert.match(redactedPrompt.messages[0].content.text, /<redacted-prompt-input>/);
    assert.doesNotMatch(redactedPrompt.messages[0].content.text, /abc123|\/Users\/example|profiles\.local\.yaml/);

    assert.deepEqual(snapshotRuntimeState(promptHome), beforePromptState);
  }, { UTS_COMPUTING_HOME: promptHome });
});

test("MCP stdio server searches only allowlisted local documentation", async () => {
  await withMcpClient(async (client) => {
    const payload = parseTextResult(
      await client.callTool({
        name: "docs.search",
        arguments: {
          query: "Read-Only Live Platform Queries",
          docIds: ["implementation-plan"],
          maxResults: 3,
          maxSnippetChars: 160
        }
      })
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.search.mode, "read-only");
    assert.equal(payload.search.source, "local-allowlisted-docs");
    assert.deepEqual(payload.search.docs_searched, ["implementation-plan"]);
    assert.equal(payload.search.matches.length <= 3, true);
    assert.equal(payload.search.matches[0].doc_id, "implementation-plan");
    assert.equal(payload.search.matches[0].uri, "uts://docs/implementation-plan");
    assert.match(payload.search.matches[0].snippet, /Read-Only Live Platform Queries/);
    assert.equal(JSON.stringify(payload).includes("/Users/"), false);
    assert.equal(JSON.stringify(payload).includes(".uts-computing"), false);
    assert.equal(JSON.stringify(payload).includes("mcp-server/dist"), false);

    const limited = parseTextResult(
      await client.callTool({
        name: "docs.search",
        arguments: {
          query: "approval",
          maxResults: 1
        }
      })
    );
    assert.equal(limited.search.matches.length, 1);
    assert.equal(typeof limited.search.truncated, "boolean");

    const rejected = parseToolError(
      await client.callTool({
        name: "docs.search",
        arguments: {
          query: "approval",
          docIds: ["../bad"]
        }
      })
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Unknown documentation id/);

    const tooLarge = await client.callTool({
      name: "docs.search",
      arguments: {
        query: "approval",
        maxResults: 21
      }
    });
    assert.equal(tooLarge.isError, true);
    assert.match(tooLarge.content[0].text, /maxResults|Invalid/);
  });
});

test("MCP stdio server refreshes fixed-source docs cache through the protocol layer", async () => {
  await withMcpClient(
    async (client) => {
      const payload = parseTextResult(
        await client.callTool({
          name: "docs.refresh",
          arguments: {
            sourceIds: ["uts-hpc-pbs"],
            maxBytes: 10000,
            timeoutMs: 1500
          }
        })
      );

      assert.equal(payload.ok, true);
      assert.equal(payload.refresh.mode, "read-only");
      assert.equal(payload.refresh.source, "fixed-official-uts-docs");
      assert.deepEqual(payload.refresh.sources_requested, ["uts-hpc-pbs"]);
      assert.equal(payload.refresh.sources[0].source_id, "uts-hpc-pbs");
      assert.equal(payload.refresh.sources[0].status, "refreshed");
      assert.equal(payload.refresh.sources[0].cache_uri, "uts://docs-cache/uts-hpc-pbs");
      assert.match(payload.refresh.sources[0].content_hash, /^[a-f0-9]{64}$/);
      assert.match(payload.refresh.sources[0].snippet, /PBS queues/);
      assert.equal(JSON.stringify(payload).includes("/Users/"), false);
      assert.equal(JSON.stringify(payload).includes(".uts-computing"), false);

      const index = parseJsonResource(await client.readResource({ uri: "uts://docs-cache" }));
      assert.ok(index.sources.some((entry) => entry.id === "uts-hpc-pbs"));
      assert.ok(index.cached.some((entry) => entry.source_id === "uts-hpc-pbs"));

      const cachedDoc = readTextResource(await client.readResource({ uri: "uts://docs-cache/uts-hpc-pbs" }));
      assert.match(cachedDoc, /Mock UTS Documentation/);
      assert.match(cachedDoc, /PBS queues and iHPC node limits/);
      assert.doesNotMatch(cachedDoc, /secret\(\)|<script>/);
      assert.equal(cachedDoc.includes("/Users/"), false);

      const rejected = parseToolError(
        await client.callTool({
          name: "docs.refresh",
          arguments: {
            sourceIds: ["https://example.com/bad"]
          }
        })
      );
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /Unknown documentation source id/);
    },
    {
      UTS_COMPUTING_TEST_MODE: "1",
      UTS_COMPUTING_TEST_DOCS: "mock"
    }
  );
});

test("MCP stdio server handles profile validation through the protocol layer", async () => {
  await withMcpClient(async (client) => {
    const result = await client.callTool({
      name: "profiles.validate",
      arguments: {
        profileId: "uts-hpc-account-a"
      }
    });
    const payload = parseTextResult(result);

    assert.equal(payload.ok, true);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].profile_id, "uts-hpc-account-a");
    assert.equal(payload.results[0].valid, true);
  });
});

test("MCP stdio server returns a read-only state migration dry-run plan", async () => {
  await withMcpClient(async (client) => {
    const payload = parseTextResult(
      await client.callTool({
        name: "state.migrate.plan",
        arguments: {}
      })
    );

    assert.equal(payload.ok, true);
    assert.equal(payload.migration.mode, "dry-run");
    assert.equal(payload.migration.target_schema_version, "0.1.0");
    assert.match(payload.migration.plan_hash, /^[a-f0-9]{64}$/);
    assert.equal(payload.migration.writes_planned, false);
    assert.equal(payload.migration.approval_state_would_change, false);
    assert.equal(payload.migration.run_state_would_change, false);
    assert.ok(Array.isArray(payload.migration.files_read));
    assert.ok(Array.isArray(payload.migration.files_would_write));
  });
});

test("MCP stdio server rejects state migration apply without trusted confirmation", async () => {
  await withMcpClient(async (client) => {
    const rejected = parseToolError(
      await client.callTool({
        name: "state.migrate.apply",
        arguments: {
          planHash: "0".repeat(64),
          confirmationToken: "wrong"
        }
      })
    );

    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /confirmation token|planHash/);
  });
});

test("MCP stdio server creates a local retry plan through the protocol layer", async () => {
  const sourceRunId = `protocol-retry-src-${process.pid}-${Date.now()}`;
  const retryRunId = `protocol-retry-next-${process.pid}-${Date.now()}`;
  const jobSpec = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs/hpc-cpu.json"), "utf8"));
  jobSpec.run_id = sourceRunId;
  jobSpec.workdir = `/shared/homes/\${USER}/experiments/${sourceRunId}`;

  await withMcpClient(async (client) => {
    const planned = parseTextResult(
      await client.callTool({
        name: "jobs.plan",
        arguments: { jobSpec }
      })
    ).plan;
    const runRecordPath = path.join(TEST_HOME, ".uts-computing", "runs", `${sourceRunId}.json`);
    const sourceRecord = JSON.parse(fs.readFileSync(runRecordPath, "utf8"));
    sourceRecord.status = "failed";
    sourceRecord.updated_at = new Date().toISOString();
    fs.writeFileSync(runRecordPath, `${JSON.stringify(sourceRecord, null, 2)}\n`, "utf8");

    const retryPayload = parseTextResult(
      await client.callTool({
        name: "jobs.retry.plan",
        arguments: {
          sourceRunId,
          retryRunId,
          reason: "protocol retry smoke"
        }
      })
    );

    assert.equal(retryPayload.ok, true);
    assert.equal(retryPayload.retry.source_run_id, sourceRunId);
    assert.equal(retryPayload.retry.retry_run_id, retryRunId);
    assert.equal(retryPayload.retry.plan.run_id, retryRunId);
    assert.equal(retryPayload.retry.plan.profile_id, planned.profile_id);
    assert.equal(retryPayload.retry.plan.approval.required, true);
    assert.equal(retryPayload.retry.plan.approval_operation, "jobs.retry");
    assert.equal(retryPayload.retry.plan.retry_of.source_run_id, sourceRunId);
    assert.equal(retryPayload.retry.plan.retry_of.source_status, "failed");
    assert.match(retryPayload.retry.plan.normalized_job_spec.workdir, new RegExp(`${retryRunId}$`));
    assert.equal(JSON.stringify(retryPayload).includes("protocol retry smoke"), true);

    const rejected = parseToolError(
      await client.callTool({
        name: "jobs.retry.plan",
        arguments: {
          sourceRunId,
          retryRunId: sourceRunId
        }
      })
    );
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /must differ/);
  });
});

test("MCP stdio server exposes redacted context resources", async () => {
  writeProtocolResourceFixtures();

  await withMcpClient(async (client) => {
    const resources = await client.listResources();
    const names = resources.resources.map((resource) => resource.name);

    assert.ok(names.includes("profiles"));
    assert.ok(names.includes("templates"));
    assert.ok(names.includes("projects"));
    assert.ok(names.includes("quota-snapshots"));
    assert.ok(names.includes("run-records"));
    assert.ok(names.includes("approval-records"));
    assert.ok(names.includes("artifacts"));
    assert.ok(names.includes("transfers"));
    assert.ok(names.includes("docs"));
    assert.ok(names.includes("docs-cache"));
    assert.ok(names.includes("template:pbs-cpu"));
    assert.ok(names.includes("doc:architecture"));
    assert.ok(names.includes("quota-snapshot:quota-protocol-test-2026-06-15T00-00-00-000Z"));
    assert.ok(names.includes("run-record:protocol-run-record"));
    assert.ok(names.includes("artifact-state:protocol-artifact-run"));
    assert.ok(names.includes("artifact-manifest:protocol-artifact-run"));
    assert.ok(names.includes("artifact-cleanup-plans:protocol-artifact-run"));
    assert.ok(names.includes("artifact-cleanup-executions:protocol-artifact-run"));
    assert.ok(names.includes("transfer-state:protocol-transfer-run"));

    const templates = await client.listResourceTemplates();
    const uriTemplates = templates.resourceTemplates.map((template) => template.uriTemplate).sort();
    assert.deepEqual(uriTemplates, [
      "uts://approval-records/{approvalId}",
      "uts://artifacts/{runId}/cleanup-executions",
      "uts://artifacts/{runId}/cleanup-plans",
      "uts://artifacts/{runId}/manifest",
      "uts://artifacts/{runId}/state",
      "uts://docs-cache/{sourceId}",
      "uts://docs/{docId}",
      "uts://profiles/{profileId}/quota-snapshot/latest",
      "uts://projects/{projectHash}",
      "uts://quota-snapshots/{snapshotId}",
      "uts://run-records/{runId}",
      "uts://templates/{templateId}",
      "uts://transfers/{runId}/executions",
      "uts://transfers/{runId}/plan",
      "uts://transfers/{runId}/state"
    ]);
  });
});

test("MCP stdio server handles approval request status and trusted decision through the protocol layer", async () => {
  const quotaSnapshotId = `quota-protocol-approval-${process.pid}`;
  const observedAt = new Date().toISOString();
  const jobSpec = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs/hpc-gpu.json"), "utf8"));
  writeProtocolQuotaSnapshot(quotaSnapshotId, "uts-hpc-account-a", "uts-hpc", observedAt);

  await withMcpClient(
    async (client) => {
      const planned = parseTextResult(
        await client.callTool({
          name: "jobs.plan",
          arguments: { jobSpec }
        })
      ).plan;
      assert.match(planned.plan_hash, /^[a-f0-9]{64}$/);

      const requested = parseTextResult(
        await client.callTool({
          name: "approvals.request",
          arguments: {
            runId: planned.run_id,
            profileId: planned.profile_id,
            platform: planned.platform,
            planHash: planned.plan_hash,
            quotaSnapshotId
          }
        })
      ).approval;
      assert.equal(requested.state, "required");
      assert.ok(requested.reasons.some((reason) => reason.includes("GPU resource request")));
      assert.ok(requested.reasons.some((reason) => reason.includes("Restricted or special queue: small_gpuq")));
      assert.equal(requested.command_summary, planned.normalized_job_spec.command);
      assert.equal(requested.resource_summary.ngpus, 1);

      const status = parseTextResult(
        await client.callTool({
          name: "approvals.status",
          arguments: { approvalId: requested.approval_id }
        })
      ).approval;
      assert.equal(status.state, "required");

      const rejectedDecision = parseToolError(
        await client.callTool({
          name: "approvals.decide",
          arguments: {
            approvalId: requested.approval_id,
            decision: "approved",
            planHash: planned.plan_hash,
            quotaSnapshotId,
            confirmationToken: "wrong"
          }
        })
      );
      assert.equal(rejectedDecision.ok, false);
      assert.match(rejectedDecision.error, /confirmation token/);

      const approved = parseTextResult(
        await client.callTool({
          name: "approvals.decide",
          arguments: {
            approvalId: requested.approval_id,
            decision: "approved",
            planHash: planned.plan_hash,
            quotaSnapshotId,
            confirmationToken: "protocol-token",
            decidedBy: "protocol-test"
          }
        })
      ).approval;
      assert.equal(approved.state, "approved");
      assert.equal(approved.plan_hash, planned.plan_hash);
      assert.equal(JSON.stringify(approved).includes("protocol-token"), false);
    },
    { UTS_COMPUTING_APPROVAL_TOKEN: "protocol-token" }
  );
});

test("MCP stdio server rejects unsafe artifact fetch inputs through the protocol layer", async () => {
  await withMcpClient(async (client) => {
    const rejected = parseToolError(
      await client.callTool({
        name: "artifacts.fetch",
        arguments: {
          runId: "../bad-run",
          artifactId: "artifact-aaaaaaaaaaaaaaaaaaaaaaaa",
          approvalId: "approval-artifact-test",
          maxBytes: 1024
        }
      })
    );

    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /run_id|runId|Unsafe/);

    const rejectedBatch = parseToolError(
      await client.callTool({
        name: "artifacts.fetch.batch",
        arguments: {
          runId: "protocol-artifact-run",
          manifestHash: "a".repeat(64),
          artifactIds: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa", "artifact-aaaaaaaaaaaaaaaaaaaaaaaa"],
          approvalId: "approval-artifact-test",
          maxTotalBytes: 1024
        }
      })
    );
    assert.equal(rejectedBatch.ok, false);
    assert.match(rejectedBatch.error, /unique/);
  });
});

test("MCP stdio server rejects dangerous extra tool arguments before handlers run", async () => {
  await withMcpClient(
    async (client) => {
      const dangerousCalls = [
        {
          name: "docs.search",
          extraField: "path",
          args: { query: "approval", path: "/Users/example/private" }
        },
        {
          name: "docs.refresh",
          extraField: "url",
          args: { sourceIds: ["unknown-source"], url: "https://evil.example/docs" }
        },
        {
          name: "access.check",
          extraField: "sshOptions",
          args: { profileId: "missing-profile", sshOptions: ["-o", "StrictHostKeyChecking=no"] }
        },
        {
          name: "quotas.refresh",
          extraField: "command",
          args: { profileId: "missing-profile", command: "qstat -f" }
        },
        {
          name: "jobs.plan",
          extraField: "command",
          args: { jobSpec: { run_id: "protocol-extra-arg" }, command: "rm -rf /" }
        },
        {
          name: "jobs.submit",
          extraField: "command",
          args: { runId: "missing-run", approvalId: "approval-missing", command: "qsub -I" }
        },
        {
          name: "jobs.retry.plan",
          extraField: "workdir",
          args: { sourceRunId: "missing-source", retryRunId: "retry-target", workdir: "/tmp" }
        },
        {
          name: "jobs.status",
          extraField: "remoteJobId",
          args: { runId: "missing-run", remoteJobId: "123.server" }
        },
        {
          name: "jobs.logs",
          extraField: "path",
          args: { runId: "missing-run", path: "/shared/homes/user/output.log" }
        },
        {
          name: "jobs.cancel",
          extraField: "force",
          args: { runId: "missing-run", approvalId: "approval-missing", force: true }
        },
        {
          name: "artifacts.list",
          extraField: "host",
          args: { runId: "missing-run", host: "uts-hpc" }
        },
        {
          name: "artifacts.fetch",
          extraField: "remotePath",
          args: {
            runId: "missing-run",
            artifactId: "artifact-aaaaaaaaaaaaaaaaaaaaaaaa",
            approvalId: "approval-missing",
            remotePath: "/tmp/metrics.json"
          }
        },
        {
          name: "artifacts.fetch.batch",
          extraField: "glob",
          args: {
            runId: "missing-run",
            manifestHash: "a".repeat(64),
            artifactIds: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"],
            approvalId: "approval-missing",
            glob: "*.json"
          }
        },
        {
          name: "artifacts.cleanup.execute",
          extraField: "path",
          args: {
            runId: "missing-run",
            manifestHash: "a".repeat(64),
            artifactIds: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"],
            approvalId: "approval-missing",
            path: "/tmp/delete-me"
          }
        },
        {
          name: "artifacts.cleanup.execute",
          extraField: "glob",
          args: {
            runId: "missing-run",
            manifestHash: "a".repeat(64),
            artifactIds: ["artifact-aaaaaaaaaaaaaaaaaaaaaaaa"],
            approvalId: "approval-missing",
            glob: "*.json"
          }
        },
        {
          name: "transfers.execute",
          extraField: "files",
          args: { runId: "missing-run", approvalId: "approval-missing", files: ["*"] }
        },
        {
          name: "transfers.execute",
          extraField: "sshOptions",
          args: { runId: "missing-run", approvalId: "approval-missing", sshOptions: ["-o", "ProxyCommand=bad"] }
        },
        {
          name: "state.migrate.apply",
          extraField: "runtimeRoot",
          args: { planHash: "a".repeat(64), confirmationToken: "wrong", runtimeRoot: "/tmp" }
        },
        {
          name: "state.migrate.apply",
          extraField: "files",
          args: { planHash: "a".repeat(64), confirmationToken: "wrong", files: [".uts-computing/runs/x.json"] }
        },
        {
          name: "access.doctor",
          extraField: "sshOptions",
          args: { profileId: "missing-profile", sshOptions: ["-o", "StrictHostKeyChecking=no"] }
        },
        {
          name: "jobs.history",
          extraField: "host",
          args: { limit: 5, host: "uts-hpc" }
        },
        {
          name: "jobs.usage",
          extraField: "command",
          args: { runId: "missing-run", command: "qstat -f" }
        },
        {
          name: "jobs.diagnose",
          extraField: "path",
          args: { runId: "missing-run", path: "/shared/homes/user/output.log" }
        },
        {
          name: "sweep.plan",
          extraField: "script",
          args: { jobSpec: { run_id: "sweep-extra" }, parameters: { lr: [0.1] }, script: "#!/bin/bash\nrm -rf /" }
        }
      ];

      for (const call of dangerousCalls) {
        await assertRejectsExtraToolArgument(client, call.name, call.args, call.extraField);
      }
    },
    {
      UTS_COMPUTING_TEST_MODE: "1",
      UTS_COMPUTING_TEST_DOCS: "mock",
      UTS_COMPUTING_TEST_JOB_OPS: "mock"
    }
  );
});

test("MCP stdio server handles iHPC status logs and cancel through the protocol layer", async () => {
  const runId = "protocol-ihpc-run";
  const { approvalId } = writeProtocolIhpcRunFixture(runId);

  await withMcpClient(
    async (client) => {
      const statusPayload = parseTextResult(
        await client.callTool({
          name: "jobs.status",
          arguments: {
            runId,
            timeoutMs: 1000
          }
        })
      );
      assert.equal(statusPayload.ok, true);
      assert.equal(statusPayload.status.platform, "uts-ihpc");
      assert.equal(statusPayload.status.status, "running");
      assert.equal(statusPayload.status.command.remote_argv.join(" "), "ssh <ihpc-compute-node> python3 - <supervisor-spec>");
      assert.equal(JSON.stringify(statusPayload).includes("uts-ihpc-access"), false);
      // The compute node is now deliberately surfaced as a structured field (tracking requirement);
      // it stays redacted to a placeholder inside command strings (asserted above).
      assert.equal(statusPayload.status.node, "mars001");

      const logsPayload = parseTextResult(
        await client.callTool({
          name: "jobs.logs",
          arguments: {
            runId,
            stream: "stdout",
            maxBytes: 64,
            timeoutMs: 1000
          }
        })
      );
      assert.equal(logsPayload.ok, true);
      assert.equal(logsPayload.logs.platform, "uts-ihpc");
      assert.equal(logsPayload.logs.streams.length, 1);
      assert.equal(logsPayload.logs.streams[0].stream, "stdout");
      assert.equal(logsPayload.logs.streams[0].content.includes("protocol-secret"), false);
      assert.equal(logsPayload.logs.streams[0].content.includes("token=<redacted>"), true);
      assert.equal(logsPayload.logs.streams[0].path.includes("${USER}"), false);
      assert.equal(logsPayload.logs.streams[0].command.remote_argv.at(-1), "<supervisor-spec>");

      const cancelPayload = parseTextResult(
        await client.callTool({
          name: "jobs.cancel",
          arguments: {
            runId,
            approvalId,
            timeoutMs: 1000
          }
        })
      );
      assert.equal(cancelPayload.ok, true);
      assert.equal(cancelPayload.cancellation.platform, "uts-ihpc");
      assert.equal(cancelPayload.cancellation.status, "cancelled");
      assert.equal(cancelPayload.cancellation.command.remote_argv.join(" "), "ssh <ihpc-compute-node> python3 - <supervisor-spec>");
      assert.equal(JSON.stringify(cancelPayload).includes("uts-ihpc-access"), false);
      assert.equal(JSON.stringify(cancelPayload).includes("mars001"), false);

      const approval = JSON.parse(fs.readFileSync(path.join(TEST_HOME, ".uts-computing", "approvals", `${approvalId}.json`), "utf8"));
      assert.ok(approval.used_at);
      assert.equal(approval.consumed_by, `jobs.cancel:ihpc-${runId}-2468`);
    },
    {
      UTS_COMPUTING_TEST_MODE: "1",
      UTS_COMPUTING_TEST_JOB_OPS: "mock"
    }
  );
});

test("MCP stdio server returns iHPC business failures as tool errors", async () => {
  const runId = "protocol-ihpc-no-supervisor";
  writeProtocolIhpcRunFixture(runId, { includeSupervisor: false });

  await withMcpClient(
    async (client) => {
      const rejected = parseToolError(
        await client.callTool({
          name: "jobs.status",
          arguments: {
            runId,
            timeoutMs: 1000
          }
        })
      );
      assert.equal(rejected.ok, false);
      assert.match(rejected.error, /supervisor metadata/);
    },
    {
      UTS_COMPUTING_TEST_MODE: "1",
      UTS_COMPUTING_TEST_JOB_OPS: "mock"
    }
  );
});

test("MCP resources can read profiles templates snapshots run records and docs", async () => {
  writeProtocolResourceFixtures();

  await withMcpClient(async (client) => {
    const profiles = parseJsonResource(await client.readResource({ uri: "uts://profiles" }));
    assert.equal(profiles.profiles.length, 4);
    assert.equal(profiles.profiles[0].login.has_host_alias, true);
    assert.equal(Object.hasOwn(profiles.profiles[0].login, "host_alias"), false);

    const template = readTextResource(await client.readResource({ uri: "uts://templates/pbs-cpu" }));
    assert.match(template, /#PBS/);

    const quota = parseJsonResource(
      await client.readResource({ uri: "uts://quota-snapshots/quota-protocol-test-2026-06-15T00-00-00-000Z" })
    );
    assert.equal(quota.profile_id, "uts-hpc-account-a");
    assert.equal(Object.hasOwn(quota, "command_outputs"), false);
    assert.doesNotMatch(JSON.stringify(quota), /stdout|stderr/);
    assert.equal(JSON.stringify(quota).includes("/Users/"), false);

    const latestQuota = parseJsonResource(
      await client.readResource({ uri: "uts://profiles/uts-hpc-account-a/quota-snapshot/latest" })
    );
    assert.equal(latestQuota.profile_id, "uts-hpc-account-a");

    const runRecord = parseJsonResource(await client.readResource({ uri: "uts://run-records/protocol-run-record" }));
    assert.equal(runRecord.run_id, "protocol-run-record");
    assert.match(runRecord.events[0].redacted_command, /<redacted>/);

    const artifactManifest = parseJsonResource(await client.readResource({ uri: "uts://artifacts/protocol-artifact-run/manifest" }));
    assert.equal(artifactManifest.run_id, "protocol-artifact-run");
    assert.equal(artifactManifest.artifacts[0].artifact_id, "artifact-aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(Object.hasOwn(artifactManifest.artifacts[0], "remote_path"), false);
    assert.equal(Object.hasOwn(artifactManifest.artifacts[0], "local_path"), false);
    assert.equal(Object.hasOwn(artifactManifest.artifacts[0], "stdout"), false);
    assert.equal(Object.hasOwn(artifactManifest.artifacts[0], "content_b64"), false);
    assert.equal(JSON.stringify(artifactManifest).includes("${USER}"), false);
    assert.equal(JSON.stringify(artifactManifest).includes("/Users/example"), false);
    assert.match(artifactManifest.artifacts[0].source_output, /\/shared\/homes\/<user>\//);

    const artifactIndex = parseJsonResource(await client.readResource({ uri: "uts://artifacts" }));
    assert.ok(artifactIndex.artifacts.some((entry) => entry.run_id === "protocol-artifact-run" && entry.cleanup_execution_count === 1));
    assert.equal(JSON.stringify(artifactIndex).includes(repoRoot), false);
    assert.equal(JSON.stringify(artifactIndex).includes("/Users/"), false);

    const artifactState = parseJsonResource(await client.readResource({ uri: "uts://artifacts/protocol-artifact-run/state" }));
    const artifactStateText = JSON.stringify(artifactState);
    assert.equal(artifactState.run_id, "protocol-artifact-run");
    assert.equal(artifactState.state, "cleanup-executed");
    assert.equal(artifactState.latest_cleanup_plan.cleanup_plan_hash, "e".repeat(64));
    assert.equal(artifactState.latest_cleanup_execution.approval_id, "approval-protocol-artifact-cleanup");
    assert.equal(artifactState.latest_cleanup_execution.evidence.remote_total_deleted_bytes, 12);
    assert.equal(Object.hasOwn(artifactState.latest_cleanup_plan, "cleanup_plan_path"), false);
    assert.equal(Object.hasOwn(artifactState.latest_cleanup_execution.evidence.command, "args"), false);
    assert.equal(artifactStateText.includes("${USER}"), false);
    assert.equal(artifactStateText.includes(repoRoot), false);
    assert.equal(artifactStateText.includes("/Users/"), false);
    assert.equal(JSON.stringify(artifactState.latest_cleanup_execution.evidence.command).includes("uts-hpc-account-a"), false);
    assert.equal(artifactStateText.includes("raw-base64-spec-should-not-leak"), false);
    assert.match(artifactState.latest_cleanup_plan.remote_candidates[0], /\/shared\/homes\/<user>\//);
    assert.match(artifactState.latest_cleanup_plan.local_candidates[0], /^<artifact-cache>\//);
    assert.match(artifactState.latest_cleanup_execution.evidence.local_deleted_files[0], /^<artifact-cache>\//);

    const cleanupPlans = parseJsonResource(await client.readResource({ uri: "uts://artifacts/protocol-artifact-run/cleanup-plans" }));
    const cleanupExecutions = parseJsonResource(await client.readResource({ uri: "uts://artifacts/protocol-artifact-run/cleanup-executions" }));
    assert.equal(cleanupPlans.cleanup_plans.length, 1);
    assert.equal(cleanupExecutions.cleanup_executions.length, 1);
    assert.equal(JSON.stringify(cleanupPlans).includes("cleanup_plan_path"), false);
    assert.equal(JSON.stringify(cleanupExecutions).includes("raw-base64-spec-should-not-leak"), false);

    const transfers = parseJsonResource(await client.readResource({ uri: "uts://transfers" }));
    assert.ok(transfers.transfers.some((entry) => entry.run_id === "protocol-transfer-run"));
    assert.equal(JSON.stringify(transfers).includes(repoRoot), false);
    assert.equal(JSON.stringify(transfers).includes("/Users/"), false);

    const transferState = parseJsonResource(await client.readResource({ uri: "uts://transfers/protocol-transfer-run/state" }));
    const transferText = JSON.stringify(transferState);
    assert.equal(transferState.run_id, "protocol-transfer-run");
    assert.equal(transferState.state, "executed");
    assert.equal(transferState.plan.plan_hash, "b".repeat(64));
    assert.deepEqual(transferState.plan.files, ["logs/run.out", "metrics.json"]);
    assert.equal(transferState.latest_execution.approval_id, "approval-protocol-transfer");
    assert.equal(transferState.latest_execution.evidence.total_size_bytes, 1232);
    assert.equal(transferState.latest_execution.evidence.files[0].checksum_status, "verified");
    assert.equal(transferState.latest_execution.evidence.files[0].sha256, "c".repeat(64));
    assert.equal(transferState.latest_execution.evidence.files[1].checksum_status, "verified");
    assert.equal(transferState.latest_execution.evidence.files[1].sha256, "d".repeat(64));
    assert.deepEqual(transferState.latest_execution.evidence.checksum_policy, { algorithm: "sha256", max_file_bytes: 50000000 });
    assert.equal(Object.hasOwn(transferState.plan, "script"), false);
    assert.equal(Object.hasOwn(transferState.plan, "plan_path"), false);
    assert.equal(transferText.includes("uts-hpc:"), false);
    assert.equal(transferText.includes("${USER}"), false);
    assert.equal(transferText.includes(repoRoot), false);
    assert.equal(transferText.includes("/Users/"), false);
    assert.equal(transferText.includes("protocol-local-user"), false, "local /Users/<home> username must not leak");
    assert.match(transferState.plan.source, /\/shared\/homes\/<user>\//);
    // The local /Users/<home> execution source is masked to <local-home> by redactTransferEndpoint.
    assert.match(transferState.latest_execution.evidence.source, /^<local-home>\/local-source\/protocol-transfer-run$/);

    const doc = readTextResource(await client.readResource({ uri: "uts://docs/implementation-plan" }));
    assert.match(doc, /M2: Read-Only Live Platform Queries/);

    const playbook = readTextResource(await client.readResource({ uri: "uts://docs/failure-playbooks" }));
    assert.match(playbook, /Universal Triage/);
  });
});

test("MCP resource templates reject unsafe runtime ids", async () => {
  await withMcpClient(async (client) => {
    await assert.rejects(
      () => client.readResource({ uri: "uts://quota-snapshots/evil..id" }),
      /Unsafe|not found|No resource/
    );
    await assert.rejects(
      () => client.readResource({ uri: "uts://docs/evil..id" }),
      /not found|No resource|Unknown/
    );
    await assert.rejects(
      () => client.readResource({ uri: "uts://artifacts/evil..id/manifest" }),
      /Unsafe|not found|No resource/
    );
    await assert.rejects(
      () => client.readResource({ uri: "uts://artifacts/evil..id/cleanup-plans" }),
      /Unsafe|not found|No resource/
    );
    await assert.rejects(
      () => client.readResource({ uri: "uts://artifacts/evil..id/cleanup-executions" }),
      /Unsafe|not found|No resource/
    );
    await assert.rejects(
      () => client.readResource({ uri: "uts://artifacts/protocol-artifact-run/files/metrics.json" }),
      /not found|No resource/
    );
    await assert.rejects(
      () => client.readResource({ uri: "uts://transfers/evil..id/state" }),
      /Unsafe|not found|No resource/
    );
    await assert.rejects(
      () => client.readResource({ uri: "uts://transfers/protocol-transfer-run/files/metrics.json" }),
      /not found|No resource/
    );
  });
});

test("MCP runtime resources reject symlink escapes", async () => {
  const quotaDir = path.join(TEST_HOME, ".uts-computing", "quotas");
  const outsideDir = path.join(TEST_HOME, ".uts-computing", "outside-resource-fixtures");
  const outsideFile = path.join(outsideDir, "outside.json");
  const linkPath = path.join(quotaDir, "symlink-escape.json");
  fs.mkdirSync(quotaDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(outsideFile, "{\"secret\":\"outside\"}\n", "utf8");
  try {
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(outsideFile, linkPath);
  } catch {
    return;
  }

  await withMcpClient(async (client) => {
    await assert.rejects(
      () => client.readResource({ uri: "uts://quota-snapshots/symlink-escape" }),
      /must stay inside|not found|No resource/
    );
  });
});

test("MCP artifact manifest resources reject symlink escapes", async () => {
  const artifactRunDir = path.join(TEST_HOME, ".uts-computing", "artifacts", "symlink-artifact");
  const outsideDir = path.join(TEST_HOME, ".uts-computing", "outside-artifact-fixtures");
  const outsideFile = path.join(outsideDir, "manifest.json");
  const linkPath = path.join(artifactRunDir, "manifest.json");
  fs.mkdirSync(artifactRunDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(outsideFile, "{\"secret\":\"outside-artifact\"}\n", "utf8");
  try {
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(outsideFile, linkPath);
  } catch {
    return;
  }

  try {
    await withMcpClient(async (client) => {
      await assert.rejects(
        () => client.readResource({ uri: "uts://artifacts/symlink-artifact/manifest" }),
        /must stay inside|not found|No resource/
      );
    });
  } finally {
    fs.rmSync(linkPath, { force: true });
  }
});

test("MCP artifact cleanup resources reject symlink escapes", async () => {
  const artifactRunDir = path.join(TEST_HOME, ".uts-computing", "artifacts", "symlink-cleanup");
  const outsideDir = path.join(TEST_HOME, ".uts-computing", "outside-cleanup-fixtures");
  const outsideFile = path.join(outsideDir, "cleanup-plan.json");
  const planLinkPath = path.join(artifactRunDir, "cleanup-plan-2026-06-15T00-00-00-000Z.json");
  const executionLinkPath = path.join(artifactRunDir, "cleanup-execute-2026-06-15T00-00-00-000Z.json");
  fs.mkdirSync(artifactRunDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(outsideFile, "{\"secret\":\"outside-cleanup\"}\n", "utf8");
  try {
    fs.rmSync(planLinkPath, { force: true });
    fs.rmSync(executionLinkPath, { force: true });
    fs.symlinkSync(outsideFile, planLinkPath);
    fs.symlinkSync(outsideFile, executionLinkPath);
  } catch {
    return;
  }

  try {
    await withMcpClient(async (client) => {
      await assert.rejects(
        () => client.readResource({ uri: "uts://artifacts/symlink-cleanup/cleanup-plans" }),
        /symlink|must stay inside|not found|No resource/
      );
      await assert.rejects(
        () => client.readResource({ uri: "uts://artifacts/symlink-cleanup/cleanup-executions" }),
        /symlink|must stay inside|not found|No resource/
      );
    });
  } finally {
    fs.rmSync(planLinkPath, { force: true });
    fs.rmSync(executionLinkPath, { force: true });
  }
});

test("MCP transfer resources reject symlink escapes", async () => {
  const transferRunDir = path.join(TEST_HOME, ".uts-computing", "transfers", "symlink-transfer");
  const outsideDir = path.join(TEST_HOME, ".uts-computing", "outside-transfer-fixtures");
  const outsideFile = path.join(outsideDir, "plan.json");
  const linkPath = path.join(transferRunDir, "plan.json");
  fs.mkdirSync(transferRunDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(outsideFile, "{\"secret\":\"outside-transfer\"}\n", "utf8");
  try {
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(outsideFile, linkPath);
  } catch {
    return;
  }

  try {
    await withMcpClient(async (client) => {
      await assert.rejects(
        () => client.readResource({ uri: "uts://transfers/symlink-transfer/plan" }),
        /must stay inside|not found|No resource/
      );
      await assert.rejects(
        () => client.readResource({ uri: "uts://transfers/symlink-transfer/state" }),
        /must stay inside|not found|No resource/
      );
    });
  } finally {
    fs.rmSync(linkPath, { force: true });
  }
});

test("profiles.list reflects a persisted quota snapshot as fresh, not 'missing'", async () => {
  // Regression: quotas.refresh persists a snapshot to the store, but profiles.list previously read
  // only the (never-populated) embedded profile field and always reported freshness "missing".
  const home = isolatedHome("uts-proto-freshness-");
  const quotaDir = path.join(home, ".uts-computing", "quotas");
  fs.mkdirSync(quotaDir, { recursive: true });
  const snapshotId = `quota-freshness-${process.pid}`;
  fs.writeFileSync(
    path.join(quotaDir, `${snapshotId}.json`),
    `${JSON.stringify(
      {
        snapshot_id: snapshotId,
        profile_id: "uts-hpc-account-a",
        platform: "uts-hpc",
        observed_at: new Date().toISOString(),
        source: "quotas.refresh",
        freshness: "fresh",
        summary: { identity: { remote_user_observed: true } },
        commands: [],
        warnings: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  await withMcpClient(
    async (client) => {
      const listed = parseTextResult(await client.callTool({ name: "profiles.list", arguments: {} }));
      const profile = listed.profiles.find((entry) => entry.profile_id === "uts-hpc-account-a");
      assert.ok(profile, "uts-hpc-account-a must be in the profile list");
      assert.equal(profile.quota_snapshot.freshness, "fresh");
      assert.equal(typeof profile.quota_snapshot.observed_at, "string");
    },
    { UTS_COMPUTING_HOME: home }
  );
});
