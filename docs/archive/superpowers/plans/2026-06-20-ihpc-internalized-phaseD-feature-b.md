# iHPC 内化 — Phase D(Feature B:`jobs.adopt` 两轴信任)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现。步骤用 checkbox(`- [ ]`)跟踪。

**Goal:** 把 `jobs.adopt` 从今天的「iHPC = history-only 占位」(`adopt.ts:82` `ihpcPidToRunRecord` 的 Phase 1 注释)升级为 **spec §5 的两轴信任收养**:(a) **我们的推进器从我们 PLAN 起的作业** → 经 `queue_id`/`run_id`/`lease_owner` 证 lineage,合成 supervisor block,adopt 执行事实为权威(`terminal_record: agent_authored` + `intent: user_declared`),`jobs.status/logs/cancel` 走我们路径;(b) **发现的非我们启动作业** → `not_lineage_proven` + history-only,full realpath gate,read/cancel 路径拒绝;(c) **我们自己死推进器但活作业** → 复用 (a) lineage-proven 路径 + 重起推进器 resume(接进 `reconcileIhpcCampaign`)。

**Architecture:** 不新增 MCP 工具面——泛化既有 `ops/jobs/adopt.ts`(沿 `pbsRowToRunRecord`/`ihpcPidToRunRecord` 原语模式)新增第三个原语 `ihpcStateJobToRunRecord`(把 STATE 文件里一条 lineage-proven 的 job 项转成带 supervisor + provenance 的 RunRecord),并在 `adoptExternalRun` 增加一条 lineage-proven 收养路径。provenance 标志(`terminal_record`/`intent`/`lineage`)落进 RunRecord 新字段 `adoption{}`(spec §5 两轴),schema + 校验 + redaction 同步。node→RunRecord status 映射不在本阶段重复手抄——`nodeStatusToRunStatus` 由 Phase B `seam/protocol.ts` 落地一份(spec §2.3 词表的唯一来源),本阶段的原语与 Phase C 的 `reconcile.ts` 都 import 它(见 CP-4 / Task 2 Step 0)。(c) 死推进器路径:Phase C 的 `reconcileIhpcCampaign`(`seam/reconcile.ts`)今天的 dead-progressor-but-live-jobs 分支**只 relaunch、不合成 RunRecord**;本阶段**为该分支新增** lineage-proven adopt 循环(对每条活作业证血缘 → `ihpcStateJobToRunRecord` 合成带真实 supervisor 的记录 → 写盘 → relaunch resume),并给 `reconcile.ts` 的 `ReconcileDeps` 补 `auditDir` + adopt 所需注入项。这不是「接线一个已存在的 adopt 调用」,而是把收养逻辑加进原本只重起的分支(见 Task 5 / CP-2 / CP-3)。`jobs.status/logs/cancel` 对 lineage-proven iHPC 记录放行(因为现在有真实 supervisor block,通过 `requireIhpcSupervisor` 的既有 gate,`jobs.ts:1013`)。

**Tech Stack:** TypeScript(ES modules、Ajv);`node --test` 跑 `mcp-server/tests/**/*.mjs`(import 自 `../../dist/...js`,**先 `npm run build`**)。依据 spec:`docs/superpowers/specs/2026-06-20-ihpc-scheduler-internalized-design.md` §5(Feature B 两轴信任)、§2.3(STATE schema + 终止标记)、§3.2(lease)、§2.6(恢复:dead-progressor-but-live-jobs)。

**前置阶段(必须已落地):** Phase A(lease、契约、deploy 加硬)、Phase B(`control/*`、`seam/protocol.ts` 的 PLAN/STATE Ajv schema + `assertIhpcState`/`assertIhpcPlan` + **共享 `nodeStatusToRunStatus` 导出(CP-4)**、`ihpc-state.schema.json` 的 `jobs[<seq>].wrapper_pid`(**CP-3**)、RunRecord 新字段 `+queue_position/+lease_owner/+auto_progressed/+attempt`、`lib/ssh.ts` `sshWriteAtomicJson`)、Phase C(`seam/launch.ts`、`seam/reconcile.ts` `reconcileIhpcCampaign` + dead-progressor-but-live-jobs 分支、`node/progressor.py` **写 `wrapper_pid` 到 STATE**、`jobs.track → reconcileIhpcCampaign` 接线、单次快路径)。Phase D **以 Feature A 为前提**(spec §5 末:「必须先信任部署的 agent 版本——锁+契约+lease——才信任它写的 state」)。**跨阶段 seam canonical 命名**(`assertIhpcState`、`reconcileIhpcCampaign({campaignId,profileId,node})`、deps `{auditDir,readState,progressorAlive,relaunchProgressor}`、`wrapper_pid`、共享 `nodeStatusToRunStatus`)见下「跨阶段 seam 契约」节;本阶段 Task 5 Step 1 会把 Phase C 改齐到 canonical。

**基线:** 全套 `npm test` 当前应绿(Phase C 之后 ~485+,以实际为准)。每个 Task 末尾 commit;不 push(控制器统一处理)。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `mcp-server/src/core/types.ts` | RunRecord 增 `adoption{}`(两轴 provenance) | **Modify**(新增可选块,勿动既有 supervisor/placement) |
| `schemas/run-record.schema.json` | run-record schema 加 `adoption` 块 | **Modify**(`additionalProperties:false` 顶层须显式加属性) |
| `mcp-server/src/core/config.ts` | redaction:`adoption` 只 disclose 标志,不泄路径/device | **Modify**(若 redactRunRecord 存在则白名单该块) |
| `mcp-server/src/ops/jobs/adopt.ts` | 新原语 `ihpcStateJobToRunRecord` + `adoptExternalRun` 的 lineage-proven 路径 | **Modify** |
| `mcp-server/src/ops/scheduler/seam/reconcile.ts` | seam 改 canonical 名(CP-1/2/4)+ dead-progressor-but-live-jobs 分支**新增** lineage-proven adopt 循环(`wrapper_pid`,CP-3)+ relaunch | **Modify**(Phase C 已建该文件) |
| `mcp-server/src/ops/jobs/jobs.ts` | Task 6 适配器 `reconcileIhpcCampaignRunStatus` 实参随 canonical 改名(`profileId`/`node`/`auditDir`) | **Modify**(随 Task 5 Step 1) |
| `mcp-server/src/index.ts` | `jobs.adopt` 工具描述更新两轴信任语义(无新工具) | **Modify** |
| `mcp-server/tests/ops/adopt-primitives.test.mjs` | `ihpcStateJobToRunRecord` 单测 | **Modify**(追加) |
| `mcp-server/tests/ops/jobs-adopt.test.mjs` | lineage-proven 收养 + (b) history-only 拒绝 read/cancel | **Modify**(追加) |
| `mcp-server/tests/ops/scheduler/reconcile-adopt.test.mjs` | (c) dead-progressor-but-live-jobs 经 adopt 原语恢复 | **Create** |

---

## 共享接口契约(本阶段消费,逐字对齐 spec)

- STATE schema(spec §2.3,由 Phase B `seam/protocol.ts` 落地)顶层 `{schema_version, campaign_id, queue_id, lease_owner, observed_at_node, node_clock_epoch, slot_count}`;`progressor{pid, started_at_node, heartbeat_node}`;`health{degraded, breaker_tripped}`;`jobs{<seq>:{seq, run_id, status, pid, wrapper_pid, gpu_index, exit_code?, started_at_node, finished_at_node?, log}}`(`wrapper_pid` 由 CP-3 新增,Phase B schema + Phase C progressor 落地);`counts{...}`。
- `lease_owner: {client, device_id, issued_at}`(PLAN 侧)/ STATE 侧 `{client, device_id}`。
- status 词表:`pending|launching|running|done|failed|cancelled|placement_conflict`(节点侧)→ 映射到 RunRecord status `submitted|running|finished|failed|cancelled|unknown`(`pending→submitted`)。映射函数 `nodeStatusToRunStatus` 由 Phase B `seam/protocol.ts` 单一导出(CP-4),本阶段 import 复用,不另抄一份。
- RunRecord 新 `adoption{}`(本阶段新增,spec §5 两轴):`{terminal_record: "agent_authored"|"external_observed", intent: "user_declared"|"unverified", lineage: "lineage_proven"|"not_lineage_proven", queue_id?, adopted_at}`。
- lineage 证明 = STATE 顶层 `queue_id` + `lease_owner` 与我们持有的 RunRecord(`run_record.queue_id`?/`run_record.lease_owner`,Phase B 已加)匹配,且 STATE `jobs[seq].run_id` 命中一条我们持有的 run。

### 跨阶段 seam 契约(BLOCKER 钉子 —— C/D 必须一致,本阶段以此为准)

一致性评审标出 4 个跨阶段 BLOCKER,直接影响本阶段消费的 seam。**以下命名/形参为 canonical**;Phase C 的 `seam/reconcile.ts`、`seam/launch.ts`、Phase B 的 `seam/protocol.ts` 必须对齐(评审建议:消费侧 D 的命名更统一,故取 D 为准,C 改之)。本阶段所有 Task 按此 canonical 写;若执行时 Phase C 仍是旧名,**先改 C 对齐,再跑本阶段**(在 Task 5 Step 1 一次性确认+对齐),不要在本阶段反向迁就旧名。

- **CP-1 — `protocol.ts` 校验导出名**:canonical = `assertIhpcPlan` / `assertIhpcState`(与 Phase B 的 `isIhpcPlanShape` 同族;Phase B 已导出此名)。Phase C 当前 import 的 `assertIhpcPlan`/`assertIhpcState`(`launch.ts`、`reconcile.ts`)与 Step 0 grep(`grep -rq "assertIhpcPlan\|validatePlan"`)是**错的**,执行 C 时须改为 `assertIhpcPlan`/`assertIhpcState`。本阶段不直接 import 这两个断言(走 audit + reconcile),但 Task 5 的 reconcile 接线依赖 C 已对齐。
- **CP-2 — `reconcileIhpcCampaign` 签名**:canonical input = `{ campaignId: string; profileId: string; node: string; runRecords?: ... }`;canonical deps = `{ now, auditDir, readState, progressorAlive, relaunchProgressor, persistRunRecord? }`。即 **`profileId`(非 `profile`)、`node`(非 `nodeId`)、`progressorAlive`(非 `progressorAlive`)、`relaunchProgressor`(非 `relaunchProgressor`)**,并给 `ReconcileDeps` 加 **`auditDir`**(本阶段 adopt 循环写 RunRecord 用)。Phase C 的 `ReconcileInput`/`ReconcileDeps` + Task 6 的 `reconcileIhpcCampaignRunStatus` 适配器须改为此形。
- **CP-3 — campaign 作业的 "supervisor of record" pid**:dead-progressor 路径里 `state.progressor.pid` 是**死推进器**的 pid,不能作 supervisor block 的 pid(否则 supervisor 指向尸体)。canonical 决定:**STATE `jobs[<seq>]` 须带 `wrapper_pid`**(该 slot 的 per-job wrapper 进程 pid,长活于推进器之上)。Phase B 在 `schemas/ihpc-state.schema.json` 的 `jobs[<seq>]` 加 `wrapper_pid`,Phase C 的 `progressor.py` 在 `reconcile_slots` 写入每 slot 的 wrapper pid。本阶段 `ihpcStateJobToRunRecord` 的 `supervisorPid` 一律取 **`job.wrapper_pid`**(`job.pid` 是内层作业 pid,信息性,**不**作 supervisor pid),Task 5 传 `job.wrapper_pid`(见 Task 2 / Task 5)。
- **CP-4 — node→RunRecord status 映射只一份**:`nodeStatusToRunStatus`(spec §2.3 词表唯一来源)由 Phase B 在 `seam/protocol.ts` 导出;本阶段 `adopt.ts` 与 Phase C `reconcile.ts` 都 **import** 它,不各抄一份 `STATUS_MAP`。映射:`pending→submitted, launching→running, running→running, done→finished, failed→failed, cancelled→cancelled, placement_conflict→unknown`(已对照 live `core/types.ts:260` 的 `RunRecord["status"]` 联合,`submitted|running|finished|failed|cancelled|unknown` 均存在)。

---

## Task 1:RunRecord 加 `adoption{}` 两轴 provenance 块(types + schema + 校验)

spec §5:provenance 标志**二维** —— `terminal_record`(是不是我们 agent 写的退出记录)与 `intent`(跑的是不是用户本意),外加 `lineage`(是否经 queue_id/lease 证血缘)。这三者必须落在 RunRecord 上,供 `jobs.status/logs/cancel` 与 history 读取区分「可信执行事实」vs「仅 history」。

**Files:**
- Modify: `mcp-server/src/core/types.ts`
- Modify: `schemas/run-record.schema.json`
- Test: `mcp-server/tests/ops/adopt-primitives.test.mjs`

- [ ] **Step 1: 写失败测试(校验新块)**

在 `mcp-server/tests/ops/adopt-primitives.test.mjs` 顶部已有 `import { assertRunRecord } from "../../dist/core/validation.js";`。追加:
```javascript
import { ihpcStateJobToRunRecord } from "../../dist/ops/jobs/adopt.js";

test("a RunRecord carrying a two-axis adoption block validates against the schema", () => {
  const rec = {
    run_id: "run-abc123",
    profile_id: "utsihpc_user_01",
    platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-12345",
    status: "running",
    created_at: "2026-06-20T10:00:00.000Z",
    updated_at: "2026-06-20T10:00:00.000Z",
    adoption: {
      terminal_record: "agent_authored",
      intent: "user_declared",
      lineage: "lineage_proven",
      queue_id: "sha256:deadbeef",
      adopted_at: "2026-06-20T10:00:00.000Z"
    },
    events: [{ at: "2026-06-20T10:00:00.000Z", kind: "adopted-lineage", summary: "x" }]
  };
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("the schema rejects an unknown adoption.lineage value", () => {
  const rec = {
    run_id: "run-bad", profile_id: "p", platform: "uts-ihpc", status: "running",
    created_at: "2026-06-20T10:00:00.000Z", updated_at: "2026-06-20T10:00:00.000Z",
    adoption: { terminal_record: "agent_authored", intent: "user_declared", lineage: "totally_invalid", adopted_at: "2026-06-20T10:00:00.000Z" },
    events: []
  };
  assert.throws(() => assertRunRecord(rec), /Invalid run record/);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/ops/adopt-primitives.test.mjs`
Expected: 第一处 FAIL(`additionalProperties:false` 拒绝未知 `adoption` 顶层属性,`assertRunRecord` 抛错);`ihpcStateJobToRunRecord` import 亦 FAIL(尚未导出)。

- [ ] **Step 3: 扩 `core/types.ts` —— RunRecord 加 `adoption?`**

在 `mcp-server/src/core/types.ts` 的 `RunRecord` 接口里,`placement?: {...}` 块(`:248-255`)**之后**、`usage?: RunUsage;`(`:256`)**之前**插入(勿改既有 supervisor/placement 块):
```typescript
  // Feature B (spec §5) two-axis adoption provenance. Present ONLY on adopted runs. Two independent
  // trust axes plus a lineage verdict — do NOT collapse them: "we launched it" (terminal_record) must
  // never launder an unverified argv into "intent is authoritative".
  //  - terminal_record: did OUR agent author this exit record? "agent_authored" = the node wrapper we
  //    deployed wrote exit.code/result.json (strong, stronger than PBS qstat). "external_observed" =
  //    we only observed it (foreign job / pre-internalization).
  //  - intent: is what it ran the user's intent? "user_declared" = command_argv/workdir came from the
  //    user's sweep params with shape+root validation only (NOT semantically verified — same trust
  //    level as PBS). "unverified" = a foreign job whose argv we never declared.
  //  - lineage: proven via STATE queue_id + lease_owner matching a RunRecord we hold, or not.
  adoption?: {
    terminal_record: "agent_authored" | "external_observed";
    intent: "user_declared" | "unverified";
    lineage: "lineage_proven" | "not_lineage_proven";
    queue_id?: string;
    adopted_at: string;
  };
```

- [ ] **Step 4: 扩 `schemas/run-record.schema.json` —— 加 `adoption` 属性**

顶层 `additionalProperties:false`(`:175`),故必须显式加属性。在 `placement` 块(`:61-73`)**之后**、`usage`(`:74`)**之前**插入:
```json
    "adoption": {
      "type": "object",
      "required": ["terminal_record", "intent", "lineage", "adopted_at"],
      "properties": {
        "terminal_record": { "type": "string", "enum": ["agent_authored", "external_observed"] },
        "intent": { "type": "string", "enum": ["user_declared", "unverified"] },
        "lineage": { "type": "string", "enum": ["lineage_proven", "not_lineage_proven"] },
        "queue_id": { "type": "string" },
        "adopted_at": { "type": "string", "format": "date-time" }
      },
      "additionalProperties": false
    },
```

- [ ] **Step 5: 占位导出 `ihpcStateJobToRunRecord`(让 import 可解析,Task 2 补实现)**

在 `mcp-server/src/ops/jobs/adopt.ts` 文件末尾临时加最小导出,使 Step 6 的 schema 测试能 build 通过(Task 2 会替换为真实实现):
```typescript
// Placeholder — real implementation lands in Task 2. Kept exported so the schema test in
// adopt-primitives.test.mjs can import the module without a build break.
export function ihpcStateJobToRunRecord(): never {
  throw new Error("ihpcStateJobToRunRecord not implemented until Task 2");
}
```

- [ ] **Step 6: Run — PASS(schema 部分)**

Run: `cd mcp-server && npm run build && node --test tests/ops/adopt-primitives.test.mjs`
Expected: 两个 schema 测试 PASS(合法 `adoption` 块校验过、非法 `lineage` 被拒)。引用 `ihpcStateJobToRunRecord` 的行为测试若已写则仍抛「not implemented」——本任务只验 schema,这是预期,Task 2 转绿。

- [ ] **Step 7: 全套件回归**

Run: `cd mcp-server && npm test 2>&1 | tail -5`
Expected: 既有 run-record 校验测试仍绿(新 `adoption` 为可选,不破坏既有记录)。

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/core/types.ts schemas/run-record.schema.json mcp-server/src/ops/jobs/adopt.ts mcp-server/tests/ops/adopt-primitives.test.mjs
git commit -m "feat(adopt): RunRecord two-axis adoption provenance block (terminal_record/intent/lineage) + schema (spec §5)"
```

---

## Task 2:`ihpcStateJobToRunRecord` 原语 —— 把 STATE 一条 job 转成 lineage-proven RunRecord

沿 `pbsRowToRunRecord`(`adopt.ts:31`)/`ihpcPidToRunRecord`(`adopt.ts:82`)的「纯函数原语:外部证据 → schema-valid RunRecord,无 SSH 无磁盘」模式,新增第三个原语:输入是 STATE 顶层(`queue_id`/`lease_owner`/`node`)+ 一条 `jobs[seq]` 项 + 该 seq 的 supervisor 路径(由 Phase C `seam/reconcile.ts` 从 PLAN/slot 目录解析后传入),输出带**真实 supervisor block**(故 `requireIhpcSupervisor` `jobs.ts:1013` 放行)+ `adoption: agent_authored/user_declared/lineage_proven`。

spec §5(a):「`jobs.status/logs/cancel` 作用于*我们*的 pid/log 路径 ⇒ 健全」——supervisor block 的 `pid`/路径来自 STATE,故 `remote_job_id` 必须是 `requireIhpcSupervisor` 期望的 `ihpc-<run_id>-<pid>` 形(`jobs.ts:1027`)。

**Files:**
- Modify: `mcp-server/src/ops/jobs/adopt.ts`
- Test: `mcp-server/tests/ops/adopt-primitives.test.mjs`

- [ ] **Step 0: 确认 Phase B 已导出共享 status 映射(CP-4)**

```bash
grep -n "export function nodeStatusToRunStatus\|export const nodeStatusToRunStatus" mcp-server/src/ops/scheduler/seam/protocol.ts
```
Expected:Phase B 已在 `seam/protocol.ts` 导出 `nodeStatusToRunStatus(status): RunRecord["status"]`(spec §2.3 词表唯一来源)。若**缺**,先在 Phase B 补该导出(本阶段不自抄一份 `STATUS_MAP`)。本 Task 的原语 import 它,Phase C `reconcile.ts` 亦 import 同一份(CP-4)。

- [ ] **Step 1: 写失败测试**

在 `mcp-server/tests/ops/adopt-primitives.test.mjs` 追加:
```javascript
const NODE_CLOCK = "2026-06-20T14:32:15.000Z";

test("ihpcStateJobToRunRecord builds a lineage-proven RunRecord with a real supervisor block", () => {
  const rec = ihpcStateJobToRunRecord({
    runId: "run-abc123",
    profileId: "utsihpc_user_01",
    node: "mars01",
    queueId: "sha256:deadbeef",
    accountLabel: "utsihpc_user_01",
    cluster: "ihpc.example",
    now: new Date("2026-06-20T14:45:30.000Z"),
    // supervisorPid = the slot's long-lived wrapper pid (CP-3), NOT the dead progressor pid.
    supervisorPid: 54321,
    job: {
      seq: 0, run_id: "run-abc123", status: "running", pid: 12345, wrapper_pid: 54321, gpu_index: 0,
      started_at_node: NODE_CLOCK, log: "/home/user/project/.uts/slot_0/stdout.log"
    },
    supervisorPaths: {
      metadata_path: "/home/user/project/.uts/slot_0/result.json",
      stdout_path: "/home/user/project/.uts/slot_0/stdout.log",
      stderr_path: "/home/user/project/.uts/slot_0/stdout.log"
    }
  });
  assert.equal(rec.platform, "uts-ihpc");
  // remote_job_id must match the ihpc-<run_id>-<pid> shape requireIhpcSupervisor expects.
  assert.equal(rec.remote_job_id, "ihpc-run-abc123-54321");
  assert.equal(rec.supervisor.pid, 54321);
  assert.equal(rec.supervisor.node_id, "mars01");
  assert.equal(rec.status, "running");
  assert.equal(rec.adoption.terminal_record, "agent_authored");
  assert.equal(rec.adoption.intent, "user_declared");
  assert.equal(rec.adoption.lineage, "lineage_proven");
  assert.equal(rec.adoption.queue_id, "sha256:deadbeef");
  assert.equal(rec.placement.gpu_index, 0);
  assert.doesNotThrow(() => assertRunRecord(rec));
});

test("ihpcStateJobToRunRecord maps node status 'done' to finished and carries exit_code event", () => {
  const rec = ihpcStateJobToRunRecord({
    runId: "run-def456", profileId: "p", node: "mars01", queueId: "sha256:q",
    now: new Date("2026-06-20T15:00:00.000Z"), supervisorPid: 60000,
    job: { seq: 1, run_id: "run-def456", status: "done", pid: 59000, wrapper_pid: 60000, gpu_index: 1, exit_code: 0,
           started_at_node: NODE_CLOCK, finished_at_node: "2026-06-20T14:55:00.000Z", log: "/r/slot_1/stdout.log" },
    supervisorPaths: { metadata_path: "/r/slot_1/result.json", stdout_path: "/r/slot_1/stdout.log", stderr_path: "/r/slot_1/stdout.log" }
  });
  assert.equal(rec.status, "finished");
  assert.equal(rec.adoption.terminal_record, "agent_authored");
});

test("ihpcStateJobToRunRecord maps placement_conflict to unknown (deferred, not failed)", () => {
  const rec = ihpcStateJobToRunRecord({
    runId: "run-c", profileId: "p", node: "mars01", queueId: "sha256:q",
    now: new Date("2026-06-20T15:00:00.000Z"), supervisorPid: 70000,
    job: { seq: 2, run_id: "run-c", status: "placement_conflict", pid: 69000, wrapper_pid: 70000, gpu_index: 0,
           started_at_node: NODE_CLOCK, log: "/r/slot_2/stdout.log" },
    supervisorPaths: { metadata_path: "/r/slot_2/result.json", stdout_path: "/r/slot_2/stdout.log", stderr_path: "/r/slot_2/stdout.log" }
  });
  assert.equal(rec.status, "unknown");
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/ops/adopt-primitives.test.mjs`
Expected: FAIL(原语抛「not implemented」/字段不符)。

- [ ] **Step 3: 实现原语 —— 替换 Task 1 Step 5 的占位**

在 `mcp-server/src/ops/jobs/adopt.ts`:删除 Task 1 Step 5 的占位 `ihpcStateJobToRunRecord`,在 `ihpcPidToRunRecord`(`:82-115`)**之后**插入。先在文件顶部已有的 type import 行(`import type { Platform, RunRecord } from "../../core/types.js";`)无需改;**新增**一行 import 共享 status 映射(CP-4,唯一来源在 Phase B `seam/protocol.ts`):
```typescript
import { nodeStatusToRunStatus, type NodeJobStatus } from "../scheduler/seam/protocol.js";
```
新增的本地类型在本文件内定义:
```typescript
// One STATE jobs[<seq>] entry (spec §2.3, grouped). started_at_node/finished_at_node are NODE-clock
// opaque labels — never differenced against the laptop clock (spec §2.3 clock-skew rule).
// wrapper_pid (CP-3) = the slot's long-lived per-job wrapper pid (the "supervisor of record"); it
// outlives the progressor, so it — not the progressor pid — is what status/logs/cancel target. pid is
// the inner job pid (informational only).
export interface IhpcStateJobEntry {
  seq: number;
  run_id: string;
  status: NodeJobStatus;
  pid: number;
  wrapper_pid: number;
  gpu_index: number;
  exit_code?: number;
  started_at_node: string;
  finished_at_node?: string;
  log: string;
}

export interface IhpcStateAdoptContext {
  runId: string;
  profileId: string;
  node: string;
  queueId: string;          // STATE top-level queue_id — the lineage proof anchor (spec §5a)
  now: Date;
  supervisorPid: number;    // the slot wrapper_pid (CP-3) — supervisor of record, NOT the progressor pid
  job: IhpcStateJobEntry;
  supervisorPaths: { metadata_path: string; stdout_path: string; stderr_path: string };
  accountLabel?: string;
  cluster?: string;
}

// nodeStatusToRunStatus is imported from seam/protocol.ts (CP-4) — spec §2.3 vocab is encoded ONCE.
// Mapping: pending→submitted, launching/running→running, done→finished, failed→failed,
// cancelled→cancelled, placement_conflict→unknown (deferred, not a failure — the brain re-places).

// Feature B (a) (spec §5): a job OUR progressor launched from OUR PLAN, proven by lineage. Synthesizes a
// REAL supervisor block (so requireIhpcSupervisor at jobs.ts:1013 admits jobs.status/logs/cancel on our
// own pid/log paths) and a two-axis adoption block. Pure: no SSH, no disk. The caller (seam/reconcile.ts)
// reads state.json once, proves lineage (STATE queue_id + lease_owner == a RunRecord we hold), and resolves
// the per-slot supervisor paths from the PLAN/slot directory before calling this.
export function ihpcStateJobToRunRecord(ctx: IhpcStateAdoptContext): RunRecord {
  const at = ctx.now.toISOString();
  // remote_job_id MUST be the canonical ihpc-<run_id>-<pid> shape requireIhpcSupervisor expects
  // (jobs.ts:1027); the pid is the slot wrapper_pid (supervisor of record, CP-3), not the inner job pid
  // and not the (possibly dead) progressor pid.
  const remoteJobId = `ihpc-${ctx.runId}-${ctx.supervisorPid}`;
  const runStatus = nodeStatusToRunStatus(ctx.job.status);
  return {
    run_id: ctx.runId,
    profile_id: ctx.profileId,
    platform: "uts-ihpc",
    remote_job_id: remoteJobId,
    rev: 0,
    status: runStatus,
    created_at: at,
    updated_at: at,
    submission: {
      account_label: ctx.accountLabel ?? ctx.profileId,
      cluster: ctx.cluster ?? ctx.profileId,
      node: ctx.node,
      requested: {},
      submitted_at: at
    },
    supervisor: {
      pid: ctx.supervisorPid,
      node_id: ctx.node,
      metadata_path: ctx.supervisorPaths.metadata_path,
      stdout_path: ctx.supervisorPaths.stdout_path,
      stderr_path: ctx.supervisorPaths.stderr_path
      // We do NOT synthesize started_at — only what the node actually reports (node-clock label).
    },
    placement: {
      hostname: ctx.node,
      node_id: ctx.node,
      gpu_index: ctx.job.gpu_index
    },
    // Two independent trust axes (spec §5): the terminal record IS ours (the wrapper wrote it), but the
    // intent was only shape+root validated — keep them separate, do not let "we launched it" launder argv.
    adoption: {
      terminal_record: "agent_authored",
      intent: "user_declared",
      lineage: "lineage_proven",
      queue_id: ctx.queueId,
      adopted_at: at
    },
    events: [
      {
        at,
        kind: "adopted-lineage",
        summary: `Adopted lineage-proven iHPC run ${ctx.runId} (seq ${ctx.job.seq}, queue ${ctx.queueId}, node status ${ctx.job.status})`
      }
    ]
  };
}
```

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/adopt-primitives.test.mjs`
Expected: 所有原语测试 PASS(含 Task 1 的 schema 测试,因为现在合成的记录带合法 `adoption`)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/jobs/adopt.ts mcp-server/tests/ops/adopt-primitives.test.mjs
git commit -m "feat(adopt): ihpcStateJobToRunRecord lineage-proven primitive (real supervisor + agent_authored provenance, spec §5a)"
```

---

## Task 3:`ihpcPidToRunRecord` 标记 `not_lineage_proven` + (b) history-only read/cancel 拒绝

spec §5(b):**发现的非我们启动作业** → `not_lineage_proven` + history-only,每个路径过完整 realpath gate,`jobs.status/logs/cancel` 拒绝。今天 `ihpcPidToRunRecord`(`adopt.ts:82`)的 Phase-1 注释说「不合成 supervisor block ⇒ status/logs/cancel 抛 does not include iHPC supervisor metadata」——这正好是 (b) 想要的拒绝行为,我们只需把它**显式标 provenance**(`external_observed`/`unverified`/`not_lineage_proven`),使「为什么被拒」可读、可审计,而非靠缺 supervisor 块的副作用。

**Files:**
- Modify: `mcp-server/src/ops/jobs/adopt.ts`
- Test: `mcp-server/tests/ops/jobs-adopt.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `mcp-server/tests/ops/jobs-adopt.test.mjs` 追加(沿用文件已有的 `getJobStatus` import 与 `tempRuntimeDir`):
```javascript
import { ihpcPidToRunRecord } from "../../dist/ops/jobs/adopt.js";

test("ihpcPidToRunRecord flags a foreign job not_lineage_proven / external_observed / unverified", () => {
  const rec = ihpcPidToRunRecord({
    runId: "adopt-foreign-1", profileId: "utsihpc_user_01", node: "mars01", pid: 9999,
    now: new Date("2026-06-20T10:00:00.000Z")
  });
  assert.equal(rec.adoption.terminal_record, "external_observed");
  assert.equal(rec.adoption.intent, "unverified");
  assert.equal(rec.adoption.lineage, "not_lineage_proven");
  // Still history-only: no supervisor block (so jobs.status/logs/cancel stay refused).
  assert.equal(rec.supervisor, undefined);
});

test("jobs.status on a not_lineage_proven iHPC record stays refused (history-only)", async () => {
  const auditDir = tempRuntimeDir("adopt-foreign-status");
  await adoptExternalRun(
    { runId: "adopt-foreign-2", profileId: "utsihpc_user_01", node: "mars01", pid: 9001 },
    { auditDir, now: new Date("2026-06-20T10:00:00.000Z") }
  );
  await assert.rejects(
    () => getJobStatus({ runId: "adopt-foreign-2" }, { auditDir }),
    /does not include iHPC supervisor metadata|history-only|not_lineage_proven/i
  );
});
```
> `utsihpc_user_01` 须是测试配置里的一个 iHPC profile;若 fixture 用别名,改成现有 iHPC profile id(参照同文件既有 iHPC 测试用的 profile)。

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/ops/jobs-adopt.test.mjs`
Expected: FAIL(`rec.adoption` 为 undefined)。

- [ ] **Step 3: 给 `ihpcPidToRunRecord` 加 provenance 标志**

`ihpcPidToRunRecord` 头部已有 `const at = ctx.now.toISOString();`(`adopt.ts:83`),故 `adopted_at: at` 直接可用。在该函数(`:82`)的 `return {...}`(`:101-114`)里,把 `events` 之前(或之后,顺序不影响校验)加入 `adoption` 块,并把内嵌注释从「Phase 1: HISTORY-ONLY」更新为 Feature B (b)。具体:在 `return {` 内、`events:` 字段(`:113`)**之前**插入:
```typescript
    // Feature B (b) (spec §5): a foreign job we only OBSERVED (bare `ihpc-sched start`, or pre-
    // internalization). Both trust axes are weak and lineage is unproven. No supervisor block is
    // synthesized, so requireIhpcSupervisor (jobs.ts:1013) keeps jobs.status/logs/cancel refused —
    // history-only until a later trust path proves lineage.
    adoption: {
      terminal_record: "external_observed",
      intent: "unverified",
      lineage: "not_lineage_proven",
      adopted_at: at
    },
```
并把该函数顶部的 Phase-1 注释首行(`// Phase 1: HISTORY-ONLY.` `adopt.ts:84`)改为 `// Feature B (b): HISTORY-ONLY, not_lineage_proven (spec §5b).`(保留其余解释行;同函数内 `jobs.ts:1036` 的引用保持不变)。

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/jobs-adopt.test.mjs`
Expected: 两个新测试 PASS;既有 iHPC adopt 测试仍绿(`adoption` 是新增可选块,不破坏既有断言)。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/jobs/adopt.ts mcp-server/tests/ops/jobs-adopt.test.mjs
git commit -m "feat(adopt): flag foreign iHPC adopts not_lineage_proven/external_observed; keep read/cancel refused (spec §5b)"
```

---

## Task 4:redaction —— `adoption` 只 disclose 标志,不泄路径/device

spec §5 的 provenance 是 DISCLOSURE,但 `adoption.queue_id` 是 content-hash、`supervisor.*_path` 是绝对路径。沿 `core/config.ts` 的 `redactProfile`(`:209-211`,记忆里记的 disclose-has_node_scheduler+runner-not-paths 同款)模式,确保 run-record 的对外披露(若存在 `redactRunRecord`/disclose 路径)**只**带三轴标志,不带 `queue_id`(hash)与 supervisor 绝对路径。

**Files:**
- Modify: `mcp-server/src/core/config.ts`(或 run-record disclosure 所在处)
- Test: 现有 redaction 测试文件(追加)

- [ ] **Step 1: 定位 run-record 对外披露路径**

```bash
grep -rn "redactRunRecord\|discloseRun\|supervisor.*path\|metadata_path" mcp-server/src/core/config.ts mcp-server/src/ops/jobs/history.ts | head
```
**已核查(2026-06-20):** `core/config.ts` 只有 `redactProfile`(`:181`),**无** `redactRunRecord`/`discloseRun`。`history.ts`(`:107` 起)对外用**显式字段白名单**逐个挑(`account_label` 等),**从不**整条 spread RunRecord——故 `adoption`/`supervisor.*_path` 是 **strip-by-absence**(没被挑就不出现),不是 strip-by-default。`jobs.history` 工具描述(`index.ts`)亦自陈「compact per-run fields, not events, commands, or paths」。
- 结论:**无** disclose-run helper 需改;本 Task 落为「**显式回归测试** + 在 history 白名单注释里把 `adoption`/`supervisor` 标为**故意不外泄**」,使未来有人给 history 加字段时被测试挡住。跳到 Step 2(注释)与 Step 3(测试)。
- 防御性:**不要**在 `history.ts` 的 compact 投影里新增 `adoption`;若确需对外暴露 provenance,只暴露三轴标志(`terminal_record`/`intent`/`lineage`),**永不**带 `adoption.queue_id`(content-hash)或任何 `supervisor.*_path`(绝对路径)。

- [ ] **Step 2: 在 history compact 投影处加「故意不外泄」注释(锁意图)**

在 `mcp-server/src/ops/jobs/history.ts` 的 compact 字段白名单(`:107` 一带,逐字段 spread 处)上方加注释,把 `adoption`/`supervisor` 显式标为故意排除,并写明若将来要暴露 provenance 的安全规则:
```typescript
// SECURITY (spec §5): this compact projection is an explicit field allowlist — it MUST NOT spread the
// whole RunRecord. adoption{} and supervisor{} are intentionally EXCLUDED: adoption.queue_id is a
// content-hash and supervisor.*_path are absolute paths. If provenance must ever surface here, expose
// ONLY the three flags (terminal_record/intent/lineage) — never queue_id, never any *_path.
```
（若未来真有 disclose-run helper,同款白名单只保留三轴标志:`{ adoption: { terminal_record, intent, lineage } }`，删 `queue_id`/`adopted_at` 与全部 `supervisor.*_path`。）

- [ ] **Step 3: 写回归测试锁定不变量**

在最贴近的 redaction/history 测试文件追加(以 `jobs.history` 为例,断言其 compact 输出不含 supervisor 路径与 queue_id):
```javascript
test("jobs.history output never leaks supervisor paths or adoption queue_id", async () => {
  const auditDir = tempRuntimeDir("adopt-redact");
  // write a lineage-proven record directly, then list history and assert no path/hash leaks
  // (uses writeRunRecord + jobsHistory already imported in this suite)
  const at = "2026-06-20T10:00:00.000Z";
  writeRunRecord({
    run_id: "run-redact", profile_id: "utsihpc_user_01", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-redact-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    supervisor: { pid: 54321, node_id: "mars01", metadata_path: "/home/u/.uts/slot_0/result.json",
      stdout_path: "/home/u/.uts/slot_0/stdout.log", stderr_path: "/home/u/.uts/slot_0/stdout.log" },
    adoption: { terminal_record: "agent_authored", intent: "user_declared", lineage: "lineage_proven",
      queue_id: "sha256:secrethash", adopted_at: at },
    events: [{ at, kind: "adopted-lineage", summary: "x" }]
  }, auditDir);
  const out = JSON.stringify(await jobsHistory({}, { auditDir }));
  assert.ok(!out.includes("/home/u/.uts"), "history must not leak supervisor paths");
  assert.ok(!out.includes("secrethash"), "history must not leak adoption queue_id hash");
});
```
> 需在该测试文件顶部确保 `import { writeRunRecord } from "../../dist/core/audit.js";` 与 `import { jobsHistory } from "../../dist/ops/jobs/history.js";` 已存在(jobs-adopt.test.mjs 已 import jobsHistory)。

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/jobs-adopt.test.mjs`
Expected: PASS(history compact 输出本就不带这些字段,测试锁定该不变量;若 FAIL 说明某披露面泄露,回 Step 2 修)。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(adopt): lock invariant — disclosure never leaks supervisor paths or adoption queue_id (spec §5)"
```

---

## Task 5:(c) dead-progressor-but-live-jobs —— 经 lineage-proven adopt 原语恢复 + relaunch

spec §5(c) + §2.6:我们推进器死(OOM)但 detached 作业仍活。Phase C 的 `reconcileIhpcCampaign`(`ops/scheduler/seam/reconcile.ts`)已实现「读 state.json 一次 → 同步 RunRecords → dead-progressor-but-live-jobs 分支」。本 Task 把该分支接到**本阶段的** `ihpcStateJobToRunRecord` 原语(为活作业合成 lineage-proven RunRecord),并确保它在合成后触发**重起推进器 resume refill**(spec §2.6「用同一 plan 重起同一推进器 ⇒ 从标记 resume,无损」)——relaunch 复用 Phase C 的 `seam/launch.ts`,本 Task 只接线 + 验收,不重建 launch。

**Files:**
- Modify: `mcp-server/src/ops/scheduler/seam/reconcile.ts`(Phase C 已建)
- Test: `mcp-server/tests/ops/scheduler/reconcile-adopt.test.mjs`(新建)

- [ ] **Step 1: 读 Phase C 的 reconcile 现状,先把 seam 改成 canonical(CP-1/CP-2),再定位 dead-progressor 分支**

```bash
sed -n '1,220p' mcp-server/src/ops/scheduler/seam/reconcile.ts
grep -n "ReconcileInput\|ReconcileDeps\|profileId\|profile\b\|nodeId\|node\b\|progressorAlive\|progressorAlive\|relaunchProgressor\|relaunchProgressor\|readState\|auditDir\|persistRunRecord\|assertIhpcState\|assertIhpcState\|STATUS_MAP\|nodeStatusToRunStatus\|dead.progressor\|heartbeat\|ihpcStateJobToRunRecord\|wrapper_pid" mcp-server/src/ops/scheduler/seam/reconcile.ts
```
**重要(CP-1/CP-2,本计划「跨阶段 seam 契约」已钉死 canonical):** Phase C 今天的 `reconcileIhpcCampaign` 用的是**旧名** —— input `{campaignId, profile, nodeId, runRecords}`、deps `readState/persistRunRecord/relaunchProgressor/progressorAlive`、并 import `assertIhpcState`、自抄一份 `STATUS_MAP`。本 Task 第一步**改 Phase C 的 seam 对齐 canonical**(不是迁就旧名):
1. `ReconcileInput` → `{ campaignId; profileId; node; runRecords? }`(`profile→profileId`、`nodeId→node`)。
2. `ReconcileDeps` 改 `progressorAlive→progressorAlive`、`relaunchProgressor→relaunchProgressor`,**新增 `auditDir: string`**(本 Task adopt 循环写盘用)。`relaunchProgressor` 签名统一为 `(req: { campaignId; profileId; node; queue_id }) => Promise<...>`。
3. 把 `import { assertIhpcState }` 改为 `import { assertIhpcState }`(CP-1);把自抄的 `STATUS_MAP` 删掉,改 `import { nodeStatusToRunStatus } from "./protocol.js"`(CP-4),其既有 status-同步循环也走该函数。
4. 同步改 Task 6 适配器 `reconcileIhpcCampaignRunStatus`(Phase C `jobs.ts` 调用处)的实参名 `profile→profileId`、`nodeId→node`,并传 `auditDir`。

**然后**定位「检测死 `progressor.pid`/陈旧 `heartbeat_node` 且仍有活作业」的分支——确认它**今天只 `relaunchProgressor`、不合成 RunRecord**(Phase C 现状如此)。本 Task **为该分支新增** lineage-proven adopt 循环(下方 Step 4),不是改写一个已存在的合成调用。

- [ ] **Step 2: 写失败测试(新建 `reconcile-adopt.test.mjs`)**

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileIhpcCampaign } from "../../../dist/ops/scheduler/seam/reconcile.js";
import { readRunRecord, writeRunRecord } from "../../../dist/core/audit.js";
import { tempRuntimeDir } from "../../helpers/index.mjs";

// Inject a STATE whose progressor.pid is dead (stub liveness=false) but jobs[0] is still running.
function deadProgressorState() {
  return {
    schema_version: "1.0.0",
    campaign_id: "campaign_x",
    queue_id: "sha256:deadbeef",
    lease_owner: { client: "claude", device_id: "laptop-7f3a" },
    observed_at_node: "2026-06-20T14:45:30Z",
    node_clock_epoch: 1781966730,
    // progressor.pid (44000) is the DEAD progressor — it must NOT become the supervisor pid (CP-3).
    progressor: { pid: 44000, started_at_node: "2026-06-20T14:32:11Z", heartbeat_node: "2026-06-20T14:32:30Z" },
    health: { degraded: null, breaker_tripped: false },
    slot_count: 1,
    jobs: {
      // pid=12345 is the inner job; wrapper_pid=54321 is the slot's long-lived wrapper (supervisor of
      // record, CP-3) — it outlives the dead progressor, so it (not progressor.pid) becomes supervisor.pid.
      "0": { seq: 0, run_id: "run-abc123", status: "running", pid: 12345, wrapper_pid: 54321, gpu_index: 0,
             started_at_node: "2026-06-20T14:32:15Z", log: "/home/u/proj/.uts/slot_0/stdout.log" }
    },
    counts: { pending: 0, running: 1, done: 0, failed: 0, cancelled: 0, conflict: 0 }
  };
}

test("reconcile: dead progressor + live job adopts lineage-proven and requests relaunch", async () => {
  const auditDir = tempRuntimeDir("reconcile-deadprog");
  // The plugin holds the RunRecord (lineage anchor): same queue_id + lease_owner.
  const at = "2026-06-20T14:32:11.000Z";
  writeRunRecord({
    run_id: "run-abc123", profile_id: "utsihpc_user_01", platform: "uts-ihpc",
    remote_job_id: "ihpc-run-abc123-54321", rev: 0, status: "running", created_at: at, updated_at: at,
    campaign_id: "campaign_x", queue_id: "sha256:deadbeef",
    lease_owner: { client: "claude", device_id: "laptop-7f3a", issued_at: at },
    submission: { account_label: "a", cluster: "c", node: "mars01", requested: {}, submitted_at: at },
    events: [{ at, kind: "launched", summary: "x" }]
  }, auditDir);

  const relaunches = [];
  const result = await reconcileIhpcCampaign(
    { campaignId: "campaign_x", profileId: "utsihpc_user_01", node: "mars01" },
    {
      auditDir,
      now: new Date("2026-06-20T14:45:30.000Z"),
      // Phase C seam allows injecting the state reader + progressor liveness + relaunch hook for tests.
      readState: async () => deadProgressorState(),
      progressorAlive: async () => false,    // dead progressor
      relaunchProgressor: async (req) => { relaunches.push(req); }
    }
  );

  // The live job is adopted lineage-proven (real supervisor block synthesized via ihpcStateJobToRunRecord).
  const onDisk = readRunRecord("run-abc123", auditDir);
  assert.equal(onDisk.adoption.lineage, "lineage_proven");
  assert.equal(onDisk.adoption.terminal_record, "agent_authored");
  // supervisor.pid comes from the slot wrapper_pid (54321), NOT the dead progressor.pid (44000) — CP-3.
  assert.equal(onDisk.supervisor.pid, 54321);
  assert.notEqual(onDisk.supervisor.pid, 44000);
  // And a relaunch was requested so refill resumes from on-disk markers (spec §2.6).
  assert.equal(relaunches.length, 1);
  assert.equal(relaunches[0].queue_id, "sha256:deadbeef");
});
```
> 测试用的是 **canonical** seam(本计划「跨阶段 seam 契约」CP-2 钉死):input `{campaignId, profileId, node}`、deps `{auditDir, now, readState, progressorAlive, relaunchProgressor}`(用于无真实节点的本地测试,呼应 spec §7「本地假节点 harness」)。Phase C 当前是旧名——**Step 1 已先把 C 改成 canonical**,故此处不再迁就旧名;若执行时发现 C 尚未改齐,回 Step 1 完成改名再跑。

- [ ] **Step 3: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler/reconcile-adopt.test.mjs`
Expected: FAIL(dead-progressor 分支尚未调 `ihpcStateJobToRunRecord` / 未请求 relaunch / `adoption` 缺失)。

- [ ] **Step 4: 给 reconcile 的 dead-progressor 分支*新增* lineage-proven adopt 循环 + relaunch（D-3：是「加」不是「接线」）**

Phase C 现状:该分支只 `relaunchProgressor`，不合成 RunRecord。本 Task **在其中新增**收养循环,并给 `reconcile.ts` **新增** import:`readRunRecordSafe`/`writeRunRecord`(`core/audit.js`)、`ihpcStateJobToRunRecord`(`../../jobs/adopt.js`)、slot 路径解析所需的 `lib/shared.ts` 守卫。对 STATE 里每条 lineage-proven 的活作业:
1. 用 STATE 顶层 `queue_id` + `lease_owner` 对照我们持有的 RunRecord 证 lineage(命中 = `lineage_proven`);未命中的(foreign / 未证血缘)**不在此路径收养**(走 §5b history-only)。
2. 调 `ihpcStateJobToRunRecord({...})` 合成带真实 supervisor 的记录。`supervisorPid` 取 **`job.wrapper_pid`**(CP-3:该 slot 的长活 wrapper = supervisor of record;`state.progressor.pid` 已死,**绝不**用它);
3. `writeRunRecord(record, auditDir)`(经既有 audit 路径,保持 rev/幂等);
4. 收养完后调注入的 `relaunchProgressor({ campaignId, profileId, node, queue_id })`(spec §2.6 用同一 plan 重起推进器 resume refill)。

最小实现骨架(此分支今天没有收养代码,以下为**新增**整块):
```typescript
// dead progressor + live jobs (spec §2.6 / §5c): adopt lineage-proven, then relaunch to resume refill.
// NOTE (D-3): Phase C's branch previously ONLY relaunched — this adopt loop is NET-NEW here.
if (!progressorAliveResult && hasLiveJobs(state)) {
  for (const [seq, job] of Object.entries(state.jobs)) {
    if (!isLiveOrTerminal(job)) continue;
    const held = readRunRecordSafe(job.run_id, deps.auditDir);
    const lineageProven =
      held?.queue_id === state.queue_id &&
      held?.lease_owner?.client === state.lease_owner.client &&
      held?.lease_owner?.device_id === state.lease_owner.device_id;
    if (!lineageProven) continue; // foreign / unproven jobs are NOT adopted here (history-only path, §5b)
    const record = ihpcStateJobToRunRecord({
      runId: job.run_id,
      profileId: input.profileId,
      node: input.node,
      queueId: state.queue_id,
      now: deps.now,
      // CP-3: the slot wrapper pid is the supervisor of record; the dead progressor pid is NEVER used here.
      supervisorPid: job.wrapper_pid,
      job,
      supervisorPaths: resolveSlotSupervisorPaths(state, job) // slot-dir resolver (added below)
    });
    writeRunRecord(record, deps.auditDir);
  }
  await deps.relaunchProgressor({
    campaignId: input.campaignId,
    profileId: input.profileId,
    node: input.node,
    queue_id: state.queue_id
  });
}
```
> `readRunRecordSafe`/`writeRunRecord` 自 `core/audit.js`;`hasLiveJobs`/`isLiveOrTerminal`/`resolveSlotSupervisorPaths` 在本文件新增(Phase C 未提供):`resolveSlotSupervisorPaths` 由 `job.log` 的 slot 目录推 `result.json`/`stdout.log`,realpath gate 在 profile roots 内——复用 `lib/shared.ts` 的 `isInsideRemoteRoot`/`assertSafeRemotePath`。`job.wrapper_pid` 来自 CP-3:Phase B 在 `ihpc-state.schema.json` 的 `jobs[<seq>]` 加了 `wrapper_pid`,Phase C 的 `progressor.py` 写入它;若执行时 STATE 尚无 `wrapper_pid`,先回 Phase B/C 补该字段(CP-3 是 BLOCKER),不要退回用 `progressor.pid`。

- [ ] **Step 5: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler/reconcile-adopt.test.mjs`
Expected: PASS(活作业被 lineage-proven 收养、relaunch 被请求一次)。

- [ ] **Step 6: 全套件回归**

Run: `cd mcp-server && npm test 2>&1 | tail -5`
Expected: 全绿(Phase C 既有 reconcile 测试 + 本阶段新测试)。

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/ops/scheduler/seam/reconcile.ts mcp-server/src/ops/jobs/jobs.ts mcp-server/tests/ops/scheduler/reconcile-adopt.test.mjs
git commit -m "feat(adopt): dead-progressor-but-live-jobs recovers via lineage-proven adopt + relaunch; align reconcile seam to canonical names (profileId/node/progressorAlive/relaunchProgressor/auditDir, assertIhpcState, shared nodeStatusToRunStatus) (spec §5c/§2.6, CP-1/CP-2/CP-3/CP-4)"
```

---

## Task 6:`jobs.adopt` 工具描述更新两轴信任语义(无新工具)

spec §8 显式决定 `seam/*` 走**内部**;Feature B 不增工具面,沿用既有 `jobs.adopt`(`index.ts:644`)。但其描述今天写「records the supplied node+pid as a history-only entry … until later phases」——现在 lineage-proven 路径已落地,描述须更新,使 agent 知道何时得到执行权威 vs history-only。**仅改描述串,不改 inputSchema**(lineage-proven 收养走 `reconcileIhpcCampaign` 自动路径,不靠手动 node+pid;手动 `jobs.adopt` 仍是 (b) 的 foreign/PBS 入口)。

**Files:**
- Modify: `mcp-server/src/index.ts`
- Test: `mcp-server/tests/integration/tool-registration.test.mjs`(断言描述含新语义关键词)

- [ ] **Step 1: 写失败测试**

在 `mcp-server/tests/integration/tool-registration.test.mjs` 追加(沿用该文件既有的工具枚举/查描述风格):
```javascript
test("jobs.adopt description states the foreign-job history-only trust level", () => {
  const tool = listTools().find((t) => t.name === "jobs.adopt");
  assert.ok(tool, "jobs.adopt must be registered");
  assert.match(tool.description, /history-only|not lineage[- ]proven|foreign/i);
});
```
> 若该文件用别的方式取工具列表(如 import 注册表),对齐既有 helper;关键是断言描述提到 foreign/history-only。

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/integration/tool-registration.test.mjs`
Expected: FAIL 或 PASS——若旧描述已含 "history-only" 则可能 PASS;此时改断言为更强的 `/lineage|two-axis|reconcile/i` 使其先 FAIL,再于 Step 3 满足。

- [ ] **Step 3: 更新 `jobs.adopt` 描述**

在 `mcp-server/src/index.ts:649-650`,把 description 改为(保留 PBS 段,更新 iHPC 段):
```typescript
      description:
        "Onboard an externally-started job into local run history. For a UTS HPC PBS profile, fetches qstat -x -f over SSH for the given remoteJobId. For a UTS iHPC profile, records the supplied node+pid as a HISTORY-ONLY, not-lineage-proven entry (a foreign job we only observed): jobs.status/logs/cancel stay refused on it. Jobs OUR progressor launched from OUR PLAN are instead adopted lineage-proven (real supervisor, agent_authored execution facts, full read/cancel) automatically via campaign reconciliation on jobs.track — not through this manual entry point. Idempotent on the run_id + remote_job_id pair; refuses to overwrite an existing run with a conflicting remote_job_id.",
```

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/integration/tool-registration.test.mjs`
Expected: PASS。

- [ ] **Step 5: 客户端中立 + 全套件**

```bash
grep -rn "adoption\|lineage_proven\|ihpcStateJobToRunRecord" .claude-plugin/ 2>/dev/null && echo "LEAK: Claude-only" || echo "neutral"
cd mcp-server && npm test 2>&1 | tail -5
```
Expected:`neutral`(Feature B 全在共享 `mcp-server/`/`schemas/`,无 Claude-only 面,符合 spec §8 + 项目 CLAUDE.md);`npm test` 全绿。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/index.ts mcp-server/tests/integration/tool-registration.test.mjs
git commit -m "docs(adopt): jobs.adopt description reflects two-axis trust (foreign=history-only, ours=lineage-proven via reconcile, spec §5/§8)"
```

---

## Phase D 退出条件

- [ ] RunRecord 有可选 `adoption{terminal_record, intent, lineage, queue_id?, adopted_at}`;schema 校验合法值、拒非法 `lineage`;既有记录(无 `adoption`)仍校验通过。
- [ ] `ihpcStateJobToRunRecord`(原语)合成带**真实 supervisor block**(`ihpc-<run_id>-<pid>` 形)+ `agent_authored/user_declared/lineage_proven` 的 iHPC RunRecord;node status 词表正确映射(done→finished、placement_conflict→unknown)。
- [ ] `ihpcPidToRunRecord`(foreign)标 `external_observed/unverified/not_lineage_proven`,**不**合成 supervisor,`jobs.status/logs/cancel` 经 `requireIhpcSupervisor` 仍拒(spec §5b)。
- [ ] disclosure(history 等)不泄 supervisor 绝对路径与 `adoption.queue_id` hash(回归测试锁定)。
- [ ] `reconcileIhpcCampaign` 用 canonical 签名(`{campaignId,profileId,node}` + deps `{auditDir,readState,progressorAlive,relaunchProgressor}`,CP-2);其 dead-progressor-but-live-jobs 分支**新增**(非接线)对 lineage-proven 活作业经 `ihpcStateJobToRunRecord` 收养(`supervisorPid = job.wrapper_pid`,非死 `progressor.pid`,CP-3)并请求 relaunch resume(spec §5c/§2.6);foreign/未证血缘的作业不在此路径被收养。
- [ ] `jobs.adopt` 工具描述反映两轴信任;无新 MCP 工具(spec §8 内部 seam);`.claude-plugin/` 无 Feature B 专有面(客户端中立)。
- [ ] `npm test` 全绿。

## 自查(spec 覆盖)

- §5(a)「我们推进器从我们 PLAN 起的作业 → adopt 执行事实为权威;provenance 二维 `terminal_record:agent_authored`+`intent:user_declared`;经 queue_id/run_id/lease_owner 证 lineage;status/logs/cancel 走我们 pid/log」→ Task 1(块)+ Task 2(原语,真实 supervisor)+ Task 5(reconcile 接线)✓。
- §5(b)「发现的非我们启动作业 → history-only + not_lineage_proven,full realpath gate,read/cancel 拒绝」→ Task 3 ✓(realpath gate 复用既有 `requireIhpcSupervisor` 的 root 校验 + foreign 无 supervisor ⇒ 拒)。
- §5(c)「我们自己死推进器但活作业 → 复用 (a) lineage-proven 路径 + 重起推进器,两行为接进 `reconcileIhpcCampaign`」→ Task 5 ✓。
- §5 末「以 Feature A 为前提;Feature B 排其后」→ 计划前置阶段已声明依赖 Phase A/B/C ✓。
- §2.3 STATE 词表 + 终止标记 + 节点钟不透明 → Task 2 `nodeStatusToRunStatus` + 不合成 started_at ✓。
- §8 客户端中立「seam 内部、不增工具面、5-touch」→ Task 6(无新工具)+ Step 5 中立检查 ✓。
- **刻意留给前置阶段(非本阶段)**:lease 的 acquire/refresh/takeover(Phase A/B);STATE/PLAN Ajv schema(Phase B `seam/protocol.ts`);`reconcileIhpcCampaign` 的读 state.json / RunRecord 同步主干 + relaunch 的 `seam/launch.ts`(Phase C)——本阶段只接 lineage-proven adopt 原语进既有 dead-progressor 分支。
- **跨阶段一致性(评审 BLOCKER,已在本计划解决)**:
  - **CP-1**:`protocol.ts` 校验导出名 canonical = `assertIhpcPlan`/`assertIhpcState`;Phase C 的 `assertIhpcPlan`/`assertIhpcState` + Step 0 grep 须改齐(Task 5 Step 1 处理 reconcile 侧;launch 侧由 Phase C 自改)。
  - **CP-2**:`reconcileIhpcCampaign` canonical 签名 `{campaignId,profileId,node}` + deps `{auditDir,now,readState,progressorAlive,relaunchProgressor}`;Task 5 Step 1 把 Phase C 旧名(`profile/nodeId/progressorAlive/relaunchProgressor`)改齐,并加 `auditDir`。
  - **CP-3**:campaign 作业的 supervisor-of-record = 该 slot 的 `wrapper_pid`(STATE `jobs[<seq>].wrapper_pid`,Phase B schema + Phase C progressor 写入);`ihpcStateJobToRunRecord` 的 `supervisorPid` 取 `job.wrapper_pid`,**绝不**用已死的 `progressor.pid`。本阶段全部测试 + 骨架已据此写;若 STATE 尚无该字段须先回 B/C 补(上游 BLOCKER)。
  - **CP-4**:node→RunRecord status 映射只在 `seam/protocol.ts` 一份 `nodeStatusToRunStatus`,本阶段 `adopt.ts` 与 Phase C `reconcile.ts` 共同 import(已对照 live `core/types.ts:260` 联合确认 `submitted|running|finished|failed|cancelled|unknown` 均存在)。
- **诚实风险(残留)**:CP-1/CP-3 的上游修改(Phase B schema 加 `wrapper_pid`、导出 `nodeStatusToRunStatus`、`assertIhpcState` 命名;Phase C progressor 写 `wrapper_pid`)不在本阶段文件内——本阶段假定它们已落地,并在 Task 2 Step 0 / Task 5 Step 1 显式校验;若上游未做,先补上游再跑本阶段,不在本阶段降级绕过。
