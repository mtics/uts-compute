// Reproducibility capture for jobs.plan: records *what code* and *what command* produced a plan,
// so a result can be reproduced months later. Written into the run record (never into plan_hash,
// which must stay stable). Git probing is best-effort and read-only; a non-repo or missing git
// yields { available: false } rather than an error.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { redactCommand } from "../../core/audit.js";
import { projectRoot } from "../../core/paths.js";
import type { EnvironmentState, GitState, Reproducibility } from "../../core/types.js";

// Injectable for tests; returns { ok, stdout } and never throws.
export type GitRunner = (args: string[]) => { ok: boolean; stdout: string };

export function makeGitRunner(cwd: string): GitRunner {
  return (args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (result.error || typeof result.stdout !== "string" || result.status !== 0) {
      return { ok: false, stdout: "" };
    }
    return { ok: true, stdout: result.stdout.trim() };
  };
}

export function probeGit(runner: GitRunner): GitState | { available: false } {
  const head = runner(["rev-parse", "HEAD"]);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout)) {
    return { available: false };
  }
  const branch = runner(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runner(["status", "--porcelain"]);
  return {
    sha: head.stdout,
    branch: branch.ok && branch.stdout.length > 0 ? branch.stdout : "unknown",
    dirty: status.ok ? status.stdout.length > 0 : false
  };
}

// Injectable for tests; runs an arbitrary program and returns { ok, stdout } without throwing.
export type EnvRunner = (program: string, args: string[]) => { ok: boolean; stdout: string };

export function makeEnvRunner(cwd: string): EnvRunner {
  return (program: string, args: string[]) => {
    const result = spawnSync(program, args, { cwd, encoding: "utf8", timeout: 5000, windowsHide: true });
    if (result.error || typeof result.stdout !== "string" || result.status !== 0) {
      return { ok: false, stdout: "" };
    }
    return { ok: true, stdout: result.stdout };
  };
}

// Best-effort Python interpreter version + a `pip freeze` digest (the exact package set), so an
// environment can be reconstructed later. Returns { available: false } when neither is observed.
export function probeEnvironment(runner: EnvRunner): EnvironmentState | { available: false } {
  const version = runner("python3", ["--version"]);
  const freeze = runner("python3", ["-m", "pip", "freeze"]);
  const pythonVersion = version.ok && /^Python \d/.test(version.stdout.trim()) ? version.stdout.trim() : null;
  const frozen = freeze.ok ? freeze.stdout.trim() : "";
  const packagesSha256 = frozen.length > 0 ? createHash("sha256").update(frozen).digest("hex") : null;
  if (pythonVersion === null && packagesSha256 === null) {
    return { available: false };
  }
  return { python_version: pythonVersion, packages_sha256: packagesSha256 };
}

export function captureReproducibility(
  command: string,
  now: Date,
  options: { gitRunner?: GitRunner; cwd?: string; envRunner?: EnvRunner } = {}
): Reproducibility {
  const runner = options.gitRunner ?? makeGitRunner(options.cwd ?? projectRoot);
  return {
    captured_at: now.toISOString(),
    command: redactCommand(command),
    git: probeGit(runner),
    // Environment capture is opt-in (the jobs.plan tool enables it) so the test suite and pure
    // planning paths don't shell out to python/pip on every plan.
    ...(options.envRunner ? { environment: probeEnvironment(options.envRunner) } : {})
  };
}
