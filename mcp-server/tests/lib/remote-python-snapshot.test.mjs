// Golden byte-for-byte snapshot of the 8 embedded-Python helper bodies.
//
// These Python programs are SOURCE STRINGS sent over SSH and executed remotely; the TypeScript side
// parses each helper's SystemExit/fail() exit codes, so every byte (including the two divergent
// fail() variants and the two divergent path-safety checks) is load-bearing. This test pins the
// EXACT rendered string of each builder against a committed fixture under
// tests/fixtures/remote-python/<NAME>.py. It exists to prove that the lib/remote-python.ts extraction
// (recomposing each body from shared String.raw snippets) does not change a single wire byte: the
// fixtures were captured from the pre-refactor source and must keep matching afterward.
//
// If a builder legitimately changes, regenerate its fixture deliberately (see capture note below) and
// review the diff — do not loosen the assertion.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ARTIFACT_LIST_PY, ARTIFACT_FETCH_PY, ARTIFACT_CLEANUP_EXECUTE_PY } from "../../dist/ops/data/artifacts.js";
import { SUPERVISOR_PY } from "../../dist/ops/jobs/ihpc-start.js";
import { IHPC_STATUS_PY, IHPC_LOGS_PY, IHPC_CANCEL_PY } from "../../dist/ops/jobs/jobs.js";
import { TRANSFER_PREFLIGHT_PY } from "../../dist/ops/data/transfer.js";
import { PY_SHA256_FILE } from "../../dist/lib/remote-python.js";
import { READ_CHUNK_BYTES } from "../../dist/lib/shared.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "remote-python");

// name -> the live rendered builder string imported from dist/.
const BUILDERS = {
  ARTIFACT_LIST_PY,
  ARTIFACT_FETCH_PY,
  ARTIFACT_CLEANUP_EXECUTE_PY,
  SUPERVISOR_PY,
  IHPC_STATUS_PY,
  IHPC_LOGS_PY,
  IHPC_CANCEL_PY,
  TRANSFER_PREFLIGHT_PY
};

function readGolden(name) {
  // Read with no encoding-normalising transforms; the fixture holds the exact bytes.
  return fs.readFileSync(path.join(fixturesDir, `${name}.py`), "utf8");
}

for (const [name, rendered] of Object.entries(BUILDERS)) {
  test(`embedded Python ${name} renders byte-for-byte to its golden fixture`, () => {
    assert.equal(typeof rendered, "string", `${name} must be a string`);
    const golden = readGolden(name);
    assert.equal(
      rendered,
      golden,
      `${name} drifted from tests/fixtures/remote-python/${name}.py — the remote Python wire bytes changed`
    );
  });
}

// Cross-check the divergent contracts the brief calls out, so a future refactor that "unifies" the two
// fail() variants or the two path-safety checks fails LOUDLY here even if someone regenerated a fixture.
test("fail() exit-code contracts stay divergent across the 8 builders", () => {
  const FAIL_FIXED = 'def fail(message):\n    print(json.dumps({"error": message}), file=sys.stderr)\n    raise SystemExit(2)\n';
  const FAIL_CODED = 'def fail(message, code=2):\n    print(json.dumps({"error": message}), file=sys.stderr)\n    raise SystemExit(code)\n';

  // Fixed-exit-2 fail(): list, supervisor, status, logs, cancel, transfer preflight.
  for (const name of [
    "ARTIFACT_LIST_PY",
    "SUPERVISOR_PY",
    "IHPC_STATUS_PY",
    "IHPC_LOGS_PY",
    "IHPC_CANCEL_PY",
    "TRANSFER_PREFLIGHT_PY"
  ]) {
    assert.ok(BUILDERS[name].includes(FAIL_FIXED), `${name} must use the fixed SystemExit(2) fail()`);
    assert.ok(!BUILDERS[name].includes(FAIL_CODED), `${name} must NOT use the coded fail()`);
  }
  // Coded-exit fail(): fetch (exit 3/4 paths) and cleanup execute.
  for (const name of ["ARTIFACT_FETCH_PY", "ARTIFACT_CLEANUP_EXECUTE_PY"]) {
    assert.ok(BUILDERS[name].includes(FAIL_CODED), `${name} must use the coded fail(message, code=2)`);
    assert.ok(!BUILDERS[name].includes(FAIL_FIXED), `${name} must NOT use the fixed fail()`);
  }
});

test("the two remote path-safety variants stay distinct (commonpath vs real==root/startswith)", () => {
  const COMMONPATH =
    "def inside_realpath(candidate, root):\n    try:\n        return os.path.commonpath([candidate, root]) == root\n    except ValueError:\n        return False\n";
  // commonpath inside_realpath(): the 4 artifact/transfer file-walk helpers.
  for (const name of [
    "ARTIFACT_LIST_PY",
    "ARTIFACT_FETCH_PY",
    "ARTIFACT_CLEANUP_EXECUTE_PY",
    "TRANSFER_PREFLIGHT_PY"
  ]) {
    assert.ok(BUILDERS[name].includes(COMMONPATH), `${name} must use the commonpath inside_realpath`);
  }
  // SUPERVISOR_PY uses its OWN real==root or startswith(root + os.sep) check and must NOT carry the
  // commonpath variant — the two path-safety policies are deliberately not unified.
  assert.ok(!SUPERVISOR_PY.includes(COMMONPATH), "SUPERVISOR_PY must keep its real==root/startswith check");
  assert.ok(
    SUPERVISOR_PY.includes("real == root or real.startswith(root + os.sep)"),
    "SUPERVISOR_PY must retain the startswith path-safety check"
  );
});

// The remote sha256_file() helper reads the file in fixed chunks; its chunk size is the wire mirror of
// the local sha256File()'s lib/shared.ts READ_CHUNK_BYTES. Chunking does not affect the digest, so the
// two never disagree at runtime — which is exactly why a drift would go unnoticed without this guard.
// Compares VALUE, not text, so it still catches a rewrite to 1048576 or 2 * 1024 * 1024 on either side.
test("remote PY_SHA256_FILE read-chunk stays in lock-step with lib/shared READ_CHUNK_BYTES", () => {
  const match = PY_SHA256_FILE.match(/handle\.read\(([^)]+)\)/);
  assert.ok(match, "PY_SHA256_FILE must call handle.read(<chunk>)");
  const chunkExpr = match[1].trim(); // e.g. "1024 * 1024"

  // Evaluate the integer product without eval(): every factor must be a base-10 integer literal.
  const factors = chunkExpr.split("*").map((part) => part.trim());
  assert.ok(
    factors.every((f) => /^[0-9]+$/.test(f)),
    `unexpected chunk expression in PY_SHA256_FILE: "${chunkExpr}" — expected a product of integer literals`
  );
  const pyChunk = factors.reduce((product, f) => product * Number(f), 1);

  assert.equal(
    pyChunk,
    READ_CHUNK_BYTES,
    `remote PY_SHA256_FILE chunk (${chunkExpr} = ${pyChunk}) must equal lib/shared READ_CHUNK_BYTES (${READ_CHUNK_BYTES})`
  );

  // Every builder that embeds sha256_file() must carry that exact chunk on the wire.
  const embedders = Object.entries(BUILDERS).filter(([, body]) => body.includes("def sha256_file("));
  assert.ok(embedders.length >= 1, "at least one builder should embed sha256_file()");
  for (const [name, body] of embedders) {
    assert.ok(
      body.includes(`handle.read(${chunkExpr})`),
      `${name} embeds sha256_file() but not the expected read(${chunkExpr}) chunk`
    );
  }
});
