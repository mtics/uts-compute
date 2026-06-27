# 审计报告:uts-compute 插件 × ihpc-sched 的内化评估与改进路线

**日期:** 2026-06-19 · **方法:** 4 阶段多 agent 工作流(12 个 agent,约 130 万 token)· **触发:** 2026-06-19 跨平台 42-study HPO 真实投放中暴露的一系列问题 · **状态:** 分析完成,待决策。

> 本报告综合了对三套系统的并行测绘、对真实投放 10 个问题(P1–P10)的根因定位、能力缺口分析、三套内化架构方案、评分推荐,以及两轮对抗评审。结论部分给出经对抗评审修正后的分层路线图。

---

## 0. 一页式结论

**关键发现(基石问题):** 本次所有 iHPC 侧故障的根都是同一个 **版本分发缺口(P2)**:`ihpc-sched` 是一个无发布通道、无版本钉、无自陈旧检查的独立仓库,靠"每账户 `git pull`"分发。iHPC 账号 A 跑的是带逻辑 slot 与 wrapper 传输的正确分支,iHPC 账号 B 跑的是约 8520 行更旧的 `origin/main`,而正确分支当时从未推到任何 remote。P3(引号崩溃)、P4(过量派发)、P5(陈旧状态卡启动)全是它的下游。

**用户的核心命题成立但不充分:** "把 ihpc-sched 内化进插件"能**决定性地**修掉 P2(版本漂移)与 P8(三仓库碎片化),并通过无 shell 传输修掉 P3;但对 P1/P4/P5/P6/P9 是**必要不充分**(每个都要显式搬运一项具体能力),且对 P7(访问配置只活在插件里)、P10(配置模板脆弱)反而会**加剧**,除非同时补访问导出与防御式配置加载。

**工作流推荐:** 方案 C(契约优先的混合)+ 嫁接方案 A 的 vendoring/版本握手(评分 C=41 > A=39 > B=32)。核心理由是**韧性不可让渡**:on-node tmux 循环能在 VPN 断开 / 笔记本休眠后存活,这是本地 MCP 服务器做不到的,因此调度器必须留在节点上。

**对抗评审给出两点必须吸收的反对(两位评审都判 holds_up=False):**
1. **运营视角:** 推荐方案里的"命令用 argv 字符串列表 + 禁 `bash -lc` lint"自相矛盾且不可实现(真实队列命令是 `source && conda activate && cd && export && python ...` 的 shell 管道,无法表达为 execve argv);真正的 P3 修复就是 wrapper 文件传输 + 一个逐字节往返金标测试,argv 重构应当删除。且把 `adopt_pbs`/`ssh 导出`放到第 5 阶段,会让**正在跑的 42-study campaign 在整整 14 天里不可见、不可核**。
2. **可维护性视角:** 该任务**已经被约 600 行 Python 胶水解决了**(任务清单 22–26 已完成),三平面 + 三契约 + vendored 子模块 + 跨语言金标 + RunRecord 状态调和层,是为一个"假想的多账户中控平面"防故障,而不是为这 4 个账户的 HPO 防故障;两运行时税(Python + TS 各校验同一份 JSON)是永久成本。唯一既便宜又有价值的点(禁 `bash -lc` 的 CI lint + 逐字节忠实的 `--param_overrides` 传输)被埋在 14 天计划的第 7 条嫁接里。

**本报告的综合落点:** 采用**分层路线图**(见 §8)。基石(P2)在本会话已基本闭环(分支已推到 `github.com:mtics/uts-ihpc`)。先做一批**便宜、高杠杆、可独立交付**的加固(传输金标 + lint、版本握手 fail-closed、sweep 禁用单进程后端的硬阻断、把 `adopt_pbs` 与 `ssh 导出`提前覆盖在飞的 campaign、结构化 preflight)。**大内化(三平面契约 + RunRecord ingest)是一个需要单独权衡的架构投资**,在科研 campaign 仍是优先级时不应自动上马,并需正面回答可维护性评审"为 4 个账户值不值"的质疑。

---

## 1. 三系统架构图谱

### 1.1 uts-compute 插件(TypeScript MCP 服务器)

本地 stdio MCP 服务器(外加 14 个 Skill 与一个只读 WebUI),为 LLM agent 中介 UTS HPC(PBS 批处理)与 iHPC(交互节点)算力。严格向下分层 `mcp/`(工具面)→ `ops/`(业务)→ `lib/`(叶子原语)→ `core/`(契约),实现内容寻址、合规门控、全程审计的实验生命周期:plan(dry-run)→ gate(审批 token 或自治 live-quota 合规)→ submit → monitor/diagnose → 收集产物 → retry/reproduce。共 38 个点分隔工具。

**关键事实:** `jobs.submit` 并**不**驱动 on-node 调度器。iHPC"受监督运行"是每 run 一个分离的 OS 进程(`Popen + start_new_session`,经两跳 SSH 的 base64 Python supervisor),在 RunRecord 里表示为 `supervisor{pid,node_id,paths}`;PBS run 是真 qsub 作业。两条路径刻意不同,只在 RunRecord 生命周期/可观测层统一。

**强项:** 机制-策略向下分层 + CI 防 lib 重定义;纵深信任(plan_hash 每次远程动作前复验、per-platform argv 允许集、处处 `shell:false`、TS 与远端 Python 双重路径包含校验、per-hop SSH host-key 策略);凭据卫生(只存 `*_ref` 指针名,auth 委托用户 agent/keychain,服务器从不碰密钥);崩溃安全(submitting 标记先写、remote_job_id 在消费审批前持久化、乐观并发 rev、孤儿 run 标 needs_reconciliation 而非盲目重投);ADR-0004 有边界的自治(可逆+可验证动作凭 ≤15 分钟的新鲜配额证明免 token,不可逆动作仍需 host-only token)。**这是三系统中工程质量最高、最适合做统一 run 模型之家的一套。**

**弱项:** `safeTool` 只 await 顶层返回值,包在对象字面量里的异步调用会静默丢失(已咬过一次,只靠手纪律规避);`projectRoot` 用 `resolve(distDir,'../../..')` 的脆弱深度假设;`.mcp.json` 默认指向从不随包发布的 `profiles/profiles.local.yaml`,干净安装会静默跑 example 配置;旧 Skill(hpc-submit-pbs / ihpc-run-background)仍按 ADR-0004 之前的口径过度门控 PBS 提交。

### 1.2 ihpc-sched(Python,`uts-ihpc` 仓库的调度器一半)

Python 3.11+(paramiko+pyyaml),作为阻塞 tmux 循环跑在用户自己的 NoMachine 会话节点上(如 turing2)。审计基于 `codex/minimal-scheduler-entities`(HEAD `e6883a9`,正确/已部署)对比 `origin/main`(`73bb5b6`,致故障的旧版)。

**强项(均为该分支新增,旧 main 没有):** 命令传输对单引号 JSON / 任意 shell 元字符**可证健壮**(base64 wrapper 文件,有直接复现 `--param_overrides '{...}'` 失败的回归测试);三层身份(experiment / placement / combined)允许长跑调度器安全热增 placement(加节点、提 slots)却**不可能**静默换实验清单或重跑别的队列已拥有的作业;纵深 host 白名单(connect/monitor/kill/logs 各自独立拒绝非 my_nodes);placement 把廉价逻辑记账(够 slot 才 SSH)与权威 nvidia-smi 探测解耦,且调度与 `--explain` 复用同一策略;`respect_external_gpu_processes`(bus_id 匹配)保护手工 HPO 不被踩;原子状态写 + .bak、per-state 进程锁 + 陈旧锁回收、heartbeat/provenance。

**弱项:** **分发模型按构造就脆**(本次故障就是跑了陈旧 `origin/main`,无版本钉/升级门告警一个 checkout 它过时了,安全网全是人纪律);`slots_per_gpu` 纯调度侧并发记账、无真实显存隔离,过设会过量占显存;GPU 空闲检查是派发时的点采样,两个调度器或外部作业仍可能在探测与实际分配之间竞争同一卡(锁是 per-state-file,非 per-GPU);CPU 并发硬编码 `CPU_SLOTS_PER_NODE=4`、不可经 queue.yaml 配置;legacy-state 兼容面(is_legacy/allow_legacy/兄弟态冲突扫描)是最复杂的安全逻辑、最易回归;大量依赖远端 shell/工具假设,SSH 操作宽泛 try/except-continue,节点异常被记录跳过而非高声暴露。

### 1.3 NexusRec 胶水层(驱动本次投放的研究侧脚本)

**强项:** study-name 纪律工程化良好(`core/hpo/study_identity.build_study_name` 是 stdlib-only 单一真源,被 torch 重的 producer 与 torch-free 的 PBS guard 共享,metric 大写化化解了 MultiVAE `ndcg@10` vs `NDCG@10` 的无限重投旧 bug);搜索空间跨平台 DRY(`sane_variant_overrides.py` 被 HPC env 生成器与 iHPC 驱动共同 import);重投 guard 防御式编码(只 import optuna、永远 exit 0、非整数/失败输出拒绝盲投、end-game 单一回收者 lineage 0);per-campaign env 冻结快照;尊重"实验值进 YAML"。

**弱项:** 6 字段 study-name 是**隐式契约**,在 ≥4 处手工重建(只有 producer/guard 走 `build_study_name`,shell echo 与 iHPC label 手搓 f-string,`COMMENT→COMMENT.ADAPTER` 在 3 处重实现 `.SANE`);研究拓扑硬编码(节点名/GPU id/账户路径/数据集/host 表/变体/budget 500/NDCG@10/RUN_TYPE 散落为 Python 字面量,且 3 文件重声明,轻微违反项目自己"实验值进 YAML"的规则);两条 iHPC 路径(`gen_ihpc_queue.py` 单卡 vs `launch_ihpc_hpo.py` 多卡 ssh)在 shard 键上微妙不一致且决策点无文档;`merge_param_overrides.py` 与 `core/config.deep_merge_dict` 是同一递归合并的两份独立实现、无共测钉死;**昂贵投放前不校验 `param_overrides` 键是否合法**(typo 如 `sane_projector_hiden` 只在 48h qsub 后运行时才暴露);`launch_ihpc_hpo.py` ssh 路径无 `HPO_STOP` 式 kill-switch、无快照冻结。

---

## 2. 真实投放复盘:P1–P10 根因

| 编号 | 严重度 | 表征 | 真实根因 | 归属 | 内化可否预防 |
|---|---|---|---|---|---|
| **P2** | **critical** | 两账户静默跑不同调度器 | **版本分发缺口(基石)**:无发布通道/版本钉/自陈旧检查,靠每账户 `git pull`;正确分支从未推 remote;`queue_id` 连绝对路径都 hash 进去,刻意让各 checkout 不撞 | ihpc-sched 分发模型整体 | **是** |
| **P3** | **critical** | `--param_overrides` 收到空串 → `JSONDecodeError` | 命令经 shell 引号字符串层传输:旧 `submitter.py` 的 `bash -lc '{cmd}'` 被命令内单引号提前闭合;新分支 base64-wrapper 文件绕开 shell 引号 | ihpc-sched submitter(旧)vs remote_command(新) | **是** |
| **P4** | **critical** | 13 秒把 16 作业堆到 4 卡 → OOM | placement 不做逻辑预留、只信瞬时显存探测;新作业 30-60s 才占显存,快轮询反复选同一"空闲"卡;新分支 `placement.py` 加逻辑 slot 记账(提交即占位) | ihpc-sched placement;**插件 ihpc-start.ts 同样无 slot 记账** | 部分 |
| **P1** | high | 朴素驱动一次性 fire 全部 → 每卡约 6 训练 | 不存在唯一受认可的 iHPC 提交/placement 路径,研究侧重实现调度(`setsid nohup` 无并发控制);连插件自己的 iHPC 路径也是单进程、无 slot 记账 | 三处共担(glue + 插件 + ihpc-sched) | 部分 |
| **P8** | high | "投一个联邦 HPO sweep"无单一 owner | 工作流横跨 3 仓库 2 语言,只靠隐式手搓契约协调(6 字段 study 名、param_overrides 形状、数据集名、单/多卡选择) | 三系统碎片化本身 | **是** |
| **P6** | high | 整个 42-study campaign 在插件里不可见 | 真实投放走裸 `hpo_submit.sh → qsub`,绕开 RunRecord 模型;`jobs.history` 是纯本地记录扫描,无记录则返回 0,`jobs_status` 无 runId 可解 | 插件 RunRecord 只由 plan/submit 创建 + PBS 胶水 | 部分 |
| **P9** | high | 数据集名 `ML` vs `MovieLens`、study 名后缀分叉(只靠人眼) | 跨仓库字符串契约无机器 preflight;`ML` 目录不存在(只有 `MovieLens`),投到 `ML` 会训练在不存在的数据集上;DeepSANE 还会**改 `parameter_space` 形状**,非简单键成员校验 | glue + 应当权威但被 shell echo 绕过的 build_study_name | 部分 |
| **P5** | medium | 陈旧全局 state 让 `tmux start` 秒退、无可见原因 | global→queue-scoped 状态迁移无自动共存处理;新版护栏**正确**拒启但只表现为 tmux 会话瞬死,原因要单独跑 `doctor` + 手动 `mv` 归档才可见 | ihpc-sched cli/state 护栏 + tmux 吞掉消息 | 部分 |
| **P7** | medium | 本机无法直连 CETUS 核进度 | 访问配置只编码在插件信任模型里、无人可用的导出;HPC alias 不在交互 shell 的 `~/.ssh/config`(只有两个 iHPC host),用户名 env 未物化 | 插件 config.ts + lib/ssh.ts + 用户 ssh config | **否(反而加剧)** |
| **P10** | low | MCPB manifest 的 `${__dirname}` 未在该字段展开 → ENOENT | 跨分发通道的配置模板不对称展开(`${__dirname}` vs `${CLAUDE_PLUGIN_ROOT}` vs registry);v0.1.1 用服务器侧 fallback 吸收 | manifest.json + config.ts defaultConfigPath | **否(反而扩大爆炸面)** |

---

## 3. 五条系统性主题

1. **版本分发缺口是基石。** P2 是 P3/P4/P5 的直接父节点,iHPC 账号 B 的每个故障都归结为"跑了陈旧 `origin/main`"。插件**已经有**版本化分发通道(MCPB manifest、`.mcp.json` plugin、MCP registry `server.json`、单一编译 `dist/`),这是支持内化的最强论据:一个可发布、可校验版本的工件取代 N 个发散 checkout。

2. **没有唯一受认可路径 → 重实现 + 不可见。** 工作流横跨三仓库两语言、无端到端 owner(P8),逼研究侧把调度重实现得很糟(P1),且真实投放绕开可观测模型(P6,裸 qsub 不铸 RunRecord)。教训泛化:可观测性被门控在"只有受认可提交路径才创建的 run-record"上,所以 **iHPC 与 PBS 都必须汇入同一条 submit→record→track→report 流**。

3. **传输/预留必须是结构性的,而非字符串/快照式的。** 两个硬故障是机制级设计选择:命令传输用 shell 引号字符串(P3)vs 无 shell 的 argv/wrapper 文件;GPU 预留用瞬时显存探测(P4)vs 提交即占位的逻辑 slot 记账。**关键警告:插件当前的 iHPC 路径(单 Popen,无 slot 记账)同样没有逻辑 placement**,所以内化必须把 ihpc-sched 的 `placement.py` 逻辑预留引擎作为一等原语搬过来,否则朴素合并会重新引入 P4 竞争。仓库统一**不会**免费交付这些属性。

4. **契约校验缺口:跨仓库隐式字符串契约,无 preflight。** 6 字段 study 名(P9a)与 `ML→MovieLens` 映射(P9b)在多处手搓、只靠人眼在 48h/500-trial 投放前校验。修复是 plan-then-gate 的 preflight(数据集存在、param_overrides 键合法、study 名跨平台逐字节一致),插件的 Ajv-schema 本能是合适的宿主,但**研究域契约的执行必须显式加,不能假定**。

5. **内化必要但不充分,且部分问题正交。** 命题确实修 P2/P3/P8;是 P1/P4/P5/P6/P9 的正确归宿(部分,各需显式搬运一项能力);但 P7、P10 不被仓库合并解决,且内化更多职责反而**扩大** P7 的唯一守门人缺口与 P10 的配置爆炸面,除非插件同时获得访问导出能力并保持防御式 fallback。

---

## 4. 能力缺口分析

**裁决:碎片化于三个 owner,只在琐碎处边界清晰。** 在两端是连贯的:插件是 PBS 单作业提交 + 统一 RunRecord/审计/凭据模型的强权威;`sane_variant_overrides` 正确地是研究专属搜索空间的唯一家。但在命题恰好瞄准的中段"投放+监督一个多卡 iHPC HPO sweep 并报告结果"碎得最厉害,该动词**无单一 owner**,由(a)插件的单进程 iHPC supervisor(GPU 盲、每 run 一进程)、(b)调度器的 GPU 感知 placement/lock/wrapper 传输(独立 Python 仓库、不兼容状态模型、无版本门)、(c)胶水(Optuna 分片、自重投链、journal 完成 guard、metric 排名——这些 campaign 真正的灵魂两个工具里都没有)拼起来。

**三套不协调的身份方案** 对应同一个"这个实验":插件 `plan_hash` / 调度器 `experiment_hash+placement_hash+queue_hash` / 胶水 `build_study_name`(Optuna study 名),互不可导出。

**七处重叠(发散风险):** iHPC 节点选择、进程存活监控、日志 tail、cancel/kill、状态/run 模型、实验身份、SSH 可达层、JSON 深合并——各有两到三份实现到同一个 iHPC。

**九处缺口(只在胶水或全缺):** 多卡 iHPC sweep 一等动词(两工具都不能把一个预算扇出到 N 卡)、journal 协调的 HPO 分片、walltime 上限下的自重投链、trial 级进度 guard、按 metric 报告结果(**没有工具读 journal**)、iHPC 用量/GPU 时核算(两工具都缺,GPU campaign 的真实盲点)、调度器版本钉/升级门(**完全缺失,这是两账户跑不同代码的根**)、两状态模型之间的桥、`param_overrides` 键的投放前校验。

---

## 5. 三套内化方案

| | 方案 A:插件 vendoring 调度器 | 方案 B:用 TS 在插件内重写 placement | 方案 C:契约优先混合 |
|---|---|---|---|
| 调度器位置 | 留 on-node(vendored 钉版,插件部署) | 折叠进插件 TS 控制循环,on-node 仅留 ~250 行瘦启动器 + ~80 行 keeper | 留 on-node 可部署单元,但只经插件钉版/投递/调用 |
| 核心机制 | 插件 vendor 子模块 + `ihpc_deploy` 版本握手;SchedulerState 被 RunRecord **adopt** | TS 移植 `placement.py` 逻辑 slot;on-node `flock` slot 租约 + keeper 防 VPN 断时过量 | 三平面 + 三版本化 JSON 契约(Queue/Job、quote-safe Submit、State/Report),两侧 Ajv+jsonschema 校验 + 跨语言金标 |
| 工期 | 约 5–7 天 | 约 24–38 天 | 约 15 天 |
| 最大风险 | 双 owner 接缝(plan_hash↔command_hash 桥 + 投影会漂移);vendoring 冻结修复速度(热修要整包重发) | **韧性丧失**:工作站 MCP 循环遇 VPN 断/休眠即停,keeper 是新写的、韧性关键、在关键路径上;无 keeper 则净负 | 两语言 schema 漂移;调度器仍是独立可部署物;裸跑绕过握手仍可能 |

**评分(1–10,total):**

| 方案 | 漂移预防 | run-record 统一 | 迁移成本(高=易) | 韧性 | 可维护性 | **总分** |
|---|---|---|---|---|---|---|
| A | 9 | 7 | 7 | **10** | 6 | 39 |
| B | 8 | **10** | 3 | 4 | 7 | 32 |
| **C** | 9 | 8 | 6 | **10** | **8** | **41** |

**工作流推荐:C + 嫁接 A(及一条来自 B)。** 决定性约束是**韧性**:on-node tmux 循环在 VPN 断/休眠后存活是调度器存在的全部意义,本地 MCP 循环无法复制。B(韧性 4)牺牲了正是这个,且只能靠一个新写的 ~80 行 keeper 找补,把项目最大风险压在最投机的组件上,还要 24–38 天服务 4 个账户。A 与 C 都留 on-node(韧性 10)、都决定性修 P2(漂移 9)。差别在接缝:A 是双 owner 的 SchedulerState 经 ad-hoc 桥 adopt(A 自称"新、承重、会漂移";vendoring 冻结修复速度);C 把同一 on-node/local 分界**显式契约化**、两侧机器校验 + 金标(投影由版本化 schema 治理而非临时桥,可维护性 8)。C 唯一短板是分发(靠 `git fetch 钉 tag`),正好用 A 的 vendoring + 版本钉路径 + fail-closed 握手嫁接掉。经验核验:`e6883a9` 上 wrapper 传输(P3 修)与 `placement.py` 逻辑 slot(P4 修)已存在,且分支现已推到 `github.com:mtics/uts-ihpc`,故 Phase 0 近乎完成,昂贵的一半纯是契约 + ingest 管道。

**主要嫁接:** 从 A 取 vendored 子模块 + `VENDOR.json{version,commit,sha256}` + 版本钉部署路径 + **fail-closed 版本握手**(缺版本/版本不符都视为硬拒,非告警);从 A 取 in-band `state.migrate`(把 P5 的手动 `mv` 仪式变成有原因回传的受认可操作);从 A/C 取 `access.doctor --export-ssh`(必需伴生,否则集中化扩大 P7);从 B 取 **Phase-0 dispatch oracle 金标语料**(证明 vendored placement 跨版本仍正确)与**禁 `bash -lc` 的 CI lint**(让 P3 机械上不可表达)。

---

## 6. 对抗评审:推荐方案的硬伤(两位评审均判不通过)

### 6.1 运营 + 失败预防视角 → accept-with-changes

- **Contract-B 按所写不可实现,且自相矛盾。** 真实队列单元(见 `gen_ihpc_queue.py:cell_command`)本质是 shell 管道:`source <conda.sh> && conda activate <env> && cd <repo> && export OMP_... && python main.py ... --param_overrides '{json}'`。`source`/`&&`/`export` 无法表达为裸 execve argv 列表。所以"argv 字符串列表契约"要么不可能(逼出 shell),要么"禁 `bash -lc` lint"禁掉了它自己引为 P3 修复的 wrapper-shell 传输。**真正的修复纯是 wrapper 文件传输 + 对单引号 `--param_overrides` JSON 的逐字节往返金标测试;argv 重构是错的,应删。**
- **P1 预防靠 WARN 而非硬阻断。** 计划保留 GPU 盲的单 Popen `ihpc-supervised` 路径,只在 plan 时对多 cell sweep 打它**告警**。告警不是预防;P1 正是凌晨投放压力下伸手错路径造成的。**应硬阻断 sweep 走单进程后端。**
- **P2 仍可绕过受认可路径漂移。** vendoring + 版本钉 + fail-closed 握手能防陈旧调度器静默产出被接受的状态,但**不阻止操作者在 `ihpc_deploy` 之外手跑旧 checkout**(正是本会话两账户做的);fail-closed ingest 只在浪费一次投放**之后**才抓到。建议:on-node wrapper 若 tree sha256≠VENDOR.json 则拒跑;`jobs.scheduler.start` 对握手版本未知/不符的节点**在烧 GPU 前**就拒绝产出队列。
- **相位排序让在飞的 42-study campaign 裸奔约 14 天。** `jobs.adopt_pbs` 与 `access.doctor --export-ssh`(让在飞工作可见/可核的东西)在第 5 阶段。**应前移到 Phase 0/1**,它们只读、依赖轻,保护的是当下真正有风险的 campaign。
- **韧性主张压在未测的 ingest 上。** 新增的失败面是插件经两跳 SSH 读节点本地 Contract-C 状态文件:读时正被写、半截 JSON、重启后重写、终态钳位的时钟偏移。须规定调度器侧原子写(写临时 + rename)+ 插件侧读重试/校验,否则引入"接受损坏状态"的新问题。
- **DeepSANE preflight 比所写更难。** `sane_variant_overrides.deep_overrides()` 同时**改 `hyper_parameters` 与 `parameter_space` 的形状**,不只是值;"param_overrides 键合法"必须是对宿主 YAML `parameter_space` 的结构/空间合并校验,不是扁平键成员检查。

### 6.2 可维护性 + 范围视角 → 按当前范围 REJECT,只接受 1–2 天的薄片

- **从未重新推导最简改动集。** 它继承了 A-vs-B-vs-C 的"三平面/三契约/vendored 子模块/fail-closed 握手"框架并在其中优化,而没问其中有没有必要。**真实问题(在不动模型代码下,把 42 个 LinSANE/DeepSANE budget-500 HPO 投到 2 PBS + 2 iHPC 账户)在本仓库已被约 600 行朴素 Python 解决**(`sane_variant_overrides.py` / `merge_param_overrides.py` / `gen_hpc_hpo_env.py` / `gen_ihpc_queue.py` / `launch_ihpc_hpo.py`,任务 22–26 已完成),14–16 天计划既不承认也不对标它。
- **范围蔓延成一个插件不该当的作业调度器。** "插件是唯一队列生产者 + 唯一状态读者" + RunRecord.scheduler 块 + 三版本化 schema + 跨语言金标 + vendored 子模块 + sha256 + 版本钉部署 + in-band migrate + 禁 shell lint + `adopt_pbs`,没有一个能防住现有 Python 工具对**本** campaign 留下的故障,它们防的是一个**不存在的**集中式多账户中控平面的故障。
- **两运行时税成永久。** "placement 留 Python" + "RunRecord 留 TS 单一权威"硬编码了分裂:queue.yaml/状态文件每加一个字段,都是 Python dataclass + TS 类型 + 三份 Ajv schema 的同步编辑。现有工具零此税——单一 SANE 搜索空间 dict 已经**是**那份共享契约,一种语言,被两个生成器 import,30 行的 import 会被替换成版本化 schema + 一致性测试套。
- **本仓库不存在任何 TS 插件工件**(无 `mcp-server/`、无 `core/audit.ts`、无 RunRecord、无 `placement.ts`);整套 C+A 嫁接预设了一个不在此处的 uts-compute 插件代码库,采纳它等于引入一个庞大外部系统去管理 on-node Python 已经在管的任务。
- **唯一既便宜又有价值的点**(禁 `bash -lc` 的 CI lint + 逐字节忠实的 `--param_overrides` 传输,后者 `gen_ihpc_queue.py`/`launch_ihpc_hpo.py` 已用 `json.dumps(separators)+shlex.quote` 做到)被埋在第 7 条嫁接里;它是单文件改动,不需要其余一切。

---

## 7. 范围外但需单独处理

- **P7(访问唯一守门人):** 内化更多职责会扩大此缺口。无论是否做大内化,都应加 `access.doctor --export-ssh`:导出人可用的 `~/.ssh/config` 片段 + 需要的 env-var **名**(`UTS_HPC_*_USER`,从不打印密钥值)。**本会话已用同一 host alias `<acct>@login-host.example` 直连成功**,证明导出可行且必要。
- **P10(配置模板脆弱):** Ajv 校验形状,不校验 `${__dirname}` 式模板**是否真的替换了**(P10 根因正是未替换 token 当作合法字符串通过)。须加显式的替换后存在性断言,并保持 `config.ts defaultConfigPath` 防御式 fallback。

---

## 8. 综合结论与分层路线图

经对抗评审修正,落点是**分层**:不把"大内化"当作既定结论自动上马,而是先收割便宜高杠杆的修复,把昂贵的架构投资留作单独权衡。

### Tier 0 — 基石(本会话已基本闭环,~1 小时)
- 把正确分支 `codex/minimal-scheduler-entities@e6883a9` 推到 remote 并打 tag(**已完成**:本会话已推到 `github.com:mtics/uts-ihpc` 并令 iHPC 账号 B checkout 与 iHPC 账号 A 一致)。这一步直接掐掉 P2 的字面成因。**补一条:** 给调度器加 `--print-contract-version`(读 pyproject),为后续握手铺路。

### Tier 1 — 便宜、高杠杆、与大架构无关(建议无论如何都做,约 2–3 天合计)
1. **P3 传输金标 + lint:** 把对单引号 `--param_overrides` JSON 的逐字节往返做成回归金标;加禁 `bash -lc`/shell 字符串拼命令的 CI lint,使引号 bug 机械上不可表达、不可回归。(**删除**推荐方案里矛盾的"argv 字符串列表"重构。)
2. **P2 fail-closed 版本握手:** on-node heartbeat 写运行中的 `scheduler_version`;消费侧对"版本未知/不符"硬拒;并让"启动前"就拒绝为握手不符的节点产出队列(在烧 GPU 前阻断,而非之后)。
3. **P1 硬阻断:** sweep(多 cell)目标若是 GPU 盲的单进程后端,**拒绝**而非告警。
4. **P6/P7 前移覆盖在飞 campaign:** 把 `adopt_pbs`(从 `qstat -x` 合成 run 记录)与 `access.doctor --export-ssh` 提前到最前;二者只读、依赖轻,保护当下正在跑的 42-study。
5. **P9 结构化 preflight:** 投放前校验数据集目录存在(`MovieLens` vs 缺失的 `ML`)、study 名跨平台逐字节一致(单一 `build_study_name`)、`param_overrides` 对宿主 YAML `parameter_space` 的**结构/空间**校验(DeepSANE 改的是形状不是值)。
6. **P5 in-band migrate:** 让 `doctor`/migrate 的原因在工具返回里可见,替掉"tmux 秒死 + 手动 mv"的不透明仪式。

### Tier 2 — 大内化(C + A 嫁接;一项需正面权衡的架构投资,约 12 天)
三平面契约(Queue/Job、quote-safe Submit、State/Report)+ vendored 版本钉部署 + RunRecord ingest(把 SchedulerState 投影为统一 run 记录)+ `ihpc_report`(读 journal、按 NDCG@10 排名)。**这是把"投+监督+报告一个多卡 iHPC sweep"做成插件一等动词的唯一彻底解。** 但必须正面回答可维护性评审的质疑:

- **它服务的是"假想的多账户中控平面",还是这 4 个账户的现实需求?** 现实需求已被约 600 行 Python 满足。
- **两运行时税(Python placement + TS 状态权威,每个字段双语言双校验)是否值当?**
- **vendoring 冻结 on-node 热修速度,正是当初催生朴素驱动(P1)的摩擦——如何不重蹈?**

**建议:** 在科研 campaign 仍是优先级时**不启动 Tier 2**;待 SANE/DeepSANE 主实验产出后,作为"是否要把 uts-compute 升级为团队级统一算力中控"的独立决策再评估。若启动,务必先做 Tier 1(它已交付大部分预防),并采纳 §6 的修正(删 argv 重构、placement 留 Python、相位前移、ingest 原子写 + 读重试)。

### 一句话
基石已闭环;**先做 Tier 1 的六项便宜加固(把 P1/P2/P3/P5/P6/P7/P9 的现实风险压住)**;**大内化(Tier 2)是真投资而非既定结论,留待主实验之后单独权衡**。

---

*附:本报告基于工作流 `wazls9nv2` 的结构化输出(maps / diagnosis / 3 designs / judged / 2 skeptics),原始数据在会话任务输出文件中。*
