#!/usr/bin/env python3
"""iHPC node progressor — the ONLY thing deployed to the node (spec 2.1).

Reads an immutable PLAN, fills slots, autonomously progresses the queue while the
brain (plugin) is offline, and writes STATE the brain reads on reconnect. stdlib only
(spec 2.8): no PyYAML, no paramiko. Recovery is reconcile-never-reattach (spec 2.6):
on-disk idempotent terminal markers (result.json) are authoritative; completed jobs
never rerun.

Run modes:
  python3 progressor.py            # resident reconcile loop (spec 2.4 Option A)
  python3 progressor.py --once     # one reconcile pass (used by the test harness)

The campaign state dir (containing plan.json / lease.json / state.json / slot_<seq>/)
is os.getcwd() by default, or UTS_PROGRESSOR_STATE_DIR if set.
"""

import json
import os
import signal
import subprocess
import sys
import time

SCHEMA_VERSION = "1.0.0"
COUNT_KEYS = ("pending", "running", "done", "failed", "cancelled", "conflict")


def state_dir():
    return os.environ.get("UTS_PROGRESSOR_STATE_DIR") or os.getcwd()


def die(message):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --- durable atomic write: temp -> fsync(file) -> rename -> fsync(dir) (spec 2.3) ---
def write_atomic_durable(path, obj):
    directory = os.path.dirname(path) or "."
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    try:
        os.write(fd, (json.dumps(obj, sort_keys=True) + "\n").encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, path)
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)  # MANDATORY: else POSIX may lose the rename on reboot (spec 2.3)
    finally:
        os.close(dir_fd)


def read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def load_plan(root):
    plan_path = os.path.join(root, "plan.json")
    if not os.path.isfile(plan_path):
        die("no plan.json in state dir")
    plan = read_json(plan_path)
    if plan.get("schema_version", "").split(".")[0] != SCHEMA_VERSION.split(".")[0]:
        die(f"unsupported PLAN schema_version {plan.get('schema_version')!r}")
    return plan


# --- node-side lease enforcement (spec 3.2): refuse PLAN whose lease_owner is not
#     the current lease.json holder (the losing brain's plan is rejected, not silently
#     overwritten). Match on client + device_id + queue_id. ---
def enforce_lease(root, plan):
    lease_path = os.path.join(root, "lease.json")
    if not os.path.isfile(lease_path):
        die("no lease.json on node; brain must acquire the lease before shipping a PLAN")
    holder = read_json(lease_path)
    owner = plan.get("lease_owner") or {}
    if (holder.get("client") != owner.get("client")
            or holder.get("device_id") != owner.get("device_id")):
        die(f"PLAN lease_owner {owner.get('client')}/{owner.get('device_id')} "
            f"is not the node lease holder {holder.get('client')}/{holder.get('device_id')}")
    if holder.get("queue_id") and holder.get("queue_id") != plan.get("queue_id"):
        die("PLAN queue_id does not match the node lease holder's queue_id")


def empty_counts():
    return {key: 0 for key in COUNT_KEYS}


def build_state(plan, jobs, counts):
    return {
        "schema_version": SCHEMA_VERSION,
        "campaign_id": plan["campaign_id"],
        "queue_id": plan["queue_id"],
        "lease_owner": {
            "client": plan["lease_owner"]["client"],
            "device_id": plan["lease_owner"]["device_id"],
        },
        "observed_at_node": now_iso(),
        "node_clock_epoch": int(time.time()),
        "slot_count": plan["limits"]["slot_count"],
        "progressor": {
            "pid": os.getpid(),
            "started_at_node": os.environ.get("UTS_PROGRESSOR_STARTED_AT", now_iso()),
            "heartbeat_node": now_iso(),
        },
        "health": {"degraded": None, "breaker_tripped": False},
        "jobs": jobs,
        "counts": counts,
    }


def consecutive_failure_breaker(root, plan):
    """failure_breaker (spec 2.6 / line 198): "N 次连续失败且零成功 ⇒ trip". The breaker exists ONLY to
    catch the broken-harness runaway: a campaign that has NEVER produced a success yet racks up
    `max_consecutive_failures` in a row is presumed mis-configured and PAUSES (so it can't burn
    idle_exit_seconds while looking "active"). It is intentionally NOT a recency circuit breaker.

    `require_one_success: true` is the spec's "且零成功" clause: ANY prior `done` (a proven-good harness)
    DISARMS the breaker — the campaign is trusted to keep churning even through a later failure run, and
    the brain handles those on reconnect. So:
      - all-fail, no success, streak>=N            -> TRIP        (broken harness)
      - [done, fail, fail, fail], require_one_success -> NO TRIP   (harness proven once; trust it)
      - require_one_success: false                 -> TRIP on streak>=N regardless of prior success
    The C-4 review confirmed this is the spec-faithful reading; the [done, fail, fail, fail] test below
    pins it so a future refactor can't silently flip it into a recency breaker.
    """
    fb = plan["policy"].get("failure_breaker") or {}
    limit = fb.get("max_consecutive_failures")
    if not limit:
        return False
    streak, any_success = 0, False
    for job in sorted(plan["jobs"], key=lambda j: j["seq"]):
        verdict, _ = classify_seq(root, job)
        if verdict == "done":
            any_success = True
            streak = 0
        elif verdict == "failed":
            streak += 1
    if fb.get("require_one_success") and any_success:
        return False  # "且零成功" disarmed: a proven harness is never breaker-paused (spec 2.6)
    return streak >= limit


def has_running_or_launchable(root, plan):
    for job in plan["jobs"]:
        verdict, _ = classify_seq(root, job)
        if verdict in ("running", "launching", "pending"):
            return True
    return False


def genuinely_idle(root, plan):
    # idle = no running and no launchable-pending (spec 2.2 idle_definition)
    return not has_running_or_launchable(root, plan)


def reconcile_once(root):
    plan = load_plan(root)
    enforce_lease(root, plan)
    jobs, counts = reconcile_slots(root, plan)
    tripped = consecutive_failure_breaker(root, plan)
    state = build_state(plan, jobs, counts)
    state["health"]["breaker_tripped"] = tripped
    write_atomic_durable(os.path.join(root, "state.json"), state)
    return plan, state, tripped


# --- per-seq slot directory + on-disk evidence (spec 2.6 recovery table) ---
def slot_dir(root, seq):
    return os.path.join(root, f"slot_{seq}")


def pid_alive(pid):
    # BARE liveness: does SOME process currently hold this pid? pid<1 is not a real process; pid==1
    # (init) is always alive and os.kill(1, 0) confirms it (PermissionError, treated as alive). This is
    # the LENIENT probe used ONLY by the reclaim back-off in claim_and_launch (a live pid means a peer
    # progressor may genuinely own the slot, so never stomp it). It is DELIBERATELY NOT proof that the
    # process is OUR job — a reused pid after a node reboot is also "alive". Status reporting must use
    # pid_is_ours() instead, which verifies the anti-pid-reuse start-evidence (spec 2.5).
    if not pid or pid < 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def proc_starttime(pid):
    """Linux /proc/<pid>/stat field 22 (starttime, in clock ticks since boot) — the robust anti-pid-reuse
    correlate. An OS pid can be recycled after a reboot, but the SAME pid pointing at a process that
    booted at a DIFFERENT starttime is provably a DIFFERENT process. We read it at LAUNCH time (stored as
    run.pid's third line) and re-read it on reconcile; a match proves continuity. Returns the starttime
    token as a STRING (compared verbatim, never arithmetic), or None if /proc is unavailable / the pid is
    gone / the line is unparseable — every None forces FAIL-CLOSED at the call site (not our process).
    The comm field (field 2) is parenthesized and may itself contain spaces and ')' (e.g. "(a b)c)"), so
    we split AFTER the LAST ')' and index into the clean remainder: there, state is token 0 and starttime
    (overall field 22) is token 19."""
    try:
        with open("/proc/%d/stat" % pid, "r", encoding="utf-8") as handle:
            raw = handle.read()
    except OSError:
        return None  # no /proc (non-Linux) or pid gone -> cannot correlate -> fail closed
    rparen = raw.rfind(")")
    if rparen < 0:
        return None
    rest = raw[rparen + 2:].split()
    if len(rest) < 20:
        return None
    return rest[19]


def pid_is_ours(run):
    """STRICT liveness used for STATUS reporting (classify_seq): is the live pid the SAME process our job
    launched, per the anti-pid-reuse start-evidence? Requires (a) the pid is alive AND (b) the recorded
    /proc starttime (run.pid third line) MATCHES the live process's current /proc starttime. ABSENT or
    MISMATCHED evidence => FAIL CLOSED (return False): an unverifiable pid must never be reported running,
    because a node reboot can recycle the pid onto a foreign process (silent ledger != reality, spec 2.5).
    If /proc is unavailable we also fail closed (proc_starttime returns None) — we never assert liveness
    we cannot prove."""
    if not run:
        return False
    pid = run.get("pid")
    if not pid_alive(pid):
        return False
    recorded = run.get("proc_starttime")
    if not recorded:
        return False  # no launch-time start-evidence recorded -> cannot prove continuity -> not ours
    live = proc_starttime(pid)
    if live is None:
        return False  # /proc unavailable or pid vanished mid-check -> fail closed
    return str(live) == str(recorded)


def read_run_pid(sdir):
    pid_path = os.path.join(sdir, "run.pid")
    if not os.path.isfile(pid_path):
        return None
    try:
        with open(pid_path, "r", encoding="utf-8") as handle:
            first = handle.readline().strip()
            second = handle.readline().strip()
            third = handle.readline().strip()
        return {"pid": int(first), "started_at_node": second or None, "proc_starttime": third or None}
    except (ValueError, OSError):
        return None


# Recovery is a pure function of on-disk markers (spec 2.6). Returns a status verdict
# for one seq WITHOUT launching.
def classify_seq(root, job):
    sdir = slot_dir(root, job["seq"])
    result_path = os.path.join(sdir, "result.json")
    if os.path.isfile(result_path):
        res = read_json(result_path)
        st = res.get("status")
        if st == "placement_conflict":
            return ("placement_conflict", res)
        if res.get("exit_code") == 0 and res.get("signal") is None:
            return ("done", res)
        if st == "cancelled":
            return ("cancelled", res)
        return ("failed", res)
    run = read_run_pid(sdir)
    # ANTI-PID-REUSE (spec 2.5): only report `running` when the live pid is PROVABLY the process our job
    # launched (pid alive AND recorded /proc starttime matches the live one). A bare live pid is NOT
    # enough — a node reboot can recycle the pid onto a foreign process, which a naive kill -0 would
    # silently classify `running` forever (dead job, live-looking ledger). pid_is_ours() fails closed on
    # absent/mismatched evidence or when /proc is unavailable.
    if run and pid_is_ours(run):
        return ("running", run)
    marker = os.path.join(sdir, "launching.marker")
    if os.path.isfile(marker):
        # launching crash: a marker with no live pid and no terminal marker is an orphan from a crashed
        # launch window. It is re-eligible `pending`; claim_and_launch reclaims it on the next pass and
        # next_attempt() bumps result.attempt (the relaunch is a new attempt, not a frozen attempt 0).
        return ("pending", {"attempt_bump": True})
    if run and pid_alive(run["pid"]):
        # run.pid present, pid ALIVE, but the start-evidence is absent or MISMATCHED: this is a recycled
        # pid (or an un-correlatable old-format run.pid), NOT our job. Treat the seq as re-eligible
        # `pending` (the brain reconciles / the slot relaunches) rather than asserting a false `running`.
        return ("pending", {"pid_reuse": True})
    if run:  # run.pid present but dead, no terminal marker -> crashed
        return ("failed", {"crashed": True})
    return ("pending", None)


# --- per-job wrapper: env-allowlist + token expand + root recheck + launch-time GPU
#     guard + SIGTERM trap writing status=cancelled + log_max_bytes (spec 2.5). Shipped
#     as a bash -c string but the ARGV is exported as a JSON array env var and rebuilt by
#     a tiny python child so NO interpolation of command_argv into shell ever happens. ---
WRAPPER_SH = r'''
set -u
# C-3: argv flows STRICTLY through UTS_JOB_ARGV (a JSON array env var), NEVER through the shell. The
# heredoc gets no positional args ("$@" is intentionally absent) so command_argv is never interpolated
# into a shell word — this is the no-interpolation contract (spec 2.5).
python3 - <<'PYEOF'
import calendar, json, os, signal, subprocess, sys, time
slot = os.environ["UTS_SLOT_DIR"]
argv = json.loads(os.environ["UTS_JOB_ARGV"])
env_overrides = json.loads(os.environ["UTS_JOB_ENV"])
allow = set(json.loads(os.environ["UTS_ENV_ALLOWLIST"]))
roots = json.loads(os.environ["UTS_ALLOWED_ROOTS"])
workdir = os.environ["UTS_JOB_WORKDIR"]
gpu_index = os.environ["UTS_GPU_INDEX"]
run_id = os.environ["UTS_RUN_ID"]
seq = int(os.environ["UTS_SEQ"])
log_max = int(os.environ["UTS_LOG_MAX_BYTES"])

def node_epoch(stamp):
    # Parse a "%Y-%m-%dT%H:%M:%SZ" NODE-clock label back to a UTC epoch. started_at and finished_at are
    # both produced from the SAME time.gmtime() on this node, so timegm() (UTC, no local-tz drift) gives a
    # clock-consistent difference. Returns None for an absent/unparseable stamp -> caller omits duration.
    if not stamp:
        return None
    try:
        return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, TypeError):
        return None

def write_result(status, exit_code=None, signal_name=None, reason=None):
    started = os.environ.get("UTS_STARTED_AT", "")
    fin = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    obj = {"seq": seq, "run_id": run_id, "status": status, "exit_code": exit_code,
           "signal": signal_name, "started_at_node": started, "finished_at_node": fin,
           "attempt": int(os.environ.get("UTS_ATTEMPT", "0"))}
    # duration_seconds is the real node-clock elapsed time (finished - started), NEVER a hardcoded 0. A
    # seq that never started — workdir/env reject, placement_conflict, or a cancel before UTS_STARTED_AT
    # is set — has no started_at, so we OMIT the field rather than emit a false 0-second runtime.
    started_epoch = node_epoch(started)
    finished_epoch = node_epoch(fin)
    if started_epoch is not None and finished_epoch is not None:
        obj["duration_seconds"] = max(0, finished_epoch - started_epoch)
    if reason is not None:
        obj["reason"] = reason
    tmp = os.path.join(slot, "result.json.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    os.write(fd, (json.dumps(obj, sort_keys=True) + "\n").encode()); os.fsync(fd); os.close(fd)
    os.rename(tmp, os.path.join(slot, "result.json"))
    dfd = os.open(slot, os.O_RDONLY); os.fsync(dfd); os.close(dfd)

# 0. no-lingering-marker discipline (spec 2.4): the body below has several `sys.exit(0)` exits
#    (workdir-reject / env-reject / placement_conflict / cancel) plus the happy path. EVERY one of
#    them must clear `launching.marker` — a lingering orphan marker after the wrapper has definitively
#    run would re-wedge claim_and_launch's O_EXCL on the next pass. We rename it to `launched.marker`
#    in a `finally` so the marker is cleared on ALL exit paths, including the SIGTERM-cancel path.
marker = os.path.join(slot, "launching.marker")
def clear_marker():
    try:
        os.rename(marker, os.path.join(slot, "launched.marker"))
    except FileNotFoundError:
        pass

# 1. SIGTERM trap installed BEFORE any subprocess.Popen and BEFORE run.pid is observable, so a cancel
#    that races the GPU-guard / env-build phase (proc still None) still writes a `cancelled` terminal
#    marker instead of hitting the default-terminate disposition (which would leave NO marker and make
#    reconcile misread a crash). `on_term` tolerates `proc is None` (spec 2.5 / 7 cancel semantics).
proc = None
def on_term(signum, frame):
    if proc is not None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
    clear_marker()
    write_result("cancelled", signal_name="SIGTERM"); sys.exit(0)
signal.signal(signal.SIGTERM, on_term)

try:
    # 2. workdir realpath inside allowed_roots (defense in depth, spec 2.5 / ihpc-start.ts:467).
    #    EXPAND ${USER}/env vars on BOTH the workdir AND every root FIRST (os.path.expandvars), byte-for-
    #    byte the same policy as the single-run SUPERVISOR_PY.expand_path (ihpc-start.ts:450-463): iHPC
    #    profiles template paths with `${USER}` (workdir `/data/${USER}/...`, roots `/data/${USER}`), so a
    #    literal `${USER}` would (a) make `cd` fail (FileNotFoundError -> exit 126) and (b) confine against
    #    UNEXPANDED roots — an asymmetric, broken check. Expand-then-realpath-then-membership keeps the
    #    confinement apples-to-apples and identical to the supervisor; the realpath/startswith guard itself
    #    is unchanged (the expansion resolves the template, it does NOT weaken confinement). The EXPANDED
    #    workdir is what we actually cd into below (step 5 Popen), never the literal `${USER}` string.
    workdir = os.path.expandvars(workdir)
    roots = [os.path.expandvars(r) for r in roots]
    real_wd = os.path.realpath(workdir)
    if not any(real_wd == os.path.realpath(r) or real_wd.startswith(os.path.realpath(r) + os.sep) for r in roots):
        write_result("failed", exit_code=126, reason=f"workdir {workdir} outside allowed_roots"); sys.exit(0)

    # 3. env: allowlist-only + literal token expand ($GPU_INDEX$/$RUN_ID$); unknown $TOKEN$ hard-fails
    TOKENS = {"$GPU_INDEX$": gpu_index, "$RUN_ID$": run_id}
    job_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    for key, val in env_overrides.items():
        if key not in allow:
            # key not in env_key_allowlist (spec 2.2)
            write_result("failed", exit_code=126, reason=f"env key {key} not in allowlist"); sys.exit(0)
        if isinstance(val, str) and val.startswith("$") and val.endswith("$"):
            if val not in TOKENS:
                # unknown $TOKEN$ -> hard fail (spec 2.2)
                write_result("failed", exit_code=126, reason=f"unknown token sentinel {val} in env"); sys.exit(0)
            val = TOKENS[val]
        job_env[key] = str(val)

    # 4. launch-time GPU guard: the ONLY nvidia-smi on the node (spec 2.5). A foreign compute-app on
    #    the TARGET gpu -> placement_conflict, do NOT exec; brain re-places on reconnect. This is
    #    TARGET-specific (correlate to UTS_GPU_INDEX, NOT "any pid on any gpu") and FAIL-CLOSED (if
    #    nvidia-smi is missing / times out / is unparseable we cannot prove the gpu free, so we treat
    #    it as a conflict rather than assuming free — never exec onto a gpu we couldn't verify).
    def target_gpu_busy():
        # (a) map the target physical index -> its uuid (stable correlation key; index alone is unsafe
        #     because compute-apps reports uuid; a foreign app on a DIFFERENT index must not block us).
        idx_map = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,uuid", "--format=csv,noheader"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=10)
        if idx_map.returncode != 0:
            raise RuntimeError("nvidia-smi --query-gpu failed")
        target_uuid = None
        for line in idx_map.stdout.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 2 and parts[0] != "" and parts[1] != "":
                if str(parts[0]) == str(gpu_index):
                    target_uuid = parts[1]
        if not target_uuid:
            # the target index was not present in the index->uuid map -> cannot verify -> fail closed
            raise RuntimeError(f"target gpu index {gpu_index} not found in nvidia-smi index map")
        # (b) list compute-apps by uuid; busy iff a compute-app is pinned to the TARGET uuid.
        apps = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_gpu_memory,gpu_uuid", "--format=csv,noheader"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            universal_newlines=True, timeout=10)
        if apps.returncode != 0:
            raise RuntimeError("nvidia-smi --query-compute-apps failed")
        for line in apps.stdout.splitlines():
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            # rows look like: "<pid>, <mem> MiB, GPU-<uuid>"; the uuid is the LAST field
            if parts and parts[-1] == target_uuid:
                return True
        return False

    if os.environ.get("UTS_GPU_GUARD", "1") == "1":
        try:
            conflict = target_gpu_busy()
        except (FileNotFoundError, subprocess.TimeoutExpired, RuntimeError, OSError):
            conflict = True  # FAIL CLOSED: cannot prove the target gpu free -> do NOT exec (spec 2.5)
        if conflict:
            write_result("placement_conflict"); sys.exit(0)

    # 5. claim -> run.pid. THREE lines (spec 2.5 anti-pid-reuse):
    #      line 1: the inner job pid
    #      line 2: started_at_node (node-clock wall label; the brain pairs it against the RunRecord)
    #      line 3: the pid's /proc starttime at LAUNCH (clock ticks since boot) — the robust reuse guard.
    #    A bare live pid can be a RECYCLED pid after a node reboot; reconcile (pid_is_ours) re-reads
    #    /proc/<pid>/stat field 22 and requires it to MATCH this captured value before reporting `running`,
    #    so a dead job whose pid was reused is never silently classified live. The SIGTERM trap is ALREADY
    #    armed (step 1, before this Popen), so a cancel racing the claim still writes a `cancelled` marker.
    def launch_proc_starttime(pid):
        # mirror of progressor.proc_starttime: split after the LAST ')' so a parenthesized/space-bearing
        # comm field cannot shift the index; starttime is token 19 of the post-comm remainder (field 22).
        try:
            with open("/proc/%d/stat" % pid, "r", encoding="utf-8") as sh:
                raw = sh.read()
        except OSError:
            return ""  # no /proc (non-Linux) -> empty evidence -> reconcile fails closed (never 'running')
        rp = raw.rfind(")")
        if rp < 0:
            return ""
        rest = raw[rp + 2:].split()
        return rest[19] if len(rest) >= 20 else ""
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    os.environ["UTS_STARTED_AT"] = started
    # workdir + log-dir creation parity with the single-run SUPERVISOR_PY (ihpc-start.ts ~:470-476):
    # confine FIRST (step 2 above proved real_wd is inside the expanded allowed_roots), THEN os.makedirs
    # the confined workdir + the slot (where stdout.log lives) BEFORE opening the log / Popen(cwd=workdir).
    # Without this, a valid in-root workdir that does not yet exist makes Popen raise FileNotFoundError and
    # the job instant-fails with a zero-byte log — the same bug the PBS workdir fix (90956f1) closed. Both
    # makedirs are idempotent (exist_ok=True) and roots-safe: `workdir` is the realpath-confined path from
    # step 2 (never created outside allowed_roots), and `slot` is the campaign's own slot_<seq> state dir.
    os.makedirs(workdir, exist_ok=True)
    os.makedirs(slot, exist_ok=True)
    log = open(os.path.join(slot, "stdout.log"), "ab", buffering=0)
    proc = subprocess.Popen(argv, cwd=workdir, env=job_env, stdin=subprocess.DEVNULL,
                            stdout=log, stderr=subprocess.STDOUT, close_fds=True,
                            start_new_session=True)

    proc_start = launch_proc_starttime(proc.pid)
    with open(os.path.join(slot, "run.pid"), "w") as h:
        h.write(f"{proc.pid}\n{started}\n{proc_start}\n")

    rc = proc.wait()
    if log_max > 0:
        p = os.path.join(slot, "stdout.log")
        if os.path.getsize(p) > log_max:
            os.truncate(p, log_max)
    write_result("done" if rc == 0 else "failed", exit_code=rc)
except Exception as exc:  # noqa: BLE001 - a launch-SETUP failure (before a live process) is TERMINAL failed, never a wedged orphan
    # WEDGE FIX: if the launch SETUP raises BEFORE subprocess.Popen produces a live process
    # (makedirs/open(log) EACCES, Popen FileNotFoundError/PermissionError on a bad command, etc.) the seq
    # has NO run.pid and NO terminal marker, so classify_seq returns `pending` FOREVER and the campaign
    # seq WEDGES (reconcile can never act on the orphan). We write a TERMINAL status=failed marker here —
    # exit_code=None (no inner process ever ran -> never a false 0) plus a reason — mirroring the single-
    # run SUPERVISOR_PY's `fail("failed to start command: ...")`. reconcile then sees `failed` and the
    # campaign moves on / retries.
    #
    # We catch `Exception` (not BaseException) so the controlled sys.exit(0) paths above (workdir/env
    # reject, placement_conflict, and on_term's cancel) raise SystemExit and are never double-handled.
    #
    # Two guards keep this from CLOBBERING a real verdict, which matters because the resident loop can run
    # several --once passes that each (re)spawn a wrapper for the same seq before the first marker lands:
    #   (1) GATE on `proc is None` — once `proc` is a live Popen the job IS launched (run.pid exists, or a
    #       dead pid already maps to `failed` via classify_seq's crash arm); a later exception in
    #       wait()/truncate() must NOT fire a second write_result. Re-raise so reconcile classifies it.
    #   (2) only write the failed marker if result.json does NOT already exist — never overwrite a terminal
    #       verdict (done/placement_conflict/cancelled) a concurrent peer wrapper for this seq already
    #       wrote. The write itself is best-effort: a vanished slot dir (e.g. teardown) means nothing left
    #       to wedge, so a failure to write is swallowed rather than re-raised.
    if proc is None:
        if not os.path.isfile(os.path.join(slot, "result.json")):
            try:
                write_result("failed", exit_code=None, reason="launch failed: " + str(exc))
            except Exception:  # noqa: BLE001 - best-effort: a vanished slot dir means nothing left to wedge
                pass
    else:
        raise  # a live process already exists; let reconcile's crash arm classify it, don't re-mark
finally:
    # spec 2.4: on EVERY exit path (reject / conflict / done / failed) the launch is over, so the
    # marker must not linger. The cancel path clears it inside on_term before sys.exit; here we cover
    # all other paths. (rename is idempotent-safe: FileNotFoundError if already cleared.)
    clear_marker()
PYEOF
'''


# --- per-seq durable attempt counter (spec 2.5 result.attempt) -------------------------------
# The progressor is a fresh process each --once pass with NO in-memory cross-pass state, so the
# relaunch count must live on disk. `attempt.count` holds the number of launches MADE SO FAR for the
# seq: the value read at claim time is the attempt index passed into the wrapper, then bumped so the
# NEXT relaunch (e.g. a reclaimed orphan, classify_seq's "attempt_bump") records attempt+1.
def next_attempt(sdir):
    path = os.path.join(sdir, "attempt.count")
    current = 0
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                current = int(handle.readline().strip() or "0")
        except (ValueError, OSError):
            current = 0
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(str(current + 1) + "\n")
    return current


def claim_and_launch(root, plan, job):
    sdir = slot_dir(root, job["seq"])
    os.makedirs(sdir, exist_ok=True)
    marker = os.path.join(sdir, "launching.marker")
    try:
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)  # spec 2.4, lock.py:50
    except FileExistsError:
        # A marker already exists. It is EITHER a genuine concurrent/finished claim (never double-fire)
        # OR an orphan stranded by a crash in the launch window (marker committed before the wrapper
        # spawn was durable) — which, left alone, wedges this seq `pending` forever (live-lock). This
        # recheck is LOAD-BEARING: a dead-progressor relaunch can run two progressors concurrently, so
        # we only reclaim when there is genuinely NO live pid AND NO terminal marker.
        run = read_run_pid(sdir)
        terminal = os.path.isfile(os.path.join(sdir, "result.json"))
        if terminal or (run and pid_alive(run["pid"])):
            return  # genuinely claimed/finished — never double-fire
        os.unlink(marker)  # orphan from a crashed launch -> reclaim
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.write(fd, str(os.getpid()).encode()); os.close(fd)
    attempt = next_attempt(sdir)
    child_env = dict(os.environ)
    child_env.update({
        "UTS_SLOT_DIR": sdir,
        "UTS_JOB_ARGV": json.dumps(job["command_argv"]),
        "UTS_JOB_ENV": json.dumps(job.get("env", {})),
        "UTS_ENV_ALLOWLIST": json.dumps(plan["security"]["env_key_allowlist"]),
        "UTS_ALLOWED_ROOTS": json.dumps(plan["security"]["allowed_roots"]),
        "UTS_JOB_WORKDIR": job["workdir"],
        "UTS_GPU_INDEX": str(job["gpu_index"]),
        "UTS_RUN_ID": job["run_id"],
        "UTS_SEQ": str(job["seq"]),
        "UTS_ATTEMPT": str(attempt),
        "UTS_LOG_MAX_BYTES": str(plan["limits"]["log_max_bytes"]),
    })
    # detached session leader (setsid via start_new_session) so the job survives the brain. If the
    # spawn itself fails, UNWIND the marker rather than stranding it (which would wedge the seq).
    try:
        wrapper = subprocess.Popen(["bash", "-c", WRAPPER_SH], env=child_env,
                         stdin=subprocess.DEVNULL,
                         stdout=open(os.path.join(sdir, "wrapper.log"), "ab", buffering=0),
                         stderr=subprocess.STDOUT, close_fds=True, start_new_session=True)
        # CP-3: record the WRAPPER (slot-supervisor-of-record) pid so reconcile/adopt resolve a live
        # pid for status/logs/cancel — NOT the dead-able progressor pid. The wrapper is the setsid
        # session leader; its pid == its process-group id (cancel = killpg on this pid).
        with open(os.path.join(sdir, "wrapper.pid"), "w") as wh:
            wh.write(f"{wrapper.pid}\n")
    except Exception:
        try:
            os.unlink(marker)
        except FileNotFoundError:
            pass
        raise


def reconcile_slots(root, plan):
    jobs_state = {}
    counts = empty_counts()
    statuses = {}
    for job in plan["jobs"]:
        verdict, _ = classify_seq(root, job)
        statuses[job["seq"]] = verdict
    draining = os.path.isfile(os.path.join(root, "drain.flag"))  # spec 7: drain = stop new launches
    free = plan["limits"]["slot_count"] - sum(1 for v in statuses.values() if v in ("running", "launching"))
    # launch ready pending seqs into free slots, ascending by seq (spec 2.4 seq is the key)
    for job in sorted(plan["jobs"], key=lambda j: j["seq"]):
        if free <= 0 or draining:   # drain: let running jobs finish, launch nothing new
            break
        if statuses[job["seq"]] == "pending":
            claim_and_launch(root, plan, job)  # attempt index is tracked durably per-seq on disk
            statuses[job["seq"]] = "launching"
            free -= 1
    # rebuild the job map + counts from disk after launching
    for job in plan["jobs"]:
        verdict, evidence = classify_seq(root, job)
        sdir = slot_dir(root, job["seq"])
        run = read_run_pid(sdir)
        entry = {"seq": job["seq"], "run_id": job["run_id"], "status": verdict,
                 "gpu_index": job["gpu_index"],
                 "log": os.path.join(sdir, "stdout.log")}
        # STATE schema types `pid` as integer; only surface it when a real pid exists (an un-launched
        # seq — pending / placement_conflict — has none, so we OMIT the key rather than write null).
        run_pid = (run or {}).get("pid")
        if isinstance(run_pid, int):
            entry["pid"] = run_pid
        # Surface the run.pid started_at_node (line 2) so the brain-side reconcile/adopt seam can pair it
        # against the held RunRecord's started_at_node (the anti-pid-reuse agreement check, spec 2.5).
        # The terminal result.json's started_at_node still wins for finished seqs; here we fill the LIVE
        # pairing for a running seq, which has no result.json yet.
        run_started = (run or {}).get("started_at_node")
        if isinstance(run_started, str) and run_started and "started_at_node" not in entry:
            entry["started_at_node"] = run_started
        # CP-3: surface the wrapper (slot-supervisor-of-record) pid so reconcile/adopt bind a LIVE pid
        wrapper_pid_path = os.path.join(sdir, "wrapper.pid")
        if os.path.isfile(wrapper_pid_path):
            try:
                with open(wrapper_pid_path, "r", encoding="utf-8") as wh:
                    entry["wrapper_pid"] = int(wh.readline().strip())
            except (ValueError, OSError):
                pass
        if isinstance(evidence, dict) and "exit_code" in evidence:
            entry["exit_code"] = evidence["exit_code"]
        jobs_state[str(job["seq"])] = entry
        bucket = "conflict" if verdict == "placement_conflict" else verdict
        if bucket == "launching":
            bucket = "running"
        if bucket in counts:
            counts[bucket] += 1
    return jobs_state, counts


# --- P0 daemonization (loop mode only) ----------------------------------------------------------
# The progressor is shipped INLINE as the FOREGROUND command of a two-hop SSH channel (`python3 -`,
# shell:false, fixed argv — NO free-form remote shell, so NO remote `setsid nohup … &`). The brain
# caps that channel's timeout at 30s and SIGTERMs the child at the deadline. A FOREGROUND resident
# loop would therefore die WITH the channel at ~30s, stalling the queue after the first window while
# RunRecords still say "running". So the loop MUST detach in PYTHON: the parent forks, prints the
# child's real pid on the ORIGINAL stdout (so the brain records a true supervisor pid), and exits 0 —
# the SSH channel closes promptly, well under the timeout. The child becomes a new session leader
# (os.setsid → immune to the channel's SIGHUP/process-group teardown), ignores SIGHUP, redirects its
# std streams (stdin←/dev/null, stdout/stderr→ <state_dir>/progressor.log) and runs the reconcile
# loop as a survivor daemon. A single fork + setsid is sufficient here: the node is Linux and the
# brain only needs the reported child pid (it does not re-attach a controlling terminal).
def daemonize(root):
    """Fork + setsid so the resident loop survives the SSH channel close. Returns True in the daemon
    CHILD (caller proceeds to run the loop); the PARENT prints {"pid": <child>} and exits 0 here."""
    # Ignore SIGHUP BEFORE the fork so the child INHERITS the ignore disposition — this closes the tiny
    # fork->setsid window in which a channel-close SIGHUP to the still-shared process group could kill
    # the child before it becomes its own session leader. The parent exits immediately below regardless.
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    pid = os.fork()
    if pid > 0:
        # PARENT: report the daemon's REAL pid on the ORIGINAL stdout (before any redirection) so the
        # brain's parseProgressorPid records a true, non-zero supervisor pid, then exit immediately so
        # the SSH channel closes well under its timeout. flush before _exit (no atexit/buffer flush).
        sys.stdout.write(json.dumps({"pid": pid}) + "\n")
        sys.stdout.flush()
        os._exit(0)
    # CHILD (the daemon): new session leader, detached from the SSH channel's process group + tty
    # (it already inherited SIGHUP=SIG_IGN from the pre-fork line above).
    os.setsid()
    log_path = os.path.join(root, "progressor.log")
    # line-buffered append log captures the detached loop's stdout/stderr for offline diagnosis.
    log = open(log_path, "a", buffering=1)
    devnull = open(os.devnull, "r")
    os.dup2(devnull.fileno(), sys.stdin.fileno())
    os.dup2(log.fileno(), sys.stdout.fileno())
    os.dup2(log.fileno(), sys.stderr.fileno())
    return True


def run_loop(root):
    while True:
        plan, _state, tripped = reconcile_once(root)
        if tripped:
            break
        if genuinely_idle(root, plan):
            break
        # active ~2s; back off when no pending (spec 2.4 backoff_poll_interval)
        time.sleep(max(1, plan["policy"].get("restart_throttle_seconds", 2)))
    return 0


def main(argv):
    root = state_dir()
    if "--once" in argv:
        # --once stays a single FOREGROUND reconcile that writes STATE and exits (never daemonizes):
        # it is the test-harness / one-shot path and the brain wants its result synchronously.
        reconcile_once(root)
        return 0
    # loop mode: daemonize so the resident loop survives the SSH window (P0). Guard os.fork defensively
    # (iHPC nodes are Linux, so fork is present); on a fork-less platform fall back to a foreground loop.
    if hasattr(os, "fork"):
        daemonize(root)  # PARENT exits inside here; only the detached CHILD returns to run the loop.
    return run_loop(root)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
