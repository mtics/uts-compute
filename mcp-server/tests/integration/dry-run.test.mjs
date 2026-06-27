import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listProfiles, redactProfile, validateProfiles } from "../../dist/core/config.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { planTransfer } from "../../dist/ops/data/transfer.js";
import { listTemplates } from "../../dist/ops/catalog/templates.js";
import { readExample, readTransferExample, runtimeRoot } from "../helpers/index.mjs";

function tempAuditDir() {
  // Anchored on the per-process isolated runtimeRoot (Bug P2), not the plugin/repo dir.
  const dir = path.join(runtimeRoot, `test-runs-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("profiles can be listed, redacted, and validated", () => {
  const profiles = listProfiles();
  assert.equal(profiles.length, 4);

  const redacted = redactProfile(profiles[0]);
  assert.equal(redacted.profile_id, "uts-hpc-account-a");
  assert.equal("host_alias" in redacted.login, false);
  assert.equal(redacted.login.has_host_alias, true);
  assert.equal(redacted.login.has_identity_file_ref, false);
  assert.equal(redacted.login.has_keychain_ref, false);
  assert.equal(redacted.defaults.has_workspace, true);

  const validation = validateProfiles();
  assert.equal(validation.every((result) => result.valid), true);
});

test("templates catalog includes all M1 dry-run templates", () => {
  const ids = listTemplates().map((template) => template.id).sort();
  assert.deepEqual(ids, ["ihpc-background", "pbs-array", "pbs-cpu", "pbs-gpu", "transfer-rsync"]);
});

test("jobs.plan renders deterministic UTS HPC CPU PBS script and audit record", () => {
  const auditDir = tempAuditDir();
  const plan = planJob(readExample("hpc-cpu.json"), { auditDir });

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.template, "pbs-cpu");
  assert.match(plan.script, /#PBS -q smallq/);
  assert.match(plan.script, /#PBS -l ncpus=2/);
  assert.match(plan.script, /python train\.py --epochs 1/);
  assert.ok(plan.audit_path);
  assert.equal(fs.existsSync(plan.audit_path), true);
});

// Defense-in-depth half of the P0 zero-log / instant-fail fix: every rendered PBS body must self-heal
// the missing-workdir `cd` by creating the workdir between `set -euo pipefail` and `cd "<workdir>"`.
// (This does NOT fix zero-logs — PBS opens -o/-e before the script runs — but the pre-qsub remote
// mkdir in jobs.submit does; here we only pin the in-script idempotent mkdir + its ordering.)
for (const [exampleName, expectedTemplate] of [
  ["hpc-cpu.json", "pbs-cpu"],
  ["hpc-gpu.json", "pbs-gpu"],
  ["hpc-array.json", "pbs-array"]
]) {
  test(`jobs.plan renders ${expectedTemplate} with an in-script mkdir -p "<workdir>" BEFORE cd "<workdir>"`, () => {
    const plan = planJob(readExample(exampleName), { auditDir: tempAuditDir(), writeAudit: false });
    assert.equal(plan.template, expectedTemplate);
    const workdir = plan.normalized_job_spec.workdir;
    const mkdirLine = `mkdir -p "${workdir}"`;
    const cdLine = `cd "${workdir}"`;
    const mkdirIdx = plan.script.indexOf(mkdirLine);
    const cdIdx = plan.script.indexOf(cdLine);
    assert.notEqual(mkdirIdx, -1, `expected ${mkdirLine} in rendered script`);
    assert.notEqual(cdIdx, -1, `expected ${cdLine} in rendered script`);
    assert.ok(mkdirIdx < cdIdx, "mkdir must precede cd so the cd lands in an existing dir under set -e");
    // It sits after the safety prelude, not before it.
    assert.ok(plan.script.indexOf("set -euo pipefail") < mkdirIdx, "mkdir must come after set -euo pipefail");
  });
}

// P0 run-id grammar: a real campaign run_id (mixed case + underscores + a dot) is admitted by
// assertSafeRunId (core/ids.ts) AND must now pass schema validation end-to-end. Before the schema
// sync this planned through assertSafeRunId but DIED at assertJobSpec (input) / assertPlannedJob
// (output) because job-spec/planned-job schemas still carried the old lowercase-hyphen-only grammar.
test("jobs.plan accepts a real campaign run_id with mixed case, underscores, and a dot end-to-end", () => {
  const job = readExample("hpc-cpu.json");
  job.run_id = "MMPFedRec_Cards_lr0.001_mainhpo";
  job.workdir = "/shared/homes/${USER}/experiments/MMPFedRec_Cards_lr0.001_mainhpo";
  // planJob runs assertJobSpec (job-spec.schema.json) on input and persists/validates the planned-job
  // artifact (planned-job.schema.json) — both must accept this run_id or this throws.
  const plan = planJob(job, { auditDir: tempAuditDir(), writeAudit: false });
  assert.equal(plan.run_id, "MMPFedRec_Cards_lr0.001_mainhpo");
  assert.equal(plan.normalized_job_spec.run_id, "MMPFedRec_Cards_lr0.001_mainhpo");
});

test("jobs.plan defaults a queue-less GPU job to a real GPU queue (small_gpuq), not the stale routing gpuq", () => {
  // The live cluster exposes small_gpuq/med_gpuq/large_gpuq (qstat), not a bare routing gpuq; a
  // queue-less GPU job must default to a REAL queue so plan and submit-time conformance (which checks
  // the rendered queue against the live snapshot) agree.
  const plan = planJob(readExample("hpc-gpu.json"), { auditDir: tempAuditDir(), writeAudit: false });

  assert.equal(plan.template, "pbs-gpu");
  assert.equal(plan.normalized_job_spec.resources.queue, "small_gpuq");
  assert.match(plan.script, /#PBS -q small_gpuq/);
  // CETUS GPU jobs require the PBS chunk/select syntax (-l select=N:ncpus=:ngpus=:mem=). The old
  // separate -l ncpus= / -l mem= / -l ngpus= form never binds the GPU request to a vnode → stuck in
  // queue forever (hpc-gpu.json: ncpus 8, ngpus 1, mem 32).
  assert.match(plan.script, /#PBS -l select=1:ncpus=8:ngpus=1:mem=32gb/);
  assert.doesNotMatch(plan.script, /#PBS -l ncpus=/);
  assert.doesNotMatch(plan.script, /#PBS -l ngpus=/);
  assert.doesNotMatch(plan.script, /#PBS -l mem=/);
  assert.match(plan.script, /#PBS -l walltime=/);
  assert.equal(plan.approval.required, true);
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("GPU")));
});

test("jobs.plan respects an explicit GPU queue and renders it (does not clobber to gpuq)", () => {
  // Regression: the planner must NOT override an explicitly-requested GPU queue, and the GPU template
  // must render the ACTUAL queue — otherwise plan (gpuq) and submit-time conformance (live *_gpuq) disagree.
  const job = readExample("hpc-gpu.json");
  job.run_id = "dry-run-hpc-gpu-explicit";
  job.resources.queue = "med_gpuq";
  const plan = planJob(job, { auditDir: tempAuditDir(), writeAudit: false });

  assert.equal(plan.normalized_job_spec.resources.queue, "med_gpuq");
  assert.match(plan.script, /#PBS -q med_gpuq/);
  assert.doesNotMatch(plan.script, /#PBS -q gpuq\s/);
});

test("jobs.plan renders PBS array metadata deterministically", () => {
  const plan = planJob(readExample("hpc-array.json"), { auditDir: tempAuditDir(), writeAudit: false });

  assert.equal(plan.template, "pbs-array");
  assert.match(plan.script, /#PBS -J 0-4%2/);
  assert.equal(plan.approval.required, true);
});

test("jobs.plan records M3e approval reasons for high-risk resource requests", () => {
  const job = readExample("hpc-array.json");
  job.run_id = "approval-policy-array";
  job.workdir = "/shared/homes/${USER}/experiments/approval-policy-array";
  job.resources.ncpus = 32;
  job.resources.memory_gb = 128;
  job.resources.walltime = "48:00:00";
  job.resources.array = {
    start: 0,
    end: 19,
    max_concurrent: 6
  };

  const plan = planJob(job, { auditDir: tempAuditDir(), writeAudit: false });

  assert.equal(plan.approval.required, true);
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("High CPU request: 32 CPUs")));
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("High memory request: 128 GB")));
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("Long walltime: 48:00:00")));
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("Array job with 20 tasks")));
  assert.ok(plan.approval.reasons.some((reason) => reason.includes("Concurrent array execution: 6 tasks")));
});

test("jobs.plan renders iHPC supervised background dry-run without remote side effects", () => {
  const plan = planJob(readExample("ihpc-background.json"), { auditDir: tempAuditDir(), writeAudit: false });

  assert.equal(plan.template, "ihpc-background");
  assert.deepEqual(plan.command_argv, ["python", "interactive_experiment.py", "--quick"]);
  assert.match(plan.script, /M3c live start uses the MCP Python supervisor/);
  assert.doesNotMatch(plan.script, /nohup|bash -lc/);
  assert.match(plan.warnings.join("\n"), /no SSH, qsub, cnode, rsync, or remote writes/);
});

test("jobs.plan rejects profile/platform mismatches before rendering", () => {
  const job = readExample("hpc-cpu.json");
  job.profile_id = "uts-ihpc-account-a";

  assert.throws(() => planJob(job, { writeAudit: false }), /Profile uts-ihpc-account-a is for uts-ihpc/);
});

test("jobs.plan rejects workdirs outside declared profile roots", () => {
  const job = readExample("hpc-cpu.json");
  job.workdir = "/tmp/not-an-approved-remote-root";

  assert.throws(() => planJob(job, { writeAudit: false }), /workdir must be inside profile workspace or scratch/);
});

test("jobs.plan rejects unsafe workdir shell characters", () => {
  const job = readExample("hpc-cpu.json");
  job.workdir = "/shared/homes/${USER}/experiments/$(touch bad)";

  assert.throws(() => planJob(job, { writeAudit: false }), /workdir contains shell-active/);
});

test("transfers.plan renders rsync text without executing transfers", () => {
  const plan = planTransfer(readTransferExample("upload.json"));

  assert.equal(plan.mode, "dry-run");
  assert.match(plan.script, /rsync -avh --progress --checksum/);
  assert.doesNotMatch(plan.script, /--delete/);
  assert.match(plan.warnings.join("\n"), /does not run rsync/);
});

test("redactCommand removes common secret spellings and URL credentials", async () => {
  const { redactCommand } = await import("../../dist/core/audit.js");

  assert.equal(
    redactCommand("python train.py token=abc password=def api_key=sk-secret --secret top --otp=123"),
    "python train.py token=<redacted> password=<redacted> api_key=<redacted> --secret <redacted> --otp=<redacted>"
  );
  assert.equal(
    redactCommand("curl https://user:pass@example.test/path"),
    "curl https://user:<redacted>@example.test/path"
  );
});

test("audit records cannot be written outside the project runtime directory", async () => {
  const { buildRunRecord, writeRunRecord } = await import("../../dist/core/audit.js");
  const record = buildRunRecord(readExample("hpc-cpu.json"), "test");

  assert.throws(() => writeRunRecord(record, os.tmpdir()), /Audit directory must stay inside/);
});

test("jobs.plan interpolates the PBS command body raw — shell metacharacters are intentionally allowed", () => {
  // The PBS job body is a shell script; the trust boundary is the approval / live-quota gate, not
  // command sanitization. A command with ; && $(...) must render verbatim into the rendered script.
  const job = readExample("hpc-cpu.json");
  job.run_id = "shell-metachars";
  job.command = "python train.py && echo $(date) ; tail -n1 log.txt";
  const plan = planJob(job, { auditDir: tempAuditDir(), writeAudit: false });
  assert.match(plan.script, /python train\.py && echo \$\(date\) ; tail -n1 log\.txt/);
});

test("jobs.plan still rejects #PBS directive injection smuggled through the command", () => {
  const job = readExample("hpc-cpu.json");
  job.run_id = "pbs-inject";
  job.command = "python train.py\n#PBS -l walltime=999:00:00";
  assert.throws(() => planJob(job, { writeAudit: false }), /must not inject PBS directives/);
});
