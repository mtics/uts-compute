# iHPC 内化 — Phase A(部署加硬:fail-closed probe + 三锁 + 契约排序 + node_scheduler + 自有目录回滚)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现。步骤用 checkbox(`- [ ]`)跟踪。

**Goal:** 把 `ihpc.scheduler.deploy` 的**部署 + 版本控制路径**从「不确定即可清」加硬为 **fail-closed**:只在能正面证明节点无活作业时才部署。本阶段经 executor seam 用 **mock** 验证(**不**做真实节点部署——首次真实节点 smoke 在 Phase C,推进器存在之后)。落地:反转 `probeSchedulerActive`;新增防外部进程篡改的孤儿 GPU 探测(固定 argv,零插值);三把锁(token / active+orphan probe / post-verify 契约 match);`contractOrdering(live,expected) → equal|older|newer|divergent`(建在 Phase 0 的 build-ordinal 格式上,deploy 拒绝 `newer|divergent`);on-node STATE_VERSION 预检 + 拒绝;`node_scheduler` profile 字段 `{runner,uv_bin?,dir?}`(schema + 类型 + 校验 + 脱敏);可配置调用 `buildSchedulerSshArgs`(console=干净 argv;uv=`ssh host sh -c` 带 `cd <dir>/current && uv run --frozen --offline`)+ runner-drift verdict;部署到插件自有目录 + SHA256 戳 + `current` 符号链接 + keep-N=3 回滚。

**Architecture:** 加硬仍全在 `mcp-server/src/ops/data/scheduler-deploy.ts` + `mcp-server/src/ops/jobs/scheduler-version.ts` 两处既有 deploy/version 路径,新增 `mcp-server/src/ops/scheduler/seam/contract.ts`(`contractOrdering`)作为新子系统树 `ops/scheduler/{control,node,seam}/` 的第一个文件(seam = 边界定义)。**不**引入 control 模块、不引入推进器、不引入 lease——那些是 Phase B/C。`node_scheduler` 走 schema + `core/types.ts` + `config.ts` redact 三处。探测/调用 argv 全部**固定 argv 或严格白名单**,绝无 operator 插值。

**Tech Stack:** TypeScript(ES modules、Ajv)、`node --test`;复用 `lib/ssh.ts`(`sshJobArgs`/`sshOuterHopFlags`)、`lib/auth.ts`(`assertConfirmationToken`)、`lib/ihpc-contract.ts`(Phase 0 的 `ContractParts {version,stateVersion,build,gitSha}` + `EXPECTED_SCHEDULER_CONTRACT`)、`lib/shared.ts`(`assertSafeSshTarget`/`sshTimeoutSeconds`/`safeTimestamp`)、`core/validation.ts`(Ajv profile 校验)。依据 spec:`docs/superpowers/specs/2026-06-20-ihpc-scheduler-internalized-design.md` §2(节点唯一 nvidia-smi 论据)、§3.2(lease 不属本阶段,但 active-probe 思路相关)、§4(全部 deploy 加硬,fail-closed)、§6 迁移表 Phase A 行、§8(客户端中立)。

**前提(跨阶段假设,实现前先核对):** 本阶段建在 **Phase 0 已落地**之上——`lib/ihpc-contract.ts` 已是 `version+stateN+buildM+sha` 格式、`ContractParts` 含 `build: number`、`EXPECTED_SCHEDULER_CONTRACT` 已带 `+buildM` 段。**实测当前工作树 `lib/ihpc-contract.ts` 仍是旧 3 段格式(`version+stateN+sha`,无 `build`)——Phase 0 plan 已写但未 commit。** 若执行 Phase A 时 Phase 0 尚未 merge,先执行 Phase 0(`docs/superpowers/plans/2026-06-20-ihpc-internalized-phase0-first-party.md`)。本 plan 的 Task 3(`contractOrdering`)依赖 `ContractParts.build` 与 `parseContractVersion` 解析 build 段。

**基线:** 全套 `npm test` 当前应绿(~485,Phase 0 后约 +4)。每个 Task 末尾 commit;不 push(控制器统一处理)。测试是 `node --test *.mjs`,从 `../../dist/...js` import,故每个验证步骤先 `npm run build`。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `mcp-server/src/ops/scheduler/seam/contract.ts` | `contractOrdering(live,expected) → equal\|older\|newer\|divergent`(按 `(stateVersion,build)` 字典序;同 `(version,build)` 不同 sha ⇒ divergent) | **新建**(子系统树 `ops/scheduler/seam/` 第一个文件) |
| `mcp-server/tests/ops/scheduler/contract-ordering.test.mjs` | `contractOrdering` 全分支测试 | **新建** |
| `schemas/profile.schema.json` | profile schema | **加** `defaults.node_scheduler`(可选,严格白名单 runner) |
| `mcp-server/src/core/types.ts` | `ComputeProfile.defaults` 类型 | **加** `node_scheduler?` 字段 |
| `mcp-server/src/core/config.ts` | `redactProfile` | **加** `has_node_scheduler` + `runner` 披露(**不**披露 `uv_bin`/`dir` 路径) |
| `mcp-server/tests/core/profile-account.test.mjs` | redact 测试 | **加** node_scheduler 披露断言 |
| `mcp-server/src/ops/jobs/scheduler-version.ts` | 版本握手 | **加** `buildSchedulerSshArgs`(console/uv 调用)+ `runner-drift` verdict;`contractOrdering` 接入 |
| `mcp-server/tests/ops/scheduler-version.test.mjs` | 版本测试 | **加** uv 调用 argv + runner-drift + ordering 断言 |
| `mcp-server/src/ops/data/scheduler-deploy.ts` | 部署 | **反转** `probeSchedulerActive` 为 fail-closed;**加** `buildRawNodeProbeSshArgs`(孤儿 GPU 探测)、STATE_VERSION 预检、`contractOrdering` 门(拒 newer/divergent)、自有目录 + SHA256 + `current` symlink + keep-N=3 | 
| `mcp-server/tests/ops/scheduler-deploy.test.mjs` | 部署测试 | **改写** active-probe 为 fail-closed 断言;**加** orphan-GPU、STATE_VERSION、ordering-gate、symlink/keep-N 断言 |
| `profiles/profiles.example.yaml` | 示例 profile | **加** 一处 `node_scheduler:` 注释示例(console 默认说明) |

> **客户端中立(§8 门):** `node_scheduler` 入 `schemas/`(共享层,非 `.claude-plugin/`);缺省默认 `console` ⇒ 既有 Codex profile 校验不变(Task 4 显式测此不变量)。无新增 MCP 工具(deploy/version 是既有工具);故无 5-touch 加工具开销。

---

## Task 1:反转 `probeSchedulerActive` 为 fail-closed(最高优先)

当前 `probeSchedulerActive`(`scheduler-deploy.ts:149-175`)对 SSH 错 / 空输出 / 不可解析 / 缺心跳全部返回 `{active:false}`(= 安全可清),头注「ANY failure… SAFE TO DEPLOY」。**反转:读不到一个能正面证明「无活作业」的状态 ⇒ 拒绝部署。** 本任务只反转 status-probe 这一半(孤儿 GPU 探测在 Task 2 叠加);引入一个三态 `ProbeVerdict`,使 deploy 能区分「证明空闲」「证明有活」「不确定」。

**Files:**
- Modify: `mcp-server/src/ops/data/scheduler-deploy.ts`
- Test: `mcp-server/tests/ops/scheduler-deploy.test.mjs`

- [ ] **Step 1: 写失败测试(替换既有 Lock 2 测试块)**

把 `scheduler-deploy.test.mjs` 中 `// Lock 2 — active-state.` 一节(`refuses to deploy when a FRESH heartbeat…` + `a STALE heartbeat (>900s) is treated as safe…`)与 `probe SSH failure is treated as safe to deploy` 三个测试**整体替换**为(fail-closed 语义):

```javascript
// Lock 2 — active-state (FAIL-CLOSED). We deploy ONLY when we can positively prove no live work.
test("refuses to deploy when a FRESH heartbeat + running/pending work means an active scheduler", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 2, pending: 1 }), stderr: "" }
  });
  await assert.rejects(
    () =>
      deployScheduler(
        { profileId: IHPC_PROFILE, confirmationToken: "right" },
        { executor: exec, now: NOW, confirmationToken: "right" }
      ),
    /active scheduler|live work/i
  );
  assert.deepEqual(programsOf(calls).slice(0, 1), ["status"], "probe then refuse — rsync must NOT be reached");
  assert.ok(!programsOf(calls).includes("rsync"), "rsync must not run on a proven-active node");
});

test("FAIL-CLOSED: probe SSH failure REFUSES (cannot prove idle) — reversed from the old safe default", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 255, stdout: "", stderr: "ssh: connect: timed out", timedOut: true }
  });
  await assert.rejects(
    () =>
      deployScheduler(
        { profileId: IHPC_PROFILE, confirmationToken: "right" },
        { executor: exec, now: NOW, confirmationToken: "right" }
      ),
    /could not (verify|prove)|cannot prove the node is idle/i
  );
  assert.ok(!programsOf(calls).includes("rsync"), "an unprovable node must NOT be rsynced");
});

test("FAIL-CLOSED: empty / unparseable status output REFUSES", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({ status: { exitCode: 0, stdout: "  \n", stderr: "" } });
  await assert.rejects(
    () =>
      deployScheduler(
        { profileId: IHPC_PROFILE, confirmationToken: "right" },
        { executor: exec, now: NOW, confirmationToken: "right" }
      ),
    /could not (verify|prove)|cannot prove the node is idle/i
  );
  assert.ok(!programsOf(calls).includes("rsync"));
});

test("FAIL-CLOSED: a FRESH heartbeat with ZERO work proves idle -> deploy proceeds", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" }
  });
  const { scheduler } = await deployScheduler(
    { profileId: IHPC_PROFILE, confirmationToken: "right" },
    { executor: exec, now: NOW, confirmationToken: "right" }
  );
  assert.equal(scheduler.ok, true);
  assert.ok(programsOf(calls).includes("rsync"), "a proven-idle node deploys");
});
```

> 注:旧的「STALE 心跳 (>900s) 视为安全」语义被**删除**——一个崩溃但仍有活 GPU 作业的推进器会留陈旧心跳;fail-closed 下「陈旧心跳」不再等于「可清」。「无活作业」的正面证据现由两部分组成:status 探测证明无 running/pending **且**(Task 2)孤儿 GPU 探测证明无活 GPU 进程。本任务先让 status 探测 fail-closed;Task 2 叠加 GPU 探测。

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler-deploy.test.mjs`
Expected: FAIL(旧 `probeSchedulerActive` 对 SSH 错返回 `active:false` ⇒ 当前会继续部署而非拒绝;新测试期望拒绝)。

- [ ] **Step 3: 反转 `probeSchedulerActive`(改 `scheduler-deploy.ts`)**

把 `ProbeResult` 接口与 `probeSchedulerActive` 函数(`:75-78` 与 `:146-175`)替换为三态判定:

```typescript
// Fail-closed probe verdict. We deploy ONLY on "idle". "active" = proven live work => refuse.
// "indeterminate" = could not prove idle (ssh error, empty/unparseable, absent heartbeat) => refuse.
export type ProbeStatus = "idle" | "active" | "indeterminate";

interface ProbeResult {
  status: ProbeStatus;
  heartbeatAgeSeconds: number | null;
  reason: string;
}

// SSH `ihpc-sched status --json` and apply a FAIL-CLOSED reading. We return "idle" ONLY when we can
// positively read a present heartbeat with zero running/pending work. Any failure to read a parseable,
// present state (ssh error, empty/unparseable output, absent heartbeat) is "indeterminate" => the
// caller REFUSES. A present heartbeat WITH running/pending work is "active" => the caller REFUSES.
// (Reversed from the old "ANY failure => SAFE TO DEPLOY" default — see spec §4.)
export async function probeSchedulerActive(
  profile: ComputeProfile,
  timeoutMs: number,
  executor: TransferExecutor,
  now: Date
): Promise<ProbeResult> {
  const sshArgs = sshJobArgs(profile.login.host_alias, timeoutMs, STATUS_ARGV);
  const result = await executor("ssh", sshArgs, timeoutMs);
  if (result.exitCode !== 0) {
    return { status: "indeterminate", heartbeatAgeSeconds: null, reason: "status SSH failed" };
  }
  const summary = parseStateSummary(result.stdout);
  if (!summary) {
    return { status: "indeterminate", heartbeatAgeSeconds: null, reason: "status output empty or unparseable" };
  }
  const { heartbeatAt, hasWork } = summary;
  // heartbeat_at is epoch SECONDS; <=0 means absent. We cannot prove idle without a present heartbeat.
  if (heartbeatAt <= 0) {
    return { status: "indeterminate", heartbeatAgeSeconds: null, reason: "no present heartbeat" };
  }
  const nowSeconds = now.getTime() / 1000;
  const ageSeconds = Math.floor(nowSeconds - heartbeatAt);
  if (hasWork) {
    return { status: "active", heartbeatAgeSeconds: ageSeconds, reason: "running/pending work present" };
  }
  return { status: "idle", heartbeatAgeSeconds: ageSeconds, reason: "present heartbeat, no work" };
}
```

并改 `deployScheduler` 中 Lock 2 的消费(`:100-107`):

```typescript
  // Lock 2 — active-state, FAIL-CLOSED. Deploy only on a positively-proven idle node.
  const probe = await probeSchedulerActive(profile, timeoutMs, executor, now);
  if (probe.status === "active") {
    throw new Error(
      `Refusing to deploy: an active scheduler is running on ${profile.login.host_alias} ` +
        `(${probe.reason}, heartbeat ${probe.heartbeatAgeSeconds ?? "?"}s ago). Stop it first.`
    );
  }
  if (probe.status === "indeterminate") {
    throw new Error(
      `Refusing to deploy: cannot prove the node is idle on ${profile.login.host_alias} ` +
        `(${probe.reason}). Re-check the node before deploying.`
    );
  }
```

把 `STALE_HEARTBEAT_SECONDS` 常量(`:61`)删除(不再有「陈旧即安全」概念);若别处无引用,直接移除该行。

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler-deploy.test.mjs`
Expected: PASS。

- [ ] **Step 5: 全套件绿**

Run: `cd /Users/lizhw/Documents/Workspace/Product/uts-computing-platform && npm test 2>&1 | tail -3`
Expected: 绿(其他套件不引用 `STALE_HEARTBEAT_SECONDS`/`ProbeResult.active`)。

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/data/scheduler-deploy.ts mcp-server/tests/ops/scheduler-deploy.test.mjs
git commit -m "fix(ihpc): invert probeSchedulerActive to fail-closed — refuse deploy unless node proven idle (Phase A)"
```

---

## Task 2:孤儿 GPU 探测(防外部进程,固定 argv 零插值)

status 探测只覆盖**我们自己推进器**报的 running/pending。一个**崩溃的推进器但 GPU 上仍有活进程**(spec §2 / `AUDIT:43`「锁是 per-state-file 非 per-GPU」)不会出现在 status 里。叠加第二道证据:固定 argv 的 `nvidia-smi --query-compute-apps=pid` + `pgrep -f setsid`,经一个新 `buildRawNodeProbeSshArgs` 走 SSH;**任一报有进程 ⇒ crash-with-live-work ⇒ 拒绝**;探测自身失败 ⇒ indeterminate ⇒ 拒绝(fail-closed 一以贯之)。argv **固定**(无 host/path 插值,host_alias 经 `assertSafeSshTarget`)。**A-2 修正:绝不让「工具缺失」被读成「节点 clear」**——若 `nvidia-smi`/`pgrep` 任一不在节点上(driver 坏/精简镜像),探测经 `command -v` 输出哨兵行(`PROBE_NVIDIA_MISSING`/`PROBE_PGREP_MISSING`),verdict 据此判 indeterminate ⇒ 拒绝;空 stdout 仅在「两工具都在且静默」时才算 clear。

**Files:**
- Modify: `mcp-server/src/ops/data/scheduler-deploy.ts`
- Test: `mcp-server/tests/ops/scheduler-deploy.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `scheduler-deploy.test.mjs` 的 mock 中,`mockExecutor` 需识别新增的 orphan-probe argv。先扩展 mock 辨识分支与 `programsOf`:把 `mockExecutor` 的 ssh 分支与 `programsOf` 改为识别 `--query-compute-apps` / `pgrep`:

```javascript
// inside mockExecutor's exec, before the status branch:
    if (joined.includes("--query-compute-apps") || joined.includes("pgrep")) {
      return orphan ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
```
并把 `mockExecutor({ status, rsync, version })` 的解构改为 `mockExecutor({ status, orphan, rsync, version })`;`programsOf` 加一分支:
```javascript
function programsOf(calls) {
  return calls.map((c) =>
    c.program === "rsync"
      ? "rsync"
      : c.args.join(" ").includes("--query-compute-apps") || c.args.join(" ").includes("pgrep")
        ? "orphan"
        : c.args.join(" ").includes("status --json")
          ? "status"
          : "version"
  );
}
```

新增测试:
```javascript
// Lock 2b — orphan GPU probe. A crashed progressor with live GPU procs must REFUSE even if status reads idle.
test("FAIL-CLOSED: orphan GPU process (live nvidia-smi compute-app) REFUSES even when status reads idle", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" },
    orphan: { exitCode: 0, stdout: "12345\n", stderr: "" } // a live compute-app pid
  });
  await assert.rejects(
    () =>
      deployScheduler(
        { profileId: IHPC_PROFILE, confirmationToken: "right" },
        { executor: exec, now: NOW, confirmationToken: "right" }
      ),
    /live GPU|orphan|crash-with-live-work/i
  );
  assert.ok(!programsOf(calls).includes("rsync"), "a node with live GPU work must NOT be rsynced");
});

test("FAIL-CLOSED: orphan probe SSH failure REFUSES (cannot prove no GPU work)", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" },
    orphan: { exitCode: 255, stdout: "", stderr: "ssh failed", timedOut: true }
  });
  await assert.rejects(
    () =>
      deployScheduler(
        { profileId: IHPC_PROFILE, confirmationToken: "right" },
        { executor: exec, now: NOW, confirmationToken: "right" }
      ),
    /cannot prove|could not (verify|prove)/i
  );
  assert.ok(!programsOf(calls).includes("rsync"));
});

test("FAIL-CLOSED: a tool-missing sentinel (nvidia-smi absent) REFUSES — absent tooling is not 'clear'", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" },
    // remote sh -c exits 0 but reports nvidia-smi was absent => we cannot prove no GPU work
    orphan: { exitCode: 0, stdout: "PROBE_NVIDIA_MISSING\n", stderr: "" }
  });
  await assert.rejects(
    () =>
      deployScheduler(
        { profileId: IHPC_PROFILE, confirmationToken: "right" },
        { executor: exec, now: NOW, confirmationToken: "right" }
      ),
    /cannot prove|absent/i
  );
  assert.ok(!programsOf(calls).includes("rsync"), "absent probe tooling must NOT be read as clear");
});

test("orphan probe argv is fixed, uses --query-compute-apps=pid and pgrep -f setsid, with NO interpolation", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" },
    orphan: { exitCode: 0, stdout: "", stderr: "" } // empty => no GPU work
  });
  await deployScheduler(
    { profileId: IHPC_PROFILE, confirmationToken: "right" },
    { executor: exec, now: NOW, confirmationToken: "right" }
  );
  const orphanCall = calls.find((c) => c.args.join(" ").includes("--query-compute-apps"));
  assert.ok(orphanCall, "orphan probe must run");
  const joined = orphanCall.args.join(" ");
  assert.ok(joined.includes("--query-compute-apps=pid"), "must query compute-app pids");
  assert.ok(joined.includes("pgrep -f setsid"), "must also pgrep the setsid wrappers");
  // No operator interpolation: the only host token is the validated alias; no profile path appears.
  assert.ok(!joined.includes("/data/") && !joined.includes("/scratch/"), "no path interpolation in the probe argv");
});
```
> 顺序:proven-idle 路径(status idle + orphan empty)的 `programsOf` 应为 `["status","orphan","rsync","version"]`。把既有 happy-path / proceed 测试里的 `programsOf` 期望从 `["status","rsync","version"]` 更新为 `["status","orphan","rsync","version"]`,并给那些 mock 加 `orphan: { exitCode: 0, stdout: "", stderr: "" }`。

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler-deploy.test.mjs`
Expected: FAIL(orphan 分支未实现,proceed 路径仍只 `status,rsync,version`)。

- [ ] **Step 3: 实现孤儿 GPU 探测(改 `scheduler-deploy.ts`)**

加固定探测 argv 常量 + builder + 调用。在 `STATUS_ARGV`(`:73`)附近加:

```typescript
// The orphan-GPU probe. Fixed argv, NO interpolation. Two independent checks joined with `;`:
//   (1) nvidia-smi --query-compute-apps=pid  -> any line = a live CUDA process on this node
//   (2) pgrep -f setsid                       -> any of our detached wrappers still alive
// Either non-empty => crash-with-live-work => refuse. The remote string is a fixed literal so it
// carries no operator data; the host alias is the only dynamic token and is assertSafeSshTarget-guarded
// by sshJobArgs.
//
// FAIL-CLOSED on absent tooling (A-2 review fix): we must NOT let "tool missing" read as "node clear".
// The bug in a naive `... || true; pgrep ... || true` is that an ABSENT nvidia-smi (driver broken) makes
// the probe emit empty stdout — which reads as "clear" and lets us clobber a crashed-with-live-GPU node,
// the exact case this probe exists to catch. We instead route tool-presence through STDOUT SENTINELS and
// design the remote command to exit 0 on a genuinely-clear node so we never conflate two failure axes:
//   - SSH transport failure (exitCode!=0, e.g. timeout/connect) => indeterminate (handled in probe fn).
//   - nvidia-smi absent: emit sentinel `PROBE_NVIDIA_MISSING` (via `command -v`) => indeterminate.
//   - pgrep absent: emit sentinel `PROBE_PGREP_MISSING` (via `command -v`) => indeterminate.
//   - pgrep present but no match: exits 1 (NORMAL clear) — we MUST NOT treat that as an error, so we
//     guard it behind `command -v` and append `|| true` only on the MATCH-vs-no-match axis, keeping the
//     ABSENCE axis on the sentinel. Net: empty stdout == "clear" ONLY when both sentinels are absent.
const ORPHAN_PROBE_ARGV = [
  "sh",
  "-c",
  "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null; else echo PROBE_NVIDIA_MISSING; fi; " +
    "if command -v pgrep >/dev/null 2>&1; then pgrep -f setsid 2>/dev/null || true; else echo PROBE_PGREP_MISSING; fi"
];

// Build the fixed orphan-probe SSH argv. Separate named builder (spec §4) so the fixed-argv, no-
// interpolation property is auditable in one place.
export function buildRawNodeProbeSshArgs(profile: ComputeProfile, timeoutMs: number): string[] {
  return sshJobArgs(profile.login.host_alias, timeoutMs, ORPHAN_PROBE_ARGV);
}

interface OrphanProbeResult {
  status: "clear" | "live" | "indeterminate";
  reason: string;
}

// FAIL-CLOSED reading (A-2): SSH error => indeterminate; a tool-missing sentinel => indeterminate
// (we cannot prove the node is clear if a probe tool was absent); any OTHER non-empty line (a pid) =>
// "live"; empty stdout with BOTH tools present-and-silent => "clear".
export async function probeOrphanGpuWork(
  profile: ComputeProfile,
  timeoutMs: number,
  executor: TransferExecutor
): Promise<OrphanProbeResult> {
  const result = await executor("ssh", buildRawNodeProbeSshArgs(profile, timeoutMs), timeoutMs);
  if (result.exitCode !== 0) {
    return { status: "indeterminate", reason: "orphan GPU probe SSH failed" };
  }
  const lines = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // A tool-missing sentinel means we could NOT actually observe that axis — fail closed, not clear.
  if (lines.includes("PROBE_NVIDIA_MISSING")) {
    return { status: "indeterminate", reason: "nvidia-smi absent on node (cannot prove no GPU work)" };
  }
  if (lines.includes("PROBE_PGREP_MISSING")) {
    return { status: "indeterminate", reason: "pgrep absent on node (cannot prove no live wrapper)" };
  }
  // Any remaining line is a real pid from nvidia-smi or pgrep => live work.
  return lines.length > 0
    ? { status: "live", reason: "live GPU process or setsid wrapper present (crash-with-live-work)" }
    : { status: "clear", reason: "no live GPU process or wrapper" };
}
```

在 `deployScheduler` 的 Lock 2(Task 1 改的那段)**之后、rsync 之前**插入:

```typescript
  // Lock 2b — orphan GPU probe, FAIL-CLOSED. Catches a crashed progressor whose detached GPU jobs
  // are still live but absent from `status`. Either a live compute-app or a live setsid wrapper refuses.
  const orphan = await probeOrphanGpuWork(profile, timeoutMs, executor);
  if (orphan.status === "live") {
    throw new Error(
      `Refusing to deploy: ${orphan.reason} on ${profile.login.host_alias}. ` +
        `A crashed scheduler with live GPU work must not be clobbered.`
    );
  }
  if (orphan.status === "indeterminate") {
    throw new Error(
      `Refusing to deploy: cannot prove there is no live GPU work on ${profile.login.host_alias} ` +
        `(${orphan.reason}). Re-check the node before deploying.`
    );
  }
```

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler-deploy.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/data/scheduler-deploy.ts mcp-server/tests/ops/scheduler-deploy.test.mjs
git commit -m "feat(ihpc): orphan-GPU probe (fixed-argv nvidia-smi + pgrep) gates deploy fail-closed (Phase A)"
```

---

## Task 3:`contractOrdering` —— `equal|older|newer|divergent`(seam/contract.ts)

Phase 0 落了 build-ordinal 格式与 `compareContract`(3 值 match/stale/unknown,向后兼容)。本任务建**排序判定**:`contractOrdering(live, expected) → equal|older|newer|divergent`,按 `(stateVersion, build)` 字典序比较;同 `(version, build)` 但 sha 不同 ⇒ `divergent`(第二账号部署了同序号但不同 commit 的 agent)。deploy 用它:`older ⇒ 重部署(正常)`、`equal ⇒ ok`、`newer|divergent ⇒ 拒绝`(别覆盖更新/分叉的 agent)。这是 `ops/scheduler/{control,node,seam}/` 树的第一个文件,落在 `seam/`(边界定义)。

**Files:**
- Create: `mcp-server/src/ops/scheduler/seam/contract.ts`
- Test: `mcp-server/tests/ops/scheduler/contract-ordering.test.mjs`

- [ ] **Step 1: 写失败测试**

新建 `mcp-server/tests/ops/scheduler/contract-ordering.test.mjs`:
```javascript
// mcp-server/tests/ops/scheduler/contract-ordering.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { contractOrdering } from "../../../dist/ops/scheduler/seam/contract.js";

const E = "0.1.0+state2+build5+abc1234"; // expected (the plugin's pinned)

test("equal: same (version,state,build,sha)", () => {
  assert.equal(contractOrdering("0.1.0+state2+build5+abc1234", E), "equal");
});

test("older: lower build at same state", () => {
  assert.equal(contractOrdering("0.1.0+state2+build4+abc1234", E), "older");
});

test("older: lower stateVersion dominates build", () => {
  assert.equal(contractOrdering("0.1.0+state1+build9+abc1234", E), "older");
});

test("newer: higher build at same state", () => {
  assert.equal(contractOrdering("0.1.0+state2+build6+abc1234", E), "newer");
});

test("newer: higher stateVersion dominates build", () => {
  assert.equal(contractOrdering("0.1.0+state3+build1+abc1234", E), "newer");
});

test("divergent: same (state,build) but different sha", () => {
  assert.equal(contractOrdering("0.1.0+state2+build5+deadbee", E), "divergent");
});

test("divergent: unparseable live string (cannot order) is divergent, never equal/older", () => {
  assert.equal(contractOrdering("", E), "divergent");
  assert.equal(contractOrdering("garbage", E), "divergent");
  assert.equal(contractOrdering(undefined, E), "divergent");
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build`
Expected: build 失败 / module 不存在(`dist/ops/scheduler/seam/contract.js` 不存在)。

- [ ] **Step 3: 实现 `seam/contract.ts`**

新建 `mcp-server/src/ops/scheduler/seam/contract.ts`:
```typescript
// mcp-server/src/ops/scheduler/seam/contract.ts
// Phase A — contract ORDERING for the on-node ihpc-sched agent. Built on Phase 0's build-ordinal
// format (version+stateN+buildM+sha; ContractParts {version, stateVersion, build, gitSha}). Whereas
// compareContract (lib/ihpc-contract.ts) returns the 3-value match/stale/unknown verdict, this returns
// a 4-value DIRECTIONAL ordering the deploy path uses to decide whether to (re)deploy:
//   equal     -> on-node == pinned                            (no-op / ok)
//   older     -> on-node behind pinned, by (stateVersion,build) (redeploy is the normal path)
//   newer     -> on-node AHEAD of pinned                       (a second account deployed a newer agent -> REFUSE)
//   divergent -> same (version,build) but different sha, OR live unparseable (cannot order -> REFUSE)
// Ordering key is (stateVersion, build) lexicographic; version (pyproject) is informational and the
// sha discriminates the divergent (same-ordinal, different-commit) case. No IO.
import { parseContractVersion } from "../../../lib/ihpc-contract.js";

export type ContractOrdering = "equal" | "older" | "newer" | "divergent";

export function contractOrdering(live: string | undefined | null, expected: string): ContractOrdering {
  const liveParts = parseContractVersion(live);
  const expectedParts = parseContractVersion(expected);
  // expected is the plugin's own pin and must parse; if either side is unparseable we cannot order.
  if (!liveParts || !expectedParts) return "divergent";

  if (liveParts.stateVersion !== expectedParts.stateVersion) {
    return liveParts.stateVersion < expectedParts.stateVersion ? "older" : "newer";
  }
  if (liveParts.build !== expectedParts.build) {
    return liveParts.build < expectedParts.build ? "older" : "newer";
  }
  // Same (stateVersion, build). Equal iff the whole pinned string matches (covers version + sha);
  // a differing sha at the same ordinal is a fork we must not silently clobber.
  return live!.trim() === expected.trim() ? "equal" : "divergent";
}
```

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler/contract-ordering.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/scheduler/seam/contract.ts mcp-server/tests/ops/scheduler/contract-ordering.test.mjs
git commit -m "feat(ihpc): contractOrdering equal|older|newer|divergent in ops/scheduler/seam (Phase A)"
```

---

## Task 4:`node_scheduler` profile 字段(schema + 类型 + 校验 + 脱敏)

加可选 `defaults.node_scheduler {runner: console|uv|cron_reboot, uv_bin?, dir?}`,严格白名单 runner,缺省默认 `console`(既有 Codex profile 校验不变)。`redactProfile` 披露 `has_node_scheduler` + `runner`,**绝不**披露 `uv_bin`/`dir`(路径)。

**Files:**
- Modify: `schemas/profile.schema.json`
- Modify: `mcp-server/src/core/types.ts`
- Modify: `mcp-server/src/core/config.ts`
- Test: `mcp-server/tests/core/profile-account.test.mjs`
- Modify: `profiles/profiles.example.yaml`

- [ ] **Step 1: 写失败测试(redact 披露 + 既有 profile 校验不变)**

在 `mcp-server/tests/core/profile-account.test.mjs` 追加:
```javascript
import { validateProfile } from "../../dist/core/validation.js";

test("redactProfile discloses has_node_scheduler + runner but NEVER the uv_bin/dir paths", () => {
  const withScheduler = {
    profile_id: "ihpc-sched-p",
    platform: "uts-ihpc",
    account_label: "ihpc-s",
    login: { host_alias: "ihpc-sched-host", username_ref: "UTS_IHPC_S_USER", requires_vpn: true },
    defaults: {
      node_family: "mars",
      node_scheduler: { runner: "uv", uv_bin: "/home/secret/.local/bin/uv", dir: "/data/secret/ihpc-sched" }
    }
  };
  const redacted = redactProfile(withScheduler);
  assert.equal(redacted.defaults.has_node_scheduler, true);
  assert.equal(redacted.defaults.node_scheduler_runner, "uv");
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes("/home/secret"), "uv_bin path must not leak");
  assert.ok(!json.includes("/data/secret"), "dir path must not leak");
});

test("redactProfile reports has_node_scheduler:false when absent (default console path)", () => {
  const bare = {
    profile_id: "ihpc-bare-p",
    platform: "uts-ihpc",
    account_label: "ihpc-b",
    login: { host_alias: "ihpc-bare-host", username_ref: "UTS_IHPC_B_USER", requires_vpn: true },
    defaults: { node_family: "mars" }
  };
  const redacted = redactProfile(bare);
  assert.equal(redacted.defaults.has_node_scheduler, false);
  assert.equal(redacted.defaults.node_scheduler_runner, "console");
});

test("a profile WITHOUT node_scheduler still validates (Codex profiles unchanged)", () => {
  const bare = {
    profile_id: "ihpc-bare-q",
    platform: "uts-ihpc",
    account_label: "ihpc-b",
    login: { host_alias: "ihpc-bare-host", username_ref: "UTS_IHPC_B_USER", requires_vpn: true },
    defaults: { node_family: "mars" }
  };
  assert.equal(validateProfile(bare).valid, true);
});

test("node_scheduler with an out-of-whitelist runner is rejected", () => {
  const bad = {
    profile_id: "ihpc-bad-r",
    platform: "uts-ihpc",
    account_label: "ihpc-b",
    login: { host_alias: "ihpc-bad-host", username_ref: "UTS_IHPC_B_USER", requires_vpn: true },
    defaults: { node_family: "mars", node_scheduler: { runner: "systemd" } }
  };
  assert.equal(validateProfile(bad).valid, false);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/core/profile-account.test.mjs`
Expected: FAIL(`node_scheduler` schema/redact 未实现;`runner:"systemd"` 当前因 `additionalProperties:false` 已拒,但 `redacted.defaults.has_node_scheduler` 未定义)。

- [ ] **Step 3: 加 schema(`schemas/profile.schema.json`)**

在 `defaults.properties` 内(`project` 之后、`defaults` 的 `additionalProperties: false` 之前)加:
```json
        "node_scheduler": {
          "type": "object",
          "description": "UTS iHPC only (Phase A): how the plugin invokes the on-node ihpc-sched agent. Optional; absent means 'console' (a clean argv). 'uv' runs `uv run --frozen --offline` from <dir>/current; 'cron_reboot' opts into restart autonomy. uv_bin/dir are node paths and are NEVER disclosed by redactProfile.",
          "required": ["runner"],
          "properties": {
            "runner": { "type": "string", "enum": ["console", "uv", "cron_reboot"] },
            "uv_bin": { "type": "string" },
            "dir": { "type": "string" }
          },
          "additionalProperties": false
        }
```

- [ ] **Step 4: 加类型(`mcp-server/src/core/types.ts`)**

在 `ComputeProfile.defaults`(`:62-77`)的 `project?: string;` 之后加:
```typescript
    // UTS iHPC only (Phase A): how the plugin invokes the on-node ihpc-sched agent. Optional; absent
    // means console (a clean argv). uv_bin/dir are node paths, disclosed only as has_node_scheduler +
    // runner by redactProfile — never the paths themselves.
    node_scheduler?: {
      runner: "console" | "uv" | "cron_reboot";
      uv_bin?: string;
      dir?: string;
    };
```

- [ ] **Step 5: 加脱敏(`mcp-server/src/core/config.ts`)**

在 `redactProfile` 的 `defaults` 块(`:202-212`)的 `has_project` 之后加两行:
```typescript
      has_project: Boolean(profile.defaults.project),
      // node_scheduler: disclose presence + runner only (runner is a non-secret mode label like 'uv').
      // uv_bin/dir are node PATHS and are intentionally NOT surfaced.
      has_node_scheduler: Boolean(profile.defaults.node_scheduler),
      node_scheduler_runner: profile.defaults.node_scheduler?.runner ?? "console"
```
(把上一行 `has_project: Boolean(profile.defaults.project)` 末尾的 `}` 前补逗号——见上,`has_project` 行加逗号后接两新键。)

- [ ] **Step 6: 加示例注释(`profiles/profiles.example.yaml`)**

在 iHPC 示例 profile(`uts-ihpc-account-a`,`defaults:` 块内 `node_family: mars` 之后)加注释示例:
```yaml
      # Optional (Phase A): how the plugin invokes the on-node ihpc-sched agent. Absent = 'console'
      # (a clean SSH argv), which is the default Codex/Claude both use. Opt into uv-managed invocation
      # or restart autonomy only if your node needs it. uv_bin/dir are node paths, never disclosed.
      # node_scheduler:
      #   runner: uv          # console | uv | cron_reboot
      #   uv_bin: /home/USER/.local/bin/uv
      #   dir: /data/USER/ihpc-sched
```

- [ ] **Step 7: Run — PASS + 全套件绿**

Run: `cd mcp-server && npm run build && node --test tests/core/profile-account.test.mjs`
Expected: PASS。
Run: `cd /Users/lizhw/Documents/Workspace/Product/uts-computing-platform && npm test 2>&1 | tail -3`
Expected: 绿(既有 profile 校验测试不变——node_scheduler 可选)。

- [ ] **Step 8: Commit**

```bash
git add schemas/profile.schema.json mcp-server/src/core/types.ts mcp-server/src/core/config.ts \
  mcp-server/tests/core/profile-account.test.mjs profiles/profiles.example.yaml
git commit -m "feat(ihpc): node_scheduler profile field {runner,uv_bin?,dir?} + redaction (presence+runner only) (Phase A)"
```

---

## Task 5:`buildSchedulerSshArgs`(console/uv 调用)+ runner-drift verdict + ordering 接入版本握手

把 `scheduler-version.ts` 的固定 `REMOTE_ARGV`(`:36`)泛化为按 `node_scheduler.runner` 配置的调用:`console` = 干净 argv(现状);`uv` = `ssh host sh -c 'cd <dir>/current && uv run --frozen --offline ...'`。runner 与 on-node 实际不符 ⇒ 新增 `runner-drift` verdict 透出。同时把 `contractOrdering` 接入结果(`ordering` 字段),供 deploy 判 newer/divergent。**严格白名单 + shell-quote,无 operator 插值**:`dir`/`uv_bin` 来自 profile(非用户每次输入),但仍校验形状。

**Files:**
- Modify: `mcp-server/src/ops/jobs/scheduler-version.ts`
- Test: `mcp-server/tests/ops/scheduler-version.test.mjs`

- [ ] **Step 1: 写失败测试**

在 `scheduler-version.test.mjs` 追加(并保留既有 4 测试):
```javascript
import { buildSchedulerSshArgs } from "../../dist/ops/jobs/scheduler-version.js";

test("buildSchedulerSshArgs(console) emits a clean fixed argv (no sh -c)", () => {
  const args = buildSchedulerSshArgs({ runner: "console" }, "ihpc-host", 15000);
  const joined = args.join(" ");
  assert.ok(joined.includes("ihpc-sched --print-contract-version"));
  assert.ok(!joined.includes("uv run"), "console runner must not invoke uv");
  assert.ok(!joined.includes("sh -c"), "console runner uses a clean argv, not sh -c");
});

test("buildSchedulerSshArgs(uv) wraps in `cd <dir>/current && uv run --frozen --offline`", () => {
  const args = buildSchedulerSshArgs(
    { runner: "uv", uv_bin: "/home/u/.local/bin/uv", dir: "/data/u/ihpc-sched" },
    "ihpc-host",
    15000
  );
  const joined = args.join(" ");
  assert.ok(joined.includes("sh -c"), "uv runner routes through sh -c");
  assert.ok(joined.includes("cd /data/u/ihpc-sched/current"), "uv runner cds into <dir>/current");
  assert.ok(joined.includes("uv run --frozen --offline"), "uv runner is hermetic (--frozen --offline)");
  assert.ok(joined.includes("--print-contract-version"));
});

test("buildSchedulerSshArgs(uv) rejects an unsafe dir/uv_bin (no shell metacharacters)", () => {
  assert.throws(
    () => buildSchedulerSshArgs({ runner: "uv", uv_bin: "/bin/uv", dir: "/data/u; rm -rf /" }, "ihpc-host", 15000),
    /unsafe|invalid/i
  );
});

test("schedulerVersion surfaces a contractOrdering + a runner-drift verdict", async () => {
  // node reports an OLDER contract -> ordering "older" -> ok:false but redeployable.
  const { exec } = mockExecutor(`0.1.0+state2+build1+abc1234\n`);
  const { scheduler } = await schedulerVersion(
    { profileId: IHPC_PROFILE },
    { executor: exec, expectedContract: "0.1.0+state2+build5+abc1234" }
  );
  assert.equal(scheduler.ordering, "older");
});
```
> `mockExecutor` 已在该文件定义;`expectedContract` 是新增的可选注入点(默认 `EXPECTED_SCHEDULER_CONTRACT`),使 ordering 可被确定性测试。
> 上面 console 断言基于实测的 `REMOTE_ARGV`(`scheduler-version.ts:36`):`const REMOTE_ARGV = ["ihpc-sched", "--print-contract-version"];`——一个干净的两元 argv,joined 后必含 `ihpc-sched --print-contract-version` 且**不**含 `sh -c`(`sshJobArgs` 不包 shell)。console 分支正是直接复用此 `REMOTE_ARGV`,故 `joined.includes("ihpc-sched --print-contract-version")` 与 `!joined.includes("sh -c")` 都对实际形状成立。

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build`
Expected: build/test 失败(`buildSchedulerSshArgs` / `scheduler.ordering` / `expectedContract` 不存在)。

- [ ] **Step 3: 实现(改 `scheduler-version.ts`)**

加 import 与 builder,扩展结果。在文件顶部 import 区加:
```typescript
import { sshJobArgs } from "../../lib/ssh.js";
import { contractOrdering, type ContractOrdering } from "../scheduler/seam/contract.js";
import type { ComputeProfile } from "../../core/types.js";
```
(替换既有 `import { sshJobArgs } ...` 若重复;`compareContract` import 保留。)

加 builder(`REMOTE_ARGV` 常量——实测 `scheduler-version.ts:36` 为 `["ihpc-sched", "--print-contract-version"]`——保留作 console 的尾 argv,builder 直接复用,故 console joined 形状与 Step 1 断言一致):
```typescript
type NodeScheduler = NonNullable<ComputeProfile["defaults"]["node_scheduler"]>;

// A node path must be an absolute, metacharacter-free path. Profile-sourced (not per-call operator
// input), but we still shape-check so a hand-edited profile can't inject shell into the uv invocation.
const SAFE_NODE_PATH = /^\/[A-Za-z0-9._\-/]+$/;

// Build the SSH argv that asks the on-node agent for its contract version, per the profile's runner:
//   console -> a clean fixed argv: `ihpc-sched --print-contract-version`
//   uv      -> `sh -c 'cd <dir>/current && <uv_bin|uv> run --frozen --offline ihpc-sched --print-contract-version'`
//   cron_reboot -> same invocation as console (cron_reboot only changes restart autonomy, not how we read version)
// No operator interpolation: runner is enum-validated; dir/uv_bin are SAFE_NODE_PATH-checked and the
// remote string is assembled here, not from caller data.
export function buildSchedulerSshArgs(
  scheduler: { runner: NodeScheduler["runner"]; uv_bin?: string; dir?: string },
  hostAlias: string,
  timeoutMs: number
): string[] {
  if (scheduler.runner === "uv") {
    const dir = scheduler.dir;
    const uvBin = scheduler.uv_bin ?? "uv";
    if (!dir || !SAFE_NODE_PATH.test(dir)) {
      throw new Error(`node_scheduler.dir is unsafe or missing for uv runner: ${dir ?? "(none)"}`);
    }
    if (scheduler.uv_bin && !SAFE_NODE_PATH.test(scheduler.uv_bin)) {
      throw new Error(`node_scheduler.uv_bin is unsafe: ${scheduler.uv_bin}`);
    }
    const remote = `cd ${dir}/current && ${uvBin} run --frozen --offline ihpc-sched --print-contract-version`;
    return sshJobArgs(hostAlias, timeoutMs, ["sh", "-c", remote]);
  }
  // console (default) and cron_reboot: clean fixed argv.
  return sshJobArgs(hostAlias, timeoutMs, REMOTE_ARGV);
}
```

扩展 `SchedulerVersionOptions` 与 `SchedulerVersionResult` 及 `schedulerVersion`:
```typescript
export interface SchedulerVersionOptions {
  configPath?: string;
  executor?: SchedulerCommandExecutor;
  timeoutMs?: number;
  expectedContract?: string; // injectable for tests; defaults to EXPECTED_SCHEDULER_CONTRACT
}
```
`SchedulerVersionResult.scheduler` 加两字段:
```typescript
    verdict: ContractVerdict;        // match | stale | unknown (back-compat)
    ordering: ContractOrdering;      // equal | older | newer | divergent (Phase A)
    runner: NodeScheduler["runner"]; // which runner we invoked through
    runner_drift: boolean;           // true if SSH/contract read fails in a way consistent with a runner mismatch
```
在 `schedulerVersion` 体内,取 runner、用 builder、算 ordering:
```typescript
  const expected = options.expectedContract ?? EXPECTED_SCHEDULER_CONTRACT;
  const scheduler = profile.defaults.node_scheduler ?? { runner: "console" as const };
  const sshArgs = buildSchedulerSshArgs(scheduler, profile.login.host_alias, timeoutMs);
  const result = await executor("ssh", sshArgs, timeoutMs);
  const live = result.exitCode === 0 ? result.stdout.trim() : "";
  const verdict = compareContract(live, expected);
  const ordering = contractOrdering(live, expected);
  // runner-drift: a uv runner that returns nonzero/empty is the canonical "wrong invocation" signal
  // (e.g. the node has no uv, or the dir is wrong) — distinct from a contract mismatch on a working invocation.
  const runner_drift = scheduler.runner === "uv" && result.exitCode !== 0;
```
并把返回的 `scheduler` 对象补上 `expected`(用上面的 `expected` 变量,而非常量)、`ordering`、`runner: scheduler.runner`、`runner_drift`,summary 在 `runner_drift` 时给出 uv 调用失败提示。

- [ ] **Step 4: Run — PASS**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler-version.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/jobs/scheduler-version.ts mcp-server/tests/ops/scheduler-version.test.mjs
git commit -m "feat(ihpc): buildSchedulerSshArgs (console/uv) + runner-drift + contractOrdering in version handshake (Phase A)"
```

---

## Task 6:STATE_VERSION 预检 + ordering 门 + 自有目录 + SHA256 + current symlink + keep-N=3

deploy 的最后一组锁:(1) **STATE_VERSION 预检**——SSH 读节点 STATE 文件版本,不匹配/legacy ⇒ 拒绝并呈现原因;(2) **ordering 门**——post-deploy verify 用 `contractOrdering`,`newer|divergent ⇒ ok:false`(别覆盖更新/分叉 agent),`equal ⇒ ok`;(3) 部署到**插件自有目录** + **SHA256 戳** + **`current` 符号链接** + **keep-N=3 回滚**(保留旧 N 份,原子切 symlink)。本阶段全 mock 验证。

**Files:**
- Modify: `mcp-server/src/ops/data/scheduler-deploy.ts`
- Test: `mcp-server/tests/ops/scheduler-deploy.test.mjs`

- [ ] **Step 1: 写失败测试**

`mockExecutor` 需识别 STATE_VERSION 预检与目录管理 argv。给 ssh 分支加一个 `stateVersion` 注入分支与 `dirops` 分支(在 status 分支前):
```javascript
    if (joined.includes("STATE_VERSION") || joined.includes("state_version")) {
      return stateVersion ?? { exitCode: 0, stdout: "2\n", stderr: "" };
    }
    if (joined.includes("mkdir") || joined.includes("ln -sfn") || joined.includes("sha256sum")) {
      return dirops ?? { exitCode: 0, stdout: "", stderr: "" };
    }
```
解构改 `mockExecutor({ status, orphan, stateVersion, dirops, rsync, version })`;`programsOf` 加 `stateversion` / `dirops` 分支。新增测试:
```javascript
test("FAIL-CLOSED: a legacy on-node STATE_VERSION REFUSES before rsync", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" },
    orphan: { exitCode: 0, stdout: "", stderr: "" },
    stateVersion: { exitCode: 0, stdout: "1\n", stderr: "" } // legacy (< pinned 2)
  });
  await assert.rejects(
    () =>
      deployScheduler(
        { profileId: IHPC_PROFILE, confirmationToken: "right" },
        { executor: exec, now: NOW, confirmationToken: "right" }
      ),
    /STATE_VERSION|state version|legacy/i
  );
  assert.ok(!programsOf(calls).includes("rsync"));
});

test("post-deploy ordering 'newer' (node ahead of pinned) -> ok:false, do not clobber", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" },
    orphan: { exitCode: 0, stdout: "", stderr: "" },
    stateVersion: { exitCode: 0, stdout: "2\n", stderr: "" },
    version: { exitCode: 0, stdout: "0.1.0+state9+build9+abc1234\n", stderr: "" } // newer than pinned
  });
  const { scheduler } = await deployScheduler(
    { profileId: IHPC_PROFILE, confirmationToken: "right" },
    { executor: exec, now: NOW, confirmationToken: "right" }
  );
  assert.equal(scheduler.ok, false);
  assert.match(scheduler.summary, /newer|ahead|divergent/i);
});

test("deploy lands in a SHA256-stamped dir, flips a `current` symlink, keeps N=3 rollback", async () => {
  tempRuntimeDir("sched-deploy");
  const { exec, calls } = mockExecutor({
    status: { exitCode: 0, stdout: statusJson({ heartbeatAt: NOW_EPOCH_S - 60, running: 0, pending: 0 }), stderr: "" },
    orphan: { exitCode: 0, stdout: "", stderr: "" },
    stateVersion: { exitCode: 0, stdout: "2\n", stderr: "" }
  });
  await deployScheduler(
    { profileId: IHPC_PROFILE, confirmationToken: "right" },
    { executor: exec, now: NOW, confirmationToken: "right" }
  );
  const joinedAll = calls.map((c) => c.args.join(" ")).join("\n");
  assert.ok(/ln -sfn .*current/.test(joinedAll), "must flip a `current` symlink atomically (ln -sfn)");
  assert.ok(/keep|tail -n \+4|rm -rf/.test(joinedAll), "must prune to keep-N=3");
});
```

- [ ] **Step 2: Run — FAIL**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler-deploy.test.mjs`
Expected: FAIL(STATE_VERSION 预检 / ordering 门 / symlink+keep-N 未实现)。

- [ ] **Step 3: 实现(改 `scheduler-deploy.ts`)**

(a) **STATE_VERSION 预检**——加固定 argv 常量 + probe,在 orphan 探测之后、rsync 之前调用。`EXPECTED_STATE_VERSION` 从契约推导(`parseContractVersion(EXPECTED_SCHEDULER_CONTRACT)?.stateVersion`):
```typescript
import { parseContractVersion } from "../../lib/ihpc-contract.js";
import { contractOrdering } from "../scheduler/seam/contract.js";

// FAIL-CLOSED at module load: the plugin's OWN pin must always parse. A `?? 0` fallback would silently
// make the preflight below accept ANY on-node version (fail-OPEN) — a hole in a fail-closed task. If the
// pinned contract is unparseable, that is a build-time bug, not a runtime degrade-gracefully case.
const EXPECTED_STATE_VERSION = (() => {
  const parts = parseContractVersion(EXPECTED_SCHEDULER_CONTRACT);
  if (!parts) {
    throw new Error(
      `EXPECTED_SCHEDULER_CONTRACT is unparseable: ${EXPECTED_SCHEDULER_CONTRACT}. The plugin's own pin must parse.`
    );
  }
  return parts.stateVersion;
})();

// Fixed-argv preflight: print the on-disk STATE schema version the node would read. A version BELOW
// our pinned one is legacy (we'd write a schema it cannot read back); != pinned => refuse.
const STATE_VERSION_ARGV = [
  "sh",
  "-c",
  "cat ~/.uts-computing/scheduler/state/STATE_VERSION 2>/dev/null || echo 0"
];

async function preflightStateVersion(
  profile: ComputeProfile,
  timeoutMs: number,
  executor: TransferExecutor
): Promise<{ ok: boolean; reason: string; live: number | null }> {
  const result = await executor("ssh", sshJobArgs(profile.login.host_alias, timeoutMs, STATE_VERSION_ARGV), timeoutMs);
  if (result.exitCode !== 0) {
    return { ok: false, reason: "STATE_VERSION preflight SSH failed", live: null };
  }
  const live = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isFinite(live)) {
    return { ok: false, reason: "STATE_VERSION unreadable", live: null };
  }
  if (live === 0) {
    return { ok: true, reason: "no prior state (fresh node)", live: 0 }; // 0 = absent, fresh node is fine
  }
  if (live !== EXPECTED_STATE_VERSION) {
    return { ok: false, reason: `on-node STATE_VERSION ${live} != pinned ${EXPECTED_STATE_VERSION} (legacy)`, live };
  }
  return { ok: true, reason: "STATE_VERSION matches", live };
}
```
在 deploy 体内 orphan 门之后加:
```typescript
  // Lock 2.5 — STATE_VERSION preflight. A legacy on-node schema would strand an in-flight campaign.
  const statePreflight = await preflightStateVersion(profile, timeoutMs, executor);
  if (!statePreflight.ok) {
    throw new Error(
      `Refusing to deploy: ${statePreflight.reason} on ${profile.login.host_alias}. ` +
        `Run state.migrate or drain the campaign first.`
    );
  }
```

(b) **自有目录 + SHA256 + current symlink + keep-N=3**——把 rsync 目标从固定 `REMOTE_SCHEDULER_DIR` 改为时间戳/sha 化的 release 目录,deploy 后翻 `current` symlink 并裁剪。加常量与目录管理 argv(全部固定/sha 化字面,无 operator 插值):
```typescript
const PLUGIN_OWNED_ROOT = ".uts-computing/scheduler/releases";
const KEEP_N = 3;

// A release dir name = deploy timestamp; the SHA256 stamp is written INTO the release after rsync.
function releaseDirName(now: Date): string {
  return `rel-${safeTimestamp(now)}`;
}

// Fixed-shape dir prep: mkdir the release dir under the plugin-owned root. No operator interpolation
// (the name is a safeTimestamp-derived literal).
function buildPrepReleaseArgs(profile: ComputeProfile, timeoutMs: number, rel: string): string[] {
  return sshJobArgs(profile.login.host_alias, timeoutMs, ["mkdir", "-p", `${PLUGIN_OWNED_ROOT}/${rel}`]);
}

// After rsync: sha256-stamp the release, flip `current` atomically (ln -sfn), prune to KEEP_N.
function buildActivateAndPruneArgs(profile: ComputeProfile, timeoutMs: number, rel: string): string[] {
  const root = PLUGIN_OWNED_ROOT;
  const script =
    `cd ${root} && ` +
    `sha256sum ${rel}/scheduler/* 2>/dev/null | sha256sum | cut -d' ' -f1 > ${rel}/SHA256 && ` +
    `ln -sfn ${rel} current && ` +
    `ls -1dt rel-* | tail -n +$((${KEEP_N}+1)) | xargs -r rm -rf`;
  return sshJobArgs(profile.login.host_alias, timeoutMs, ["sh", "-c", script]);
}
```
把 `buildRsyncArgs` 的 `REMOTE_SCHEDULER_DIR` destination 改为 `${PLUGIN_OWNED_ROOT}/${rel}/scheduler/`(传入 `rel`);在 deploy 体内:STATE_VERSION 预检通过后,`const rel = releaseDirName(now);` → `executor("ssh", buildPrepReleaseArgs(...))` → rsync 到 release → `executor("ssh", buildActivateAndPruneArgs(...))` → 再做 post-deploy verify。

(c) **ordering 门**——把 post-deploy verify(`:126`)的 `ok` 从 `verdict === "match"` 改为基于 ordering:
```typescript
  const ordering = contractOrdering(version.live, EXPECTED_SCHEDULER_CONTRACT);
  const ok = ordering === "equal";
  const summary = ok
    ? `Deployed ihpc-scheduler to ${profile.login.host_alias} (release ${rel}) and verified the on-node contract (${EXPECTED_SCHEDULER_CONTRACT}).`
    : ordering === "newer" || ordering === "divergent"
      ? `Deployed but the on-node contract is ${ordering} (live ${version.live ?? "unreadable"} vs pinned ${EXPECTED_SCHEDULER_CONTRACT}) — refusing to treat as success; do not clobber a newer/divergent agent.`
      : `Deployed ihpc-scheduler to ${profile.login.host_alias} but verification is ${ordering} (live ${version.live ?? "unreadable"} expected ${EXPECTED_SCHEDULER_CONTRACT}). Re-check the node before launching.`;
```
并把 `SchedulerDeployResult.scheduler` 加 `ordering` 与 `release` 字段(透出)。

> 注:本任务**接 Phase A** 的 `schedulerVersion` 仍走它的 console 默认 runner;deploy 的 post-verify 经既有 `versionExecutor` adapter(`:121`)调用,runner 由 profile 决定(Task 5 已让 `schedulerVersion` 读 `node_scheduler`)。

- [ ] **Step 4: Run — PASS + 全套件绿**

Run: `cd mcp-server && npm run build && node --test tests/ops/scheduler-deploy.test.mjs`
Expected: PASS。
Run: `cd /Users/lizhw/Documents/Workspace/Product/uts-computing-platform && npm test 2>&1 | tail -3`
Expected: 绿。

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/ops/data/scheduler-deploy.ts mcp-server/tests/ops/scheduler-deploy.test.mjs
git commit -m "feat(ihpc): STATE_VERSION preflight + ordering gate + sha256 release dir + current symlink + keep-N=3 (Phase A)"
```

---

## Phase A 退出条件

- [ ] `probeSchedulerActive` 三态(`idle|active|indeterminate`),deploy **fail-closed**:SSH 错 / 空 / 不可解析 / 缺心跳 / 有活作业 全部**拒绝**;仅「present heartbeat + 零 work + orphan-clear」放行。
- [ ] 孤儿 GPU 探测经 `buildRawNodeProbeSshArgs`(固定 argv `nvidia-smi --query-compute-apps=pid` + `pgrep -f setsid`,零插值);有进程、探测 SSH 失败、或**工具缺失哨兵**(`PROBE_NVIDIA_MISSING`/`PROBE_PGREP_MISSING`)⇒ 拒绝;空 stdout 仅当两工具皆在且静默才算 clear(A-2:不让「工具缺失」误读为「clear」)。
- [ ] `contractOrdering(live,expected) → equal|older|newer|divergent` 在 `ops/scheduler/seam/contract.ts`;按 `(stateVersion,build)` 字典序;同序不同 sha ⇒ divergent;deploy 拒绝 `newer|divergent`。
- [ ] STATE_VERSION 预检:legacy/不匹配 ⇒ 拒绝(fresh 节点 `0` 放行);`EXPECTED_STATE_VERSION` 从 pinned 契约推导,**契约不可解析时模块加载即 throw**(A-1:不 `?? 0` fail-open)。
- [ ] `node_scheduler {runner: console|uv|cron_reboot, uv_bin?, dir?}` 入 schema + `core/types.ts` + 校验;缺省默认 console(既有 profile 校验不变);redact 仅披露 `has_node_scheduler` + `node_scheduler_runner`,**不**披露路径。
- [ ] `buildSchedulerSshArgs` console=干净 argv;uv=`sh -c 'cd <dir>/current && uv run --frozen --offline ...'`,严格 `SAFE_NODE_PATH` 校验;`runner_drift` verdict 透出。
- [ ] 部署到 `.uts-computing/scheduler/releases/rel-<ts>/` + SHA256 戳 + 原子 `current` symlink(`ln -sfn`)+ keep-N=3 裁剪。
- [ ] 全程**仅 mock executor**验证;无真实节点部署(首次真实 smoke 在 Phase C)。`npm test` 绿。
- [ ] 无新增 MCP 工具(deploy/version 既有);`node_scheduler` 入共享 `schemas/`(非 `.claude-plugin/`)——Codex 中立。

## 自查(spec 覆盖)

- §4「反转 `probeSchedulerActive` 为 fail-closed」→ Task 1 ✓;「孤儿 GPU 探测(固定 argv nvidia-smi --query-compute-apps=pid + pgrep -f setsid,无插值,新 builder)」→ Task 2 `buildRawNodeProbeSshArgs` ✓。
- §4「三把锁:token / 活跃探测(fail-closed + GPU-liveness)/ 部署后契约 match」→ Lock1(既有 token,保留)/ Lock2+2b(Task 1+2)/ Lock3(Task 6 ordering 门)✓。
- §4「`contractOrdering(live,expected)→equal|older|newer|divergent`,deploy 拒 newer|divergent」→ Task 3 + Task 6 ✓;建在 Phase 0 build-ordinal 格式上(前提已注明)。
- §4「STATE_VERSION 预检 + 拒绝」→ Task 6 `preflightStateVersion` ✓。
- §4「`node_scheduler` 字段 + 缺省 console + 严格白名单 + 脱敏仅披露 has_node_scheduler+runner 非路径」→ Task 4 ✓。
- §4「可配置调用 `buildSchedulerSshArgs`(console 干净 argv;uv `ssh host sh -c` 带 `cd <dir>/current && uv run --frozen --offline`)+ runner-drift verdict」→ Task 5 ✓。
- §4「部署到插件自有目录 + SHA256 戳 + current symlink + keep-N=3 回滚」→ Task 6 ✓。
- §8 客户端中立(node_scheduler 入 schemas;无新工具;Codex profile 校验不变)→ Task 4 显式测 ✓。
- **刻意 OUT(Phase A 边界):** 推进器(`node/progressor.py`,Phase C)、control 模块(placement/queue/plan,Phase B)、lease(Phase B 大脑侧 / Phase C 节点侧)、真实节点 smoke(Phase C)。本 plan 不触及。
