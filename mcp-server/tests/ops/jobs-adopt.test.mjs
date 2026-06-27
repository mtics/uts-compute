import assert from "node:assert/strict";
import test from "node:test";
import { readRunRecord, writeRunRecord } from "../../dist/core/audit.js";
import { adoptExternalRun, ihpcPidToRunRecord } from "../../dist/ops/jobs/adopt.js";
import { jobsHistory } from "../../dist/ops/jobs/history.js";
import { getJobLogs, getJobStatus } from "../../dist/ops/jobs/jobs.js";
import {
  tempRuntimeDir,
  writeResolvedHpcConfig,
  RESOLVED_HPC_USER
} from "../helpers/index.mjs";

const QSTAT = `Job Id: 4321.cetus\n    job_state = R\n    exec_host = node07/0*4\n    resources_used.walltime = 01:00:00\n    resources_used.ncpus = 4\n`;
const now = new Date("2026-06-20T10:00:00.000Z");

function pbsExecutor(stdout) {
  const calls = [];
  return {
    calls,
    exec: async (program, args, t) => {
      calls.push({ program, args, t });
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    }
  };
}

test("jobs.adopt (PBS) SSHes qstat and writes a discoverable record", async () => {
  const auditDir = tempRuntimeDir("adopt-pbs");
  const { exec, calls } = pbsExecutor(QSTAT);
  const res = await adoptExternalRun(
    { runId: "adopt-4321-cetus", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  assert.equal(res.adopted.run_id, "adopt-4321-cetus");
  assert.equal(res.adopted.status, "running");
  assert.equal(calls[0].program, "ssh");
  const onDisk = readRunRecord("adopt-4321-cetus", auditDir);
  assert.equal(onDisk.remote_job_id, "4321.cetus");
  assert.equal(onDisk.events[0].kind, "adopted-external");
});

test("jobs.adopt is idempotent for a matching re-adopt", async () => {
  const auditDir = tempRuntimeDir("adopt-idem");
  const { exec } = pbsExecutor(QSTAT);
  const first = await adoptExternalRun(
    { runId: "adopt-4321-cetus", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  const second = await adoptExternalRun(
    { runId: "adopt-4321-cetus", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  assert.equal(second.adopted.idempotent, true);
  assert.equal(first.adopted.run_id, second.adopted.run_id);
});

test("jobs.adopt refuses a conflicting remote_job_id on an existing run", async () => {
  const auditDir = tempRuntimeDir("adopt-conflict");
  const { exec } = pbsExecutor(QSTAT);
  await adoptExternalRun(
    { runId: "adopt-x", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  await assert.rejects(
    () =>
      adoptExternalRun(
        { runId: "adopt-x", profileId: "uts-hpc-account-a", remoteJobId: "9999.cetus" },
        { auditDir, executor: exec, now }
      ),
    /already exists|conflict/i
  );
});

test("jobs.adopt (iHPC) requires node+pid and writes a history-only record", async () => {
  const auditDir = tempRuntimeDir("adopt-ihpc");
  const res = await adoptExternalRun(
    { runId: "adopt-venus01-31245", profileId: "uts-ihpc-account-a", node: "venus01", pid: 31245 },
    { auditDir, now }
  );
  assert.equal(res.adopted.status, "running");
  const onDisk = readRunRecord("adopt-venus01-31245", auditDir);
  assert.equal(onDisk.remote_job_id, "ihpc-adopt-venus01-31245-31245");
  assert.equal(onDisk.platform, "uts-ihpc");
  assert.equal(onDisk.supervisor, undefined); // Phase 1: history-only, see scoping note
  assert.equal(onDisk.placement, undefined); // no placement supplied -> field absent
});

// An observe executor that answers BOTH probes the P2-a status path ships: the liveness os.kill probe
// and the node-usage nvidia-smi probe.
function observeExecutor({ alive = true } = {}) {
  const gpu = { ok: true, gpus: [{ index: 0, name: "Tesla T4", utilization_gpu_percent: 5, memory_used_mb: 10, memory_total_mb: 16000 }], errors: [] };
  return async (_program, _args, _t, stdin) => {
    if (typeof stdin === "string" && /os\.kill\(pid, 0\)/.test(stdin)) {
      return { exitCode: 0, stdout: `${JSON.stringify({ alive })}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: `${JSON.stringify(gpu)}\n`, stderr: "" };
  };
}

test("jobs.adopt (iHPC) persists scheduler-reported placement when given gpuIndex/hostname", async () => {
  const auditDir = tempRuntimeDir("adopt-ihpc-placement");
  const res = await adoptExternalRun(
    { runId: "adopt-venus01-31245", profileId: "uts-ihpc-account-a", node: "venus01", pid: 31245, gpuIndex: 1, hostname: "venus01" },
    { auditDir, now }
  );
  assert.equal(res.adopted.status, "running");
  const onDisk = readRunRecord("adopt-venus01-31245", auditDir);
  assert.deepEqual(onDisk.placement, { gpu_index: 1, hostname: "venus01", node_id: "venus01" });
  // P2-a: still no supervisor block, but jobs.status now OBSERVES (liveness + GPU) instead of throwing.
  const result = await getJobStatus(
    { runId: "adopt-venus01-31245" },
    { auditDir, executor: observeExecutor({ alive: true }) }
  );
  assert.equal(result.status.liveness, "alive");
  assert.deepEqual(result.status.placement, { gpu_index: 1, hostname: "venus01", node_id: "venus01" });
});

// Finding 5 (defense-in-depth): the adopted iHPC observed.node/pid is validated at READ time, but must
// ALSO be validated at WRITE time so a shell-metachar node or a pid<=1 can never be persisted into the
// `observed` block in the first place. These are refused at adopt time, before any record is written.
test("jobs.adopt (iHPC) refuses a shell-metachar node at write time", async () => {
  const auditDir = tempRuntimeDir("adopt-bad-node");
  await assert.rejects(
    () =>
      adoptExternalRun(
        { runId: "adopt-bad-node-1", profileId: "uts-ihpc-account-a", node: "venus01; rm -rf /", pid: 31245 },
        { auditDir, now }
      ),
    /node/i
  );
  // Nothing was persisted.
  assert.throws(() => readRunRecord("adopt-bad-node-1", auditDir));
});

test("jobs.adopt (iHPC) refuses a node that starts with a dash at write time", async () => {
  const auditDir = tempRuntimeDir("adopt-dash-node");
  await assert.rejects(
    () =>
      adoptExternalRun(
        { runId: "adopt-dash-node-1", profileId: "uts-ihpc-account-a", node: "-oProxyCommand=evil", pid: 31245 },
        { auditDir, now }
      ),
    /node/i
  );
  assert.throws(() => readRunRecord("adopt-dash-node-1", auditDir));
});

test("jobs.adopt (iHPC) refuses a pid <= 1 at write time", async () => {
  const auditDir = tempRuntimeDir("adopt-bad-pid");
  for (const pid of [1, 0, -5, 1.5]) {
    await assert.rejects(
      () =>
        adoptExternalRun(
          { runId: "adopt-bad-pid-1", profileId: "uts-ihpc-account-a", node: "venus01", pid },
          { auditDir, now }
        ),
      /pid/i,
      `pid ${pid} must be refused`
    );
  }
  assert.throws(() => readRunRecord("adopt-bad-pid-1", auditDir));
});

// ---------------------------------------------------------------------------------------------------
// Closed-world verification (Task 4): prove the adopted record opens the closed world for PBS and is
// honestly history-only for iHPC.
// ---------------------------------------------------------------------------------------------------

test("closed world: an adopted PBS run appears in jobs.history (the world is open)", async () => {
  const auditDir = tempRuntimeDir("adopt-cw-pbs");
  const { exec } = pbsExecutor(QSTAT);
  await adoptExternalRun(
    { runId: "adopt-4321-cetus", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  const history = jobsHistory({ auditDir });
  assert.ok(history.total >= 1, "adopted PBS run must be discoverable in jobs.history");
  const found = history.runs.find((run) => run.run_id === "adopt-4321-cetus");
  assert.ok(found, "the adopted PBS run_id must appear in the history listing");
  assert.equal(found.remote_job_id, "4321.cetus");
});

test("closed world (P2-a): an adopted iHPC run is discoverable AND observable (liveness + GPU)", async () => {
  const auditDir = tempRuntimeDir("adopt-cw-ihpc");
  await adoptExternalRun(
    { runId: "adopt-venus01-31245", profileId: "uts-ihpc-account-a", node: "venus01", pid: 31245 },
    { auditDir, now }
  );
  // Discoverable in history...
  const history = jobsHistory({ auditDir });
  assert.ok(
    history.runs.some((run) => run.run_id === "adopt-venus01-31245"),
    "the adopted iHPC run must appear in jobs.history"
  );
  // ...and jobs.status now OBSERVES it (read-only liveness + node GPU snapshot) instead of throwing the
  // supervisor-metadata limitation — foreign iHPC work is no longer invisible to the monitoring surface.
  const result = await getJobStatus(
    { runId: "adopt-venus01-31245" },
    { auditDir, executor: observeExecutor({ alive: true }) }
  );
  assert.equal(result.status.liveness, "alive");
  assert.equal(result.status.status, "running");
  assert.equal(result.status.node, "venus01");
  assert.equal(result.status.gpu_usage.status, "ok");
});

// --- Phase D (Feature B, spec §5b): a foreign iHPC job we only OBSERVED is history-only +
// not_lineage_proven; its read/cancel paths stay refused. ---

test("ihpcPidToRunRecord flags a foreign job not_lineage_proven / external_observed / unverified", () => {
  const rec = ihpcPidToRunRecord({
    runId: "adopt-foreign-1", profileId: "uts-ihpc-account-a", node: "venus01", pid: 9999,
    now: new Date("2026-06-20T10:00:00.000Z")
  });
  assert.equal(rec.adoption.terminal_record, "external_observed");
  assert.equal(rec.adoption.intent, "unverified");
  assert.equal(rec.adoption.lineage, "not_lineage_proven");
  // Still history-only: no supervisor block (so jobs.status/logs/cancel stay refused).
  assert.equal(rec.supervisor, undefined);
});

test("jobs.status on a not_lineage_proven iHPC record OBSERVES it (P2-a); logs/cancel stay observe-only", async () => {
  const auditDir = tempRuntimeDir("adopt-foreign-status");
  await adoptExternalRun(
    { runId: "adopt-foreign-2", profileId: "uts-ihpc-account-a", node: "venus01", pid: 9001 },
    { auditDir, now: new Date("2026-06-20T10:00:00.000Z") }
  );
  // P2-a: a foreign (not_lineage_proven) iHPC run is now OBSERVABLE via jobs.status — the win of the fix.
  const status = await getJobStatus(
    { runId: "adopt-foreign-2" },
    { auditDir, executor: observeExecutor({ alive: false }) }
  );
  assert.equal(status.status.liveness, "dead");
  assert.equal(status.status.status, "finished");
  // ...but logs (no supervisor log paths to read) stay refused with the clear observe-only message.
  await assert.rejects(
    () => getJobLogs({ runId: "adopt-foreign-2" }, { auditDir }),
    /observe-only|no supervisor log/i
  );
});

// ---------------------------------------------------------------------------------------------------
// P2-b: complete the adopted-PBS control chain — jobs.logs on an adopted PBS run (no saved plan) derives
// the stdout/stderr file paths from `qstat -f` (Output_Path / Error_Path, format `host:/abs/path`) and
// tails them via the existing bounded `tail -c ... -- <path>` allowlisted remote command.
// ---------------------------------------------------------------------------------------------------

// A `qstat -f` record carrying the PBS Output_Path / Error_Path attributes (host:/abs/path). The paths
// land inside the resolved profile root (/shared/homes/<RESOLVED_HPC_USER>/experiments/...).
const ADOPTED_LOGS_QSTAT = [
  "Job Id: 4321.cetus",
  "    job_state = R",
  "    exec_host = node07/0*4",
  `    Output_Path = cetus:/shared/homes/${RESOLVED_HPC_USER}/experiments/adopt-logs/job.out`,
  `    Error_Path = cetus:/shared/homes/${RESOLVED_HPC_USER}/experiments/adopt-logs/job.err`,
  ""
].join("\n");

// Adopt a PBS job under the RESOLVED-user HPC config (so the profile roots resolve to a concrete
// /shared/homes/<user>/... prefix the derived Output_Path can be confined to).
async function adoptedPbsRunWithLogs(auditDir, configPath, runId = "adopt-logs", remoteJobId = "4321.cetus") {
  const exec = async () => ({ exitCode: 0, stdout: ADOPTED_LOGS_QSTAT, stderr: "", timedOut: false });
  await adoptExternalRun(
    { runId, profileId: "uts-hpc-account-a", remoteJobId },
    { auditDir, configPath, executor: exec, now }
  );
  return readRunRecord(runId, auditDir);
}

test("jobs.logs on an adopted PBS run derives stdout/stderr from qstat -f and tails them", async () => {
  const auditDir = tempRuntimeDir("adopt-logs-pbs");
  const configPath = writeResolvedHpcConfig("adopt-logs");
  const record = await adoptedPbsRunWithLogs(auditDir, configPath);
  assert.ok(record.adoption, "adopted PBS record must carry an adoption block");
  assert.equal(record.plan_hash, undefined, "adopted PBS record has no saved plan");

  const calls = [];
  const result = await getJobLogs(
    { runId: record.run_id, maxBytes: 2048 },
    {
      auditDir,
      configPath,
      now: new Date("2026-06-20T11:00:00.000Z"),
      executor: async (program, args) => {
        calls.push({ program, args });
        assert.equal(program, "ssh");
        const remoteArgv = args.slice(-3 - 2); // last 5 for tail, last 3 for qstat -f
        if (args.at(-3) === "qstat" && args.at(-2) === "-f") {
          // The derivation runs `qstat -f <id>` to read Output_Path / Error_Path.
          assert.equal(args.at(-1), "4321.cetus");
          return { exitCode: 0, stdout: ADOPTED_LOGS_QSTAT, stderr: "", timedOut: false };
        }
        // Otherwise it's the bounded tail of a derived (host-stripped, absolute) log path.
        assert.equal(args.at(-5), "tail");
        assert.equal(args.at(-4), "-c");
        assert.equal(args.at(-3), "2048");
        assert.equal(args.at(-2), "--");
        assert.match(
          args.at(-1),
          new RegExp(`^/shared/homes/${RESOLVED_HPC_USER}/experiments/adopt-logs/job\\.(out|err)$`)
        );
        void remoteArgv;
        return { exitCode: 0, stdout: `tail of ${args.at(-1)}\n`, stderr: "", timedOut: false };
      }
    }
  );

  assert.equal(result.logs.streams.length, 2);
  const stdout = result.logs.streams.find((s) => s.stream === "stdout");
  const stderr = result.logs.streams.find((s) => s.stream === "stderr");
  assert.ok(stdout, "stdout stream present");
  assert.ok(stderr, "stderr stream present");
  assert.equal(stdout.status, "passed");
  assert.match(stdout.content, /tail of/);
  assert.equal(stderr.status, "passed");
  // The masked path must not leak the resolved username, but must point at the job.out/.err file.
  assert.match(stdout.path, /job\.out$/);
  assert.doesNotMatch(stdout.path, new RegExp(RESOLVED_HPC_USER));
  // The redacted remote argv masks the derived log path.
  assert.equal(stdout.command.remote_argv.at(-1), "<plan-log-path>");
  // qstat -f (once) + tail (stdout) + tail (stderr) = 3 SSH calls.
  assert.equal(calls.length, 3);
  assert.ok(result.logs.evidence_path);
});

// P2-b (continuation-line coverage): PBS folds a long Output_Path value across continuation lines (a `\n`
// followed by TAB-indented text that is NOT a new `name = ` attribute). unfoldPbsRecord must rejoin the
// wrapped segments onto the attribute line before the path is derived. The single-line fixture above never
// exercises that path; this one does — the Output_Path is split mid-token (`a-de` + `eply-nested-...`),
// and the derived tail must receive the FULLY UNFOLDED absolute path (no embedded newline, no `a-de` gap).
const WRAPPED_OUTPUT_PATH_QSTAT = [
  "Job Id: 6262.cetus",
  "    job_state = R",
  "    exec_host = node07/0*4",
  // PBS continuation fold: the value wraps onto a TAB-indented line that is not a `key = value` attribute,
  // so unfoldPbsRecord appends its trimmed text to the previous line: `...adopt-logs/a-de` + `eply-nested-
  // results-subdir/job.out` => `...adopt-logs/a-deeply-nested-results-subdir/job.out`.
  `    Output_Path = cetus:/shared/homes/${RESOLVED_HPC_USER}/experiments/adopt-logs/a-de`,
  "\teply-nested-results-subdir/job.out",
  `    Error_Path = cetus:/shared/homes/${RESOLVED_HPC_USER}/experiments/adopt-logs/job.err`,
  ""
].join("\n");

test("jobs.logs on an adopted PBS run unfolds a wrapped qstat -f Output_Path continuation line", async () => {
  const auditDir = tempRuntimeDir("adopt-logs-wrapped");
  const configPath = writeResolvedHpcConfig("adopt-logs-wrapped");
  // Adopt under the resolved-user config. The adopt-time qstat carries the wrapped Output_Path too; what
  // matters is that the logs-derivation qstat -f below is wrapped and gets unfolded.
  const adoptExec = async () => ({ exitCode: 0, stdout: WRAPPED_OUTPUT_PATH_QSTAT, stderr: "", timedOut: false });
  await adoptExternalRun(
    { runId: "adopt-wrapped", profileId: "uts-hpc-account-a", remoteJobId: "6262.cetus" },
    { auditDir, configPath, executor: adoptExec, now }
  );
  const record = readRunRecord("adopt-wrapped", auditDir);
  assert.equal(record.plan_hash, undefined, "adopted PBS record has no saved plan");

  const tailedPaths = [];
  const result = await getJobLogs(
    { runId: "adopt-wrapped", stream: "stdout", maxBytes: 1024 },
    {
      auditDir,
      configPath,
      now: new Date("2026-06-20T11:00:00.000Z"),
      executor: async (program, args) => {
        assert.equal(program, "ssh");
        if (args.at(-3) === "qstat" && args.at(-2) === "-f") {
          assert.equal(args.at(-1), "6262.cetus");
          return { exitCode: 0, stdout: WRAPPED_OUTPUT_PATH_QSTAT, stderr: "", timedOut: false };
        }
        // The bounded tail of the derived, fully-unfolded absolute path.
        assert.equal(args.at(-5), "tail");
        assert.equal(args.at(-2), "--");
        tailedPaths.push(args.at(-1));
        return { exitCode: 0, stdout: `tail of ${args.at(-1)}\n`, stderr: "", timedOut: false };
      }
    }
  );

  // The load-bearing assertion: the continuation line was rejoined, so the tailed path is the unfolded
  // absolute path with NO `a-de\n...` gap and NO embedded newline. A regression in unfoldPbsRecord (e.g.
  // dropping the continuation or leaving the fold in place) would tail `.../adopt-logs/a-de` or a path
  // containing a newline instead — and this exact-match would fail.
  assert.equal(tailedPaths.length, 1, "exactly one stdout stream is tailed");
  assert.equal(
    tailedPaths[0],
    `/shared/homes/${RESOLVED_HPC_USER}/experiments/adopt-logs/a-deeply-nested-results-subdir/job.out`
  );
  const stdout = result.logs.streams.find((s) => s.stream === "stdout");
  assert.equal(stdout.status, "passed");
  assert.match(stdout.content, /tail of/);
});

test("jobs.logs on an adopted PBS run refuses an Output_Path outside the profile roots", async () => {
  const auditDir = tempRuntimeDir("adopt-logs-confine");
  const configPath = writeResolvedHpcConfig("adopt-logs-confine");
  await adoptedPbsRunWithLogs(auditDir, configPath, "adopt-escape", "5151.cetus");

  // qstat -f now reports an Output_Path OUTSIDE every profile root (a traversal-free but foreign path).
  const escapeQstat = [
    "Job Id: 5151.cetus",
    "    job_state = R",
    "    Output_Path = cetus:/etc/shadow",
    "",
  ].join("\n");
  let tailCalls = 0;
  const result = await getJobLogs(
    { runId: "adopt-escape", stream: "stdout", maxBytes: 1024 },
    {
      auditDir,
      configPath,
      now: new Date("2026-06-20T11:00:00.000Z"),
      executor: async (program, args) => {
        if (args.at(-3) === "qstat" && args.at(-2) === "-f") {
          return { exitCode: 0, stdout: escapeQstat, stderr: "", timedOut: false };
        }
        tailCalls += 1;
        return { exitCode: 0, stdout: "should-not-be-tailed\n", stderr: "", timedOut: false };
      }
    }
  );
  // A confinement failure is a clear failed stream, never a silent skip and never a tail of the path.
  assert.equal(tailCalls, 0, "a path outside the profile roots must never be tailed");
  assert.equal(result.logs.streams.length, 1);
  assert.equal(result.logs.streams[0].status, "failed");
  assert.match(result.logs.streams[0].summary, /profile root|outside|confine/i);
});

test("jobs.history output never leaks supervisor paths or adoption queue_id", () => {
  const auditDir = tempRuntimeDir("adopt-redact");
  // Write a lineage-proven record directly (real supervisor paths + adoption queue_id hash), then list
  // history and assert the compact projection leaks neither the absolute paths nor the queue_id hash.
  const at = "2026-06-20T10:00:00.000Z";
  writeRunRecord({
    run_id: "run-redact", profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-redact-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    supervisor: { pid: 54321, node_id: "mars01", metadata_path: "/home/u/.uts/slot_0/result.json",
      stdout_path: "/home/u/.uts/slot_0/stdout.log", stderr_path: "/home/u/.uts/slot_0/stdout.log" },
    adoption: { terminal_record: "agent_authored", intent: "user_declared", lineage: "lineage_proven",
      queue_id: "sha256:secrethash", adopted_at: at },
    events: [{ at, kind: "adopted-lineage", summary: "x" }]
  }, auditDir);
  const out = JSON.stringify(jobsHistory({ auditDir }));
  assert.ok(!out.includes("/home/u/.uts"), "history must not leak supervisor paths");
  assert.ok(!out.includes("secrethash"), "history must not leak adoption queue_id hash");
});
