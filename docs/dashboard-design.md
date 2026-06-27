# 实验追踪后台 — 设计文档

一个面向 `uts-compute` 的**轻量、以只读为主**的实验追踪 Web 后台,基于开源
[Tabler](https://github.com/tabler/tabler) HTML 套件(MIT)。它把 Agent 实验的全生命周期——
**提交 → 进入服务器 → 排队 → worker(计算节点)执行 → 产生日志 → 生成指标 → 保存 artifact →
完成/失败**——可视化展示出来,数据直接读 MCP server 已经写在 `.uts-computing/` 下的**已脱敏 JSON**,
并提供一小组 state-gated 的动作(clone / rerun / enqueue / abort),这些动作全部走现有的安全闸门。

它吸收三套系统的能力:**MLflow**(Experiment/Run、参数、时序指标、artifact、代码版本、**trace/span**)、
**Aim**(大量 run 的搜索/分组/对比、scatter、平行坐标、报告)、**ClearML**(Task/Queue/Worker、
**Task 分段**、实时日志、**clone/rerun/enqueue/abort**)。

本文是该后台的*设计 spec*。**状态:已实现并发布**——Web 后台已上线(页面:Runs / Explore / Capacity / Projects;Node load 折叠进 Runs;Explore 展示 iHPC 节点级 GPU 与 PBS array-job 聚合用量),实现说明见 [webui/README.md](../webui/README.md)。本文保留为设计基线。核心插件参见 [architecture-overview.md](architecture-overview.md)。

---

## 1. 核心认知 — 我们的 run-record 已是数据模型的约 80%

这个后台主要是把已有数据*投影*出来,而非新增埋点。跨系统的实体几乎一一对应到我们的
run-record / 资源上:

| 跨系统实体 | uts-compute 现有来源 |
|---|---|
| MLflow **Experiment** / ClearML 项目 | `RunRecord.project` + `project_hash`(git 推断);`projects.list` 汇总 |
| MLflow **Run** / ClearML **Task** | 一条 `RunRecord`(`run_id`、`remote_job_id`、`profile_id`、`platform`) |
| Run **status**(SCHEDULED/RUNNING/FINISHED/FAILED/KILLED) | `RunRecord.status` = planned/submitted/running/finished/failed/cancelled/unknown |
| ClearML Task **Execution** 段(仓库+commit+环境) | `RunRecord.reproducibility.git`(sha/branch/dirty)+ `submission`(账号/集群/队列/节点/请求资源)+ `plan_hash` |
| **Parameters** / 超参 | `PlannedJob.normalized_job_spec`(resources、command、experiment、sweep 网格) |
| ClearML **Results**(scalars/console/info) | `RunRecord.usage`(核时/GPU 时、CPU 效率)+ `jobs.logs` tail + `events[]` |
| **Artifacts** | `uts://artifacts/{runId}/manifest`(路径、大小、SHA-256)+ cleanup 状态 |
| **代码 / git 版本** | `RunRecord.reproducibility.git` + `events[].redacted_command` |
| **Queue** | `quotas.capacity`:每队列 running/queued + 余量 + 推荐并行度 |
| **Worker / 计算节点** | `submission.node`(PBS exec_host)/ `supervisor.node_id`(iHPC cnode) |
| **审批 / 血缘** | `RunRecord.approval`(state、绑定的 plan_hash/snapshot)+ `retry_of` + `uts://approval-records` |
| MLflow **Trace / Span**(agent planner/tool/verifier 调用链) | **缺口** — 未捕获(见 §6) |
| 每步 **时序指标** | **缺口** — 只在 job 结束时存一份聚合 `usage`(见 §8) |

所以借鉴的四类能力里,三类跑在我们**已有**的数据上;只有 **trace/span** 和**每步指标**需要新增捕获
(改动小、范围可控 — §8)。

---

## 2. 架构

```
┌─────────────────────────── 浏览器 ────────────────────────────┐
│  静态 Tabler HTML/JS(CDN:@tabler/core MIT · ApexCharts ·     │
│  List.js · Tabler Icons)— 零构建步骤                          │
│        │ fetch()                          ▲ poll(日志/队列)   │
└────────┼──────────────────────────────────┼──────────────────┘
         ▼ /api/*(读) · /api/actions/*(写)
┌─────────────────────── webui/server.mjs ──────────────────────┐
│  极小的、以只读为主的 Node HTTP 服务,仅绑 127.0.0.1          │
│  - 直接 import 已编译的 dist/ 领域函数:                       │
│    jobsHistory · listProjects · quotaCapacity · readRunRecord │
│    getJobLogs · planRetryJob · submitJob · cancelJob · approvals│
│  - 复用 uts:// 资源用的同一套脱敏逻辑                          │
└───────────────────────────────┬───────────────────────────────┘
                                 ▼ 读取 / 操作
                         .uts-computing/(gitignore,写入时已脱敏)
                         runs/ plans/ quotas/ artifacts/ approvals/ …
```

- **隔离。** 所有东西放在一个新的顶层 `webui/`(服务 + 静态资源)。client-neutral 的 MCP 核心
  (`mcp-server/`、`skills/`)**不动**——后台是一个*可选、独立*的界面,符合本项目"核心保持
  client-neutral"的约束。
- **为什么要一个小服务(而非纯静态)。** 浏览器无法通过 `file://` 随意 `fetch()` 本地文件,而且取数
  路径必须套用 MCP server 同一套脱敏。一个约 150 行的 Node 服务,直接 import 现成的 `dist/` 函数,是
  最轻的方案,它能 (a) 托管静态 Tabler HTML、(b) 暴露只读 JSON API、(c) 复用脱敏、(d) 让写动作走与
  MCP 工具**完全相同**的闸门。只绑 `127.0.0.1`。
- **不引入新数据存储。** 服务按需读 `.uts-computing/` 的 JSON(就像 `jobs.history` / `projects.list` /
  `uts://` 资源那样)。数据在写入时已经过 schema 校验和脱敏。

### 技术事实(调研确认)
- **Tabler** 是 **MIT**,基于 Bootstrap 5,**可直接用 CDN、无需构建**。图表用 **ApexCharts**(单独 CDN)。
  表格的排序/搜索/分页用 **List.js**(极小、MIT、纯 JS)。图标用 **Tabler Icons**(MIT)。三个原生缺口
  ——span *树*、实时日志 *tail*、scatter *联动刷选*——分别用 `<details>`/`.collapse`、`setInterval`+`fetch`、
  ApexCharts 事件解决,均无新增依赖。

---

## 3. 页面 / 信息架构

| 页面 | 借鉴自 | Tabler 组件 | 我们的数据 / API |
|---|---|---|---|
| **Runs 列表** | ClearML 任务表 + Aim 过滤栏 + MLflow 搜索 | `table.table-vcenter` + List.js(排序/搜索/分页);`badge`/`status-dot-animated`;过滤 `dropdown`/`btn-group`;`empty` 空态;行内 sparkline | `GET /api/runs?project=&status=&platform=&since=&limit=`(≈ `jobsHistory`) |
| **Run 详情** | ClearML 五段 | `card-tabs` + `nav-tabs`;`datagrid` 展示键值;`card-status-top`/`ribbon` 表示终态 | `GET /api/runs/:id`(record + plan + manifest) |
| ↳ 概览/Execution | ClearML Execution | 统计 `card` 组 + git `code` 标签 + `plan_hash` | `submission`、`reproducibility.git`、`plan_hash`、`resources` |
| ↳ 参数 | MLflow 参数 | `datagrid` / 两列表 | `normalized_job_spec` |
| ↳ 生命周期 | MLflow 时间轴 + Tabler steps | `steps.steps-vertical`(线性)+ `timeline`(事件) | `status` + `events[]`(见 §4) |
| ↳ 日志 | ClearML console | 可滚动 `<pre>`(深色)+ 自动滚动开关 | `GET /api/runs/:id/logs`(实时 `getJobLogs` tail,或已存证据) |
| ↳ 指标 | MLflow 指标图 | ApexCharts line/area | 当前用 `usage`;接入 §8 后为每步序列 |
| ↳ Artifacts | MLflow artifact 树 | `list-group`(名称/`badge` 大小/`code` 校验和/下载) | `uts://artifacts/:id/manifest` |
| ↳ Trace | MLflow trace 三栏 | 嵌套 `details` 树 + gantt-`progress` + span 详情面板 | **接入 §6 后** |
| **Capacity Snapshot**(`#/capacity`; 旧路由 `#/queue` alias 到同页,`/api/capacity` 为 canonical;原名 "Queue & Workers") | ClearML Workers&Queues | 统计 `card` 行(平均等待 / 排队数 / 运行中)+ 两个 `table` + 每节点 `progress` + `status-dot` 存活 | `GET /api/capacity?profileId=`(≈ `quotaCapacity`)+ 节点取自 `submission.node` |
| **Explorer** | Aim explorers | ApexCharts 多线 + scatter;group-by `form-select`;对比 `table` | `GET /api/explore?...`(见 §5) |
| **Projects** | Aim reports + MLflow experiment | `card` 网格 + ApexCharts donut + KPI 卡片 + `timeline` 活动流 | `GET /api/projects`(≈ `listProjects`) |

**可直接借用的 Tabler 起始页:** `datatable.html`(列表)、`cards.html`+`steps.html`+`timeline.html`
(Run 详情)、`index.html`+`uptime-monitor.html`(队列/worker)、`charts.html`(Explorer)。

---

## 4. 生命周期模型(stage → status → event)

生命周期组件完全由 `RunRecord.status` + `events[].kind` 驱动:

| 后台阶段 | `status` | 标记性的 `events[].kind` | Tabler 视觉 |
|---|---|---|---|
| 提交(计划已接受) | `planned` | `dry-run-plan` | 第 1 步 active · `status-azure` |
| 进服务器 / 排队 | `submitted` | `live-submit` / `live-retry-submit` / `ihpc-live-start` | `status-yellow` + 动画圆点 |
| 在 worker 上运行 | `running` | 状态跃迁(`pbs-status`) | `status-blue` + 脉冲圆点 + 不定 `progress` |
| 产生日志 | `running` | `pbs-logs` / `ihpc-logs` | 时间轴事件 · 实时 `<pre>` |
| 生成指标 | `running`→终态 | (usage 从 qstat 解析) | sparkline 开始 |
| 保存 artifact | `finished` | `artifact-fetch` / `…batch` / `cleanup-plan-*` | `list-group` 填充 |
| 完成 | `finished` | 状态跃迁 | 所有步骤完成 · `ribbon.bg-green` |
| 失败 | `failed` | 状态跃迁 + `jobs.diagnose` | `ribbon.bg-red` + `alert-danger` |
| 取消 | `cancelled` | `live-cancel` / `ihpc-live-cancel` | `status-red` 静态 |

---

## 5. 多 run Explorer(Aim)

"大量 run"的界面。一个纯过滤的查询层 + 一个独立的查询后分组层(Aim 最关键的可组合性经验):
- **过滤栏** — 对 run 字段的一个小布尔表达式语言,例如
  `project == "diffusion" and status == "finished" and usage.core_hours > 50`,并对已知字段做自动补全。
  (即 Aim 的 AimQL,裁剪到我们已有的字段。)
- **三通道 group-by** — 按任意字段(project、queue、job_type)做颜色 / 线型 / 子图拆分,这是 Aim 标志性的
  faceting;叠在过滤*之后*。
- **聚合带** — 一组内的均值/中位 + 标准差 / 标准误 / 95% 置信区间(需要 ≥2 个共享 x 轴的 run;接入 §8 后
  才有意义)。
- **Scatter** — X/Y = 任意参数或任意(末值)指标;颜色 = 分组;可选 LOESS 趋势线。当前 X/Y 可取
  `resources.*` 对 `usage.*`(例如请求内存 vs 实际内存,参见 `jobs.rightsize`);接入 §8 后更丰富。
- **平行坐标** — run 作为折线穿过所选的参数 + 指标坐标轴,按目标指标做颜色渐变。
- **对比表** — 所选 run 为行、参数/指标为列,最优单元格高亮。
- **报告**(暂缓) — Aim 式的 markdown 内嵌已存查询;优先级最低。

---

## 6. Agent Trace / Span(MLflow) — agent 执行视图及其缺口

价值最高的*新*概念:把 agent **自己**的推理链(planner → retriever → tool-call → verifier)按 span 树
可视化,像 MLflow 展示一条 trace 那样。

- **查看器(三栏,来自 MLflow):** 一个 span **树**(嵌套 `details`)+ 一个 **gantt 时间轴**(每个 span 是
  按起止/时长定位的 `progress` 条)+ 一个 **per-span 详情**面板(inputs/outputs/延迟/状态/属性/事件)。按
  `span_type`(LLM/RETRIEVER/TOOL/AGENT/EVALUATOR)着色。
- **缺口与最小 schema。** 我们今天没捕获这个(MCP server 看不到 agent 的决策树)。最小新增:一个可选的
  `.uts-computing/agent-traces/<run_id>.json`(新增一个 `.uts-computing/` 目录 + schema),由 agent/skill
  写入,内容是一组 span `{ span_id, parent_id, name, span_type, start, end, status, inputs, outputs }`,通过
  `uts://agent-traces/{runId}` 和 `GET /api/runs/:id/trace` 暴露。**范围:** 一个新的可选存储 + schema
  (加性、脱敏);*写入*在 agent 侧、不受后台控制,所以 Trace 标签页在数据缺失时退化为空态。

---

## 7. 动作 — clone / rerun / enqueue / abort(ClearML),全部走安全闸门

后台提供 ClearML 式的 **state-gated** 动作。关键在于:**每个写动作都走与对应 MCP 工具完全相同的闸门**
——Web UI 只是另一个调用者,绝不绕过。

| 按钮 | 何种 status 可见 | 映射到 | 安全层级 | 鉴权 |
|---|---|---|---|---|
| **Clone** | 任意终态 | `jobs.retry.plan`(dry-run,新 `plan_hash`) | dry-run,无闸门 | 无 |
| **Rerun / Enqueue** | `planned`(含刚 clone 的) | `jobs.submit` | Tier-A:对新鲜配额快照做 live conformance | conformant 则无需;否则需一个审批 |
| **Abort** | `submitted` / `running` | `jobs.cancel` | **Tier-B(不可逆)** | 需要宿主端 `UTS_COMPUTING_APPROVAL_TOKEN` |
| **Approve / Reject** | 待审批 | `approvals.decide` | Tier-B 确认 | 需要宿主端令牌 |

动作面的设计约束:
- **State-gated UI** — 一个 run 只渲染其 status 下合法的动作(ClearML 的矩阵),由 `status` 驱动。
- **令牌不进浏览器。** Tier-B 确认令牌只存在于*服务器*的 env,绝不出现在客户端 JS。UI 弹确认框;由服务器
  施加闸门。服务器**只绑 localhost**。
- **审批流保留。** abort/cancel 仍然要创建并消费一条绑定 `plan_hash`+`quota_snapshot_id` 的
  `approvals.request`→`approvals.decide` 记录;后台把待审批呈现出来(`review-approvals` 技能的 UI 等价物),
  并记录谁做的决定。"Rerun"仍然重校验 `plan_hash` 和 live 配额范围。后台做的任何事都逃不出
  conformance/审批这条安全脊柱。
- **审计。** 每个动作本来就会以一条带脱敏命令的 run-record 事件记录下来;后台只是触发器。

`POST /api/actions/{clone,submit,abort}` 和 `POST /api/approvals/decide` 调用对应的 dist 函数(带上服务器
持有的 options:audit 目录、令牌);响应是同样的 `{ok}` 信封。

---

## 8. 数据:有 / 部分 / 缺 + 加性增强

| 需求 | 状态 | 来源 / 增强 |
|---|---|---|
| 生命周期、status、events、plan_hash、审批、project | **有** | run-record |
| 提交上下文(账号/集群/队列/节点/请求资源) | **有** | `submission` |
| 用量聚合(核时/GPU 时、CPU 效率、内存) | **有** | `usage`(结束时一份快照) |
| Artifact manifest(路径/大小/SHA-256) | **有** | `uts://artifacts/:id/manifest` |
| Git 代码版本 | **有** | `reproducibility.git` |
| 队列容量(running/queued/余量) | **有** | `quotas.capacity`(快照) |
| 计算节点 | **部分** | `submission.node`(跑起来才有) |
| 日志 | **部分** | `jobs.logs` 有界 tail(无流式 → 轮询) |
| 失败分类 | **部分** | `jobs.diagnose` 现算(未持久化) |
| **每步指标时序** | **缺** | **ENH-1**:可选 `RunUsageSample[]`(timestamp + 核时/GPU 时 + CPU 效率 + 内存),运行中追加——加性 schema 小改;是让 Metrics/Explorer 可信的最高杠杆 |
| **Agent trace/span** | **缺** | **ENH-2**:`.uts-computing/agent-traces/<run>.json` + schema + `uts://agent-traces`(见 §6)——agent 侧写入 |
| 持久化失败诊断 | **缺** | **ENH-3**:在 `failed` 跃迁时把 `jobs.diagnose` 结果写进 run-record(小) |
| 实时队列/worker 监控 | **缺** | **ENH-4**:可选 `quotas.monitor` 时序(中) |

ENH-1/-3 是 run-record/schema 的小加性改动;ENH-2 是新的可选存储;ENH-4 是中等大小的特性。
**没有一个阻塞 P1**(P1 跑在"有"的数据上)。

---

## 9. API 面(`webui/server.mjs`)

读:`GET /api/runs` · `/api/runs/:id` · `/api/runs/:id/logs` · `/api/runs/:id/trace` · `/api/projects` ·
`/api/capacity` · `/api/explore`。写:`POST /api/actions/clone|submit|abort` · `POST /api/approvals/decide`。
全部复用 `mcp-server/dist/*` 函数;所有响应是 `{ok,...}` 信封;服务器绑 `127.0.0.1`,只读已脱敏 JSON。

---

## 10. 分期计划

- **P1 — 只读 v1(现有数据即可):** `webui/server.mjs` + Tabler 页面:Runs 列表 · Run 详情
  (概览/Execution、参数、生命周期、日志、Artifacts)· Queue & Worker 监控 · Projects 汇总。
- **P2 — Explorer + 动作:** Aim 式过滤/分组/scatter/平行坐标/对比;ClearML 式 state-gated
  clone/rerun/abort + 审批界面(见 §7)。
- **P3 — 补缺口:** ENH-1 每步指标(解锁真正的 Metrics/Explorer)、ENH-3 持久化诊断;然后 ENH-2 agent
  trace/span + Trace 三栏查看器。
- **P4 — 打磨:** ENH-4 实时队列监控、日志流式、报告。

---

## 11. 安全与非目标

- **只有脱敏数据离盘。** 后台读的是 `uts://` 资源暴露的同一套脱敏 JSON(host 别名 / 用户名已掩码、密钥已
  脱敏、路径项目相对)。没有明文凭据,不读 `profiles.local.yaml`。
- **只绑 localhost。** 服务器绑 `127.0.0.1`;它是单用户本地工具,不是多租户 Web 应用。除此(以及不可逆动作
  的 Tier-B 令牌闸门)之外不在范围内做鉴权层。
- **不绕过安全脊柱。** 每个写动作都复用 MCP 工具的闸门(plan_hash 重校验、live conformance、不可逆操作的
  人工令牌)。后台做不了 agent 做不了的任何事。
- **核心保持 client-neutral。** 所有后台代码隔离在 `webui/` 下;不往共享 MCP server 或 Skills 里加任何东西。
  后台是一个可选界面。
- **不是**多云/SaaS 追踪器,**不是**托管 leaderboard,**不是** MCP 工具的替代品——它可视化并触发它们。

---

## 12. 参考

支撑本设计的调研:
- **Tabler**(MIT、组件、图表):https://github.com/tabler/tabler · https://docs.tabler.io/ui/components/ · https://docs.tabler.io/ui/getting-started/license/
- **MLflow**(tracking + trace/span):https://mlflow.org/docs/latest/ml/tracking/ · https://mlflow.org/docs/latest/genai/concepts/trace/
- **Aim**(explorers、scatter、reports):https://aimstack.readthedocs.io/en/latest/ui/overview.html · https://aimstack.readthedocs.io/en/latest/ui/pages/explorers.html
- **ClearML**(task/queue/worker/agent):https://clear.ml/docs/latest/docs/fundamentals/task/ · https://clear.ml/docs/latest/docs/webapp/webapp_workers_queues/ · https://clear.ml/docs/latest/docs/clearml_agent/
</content>
