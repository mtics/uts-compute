import assert from "node:assert/strict";
import test from "node:test";
import { parsePbsUsage, parsePbsRequested, computeUsageMetrics, parsePbsArrayUsage, parseQstatUsageMetrics, isPbsArrayJobId } from "../../dist/ops/jobs/accounting.js";

// `qstat -x -t -f` on a finished array job: one block per sub-job, each with its own resources_used.
// The array PARENT block carries no resources_used (PBS keeps it on the sub-jobs).
const ARRAY_SUBJOBS = `Job Id: 4150[].hpc-head01
    Job_Name = sweep
    job_state = F
    Resource_List.ncpus = 4

Job Id: 4150[0].hpc-head01
    job_state = F
    resources_used.walltime = 00:30:00
    resources_used.ncpus = 4
    resources_used.cput = 01:30:00
    resources_used.mem = 1048576kb

Job Id: 4150[1].hpc-head01
    job_state = F
    resources_used.walltime = 01:00:00
    resources_used.ncpus = 4
    resources_used.cput = 03:30:00
    resources_used.mem = 2097152kb
`;

const FINISHED_GPU_JOB = `Job Id: 12345.pbsserver
    Job_Name = train
    job_state = F
    resources_used.cput = 06:00:00
    resources_used.walltime = 01:00:00
    resources_used.ncpus = 8
    resources_used.cpupercent = 600
    resources_used.mem = 4194304kb
    exec_vnode = (gpunode01:ncpus=8:ngpus=2)
    Resource_List.walltime = 02:00:00
`;

test("parsePbsUsage extracts resources_used fields and ngpus from exec_vnode", () => {
  assert.deepEqual(parsePbsUsage(FINISHED_GPU_JOB), {
    walltime_seconds: 3600,
    cpu_seconds: 21600,
    ncpus: 8,
    ngpus: 2,
    mem: "4194304kb"
  });
});

test("computeUsageMetrics derives core-hours, gpu-hours, and cpu efficiency", () => {
  const metrics = computeUsageMetrics(parsePbsUsage(FINISHED_GPU_JOB));
  assert.equal(metrics.core_hours, 8); // 8 cpus * 1h
  assert.equal(metrics.gpu_hours, 2); // 2 gpus * 1h
  assert.equal(metrics.cpu_efficiency_percent, 75); // 6 cpu-hours / (8 * 1h)
});

test("parsePbsRequested extracts Resource_List.* into the submission.requested shape (Track 2.5)", () => {
  assert.deepEqual(parsePbsRequested(`Job Id: 1.pbs
    Resource_List.ncpus = 8
    Resource_List.mem = 32gb
    Resource_List.walltime = 08:00:00
    Resource_List.ngpus = 2
    resources_used.ncpus = 8
`), { ncpus: 8, memory_gb: 32, walltime: "08:00:00", ngpus: 2 });
});

test("parsePbsRequested omits undeclared fields and returns {} when none are present", () => {
  assert.deepEqual(parsePbsRequested("Job Id: 2.pbs\n    job_state = Q\n"), {});
  assert.deepEqual(parsePbsRequested("Job Id: 3.pbs\n    Resource_List.ncpus = 4\n"), { ncpus: 4 });
});

test("parsePbsRequested keeps an explicit ngpus=0 but drops a zero/garbage ncpus", () => {
  assert.deepEqual(parsePbsRequested("Job Id: 4.pbs\n    Resource_List.ncpus = 0\n    Resource_List.ngpus = 0\n"), { ngpus: 0 });
});

test("parsePbsUsage reads ngpus from Resource_List when exec_vnode lacks it", () => {
  const raw = parsePbsUsage(`Job Id: 7.pbs
    resources_used.walltime = 00:30:00
    resources_used.cput = 00:30:00
    resources_used.ncpus = 4
    Resource_List.ngpus = 1
`);
  assert.equal(raw.ngpus, 1);
  const metrics = computeUsageMetrics(raw);
  assert.equal(metrics.core_hours, 2);
  assert.equal(metrics.gpu_hours, 0.5);
  assert.equal(metrics.cpu_efficiency_percent, 25);
});

test("parsePbsUsage returns null for a job with no usage yet (queued)", () => {
  assert.equal(parsePbsUsage(`Job Id: 99.pbs
    job_state = Q
    Resource_List.ncpus = 8
`), null);
});

test("parsePbsUsage handles walltime hours beyond 24", () => {
  const raw = parsePbsUsage(`Job Id: 8.pbs
    resources_used.walltime = 30:00:00
    resources_used.ncpus = 1
    resources_used.cput = 15:00:00
`);
  assert.equal(raw.walltime_seconds, 108000);
  assert.equal(raw.ngpus, 0);
  assert.equal(computeUsageMetrics(raw).core_hours, 30);
});

test("isPbsArrayJobId detects array parents and sub-jobs but not plain jobs", () => {
  assert.equal(isPbsArrayJobId("4150[].hpc-head01"), true);
  assert.equal(isPbsArrayJobId("4150[7].hpc-head01"), true);
  assert.equal(isPbsArrayJobId("3703.hpc-head01"), false);
});

test("parsePbsArrayUsage sums resources_used across array sub-jobs", () => {
  const metrics = parsePbsArrayUsage(ARRAY_SUBJOBS);
  // sub[0]: 1800s x 4cpu, sub[1]: 3600s x 4cpu -> core-seconds 7200+14400=21600 -> 6 core-hours.
  assert.equal(metrics.core_hours, 6);
  assert.equal(metrics.walltime_seconds, 5400, "sub-job walltimes summed (1800+3600)");
  assert.equal(metrics.cpu_seconds, 18000, "sub-job cput summed (5400+12600)");
  assert.equal(metrics.ncpus, 4, "per-task shape (max sub-job ncpus)");
  assert.equal(metrics.gpu_hours, 0);
  // aggregate cput 18000 over aggregate core-seconds 21600 = 83.3% efficiency.
  assert.equal(metrics.cpu_efficiency_percent, 83.3);
  assert.equal(metrics.mem, "2097152kb", "peak per-task RSS across sub-jobs");
});

test("parsePbsArrayUsage returns null when only the array parent (no sub-job usage) is present", () => {
  assert.equal(parsePbsArrayUsage("Job Id: 4150[].hpc-head01\n    job_state = F\n    Resource_List.ncpus = 4\n"), null);
});

test("parseQstatUsageMetrics dispatches: array sums sub-jobs, plain reads the single record", () => {
  assert.equal(parseQstatUsageMetrics(ARRAY_SUBJOBS, true).core_hours, 6);
  const single = parseQstatUsageMetrics(FINISHED_GPU_JOB, false);
  assert.equal(single.core_hours, computeUsageMetrics(parsePbsUsage(FINISHED_GPU_JOB)).core_hours);
});
