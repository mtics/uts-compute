import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyFailure, diagnoseJob } from "../../dist/ops/jobs/diagnose.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { repoRoot, runtimeRoot } from "../helpers/index.mjs";

const NOW = new Date("2026-06-15T00:00:00.000Z");

function classifyLog(logText, status = "failed") {
  return classifyFailure({ status, logText });
}

test("classifyFailure maps each taxonomy category from log signals", () => {
  assert.equal(classifyLog("=>> PBS: job killed: walltime 3600 exceeded limit 3600").category, "session-timeout");
  assert.equal(classifyLog("slurmstepd: error: Out of memory; Killed").category, "resource-request");
  assert.equal(classifyLog("OSError: [Errno 122] Disk quota exceeded").category, "quota");
  assert.equal(classifyLog("ssh: connect to host x: Connection refused").category, "access");
  assert.equal(classifyLog("ModuleNotFoundError: No module named 'torch'").category, "environment");
  assert.equal(classifyLog("FileNotFoundError: [Errno 2] No such file or directory: '/data/x'").category, "data-path");
});

test("classifyFailure falls back to command for a generic traceback", () => {
  const d = classifyLog("Traceback (most recent call last):\n  ValueError: bad shape");
  assert.equal(d.category, "command");
  assert.equal(d.confidence, "medium");
  assert.match(d.next_action, /re-plan/i);
});

test("classifyFailure returns none for a clean finished run and unknown otherwise", () => {
  assert.equal(classifyLog("epoch 1 done\nsaved checkpoint\n", "finished").category, "none");
  assert.equal(classifyLog("", "failed").category, "unknown");
});

test("classifyFailure handles a large pathological log without catastrophic backtracking", () => {
  // A long run of letters nearly matches the [A-Za-z.]{0,40}Error: rule but never completes it.
  // With an unbounded quantifier this backtracks quadratically (ReDoS); bounded, it stays linear.
  const pathological = "A".repeat(200000);
  const start = process.hrtime.bigint();
  const d = classifyFailure({ status: "failed", logText: pathological });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(d.category, "unknown");
  assert.ok(elapsedMs < 1000, `classification took ${elapsedMs}ms (possible ReDoS regression)`);
});

test("classifyFailure captures the matching log line as evidence", () => {
  const d = classifyLog("line one\nfatal: Out of memory here\nline three");
  assert.equal(d.category, "resource-request");
  assert.deepEqual(d.evidence, ["fatal: Out of memory here"]);
});

test("diagnoseJob combines status + logs into a classified diagnosis", async () => {
  const auditDir = path.join(runtimeRoot, `test-diag-${process.pid}-${Date.now()}`);
  const planDir = path.join(runtimeRoot, `test-diag-plans-${process.pid}-${Date.now()}`);
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(planDir, { recursive: true });

  const job = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs", "hpc-cpu.json"), "utf8"));
  const plan = planJob(job, { configPath: "profiles/profiles.example.yaml", auditDir, planDir, gitRunner: () => ({ ok: false, stdout: "" }) });

  // Mark the run submitted+finished with a remote job id so status/logs can run.
  const recordPath = plan.audit_path;
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  record.remote_job_id = "12345.pbs";
  record.status = "finished";
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  const executor = async (program, args) => {
    const remote = args.join(" ");
    if (remote.includes("qstat")) {
      return { exitCode: 0, stdout: "Job Id: 12345.pbs\n    job_state = F\n    Exit_status = 137\n", stderr: "" };
    }
    if (remote.includes("tail")) {
      return { exitCode: 0, stdout: "epoch 1\nslurmstepd: error: Out of memory: Killed process\n", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  };

  const { diagnosis } = await diagnoseJob(
    { runId: plan.run_id },
    { auditDir, planDir, executor, configPath: "profiles/profiles.example.yaml", now: NOW, timeoutMs: 5000 }
  );

  assert.equal(diagnosis.run_id, plan.run_id);
  assert.equal(diagnosis.platform, "uts-hpc");
  assert.equal(diagnosis.category, "resource-request");
  assert.equal(diagnosis.confidence, "high");
  assert.match(diagnosis.next_action, /jobs\.usage|memory/i);
});
