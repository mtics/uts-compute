import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

import { NODE_USAGE_PY } from "../../../dist/ops/scheduler/seam/node-usage-py.js";

// Run the REAL NODE_USAGE_PY under python3, exactly as the node would (fed on stdin, with a base64url
// spec argv that the probe IGNORES). This proves the probe DEGRADES GRACEFULLY on a box WITHOUT
// nvidia-smi (the dev/CI machine): it must EXIT 0 and print one valid JSON line with ok:false, an empty
// gpus[], and the nvidia-smi-missing error captured in errors[] — never crash to stderr, never emit a
// fabricated GPU reading.
//
// We invoke python3 by ABSOLUTE path and force an EMPTY PATH for the child so its own
// subprocess.run(["nvidia-smi", ...]) cannot resolve nvidia-smi even on a GPU dev box, making the
// "degrades gracefully" assertion deterministic on any host.

function resolvePython3() {
  try {
    return execFileSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).trim() || "python3";
  } catch {
    return "python3";
  }
}
const PYTHON3 = resolvePython3();

function runUsage(extraEnv = {}) {
  const spec = Buffer.from(JSON.stringify({ kind: "node-usage" }), "utf8").toString("base64url");
  return spawnSync(PYTHON3, ["-", spec], {
    input: NODE_USAGE_PY,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv }
  });
}

test("python3 is available for the node-usage fork test (loud, not a silent skip)", () => {
  const probe = spawnSync(PYTHON3, ["--version"], { encoding: "utf8" });
  assert.equal(probe.status, 0, "python3 must be on PATH to run the NODE_USAGE_PY fork test");
});

test("real NODE_USAGE_PY degrades gracefully on a box with no nvidia-smi: exit 0 + valid JSON, no fake GPUs", () => {
  const r = runUsage({ PATH: "/nonexistent-node-usage-path" });
  assert.equal(r.status, 0, `NODE_USAGE_PY must exit 0 even with no GPU tooling (stderr: ${r.stderr})`);
  assert.equal((r.stderr || "").trim(), "", "the probe must NEVER raise to stderr on a missing tool");

  const lines = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length >= 1, "the probe must print at least one JSON line");
  const parsed = JSON.parse(lines.at(-1));

  assert.equal(parsed.ok, false, "no nvidia-smi -> not ok");
  assert.deepEqual(parsed.gpus, [], "no per-GPU rows when nvidia-smi is absent (no fabricated reading)");
  assert.ok(Array.isArray(parsed.errors), "errors must be an array");
  assert.ok(
    parsed.errors.some((e) => /nvidia-smi/.test(e)),
    `the nvidia-smi absence must be captured in errors[], got ${JSON.stringify(parsed.errors)}`
  );
});

test("real NODE_USAGE_PY prints exactly one JSON object line (parseable by parseJsonLastLine)", () => {
  const r = runUsage({ PATH: "/nonexistent-node-usage-path" });
  assert.equal(r.status, 0, r.stderr);
  const lines = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean);
  const parsed = JSON.parse(lines.at(-1));
  assert.equal(typeof parsed, "object");
  for (const key of ["ok", "gpus", "errors"]) {
    assert.ok(Object.hasOwn(parsed, key), `JSON line must carry the ${key} field`);
  }
});

// SUCCESS PATH (hermetic, no real nvidia-smi): put a FAKE `nvidia-smi` on PATH that prints one CSV row
// in the exact --format=csv,noheader,nounits shape the probe queries, then run the REAL NODE_USAGE_PY.
// This actually exercises the `subprocess.run(... stdout=subprocess.PIPE, universal_newlines=True ...)`
// SUCCESS branch under the local python3 — i.e. it PROVES the 3.6-safe kwargs capture stdout as text and
// the row parses into a GPU reading. (With the old 3.7+ capture_output=/text= kwargs this is the call
// that would have blown up on a 3.6 node; here we assert the call shape works end-to-end.)
test("real NODE_USAGE_PY parses a GPU on the success path with a fake nvidia-smi (proves stdout=PIPE call shape)", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-usage-fakebin-"));
  try {
    const fake = path.join(binDir, "nvidia-smi");
    // Ignore all args; emit exactly one CSV row matching index,name,utilization,memory.used,memory.total.
    fs.writeFileSync(fake, "#!/bin/sh\necho '0, Tesla V100-SXM2-16GB, 37, 1024, 16160'\n", { mode: 0o755 });

    const r = runUsage({ PATH: binDir });
    assert.equal(r.status, 0, `success path must still exit 0 (stderr: ${r.stderr})`);
    assert.equal((r.stderr || "").trim(), "", "success path must not raise to stderr");

    const lines = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines.at(-1));

    assert.equal(parsed.ok, true, "a parseable GPU row -> ok:true");
    assert.deepEqual(parsed.errors, [], "no errors on the clean success path");
    assert.equal(parsed.gpus.length, 1, "exactly the one fake GPU row is parsed");
    assert.deepEqual(parsed.gpus[0], {
      index: 0,
      name: "Tesla V100-SXM2-16GB",
      utilization_gpu_percent: 37,
      memory_used_mb: 1024,
      memory_total_mb: 16160
    }, "the CSV row must parse into the pinned per-GPU JSON shape (proves stdout was captured as text)");
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
