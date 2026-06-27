import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { planJob } from "../../dist/ops/plans/planner.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import { getJobLogs } from "../../dist/ops/jobs/jobs.js";
import { readExample, tempRuntimeDir, writeProfileConfig, runtimeRoot } from "../helpers/index.mjs";

// iHPC-specific quota snapshot (hardcodes uts-ihpc platform) — kept inline by design.
function writeIhpcQuotaSnapshot(snapshotId, profileId, observedAt) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${snapshotId}.json`),
    `${JSON.stringify(
      {
        snapshot_id: snapshotId,
        profile_id: profileId,
        platform: "uts-ihpc",
        observed_at: observedAt,
        source: "quotas.refresh",
        freshness: "fresh",
        summary: {
          identity: { remote_user_observed: true },
          node_families: { observed: true, available_families: ["mars"], all_families: ["mars", "mercury"] },
          sessions: { observed: true, active_session_count: 1, active_nodes: [{ node: "mars001", family: "mars" }] }
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

// A profile rooted at a NON-standard mount (/work/), not one of the three default
// redaction prefixes (/data, /scratch, /shared/homes). Redaction must derive the
// mask prefix from the profile's declared roots, not a hardcoded list.
const nonStandardRootProfile = {
  profile_id: "uts-ihpc-roots-test",
  platform: "uts-ihpc",
  account_label: "ihpc-roots",
  login: { host_alias: "uts-ihpc-access", username_ref: "UTS_IHPC_ROOTS_USER", ssh_agent: true, requires_vpn: true },
  defaults: { node_family: "mars", workspace: "/work/${USER}/experiments", scratch: "/scratch/${USER}" },
  quota_snapshot: null
};

test("redaction masks the username under a profile-declared non-standard root (ihpc start + jobs.logs)", async () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const configPath = writeProfileConfig("roots", [nonStandardRootProfile]);

  const job = readExample("ihpc-background.json");
  job.run_id = "redact-roots";
  job.profile_id = "uts-ihpc-roots-test";
  job.workdir = "/work/${USER}/experiments/redact-roots";
  const plan = planJob(job, { planDir, auditDir, configPath });

  const quotaSnapshotId = "quota-redact-roots-2026-06-15T00-00-00-000Z";
  writeIhpcQuotaSnapshot(quotaSnapshotId, plan.profile_id, now.toISOString());

  const result = await submitJob(
    { runId: plan.run_id, quotaSnapshotId },
    {
      planDir,
      auditDir,
      configPath,
      now,
      executor: async (program) => {
        assert.equal(program, "ssh");
        return {
          exitCode: 0,
          stdout:
            '{"pid":4242,"metadata_path":"/work/alice/experiments/redact-roots/logs/redact-roots.supervisor.json","stdout_path":"/work/alice/experiments/redact-roots/logs/redact-roots.out","stderr_path":"/work/alice/experiments/redact-roots/logs/redact-roots.err"}\n',
          stderr: ""
        };
      }
    }
  );

  // ihpc-start.ts redaction: the echoed supervisor path carries the real account name.
  const startedPath = result.submission.supervisor.stdout_path;
  assert.equal(startedPath.includes("/work/alice"), false);
  assert.equal(startedPath.includes("/work/<user>/"), true);

  // jobs.ts redaction: the persisted plan path carries ${USER}; jobs.logs must mask it.
  const logs = await getJobLogs(
    { runId: plan.run_id, stream: "stdout" },
    {
      auditDir,
      configPath,
      now,
      executor: async (program) => {
        assert.equal(program, "ssh");
        return {
          exitCode: 0,
          stdout: '{"streams":[{"stream":"stdout","status":"passed","content":"hello","truncated":false,"summary":"ok"}]}\n',
          stderr: ""
        };
      }
    }
  );
  const loggedPath = logs.logs.streams[0].path;
  assert.equal(loggedPath.includes("${USER}"), false);
  assert.equal(loggedPath.includes("/work/<user>/"), true);
});
