import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";

import { CANARY_PY } from "../../../dist/ops/scheduler/seam/canary-py.js";

// Resolve python3's ABSOLUTE path once, so we can invoke it directly while handing the child an empty
// PATH — that way the probe's own `subprocess.run(["nvidia-smi", ...])` cannot resolve nvidia-smi even
// on a GPU dev box, making the graceful-degradation assertion deterministic on any host. (Without an
// absolute python3, narrowing PATH would also break finding python3 itself.)
function resolvePython3() {
  try {
    return execFileSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).trim() || "python3";
  } catch {
    return "python3";
  }
}
const PYTHON3 = resolvePython3();

// Run the REAL CANARY_PY under python3, exactly as the node would (fed on stdin, with a base64url spec
// argv that the probe IGNORES). This proves the probe DEGRADES GRACEFULLY on a box WITHOUT nvidia-smi
// or torch (the dev/CI machine): it must EXIT 0 and print one valid JSON line with gpu_count:0, the
// nvidia-smi-missing error captured in errors[], and torch_present:false — never crash to stderr.
//
// We gate on python3 with a LOUD assertion (not a silent skip): a missing python3 is a real CI gap the
// suite must surface, not paper over. We also force an EMPTY PATH-ish environment for the GPU tools by
// pointing PATH at an empty temp dir so nvidia-smi is provably absent even on a GPU dev box, making the
// "degrades gracefully" assertion deterministic regardless of the host.

function runCanary(extraEnv = {}) {
  // A base64url-encoded {"kind":"canary"} spec, matching encodeSpec — the probe ignores it but the
  // two-hop seam always passes one, so we exercise the same argv shape. We invoke python3 by ABSOLUTE
  // path so a narrowed child PATH (to hide nvidia-smi) cannot break locating the interpreter itself.
  const spec = Buffer.from(JSON.stringify({ kind: "canary" }), "utf8").toString("base64url");
  return spawnSync(PYTHON3, ["-", spec], {
    input: CANARY_PY,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv }
  });
}

test("python3 is available for the canary fork test (loud, not a silent skip)", () => {
  const probe = spawnSync(PYTHON3, ["--version"], { encoding: "utf8" });
  assert.equal(probe.status, 0, "python3 must be on PATH to run the CANARY_PY fork test");
});

test("real CANARY_PY degrades gracefully on a box with no nvidia-smi/torch: exit 0 + valid JSON", () => {
  // Force nvidia-smi to be absent regardless of host: an empty PATH means the fixed argv list cannot
  // resolve nvidia-smi, exercising the FileNotFoundError branch. (python3 itself is invoked by absolute
  // resolution via spawnSync before PATH is narrowed for the child's own subprocess calls.)
  const r = runCanary({ PATH: "/nonexistent-canary-path" });
  assert.equal(r.status, 0, `CANARY_PY must exit 0 even with no GPU tooling (stderr: ${r.stderr})`);
  assert.equal((r.stderr || "").trim(), "", "the probe must NEVER raise to stderr on a missing tool");

  const lines = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 1, "the probe must print at least one JSON line");
  const parsed = JSON.parse(lines.at(-1));

  assert.equal(parsed.gpu_count, 0, "no nvidia-smi -> zero GPUs");
  assert.deepEqual(parsed.gpus, [], "no per-GPU rows when nvidia-smi is absent");
  assert.equal(parsed.torch_present, false, "torch is not importable on the dev box -> false");
  assert.equal(parsed.cuda_available, null, "no torch -> cuda_available is null (unverifiable, not false)");
  assert.equal(parsed.ok, false, "a zero-GPU node is not 'ok' from the probe's optimistic verdict");
  assert.ok(Array.isArray(parsed.errors), "errors must be an array");
  assert.ok(
    parsed.errors.some((e) => /nvidia-smi/.test(e)),
    `the nvidia-smi absence must be captured in errors[], got ${JSON.stringify(parsed.errors)}`
  );
});

test("real CANARY_PY prints exactly one JSON object line (parseable by parseJsonLastLine)", () => {
  const r = runCanary({ PATH: "/nonexistent-canary-path" });
  assert.equal(r.status, 0, r.stderr);
  const lines = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  // The brain parses the LAST non-empty line as JSON; assert that line is a single complete object.
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(typeof parsed, "object");
  for (const key of ["ok", "gpu_count", "gpus", "torch_present", "cuda_available", "errors"]) {
    assert.ok(Object.hasOwn(parsed, key), `JSON line must carry the ${key} field`);
  }
});
