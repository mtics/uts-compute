// Single child-process transport primitive shared by every module that shells out (access, doctor,
// quotas, jobs, submit, transfer, artifacts, ihpc-start). Each module previously carried a private
// byte-identical `default*Executor`; consolidated here so the copies can't drift apart.
//
// Behavioural contract (the union of all six prior copies):
//   - spawn with { shell: false, windowsHide: true } — no shell interpolation, ever.
//   - capture stdout/stderr as utf8 strings.
//   - SIGTERM the child after `timeoutMs` and flag `timedOut`.
//   - on spawn error, resolve exitCode=null with stderr falling back to the error message.
//   - pipe `stdin` (string) to the child when provided; otherwise close stdin with no input.
//
// NOTE: the five stdin-capable executors (artifacts, jobs, transfer, ihpc-start, submit) always
// closed the child's stdin. access's `defaultCommandExecutor` historically never touched stdin at
// all — it relied on its BatchMode ssh probes reading no input. Routing access through runProcess
// adds a `child.stdin?.end()` for those probes; that is harmless (BatchMode ssh consumes no stdin)
// but is a real delta, so the access migration is pinned by a dedicated stdin-lifecycle regression
// test (see tests/access.test.mjs).

// Leaf module: imports only node:child_process — no domain imports, no cycles.

import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

// The shared shape of every module's command executor. Callers that need their own narrower alias
// (JobCommandExecutor, ArtifactExecutor, …) keep it for documentation, but all are assignable here.
export type Executor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin?: string
) => Promise<CommandResult>;

export const runProcess: Executor = (program, args, timeoutMs, stdin) =>
  new Promise((resolve) => {
    const child = spawn(program, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
