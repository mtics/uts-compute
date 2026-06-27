import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { captureReproducibility, probeGit, probeEnvironment } from "../../dist/ops/plans/reproducibility.js";
import { planJob } from "../../dist/ops/plans/planner.js";
import { repoRoot, tempRuntimeDir } from "../helpers/index.mjs";

function fakeGit(map) {
  return (args) => map[args.join(" ")] ?? { ok: false, stdout: "" };
}

const cleanRepo = fakeGit({
  "rev-parse HEAD": { ok: true, stdout: "c".repeat(40) },
  "rev-parse --abbrev-ref HEAD": { ok: true, stdout: "main" },
  "status --porcelain": { ok: true, stdout: "" }
});

test("probeGit reports sha, branch, and a dirty working tree", () => {
  const runner = fakeGit({
    "rev-parse HEAD": { ok: true, stdout: "a".repeat(40) },
    "rev-parse --abbrev-ref HEAD": { ok: true, stdout: "feature/x" },
    "status --porcelain": { ok: true, stdout: " M mcp-server/src/planner.ts" }
  });
  assert.deepEqual(probeGit(runner), { sha: "a".repeat(40), branch: "feature/x", dirty: true });
});

test("probeGit reports a clean working tree", () => {
  assert.deepEqual(probeGit(cleanRepo), { sha: "c".repeat(40), branch: "main", dirty: false });
});

test("probeGit returns available:false when git fails or the dir is not a repo", () => {
  assert.deepEqual(probeGit(() => ({ ok: false, stdout: "" })), { available: false });
  // a non-40-hex HEAD (e.g. unexpected output) is also treated as unavailable
  assert.deepEqual(probeGit(fakeGit({ "rev-parse HEAD": { ok: true, stdout: "not-a-sha" } })), { available: false });
});

test("captureReproducibility stamps captured_at and redacts secrets in the command", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const repro = captureReproducibility("python train.py --token=abc123secret", now, { gitRunner: cleanRepo });
  assert.equal(repro.captured_at, now.toISOString());
  assert.deepEqual(repro.git, { sha: "c".repeat(40), branch: "main", dirty: false });
  assert.match(repro.command, /--token=<redacted>/);
  assert.doesNotMatch(repro.command, /abc123secret/);
});

test("jobs.plan writes a reproducibility block into the run record", () => {
  const auditDir = tempRuntimeDir("test-repro-runs");
  const planDir = tempRuntimeDir("test-repro-plans");
  const job = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs", "hpc-cpu.json"), "utf8"));

  const plan = planJob(job, {
    configPath: "profiles/profiles.example.yaml",
    auditDir,
    planDir,
    gitRunner: cleanRepo
  });

  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  assert.ok(record.reproducibility, "run record carries a reproducibility block");
  assert.equal(record.reproducibility.git.sha, "c".repeat(40));
  assert.equal(record.reproducibility.git.dirty, false);
  assert.equal(record.reproducibility.command, "python train.py --epochs 1");
  // reproducibility must NOT perturb the deterministic plan hash
  const planAgain = planJob(job, { configPath: "profiles/profiles.example.yaml", auditDir, planDir, gitRunner: () => ({ ok: false, stdout: "" }) });
  assert.equal(planAgain.plan_hash, plan.plan_hash);
});

function fakeEnv(map) {
  return (program, args) => map[`${program} ${args.join(" ")}`] ?? { ok: false, stdout: "" };
}
const realisticEnv = fakeEnv({
  "python3 --version": { ok: true, stdout: "Python 3.11.4\n" },
  "python3 -m pip freeze": { ok: true, stdout: "numpy==1.26.0\ntorch==2.3.0\n" }
});

test("probeEnvironment captures the python version and a pip-freeze digest", () => {
  const env = probeEnvironment(realisticEnv);
  assert.equal(env.python_version, "Python 3.11.4");
  assert.match(env.packages_sha256, /^[a-f0-9]{64}$/);
  // the digest is over the exact freeze output, so a different package set yields a different hash
  const other = probeEnvironment(fakeEnv({
    "python3 --version": { ok: true, stdout: "Python 3.11.4\n" },
    "python3 -m pip freeze": { ok: true, stdout: "numpy==1.27.0\n" }
  }));
  assert.notEqual(other.packages_sha256, env.packages_sha256);
});

test("probeEnvironment returns available:false when python/pip are absent", () => {
  assert.deepEqual(probeEnvironment(() => ({ ok: false, stdout: "" })), { available: false });
});

test("captureReproducibility captures environment only when an envRunner is provided", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");
  const withEnv = captureReproducibility("python train.py", now, { gitRunner: cleanRepo, envRunner: realisticEnv });
  assert.equal(withEnv.environment.python_version, "Python 3.11.4");
  const withoutEnv = captureReproducibility("python train.py", now, { gitRunner: cleanRepo });
  assert.equal(withoutEnv.environment, undefined);
});

test("captured environment is recorded but does not perturb the deterministic plan hash", () => {
  const auditDir = tempRuntimeDir("test-repro-env-runs");
  const planDir = tempRuntimeDir("test-repro-env-plans");
  const job = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs", "hpc-cpu.json"), "utf8"));
  const withEnv = planJob(job, { configPath: "profiles/profiles.example.yaml", auditDir, planDir, gitRunner: cleanRepo, envRunner: realisticEnv });
  const record = JSON.parse(fs.readFileSync(withEnv.audit_path, "utf8"));
  assert.equal(record.reproducibility.environment.python_version, "Python 3.11.4");
  assert.match(record.reproducibility.environment.packages_sha256, /^[a-f0-9]{64}$/);
  const withoutEnv = planJob(job, { configPath: "profiles/profiles.example.yaml", auditDir, planDir, gitRunner: cleanRepo });
  assert.equal(withEnv.plan_hash, withoutEnv.plan_hash);
});
