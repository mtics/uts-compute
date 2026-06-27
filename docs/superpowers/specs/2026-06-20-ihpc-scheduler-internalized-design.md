# iHPC 调度器内化设计 Spec —— 插件=大脑 + 节点=极小推进器

> 状态:**待评审草案(DRAFT for review)**(2026-06-20)。本 spec **取代**早先的 `2026-06-20-ihpc-scheduler-deploy-hardening-design.md`(那份的前提错了——它部署完整调度器)。设计依据:`docs/archive/superpowers/research/2026-06-20-ihpc-internalized-minimal-agent-research.md`(9-agent 调研 + 对抗式 + 完整性批评,关键论断已核对源码),并对账 `docs/archive/AUDIT_2026-06-19_ihpc-sched-internalization.md`。

**目标:** 把 iHPC 调度器的**大脑内化进插件(TypeScript/MCP)**,与既有 `sweep.*`/`campaign.*`/`jobs.*`/`quotas.*`/`ihpc-start` 融为一体;节点上只部署一个**极小的 slot 填充推进器**(~250–350 行 Python stdlib),它从插件写的 PLAN 启动 detached 作业、在客户端离线时自主推进队列、把 STATE 写盘供插件重连时读取。

**架构决策(已定,不再论证):** 大脑/肌肉分离。**运行期**调度器循环留在节点(survive-logout 必需);**代码所有权** first-party(§0);**节点足迹最小**——节点不做 placement 策略、不做队列策略、不算 quota、不发邮件、没有 14 子命令 CLI。

**技术栈:** TypeScript(ES modules、Zod、Ajv)、`node --test`;复用 `ihpc-start.ts` 的 inline-Python micro-worker 机制(`SUPERVISOR_PY`/`remote-python.ts`)、`lib/ssh.ts`、`lib/ihpc-contract.ts`、`ops/quotas/*`、`ops/jobs/sweep.ts`、`ops/plans/planner.ts`、`ops/quotas/campaign*`;节点推进器为 Python 3 stdlib。

---

## 0. 所有权模型 + 两处必读修正

**所有权(first-party):** `ihpc-sched` 是插件的 **first-party 子系统**,由你自有的 `mtics/uts-ihpc` 整合进 `ihpc-scheduler/`,直接编辑;**退役**「从上游 vendoring + sync + 脱敏自有 id + 钉上游 SHA」那套(`sync-ihpc-scheduler.sh`/`check-provenance.mjs`/`redactions.local.txt`);`UPSTREAM`/`PROVENANCE.json` 降为一次性来源说明。但注意:内化后**整棵完整调度器并不部署到节点**——只部署 §2 的极小推进器;完整树里的 placement/scanner/mail/CLI 移进大脑或丢弃。

**两处批评强制的修正(已核对源码,务必不要回退):**

1. **「节点完全不跑 nvidia-smi」是错的绝对化。** 节点必须保留**唯一一处** `nvidia-smi`——per-job wrapper 在**启动瞬间**断言目标 GPU 真空闲(vendored `submitter.py:145`(`--query-gpu`)/`:154`(`--query-compute-apps`)本就为「GPU 可能被外部进程占用」跑此检查;`AUDIT_2026-06-19:43` 记录了「锁是 per-state-file 不是 per-GPU」的竞态;多账号共享同节点是受支持拓扑)。**离开节点的是 placement 策略与跨节点均衡,不是这道最终空闲断言。**

2. **deploy 的锁还不存在,且当前默认是「不确定即可清」。** 实测 `probeSchedulerActive`(`scheduler-deploy.ts:147`):`active = ageSeconds <= 900 && hasWork`,头注释「ANY failure… SAFE TO DEPLOY」——一个**崩溃但仍有活 GPU 作业**的推进器会被读成「非活跃 → 可清」。所有锁、孤儿 GPU 探测、`contractOrdering`、STATE_VERSION 预检都是**净新增**,且 `probeSchedulerActive` 必须**反转为 fail-closed**。

---

## 1. 概要

**大脑/肌肉分离。** 插件(与用户在线时)= 大脑:placement *策略*、队列/sweep/campaign 推进*策略*、quota/conformance gate、版本钉住部署、单写者协调、权威 state-of-record(RunRecords)。节点 = 极小常驻推进器:读不可变 PLAN、填空 slot、**离线自主推进**、写 STATE。推进器是既有单次 `SUPERVISOR_PY`(`ihpc-start.ts:455`)从「起一个 detached 进程」到「起 N 个、对账、补位、循环」的直接泛化。

这是经典的**胖控制端/瘦节点**分解(Slurm `slurmctld` vs `slurmd`/`slurmstepd`),带 task-spooler 的离线推进保证,但把 placement *策略*从节点抬走。恢复是 **reconcile-never-reattach**:落盘的幂等终止标记(`result.json`)是权威,完成的作业永不重跑,崩溃后从文件重建全部进度。

---

## 2. 极小节点推进器(核心交付物)

### 2.1 职责与明确的非职责

| 做 | 不做 |
|---|---|
| 启动时读一次 PLAN(按 `queue_id` 不可变) | 决定*哪个*作业跑(大脑预排队列) |
| 由**活 PID vs slot 上限**数空 slot | 跑队列/placement *策略*、跨节点均衡 |
| **仅在启动瞬间**用 `nvidia-smi --query-compute-apps` 断言目标 GPU 空闲 | 持续轮询 nvidia-smi;算占用*策略*;选哪块 GPU |
| 经 `setsid` wrapper 把下一个就绪作业起进已认领 slot | 算 quota / ban-关键限额 |
| 跟踪 PID;退出时写幂等终止标记 | 发邮件、维护 CLI、持有 state-of-record |
| 离线自主推进;原子(durable rename)写 STATE | reattach 进程句柄;重跑已完成作业 |
| 每轮心跳;队列排空或真空闲时退出 | 重新放置作业(冲突 → 标记 + 交还大脑) |

节点权威是有界的:执行交给它的 plan,世界与 plan 不符时(GPU 忙)**拒绝并上报**,只报观测。*策略*在大脑。

### 2.2 PLAN 文件(大脑 → 节点;JSON;原子 durable 写)

**路径:** `~/.uts-computing/scheduler/state/<campaign_id>/plan.json` —— profile-root 目录,**可跨重启留存,绝不 `/tmp`**。

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
  "limits":   { "slot_count": 2, "max_slots_per_gpu": 1, "log_max_bytes": 209715200 },
  "security": { "allowed_roots": ["/home/user/project", "/scratch/user"],
                "env_key_allowlist": ["CUDA_VISIBLE_DEVICES", "UTS_RUN_ID", "OMP_NUM_THREADS", "PYTHONUNBUFFERED"] },
  "policy":   { "on_job_failure": "continue",
                "failure_breaker": { "max_consecutive_failures": 5, "require_one_success": true },
                "idle_definition": "no_running_and_no_launchable_pending",
                "idle_exit_seconds": 604800, "restart_throttle_seconds": 2 },
  "jobs": [
    { "seq": 0, "run_id": "run_abc123",
      "command_argv": ["python", "train.py", "--lr", "0.01"],
      "workdir": "/home/user/project",
      "env": { "CUDA_VISIBLE_DEVICES": "$GPU_INDEX$", "UTS_RUN_ID": "$RUN_ID$" },
      "gpu_index": 0, "gpu_count": 1, "timeout_seconds": 3600 }
  ]
}
```

**设计点(每条对应一处批评修正):**
- **`seq` 是唯一推进键**(GNU-parallel `--resume`):「哪些已完」由 `seq` 匹配终止标记重建。**PLAN 对同一 `queue_id` 必须不可变**——seq-keyed resume 若 plan 中途变更会损坏。
- **`command_argv` 是预转义 argv 数组;禁止 `bash -lc`** —— 让引号注入类问题无法表示,匹配 `SUPERVISOR_PY` 的「非空字符串列表」契约(`ihpc-start.ts:477`)。
- **token 展开是加固的,不是手挥**:sentinel 形如 `$GPU_INDEX$`/`$RUN_ID$`,**只在 `env` *值*里**展开(绝不进 `argv[0]`、不重新切词、不嵌套),按**固定白名单字面替换**;未知 `$TOKEN$` **硬失败,不透传**。
- **`env_key_allowlist` 节点侧强制**:plan 在可能共享的节点上,被篡改/第二写者的 plan 可能塞 `LD_PRELOAD`/`BASH_ENV`/`PYTHONSTARTUP`;wrapper exec 前**拒绝任何不在白名单的 env key**。
- **`gpu_index` 由大脑分配**(placement 策略是大脑的活),但**启动时由 wrapper 再断言空闲**(§2.5)——大脑决定,节点验证。
- **`allowed_roots`** → wrapper 启动时对 `workdir` realpath 复校在 roots 内(纵深防御,同 `SUPERVISOR_PY.checked_path` `ihpc-start.ts:467`)。
- **`depends_on` 在 v1 砍掉**:它曾是个无定义行为的 schema 字段(潜 bug),作业顺序完全由 `seq` 表达(大脑发 plan 前把任意 DAG 线性化成 seq);真要 intra-plan 依赖,v1.1 再带定义良好的 ready-set。
- **`schema_compat_min`** 声明能安全读此 plan 下 STATE 的最旧大脑——前向兼容契约(§2.7)。
- **扁平字段按关注点分组**(`limits`/`security`/`policy`;STATE 侧 `progressor`/`health`)—— 让**结构布局承担分组语义**,而非一袋平铺字段全靠名字区分(贯穿全 spec 的「语义=结构+命名」原则,同 §3.4 的 `control/node/seam` 目录树)。

### 2.3 SLOT-STATE 协议(节点 → 大脑;单一 summary 文件=真相源)

大脑一次 `cat` 读**一个** `state.json`(整文件、atomic-rename-safe、绝不 `tail`);per-slot `result.json` 仅在观测到终止态时读。**身份是 slot/seq 目录,不是 PID**(s6/nq 教训——击败 PID 复用)。

```json
{
  "schema_version": "1.0.0",
  "campaign_id": "campaign_20260620_abc123",
  "queue_id": "sha256:<plan-content-hash>",
  "lease_owner": { "client": "claude", "device_id": "laptop-7f3a" },
  "observed_at_node": "2026-06-20T14:45:30Z",
  "node_clock_epoch": 1781966730,
  "progressor": { "pid": 54321, "started_at_node": "2026-06-20T14:32:11Z", "heartbeat_node": "2026-06-20T14:45:30Z" },
  "health": { "degraded": null, "breaker_tripped": false },
  "slot_count": 2,
  "jobs": {
    "0": { "seq": 0, "run_id": "run_abc123", "status": "running", "pid": 12345, "gpu_index": 0,
           "started_at_node": "2026-06-20T14:32:15Z", "log": ".../slot_0/stdout.log" },
    "1": { "seq": 1, "run_id": "run_def456", "status": "done", "pid": 12350, "gpu_index": 1, "exit_code": 0,
           "started_at_node": "...", "finished_at_node": "...", "log": ".../slot_1/stdout.log" }
  },
  "counts": { "pending": 0, "running": 1, "done": 1, "failed": 0, "cancelled": 0, "conflict": 0 }
}
```

**per-job 终止标记 `.../slot_<seq>/result.json`**(wrapper 写,原子 durable rename,权威且幂等):
```json
{ "seq": 1, "run_id": "run_def456", "exit_code": 0, "signal": null,
  "started_at_node": "...", "finished_at_node": "...", "duration_seconds": 707, "attempt": 0 }
```

**状态词表:** `pending | launching | running | done | failed | cancelled | placement_conflict`(本 GNU-parallel joblog,加 `launching` 与 `placement_conflict`)。

**时钟偏移规则(核对 `scheduler-deploy.ts` 的 `nowSeconds - heartbeatAt`):** 所有 `*_at_node` 时间戳与时长**节点侧、节点钟 vs 节点钟**计算;大脑视其为**不透明标签**,绝不用「笔记本 now − 节点时间戳」相减。心跳新鲜度由**节点**算(节点戳 `progressor.heartbeat_node` 并带 `node_clock_epoch`),大脑用节点相对量或两次 SSH 读取相减。修正了当前 900s 规则的跨钟相减。

**原子性(承重修正):** 每次写 = **temp → `fsync(file)` → `rename` → `fsync(父目录 fd)`**。**目录 fsync 是强制的**:否则 POSIX 允许重启时丢失 rename(目录项变更)而文件内容存活 → 已完成作业的 `result.json` 消失 → §2.6 的「无标记 ⇒ pending」会**重跑已完成作业**(正是我们要避免的 Nomad 式 bug)。这比 vendored `state.save`(`.bak`+`.tmp`+rename,`state.py:205`)多加了它缺的目录 fsync。**诚实补注:目录 fsync 在 NFS/Lustre 上可能部分 no-op,而 iHPC 家目录正是 NFS/Lustre**——所以「绝不重跑」的真正后盾是**标记幂等性 + lease**,目录 fsync 是「支持的文件系统上的正确性」加成,非无条件充分。

### 2.4 自主推进 —— 极小常驻 reconcile 循环(选 Option A)

```python
while has_running_or_launchable(state, plan):
    reconcile_slots(state)        # harvest 死 PID → 读终止标记 → done/failed/conflict
    write_heartbeat(state)        # 每轮 mtime 面包屑(SPOF 可检测)
    launch_ready(state, plan)     # while 空 slot>0 且有就绪 pending seq:claim-then-setsid-launch
    write_atomic_durable(state_json, state)
    if breaker_tripped(state, plan): mark_breaker(); break
    if genuinely_idle(state, plan): break   # idle = 无 running 且无 launchable-pending
    sleep(backoff_poll_interval(state))      # 活跃 ~2-5s;无 pending 时退避
```
`free = slot_count − count(status∈{launching,running} 且 pid 活)`。空 slot 由**数活作业**得到,绝不用 token 池。

**机制选型:**

| 选项 | 裁决 | 原因 |
|---|---|---|
| **A. 常驻 reconcile 循环**(`setsid nohup`) | **选中** | 一个 SIGTERM 即可取消/drain;单一 liveness 权威;slot 数自愈;~250–350 行 stdlib;最贴近既有 `SUPERVISOR_PY`;镜像 task-spooler 离线推进但去掉 placement 策略 |
| B. setsid 链(每个作业 exec 下一个) | 否 | 无法中途停/改序;顺序冻结;卡住的作业永堵链;无中心 liveness/上报 |
| C. systemd --user + linger + timer | 否(默认) | `enable-linger` 需一次性 **root**,user-space-only iHPC 账号可能没有;仅作*探测到*的增强,Option A 是保底 |
| C′. cron `@reboot` | **仅重启场景采纳** | user-space、**无需 root**、survive reboot —— Option A 唯一缺的能力;离线重启后从标记重起推进器(§2.6) |

**slot 认领在 fork 前原子且 seq-keyed(承重修正):** 只数活 PID 有启动窗口竞态——在 `setsid …&` 返回到子进程写 `run.pid` 之间,`kill -0` 看不到,第二轮(或中途重起的推进器)会重复 fire 同一 `seq`(= 同 `run_id` 两次 = reconcile 损坏 + 双重 GPU 用)。修:`setsid` **之前**用 `O_CREAT|O_EXCL` 建 `slot_<seq>/launching.marker`(复用本仓库 `lock.py:50`),wrapper 起来后 rename 成 `run.pid`。reconcile:有 marker + 无活 pid ⇒「启动中崩溃 ⇒ pending(新 attempt)」;有 marker + 活 pid ⇒「已认领,勿重起」。

**数活而非 token**:否掉 GNU-make jobserver 的 FIFO-token,正因为 token 在 OOM-kill 时永久泄漏(make 有记载的弱点);数活 PID 对崩溃自愈,launch marker 补上其唯一缺口。

### 2.5 per-job wrapper —— `slurmstepd` 类比,带启动时 GPU 守卫

复用 `SUPERVISOR_PY` 原语(`start_new_session=True`、`stdin=DEVNULL`、`close_fds=True`),加 env 白名单、token 展开、root 复校、**启动时 GPU 空闲断言**、日志大小上限:

```bash
setsid bash -c '
  # 1. 校验:workdir realpath 在 allowed_roots;env key 在白名单;token 字面展开
  # 2. 启动时 GPU 守卫(节点上唯一的 nvidia-smi):
  if gpu_busy_by_foreign_pid "$GPU_INDEX"; then
       write_result_json status=placement_conflict   # 不 exec;大脑重连时重放置
       exit 0
  fi
  echo $$ > "$SLOT/run.pid" && mv "$SLOT/launching.marker" handled
  # fork + wait(不 exec-replace),使 wrapper 能 trap SIGTERM:
  "${ARGV[@]}" >"$SLOT/stdout.log" 2>&1 </dev/null &  job_pid=$!
  trap "kill -- -$job_pid; write_result_json status=cancelled; exit 0" TERM
  wait "$job_pid"
'
# 正常退出 → wrapper 写 exit.code 再写 result.json(durable rename);收到 SIGTERM → 写 status=cancelled
# (故被杀作业总有终止标记,否则 reconcile 误判「崩溃」——§7 取消语义);全程执行 log_max_bytes
```

- **启动时 GPU 守卫是共享节点安全故事的关键。** 它是节点上*唯一*的 `nvidia-smi`,限定在使用瞬间——这一点跨账号安全,因为大脑的逻辑预记账无法对*第二个账号的独立大脑*序列化(锁是 per-state-file 非 per-GPU,`AUDIT:43`;多账号同节点是受支持拓扑)。它廉价(一次本地 nvidia-smi,无 SSH),是让**离线 refill 到共享 GPU 安全**的那一点。冲突时作业变 `placement_conflict`、不启动,大脑重连时重放置。
- **取消** = `kill -- -$pgid`(经 setsid 会话的进程组 kill);**liveness** = `kill -0 pid` / `/proc/<pid>`,配 `started_at_node` 击败 PID 复用。
- **日志上限:** wrapper 执行 `log_max_bytes`(截断标记或轮转);推进器自身写 STATE 遇 `ENOSPC` 时设 `degraded:"disk_full"` 并暂停启动,而非空转。

### 2.6 崩溃/重启恢复 —— reconcile,绝不 reattach

恢复是 on-disk 标记的纯函数。(重)启动时对每个 `seq`:

| on-disk 证据 | 结论 | 动作 |
|---|---|---|
| `result.json`/`exit.code` 在 | **终止** | 信任;**绝不重跑**(§2.3 的 durable rename 让它跨重启成立) |
| `launching.marker` 在,pid 死/无 | **启动中崩溃** | 重新 eligible 为 pending,**新 attempt** |
| `run.pid` 在,`kill -0` 活,无终止标记 | **running** | adopt;占其 slot |
| `run.pid` 在,`kill -0` 死,无终止标记 | **崩溃** | 标 failed;`on_job_failure` 策略决定 |
| `result.json status=placement_conflict` | **deferred** | 大脑重连重放置;非失败 |
| 无标记 | **pending** | eligible 启动 |

- **客户端登出/VPN 断/笔记本睡眠:** 大脑消失;作业存活(自有 setsid 会话);推进器继续填 slot、写 STATE。重连 ⇒ 大脑读一次 `state.json`,对账 RunRecords。
- **推进器崩溃(OOM):** detached 作业存活。大脑检测到死 `progressor.pid`(或**陈旧心跳**——§2.4 面包屑让它*可检测而非静默*)+ 活作业 ⇒ 用同一 plan 重起同一推进器 ⇒ 从标记 resume,无损。
- **节点重启 —— 诚实边界:** 草稿的「插件重起推进器」对离线场景是错的——大脑仅在用户在线时跑,离线重启会搁置 campaign。**明示边界:** detached 作业重启即死;无自治重生时 campaign **暂停到重连**,再从标记 resume。需要跨重启自治的用户,唯一正当的节点常驻是 user-space **cron `@reboot`**(无需 root,不同于 systemd-linger),**经 profile 标志 opt-in**,非默认。默认路径**不**宣称「重启自愈」。

`restart_throttle_seconds ≥ 1` 守护重起(s6 规则)防瞬失作业 fork-bomb。**连续失败熔断:** 节流只界 fork *速率*不界总*时长*——剩余作业全瞬失会烧满 `idle_exit_seconds`(且因「活跃」永不 idle-exit);`failure_breaker`(N 次连续失败且零成功 ⇒ 写 `breaker_tripped`、暂停、待重连)关掉它。

### 2.7 schema 前向兼容(死锁破除器)

长 campaign 可能跨越一次插件升级。deploy 在活作业上拒绝(§4);大脑读不了旧 schema STATE 就无法对账 ⇒ **死锁**。规则:**PLAN/STATE schema 在大版本内 append-only 且前向兼容。** v1.x 大脑必须能读任意 v1.y STATE(`y ≤ 自身`),忽略未知字段;`schema_compat_min` 在 PLAN 里声明下限。*大*版本跳(v2)是唯一可能破坏对账的,且须先 drain 活 campaign。此机制独立于 `state.migrate.{plan,apply}`(那是插件本地记录迁移,非节点文件迁移)。

### 2.8 语言/依赖 —— Python 3 stdlib,inline ship

仅 stdlib(`os, sys, json, subprocess, time, signal, pathlib, tempfile, fcntl`)。无 PyYAML(POSIX sh 解析不了 YAML,且 PyYAML 是依赖;JSON 是 stdlib)、无 paramiko、无外部包。像 `SUPERVISOR_PY` 一样**经 SSH stdin inline ship**(`pyImports`/`PY_DECODE_SPEC`/`remote-python.ts`)——**什么都不"安装"**。POSIX-sh 被否(纯 sh 解析 `state.json` 易错;stdlib Python 是 user-space-only、间歇 SSH、survive-logout 节点的正确层级)。

**诚实风险:** 「代码少」≠「风险小」。常驻循环本身是推进的 SPOF——OOM 则 refill 停到重连;心跳面包屑(§2.4)让其**可检测**;idle 退避缩小多天轮询足迹。我们保留 SPOF(vendored 调度器本就有)但把它显式化。**注意 `idle_exit_seconds` 默认 7 天(§2.2)与本仓库 `skills/confirm-usage/` 的「iHPC 节点占用监控」直接相干**:drain 完但未退出的推进器会轮询一周,可能触发「你还在用这个节点吗」的邮件;规划时考虑更短默认或显式的 usage-monitor 交互。

---

## 3. 插件大脑

### 3.1 移进插件(TS)的部分

| 关注点 | 原(Python 调度器) | 现(插件 TS) |
|---|---|---|
| placement **策略** | `placement.py` `NodeSlots`/`_find_slot` | `control/placement.ts`:分配 `(node,gpu_index,slots_per_gpu)` —— **记账优先,SSH 探测仅冷启动/adopt/漂移** |
| 队列推进**策略** | `scheduler.py` `run_forever`/`_dispatch_pending` | `control/queue.ts`:排序、`max_concurrent`、campaign 边界、FIFO/公平 |
| 预记账(防双放置) | `scheduler.py` `_dispatch_pending` 的 `virtual_gpu_counts`(init `:265-266`、递减 `:324-325`) | **同算法移植 TS** —— 注明*prior art*,非新创 |
| **最终空闲 GPU 检查** | `submitter.py:145,154` nvidia-smi 阈值 | **节点 wrapper 启动时守卫**(§2.5)—— 节点唯一 nvidia-smi |
| state-of-record | `state.py` `SchedulerState`(节点 JSON) | RunRecords(`core/types.ts`);节点文件是 cache |
| quota/ban-关键限额 | (已 TS)`quotas/*` | 不变;**PLAN 写前**检查 |
| 单写者协调 | `lock.py` `SchedulerLock`(`O_CREAT|O_EXCL`) | **重新实例化,非删除** —— 见 §3.2 |
| mail、hot-reload、tmux CLI | 调度器内部 | **丢弃** |

**placement 记账优先,非探测优先。** GPU 拓扑静态(`queue.example.yaml:9`,从 `hardware.yaml` 解析),per-account 视角下我们 slot 的占用者只有我们自己的作业,大脑已从 plan/state 知晓。所以**常路 placement 是纯大脑记账**(`virtual_gpu_counts` 式预记账:作业*被放进 PLAN 时*递减可用 slot,而非事后观测)+ **零 SSH nvidia-smi**。SSH nvidia-smi 探测仅留给**冷启动/adopt/漂移**路径。这把 `control/placement.ts` 从 L 砍到 S,并去掉每次提交对间歇 SSH 的依赖。**探测原本提供的跨账号/外部进程安全,移到节点启动守卫(§2.5)**——严格更优,因为它在真正使用瞬间跑,且是唯一对第二账号独立大脑也安全的点。

**为何预记账与启动守卫都要:** 预记账防*我们自己*大脑超订*我们自己*的 slot(「16 作业塞 4 GPU」);启动守卫防*外部*进程(别的账号、裸交互作业)撞上大脑离线时分配的 slot。互不取代。

### 3.2 单写者协调 —— 锁没消失,是搬家了

草稿写「lock → 丢弃」是**真 bug**。你跑**两个客户端(Claude Code 与 Codex)**跨可能多设备;两个大脑会都预记账、都写 PLAN(原子 rename = 后写者赢 ⇒ 静默队列覆盖)、都起推进器 ⇒ 双放置。vendored `SchedulerLock`(`O_CREAT|O_EXCL` + 陈旧 PID 检测,`lock.py:50`)须**重新实例化为 per `(profile,node)` 单写者 lease**:
- lease 写**在节点**(`~/.uts-computing/scheduler/lease.json`,`O_CREAT|O_EXCL`,持有者 `{client,device_id,pid,queue_id}`,节点侧按心跳age 检陈旧)。
- **推进器拒绝 `lease_owner` ≠ 当前 lease 持有者的 PLAN**(节点侧执行点)——竞争写 plan 的第二大脑在启动时被拒,而非静默覆盖。
- 大脑侧:placement 前 acquire/refresh lease;遇陈旧 lease(死持有者)新大脑可接管并经 lineage(§5a)adopt 在飞作业。

### 3.3 与既有工具的融合

```
sweep_plan({parameters, maxConcurrent, campaignId})
  → SweepResult.table[{index, params}]
      → planJob(... campaignId) ⇒ N RunRecords(status:"planned")            [ops/plans/planner.ts]
          → control/queue.ts:按 campaign 入队,施加 max_concurrent
              → 取 (profile,node) LEASE                                       [§3.2]
                  → quotas_capacity(refresh) + checkIhpcNodePoolConformance ⇒ GATE  [quotas/*]
                      → control/placement.ts:预记账(记账)⇒ 分配 node+gpu_index
                          → control/plan.ts:发 PLAN(durable 写)
                              → seam/launch.ts:原子 SSH 写 PLAN + 每节点起一次推进器
                                  ⇒ RunRecord.supervisor.pid, .placement.gpu_slot, .queue_position, .lease_owner
jobs_track / 重连
  → 一次 SSH 读 state.json ⇒ 对账 RunRecords(running/done/failed/conflict)    [seam/reconcile.ts]
campaign_status / campaign_audit ⇒ per-account ledger 汇总(不变)              [campaign.ts]
```
`campaignId` 已贯穿 `sweep_plan → planJob → RunRecord.campaign_id`;quota 逻辑已是无状态/快照驱动/一次一账号(正确模型——留 TS,绝不下放节点);`ihpc-start` 从「起一个进程」演进为「每节点起一个**推进器**」——但**保留快路径**(§6 D1)。

### 3.4 新增/改动的 TS

**新子系统树 `ops/scheduler/{control,node,seam}/`** —— 目录结构承担「大脑侧 / 节点侧 / 跨接缝」语义,文件名只承担具体关注点(去掉冗余的 `scheduler-` 前缀;**结构 + 命名混合承担语义**):

| 文件 | 用途 | 工作量 |
|---|---|---|
| `control/placement.ts` | **记账预记账**(移植 `virtual_gpu_counts`);SSH nvidia-smi **仅**冷启动/adopt/漂移 | **S**(原 L) |
| `control/queue.ts` | pending 队列、campaign 成员、`max_concurrent`、推进策略 | L |
| `control/lease.ts` | per `(profile,node)` 单写者 lease、陈旧检测、接管 | M |
| `control/plan.ts` | `planNextBatch()` → lease+队列+placement+quota gate → 发 PLAN(原 scheduler-brain) | M |
| `node/progressor.py` | ~250–350 行 Python stdlib,inline ship —— **唯一真正部署到节点的东西** | M |
| `seam/protocol.ts` | PLAN/STATE schema + Ajv 校验;token/env-allowlist/argv/realpath 断言;`schema_compat_min` 检查(原 node-agent-plan) | M |
| `seam/contract.ts` | agent 版本契约:build-ordinal 格式 + `compareContract` + `contractOrdering`(relocate+扩展既有 `lib/ihpc-contract.ts`,更新 importer 如 `scheduler-version.ts`) | M |
| `seam/launch.ts` | 原子 SSH 写 PLAN(durable)+ 起推进器;持久化 placement/lease/supervisor(原 ihpc-launch) | M |
| `seam/reconcile.ts` | `reconcileIhpcCampaign()` —— 一次读 `state.json`;同步 RunRecords;**死推进器但活作业的 adopt 路径** | M |

**改既有文件:**

| 文件 | 用途 | 工作量 |
|---|---|---|
| 扩 `core/types.ts` | RunRecord 新增 `+queue_position`、`+lease_owner`、`+auto_progressed{by_node_agent,freed_by_run_id}`、`+attempt`;`gpu_slot` **并入既有 `placement{}`**(`:248-254` 已有 gpu_index/slots_per_gpu)、progressor pid **并入既有 `supervisor{}`**(`:237`),勿重复建块 | S |
| 扩 `lib/ssh.ts` | `sshWriteAtomicJson()`(durable:temp→fsync→rename→dir-fsync) | S |
| 扩 `ops/jobs/jobs.ts` | `jobs.track` 调用 `seam/reconcile.ts` | S |

---

## 4. tiny agent 的部署 + 版本 —— 全部净新增、fail-closed

**框架更正:** 草稿说这些「survive/transfer」。它们不存在。当前 `probeSchedulerActive` **默认不确定即可清**(`active = ageSeconds <= 900 && hasWork`;头注「ANY failure… SAFE TO DEPLOY」)。以下每项都是 **Phase-A 要建的**。

- **把 `probeSchedulerActive` 反转为 FAIL-CLOSED(最高优先)。** 读不到状态/SSH 错/空输出 ⇒ **拒绝部署**,不是「安全」。仅当能**正面证明节点无活作业**时才安全——「活作业」由**孤儿 GPU 探测**(固定 argv `nvidia-smi --query-compute-apps=pid` + `pgrep -f setsid`)检测,使*崩溃但有活 GPU 作业的推进器*读成 **crash-with-live-work ⇒ 拒绝**。这是部署的*前置条件*,非增强。
- **三把锁(净新增):** Lock 1 确认门;Lock 2 活跃探测(现 fail-closed + GPU-liveness);Lock 3 部署后契约须读 `match`。
- **契约格式改(破坏性,由 `state.migrate` 守):** 当前 pin `"0.1.0+state2+e6883a9"` 是*上游 SHA*,`compareContract` 只返回 `match|stale|unknown`(**无排序**,且 git SHA 不可排序),故 `contractOrdering(older/newer/divergent)` 从今天格式**推不出**。修:**加单调 build ordinal** → 格式 `version+stateN+buildM+sha`;**first-party**(由插件自有 build 生成,非上游)。`contractOrdering(live,expected)` 比 `(stateVersion, build)` 字典序:`older ⇒ 重部署`、`newer ⇒ 拒绝`(第二账号部署了更新 agent)、`equal-(version,build)-不同-sha ⇒ divergent ⇒ 拒绝`。这级联到 `CONTRACT_RE`/`schedulerContractVersion` 并需 `state.migrate` 步;标为**破坏性格式改**。`compareContract` 保留 3 值并集向后兼容;`contractOrdering` 是新增。
- **STATE_VERSION 预检(Lock 2.5):** SSH 读节点状态文件版本;不匹配/legacy ⇒ 拒绝 + 呈现原因。独立于 `state.migrate.apply`(插件本地)。配 §2.7 前向兼容,使在飞 campaign 不被搁置。
- **`node_scheduler` profile 字段**(可选;新校验器**必须**把缺省默认为 `console` ⇒ 既有 Codex profile 校验不变——这是净新增代码要保证的,非既有不变量):`{runner: console|uv|cron_reboot, uv_bin, dir}`,严格白名单、shell-quote、无 operator 插值;不匹配 ⇒ `runner-drift` verdict。(`cron_reboot` 是 §2.6 的重启自治 opt-in。)
- **部署到插件自有目录 + SHA256 戳 + `current` 符号链接 + keep-N=3 回滚。** **stdlib-only 推进器可能根本不需要 uv** —— 若是,整个砍掉 `uv run --frozen --offline`/`uv.lock`;否则为极小载荷保留。

**丢弃/退役:** 上游 sync(`sync-ihpc-scheduler.sh`/`check-provenance.mjs`/`redactions.local.txt`/内嵌真实 id)—— 代码 **first-party**,直接编辑 `ihpc-scheduler/`;14 子命令 CLI、tmux 循环、placement/mail 模块**永不部署到节点**,其部署面消失。**锁不退役** —— 搬到大脑 + 节点 lease(§3.2)。

---

## 5. Feature B 重定(`jobs.adopt`)—— 两轴信任

草稿「lineage-proven 严格强于 PBS」**混淆了两条信任轴**。分开:
- **轴(i)终止记录 provenance:** *是我们的 agent 产出这条退出记录吗?* 我们推进器起的作业:**是,强** —— `exit.code`/`result.json` 由 wrapper 在*我们*代码里写。严格强于 PBS 的外部 `qstat`。
- **轴(ii)意图保真:** *它跑的是用户本意吗?* `command_argv`/`workdir` 源自**用户 sweep 参数,仅 shape+root 校验**(`ihpc-start.ts:477,467`),**未**语义验证 —— **与 PBS 同级**。

**(a) 我们推进器从我们 PLAN 起的作业 → adopt 执行事实为权威。** 对账读 `state.json`;合成 supervisor block;经 `queue_id`/`run_id`/`lease_owner` 匹配持有的 RunRecords 证明 lineage。provenance 标志**二维**:`terminal_record: agent_authored`(强)+ `intent: user_declared`(仅 shape 校验)。`jobs.status/logs/cancel` 作用于*我们*的 pid/log 路径 ⇒ 健全。别让「我们起的」把未验证 `argv` 洗成「意图权威」。

**(b) 发现的非我们启动的作业**(裸 `ihpc-sched start`,或内化前)→ **history-only + `not_lineage_proven`**,每个上报路径过完整 realpath gate;`jobs.status/logs/cancel` 拒绝直到后续阶段。

**(c) 我们自己的死推进器但活作业 —— 显式接线。** §5(a) 假设推进器活。恢复模型(§2.6)也会产生「我们推进器死、作业仍 detached 跑」。这**复用 (a) lineage-proven 路径**(标记+lease 证 lineage)但额外**重起推进器**resume refill —— 两行为都接进 `reconcileIhpcCampaign`。

(a)/(c) 的信任**以 Feature A 为前提**(必须先信任*部署的 agent 版本*——锁+契约+lease——才信任它写的 state)。**Feature B 排在 Feature A 之后。**

---

## 6. 迁移

**从今天:** 两条路并存 —— `ihpc-scheduler/` 完整 vendored 调度器,与单次 `ihpc-start.ts` `SUPERVISOR_PY`。

| 阶段 | 动作 |
|---|---|
| **0. first-party 切换** | 停止把 `mtics/uts-ihpc` 当上游;直接编辑 `ihpc-scheduler/`;退役 sync/provenance;清除内嵌 id;first-party 契约 pin **带 build ordinal**(§4) |
| **A. tiny agent 加硬部署** | **反转 `probeSchedulerActive` 为 fail-closed**;三锁 + 孤儿 GPU 探测 + STATE_VERSION 预检 + `contractOrdering` + `node_scheduler` 字段 + SHA 戳目录 + 回滚 + **节点 lease**(§3.2)。**首次真实节点 smoke**(唯一让所有锁真跑的地方) |
| **B. control 构建** | 落 `seam/protocol`/`control/placement`(记账优先)/`control/queue`/`control/lease`/`control/plan`;扩 RunRecord;移植 `virtual_gpu_counts` |
| **C. 推进器切换** | 用 slot 填充推进器替换 `SUPERVISOR_PY`;接 `jobs.track → reconcileIhpcCampaign`。**保留遗留单次路径于 profile 标志后做行为回滚** |
| **D. Feature B** | lineage-proven adoption(a/c);provenance-flagged history-only(b) |

**D1 —— 保留单次快路径。** 把每个单次运行都走 `seam/launch({jobs:[one]})` + 常驻推进器 + plan/state,会让*最常用、最简单*的路径依赖*整套*新机制——任何回归连单次都坏。为 `jobs==1, 无 campaign` 保留直连 `SUPERVISOR_PY` **快路径**;仅当 `slot_count>1` 或存在 campaign 队列时启用推进器。这也给**行为回滚**:`node_scheduler.runner=console`(遗留)把 profile 路由回单次(deploy keep-N=3 管载荷回滚,这个管行为)。

---

## 7. 测试与验证(此前缺失,现强制)

推进器是最高风险、最不可观测的新组件;~250–350 行而零测试计划不可接受。

- **本地假节点 harness(无 GPU,可 CI):** 推进器对 tmp 目录跑假 `sleep`/`exit N` 作业;断言 reconcile-never-reattach(无双跑、标记被尊重)。
- **崩溃注入矩阵:** temp-write 前崩、temp 与 rename 间崩、rename 后崩、`exit.code` 后 `result.json` 前崩、**启动窗口内崩(setsid 与 run.pid 间)**、**rename 后 dir-fsync 前崩(必须不重跑)**。每种都可恢复。
- **PID 复用测试:** stub `kill -0` 对复用 PID 报活;断言 `started_at_node` 配对拒绝。
- **launch-marker 测试:** 中途杀推进器;重启;断言半启动的 `seq` 不被重复 fire。
- **GPU 冲突测试:** stub `nvidia-smi --query-compute-apps` 报目标 GPU 忙;断言 `placement_conflict`、不 exec、大脑重连重放置。
- **golden inline-Python 测试:** 推进器字符串须 `python3 -c` 解析/运行(镜像 `remote-python.ts` micro-worker 先例测试)。
- **时钟偏移测试:** 节点钟 ≠ 笔记本钟;断言新鲜度/idle 决策只用节点相对量。
- **lease 测试:** 两大脑竞争写 plan;断言败者 plan 被推进器 `lease_owner` 检查拒绝。
- **命名验收语料(首次真实节点 smoke):** 冷启 → 1-slot 启动 → 重连对账 → **离线-完成-补位**(断 SSH、重连、断言离开期间下一作业已起)→ 推进器-OOM-重起 → **节点重启-暂停-重连 resume**(若 `cron_reboot` 启用则自治 resume)→ 中途取消(drain vs now)→ schema-不匹配-拒绝 → 部署-拒绝-当有活 GPU 作业。

**取消语义:** 提供**两者** —— 「立即取消」(SIGTERM 推进器 + 对每个 running 作业 `kill -- -$pgid`)与「drain」(停新启动、让 running 跑完)——映射到 `jobs.cancel`/`campaign`。被取消作业的 `result.json status=cancelled` **由 wrapper 在 SIGTERM-到-作业时写**(故被杀作业总有终止标记;否则 reconcile 误读为「崩溃」)。

---

## 8. 客户端中立(Codex)

推进器 + JSON 协议本就客户端中立。新面须落共享层,非 `.claude-plugin/`:任何新 MCP 工具遵 **5-touch 加工具规则**(见项目记忆);新 schema 入 `schemas/`;skill 入 `skills/`。**显式决定** `seam/launch`/`seam/reconcile` 是**内部**(被既有 `jobs.*`/`sweep.*`/`campaign.*` 调用——优选,不增工具面)还是新工具。中立性 checklist 作 Phase-A 门。

---

## 9. 外部范式对照

| 设计选择 | 范式 | 取/异 |
|---|---|---|
| 大脑定 placement *策略*;节点执行 | **Slurm `slurmctld` vs `slurmd`** | 取:控制端持队列/placement 策略;节点从不调度 |
| per-job detached shepherd 写自身退出记录 | **`slurmstepd`** (+`setsid`) | 取:每作业一个瞬态 session-leader,拥 pgroup,survive manager;killpg 取消 |
| 常驻循环在客户端离线时推进队列 | **task-spooler (`tsp`)** | 取:per-user daemon 在客户端缺席时拥 slot 推进。异:去掉 placement *策略*;**最终空闲 GPU 检查留在启动时** |
| 数活作业而非 token 限 slot | **GNU make jobserver(反面)** | 异:make 的 FIFO token 在 OOM-kill 泄漏;数活 PID(自愈)+ `O_EXCL` launch marker |
| seq-keyed 不可变 plan + skip-done resume | **GNU parallel `--joblog`/`--resume`** | 取:单调 `seq` 是唯一推进键;state 从标记重建 |
| 作业=目录;PID 附带;标记是真相 | **s6 / runit / nq** | 取:稳定目录身份击败 PID 复用;`exit.code` = 幂等终止态 |
| reconcile-never-reattach;绝不重跑已完成 | **Nomad alloc-dir(警示)** | 异:幂等终止标记 + **durable rename(dir fsync)** + 绝不 `/tmp` 让「绝不重跑」真成立 |
| 预记账(放置时递减,非观测时) | **vendored `scheduler.py` `_dispatch_pending`(`:265-266,324-325`)** | 取:**移植既有 prior art 到 TS**(注明,非新创) |
| 单写者 lease(多客户端) | **vendored `SchedulerLock` `O_CREAT|O_EXCL`(`lock.py:50`)** | 取:重实例化为 `(profile,node)` lease;推进器执行 `lease_owner`。锁搬家了,没消失 |
| 启动时空闲 GPU 断言 | **vendored `submitter.py:145,154` nvidia-smi** | 取:留*检查*,从控制端-放置时移到节点-启动时——唯一跨账号安全点 |
| 无 root 重启自治 | **cron `@reboot`**(vs systemd-linger 需 root) | 仅 `cron_reboot` opt-in 时取;默认 = 暂停到重连(诚实边界) |
| restart 节流 ≥1s + 连续失败熔断 | **s6-supervise** (+ 熔断模式) | 取:节流界 fork-rate;熔断界总时长 |

---

## 10. 待解问题 / 优先修复(给 spec 实现者)

**优先修复(按风险):**
1. **反转 `probeSchedulerActive` 为 fail-closed + 孤儿 GPU 探测;把所有 deploy 加硬重标为净新增** —— 当前会清掉离线工作,最高风险。
2. **placement = 大脑记账(移植 `virtual_gpu_counts`),提交时无 SSH nvidia-smi;空闲 GPU 检查移到启动时 wrapper 守卫** —— 砍最大组件 + 修共享节点离线安全。
3. **durable rename(file fsync + rename + dir fsync)+ `O_EXCL` launch marker** —— 缺任一,「绝不重跑」与「无重复 seq」都不成立。
4. **重新实例化单写者 lease** —— 否则两客户端(Claude+Codex)静默覆盖 plan / 双放置。
5. **契约格式:加单调 build ordinal 后再 `contractOrdering`;标破坏性 + `state.migrate`。**
6. schema 前向兼容(§2.7)、精确 idle 定义 + 砍 `depends_on` + 失败熔断、节点侧时钟数学、env 白名单 + token 加固 + log-cap/disk-full。
7. 诚实重启边界 + opt-in `cron_reboot`、心跳-可检测 SPOF。
8. 推进器崩溃注入 harness + 命名验收语料;取消 drain-vs-now + wrapper 写 `cancelled`;单次快路径 + 行为回滚标志;Codex-中立 5-touch checklist。

**待规划解决:**
- `seam/launch`/`seam/reconcile` 走内部 vs 新工具(§8)。
- 推进器是否真能零依赖到完全不需要 uv(§4 末);若是则砍 uv 相关。
- lease 接管时对在飞作业的 adopt 细节(§3.2 + §5c)。

---

## 11. 范围外

- 节点循环升 tmux→`systemd --user`+linger(节点侧运维;`cron_reboot` 已覆盖无-root 重启自治)。
- intra-plan `depends_on`(v1 砍掉;真需要时 v1.1 带定义良好 ready-set)。
- 任何 `ops/quotas/*` 改动(ban-关键限额独立于本工作,留 TS)。
- summarizer 等 vendored optional 依赖。
