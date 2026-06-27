# iHPC 内化 — Phase B(control:大脑模块)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现。步骤用 checkbox(`- [ ]`)跟踪。

**Goal:** 构建插件「大脑」的 control 子系统——placement 记账(移植 `virtual_gpu_counts` 预记账)、pending 队列推进策略、per-`(profile,node)` 单写者 lease、`planNextBatch()` 合成 PLAN 对象、PLAN/STATE 的 Ajv schema + 加固断言(token/env-allowlist/argv/realpath)、durable SSH 原子写 primitive,以及 RunRecord 新字段。本阶段**只造大脑侧逻辑**:全部产出是纯函数 + schema 校验 + 一个 SSH 写 primitive。**不**部署任何东西到节点,**不**写推进器,**不**做 reconcile,**不**做节点侧 lease.json 执行——那些都在 Phase C。

**Architecture:** 新子系统树 `mcp-server/src/ops/scheduler/{control,seam}/`(`node/` 与 `seam/contract.ts`/`seam/launch.ts`/`seam/reconcile.ts` 由 Phase A/C 落地,本阶段只新建 `seam/protocol.ts`)。目录结构承担「大脑侧 control / 跨接缝 seam」语义,文件名承担具体关注点(无冗余 `scheduler-` 前缀)。`control/placement.ts` 是纯记账(SSH nvidia-smi 探测注入为可选 executor,默认不触发);`control/queue.ts` 纯排序/并发/campaign 边界;`control/lease.ts` 大脑侧 acquire/refresh/stale/takeover 决策(节点写由 `seam/protocol.ts` 校验,节点执行在 C);`control/plan.ts` 的 `planNextBatch()` 串 lease+queue+placement+quota gate → 发 PLAN。`seam/protocol.ts` 用既有 `ajv/dist/2020.js`(`core/validation.ts:27-30` 模式)编译两份新 schema(`schemas/ihpc-plan.schema.json`、`schemas/ihpc-state.schema.json`)+ 程序化加固断言。

**Tech Stack:** TypeScript(ES modules、Ajv 2020)、`node --test`(`.mjs` import from `../../dist/...js`,先 `npm run build`)。依据 spec:`docs/superpowers/specs/2026-06-20-ihpc-scheduler-internalized-design.md` §2.2(PLAN)、§2.3(STATE)、§2.7(schema 前向兼容)、§3.1(移进 TS)、§3.2(lease)、§3.3(融合)、§3.4(新增/改动 TS 表)、§5a(lineage 字段)。Phase 0 已落契约 build-ordinal 格式(`version+stateN+buildM+sha`);Phase A 已落 `node_scheduler` profile 字段、`contractOrdering`、节点 lease 概念。

**基线:** 全套 `npm test` 当前应绿(~485,Phase A 后更高)。每个 Task 末尾 commit;不 push(控制器统一处理)。所有路径绝对,测试 import 自 `dist/`。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `mcp-server/src/core/types.ts` | RunRecord 扩 `+queue_position`/`+lease_owner`/`+auto_progressed`/`+attempt`;`gpu_slot` 并入既有 `placement{}`、progressor pid 并入既有 `supervisor{}`;新增 `LeaseOwner`/`IhpcPlan`/`IhpcState` 接口 | **Modify** |
| `mcp-server/src/lib/ssh.ts` | `sshWriteAtomicJson()` argv builder(durable:temp→fsync→rename→dir-fsync 的 inline-python micro-worker) | **Modify** |
| `mcp-server/src/ops/scheduler/control/placement.ts` | 记账预记账(移植 `virtual_gpu_counts`);`allocateGpuSlot`/`reserveSlots`;SSH nvidia-smi 仅经注入 executor(冷启动/adopt/漂移) | **Create** |
| `mcp-server/src/ops/scheduler/control/queue.ts` | pending 队列、campaign 成员、`max_concurrent`、FIFO 推进策略 | **Create** |
| `mcp-server/src/ops/scheduler/control/lease.ts` | per-`(profile,node)` 单写者 lease:acquire/refresh/staleness/takeover 决策(纯) | **Create** |
| `mcp-server/src/ops/scheduler/control/plan.ts` | `planNextBatch()` → lease+queue+placement+quota gate → 发 `IhpcPlan` | **Create** |
| `mcp-server/src/ops/scheduler/seam/protocol.ts` | PLAN/STATE Ajv 校验 + token/env-allowlist/argv/realpath 断言 + `schema_compat_min` 检查 | **Create** |
| `schemas/ihpc-plan.schema.json` | PLAN 结构 schema(§2.2 分组) | **Create** |
| `schemas/ihpc-state.schema.json` | STATE 结构 schema(§2.3 分组) | **Create** |
| `mcp-server/tests/ops/scheduler/placement.test.mjs` | placement 记账测试 | **Create** |
| `mcp-server/tests/ops/scheduler/queue.test.mjs` | 队列推进测试 | **Create** |
| `mcp-server/tests/ops/scheduler/lease.test.mjs` | lease 决策测试 | **Create** |
| `mcp-server/tests/ops/scheduler/plan.test.mjs` | `planNextBatch` 集成测试 | **Create** |
| `mcp-server/tests/ops/scheduler/protocol.test.mjs` | protocol schema + 断言测试 | **Create** |
| `mcp-server/tests/lib/ssh-atomic.test.mjs` | `sshWriteAtomicJson` argv 测试 | **Create** |
| `schemas/run-record.schema.json` | 允许 RunRecord 新字段(若 schema 严格) | **Modify(按需)** |

> 注:`seam/contract.ts`(`contractOrdering`)在 Phase A 已落;本阶段不动它。`seam/launch.ts`/`seam/reconcile.ts`/`node/progressor.py` 在 Phase C。`control/plan.ts` 只 **合成并返回** `IhpcPlan` 对象 + 经 `protocol.ts` 自校验,**不**调用 `seam/launch` 写盘起推进器(那是 C)。

---

## Task 1:扩 `core/types.ts`——RunRecord 新字段 + LeaseOwner + IhpcPlan/IhpcState 接口

§3.4 表:RunRecord 新增 `+queue_position`、`+lease_owner`、`+auto_progressed{by_node_agent,freed_by_run_id}`、`+attempt`;`gpu_slot` **并入既有 `placement{}`**(`:248-254` 已有 `gpu_index`/`slots_per_gpu`,无需重复块);progressor pid **并入既有 `supervisor{}`**(`:237` 已有 `pid`/`node_id`)。新增 `LeaseOwner`、`IhpcPlan`、`IhpcState`(spec §2.2/§2.3 的 grouped 结构,供 `protocol.ts`/`plan.ts` 共享类型)。

**Files:**
- Modify: `mcp-server/src/core/types.ts`
- Test: `mcp-server/tests/ops/scheduler/types-shape.test.mjs`(Create)

- [ ] **Step 1: 写失败测试**

Create `mcp-server/tests/ops/scheduler/types-shape.test.mjs`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { isIhpcPlanShape, isLeaseOwnerShape } from "../../../dist/ops/scheduler/seam/protocol.js";

// 这两个轻量 type-guard 在 protocol.ts(Task 5)实现;此 Task 仅靠它们间接断言 types 的字段存在,
// 因为 .d.ts 类型本身不可在运行时断言。先建 guard 的桩失败,Task 1 落 types,Task 5 落 guard。
test("LeaseOwner shape: client/device_id/issued_at", () => {
  assert.equal(isLeaseOwnerShape({ client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" }), true);
  assert.equal(isLeaseOwnerShape({ client: "claude" }), false);
  assert.equal(isLeaseOwnerShape({ client: "x", device_id: "d", issued_at: "t" }), false); // client 非 claude|codex
});

test("IhpcPlan shape: top + limits + security + policy + jobs", () => {
  const plan = {
    schema_version: "1.0.0", schema_compat_min: "1.0.0",
    campaign_id: "campaign_x", queue_id: "sha256:abc",
    lease_owner: { client: "claude", device_id: "d1", issued_at: "2026-06-20T14:32:10Z" },
    node_id: "mars01", profile_id: "utsihpc_user_01",
    limits: { slot_count: 2, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/home/user/p"], env_key_allowlist: ["UTS_RUN_ID"] },
    policy: {
      on_job_failure: "continue",
      failure_breaker: { max_consecutive_failures: 5, require_one_success: true },
      idle_definition: "no_running_and_no_launchable_pending",
      idle_exit_seconds: 604800, restart_throttle_seconds: 2
    },
    jobs: [{ seq: 0, run_id: "run_a", command_argv: ["python", "t.py"], workdir: "/home/user/p",
             env: { UTS_RUN_ID: "$RUN_ID$" }, gpu_index: 0, gpu_count: 1, timeout_seconds: 3600 }]
  };
  assert.equal(isIhpcPlanShape(plan), true);
  assert.equal(isIhpcPlanShape({ ...plan, jobs: [] }), false); // 空 jobs 非法
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build`
Expected: FAIL(`dist/ops/scheduler/seam/protocol.js` 不存在;且 types 缺新接口 → tsc 报错)。这一步用编译失败证明缺口。

- [ ] **Step 3: 改 `core/types.ts`——扩 RunRecord + 新接口**

在 `RunRecord` 的 `supervisor?` 块加 progressor pid 复用(§3.4「progressor pid 并入既有 supervisor{}」),在 `placement?` 块加 `gpu_slot` 复用(它已有 `gpu_index`/`slots_per_gpu`,增加一个显式 `gpu_slot` 别名字段以承载「slot 序号」语义),并加 4 个新顶层字段。把 `RunRecord` 接口里 `placement?: { ... }` 改为:
```typescript
  placement?: {
    hostname: string;
    node_id?: string;
    gpu_index?: number;
    slots_per_gpu?: number;
    // Phase B: which slot index (0-based) on the chosen GPU this run occupies. The brain assigns it
    // during pre-accounting (control/placement.ts); the node verifies GPU-idle at launch (Phase C).
    gpu_slot?: number;
    started_at?: string;
    placement_hash?: string;
  };
```
把 `supervisor?` 块改为(加一行注释 + 复用 pid 承载 progressor pid;无新字段,只标注语义):
```typescript
  supervisor?: {
    // Phase B/C: for a campaign progressor this is the on-node progressor PID (the slot-filling
    // reconcile loop); for a single-run fast path it stays the per-process supervisor PID.
    pid: number;
    node_id?: string;
    metadata_path: string;
    stdout_path: string;
    stderr_path: string;
    started_at?: string;
  };
```
在 `RunRecord` 接口 `reproducibility?` 之前加 4 个新字段:
```typescript
  // Phase B (internalized scheduler) — brain-side queue/lease/auto-progression attribution. All four
  // are organizational/observability metadata: they live ONLY on the run record, are NEVER hashed into
  // plan_hash, and are absent on plain non-campaign runs.
  queue_position?: number;
  lease_owner?: LeaseOwner;
  auto_progressed?: {
    // true when the on-node progressor (not the online brain) launched this run into a freed slot.
    by_node_agent: boolean;
    // the run whose terminal slot this run filled, when known (for the campaign ledger lineage).
    freed_by_run_id?: string;
  };
  // crash/restart relaunch attempt counter (§2.6 "新 attempt"); 0 for the first launch.
  attempt?: number;
```
在文件末尾(`DocsCacheRecord` 之后)追加共享接口:
```typescript
// --- Phase B: internalized iHPC scheduler PLAN/STATE shared types (spec §2.2 / §2.3) ---

// The single writer that authored a PLAN / holds the node lease. `client` is the agent family; never a
// secret. Mirrors the node lease.json holder minus pid/queue_id (those are node-side, Phase C).
export interface LeaseOwner {
  client: "claude" | "codex";
  device_id: string;
  issued_at: string;
}

// PLAN job entry (spec §2.2 `jobs[]`). command_argv is pre-escaped argv (no bash -lc); env values may
// carry hardened sentinels ($GPU_INDEX$/$RUN_ID$) expanded ONLY in env values on the node (Phase C).
export interface IhpcPlanJob {
  seq: number;
  run_id: string;
  command_argv: string[];
  workdir: string;
  env: Record<string, string>;
  gpu_index: number;
  gpu_count: number;
  timeout_seconds: number;
}

// PLAN file (brain -> node; spec §2.2, grouped by concern). Immutable per queue_id.
// campaign_id is `string | null`: a campaign run carries its id; the single-run FAST PATH (jobs==1,
// no campaign — Phase C seam/launch.ts) emits a PLAN with campaign_id:null and keys its fast path on
// that null. Phase C MUST reuse THIS canonical IhpcPlan type for its launch path (not a private looser
// PlanObject) so field drift is caught at compile time (review CP-5).
export interface IhpcPlan {
  schema_version: string;
  schema_compat_min: string;
  campaign_id: string | null;
  queue_id: string;
  lease_owner: LeaseOwner;
  node_id: string;
  profile_id: string;
  limits: { slot_count: number; max_slots_per_gpu: number; log_max_bytes: number };
  security: { allowed_roots: string[]; env_key_allowlist: string[] };
  policy: {
    on_job_failure: "continue" | "stop";
    failure_breaker: { max_consecutive_failures: number; require_one_success: boolean };
    idle_definition: string;
    idle_exit_seconds: number;
    restart_throttle_seconds: number;
  };
  jobs: IhpcPlanJob[];
}

// STATE per-slot entry (spec §2.3 jobs.<seq>).
// `pid` is the INNER job process pid. `wrapper_pid` is the per-slot wrapper/supervisor-of-record pid
// (the launch-time GPU-guard + SIGTERM-trap wrapper, Phase C §2.5) — this is the pid Phase D's
// dead-progressor adopt path (`ihpcStateJobToRunRecord`) uses to build the supervisor block, so that a
// dead PROGRESSOR pid is never mistaken for the supervisor of a still-live job (review CP-3 / D-2). The
// node writes wrapper_pid when it launches a slot; the brain never invents it.
export interface IhpcStateJob {
  seq: number;
  run_id: string;
  status: IhpcJobStatus;
  pid?: number;
  wrapper_pid?: number;
  gpu_index?: number;
  exit_code?: number;
  started_at_node?: string;
  finished_at_node?: string;
  log: string;
}

export type IhpcJobStatus =
  | "pending" | "launching" | "running" | "done" | "failed" | "cancelled" | "placement_conflict";

// STATE file (node -> brain; spec §2.3, grouped). The brain reads it ONCE per reconcile (Phase C).
export interface IhpcState {
  schema_version: string;
  campaign_id: string;
  queue_id: string;
  lease_owner: Pick<LeaseOwner, "client" | "device_id">;
  observed_at_node: string;
  node_clock_epoch: number;
  slot_count: number;
  progressor: { pid: number; started_at_node: string; heartbeat_node: string };
  health: { degraded: string | null; breaker_tripped: boolean };
  jobs: Record<string, IhpcStateJob>;
  counts: {
    pending: number; running: number; done: number; failed: number;
    cancelled: number; conflict: number;
  };
}
```

- [ ] **Step 4: 构建确认 types 编译**

Run: `npm run build 2>&1 | grep -E "types.ts|TS[0-9]" || echo "types compile clean"`
Expected: `types compile clean`(protocol.js 仍缺 → 整体 build 仍失败,但 types.ts 本身无错;Task 5 落 protocol 后整体绿)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/core/types.ts mcp-server/tests/ops/scheduler/types-shape.test.mjs
git commit -m "feat(scheduler): extend RunRecord + add LeaseOwner/IhpcPlan/IhpcState types (Phase B §3.4/§2.2/§2.3)"
```

---

## Task 2:`lib/ssh.ts`——`sshWriteAtomicJson()` durable 写 primitive

§3.4「扩 `lib/ssh.ts`:`sshWriteAtomicJson()`(durable:temp→fsync→rename→dir-fsync)」。§2.3 承重修正:目录 fsync 强制。复用 `ihpc-start.ts` 的 inline-python micro-worker 机制(经 `sshSupervisorArgs` 两跳 + `python3 - <encodedSpec>`),但 payload 是「写一个 JSON 文件,durable」。本 Task 只造 **argv + inline python 字符串**(纯 mechanism,无策略);实际起推进器在 Phase C。

**Files:**
- Modify: `mcp-server/src/lib/ssh.ts`
- Test: `mcp-server/tests/lib/ssh-atomic.test.mjs`(Create)

- [ ] **Step 0: 复核 live `sshSupervisorArgs` 形状(review B-5)**

Run: `grep -n "export function sshSupervisorArgs\|SSH_INNER_HOP_HOST_KEY\|\"-T\"\|\"ssh\"\|\"python3\"" mcp-server/src/lib/ssh.ts`
Expected:确认 `sshSupervisorArgs(hostAlias, computeNode, timeoutMs, encodedSpec)`(:119)返回内层尾段为 `[hostAlias, "ssh", "-o", SSH_INNER_HOP_HOST_KEY, computeNode, "python3", "-", encodedSpec]`,且 `-T` 位于 `hostAlias` 之前(外层段),`SSH_INNER_HOP_HOST_KEY` 已 export(:28 = `"StrictHostKeyChecking=accept-new"`)。Step 1 的 golden 即据此真实形状写,且用常量而非字面量。

- [ ] **Step 1: 写失败测试**

Create `mcp-server/tests/lib/ssh-atomic.test.mjs`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { ATOMIC_WRITE_PY, sshWriteAtomicJsonArgs, SSH_INNER_HOP_HOST_KEY } from "../../dist/lib/ssh.js";

test("ATOMIC_WRITE_PY does temp -> fsync(file) -> rename -> fsync(dir)", () => {
  // golden: 镜像 remote-python micro-worker 的可解析性 + 关键 syscall 顺序断言
  assert.match(ATOMIC_WRITE_PY, /os\.fsync\(/);          // file fsync
  assert.match(ATOMIC_WRITE_PY, /os\.replace\(|os\.rename\(/); // atomic rename
  assert.match(ATOMIC_WRITE_PY, /O_RDONLY/);             // open dir fd for dir fsync
  // 必须先 fsync 文件再 rename 再 fsync 目录:断言三者出现顺序
  const fFsync = ATOMIC_WRITE_PY.search(/handle\.flush\(\)[\s\S]*?os\.fsync\(handle\.fileno\(\)\)/);
  const fRename = ATOMIC_WRITE_PY.search(/os\.replace\(/);
  const fDir = ATOMIC_WRITE_PY.search(/os\.fsync\(dir_fd\)/);
  assert.ok(fFsync >= 0 && fRename > fFsync && fDir > fRename, "order must be fsync(file) < rename < fsync(dir)");
});

test("sshWriteAtomicJsonArgs composes a two-hop supervisor-style argv to the node", () => {
  const args = sshWriteAtomicJsonArgs("login-gw", "mars01", 10000, "QmFzZTY0U3BlYw");
  // 断言 STABLE 的内层尾段(gateway 之后),用 SSH_INNER_HOP_HOST_KEY 常量而非硬编码字面量,这样
  // 外层 hop flags 或 inner-hop 选项若调整也不会脆裂(review B-5)。`-T` 在 hostAlias 之前(外层段),
  // 故从 login-gw 切片不含它。注:实现复用 sshSupervisorArgs(ssh.ts:119),其内层尾段位置已被
  // tests/access.test.mjs pin;此处只复核「我们的 primitive 透传了它」。
  const i = args.indexOf("login-gw");
  assert.deepEqual(
    args.slice(i),
    ["login-gw", "ssh", "-o", SSH_INNER_HOP_HOST_KEY, "mars01", "python3", "-", "QmFzZTY0U3BlYw"]
  );
  // 同时复核外层段确含两跳硬化标志 -T(在 gateway 前),即真两跳而非误退化单跳。
  assert.ok(args.slice(0, i).includes("-T"), "outer hop must carry -T (two-hop, not single-hop)");
});

test("sshWriteAtomicJsonArgs rejects an unsafe encoded spec", () => {
  assert.throws(() => sshWriteAtomicJsonArgs("login-gw", "mars01", 10000, "bad spec!"), /not safe/);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/lib/ssh-atomic.test.mjs`
Expected: FAIL(`ATOMIC_WRITE_PY`/`sshWriteAtomicJsonArgs` 未导出)。

- [ ] **Step 3: 改 `lib/ssh.ts`——加 import + 两个导出**

在文件顶部 import 区(`import { isSafeRemoteToken } from "../core/ids.js";` 之后)加:
```typescript
import { pyImports, PY_FAIL_FIXED, PY_DECODE_SPEC } from "./remote-python.js";
```
> 注:`remote-python.ts` 是 leaf(只导出纯字符串构造器),与 `ssh.ts` 同层无环;若 lint 报循环依赖,改为把 `ATOMIC_WRITE_PY` 放进 `remote-python.ts` 并从那里 re-export(同 `SUPERVISOR_PY` 现住 `ihpc-start.ts` 的先例,但 primitive 更适合 leaf)。本步默认直接 import。

在文件末尾追加:
```typescript
// Durable atomic JSON write on a compute node (spec §2.3 "temp → fsync(file) → rename → fsync(dir)").
// The directory fsync is mandatory: without it POSIX permits losing the rename (a directory-entry
// change) on a power loss while the file body survives, which would make a written PLAN/STATE vanish
// across a node restart. The encoded spec carries {path, contents} (base64 JSON via remote-python).
// This is pure MECHANISM (an inline micro-worker string + the two-hop argv); the brain owns WHEN to
// call it (Phase C seam/launch.ts). Built to mirror SUPERVISOR_PY's stdin-shipped python3 -c form.
export const ATOMIC_WRITE_PY = String.raw`${pyImports(["base64", "json", "os", "sys", "tempfile"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("write")}
path = spec.get("path")
contents = spec.get("contents")
if not isinstance(path, str) or not path.startswith("/"):
    fail("path must be an absolute string")
if not isinstance(contents, str):
    fail("contents must be a JSON string")
directory = os.path.dirname(path)
os.makedirs(directory, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(contents)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
except Exception as exc:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    fail(f"durable write failed: {exc}")
print(json.dumps({"path": path, "bytes": len(contents)}, sort_keys=True))
`;

// Two-hop argv that ships ATOMIC_WRITE_PY to a compute node, identical in shape to sshSupervisorArgs
// (outer-hop hardening -> -T -> gateway -> inner ssh accept-new -> node -> python3 - <encodedSpec>).
// encodedSpec carries the base64 {path, contents}; the caller (Phase C) builds it via encodeSpec.
export function sshWriteAtomicJsonArgs(
  hostAlias: string,
  computeNode: string,
  timeoutMs: number,
  encodedSpec: string
): string[] {
  return sshSupervisorArgs(hostAlias, computeNode, timeoutMs, encodedSpec);
}
```
> `sshWriteAtomicJsonArgs` 复用 `sshSupervisorArgs`,因此自动继承 host-alias / node-id / encodedSpec 的安全断言(`/^[A-Za-z0-9_-]+$/`,见 ssh.ts:124),无需复制校验。`"bad spec!"` 会触发 `Operation spec encoding is not safe for SSH argv`(测试匹配 `/not safe/`)。

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/lib/ssh-atomic.test.mjs`
Expected: PASS(3 测试全绿)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/lib/ssh.ts mcp-server/tests/lib/ssh-atomic.test.mjs
git commit -m "feat(ssh): sshWriteAtomicJson durable write primitive (temp->fsync->rename->dir-fsync, spec §2.3)"
```

---

## Task 3:`control/placement.ts`——记账预记账(移植 `virtual_gpu_counts`)

§3.1 + §9 表:移植 `scheduler.py:265-266`(init `virtual_gpu_counts = {node: gpu_job_counts}`)与 `:324-325`(放置后递减/递增)到 TS。常路 placement = **纯大脑记账,零 SSH**;SSH nvidia-smi 探测仅留给冷启动/adopt/漂移,经**注入的可选 `probe` executor**(默认 `undefined` ⇒ 不触发)。预记账算法逻辑参 `submitter.py:145,154` 的占用语义(但本阶段不真跑 nvidia-smi)。

**Files:**
- Create: `mcp-server/src/ops/scheduler/control/placement.ts`
- Test: `mcp-server/tests/ops/scheduler/placement.test.mjs`(Create)

- [ ] **Step 1: 写失败测试**

Create `mcp-server/tests/ops/scheduler/placement.test.mjs`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { initVirtualGpuCounts, allocateGpuSlot, reserveSlots } from "../../../dist/ops/scheduler/control/placement.js";

const node = { node_id: "mars01", gpu_indices: [0, 1], max_slots_per_gpu: 1 };

test("initVirtualGpuCounts seeds from currently running placements", () => {
  // 一个已 running 的作业占着 gpu 0 → counts {0:1}
  const counts = initVirtualGpuCounts(node, [{ gpu_index: 0 }]);
  assert.deepEqual(counts, { 0: 1, 1: 0 });
});

test("allocateGpuSlot picks the least-loaded GPU under max_slots_per_gpu", () => {
  const counts = { 0: 1, 1: 0 };
  const slot = allocateGpuSlot(node, counts);
  assert.deepEqual(slot, { node_id: "mars01", gpu_index: 1, gpu_slot: 0 });
  // 记账递增后,gpu 1 现也占 1
  assert.equal(counts[1], 1);
});

test("allocateGpuSlot returns null when every GPU is at max_slots_per_gpu (no over-subscription)", () => {
  const counts = { 0: 1, 1: 1 };
  assert.equal(allocateGpuSlot(node, counts), null);
});

test("reserveSlots pre-accounts N jobs and refuses to exceed capacity (16 jobs / 2 GPUs)", () => {
  const placements = reserveSlots(node, 16, []);
  assert.equal(placements.length, 2); // slot_count=2 capacity (2 GPUs x 1 slot); rest stay pending
  assert.deepEqual(placements.map((p) => p.gpu_index), [0, 1]);
});

test("reserveSlots honors slots already held by running work", () => {
  const placements = reserveSlots(node, 4, [{ gpu_index: 0 }]); // gpu0 已占
  assert.equal(placements.length, 1); // 只剩 gpu1 一个空 slot
  assert.equal(placements[0].gpu_index, 1);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/placement.test.mjs`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 `control/placement.ts`**

```typescript
// control/placement.ts — brain-side placement ACCOUNTING (spec §3.1, §9). Common-path placement is
// pure in-brain pre-accounting ported from the vendored scheduler.py `_dispatch_pending`
// (`virtual_gpu_counts` init :265-266, post-dispatch increment :324-325): a job decrements an
// available slot AT THE MOMENT it is placed into a PLAN, never by observing the node afterwards. This
// is what keeps the brain from over-subscribing its OWN slots ("16 jobs onto 4 GPUs"). SSH nvidia-smi
// is NOT run here — the launch-time GPU idle guard (the node's only nvidia-smi, Phase C wrapper) is
// what protects against FOREIGN processes (other accounts) and is the only cross-account-safe point.
// A `probe` executor is injectable for the cold-start/adopt/drift paths only; default undefined ⇒
// pure accounting, zero SSH, matching spec §3.1 "记账优先,非探测优先".

export interface NodeTopology {
  node_id: string;
  // GPU indices physically present on the node (static, from hardware.yaml-derived queue config).
  gpu_indices: number[];
  // per-GPU slot cap (PLAN.limits.max_slots_per_gpu).
  max_slots_per_gpu: number;
}

// Per-GPU running-job count (the TS analogue of state.gpu_job_counts(hostname): {gpu_index -> count}).
export type VirtualGpuCounts = Record<number, number>;

export interface GpuSlotAllocation {
  node_id: string;
  gpu_index: number;
  gpu_slot: number; // 0-based slot index on the chosen GPU
}

// Seed virtual counts from the placements currently held by running work (mirrors scheduler.py:265-266
// initialising virtual_gpu_counts from state.gpu_job_counts). Every present GPU is keyed (0 when free)
// so allocateGpuSlot can iterate deterministically.
export function initVirtualGpuCounts(node: NodeTopology, held: Array<{ gpu_index?: number }>): VirtualGpuCounts {
  const counts: VirtualGpuCounts = {};
  for (const gpu of node.gpu_indices) {
    counts[gpu] = 0;
  }
  for (const placement of held) {
    if (typeof placement.gpu_index === "number" && placement.gpu_index in counts) {
      counts[placement.gpu_index] += 1;
    }
  }
  return counts;
}

// Pick the least-loaded GPU still under max_slots_per_gpu, increment its virtual count (the placement-
// time decrement of available capacity, scheduler.py:324-325), and return the slot. Returns null when
// every GPU is saturated — the brain then leaves the job pending rather than over-subscribing.
export function allocateGpuSlot(node: NodeTopology, counts: VirtualGpuCounts): GpuSlotAllocation | null {
  let best: number | null = null;
  for (const gpu of node.gpu_indices) {
    const used = counts[gpu] ?? 0;
    if (used >= node.max_slots_per_gpu) continue;
    if (best === null || used < (counts[best] ?? 0)) best = gpu;
  }
  if (best === null) return null;
  const slotIndex = counts[best] ?? 0;
  counts[best] = slotIndex + 1;
  return { node_id: node.node_id, gpu_index: best, gpu_slot: slotIndex };
}

// Pre-account up to `want` jobs onto a node's free slots, given the placements already held by running
// work. Stops when capacity is exhausted (jobs beyond capacity stay pending). Pure: no SSH, no node
// observation. This is the brain's "reserve N slots" used by control/plan.ts's planNextBatch.
export function reserveSlots(
  node: NodeTopology,
  want: number,
  held: Array<{ gpu_index?: number }>
): GpuSlotAllocation[] {
  const counts = initVirtualGpuCounts(node, held);
  const placements: GpuSlotAllocation[] = [];
  for (let i = 0; i < want; i += 1) {
    const slot = allocateGpuSlot(node, counts);
    if (!slot) break;
    placements.push(slot);
  }
  return placements;
}
```

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/placement.test.mjs`
Expected: PASS(5 测试全绿)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/scheduler/control/placement.ts mcp-server/tests/ops/scheduler/placement.test.mjs
git commit -m "feat(scheduler): control/placement accounting-first pre-accounting (port virtual_gpu_counts, spec §3.1)"
```

---

## Task 4:`control/queue.ts`——pending 队列推进策略

§3.4:pending 队列、campaign 成员、`max_concurrent`、FIFO/公平推进策略。纯函数:给定 campaign 的全部 RunRecord(状态混合),按 `queue_position` FIFO 排序,过滤出可启动的 pending,施加 `max_concurrent`(扣除已 running 的)得到「本批应启动的 N 个 run」。

**Files:**
- Create: `mcp-server/src/ops/scheduler/control/queue.ts`
- Test: `mcp-server/tests/ops/scheduler/queue.test.mjs`(Create)

- [ ] **Step 1: 写失败测试**

Create `mcp-server/tests/ops/scheduler/queue.test.mjs`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { orderQueue, launchableBatch } from "../../../dist/ops/scheduler/control/queue.js";

const rec = (run_id, status, queue_position) => ({ run_id, status, queue_position, campaign_id: "c1" });

test("orderQueue sorts by queue_position FIFO, ties by run_id", () => {
  const ordered = orderQueue([rec("b", "planned", 2), rec("a", "planned", 1), rec("c", "planned", 1)]);
  assert.deepEqual(ordered.map((r) => r.run_id), ["a", "c", "b"]);
});

test("launchableBatch respects max_concurrent minus already-running", () => {
  const recs = [
    rec("r1", "running", 0), rec("r2", "planned", 1), rec("r3", "planned", 2), rec("r4", "planned", 3)
  ];
  const batch = launchableBatch(recs, { maxConcurrent: 3 });
  // 1 running + room for 2 more → r2, r3
  assert.deepEqual(batch.map((r) => r.run_id), ["r2", "r3"]);
});

test("launchableBatch returns empty when max_concurrent is saturated", () => {
  const recs = [rec("r1", "running", 0), rec("r2", "running", 1), rec("r3", "planned", 2)];
  assert.deepEqual(launchableBatch(recs, { maxConcurrent: 2 }), []);
});

test("launchableBatch ignores terminal and non-campaign runs", () => {
  const recs = [
    rec("r1", "finished", 0), rec("r2", "failed", 1), rec("r3", "planned", 2),
    { run_id: "x", status: "planned", queue_position: 3, campaign_id: "OTHER" }
  ];
  const batch = launchableBatch(recs, { maxConcurrent: 5, campaignId: "c1" });
  assert.deepEqual(batch.map((r) => r.run_id), ["r3"]);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/queue.test.mjs`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 `control/queue.ts`**

```typescript
// control/queue.ts — brain-side pending-queue progression POLICY (spec §3.1/§3.4, ports
// scheduler.py run_forever/_dispatch_pending ordering + max_concurrent). Pure: takes a campaign's run
// records and decides WHICH pending runs are launchable this batch. No SSH, no node observation, no
// placement (that is control/placement.ts) — purely "what does the queue say to start next".

import type { RunRecord } from "../../../core/types.js";

// The non-terminal statuses that occupy a concurrency slot or are eligible to start. Every literal here
// MUST be a member of the live RunRecord["status"] union (core/types.ts:260):
// "planned"|"submitting"|"submitted"|"running"|"finished"|"failed"|"cancelled"|"unknown" — verified
// against source (review CP-6). If that union changes, this set and every node→RunRecord mapper break.
const RUNNING = new Set<RunRecord["status"]>(["submitting", "submitted", "running"]);
const LAUNCHABLE = new Set<RunRecord["status"]>(["planned"]);

export interface QueueProgressionOptions {
  maxConcurrent: number;
  // when set, only runs of this campaign participate (others are ignored, never started).
  campaignId?: string;
}

// FIFO by queue_position (the brain's monotonic enqueue order), ties broken by run_id for determinism.
// Records without a queue_position sort last (treated as +Infinity) so an unattributed run never jumps
// the queue.
export function orderQueue<T extends Pick<RunRecord, "run_id" | "queue_position">>(records: T[]): T[] {
  return [...records].sort((left, right) => {
    const lp = typeof left.queue_position === "number" ? left.queue_position : Number.POSITIVE_INFINITY;
    const rp = typeof right.queue_position === "number" ? right.queue_position : Number.POSITIVE_INFINITY;
    if (lp !== rp) return lp - rp;
    return left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0;
  });
}

// The runs to launch THIS batch: FIFO-ordered launchable pending runs, capped so that
// (currently running + newly launched) never exceeds maxConcurrent. Terminal runs and runs of other
// campaigns are excluded. Returns [] when the campaign is already at its concurrency cap.
export function launchableBatch(
  records: RunRecord[],
  options: QueueProgressionOptions
): RunRecord[] {
  const scoped = options.campaignId
    ? records.filter((record) => record.campaign_id === options.campaignId)
    : records;
  const running = scoped.filter((record) => RUNNING.has(record.status)).length;
  const room = Math.max(0, options.maxConcurrent - running);
  if (room === 0) return [];
  const pending = orderQueue(scoped.filter((record) => LAUNCHABLE.has(record.status)));
  return pending.slice(0, room);
}
```

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/queue.test.mjs`
Expected: PASS(4 测试全绿)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/scheduler/control/queue.ts mcp-server/tests/ops/scheduler/queue.test.mjs
git commit -m "feat(scheduler): control/queue FIFO + max_concurrent progression policy (spec §3.1)"
```

---

## Task 5:`seam/protocol.ts`——PLAN/STATE schema + 加固断言 + type guards

§3.4:PLAN/STATE schema + Ajv 校验;token/env-allowlist/argv/realpath 断言;`schema_compat_min` 检查。这是 Task 1 测试桩(`isIhpcPlanShape`/`isLeaseOwnerShape`)的实现。两份 schema 落 `schemas/`(客户端中立,§8)。加固断言对应 spec §2.2 设计点:`command_argv` 非空字符串列表(禁 `bash -lc`)、env key 必须在 `env_key_allowlist`、env 值里的 `$TOKEN$` 只允许已知 sentinel(`$GPU_INDEX$`/`$RUN_ID$`)、`workdir` 必须在 `allowed_roots` 内。

> **跨阶段契约 — 导出名 PIN(review CP-1,BLOCKER):** 本 Task 是 PLAN/STATE 断言函数的**唯一定义点**。canonical 名是 `assertIhpcPlan` / `assertIhpcState`(与 `isIhpcPlanShape` 命名一致)。**不要**额外导出 `assertIhpcPlan` / `assertIhpcState` 别名。Phase C(`seam/launch.ts` / `seam/reconcile.ts`)与 Phase D 必须 import 这两个 canonical 名;Phase C 的 Step 0 grep 也须改成 `grep -rq "assertIhpcPlan" .../protocol.ts`(那两个 plan 已据此校正)。同理本 Task 还导出 canonical 的 `nodeStatusToRunStatus`(CP-4 单一 node→RunRecord 状态表),C/D 一律 import 之、**不得**各留私拷贝。

**Files:**
- Create: `schemas/ihpc-plan.schema.json`, `schemas/ihpc-state.schema.json`
- Create: `mcp-server/src/ops/scheduler/seam/protocol.ts`
- Test: `mcp-server/tests/ops/scheduler/protocol.test.mjs`(Create)

- [ ] **Step 1: 落两份 schema**

Create `schemas/ihpc-plan.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "ihpc-plan.schema.json",
  "type": "object",
  "additionalProperties": true,
  "required": ["schema_version", "schema_compat_min", "campaign_id", "queue_id", "lease_owner",
               "node_id", "profile_id", "limits", "security", "policy", "jobs"],
  "properties": {
    "schema_version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "schema_compat_min": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "campaign_id": { "type": ["string", "null"], "minLength": 1 },
    "queue_id": { "type": "string", "pattern": "^sha256:[0-9a-f]{6,64}$" },
    "lease_owner": {
      "type": "object",
      "required": ["client", "device_id", "issued_at"],
      "additionalProperties": false,
      "properties": {
        "client": { "enum": ["claude", "codex"] },
        "device_id": { "type": "string", "minLength": 1 },
        "issued_at": { "type": "string", "format": "date-time" }
      }
    },
    "node_id": { "type": "string", "minLength": 1 },
    "profile_id": { "type": "string", "minLength": 1 },
    "limits": {
      "type": "object",
      "required": ["slot_count", "max_slots_per_gpu", "log_max_bytes"],
      "properties": {
        "slot_count": { "type": "integer", "minimum": 1 },
        "max_slots_per_gpu": { "type": "integer", "minimum": 1 },
        "log_max_bytes": { "type": "integer", "minimum": 1 }
      }
    },
    "security": {
      "type": "object",
      "required": ["allowed_roots", "env_key_allowlist"],
      "properties": {
        "allowed_roots": { "type": "array", "minItems": 1, "items": { "type": "string", "pattern": "^/" } },
        "env_key_allowlist": { "type": "array", "items": { "type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$" } }
      }
    },
    "policy": {
      "type": "object",
      "required": ["on_job_failure", "failure_breaker", "idle_definition", "idle_exit_seconds", "restart_throttle_seconds"],
      "properties": {
        "on_job_failure": { "enum": ["continue", "stop"] },
        "failure_breaker": {
          "type": "object",
          "required": ["max_consecutive_failures", "require_one_success"],
          "properties": {
            "max_consecutive_failures": { "type": "integer", "minimum": 1 },
            "require_one_success": { "type": "boolean" }
          }
        },
        "idle_definition": { "type": "string", "minLength": 1 },
        "idle_exit_seconds": { "type": "integer", "minimum": 1 },
        "restart_throttle_seconds": { "type": "integer", "minimum": 1 }
      }
    },
    "jobs": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["seq", "run_id", "command_argv", "workdir", "env", "gpu_index", "gpu_count", "timeout_seconds"],
        "properties": {
          "seq": { "type": "integer", "minimum": 0 },
          "run_id": { "type": "string", "minLength": 1 },
          "command_argv": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } },
          "workdir": { "type": "string", "pattern": "^/" },
          "env": { "type": "object", "additionalProperties": { "type": "string" } },
          "gpu_index": { "type": "integer", "minimum": 0 },
          "gpu_count": { "type": "integer", "minimum": 1 },
          "timeout_seconds": { "type": "integer", "minimum": 1 }
        }
      }
    }
  }
}
```

Create `schemas/ihpc-state.schema.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "ihpc-state.schema.json",
  "type": "object",
  "additionalProperties": true,
  "required": ["schema_version", "campaign_id", "queue_id", "lease_owner", "observed_at_node",
               "node_clock_epoch", "slot_count", "progressor", "health", "jobs", "counts"],
  "properties": {
    "schema_version": { "type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$" },
    "campaign_id": { "type": "string", "minLength": 1 },
    "queue_id": { "type": "string", "pattern": "^sha256:[0-9a-f]{6,64}$" },
    "lease_owner": {
      "type": "object",
      "required": ["client", "device_id"],
      "properties": { "client": { "enum": ["claude", "codex"] }, "device_id": { "type": "string" } }
    },
    "observed_at_node": { "type": "string", "format": "date-time" },
    "node_clock_epoch": { "type": "integer", "minimum": 0 },
    "slot_count": { "type": "integer", "minimum": 1 },
    "progressor": {
      "type": "object",
      "required": ["pid", "started_at_node", "heartbeat_node"],
      "properties": {
        "pid": { "type": "integer", "minimum": 2 },
        "started_at_node": { "type": "string" },
        "heartbeat_node": { "type": "string" }
      }
    },
    "health": {
      "type": "object",
      "required": ["degraded", "breaker_tripped"],
      "properties": {
        "degraded": { "type": ["string", "null"] },
        "breaker_tripped": { "type": "boolean" }
      }
    },
    "jobs": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["seq", "run_id", "status", "log"],
        "properties": {
          "seq": { "type": "integer", "minimum": 0 },
          "run_id": { "type": "string", "minLength": 1 },
          "status": { "enum": ["pending", "launching", "running", "done", "failed", "cancelled", "placement_conflict"] },
          "pid": { "type": "integer" },
          "wrapper_pid": { "type": "integer" },
          "gpu_index": { "type": "integer" },
          "exit_code": { "type": "integer" },
          "started_at_node": { "type": "string" },
          "finished_at_node": { "type": "string" },
          "log": { "type": "string" }
        }
      }
    },
    "counts": {
      "type": "object",
      "required": ["pending", "running", "done", "failed", "cancelled", "conflict"],
      "additionalProperties": { "type": "integer", "minimum": 0 }
    }
  }
}
```

- [ ] **Step 2: 写失败测试**

Create `mcp-server/tests/ops/scheduler/protocol.test.mjs`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import {
  isLeaseOwnerShape, isIhpcPlanShape, assertIhpcPlan, assertIhpcState, brainCanReadState,
  nodeStatusToRunStatus
} from "../../../dist/ops/scheduler/seam/protocol.js";

function validPlan() {
  return {
    schema_version: "1.0.0", schema_compat_min: "1.0.0",
    campaign_id: "campaign_x", queue_id: "sha256:abcdef",
    lease_owner: { client: "claude", device_id: "d1", issued_at: "2026-06-20T14:32:10Z" },
    node_id: "mars01", profile_id: "p1",
    limits: { slot_count: 2, max_slots_per_gpu: 1, log_max_bytes: 209715200 },
    security: { allowed_roots: ["/home/user/p"], env_key_allowlist: ["UTS_RUN_ID", "CUDA_VISIBLE_DEVICES"] },
    policy: { on_job_failure: "continue",
              failure_breaker: { max_consecutive_failures: 5, require_one_success: true },
              idle_definition: "no_running_and_no_launchable_pending",
              idle_exit_seconds: 604800, restart_throttle_seconds: 2 },
    jobs: [{ seq: 0, run_id: "run_a", command_argv: ["python", "t.py"], workdir: "/home/user/p",
             env: { UTS_RUN_ID: "$RUN_ID$", CUDA_VISIBLE_DEVICES: "$GPU_INDEX$" },
             gpu_index: 0, gpu_count: 1, timeout_seconds: 3600 }]
  };
}

test("isLeaseOwnerShape / isIhpcPlanShape type guards", () => {
  assert.equal(isLeaseOwnerShape({ client: "codex", device_id: "d", issued_at: "t" }), true);
  assert.equal(isLeaseOwnerShape({ client: "nope", device_id: "d", issued_at: "t" }), false);
  assert.equal(isIhpcPlanShape(validPlan()), true);
  assert.equal(isIhpcPlanShape({ ...validPlan(), jobs: [] }), false);
});

test("assertIhpcPlan accepts a well-formed plan", () => {
  assert.doesNotThrow(() => assertIhpcPlan(validPlan()));
});

test("assertIhpcPlan rejects bash -lc style (command_argv must be argv, schema minItems)", () => {
  const p = validPlan();
  p.jobs[0].command_argv = []; // empty → invalid argv
  assert.throws(() => assertIhpcPlan(p), /command_argv|jobs/i);
});

test("assertIhpcPlan rejects an env key outside env_key_allowlist", () => {
  const p = validPlan();
  p.jobs[0].env.LD_PRELOAD = "/evil.so"; // not in allowlist
  assert.throws(() => assertIhpcPlan(p), /env key .* not in env_key_allowlist|LD_PRELOAD/);
});

test("assertIhpcPlan rejects an unknown $TOKEN$ sentinel in an env value", () => {
  const p = validPlan();
  p.security.env_key_allowlist.push("UTS_SECRET");
  p.jobs[0].env.UTS_SECRET = "$NOPE$"; // unknown sentinel
  assert.throws(() => assertIhpcPlan(p), /unknown token sentinel|\$NOPE\$/);
});

test("assertIhpcPlan rejects a workdir outside allowed_roots", () => {
  const p = validPlan();
  p.jobs[0].workdir = "/etc"; // outside /home/user/p
  assert.throws(() => assertIhpcPlan(p), /workdir .* outside allowed_roots/);
});

test("assertIhpcState validates a node STATE document", () => {
  const state = {
    schema_version: "1.0.0", campaign_id: "campaign_x", queue_id: "sha256:abcdef",
    lease_owner: { client: "claude", device_id: "d1" },
    observed_at_node: "2026-06-20T14:45:30Z", node_clock_epoch: 1781966730, slot_count: 2,
    progressor: { pid: 54321, started_at_node: "2026-06-20T14:32:11Z", heartbeat_node: "2026-06-20T14:45:30Z" },
    health: { degraded: null, breaker_tripped: false },
    jobs: { "0": { seq: 0, run_id: "run_a", status: "running", log: "/x/stdout.log" } },
    counts: { pending: 0, running: 1, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  };
  assert.doesNotThrow(() => assertIhpcState(state));
});

test("nodeStatusToRunStatus is the single node→RunRecord status table (CP-4)", () => {
  // every node status maps to a live RunRecord status; placement_conflict + unknown input → "unknown"
  assert.equal(nodeStatusToRunStatus("pending"), "submitted");
  assert.equal(nodeStatusToRunStatus("launching"), "running");
  assert.equal(nodeStatusToRunStatus("running"), "running");
  assert.equal(nodeStatusToRunStatus("done"), "finished");
  assert.equal(nodeStatusToRunStatus("failed"), "failed");
  assert.equal(nodeStatusToRunStatus("cancelled"), "cancelled");
  assert.equal(nodeStatusToRunStatus("placement_conflict"), "unknown");
  assert.equal(nodeStatusToRunStatus("some_future_status"), "unknown"); // no throw on newer-node STATE
});

test("brainCanReadState enforces schema_compat_min forward-compat (§2.7)", () => {
  // 大脑自身 1.2.0;STATE 由 schema_compat_min 1.0.0 的 PLAN 产出 → 可读
  assert.equal(brainCanReadState({ planCompatMin: "1.0.0", brainVersion: "1.2.0" }), true);
  // PLAN 要求最低 1.3.0,但大脑只有 1.2.0 → 不可读(死锁破除器:大脑太旧)
  assert.equal(brainCanReadState({ planCompatMin: "1.3.0", brainVersion: "1.2.0" }), false);
  // 大版本跳(v2) → 不可读
  assert.equal(brainCanReadState({ planCompatMin: "2.0.0", brainVersion: "1.9.0" }), false);
});
```

- [ ] **Step 3: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/protocol.test.mjs mcp-server/tests/ops/scheduler/types-shape.test.mjs`
Expected: FAIL(模块不存在)。

- [ ] **Step 4: 实现 `seam/protocol.ts`**

```typescript
// seam/protocol.ts — the PLAN/STATE boundary contract (spec §2.2/§2.3/§2.7). Compiles the two grouped
// schemas with the same Ajv 2020 instance pattern as core/validation.ts, then layers the programmatic
// hardening asserts that JSON Schema cannot express: env keys must be in env_key_allowlist, env values
// may only carry KNOWN $TOKEN$ sentinels, and each job's workdir must realpath-prefix-match an
// allowed_root. Forward-compat (schema_compat_min) is the deadlock-breaker per §2.7. CLIENT-NEUTRAL:
// schemas live in schemas/, no Claude-only behavior.

import fs from "node:fs";
import type { AnySchema } from "ajv";
import * as Ajv2020Module from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import { resolveProjectPath } from "../../../core/paths.js";
import type { IhpcJobStatus, IhpcPlan, IhpcState, LeaseOwner, RunRecord } from "../../../core/types.js";

const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module.Ajv2020 }).default;
const addFormats = (addFormatsModule as unknown as { default: (ajv: InstanceType<typeof Ajv2020>) => void }).default;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(name: string): AnySchema {
  return JSON.parse(fs.readFileSync(resolveProjectPath(`schemas/${name}`), "utf8")) as AnySchema;
}

const validatePlanSchema = ajv.compile(loadSchema("ihpc-plan.schema.json"));
const validateStateSchema = ajv.compile(loadSchema("ihpc-state.schema.json"));

// The ONLY env-value sentinels the node expands (spec §2.2 "未知 $TOKEN$ 硬失败,不透传").
const KNOWN_SENTINELS = new Set(["$GPU_INDEX$", "$RUN_ID$"]);
const SENTINEL_RE = /\$[A-Z_][A-Z0-9_]*\$/g;

// THE single node-STATE-status -> RunRecord-status table (spec §2.3 vocab is the source of truth).
// Phase C (seam/reconcile.ts) and Phase D (jobs/adopt.ts) BOTH import this — they must NOT keep private
// copies of the mapping, which would silently drift (review CP-4). Every value on the right is a member
// of the live RunRecord["status"] union (core/types.ts:260, verified). placement_conflict has no
// dedicated RunRecord status, so it maps to "unknown" (the brain surfaces the conflict via STATE counts,
// not the run status). Returns "unknown" for any unrecognised input rather than throwing, so a
// newer-node STATE status never crashes an older brain's reconcile.
export function nodeStatusToRunStatus(nodeStatus: IhpcJobStatus | string): RunRecord["status"] {
  switch (nodeStatus) {
    case "pending":
      return "submitted";
    case "launching":
      return "running";
    case "running":
      return "running";
    case "done":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "placement_conflict":
      return "unknown";
    default:
      return "unknown";
  }
}

function formatErrors(errors: typeof validatePlanSchema.errors): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}

export function isLeaseOwnerShape(value: unknown): value is LeaseOwner {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.client === "claude" || v.client === "codex")
    && typeof v.device_id === "string" && v.device_id.length > 0
    && typeof v.issued_at === "string" && v.issued_at.length > 0;
}

export function isIhpcPlanShape(value: unknown): value is IhpcPlan {
  return validatePlanSchema(value) === true;
}

// realpath-style prefix containment: target equals a root or sits under root + "/".
function insideRoots(workdir: string, roots: string[]): boolean {
  return roots.some((root) => workdir === root || workdir.startsWith(root.endsWith("/") ? root : `${root}/`));
}

// Schema-validate a PLAN, then apply the hardening asserts JSON Schema cannot express.
export function assertIhpcPlan(value: unknown): asserts value is IhpcPlan {
  if (validatePlanSchema(value) !== true) {
    throw new Error(`Invalid iHPC PLAN: ${formatErrors(validatePlanSchema.errors)}`);
  }
  const plan = value as IhpcPlan;
  const allowedKeys = new Set(plan.security.env_key_allowlist);
  for (const job of plan.jobs) {
    if (!insideRoots(job.workdir, plan.security.allowed_roots)) {
      throw new Error(`PLAN job ${job.seq}: workdir ${job.workdir} is outside allowed_roots`);
    }
    for (const [key, raw] of Object.entries(job.env)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`PLAN job ${job.seq}: env key ${key} is not in env_key_allowlist`);
      }
      for (const match of raw.match(SENTINEL_RE) ?? []) {
        if (!KNOWN_SENTINELS.has(match)) {
          throw new Error(`PLAN job ${job.seq}: unknown token sentinel ${match} in env value for ${key}`);
        }
      }
    }
  }
}

export function assertIhpcState(value: unknown): asserts value is IhpcState {
  if (validateStateSchema(value) !== true) {
    throw new Error(`Invalid iHPC STATE: ${formatErrors(validateStateSchema.errors)}`);
  }
}

// §2.7 forward-compat: a v1.x brain can read any v1.y STATE produced under a PLAN whose
// schema_compat_min ≤ the brain's own schema version, within the SAME major. A major bump (v2) or a
// compat_min the brain is older than is unreadable (the brain must be upgraded / the campaign drained).
export function brainCanReadState(input: { planCompatMin: string; brainVersion: string }): boolean {
  // Compare on [major, minor] only — patch and any further components are tolerated (§2.7 "ignore
  // unknown, y ≤ self"). A missing minor defaults to 0 ("1" => 1.0); a NON-finite major/minor (garbage
  // string) is treated as UNREADABLE — fail-closed, never NaN>=NaN === false silently masking a real
  // version (review B-4).
  const parse = (v: string): { maj: number; min: number } | null => {
    const parts = v.split(".");
    const maj = Number.parseInt(parts[0] ?? "", 10);
    const min = parts.length > 1 ? Number.parseInt(parts[1] ?? "", 10) : 0;
    if (!Number.isFinite(maj) || !Number.isFinite(min)) return null;
    return { maj, min };
  };
  const plan = parse(input.planCompatMin);
  const brain = parse(input.brainVersion);
  if (!plan || !brain) return false;
  if (plan.maj !== brain.maj) return false;
  return brain.min >= plan.min;
}
```
> 注:`isIhpcPlanShape({...jobs:[]})` 因 schema 的 `jobs.minItems:1` 返回 false(Task 1 桩用到)。Task 1 的 `types-shape.test.mjs` import 的 `isIhpcPlanShape`/`isLeaseOwnerShape` 此处已实现,故两测试文件此 Task 后一起绿。

- [ ] **Step 5: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/protocol.test.mjs mcp-server/tests/ops/scheduler/types-shape.test.mjs`
Expected: PASS(两文件全绿)。

- [ ] **Step 6: Commit**

```bash
git add schemas/ihpc-plan.schema.json schemas/ihpc-state.schema.json \
  mcp-server/src/ops/scheduler/seam/protocol.ts \
  mcp-server/tests/ops/scheduler/protocol.test.mjs mcp-server/tests/ops/scheduler/types-shape.test.mjs
git commit -m "feat(scheduler): seam/protocol PLAN/STATE schema + env-allowlist/token/realpath asserts + compat (spec §2.2/§2.3/§2.7)"
```

---

## Task 6:`control/lease.ts`——per-`(profile,node)` 单写者 lease 决策

§3.2:`SchedulerLock`(`O_CREAT|O_EXCL` + 陈旧 PID 检测,`lock.py:50`)重新实例化为 per-`(profile,node)` 单写者 lease。本阶段是**大脑侧纯决策**:acquire(无 lease → 取)、refresh(自己持有 → 续)、staleness(按心跳 age 判死)、takeover(陈旧 → 新大脑接管)。lease.json 的实际节点写经 `seam/protocol`/`sshWriteAtomicJson`,节点侧执行(拒绝 `lease_owner` 不符的 PLAN)在 Phase C。lease age 按**节点钟**(spec §2.3 时钟规则:大脑不做跨钟相减),本函数取 `nodeNowEpoch` 与 `heartbeatEpoch` 都是节点侧量。

**Files:**
- Create: `mcp-server/src/ops/scheduler/control/lease.ts`
- Test: `mcp-server/tests/ops/scheduler/lease.test.mjs`(Create)

- [ ] **Step 1: 写失败测试**

Create `mcp-server/tests/ops/scheduler/lease.test.mjs`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { decideLease, isLeaseStale } from "../../../dist/ops/scheduler/control/lease.js";

const me = { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" };
const other = { client: "codex", device_id: "desktop-9", issued_at: "2026-06-20T14:00:00Z" };

test("decideLease=acquire when no lease exists", () => {
  const d = decideLease({ held: null, me, nodeNowEpoch: 1000, heartbeatEpoch: null, staleSeconds: 120 });
  assert.equal(d.action, "acquire");
});

test("decideLease=refresh when we already hold it", () => {
  const d = decideLease({ held: me, me, nodeNowEpoch: 1000, heartbeatEpoch: 990, staleSeconds: 120 });
  assert.equal(d.action, "refresh");
});

test("decideLease=blocked when a LIVE other holder owns it", () => {
  const d = decideLease({ held: other, me, nodeNowEpoch: 1000, heartbeatEpoch: 980, staleSeconds: 120 });
  assert.equal(d.action, "blocked");
  assert.equal(d.holder.client, "codex");
});

test("decideLease=takeover when the other holder's lease is STALE (dead)", () => {
  // heartbeat 800,now 1000 → age 200 > 120 → stale → 接管
  const d = decideLease({ held: other, me, nodeNowEpoch: 1000, heartbeatEpoch: 800, staleSeconds: 120 });
  assert.equal(d.action, "takeover");
});

test("isLeaseStale uses node-clock age only (no cross-clock subtraction)", () => {
  assert.equal(isLeaseStale({ nodeNowEpoch: 1000, heartbeatEpoch: 800, staleSeconds: 120 }), true);
  assert.equal(isLeaseStale({ nodeNowEpoch: 1000, heartbeatEpoch: 950, staleSeconds: 120 }), false);
  assert.equal(isLeaseStale({ nodeNowEpoch: 1000, heartbeatEpoch: null, staleSeconds: 120 }), true); // no heartbeat → stale
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/lease.test.mjs`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 `control/lease.ts`**

```typescript
// control/lease.ts — brain-side single-writer LEASE decision per (profile, node) (spec §3.2). Two
// clients (Claude Code + Codex) across possibly multiple devices would otherwise both pre-account, both
// write a PLAN (atomic rename = last-writer-wins => silent queue clobber), and both start progressors =>
// double placement. This re-instantiates the vendored SchedulerLock (O_CREAT|O_EXCL + stale-pid
// detection, lock.py:50) as a lease whose holder is a LeaseOwner. This module is PURE DECISION: the
// node-side write (sshWriteAtomicJson) and the node-side enforcement (progressor refuses a PLAN whose
// lease_owner != current holder) are Phase C. Staleness uses NODE-clock age only — never a laptop-now
// minus node-timestamp subtraction (spec §2.3 clock rule).

import type { LeaseOwner } from "../../../core/types.js";

export interface LeaseStalenessInput {
  nodeNowEpoch: number;          // node clock "now" (e.g. a fresh node-side epoch read)
  heartbeatEpoch: number | null; // the holder's last heartbeat, node clock; null when never seen
  staleSeconds: number;          // age beyond which the holder is presumed dead
}

export interface LeaseDecisionInput extends LeaseStalenessInput {
  held: LeaseOwner | null; // current on-node lease holder, or null when unheld
  me: LeaseOwner;          // this brain's identity
}

export type LeaseDecision =
  | { action: "acquire" }                    // no holder — take it
  | { action: "refresh" }                    // we already hold it — renew
  | { action: "takeover"; from: LeaseOwner } // a STALE other holder — adopt in-flight work (§3.2/§5c)
  | { action: "blocked"; holder: LeaseOwner }; // a LIVE other holder — refuse, do not clobber

// A lease with no heartbeat, or whose node-clock heartbeat age exceeds staleSeconds, is stale.
export function isLeaseStale(input: LeaseStalenessInput): boolean {
  if (input.heartbeatEpoch === null) return true;
  return input.nodeNowEpoch - input.heartbeatEpoch > input.staleSeconds;
}

function sameOwner(a: LeaseOwner, b: LeaseOwner): boolean {
  return a.client === b.client && a.device_id === b.device_id;
}

export function decideLease(input: LeaseDecisionInput): LeaseDecision {
  if (!input.held) return { action: "acquire" };
  if (sameOwner(input.held, input.me)) return { action: "refresh" };
  if (isLeaseStale(input)) return { action: "takeover", from: input.held };
  return { action: "blocked", holder: input.held };
}
```

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/lease.test.mjs`
Expected: PASS(5 测试全绿)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/scheduler/control/lease.ts mcp-server/tests/ops/scheduler/lease.test.mjs
git commit -m "feat(scheduler): control/lease single-writer lease decision (node-clock staleness, spec §3.2)"
```

---

## Task 7:`control/plan.ts`——`planNextBatch()` 合成 PLAN

§3.4:`planNextBatch()` → lease + 队列 + placement + quota gate → 发 `IhpcPlan`。串起 Task 3-6:先看 lease 决策(非 acquire/refresh/takeover ⇒ 不发 plan);用 `launchableBatch` 取本批 run;用 `reserveSlots` 预记账分配 gpu_slot;quota gate 用既有 `checkIhpcNodePoolConformance`(`conformance.ts:268`)守 ban-关键限额;合成 `IhpcPlan` 并经 `assertIhpcPlan` 自校验。**只返回 plan + placements,不写盘、不起推进器**(§3.3 流水线里 `seam/launch.ts` 那一步是 Phase C)。

> **`gpu_slot` 写路径(review B-2):** `RunRecord.placement.gpu_slot`(Task 1 加的字段)必须真被写,否则是死字段。`reserveSlots` 返回的 `GpuSlotAllocation{node_id,gpu_index,gpu_slot}` 不能丢 `gpu_slot`。本 Task 让 `planNextBatch` 返回 `{ plan, placements }`——`placements[i]` 与 `plan.jobs[i]` 按下标对齐,携带 `gpu_slot`。Phase C 的 `seam/launch.ts buildRunRecord` 据此把 `placement.gpu_slot` 写进 RunRecord(C 计划已据此接线)。`gpu_slot` **不进 PLAN job**(PLAN 只给节点 `gpu_index`;slot 序号是大脑侧记账产物,属 RunRecord 观测面),故 schema 不变。

**Files:**
- Create: `mcp-server/src/ops/scheduler/control/plan.ts`
- Test: `mcp-server/tests/ops/scheduler/plan.test.mjs`(Create)

- [ ] **Step 1: 写失败测试**

Create `mcp-server/tests/ops/scheduler/plan.test.mjs`:
```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { planNextBatch } from "../../../dist/ops/scheduler/control/plan.js";
import { assertIhpcPlan } from "../../../dist/ops/scheduler/seam/protocol.js";

const me = { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" };
const node = { node_id: "mars01", gpu_indices: [0, 1], max_slots_per_gpu: 1 };

function jobRec(run_id, queue_position) {
  return {
    run_id, status: "planned", queue_position, campaign_id: "c1", profile_id: "p1",
    command_argv: ["python", "train.py", "--lr", "0.01"], workdir: "/home/user/p",
    env: { UTS_RUN_ID: "$RUN_ID$", CUDA_VISIBLE_DEVICES: "$GPU_INDEX$" }, timeout_seconds: 3600
  };
}

function baseInput(overrides = {}) {
  return {
    campaignId: "c1", profileId: "p1", node,
    me, lease: { action: "acquire" },
    maxConcurrent: 4, slotCount: 2,
    allowedRoots: ["/home/user/p"],
    envKeyAllowlist: ["UTS_RUN_ID", "CUDA_VISIBLE_DEVICES"],
    nodeLimits: [{ families: ["mars"], limit: 2 }],
    activeNodes: [],
    records: [jobRec("run_a", 0), jobRec("run_b", 1), jobRec("run_c", 2)],
    held: [],
    ...overrides
  };
}

test("planNextBatch emits a schema-valid PLAN + aligned placements for the launchable batch", () => {
  const { plan, placements } = planNextBatch(baseInput());
  assert.doesNotThrow(() => assertIhpcPlan(plan));
  assert.equal(plan.campaign_id, "c1");
  assert.equal(plan.node_id, "mars01");
  assert.deepEqual(plan.lease_owner, me);
  // slot_count=2 / 2 GPUs → 只有 run_a,run_b 进 plan(run_c 留 pending)
  assert.deepEqual(plan.jobs.map((j) => j.run_id), ["run_a", "run_b"]);
  assert.deepEqual(plan.jobs.map((j) => j.gpu_index), [0, 1]);
  // placements 与 jobs 按下标对齐,且携带 gpu_slot(B-2:gpu_slot 的写路径起点)
  assert.equal(placements.length, plan.jobs.length);
  assert.deepEqual(placements.map((p) => p.gpu_index), [0, 1]);
  assert.deepEqual(placements.map((p) => p.gpu_slot), [0, 0]); // 每 GPU 第 0 个 slot(max_slots_per_gpu=1)
  // queue_id 是内容 hash
  assert.match(plan.queue_id, /^sha256:[0-9a-f]+$/);
});

test("planNextBatch returns null when the lease is blocked (a live other holder)", () => {
  const result = planNextBatch(baseInput({ lease: { action: "blocked", holder: { client: "codex", device_id: "d" } } }));
  assert.equal(result, null);
});

test("planNextBatch refuses when the node-pool quota gate fails (ban-critical)", () => {
  // 已持有 2 个 mars 节点 + 目标 mars01 → 第 3 个 → 超 limit 2
  assert.throws(
    () => planNextBatch(baseInput({ activeNodes: [{ node: "mars02" }, { node: "mars03" }] })),
    /node-pool|conformance/i
  );
});

test("planNextBatch is deterministic: same input → same queue_id", () => {
  const a = planNextBatch(baseInput());
  const b = planNextBatch(baseInput());
  assert.equal(a.plan.queue_id, b.plan.queue_id);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/plan.test.mjs`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 `control/plan.ts`**

```typescript
// control/plan.ts — planNextBatch(): the brain's online decision that fuses lease + queue + placement +
// quota gate into an immutable PLAN (spec §3.3 pipeline). It RETURNS the IhpcPlan object (self-validated
// via assertIhpcPlan); it does NOT write to the node or start the progressor — that is seam/launch.ts in
// Phase C. queue_id is a sha256 of the canonical plan content (minus itself), so the same campaign state
// yields the same immutable plan (seq-keyed resume requires per-queue_id immutability, spec §2.2).

import { createHash } from "node:crypto";
import { stableJson } from "../../../lib/shared.js";
import { checkIhpcNodePoolConformance } from "../../quotas/conformance.js";
import { launchableBatch } from "./queue.js";
import { reserveSlots, type GpuSlotAllocation, type NodeTopology } from "./placement.js";
import { assertIhpcPlan } from "../seam/protocol.js";
import type { IhpcPlan, IhpcPlanJob, LeaseOwner, RunRecord } from "../../../core/types.js";
import type { LeaseDecision } from "./lease.js";

const SCHEMA_VERSION = "1.0.0";
const SCHEMA_COMPAT_MIN = "1.0.0";

// A queue entry: a RunRecord plus the node-launch fields the brain has resolved for it.
// PRODUCER (review B-3): these four per-run launch fields are stamped onto the record by the PLAN-job
// producer at enqueue time — `jobs.plan` / `sweep_plan` (ops/plans/planner.ts, ops/sweep.ts), which
// already expand sweep params into a concrete argv + workdir + env + timeout per run. `planNextBatch`
// is a pure CONSUMER: it never derives argv from sweep params itself. So a caller MUST pass
// QueueRunRecord[] (records already carrying these fields), not bare RunRecord[]; passing a record that
// lacks command_argv yields an `assertIhpcPlan` failure (empty/undefined argv) — fail-loud, by design.
// The fields are launch inputs, NOT persisted RunRecord columns: they live on the queue entry the brain
// holds in memory while planning, and flow into PLAN.jobs[] — they are not added to core/types.ts
// RunRecord (which stays the persisted shape). Phase C's seam/launch.ts reads PLAN.jobs[] for them.
export type QueueRunRecord = RunRecord & {
  command_argv: string[];
  workdir: string;
  env: Record<string, string>;
  timeout_seconds: number;
};

export interface PlanNextBatchInput {
  campaignId: string;
  profileId: string;
  node: NodeTopology;
  me: LeaseOwner;
  lease: LeaseDecision;
  maxConcurrent: number;
  slotCount: number;
  allowedRoots: string[];
  envKeyAllowlist: string[];
  nodeLimits?: Array<{ families: string[]; limit: number }>;
  activeNodes?: Array<{ node?: string; family?: string }>;
  records: QueueRunRecord[];
  // placements already held by running work (for placement pre-accounting).
  held: Array<{ gpu_index?: number }>;
  // policy knobs with spec §2.2 defaults.
  logMaxBytes?: number;
  idleExitSeconds?: number;
  restartThrottleSeconds?: number;
  maxConsecutiveFailures?: number;
}

// The brain's plan output: the immutable PLAN plus the per-job slot allocations (placements[i] aligns
// with plan.jobs[i] by index). placements carries gpu_slot, which Phase C seam/launch.ts stamps onto
// each RunRecord.placement.gpu_slot (review B-2 — the field must actually be written, not left dead).
export interface PlanNextBatchResult {
  plan: IhpcPlan;
  placements: GpuSlotAllocation[];
}

// Returns null when the lease forbids writing (blocked by a live other holder). Throws when the
// ban-critical node-pool quota gate refuses. Otherwise returns the immutable PLAN + aligned placements.
export function planNextBatch(input: PlanNextBatchInput): PlanNextBatchResult | null {
  if (input.lease.action === "blocked") {
    return null;
  }

  // HARD per-account node-pool gate (the ban-prevention) BEFORE placing anything (spec §3.3 GATE step).
  const poolConformance = checkIhpcNodePoolConformance({
    targetNode: input.node.node_id,
    nodeLimits: input.nodeLimits,
    activeNodes: input.activeNodes ?? []
  });
  if (!poolConformance.conforms) {
    const detail = poolConformance.violations.map((violation) => violation.message).join("; ");
    throw new Error(`iHPC node-pool conformance failed for ${input.profileId}: ${detail}`);
  }

  const batch = launchableBatch(input.records, {
    maxConcurrent: input.maxConcurrent,
    campaignId: input.campaignId
  });
  const placements = reserveSlots(input.node, batch.length, input.held);

  const jobs: IhpcPlanJob[] = [];
  placements.forEach((placement, index) => {
    const record = batch[index];
    jobs.push({
      seq: index,
      run_id: record.run_id,
      command_argv: record.command_argv,
      workdir: record.workdir,
      env: record.env,
      gpu_index: placement.gpu_index,
      gpu_count: 1,
      timeout_seconds: record.timeout_seconds
    });
  });

  const planWithoutQueueId = {
    schema_version: SCHEMA_VERSION,
    schema_compat_min: SCHEMA_COMPAT_MIN,
    campaign_id: input.campaignId,
    lease_owner: input.me,
    node_id: input.node.node_id,
    profile_id: input.profileId,
    limits: {
      slot_count: input.slotCount,
      max_slots_per_gpu: input.node.max_slots_per_gpu,
      log_max_bytes: input.logMaxBytes ?? 209715200
    },
    security: { allowed_roots: input.allowedRoots, env_key_allowlist: input.envKeyAllowlist },
    policy: {
      on_job_failure: "continue" as const,
      failure_breaker: {
        max_consecutive_failures: input.maxConsecutiveFailures ?? 5,
        require_one_success: true
      },
      idle_definition: "no_running_and_no_launchable_pending",
      idle_exit_seconds: input.idleExitSeconds ?? 604800,
      restart_throttle_seconds: input.restartThrottleSeconds ?? 2
    },
    jobs
  };
  const queueId = `sha256:${createHash("sha256").update(stableJson(planWithoutQueueId)).digest("hex")}`;
  const plan: IhpcPlan = { ...planWithoutQueueId, queue_id: queueId };

  assertIhpcPlan(plan);
  // placements is the slice actually consumed (one per emitted job, gpu_slot-carrying); Phase C threads
  // each onto its RunRecord.placement.gpu_slot. queue_id is hashed over the PLAN only — placements are a
  // brain-side by-product and are NOT part of the immutable plan content (so they never perturb the hash).
  return { plan, placements: placements.slice(0, jobs.length) };
}
```
> 注:`launchableBatch` 的 `room` 可能大于 `placements.length`(并发上限 > 物理 slot),故 `jobs` 以 `placements.length` 为界(`forEach` 遍历 placements),把 run 数收敛到真实空 slot——这正是「预记账防自己超订自己」。`stableJson` 来自 `lib/shared.ts`(planner.ts:2 已用),保证 `queue_id` 确定性。返回的 `placements`(切到 `jobs.length`)与 `plan.jobs` 同长同序,`placements[i].gpu_slot` 即 `plan.jobs[i]` 对应 run 的 slot 序号,供 Phase C 写 RunRecord(B-2)。

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler/plan.test.mjs`
Expected: PASS(4 测试全绿)。

- [ ] **Step 5: 全套件回归**

Run: `npm test 2>&1 | tail -5`
Expected:全绿(新增 6 个 scheduler 测试文件 + ssh-atomic 并入,~485 → 更高;无既有测试回归)。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/scheduler/control/plan.ts mcp-server/tests/ops/scheduler/plan.test.mjs
git commit -m "feat(scheduler): control/plan planNextBatch fuses lease+queue+placement+quota gate -> immutable PLAN (spec §3.3)"
```

---

## Phase B 退出条件

- [ ] `mcp-server/src/ops/scheduler/control/{placement,queue,lease,plan}.ts` + `seam/protocol.ts` 存在并全绿。
- [ ] `schemas/ihpc-plan.schema.json` + `schemas/ihpc-state.schema.json` 存在,被 `protocol.ts` 经 Ajv 2020 编译(同 `core/validation.ts` 模式)。
- [ ] `core/types.ts`:RunRecord 有 `queue_position`/`lease_owner`/`auto_progressed`/`attempt`;`placement.gpu_slot` 与 `supervisor.pid`(progressor 复用)就位;`LeaseOwner`/`IhpcPlan`(`campaign_id: string | null`,CP-5)/`IhpcState`/`IhpcPlanJob`/`IhpcStateJob`(含 `wrapper_pid?`,CP-3)/`IhpcJobStatus` 已导出。
- [ ] 跨阶段契约 pin:`seam/protocol.ts` 导出 canonical `assertIhpcPlan`/`assertIhpcState`(无 `assertValid*` 别名,CP-1)+ canonical `nodeStatusToRunStatus`(单一 node→RunRecord 状态表,CP-4);`planNextBatch` 返回 `{ plan, placements }`,`placements[i].gpu_slot` 喂 Phase C 写 RunRecord(CP-B-2);STATE schema 含 `jobs.<seq>.wrapper_pid`(供 D 死推进器 adopt 取 supervisor-of-record pid,CP-3)。
- [ ] `lib/ssh.ts`:`ATOMIC_WRITE_PY`(fsync(file)→rename→fsync(dir) 顺序)+ `sshWriteAtomicJsonArgs` 就位。
- [ ] `planNextBatch` 在 lease blocked 时返回 null;在 node-pool gate 失败时 throw;成功时返回 `assertIhpcPlan` 通过且 `queue_id` 确定性的 PLAN。
- [ ] PLAN 加固断言:空 `command_argv`、allowlist 外 env key、未知 `$TOKEN$`、`allowed_roots` 外 workdir 全被拒。
- [ ] `brainCanReadState` 实现 §2.7 前向兼容(同大版本 minor ≤ 自身可读,大版本跳/太旧不可读)。
- [ ] `npm test` 绿;**无任何节点部署/SSH 真连/推进器/reconcile/节点 lease 执行代码**(全留 Phase C)。

## 自查(spec 覆盖)

- §2.2 PLAN(grouped top/limits/security/policy/jobs)→ `IhpcPlan` 接口 + `ihpc-plan.schema.json` + `assertIhpcPlan` ✓;设计点:`command_argv` 非空 argv(schema minItems + 测试)✓、`env_key_allowlist` 强制(断言)✓、`$TOKEN$` 白名单硬失败(断言)✓、`allowed_roots` 复校(断言)✓、`queue_id` 内容 hash 不可变(`planNextBatch`)✓、砍 `depends_on`(seq 排序)✓、`schema_compat_min`(`brainCanReadState`)✓。
- §2.3 STATE(grouped top/progressor/health/jobs/counts)+ 状态词表 → `IhpcState`/`IhpcStateJob`/`IhpcJobStatus` + `ihpc-state.schema.json` + `assertIhpcState` ✓;durable rename(file fsync→rename→dir fsync)→ `ATOMIC_WRITE_PY` ✓。
- §2.7 schema 前向兼容(死锁破除器)→ `brainCanReadState` ✓。
- §3.1 移进 TS:placement 记账优先(移植 `virtual_gpu_counts` :265-266/:324-325,SSH nvidia-smi 仅注入)→ `control/placement.ts` ✓;队列推进策略 → `control/queue.ts` ✓;quota gate「PLAN 写前检查」复用既有 `checkIhpcNodePoolConformance` → `control/plan.ts` ✓。
- §3.2 单写者 lease(重实例化 `SchedulerLock`,per-`(profile,node)`,节点钟陈旧检测,takeover)→ `control/lease.ts` ✓;节点侧执行(拒绝不符 lease 的 PLAN)**刻意留 Phase C**(退出条件已注明)。
- §3.3 融合流水线 → `planNextBatch` 串 lease+queue+placement+quota,返回 PLAN;`seam/launch` 写盘起推进器**留 Phase C** ✓。
- §3.4 新增/改动 TS 表逐行覆盖;`core/types.ts` 字段并入既有 `placement{}`/`supervisor{}` 不重复建块 ✓;`lib/ssh.ts` `sshWriteAtomicJson` ✓。`seam/contract.ts`(Phase A)、`node/progressor.py`/`seam/launch.ts`/`seam/reconcile.ts`(Phase C)、`jobs.ts` 接 reconcile(Phase C)**均不在本阶段**。
- §5a lineage 字段(`auto_progressed{by_node_agent,freed_by_run_id}`、`attempt`)→ RunRecord 已扩,供 Phase C reconcile/adopt 写入 ✓。
- §8 客户端中立:schema 入 `schemas/`、`seam/protocol` 为内部模块(被 control 调用,不新增 MCP 工具面)✓。

**跨阶段一致性(review 落项):**
- CP-1:`assertIhpcPlan`/`assertIhpcState` 定为 canonical(无 `assertValid*` 别名);Task 5 加 PIN 注,C/D import 之、C 的 Step 0 grep 已据此校正 ✓。
- CP-3:`IhpcStateJob.wrapper_pid?` + STATE schema `jobs.<seq>.wrapper_pid` 落地——区分「内层 job pid」与「per-slot wrapper/supervisor-of-record pid」,D 死推进器 adopt 取后者,不再用死 progressor pid ✓。
- CP-4:`nodeStatusToRunStatus` 单一映射表导出自 `seam/protocol.ts`(每个右值经核对属 live `RunRecord["status"]` 并集),C/D import、不留私拷贝;含 unknown 回退不抛 ✓。
- CP-5:`IhpcPlan.campaign_id: string | null`(schema 仍 `required` 但类型容 null),C 的单跑 fast path 复用 canonical `IhpcPlan` 而非私有 `PlanObject` ✓。
- CP-6:`queue.ts` 注释引 live `RunRecord["status"]` 并集(core/types.ts:260,已核对 `submitting|submitted|running|planned|finished|failed|cancelled|unknown` 全在)✓。
- B-2:`gpu_slot` 写路径——`planNextBatch` 返回 `{plan, placements}`,`placements[i].gpu_slot` 对齐 `plan.jobs[i]`,Phase C 写 `RunRecord.placement.gpu_slot`(字段不再死)✓。
- B-3:`QueueRunRecord` 的 `command_argv`/`workdir`/`env`/`timeout_seconds` 生产者已注明 = `jobs.plan`/`sweep_plan`(planner.ts/sweep.ts)在入队时 stamp;`planNextBatch` 仅消费,缺字段则 `assertIhpcPlan` fail-loud ✓。
- B-4:`brainCanReadState` 用 `Number.isFinite` 守解析,垃圾版本号 fail-closed,不再 NaN>=NaN 静默放行 ✓。
- B-5:`ssh-atomic` golden 改用导出常量 `SSH_INNER_HOP_HOST_KEY` 的尾段 slice + `-T` 两跳复核,Task 2 加 Step 0 复核 live `sshSupervisorArgs` 形状 ✓。

**刻意不做(留后续阶段,非遗漏):** 节点 `progressor.py`、`seam/launch.ts`、`seam/reconcile.ts`、`jobs.track → reconcile` 接线、节点 lease.json 物理写与执行、真实节点 smoke、崩溃注入 harness——全 Phase C。Feature B(`jobs.adopt` 两轴信任)—— Phase D。
