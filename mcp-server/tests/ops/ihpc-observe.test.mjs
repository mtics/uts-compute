import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { adoptExternalRun, ihpcPidToRunRecord } from "../../dist/ops/jobs/adopt.js";
import { cancelJob, getJobLogs, getJobStatus } from "../../dist/ops/jobs/jobs.js";
import { assertRunRecord } from "../../dist/core/validation.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

// ---------------------------------------------------------------------------------------------------
// P2-a — observability for ADOPTED / FOREIGN iHPC runs.
//
// An adopted iHPC run is born from `ihpc-sched` + hand-written queue YAML and ingested via jobs.adopt.
// It has an `adoption` block, platform uts-ihpc, and NO `supervisor` block (jobs.adopt deliberately
// cannot synthesize an external process's stdout/stderr/metadata paths). Before P2-a, jobs.status on it
// THREW the "does not include iHPC supervisor metadata" error — foreign work was invisible.
//
// P2-a gives such a run a READ-ONLY OBSERVE PATH: jobs.status reports whether the recorded pid is still
// alive on its node + the node's GPU snapshot, WITHOUT requiring supervisor metadata. The observe path
// uses ONLY the node+pid the operator supplied at adopt time (durably stored as the `observed` block).
// jobs.logs / jobs.cancel stay unavailable (they genuinely need supervisor log paths) but now return a
// CLEAR, specific observe-only error rather than the generic supervisor-missing throw.
// ---------------------------------------------------------------------------------------------------

const now = new Date("2026-06-20T10:00:00.000Z");
const observedAt = new Date("2026-06-20T10:05:00.000Z");

// A NODE_USAGE_PY-shaped GPU report (two healthy GPUs). The observe path reuses probeNodeUsage, so the
// executor must answer BOTH the liveness probe (IHPC_STATUS_PY, os.kill) and the node-usage probe.
function gpuReport(overrides = {}) {
  return {
    ok: true,
    gpus: [
      { index: 0, name: "Tesla T4", utilization_gpu_percent: 42, memory_used_mb: 2048, memory_total_mb: 16000 },
      { index: 1, name: "Tesla T4", utilization_gpu_percent: 0, memory_used_mb: 8, memory_total_mb: 16000 }
    ],
    errors: [],
    ...overrides
  };
}

// One executor that routes by the inline python it is shipped: the liveness probe carries os.kill;
// the node-usage probe carries nvidia-smi. Returns alive/gpu per the supplied fixtures and records calls.
function observeExecutor({ alive = true, gpu = gpuReport(), calls = [] } = {}) {
  return async (program, args, _timeoutMs, stdin) => {
    calls.push({ program, args, stdin });
    if (typeof stdin === "string" && /os\.kill\(pid, 0\)/.test(stdin)) {
      return { exitCode: 0, stdout: `${JSON.stringify({ alive })}\n`, stderr: "" };
    }
    if (typeof stdin === "string" && /nvidia-smi/.test(stdin)) {
      return { exitCode: 0, stdout: `${JSON.stringify(gpu)}\n`, stderr: "" };
    }
    throw new Error(`unexpected probe stdin: ${String(stdin).slice(0, 60)}`);
  };
}

async function adoptedIhpcRun(runId, auditDir) {
  return adoptExternalRun(
    { runId, profileId: "uts-ihpc-account-a", node: "mars001", pid: 31245 },
    { auditDir, now }
  );
}

// --- adopt primitive: the observed node+pid is durably stored -------------------------------------

test("ihpcPidToRunRecord records the observed node+pid and still validates (no supervisor)", () => {
  const rec = ihpcPidToRunRecord({
    runId: "obs-venus01-31245",
    profileId: "uts-ihpc-account-a",
    node: "venus01",
    pid: 31245,
    now
  });
  assert.deepEqual(rec.observed, { node: "venus01", pid: 31245 });
  assert.equal(rec.supervisor, undefined, "still history-only: no supervisor block");
  assert.doesNotThrow(() => assertRunRecord(rec), "schema must accept the observed block");
});

test("the schema rejects an observed block with an unknown field", () => {
  const rec = ihpcPidToRunRecord({
    runId: "obs-bad", profileId: "uts-ihpc-account-a", node: "venus01", pid: 31245, now
  });
  rec.observed.bogus = 1;
  assert.throws(() => assertRunRecord(rec), /Invalid run record/);
});

// --- jobs.status observe path: liveness + GPU, no supervisor needed -------------------------------

test("jobs.status on an adopted iHPC run OBSERVES liveness + GPU instead of throwing", async () => {
  const auditDir = tempRuntimeDir("observe-status-alive");
  await adoptedIhpcRun("obs-alive", auditDir);
  const calls = [];
  const result = await getJobStatus(
    { runId: "obs-alive" },
    { auditDir, now: observedAt, executor: observeExecutor({ alive: true, calls }) }
  );

  assert.equal(result.status.mode, "read-only");
  assert.equal(result.status.platform, "uts-ihpc");
  assert.equal(result.status.node, "mars001");
  // a live recorded pid => the run is observed running.
  assert.equal(result.status.status, "running");
  assert.equal(result.status.liveness, "alive");
  // the GPU snapshot is carried through from the node-usage probe.
  assert.equal(result.status.gpu_usage.status, "ok");
  assert.equal(result.status.gpu_usage.gpus.length, 2);
  assert.equal(result.status.gpu_usage.gpus[0].utilization_gpu_percent, 42);
  // BOTH probes ran over the two-hop ssh seam.
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.program === "ssh"));
  // never leaks the node alias / node token into the redacted command.
  assert.equal(result.status.command.remote_argv.join(" "), "ssh <ihpc-compute-node> python3 - <supervisor-spec>");
});

test("jobs.status observe: a DEAD recorded pid maps the run to finished", async () => {
  const auditDir = tempRuntimeDir("observe-status-dead");
  await adoptedIhpcRun("obs-dead", auditDir);
  const result = await getJobStatus(
    { runId: "obs-dead" },
    { auditDir, now: observedAt, executor: observeExecutor({ alive: false }) }
  );
  assert.equal(result.status.liveness, "dead");
  assert.equal(result.status.status, "finished");

  const runRecord = JSON.parse(fs.readFileSync(result.status.run_record_path, "utf8"));
  assert.equal(runRecord.status, "finished");
  assert.equal(runRecord.events.at(-1).kind, "ihpc-observe");
});

test("jobs.status observe: a node we cannot read GPUs from is node-unverifiable, never fabricated", async () => {
  const auditDir = tempRuntimeDir("observe-status-nogpu");
  await adoptedIhpcRun("obs-nogpu", auditDir);
  const empty = { ok: false, gpus: [], errors: ["nvidia-smi not found on node"] };
  const result = await getJobStatus(
    { runId: "obs-nogpu" },
    { auditDir, now: observedAt, executor: observeExecutor({ alive: true, gpu: empty }) }
  );
  // liveness is still reported even when the GPU view is unverifiable.
  assert.equal(result.status.liveness, "alive");
  assert.equal(result.status.status, "running");
  assert.equal(result.status.gpu_usage.status, "node-unverifiable");
  assert.deepEqual(result.status.gpu_usage.gpus, []);
});

test("jobs.status observe: a timed-out liveness probe does not clobber the prior definite status", async () => {
  const auditDir = tempRuntimeDir("observe-status-timeout");
  await adoptedIhpcRun("obs-timeout", auditDir);
  const result = await getJobStatus(
    { runId: "obs-timeout" },
    {
      auditDir,
      now: observedAt,
      executor: async (_p, _a, _t, stdin) => {
        if (/os\.kill\(pid, 0\)/.test(stdin)) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
        return { exitCode: 0, stdout: `${JSON.stringify(gpuReport())}\n`, stderr: "" };
      }
    }
  );
  // an indeterminate liveness probe -> liveness "unknown"; the run stays at its prior definite "running".
  assert.equal(result.status.liveness, "unknown");
  assert.equal(result.status.status, "running");
});

// --- jobs.logs / jobs.cancel: clear observe-only refusal (NOT the generic supervisor throw) --------

test("jobs.logs on an adopted iHPC run returns a clear observe-only error", async () => {
  const auditDir = tempRuntimeDir("observe-logs");
  await adoptedIhpcRun("obs-logs", auditDir);
  let calls = 0;
  await assert.rejects(
    () => getJobLogs({ runId: "obs-logs" }, { auditDir, executor: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; } }),
    /observe-only|no supervisor log/i
  );
  assert.equal(calls, 0, "no SSH before the refusal");
});

test("jobs.cancel on an adopted iHPC run returns a clear observe-only error (cancel on the node)", async () => {
  const auditDir = tempRuntimeDir("observe-cancel");
  await adoptedIhpcRun("obs-cancel", auditDir);
  let calls = 0;
  await assert.rejects(
    () =>
      cancelJob(
        { runId: "obs-cancel", approvalId: "approval-whatever" },
        { auditDir, executor: async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; } }
      ),
    /observe-only|cancel on the node/i
  );
  assert.equal(calls, 0, "no SSH before the refusal");
});

// --- still history-only when node+pid was not captured (older adopt records) ----------------------

test("jobs.status on an adopted iHPC run WITHOUT an observed block stays history-only (clear error)", async () => {
  const auditDir = tempRuntimeDir("observe-no-observed");
  const res = await adoptedIhpcRun("obs-missing", auditDir);
  // simulate an OLD adopt record that predates the observed block.
  const runRecordPath = res.adopted.run_id;
  const onDiskPath = `${auditDir}/${runRecordPath}.json`;
  const rec = JSON.parse(fs.readFileSync(onDiskPath, "utf8"));
  delete rec.observed;
  fs.writeFileSync(onDiskPath, `${JSON.stringify(rec, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => getJobStatus({ runId: "obs-missing" }, { auditDir, executor: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }),
    /supervisor|observe/i
  );
});
