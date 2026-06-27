import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getJobUsage } from "../../dist/ops/jobs/jobs.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

const NOW = new Date("2026-06-15T00:00:00.000Z");

const FINISHED_GPU_JOB = `Job Id: 12345.pbsserver
    job_state = F
    resources_used.cput = 06:00:00
    resources_used.walltime = 01:00:00
    resources_used.ncpus = 8
    resources_used.mem = 4194304kb
    exec_vnode = (gpunode01:ncpus=8:ngpus=2)
`;

function writeRecord(auditDir, overrides) {
  const record = {
    run_id: "usage-run",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: "12345.pbsserver",
    status: "finished",
    created_at: "2026-06-10T01:00:00.000Z",
    updated_at: "2026-06-10T02:00:00.000Z",
    events: [{ at: "2026-06-10T01:00:00.000Z", kind: "planned", summary: "planned" }],
    ...overrides
  };
  fs.writeFileSync(path.join(auditDir, `${record.run_id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record.run_id;
}

test("jobs.usage parses PBS accounting for a finished HPC run", async () => {
  const auditDir = tempRuntimeDir("test-usage-runs");
  const runId = writeRecord(auditDir, {});
  let calledArgs = null;
  const executor = async (program, args) => {
    calledArgs = args;
    return { exitCode: 0, stdout: FINISHED_GPU_JOB, stderr: "" };
  };

  const { usage } = await getJobUsage(
    { runId },
    { auditDir, executor, configPath: "profiles/profiles.example.yaml", now: NOW, timeoutMs: 5000 }
  );

  assert.equal(usage.platform, "uts-hpc");
  assert.equal(usage.remote_job_id, "12345.pbsserver");
  assert.ok(usage.usage, "usage metrics present");
  assert.equal(usage.usage.core_hours, 8);
  assert.equal(usage.usage.gpu_hours, 2);
  assert.equal(usage.usage.cpu_efficiency_percent, 75);
  assert.match(usage.summary, /8 core-hours, 2 GPU-hours, 75% CPU efficiency/);
  // used the finished-job historical query
  assert.deepEqual(calledArgs.slice(-4), ["qstat", "-x", "-f", "12345.pbsserver"]);
});

test("jobs.usage reports no usage when qstat has no accounting yet", async () => {
  const auditDir = tempRuntimeDir("test-usage-queued");
  const runId = writeRecord(auditDir, { status: "running" });
  const executor = async () => ({ exitCode: 0, stdout: "Job Id: 12345.pbsserver\n    job_state = Q\n", stderr: "" });
  const { usage } = await getJobUsage({ runId }, { auditDir, executor, configPath: "profiles/profiles.example.yaml", now: NOW });
  assert.equal(usage.usage, null);
  assert.match(usage.summary, /No PBS usage/);
});

test("jobs.usage returns null usage for iHPC runs without contacting the scheduler", async () => {
  const auditDir = tempRuntimeDir("test-usage-ihpc");
  const runId = writeRecord(auditDir, { profile_id: "uts-ihpc-account-a", platform: "uts-ihpc", remote_job_id: "9999" });
  let called = false;
  const executor = async () => {
    called = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const { usage } = await getJobUsage({ runId }, { auditDir, executor, configPath: "profiles/profiles.example.yaml", now: NOW });
  assert.equal(usage.platform, "uts-ihpc");
  assert.equal(usage.usage, null);
  assert.match(usage.summary, /iHPC/);
  assert.equal(called, false, "iHPC usage must not run any remote command");
});
