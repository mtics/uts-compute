import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { requestApproval, decideApproval, readApproval } from "../../dist/ops/approvals/approvals.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { submitJob } from "../../dist/ops/jobs/submit.js";
import { readRunRecord } from "../../dist/core/audit.js";
import {
  readExample,
  runtimeRoot,
  writeQuotaSnapshot,
  writeResolvedHpcConfig,
  resolvedHpcWorkdir,
  RESOLVED_HPC_ALIAS
} from "../helpers/index.mjs";

// submit.test.mjs keeps its own tempRuntimeDir: this variant intentionally OMITS the random-hex
// suffix the shared helper adds (prefix-pid-millis only). It anchors on the shared, per-process
// isolated runtimeRoot (Bug P2) so its dirs land inside the server's relocated `.uts-computing` root.
function tempRuntimeDir(prefix) {
  const dir = path.join(runtimeRoot, `${prefix}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// approvedPlan uses the RESOLVED-user HPC profile (a `user@host` host_alias), so the planner
// substitutes ${USER} at plan time and the normalized workdir is a concrete path — the real LIVE submit
// contract. jobs.submit now FAILS CLOSED on a still-literal ${USER} workdir (the zero-log root cause),
// so a bare-alias profile (which leaves ${USER} literal) is no longer a valid live-submit fixture.
function approvedPlan(jobName = "hpc-cpu.json", runId = undefined) {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const approvalDir = tempRuntimeDir("test-approvals");
  const configPath = writeResolvedHpcConfig("submit");
  const job = readExample(jobName);
  if (runId) {
    job.run_id = runId;
    // A concrete (resolved) workdir under the profile's workspace root — exactly what the planner emits
    // for a user@host alias. The literal-${USER} form is intentionally NOT used here anymore.
    job.workdir = resolvedHpcWorkdir(runId);
  }
  const plan = planJob(job, { planDir, auditDir, configPath });
  const quotaSnapshotId = `quota-submit-${plan.run_id}-2026-06-15T00-00-00-000Z`;
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());
  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId,
      reasons: plan.approval.reasons,
      commandSummary: plan.normalized_job_spec.command,
      resourceSummary: plan.normalized_job_spec.resources
    },
    { approvalDir, now }
  ).approval;
  const approval = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      confirmationToken: "submit-token"
    },
    { approvalDir, now, confirmationToken: "submit-token" }
  ).approval;

  return { plan, approval, planDir, auditDir, approvalDir, quotaSnapshotId, configPath, now };
}

test("jobs.submit submits an approved UTS HPC PBS plan through mocked ssh qsub stdin", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-hpc-cpu");
  const calls = [];
  const executor = async (program, args, timeoutMs, stdin) => {
    calls.push({ program, args, timeoutMs, stdin });
    assert.equal(program, "ssh");
    const remoteArgv = args.slice(args.indexOf(RESOLVED_HPC_ALIAS) + 1);
    // The pre-qsub mkdir runs first (no stdin); the qsub carries the PBS script on stdin.
    if (remoteArgv[0] === "mkdir") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    assert.equal(args.at(-1), "qsub");
    assert.match(stdin, /#PBS -q smallq/);
    assert.match(stdin, /python train\.py --epochs 1/);
    return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
  };

  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      configPath: fixture.configPath,
      now: fixture.now,
      executor
    }
  );

  assert.equal(result.submission.remote_job_id, "1234.hpc");
  assert.equal(result.submission.status, "submitted");
  assert.equal(result.submission.command.remote_argv.join(" "), "qsub");
  // The host alias is masked out of the returned command args.
  assert.equal(result.submission.command.args.includes(RESOLVED_HPC_ALIAS), false);
  // Two SSH calls now: the pre-qsub workdir/log_dir mkdir, then qsub.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.slice(calls[0].args.indexOf(RESOLVED_HPC_ALIAS) + 1)[0], "mkdir");
  assert.equal(calls[1].args.at(-1), "qsub");

  const runRecord = JSON.parse(fs.readFileSync(result.submission.run_record_path, "utf8"));
  assert.equal(runRecord.status, "submitted");
  assert.equal(runRecord.remote_job_id, "1234.hpc");
  assert.equal(runRecord.plan_hash, fixture.plan.plan_hash);
  assert.equal(runRecord.events.at(-1).kind, "live-submit");

  const consumed = readApproval(fixture.approval.approval_id, { approvalDir: fixture.approvalDir });
  assert.equal(consumed.state, "approved");
  assert.ok(consumed.used_at);
  assert.equal(consumed.consumed_by, "jobs.submit:1234.hpc");
});

test("jobs.submit creates log_dir + workdir over SSH BEFORE qsub (P0 zero-log / instant-fail fix)", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-mkdir-order");
  const workdir = fixture.plan.normalized_job_spec.workdir;
  const logDir = `${workdir}/logs`;
  const calls = [];
  const executor = async (program, args, timeoutMs, stdin) => {
    // The remote argv tail is everything after the host alias (the SSH transport flags precede it).
    const hostIdx = args.indexOf(RESOLVED_HPC_ALIAS);
    const remoteArgv = args.slice(hostIdx + 1);
    calls.push({ program, remoteArgv, stdin });
    if (remoteArgv[0] === "mkdir") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
  };

  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
    { planDir: fixture.planDir, auditDir: fixture.auditDir, approvalDir: fixture.approvalDir, configPath: fixture.configPath, now: fixture.now, executor }
  );

  assert.equal(result.submission.status, "submitted");
  // mkdir runs first, qsub second.
  assert.equal(calls.length, 2);
  assert.equal(calls[0].remoteArgv[0], "mkdir");
  assert.equal(calls[1].remoteArgv[0], "qsub");

  // The mkdir argv is the EXACT fixed shape with the derived log_dir + workdir, log_dir before workdir
  // (parent created first), both equal to the planner's <workdir>/logs and <workdir>.
  assert.deepEqual(calls[0].remoteArgv, ["mkdir", "-p", "--", logDir, workdir]);
  assert.equal(calls[0].remoteArgv[3], `${workdir}/logs`);
  assert.equal(calls[0].remoteArgv[4], workdir);

  // The created dirs are FULLY RESOLVED (${USER} substituted at plan time) and inside the profile's
  // workspace root — exactly what PBS opens for -o/-e. No literal ${USER} survives to mkdir or qsub.
  assert.ok(workdir.startsWith("/shared/homes/u00000001/experiments/"));
  assert.ok(logDir.startsWith("/shared/homes/u00000001/experiments/"));
  assert.equal(workdir.includes("${USER}"), false);

  // The qsub script cds to and writes -o/-e under the SAME paths the mkdir created.
  assert.match(calls[1].stdin, new RegExp(`cd "${workdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(calls[1].stdin, new RegExp(`#PBS -o ${logDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
});

test("jobs.submit fails closed when the pre-qsub mkdir fails: it THROWS and NEVER runs qsub", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-mkdir-fail");
  const calls = [];
  const executor = async (program, args) => {
    const hostIdx = args.indexOf(RESOLVED_HPC_ALIAS);
    const remoteArgv = args.slice(hostIdx + 1);
    calls.push(remoteArgv[0]);
    if (remoteArgv[0] === "mkdir") {
      return { exitCode: 1, stdout: "", stderr: "mkdir: cannot create directory: Permission denied" };
    }
    return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
  };

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
        { planDir: fixture.planDir, auditDir: fixture.auditDir, approvalDir: fixture.approvalDir, configPath: fixture.configPath, now: fixture.now, executor }
      ),
    /mkdir|create.*director|workdir|log_dir/i
  );
  // mkdir ran; qsub NEVER did.
  assert.deepEqual(calls, ["mkdir"]);

  // The durable record still reads "submitting" (set before mkdir) so a failed mkdir stays reconcilable
  // and never looks like a clean un-submitted job whose remote counterpart is orphaned.
  const runRecord = readRunRecord(fixture.plan.run_id, fixture.auditDir);
  assert.equal(runRecord.status, "submitting");
  assert.ok(!runRecord.remote_job_id);
});

test("jobs.submit accepts a PBS array job id (regression: array submit was misread as a failure)", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-array");
  const executor = async () => ({ exitCode: 0, stdout: "3852[].hpc-head01\n", stderr: "" });

  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
    { planDir: fixture.planDir, auditDir: fixture.auditDir, approvalDir: fixture.approvalDir, configPath: fixture.configPath, now: fixture.now, executor }
  );

  assert.equal(result.submission.status, "submitted");
  assert.equal(result.submission.remote_job_id, "3852[].hpc-head01");
  const runRecord = readRunRecord(fixture.plan.run_id, fixture.auditDir);
  assert.equal(runRecord.status, "submitted");
  assert.equal(runRecord.remote_job_id, "3852[].hpc-head01");
});

test("jobs.submit never drops the side effect: qsub exit 0 + unparseable id => a reconcile record, not a clean failure", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-unparsed");
  const executor = async () => ({ exitCode: 0, stdout: "qsub: weird output with no id\n", stderr: "" });

  await assert.rejects(
    submitJob(
      { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
      { planDir: fixture.planDir, auditDir: fixture.auditDir, approvalDir: fixture.approvalDir, configPath: fixture.configPath, now: fixture.now, executor }
    ),
    /did not return a safe PBS job id/
  );

  // The qsub already ran, so the record must carry the raw output for reconciliation (NOT vanish as a
  // clean failure that would invite a duplicate submit). jobs.track keys on submitting + no job id.
  const runRecord = readRunRecord(fixture.plan.run_id, fixture.auditDir);
  assert.equal(runRecord.status, "submitting");
  assert.ok(!runRecord.remote_job_id, "no job id was captured on the parse failure");
  assert.equal(runRecord.events.at(-1).kind, "live-submit-unparsed");
  assert.match(runRecord.events.at(-1).summary, /weird output with no id/);
});

test("jobs.submit rejects unapproved or already consumed approvals before command execution", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-reuse");
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
  };

  await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
    {
      planDir: fixture.planDir,
      auditDir: fixture.auditDir,
      approvalDir: fixture.approvalDir,
      configPath: fixture.configPath,
      now: fixture.now,
      executor
    }
  );
  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          configPath: fixture.configPath,
          now: fixture.now,
          executor
        }
      ),
    /already been consumed|only planned runs/
  );
  // First submit ran mkdir + qsub (2 SSH calls); the rejected re-submit ran NEITHER.
  assert.equal(calls, 2);
});

test("jobs.submit rejects non-submit approvals before command execution", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-wrong-operation");
  const requested = requestApproval(
    {
      runId: fixture.plan.run_id,
      profileId: fixture.plan.profile_id,
      platform: fixture.plan.platform,
      operation: "jobs.retry",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      reasons: ["Retry after environment fix"]
    },
    { approvalDir: fixture.approvalDir, now: fixture.now }
  ).approval;
  const retryApproval = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: fixture.plan.plan_hash,
      quotaSnapshotId: fixture.quotaSnapshotId,
      confirmationToken: "submit-token"
    },
    { approvalDir: fixture.approvalDir, now: fixture.now, confirmationToken: "submit-token" }
  ).approval;
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: retryApproval.approval_id },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          configPath: fixture.configPath,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
          }
        }
      ),
    /not jobs.submit/
  );
  assert.equal(calls, 0);
});

test("jobs.submit rejects approval plan hash mismatch before command execution", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-mismatch");
  const tampered = JSON.parse(fs.readFileSync(fixture.plan.plan_path, "utf8"));
  tampered.plan_hash = "0".repeat(64);
  fs.writeFileSync(fixture.plan.plan_path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          configPath: fixture.configPath,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
          }
        }
      ),
    /plan_hash/
  );
  assert.equal(calls, 0);
});

// A failed/cancelled run is NOT re-submittable directly — re-submit stays forbidden because retry.plan
// builds a fresh run_id + retry lineage + new plan_hash. But the guard error must NAME that re-run path
// (jobs.retry.plan / sweep.retry.plan) so the operator stops hand-resetting runs to 'planned'. This is the
// follow-up to the CETUS instant-fail incident: now that an instant-fail run reliably reaches 'failed',
// retry.plan is the supported adoption path.
for (const status of ["failed", "cancelled"]) {
  test(`jobs.submit guard on a ${status} run names jobs.retry.plan as the re-run path`, async () => {
    const fixture = approvedPlan("hpc-cpu.json", `submit-${status}-names-retry`);
    // Force the persisted run record into the terminal status before re-submit is attempted.
    const recordPath = path.join(fixture.auditDir, `${fixture.plan.run_id}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.status = status;
    fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    let calls = 0;

    await assert.rejects(
      () =>
        submitJob(
          { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
          {
            planDir: fixture.planDir,
            auditDir: fixture.auditDir,
            approvalDir: fixture.approvalDir,
            configPath: fixture.configPath,
            now: fixture.now,
            executor: async () => {
              calls += 1;
              return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
            }
          }
        ),
      (err) => {
        assert.match(err.message, /jobs\.retry\.plan/, "the guard must point a terminal run at jobs.retry.plan");
        assert.match(err.message, new RegExp(status), "the guard still reports the offending status");
        return true;
      }
    );
    // The guard rejects before any remote command runs.
    assert.equal(calls, 0);
  });
}

// Build an APPROVED plan using the BUNDLED bare-alias profile (host_alias = "uts-hpc", no user@), so the
// planner leaves a LITERAL ${USER} in normalized_job_spec.workdir — the exact unfixable-at-mkdir state
// the zero-log incident came from (PBS opens the literal ${USER} -o/-e path, the SSH login shell expands
// it for mkdir → two different dirs → zero logs again).
function approvedBareAliasPlan(runId) {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const approvalDir = tempRuntimeDir("test-approvals");
  const job = readExample("hpc-cpu.json");
  job.run_id = runId;
  job.workdir = `/shared/homes/\${USER}/experiments/${runId}`;
  // No configPath: the bundled example profile's bare "uts-hpc" alias leaves ${USER} unresolved.
  const plan = planJob(job, { planDir, auditDir });
  assert.ok(plan.normalized_job_spec.workdir.includes("${USER}"), "fixture must keep ${USER} literal");
  const quotaSnapshotId = `quota-bare-${plan.run_id}-2026-06-15T00-00-00-000Z`;
  writeQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now.toISOString());
  const requested = requestApproval(
    {
      runId: plan.run_id,
      profileId: plan.profile_id,
      platform: plan.platform,
      planHash: plan.plan_hash,
      quotaSnapshotId,
      reasons: plan.approval.reasons,
      commandSummary: plan.normalized_job_spec.command,
      resourceSummary: plan.normalized_job_spec.resources
    },
    { approvalDir, now }
  ).approval;
  const approval = decideApproval(
    {
      approvalId: requested.approval_id,
      decision: "approved",
      planHash: plan.plan_hash,
      quotaSnapshotId,
      confirmationToken: "submit-token"
    },
    { approvalDir, now, confirmationToken: "submit-token" }
  ).approval;
  return { plan, approval, planDir, auditDir, approvalDir, now };
}

// Item 1 (IMPORTANT): a LIVE UTS HPC PBS submit whose workdir still carries an unresolved ${USER} must
// FAIL CLOSED before any remote side effect. Otherwise the pre-qsub mkdir (SSH login shell expands
// ${USER}) and PBS's -o/-e open (literal ${USER}, PBS does NOT expand it) target DIFFERENT dirs and the
// zero-log incident silently recurs.
test("jobs.submit FAILS CLOSED on an unresolved ${USER} workdir: it THROWS and runs NO mkdir or qsub", async () => {
  const fixture = approvedBareAliasPlan("submit-unresolved-user");
  let calls = 0;
  await assert.rejects(
    () =>
      submitJob(
        { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
        {
          planDir: fixture.planDir,
          auditDir: fixture.auditDir,
          approvalDir: fixture.approvalDir,
          now: fixture.now,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "1234.hpc\n", stderr: "" };
          }
        }
      ),
    /unresolved|\$\{USER\}|user@host|fully[- ]resolved/i
  );
  // Neither the pre-qsub mkdir nor qsub ever ran — the guard fired BEFORE any executor call.
  assert.equal(calls, 0);
  // The durable record stays "submitting" (the marker is written before the guard) so it is reconcilable
  // and never looks like a clean planned job. No remote job id was ever recorded.
  const runRecord = readRunRecord(fixture.plan.run_id, fixture.auditDir);
  assert.equal(runRecord.status, "submitting");
  assert.ok(!runRecord.remote_job_id);
});

// Item 3 (NIT): the pre-qsub mkdir must leave a run-record event so an operator reconciling a failure
// between the "submitting" marker and qsub can see a mkdir was attempted.
test("jobs.submit records a pre-submit-mkdir audit event around the pre-qsub mkdir", async () => {
  const fixture = approvedPlan("hpc-cpu.json", "submit-mkdir-event");
  const executor = async (program, args, timeoutMs, stdin) => {
    const remoteArgv = args.slice(args.indexOf(RESOLVED_HPC_ALIAS) + 1);
    if (remoteArgv[0] === "mkdir") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "4242.hpc\n", stderr: "" };
  };

  const result = await submitJob(
    { runId: fixture.plan.run_id, approvalId: fixture.approval.approval_id },
    { planDir: fixture.planDir, auditDir: fixture.auditDir, approvalDir: fixture.approvalDir, configPath: fixture.configPath, now: fixture.now, executor }
  );
  assert.equal(result.submission.status, "submitted");

  const runRecord = readRunRecord(fixture.plan.run_id, fixture.auditDir);
  const mkdirEvent = runRecord.events.find((event) => event.kind === "pre-submit-mkdir");
  assert.ok(mkdirEvent, "expected a pre-submit-mkdir event on the run record");
  // It is recorded AFTER the submitting marker / live-submit-attempt and BEFORE the terminal live-submit.
  const kinds = runRecord.events.map((event) => event.kind);
  assert.ok(kinds.indexOf("live-submit-attempt") < kinds.indexOf("pre-submit-mkdir"));
  assert.ok(kinds.indexOf("pre-submit-mkdir") < kinds.lastIndexOf("live-submit"));
  // The redacted command names ssh + mkdir but leaks no real path/id.
  assert.match(mkdirEvent.redacted_command, /ssh <profile-host> mkdir/);
  assert.equal(mkdirEvent.redacted_command.includes("u00000001"), false);
  assert.equal(mkdirEvent.redacted_command.includes("/shared/homes"), false);
});

test("jobs.submit rejects iHPC plans without a valid approval before command execution", async () => {
  const planDir = tempRuntimeDir("test-plans");
  const auditDir = tempRuntimeDir("test-runs");
  const plan = planJob(readExample("ihpc-background.json"), { planDir, auditDir });
  // Satisfy the first-run onboarding gate (a captured quota snapshot counts) so this test exercises the
  // APPROVAL rejection it targets, rather than tripping the onboarding gate first. Previously it passed
  // only because of quota snapshots leaked into the shared repo .uts-computing by other tests (Bug P2).
  writeQuotaSnapshot(`quota-ihpc-noapproval-${plan.run_id}`, plan.profile_id, plan.platform, "2026-06-15T00:00:00.000Z");
  let calls = 0;

  await assert.rejects(
    () =>
      submitJob(
        { runId: plan.run_id, approvalId: "approval-dummy-0000000000000000-0000000000000000" },
        {
          planDir,
          auditDir,
          executor: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "ok\n", stderr: "" };
          }
        }
      ),
    /approval_id|Approval|ENOENT|no such file/
  );
  assert.equal(calls, 0);
});
