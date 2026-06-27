import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { planJob } from "../../dist/ops/plans/planner.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import { trackActiveJobs } from "../../dist/ops/jobs/jobs.js";
import {
  readExample,
  tempRuntimeDir,
  runtimeRoot,
  writeResolvedHpcConfig,
  resolvedHpcWorkdir
} from "../helpers/index.mjs";

const smallqLimit = {
  name: "smallq",
  enabled: true,
  started: true,
  resources_max: { ncpus: 4, mem_gb: 32, walltime_seconds: 86400 },
  max_run: { perUserGeneric: 60 },
  max_queued: { perUserGeneric: 100 }
};

function writeSnapshot(snapshotId, profileId, platform, observedAt, queueLimits, byQueue = {}, filesystems = [], groups = []) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = {
    snapshot_id: snapshotId,
    profile_id: profileId,
    platform,
    observed_at: observedAt,
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      identity: { remote_user_observed: true, groups },
      queues: { observed: true, queue_names: queueLimits.map((q) => q.name), queue_limits: queueLimits },
      running_work: { observed: true, job_count: 0, by_queue: byQueue },
      storage: { observed: true, filesystems }
    },
    commands: [],
    warnings: []
  };
  fs.writeFileSync(path.join(dir, `${snapshotId}.json`), `${JSON.stringify({ snapshot }, null, 2)}\n`, "utf8");
  return snapshotId;
}

// Autonomous-conformance fixtures plan against the RESOLVED-user HPC profile (user@host alias), so the
// normalized workdir is a concrete path — the real live-submit shape jobs.submit now requires (it fails
// closed on a still-literal ${USER}). The concrete workdir still lives under /shared/homes, so the
// storage-headroom conformance check (which matches the target path against the workspace filesystem)
// behaves identically.
function planHpcJob(runId, resources, now) {
  const planDir = tempRuntimeDir("test-auto-plans");
  const auditDir = tempRuntimeDir("test-auto-runs");
  const configPath = writeResolvedHpcConfig("auto");
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.profile_id = "uts-hpc-account-a";
  job.workdir = resolvedHpcWorkdir(runId);
  job.resources = resources;
  const plan = planJob(job, { planDir, auditDir, configPath, now });
  return { plan, planDir, auditDir, configPath };
}

test("jobs.submit runs autonomously when the job conforms to the fresh quota snapshot (no token)", async () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-smoke-conform",
    { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  const snapshotId = `quota-uts-hpc-account-a-${now.toISOString().replace(/[:.]/g, "-")}`;
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString(), [smallqLimit]);
  let qsubCalls = 0;

  const res = await submitJob(
    { runId: plan.run_id, quotaSnapshotId: snapshotId },
    {
      planDir,
      auditDir,
      configPath,
      now,
      executor: async (program, _args, _t, stdin) => {
        assert.equal(program, "ssh");
        // The pre-qsub workdir/log_dir mkdir carries no stdin; only the qsub ships the PBS script.
        if (!stdin) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        qsubCalls += 1;
        assert.match(stdin, /#PBS/);
        return { exitCode: 0, stdout: "12345.hpc\n", stderr: "" };
      }
    }
  );

  assert.equal(qsubCalls, 1);
  assert.equal(res.submission.remote_job_id, "12345.hpc");
  assert.equal(res.submission.approval_id, undefined);
  assert.equal(res.submission.quota_snapshot_id, snapshotId);
  const runRecord = JSON.parse(fs.readFileSync(path.join(auditDir, `${plan.run_id}.json`), "utf8"));
  assert.equal(runRecord.status, "submitted");
  assert.equal(runRecord.remote_job_id, "12345.hpc");
  assert.equal(runRecord.approval.state, "not_required");
});

test("jobs.submit refuses a non-conforming job before any qsub", async () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-smoke-toobig",
    { queue: "smallq", ncpus: 16, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  const snapshotId = "quota-uts-hpc-account-a-toobig";
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString(), [smallqLimit]);
  let qsubCalls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: plan.run_id, quotaSnapshotId: snapshotId },
        {
          planDir,
          auditDir,
          configPath,
          now,
          executor: async () => {
            qsubCalls += 1;
            return { exitCode: 0, stdout: "x\n", stderr: "" };
          }
        }
      ),
    /does not conform|ncpus/
  );
  assert.equal(qsubCalls, 0);
});

test("jobs.submit refuses a job whose target filesystem is observably full (storage headroom)", async () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-smoke-fulldisk",
    { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  const snapshotId = "quota-uts-hpc-account-a-fulldisk";
  // The job writes under /shared/homes; that filesystem is at 100% capacity in the snapshot.
  // /scratch having room must not rescue it.
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString(), [smallqLimit], {}, [
    { kind: "scratch", mounted_on: "/scratch", capacity_percent: 40, avail_bytes: 500 * 1024 ** 3 },
    { kind: "workspace", mounted_on: "/shared/homes", capacity_percent: 100, avail_bytes: 0 }
  ]);
  let qsubCalls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: plan.run_id, quotaSnapshotId: snapshotId },
        {
          planDir,
          auditDir,
          configPath,
          now,
          executor: async () => {
            qsubCalls += 1;
            return { exitCode: 0, stdout: "x\n", stderr: "" };
          }
        }
      ),
    /does not conform|storage|full/
  );
  assert.equal(qsubCalls, 0);
});

test("jobs.submit proceeds when the target filesystem has headroom even if another is full", async () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-smoke-otherdisk",
    { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  const snapshotId = "quota-uts-hpc-account-a-otherdisk";
  // /scratch is full but the job writes under /shared/homes, which has room.
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString(), [smallqLimit], {}, [
    { kind: "scratch", mounted_on: "/scratch", capacity_percent: 100, avail_bytes: 0 },
    { kind: "workspace", mounted_on: "/shared/homes", capacity_percent: 50, avail_bytes: 300 * 1024 ** 3 }
  ]);
  let qsubCalls = 0;

  const res = await submitJob(
    { runId: plan.run_id, quotaSnapshotId: snapshotId },
    {
      planDir,
      auditDir,
      configPath,
      now,
      executor: async (_program, _args, _t, stdin) => {
        if (!stdin) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        qsubCalls += 1;
        return { exitCode: 0, stdout: "777.hpc\n", stderr: "" };
      }
    }
  );
  assert.equal(qsubCalls, 1);
  assert.equal(res.submission.remote_job_id, "777.hpc");
});

test("jobs.submit refuses autonomy against a stale snapshot", async () => {
  const now = new Date("2026-06-16T01:00:00.000Z");
  const stale = new Date("2026-06-16T00:00:00.000Z").toISOString();
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-smoke-stale",
    { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  const snapshotId = "quota-uts-hpc-account-a-stale";
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", stale, [smallqLimit]);
  let qsubCalls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: plan.run_id, quotaSnapshotId: snapshotId },
        {
          planDir,
          auditDir,
          configPath,
          now,
          executor: async () => {
            qsubCalls += 1;
            return { exitCode: 0, stdout: "x\n", stderr: "" };
          }
        }
      ),
    /stale/
  );
  assert.equal(qsubCalls, 0);
});

test("jobs.submit honors a per-group max_run cap threaded from the snapshot (closes the fail-open hole)", async () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-group-cap",
    { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  // smallq's ONLY running cap is a per-group cap of 2 for "research"; the account already has 2
  // running. With groups=[] (the old bug) the perGroup cap is invisible and this would conform.
  const groupCapQ = {
    name: "smallq",
    enabled: true,
    started: true,
    resources_max: { ncpus: 4, mem_gb: 32, walltime_seconds: 86400 },
    max_run: { perGroup: { research: 2 } },
    max_queued: { perUserGeneric: 100 }
  };
  const snapshotId = "quota-uts-hpc-account-a-groupcap";
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString(), [groupCapQ], { smallq: { running: 2, queued: 0 } }, [], ["research", "hpcusers"]);
  let qsubCalls = 0;
  await assert.rejects(
    () =>
      submitJob(
        { runId: plan.run_id, quotaSnapshotId: snapshotId },
        { planDir, auditDir, configPath, now, executor: async () => { qsubCalls += 1; return { exitCode: 0, stdout: "x\n", stderr: "" }; } }
      ),
    /does not conform|max[_-]?run/i
  );
  assert.equal(qsubCalls, 0);
});

test("jobs.submit permits a group-only ACL grant threaded from the snapshot (closes the fail-closed hole)", async () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-group-acl",
    { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  // smallq is gated by a group ACL granting "research"; with groups=[] the account is wrongly denied.
  const aclGroupQ = {
    name: "smallq",
    enabled: true,
    started: true,
    resources_max: { ncpus: 4, mem_gb: 32, walltime_seconds: 86400 },
    acl_group_enable: true,
    acl_groups: ["research"],
    max_run: { perUserGeneric: 60 },
    max_queued: { perUserGeneric: 100 }
  };
  const snapshotId = "quota-uts-hpc-account-a-groupacl";
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString(), [aclGroupQ], {}, [], ["research", "hpcusers"]);
  let qsubCalls = 0;
  const res = await submitJob(
    { runId: plan.run_id, quotaSnapshotId: snapshotId },
    {
      planDir,
      auditDir,
      configPath,
      now,
      executor: async (_program, _args, _t, stdin) => {
        if (!stdin) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        qsubCalls += 1;
        return { exitCode: 0, stdout: "999.hpc\n", stderr: "" };
      }
    }
  );
  assert.equal(qsubCalls, 1);
  assert.equal(res.submission.remote_job_id, "999.hpc");
});

test("a submit that dies during the remote qsub is left 'submitting' and jobs.track flags it for reconciliation (no orphan)", async () => {
  const now = new Date("2026-06-16T00:00:00.000Z");
  const { plan, planDir, auditDir, configPath } = planHpcJob(
    "auto-orphan-window",
    { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
    now
  );
  const snapshotId = "quota-uts-hpc-account-a-orphan";
  writeSnapshot(snapshotId, "uts-hpc-account-a", "uts-hpc", now.toISOString(), [smallqLimit]);

  // Simulate the process dying during the remote qsub. The durable marker is written BEFORE the
  // remote call, so the record must already be "submitting" (not "planned") when the call fails.
  await assert.rejects(() =>
    submitJob(
      { runId: plan.run_id, quotaSnapshotId: snapshotId },
      { planDir, auditDir, configPath, now, executor: async () => { throw new Error("connection dropped mid-qsub"); } }
    )
  );
  const crashed = JSON.parse(fs.readFileSync(path.join(auditDir, `${plan.run_id}.json`), "utf8"));
  assert.equal(crashed.status, "submitting");
  assert.equal(crashed.remote_job_id, null);

  // jobs.track must surface the in-flight run for reconciliation, not silently skip it as planned,
  // and must not try to poll a record that has no remote_job_id.
  const { tracking } = await trackActiveJobs(
    {},
    { auditDir, now, executor: async () => { throw new Error("must not poll a record with no remote_job_id"); } }
  );
  assert.equal(tracking.counts.needs_reconciliation, 1);
  assert.equal(tracking.counts.skipped_planned, 0);
  assert.ok(tracking.needs_reconciliation.some((entry) => entry.run_id === plan.run_id));
});
