import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// P0 daemonize coverage: the campaign progressor is shipped INLINE over `python3 -` as the FOREGROUND
// command of a two-hop SSH channel whose timeout is capped at 30s. In loop mode it MUST detach itself
// in Python (fork + setsid) so the parent `python3 -` exits promptly — the SSH channel closes well
// under the timeout — and the daemon child survives the channel teardown (immune to the SIGHUP/process-
// group death). The parent prints exactly one `{"pid": <child>}` line on the ORIGINAL stdout (before
// any redirection) so the brain can record the daemon's real pid. `--once` must NEVER daemonize.
//
// This harness forks the REAL src/ops/scheduler/node/progressor.py under python3 (mirroring
// progressor-reconcile.test.mjs) so the assertion exercises the actual wire bytes, not a stub.

const PROGRESSOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "src", "ops", "scheduler", "node", "progressor.py"
);

// If python3 is unavailable we MUST fail loudly rather than silently skip — the daemonization is the
// whole point of the P0 fix and an environment that cannot run it must surface that, not pass blank.
const PYTHON_OK = spawnSync("python3", ["-c", "import os; assert hasattr(os, 'fork')"], { encoding: "utf8" }).status === 0;

function makeCampaign({ plan, lease }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-daemon-"));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  if (lease) fs.writeFileSync(path.join(dir, "lease.json"), JSON.stringify(lease));
  return dir;
}

function basePlan(overrides = {}) {
  return {
    schema_version: "1.0.0",
    schema_compat_min: "1.0.0",
    campaign_id: "campaign_daemon",
    queue_id: "sha256:deadbeef",
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" },
    node_id: "mars01",
    profile_id: "utsihpc_user_01",
    limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/tmp"], env_key_allowlist: ["UTS_RUN_ID"] },
    policy: {
      on_job_failure: "continue",
      failure_breaker: { max_consecutive_failures: 5, require_one_success: true },
      idle_definition: "no_running_and_no_launchable_pending",
      idle_exit_seconds: 604800, restart_throttle_seconds: 2
    },
    jobs: [],
    ...overrides
  };
}

const LEASE = { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" };

test("python3 with os.fork must be available for the daemonize harness", () => {
  assert.ok(PYTHON_OK, "python3 with os.fork is required to verify the P0 daemonization fix");
});

test("loop mode DAEMONIZES: parent prints one {\"pid\":N} line then exits promptly, daemon detaches and writes STATE", () => {
  assert.ok(PYTHON_OK, "python3 with os.fork required");
  // A loop-mode plan with one always-running job (sleep) so the loop would NOT idle-exit immediately.
  // If the progressor stayed FOREGROUND, this spawn would block until the loop ended; with the fix the
  // parent forks the daemon and returns at once.
  const dir = makeCampaign({
    plan: basePlan({ jobs: [{ seq: 0, run_id: "run_0", command_argv: ["sleep", "30"],
      workdir: "/tmp", env: {}, gpu_index: 0, gpu_count: 1, timeout_seconds: 30 }] }),
    lease: LEASE
  });

  const started = Date.now();
  // Bound the parent at 10s: a correctly daemonizing parent returns in well under a second; a still-
  // FOREGROUND loop would hit this timeout (the sleep-30 job keeps it non-idle for ~30s) and prove the bug.
  const r = spawnSync("python3", [PROGRESSOR], {
    cwd: dir,
    env: { ...process.env, UTS_PROGRESSOR_STATE_DIR: dir, UTS_GPU_GUARD: "0" },
    encoding: "utf8",
    timeout: 10000
  });
  const elapsed = Date.now() - started;

  assert.equal(r.signal, null, `parent must NOT be killed by the harness timeout (still foreground?) — elapsed ${elapsed}ms`);
  assert.equal(r.status, 0, `parent must exit 0 after forking the daemon; stderr=${r.stderr}`);
  assert.ok(elapsed < 8000, `parent should return promptly after detaching, took ${elapsed}ms (foreground loop?)`);

  // the parent prints exactly one JSON line carrying the DAEMON's real pid on the ORIGINAL stdout.
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  assert.equal(lines.length, 1, `parent must print exactly one stdout line, got ${JSON.stringify(lines)}`);
  const parsed = JSON.parse(lines[0]);
  assert.equal(typeof parsed.pid, "number");
  assert.ok(parsed.pid > 1, `must report the daemon's real pid (> 1), got ${parsed.pid}`);
  assert.notEqual(parsed.pid, process.pid);

  // the detached daemon keeps running and writes STATE under the state dir; poll briefly for it.
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(path.join(dir, "state.json")) && Date.now() < deadline) { /* spin */ }
  assert.ok(fs.existsSync(path.join(dir, "state.json")), "the detached daemon must write STATE after the parent exits");

  // a logfile under the state dir captures the daemon's redirected stdout/stderr.
  assert.ok(fs.existsSync(path.join(dir, "progressor.log")), "daemon must redirect stdout/stderr to <state_dir>/progressor.log");

  // cleanup: stop the daemon (it is a new session leader == its own pgid) and any sleep child.
  try { process.kill(parsed.pid, "SIGTERM"); } catch { /* already gone */ }
  // best-effort: kill the slot's inner sleep if it claimed one.
  try {
    const runPid = Number(fs.readFileSync(path.join(dir, "slot_0", "run.pid"), "utf8").split("\n")[0]);
    if (runPid > 1) process.kill(runPid, "SIGKILL");
  } catch { /* none */ }
});

test("--once mode does NOT daemonize: a single foreground reconcile that returns directly (no pid-line detach)", () => {
  assert.ok(PYTHON_OK, "python3 with os.fork required");
  const dir = makeCampaign({ plan: basePlan(), lease: LEASE });
  const r = spawnSync("python3", [PROGRESSOR, "--once"], {
    cwd: dir,
    env: { ...process.env, UTS_PROGRESSOR_STATE_DIR: dir, UTS_GPU_GUARD: "0" },
    encoding: "utf8",
    timeout: 10000
  });
  assert.equal(r.status, 0, r.stderr);
  // --once keeps its current behavior: it does NOT print a {"pid":N} detach line and does NOT create
  // the daemon logfile (it ran in the foreground and wrote STATE directly).
  const lines = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { /* not json — fine for --once */ }
    if (parsed && typeof parsed === "object") {
      assert.ok(!("pid" in parsed), `--once must NOT emit a daemon pid-detach line, saw ${line}`);
    }
  }
  assert.ok(!fs.existsSync(path.join(dir, "progressor.log")), "--once must NOT create the daemon logfile");
  assert.ok(fs.existsSync(path.join(dir, "state.json")), "--once still writes STATE in the foreground");
});
