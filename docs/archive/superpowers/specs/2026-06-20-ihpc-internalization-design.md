# iHPC 内化 + 运营加固 —— 设计 Spec

- **日期:** 2026-06-20
- **状态:** **完成 —— 全部 6 个 Phase 已交付**(见 §11.1、§11.2、§11.3、§11.4、§11.5)。本 spec 自此 **COMPLETE**。
- **范围说明:** 本 spec 同时覆盖两条共享同一根因的交织战线:(a) 针对真实使用中暴露的**闭世界**故障对插件做**运营加固**;(b) 把 on-node 的 `ihpc-sched` 调度器**内化**为插件可控的产物。两者一起排期,因为最高杠杆的修复(adopt、token 接线、调度器版本握手)是其余工作的前置。
- **所有者决策:**
  1. 以记录 upstream SHA 的方式 vendor 调度器最小子集(不用 submodule)。
  2. 即便某问题在 HEAD 已修,仍按完整加固集逐项覆盖。
  3. 工具命名为 `ihpc.scheduler.version`(裸名词,非 `..._check`)。
  4. `parameter_space` 是 preflight 的可选输入。
  5. `jobs.adopt`/`adopt_pbs` 是单点最高杠杆修复,领衔 Phase 1。
  6. `campaign_id` 显式声明;扇出路径必填,单作业可选。
  7. **这 4 个账号是一个共享项目下两位合作者的独立 allocation —— 每位所有者恰好持有一个 HPC + 一个 iHPC 账号(同一平台上无两个账号)。** 因此同平台「每账号配额翻倍」的模式在此结构上并不存在;多账号并行使用属于政策**允许**的情形。公平使用组件**强制每账号自身上限并记录归属(attribution)**,而非阻断多账号使用。
  8. 按运营影响重排优先级:致命问题 #1(闭世界 adopt)、#2(审批 token 失效)、#3(无 `ihpc-sched` 生命周期)先于一切。
- **来源:** `docs/AUDIT_2026-06-19_ihpc-sched-internalization.md`(P1–P10);`docs/accounts-and-safety.md`(公平使用);§3–§5 记录的"实际使用"五领域 / 18 项完备性复审;`docs/superpowers/plans/2026-06-20-tier1-ihpc-hardening.md`(Tier-1 任务,已并入)。

---

## 1. 背景与一句话结论

2026-06-19,一次跨平台的 42-study HPO campaign 经研究侧裸脚本铺到 2 HPC + 2 iHPC 账号。本会话里,这个**本应作为操作工具**的插件,在提交、监控、撤销、重分配几乎每个阶段都被绕过。

> **一句话根因:插件是一个闭世界观测器(closed-world observer)。** 全部 38 个工具都以*仅由插件自己 plan→submit 流水线创建*的 RunRecord 为唯一键。一旦真实工作在插件之外启动(裸 `qsub`、`ihpc-sched`),整张工具面立刻失明。再叠加两条独立致命缺陷 —— 审批 token 从未接进安装、对 `ihpc-sched` 零生命周期能力 —— 就解释了为何本会话插件几乎没派上用场。

代码级研究还确认:急性的*调度器*故障(P3 引号崩溃、P4 过量派发)是**某账号静默运行的陈旧 `origin/main`** 的属性,在权威分支(`mtics/uts-ihpc` @ `e6883a9`)中已修复/缓解。那里的基石是 **P2 —— 版本分发**:没有任何机制保证一个账号实际跑的是哪个调度器版本。

---

## 2. 目标 / 非目标

### 目标
1. **打开闭世界:** 一个 `jobs.adopt` 缝,从外部证据(`qstat -x`、已知 iHPC pid)合成 RunRecord,使 status/usage/logs/cancel/history/diagnose 能作用于非插件启动的工作。
2. **让插件能动手:** 把 `UTS_COMPUTING_APPROVAL_TOKEN` 接进安装,使 token 门控操作(`jobs.cancel`、`artifacts.cleanup.execute`、`state.migrate.apply`、`approvals.decide`)真正可用。
3. **赋予插件对 `ihpc-sched` 的生命周期:** 版本握手 → 部署钉定版本 → 观测。插件成为唯一控制面;调度器仍留在 on-node。
4. **让插件如实自陈:** 暴露 `using_example_profiles`、有效 `config_path` 与真实 `login_host`;不再静默坍缩到示例 profile。
5. **补上人工接管缝:** `access.doctor --export-ssh`,在插件做不了时让人能接手。
6. **投放前校验:** `ihpc.campaign.preflight`(dataset / param_overrides 形状)。
7. **每账号公平使用合规 + 透明归属**(见 §10):硬强制每账号自身上限;记录一个 campaign 合法跨越不同合作者的独立 allocation。
8. **正确性加固:** 审查全部工具的 `safeTool` 嵌套 await 隐患;修小 bug(`jobs.history since`、脆弱的 `projectRoot`)。

### 非目标
- 调度器循环**留在 on-node**(韧性:断网/休眠存活)。插件永不在本地运行它。
- 不用 TypeScript 重写调度器逻辑。
- **不做检测规避。** campaign 台账与归属的存在是为了**披露**多 allocation 使用并证明每账号合规,绝非隐藏。任何单账号越过其自身上限,无论有无 attestation,一律硬阻。
- 除 adopt + 每账号强制 + 归属外,不做跨账号编排。
- 不自动部署、不触碰正在运行的 42-study campaign(在代码中强制;见 §9)。

---

## 3. 五条系统性主题

1. **闭世界观测。** status/usage/logs/cancel/history/retry/diagnose 全部依赖本地创建的 RunRecord。一个 adopt/reconcile 缝(`qstat -x` 或已知 iHPC pid → 合成 RunRecord)是单点最高杠杆 —— 一次解锁约 8 项问题。**本地只读 WebUI(`webui/server.mjs`)是同一模型的第二张脸**:其 `/api/{runs,explore,summary}` 经 `jobsHistory`/`readRunRecordSafe` 读同一份 RunRecord 存储,因此对着真实 campaign 显示 `total_runs:0`,且会被 adopt 顺带治好 —— *前提是先修好它的存储路径 bug(W1),使它读到服务器实际写入的那份存储*。
2. **访问路径不对称。** 插件知道自己用的 host/user/ssh,却把它们当凭据全部脱敏;唯一对外暴露的主机名是一个不可达的 `:22` 文档 URL。插件做不了时,人也接不了手,因为工具把自己本有的可达性藏了起来。
3. **静默错配回退。** 未设 / 为空 / 未替换的 config 坍缩到自带示例 profile —— 而最常见的干净安装场景(路径未设/为空)是**完全静默、无任何告警**的;只有未替换的 `${...}` 与文件未找到这两种情形会写出一条被吞掉的 stderr。此后所有访问/配额/作业结果都失去意义,失败还被误判成 VPN 问题。
4. **只建议不执行。** diagnose、retry.plan、sweep.plan/rank、capacity、审批流全部停在一句建议或一次 dry-run;没有 execute/编排/批处理路径。于是 42-study sweep 的瞬态失败恢复退化成 O(失败数) 次人工往返。
5. **带外耦合与脆弱分发。** 正确性悄悄依赖安装从未建立的不变量:审批 token、`username_ref` env、`${CLAUDE_PLUGIN_ROOT}`/`${__dirname}` 展开、`projectRoot` 深度假设,以及一个插件既不能钉版本也无法探测的 on-node `ihpc-sched`。全都潜伏到最糟的时刻才爆。

---

## 4. 问题清单(按运营影响排序)

严重度来自实际使用复审;"修复者"映射 §7/§8 单元,"Phase"映射 §12。

### 致命
| # | 问题 | 实质 | 修复者 | Phase |
|---|---|---|---|---|
| C1 | 外部作业不可见且不可控 | 无 adopt:真实 campaign 返回 `total:0`,既查不到也停不掉(合并 OBS-1/2、LC1/2、IHPC-5) | `jobs.adopt` + `pbsRowToRunRecord`/`ihpcPidToRunRecord` | 1 |
| C2 | 审批门控开箱即废 | `UTS_COMPUTING_APPROVAL_TOKEN` 从未进 `.mcp.json`/`manifest.json`;`cancel`/`cleanup`/`migrate`/`approvals.decide` 硬抛 | 安装 token 接线 + `approvals.list` | 1 |
| C3 | 对 `ihpc-sched` 零生命周期 | 无法部署、钉版本、甚至检测节点调度器是否陈旧;基石审计故障(两账户跑不同版本→OOM)完全在插件之外 | `ihpc.scheduler.version`(Ph1)→ `deploy`(Ph2) | 1→2 |

### 高
| # | 问题 | 实质 | 修复者 | Phase |
|---|---|---|---|---|
| H4 | 静默回退示例 profile | 配置缺/空/未替换 → 占位 profile;**未设/为空时静默(仅 token/未找到会告警)**;结果无意义,失败误判为 VPN | `using_example_profiles` + `config_path` 回显 | 1 |
| H5 | 访问路径对人类隐藏 | host/user/ssh 全脱敏,只暴露不可达文档 URL;人工接管要去 `cat` 一个 gitignore 的 YAML | `access.doctor --export-ssh` + `login_host` | 3 |
| H6 | iHPC 启动单进程且 GPU 盲 | `startIhpcRun` 只在 `activeNodes[0]` 起一个 `Popen`,无多卡/多节点扇出 | `ihpc-start` 硬阻 + 委托给调度器 | 4 |
| H7 | `sweep.plan` 硬拒 iHPC | 没有任何插件路径能做多卡 iHPC sweep | 调度器驱动的 sweep 路径 | 4 |
| H8 | iHPC 用量硬为 null | 唯一状态探测是 `os.kill(pid,0)`;无 GPU 时/利用率/落点可见性 | 调度器可观测性 + adopt | 4 |
| H9 | `safeTool` 只 await 顶层 | 嵌套未 await 的 Promise 静默序列化成 `{}`;38 个工具靠手纪律 —— 插件级正确性隐患 | 嵌套 await 审查 + lint | 6 |

### 中
| # | 问题 | 修复者 | Phase |
|---|---|---|---|
| M10 | 只诊断不动手(retry 一次性 dry-run、diagnose 返字符串、sweep.rank 从不重投) | execute/编排路径 | 5 |
| M11 | 旧 skill(hpc-submit-pbs / ihpc-run-background)过度门控,与 ADR-0004 免 token 自治矛盾,且会撞上死 token(C2) | skill 清理 | 5 |
| M12 | 真实安装下状态/资源路径渲染成 `<outside-project>` | `projectRoot` 健壮化 | 6 |
| M13 | 两个同名 `profiles.local.yaml`;无有效配置路径回显 | `config_path` 回显(随 H4) | 1 |
| M14 | 无 `approvals.list` 枚举工具 | `approvals.list`(随 C2) | 1 |
| M15 | `docs.refresh` 需 VPN 才能填缓存;离线者连访问路径都读不到 | 离线说明 + 访问导出(随 H5) | 3 |

### 低
| # | 问题 | 修复者 | Phase |
|---|---|---|---|
| L16 | 配额快照陈旧但无 refresh-and-report | refresh-and-report | 6 |
| L17 | `projectRoot = resolve(distDir,'../../..')` 脆弱深度假设 | `projectRoot` 健壮化 | 6 |
| L18 | `jobs.history` 的 `since` 是未校验的字典序比较 | 校验 `since` | 6 |

### WebUI —— 闭世界的辅助第二张脸(`webui/server.mjs`)
大多数 WebUI 问题是*继承*来的,会被致命项顺带治好;只有 W1 是新的独立缺陷。
| # | 严重度 | 问题 | 实质 | 修复者 | Phase |
|---|---|---|---|---|---|
| W1 | 高 | WebUI 默认读错存储 | `server.mjs:42` `runtimeDir ?? ".uts-computing"`(相对 CWD);CLI 入口 `:368-370` 不传任何 option;服务器经 `runtimeBaseDir`(`paths.ts:37`)写到 `~/.local/state/.uts-computing`。无 CLI/env 覆盖 → 即便有记录面板也是空的。这是对 `paths.ts` `RUNTIME_DIRS` 注册表的一次再发散 | 复用服务器 `runtimeRootDir()` 解析器 + `UTS_WEBUI_RUNTIME_DIR` 覆盖 | 1 |
| W2 | — | WebUI 审批/中止继承死 token | `server.mjs:51,145-153` `decideApproval` 用 `UTS_COMPUTING_APPROVAL_TOKEN` | 由 C2(安装 token 接线)治好 | 1 |
| W3 | 低 | WebUI 设计上离线 | 从不 SSH;实时日志拉取"故意没接线";只读已存快照,永远落后于集群 | 暂不在范围(记为已知);未来:接实时状态 | — |
| W4 | — | WebUI GPU 时 KPI 读作 0 | 头部 KPI 取自 `record.usage`,iHPC 恒为 null | 由 H8(iHPC 用量)治好 | 4 |

---

## 5. 三条致命问题展开

**C1 —— 闭世界。** 本会话感受最强的一条:`jobs_history(uts-hpc)` 返回 `total:0`("什么都没在跑" —— 假象);撤销合作者的 HPC 作业失败,因为 `jobs_cancel` 需要一个它从未拥有的 runId。根因:`history.ts jobsHistory` 只读 `listRunRecordIds`(`core/audit.ts`,一次本地 runs 目录的 readdir);`jobs.ts` 的 status/usage/logs/cancel 都先 `readRunRecord` 再 `requireRemoteJobId` —— 没有任何输入形态接受一个裸调度器作业号。

**C2 —— 死审批 token。** 完备性复审补出,爆炸半径比 C1 更大。`lib/auth.ts:104` 读 `process.env.UTS_COMPUTING_APPROVAL_TOKEN`,未设则抛;`.mcp.json:10` 的 env 只设 `UTS_COMPUTING_CONFIG`;`manifest.json:21` 只暴露 `config_path`。于是干净安装下该变量永不存在,所有 token 门控操作(`jobs.cancel`、`artifacts.cleanup.execute`、`state.migrate.apply`、`approvals.decide`)对**插件自己提交的作业**也一样硬抛。(一处校正:ADR-0004 使 `jobs.retry`/`submit`/`transfer`/`fetch` 走 conformance 自治,因此死 token **不**阻断 retry —— 但确实阻断了 cancel,而那正是重分配所需。)

**C3 —— 无 `ihpc-sched` 生命周期(审计 P2)。** 真实投放路径是 `ihpc-sched` 的 tmux 循环;本会话最严重的事故正是两账户静默跑了不同版本的调度器。插件对这个真正跑了 campaign 的循环既不能部署、不能版本握手、也无法观测 —— 连一个只读的陈旧探测都没有。

---

## 6. 架构:闭世界 → 开放世界控制面

三步,按依赖序:

1. **adopt 缝(打开世界)。** `jobs.adopt` 从外部证据合成一条 RunRecord,经既有的 `buildRunRecord`/`writeRunRecord` 路径写入。记录一旦存在,所有现有工具(status/usage/logs/cancel/history/diagnose)原样可用。这是单点最高杠杆,远小于完整内化。
2. **安装完整性(让它能动手、肯说实话)。** 把审批 token 接进 `.mcp.json`/`manifest.json`;在工具信封里加 `using_example_profiles` + `config_path`;为人工接管暴露 `login_host`。
3. **调度器控制面(掌管 on-node 运行时)。** 版本握手 → vendored 钉定部署 → 观测。调度器仍是 Python、仍在 on-node。

`★ 洞察 ─────────────────────────────────────`
adopt 缝与控制面是同一个想法在两个尺度上的体现:**不再要求插件必须是工作的*发起者*才能*看见并治理*它。** adopt 对 PBS/iHPC 作业这么做(读外部证据 → 本地记录);控制面对调度器本身这么做(部署一个已知版本 → 读它的版本/心跳)。两者都把"闭世界"换成"基于证据的世界"。
`─────────────────────────────────────────────────`

---

## 7. 功能元语层 —— primitives(纯函数、可单测、无 SSH、无 mutation)

| Primitive | 文件(新/▲既有) | 签名(要义) | 服务 |
|---|---|---|---|
| `pbsRowToRunRecord` | `ops/jobs/adopt.ts`(新) | `(qstatFields, profile) → RunRecord`(复用 `parseQstatFields`/`parsePbsUsage`/`parseExecNodes`) | C1 |
| `ihpcPidToRunRecord` | `ops/jobs/adopt.ts`(新) | `(node, pid, meta, profile) → RunRecord` | C1 |
| `schedulerContractVersion` / `parseContractVersion` / `compareContract` | `lib/ihpc-contract.ts`(新) | 版本串构造 / 解析 / `match\|stale\|unknown` | C3/P2 |
| `validateQueueContract` | `ops/jobs/ihpc-preflight.ts`(新) | `(queueYaml, datasetDirs, paramSpace?) → Finding[]` | P9 |
| `sshConfigSnippet` / `requiredEnvNames` | `ops/access/ssh-export.ts`(新) | `(profile) → {snippet, envNames[]}`(仅名,不含值) | H5 |
| `effectiveConfigStatus` | `core/config.ts`(▲) | `(env, resolvedPath) → {using_example_profiles, config_path}` | H4/M13 |
| `buildCampaignLedger` / `accountKey` / `fairUseVerdict` | `ops/quotas/fairuse.ts`(新) | 推导 `{campaign → allocations}`;**每账号上限**裁决 | §10 |
| `validateSinceFilter` | `ops/jobs/history.ts`(▲) | 拒绝非 ISO 的 `since` | L18 |

原样复用(研究已确认):`parseQstatFields`/`parsePbsUsage`/`computeUsageMetrics`/`parseExecNodes`(`ops/jobs/accounting.ts`)、`parseQstatStatus`(`ops/jobs/jobs.ts:647`)、`buildRunRecord`/`writeRunRecord`/`listRunRecordIds`/`readRunRecordSafe`(`core/audit.ts`)、`computeNodePoolOccupancy`/`totalNodeHeadroom`(`ops/quotas/quota-limits.ts`)、`transfers.plan/execute` rsync(`ops/data/transfer.ts`)、conformance(`ops/quotas/conformance.ts`)、auth(`lib/auth.ts`)、`safeTool`(`index.ts:101`)、测试缝(`core/test-executors.ts`)。

Python 侧 primitives(vendored 树):`contract_version()`;为既有 base64 wrapper 往返补一个金标(golden)夹具。

---

## 8. 业务流程层 —— business flows(MCP 工具,门控、可观测)

| 工具 | 映射 | 安全层级 | 行为 |
|---|---|---|---|
| `jobs.adopt`(`adopt_pbs` + iHPC) | C1 | 远端只读,本地写 | `qstat -x` / 已知 iHPC pid → 为未跟踪作业合成 RunRecord;幂等;按 `remote_job_id` 键 |
| `approvals.list` | C2/M14 | 只读 | 枚举审批记录与状态 |
| `ihpc.scheduler.version` | C3/P2 | 只读 | SSH `--print-contract-version`;返回 `{live, expected, verdict}`;`stale`/`unknown` 时 `ok:false` |
| `ihpc.scheduler.deploy` | C3/内化 | **token + 活动态拒绝 + 部署后核验** | rsync vendored 子树,随后 `ihpc.scheduler.version`;非 `match` 则失败(§9) |
| `ihpc.campaign.preflight` | P9 | 只读 | 校验 queue YAML:dataset 目录存在(`MovieLens`≠`ML`)、`param_overrides` 形状对照可选 `parameter_space` |
| `access.doctor --export-ssh` | H5/M15 | 只读 | 输出 `login_host`、`~/.ssh/config` 片段 + 所需 env 变量**名**(绝不含值) |
| `ihpc-start` 硬阻 | H6/H7/P1 | 护栏 | 拒绝 sweep/扇出用法;引导到调度器路径(`sweep.ts:63` 仅 HPC,已拒 iHPC) |
| `campaign.status` / `campaign.audit` | §10 | 只读 | 展示某 campaign 的 allocation/运行;标记任何越过自身上限的账号 |
| (信封字段)`using_example_profiles`、`config_path` | H4/M13 | — | 加进工具输出,使错配可见 |

安装/配置(非工具):
- 把 `UTS_COMPUTING_APPROVAL_TOKEN` 接进 `.mcp.json` env 与 `manifest.json` `user_config`(C2)。这同时打通 WebUI 审批/中止路径(W2)。
- 回退示例 profile 时**高声失败**(而非吞掉 stderr),并给每个结果打 `using_example_profiles:true` 标(H4)。
- **WebUI 存储路径(W1):** 让 `webui/server.mjs` 的 `runtimeDir` 默认取自服务器共享的 `runtimeRootDir()` 解析器(使其无法与 RunRecord 写入位置发散),并加 `UTS_WEBUI_RUNTIME_DIR` / CLI 覆盖。此后 adopt(C1)即可让面板显示真实作业,无需任何额外 WebUI 工作。

Python 轨道(vendored,新 CI lane):**A1** 金标 + `no-bash-lc` lint · **A2** `--print-contract-version` + 心跳版本 + doctor STALE fail-closed · **A3** 在 tmux 启动前 surface legacy-state 拒绝。

---

## 9. 部署流程 —— 唯一危险工具

`ihpc.scheduler.deploy` 带三把独立锁:
1. **人类审批 token**(现已真正接线,见 C2),经两级门控。
2. **活动态拒绝(campaign 守卫)。** 写入前先探测节点;若存在活动调度器锁或非 legacy 的 scoped state,则**拒绝**(不 mutation)。活性以**心跳时间戳**判定(跨 SSH 会话可移植),而非裸 `kill -0` PID 探测(远端 PID 只在其本机有意义)。心跳新于 900s 陈旧阈值 ⇒ 活动中 ⇒ 拒绝。这是 deploy 不可能覆盖正在运行的 42-study campaign 的代码级保证。
3. **原子部署后核验。** rsync 后立即调 `ihpc.scheduler.version`;若 verdict ≠ `match`,deploy 失败。核验或失败,绝不"发完不管"。

`unknown` verdict(SSH 失败 / 不可解析 / 调度器早于 `--print-contract-version`)是**预期的部署前状态** —— `deploy` 视其为"需要部署";独立的 `ihpc.scheduler.version` 则报 `ok:false` 让运维者看到漂移。

传输:组合 `transfers.plan` + `transfers.execute`(rsync `-av --checksum`)把 `ihpc-scheduler/` 推到节点;经打包入口调用。

---

## 10. 公平使用:每账号合规 + 透明多 allocation

**背景:** 这 4 个账号是**两位合作者**在一个共享项目下的独立 allocation;**每位所有者恰好持有一个 HPC + 一个 iHPC 账号**(同平台无两账号)。这是政策**允许**的情形(`accounts-and-safety.md:11`),而非配额轮换(第 18 行) —— 且因为没有所有者持有两个同平台账号,"每平台上限翻倍"模式在结构上不存在。所以本组件**强制并记录**,不阻断多账号使用。

- **每账号上限硬强制(真正的防封)。** 扩展 conformance 门禁,使任一账号**硬阻**越过其自身 iHPC 节点池上限(`computeNodePoolOccupancy`)或 PBS per-user 上限 —— 无论 campaign 或 attestation。越过单账号上限正是触发封禁的原因,这从结构上防住它。这是此处唯一的硬阻。
- **所有者归属(新可选 profile 字段)。** 增加 `defaults.owner` / `allocation`(归属,非凭据),使 campaign 台账能*显示*每个账号属于哪位所有者、以及某 campaign 合法跨越**不同**所有者的 allocation。让跨所有者的工作迁移(例如一方被重分配的 trial 在共享项目中跑在另一方的 iHPC 账号上)**可见且可归属**。服务于透明。
- **公平使用 attestation(非 waiver-阻断)。** `campaign_id` 由操作者显式声明(扇出路径必填,单作业可选;`accounts-and-safety.md:20` 禁止推断身份 —— 故须显式)。操作者按 campaign 记录一次合法依据(合作者 + allocation + 共享项目),存入派生台账(RunRecord 之上的视图 —— 无第二真相源)。
- **`campaign.status` / `campaign.audit`**(只读):展示 campaign 的 allocation 与运行;标记任何越过自身上限的账号;吸纳已 adopt 的外部作业,使裸 qsub 工作也现形。

**显式非目标:** 此处不隐藏多 allocation 使用;台账是为披露。**所有者须自行确认的残留:** UTS 自身的公平使用 TOS 是否允许把合作者的独立 allocation 汇到一个 workload 上(项目文档允许;机构政策可能更严)。

---

## 11. 仓库布局 —— 带溯源的 vendoring

```
uts-computing-platform/
├── ihpc-scheduler/                  # vendored 子树 = 部署载荷
│   ├── UPSTREAM                      # 仓库 URL + 钉定 SHA (e6883a9) + 同步日期
│   ├── pyproject.toml                # version "0.1.0" -> contract 基线
│   ├── src/scheduler/  src/scanner/  # 真正运行的 ~5k LOC
│   ├── tests/                        # 2,606 行 pytest,在 CI 跑
│   └── configs/*.example.yaml        # 仅 schema 范例;无 campaign 配置
├── scripts/sync-ihpc-scheduler.sh    # 从给定 SHA 重新 vendor,重写 UPSTREAM
└── mcp-server/ ...                   # TS 插件
```
vendor 排除:`.claude/agents/`、`docs/intro/`、`outputs/`。**溯源 CI 检查在 vendored 树/`UPSTREAM` SHA 不一致时硬失败**(禁止对 vendored 代码的静默本地修改)。选 vendor 而非 submodule,是因为源码是 deploy 工具运送的*载荷*,而 submodule 内容在 `.mcpb` 打包时不可靠地随行。

### 11.1 Phase 2 已交付 —— 溯源模型「upstream + documented additions/redactions」

Phase 2(vendor + deploy / 完整 C3 内化)已落地。交付物:

- **vendored 子树** `ihpc-scheduler/`(scheduler + scanner + tests + `*.example.yaml`),钉定 upstream SHA `e6883a9`;`src/` 是 deploy 载荷,随 `.mcpb` 打包,只排除 `tests/`。
- **依赖轻量的 contract 戳** `src/scheduler/_contract.py` + `cli.py --print-contract-version` 钩子;`contract_version()` 输出 `0.1.0+state2+e6883a9`,等于 TS 侧 `mcp-server/src/lib/ihpc-contract.ts` 的 `EXPECTED_SCHEDULER_CONTRACT`。无 paramiko 也可用纯 `python3` 验证。
- **`ihpc.scheduler.deploy` 工具**(三把锁:token + 活动态拒绝 + 部署后版本核验),仅以 mock executor 单测,**从不对真实节点运行**。工具总数 41 → 42。
- **仓库首个 CI**(`.github/workflows/ci.yml`):js lane(`npm test` + `check:provenance`)+ python lane(vendored pytest,cwd `ihpc-scheduler/`)。

**溯源模型 = 「记录的 upstream SHA + 文档化的本地增改」,由 per-file manifest 强制。** 取纯 upstream `e6883a9`,外加明确记录的本地增量;两份机读凭证:

- `ihpc-scheduler/UPSTREAM` —— 记录 repo URL、钉定 SHA、同步日期、vendored 路径、`local_additions`(`_contract.py` 戳、`cli.py --print-contract-version` 钩子、`tests/test_scheduler_contract.py` 金标)、`local_redactions`(按 secrets policy 将真实 iHPC 用户名替换为中性占位符)。
- `ihpc-scheduler/PROVENANCE.json` —— 每个 vendored 文件的 sha256 清单 + `upstream_sha`。

`scripts/check-provenance.mjs`(`npm run check:provenance`)重算清单并在**任何**漂移时硬失败 —— 它禁止的是*静默*编辑,而非已记录的增改(后者属于已纳入基线的部分)。重新 vendor 经 `scripts/sync-ihpc-scheduler.sh`(需 gitignore 的 `scripts/redactions.local.txt` 提供用户名脱敏对;传 `SYNC_DATE` 以使输出可复现复审),它会重写 `UPSTREAM` + `PROVENANCE.json`。最干净的长期方案是把 contract 戳 upstream 进 `mtics/uts-ihpc` 后在新 SHA 重新 vendor(未来工作)。

### 11.2 Phase 3 已交付 —— 人工接管与访问真相(H5 + M15)

Phase 3(人工接管缝 + 离线说明)已落地。交付物:

- **H5 `access.doctor --export-ssh`** —— 新增纯函数 `ops/access/ssh-export.ts:sshConfigSnippet(profile)`(无 SSH、无 IO),并给 `access.doctor` 加 `exportSsh` 布尔标志(**非新工具**,故工具总数仍为 **42**)。置位时,处理器对单个显式 `profileId` 返回 `{ login_host, ssh_config_snippet, required_env_names }` —— 真实 `login_host` + 可直接粘贴的 `~/.ssh/config` 片段 + 所需 env 变量**名**(绝不含值/密钥/口令/真实远端用户名),**不跑任何远程探测**。这是插件够不着集群(VPN 断/离线)时的人工逃生口,并补上 Phase 1 推迟的 `login_host` 披露。复用 `clusterFromHostAlias` 解析 host。测试断言导出中无任何 secret 值泄漏。
- **M15 `docs.refresh` 离线说明** —— 当某源以网络类错误(`fetch`/`timeout`/`ECONNREFUSED`/`ENOTFOUND` 等)抓取失败时,在该源 `warnings` 追加一条可执行的离线接管说明,指向 `access.doctor --export-ssh`,使离线者即便无缓存也能拿到 SSH 访问路径;原始错误保留以便诊断。
- **文档** —— `README.md` / `mcp-server/README.md` 描述了 `--export-ssh` 与离线说明;本节即 spec 复审凭据。

### 11.3 Phase 4 已交付 —— iHPC 监督与 sweep 正确性(H6/H7 + H8 + P9)

Phase 4(iHPC 监督与 sweep 正确性)已落地。交付物:

- **H6/H7 `ihpc-start` 硬阻** —— `ops/jobs/ihpc-start.ts` 在加载校验过的 plan 后、任何 I/O 之前,对归一化 spec 做单进程护栏:`resources.array` 或 `resources.ngpus > 1` 一律抛错并指向调度器路径(`ihpc.scheduler.deploy` → on-node `ihpc-sched start`)。`ihpc-start` 只在一个节点跑一个进程,默默把多卡命令跑一次会浪费整个 campaign,故硬停而非降级。合法单进程(`ngpus=1`、无 `array`)不受影响。**非新工具**。
- **H8 `RunRecord.placement` + adopt 携带的 GPU 可见性** —— 给 `core/types.ts` 的 `RunRecord` 增加可选、平台无关的 `placement` 字段(`hostname`/`node_id`/`gpu_index`/`slots_per_gpu`/`started_at`/`placement_hash`),并在 `schemas/run-record.schema.json` 同提交内加上匹配的 `additionalProperties:false` / `required:["hostname"]` 对象(类型↔schema 由 `assertRunRecord` 的 Ajv 校验钉死,不得漂移)。`jobs.adopt` 接受可选 `gpuIndex`/`hostname`/`slotsPerGpu` 并为 iHPC 路径构造 placement;`jobs.history`/`jobs.status` 在存在时回显之。**插件只读调度器上报的落点,从不探测 GPU**;PBS 记录无 placement(其会计在 `usage`)。**非新工具**。
- **P9 `ihpc.campaign.preflight`** —— 新增纯函数 `ops/jobs/ihpc-preflight.ts:validateQueueContract`(无 SSH、无 mutation),返回新声明的 `QueueFinding { level, path, message, suggestion? }[]`,并注册 `ihpc.campaign.preflight` 只读工具(`READ_LOCAL`)。校验 queue YAML 结构(`my_nodes`/`experiments[name,command,requires_gpu]`)、本地 dataset 存在性(从 `--dataset` CLI flag 取名,与 `datasetDirs` 做**大小写敏感精确匹配**,捕获 `MovieLens` ≠ `ML`)、以及内嵌 `--param_overrides '{...}'` 的 JSON 形状(对照可选 `parameterSpace`)。纯/本地,绝不远程探测。**工具总数 42 → 43。**
- **已交付的设计决定 —— adopted iHPC「history-only + 可观测性,不合成 supervisor」** —— Phase 1 推迟的"完整 adopted-iHPC 调和"在此解析为**刻意的非目标**:**不**合成 supervisor 块。`requireIhpcSupervisor` 要求 `metadata_path`/`stdout_path`/`stderr_path` **位于 profile 根内**;外部启动的进程不暴露这些路径,猜测它们会绕过一条硬安全边界。故 `jobs.status`/`logs`/`cancel` 对 adopted iHPC 仍以清晰的 "missing supervisor metadata" 拒绝。我们补的是**可观测性(placement)**,而非调和。一个 live `ihpc-sched status --json` 轮询以刷新 placement 是已记录的未来增强,不在本 phase。
- **文档** —— `README.md` / `mcp-server/README.md` / 架构文档(工具总数 42 → 43,`ihpc.campaign.preflight` 入表)描述了 `ihpc-start` 护栏、`placement` 可观测性,以及 adopted iHPC 的 history-only 设计;本节即 spec 复审凭据。

### 11.4 Phase 5 已交付 —— 执行路径与公平使用(M10 + §10 + M11)

Phase 5(执行路径与每账号公平使用)已落地。交付物:

- **§10 每账号硬强制 —— iHPC 节点池门(强制,非求和)** —— `ops/quotas/conformance.ts` 新增纯函数 `checkIhpcNodePoolConformance`(复用 `quota-limits.ts` 的 `computeNodePoolOccupancy`/`inferNodeFamily`,不重造池数学)与 `node-pool-exceeded` 违例码;`ops/jobs/ihpc-start.ts` 在选定目标节点后、启动 supervisor 前调用之,若该 profile **自己的** `defaults.node_limits`(取自门户 "My Node Limits")池已满则**硬阻**第三个同族节点的启动 —— 这是 PBS 每用户 `qstat -u` 阻断的 iHPC 对等物,真正的封号预防。两道门都只把**一个** profile 对照**它自己**的上限,**从不跨账号求和**;`node_limits` 未设则无可强制上限(须操作者从门户设置)。这 4 个账号是两位合作者各持一个 HPC + 一个 iHPC 的独立 allocation,故多账号并行是政策允许的;本组件**强制并记录,不阻断**多账号使用。**非新工具**。
- **§10 归属字段 —— `defaults.owner`/`allocation`(归属标签,非凭据)** —— `core/types.ts` 给 `ComputeProfile.defaults` 加两个可选字符串;`schemas/profile.schema.json`(`defaults.additionalProperties:false`)同提交加上二者,否则 `validateProfiles` 会拒收;`redactProfile` 作为白名单**surface** 二者(像 `account_label` 一样是非机密标签),因为台账的目的是**披露/归属**;`profiles/profiles.example.yaml` 用**占位**值(绝无真实 id)。
- **§10 campaign 台账 —— 披露而非隐藏(`campaign.status` / `campaign.audit`)** —— 新 `ops/quotas/fairuse.ts` 派生元语(`accountKey`/`buildCampaignLedger`/`fairUseVerdict`);`RunRecord.campaign_id?`(**非** `JobSpec` 字段,像 `project` 一样**不**进 `plan_hash`)+ `schemas/run-record.schema.json` 同提交加可选 `campaign_id`;扇出路径(`sweep.plan`)**必填** `campaignId` 参数、单作业可选。`campaign.status`(只读)披露某 campaign 的每账号运行数/状态分解(RunRecord 之上的派生 rollup,无第二真相源);`campaign.audit`(只读)对每个账号对照**它自己**最新快照组裁决,**标记**任何已越自身上限(iHPC 节点池或 PBS 每用户)的账号 —— **surface 而非开脱**,无快照者记为"未知"而非默认合规,**从不跨账号求和**。**工具总数 43 → 45。**
- **M10 `sweep.retry.plan` —— planner 而非 orchestrator** —— 新增 `planRetrySweep`(`READ_LOCAL`,**同步纯 planner**):取**原始** `parameters` 网格 + `failedIndices` 为输入(像 `sweep.rank` 一样重跑 `expandGrid` —— index→params 表不持久化),把失败索引压实为 `[0..n-1]` 并返回 `index_map`,产出一个更小的新 PBS array plan(新 `run_id`/`plan_hash`,新 `SweepRetryLineage` + `sweep_retry_of?` 字段加到 `PlannedJob`/`RunRecord` + `schemas/run-record.schema.json` 同提交,并穿过 `PlanHashLineage`/`buildPlanHash`/`planHashForPlan` **绑入哈希**)。**dry-run only:无 SSH、无源运行 mutation、无 auto-detect/auto-submit/编排** —— 重投仍走既有的、conformance-gated 的自治 `jobs.submit`(layering 审计明确否决了 god-object)。仅 UTS HPC CPU sweep。**工具总数 45 → 46。**
- **M11 旧 skill 与 ADR-0004 自治对齐(仅文档)** —— `skills/hpc-submit-pbs`、`skills/ihpc-run-background`、`skills/triage-and-retry` 三个 SKILL.md 教 ADR-0004 自治模型:submit/retry/transfer/fetch 经 `quota_snapshot_id` 自治,`approvalId` 仅用于 cancel/cleanup/migrate;**无 skill 再为自治的 submit/retry 强制 token**(避免撞上 C2 死 token)。打包检查只校 frontmatter,不校正文。
- **文档** —— `README.md` / `mcp-server/README.md` / 架构文档(工具总数 43 → 46,三个新工具入表;deep-dive 的 `grep defineTool(` 推导更新到 46;`architecture-layers.svg`)描述了每账号硬上限(含 iHPC 节点池门)、台账的**披露**用途、M10 planner-not-orchestrator 与 M11;本节即 spec 复审凭据。

### 11.5 Phase 6 已交付 —— 正确性加固(H9 + L18 + M12/L17 + L16)

Phase 6(最终正确性加固)已落地。**不新增任何工具,总数仍为 46。** 交付物:

- **H9 `safeTool` 运行时护栏(取代手纪律)** —— 在 `index.ts` 的 `safeTool` 包装器里、`await handler()` 之后加一道运行时检查:若解析后的结果对象有任一**顶层属性是 thenable**(`typeof v?.then === "function"`),即抛出清晰错误,由既有 try/catch 收敛为标准 `{ok:false, error}` 信封 —— 把"嵌套未 await 的 Promise 静默序列化成 `{}`"这个 38→46 工具一直靠手纪律守的隐患变成**结构性不可能**,零误报、覆盖每个工具与未来重构。审计了 recon 怀疑的 `access.doctor`:它是裸 `return runDoctor(...)`(顶层已被 safeTool await),**非属性 Promise**,**无需修复**。
- **L18 `jobs.history` `since` ISO-8601 校验** —— 在 `ops/jobs/history.ts` 新增纯函数 `validateSinceFilter`,以正则 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/` + `Date.parse` 有限性拒绝非 ISO 的 `since`(正则是首要形状守卫;日历日翻转如 Feb-30 被 `Date.parse` 滚成 Mar-2 属可接受),取代原来未校验的字典序 `>=` 比较;`index.ts` 的 `since` 输入 schema 同步收紧为 `z.string().regex(...)` 以早反馈,处理器仍保留校验(`jobsHistory` 在测试/其他路径被直接调用)。
- **M12/L17 健壮 `projectRoot` 锚定** —— `core/paths.ts` 把 `resolve(distDir,'../../..')` 的脆弱固定深度假设替换为 `package.json` 标记上行查找(逐级读取并在 `name === "uts-compute"` 时返回该目录,有界、止于文件系统根),并保留历史固定深度作**回退**(带一行 stderr 告警)以免既有安装回归。这是载荷性修复:schema / example / profile 解析全赖它,真实安装下不再把状态/资源路径渲染成 `<outside-project>`。
- **L16 `quotas.capacity` 可选 refresh-and-report** —— `ops/quotas/capacity.ts` 接受可选 `refresh`;为真时经既有 `refreshQuotas` executor 缝先刷新出一份新快照,再在新快照上计算 capacity(无陈旧龄注记);`refresh:false`/缺省时行为不变(读已存快照)。`index.ts` 的 `quotas.capacity` schema 加 `refresh: z.boolean().default(false)`,并把注解从 `READ_LOCAL` 翻为 `READ_REMOTE`(它现在可联系集群);`mcp-protocol.test.mjs` 的 `EXPECTED_TOOL_ANNOTATIONS` 同步更新为 READ_REMOTE 三字段形态(`openWorldHint` false → true)。**注解变更,非新工具。**
- **文档** —— `architecture-overview.md` 的测试数(432 → 484)与 TS 模块数(57 → 61)对齐 LIVE;工具数仍 46。本节即 spec 复审凭据。

---

## 12. 排期 —— 按运营影响重排的各 Phase

1. **Phase 1 —— 解盲与解铐(致命项)。** `jobs.adopt`(C1)· 把 `UTS_COMPUTING_APPROVAL_TOKEN` 接进安装 + `approvals.list`(C2/M14,同修 W2)· `ihpc.scheduler.version` 只读握手 + `--print-contract-version` 戳(C3 第一步)· `using_example_profiles` + `config_path` 回显 + 高声回退(H4/M13)· **WebUI 存储路径修复**(W1:复用 `runtimeRootDir()` + 覆盖),使 adopt 的记录在面板可见 · **更新 `accounts-and-safety.md:105`**("撤销非本包创建的作业"现为仅手动)以经 adopt + token 许可 cancel 已 adopt 作业 —— 是必交付项,非隐含。
2. **Phase 2 —— vendor + deploy(完整 C3 / 内化)。** vendor `ihpc-scheduler/` + 同步脚本 + 溯源 CI + `ihpc.scheduler.deploy`(三把锁)。
3. **Phase 3 —— 人工接管与访问真相。** `access.doctor --export-ssh` + `login_host`(H5)· `docs.refresh` 离线说明(M15)。
4. **Phase 4 —— iHPC 监督与 sweep 正确性。** `ihpc-start` 硬阻(H6/H7)· 经调度器/adopt 的 GPU 可见性(H8)· `ihpc.campaign.preflight`(P9)。
5. **Phase 5 —— 执行路径与公平使用。** retry 与 sweep 失败恢复的 execute/编排(M10)· 公平使用每账号强制 + 台账 + attestation(§10)· skill 清理(M11)。
6. **Phase 6 —— 正确性加固。** `safeTool` 嵌套 await 审查 + lint(H9)· `jobs.history since` 校验(L18)· `projectRoot` 健壮化(M12/L17)· 陈旧快照 refresh-and-report(L16)。

各 Phase 独立可交付;后续 Phase 只依赖更早的 primitives。

---

## 13. 问题 → 解决方案 溯源(运营 ⊕ 审计 P 系)

| 项 | 严重度 | 审计关联 | 修复者 | Phase |
|---|---|---|---|---|
| C1 闭世界 | 致命 | P6 | `jobs.adopt` | 1 |
| C2 死 token | 致命 | —(新) | 安装 token 接线 + `approvals.list` | 1 |
| C3 无调度器生命周期 | 致命 | P2 | `ihpc.scheduler.version` → `deploy` | 1→2 |
| H4 静默示例回退 | 高 | — | `using_example_profiles` + `config_path` | 1 |
| H5 访问对人类隐藏 | 高 | P7 | `access.doctor --export-ssh` | 3 |
| H6/H7 iHPC 单进程 / sweep 拒绝 | 高 | P1 | `ihpc-start` 硬阻 + 调度器路径 | 4 |
| H8 iHPC 用量 null | 高 | P4/P8 | 调度器可观测性 + adopt | 4 |
| H9 safeTool 嵌套 await | 高 | — | 审查 + lint | 6 |
| M10 只建议不执行 | 中 | — | execute 路径 | 5 |
| M11 旧 skill 过度门控 | 中 | — | skill 清理 | 5 |
| M12 `<outside-project>` 渲染 | 中 | P10 | projectRoot 健壮化 | 6 |
| L17 脆弱 projectRoot 深度 | 低 | P10 | projectRoot 健壮化 | 6 |
| M13 同名 profile | 中 | — | config_path 回显 | 1 |
| M14 无 approvals.list | 中 | — | `approvals.list` | 1 |
| M15 docs.refresh 需 VPN | 中 | — | 离线说明 | 3 |
| L16 陈旧快照 | 低 | — | refresh-and-report | 6 |
| L18 history `since` | 低 | — | 校验 `since` | 6 |
| W1 WebUI 读错存储 | 高 | — | 复用 `runtimeRootDir()` + 覆盖 | 1 |
| W2/W4 WebUI 继承 | — | — | 由 C2 / H8 治好 | 1 / 4 |
| P3 引号崩溃 | (HEAD 已修) | P3 | A1 金标 + `no-bash-lc` lint | 2 |
| P9 dataset/param_overrides | — | P9 | `ihpc.campaign.preflight` | 4 |
| P5 legacy-state 静默死亡 | — | P5 | A3 tmux 前 surface | 2 |
| 公平使用每账号 | — | accounts-and-safety | §10 强制 + 台账 | 5 |

---

## 14. 风险与未决项
- **双运行时税:** 仓库新增 Python CI lane(以 vendor 最小子集 + 溯源检查缓解)。
- **`parameter_space` 位置:** 在 NexusRec 而非 `uts-ihpc`;preflight 视其为可选。
- **UTS 公平使用 TOS:** 所有者须确认合作者 allocation 汇聚是否被许可(§10)。
- **vendor 漂移:** `sync-ihpc-scheduler.sh` + `UPSTREAM` 使重新同步显式;需有人去跑。
- **adopt 保真度:** 合成的 RunRecord 缺 `plan_hash` 谱系(无原始 plan);对已 adopt 作业的 cancel 须允许但标注"adopted, 非插件发起"(参见 `accounts-and-safety.md:105` 现将"撤销非本包创建的作业"列为仅手动 —— 本 spec 经 adopt + token 刻意启用之,且须更新该政策行)。
- **on-node 部署路径/入口:** Phase 2 对一个非 campaign 节点确认。

---

## 附录 —— 研究已确认的锚点

**插件(TS),`mcp-server/src/`:**
- 闭世界:`ops/jobs/history.ts jobsHistory` → `listRunRecordIds`(`core/audit.ts:12-22`);`ops/jobs/jobs.ts` status/usage/logs/cancel `readRunRecord`+`requireRemoteJobId`;`parseQstatStatus` `jobs.ts:647-682`。
- RunRecord:`core/types.ts:187-234`;build/write `core/audit.ts:75-164`;存储 `.uts-computing/runs/<run_id>.json`(`core/paths.ts:56`)。
- qstat 解析:`ops/jobs/accounting.ts:8-89`(`parseQstatFields`/`parsePbsUsage`/`computeUsageMetrics`/`parseExecNodes`)。
- 死 token(C2):`lib/auth.ts:104` 读 env;`.mcp.json:10` env(仅 config);`manifest.json:21` 仅 `config_path`;`manifest.json:25-26` `user_config`。
- 静默回退(H4):`core/config.ts:9` `DEFAULT_CONFIG`,`:20-38` 示例回退 —— 未设/为空时静默;仅未替换 `${...}`/未找到才 stderr 告警。
- SSH 构造器:`lib/ssh.ts:76-138`;exec `lib/process.ts runProcess`;rsync `ops/data/transfer.ts:94-200`。
- plan hash:`ops/plans/planner.ts:137-149`。审批/auth:`lib/auth.ts:28-111`;conformance `ops/quotas/conformance.ts:121+`。跨账号 advisory(非门控):`ops/approvals/approvals.ts:230-235`。
- project 身份:`ops/profiles/project.ts:1-62`;RunRecord 上 `core/types.ts:196-197`。
- safeTool:`index.ts:101-111`;defineTool `index.ts:154-189`;测试缝 `core/test-executors.ts`。
- iHPC start:`ops/jobs/ihpc-start.ts:64-228`(`selectActiveComputeNode:269-306`);sweep iHPC:`ops/jobs/sweep.ts:63`。
- 节点池 primitives:`ops/quotas/quota-limits.ts:13-67`;capacity `ops/quotas/capacity.ts`。access.doctor:`ops/access/doctor.ts:62-185`。
- WebUI:`webui/server.mjs:41-51`(`createWebuiServer` 默认值、`runtimeDir ?? ".uts-computing"`、token 取自 env)、`:145-153` `decideApproval`、`:368-370` CLI 入口(无 runtimeDir option);服务器存储解析 `core/paths.ts:37 runtimeBaseDir` / `:47 runtimeRootDir` / `:50-65 RUNTIME_DIRS`。

**调度器(Python)@ `e6883a9`,`src/scheduler/`:**
- CLI:`cli.py`(start/status/doctor/mutate/retry/kill/tmux;加 `--print-contract-version`)。
- 版本:`pyproject.toml:3` `0.1.0`;`state.py:22` `STATE_VERSION=2`;心跳 `state.py:318-321`;锁载荷 `lock.py:54-61`;陈旧阈值 `cli.py:1115`(900s)。
- 传输(P3 已修):`remote_command.py:51-66` base64 wrapper;测试 `tests/test_scheduler_submitter.py:75-79`。
- 落点(P4):`placement.py` + `submitter.py:_probe_gpu_slots:134-209`;按 `(tracked_jobs, -free_pct)` 排序。
- legacy state(P5):`_blocking_state_issues cli.py:1265-1289`;`sys.exit(1) cli.py:206-210`。
- config 契约(P9):`config.py:292-475`;queue YAML = `my_nodes`/`scheduler`/`experiments[name,command,requires_gpu]`;`param_overrides` 为 `command` 内嵌 JSON。
- 测试:`tests/` 8 文件,2,606 行。
