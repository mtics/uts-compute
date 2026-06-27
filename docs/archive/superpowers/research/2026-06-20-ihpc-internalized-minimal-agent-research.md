# Internalized iHPC Scheduler: Final Spec-Ready Architecture

## 0. ORIENTATION

**Decision (settled, not re-litigated):** internalize the scheduler's *brain* into the plugin (TypeScript/MCP). The node keeps only a **minimal slot-filling progressor** that launches detached jobs from a plugin-authored PLAN, auto-progresses the queue while the client is offline, and writes STATE files the plugin reads on reconnect. The node does **no** placement *policy*, **no** queue *policy*, **no** quota math, **no** mail, **no** 14-subcommand CLI.

**Two corrections that the original draft got wrong and the critiques proved against the code — both now baked into this spec:**

1. **"The node does no `nvidia-smi`" is a false absolute.** A *single, scoped, launch-time* GPU-occupancy guard MUST remain on the node, because **offline progression onto a shared/multi-account node is otherwise unsafe** (confirmed: `_find_slot` runs an nvidia-smi memory-threshold check *precisely because a GPU can be occupied by a foreign process* — `scheduler.py:331`; the project's own audit documents the per-state-file-not-per-GPU race — `AUDIT_2026-06-19:43`). What we remove from the node is *placement policy and cross-node load-balancing*, **not** the final free-GPU assertion at the moment of use. (Adversarial A2/B2, Completeness P0-1/P0-2.)

2. **The deploy-hardening locks DO NOT EXIST YET and the current default is clobber-on-uncertainty.** Confirmed verbatim: `probeSchedulerActive` treats "ANY failure to read a fresh-active state… as SAFE TO DEPLOY" and computes `active = ageSeconds <= 900 && hasWork` — so a *crashed* progressor with *live GPU jobs* reads as **not active → clobberable**. The draft's "deploy-hardening survives / is built" framing is wrong. **All locks, the anti-clobber GPU probe, `contractOrdering`, and the STATE_VERSION pre-check are NET-NEW Phase-A work, and `probeSchedulerActive` must be inverted to fail-closed.** (Adversarial A1/A3, Completeness P0-4.)

Everything below is written so it can be lifted directly into the rewritten spec.

---

## 1. SUMMARY

Split **brain from muscle**. The plugin (online with the user) is the brain: placement *policy*, queue/sweep/campaign progression *policy*, quota/conformance gates, version-pinned deployment, single-writer coordination, and the authoritative **state-of-record** (RunRecords). The node runs a **minimal resident progressor** (~250–350 LOC Python stdlib): reads an immutable PLAN, fills free slots, **auto-progresses while the client is offline**, and writes STATE files. The progressor is a direct generalization of the existing single-run `SUPERVISOR_PY` (`ihpc-start.ts:455`) from "launch one detached process" to "launch N, reconcile, refill, loop."

This is the canonical **fat-controller / thin-node** decomposition (Slurm `slurmctld` vs `slurmd`/`slurmstepd`), with task-spooler's offline-progression guarantee, but with placement *policy* lifted off the node. Recovery is **reconcile-never-reattach**: an idempotent on-disk terminal marker (`exit.code`/`result.json`) is authoritative, so completed jobs are never re-run and a crashed progressor re-derives all progress from files. The node retains exactly **one** piece of `nvidia-smi` logic — a *launch-time* free-GPU assertion in the per-job wrapper — because offline refill onto a shared/multi-account GPU is unsafe without it.

---

## 2. THE MINIMAL NODE AGENT (core deliverable)

### 2.1 Responsibilities and explicit non-responsibilities

| Does | Does NOT |
|---|---|
| Read PLAN once at startup (immutable per `queue_id`) | Decide *which* job runs (brain pre-orders the queue) |
| Count free slots from **live PIDs vs slot cap** | Run queue/placement *policy* or cross-node balancing |
| **At launch time only**, assert the target GPU is actually idle via `nvidia-smi --query-compute-apps` | Continuously poll `nvidia-smi`; compute occupancy *policy*; pick which GPU |
| Launch next ready job into a claimed slot via `setsid` wrapper | Compute quota / ban-critical caps |
| Track PID; on exit, write idempotent terminal marker | Send mail, maintain a CLI, hold the state-of-record |
| Auto-progress while offline; write STATE atomically (durable rename) | Reattach to process handles; re-run completed jobs |
| Heartbeat each loop; exit when queue drains or genuinely idle | Re-place a job (conflict → mark + defer to brain) |

The node's authority is bounded: execute a plan it was handed, **refuse-and-report** when the world disagrees with the plan (GPU busy), report observations. *Policy* lives in the brain.

### 2.2 PLAN FILE (brain → node; JSON; atomic durable write)

**Path:** `~/.uts-computing/scheduler/state/<campaign_id>/plan.json` — a profile-root dir, **reboot-survivable, never `/tmp`**.

```json
{
  "schema_version": "1.0.0",
  "schema_compat_min": "1.0.0",
  "campaign_id": "campaign_20260620_abc123",
  "queue_id": "sha256:<plan-content-hash>",
  "lease_owner": { "client": "claude|codex", "device_id": "laptop-7f3a", "issued_at": "2026-06-20T14:32:10Z" },
  "created_at": "2026-06-20T14:32:10Z",
  "node_id": "mars01",
  "profile_id": "utsihpc_user_01",
  "slot_count": 2,
  "max_slots_per_gpu": 1,
  "allowed_roots": ["/home/user/project", "/scratch/user"],
  "env_key_allowlist": ["CUDA_VISIBLE_DEVICES", "UTS_RUN_ID", "OMP_NUM_THREADS", "PYTHONUNBUFFERED"],
  "on_job_failure": "continue",
  "failure_breaker": { "max_consecutive_failures": 5, "require_one_success": true },
  "idle_definition": "no_running_and_no_launchable_pending",
  "idle_exit_seconds": 604800,
  "restart_throttle_seconds": 2,
  "log_max_bytes": 209715200,
  "jobs": [
    {
      "seq": 0, "run_id": "run_abc123",
      "command_argv": ["python", "train.py", "--lr", "0.01"],
      "workdir": "/home/user/project",
      "env": { "CUDA_VISIBLE_DEVICES": "$GPU_INDEX$", "UTS_RUN_ID": "$RUN_ID$" },
      "gpu_index": 0, "gpu_count": 1, "timeout_seconds": 3600
    }
  ]
}
```

**Design points (each cited / fixed against a critique):**

- **`seq` is the only progression key** (GNU-parallel `--resume`): "what's done" is re-derived by matching `seq` to terminal markers. The plan MUST be **immutable for a given `queue_id`** — seq-keyed resume corrupts if the plan mutates mid-run.
- **`command_argv` is a pre-escaped argv array; `bash -lc` is forbidden** — makes the quoting-injection class unrepresentable, matches `SUPERVISOR_PY`'s "non-empty string list" contract (`ihpc-start.ts:477`).
- **Token expansion is hardened, not hand-waved** (Completeness P1-3). Tokens use sentinel form `$GPU_INDEX$`/`$RUN_ID$`, are expanded **only inside `env` *values*** (never `argv[0]`, never re-split into multiple args, no nesting), by **literal substitution from a fixed whitelist**. An unknown `$TOKEN$` is a **hard fail, not passthrough**.
- **`env_key_allowlist` is enforced node-side** (Completeness P1-3). The plan lives in `~/.uts-computing` on a possibly-shared node; a tampered/second-writer plan could set `LD_PRELOAD`/`BASH_ENV`/`PYTHONSTARTUP`. The wrapper **rejects any env key not on the allowlist** before exec.
- **`gpu_index` is brain-assigned** (placement *policy* is the brain's job) but is **re-asserted free at launch time** by the wrapper (§2.6) — brain decides, node verifies.
- **`allowed_roots`** → wrapper re-validates `workdir` realpath inside roots at launch (defense in depth), exactly as `SUPERVISOR_PY.checked_path` does (`ihpc-start.ts:467`).
- **`depends_on` is CUT from v1** (Completeness P1-4). It was a schema field with no defined behavior — a latent bug that interacts with idle-definition and resume. Job ordering is expressed entirely by `seq` (the brain linearizes any DAG into seq order before emitting the plan). If true intra-plan dependencies are needed later, they ship in v1.1 with a defined ready-set computation.
- **`schema_compat_min`** declares the oldest brain that can safely read STATE written under this plan — the forward-compat contract (§2.7, Completeness P0-4).

### 2.3 SLOT-STATE protocol (node → brain; one summary file = source of truth)

The brain reads **one** `state.json` in a single `cat` (full-file, atomic-rename-safe, never `tail`); per-slot `result.json` is read only when a terminal state is observed. **Identity is the slot/seq directory, not the PID** (s6/nq lesson — defeats PID reuse).

```json
{
  "schema_version": "1.0.0",
  "campaign_id": "campaign_20260620_abc123",
  "queue_id": "sha256:<plan-content-hash>",
  "lease_owner": { "client": "claude", "device_id": "laptop-7f3a" },
  "observed_at_node": "2026-06-20T14:45:30Z",
  "progressor_pid": 54321,
  "progressor_started_at_node": "2026-06-20T14:32:11Z",
  "progressor_heartbeat_node": "2026-06-20T14:45:30Z",
  "node_clock_epoch": 1781966730,
  "slot_count": 2,
  "degraded": null,
  "breaker_tripped": false,
  "jobs": {
    "0": { "seq": 0, "run_id": "run_abc123", "status": "running",
           "pid": 12345, "gpu_index": 0,
           "started_at_node": "2026-06-20T14:32:15Z", "log": ".../slot_0/stdout.log" },
    "1": { "seq": 1, "run_id": "run_def456", "status": "done",
           "pid": 12350, "gpu_index": 1, "exit_code": 0,
           "started_at_node": "...", "finished_at_node": "...", "log": ".../slot_1/stdout.log" }
  },
  "counts": { "pending": 0, "running": 1, "done": 1, "failed": 0, "cancelled": 0, "conflict": 0 }
}
```

**Per-job terminal marker — `.../slot_<seq>/result.json`** (written by the wrapper, atomic durable rename, authoritative & idempotent):

```json
{ "seq": 1, "run_id": "run_def456", "exit_code": 0, "signal": null,
  "started_at_node": "...", "finished_at_node": "...", "duration_seconds": 707, "attempt": 0 }
```

**Status vocabulary:** `pending | launching | running | done | failed | cancelled | placement_conflict`. Modeled on GNU-parallel joblog (seq/start/runtime/exitval/signal), plus `launching` (B3 fix) and `placement_conflict` (B2 fix).

**Clock-skew rule (Completeness P1-6, confirmed against `scheduler-deploy.ts` `nowSeconds - heartbeatAt`):** **all `*_at_node` timestamps and all durations are computed node-side, node-clock vs node-clock.** The brain treats them as **opaque labels**, never subtracting laptop-now from a node timestamp. Heartbeat freshness is computed by the **node** (it stamps `progressor_heartbeat_node` and includes `node_clock_epoch`); the brain compares heartbeat age using node-relative math, or re-reads twice over SSH and diffs node-reported values. This corrects the inherited cross-clock subtraction that the current 900s rule performs.

**Atomicity (Adversarial C2 — load-bearing fix):** every write is **temp → `fsync(file)` → `rename` → `fsync(parent dir fd)`**. The directory fsync is mandatory, not optional: without it POSIX permits the rename (a dir-entry change) to be lost across reboot while file contents survive, so a finished job's `result.json` vanishes and §2.6's "no markers ⇒ pending" silently **re-runs a completed job** — the exact Nomad bug we claim to avoid. This matches/exceeds the vendored `state.save` (`.bak` + `.tmp` + rename, `state.py:205`) by adding the dir fsync it lacks.

### 2.4 AUTO-PROGRESSION — tiny resident reconcile loop (chosen: Option A)

```python
while has_running_or_launchable(state, plan):
    reconcile_slots(state)        # harvest dead PIDs -> read terminal marker -> done/failed/conflict
    write_heartbeat(state)        # mtime breadcrumb every loop (SPOF detectable)
    launch_ready(state, plan)     # while free_slots>0 and ready pending seqs: claim-then-setsid-launch
    write_atomic_durable(state_json, state)
    if breaker_tripped(state, plan): mark_breaker(); break
    if genuinely_idle(state, plan): break   # idle = no running AND no launchable-pending
    sleep(backoff_poll_interval(state))      # ~2-5s active; back off when no pending
```

`free = slot_count − count(status in {launching, running} with live pid)`. Free slots are computed by **counting live jobs**, never a token pool.

**Decision matrix (candidates + external precedent):**

| Option | Verdict | Why |
|---|---|---|
| **A. Resident reconcile loop** (`setsid nohup`) | **CHOSEN** | One SIGTERM cancels/drains; single liveness authority; self-healing slot count; ~250–350 LOC stdlib; closest to existing `SUPERVISOR_PY`; mirrors **task-spooler**'s offline progression with placement *policy* removed. |
| **B. setsid-chain** (each job execs next) | rejected | Can't stop/re-prioritize mid-queue; order frozen; a stuck job blocks the chain forever; no central liveness/reporting. |
| **C. systemd --user + linger + timer** | rejected as default | `enable-linger` needs one-time **root**, which a user-space-only iHPC account may lack. Allowed only as a *detected* enhancement; Option A is the guaranteed fallback. |
| **C′. cron `@reboot`** (Adversarial B1) | **adopted for the reboot case only** | User-space, **no root**, survives reboot — the one capability Option A lacks. A `@reboot` entry re-launches the progressor from markers after an offline node reboot (see §2.6). |

**Slot-claim is atomic and seq-keyed BEFORE fork (Adversarial B3 — load-bearing fix).** Counting live PIDs alone has a launch-window race: between `setsid …&` returning and the child writing `run.pid`, `kill -0` sees nothing, so a second iteration (or a relaunched progressor mid-launch) can double-fire the same `seq` (= same `run_id` twice = corrupted reconcile + double GPU use). Fix: `O_CREAT|O_EXCL` a `slot_<seq>/launching.marker` **before** `setsid` (reusing the codebase's own `lock.py:50` `O_CREAT|O_EXCL|O_WRONLY` pattern). The wrapper renames it to `run.pid` on start. Reconcile: present marker + no live pid ⇒ "crashed during launch ⇒ pending (new attempt)"; present marker + live pid ⇒ "claimed, do not relaunch."

**Slot-limit by counting, not tokens** — rejects the GNU-make jobserver FIFO-token approach precisely because a token leaks permanently on OOM-kill (make's documented weakness). Counting live PIDs against the cap is self-healing on crash; the launch marker closes its only gap.

### 2.5 PER-JOB WRAPPER — the `slurmstepd` analog, with a launch-time GPU guard

Reuses the proven `SUPERVISOR_PY` primitive (`start_new_session=True`, `stdin=DEVNULL`, `close_fds=True`), adding the env-allowlist check, token expansion, root re-validation, **launch-time GPU-free assertion**, and log-size cap:

```bash
setsid bash -c '
  # 1. validate: workdir realpath in allowed_roots; env keys in allowlist; tokens expanded literally
  # 2. LAUNCH-TIME GPU GUARD (B2 / P0-1 / P0-2): the ONLY nvidia-smi on the node
  if gpu_busy_by_foreign_pid "$GPU_INDEX"; then
       write_result_json status=placement_conflict   # do NOT exec; brain re-places on reconnect
       exit 0
  fi
  echo $$ > "$SLOT/run.pid" && mv "$SLOT/launching.marker" handled
  exec >"$SLOT/stdout.log" 2>&1 </dev/null
  exec "${ARGV[@]}"
'
# on child exit, wrapper writes exit.code then result.json (durable rename), enforces log_max_bytes
```

- **The launch-time GPU guard is the crux of the shared-node safety story.** It is the *only* `nvidia-smi` on the node, scoped to the instant of use — the one point that is cross-account-safe because the brain's logical pre-accounting cannot serialize against a *second account's independent brain* (confirmed: lock is per-state-file, not per-GPU — `AUDIT_2026-06-19:43`; multi-account same-node is the project's supported topology — MEMORY). It is cheap (one local `nvidia-smi`, no SSH), and it is what makes **offline refill onto a shared GPU safe**. On conflict the job becomes `placement_conflict`, stays unlaunched, and the brain re-places on reconnect.
- **Cancel** = `kill -- -$pgid` (process-group kill via the setsid session). **Liveness** = `kill -0 pid` / `/proc/<pid>`, paired with `started_at_node` to defeat PID recycling.
- **Log cap (Completeness P1-1):** wrapper enforces `log_max_bytes` (truncate-and-mark or rotate). A days-long N-slot campaign appending unrotated logs on a quota'd NFS/Lustre home can fill the disk → the *next* atomic temp-write fails → the node wedges. The progressor watches for `ENOSPC` on its own state write and sets `degraded:"disk_full"` + pauses launches rather than spinning.

### 2.6 CRASH / REBOOT RECOVERY — reconcile, never reattach

Recovery is a pure function of on-disk markers. On (re)start, for each `seq`:

| On-disk evidence | Conclusion | Action |
|---|---|---|
| `result.json` / `exit.code` present | **terminal** | Trust; **never re-run** (durable-rename §2.3 makes this hold across reboot) |
| `launching.marker` present, pid dead/absent | **crashed during launch** | Re-eligible as pending, **new attempt** (B3) |
| `run.pid` present, `kill -0` alive, no terminal marker | **running** | Adopt; count its slot |
| `run.pid` present, `kill -0` dead, no terminal marker | **crashed** | Mark failed; `on_job_failure` policy decides |
| `result.json status=placement_conflict` | **deferred** | Brain re-places on reconnect; not a failure |
| no markers | **pending** | Eligible to launch |

- **Client logout / VPN drop / laptop sleep:** brain disappears; jobs survive (own setsid session); progressor keeps filling slots and writing STATE. Reconnect ⇒ brain reads `state.json` once, reconciles RunRecords.
- **Progressor crash (OOM):** detached jobs survive. Brain detects dead `progressor_pid` (or **stale heartbeat** — the §2.4 breadcrumb makes this *detectable instead of silent*, Adversarial C3) + live jobs ⇒ re-launches the same progressor with the same plan ⇒ resumes from markers, losing nothing (GNU-parallel `--resume`).
- **Node reboot — HONEST BOUNDARY (Adversarial B1, Completeness P1-2):** the draft's "plugin re-launches the progressor" is wrong for the offline case — the brain only runs when the user is online, so an offline reboot strands the campaign. **State the boundary explicitly:** detached jobs die on reboot; without an autonomous re-spawn the campaign **pauses until reconnect**, then resumes from markers. For users who need autonomy across reboot, the **only** justified node-resident persistence is a **user-space cron `@reboot`** entry (no root, unlike systemd-linger) that re-launches the progressor; it is **opt-in via a profile flag**, not the default. Do not claim "self-healing on reboot" for the default path.

`restart_throttle_seconds ≥ 1` guards relaunch (s6 rule) so an instantly-failing job can't fork-bomb. **Consecutive-failure circuit breaker (Completeness D3):** the throttle bounds fork-*rate* but not total *duration* — a campaign whose remaining jobs all fail instantly would burn the node for the whole `idle_exit_seconds` emitting failures (and never idle-exit, since it's "active"). `failure_breaker` (N consecutive failures with zero successes ⇒ write `breaker_tripped`, pause, await reconnect) closes this.

### 2.7 SCHEMA FORWARD-COMPATIBILITY (Completeness P0-4 — deadlock breaker)

A long campaign can outlive a plugin upgrade. Deploy refuses over live work (§4); the brain can't reconcile if it can't read old-schema STATE ⇒ **deadlock**. Rule: **PLAN/STATE schemas are append-only and forward-compatible within a major version.** A v1.x brain MUST read any v1.y STATE (`y ≤ its own`), ignoring unknown fields; `schema_compat_min` in the PLAN declares the floor. A *major* bump (v2) is the only thing that may break reconcile, and it is gated behind draining live campaigns first. This is independent of `state.migrate.{plan,apply}` (which is plugin-local record migration, not node-file migration).

### 2.8 LANGUAGE / DEPENDENCY — Python 3 stdlib, shipped inline (with an honest risk note)

Stdlib only (`os, sys, json, subprocess, time, signal, pathlib, tempfile, fcntl`). No PyYAML (POSIX shell can't parse YAML and PyYAML is a dep; JSON is stdlib), no paramiko, no external packages. Shipped **inline over SSH stdin** as a micro-worker, exactly like `SUPERVISOR_PY` (`pyImports`, `PY_DECODE_SPEC`, `remote-python.ts`) — **nothing is "installed."** POSIX-sh was considered and rejected: pure-sh JSON parsing of `state.json` is error-prone; stdlib Python is the right tier for a user-space-only, intermittent-SSH, survive-logout node.

**Honest risk framing (Adversarial C3):** "minimal code" ≠ "minimal risk." The resident loop is itself a SPOF for progression — if it OOMs, refill stalls until reconnect. The heartbeat breadcrumb (§2.4) makes that **detectable**; idle-backoff shrinks the multi-day polling footprint a shared-cluster usage monitor could flag. We keep the SPOF (the vendored scheduler had it too) but surface it rather than implying it away.

---

## 3. THE PLUGIN BRAIN

### 3.1 What moves into the plugin (TS)

| Concern | Was (Python scheduler) | Now (plugin TS) |
|---|---|---|
| Placement **policy** | `placement.py` `NodeSlots`, `_find_slot` | `scheduler-placement.ts`: assign `(node, gpu_index, slots_per_gpu)` — **bookkeeping-first, SSH-probe only on cold-start/adopt/drift** (see below) |
| Queue progression **policy** | `scheduler.py` `run_forever`, `_dispatch_pending` | `scheduler-queue.ts`: ordering, `max_concurrent`, campaign boundaries, FIFO/fair |
| Pre-accounting (don't double-place) | `scheduler.py` `virtual_gpu_counts` (`:331-360`) | **same algorithm, ported to TS** — cite as *prior art*, not new (Completeness "cite prior art") |
| **Final free-GPU check** | `_find_slot` nvidia-smi memory-threshold | **launch-time wrapper guard on the node** (§2.5) — the one node-side nvidia-smi |
| State-of-record | `state.py` `SchedulerState` (JSON on node) | RunRecords (`core/types.ts`); node files are caches |
| Quota / ban-critical caps | (already TS) `quotas/*` | unchanged — checked **before** PLAN write |
| Single-writer coordination | `lock.py` `SchedulerLock` (`O_CREAT|O_EXCL`) | **re-instantiated, not deleted** — see §3.2 |
| Mail, hot-reload, tmux CLI | scheduler internals | **dropped** |

**Placement is bookkeeping-first, not probe-first (Adversarial A2, Completeness P0-1 resolution).** GPU topology is static (`queue.example.yaml:9`, resolved from `hardware.yaml`) and on a per-account view the only occupants of our slots are our own jobs, which the brain already knows from its plan/state. So **the common-path placement is pure brain bookkeeping** (`virtual_gpu_counts`-style pre-accounting: decrement available slots when a job is *placed into the PLAN*, not when later observed free) with **zero SSH `nvidia-smi`**. An SSH `nvidia-smi` probe is reserved for the **cold-start / adopt / drift-detected** path (first attach to a node we lack authoritative state for). This collapses `scheduler-placement.ts` from L→S and removes a per-submit dependency on the intermittent SSH link. **The cross-account/foreign-process safety that the probe used to provide is moved to the node's launch-time guard (§2.5)** — which is strictly better, because it runs at the actual moment of use and is the only point safe against a second account's independent brain.

**Why both pre-accounting AND the launch guard:** pre-accounting prevents *our own* brain from over-subscribing *our own* slots ("16 jobs onto 4 GPUs"); the launch guard prevents a *foreign* process (other account, raw interactive job) from colliding with a slot the brain assigned while offline. Neither subsumes the other.

### 3.2 Single-writer coordination — the lock did not disappear, it moved (Completeness P0-3)

The draft listed "lock → dropped." **That is a real bug.** The user runs **two clients (Claude Code AND Codex)** across possibly multiple devices; two brains can both pre-account, both write a PLAN (atomic rename = last-writer-wins ⇒ silent queue clobber), both launch a progressor ⇒ double-placement. The vendored `SchedulerLock` (`O_CREAT|O_EXCL` + stale-PID detection, `lock.py:50`) must be **re-instantiated as a single-writer lease per `(profile, node)`**:

- The lease is written **on the node** (`~/.uts-computing/scheduler/lease.json`, `O_CREAT|O_EXCL`, holder = `{client, device_id, pid, queue_id}`, stale-detected by heartbeat age node-side).
- The **progressor refuses a PLAN whose `lease_owner` ≠ current lease holder** (the on-node enforcement point), so a second brain that races a plan write is rejected at launch rather than silently clobbering.
- Brain-side: acquire/refresh the lease before placement; on stale lease (dead holder) a new brain may take over and adopt in-flight jobs via lineage (§5a).

### 3.3 Fusion with existing tools

```
sweep_plan({parameters, maxConcurrent, campaignId})
  → SweepResult.table[{index, params}]
      → planJob(... campaignId)  ⇒ N RunRecords (status:"planned")        [planner.ts]
          → scheduler-queue.ts: enqueue under campaign, apply max_concurrent
              → ACQUIRE (profile,node) LEASE                                [§3.2]
                  → quotas_capacity(refresh) + checkIhpcNodePoolConformance ⇒ GATE  [quotas/*]
                      → scheduler-placement.ts: pre-account (bookkeeping) ⇒ assign node+gpu_index
                          → scheduler-brain.ts: emit PLAN (durable write)
                              → ihpc-launch.ts: atomic SSH PLAN write + launch progressor ONCE/node
                                  ⇒ RunRecord.supervisor={progressor_pid}, .gpu_slot, .queue_position, .lease_owner
jobs_track / reconnect
  → read state.json once over SSH ⇒ reconcile RunRecords (running/done/failed/conflict)  [jobs.ts]
campaign_status / campaign_audit ⇒ per-account ledger rollup (unchanged)    [campaign.ts]
```

`campaignId` already threads `sweep_plan → planJob → RunRecord.campaign_id`; quota logic is already stateless/snapshot-driven/one-account-at-a-time (correct model — stays in TS, never delegated to the node); `ihpc-start` evolves from "launch one process" to "launch one **progressor** per node" — **but keeps a fast path** (§6 D1).

### 3.4 New / changed TS

| File | Purpose | Effort |
|---|---|---|
| `ops/scheduler/node-agent-plan.ts` | PLAN/STATE schemas + Ajv validation; token/env-allowlist/argv/realpath asserts; `schema_compat_min` check | M |
| `ops/scheduler/scheduler-placement.ts` | **bookkeeping pre-accounting** (port `virtual_gpu_counts`); SSH `nvidia-smi` **only** cold-start/adopt/drift | **S** (was L) |
| `ops/scheduler/scheduler-queue.ts` | pending queue, campaign membership, `max_concurrent`, progression policy | L |
| `ops/scheduler/scheduler-lease.ts` | single-writer lease per `(profile,node)`, stale detection, takeover (P0-3) | M |
| `ops/scheduler/scheduler-brain.ts` | `planNextBatch()` → lease+queue+placement+quota gate → emit PLAN | M |
| `ops/jobs/ihpc-launch.ts` | atomic SSH PLAN write (durable) + launch progressor; persist supervisor/gpu_slot/lease | M |
| extend `ops/jobs/jobs.ts` | `reconcileIhpcCampaign()` — read `state.json` once; sync RunRecords; **dead-progressor-but-live-jobs adopt path** (P3) | M |
| extend `core/types.ts` | RunRecord `+queue_position`, `+gpu_slot`, `+lease_owner`, `+auto_progressed{by_node_agent, freed_by_run_id}`, `+attempt` | S |
| extend `lib/ssh.ts` | `sshWriteAtomicJson()` (durable: temp→fsync→rename→dir-fsync) | S |
| `lib/ihpc-contract.ts` | **format change + `contractOrdering`** (§4) | M |
| the progressor | ~250–350 LOC Python, shipped inline | M |

---

## 4. DEPLOY + VERSION (of the tiny agent) — ALL NET-NEW, FAIL-CLOSED

**Framing correction (Adversarial A1):** the draft said this "survives / transfers." It does not exist. The current `probeSchedulerActive` **default is clobber-on-uncertainty** (confirmed: `active = ageSeconds <= 900 && hasWork`; header: "ANY failure… SAFE TO DEPLOY"). Every item below is **Phase-A work to build**.

- **Invert `probeSchedulerActive` to FAIL-CLOSED (highest-priority fix).** Unreadable status / SSH error / empty output ⇒ **refuse deploy**, not "safe." A deploy is safe only when we can positively prove the node has **no live work** — and "live work" must be detected by the **anti-clobber GPU probe** (fixed-argv `nvidia-smi --query-compute-apps=pid` + `pgrep -f setsid`), so a *crashed progressor with live GPU jobs* reads as **crash-with-live-work ⇒ refuse**. This is a *precondition* of deploy, not an enhancement.
- **Three locks (net-new):** Lock 1 confirmation gate; Lock 2 active-state probe (now fail-closed + GPU-liveness); Lock 3 post-deploy contract must read `match`.
- **Contract format change (Adversarial A3 / Completeness D2 — breaking, gated by `state.migrate`):** the current pin `"0.1.0+state2+e6883a9"` is an *upstream SHA* and `compareContract` returns only `match|stale|unknown` — **no ordering**, and git SHAs don't order, so `contractOrdering(older/newer/divergent)` is **not derivable** from today's format. Fix: **add a monotonic build ordinal** → format `version+stateN+buildM+sha`; make it **first-party** (regenerated by the plugin's own build, not upstream). `contractOrdering(live, expected)` compares `(stateVersion, build)` lexicographically: `older ⇒ redeploy`, `newer ⇒ refuse` (a second account deployed a newer agent), `equal-(version,build)-different-sha ⇒ divergent ⇒ refuse` (two-accounts-same-version hazard). This cascades into `CONTRACT_RE`, `schedulerContractVersion`, and requires a `state.migrate` step — flag as a **breaking format change**, not a drop-in. `compareContract` keeps its 3-value union for backward-compat; `contractOrdering` is additive.
- **STATE_VERSION pre-check (Lock 2.5):** SSH-read the node's state-file version; mismatch/legacy ⇒ refuse + surface reason. Independent of `state.migrate.apply` (plugin-local). Combined with §2.7 forward-compat so an in-flight campaign isn't stranded.
- **`node_scheduler` profile field** (optional, `console` default ⇒ Codex profiles validate unchanged): `{runner: console|uv|cron_reboot, uv_bin, dir}`, strict allow-list, shell-quoted, no operator interpolation; mismatch ⇒ `runner-drift` verdict. (`cron_reboot` is the opt-in reboot-autonomy flag, §2.6.)
- **Deploy to plugin-owned dir + SHA256 stamp + `current` symlink + keep-N=3 rollback.** A **stdlib-only progressor may need no uv at all** — if so, drop `uv run --frozen --offline`/`uv.lock` entirely; otherwise keep them for the tiny payload.

**Dropped / retired:** upstream sync cadence (`sync-ihpc-scheduler.sh`, `check-provenance.mjs`, `redactions.local.txt`, embedded real IDs) — the code is **first-party**, edited directly in `ihpc-scheduler/`. The 14-subcommand CLI, on-node tmux loop, placement/mail modules never ship to the node, so their deploy surface vanishes. **The lock does NOT retire** — it moves to the brain + node lease (§3.2).

---

## 5. FEATURE B REFRAME (`jobs.adopt`) — two verdicts on two trust axes

The draft's "lineage-proven is strictly stronger than PBS" **conflates two trust axes** (Adversarial C1). Separate them:

- **Axis (i) — terminal record provenance:** *did our agent produce this exit record?* For jobs our progressor launched: **yes, strong** — `exit.code`/`result.json` are wrapper-authored, in *our* code. Strictly stronger than PBS's external `qstat`.
- **Axis (ii) — intent fidelity:** *is the work it ran what the user meant?* `command_argv`/`workdir` originate from **user sweep params, only shape+root-validated** (`ihpc-start.ts:477,467`), **not** semantically verified — **same trust level as PBS.**

**(a) Jobs our progressor launched from our PLAN → ADOPT execution facts as authoritative.** Reconcile reads `state.json` over SSH; synthesizes the supervisor block; lineage provable via `queue_id`/`run_id`/`lease_owner` matching held RunRecords. Provenance flag is **two-dimensional**: `terminal_record: agent_authored` (strong) + `intent: user_declared` (shape-validated only). `jobs.status/logs/cancel` operate on *our* pid/log paths ⇒ sound. Don't let "we launched it" launder unvalidated `argv` into "intent authoritative."

**(b) Jobs found running we did NOT launch** (raw `ihpc-sched start`, or pre-internalization) → **history-only + `not_lineage_proven`**, every reported path through the full realpath gate; `jobs.status/logs/cancel` refused until a later phase.

**(c) Our own dead-progressor-but-live-jobs (Completeness P3) — wire explicitly.** §5(a) assumed the progressor is alive. The recovery model (§2.6) also produces "our progressor died, jobs still run detached." This **reuses the (a) lineage-proven path** (markers + lease prove lineage) but additionally **relaunches the progressor** to resume refill — both behaviors wired into `reconcileIhpcCampaign`, not just one.

Case (a)/(c) trust is **predicated on Feature A** (you must trust the *deployed agent version* — locks + contract + lease — before trusting the state it wrote). **Feature B sequences after Feature A.**

---

## 6. MIGRATION

**From today:** two paths coexist — full vendored scheduler at `ihpc-scheduler/`, and single-run `ihpc-start.ts` `SUPERVISOR_PY`.

| Phase | Action |
|---|---|
| **0. First-party flip** | Stop treating `mtics/uts-ihpc` as upstream; edit `ihpc-scheduler/` directly; retire sync/provenance; purge embedded IDs; first-party contract pin **with build ordinal** (§4). |
| **A. Hardened deploy of the tiny agent** | **Invert `probeSchedulerActive` to fail-closed**; ship three locks + anti-clobber GPU probe + STATE_VERSION pre-check + `contractOrdering` + `node_scheduler` field + SHA-stamped dir + rollback + **node lease** (§3.2). **First real-node smoke test** (only place all locks run for real). |
| **B. Brain build** | Land `node-agent-plan`, `scheduler-placement` (bookkeeping-first), `scheduler-queue`, `scheduler-lease`, `scheduler-brain`; extend RunRecord; port `virtual_gpu_counts`. |
| **C. Progressor cutover** | Replace `SUPERVISOR_PY` with the slot-filling progressor; wire `jobs.track → reconcileIhpcCampaign`. **Keep the legacy single-run path behind a profile flag for behavioral rollback** (D1/Completeness P2-5). |
| **D. Feature B** | Lineage-proven adoption (a/c); provenance-flagged history-only (b). |

**D1 — keep a single-run FAST PATH (Adversarial D1 / Completeness P2-5).** Routing every single run through `ihpc-launch({jobs:[one]})` + resident progressor + plan/state makes the *most-used, simplest* path depend on the *entire* new machinery — any regression breaks single-run too. Keep the direct `SUPERVISOR_PY` path as a **fast path** for `jobs==1, no campaign`; engage the progressor only when `slot_count>1` or a campaign queue exists. This also gives a **behavioral rollback**: a `node_scheduler.runner=console` (legacy) flag routes a profile back to single-run while the progressor stabilizes — the deploy keep-N=3 covers payload rollback, this covers behavior.

**Spec doc deltas (`2026-06-20-ihpc-scheduler-deploy-hardening-design.md`):** §0 → "first-party plugin sub-system" (kill vendoring narrative); §1 → "why a *node-resident progressor* exists" = **survivability of loop+state across disconnect, NOT autonomy and NOT SSH-independence**; §2 → forces tightened (continuity ≠ autonomy ≠ placement-policy-on-node); §3–7 = Feature A scope **re-labeled NET-NEW**, with **fail-closed `probeSchedulerActive`** as the headline change and the **contract-format build-ordinal** flagged breaking; §8–9 verification + rollback (incl. behavioral); §10 Codex neutrality; §11 Feature B as two-axis trust. **Net premise correction:** target the ~250–350-line progressor, not a full scheduler on the node.

---

## 7. TESTING & VERIFICATION (Completeness P2 — was absent, now mandatory)

The progressor is the riskiest, least-observable new component; ~250–350 LOC with **zero** test plan is unacceptable.

- **Local fake-node harness (no GPU, CI-able):** run the progressor against tmp dirs with fake `sleep`/`exit N` jobs; assert reconcile-never-reattach (no double-run, markers honored).
- **Crash-injection matrix:** crash before temp-write, between temp and rename, after rename, after `exit.code` but before `result.json`, **during the launch window (between setsid and run.pid)** (B3), **after rename but before dir-fsync** (C2 — must NOT re-run). Assert each is recoverable.
- **PID-recycling test:** stub `kill -0` alive for a recycled PID; assert `started_at_node` pairing rejects it.
- **Launch-marker test (B3):** kill progressor mid-launch; restart; assert the half-launched `seq` is not double-fired.
- **GPU-conflict test (B2):** stub `nvidia-smi --query-compute-apps` to report the target GPU busy; assert `placement_conflict`, no exec, brain re-places on reconnect.
- **Golden-source inline-Python test:** the progressor string must `python3 -c` parse/run (mirror the `remote-python.ts` micro-worker precedent test).
- **Clock-skew test (P1-6):** set node clock ≠ laptop clock; assert freshness/idle decisions use node-relative math only.
- **Lease test (P0-3):** two brains race a plan write; assert the loser's plan is rejected by the progressor's `lease_owner` check.
- **Named acceptance corpus (first-real-node smoke):** cold start → 1-slot launch → reconnect-reconcile → **offline-finish-and-refill** (disconnect SSH, reconnect, assert next job started while away) → progressor-OOM-relaunch → **node-reboot-pause-then-resume-on-reconnect** (and, if `cron_reboot` enabled, autonomous resume) → cancel-mid-campaign (drain vs now, below) → schema-mismatch-refusal → deploy-refusal-with-live-GPU-work.

**Cancellation semantics (Completeness P2-3):** offer **both** — "cancel now" (SIGTERM progressor + `kill -- -$pgid` each running job) and "drain" (stop new launches, let running finish) — mapped to `jobs.cancel` / `campaign` semantics. A cancelled job's `result.json status=cancelled` is **written by the wrapper on SIGTERM-to-job** (so a killed job always has a terminal marker; otherwise reconcile mis-reads it as "crashed").

**Codex client-neutrality (Completeness P2-4):** progressor + JSON protocol are client-neutral (good). New surface MUST land in the shared layer, not `.claude-plugin/`: any new MCP tool follows the **5-touch add-a-tool rule** (MEMORY); new schemas under `schemas/`; skills under `skills/`. Decide explicitly whether `ihpc-launch`/`reconcileIhpcCampaign` are **internal** (invoked by existing `jobs.*`/`sweep.*`/`campaign.*` tools — preferred, no new tool surface) or new tools. A neutrality checklist is a Phase-A gate.

---

## 8. EXTERNAL-PRECEDENT MAP

| Design choice | Precedent | Take / diverge |
|---|---|---|
| Brain decides placement *policy*; node executes | **Slurm `slurmctld` vs `slurmd`** | Take: controller holds queue/placement-policy; node never schedules. The correction over keeping policy on the node. |
| Per-job detached shepherd writing its own exit record | **`slurmstepd`** (+`setsid`) | Take: one transient session-leader per job, owns the pgroup, survives the manager; killpg to cancel. |
| Resident loop progresses queue while client offline | **task-spooler (`tsp`)** | Take: per-user daemon owns slot progression with client gone. Diverge: placement *policy* removed (tsp keeps it); **final free-GPU check stays at launch**. |
| Slot limit by counting live jobs, not tokens | **GNU make jobserver (anti-pattern)** | Diverge: make's FIFO token leaks on OOM-kill; count live PIDs against cap (self-healing) + `O_EXCL` launch marker for the launch-window race. |
| Seq-keyed immutable plan + resume-by-skip-done | **GNU parallel `--joblog`/`--resume`** | Take: monotonic `seq` is the only progression key; state re-derived from markers. |
| Job = directory; PID incidental; markers are truth | **s6 / runit / nq** | Take: stable dir identity defeats PID reuse; `exit.code` = idempotent terminal state. |
| Reconcile-never-reattach; never re-run completed | **Nomad alloc-dir (cautionary)** | Diverge: idempotent terminal marker + **durable rename (dir fsync)** + never `/tmp` make "never re-run" actually hold. |
| Pre-accounting (decrement on placement, not observation) | **vendored `scheduler.py` `virtual_gpu_counts` (`:331-360`)** | Take: **port existing prior art to TS** (cite, don't present as new). |
| Single-writer lease (multi-client) | **vendored `SchedulerLock` `O_CREAT|O_EXCL` (`lock.py:50`)** | Take: re-instantiate as `(profile,node)` lease; progressor enforces `lease_owner`. The lock moved, didn't vanish. |
| Launch-time free-GPU assertion | **vendored `_find_slot` nvidia-smi memory check (`:331`)** | Take: keep the *check*, move it from placement-time-on-controller to launch-time-on-node — the only cross-account-safe point. |
| Reboot autonomy without root | **cron `@reboot`** (vs systemd-linger needing root) | Take only if `cron_reboot` opt-in; default = pause-until-reconnect (honest boundary). |
| Restart throttle ≥1s + consecutive-failure breaker | **s6-supervise** (+ circuit-breaker pattern) | Take: throttle bounds fork-rate; breaker bounds total duration (s6 throttle protects the node, not the campaign). |

---

## 9. CRITIQUES JUDGED INVALID / NARROWED

- **Completeness "node must carry occupancy or offline progression is unsafe" — accepted but narrowed:** correct that *some* node-side GPU check is required; **wrong** if read as "the node needs continuous occupancy polling / placement." Scope is exactly one launch-time assertion in the wrapper (§2.5), not a return of placement policy to the node.
- **Completeness P3 `fsync`-on-NFS/Lustre note — acknowledged, not blocking:** dir-fsync may be a partial no-op on some network FS; we still issue it (correctness where supported) and rely on the marker idempotency + lease for the rest. Worth a spec note, not an architecture change.
- **Draft's "strictly stronger than PBS" — rejected as stated, replaced** by the two-axis model (§5): stronger on terminal-record provenance, *equal* on intent fidelity.
- **Draft's "single-user ⇒ placement can't go stale" — rejected:** the project's own audit (`AUDIT_2026-06-19:43`) and multi-account model prove it can; hence the launch-time guard + lease.
- **Draft's "deploy-hardening survives" / "self-healing on reboot" — rejected as factually wrong against the code** (`probeSchedulerActive` clobber-default; offline reboot strands the campaign); replaced by fail-closed deploy + honest reboot boundary + opt-in `cron_reboot`.

---

## 10. PRIORITY FIX LIST (for the spec author)

1. **Invert `probeSchedulerActive` to fail-closed + anti-clobber GPU probe; re-label ALL deploy-hardening as net-new** (A1) — currently clobbers offline work; highest risk.
2. **Placement = brain bookkeeping (port `virtual_gpu_counts`), no per-submit SSH `nvidia-smi`; move the free-GPU check to a launch-time wrapper guard** (A2/B2/P0-1/P0-2) — collapses the biggest component AND fixes shared-node offline safety.
3. **Durable rename (file fsync + rename + dir fsync) + `O_EXCL` launch marker** (C2/B3) — without both, "never re-run completed" and "no duplicate seq" are false.
4. **Re-instantiate the single-writer lease** (P0-3) — two clients (Claude+Codex) silently clobber plans / double-place otherwise.
5. **Contract format: add monotonic build ordinal before `contractOrdering`; flag breaking + `state.migrate`** (A3/D2).
6. **Schema forward-compat rule** (P0-4), **precise idle definition + cut `depends_on` + failure circuit-breaker + reconcile retry-vs-terminal seam** (P1-2/P1-4/P1-5/D3), **node-side clock math** (P1-6), **env-allowlist + token hardening + log-cap/disk-full** (P1-3/P1-1).
7. **Honest reboot boundary + opt-in `cron_reboot`** (B1), **heartbeat-detectable SPOF** (C3).
8. **Node-agent crash-injection harness + named acceptance corpus** (P2-1/P2-2); **cancel drain-vs-now + wrapper-writes-`cancelled`** (P2-3); **single-run fast path + behavioral rollback flag** (D1/P2-5); **Codex-neutral 5-touch checklist** (P2-4).

---

**Key file references (absolute, verified this session):**
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/jobs/ihpc-start.ts:455` — `SUPERVISOR_PY` (the progressor template; `start_new_session=True`, `command_argv` list `:477`, `checked_path` root-gate `:467`, append-mode unrotated logs).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/data/scheduler-deploy.ts:147` — `probeSchedulerActive`, **confirmed clobber-on-uncertainty default** (`active = ageSeconds <= 900 && hasWork`) + cross-clock `nowSeconds - heartbeatAt`. Invert to fail-closed (A1, P1-6).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/lib/ihpc-contract.ts:8,32,40` — `ContractParts`, `compareContract` (`match|stale|unknown`, **no ordering**), `EXPECTED = "0.1.0+state2+e6883a9"` (**upstream SHA**). Add build ordinal + `contractOrdering` (A3).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/ihpc-scheduler/src/scheduler/scheduler.py:331-360` — `_find_slot` nvidia-smi memory-threshold check + `virtual_gpu_counts` pre-accounting (port to TS; move the check to the node launch guard).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/ihpc-scheduler/src/scheduler/lock.py:50` — `SchedulerLock` `O_CREAT|O_EXCL` pattern (reuse for both the node lease and the launch marker).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/ihpc-scheduler/src/scheduler/state.py:205` — `state.save` `.bak`+`.tmp`+rename (match/exceed; **add the dir fsync it lacks**).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/ihpc-scheduler/src/scanner/infra/collector.py:117` — node-local `nvidia-smi` today (the check we keep, scoped to launch time).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/docs/AUDIT_2026-06-19_ihpc-sched-internalization.md:43` — project's own statement that the GPU-idle check races (per-state-file, not per-GPU lock).
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/jobs/adopt.ts` — `pbsRowToRunRecord`, the external-evidence→RunRecord pattern Feature B generalizes (and the dead-progressor-but-live-jobs path to wire into `reconcileIhpcCampaign`).
- New tree to create: `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/scheduler/{node-agent-plan,scheduler-placement,scheduler-queue,scheduler-lease,scheduler-brain}.ts` and `mcp-server/src/ops/jobs/ihpc-launch.ts`.