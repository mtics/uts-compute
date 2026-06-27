import assert from "node:assert/strict";
import test from "node:test";

import {
  probeNodeCanary,
  runIhpcPreflight,
  mapCanaryReportToFindings
} from "../../dist/ops/jobs/ihpc-preflight.js";
import { writeProfileConfig } from "../helpers/index.mjs";

// ---------------------------------------------------------------------------------------------------
// OPT-IN on-node GPU/CUDA canary. probeNodeCanary ships the FIXED CANARY_PY over the existing two-hop
// sshSupervisorArgs seam and maps the probe's JSON to QueueFinding[]; runIhpcPreflight folds it into
// the pure-local validateQueueContract ONLY when BOTH profileId and node are supplied. These tests
// inject a crafted-JSON executor so no real SSH/GPU is touched.
// ---------------------------------------------------------------------------------------------------

const IHPC_PROFILE = {
  profile_id: "uts-ihpc-canary",
  platform: "uts-ihpc",
  account_label: "ihpc-canary",
  login: { host_alias: "ihpc-canary", username_ref: "UTS_IHPC_CANARY_USER", requires_vpn: true },
  defaults: { node_family: "turing", node_limits: [{ families: ["turing"], limit: 2 }] }
};

// An executor that returns a fixed CANARY_PY JSON line on stdout, exit 0. Records every call so the
// "no SSH by default" tests can assert it was NEVER touched.
function jsonExecutor(report, calls) {
  return async (program, args, _timeoutMs, _stdin) => {
    calls.push({ program, args });
    return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
  };
}

// A canary report builder with healthy defaults; override fields per case.
function report(overrides = {}) {
  return {
    ok: true,
    gpu_count: 2,
    gpus: [
      { index: 0, mem_used: 100, mem_total: 16000, util: 1 },
      { index: 1, mem_used: 100, mem_total: 16000, util: 1 }
    ],
    torch_present: true,
    cuda_available: true,
    errors: [],
    ...overrides
  };
}

// --- probeNodeCanary unit cases (injected executor) -----------------------------------------------

test("probeNodeCanary: a healthy node yields NO findings", async () => {
  const calls = [];
  const findings = await probeNodeCanary(IHPC_PROFILE, "mars01", jsonExecutor(report(), calls));
  assert.equal(findings.length, 0, JSON.stringify(findings));
  // it used the two-hop seam: program ssh, and the LAST argv token is the encoded {kind:"canary"} spec.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, "ssh");
});

test("probeNodeCanary: gpu_count:0 -> error gpu-unavailable", async () => {
  const findings = await probeNodeCanary(
    IHPC_PROFILE,
    "mars01",
    jsonExecutor(report({ gpu_count: 0, gpus: [], ok: false, errors: ["nvidia-smi not found on node"] }), [])
  );
  const f = findings.find((x) => x.code === "gpu-unavailable");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "error");
});

test("probeNodeCanary: cuda_available:false -> error cuda-unavailable (the real killer)", async () => {
  const findings = await probeNodeCanary(
    IHPC_PROFILE,
    "mars01",
    jsonExecutor(report({ cuda_available: false }), [])
  );
  const f = findings.find((x) => x.code === "cuda-unavailable");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "error");
  // torch IS present here, so we must NOT also emit cuda-unverified.
  assert.equal(findings.some((x) => x.code === "cuda-unverified"), false);
});

test("probeNodeCanary: torch_present:false -> warning cuda-unverified (not an error)", async () => {
  const findings = await probeNodeCanary(
    IHPC_PROFILE,
    "mars01",
    jsonExecutor(report({ torch_present: false, cuda_available: null }), [])
  );
  const f = findings.find((x) => x.code === "cuda-unverified");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "warning");
  // a missing torch must NOT escalate to an error (no blocking finding).
  assert.equal(findings.some((x) => x.level === "error"), false);
});

test("probeNodeCanary: every GPU busy -> warning gpu-busy", async () => {
  const findings = await probeNodeCanary(
    IHPC_PROFILE,
    "mars01",
    jsonExecutor(
      report({
        gpus: [
          { index: 0, mem_used: 15000, mem_total: 16000, util: 99 },
          { index: 1, mem_used: 14000, mem_total: 16000, util: 88 }
        ]
      }),
      []
    )
  );
  const f = findings.find((x) => x.code === "gpu-busy");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "warning");
});

test("probeNodeCanary: a single FREE gpu among busy ones is NOT all-busy (no gpu-busy)", async () => {
  const findings = await probeNodeCanary(
    IHPC_PROFILE,
    "mars01",
    jsonExecutor(
      report({
        gpus: [
          { index: 0, mem_used: 15000, mem_total: 16000, util: 99 }, // busy
          { index: 1, mem_used: 50, mem_total: 16000, util: 0 } // free
        ]
      }),
      []
    )
  );
  assert.equal(findings.some((x) => x.code === "gpu-busy"), false, JSON.stringify(findings));
});

// --- FAIL-CLOSED: an unverifiable node is NEVER healthy --------------------------------------------

test("probeNodeCanary FAIL-CLOSED: non-zero exit -> error node-unverifiable", async () => {
  const exec = async () => ({ exitCode: 1, stdout: "", stderr: "ssh: connect to host failed\n" });
  const findings = await probeNodeCanary(IHPC_PROFILE, "mars01", exec);
  const f = findings.find((x) => x.code === "node-unverifiable");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "error");
});

test("probeNodeCanary FAIL-CLOSED: a timeout -> error node-unverifiable", async () => {
  const exec = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
  const findings = await probeNodeCanary(IHPC_PROFILE, "mars01", exec);
  const f = findings.find((x) => x.code === "node-unverifiable");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "error");
});

test("probeNodeCanary FAIL-CLOSED: garbage (unparseable) stdout -> error node-unverifiable", async () => {
  const exec = async () => ({ exitCode: 0, stdout: "this is not json at all\n", stderr: "" });
  const findings = await probeNodeCanary(IHPC_PROFILE, "mars01", exec);
  const f = findings.find((x) => x.code === "node-unverifiable");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "error");
});

test("probeNodeCanary FAIL-CLOSED: a wrong-shape JSON (missing fields) -> error node-unverifiable", async () => {
  const exec = async () => ({ exitCode: 0, stdout: `${JSON.stringify({ hello: "world" })}\n`, stderr: "" });
  const findings = await probeNodeCanary(IHPC_PROFILE, "mars01", exec);
  const f = findings.find((x) => x.code === "node-unverifiable");
  assert.ok(f, JSON.stringify(findings));
  assert.equal(f.level, "error");
});

test("probeNodeCanary rejects an unsafe node token before any SSH", async () => {
  let called = false;
  const exec = async () => {
    called = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
  await assert.rejects(() => probeNodeCanary(IHPC_PROFILE, "mars01; rm -rf /", exec), /Unsafe iHPC compute node/);
  assert.equal(called, false, "an unsafe node token must be rejected before the executor is touched");
});

// mapCanaryReportToFindings is pure: a broken node can carry BOTH a gpu error and (here) verify ok.
test("mapCanaryReportToFindings: combined gpu-unavailable + cuda-unavailable on one report", () => {
  const findings = mapCanaryReportToFindings(report({ gpu_count: 0, gpus: [], cuda_available: false }));
  assert.ok(findings.some((x) => x.code === "gpu-unavailable" && x.level === "error"));
  assert.ok(findings.some((x) => x.code === "cuda-unavailable" && x.level === "error"));
});

// --- runIhpcPreflight end-to-end (local + optional canary) -----------------------------------------

const GOOD_YAML = {
  my_nodes: [{ hostname: "mars01", gpu_count: 2 }],
  experiments: [{ name: "e1", command: "python train.py --dataset MovieLens", requires_gpu: true }]
};

test("runIhpcPreflight DEFAULT (no profileId/node) is PURE-LOCAL: the executor is NEVER called", async () => {
  const calls = [];
  const result = await runIhpcPreflight(
    { queueYaml: GOOD_YAML, datasetDirs: ["MovieLens"] },
    { executor: jsonExecutor(report(), calls) }
  );
  assert.equal(calls.length, 0, "no SSH may happen when profileId+node are absent");
  assert.equal(result.preflight.valid, true);
  assert.equal(result.preflight.findings.length, 0);
});

test("runIhpcPreflight DEFAULT still surfaces a local dataset error and does NO SSH", async () => {
  const calls = [];
  const result = await runIhpcPreflight(
    { queueYaml: GOOD_YAML, datasetDirs: ["ML"] }, // MovieLens not present -> local error
    { executor: jsonExecutor(report(), calls) }
  );
  assert.equal(calls.length, 0);
  assert.equal(result.preflight.valid, false);
  assert.ok(result.preflight.findings.some((x) => /dataset|MovieLens/.test(x.message)));
});

test("runIhpcPreflight with node+profileId folds the canary's gpu-busy warning in WITH the local findings", async () => {
  const configPath = writeProfileConfig("canary-e2e", [IHPC_PROFILE]);
  const busy = report({
    gpus: [
      { index: 0, mem_used: 15000, mem_total: 16000, util: 99 },
      { index: 1, mem_used: 14000, mem_total: 16000, util: 95 }
    ]
  });
  const calls = [];
  const result = await runIhpcPreflight(
    { queueYaml: GOOD_YAML, datasetDirs: ["MovieLens"], profileId: "uts-ihpc-canary", node: "mars01" },
    { executor: jsonExecutor(busy, calls), configPath }
  );
  // SSH happened exactly once via the seam.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, "ssh");
  // local findings (none here) AND the canary warning are both present; gpu-busy is a warning so valid stays true.
  assert.ok(result.preflight.findings.some((x) => x.code === "gpu-busy" && x.level === "warning"));
  assert.equal(result.preflight.valid, true);
});

test("runIhpcPreflight with node+profileId fails closed (valid:false) when the node is unverifiable", async () => {
  const configPath = writeProfileConfig("canary-e2e-fc", [IHPC_PROFILE]);
  const exec = async () => ({ exitCode: 255, stdout: "", stderr: "ssh: Could not resolve hostname\n" });
  const result = await runIhpcPreflight(
    { queueYaml: GOOD_YAML, datasetDirs: ["MovieLens"], profileId: "uts-ihpc-canary", node: "mars01" },
    { executor: exec, configPath }
  );
  assert.equal(result.preflight.valid, false, "an unverifiable node must block (valid:false), never pass");
  assert.ok(result.preflight.findings.some((x) => x.code === "node-unverifiable" && x.level === "error"));
});

test("runIhpcPreflight rejects a non-iHPC profile for the canary", async () => {
  const hpc = { ...IHPC_PROFILE, profile_id: "uts-hpc-x", platform: "uts-hpc" };
  const configPath = writeProfileConfig("canary-e2e-hpc", [hpc]);
  await assert.rejects(
    () =>
      runIhpcPreflight(
        { queueYaml: GOOD_YAML, profileId: "uts-hpc-x", node: "mars01" },
        { executor: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }), configPath }
      ),
    /uts-ihpc/
  );
});
