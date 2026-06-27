<!--
Auto-generated 2026-06-19 by a 16-subsystem multi-agent architecture survey (19 agents, run w59h5zdzr):
16 parallel deep-readers -> synthesis -> adversarial completeness pass. A documentation map, not a
source of truth: verify file:line specifics against the code before relying on them.

ERRATA (this snapshot predates the latest fixes):
- The migration project-relative vs per-user runtime-root inconsistency (§2.3 / §4.8 / §5.6 / §9) is
  FIXED in commit 337e5b1 — plan/apply now report/re-resolve paths relative to the runtime root, and
  migrations.test.mjs no longer pins UTS_COMPUTING_HOME=repoRoot.
- The distribution.md "tag v0.1.0" drift (§9) is FIXED (anchored to server.json's version).
- The .mcp.json -> profiles.local.yaml default (§9) was already changed to the shipped example.
- index.ts's server version literal (§9) is FIXED: it is now derived from package.json so it stays in
  lockstep with the manifests (the server advertises 0.1.1).
- The doc test-count drift (§其它承重 gotchas) is FIXED: architecture-overview.md now cites a stable
  test-file count (103 files) instead of a fast-drifting case total (`npm test` reports 586 passing
  cases as of 2026-06-21).
-->

# UTS Computing Platform — 架构与功能逻辑权威文档

> 面向"既要懂架构、也要懂业务流程"的读者。本文档融合 16 个子系统分析的结构化发现,所有关键论断尽量保留 `file:line` 引用以便追溯。除非特别说明,代码路径相对仓库根目录(MCP 服务实现位于 `mcp-server/`)。

---

## 1. 系统总览

### 1.1 它是什么

uts-computing-platform 是一个**面向 UTS HPC / iHPC 实验工作流的 MCP 插件**。它把"在 UTS 集群上跑一个实验"这件事,封装成一条**内容寻址(content-addressed)、配额包络门禁(conformance-gated)、全程审计(audited)的实验生命周期流水线**:计划(plan)→ 门禁(gate)→ 执行(submit)→ 监控/诊断(monitor/diagnose)→ 收集产物(collect)→ 复现/重试(reproduce/retry)。

它要解决的核心问题是:**让一个 LLM 智能体可以安全地、自主地操作真实的超算账户**——既不退化成一个"什么都能跑的通用 shell",也不会因为一次廉价计划骗取审批后提交一个昂贵作业。两条贯穿全局的设计主张是(`docs/architecture-overview.md:11-14`):

- **内容寻址的可复验执行(content-addressed re-verified execution)**:每一个会改变远端状态的动作,在触碰集群之前都会从保存的计划工件字节中**重新计算 `plan_hash`** 并比对,不匹配即拒绝。
- **以一致性取代令牌(conformance, not tokens / ADR 0004)**:对可逆且机器可验证的操作,授权不再依赖人工令牌,而是依赖针对一份**新鲜的实时配额快照**的一致性证明;只有不可逆操作才保留人工确认令牌。

### 1.2 两条发布渠道(实际为四个分发面)

一套**客户端中立的核心**(`mcp-server/dist` + `skills/`)通过若干薄清单(manifest)投射到多个宿主上,每个宿主用**各自不同的根变量约定**定位插件安装目录(`docs/distribution.md:3-12`):

| 分发面 | 清单文件 | 启动方式 / 根变量 |
|---|---|---|
| **Claude Code 插件** | `.mcp.json` + `.claude-plugin/plugin.json` | `node ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js`,`${CLAUDE_PLUGIN_ROOT}` 在 args 与 env 中都展开 |
| **Claude Desktop 一键包(.mcpb)** | `manifest.json`(manifest_version 0.3) | `${__dirname}/mcp-server/dist/index.js`;**注意** `${__dirname}` 在 args 中展开,但在 `user_config` 默认值中**不展开** |
| **MCP 注册表发现** | `server.json`(schema 2025-12-11,`io.github.mtics/uts-compute`) | 指向 GitHub release 的 `.mcpb` 下载,带 `fileSha256` 占位 |
| **本地/Git marketplace** | `.claude-plugin/marketplace.json` | 注册插件 `uts-compute`,`source: ./` |

两条主渠道根变量解析方式的**不对称**,正是 `defaultConfigPath()` 容错存在的根本原因(见 §5.0 与 §9)。

### 1.3 客户端中立设计

Claude Code 与 Codex(及 agentskills.io 智能体)**共享同一套资产**:`skills/`、`mcp-server/`、`schemas/`、`templates/`、`profiles/`。客户端差异被压缩到极小:

- Claude Code 通过 `.claude-plugin/plugin.json` 的 `"skills":"./skills/"` 接入;
- Codex 通过 `.agents/skills/` 符号链接镜像发现同样的 14 个 SKILL.md 目录(ADR 0005,退役了 Codex 插件包装层);
- 每个 skill 最多允许一个可选的 `agents/openai.yaml`(Codex 接口元数据),其形状由 CI 校验(`scripts/validate-plugin-package.mjs:307-342`)。

项目铁律(`CLAUDE.md`):**除非隔离在 `.claude-plugin/` 内,否则不得加入 Claude-only 行为**;核心实现保持客户端中立。

---

## 2. 架构与分层

### 2.1 机制-vs-策略的严格下行分层

源码按 `core / lib / ops / mcp` 四层组织,依赖**只能向下**,无环(`docs/architecture-overview.md:42,53`)。layering audit 已验证无循环依赖。

```
┌─────────────────────────────────────────────────────────────┐
│  mcp/  (协议表面 / Surface)                                    │
│   index.ts: McpServer over stdio, 47 个点号工具, safeTool 封装   │
│   mcp/resources.ts (25 个 uts:// 只读资源)                      │
│   mcp/prompts.ts (5 个引导式 prompt)                           │
│   mcp/schemas.ts (zod 输入 schema 工厂)   cli.ts (非 MCP 入口)  │
└───────────────────────────────┬─────────────────────────────┘
                                │ 只向下依赖
┌───────────────────────────────▼─────────────────────────────┐
│  ops/  (能力 / 组合 / 策略)                                     │
│   plans/    jobs/    approvals/    quotas/                    │
│   data/(transfer, artifacts, migrations)   catalog/(docs,模板) │
│   profiles/(onboarding, project, projects)  access/(doctor,…) │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│  lib/  (跨切关注的纯叶子 / 安全脊柱)                             │
│   process.ts(注入式 executor, shell:false)  ssh.ts(双跳 argv)  │
│   auth.ts(审批/令牌/配额门禁)  redact.ts  shared.ts  walltime   │
│   remote-python.ts(远端 Python 线字节)  evidence.ts            │
│   仅有的领域边: lib/redact → core/audit.redactCommand          │
└───────────────────────────────┬─────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────┐
│  core/  (叶子: 机制与契约)                                      │
│   types.ts · paths.ts · ids.ts · validation.ts               │
│   config.ts · audit.ts · access.ts                           │
│   (paths/ids/types/validation 无向上导入, 纯叶子)               │
└──────────────────────────────────────────────────────────────┘
                         注入式 executor 缝隙(测试可换桩,生产永不触达 HPC)
```

**"47 个点号工具"如何得来**:`index.ts` 把工具收敛进一张声明式 `TOOLS` 表并循环注册(取代了曾经的显式 `registerTool` 调用 + 独立 `TOOL_META` 表)。`grep defineTool(` **恰好命中 47 处**,全部是注册调用——泛型函数声明写作 `defineTool<…>(`(`:234`)并不匹配 `defineTool(`;若改用不带括号的 `grep defineTool` 则命中 49 处,多出的两处是该函数声明(`:234`)与一处注释(`:230`)。真正被注册的去重点号工具**恰好 47 个**,是被两套协议测试逐字钉死的活契约:`tool-registration.test.mjs` 的 `EXPECTED_TOOL_NAMES`(47 条,对真实 stdio 服务核对)与 `mcp-protocol.test.mjs` 再次现场重钉。

关键分层判定(`docs/archive/layering-audit-2026-06.md`):5 个修复步骤中 4 个完成,修掉了一个真实的 run-record 双写 bug;第 5 步"生命周期坍缩"被正确地判为 NO-OP(过度抽象),不要重新提议那个上帝编排器。

### 2.2 `projectRoot` 锚定

`core/paths.ts:10-12` 把仓库根锚定为 `resolve(distDir, '../../..')`——从编译后的 `dist/core/paths.js` 向上三级。这是**所有出货只读资产**(schemas/、examples/、templates/、bundled example profiles)的唯一解析锚点,因此资产解析与启动 CWD、安装目录无关。

- `schemas/` 经 `validation.ts:33` 的 `resolveProjectPath` 解析;
- `templates/*.hbs` 经 `templates.ts:53`;
- `profiles/profiles.example.yaml` 经 `config.ts:15`;
- git runner 的 cwd 锚到 projectRoot(`planner.ts:75`、`reproducibility.ts:71`)。

**已知 gotcha**:`../../..` 的深度是承重且脆弱的——它假设 `config.ts`/`paths.ts` 编译到 `dist/core/`。把 `core/` 在 `dist` 下移动会**静默破坏** schema/example/template/profile 解析(MEMORY `src-layer-structure.md` 已记录)。

### 2.3 运行期状态根(`.uts-computing`)与 per-user 隔离

运行期状态(run/plan/quota/approval/artifact/transfer 记录)写到一个**per-user** 的 `.uts-computing/` 根,**刻意不是** projectRoot。这是 P2 修复:一次现场安装曾在插件目录里积累了约 18.7k 个测试运行文件 / 163 MB(`paths.ts:27-44`)。

`runtimeBaseDir()` 的优先级**严格首匹配**(`paths.ts:37-44`,`state-dir.test.mjs:49-62`):

```
UTS_COMPUTING_STATE_DIR  (运维/CI 覆盖)
> UTS_COMPUTING_HOME      (测试隔离钩子,各 node --test 文件独立临时根)
> XDG_STATE_HOME          (仅当为绝对路径时才采纳)
> ~/.local/state          (per-user 默认)
```

`runtimeRootDir() = <base>/.uts-computing`。

**与状态迁移工具的潜在路径报告不一致(承重 gotcha,见 §4.8 / §5.6)**:迁移工具的 `relativeProjectPath`/`candidateFromProjectRelativePath` 是对 **projectRoot** 做相对/还原,而 `assertInsideRuntime` 围栏却是对 **per-user `runtimeBaseDir()`** 做约束。两者只有在"运行期 base 恰好等于 project root"时才对齐。在 v0.1.1 之后的默认 per-user 安装下,运行期状态写在家目录,迁移工具的 `records[].path` / `files_read` 因此会渲染成 `<outside-project>`。这是 v0.1.1 per-user 状态目录默认值与迁移工具 project-relative 报告之间的**活跃不一致**;测试套件必须钉 `UTS_COMPUTING_HOME=repoRoot` 才能让二者对账(`migrations.test.mjs:26-31`)。

### 2.4 RUNTIME_DIRS 与路径围栏守卫

`RUNTIME_DIRS`(`paths.ts:55-66`)是 10 个 `.uts-computing/<subdir>` 相对字面量的规范 `as const` 表(runs/plans/approvals/quotas/artifacts/transfers/jobOps/onboarding/access/docsCache),被约 17 个模块作为默认目录常量导入,**防止字符串漂移**。其字面量值本身就是承重契约。

四道围栏守卫**刻意不合并**(各自的抛错字符串是被测试逐字钉住的契约):

1. **`assertInsideProject`**(`paths.ts:18-25`):相对候选限定在 projectRoot;`..`/绝对逃逸抛 "must stay inside the project root"。
2. **`assertInsideRuntime`**(`paths.ts:68-83`):相对字面量对 `runtimeBaseDir()` 解析后限定在 `runtimeRootDir()`;绝对候选(测试临时目录)原样接受;51 个调用点。
3. **`assertRealPathInside` / `assertRealPathInsideRealRoot`**(`paths.ts:86-105`):用 `realpathSync` 同时解析候选与根再做包含检查,击败指向资源目录之外的符号链接;`*RealRoot` 变体接受预解析根(用于一次解析根的度量遍历循环),并刻意发出不同的错误后缀。
4. **`resolveRecordPath`**(`paths.ts:113-125`):读侧扁平记录路径构造器,先做廉价相对预检查,再做 realpath 守卫,被 `audit.readRunRecord`、`plan-store.readPlanArtifact`、`ihpc-start.readQuotaSnapshot` 共享。

**信任不对称(刻意)**:运维提供的**绝对** config/profile 路径**允许**逃出 projectRoot(真实用户档案文件在家目录),只有相对的、可被攻击者影响的路径才被围栏(`config.ts:46-50`)。

---

## 3. 领域模型与数据契约

### 3.1 核心类型(`core/types.ts`)

| 类型 | 位置 | 角色 |
|---|---|---|
| **PLATFORM / Platform** | `types.ts:7-8` | 仅两个平台串 `'uts-hpc'`/`'uts-ihpc'`;Platform 由 const 派生,联合与取值永不矛盾;约 38 处分支用 `PLATFORM.HPC/IHPC` |
| **ComputeProfile** | `types.ts:50-70` | 运维的每账户档案:身份(platform/account_label)、login(host_alias、`*_ref`、requires_vpn)、defaults(queue/node_family/workspace/scratch/project)、可选 quota_snapshot。**唯一携带凭据线索的输入** |
| **JobSpec** | `types.ts:72-110` | 归一化的实验提交请求:run_id、profile_id、platform、experiment、resources、command、可选 resumable 断点契约、可选 approval 提示 |
| **PlannedJob** | `types.ts:126-151` | dry-run 计划工件:mode `'dry-run'`、`plan_hash`、template、script、command_argv(仅 iHPC)、normalized_job_spec、approval、approval_operation、retry_of、warnings、spec_diff |
| **RunRecord** | `types.ts:183-230` | 持久审计记录,贯穿状态机 planned→submitting→submitted/running→finished/failed/cancelled/unknown;含 rev(乐观并发)、plan_hash、quota_snapshot_id、approval 块、supervisor、submission、usage、append-only events[]、reproducibility、project/project_hash、retry_of |
| **SubmissionContext** | `types.ts:169-181` | 冻结的、**无机密**的 who/where/what:account_label + cluster 登录主机(从不含原始用户名)+ 请求资源 + submitted_at |
| **ApprovalRecord** | `types.ts:243-265` | 绑定到 run/profile/platform/operation/plan_hash/quota_snapshot_id 的授权令;含 used_at/consumed_by 单次消费标记 |
| **QuotaSnapshot** | `types.ts:644` | 实时账户证据快照:snapshot_id、profile_id、platform、observed_at、source const `'quotas.refresh'`、freshness、summary{identity,queues,node_families,sessions,storage,running_work}、commands[]、warnings |
| **Transfer\*** | `types.ts:402-459` | TransferPlan / PlannedTransfer / TransferExecutionRecord |
| **Artifact\*** | `types.ts` + schemas | ArtifactManifest / FetchRecord / FetchBatchRecord / SummaryRecord / CleanupPlan / CleanupExecutionRecord |
| **Reproducibility / GitState / EnvironmentState** | `types.ts:15-33` | 复现块,被 reproduce-run skill 消费 |
| **RetryLineage** | `types.ts:112-118` | {source_run_id, source_status(failed\|cancelled), source_plan_hash, planned_at, reason?},是 planned-job 与 run-record 两个 schema 共享的 `$def` |

### 3.2 与 JSON Schema 的关系(共 21 个 schema)

每一种落盘/上线的记录都有一份**权威 JSON Schema**(全部 `additionalProperties:false`),由 `validation.ts:27-56` 在模块加载时用 **Ajv 2020-12 + ajv-formats** 编译一次。每个 `validateX` 返回 `{valid,errors}`,每个 `assertX` 抛错并收窄 TS 类型,**在每一个落盘/上线边界都设了 schema 闸门**。

代表性绑定:`profile.schema.json`、`job-spec.schema.json`、`planned-job.schema.json`、`run-record.schema.json`、`approval-record.schema.json`、`quota-snapshot.schema.json`、`onboarding-record.schema.json`、`access-check-result.schema.json`、`transfer-plan/planned-transfer/transfer-execution-record`、`artifact-manifest/fetch/fetch-batch/summary/cleanup-plan/cleanup-execution`、`docs-cache-record`、`state-migration-plan/apply`。

**重要约束在 schema 而非 TS**:例如 `ncpus>=1`、`memory_gb>=1`、`walltime` 正则 `^[0-9]{1,3}:[0-5][0-9]:[0-5][0-9]$` 仅由 `job-spec.schema.json:36-52` 强制;TS 的 `JobSpec.resources` 是松散的(`ncpus?:number`),跳过 `assertJobSpec` 会放过越界值。

`run_id` 文法在**两处**必须对齐:`ids.ts:7` 的 `SAFE_RUN_ID_PATTERN` `/^[a-z0-9][a-z0-9-]{2,127}$/` 与 `job-spec.schema.json:10` 的同一正则。

### 3.3 哪些是机密、如何脱敏

**靠构造保证机密卫生**:`ComputeProfile` 只存 `*_ref` 指针(username_ref、identity_file_ref、keychain_ref)——环境变量名/keychain 条目名,**从不存机密值本身**(`types.ts:54-61`;示例 `UTS_HPC_ACCOUNT_A_USER`)。SSH 认证本身委托给用户的 ssh-agent/keychain/IdentityFile(BatchMode),**服务端从不经手密码或密钥材料**。

脱敏/派生核心(`config.ts:107-175`):
- `clusterFromHostAlias` 从 `user@host` 取 host 部分(丢弃用户名);
- `profileAccountName` 取 user 部分作为显示账户(回退到裸 alias、再回退 account_label);
- `redactProfile` 把每个可携密字段折叠成 `has_*` 布尔(`config.ts:146-175`),被 `profiles.list`、`uts://profiles` 资源、`access.check` 消费。

远端路径脱敏:`maskUserRootPath`(`config.ts:207-240`)把跟在档案声明的挂载前缀后的 `${USER}` 段替换为 `<user>`,**最长前缀优先**(`/data/labx/` 不被更短的 `/data/` 误掩)。命令脱敏:`redactCommand`(`audit.ts:35-73`)分层清洗密码/令牌/API 密钥/MFA/Bearer/url 凭据/PEM 块/高熵 blob,但**刻意放过十六进制摘要**(让 plan_hash 存活)与**带分隔符的串**(让 run-id/路径存活)。

---

## 4. 子系统功能逻辑

### 4.1 规划(planning)— `ops/plans/`

**职责**:把已校验的 JobSpec 确定性地变成内容寻址的 PlannedJob,并产出 `plan_hash`——下游每一个上线门禁绑定的密码学锚点。M1 严格本地:`planJob` **不做任何 SSH/qsub/cnode/rsync/远端写**(`planner.ts:258`)。

关键组件:`planJob`(`planner.ts:27` 编排器)、`normalizeJobSpec`(`:180` 合并 defaults、GPU 强制 gpuq、派生 workdir、替换 `${USER}`)、`buildPlanHash`/`planHashForPlan`(`:137,154`)、`parseCommandArgv`(`command-argv.ts:3`,仅 iHPC 的无 shell argv 分词器)、`diffJobSpecs`(`spec-diff.ts:16`,纯顾问性)、`captureReproducibility`(`reproducibility.ts:66`,尽力而为)、`writePlanArtifact`/`readVerifiedPlan`(`plan-store.ts`)。

**plan_hash 确定性**:`sha256(stableJson({normalized_job_spec, template, script, [approval_operation], [retry_of]}))`。git 状态、环境、project、quota_snapshot_id、warnings、spec_diff、approval.policy、audit/plan 路径**全部刻意排除**,使哈希跨机器/时间稳定(`planner.ts:137-149`,`shared.ts:84-101`)。

### 4.2 审批(approvals)— `ops/approvals/` + `lib/auth.ts`

**职责**:文件后端的审批状态机,把每个上线/破坏性操作绑定到**精确的 plan_hash + 新鲜配额快照 + 每操作资源范围**,要求可信确认令牌把 `required→approved` 翻转,执行时单次消费;并提供一条**令牌无关的自治一致性路径**。

状态机:`required → approved | rejected`(仅经 `decideApproval`,仅从 `required`);`required|approved → expired`(惰性,任何超 TTL 的读触发);`approved` 经 `used_at/consumed_by` 单次消费(**不是独立 state 值**——见 §9 gotcha)。

确定性 approval_id = `approval-{runId}-{op8}-{planHash16}-{quota16}[-{scope16}]`,使 request 幂等且抗碰撞(`approvals.ts:80-88`)。`approvalExpiresAt = min(now+expiryHours, observedAt+maxAge)`——审批**永不超出其配额窗口**(默认 15 分钟)。

### 4.3 提交执行(submission)— `ops/jobs/submit.ts` + `ihpc-start.ts`

**职责**:把已验证的 dry-run 计划变成真实远端作业,两条平台路径:**PBS HPC**(`qsub` 经 SSH stdin 喂入保存的脚本)与 **iHPC**(固定 base64 编码的 Python supervisor,经两跳 SSH `Popen` 一个 argv-only 命令于新会话)。背后是叠加门禁:plan-hash 自完整性 → 档案 onboarding → 审批或实时一致性 → 崩溃安全的 `submitting` 标记。

**两套刻意分立的执行机制,不统一**:
- PBS = 单跳 `ssh -T <host> qsub`,脚本走 stdin(调度器拥有进程);iHPC 状态用 `os.kill(pid,0)` 探活,取消用 `os.killpg(SIGTERM)`,usage 恒为 null(`jobs.ts:416-417`)。
- iHPC = 两跳 SSH 到发现的交互计算节点,运行固定 Python supervisor,`Popen(start_new_session=True)` 使进程在 SSH 断连后存活,无批调度器。

### 4.4 监控诊断(monitoring)— `ops/jobs/jobs.ts` + `diagnose.ts`

**职责**:"观察并作用于已提交工作"的另一半,把异构的 PBS 与 iHPC 后端归一到同一条 RunRecord 生命周期与状态词汇。读为主、安全优先的可观测性:每次远端读都被 allowlist、字节有界、脱敏、记为证据;唯一变更远端的是 `jobs.cancel`,且只在绑定、单次审批之后。

- `reconcileRunStatus`(`jobs.ts`):单次轮询路径,按平台路由 PBS(`qstat -f`,完成态退回 `qstat -x -f` 查历史)或 iHPC(`os.kill` 探活)。
- PBS 状态映射(策略,`parseQstatStatus` `jobs.ts:653-682`):Q/H/W/T→submitted,R/E/S→running,C/F→finished(除非 `Exit_status` 有限非零则 failed);未映射字母/超时/非零退出→unknown。
- `classifyFailure`(`diagnose.ts:46-97`):有序正则故障分类(**顺序承重,首匹配胜**):session-timeout > resource-request > quota > access > environment > data-path > command;前三类高置信。
- **终态钳制**:一旦 finished/failed/cancelled,后续轮询不能把它移回非终态(`jobs.ts:698-701`)。
- **乐观并发**:每次 run-record 写都 bump rev,磁盘 rev 超前于内存基 rev 则拒写(`audit.ts:145-164`)。

### 4.5 配额/容量/onboarding/access — `ops/quotas/` + `ops/profiles/onboarding.ts` + `ops/access/`

**职责**:回答"现在提交安全吗?"。SSH 抓取实时账户配额证据到 schema 校验的快照,再派生为:容量顾问、自治提交一致性门禁、首跑 onboarding 门禁、连通性预检(access/doctor)、iHPC 节点用量确认工具、本地 rightsize/projects 汇总。除 onboarding 标记写与 confirm_usage 的单条 allowlist 命令外,**全部只读/顾问性**。

- `refreshQuotas`(`quotas.ts`):按平台分发,跑固定 allowlist 的只读 SSH 探针(HPC:whoami/id/groups + qstat -Q/-Qf/-u + pbsnodes;iHPC:cnode avail/all/mynodes + sessiontime + projvolu;加 df/du),解析、schema 校验、脱敏远端用户名、写证据文件。
- `checkPbsConformance`(`conformance.ts`):自治提交门禁,纯检查作业是否落在实时 PBS 队列限内;**失败即安全**——若结构化限未被观测(`limits-unverified`)立即拒绝,绝不盲提。

**PBS 违规码全集与精确语义(承构造,getting wrong 会误门禁作业)**:`ConformanceViolation` 的完整码集是 `limits-unverified`、`unknown-queue`、`queue-disabled`、`acl-denied`、`ncpus-exceeded`、`mem-exceeded`、`ngpus-exceeded`、`walltime-exceeded`、`max-run-exceeded`、`max-queued-exceeted`(每用户运行/排队上限)、`storage-full`、`storage-headroom`(`conformance.ts:74-107,121-238`)。一致性要求:队列存在、enabled 且 started、ACL 准入(user 或 group 闸)、落在 `resources_max`(ncpus/mem_gb/walltime/ngpus)内,且**再提交一个不会超**每用户有效上限(`running+1` / `queued+1`,即 +1 语义)。

**`effectiveUserLimit` 优先级(getting wrong 会误门禁)**:`user > group(取最小) > generic > overall`(`quota-limits.ts:57-106`)。这编码了真实 PBS scoped-limit 语法(如 `[u:PBS_GENERIC=60]`);多个匹配 group 时取**最保守的最小上限**。

**存储余量不是配额(关键区分)**:99% 上限是**满盘守卫**而非每用户配额——UTS 存储是共享 NFS,**没有每用户配额**,文件系统/调度器仍是权威(`conformance.ts:9-10,33-72`)。把它当配额会理解错;正因如此,存储在一个本应硬门禁的检查内部呈现为"顾问形"。当未观测到可用量(df 失败、`filesystems.length===0`)时,存储守卫被跳过而非阻塞(`submit.ts:225`)。

**列截断队列名前缀匹配回退**:`qstat -u` 会把长队列名截断成如 `small_g*`;`lookupQueueCounts` 用前缀匹配回退处理这一真实 qstat 怪癖(`capacity.ts:198`,`submit.ts:233`),否则会把 running/queued 计数清零、过度授予余量。

- onboarding 门禁:`assertProfileOnboarded`(`onboarding.ts:63-70`)。档案只有在一次真实连接观测到远端身份后才被 onboarded(`liveAccessConfirmed` 要求 `remote_user_observed === true`);失败的首连**不**解锁提交。一份既有快照也满足门禁(向后兼容逃生口)。

**doctor 专属探针与 per-profile 隔离**:`access.doctor`(`doctor.ts:62-92`)在 access.check 连通性电池上叠加**远端时钟偏移**与 **PBS 调度器可达**探针,汇总成 ok/warn/fail rollup;**一个坏档案永不中止整轮 sweep**(per-profile 隔离)。doctor 刻意用**更低的 5s 默认超时**(连通性探针),而 quotas/submit 默认 10s,全体共享 30s 上限——这是被各发现反复标记"不可压平"的 per-module 超时策略分裂的一部分(`access.ts:64-68`,`quotas.ts:26-29`,`doctor.ts:56-60`)。

### 4.6 数据传输(transfers)— `ops/data/transfer.ts`

**职责**:两阶段 rsync 暂存。`transfers.plan` 渲染哈希化、文件固定的 dry-run 计划工件;`transfers.execute` **自治地**跑固定 rsync argv,带远/本地预检、sha256 校验、字节/文件上限、双重项目/运行根路径围栏。`transfers.execute` 的审批是接受但**不要求**——保存的 plan_hash + 固定文件列表 + max_total_bytes + checksum 校验**即门禁**。

### 4.7 产物/目录(artifacts/catalog)— `ops/data/artifacts.ts` + `ops/catalog/`

**职责**:run 范围的产物生命周期(list→manifest→fetch/batch→summarize→cleanup-plan→cleanup-execute),加上固定 allowlist 的官方文档缓存与静态模板目录。**从不给智能体一个自由形式的文件原语**:每次远端触碰都经一个经 SSH 投递的嵌入式 Python 助手在**远端侧**重新校验 realpath 包含;每次本地写都被围栏在 `.uts-computing/artifacts`;唯一破坏性路径(cleanup.execute)受类型化审批门禁,绑定到 run 身份、plan_hash、配额快照、manifest 哈希与精确 artifact-id 集合。

**fetch/batch 覆盖 vs cleanup 精确——承重的安全不对称**:fetch/batch 的字节上限用 `>=`(必须**覆盖**,读可以欠预算);cleanup 的上限用**精确相等**(`max_artifacts === 计数`、`max_total_bytes === manifest 总和的精确值`,`delete_mode === 'unlink-regular-files-only'`)。`artifacts.ts:287` 与 `:441` 两处内联注释**专门存在**,就是为了阻止 reviewer 把这条"fetch/batch 审批可选、cleanup 审批必需"的设计"修正"成一律必需。这条 exact-vs-cover 不对称是承重的安全区分,不可压平。

**产物度量汇总引擎(`collectMetrics`/`sanitizeJsonMetric`,反凭据外泄设计)**:`artifacts.summarize` 不是通用文件读取器,而是 allowlist + 上限 + 脱敏引擎(`artifacts.ts:1278-1416,1447-1497`):
- 文件必须**同时**匹配度量名 token **和**允许扩展名(json/jsonl/ndjson/csv/tsv),且**不**匹配机密文件名正则,才被打开;
- 上限:每文件 1MB / 总 5MB / 100 文件;JSON 深度 4 / 500 键 / 50 数组项;表格 1000 行 / 100 列;
- `>200` 字符的串与匹配机密值模式的串被丢弃,机密键被跳过;
- **符号链接永不读取**。

这套设计使 summarize **不能意外外泄**被输出捕获的凭据,值得多于一句的篇幅。

**docs/catalog 子系统**(`docs.refresh` / `docs.search` / `templates.list`,`ops/catalog/`):

- `docs.refresh`(`docs.ts:279`)是**唯一未门禁的出站 HTTPS 路径**,但被严密约束:固定 `REMOTE_DOC_SOURCES` 源 id allowlist(无调用方 URL/host/header/path);URL 必须是 HTTPS 且落在 host allowlist(`hpc/ihpc.research.uts.edu.au`);`redirect:'manual'` + 最终 URL host 重校验(**3xx 被拒**,防 allowlisted URL 跳到非 allowlisted host);content-type allowlist;content-length **预检** + 流式 body 字节上限(超出立即取消);HTML→text 净化(剥脚本/样式/注释/标签,解实体);`sha256(body)` 后写 schema 校验的缓存记录(`docs.ts:473-566,647-660,707-728`)。**已知 footgun**:host allowlist 信任 UTS DNS,**无 IP 钉定**,DNS-rebinding 对固定 hostname 不在本层范围内。
- `docs.search`(`docs.ts:252`)只读**出货的本地 DOCS allowlist**:`resolveDocPath` 对 project root 做 realpath 约束;query 必须 2-200 字符、无控制字符;`docIds` 至多 10 个且唯一(`docs.ts:422-437,774-797`)。从不取 URL、从不读任意路径。
- `templates.list` 返回静态 `TEMPLATE_CATALOG`(5 个 PBS/iHPC/transfer dry-run 模板);`renderTemplate` 做带缺失变量守卫的 `{{var}}` 替换。

### 4.8 状态迁移(state migration)— `ops/data/migrations.ts`

**职责**:两阶段(dry-run plan / 令牌确认 apply)MCP 子系统,扫描本地 `.uts-computing` 树,校验每条持久记录,**仅加法地**把 `schema_version: "0.1.0"` 戳到已有效但缺它的记录上,带备份、原子写、plan-hash 绑定、符号链接/逃逸拒绝,**从不变更语义状态**。其 project-relative 路径报告与默认 per-user 状态根之间的不一致见 §2.3;apply 的 TOCTOU 防御与全有或全无语义见 §5.6。

### 4.9 MCP 装配/工具注册 — `mcp/` + `index.ts`

stdio `McpServer`,经声明式 TOOLS 表注册**恰好 47 个**点号工具(派生方式见 §2.1),10 个资源集合,5 个引导 prompt,全部经 `safeTool` 封装归一为统一 `{ ok, ... }` JSON 信封。这是**唯一触碰 SDK 的地方**;别处全是客户端中立的 ops/core 逻辑。

### 4.10 安全库(security libs)— `lib/*` + `core/audit` + `core/access`

一组纯叶子库共同拥有端到端信任流水线:无 shell 的注入式 executor、加固的双跳 SSH argv 装配(每跳主机密钥策略不同)、argv allowlist、分层机密/PII 脱敏、审批绑定授权门禁、字节上限、围栏检查的证据写入。这些库**刻意从各模块的副本中合并**,正是为了让这些安全助手不能漂移——这里的分歧就是安全 bug。

### 4.11 Skills — `skills/`

14 个纯 markdown、客户端中立的 Skill,编码 UTS HPC/iHPC 实验的工作流/决策/停止条件策略,把 47 个工具组合成安全端到端流;**把每个有副作用的动作、机密、授权都委托给 MCP 服务**(详见 §7)。

### 4.12 WebUI — `webui/`

只读为主、仅本地(127.0.0.1)的 Node HTTP 服务 + 零构建原生 SPA,可视化 MCP 服务写出的同一份**已脱敏的** `.uts-computing/` 运行记录;它的四个写动作路由经**完全相同的领域函数**(因此同样的安全门禁)。仪表盘只是另一个调用者,绝非旁路(详见 §8)。

---

## 5. 端到端业务流程(最重要)

### 5.0 启动期配置解析(每条渠道的前置)

`index.ts:186/198` 调 `listProfiles()/validateProfiles()` **不带显式 configPath**,于是默认参 `defaultConfigPath()`(`config.ts:23-43`)生效,读 `process.env.UTS_COMPUTING_CONFIG` 并按序三重回退:
1. 未设/空 → bundled example,**静默**(`config.ts:26`);
2. 值仍含 `${`(宿主未替换其令牌)→ bundled example **加 stderr 警告**(`:27-33`);
3. 值存在且无令牌但磁盘不存在 → bundled example **加"not found"警告**(`:35-41`)。

否则返回解析后的绝对存在路径。`bundledExampleConfigPath()`(`:14-16`)对 projectRoot 解析 `profiles/profiles.example.yaml`,从任意启动目录都正确。**四个**回归用例钉住此不变量(`config-fallback.test.mjs:28-62`):未设、`${...}` 令牌、缺失文件、以及一个有效的**外部绝对路径**(原样采纳、不被项目围栏)。

### 5.1 流程 (a):Profile 选择 → onboarding 首跑门禁 → access.check/doctor 连通性预检

1. **选档案**:`profiles.list`/`profiles.validate` → `loadProfileConfig(defaultConfigPath())`(`config.ts:45,77,81`)。校验 `version===1`、profiles 数组、profile_id 唯一(`config.ts:53-72`),每档案过 `assertProfile`(Ajv `profile.schema.json`)。输出经 `redactProfile`(`config.ts:146`)。**铁律**:每次上线操作恰用一个 profile_id(ADR 0002),多账户用于授权/项目分离/审计,**永不**合并配额池。

2. **连通性预检——短路电池流(承重)**:`access.check` → `checkAccessForProfile`(`access.ts:76-203`)跑一条**短路连通性电池**,严格按序:`profile → ssh-config → dns → tcp → host-key → ssh-auth → remote-identity → vpn`;**前一步失败则跳过后续步**(belt-and-suspenders)。在真正 spawn 之前,`assertAllowedAccessCommand`(`:398-438`)对**整条 ssh argv 做位置性重校验**:每对 `-o`(BatchMode=yes、PasswordAuthentication=no、KbdInteractiveAuthentication=no、NumberOfPasswordPrompts=0、StrictHostKeyChecking=yes、UpdateHostKeys=no)、数值 ConnectTimeout、host alias 安全,远端命令被限于 allowlist `[['true'],['id','-un']]`;remote-identity 的 stdout 被**整体替换为 `<redacted-identity>`**(`:541`)。"重校验它即将 spawn 的 argv"是一道**独立**的安全机制,而非信任装配器。`access.doctor`(`doctor.ts:62-92`)在此电池上加远端时钟偏移与 PBS 调度器可达探针(用更低的 5s 超时),汇总 ok/warn/fail,一个坏档案不中止整轮。

3. **onboarding 首跑门禁**:`profiles.onboard` → `onboardProfile`(`onboarding.ts:90-117`)经 `refreshQuotas` 连接,要求 `summary.identity.remote_user_observed === true`,然后写持久 marker。`isProfileOnboarded`(`:56-61`)= 有 onboarding 文件 **或** 任一捕获的配额快照。**这是 `jobs.submit` 在任何平台分发前硬性强制的前置**(`submit.ts:56`);dry-run `jobs.plan` 不受门禁。

### 5.2 流程 (b):作业全生命周期 plan → (dry-run) → approve → submit → monitor → collect

#### 公共前段:plan(dry-run)

`jobs.plan`(`index.ts:413`)或 `cli.ts:19` 调 `planJob`:
- `assertJobSpec`(`planner.ts:28`,Ajv)→ `getProfile`(`:29`)→ profile.platform vs jobSpec.platform 不匹配抛错(`:31-35`)→ `resolveRemoteUser`(`:164`)→ `normalizeJobSpec`(`:180-202`,合并 defaults、GPU>0 强制 `queue='gpuq'`、派生 `workdir=<workspace|scratch>/<run_id>`、替换 `${USER}`)。
- `validateDryRunBoundaries`(`:219-255`):workdir 绝对/无 `..`/无 shell 活跃字符且嵌套在档案 workspace/scratch 根内;command 非空、无控制字符、无 `#PBS` 注入;HPC 需 queue+ncpus+memory_gb+walltime,iHPC 需 node_family;array 边界合理。
- `chooseTemplate`(`:204`)→ `renderTemplate`(`:52`)→ **`buildPlanHash`**(`:53,137`)→ 组装 PlannedJob(`:56-71`)。**ADR 0004 顺序不变量**:`approval.policy:'advisory'` 在 `buildPlanHash` **之后**才 spread 到计划上,使顾问降级不扰动哈希(`:67-69`)。
- 一次 git 探针(`makeGitRunner` over projectRoot)同时喂 project 身份与 reproducibility(`:75-76`,两者都不入 plan_hash)。`buildRunRecord`+`writeRunRecord`(status `planned`,`audit.ts:75,120`)。`writePlanArtifact`。附上顾问性 `spec_diff`(从不持久化/哈希)。

#### approve(可选,或走自治)

`approvals.request` → `requestApproval`(`approvals.ts:68`):派生确定性 approval_id,经 `assertPlanMatchesApprovalRequest`(`:168` 重算 `planHashForPlan` 并检查 == 保存且请求的哈希,且 operation==期望)再验证保存的计划,经 `assertFreshMatchingQuotaSnapshot`(`:370`,默认 15 分钟窗口)读配额快照,写 state `required`。`approvals.decide` → `decideApproval`(`:246`)要求可信确认令牌(`assertConfirmationToken`,`auth.ts:99`——选项覆盖否则 env `UTS_COMPUTING_APPROVAL_TOKEN`;未设则**任何审批都无法授予**),重检 plan_hash & quota_snapshot_id,写 `approved`/`rejected`。

#### submit — PBS HPC 路径(`submit.ts`)

1. `assertSafeRunId`/`assertSafeApprovalId` 文法检查。
2. **`readVerifiedPlan`**(`plan-store.ts:38-44`):加载保存的 PlannedJob 并重算 `planHashForPlan`,若 != 存储 plan_hash 则该工件被篡改,抛错(plan 自完整性门禁)。
3. `assertProfileOnboarded`(`submit.ts:56`)。
4. 按 `plan.platform` 分支(IHPC 委托 `startIhpcRun`;HPC 续行;其他抛错)。
5. 读 RunRecord;`getProfile`;断言 profile.platform == plan.platform;由 lineage 计算 `expectedOperation`(jobs.submit vs jobs.retry)。
6. **授权二选一**(`submit.ts:79-93`):有 `approvalId` 时 `approvalStatus` 加载 + `assertApprovalUsableForPlan` 绑定;无则需新鲜 `quotaSnapshotId`,`conformanceForPlan` → `checkPbsConformance` 须 `conforms:true`。两者皆无即抛错。
7. 守卫 `runRecord.status == 'planned'`。
8. **崩溃安全标记**:在远端调用**之前**写 status='submitting' + plan_hash + quota_snapshot_id + 'live-submit-attempt' 事件(`:99-128`)。
9. `sshSubmitArgs` → `sshSingleHopArgs`(外跳加固前奏、`-T`、host alias、尾随 `['qsub']`)执行 ssh,PBS 脚本经 stdin 喂入 `runProcess(shell:false)`。非零退出抛脱敏失败摘要。
10. `parseRemoteJobId` 用 PBS 作业 id 文法校验 qsub stdout(`:257-263`)。**立即持久化 `remote_job_id`**(第二次写,在消费审批**之前**,使崩溃不孤儿化集群作业)。
11. `consumeApproval`(审批模式下)标 `used_at`。最后置 status='submitted',建无机密 submission context,附审批块,推 'live-submit' 事件,写记录,返回 `SubmitResult`(脱敏命令)。

#### submit — iHPC 路径(`startIhpcRun`,`ihpc-start.ts`)

同样的 plan/onboarding/审批-或-快照脊柱,但一致性是 `selectActiveComputeNode`(`:269-306`,要求新鲜快照显示活跃 cnode 会话且节点匹配请求的 node_family,解析 `snapshot.summary.sessions.active_nodes + node_families`)。`buildSupervisorSpec`(`:230-267`)校验 workdir 在档案根内,**重解析 command_argv 并断言 == 计划保存的 command_argv**(防篡改 argv),派生 workdir/logs 下固定 log/pid/metadata 路径。`encodeSpec` base64url 编码;`sshSupervisorArgs` 建两跳 argv(外跳到网关、内跳 `ssh -o StrictHostKeyChecking=accept-new <node> python3 - <spec>`);固定 `SUPERVISOR_PY` 经 stdin。远端 Python 对 realpath 化的 `allowed_roots` 重校验每条路径,然后 `Popen(command_argv, cwd=workdir, stdin=DEVNULL, start_new_session=True, close_fds=True)`,写 pid/metadata,打印 JSON 行。`remote_job_id = ihpc-<run_id>-<pid>`;status 直达 `running`(无批调度器)。

#### monitor(status/logs/diagnose)

见 §4.4。`jobs.status` → `reconcileRunStatus`;`jobs.track` → `listRunRecordIds` → `readRunRecordSafe` → 分区(终态跳过、submitting-无-remote_job_id 标记 `needs_reconciliation`、planned-无-id 跳过、active)→ 限额 + 截断标志 → `mapBounded(4)` 扇出。`jobs.logs` 字节有界(默认 16384、硬上限 200000;diagnose 默认 8000),PBS 用 `tail -c` 从计划声明的 `#PBS -o/-e` 路径,iHPC 用 `IHPC_LOGS_PY` seek-to-tail,**脱敏后再次截断**。`jobs.diagnose` → status + 尽力而为 logs → `classifyFailure`。

#### collect(artifacts)

`artifacts.list` → `readVerifiedPlan` → `plannedOutputPaths`(workdir 须在档案根内,每个 output 须在 workdir 内)→ `encodeSpec` → `sshArtifactArgs` → `ARTIFACT_LIST_PY` 远端遍历、realpath 围栏、捕获 size+SHA-256 → 写规范 manifest.json(`manifest_hash = sha256(manifest 文件字节)`)。`artifacts.fetch`:按 opaque artifact_id 查 manifest,要求 `run.plan_hash == plan.plan_hash` 且 quota_snapshot_id 存在,`ARTIFACT_FETCH_PY` 返回 base64 内容,**三重 SHA-256 校验**(本地 == 远端 == manifest),写入 `files/` 围栏内。`artifacts.summarize` 本地遍历缓存,allowlist + 上限 + 机密脱敏地抽取度量(详见 §4.7)。

#### collect — `artifacts.cleanup.execute` 破坏性流程(最重门禁,与传输 (d) 平行)

这是最受门禁的破坏性操作,独立成流(`artifacts.ts:655,1113-1159,2000-2004`):

```
artifacts.cleanup.execute
  │ 终态守卫: run.status ∈ {finished,failed,cancelled} (:1155)
  ▼
  manifestHash 匹配检查 (绑定到精确的最新 manifest)
  ▼
  每个目标必须 kind:file 且 checksum_status=='captured' + 有 sha256 + 整数 size
  ▼
  消费 scope 匹配的强制审批 (assertArtifactCleanupApproval, :1113-1146):
    delete_mode === 'unlink-regular-files-only'
    max_artifacts === 精确计数
    max_total_bytes === manifest 总和精确相等 (不是覆盖)
    artifact_ids / manifest_hash 精确匹配
    + 绑定 run/profile/platform + plan_hash + quota_snapshot
  ▼
  远端 ARTIFACT_CLEANUP_EXECUTE_PY: 每个 unlink 前重验 containment + 常规文件 + 非符号链接 + size + SHA (:2000-2004)
  ▼
  本地删除: lstat (非 stat) + 拒符号链接 + realpath 重约束在缓存内, 然后 unlink (:1213-1233)
  ▼
  写 evidence + recordOperationEvidence 单次 run-record 事件
```

#### retry 全生命周期流(triage→jobs.retry.plan)

`triage-and-retry` 经 `jobs.status/logs` → `jobs.diagnose` → 按故障类分支后,走 `planRetryJob`/`buildRetryJobSpec`(`retry.ts:43-215`):

```
jobs.retry.plan
  │ retryable 源状态检查: failed(任意) 或 cancelled(带显式 reason) — 否则拒
  ▼
  assertSourceRecordMatchesPlan: 源记录身份 + 源 plan_hash 必须匹配保存的计划
  ▼
  recompute 源 plan_hash (自完整性)
  ▼
  buildRetryJobSpec:
    新 run_id (须 != source, 且无既有本地 plan/run 状态)
    deriveRetryWorkdir: 仅交换源 workdir 尾段的 run_id
       ── gotcha: 源 workdir 必须以源 run_id 结尾, 否则 retry 被阻 (:205-215)
    1-4x 升配钳制 (顾问性; submit 时一致性门禁仍按队列 resources_max 封顶)
    声明式 resume: 校验后的 resume_flag + checkpoint_path (从不 glob/扫目录)
  ▼
  re-plan via planJob → approval_operation='jobs.retry' + retry_of 折入 plan_hash (planHashForPlan)
  ▼
  → 新 retry 审批 (fresh, jobs.retry operation) → submit
```

### 5.3 流程 (c):dry-run / approve / submit 三段式安全门禁模型

```
                  plan (dry-run, 无 SSH)
                        │ 产 PlannedJob + plan_hash
                        │ (approval.required/reasons 仅顾问性, ADR 0004)
                        ▼
        ┌───────────────────────────────────────────┐
        │  授权:两条互斥路径                          │
        ├──────────────────────┬────────────────────┤
        │  人工审批(令牌门禁)   │  自治一致性(无令牌) │
        │  approvals.request    │  须新鲜 quotaSnapshot│
        │  → required           │  (<=15min,id/profile/│
        │  approvals.decide      │   platform 匹配)     │
        │  (assertConfirmation   │  checkPbsConformance │
        │   Token, plan_hash &   │  须 conforms:true    │
        │   quota 重检) → approved│  否则抛具体违规限    │
        └──────────────────────┴────────────────────┘
                        │
                        ▼
        submit:每个生效工具在任何 SSH 前
          assertApprovalUsableForPlan / assertApprovalBoundTo
          重绑定 LIVE 计划/run 身份 + plan_hash + quota_snapshot_id
          + 每操作资源 scope
                        │ 远端命令成功、remote_job_id 已持久化之后
                        ▼
        consumeApproval:置 used_at/consumed_by(严格单次)
```

**绑定的精确性**:审批仅对其精确 run_id/profile_id/platform + plan_hash(+ operation jobs.submit vs jobs.retry,后者经 `planHashForPlan` 折入 plan_hash)有效。改 profile/资源/命令/路径/队列/walltime/操作类即令审批失效。带 scope 的操作(transfers.execute、artifacts.fetch/.batch/.cleanup.execute)额外把 `resource_summary` 哈希成 `scope_hash` 嵌入 approval_id,并在执行时重验完整 resource_summary。**fetch/batch 用 `>=` 覆盖、cleanup 用精确相等**(详见 §4.7):`delete_mode` 必须 == `'unlink-regular-files-only'`、`max_artifacts` 必须 == 精确计数、`max_total_bytes` 必须**精确相等**(不是覆盖)。

**自治一致性路径(ADR 0004 的核心)**:针对一份新鲜的实时配额包络证明一致性,**替代**人工审批令牌,让智能体可无人值守地提交,只要作业可证明落在真实限内。`jobs.cancel` **无**自治路径(总需 approvalId);submit/iHPC-start 有。

### 5.4 流程 (d):数据暂存 transfers.plan / execute

**plan**(`planTransfer`,`transfer.ts:94-149`):Ajv 校验 `transfer-plan.schema.json` → `getProfile` → 对 source & destination 做 `assertSafePath` + `assertTransferRootCharacters`(绝对、无 `..`、无 shell 活跃字符、无空白)→ `normalizeTransferFiles`(1..1000、唯一、安全文法、剥 `./`)→ `normalizeMaxTotalBytes`(undefined=无限,有值则 1..50GB)→ 渲染顾问性 rsync 脚本(**从不执行**)→ `buildTransferPlanHash` → 写 `<runtime>/.uts-computing/transfers/<run_id>/plan.json`。**无任何 SSH/rsync/UTS 接触**。

**execute**(`executeTransfer`,`:155-240`):读+校验 plan.json,断言 run_id 匹配且 mode==='dry-run' → **重算哈希,!= 保存的 plan_hash 即篡改抛错**(`:168-171`)→ 若传 approvalId 则 `assertTransferApproval`(身份 + plan_hash + resource_summary,**可选**)→ `requireTransferFiles`+`requireMaxTotalBytes`(execute 时强制,即便 plan schema 标可选)→ **按方向预检**:
- **download**:source-在-档案根 + dest-在-运行根(`assertDestinationInsideRuntime`),检视**远端** source;
- **upload**:dest-在-档案根 + source-是-**项目根内**存在目录(`assertExistingDirectoryInsideProject`),本地 stat+checksum(总和 <= 上限)。

**双重围栏(承重安全边界)**:upload SOURCE 须项目根内现存目录;download DESTINATION 须 per-user 运行 transfers 目录内;任一方向的远端端点须档案声明的 workspace/scratch/project 根内。然后(若有审批)`consumeApproval` 单次消费,建固定 rsync argv(`-a --checksum --files-from=- -e '<ssh -T>'`),文件经 stdin 喂入。**后检**:download 重校验存在/非符号链接/realpath-在-dest/size/重哈希;upload 重检远端 dest size+sha256 相等并采用远端后检文件集作为证据。`checksum`:<=50MB 'captured'、更大 'skipped-large',后检提升 captured→verified。rsync 脱敏**必须用 substring 模式**(host alias 与 root 是单个 `host:/root/...` argv token 的子串)。**超时刻意高**:默认 30s、上限 10min(远超其他模块的 30s 上限),因为传输移动大数据集。

### 5.5 流程 (e):sweep 批量扫描与 rightsize

**sweep.plan**(`planSweep`,`sweep.ts:54-140`):把有界网格展开成**一个** PBS array 作业(单个 plan_hash),shell 注入安全的替换,可选容量调优并发。三条承重规则:
1. **网格大小先从轴长度上限 256**(在物化笛卡尔积**之前**,避免 OOM——如 10 轴 × 8 = 1e9 在 `expandGrid` 物化前就被拒,`sweep.ts:71-76`);
2. **每个 `{param}` 必须出现在基命令中**(否则替换无意义,`:118-140`),且每个值过 allowlist;
3. **`max_concurrent` 只下调、永不上调**到实时队列运行余量(`:199-233`)——"只降不升"是安全相关的那一半:它能把过激并发收紧到真实余量,但绝不会因容量调优而把用户声明的并发抬高。

**graceful degradation**:`sweep.plan` 只发 CPU PBS array,故 run-sweep skill 把 GPU 搜索改路为 N 个单独 run-experiment 作业、iHPC 搜索改为逐个 ihpc-run-background。`sweep.rank` 是对已完成 sweep 度量的只读顾问。

**rightsize**(`rightsizeProject`,`rightsize.ts:30-67`):纯本地顾问,逐项目比较 requested-typical(中位)vs used-peak(最大)的 mem/walltime/gpus + 中位 CPU 效率,过度请求约 2x+ 建议下调、紧张(<1.1x)建议加余量。**只读本地运行记录,从不连接**。

### 5.6 流程 (f):状态迁移 state.migrate.plan / apply

**plan**(`planStateMigration`,`migrations.ts:110`):`assertInsideRuntime(runtimeRoot ?? '.uts-computing')` → realpath 化 → `scanRuntimeTree` 按子目录分发扫描器(access/approvals/runs 扁平;quotas 包装感知;plans;transfers/artifacts 按文件名前缀的 run 目录)。每候选过 `fileCandidate`(拒符号链接、非常规文件、realpath 逃逸)。`recordFromValidation`:invalid→blocked;version=='0.1.0'→current;否则→would-update/add-schema-version。算 `plan_hash`,自校验。返回 `writes_planned:false`。

**apply**(`applyStateMigration`,`:170`)——**TOCTOU 防御 + 全有或全无 blocker 语义**:
1. **令牌门禁优先**(`:174`,在扫描/写之前)→ 缺失抛 "requires a trusted confirmation token",不匹配抛 "Invalid migration confirmation token";
2. **用同一个 `now` 重跑 plan**(`:180`)→ `planHash` hex 检查 → **若入参 `planHash` != 新算 plan_hash 则拒**(TOCTOU 防御,`:181-184`);
3. **blocker 检查**(`:185-187`):`cannot_migrate` 非空则**整体拒绝**——一个损坏/符号链接/逃逸文件阻塞**整个** apply,**没有部分/跳过坏文件模式**(全有或全无);
4. 写前**预先准备并重校验**所有迁移值(`:215`,任何校验失败在任何写之前抛)→ 备份(`.uts-computing/backups/<safeTimestamp>`)+ 每文件原子写(临时文件+rename)。

**仅加法**:唯一变更是设 `schema_version`(或 `snapshot.schema_version`)='0.1.0' 到已 schema 有效的记录上;从不修复损坏记录、从不改字段含义、从不触碰审批/run 语义状态(`approval_state_changed`/`run_state_changed` 硬编码为 false)。**无记录需更新时**返回 `writes_applied:false`,连 `backups/` 目录都不创建。

---

## 6. 安全与信任模型

**Plan→Gate→Execute→Redact→Persist** 流水线,四个跨切不变量(无每模块各自重实现):

1. **无 shell 注入**:每个远端命令经唯一 `runProcess`(`process.ts:39`,`spawn({shell:false, windowsHide:true})`)缝隙,带每工具 argv allowlist。`shell:false, ever` 是无注入保证。注入式 `Executor` 类型既是安全咽喉也是可测试缝隙——换桩即可全链路测试而永不触达 HPC。

2. **无机密/PII 泄漏到审计**:`redactCommand`(分层正则)+ `maskHostAlias`(精确模式)+ `maskUserRootPath`(挂载前缀下用户名→`<user>`)在任何持久化之前清洗。`submission_context` 靠构造无机密(仅 account_label + cluster)。**两种脱敏模式不可互换**:'exact' 用于独立 argv token,'substring' 用于 rsync `host:/root` 路径——选错会静默欠脱敏(本子系统最微妙的 footgun)。

3. **字节上限**:在 SSH 边界**两侧**强制——TS 校验 argv 并切片输出,远端 Python 独立重解码、realpath 检查包含、用不同退出码强制 max_bytes(`SystemExit(3)` 非常规文件、`SystemExit(4)` 超 max_bytes)。

4. **路径围栏 + checksum**:见 §2.4。**纵深防御**:包含与 size/checksum 策略在 TS 与远端 Python 中**双重**强制(`PY_INSIDE_REALPATH` commonpath、运行字节总和、每文件 checksum 阈值),并在解析助手 JSON 时再校验。本地 `sha256File` 1MiB chunk 与远端 `PY_SHA256_FILE` 1MiB chunk **锁步**(快照测试钉住)。

5. **审批令牌**:人工确认令牌**只来自宿主环境**(`UTS_COMPUTING_APPROVAL_TOKEN`)或显式覆盖——模型文本永不构成审批(`auth.ts:99-111`)。

6. **只读 vs 变更——精确的非只读工具集**:`destructiveHint:true` 仅 `jobs.cancel`/`artifacts.cleanup.execute`/`transfers.execute`/`state.migrate.apply`。而**非只读**(`readOnlyHint:false`)的工具集比"4 个破坏性"大:完整清单是 `access.confirm_usage`、`jobs.submit`、`jobs.cancel`、`transfers.execute`、`artifacts.fetch`、`artifacts.fetch.batch`、`artifacts.cleanup.execute`、`state.migrate.apply`、`approvals.request`、`approvals.decide`(`index.ts:128-136`,`EXPECTED_TOOL_ANNOTATIONS` 钉住)。注意 `fetch` 与 `fetch.batch` 是**两个**不同工具、`request` 与 `decide` 也是两个,所以这是 10+ 个**不同工具**而非"8 类";安全注解(readOnly/destructive/openWorld)是被测试逐条钉住的契约(`idempotentHint` 未被钉,可能漂移)。

7. **每跳 SSH 主机密钥策略分裂**:外跳(本地→网关)用 `StrictHostKeyChecking=yes`(预钉网关);内跳(网关→动态发现的计算节点)用 `accept-new` TOFU(节点未预钉)。argv 位置被测试钉住,顺序不得变(`ssh.ts:9-19,119-138`)。

8. **可复现性**:`plan_hash` 与 `project_hash` 是规范内容的纯 sha256,无中央注册表,同输入在任意机器产同 id。git 状态/环境/project 被记录但**从不折入** plan_hash,使内容地址不被 git-脏或项目重标签扰动。

**远端线字节的刻意分歧(pinned-must-not-merge,§4.10 的反复主题)**:两组远端 Python 片段被刻意保持分立,绝不合并(`remote-python.ts:12-27`):
- **两个 `fail()` 变体**:`PY_FAIL_FIXED`(恒 exit 2)vs `PY_FAIL_CODED`(exit 3=非常规文件 / exit 4=超 max_bytes),让 TS 侧能区分 fetch 失败模式;
- **两套远端路径包含策略**:文件遍历助手用 commonpath 的 `PY_INSIDE_REALPATH`,而 supervisor 用"`real==root` 或 `real.startswith(root+os.sep)`"对一个 roots **列表**逐个检查。

这些是被金标准快照测试(`tests/remote-python-snapshot.test.mjs`)逐字节钉住的线字节;§6 提到了不同退出码,但更要点明:它们是**故意不合并**的线片段,合并会静默把畸形请求归零或拒绝合法值。

**Tier 模型(ADR 0004)**:可逆+一致的操作(submit/transfer/fetch)自治运行,由实时配额一致性门禁;只有不可逆/结构性操作(cleanup.execute 删除、jobs.cancel、state.migrate.apply)需宿主令牌。`docs.refresh` 是唯一未门禁的 HTTPS 出口例外,由固定源 allowlist + manual-redirect 主机钉定 + 最终 URL host 重校验(3xx 拒)+ content-type + 字节上限约束(端到端流程见 §4.7)。文档诚实陈述:即便保留的令牌对一个有 shell 能力的智能体也不是硬边界——真正约束它的是**结构性**的(scope 绑定的单次审批、删除前远端 size+SHA-256 重验、仅加法迁移加每文件备份)。

---

## 7. Skills 如何把 MCP 工具编排成用户工作流(14 个 skill)

Skills 是程序性知识/编排层(严格的 Skill-vs-MCP 边界,`docs/mcp-skills-composition-review.md:33-51`)。**Skills 拥有**:工作流、决策策略、停止条件、审批提示、工具顺序;**绝不拥有** SSH/PBS/iHPC/rsync 执行、机密处理、授权。当所需 MCP 工具缺失时,Skill 必须**停下并指明缺失的里程碑**,而非退化到直接 shell。

| Skill | 类型 | 映射到的流程 | 核心工具序列 |
|---|---|---|---|
| **select-profile** | 构建块 | (a) | profiles.list/validate → access.check → quotas.refresh;一档案一操作 |
| **plan-experiment** | 构建块 | (b) plan | 重述目标 → 选平台 → profiles.onboard(首用)→ quotas.capacity 定并行度 → job spec |
| **hpc-submit-pbs** | 构建块 | (b) PBS | jobs.plan → jobs.submit(runId, approvalId\|quotaSnapshotId) |
| **ihpc-run-background** | 构建块 | (b) iHPC | jobs.plan → jobs.submit(从活跃 cnode 派生节点) |
| **run-experiment** | 编排器 | (a)+(b)+(c) | select+onboard → plan → capacity → 授权(Tier-A 自治)→ submit → **强制 jobs.status 验证** → 交接 |
| **run-sweep** | 编排器 | (e) | quotas.capacity → sweep.plan(网格→一个 PBS array)→ submit → jobs.track → artifacts.list→fetch.batch→summarize → sweep.rank |
| **triage-and-retry** | 编排器 | (b) monitor + retry | jobs.status/logs → jobs.diagnose → 按类分支 → jobs.retry.plan(escalate/resume)→ 新 retry 审批 → submit;有界重试 |
| **reproduce-run** | 编排器 | (b) | jobs.history → 读 uts://run-records/{runId} 复现块 → jobs.plan(**新 plan_hash**)→ submit |
| **fleet-status** | 编排器 | monitor | jobs.track 单次和解 → projects.list 汇总 → jobs.history/usage,严格只读 |
| **review-approvals** | 编排器 | (c) Tier-B | 枚举 uts://approval-records → approvals.status(过期失效)→ 人工 approvals.decide(宿主令牌)→ 绑定工具单次消费 |
| **monitor-and-recover** | 构建块 | monitor | 单 run 恢复(track/diagnose/rightsize/retry) |
| **analyze-artifacts** | 构建块 | collect | 基于 manifest 的窄产物分析(无任意浏览/glob)|
| **stage-transfer** | 构建块 | (d) | 固定文件 rsync(无 glob/--delete/任意目标)|
| **confirm-usage** | 独立响应器 | — | 解析 iHPC 邮件 → access.confirm_usage(profileId,node,token) |

**confirm-usage 端到端 live-SSH 响应流(唯一直接用户触发的 live 动作)**:`confirmUsageOnNode`(`confirm-usage.ts:18-45`)解析 iHPC 用量监控邮件取 `node` + `token` → **iHPC-only 档案检查**(非 iHPC 抛错)→ token 必须匹配 `/^[A-Za-z0-9]{4,32}$/`(任何 SSH 之前)→ 经 `sshOnNode`(两跳)跑**唯一 allowlist 命令** `confirm_usage <token>`;`sshOnNode` 在 `node === hostAlias`(仅网关)时**省略内跳**。这是 §4.11 表里仅列名、但实为直接用户触发 live SSH 的那条流。

**已知漂移(在 fix/doc-drift-and-cleanup 分支上活跃)**:较旧的单步 skill(hpc-submit-pbs/ihpc-run-background)仍指示"上线提交前确保审批记录绑定 plan_hash + quota_snapshot_id",这**早于且抵触** ADR-0004 的 Tier-A 自治模型(编排器与服务端都已反映)。字面遵循 hpc-submit-pbs 会**过度门禁**每次 PBS 提交。编排器正确,构建块陈旧。

---

## 8. WebUI — 只读看板读取同一 .uts-computing 状态

`webui/server.mjs`(绑定 127.0.0.1)+ `webui/public/` 零构建原生 SPA。它的存在理由:可视化同一份已脱敏的运行记录而不触碰客户端中立的 MCP 核心。

**复用而非重实现**:读端点只触碰 MCP 服务写出的、**已脱敏的**本地 JSON(经 `jobsHistory`/`listProjects`/`readRunRecordSafe`/`quotaCapacity`,直接从 `dist/` 导入编译后的领域函数,以**复用同一脱敏**)。写动作(clone/submit/abort/approve)路由经**完全相同**的 `planRetryJob`/`submitJob`/`cancelJob`/`requestApproval`/`decideApproval`——因此同样的 plan_hash/conformance/审批令牌门禁。**仪表盘只是另一个调用者,绝非旁路**(`webui/server.mjs:1-7`)。

**WebUI 特有的安全代码与权衡**:
- **CSRF 门禁 `isSameOriginJson`**(`server.mjs:340-346`):要求 `application/json` 且拒绝任何**跨源** Origin。**gotcha**:同源 Origin 通过,**缺失 Origin 头也通过**——只有"存在的跨源 Origin"才被拒。这只因服务绑定 127.0.0.1 才可接受。
- **静态文件遍历守卫**:`path.normalize` 后必须以 `PUBLIC_DIR` 前缀开头;run id 经从 `dist` 导入的同一 `SAFE_RUN_ID_PATTERN` 校验(不漂移)。
- **Tier-B 令牌**从 server env 注入到 `decideApproval`(同时给 input 与 options),浏览器从不见到也不发送它。
- **XSS 漏斗 `esc()`**(`app.js:19-20`):前端用模板串 + `innerHTML` 构造标记,所有插值的 run/project/command 串都过 `esc()` HTML 实体转义——这是 run/project/command 串的主 XSS 防御。
- **CDN 无 SRI 供应链权衡**(`index.html:10-16`):Tabler/ApexCharts/List.js 经 CDN 加载,**无 Subresource-Integrity 哈希**、仅钉次版本——对一个离线化本地工具被明确接受的供应链权衡。

**仅前端(无服务端等价物)的派生启发式**(`app.js:377-402,1196-1202`):
- `computeNeedsAttention`:把 `failed`/`unknown`/`needs-reconciliation`/`dirty-git` 的 run 标为需关注;
- `resourceFitReasons`/over-requested:`memory req > used*1.5 且 req-used>2`,或 `CPU 效率 <20%` 时标记过度请求,驱动 Explore 的 right-sizing 表与关注 chips。

这些启发式只活在 `app.js`,服务端没有对应实现。读端点 `/api/explore`、`/api/summary` 在 webui 层重读完整记录嫁接 usage/requested 投影(共享 jobsHistory 契约刻意省略它们以保持无机密紧凑摘要)——聚合静默封顶 500 runs。

---

## 9. 关键设计决策、权衡与已知 gotchas

### ADR 思想
- **ADR 0004(配额包络自治)**——最具决定性的取舍。在同机部署下,每次提交的人工令牌被判为安全戏剧(智能体能读/设自己的 env 变量),故授权改为锚定在平台实时的每账户配额包络;令牌只保留给 3 个不可逆操作。`approval-policy.ts` 的风险阈值(16cpu/64gb/24h/受限队列/GPU)降级为顾问性显示。
- **ADR 0005(标准优先分发)**:退役 Codex 插件包装层,只保留一个 Claude Code 插件 + 标准 MCP 配置 + `.agents/skills` 符号链接镜像。
- **ADR 0002(多账户安全)**:每个上线操作恰绑一个 profile_id;**阻止**自动跨账户分发;从不存机密。仍完全生效。

### 双确认/审批与崩溃安全
- **写顺序编码崩溃安全**:status='submitting' + plan_hash + quota_snapshot_id 在远端 qsub/start **之前**持久化;remote_job_id 在消费审批**之前**第二次写;只有这之后 status 才推进。卡在 'submitting' 无 remote_job_id 的记录被 `jobs.track` 浮为 `needs_reconciliation`,**绝不盲目重提**。
- **审批单次**:`consumeApproval` 若 `used_at` 已设则抛错;远端作业 id 在消费**之前**持久化,使崩溃不能孤儿化作业。
- **配额新鲜度封顶审批 TTL**:`approvalExpiresAt = min(now+expiryHours, observedAt+maxAge)`——审批不能超出它所依据的配额窗口。

### await footgun(MEMORY + b229083 修复)
`safeTool` **只 await 顶层返回**。把 async 调用包在对象字面量里——`safeTool(() => ({ access: checkAccess(...) }))`——留下未解析的 Promise,`JSON.stringify` 发出 `{"access":{}}`,结果被静默丢弃。正确写法:`async () => ({ access: await checkAccess(...) })` 或直接返回 promise。对象包装**只对同步生产者安全**。这是被修复过的真实潜伏 bug(`index.ts:86-96`)。

### 其它承重 gotchas
- **无 'consumed' 状态值**:schema/类型的 state 枚举只有 `not_required|required|approved|rejected|expired`。消费经 `used_at + consumed_by` 字段带外跟踪,一条已消费记录仍读为 `state:'approved'`。
- **'not_required' 只出现在 run-record 的冻结审批块**(自治路径戳),`requestApproval` 从不写 `not_required` 的独立审批文件。
- **`projectRoot` 的 `../../..` 深度脆弱**:移动 `core/` 模块会静默破坏 schema/example/template/profile 解析。
- **`.mcp.json` 指向永不出货的 `profiles.local.yaml`**:干净插件安装该路径总是缺失,故插件用户**静默地**跑在 example profiles 上,直到创建 local.yaml——只有可能被忽略的 stderr 警告。
- **迁移工具 project-relative 报告 vs per-user 状态根**:见 §2.3——默认安装下 `records[].path` 渲染为 `<outside-project>`,测试须钉 `UTS_COMPUTING_HOME=repoRoot`。这是 v0.1.1 per-user 默认值与迁移工具报告的活跃不一致。
- **`current_schema_version` 在 would-update 分支报为 null**(而非文件实际串):仅因每个记录 schema 把 `schema_version` 钉到枚举 `['0.1.0']` 才安全;未来第二版本需重做此 null 报告。
- **walltime 解析器分裂不可压平**:`parseWalltimeSeconds`(严格,用户请求)vs `parseHmsSeconds`(宽松,可信调度器输出);合并会静默把畸形请求归零或拒绝合法调度器值。
- **版本漂移**:`index.ts:57` 的服务版本字面量 `'0.1.0'` 落后于插件的 0.1.1;`docs/distribution.md:51` 仍写 `tag v0.1.0` 而 server.json 与四个清单都在 0.1.1;`server.json` 出货占位 `fileSha256`(仅因发布是手工步骤才正确)。迁移目标 `schema_version='0.1.0'` 刻意与发布版 0.1.1 解耦(schema 内容版本只在 schema 改时才 bump)。
- **测试计数曾是文档里最不稳定的数字,现已收敛**:MEMORY 在各审计点记录过 258/345/365,文档亦先后写过 366/484。为止血,`architecture-overview.md:9` 现改用**稳定的测试文件数**(103 个文件)而非快速漂移的用例总数(`npm test` 于 2026-06-21 报告 586 用例全部通过)。其余规模数字(工具 / skills / schemas / 模块)请以 `architecture-overview.md` 的当前值为准,不在此处重复其易漂移的快照。

---

*文档结束。本架构的设计哲学贯穿始终:每个工具的规格在"拒绝什么"上花的笔墨多于"做什么"——"最窄可行 schema"与处处 `additionalProperties:false` 是被协议测试强制的陈述性不变量。*
