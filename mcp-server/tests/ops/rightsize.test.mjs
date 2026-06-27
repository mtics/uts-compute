import assert from "node:assert/strict";
import test from "node:test";
import { rightsizeProject } from "../../dist/ops/quotas/rightsize.js";

function rec(requested, usage) {
  return {
    run_id: "r",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    remote_job_id: "r.hpc",
    project: "alpha",
    status: "finished",
    submission: { account_label: "A", cluster: "cetus", requested, submitted_at: "2026-06-15T00:00:00.000Z" },
    usage,
    created_at: "2026-06-15T00:00:00.000Z",
    updated_at: "2026-06-15T00:00:00.000Z",
    events: []
  };
}

test("rightsizeProject flags over-requested memory and walltime from history", () => {
  const records = [
    rec(
      { memory_gb: 64, walltime: "08:00:00", ncpus: 8 },
      { walltime_seconds: 2400, mem_gb: 6, ncpus: 8, ngpus: 0, core_hours: 16, gpu_hours: 0, cpu_efficiency_percent: 85 }
    ),
    rec(
      { memory_gb: 64, walltime: "08:00:00", ncpus: 8 },
      { walltime_seconds: 3000, mem_gb: 7, ncpus: 8, ngpus: 0, core_hours: 20, gpu_hours: 0, cpu_efficiency_percent: 80 }
    )
  ];
  const report = rightsizeProject("alpha", records);
  assert.equal(report.samples, 2);
  assert.equal(report.mem_gb.used_peak, 7);
  assert.equal(report.mem_gb.requested_typical, 64);
  assert.ok(report.mem_gb.headroom_ratio >= 9);
  assert.match(report.mem_gb.recommendation, /over-request/i);
  assert.match(report.walltime_hours.recommendation, /over-request/i);
  assert.equal(report.cpu_efficiency_percent.median, 82.5);
});

test("rightsizeProject reports no samples gracefully", () => {
  const report = rightsizeProject("empty", []);
  assert.equal(report.samples, 0);
  assert.equal(report.mem_gb.recommendation, "insufficient data");
  assert.equal(report.gpus.recommendation, "insufficient data");
  assert.ok(report.notes.length > 0);
});

test("rightsizeProject flags over-requested GPUs from history", () => {
  const records = [
    rec(
      { memory_gb: 32, walltime: "04:00:00", ncpus: 8, ngpus: 4 },
      { walltime_seconds: 3600, mem_gb: 20, ncpus: 8, ngpus: 1, core_hours: 8, gpu_hours: 1, cpu_efficiency_percent: 70 }
    ),
    rec(
      { memory_gb: 32, walltime: "04:00:00", ncpus: 8, ngpus: 4 },
      { walltime_seconds: 3600, mem_gb: 22, ncpus: 8, ngpus: 2, core_hours: 8, gpu_hours: 2, cpu_efficiency_percent: 72 }
    )
  ];
  const report = rightsizeProject("alpha", records);
  assert.equal(report.gpus.requested_typical, 4);
  assert.equal(report.gpus.used_peak, 2);
  assert.equal(report.gpus.headroom_ratio, 2);
  assert.match(report.gpus.recommendation, /over-request/i);
});

test("rightsizeProject reports insufficient GPU data for CPU-only runs", () => {
  const records = [
    rec(
      { memory_gb: 64, walltime: "08:00:00", ncpus: 8 },
      { walltime_seconds: 2400, mem_gb: 6, ncpus: 8, ngpus: 0, core_hours: 16, gpu_hours: 0, cpu_efficiency_percent: 85 }
    )
  ];
  const report = rightsizeProject("alpha", records);
  assert.equal(report.gpus.recommendation, "insufficient data");
});
