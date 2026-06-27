import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Spawn a genuinely-live, long-lived process and return its real pid WITHOUT blocking. We must detach +
// ignore stdio: a `sleep 30` that inherits a pipe keeps spawnSync (or the parent) waiting on that pipe
// for the full 30s. `detached + stdio:"ignore" + unref` gives us a live pid the test can probe and kill
// immediately. Used to simulate a reused/foreign pid (alive but not OUR job).
function spawnLiveVictim() {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

const PROGRESSOR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "src", "ops", "scheduler", "node", "progressor.py"
);

// 在 tmp campaign 目录里跑一轮推进器。env 注入 stub bin 目录(假 nvidia-smi)。
function runProgressor(campaignDir, { oneShot = true, env = {} } = {}) {
  return spawnSync("python3", [PROGRESSOR, "--once"], {
    cwd: campaignDir,
    env: { ...process.env, UTS_PROGRESSOR_STATE_DIR: campaignDir, ...env },
    encoding: "utf8"
  });
}

// Each launched wrapper writes its slot_<seq>/result.json asynchronously (detached session leader).
// A bare --once pass returns as soon as it spawns the wrapper, so between passes we give the in-flight
// slot a brief window to land its terminal marker before the next pass evaluates the queue/breaker.
// This mirrors the resident loop's restart_throttle pacing without coupling to wall-clock timing.
function waitMarkers(dir, total, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let terminal = 0;
    for (let s = 0; s < total; s += 1) {
      if (fs.existsSync(path.join(dir, `slot_${s}`, "result.json"))) terminal += 1;
    }
    // settle once the single in-flight slot (slot_count=1) has a marker, or all are terminal
    const running = fs.existsSync(path.join(dir, "slot_0")) &&
      !fs.existsSync(path.join(dir, "slot_0", "result.json"));
    if (terminal >= total || !running) break;
  }
}

function makeCampaign({ plan, lease }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-"));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
  if (lease) fs.writeFileSync(path.join(dir, "lease.json"), JSON.stringify(lease));
  return dir;
}

function basePlan(overrides = {}) {
  return {
    schema_version: "1.0.0",
    schema_compat_min: "1.0.0",
    campaign_id: "campaign_test",
    queue_id: "sha256:deadbeef",
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" },
    node_id: "mars01",
    profile_id: "utsihpc_user_01",
    limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/tmp"], env_key_allowlist: ["CUDA_VISIBLE_DEVICES", "UTS_RUN_ID"] },
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

test("progressor refuses a PLAN whose lease_owner != node lease holder", () => {
  const dir = makeCampaign({
    plan: basePlan(),
    lease: { client: "codex", device_id: "other-box", pid: 999, queue_id: "sha256:deadbeef" }
  });
  const r = runProgressor(dir);
  assert.notEqual(r.status, 0, "must exit non-zero on lease mismatch");
  assert.match(r.stderr, /lease/i);
  assert.equal(fs.existsSync(path.join(dir, "state.json")), false, "must not write STATE on lease refusal");
});

test("progressor writes a durable STATE on an empty-jobs PLAN and is idle", () => {
  const dir = makeCampaign({
    plan: basePlan(),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 123, queue_id: "sha256:deadbeef" }
  });
  const r = runProgressor(dir);
  assert.equal(r.status, 0, r.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.schema_version, "1.0.0");
  assert.equal(state.campaign_id, "campaign_test");
  assert.equal(state.queue_id, "sha256:deadbeef");
  assert.deepEqual(state.lease_owner, { client: "claude", device_id: "laptop-7f3a" });
  assert.equal(typeof state.node_clock_epoch, "number");
  assert.equal(typeof state.progressor.heartbeat_node, "string");
  assert.deepEqual(state.counts, { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, conflict: 0 });
});

// 写一个 stub nvidia-smi 到 bin/,prepend 进 PATH。
// The TARGET-specific fail-closed guard runs TWO queries: (1) --query-gpu=index,uuid maps the
// physical index -> a uuid; (2) --query-compute-apps=pid,used_gpu_memory,gpu_uuid lists foreign
// apps by uuid. The stub answers BOTH so the guard can correlate a foreign pid to a SPECIFIC gpu.
//   busyGpu === null  -> no compute apps anywhere (free)
//   busyGpu === <int> -> one foreign compute app pinned to that gpu index's uuid
// We synthesize a deterministic uuid per index ("GPU-0000...000<index>") for both queries.
function withStubNvidiaSmi(dir, { busyGpu = null, gpus = [0, 1] } = {}) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const smi = path.join(bin, "nvidia-smi");
  const uuidFor = (i) => `GPU-00000000-0000-0000-0000-00000000000${i}`;
  const indexUuidLines = gpus.map((i) => `${i}, ${uuidFor(i)}`).join("\\n");
  const computeLine = busyGpu === null ? "" : `999999, 512 MiB, ${uuidFor(busyGpu)}`;
  // The guard distinguishes the two queries by matching "query-gpu" vs "query-compute-apps" in argv.
  const body = `#!/bin/sh
for a in "$@"; do
  case "$a" in
    *query-gpu*) printf '%b\\n' "${indexUuidLines}"; exit 0 ;;
    *query-compute-apps*) printf '%s\\n' "${computeLine}"; exit 0 ;;
  esac
done
exit 0
`;
  fs.writeFileSync(smi, body, { mode: 0o755 });
  return bin;
}

// A stub that simulates nvidia-smi being unparseable/erroring -> the guard MUST fail closed.
function withBrokenNvidiaSmi(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  // exit non-zero with garbage on stdout: neither query returns a usable index->uuid map.
  fs.writeFileSync(path.join(bin, "nvidia-smi"),
    `#!/bin/sh\necho "garbage not-a-csv"\nexit 7\n`, { mode: 0o755 });
  return bin;
}

function jobSpec(seq, argv, overrides = {}) {
  return {
    seq, run_id: `run_${seq}`, command_argv: argv,
    workdir: overrides.workdir ?? "/tmp",
    env: overrides.env ?? { UTS_RUN_ID: "$RUN_ID$" },
    gpu_index: overrides.gpu_index ?? 0, gpu_count: 1, timeout_seconds: 30
  };
}

test("progressor launches a ready job, harvests its terminal marker, never reruns it", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "import sys; sys.exit(0)"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  // pass 1: 认领并启动 seq 0
  let r = runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr);
  // 给作业一点时间退出,再跑 pass 2 收割
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.seq, 0);
  assert.equal(result.exit_code, 0);
  // pass 3: 已完成的 seq 0 不得被重新 fire(无第二个 launching.marker / attempt 不增)
  r = runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.jobs["0"].status, "done");
  assert.equal(state.counts.done, 1);
});

test("progressor marks placement_conflict (not exec) when the target GPU is foreign-busy", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "open('/tmp/SHOULD_NOT_RUN','w')"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: 0 });
  // the wrapper writes result.json asynchronously; poll for it (each pass re-runs reconcile)
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "placement_conflict");
  assert.equal(fs.existsSync("/tmp/SHOULD_NOT_RUN"), false, "the job must NOT have exec'd");
});

test("GPU guard is TARGET-specific: a foreign app on a DIFFERENT gpu index is NOT a conflict (job runs)", () => {
  // foreign compute app pinned to gpu index 1; the job targets gpu index 0 -> must NOT conflict.
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "open('/tmp/RAN_ON_FREE_GPU','w')"], { gpu_index: 0 })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  fs.rmSync("/tmp/RAN_ON_FREE_GPU", { force: true });
  const bin = withStubNvidiaSmi(dir, { busyGpu: 1 }); // busy GPU != target GPU 0
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.notEqual(result.status, "placement_conflict",
    "a foreign app on a different gpu index must not block the target gpu (target-specific guard)");
  assert.equal(result.exit_code, 0);
  assert.equal(fs.existsSync("/tmp/RAN_ON_FREE_GPU"), true, "the job SHOULD have exec'd on the free target gpu");
  fs.rmSync("/tmp/RAN_ON_FREE_GPU", { force: true });
});

test("GPU guard FAILS CLOSED: an unparseable/erroring nvidia-smi marks placement_conflict (job not exec'd)", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "open('/tmp/SHOULD_NOT_RUN_FC','w')"], { gpu_index: 0 })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  fs.rmSync("/tmp/SHOULD_NOT_RUN_FC", { force: true });
  const bin = withBrokenNvidiaSmi(dir); // unparseable output + non-zero exit -> cannot prove free
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "placement_conflict", "unparseable nvidia-smi must fail CLOSED, never assume free");
  assert.equal(fs.existsSync("/tmp/SHOULD_NOT_RUN_FC"), false, "the job must NOT have exec'd when the guard cannot prove the gpu free");
  fs.rmSync("/tmp/SHOULD_NOT_RUN_FC", { force: true });
});

test("progressor rejects an env key not in the allowlist", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "pass"], { env: { LD_PRELOAD: "/evil.so" } })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  // the wrapper writes result.json asynchronously; poll for it (each pass re-runs reconcile)
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "failed");
  assert.match(JSON.stringify(result), /allowlist|env/i);
});

test("launch EXCEPTION (non-executable command) writes a terminal failed marker, never a wedged orphan seq", () => {
  // A real, confinement-passing, GPU-guard-passing launch whose subprocess.Popen RAISES: the command
  // argv points at a file that exists but is NOT executable (no +x), so Popen raises PermissionError
  // (EACCES) AFTER step 2-4 pass and AFTER makedirs/open(log). Before the fix the wrapper would exit
  // non-zero with NO result.json (the finally only cleared the launch marker), so classify_seq returns
  // `pending` forever — a wedged orphan the campaign reconcile can never act on. After the fix the
  // wrapper catches the exception and writes a TERMINAL status=failed result marker (exit_code=null +
  // a reason), so reconcile maps the seq to `failed` and the campaign can move on / retry.
  const dir = makeCampaign({ plan: basePlan(), lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" } });
  // Isolate fully under the campaign's own unique mkdtemp dir: allowed_roots AND the job workdir both
  // point at `dir`, so this test shares NO path with any concurrent peer and the non-exec file lives in
  // the confined root. The file exists but is NOT executable (mode 0o644), so Popen([notExec]) raises
  // PermissionError (EACCES) AFTER confinement (step 2) and the GPU guard (step 4, stub reports free).
  const notExec = path.join(dir, "not-executable.bin");
  fs.writeFileSync(notExec, "#!/bin/sh\necho should-never-run\n", { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(basePlan({
    security: { allowed_roots: [dir], env_key_allowlist: ["UTS_RUN_ID"] },
    jobs: [jobSpec(0, [notExec], { workdir: dir })]
  })));
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  // Fire EXACTLY ONE pass to claim + spawn the (detached) wrapper, then PASSIVELY poll the filesystem
  // for the marker the wrapper writes synchronously before it exits — no tight re-launch loop, so this
  // test adds no concurrent fork churn to its peers.
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) { /* passive wait */ }
  assert.ok(fs.existsSync(path.join(dir, "slot_0", "result.json")),
    "a launch that RAISES must still write a TERMINAL result marker (else the seq wedges pending forever)");
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "failed", "a launch exception is a terminal failed, not a silent orphan");
  assert.equal(result.exit_code, null, "no inner process ever ran -> exit_code is null, never a false 0");
  assert.match(JSON.stringify(result), /launch|start|exec|permission|denied/i,
    "the failed marker should carry a launch-failure reason");
  // and reconcile must MAP it to failed (campaign can act on it), not leave it pending/orphan
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.jobs["0"].status, "failed", "reconcile must map the launch-exception seq to failed");
  assert.equal(state.counts.failed, 1, "the failed seq must be counted, never left pending");
  assert.equal(state.counts.pending, 0, "a launch exception must NOT leave the seq wedged pending");
});

test("launch-marker prevents re-firing a seq when killed mid-launch (no double-fire)", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["sleep", "30"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); // claims + launches
  // run.pid 存在且活 => 第二轮不得再 fire(adopt,占其 slot)
  // give the wrapper a moment to write run.pid before pass 2
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "run.pid")) && Date.now() < deadline) {}
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const slot = fs.readdirSync(path.join(dir, "slot_0"));
  assert.ok(slot.includes("run.pid"), "claimed marker must have become run.pid");
  // 只有一个活作业:slot_count=1,不会有 slot_0 的第二个 attempt 在跑
  const pid = Number(fs.readFileSync(path.join(dir, "slot_0", "run.pid"), "utf8").trim());
  try { process.kill(pid, "SIGKILL"); } catch (_e) { /* already gone */ } // 清理 sleep 30
});

test("failure_breaker trips after N consecutive failures with zero success", () => {
  const dir = makeCampaign({
    plan: basePlan({
      limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 0 },
      policy: {
        on_job_failure: "continue",
        failure_breaker: { max_consecutive_failures: 2, require_one_success: true },
        idle_definition: "no_running_and_no_launchable_pending",
        idle_exit_seconds: 604800, restart_throttle_seconds: 0
      },
      jobs: [0, 1, 2].map((s) => jobSpec(s, ["python3", "-c", "import sys; sys.exit(1)"]))
    }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  // run resident-ish: many --once passes; breaker must trip before all 3 finish
  for (let i = 0; i < 12; i++) { runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); waitMarkers(dir, 3); }
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.health.breaker_tripped, true);
});

test("failure_breaker does NOT trip with require_one_success once a job has succeeded (C-4 pin)", () => {
  // [done, fail, fail, fail] with limit=2 + require_one_success: a proven harness DISARMS the breaker.
  // This pins the spec-2.6 "且零成功" reading so it is never silently turned into a recency breaker.
  const dir = makeCampaign({
    plan: basePlan({
      limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 0 },
      policy: {
        on_job_failure: "continue",
        failure_breaker: { max_consecutive_failures: 2, require_one_success: true },
        idle_definition: "no_running_and_no_launchable_pending",
        idle_exit_seconds: 604800, restart_throttle_seconds: 0
      },
      jobs: [
        jobSpec(0, ["python3", "-c", "import sys; sys.exit(0)"]),
        jobSpec(1, ["python3", "-c", "import sys; sys.exit(1)"]),
        jobSpec(2, ["python3", "-c", "import sys; sys.exit(1)"]),
        jobSpec(3, ["python3", "-c", "import sys; sys.exit(1)"])
      ]
    }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  for (let i = 0; i < 16; i++) { runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); waitMarkers(dir, 4); }
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.counts.done, 1);
  assert.equal(state.health.breaker_tripped, false, "a proven harness must NOT be breaker-paused (spec 2.6 '且零成功')");
});

test("failure_breaker DOES trip on streak even after a success when require_one_success is false (C-4 pin)", () => {
  // require_one_success: false -> the streak alone trips, prior success notwithstanding.
  const dir = makeCampaign({
    plan: basePlan({
      limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 0 },
      policy: {
        on_job_failure: "continue",
        failure_breaker: { max_consecutive_failures: 2, require_one_success: false },
        idle_definition: "no_running_and_no_launchable_pending",
        idle_exit_seconds: 604800, restart_throttle_seconds: 0
      },
      jobs: [
        jobSpec(0, ["python3", "-c", "import sys; sys.exit(0)"]),
        jobSpec(1, ["python3", "-c", "import sys; sys.exit(1)"]),
        jobSpec(2, ["python3", "-c", "import sys; sys.exit(1)"])
      ]
    }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  for (let i = 0; i < 12; i++) { runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); waitMarkers(dir, 3); }
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.health.breaker_tripped, true, "streak>=N trips regardless of prior success when require_one_success=false");
});

test("crash recovery: a pre-existing terminal marker is trusted and the job never reruns", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "open('/tmp/RERUN_PROOF','a')"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  // inject a done result.json BEFORE any pass (simulates a crash AFTER rename+dir-fsync)
  fs.mkdirSync(path.join(dir, "slot_0"));
  fs.writeFileSync(path.join(dir, "slot_0", "result.json"),
    JSON.stringify({ seq: 0, run_id: "run_0", exit_code: 0, signal: null,
      started_at_node: "x", finished_at_node: "y", duration_seconds: 1, attempt: 0 }));
  fs.rmSync("/tmp/RERUN_PROOF", { force: true });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  for (let i = 0; i < 3; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(fs.existsSync("/tmp/RERUN_PROOF"), false, "completed job must NEVER rerun (spec 2.6)");
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.jobs["0"].status, "done");
});

const HAVE_PROC_STAT = fs.existsSync("/proc/self/stat");

// Read /proc/<pid>/stat field 22 (starttime, clock ticks since boot) the same way the progressor does.
// The comm field (field 2) is wrapped in parens and may itself contain spaces/parens, so we split AFTER
// the last ")" to land on a clean " S 1 2 ..." remainder whose 20th whitespace token is starttime.
function procStarttime(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const rparen = raw.lastIndexOf(")");
  const rest = raw.slice(rparen + 2).trim().split(/\s+/);
  return rest[19]; // field 22 overall; field 3 (state) is index 0 of `rest`, so starttime is index 19
}

test("pid-reuse: a LIVE pid whose /proc starttime MISMATCHES the recorded start-evidence is NOT running", { skip: !HAVE_PROC_STAT }, () => {
  // Anti-pid-reuse (spec 2.5): a bare `kill -0` only proves SOME process holds the pid, not OURS. We
  // launch a real, long-lived process, record its pid, but write a run.pid whose third line (the
  // /proc starttime captured at launch) is a value that can NEVER match the live process's actual
  // starttime. classify_seq must therefore REFUSE to call it running (downgrade to pending), because
  // the live pid is provably a DIFFERENT process than the one we launched (a reused pid after reboot).
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["true"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const livePid = spawnLiveVictim();
  try {
    fs.mkdirSync(path.join(dir, "slot_0"));
    // third line = a starttime that does NOT match the live process (pid is alive, start-evidence wrong)
    fs.writeFileSync(path.join(dir, "slot_0", "run.pid"), `${livePid}\n2026-06-20T00:00:00Z\n1\n`);
    const bin = withStubNvidiaSmi(dir, { busyGpu: null });
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.notEqual(state.jobs["0"].status, "running",
      "a live pid with mismatched start-evidence must NOT be running (pid reuse); it is re-eligible pending");
  } finally {
    try { process.kill(livePid, "SIGKILL"); } catch (_e) { /* already gone */ }
  }
});

test("pid-reuse: a LIVE pid whose /proc starttime MATCHES the recorded start-evidence stays running", { skip: !HAVE_PROC_STAT }, () => {
  // The happy path: a process we are genuinely supervising. We write run.pid with the CORRECT /proc
  // starttime third line, so classify_seq can prove the live pid is the same process we launched and
  // keeps it `running` (no spurious downgrade of a real live job).
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["true"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const livePid = spawnLiveVictim();
  try {
    fs.mkdirSync(path.join(dir, "slot_0"));
    const realStart = procStarttime(livePid);
    fs.writeFileSync(path.join(dir, "slot_0", "run.pid"), `${livePid}\n2026-06-20T00:00:00Z\n${realStart}\n`);
    const bin = withStubNvidiaSmi(dir, { busyGpu: null });
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.jobs["0"].status, "running",
      "a live pid whose /proc starttime matches the recorded launch evidence is genuinely our process");
  } finally {
    try { process.kill(livePid, "SIGKILL"); } catch (_e) { /* already gone */ }
  }
});

test("pid-reuse: a run.pid with NO start-evidence third line is NOT trusted as running (fail closed)", { skip: !HAVE_PROC_STAT }, () => {
  // Absence of the start-evidence is fail-closed: an old-format run.pid (or one we cannot correlate)
  // must NOT be asserted running on the strength of a bare live pid. It is downgraded to pending.
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["true"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const livePid = spawnLiveVictim();
  try {
    fs.mkdirSync(path.join(dir, "slot_0"));
    // only two lines (pid + started_at_node); NO /proc starttime evidence
    fs.writeFileSync(path.join(dir, "slot_0", "run.pid"), `${livePid}\n2026-06-20T00:00:00Z\n`);
    const bin = withStubNvidiaSmi(dir, { busyGpu: null });
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.notEqual(state.jobs["0"].status, "running",
      "absent start-evidence must fail closed: a bare live pid is not proof the job still runs");
  } finally {
    try { process.kill(livePid, "SIGKILL"); } catch (_e) { /* already gone */ }
  }
});

test("a real progressor-launched job records /proc starttime and stays running across passes", { skip: !HAVE_PROC_STAT }, () => {
  // End-to-end: the progressor launches a long sleep, the wrapper writes run.pid WITH the /proc
  // starttime third line, and a subsequent reconcile pass proves liveness via the start-evidence and
  // keeps the job running (not re-fired). This pins that the WRITER and READER are wired together.
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["sleep", "30"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); // claims + launches sleep 30
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "run.pid")) && Date.now() < deadline) {}
  const lines = fs.readFileSync(path.join(dir, "slot_0", "run.pid"), "utf8").split("\n");
  const innerPid = Number(lines[0].trim());
  try {
    assert.ok(lines[2] && lines[2].trim().length > 0,
      "the wrapper must record a /proc starttime third line so the reader can verify the pairing");
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); // pass 2: prove-liveness + snapshot
    const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state.jobs["0"].status, "running", "a genuinely live, start-evidence-matched job stays running");
  } finally {
    try { process.kill(innerPid, "SIGKILL"); } catch (_e) { /* already gone */ }
  }
});

test("crash-recovery: an ORPHAN launching.marker (no run.pid, no result.json) is RECLAIMED and launched (no live-lock)", () => {
  // Simulates a crash in the launch window: marker was committed but the wrapper spawn never
  // became durable. Without reclaim, claim_and_launch's O_EXCL hits FileExistsError, returns
  // silently, the seq stays pending forever, and the resident loop can never idle-exit (live-lock).
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "open('/tmp/ORPHAN_RECLAIMED','w')"], { gpu_index: 0 })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  fs.rmSync("/tmp/ORPHAN_RECLAIMED", { force: true });
  // strand an orphan marker: slot dir + launching.marker, but NO run.pid and NO result.json
  fs.mkdirSync(path.join(dir, "slot_0"));
  fs.writeFileSync(path.join(dir, "slot_0", "launching.marker"), "987654"); // a dead progressor pid
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  // Generous deadline (15s) so a loaded machine still reaches the terminal marker. The wrapper writes
  // result.json asynchronously (detached session leader), independently of when a --once pass snapshots
  // STATE — so reaching result.json does NOT yet guarantee STATE reflects `done`.
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  assert.equal(fs.existsSync("/tmp/ORPHAN_RECLAIMED"), true, "the orphan-stranded seq MUST be reclaimed and launched");
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.exit_code, 0);
  // Run ONE more reconcile pass now that the terminal marker exists, so STATE harvests it to `done`
  // deterministically rather than racing the snapshot taken by the pass that merely launched the wrapper.
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  // and the loop can now make progress / idle-exit (state shows the seq done, not stuck pending)
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.jobs["0"].status, "done");
  fs.rmSync("/tmp/ORPHAN_RECLAIMED", { force: true });
});

test("crash-recovery: a marker over a LIVE run.pid is NOT reclaimed (no double-fire)", () => {
  // A dead-progressor relaunch could run two progressors concurrently. The reclaim recheck is
  // load-bearing: a marker sitting over a genuinely live run.pid must NEVER be re-fired. The reclaim
  // back-off is intentionally CONSERVATIVE — it backs off on a bare live pid (someone IS there), even
  // when start-evidence is absent — so a concurrent peer progressor's claim is never stomped. (Status
  // reporting in classify_seq is the strict path; reclaim safety is the lenient path.)
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "open('/tmp/DOUBLE_FIRE_PROOF','a')"], { gpu_index: 0 })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  fs.rmSync("/tmp/DOUBLE_FIRE_PROOF", { force: true });
  fs.mkdirSync(path.join(dir, "slot_0"));
  fs.writeFileSync(path.join(dir, "slot_0", "launching.marker"), "987654");
  // a real, genuinely-live process holds the pid -> a live claim; reclaim must back off.
  const livePid = spawnLiveVictim();
  fs.writeFileSync(path.join(dir, "slot_0", "run.pid"), `${livePid}\n2026-06-20T00:00:00Z\n`);
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  try {
    for (let i = 0; i < 3; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(fs.existsSync("/tmp/DOUBLE_FIRE_PROOF"), false, "a live-pid slot must NOT be re-fired under its orphan-looking marker");
  } finally {
    try { process.kill(livePid, "SIGKILL"); } catch (_e) { /* already gone */ }
  }
});

test("crash-recovery: a marker over a TERMINAL result.json is NOT reclaimed (no double-fire)", () => {
  // A terminal marker is authoritative (spec 2.6). An orphan-looking launching.marker sitting
  // beside a result.json must never re-fire the finished seq.
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "open('/tmp/TERMINAL_RERUN_PROOF','a')"], { gpu_index: 0 })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  fs.rmSync("/tmp/TERMINAL_RERUN_PROOF", { force: true });
  fs.mkdirSync(path.join(dir, "slot_0"));
  fs.writeFileSync(path.join(dir, "slot_0", "launching.marker"), "987654");
  fs.writeFileSync(path.join(dir, "slot_0", "result.json"),
    JSON.stringify({ seq: 0, run_id: "run_0", exit_code: 0, signal: null,
      started_at_node: "x", finished_at_node: "y", duration_seconds: 1, attempt: 0 }));
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  for (let i = 0; i < 3; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(fs.existsSync("/tmp/TERMINAL_RERUN_PROOF"), false, "a finished seq must NOT re-fire under a stale marker");
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.jobs["0"].status, "done");
});

test("attempt counter is wired: a reclaimed (re-fired) seq increments result.json.attempt", () => {
  // First launch crashes (orphan marker). The reclaim re-fires the seq and the resulting terminal
  // marker must record attempt >= 1 (the relaunch count), not a frozen 0.
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "import sys; sys.exit(0)"], { gpu_index: 0 })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  // Model a crashed FIRST launch deterministically: an orphan launching.marker (the crash left it
  // stranded) AND an attempt.count of 1 (the crashed launch already consumed attempt index 0 via
  // next_attempt()). The reclaim is therefore genuinely the SECOND attempt, so next_attempt() returns
  // 1 and the wrapper records attempt>=1 on the FIRST reclaim pass — no dependence on a double-reclaim
  // race (under full-suite load the wrapper can rename the marker / write run.pid before a second pass,
  // which previously left a frozen attempt:0 ~20% of the time). Without seeding attempt.count the first
  // reclaim would record attempt:0 and only an extra, timing-dependent re-fire would bump it.
  fs.mkdirSync(path.join(dir, "slot_0"));
  fs.writeFileSync(path.join(dir, "slot_0", "launching.marker"), "987654");
  fs.writeFileSync(path.join(dir, "slot_0", "attempt.count"), "1\n"); // crashed first launch consumed attempt 0
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  // Generous deadline (15s) + robust marker poll so a loaded machine still reaches the terminal marker;
  // the assertion no longer hinges on wall-clock timing — attempt>=1 is guaranteed by the seeded count.
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  assert.ok(fs.existsSync(path.join(dir, "slot_0", "result.json")), "the reclaimed seq must reach a terminal marker within the deadline");
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.ok(result.attempt >= 1, `a re-fired seq must record attempt>=1, got ${result.attempt}`);
});

test("cancel NOW: SIGTERM to a running wrapper writes status=cancelled (terminal marker exists)", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["sleep", "30"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); // launch sleep 30
  // wait for the wrapper to claim its slot (run.pid + wrapper.pid present)
  let deadline = Date.now() + 5000;
  while ((!fs.existsSync(path.join(dir, "slot_0", "run.pid")) ||
          !fs.existsSync(path.join(dir, "slot_0", "wrapper.pid"))) && Date.now() < deadline) {}
  // The SIGTERM trap is now installed BEFORE subprocess.Popen (proc=None tolerant), so once the wrapper
  // exists at all the trap is armed — no 300ms busy-wait needed; a cancel-NOW deterministically writes
  // a `cancelled` terminal marker rather than racing the default-terminate disposition (no marker).
  // the wrapper python is a setsid session leader (wrapper.pid == its pgid); SIGTERM its group -> trap
  // writes status=cancelled before the inner sleep is reaped (spec 7 cancel-now semantics).
  const wrapperPid = Number(fs.readFileSync(path.join(dir, "slot_0", "wrapper.pid"), "utf8").trim());
  try { process.kill(-wrapperPid, "SIGTERM"); } catch (_e) { /* group already gone */ }
  deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {}
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "cancelled", "killed job must ALWAYS have a terminal marker (spec 7)");
  // cleanup any lingering inner job
  try {
    const innerPid = Number(fs.readFileSync(path.join(dir, "slot_0", "run.pid"), "utf8").split("\n")[0]);
    process.kill(innerPid, "SIGKILL");
  } catch (_e) { /* already gone */ }
});

test("cancel DRAIN: a drain.flag stops new launches but lets running jobs finish", () => {
  const dir = makeCampaign({
    plan: basePlan({ limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 0 },
      jobs: [jobSpec(0, ["python3", "-c", "pass"]), jobSpec(1, ["python3", "-c", "pass"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  fs.writeFileSync(path.join(dir, "drain.flag"), "");
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  for (let i = 0; i < 4; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  // with drain set BEFORE any launch, NO seq should have been launched
  assert.equal(fs.existsSync(path.join(dir, "slot_0", "launching.marker")), false);
  assert.equal(fs.existsSync(path.join(dir, "slot_0", "run.pid")), false);
});

test("acceptance: offline-finish-and-refill (slot_count=1, two jobs progress without the brain)", () => {
  const dir = makeCampaign({
    plan: basePlan({ limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 0 },
      jobs: [jobSpec(0, ["python3", "-c", "pass"]), jobSpec(1, ["python3", "-c", "pass"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  // many --once passes simulate the resident loop with the brain absent
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
    const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
    if (s.counts.done === 2) break;
  }
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.counts.done, 2, "both jobs must complete offline via slot refill (spec 7)");
});

// ---------------------------------------------------------------------------------------------------
// P2 (confinement parity with the single-run supervisor). iHPC profiles commonly template paths with
// `${USER}` (workdir `/data/${USER}/...`, allowed_roots `/data/${USER}`). The single-run SUPERVISOR_PY
// (ihpc-start.ts expand_path) runs `os.path.expandvars` on BOTH the workdir and every allowed_root
// BEFORE the realpath/membership confinement check, so the run lands on the REAL remote path and the
// confinement compares apples-to-apples. The campaign wrapper MUST do the same — otherwise a `${USER}`
// workdir is taken literally (`cd /data/${USER}/...` fails -> exit 126) AND the confinement is asymmetric
// (it would compare against unexpanded roots). These two tests mirror ihpc-start.test.mjs's `${USER}`
// coverage: (1) expansion lands on the real path with confinement INTACT; (2) an out-of-root `${USER}`
// path is STILL refused (the expansion must not open a bypass).
// ---------------------------------------------------------------------------------------------------
test("campaign wrapper expands ${USER} in workdir AND allowed_roots before the confinement check (lands on the real path)", () => {
  // A real per-test home the expanded `${USER}` path resolves to; the job writes a sentinel INSIDE the
  // expanded workdir to prove it actually cd'd into the real directory (not the literal `${USER}` dir).
  const fakeUser = `prog_user_${process.pid}`;
  const homeBase = fs.mkdtempSync(path.join(os.tmpdir(), "uexp-"));
  const realRoot = path.join(homeBase, fakeUser);          // expands from `${homeBase}/$UTS_FAKE_USER`
  const realWorkdir = path.join(realRoot, "experiments", "run_0");
  fs.mkdirSync(realWorkdir, { recursive: true });
  // The wrapper inherits the progressor's env (claim_and_launch copies os.environ), so a `${UTS_FAKE_USER}`
  // token in the PLAN expands via os.path.expandvars to the injected value — exactly like the supervisor
  // resolving `${USER}` from the node's real remote environment at launch.
  const tmplRoot = `${homeBase}/\${UTS_FAKE_USER}`;
  const tmplWorkdir = `${tmplRoot}/experiments/run_0`;
  const dir = makeCampaign({
    plan: basePlan({
      security: { allowed_roots: [tmplRoot], env_key_allowlist: ["UTS_RUN_ID"] },
      jobs: [jobSpec(0, ["python3", "-c", "open('confined_sentinel','w').close()"], { workdir: tmplWorkdir })]
    }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  const env = { PATH: `${bin}:${process.env.PATH}`, UTS_FAKE_USER: fakeUser };
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "done", `the expanded-workdir job must run (got ${JSON.stringify(result)})`);
  assert.equal(result.exit_code, 0);
  // The sentinel exists in the EXPANDED workdir, not under a literal "${UTS_FAKE_USER}" directory.
  assert.equal(fs.existsSync(path.join(realWorkdir, "confined_sentinel")), true,
    "the job must cd into the REAL expanded workdir, not the literal ${USER} path");
  assert.equal(fs.existsSync(path.join(homeBase, "${UTS_FAKE_USER}")), false,
    "no literal ${USER} directory may be created — the token must be expanded");
  fs.rmSync(homeBase, { recursive: true, force: true });
});

test("campaign wrapper still REFUSES an out-of-root ${USER} workdir after expansion (no confinement bypass)", () => {
  // NEGATIVE / no-bypass: roots expand to `${homeBase}/<user>` but the workdir expands to a SIBLING
  // `${homeBase}/<user>_escape/...` OUTSIDE that root. Expansion must happen on BOTH sides BEFORE the
  // membership check, so the expanded workdir is still proven outside the expanded root and REFUSED with
  // exit 126 — the expansion resolves the template, it does NOT weaken the realpath confinement.
  const fakeUser = `prog_user_${process.pid}`;
  const homeBase = fs.mkdtempSync(path.join(os.tmpdir(), "uexpneg-"));
  const escapeWorkdir = path.join(homeBase, `${fakeUser}_escape`, "experiments", "run_0");
  fs.mkdirSync(escapeWorkdir, { recursive: true });        // the dir exists; confinement (not ENOENT) must reject it
  const tmplRoot = `${homeBase}/\${UTS_FAKE_USER}`;
  const tmplWorkdir = `${homeBase}/\${UTS_FAKE_USER}_escape/experiments/run_0`;
  const dir = makeCampaign({
    plan: basePlan({
      security: { allowed_roots: [tmplRoot], env_key_allowlist: ["UTS_RUN_ID"] },
      jobs: [jobSpec(0, ["python3", "-c", "open('SHOULD_NOT_RUN_ESCAPE','w').close()"], { workdir: tmplWorkdir })]
    }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  const env = { PATH: `${bin}:${process.env.PATH}`, UTS_FAKE_USER: fakeUser };
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "failed", "an out-of-root expanded workdir must be refused");
  assert.equal(result.exit_code, 126, "confinement rejection is exit 126 (matches the supervisor)");
  assert.match(JSON.stringify(result), /allowed_roots|outside/i);
  assert.equal(fs.existsSync(path.join(escapeWorkdir, "SHOULD_NOT_RUN_ESCAPE")), false,
    "the job must NOT exec when its expanded workdir is outside the expanded roots (no bypass)");
  fs.rmSync(homeBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------
// Workdir-creation parity with the single-run iHPC SUPERVISOR_PY (ihpc-start.ts ~:463-484). The
// supervisor confines the path THEN os.makedirs(workdir)+os.makedirs(log_dir) BEFORE opening its log
// files / Popen(cwd=workdir). The campaign wrapper previously did NOT create the workdir, so a job whose
// (confined, in-root) workdir did not yet exist instant-failed at Popen with FileNotFoundError — the
// same class of bug as the PBS workdir fix (commit 90956f1). These tests pin that the wrapper creates a
// MISSING in-root workdir before launching, idempotently and ONLY inside the allowed roots.
// ---------------------------------------------------------------------------------------------------
test("progressor creates a MISSING in-root workdir before launching (parity with the iHPC supervisor)", () => {
  // Point the job at a workdir UNDER an allowed root (/tmp) that does NOT exist yet. Old code never
  // os.makedirs'd it, so Popen(cwd=workdir) raised FileNotFoundError and the job could not complete.
  const missingWorkdir = path.join(os.tmpdir(), `prog-missing-wd-${process.pid}-${Date.now()}`, "experiments", "run_0");
  fs.rmSync(path.dirname(path.dirname(missingWorkdir)), { recursive: true, force: true });
  assert.equal(fs.existsSync(missingWorkdir), false, "precondition: the workdir must not exist yet");
  const dir = makeCampaign({
    // The job writes a sentinel via a RELATIVE path, proving it actually cd'd into the created workdir.
    plan: basePlan({
      security: { allowed_roots: [os.tmpdir()], env_key_allowlist: ["UTS_RUN_ID"] },
      jobs: [jobSpec(0, ["python3", "-c", "open('made_in_workdir','w').close()"], { workdir: missingWorkdir })]
    }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {
    runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  }
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "done", `a missing in-root workdir must be created before launch (got ${JSON.stringify(result)})`);
  assert.equal(result.exit_code, 0);
  assert.equal(fs.existsSync(missingWorkdir), true, "the wrapper must os.makedirs the confined workdir before Popen");
  assert.equal(fs.existsSync(path.join(missingWorkdir, "made_in_workdir")), true,
    "the job must cd into the freshly-created workdir (proves makedirs ran before Popen)");
  fs.rmSync(path.dirname(path.dirname(missingWorkdir)), { recursive: true, force: true });
});
