# UTS iHPC 工具集

个人工具，用于在 UTS iHPC 集群上扫描节点资源状态、自动调度和监控实验。

> **平台文档**：iHPC 使用文档见 [docs/](docs/)，整理自[官方文档](https://ihpc.research.uts.edu.au/help/documentation-rhel-810/)（RHEL 8.10）。

## 工具概览

- **Scanner** — 通过 `cnode avail` 扫描所有节点（1 次 SSH），按空闲度打分排序
- **Scheduler** — 在自己的 NoMachine 会话节点上提交、监控实验，支持邮件通知、运行中安全扩容和结果索引

## 环境准备

```bash
uv sync
cp configs/config.example.yaml configs/config.yaml    # 填入账号和密码
cp configs/queue.example.yaml configs/queue.yaml      # 填入节点和实验列表
```

> `configs/config.yaml` 和 `configs/queue.yaml` 含敏感信息，已被 `.gitignore` 排除。

## Scanner — 节点扫描器

扫描所有可用节点，按空闲度评分（0–100）排序输出。只建立 1 个 SSH 连接（到头节点），不会 SSH 到计算节点。

```bash
ihpc-scan                              # 扫描所有节点（默认账号，按空闲度排序）
ihpc-scan --cluster turing --idle-gpu  # 只看 Turing 集群，且 GPU 空闲的节点
ihpc-scan --min-score 70 -f json       # 只看空闲分 ≥ 70 的节点，输出 JSON
ihpc-scan --all-accounts               # 扫描所有账号
ihpc-scan --force                      # 跳过缓存强制刷新
ihpc-scan -w cpu                       # 使用 CPU 优先权重
```

### Python API

```python
from src.scanner import NodeScanner, load_config

config = load_config()
scanner = NodeScanner(config)
result = scanner.scan()   # 1 次 SSH 到头节点

# 打印表格
print(scanner.display(result))

# 筛选 + 排序
for node in result.filter(cluster="turing", min_score=70):
    print(f"{node.hostname}: score={node.idle_score}  gpu={node.gpu_pct}%")

# 输出 JSON
print(scanner.display(result, fmt="json"))
```

## Scheduler — 实验调度器

在已建立 NoMachine 会话的节点上提交实验，自动分配 GPU（通过 `CUDA_VISIBLE_DEVICES`），监控 PID 和退出码，发送邮件通知。

**在 turing2 的 tmux 会话中运行**：

```bash
ihpc-sched doctor                 # 只读检查 queue/state 是否安全匹配
ihpc-sched doctor --probe-nodes   # 只用 head-node cnode 检查 my_nodes Connect 状态
ihpc-sched start --dry-run        # 预览启动计划，不写 state，不提交任务
ihpc-sched start                  # 启动调度器（阻塞运行，放在 tmux 里）
ihpc-sched status                 # 只读查看当前队列状态
ihpc-sched status --json          # JSON 状态，便于脚本读取
ihpc-sched status --explain       # 仅探测本 queue 的 my_nodes，解释 pending 阻塞原因
ihpc-sched report                 # 只读汇总 outputs/scheduler_state/*.json
ihpc-sched artifacts --status done --output outputs/artifacts.json
                                  # 从 scheduler states 生成实验产物索引
ihpc-sched archive                # dry-run：列出可归档的 completed state
ihpc-sched mutate --set-slots 4   # dry-run：把本队列 slots/GPU 改为 4
ihpc-sched mutate --add-node mars29 --execute
                                  # 调度器运行中安全追加节点；下一轮 poll 热加载
ihpc-sched mutate --replace-node mars12:mars29
ihpc-sched migrate-state          # dry-run：采用当前 queue hash，修复安全迁移
ihpc-sched tmux start             # 使用合法、稳定、queue-scoped 的默认 tmux session 名
ihpc-sched tmux status
ihpc-sched retry <job-id>         # dry-run：预览重新提交失败实验
ihpc-sched retry <job-id> --execute
ihpc-sched kill <job-id>          # dry-run：预览终止运行实验
ihpc-sched kill <job-id> --execute
ihpc-sched logs <job-id>          # 查看实验日志（最后 40 行）
```

`retry` 和 `kill` 只接受当前 queue-scoped state 内的精确 job id 或实验名，不支持 pattern
匹配。危险操作默认 dry-run，必须显式 `--execute` 才会写 state 或发送信号。

`report` 和默认 `doctor` 只读本地 JSON state / tmux 信息，不 SSH compute node。
`doctor --probe-nodes` 也只通过配置的 head node 执行 `cnode`，并且只检查当前 queue `my_nodes`，不会扫描或占用任意空闲节点。

调度器把 queue 身份拆成两层：`experiment_hash` 只描述实验清单和命令，`placement_hash`
只描述节点、GPU allow/block、slots/GPU 和调度阈值。运行中的 scheduler 允许安全扩容
placement（追加节点、提高 slots/GPU），但会拒绝修改实验清单、移除正在运行的节点/GPU
或降低 slots/GPU。这样可以在实验期间把新空闲节点加入当前队列，而不需要停止已有任务。

### queue.yaml 格式

```yaml
# 当前有 NoMachine 会话的节点（GPU 数量从 hardware.yaml 自动读取）
my_nodes:
  - turing2
  - hostname: turing1
    gpus: [1]        # 只允许用 GPU 1，保护 GPU 0/2 上已有 HPO
  - hostname: mars29
    block_gpus: [0]  # 也可排除指定 GPU

scheduler:
  slots_per_gpu: 4
  gpu_free_threshold_pct: 40
  respect_external_gpu_processes: true

experiments:
  - name: "bert-lr1e-4"
    command: "conda activate nlp && cd ~/Data/Workspace/proj && python train.py --lr 1e-4"
    requires_gpu: true

  - name: "preprocess"
    command: "conda activate base && python preprocess.py"
    requires_gpu: false
```

## 配置文件结构

```text
configs/
├── config.example.yaml   账号、SSH、评分、调度器全局设置模板
├── config.yaml           实际配置（gitignored）
├── hardware.yaml         各集群 GPU 数量（静态，长期不变）
├── queue.example.yaml    实验队列模板
└── queue.yaml            实际队列（gitignored）
```

`config.yaml` 包含四个 section：

```yaml
accounts:    # SSH 账号
scanner:     # SSH 超时、缓存时间
scoring:     # 权重预设（gpu / cpu / balanced）
scheduler:   # 邮件通知、GPU 阈值、轮询间隔
```

## 运行期调整与结果索引

- `ihpc-sched mutate --add-node NODE --execute`：在 scheduler 正在运行时追加节点。命令只原子写
  `queue.yaml`；运行中的 scheduler 会在下一轮 poll 检测到 placement 变化并热加载。
- `ihpc-sched mutate --set-slots N --execute`：scheduler 正在运行时只允许提高 slots/GPU；
  降低 slots/GPU 必须先停掉 scheduler 并确认不会影响已有任务。
- `ihpc-sched report`：跨 queue state 汇总 pending/running/done/failed、remaining、
  heartbeat、tmux 和阻塞原因，用来判断是否还有实验排队。
- `ihpc-sched artifacts --status done --output PATH`：从 state 文件生成 JSON 产物索引，
  包含 job id、实验名、节点、GPU、日志路径、wrapper、退出码、experiment/placement hash。
  这用于后续把结果从远端拉回本地，而不需要手工翻多个 state 文件。

调度器分配节点时使用 deterministic least-loaded policy：优先选择当前 tracked running job
占比更低的节点，避免所有新任务按配置顺序压到同一台机器上等待。

## 项目结构

```text
uts-ihpc/
├── configs/              配置文件（credentials 已 gitignore）
├── outputs/
│   ├── logs/             实验 stdout/stderr 日志（gitignored）
│   └── scheduler_state/  queue-scoped 调度器状态（gitignored）
├── docs/
│   ├── intro/            iHPC 平台使用文档
│   └── design/           设计方案文档
└── src/
    ├── scanner/          节点扫描器
    └── scheduler/        实验调度器
```

## 关键限制

- **严禁**批量 SSH 到所有计算节点（违反 iHPC 政策，可能导致封号）
- Scanner 只需 1 次 SSH（头节点）；Scheduler 只 SSH 到自己的会话节点

## 平台信息

- **门户**：`https://ihpc.research.uts.edu.au`（需校内网络或 VPN）
- **头节点**：`access.ihpc.uts.edu.au`
- **规模**：6 个集群 / 121+ 节点 / 3336 CPU 核心 / 32.93 TB 内存
