import assert from "node:assert/strict";
import test from "node:test";

import {
  probeNodeUsage,
  parseNodeUsageReport
} from "../../dist/ops/jobs/ihpc-node-usage.js";

// ---------------------------------------------------------------------------------------------------
// ihpc.node.usage — a READ-ONLY one-shot per-GPU utilization probe. probeNodeUsage ships the FIXED
// NODE_USAGE_PY over the existing two-hop sshSupervisorArgs seam (the same seam the canary uses) and
// maps the probe's JSON to a structured { node, gpus, probed_at, status } result. These tests inject a
// crafted-JSON executor so no real SSH/GPU is touched.
//
// FAIL-CLOSED CONTRACT: an SSH failure / timeout / unparseable output yields a node-unverifiable
// status with NO gpus[] — never a fabricated reading.
// ---------------------------------------------------------------------------------------------------

const IHPC_PROFILE = {
  profile_id: "uts-ihpc-usage",
  platform: "uts-ihpc",
  account_label: "ihpc-usage",
  login: { host_alias: "ihpc-usage", username_ref: "UTS_IHPC_USAGE_USER", requires_vpn: true },
  defaults: { node_family: "turing", node_limits: [{ families: ["turing"], limit: 2 }] }
};

// A node-usage report builder with two healthy GPUs; override fields per case.
function report(overrides = {}) {
  return {
    ok: true,
    gpus: [
      { index: 0, name: "Tesla T4", utilization_gpu_percent: 37, memory_used_mb: 1024, memory_total_mb: 16000 },
      { index: 1, name: "Tesla T4", utilization_gpu_percent: 0, memory_used_mb: 12, memory_total_mb: 16000 }
    ],
    processes: [],
    errors: [],
    ...overrides
  };
}

// An executor that returns a fixed NODE_USAGE_PY JSON line on stdout, exit 0. Records every call so the
// seam-usage and node-token-rejection tests can assert it was (or was NOT) touched.
function jsonExecutor(rep, calls) {
  return async (program, args, _timeoutMs, _stdin) => {
    calls.push({ program, args });
    return { exitCode: 0, stdout: `${JSON.stringify(rep)}\n`, stderr: "" };
  };
}

// --- parseNodeUsageReport: pure probe-report -> tool-output mapping --------------------------------

test("parseNodeUsageReport: a healthy CSV-derived report yields the per-GPU structure", () => {
  const parsed = parseNodeUsageReport(report());
  assert.ok(parsed, "a well-shaped report must parse");
  assert.equal(parsed.gpus.length, 2);
  assert.deepEqual(parsed.gpus[0], {
    index: 0,
    name: "Tesla T4",
    utilization_gpu_percent: 37,
    memory_used_mb: 1024,
    memory_total_mb: 16000
  });
  // a malformed/extra field on the row must be dropped, not carried through.
  assert.equal(Object.keys(parsed.gpus[1]).length, 5);
});

test("parseNodeUsageReport: a malformed GPU row is filtered, not fatal", () => {
  const parsed = parseNodeUsageReport(
    report({
      gpus: [
        { index: 0, name: "Tesla T4", utilization_gpu_percent: 5, memory_used_mb: 100, memory_total_mb: 16000 },
        { index: "bad", name: 5, utilization_gpu_percent: null } // malformed -> filtered
      ]
    })
  );
  assert.ok(parsed);
  assert.equal(parsed.gpus.length, 1, "only the well-formed row survives");
});

test("parseNodeUsageReport: a wrong-shape report (missing gpus) returns null (fail-closed upstream)", () => {
  assert.equal(parseNodeUsageReport({ hello: "world" }), null);
  assert.equal(parseNodeUsageReport(null), null);
  assert.equal(parseNodeUsageReport([1, 2, 3]), null);
});

test("parseNodeUsageReport: per-process GPU memory (L2 per-PID) is parsed; malformed rows filtered", () => {
  const parsed = parseNodeUsageReport(report({
    processes: [
      { pid: 3174690, used_memory_mb: 8200 },
      { pid: "bad", used_memory_mb: 5 }, // malformed -> filtered
      { used_memory_mb: 5 }              // missing pid -> filtered
    ]
  }));
  assert.ok(parsed);
  assert.deepEqual(parsed.processes, [{ pid: 3174690, used_memory_mb: 8200 }]);
});

test("parseNodeUsageReport: a report with no processes field yields an empty processes array", () => {
  const parsed = parseNodeUsageReport({ ok: true, gpus: report().gpus, errors: [] });
  assert.ok(parsed);
  assert.deepEqual(parsed.processes, []);
});

test("probeNodeUsage: status:ok carries per-process GPU memory; node-unverifiable carries empty processes", async () => {
  const okResult = await probeNodeUsage(IHPC_PROFILE, "mars01", jsonExecutor(report({ processes: [{ pid: 999, used_memory_mb: 4096 }] }), []));
  assert.equal(okResult.status, "ok");
  assert.deepEqual(okResult.processes, [{ pid: 999, used_memory_mb: 4096 }]);
  const downResult = await probeNodeUsage(IHPC_PROFILE, "mars01", async () => ({ exitCode: 1, stdout: "", stderr: "nvidia-smi: not found" }));
  assert.equal(downResult.status, "node-unverifiable");
  assert.deepEqual(downResult.processes, []);
});

// --- probeNodeUsage unit cases (injected executor) ------------------------------------------------

test("probeNodeUsage: a healthy node returns status:ok with per-GPU utilization + memory", async () => {
  const calls = [];
  const result = await probeNodeUsage(IHPC_PROFILE, "mars01", jsonExecutor(report(), calls));
  assert.equal(result.status, "ok");
  assert.equal(result.node, "mars01");
  assert.equal(result.gpus.length, 2);
  assert.equal(result.gpus[0].utilization_gpu_percent, 37);
  assert.equal(result.gpus[0].memory_used_mb, 1024);
  assert.equal(result.gpus[0].memory_total_mb, 16000);
  assert.ok(typeof result.probed_at === "string" && result.probed_at.length > 0, "probed_at timestamp");
  // it used the two-hop seam: program ssh.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, "ssh");
});

test("probeNodeUsage: an empty/missing-nvidia-smi report yields node-unverifiable, NOT a fake reading", async () => {
  // nvidia-smi absent on the node: the probe reports ok:false, no gpus, an error string.
  const empty = { ok: false, gpus: [], errors: ["nvidia-smi not found on node"] };
  const result = await probeNodeUsage(IHPC_PROFILE, "mars01", jsonExecutor(empty, []));
  assert.equal(result.status, "node-unverifiable");
  assert.deepEqual(result.gpus, [], "a node we could not read GPUs from must NOT fabricate a reading");
  assert.ok(/nvidia-smi/.test(result.reason ?? ""), "the reason carries the probe error");
});

// --- FAIL-CLOSED: an unverifiable node is NEVER a fabricated reading ------------------------------

test("probeNodeUsage FAIL-CLOSED: non-zero exit -> status node-unverifiable, no gpus", async () => {
  const exec = async () => ({ exitCode: 1, stdout: "", stderr: "ssh: connect to host failed\n" });
  const result = await probeNodeUsage(IHPC_PROFILE, "mars01", exec);
  assert.equal(result.status, "node-unverifiable");
  assert.deepEqual(result.gpus, []);
});

test("probeNodeUsage FAIL-CLOSED: a timeout -> status node-unverifiable, no gpus", async () => {
  const exec = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
  const result = await probeNodeUsage(IHPC_PROFILE, "mars01", exec);
  assert.equal(result.status, "node-unverifiable");
  assert.deepEqual(result.gpus, []);
});

test("probeNodeUsage FAIL-CLOSED: garbage (unparseable) stdout -> status node-unverifiable", async () => {
  const exec = async () => ({ exitCode: 0, stdout: "this is not json at all\n", stderr: "" });
  const result = await probeNodeUsage(IHPC_PROFILE, "mars01", exec);
  assert.equal(result.status, "node-unverifiable");
  assert.deepEqual(result.gpus, []);
});

test("probeNodeUsage FAIL-CLOSED: the executor throwing -> status node-unverifiable", async () => {
  const exec = async () => {
    throw new Error("spawn ssh ENOENT");
  };
  const result = await probeNodeUsage(IHPC_PROFILE, "mars01", exec);
  assert.equal(result.status, "node-unverifiable");
  assert.deepEqual(result.gpus, []);
});

// --- node-token validation: rejected BEFORE any SSH ----------------------------------------------

test("probeNodeUsage rejects a shell-metachar node token before any SSH", async () => {
  let called = false;
  const exec = async () => {
    called = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
  await assert.rejects(() => probeNodeUsage(IHPC_PROFILE, "mars01; rm -rf /", exec), /Unsafe iHPC compute node/);
  assert.equal(called, false, "an unsafe node token must be rejected before the executor is touched");
});

test("probeNodeUsage rejects a `..` traversal node token before any SSH", async () => {
  let called = false;
  const exec = async () => {
    called = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
  await assert.rejects(() => probeNodeUsage(IHPC_PROFILE, "../etc/passwd", exec), /Unsafe iHPC compute node/);
  assert.equal(called, false);
});

test("probeNodeUsage rejects a LEADING-DASH node token (no SSH/option-flag confusion) before any SSH", async () => {
  // A token like "-oProxyCommand=..." is a valid isSafeRemoteToken string, but a leading dash would let
  // it be parsed as an ssh option flag on the inner hop. probeNodeUsage must reject it pre-SSH.
  let called = false;
  const exec = async () => {
    called = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
  await assert.rejects(() => probeNodeUsage(IHPC_PROFILE, "-oProxyCommand=evil", exec), /Unsafe iHPC compute node/);
  assert.equal(called, false, "a leading-dash node token must be rejected before the executor is touched");
});

test("probeNodeUsage rejects a non-iHPC profile", async () => {
  const hpc = { ...IHPC_PROFILE, profile_id: "uts-hpc-x", platform: "uts-hpc" };
  await assert.rejects(
    () => probeNodeUsage(hpc, "mars01", async () => ({ exitCode: 0, stdout: "{}", stderr: "" })),
    /uts-ihpc/
  );
});
