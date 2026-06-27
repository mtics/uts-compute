import assert from "node:assert/strict";
import test from "node:test";
import { isSafePbsJobId, isSafeRemoteJobId } from "../../dist/core/ids.js";
import { assertAllowedHpcJobRemoteArgv } from "../../dist/ops/jobs/jobs.js";
import { sshJobArgs } from "../../dist/lib/ssh.js";

// Regression for the P0 field-report defect: a successful `qsub` of a PBS Pro ARRAY job returns
// `<seq>[].<server>` (server = the executing host, e.g. hpc-head01), which the old narrow token
// grammar rejected — so a queued job looked like a failure, lost its id, and could be double-submitted.

test("isSafePbsJobId accepts PBS Pro job ids incl. array forms and non-default servers", () => {
  for (const ok of [
    "12345",
    "12345.pbsserver",
    "3852.hpc-head01",
    "3852[].hpc-head01",
    "3852[0].hpc-head01",
    "3852[7].hpc-head01"
  ]) {
    assert.equal(isSafePbsJobId(ok), true, `expected accept: ${ok}`);
  }
});

test("isSafePbsJobId rejects injection and malformed ids", () => {
  for (const bad of [
    "3852; rm -rf /",
    "3852`whoami`",
    "3852$(id)",
    "3852 4321",
    "3852[].hpc head01",
    "ihpc-run-1", // an iHPC id is NOT a PBS id
    "",
    "[].srv",
    "3852[].",
    ".srv",
    "3852[a].srv",
    "3852[]extra"
  ]) {
    assert.equal(isSafePbsJobId(bad), false, `expected reject: ${bad}`);
  }
});

test("the broad isSafeRemoteJobId still covers iHPC ids but deliberately omits brackets", () => {
  assert.equal(isSafeRemoteJobId("ihpc-myrun-1234"), true);
  assert.equal(isSafeRemoteJobId("3852[].hpc-head01"), false);
});

test("assertAllowedHpcJobRemoteArgv allowlists qstat/qdel for an array job id", () => {
  assert.doesNotThrow(() => assertAllowedHpcJobRemoteArgv(["qstat", "-f", "3852[].hpc-head01"]));
  assert.doesNotThrow(() => assertAllowedHpcJobRemoteArgv(["qstat", "-x", "-f", "3852[0].hpc-head01"]));
  assert.doesNotThrow(() => assertAllowedHpcJobRemoteArgv(["qdel", "3852[].hpc-head01"]));
  assert.throws(() => assertAllowedHpcJobRemoteArgv(["qdel", "3852; rm -rf /"]), /not allowlisted/);
});

// P0 zero-log / instant-fail fix: a fixed `mkdir -p -- <log_dir> <workdir>` runs over SSH BEFORE qsub
// so PBS can open its `-o`/`-e` files (it does NOT create their parent dir) and the script's `cd` under
// `set -e` lands in an existing dir. The allowlist admits ONLY this fixed shape (EXACTLY 2 safe-path
// operands, length 5) — ensureRemoteWorkdirs never builds any other count, so the allowlist matches
// reality. The allowlist guarantees the fixed SHAPE + safe-path tokens only; roots-confinement of the
// two operands is the caller's (ensureRemoteWorkdirs) responsibility, not the allowlist's.
test("assertAllowedHpcJobRemoteArgv allowlists the fixed mkdir -p -- <log_dir> <workdir> shape and rejects injection", () => {
  // The allowlist checks SHAPE only, so a still-literal ${USER} path is a valid shape here (the
  // unresolved-${USER} fail-closed check lives in ensureRemoteWorkdirs, not in the allowlist).
  assert.doesNotThrow(() =>
    assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--", "/shared/homes/${USER}/experiments/run-1/logs", "/shared/homes/${USER}/experiments/run-1"])
  );
  // Concrete (resolved) paths are the real live shape (the planner resolves ${USER} ahead of time).
  assert.doesNotThrow(() =>
    assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--", "/data/u00000001/experiments/run-2/logs", "/data/u00000001/experiments/run-2"])
  );

  // Missing the `--` end-of-options guard.
  assert.throws(
    () => assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "/shared/homes/x/run/logs", "/shared/homes/x/run"]),
    /not allowlisted/
  );
  // Wrong flag (only `-p` is permitted).
  assert.throws(
    () => assertAllowedHpcJobRemoteArgv(["mkdir", "-rf", "--", "/shared/homes/x/run"]),
    /not allowlisted/
  );
  // No path operands at all.
  assert.throws(() => assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--"]), /not allowlisted/);
  // An injection token in the path position (shell metacharacters fail isSafeRemotePath).
  assert.throws(
    () => assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--", "/shared/homes/x/run; rm -rf /"]),
    /not allowlisted/
  );
  // A non-path operand (does not start with `/`).
  assert.throws(
    () => assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--", "not-an-absolute-path"]),
    /not allowlisted/
  );
  // A relative-traversal operand.
  assert.throws(
    () => assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--", "/shared/homes/x/../../etc"]),
    /not allowlisted/
  );
  // Item 2 length-tightening: exactly TWO operands (length 5) is the only accepted shape. ONE operand
  // (length 4) and THREE operands (length 6) are now REJECTED — ensureRemoteWorkdirs only ever builds
  // the exact <log_dir> <workdir> pair, so any other count is off-contract.
  assert.throws(
    () => assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--", "/shared/homes/x/run"]),
    /not allowlisted/
  );
  assert.throws(
    () => assertAllowedHpcJobRemoteArgv(["mkdir", "-p", "--", "/a/1", "/a/2", "/a/3"]),
    /not allowlisted/
  );
});

test("sshJobArgs shell-quotes an array id (literal []) but leaves plain ids and ${USER} paths verbatim", () => {
  const quoted = sshJobArgs("uts-hpc", 10000, ["qdel", "3852[].hpc-head01"]);
  assert.equal(quoted.at(-1), "'3852[].hpc-head01'", "array id must be single-quoted for the remote shell");
  assert.equal(quoted.at(-2), "qdel", "command token stays verbatim");

  const plain = sshJobArgs("uts-hpc", 10000, ["qstat", "-f", "1234.pbsserver"]);
  assert.equal(plain.at(-1), "1234.pbsserver", "a non-array id needs no quoting");

  // A tail path intentionally carries ${USER} for REMOTE shell expansion — it must NOT be quoted.
  const tail = sshJobArgs("uts-hpc", 10000, ["tail", "-c", "2048", "--", "/shared/homes/${USER}/x/job.out"]);
  assert.equal(tail.at(-1), "/shared/homes/${USER}/x/job.out", "remote ${USER} expansion must be preserved");
});
