# iHPC 内化 — Phase C(节点推进器 + 切换)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现。步骤用 checkbox(`- [ ]`)跟踪。每个 Task 末尾 commit;**不 push**(控制器统一处理)。

**Goal:** 构建并切换到**节点侧极小推进器**:`node/progressor.py`(~250–350 行 Python 3 stdlib,经 SSH inline ship)读不可变 PLAN、按 slot 填空对账(reconcile-never-reattach)、在客户端离线时自主推进队列、把 STATE 原子 durable 写盘;`seam/launch.ts`(原子 SSH 写 PLAN + 每节点起一次推进器,持久化 supervisor/placement/lease 到 RunRecord);`seam/reconcile.ts`(`reconcileIhpcCampaign`:一次读 `state.json`、同步 RunRecords、死推进器-但活作业路径);把 `jobs.track` 接进 `seam/reconcile`;保留**单次快路径**(`jobs==1`/无 campaign 直连 `SUPERVISOR_PY`);崩溃注入 harness + 命名验收语料;取消 drain-vs-now。

**Architecture:** 大脑/肌肉分离(spec §1)。本阶段只建**肌肉(节点)** + **接缝(seam)**;**大脑(control/*)与 schema(seam/protocol.ts)是 Phase B 的前置交付**(见下「前置依赖」)。推进器是既有单次 `SUPERVISOR_PY`(`ihpc-start.ts:455`)从「起一个 detached 进程」到「起 N 个、对账、补位、循环」的直接泛化(spec §1、§2.4)。恢复是 **reconcile-never-reattach**(spec §2.6):落盘的幂等终止标记(`result.json`)是权威,完成的作业永不重跑。机制:常驻 reconcile 循环(`setsid nohup`,spec §2.4 Option A);slot 认领在 fork 前 `O_CREAT|O_EXCL` launch.marker(复用 `lock.py:50`);durable 写 = temp→`fsync(file)`→rename→`fsync(dir)`(spec §2.3,比 `state.py:205` 多目录 fsync);per-job wrapper 带**启动时 GPU 守卫**(节点上唯一 `nvidia-smi`,spec §2.5)+ SIGTERM trap 写 `status=cancelled`;node 侧 `lease.json` 强制(拒绝 `lease_owner` ≠ 当前持有者的 PLAN,spec §3.2)。

**Tech Stack:** TypeScript(ES modules、Ajv)、`node --test`;Python 3 stdlib only(`os, sys, json, subprocess, time, signal, pathlib, tempfile, fcntl`——无 PyYAML/paramiko,spec §2.8);推进器经 `remote-python.ts` 的 `pyImports`/`PY_DECODE_SPEC` 机制 inline ship(spec §2.8)。依据 spec:`docs/superpowers/specs/2026-06-20-ihpc-scheduler-internalized-design.md` §2(全节)、§3.3、§3.4(`seam/launch`/`seam/reconcile`)、§5c、§6(C/D1)、§7。

**前置依赖(本阶段假定已 merge,不在本阶段重做):**
- **Phase A**:`node_scheduler` profile 字段({runner: console|uv|cron_reboot, uv_bin?, dir?})、`buildSchedulerSshArgs`、`contractOrdering`、fail-closed 部署、节点 lease 写入控制路径。本阶段**消费** `node_scheduler.runner` 做快路径路由(§6 D1)。
- **Phase B**:`ops/scheduler/seam/protocol.ts`(PLAN/STATE 的 Ajv schema + token/env-allowlist/argv/realpath 断言 + `schema_compat_min`,**canonical 导出名 `assertIhpcPlan`/`assertIhpcState`**——CP-1)、`ops/scheduler/control/{placement,queue,lease,plan}.ts`(尤其 `planNextBatch()` 发 PLAN 对象、`control/lease.ts` 的 acquire/refresh)、`lib/ssh.ts` 的 `sshWriteAtomicJson()`、`core/types.ts` 的 **canonical `IhpcPlan` 类型(`campaign_id: string` 非空——CP-5)** 与扩展的 RunRecord(`+queue_position`、`+lease_owner`、`+auto_progressed{by_node_agent,freed_by_run_id}`、`+attempt`、`placement.gpu_slot?`——B-2/CP-3)、以及 `ihpc-state.schema.json` 的 `jobs[<seq>].wrapper_pid?`(CP-3,本阶段推进器写、Phase D 读)。本阶段**消费** `assertIhpcPlan`(写盘前校验 campaign PLAN)/`assertIhpcState`(reconcile 时校验 STATE)、`planNextBatch()` 的输出(含 `gpu_slot`)、`sshWriteAtomicJson()`、`IhpcPlan` 类型、扩展后的 RunRecord 字段。

> **本阶段对 Phase B 的新增 ASK(已在 Phase B 计划登记,此处只列依赖,不在本阶段补建):** (a) protocol.ts 导出名固定为 `assertIhpcPlan`/`assertIhpcState`;(b) `IhpcPlan.campaign_id: string`(非空,单次快路径用本阶段的 `SingleRunSpec`,不复用 `IhpcPlan`);(c) STATE schema `jobs[<seq>].wrapper_pid?: integer`(slot-supervisor-of-record pid,CP-3);(d) `planNextBatch` 把 `reserveSlots` 的 `gpu_slot` 透传进 PLAN job(使 `placement.gpu_slot` 不 dead,B-2)。

> **若前置未就位的兜底:** 每个消费前置接口的 Task 在 Step 0 用 `grep` 断言该符号存在(命令给出);缺失则停下、先完成 Phase A/B,不在本阶段补建大脑/schema/lease。

**基线:** 全套 `npm test` 当前 478(本机实测;CI 含 python pytest 另计)。`npm run build` 必须先跑(测试 import `../../dist/...js`)。推进器测试用本机 `python3`(实测 3.14)直接跑 `node/progressor.py`,无需真实节点/GPU(spec §7「本地假节点 harness」)。

---

## 共享接口(本阶段 verbatim 使用,来自 spec §2.2/§2.3 + 顶层 SHARED INTERFACES)

**PLAN(大脑→节点,`~/.uts-computing/scheduler/state/<campaign_id>/plan.json`,绝不 `/tmp`):**
顶层 `{schema_version, schema_compat_min, campaign_id, queue_id, lease_owner, node_id, profile_id}`;
`limits{slot_count, max_slots_per_gpu, log_max_bytes}`;
`security{allowed_roots, env_key_allowlist}`;
`policy{on_job_failure, failure_breaker{max_consecutive_failures, require_one_success}, idle_definition, idle_exit_seconds, restart_throttle_seconds}`;
`jobs[]{seq, run_id, command_argv, workdir, env, gpu_index, gpu_count, timeout_seconds}`。

**STATE(节点→大脑,同目录 `state.json`):**
顶层 `{schema_version, campaign_id, queue_id, lease_owner, observed_at_node, node_clock_epoch, slot_count}`;
`progressor{pid, started_at_node, heartbeat_node}`;`health{degraded, breaker_tripped}`;
`jobs{<seq>:{seq, run_id, status, pid, wrapper_pid?, gpu_index, exit_code?, started_at_node, finished_at_node?, log}}`;
`counts{pending, running, done, failed, cancelled, conflict}`。

> **CP-3「supervisor of record」:** `jobs[<seq>].pid` 是**内层作业** pid;`jobs[<seq>].wrapper_pid` 是**per-slot wrapper(setid 会话首)**的 pid——这才是 campaign job 的「supervisor of record」。`progressor.pid` 是推进器自身、可死(§5c);`wrapper_pid` 在 wrapper 写 `run.pid` 时一并落 STATE。Phase B 在 `ihpc-state.schema.json` 的 `jobs[<seq>]` 加可选 `wrapper_pid`;Phase D adopt 用 `wrapper_pid`(非死的 `progressor.pid`)构 supervisor 块。

**per-slot 终止标记 `slot_<seq>/result.json`:** `{seq, run_id, exit_code, signal, started_at_node, finished_at_node, duration_seconds, attempt}`。

**lease_owner:** `{client, device_id, issued_at}`;node `lease.json` holder `{client, device_id, pid, queue_id}`。

**status 词表:** `pending | launching | running | done | failed | cancelled | placement_conflict`。

**token 哨兵:** `$GPU_INDEX$`/`$RUN_ID$`,**只在 `env` 值里**字面替换,白名单固定,未知 `$TOKEN$` 硬失败(spec §2.2)。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `mcp-server/src/ops/scheduler/node/progressor.py` | ~250–350 行 stdlib 推进器:读 PLAN、lease 强制、slot reconcile 循环、per-job wrapper(GPU 守卫 + SIGTERM trap)、durable 写、`O_EXCL` launch.marker、reconcile-never-reattach 恢复 | **新建** |
| `mcp-server/src/ops/scheduler/node/progressor-source.ts` | 把 `progressor.py` 读成 `PROGRESSOR_PY` 字符串(inline ship);`buildProgressorStdin(plan)` 组装 SSH stdin | **新建** |
| `mcp-server/src/ops/scheduler/seam/launch.ts` | `launchIhpcCampaign()`:`assertIhpcPlan` 校验 PLAN(仅 campaign 路径,非空 campaign_id)→ `sshWriteAtomicJson` 写 plan.json + lease 预检 → 每节点起一次推进器(`setsid nohup`)→ 持久化 supervisor(**slot 路径化**,CP-3)/placement.gpu_index+gpu_slot/queue_position/lease_owner 到各 RunRecord;单次快路径(`campaign_id===null` 判别式)分流。CP-5:`PlanObject = IhpcPlan | SingleRunSpec` 判别联合 | **新建** |
| `mcp-server/src/ops/scheduler/seam/status.ts` | CP-4 单一 `nodeStatusToRunStatus()` 映射器(node STATE status → RunRecord.status,C `reconcile.ts` 与 D `adopt.ts` 共用,不各抄一份) | **新建** |
| `mcp-server/src/ops/scheduler/seam/reconcile.ts` | `reconcileIhpcCampaign()`:一次 SSH 读 `state.json` → Ajv 校验(`assertIhpcState`)→ 同步 RunRecords(running/done/failed/cancelled/placement_conflict,经 `nodeStatusToRunStatus`)→ 死推进器-但活作业:adopt 活作业(可注入 hook,D 接)+ 重起推进器 resume(§5c)。CP-2 签名 `{campaignId,profileId,profile,node,runRecords}` + deps `{readState,persistRunRecord,relaunchProgressor,progressorAlive?,adoptLiveJob?,auditDir?}` 与 Phase D verbatim 共享 | **新建** |
| `scripts/copy-progressor.mjs` | C-5 postbuild:`tsc` 后把 `progressor.py` 复制进 `dist/`(`package.json` `postbuild` 触发);测试断言 dist==src | **新建** |
| `mcp-server/src/ops/jobs/jobs.ts` | `reconcileRunStatus` 对带 `campaign_id` 的 iHPC run 走 `reconcileIhpcCampaign`(而非 per-pid `IHPC_STATUS_PY`) | **改** |
| `mcp-server/tests/fixtures/remote-python/PROGRESSOR_PY.py` | 推进器 golden 字节快照 | **新建** |
| `mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs` | 本地假节点:reconcile-never-reattach、launch-marker、崩溃注入矩阵、GPU 冲突、lease 拒绝、PID 复用 | **新建** |
| `mcp-server/tests/ops/scheduler/progressor-snapshot.test.mjs` | `PROGRESSOR_PY` golden 字节 + `python3 -c` 语法解析 | **新建** |
| `mcp-server/tests/ops/scheduler/launch.test.mjs` | `launchIhpcCampaign` 写 PLAN/起推进器/持久化 RunRecord;快路径分流;lease 写 | **新建** |
| `mcp-server/tests/ops/scheduler/reconcile.test.mjs` | `reconcileIhpcCampaign` STATE→RunRecord 同步;死推进器路径;时钟偏移;Ajv 拒绝坏 STATE | **新建** |

---

## Task 1:推进器骨架 —— 读 PLAN、lease 强制、durable 写、心跳

仅 stdlib。本任务落:argv-decode(镜像 `PY_DECODE_SPEC`)、PLAN 读取与基本断言、**node 侧 lease.json 强制**(spec §3.2:拒绝 `lease_owner` ≠ 当前持有者)、durable 原子写(temp→fsync→rename→dir-fsync,spec §2.3)、心跳 + STATE 初版。reconcile/launch 循环留 Task 2-3。

**Files:**
- Create: `mcp-server/src/ops/scheduler/node/progressor.py`
- Test: `mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`

- [ ] **Step 0: 确认 Phase B 前置(目录 + sshWriteAtomicJson)**

Run:
```bash
test -d mcp-server/src/ops/scheduler/seam && grep -q "sshWriteAtomicJson" mcp-server/src/lib/ssh.ts && echo "B-OK" || echo "B-MISSING — finish Phase B first"
mkdir -p mcp-server/src/ops/scheduler/node mcp-server/tests/ops/scheduler
```
Expected: `B-OK`(若 `B-MISSING` 停下先做 Phase B)。

- [ ] **Step 1: 写失败测试(假节点:lease 拒绝 + durable STATE 写)**

`mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
```

- [ ] **Step 2: Run — FAIL**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: FAIL(`progressor.py` 不存在 → `python3` 报 `No such file`,`r.status` 非 0 且无 `state.json`;两测试均挂)。

- [ ] **Step 3: 实现 `progressor.py`(骨架部分)**

`mcp-server/src/ops/scheduler/node/progressor.py`:
```python
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


def reconcile_once(root):
    plan = load_plan(root)
    enforce_lease(root, plan)
    # Task 2 fills slot reconcile + launch; for now just write a heartbeat STATE.
    jobs, counts = reconcile_slots(root, plan)
    state = build_state(plan, jobs, counts)
    write_atomic_durable(os.path.join(root, "state.json"), state)
    return plan, state, counts


# reconcile_slots / launch_ready are completed in Task 2; placeholder for the skeleton
# returns empty job-map + zero counts so Task 1's empty-PLAN test passes.
def reconcile_slots(root, plan):
    return {}, empty_counts()


def main(argv):
    root = state_dir()
    once = "--once" in argv
    if once:
        reconcile_once(root)
        return 0
    # resident loop wired in Task 2
    reconcile_once(root)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: Run — PASS**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: PASS(两测试均绿:lease 不匹配非 0 退出无 STATE;空-jobs PLAN 写出 durable STATE)。

- [ ] **Step 5: 验证 durable 写真的 fsync 目录(无残留 .tmp)**

Run:
```bash
node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs 2>&1 | tail -3
```
Expected: PASS;手动确认实现里 `write_atomic_durable` 调了 `os.fsync(dir_fd)`(目录 fsync 是 spec §2.3 承重项)。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/scheduler/node/progressor.py \
  mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs
git commit -m "feat(scheduler): progressor skeleton — PLAN read, node-side lease enforce, durable STATE write"
```

---

## Task 2:slot reconcile 循环 + launch-marker + per-job wrapper(GPU 守卫 + SIGTERM trap)

落 spec §2.4(reconcile 循环 + `O_EXCL` 认领)、§2.5(per-job wrapper:env 白名单、token 展开、root 复校、启动时 GPU 守卫、SIGTERM trap 写 `cancelled`、`log_max_bytes`)、§2.6(reconcile-never-reattach 恢复表)。

**Files:**
- Modify: `mcp-server/src/ops/scheduler/node/progressor.py`
- Test: `mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`

- [ ] **Step 1: 追加失败测试(slot 填充、终止标记、GPU 冲突、launch-marker、PID 复用)**

追加到 `progressor-reconcile.test.mjs`。stub `nvidia-smi` 用注入的 PATH bin:
```javascript
// 写一个 stub nvidia-smi 到 bin/,prepend 进 PATH。busy=true 时报目标 GPU 被外部 pid 占用。
function withStubNvidiaSmi(dir, { busyGpu = null } = {}) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const smi = path.join(bin, "nvidia-smi");
  // --query-compute-apps=pid,gpu_bus_id 风格:busy 时打印一行 fake pid。
  const body = busyGpu === null
    ? `#!/bin/sh\nexit 0\n`
    : `#!/bin/sh\n# stub: report GPU ${busyGpu} busy by a foreign pid\necho "999999"\n`;
  fs.writeFileSync(smi, body, { mode: 0o755 });
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
  for (let i = 0; i < 3; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "placement_conflict");
  assert.equal(fs.existsSync("/tmp/SHOULD_NOT_RUN"), false, "the job must NOT have exec'd");
});

test("progressor rejects an env key not in the allowlist", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["python3", "-c", "pass"], { env: { LD_PRELOAD: "/evil.so" } })] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  for (let i = 0; i < 3; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "failed");
  assert.match(JSON.stringify(result), /allowlist|env/i);
});

test("launch-marker prevents re-firing a seq when killed mid-launch (no double-fire)", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["sleep", "30"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); // claims + launches
  // run.pid 存在且活 => 第二轮不得再 fire(adopt,占其 slot)
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const slot = fs.readdirSync(path.join(dir, "slot_0"));
  assert.ok(slot.includes("run.pid"), "claimed marker must have become run.pid");
  // 只有一个活作业:slot_count=1,不会有 slot_0 的第二个 attempt 在跑
  const pid = Number(fs.readFileSync(path.join(dir, "slot_0", "run.pid"), "utf8").trim());
  process.kill(pid, "SIGKILL"); // 清理 sleep 30
});
```

- [ ] **Step 2: Run — FAIL**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: FAIL(`reconcile_slots` 仍是 placeholder:不启动作业,无 `slot_0/`、无 `result.json`,新增 4 测试全挂)。

- [ ] **Step 3: 实现 slot reconcile + launch-marker + wrapper**

替换 Task 1 的 placeholder `reconcile_slots`,并新增 launch + wrapper 逻辑。在 `progressor.py` 里把 placeholder 段替换为:
```python
# --- per-seq slot directory + on-disk evidence (spec 2.6 recovery table) ---
def slot_dir(root, seq):
    return os.path.join(root, f"slot_{seq}")


def pid_alive(pid):
    if not pid or pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_run_pid(sdir):
    pid_path = os.path.join(sdir, "run.pid")
    if not os.path.isfile(pid_path):
        return None
    try:
        with open(pid_path, "r", encoding="utf-8") as handle:
            first = handle.readline().strip()
            second = handle.readline().strip()
        return {"pid": int(first), "started_at_node": second or None}
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
    if run and pid_alive(run["pid"]):
        return ("running", run)
    marker = os.path.join(sdir, "launching.marker")
    if os.path.isfile(marker):
        # launching crash (claimed but no live pid, no terminal marker) -> re-eligible pending
        return ("pending", {"attempt_bump": True})
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
import json, os, signal, subprocess, sys, time
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

def write_result(status, exit_code=None, signal_name=None):
    started = os.environ.get("UTS_STARTED_AT", "")
    fin = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    obj = {"seq": seq, "run_id": run_id, "status": status, "exit_code": exit_code,
           "signal": signal_name, "started_at_node": started, "finished_at_node": fin,
           "duration_seconds": 0, "attempt": int(os.environ.get("UTS_ATTEMPT", "0"))}
    tmp = os.path.join(slot, "result.json.tmp")
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    os.write(fd, (json.dumps(obj, sort_keys=True) + "\n").encode()); os.fsync(fd); os.close(fd)
    os.rename(tmp, os.path.join(slot, "result.json"))
    dfd = os.open(slot, os.O_RDONLY); os.fsync(dfd); os.close(dfd)

# 1. workdir realpath inside allowed_roots (defense in depth, spec 2.5 / ihpc-start.ts:467)
real_wd = os.path.realpath(workdir)
if not any(real_wd == os.path.realpath(r) or real_wd.startswith(os.path.realpath(r) + os.sep) for r in roots):
    write_result("failed", exit_code=126); sys.exit(0)

# 2. env: allowlist-only + literal token expand ($GPU_INDEX$/$RUN_ID$); unknown $TOKEN$ hard-fails
TOKENS = {"$GPU_INDEX$": gpu_index, "$RUN_ID$": run_id}
job_env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
for key, val in env_overrides.items():
    if key not in allow:
        write_result("failed", exit_code=126); sys.exit(0)  # key not in env_key_allowlist (spec 2.2)
    if isinstance(val, str) and val.startswith("$") and val.endswith("$"):
        if val not in TOKENS:
            write_result("failed", exit_code=126); sys.exit(0)  # unknown $TOKEN$ -> hard fail (spec 2.2)
        val = TOKENS[val]
    job_env[key] = str(val)

# 3. launch-time GPU guard: the ONLY nvidia-smi on the node (spec 2.5). foreign pid on
#    target GPU -> placement_conflict, do NOT exec; brain re-places on reconnect.
try:
    out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"],
                         capture_output=True, text=True, timeout=10)
    busy = bool(out.stdout.strip())
except (FileNotFoundError, subprocess.TimeoutExpired):
    busy = False  # no GPU tooling on the fake/CI node -> treat as free (spec 7 harness)
if busy and os.environ.get("UTS_GPU_GUARD", "1") == "1":
    write_result("placement_conflict"); sys.exit(0)

# 4. claim -> run.pid (started_at second line beats PID reuse, spec 2.5)
started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
os.environ["UTS_STARTED_AT"] = started
log = open(os.path.join(slot, "stdout.log"), "ab", buffering=0)
proc = subprocess.Popen(argv, cwd=workdir, env=job_env, stdin=subprocess.DEVNULL,
                        stdout=log, stderr=subprocess.STDOUT, close_fds=True,
                        start_new_session=True)
with open(os.path.join(slot, "run.pid"), "w") as h:
    h.write(f"{proc.pid}\n{started}\n")
marker = os.path.join(slot, "launching.marker")
if os.path.exists(marker):
    os.rename(marker, os.path.join(slot, "launched.marker"))

# 5. SIGTERM trap -> killpg + write status=cancelled (so a killed job ALWAYS has a
#    terminal marker; else reconcile misreads "crash" — spec 2.5 / 7 cancel semantics)
def on_term(signum, frame):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        pass
    write_result("cancelled", signal_name="SIGTERM"); sys.exit(0)
signal.signal(signal.SIGTERM, on_term)

rc = proc.wait()
if log_max > 0:
    p = os.path.join(slot, "stdout.log")
    if os.path.getsize(p) > log_max:
        os.truncate(p, log_max)
write_result("done" if rc == 0 else "failed", exit_code=rc)
PYEOF
'''


def claim_and_launch(root, plan, job, attempt):
    sdir = slot_dir(root, job["seq"])
    os.makedirs(sdir, exist_ok=True)
    marker = os.path.join(sdir, "launching.marker")
    try:
        fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY)  # spec 2.4, lock.py:50
    except FileExistsError:
        return  # already claimed by a concurrent pass; do not double-fire
    os.write(fd, str(os.getpid()).encode()); os.close(fd)
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
    # detached session leader (setsid via start_new_session) so the job survives the brain
    wrapper = subprocess.Popen(["bash", "-c", WRAPPER_SH], env=child_env,
                     stdin=subprocess.DEVNULL,
                     stdout=open(os.path.join(sdir, "wrapper.log"), "ab", buffering=0),
                     stderr=subprocess.STDOUT, close_fds=True, start_new_session=True)
    # CP-3: record the WRAPPER (slot-supervisor-of-record) pid so reconcile/adopt resolve a live pid
    # for status/logs/cancel — NOT the dead-able progressor pid. The wrapper is the setsid session
    # leader; its pid == its process-group id (cancel = killpg on this pid).
    with open(os.path.join(sdir, "wrapper.pid"), "w") as wh:
        wh.write(f"{wrapper.pid}\n")


def reconcile_slots(root, plan):
    jobs_state = {}
    counts = empty_counts()
    statuses = {}
    for job in plan["jobs"]:
        verdict, _ = classify_seq(root, job)
        statuses[job["seq"]] = verdict
    free = plan["limits"]["slot_count"] - sum(1 for v in statuses.values() if v in ("running", "launching"))
    # launch ready pending seqs into free slots, ascending by seq (spec 2.4 seq is the key)
    for job in sorted(plan["jobs"], key=lambda j: j["seq"]):
        if free <= 0:
            break
        if statuses[job["seq"]] == "pending":
            claim_and_launch(root, plan, job, attempt=0)
            statuses[job["seq"]] = "launching"
            free -= 1
    # rebuild the job map + counts from disk after launching
    for job in plan["jobs"]:
        verdict, evidence = classify_seq(root, job)
        sdir = slot_dir(root, job["seq"])
        run = read_run_pid(sdir)
        entry = {"seq": job["seq"], "run_id": job["run_id"], "status": verdict,
                 "pid": (run or {}).get("pid"), "gpu_index": job["gpu_index"],
                 "log": os.path.join(sdir, "stdout.log")}
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
```

- [ ] **Step 4: Run — PASS**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: PASS(全部 6 测试:lease 拒绝、空-PLAN、launch+harvest+never-rerun、GPU 冲突、env 白名单拒绝、launch-marker 防双 fire)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/scheduler/node/progressor.py \
  mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs
git commit -m "feat(scheduler): progressor slot reconcile loop + O_EXCL launch-marker + per-job wrapper (GPU guard, env-allowlist, SIGTERM->cancelled)"
```

---

## Task 3:常驻循环 + 失败熔断 + idle 退避 + 崩溃注入矩阵

落 spec §2.4 常驻循环(`while has_running_or_launchable`)、§2.6 `failure_breaker`(连续失败熔断)、idle 定义/退避,以及 §7 崩溃注入矩阵(temp 写前/temp 与 rename 间/rename 后/dir-fsync 前崩 → 必须不重跑)。

**Files:**
- Modify: `mcp-server/src/ops/scheduler/node/progressor.py`
- Test: `mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`

- [ ] **Step 1: 追加失败测试(熔断 + 崩溃恢复 = 不重跑)**

追加:
```javascript
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
  for (let i = 0; i < 12; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
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
  for (let i = 0; i < 16; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
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
  for (let i = 0; i < 12; i++) runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
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

test("pid-reuse: run.pid second line (started_at) prevents adopting a reused pid", () => {
  // run.pid points at pid 1 (init, always alive) but with no terminal marker -> a naive
  // kill -0 would call it running. Our classify_seq still returns running for a live pid
  // WITHOUT a marker; the started_at line is what reconcile.ts pairs against the RunRecord.
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["true"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  fs.mkdirSync(path.join(dir, "slot_0"));
  fs.writeFileSync(path.join(dir, "slot_0", "run.pid"), "1\n2026-06-20T00:00:00Z\n");
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.jobs["0"].status, "running"); // live pid, no marker => adopted, not re-fired
});
```

- [ ] **Step 2: Run — FAIL**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: FAIL(熔断未实现 → `breaker_tripped` 恒 false;无熔断的 break 逻辑会让循环不终止/状态不对)。

- [ ] **Step 3: 实现熔断 + 常驻循环 + idle**

在 `progressor.py` 的 `reconcile_once` 之后、`main` 之前加,并改 `build_state` 接受 `breaker`/`degraded`:
```python
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
```
改 `reconcile_once` 把熔断算进 STATE,并让 `main` 用常驻循环:
```python
def reconcile_once(root):
    plan = load_plan(root)
    enforce_lease(root, plan)
    jobs, counts = reconcile_slots(root, plan)
    tripped = consecutive_failure_breaker(root, plan)
    state = build_state(plan, jobs, counts)
    state["health"]["breaker_tripped"] = tripped
    write_atomic_durable(os.path.join(root, "state.json"), state)
    return plan, state, tripped
```
改 `main` 的非 `--once` 分支为常驻循环:
```python
def main(argv):
    root = state_dir()
    if "--once" in argv:
        reconcile_once(root)
        return 0
    while True:
        plan, _state, tripped = reconcile_once(root)
        if tripped:
            break
        if genuinely_idle(root, plan):
            break
        # active ~2s; back off when no pending (spec 2.4 backoff_poll_interval)
        time.sleep(max(1, plan["policy"].get("restart_throttle_seconds", 2)))
    return 0
```
> 注:`build_state` 已在 Task 1 写 `health.breaker_tripped: False`;`reconcile_once` 在写盘前覆盖为真值。

- [ ] **Step 4: Run — PASS**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: PASS(全部 11 测试;熔断 trip / require_one_success disarm（C-4 两个 pin）/ 崩溃恢复不重跑 / PID 复用 adopt-not-refire 均绿)。

- [ ] **Step 5: 全套件回归 + golden 快照 + python 语法**

新建 `mcp-server/tests/ops/scheduler/progressor-snapshot.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "..", "..", "src", "ops", "scheduler", "node", "progressor.py");
const GOLDEN = path.join(here, "..", "..", "fixtures", "remote-python", "PROGRESSOR_PY.py");

test("progressor.py parses under python3 (no syntax errors, mirrors remote-python golden discipline)", () => {
  const r = spawnSync("python3", ["-c", `import ast,sys; ast.parse(open(${JSON.stringify(SRC)}).read())`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("progressor.py matches its committed golden byte-for-byte (regenerate deliberately on change)", () => {
  const live = fs.readFileSync(SRC, "utf8");
  if (!fs.existsSync(GOLDEN)) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, live);
  }
  assert.equal(live, fs.readFileSync(GOLDEN, "utf8"),
    "progressor.py changed — review the diff, then `cp src/.../progressor.py tests/fixtures/remote-python/PROGRESSOR_PY.py`");
});
```
Run:
```bash
node --test mcp-server/tests/ops/scheduler/progressor-snapshot.test.mjs   # 首跑写入 golden
npm run build && npm test 2>&1 | tail -4
```
Expected: snapshot 测试绿(首跑落 golden);`npm test` 仍绿(478 + 新增,无回归)。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/scheduler/node/progressor.py \
  mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs \
  mcp-server/tests/ops/scheduler/progressor-snapshot.test.mjs \
  mcp-server/tests/fixtures/remote-python/PROGRESSOR_PY.py
git commit -m "feat(scheduler): progressor resident loop + failure breaker + idle backoff + crash-injection/pid-reuse harness + golden snapshot"
```

---

## Task 4:`seam/launch.ts` —— 原子写 PLAN + 起推进器 + 持久化 RunRecord + 单次快路径

落 spec §3.3/§3.4 `seam/launch`、§6 D1 单次快路径。消费 Phase B 的 `protocol.ts`(校验 PLAN)、`sshWriteAtomicJson`、扩展 RunRecord;消费 Phase A 的 `node_scheduler.runner` 路由。

**Files:**
- Create: `mcp-server/src/ops/scheduler/node/progressor-source.ts`
- Create: `mcp-server/src/ops/scheduler/seam/launch.ts`
- Test: `mcp-server/tests/ops/scheduler/launch.test.mjs`

- [ ] **Step 0: 确认 Phase B 接口存在**

Run:
```bash
grep -q "sshWriteAtomicJson" mcp-server/src/lib/ssh.ts \
  && grep -rq "assertIhpcPlan" mcp-server/src/ops/scheduler/seam/protocol.ts \
  && grep -rq "assertIhpcState" mcp-server/src/ops/scheduler/seam/protocol.ts \
  && grep -q "auto_progressed\|queue_position" mcp-server/src/core/types.ts \
  && echo "B-OK" || echo "B-MISSING"
```
Expected: `B-OK`。**导出名是跨阶段 canonical 契约(见 spec SHARED INTERFACES + Phase B Task 5):PLAN 校验函数是 `assertIhpcPlan`、STATE 校验函数是 `assertIhpcState`(与 `isIhpcPlanShape` 命名一致),语义为「Ajv 校验对象,不合法抛错」。本 Task 的 import 必须用这两个名字,不得用 `assertIhpcPlan`/`assertIhpcState`。**

- [ ] **Step 1: 写失败测试(mock executor:断言写 PLAN、起推进器、RunRecord 字段;快路径分流)**

`mcp-server/tests/ops/scheduler/launch.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { launchIhpcCampaign } from "../../../dist/ops/scheduler/seam/launch.js";

function basePlan(jobs) {
  return {
    schema_version: "1.0.0", schema_compat_min: "1.0.0",
    campaign_id: "campaign_x", queue_id: "sha256:abc",
    lease_owner: { client: "claude", device_id: "dev-1", issued_at: "2026-06-20T00:00:00Z" },
    node_id: "mars01", profile_id: "p1",
    limits: { slot_count: 2, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/home/u/proj"], env_key_allowlist: ["UTS_RUN_ID"] },
    policy: { on_job_failure: "continue",
      failure_breaker: { max_consecutive_failures: 5, require_one_success: true },
      idle_definition: "no_running_and_no_launchable_pending",
      idle_exit_seconds: 604800, restart_throttle_seconds: 2 },
    jobs
  };
}

test("launchIhpcCampaign writes PLAN atomically then starts the progressor once", async () => {
  const calls = [];
  const writes = [];
  const result = await launchIhpcCampaign(
    {
      plan: basePlan([
        { seq: 0, run_id: "run_0", command_argv: ["python3", "t.py"], workdir: "/home/u/proj",
          env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 0, gpu_count: 1, timeout_seconds: 60 },
        { seq: 1, run_id: "run_1", command_argv: ["python3", "t.py"], workdir: "/home/u/proj",
          env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 1, gpu_count: 1, timeout_seconds: 60 }
      ]),
      profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" },
        defaults: {}, node_scheduler: { runner: "console" } }
    },
    {
      now: new Date("2026-06-20T00:00:00Z"),
      sshWriteAtomicJson: async (host, node, remotePath, obj) => { writes.push({ host, node, remotePath, obj }); },
      startProgressor: async (host, node, stdin) => { calls.push({ host, node, stdin }); return { pid: 4242 }; },
      auditDir: undefined,
      persistRunRecord: (rec) => calls.push({ persisted: rec.run_id, rec })
    }
  );
  // wrote exactly one plan.json under the campaign state dir (never /tmp)
  assert.equal(writes.length, 1);
  assert.match(writes[0].remotePath, /\.uts-computing\/scheduler\/state\/campaign_x\/plan\.json$/);
  assert.doesNotMatch(writes[0].remotePath, /^\/tmp/);
  // started the progressor exactly once for the node
  assert.equal(calls.filter((c) => c.stdin).length, 1);
  assert.match(calls.find((c) => c.stdin).stdin, /reconcile_slots|def main/);
  // persisted supervisor.pid + placement.gpu_index + queue_position + lease_owner on each RunRecord
  const persisted = calls.filter((c) => c.persisted);
  assert.equal(persisted.length, 2);
  const r0 = persisted.find((c) => c.persisted === "run_0").rec;
  assert.equal(r0.supervisor.pid, 4242);
  // C-6: campaign supervisor paths are slot-dir path-based, NOT empty strings
  assert.match(r0.supervisor.metadata_path, /scheduler\/state\/campaign_x\/slot_0\/result\.json$/);
  assert.match(r0.supervisor.stdout_path, /scheduler\/state\/campaign_x\/slot_0\/stdout\.log$/);
  assert.equal(r0.placement.gpu_index, 0);
  assert.equal(r0.placement.gpu_slot, 0); // CP-3: gpu_slot threaded onto placement, not dead
  assert.equal(r0.queue_position, 0);
  assert.deepEqual(r0.lease_owner, { client: "claude", device_id: "dev-1", issued_at: "2026-06-20T00:00:00Z" });
  assert.equal(result.progressor.pid, 4242);
});

test("single-run fast path: jobs==1 + no campaign routes to direct supervisor, NOT the progressor", async () => {
  let progressorStarted = false;
  let fastPathUsed = false;
  await launchIhpcCampaign(
    {
      plan: { ...basePlan([{ seq: 0, run_id: "run_only", command_argv: ["python3", "t.py"],
        workdir: "/home/u/proj", env: {}, gpu_index: 0, gpu_count: 1, timeout_seconds: 60 }]),
        campaign_id: null, limits: { slot_count: 1, max_slots_per_gpu: 1, log_max_bytes: 1 } },
      profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" },
        defaults: {}, node_scheduler: { runner: "console" } }
    },
    {
      now: new Date("2026-06-20T00:00:00Z"),
      sshWriteAtomicJson: async () => {},
      startProgressor: async () => { progressorStarted = true; return { pid: 1 }; },
      startSingleSupervisor: async () => { fastPathUsed = true; return { pid: 7, node_id: "mars01" }; },
      persistRunRecord: () => {}
    }
  );
  assert.equal(fastPathUsed, true, "single non-campaign run must use the SUPERVISOR_PY fast path (spec 6 D1)");
  assert.equal(progressorStarted, false, "must NOT start the resident progressor for a single run");
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build`(应失败:模块不存在)→ FAIL。

- [ ] **Step 3: 实现 `progressor-source.ts`**

`mcp-server/src/ops/scheduler/node/progressor-source.ts`:
```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The progressor is shipped over SSH stdin exactly like SUPERVISOR_PY (spec 2.8). We read the
// committed .py source once at import time so the wire bytes equal the file the golden snapshot
// pins (tests/fixtures/remote-python/PROGRESSOR_PY.py).
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROGRESSOR_PY: string = fs.readFileSync(path.join(here, "progressor.py"), "utf8");
```
> **C-5:`progressor.py` 必须随 `dist/` 复制,且复制是「真正的、被测的、顺序正确的」build 步骤。** `npm run build` 当前是纯 `tsc -p mcp-server/tsconfig.json`(实测 `package.json:7`,`rootDir:src` / `outDir:dist`),`tsc` **不**复制非 `.ts` 资产,**且每次 `tsc` 不会清空 `dist`**(无 `--clean`),但「先 cp 再 tsc」会因 tsc 写同目录而风险竞态;故用 **`postbuild`(tsc 之后)** 跑一个专门的 copy 脚本,顺序明确(copy 永远在 tsc 之后)。
>
> 1. 新建 `scripts/copy-progressor.mjs`(node,stdlib only):`mkdir -p mcp-server/dist/ops/scheduler/node` → `fs.copyFileSync(src, dist)`。
> ```javascript
> import fs from "node:fs";
> import path from "node:path";
> const src = "mcp-server/src/ops/scheduler/node/progressor.py";
> const dst = "mcp-server/dist/ops/scheduler/node/progressor.py";
> fs.mkdirSync(path.dirname(dst), { recursive: true });
> fs.copyFileSync(src, dst);
> ```
> 2. `package.json` 加 `"postbuild": "node scripts/copy-progressor.mjs"`(npm 在 `build` 后自动跑 `postbuild`,保证「tsc → copy」顺序;`mcp:start`/`test` 等所有走 `npm run build` 的入口都覆盖)。
> 3. **加一个测试断言 `dist` 与 `src` 字节一致**(防 copy 被跳过 / build 缓存陈旧导致 golden 与上线字节分叉)。在 `progressor-snapshot.test.mjs`(Task 3 Step 5 建)追加:
> ```javascript
> import { execSync } from "node:child_process";
> test("dist progressor.py equals src byte-for-byte (postbuild copy ran)", () => {
>   const DIST = path.join(here, "..", "..", "..", "dist", "ops", "scheduler", "node", "progressor.py");
>   if (!fs.existsSync(DIST)) execSync("npm run build", { stdio: "ignore" });
>   assert.equal(fs.readFileSync(DIST, "utf8"), fs.readFileSync(SRC, "utf8"),
>     "dist/progressor.py diverged from src — postbuild copy did not run; check scripts/copy-progressor.mjs + package.json postbuild");
> });
> ```
> 这样 `progressor-source.ts`(读 `dist/.../progressor.py`,Task 4 Step 3 实现)、golden 快照(读 `src`,Task 3)、上线字节(`dist`)三者由测试钉死一致。

- [ ] **Step 4: 实现 `seam/launch.ts`**

`mcp-server/src/ops/scheduler/seam/launch.ts`:
```typescript
import { PROGRESSOR_PY } from "../node/progressor-source.js";
import { assertIhpcPlan } from "./protocol.js"; // Phase B canonical export: Ajv-validate the PLAN, throw if invalid
import type { ComputeProfile, RunRecord } from "../../../core/types.js";

// PLAN/STATE live under the profile-root scheduler dir, NEVER /tmp (spec 2.2). The remote home is
// resolved by the node ($HOME); we ship the relative tail and let the node expand it.
function planRemotePath(campaignId: string): string {
  return `~/.uts-computing/scheduler/state/${campaignId}/plan.json`;
}

// CP-5: the canonical PLAN type (Phase B core/types.ts `IhpcPlan`) requires a non-null campaign_id
// (the schema requires it). The single-run fast path is NOT a PLAN — it is keyed on the ABSENCE of a
// campaign. So we model the launch input as a discriminated union: a `campaign_id: string` PLAN that
// IS the canonical IhpcPlan, OR a `campaign_id: null` SingleRunSpec that never pretends to be one and
// is never fed to assertIhpcPlan (which would reject campaign_id:null). This keeps the campaign path
// type-checked against the real PLAN type and prevents field drift at compile time.
import type { IhpcPlan } from "../../../core/types.js"; // Phase B: canonical PLAN type (campaign_id: string)

export type PlanObject = IhpcPlan | SingleRunSpec;

// SingleRunSpec mirrors IhpcPlan's shape but pins campaign_id to null (the fast-path discriminant).
export interface SingleRunSpec extends Omit<IhpcPlan, "campaign_id"> {
  campaign_id: null;
}

export interface LaunchDeps {
  now: Date;
  sshWriteAtomicJson: (host: string, node: string, remotePath: string, obj: unknown) => Promise<void>;
  startProgressor: (host: string, node: string, stdin: string) => Promise<{ pid: number }>;
  startSingleSupervisor?: (host: string, node: string, job: PlanObject["jobs"][number]) => Promise<{ pid: number; node_id: string }>;
  persistRunRecord: (rec: RunRecord) => void;
  auditDir?: string;
}

export interface LaunchInput {
  plan: PlanObject;
  profile: ComputeProfile & { node_scheduler?: { runner: "console" | "uv" | "cron_reboot"; dir?: string } };
}

export interface LaunchResult {
  mode: "campaign" | "single";
  campaign_id: string | null;
  progressor: { pid: number | null };
}

// spec 6 D1: keep the single-run FAST PATH. jobs==1 AND no campaign -> direct SUPERVISOR_PY, no PLAN,
// no resident progressor. This keeps the most-common path off the whole new mechanism. The discriminant
// is `campaign_id === null` (the SingleRunSpec branch of the union); this also type-narrows `plan`.
function isSingleRunFastPath(plan: PlanObject): plan is SingleRunSpec {
  return plan.campaign_id === null && plan.jobs.length === 1;
}

export async function launchIhpcCampaign(input: LaunchInput, deps: LaunchDeps): Promise<LaunchResult> {
  const { plan, profile } = input;
  const host = profile.login.host_alias;
  const node = plan.node_id;

  if (isSingleRunFastPath(plan) && deps.startSingleSupervisor) {
    const started = await deps.startSingleSupervisor(host, node, plan.jobs[0]);
    const job = plan.jobs[0];
    deps.persistRunRecord(buildRunRecord(plan, job, started.pid, started.node_id, deps.now, 0));
    return { mode: "single", campaign_id: null, progressor: { pid: null } };
  }

  // Campaign path: campaign_id is non-null here (the fast path consumed the null case). Validate the
  // canonical PLAN (spec 2.2) — assertIhpcPlan is the Phase B Ajv gate and would REJECT a campaign_id:null
  // plan, which is why the fast path is split off ABOVE this line. Then atomically write the immutable
  // PLAN, start the progressor once for the node (spec 3.3), persist placement/supervisor/lease per run.
  if (plan.campaign_id === null) {
    // a null-campaign PLAN with !=1 jobs is a programming error: a campaign MUST have a campaign_id.
    throw new Error("launchIhpcCampaign: multi-job launch requires a non-null campaign_id");
  }
  const campaignPlan: IhpcPlan = plan; // narrowed: campaign_id is string
  assertIhpcPlan(campaignPlan);
  await deps.sshWriteAtomicJson(host, node, planRemotePath(campaignPlan.campaign_id), campaignPlan);
  const started = await deps.startProgressor(host, node, PROGRESSOR_PY);
  campaignPlan.jobs.forEach((job, idx) => {
    deps.persistRunRecord(buildRunRecord(campaignPlan, job, started.pid, node, deps.now, idx));
  });
  return { mode: "campaign", campaign_id: campaignPlan.campaign_id, progressor: { pid: started.pid } };
}

// C-6: campaign-job supervisor paths are PATH-BASED (the slot dir), not empty strings. requireIhpcSupervisor
// + the run-record schema expect populated metadata/stdout/stderr; for a campaign run the "supervisor of
// record" is the slot directory under the campaign state dir (the per-slot wrapper, NOT the dead-able
// progressor pid — see CP-3). We mirror D Task 2's `resolveSlotSupervisorPaths` so launch.ts and reconcile/
// adopt agree on where a campaign run's logs live.
export function resolveSlotSupervisorPaths(campaignId: string, seq: number): {
  metadata_path: string; stdout_path: string;
} {
  const slotDir = `~/.uts-computing/scheduler/state/${campaignId}/slot_${seq}`;
  return { metadata_path: `${slotDir}/result.json`, stdout_path: `${slotDir}/stdout.log` };
}

function buildRunRecord(
  plan: PlanObject, job: PlanObject["jobs"][number], progressorPid: number,
  nodeId: string, now: Date, queuePosition: number
): RunRecord {
  // CP-3: gpu_slot is the brain's pre-accounting slot; thread it onto placement.gpu_slot (Phase B added
  // the field) so it is not dead. The per-slot wrapper pid is NOT known at launch (the progressor forks it
  // later and records it in STATE jobs[<seq>].wrapper_pid); the supervisor block here references the slot
  // dir path-based, and reconcile/adopt resolve the live wrapper_pid from STATE when needed.
  const slotPaths = plan.campaign_id
    ? resolveSlotSupervisorPaths(plan.campaign_id, job.seq)
    : { metadata_path: "", stdout_path: "" }; // single-run fast path keeps SUPERVISOR_PY's own paths (set by startSingleSupervisor's caller)
  return {
    run_id: job.run_id,
    profile_id: plan.profile_id,
    platform: "uts-ihpc",
    remote_job_id: `ihpc-${job.run_id}-${progressorPid}`,
    campaign_id: plan.campaign_id ?? undefined,
    status: "running",
    queue_position: queuePosition,
    lease_owner: plan.lease_owner,
    supervisor: { pid: progressorPid, node_id: nodeId, metadata_path: slotPaths.metadata_path, stdout_path: slotPaths.stdout_path, stderr_path: slotPaths.stdout_path, started_at: now.toISOString() },
    placement: { hostname: nodeId, node_id: nodeId, gpu_index: job.gpu_index, gpu_slot: job.gpu_index, slots_per_gpu: plan.limits.max_slots_per_gpu, started_at: now.toISOString() },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    events: [{ at: now.toISOString(), kind: "ihpc-progressor-launch", summary: `Queued run ${job.run_id} (seq ${job.seq}) under campaign ${plan.campaign_id}` }]
  } as RunRecord;
}
```
> 注:`queue_position`/`lease_owner` 是 Phase B 扩的 RunRecord 字段;`supervisor`/`placement` 是既有块(`core/types.ts:237,248`)。**CP-3「supervisor of record」定义(跨 B/C/D 一致):** 一个 campaign job 的 supervisor 是**路径化(slot 目录)**而非 pid 化的——`supervisor.metadata_path`/`stdout_path` 指向 `~/.uts-computing/scheduler/state/<campaign>/slot_<seq>/{result.json,stdout.log}`;`supervisor.pid` 字段写**推进器 pid**仅作 lineage 标记,但 status/logs/cancel 解析靠 slot 路径 + STATE 里的 `jobs[<seq>].wrapper_pid`(Phase B 在 STATE schema 加、Phase C 推进器写、Phase D adopt 读),**绝不**用可能已死的推进器 pid 去 `requireIhpcSupervisor`。**CP-3「gpu_slot 写路径」:** `placement.gpu_slot`(Phase B 加的字段)在此由 `job.gpu_index` 落写(单 GPU 单 slot 时 slot==index;多 slot/GPU 时 Phase B `reserveSlots` 的 `gpu_slot` 经 `planNextBatch` 进 PLAN job 再到此),使该字段不再 dead(B-2)。生产里 `persistRunRecord`/`sshWriteAtomicJson`/`startProgressor` 由 `index.ts` wiring 注入真实实现(`updateRunRecord`、`lib/ssh.ts` 的 `sshWriteAtomicJson`、`setsid nohup python3 -` over SSH);此处 deps 化以保 spec §8「seam 是内部、不增工具面」并可单测。

- [ ] **Step 5: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/launch.test.mjs`
Expected: PASS(两测试:campaign 写一次 PLAN+起一次推进器+持久化字段;单次走 fast path 不起推进器)。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/scheduler/node/progressor-source.ts \
  mcp-server/src/ops/scheduler/seam/launch.ts \
  mcp-server/tests/ops/scheduler/launch.test.mjs \
  scripts/copy-progressor.mjs package.json
git commit -m "feat(scheduler): seam/launch — atomic PLAN write + start progressor once + persist RunRecord; single-run fast path (D1); postbuild copies progressor.py into dist"
```

---

## Task 5:`seam/reconcile.ts` —— 一次读 STATE + 同步 RunRecords + 死推进器路径

落 spec §3.3/§3.4 `seam/reconcile`、§2.3「一次 `cat` 读一个 state.json,绝不 tail」、§2.6/§5c 死推进器-但活作业、时钟偏移规则(§2.3:`*_at_node` 是不透明标签,绝不笔记本 now 减节点时间戳)。

**Files:**
- Create: `mcp-server/src/ops/scheduler/seam/status.ts`(CP-4 单一状态映射器,C+D 共用)
- Create: `mcp-server/src/ops/scheduler/seam/reconcile.ts`
- Test: `mcp-server/tests/ops/scheduler/reconcile.test.mjs`

- [ ] **Step 1: 写失败测试(STATE→RunRecord 映射、坏 STATE Ajv 拒绝、死推进器-活作业、时钟偏移)**

`mcp-server/tests/ops/scheduler/reconcile.test.mjs`:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { reconcileIhpcCampaign } from "../../../dist/ops/scheduler/seam/reconcile.js";

function stateWith(jobs, progressor = { pid: 5000, started_at_node: "x", heartbeat_node: "2026-06-20T14:45:30Z" }) {
  return {
    schema_version: "1.0.0", campaign_id: "campaign_x", queue_id: "sha256:abc",
    lease_owner: { client: "claude", device_id: "dev-1" },
    observed_at_node: "2026-06-20T14:45:30Z", node_clock_epoch: 1781966730, slot_count: 2,
    progressor, health: { degraded: null, breaker_tripped: false },
    jobs, counts: { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  };
}

// CP-2: the canonical reconcile seam takes { campaignId, profileId, profile, node, runRecords } and deps
// { readState, persistRunRecord, relaunchProgressor, progressorAlive?, adoptLiveJob?, auditDir? }. These
// names are shared verbatim with Phase D Task 5 (D only WIRES this signature, never reshapes it).
test("reconcileIhpcCampaign maps STATE job statuses onto RunRecords (one SSH read)", async () => {
  let reads = 0;
  const persisted = [];
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [
        { run_id: "run_0", status: "running" }, { run_id: "run_1", status: "running" }
      ] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      readState: async () => { reads += 1; return stateWith({
        "0": { seq: 0, run_id: "run_0", status: "done", pid: 1, gpu_index: 0, exit_code: 0, started_at_node: "a", finished_at_node: "b", log: "/l/0" },
        "1": { seq: 1, run_id: "run_1", status: "running", pid: 2, gpu_index: 1, started_at_node: "a", log: "/l/1" }
      }); },
      persistRunRecord: (rec) => persisted.push(rec),
      relaunchProgressor: async () => ({ pid: 9999 })
    }
  );
  assert.equal(reads, 1, "must read state.json exactly once (never tail)");
  const r0 = persisted.find((r) => r.run_id === "run_0");
  const r1 = persisted.find((r) => r.run_id === "run_1");
  assert.equal(r0.status, "finished");  // STATE done -> RunRecord finished
  assert.equal(r1.status, "running");
});

test("reconcile maps placement_conflict/failed/cancelled and does NOT do laptop-vs-node clock math", async () => {
  const persisted = [];
  const out = await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_c", status: "running" }] },
    { now: new Date("1999-01-01T00:00:00Z"), // laptop clock far in the past — must be ignored
      readState: async () => stateWith({
        "0": { seq: 0, run_id: "run_c", status: "placement_conflict", pid: null, gpu_index: 0, started_at_node: "z", log: "/l" }
      }),
      persistRunRecord: (rec) => persisted.push(rec),
      relaunchProgressor: async () => ({ pid: 1 }) });
  assert.equal(persisted[0].status, "unknown"); // placement_conflict surfaces as needs-reconciliation
  assert.ok(out.needs_reconciliation.some((n) => n.run_id === "run_c"));
});

test("dead progressor but live jobs: reconcile adopts live jobs then relaunches the progressor (spec 5c)", async () => {
  let restarted = false;
  const adopted = [];
  const persisted = [];
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_0", status: "running" }] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      // progressor.pid reported dead by the node-side liveness probe (deps.progressorAlive=false)
      readState: async () => stateWith(
        { "0": { seq: 0, run_id: "run_0", status: "running", pid: 12345, wrapper_pid: 12300, gpu_index: 0, started_at_node: "a", log: "/l" } },
        { pid: 5000, started_at_node: "x", heartbeat_node: "2026-06-19T00:00:00Z" }),
      progressorAlive: async () => false,
      // CP-3/D-3: when an adopt hook is supplied, each live STATE job is adopted (lineage-proven) before
      // relaunch. C's standalone test exercises the hook with a stub; D supplies the real ihpcStateJobToRunRecord.
      adoptLiveJob: (job) => { adopted.push(job.run_id); return { run_id: job.run_id, status: "running" }; },
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; },
      persistRunRecord: (rec) => persisted.push(rec)
    }
  );
  assert.equal(restarted, true, "dead progressor + live jobs must relaunch the progressor to resume refill");
  assert.deepEqual(adopted, ["run_0"], "each live STATE job must be adopted (lineage-proven) before relaunch");
  assert.ok(persisted.some((r) => r.run_id === "run_0"), "the adopted RunRecord must be persisted");
});

test("dead progressor with NO adopt hook: relaunch-only (C standalone behavior, spec 5c)", async () => {
  let restarted = false;
  await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
      node: "mars01", runRecords: [{ run_id: "run_0", status: "running" }] },
    {
      now: new Date("2026-06-20T15:00:00Z"),
      readState: async () => stateWith(
        { "0": { seq: 0, run_id: "run_0", status: "running", pid: 12345, gpu_index: 0, started_at_node: "a", log: "/l" } },
        { pid: 5000, started_at_node: "x", heartbeat_node: "2026-06-19T00:00:00Z" }),
      progressorAlive: async () => false,
      relaunchProgressor: async () => { restarted = true; return { pid: 9999 }; },
      persistRunRecord: () => {}
    }
  );
  assert.equal(restarted, true, "without an adopt hook, the dead-progressor branch still relaunches");
});

test("reconcile rejects a STATE that fails the protocol schema", async () => {
  await assert.rejects(
    () => reconcileIhpcCampaign(
      { campaignId: "campaign_x", profileId: "p1", profile: { profile_id: "p1", platform: "uts-ihpc", login: { host_alias: "ihpc" } },
        node: "mars01", runRecords: [] },
      { now: new Date(), readState: async () => ({ schema_version: "1.0.0", jobs: "not-an-object" }),
        persistRunRecord: () => {}, relaunchProgressor: async () => ({ pid: 1 }) }),
    /schema|invalid|state/i
  );
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build` → FAIL(`reconcile.js` 不存在)。

- [ ] **Step 3: 实现 `seam/reconcile.ts`**

先建 **CP-4 单一状态映射器** `mcp-server/src/ops/scheduler/seam/status.ts`(node STATE status → RunRecord.status 只此一份,C `reconcile.ts` 与 D `adopt.ts` 都 import,绝不各抄一份):
```typescript
import type { RunRecord } from "../../../core/types.js";

// CP-4: the ONE node-STATE-status -> RunRecord.status table. spec 2.3 vocab is the single source.
// Both seam/reconcile.ts AND ops/jobs/adopt.ts (Phase D) import this — no hand-maintained copies.
// RunRecord["status"] union verified against core/types.ts:260:
//   planned|submitting|submitted|running|finished|failed|cancelled|unknown
const NODE_STATUS_MAP: Record<string, RunRecord["status"]> = {
  pending: "submitted",
  launching: "running",
  running: "running",
  done: "finished",
  failed: "failed",
  cancelled: "cancelled",
  placement_conflict: "unknown" // brain re-places on reconnect (spec 2.5) -> needs reconciliation
};

export function nodeStatusToRunStatus(nodeStatus: string): RunRecord["status"] {
  return NODE_STATUS_MAP[nodeStatus] ?? "unknown";
}
```

`mcp-server/src/ops/scheduler/seam/reconcile.ts`:
```typescript
import { assertIhpcState } from "./protocol.js"; // Phase B canonical export: Ajv-validate STATE, throw if invalid
import { nodeStatusToRunStatus } from "./status.js"; // CP-4: shared status map (also used by D's adopt.ts)
import type { ComputeProfile, RunRecord } from "../../../core/types.js";

// CP-2: the canonical reconcile seam signature, shared verbatim with Phase D's consumer (D Task 5).
// Param names are pinned here so D only WIRES, never reshapes: profileId + node + relaunchProgressor +
// progressorAlive (uniform with D), plus auditDir + an injectable adopt hook (adoptLiveJob) so the
// dead-progressor-but-live-jobs branch can synthesize lineage-proven RunRecords (spec 5c) — D supplies
// the real adopt hook; C's own test supplies a stub.
export interface ReconcileInput {
  campaignId: string;
  profileId: string;
  profile: ComputeProfile;
  node: string;
  runRecords: Array<Partial<RunRecord> & { run_id: string; status: RunRecord["status"] }>;
}

// One STATE job entry as the node writes it (spec 2.3). wrapper_pid is the slot-supervisor-of-record
// pid (CP-3); pid is the inner job pid.
export interface NodeStateJob {
  seq: number; run_id: string; status: string; pid: number | null; wrapper_pid?: number;
  gpu_index: number; exit_code?: number; started_at_node: string; finished_at_node?: string; log: string;
}

export interface ReconcileDeps {
  now: Date;
  // ONE read of state.json, whole-file, atomic-rename-safe; NEVER tail (spec 2.3).
  readState: (host: string, node: string, campaignId: string) => Promise<unknown>;
  persistRunRecord: (rec: Partial<RunRecord> & { run_id: string }) => void;
  // dead-progressor-but-live-jobs (spec 5c): relaunch the progressor with the same plan.
  relaunchProgressor: (host: string, node: string, campaignId: string) => Promise<{ pid: number }>;
  // optional liveness probe for progressor.pid (kill -0 on the node); if absent, trust STATE heartbeat.
  progressorAlive?: (host: string, node: string, pid: number) => Promise<boolean>;
  // CP-3/D-3: optional adopt hook. When the dead-progressor branch fires, each live STATE job is
  // adopted as a lineage-proven RunRecord (D supplies ihpcStateJobToRunRecord-backed hook + auditDir;
  // C's branch then persists it). Absent => relaunch-only (C's standalone behavior).
  adoptLiveJob?: (job: NodeStateJob, ctx: { campaignId: string; node: string; now: Date }) => Partial<RunRecord> & { run_id: string };
  auditDir?: string;
}

export interface ReconcileResult {
  observed_at: string;
  campaign_id: string;
  transitions: Array<{ run_id: string; status: RunRecord["status"] }>;
  needs_reconciliation: Array<{ run_id: string; message: string }>;
  progressor_restarted: boolean;
}

export async function reconcileIhpcCampaign(input: ReconcileInput, deps: ReconcileDeps): Promise<ReconcileResult> {
  const host = input.profile.login.host_alias;
  const raw = await deps.readState(host, input.node, input.campaignId);
  assertIhpcState(raw); // throws on a malformed STATE (spec 3.4)
  const state = raw as {
    progressor: { pid: number; heartbeat_node: string };
    jobs: Record<string, NodeStateJob>;
  };

  const transitions: ReconcileResult["transitions"] = [];
  const needs: ReconcileResult["needs_reconciliation"] = [];
  const byRunId = new Map(Object.values(state.jobs).map((j) => [j.run_id, j]));

  for (const record of input.runRecords) {
    const observed = byRunId.get(record.run_id);
    if (!observed) {
      needs.push({ run_id: record.run_id, message: "run not present in node STATE" });
      continue;
    }
    const mapped = nodeStatusToRunStatus(observed.status); // CP-4: shared mapper
    if (observed.status === "placement_conflict") {
      needs.push({ run_id: record.run_id, message: "placement_conflict — brain must re-place" });
    }
    // Clock-offset rule (spec 2.3): we treat *_at_node timestamps as opaque labels; we do NOT
    // compute laptop-now minus a node timestamp. We persist node-stamped fields verbatim.
    deps.persistRunRecord({ ...record, status: mapped, updated_at: deps.now.toISOString() });
    transitions.push({ run_id: record.run_id, status: mapped });
  }

  // dead-progressor-but-live-jobs (spec 2.6 / 5c): if the progressor pid is dead but jobs are still
  // running, relaunch the SAME progressor to resume refill (markers + lease prove lineage). If an
  // adopt hook is supplied (D Task 5), each live STATE job is ALSO adopted as a lineage-proven
  // RunRecord before relaunch (CP-3/D-3) — this is the branch D wires, not reshapes.
  let restarted = false;
  const liveJobs = Object.values(state.jobs).some((j) => j.status === "running" || j.status === "launching");
  if (liveJobs && deps.progressorAlive) {
    const alive = await deps.progressorAlive(host, input.node, state.progressor.pid);
    if (!alive) {
      if (deps.adoptLiveJob) {
        for (const job of Object.values(state.jobs)) {
          if (job.status === "running" || job.status === "launching") {
            deps.persistRunRecord(deps.adoptLiveJob(job, { campaignId: input.campaignId, node: input.node, now: deps.now }));
          }
        }
      }
      await deps.relaunchProgressor(host, input.node, input.campaignId);
      restarted = true;
    }
  }

  return {
    observed_at: deps.now.toISOString(),
    campaign_id: input.campaignId,
    transitions,
    needs_reconciliation: needs,
    progressor_restarted: restarted
  };
}
```

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/reconcile.test.mjs`
Expected: PASS(五测试:STATE→RunRecord 映射一次读、placement_conflict→needs + 无跨钟相减、死推进器 adopt+重起、死推进器无 adopt-hook relaunch-only、坏 STATE Ajv 拒绝)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/scheduler/seam/status.ts \
  mcp-server/src/ops/scheduler/seam/reconcile.ts \
  mcp-server/tests/ops/scheduler/reconcile.test.mjs
git commit -m "feat(scheduler): seam/reconcile — one-read STATE sync to RunRecords + dead-progressor adopt+relaunch (5c); shared nodeStatusToRunStatus mapper (CP-4); node-clock-opaque"
```

---

## Task 6:接 `jobs.track` → `reconcileIhpcCampaign`(campaign 走 seam,单次保留 per-pid)

落 spec §3.3「jobs_track / 重连 → 一次读 state.json → 对账」、§6 C。带 `campaign_id` 的 iHPC run 走 `reconcileIhpcCampaign`;无 campaign 的单次 iHPC run 仍走既有 `reconcileIhpcRunStatus`(per-pid `IHPC_STATUS_PY`,快路径行为不变)。

**Files:**
- Modify: `mcp-server/src/ops/jobs/jobs.ts`
- Test: `mcp-server/tests/ops/scheduler/reconcile.test.mjs`(追加 jobs.ts 分流断言)或既有 `mcp-server/tests/ops/jobs/*track*`

- [ ] **Step 0: 确认本 Task 复用的既有 helper 在 `jobs.ts` 可达(C-7)**

Run:
```bash
for sym in encodeSpec parseSingleJsonLine redactedIhpcCommand requireIhpcSupervisor sshSupervisorArgs updateRunRecord; do
  grep -q "\b$sym\b" mcp-server/src/ops/jobs/jobs.ts && echo "$sym OK" || echo "$sym MISSING — import it in jobs.ts before Step 3"
done
grep -q "PLATFORM" mcp-server/src/ops/jobs/jobs.ts && echo "PLATFORM OK" || echo "PLATFORM MISSING"
```
Expected: 全部 `OK`。`reconcileIhpcCampaignRunStatus` 引用 `encodeSpec`/`parseSingleJsonLine`/`redactedIhpcCommand`/`requireIhpcSupervisor`/`sshSupervisorArgs`/`updateRunRecord`/`PLATFORM.IHPC`——任一 `MISSING` 则在 Step 3 先补 import,否则实现步会撞 undefined 引用。

- [ ] **Step 1: 写失败测试(dispatch:campaign run 调 reconcileIhpcCampaign,单次 run 不调)**

在 `reconcile.test.mjs` 追加(import `reconcileRunStatusForTest` 或经 `getJobStatus` 的注入 hook;若 jobs.ts 未暴露 seam 注入点,本 Step 先加一个可注入的 `reconcileSeam` 选项):
```javascript
import { getJobStatus } from "../../../dist/ops/jobs/jobs.js";

test("jobs dispatch: an iHPC run WITH campaign_id routes to the campaign seam, not per-pid status", async () => {
  let campaignSeamCalled = false;
  let perPidCalled = false;
  await getJobStatus(
    { runId: "run_camp" },
    {
      // test hooks (added in Step 3): override the campaign-seam + per-pid reconcilers
      now: new Date("2026-06-20T15:00:00Z"),
      auditDir: undefined,
      _reconcileCampaignSeam: async () => { campaignSeamCalled = true; return { transitions: [], needs_reconciliation: [] }; },
      _reconcilePerPid: async () => { perPidCalled = true; return { status: { status: "running" } }; },
      _loadRunRecord: () => ({ run_id: "run_camp", platform: "uts-ihpc", campaign_id: "campaign_x",
        remote_job_id: "ihpc-run_camp-1", status: "running", profile_id: "p1" })
    }
  );
  assert.equal(campaignSeamCalled, true);
  assert.equal(perPidCalled, false);
});
```
> 注:若 `getJobStatus` 现有签名不便注入,改为单测一个新导出的小分流函数 `pickIhpcReconciler(runRecord)` 返回 `"campaign" | "per-pid"`,并断言 `pickIhpcReconciler({campaign_id:"x",...}) === "campaign"`、`pickIhpcReconciler({campaign_id:undefined,...}) === "per-pid"`。优先这条(更小、无需改 `getJobStatus` 签名):
```javascript
import { pickIhpcReconciler } from "../../../dist/ops/jobs/jobs.js";
test("pickIhpcReconciler routes campaign runs to the seam and single runs to per-pid", () => {
  assert.equal(pickIhpcReconciler({ platform: "uts-ihpc", campaign_id: "campaign_x" }), "campaign");
  assert.equal(pickIhpcReconciler({ platform: "uts-ihpc" }), "per-pid");
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/reconcile.test.mjs`
Expected: FAIL(`pickIhpcReconciler` 未导出)。

- [ ] **Step 3: 实现分流(改 `reconcileRunStatus` 在 jobs.ts:100)**

在 `mcp-server/src/ops/jobs/jobs.ts` 加导出小函数,并在 `reconcileRunStatus` 的 iHPC 分支用它:
```typescript
// spec 6 C: an iHPC run that belongs to a campaign reconciles via the node STATE seam (one read of
// state.json), not the per-pid IHPC_STATUS_PY path. A single non-campaign iHPC run keeps the legacy
// per-pid path (the fast-path behavior, spec 6 D1).
export function pickIhpcReconciler(runRecord: { platform: string; campaign_id?: string }): "campaign" | "per-pid" {
  return runRecord.platform === PLATFORM.IHPC && runRecord.campaign_id ? "campaign" : "per-pid";
}
```
在 `reconcileRunStatus`(jobs.ts:100-116)把 iHPC 分支改为:
```typescript
  if (runRecord.platform === PLATFORM.IHPC) {
    if (pickIhpcReconciler(runRecord) === "campaign") {
      // delegate to seam/reconcile.ts: read state.json once, sync this run's RunRecord, return its
      // status. The campaign-wide sync (sibling runs) is driven by jobs.track's batch path.
      return reconcileIhpcCampaignRunStatus(runRecord, profile, remoteJobId, now, timeoutMs, executor, options);
    }
    return reconcileIhpcRunStatus(runRecord, profile, remoteJobId, now, timeoutMs, executor, options);
  }
```
新增薄适配 `reconcileIhpcCampaignRunStatus`(jobs.ts):它构造 `reconcileIhpcCampaign` 的 deps（`readState` 经 `sshSupervisorArgs` 读 `~/.uts-computing/scheduler/state/<campaign_id>/state.json`,`persistRunRecord` 经 `updateRunRecord`,`relaunchProgressor` 经 `seam/launch` 的起推进器原语),调用后把本 run 的 transition 映射成 `JobStatusResult`。import `reconcileIhpcCampaign` from `../scheduler/seam/reconcile.js`。
```typescript
import { reconcileIhpcCampaign } from "../scheduler/seam/reconcile.js";

async function reconcileIhpcCampaignRunStatus(
  runRecord: RunRecord, profile: ComputeProfile, remoteJobId: string, now: Date,
  timeoutMs: number, executor: JobCommandExecutor, options: JobOperationOptions
): Promise<JobStatusResult> {
  const supervisor = requireIhpcSupervisor(runRecord, profile);
  const out = await reconcileIhpcCampaign(
    { campaignId: runRecord.campaign_id as string, profileId: runRecord.profile_id, profile,
      node: supervisor.node_id ?? "",
      runRecords: [{ run_id: runRecord.run_id, status: runRecord.status }] },
    {
      now,
      readState: async (host, node, campaignId) => {
        const spec = encodeSpec({ campaign_id: campaignId, kind: "state" });
        const args = sshSupervisorArgs(host, node, timeoutMs, spec);
        const result = await executor("ssh", args, timeoutMs, IHPC_STATE_READ_PY);
        return JSON.parse(parseSingleJsonLine(result.stdout));
      },
      persistRunRecord: (rec) => updateRunRecord({ ...runRecord, ...rec } as RunRecord, options.auditDir),
      // CP-2: relaunchProgressor (canonical name). jobs.track's single-run reconcile keeps the existing
      // progressor pid; the full dead-progressor adopt+relaunch is exercised by jobs.track's batch path (D).
      relaunchProgressor: async () => ({ pid: runRecord.supervisor?.pid ?? 0 })
    }
  );
  const t = out.transitions.find((x) => x.run_id === runRecord.run_id);
  return {
    mode: "read-only", run_id: runRecord.run_id, profile_id: runRecord.profile_id,
    platform: runRecord.platform, remote_job_id: remoteJobId, observed_at: now.toISOString(),
    status: t?.status ?? runRecord.status,
    ...(supervisor.node_id ? { node: supervisor.node_id } : {}),
    ...(runRecord.placement ? { placement: runRecord.placement } : {}),
    usage: null, summary: `reconciled campaign run ${runRecord.run_id} -> ${t?.status ?? runRecord.status}`,
    command: redactedIhpcCommand(
      sshSupervisorArgs(profile.login.host_alias, supervisor.node_id ?? "", timeoutMs, encodeSpec({ campaign_id: runRecord.campaign_id, kind: "state" })),
      profile.login.host_alias, supervisor.node_id ?? "", "<state-spec>")
  };
}
```
`IHPC_STATE_READ_PY`:一个极小 inline-python(镜像 `IHPC_STATUS_PY` 风格,用 `pyImports`/`PY_DECODE_SPEC`/`PY_FAIL_FIXED`)`cat` 整个 `~/.uts-computing/scheduler/state/<campaign_id>/state.json` 并 `print` 之(绝不 tail,spec §2.3)。加它到 jobs.ts 的 inline-python 区,并加进 `progressor-snapshot`/`remote-python-snapshot` 的 golden 集合(若 snapshot 测试覆盖 jobs.ts 的导出):
```python
# IHPC_STATE_READ_PY body (composed via pyImports(["base64","json","os","sys"]) + PY_FAIL_FIXED + PY_DECODE_SPEC("state")):
campaign_id = spec.get("campaign_id")
if not isinstance(campaign_id, str) or not campaign_id or "/" in campaign_id or ".." in campaign_id:
    fail("unsafe campaign_id")
path = os.path.expanduser(f"~/.uts-computing/scheduler/state/{campaign_id}/state.json")
if not os.path.isfile(path):
    fail("no state.json for campaign")
with open(path, "r", encoding="utf-8") as handle:
    sys.stdout.write(handle.read())   # whole file, never tail (spec 2.3)
```

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/reconcile.test.mjs`
Expected: PASS(`pickIhpcReconciler` 分流正确)。

- [ ] **Step 5: 全套件回归(确认单次 iHPC 路径未回归)**

Run:
```bash
npm run build && npm test 2>&1 | tail -5
```
Expected: 全绿(单次 iHPC `ihpc-start.test.mjs` / `jobs` track 测试不变;若 `remote-python-snapshot.test.mjs` 因新增 `IHPC_STATE_READ_PY` 导出失败,deliberately 重新生成其 golden 并 review diff)。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/jobs/jobs.ts mcp-server/tests/ops/scheduler/reconcile.test.mjs \
  mcp-server/tests/fixtures/remote-python/ 2>/dev/null
git commit -m "feat(jobs): route campaign iHPC runs through seam/reconcile (jobs.track); single runs keep per-pid path"
```

---

## Task 7:取消语义(drain vs now)+ 命名验收语料(本地假节点 smoke)

落 spec §7 取消语义(立即 / drain)、§7 命名验收语料(冷启→1-slot→重连对账→离线-完成-补位→推进器-OOM-重起→中途取消)。本地假节点全程(无真实节点/GPU);真实节点 smoke 由操作者在部署后单独跑(spec §7,超出可 CI 范围)。

**Files:**
- Modify: `mcp-server/src/ops/scheduler/node/progressor.py`(SIGTERM=立即;`drain.flag`=drain)
- Test: `mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`(取消两路 + 端到端语料)

- [ ] **Step 1: 写失败测试(立即取消 + drain + 离线补位语料)**

追加:
```javascript
test("cancel NOW: SIGTERM to a running wrapper writes status=cancelled (terminal marker exists)", () => {
  const dir = makeCampaign({
    plan: basePlan({ jobs: [jobSpec(0, ["sleep", "30"])] }),
    lease: { client: "claude", device_id: "laptop-7f3a", pid: 1, queue_id: "sha256:deadbeef" }
  });
  const bin = withStubNvidiaSmi(dir, { busyGpu: null });
  runProgressor(dir, { env: { PATH: `${bin}:${process.env.PATH}` } }); // launch sleep 30
  const wrapperPid = Number(fs.readFileSync(path.join(dir, "slot_0", "run.pid"), "utf8").split("\n")[0]);
  // the wrapper python is the parent; SIGTERM it -> trap writes cancelled
  const ppid = findWrapperParent(dir); // helper: reads wrapper.log / pgid; or SIGTERM the run.pid's group
  process.kill(-Number(ppid), "SIGTERM"); // killpg
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, "slot_0", "result.json")) && Date.now() < deadline) {}
  const result = JSON.parse(fs.readFileSync(path.join(dir, "slot_0", "result.json"), "utf8"));
  assert.equal(result.status, "cancelled", "killed job must ALWAYS have a terminal marker (spec 7)");
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
```
> 测试 helper `findWrapperParent` 可简化为:对 `slot_0/run.pid` 的 pid 取 `process group`(`-pgid`)。若实现起来易脆,改为断言「SIGTERM 推进器进程组后 result.json status=cancelled」并用 spawn 持有推进器句柄。

- [ ] **Step 2: Run — FAIL**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: FAIL(`drain.flag` 未被尊重 → drain 测试挂;cancelled-marker 取决于 Task 2 的 SIGTERM trap,若已绿则只 drain 挂)。

- [ ] **Step 3: 实现 drain(改 `reconcile_slots` 在启动前检查 drain.flag)**

在 `progressor.py` 的 `reconcile_slots` 启动循环前加:
```python
    draining = os.path.isfile(os.path.join(root, "drain.flag"))  # spec 7: drain = stop new launches
    free = plan["limits"]["slot_count"] - sum(1 for v in statuses.values() if v in ("running", "launching"))
    for job in sorted(plan["jobs"], key=lambda j: j["seq"]):
        if free <= 0 or draining:   # drain: let running jobs finish, launch nothing new
            break
        if statuses[job["seq"]] == "pending":
            claim_and_launch(root, plan, job, attempt=0)
            statuses[job["seq"]] = "launching"
            free -= 1
```
（立即取消 = SIGTERM 推进器进程组,wrapper 的 SIGTERM trap 已在 Task 2 写 `status=cancelled` —— 无需新代码。）

- [ ] **Step 4: Run — PASS**

Run: `node --test mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs`
Expected: PASS(取消两路 + 离线补位语料全绿)。

- [ ] **Step 5: 重生成 golden + 全套件**

Run:
```bash
cp mcp-server/src/ops/scheduler/node/progressor.py mcp-server/tests/fixtures/remote-python/PROGRESSOR_PY.py
npm run build && npm test 2>&1 | tail -5
```
Expected: golden 更新(review diff:只多 drain 检查);`npm test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/scheduler/node/progressor.py \
  mcp-server/tests/ops/scheduler/progressor-reconcile.test.mjs \
  mcp-server/tests/fixtures/remote-python/PROGRESSOR_PY.py
git commit -m "feat(scheduler): cancel drain-vs-now (drain.flag + SIGTERM->cancelled) + offline-finish-refill acceptance corpus (spec 7)"
```

---

## Phase C 退出条件

- [ ] `node/progressor.py` 存在,~250–350 行 stdlib only(无 PyYAML/paramiko);`python3 -c "import ast; ast.parse(...)"` 通过;golden 字节快照锁定。
- [ ] 推进器:读不可变 PLAN、**node 侧 lease.json 强制**(拒绝 `lease_owner` ≠ 持有者)、`O_EXCL` launch.marker 防双 fire、durable 写(file+dir fsync)、per-job wrapper(env 白名单 + token 字面展开 + root 复校 + 启动时 GPU 守卫 + SIGTERM→cancelled + log_max_bytes)、reconcile-never-reattach 恢复、failure_breaker、idle 退避、常驻循环。
- [ ] 崩溃注入 / launch-marker / PID-复用 / GPU-冲突 / lease-拒绝 测试全绿;**已完成作业永不重跑**有测试证明。
- [ ] `seam/launch.ts`:`assertIhpcPlan` 校验 campaign PLAN → 原子写 plan.json(`~/.uts-computing/scheduler/state/<campaign_id>/`,绝不 /tmp)→ 每节点起一次推进器 → 持久化 supervisor(slot 路径化,CP-3/C-6)/placement.gpu_index+gpu_slot/queue_position/lease_owner;**单次快路径**(`campaign_id===null` + jobs==1)经 `SingleRunSpec` 判别分流到 SUPERVISOR_PY(不复用 `IhpcPlan`,CP-5)。
- [ ] `seam/status.ts`:单一 `nodeStatusToRunStatus`(CP-4);`seam/reconcile.ts`:**一次读** state.json(绝不 tail)+ `assertIhpcState` 校验 + STATE→RunRecord 同步(经共享映射器)+ 死推进器-但活作业 adopt(可注入 hook)+ 重起(§5c);CP-2 签名与 Phase D verbatim 共享;时钟为节点不透明标签(无跨钟相减)。
- [ ] `jobs.track` 经 `pickIhpcReconciler` 把 campaign iHPC run 路由到 seam;单次 iHPC run 保留 per-pid 路径(行为无回归)。
- [ ] 取消 drain-vs-now;被杀作业总有 `result.json status=cancelled`。
- [ ] `npm run build && npm test` 全绿(478 基线 + 新增,无回归);`progressor.py` 经 `postbuild`(`scripts/copy-progressor.mjs`)复制进 `dist/`,且 `dist==src` 字节一致有测试钉死(C-5)。
- [ ] 客户端中立(spec §8):`seam/launch`/`seam/reconcile` 是**内部**模块(被 `jobs.*` 调用),未新增 MCP 工具面;`progressor.py` 是纯 stdlib JSON 协议,Codex 可同样消费。

## 自查(spec 覆盖)
- §2.1 职责/非职责 → Task 1-3 推进器(读 PLAN、数活 slot、唯一 nvidia-smi 启动守卫、durable STATE、离线推进) ✓。
- §2.2 PLAN schema(分组 limits/security/policy/jobs + token 哨兵 + env 白名单 + 不可变 seq) → Task 1-2 消费 + Task 4 写 ✓。
- §2.3 STATE schema + 终止标记 + 状态词表 + **durable temp→fsync→rename→dir-fsync** + 节点钟规则 → Task 1(durable 写)、Task 5(节点不透明钟) ✓。
- §2.4 常驻 reconcile 循环 Option A + `O_EXCL` launch-marker + 数活非 token → Task 2-3 ✓。
- §2.5 per-job wrapper(GPU 守卫 + killpg 取消 + log-cap) → Task 2、Task 7 ✓。
- §2.6 reconcile-never-reattach 恢复表 + failure_breaker + restart_throttle → Task 2-3 ✓;`failure_breaker` 语义按「N 次连续失败且零成功」实现,`require_one_success` = 任一成功即 disarm,加 C-4 两个 pin 测试钉死(不退化成 recency breaker)✓;节点重启「暂停到重连」边界:本阶段默认路径不宣称重启自愈(cron_reboot 是 Phase A opt-in),退出条件未误称自愈 ✓。
- §2.7 schema 前向兼容:推进器 `schema_version` 大版本检查 + 忽略未知字段(Ajv `additionalProperties` 由 Phase B protocol.ts 定;reconcile 读时不因未知字段失败)→ Task 1/5 大版本检查 ✓(完整前向兼容矩阵属 Phase B schema 责任,本阶段消费)。
- §2.8 stdlib-only inline ship → Task 1(import 集)、Task 4(`progressor-source.ts`/golden) ✓。
- §3.3 工具融合(`seam/launch` 起推进器、`jobs.track → reconcile`) → Task 4、Task 6 ✓。
- §3.4 `seam/launch`/`seam/reconcile`/`node/progressor.py` → Task 4/5/1-3,RunRecord 新字段(queue_position/lease_owner/supervisor.pid/placement.gpu_index)在 launch 持久化 ✓。
- §5c 死推进器-但活作业复用 lineage 路径 + 重起推进器 resume → Task 5 ✓;**CP-3/D-3**:`reconcile.ts` 死推进器分支带可注入 `adoptLiveJob` hook + `auditDir`,D Task 5 只「接线」(供真实 `ihpcStateJobToRunRecord`),不重塑签名;C 自身用 stub hook + relaunch-only 双测试覆盖 ✓。
- §6 C 切换 + D1 单次快路径(node_scheduler.runner=console 回滚)→ Task 4(fast path)、Task 6(分流) ✓。
- §7 测试:本地假节点 harness、崩溃注入矩阵、PID 复用、launch-marker、GPU 冲突、lease、golden inline-python、时钟偏移、取消 drain-vs-now + wrapper 写 cancelled、命名验收语料(离线-完成-补位) → Task 1-3、5、7 ✓。**真实节点首次 smoke** 是 Phase C 出口的操作者步骤(无法 CI),已在 Task 7 标注属部署后人工。
- §8 客户端中立:seam 为内部、不增工具面 → 退出条件 + Task 4 注释 ✓。
- **刻意留给其他阶段**:control/* 大脑、protocol.ts schema、节点 lease 写入控制路径(Phase A/B,本阶段 Step 0 断言其存在并消费);Feature B `jobs.adopt` 两轴信任(Phase D,§5a/b)。

### 跨阶段一致性评审已应用(CP-* / C-*)
- **CP-1**(BLOCKER):protocol.ts 导出名统一为 `assertIhpcPlan`/`assertIhpcState`;Task 4 Step 0 grep 改用这两个名;`launch.ts` import/调用、`reconcile.ts` import/调用全部对齐 ✓。
- **CP-2**(BLOCKER):`reconcileIhpcCampaign` 签名与 Phase D verbatim 统一——`{campaignId, profileId, profile, node, runRecords}` + deps `{readState, persistRunRecord, relaunchProgressor, progressorAlive?, adoptLiveJob?, auditDir?}`;Task 5 测试 + Task 6 adapter 全用新名 ✓。
- **CP-3 / D-2**(MAJOR):campaign job 的「supervisor of record」定为 **wrapper(slot 会话首)pid**——推进器写 STATE `jobs[<seq>].wrapper_pid`(本阶段 `claim_and_launch` 落 `wrapper.pid`、`reconcile_slots` 读进 STATE),`launch.ts` 的 supervisor 块**路径化**(slot 目录),Phase D adopt 用 `wrapper_pid` 而非死的 `progressor.pid` ✓。
- **CP-4**(MAJOR):node-status→RunRecord-status 单一映射器 `seam/status.ts::nodeStatusToRunStatus`,C `reconcile.ts` 与 D `adopt.ts` 共 import,不各抄 ✓。
- **CP-5**(MINOR):`PlanObject = IhpcPlan | SingleRunSpec` 判别联合;campaign 路径用真 `IhpcPlan`(编译期防字段漂移),单次快路径用 `SingleRunSpec`(`campaign_id: null`),`assertIhpcPlan` 只在 campaign 路径调 ✓。
- **CP-6**(MINOR):`RunRecord["status"]` union 已核(core/types.ts:260 = `planned|submitting|submitted|running|finished|failed|cancelled|unknown`),所有状态映射成员合法,`status.ts` 注释钉住引用 ✓。
- **C-3**(MAJOR):wrapper heredoc 去掉死 `"$@"`,argv 严格走 `UTS_JOB_ARGV`(no-interpolation 契约清晰)✓。
- **C-4**(MAJOR):`failure_breaker` 语义按 spec 2.6「N 次连续失败且零成功」定;`require_one_success` = 任一 `done` 即 disarm(spec-faithful);加 `[done,fail,fail,fail]` + `require_one_success:false` 两个 pin 测试 ✓。
- **C-5**(MAJOR):`progressor.py` 复制进 `dist/` 是真实 `postbuild` 步骤(`scripts/copy-progressor.mjs`),顺序固定(tsc→copy),且测试断言 `dist==src` 字节一致 ✓。
- **C-6**(MINOR):campaign 的 `supervisor.metadata_path`/`stdout_path` 落 slot 路径(非空串),与 D adopt 的 supervisor 块一致 ✓。
- **C-7**(MINOR):Task 6 加 Step 0 grep 断言 `encodeSpec`/`parseSingleJsonLine`/`redactedIhpcCommand`/`requireIhpcSupervisor`/`sshSupervisorArgs`/`updateRunRecord`/`PLATFORM` 在 jobs.ts 可达 ✓。
