import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import { cancelJob, getJobLogs, getJobStatus } from "../../dist/ops/jobs/jobs.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import {
  repoRoot,
  readExample,
  tempRuntimeDir,
  writeQuotaSnapshot,
  writeResolvedHpcConfig,
  resolvedHpcWorkdir
} from "../helpers/index.mjs";

// The live submit step uses the RESOLVED-user HPC profile (user@host alias) so the workdir is a concrete
// path — jobs.submit now fails closed on a still-literal ${USER}. configPath is threaded through submit
// AND the downstream status/logs/cancel calls so the same profile (and resolved log paths) is used end to
// end, matching the real live contract.
async function submittedHpcRun(runId = "ops-hpc-run") {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const approvalDir = tempRuntimeDir("test-approvals");
  const configPath = writeResolvedHpcConfig("jobs");
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.workdir = resolvedHpcWorkdir(runId);
  const plan = planJob(job, { planDir, auditDir, configPath });
  const quotaSnapshotId = `quota-${runId}-2026-06-15T00-00-00-000Z`;
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());
  const submitRequest = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      operation: "jobs.submit",
      planHash: plan.plan_hash,
      quotaSnapshotId
    },
    { approvalDir, now }
  ).approval;
  const submitApproval = decideApproval(
    {
      approvalId: submitRequest.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      confirmationToken: "ops-token"
    },
    { approvalDir, now, confirmationToken: "ops-token" }
  ).approval;
  await submitJob(
    { runId: plan.run_id, approvalId: submitApproval.approval_id },
    {
      planDir,
      auditDir,
      approvalDir,
      configPath,
      now,
      executor: async () => ({ exitCode: 0, stdout: "4321.hpc\n", stderr: "" })
    }
  );
  return { plan, planDir, auditDir, approvalDir, quotaSnapshotId, submitApproval, configPath, now };
}

function approvedCancel(fixture, now = fixture.now) {
  const requested = requestApproval(
    {
      runId: fixture.plan.run_id,
      profileId: fixture.plan.profile_id,
      platform: fixture.plan.platform,
      operation: "jobs.cancel",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      reasons: ["User requested explicit cancellation"],
      commandSummary: `qdel run ${fixture.plan.run_id}`
    },
    { approvalDir: fixture.approvalDir, now }
  ).approval;
  return decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      confirmationToken: "ops-token"
    },
    { approvalDir: fixture.approvalDir, now, confirmationToken: "ops-token" }
  ).approval;
}

test("jobs.status queries qstat -f for the run record job id and updates local status", async () => {
  const fixture = await submittedHpcRun("ops-status");
  const calls = [];
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async (program, args, timeoutMs) => {
        calls.push({ program, args, timeoutMs });
        assert.equal(program, "ssh");
        assert.deepEqual(args.slice(-3), ["qstat", "-f", "4321.hpc"]);
        return { exitCode: 0, stdout: "Job Id: 4321.hpc\n    job_state = R\n", stderr: "" };
      }
    }
  );

  assert.equal(result.status.status, "running");
  assert.equal(result.status.scheduler_state, "R");
  assert.equal(result.status.command.args.includes("uts-hpc"), false);
  assert.equal(result.status.command.remote_argv.at(-1), "<remote-job-id>");
  assert.ok(result.status.evidence_path);
  assert.equal(calls.length, 1);

  const runRecord = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(runRecord.status, "running");
  assert.equal(runRecord.events.at(-1).kind, "pbs-status");
  assert.equal(runRecord.events.at(-1).artifact_path, result.status.evidence_path);
});

test("jobs.status maps the previously-unmapped PBS states M (moved), U (user-suspend), X (finished)", async () => {
  // These valid PBS Pro states fell through to 'unknown' before. M = job moved/transiting between
  // queues (in-flight, like T); U = suspended by workstation user activity (like S); X = finished/
  // expired historical record (like F).
  const cases = [
    { state: "M", expected: "submitted" },
    { state: "U", expected: "running" },
    { state: "X", expected: "finished" }
  ];
  for (const { state, expected } of cases) {
    const fixture = await submittedHpcRun(`ops-state-${state.toLowerCase()}`);
    const result = await getJobStatus(
      { runId: fixture.plan.run_id },
      {
        auditDir: fixture.auditDir,
        configPath: fixture.configPath,
        now: new Date("2026-06-15T00:05:00.000Z"),
        executor: async () => ({ exitCode: 0, stdout: `Job Id: 4321.hpc\n    job_state = ${state}\n`, stderr: "" })
      }
    );
    assert.equal(result.status.status, expected, `PBS state ${state} should map to ${expected}`);
    assert.equal(result.status.scheduler_state, state);
  }
});

test("jobs.status bumps the run-record rev by exactly 1 per poll (no stray double-write)", async () => {
  const fixture = await submittedHpcRun("ops-status-rev");
  const recordPath = path.join(fixture.auditDir, `${fixture.plan.run_id}.json`);
  const revBefore = JSON.parse(fs.readFileSync(recordPath, "utf8")).rev;

  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({ exitCode: 0, stdout: "Job Id: 4321.hpc\n    job_state = R\n", stderr: "" })
    }
  );

  const revAfter = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8")).rev;
  // A single poll is one transactional write: the status reconcile must advance rev by exactly 1,
  // not 2 (the old stray updateRunRecord after updateRunStatus double-bumped it).
  assert.equal(revAfter, revBefore + 1);
});

test("jobs.status maps completed nonzero PBS exit status to failed", async () => {
  const fixture = await submittedHpcRun("ops-status-failed");
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({
        exitCode: 0,
        stdout: "Job Id: 4321.hpc\n    job_state = C\n    Exit_status = 2\n",
        stderr: ""
      })
    }
  );

  assert.equal(result.status.status, "failed");
  const runRecord = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(runRecord.status, "failed");
});

test("jobs.status records a qstat failure as a non-destructive observation_failed with redacted stderr", async () => {
  // The run is already in a DEFINITE 'submitted' state; a transient qstat failure is an INDETERMINATE
  // observation and must NOT regress the ledger to 'unknown' (audit P0). It is logged as evidence only.
  const fixture = await submittedHpcRun("ops-status-qstat-failure");
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "qstat failed token=scheduler-secret\n"
      })
    }
  );

  // The definite prior status survives the failed probe; the summary still reports the probe failure.
  assert.equal(result.status.status, "submitted");
  assert.match(result.status.summary, /qstat failed/);
  assert.doesNotMatch(result.status.summary, /scheduler-secret/);
  const evidence = fs.readFileSync(result.status.evidence_path, "utf8");
  assert.doesNotMatch(evidence, /scheduler-secret/);
  assert.match(evidence, /token=<redacted>/);

  const runRecord = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(runRecord.status, "submitted");
  const failEvent = runRecord.events.at(-1);
  assert.equal(failEvent.kind, "observation_failed");
  assert.match(failEvent.summary, /kept prior status 'submitted'/);
  assert.doesNotMatch(JSON.stringify(runRecord.events), /scheduler-secret/);
});

test("jobs.status surfaces a network_hint + error_kind when the SSH probe is VPN-down unreachable", async () => {
  const { NETWORK_DROP_HINT } = await import("../../dist/lib/net-errors.js");
  const fixture = await submittedHpcRun("ops-status-vpn-down");
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({
        exitCode: 255,
        stdout: "",
        stderr: "ssh: connect to host hpc-host01 port 22: Operation timed out\n"
      })
    }
  );

  // Probe was indeterminate, so the definite 'submitted' status is preserved (audit P0) — but now the
  // operator gets an actionable VPN hint instead of a cryptic "qstat failed".
  assert.equal(result.status.status, "submitted");
  assert.equal(result.status.error_kind, "unreachable");
  assert.equal(result.status.network_hint, NETWORK_DROP_HINT);
});

test("jobs.status sets no network_hint when qstat ran and the job simply finished", async () => {
  const fixture = await submittedHpcRun("ops-status-no-hint");
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({ exitCode: 0, stdout: "Job Id: x\n    job_state = R\n", stderr: "" })
    }
  );
  assert.equal(result.status.status, "running");
  assert.equal(result.status.network_hint, undefined);
  assert.equal(result.status.error_kind, undefined);
});

test("jobs.status falls back to qstat -x for a finished job and reports terminal status", async () => {
  const fixture = await submittedHpcRun("ops-status-finished");
  const calls = [];
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:30:00.000Z"),
      executor: async (_program, args) => {
        calls.push(args);
        if (args.includes("-x")) {
          return { exitCode: 0, stdout: "Job Id: 4321.hpc\n    job_state = F\n    Exit_status = 0\n", stderr: "" };
        }
        return {
          exitCode: 153,
          stdout: "",
          stderr: "qstat: 4321.hpc Job has finished, use -x or -H to obtain historical job information\n"
        };
      }
    }
  );

  assert.equal(result.status.status, "finished");
  assert.equal(result.status.scheduler_state, "F");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("-x") && calls[1].at(-1) === "4321.hpc");
});

test("jobs.status reports a nonzero-exit finished job as failed via qstat -x", async () => {
  const fixture = await submittedHpcRun("ops-status-failed");
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:30:00.000Z"),
      executor: async (_program, args) => {
        if (args.includes("-x")) {
          return { exitCode: 0, stdout: "Job Id: 4321.hpc\n    job_state = F\n    Exit_status = 1\n", stderr: "" };
        }
        return { exitCode: 35, stdout: "", stderr: "qstat: 4321.hpc Job has finished, use -x or -H\n" };
      }
    }
  );

  assert.equal(result.status.status, "failed");
});

test("jobs.submit freezes submission context (account, cluster, queue, requested resources) into the run record", async () => {
  const fixture = await submittedHpcRun("ops-submission-ctx");
  const record = JSON.parse(fs.readFileSync(path.join(fixture.auditDir, `${fixture.plan.run_id}.json`), "utf8"));
  const resources = fixture.plan.normalized_job_spec.resources;
  assert.ok(record.submission, "submission block present");
  assert.equal(typeof record.submission.account_label, "string");
  assert.ok(record.submission.account_label.length > 0);
  assert.equal(typeof record.submission.cluster, "string");
  assert.equal(record.submission.queue, resources.queue);
  assert.equal(record.submission.requested.ncpus, resources.ncpus);
  assert.equal(record.submission.requested.memory_gb, resources.memory_gb);
  assert.equal(record.submission.requested.walltime, resources.walltime);
});

test("jobs.status parses exec_host and resources_used into node and usage", async () => {
  const fixture = await submittedHpcRun("ops-status-usage");
  const result = await getJobStatus(
    { runId: fixture.plan.run_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:05:00.000Z"),
      executor: async () => ({
        exitCode: 0,
        stdout:
          "Job Id: 4321.hpc\n    job_state = R\n    exec_host = node07/0*2\n    resources_used.walltime = 01:00:00\n    resources_used.ncpus = 2\n    resources_used.cput = 01:30:00\n    resources_used.mem = 1048576kb\n",
        stderr: ""
      })
    }
  );

  assert.equal(result.status.status, "running");
  assert.equal(result.status.node, "node07");
  assert.ok(result.status.usage);
  assert.equal(result.status.usage.core_hours, 2);
  assert.equal(result.status.usage.cpu_efficiency_percent, 75);

  const record = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(record.submission.node, "node07");
});

test("jobs.logs tails only bounded stdout and stderr paths from the saved PBS plan", async () => {
  const fixture = await submittedHpcRun("ops-logs");
  const calls = [];
  const result = await getJobLogs(
    { runId: fixture.plan.run_id, maxBytes: 2048 },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:06:00.000Z"),
      executor: async (program, args) => {
        calls.push({ program, args });
        assert.equal(program, "ssh");
        assert.equal(args.at(-5), "tail");
        assert.equal(args.at(-4), "-c");
        assert.equal(args.at(-3), "2048");
        assert.equal(args.at(-2), "--");
        // The PBS log paths are FULLY RESOLVED (${USER} substituted at plan time) — exactly what the live
        // submit renders into -o/-e and what jobs.logs tails. No literal ${USER} survives.
        assert.match(args.at(-1), /^\/shared\/homes\/u00000001\/experiments\/ops-logs\/logs\/ops-logs\.(out|err)$/);
        return { exitCode: 0, stdout: "epoch=1 token=secret-value\n", stderr: "" };
      }
    }
  );

  assert.equal(result.logs.streams.length, 2);
  assert.equal(result.logs.streams[0].content.includes("secret-value"), false);
  assert.equal(result.logs.streams[0].command.remote_argv.at(-1), "<plan-log-path>");
  assert.ok(result.logs.evidence_path);
  assert.equal(calls.length, 2);

  const runRecord = JSON.parse(fs.readFileSync(result.logs.run_record_path, "utf8"));
  assert.equal(runRecord.events.at(-1).kind, "pbs-logs");
  assert.equal(runRecord.events.at(-1).artifact_path, result.logs.evidence_path);
});

test("jobs.logs preserves failed stream status and redacts tail stderr", async () => {
  const fixture = await submittedHpcRun("ops-log-failure");
  const result = await getJobLogs(
    { runId: fixture.plan.run_id, stream: "stdout", maxBytes: 1024 },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      now: new Date("2026-06-15T00:06:00.000Z"),
      executor: async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "tail could not read log Authorization: Bearer abcdefghijklmnop\n"
      })
    }
  );

  assert.equal(result.logs.streams.length, 1);
  assert.equal(result.logs.streams[0].status, "failed");
  assert.match(result.logs.streams[0].summary, /tail failed/);
  assert.doesNotMatch(result.logs.streams[0].summary, /abcdefghijklmnop/);
  assert.match(result.logs.streams[0].summary, /Bearer <redacted>/);
});

test("jobs.logs rejects tampered plan artifacts before remote log reads", async () => {
  const fixture = await submittedHpcRun("ops-log-tamper");
  const tampered = JSON.parse(fs.readFileSync(fixture.plan.plan_path, "utf8"));
  tampered.script = tampered.script.replace("#PBS -o", "#PBS -o /tmp/unsafe;rm -rf / #");
  fs.writeFileSync(fixture.plan.plan_path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  let calls = 0;

  await assert.rejects(
    () =>
      getJobLogs(
        { runId: fixture.plan.run_id },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          configPath: fixture.configPath,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /plan_hash|Unsafe/
  );
  assert.equal(calls, 0);
});

test("jobs.cancel requires a jobs.cancel approval and consumes it after qdel succeeds", async () => {
  const fixture = await submittedHpcRun("ops-cancel");
  const cancelApproval = approvedCancel(fixture);
  assert.notEqual(cancelApproval.approval_id, fixture.submitApproval.approval_id);
  assert.equal(cancelApproval.operation, "jobs.cancel");
  assert.ok(cancelApproval.reasons.some((reason) => reason.includes("Cancellation requires explicit approval")));
  const calls = [];

  const result = await cancelJob(
    { runId: fixture.plan.run_id, approvalId: cancelApproval.approval_id },
    {
      auditDir: fixture.auditDir,
      configPath: fixture.configPath,
      approvalDir: fixture.approvalDir,
      now: new Date("2026-06-15T00:07:00.000Z"),
      executor: async (program, args) => {
        calls.push({ program, args });
        assert.equal(program, "ssh");
        assert.deepEqual(args.slice(-2), ["qdel", "4321.hpc"]);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    }
  );

  assert.equal(result.cancellation.status, "cancelled");
  assert.equal(result.cancellation.command.remote_argv.at(-1), "<remote-job-id>");
  assert.equal(calls.length, 1);

  const runRecord = JSON.parse(fs.readFileSync(result.cancellation.run_record_path, "utf8"));
  assert.equal(runRecord.status, "cancelled");
  assert.equal(runRecord.events.at(-1).kind, "live-cancel");

  const consumed = readApproval(cancelApproval.approval_id, { approvalDir: fixture.approvalDir });
  assert.equal(consumed.operation, "jobs.cancel");
  assert.ok(consumed.used_at);
  assert.equal(consumed.consumed_by, "jobs.cancel:4321.hpc");
});

test("jobs.cancel leaves approval unconsumed when qdel fails", async () => {
  const fixture = await submittedHpcRun("ops-cancel-qdel-failure");
  const cancelApproval = approvedCancel(fixture);

  await assert.rejects(
    () =>
      cancelJob(
        { runId: fixture.plan.run_id, approvalId: cancelApproval.approval_id },
        {
          auditDir: fixture.auditDir,
          configPath: fixture.configPath,
          approvalDir: fixture.approvalDir,
          now: new Date("2026-06-15T00:07:00.000Z"),
          executor: async () => ({
            exitCode: 1,
            stdout: "",
            stderr: "qdel failed api_key=cancel-secret\n"
          })
        }
      ),
    /qdel cancellation failed/
  );

  const stillApproved = readApproval(cancelApproval.approval_id, { approvalDir: fixture.approvalDir });
  assert.equal(stillApproved.operation, "jobs.cancel");
  assert.equal(stillApproved.used_at, undefined);
});

test("jobs.cancel rejects submit approvals before qdel execution", async () => {
  const fixture = await submittedHpcRun("ops-cancel-wrong-approval");
  const submitApproval = JSON.parse(fs.readdirSync(fixture.approvalDir).map((name) => {
    return fs.readFileSync(path.join(fixture.approvalDir, name), "utf8");
  })[0]);
  let calls = 0;

  await assert.rejects(
    () =>
      cancelJob(
        { runId: fixture.plan.run_id, approvalId: submitApproval.approval_id },
        {
          auditDir: fixture.auditDir,
          configPath: fixture.configPath,
          approvalDir: fixture.approvalDir,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        }
      ),
    /not jobs.cancel|already been consumed/
  );
  assert.equal(calls, 0);
});

test("jobs.status and jobs.cancel reject iHPC or unsubmitted runs before command execution", async () => {
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const plan = planJob(readExample("ihpc-background.json"), { planDir, auditDir });
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await assert.rejects(() => getJobStatus({ runId: plan.run_id }, { auditDir, executor }), /remote_job_id/);
  await assert.rejects(
    () => cancelJob({ runId: plan.run_id, approvalId: "approval-dummy" }, { auditDir, executor }),
    /approval_id|remote_job_id/
  );
  assert.equal(calls, 0);
});
