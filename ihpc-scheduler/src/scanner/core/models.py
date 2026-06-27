"""Data models for node availability scanning."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


# ---------------------------------------------------------------------------
# Scanner models — based on ``cnode avail`` output (no per-node SSH required)
# ---------------------------------------------------------------------------

@dataclass
class CnodeNodeInfo:
    """Node info parsed from ``cnode avail`` on the head node.

    All values come from iHPC's head-node load balancer.  No SSH connection
    to the compute node is needed.

    Percentage fields:
      - cpu_pct / mem_pct / gpu_pct / gpu_mem_pct  →  utilisation (0–100)
      - free variants are computed as 100 - utilisation
    """

    hostname: str
    cluster: str
    load_index: int        # 0 = low, 1 = medium, 2 = high
    connectable: bool      # True when Connect column is "yes"
    cpu_pct: float         # %CPU utilisation
    mem_pct: float         # %Mem used
    gpu_pct: float         # %GPU average utilisation across all GPUs
    gpu_mem_pct: float     # %GPU memory used
    users: list[str] = field(default_factory=list)

    idle_score: float = -1.0  # filled in by scorer after construction

    # ── Derived properties ─────────────────────────────────────────────────

    @property
    def cpu_free_pct(self) -> float:
        return max(0.0, 100.0 - self.cpu_pct)

    @property
    def mem_free_pct(self) -> float:
        return max(0.0, 100.0 - self.mem_pct)

    @property
    def gpu_free_pct(self) -> float:
        return max(0.0, 100.0 - self.gpu_pct)

    @property
    def user_count(self) -> int:
        return len(self.users)

    @property
    def gpu_likely_idle(self) -> bool:
        """Average GPU utilisation is below 10 %."""
        return self.gpu_pct < 10.0

    @property
    def load_label(self) -> str:
        return {0: "idle", 1: "low", 2: "busy"}.get(self.load_index, "?")


@dataclass
class ScanResult:
    """Result of a full cluster scan (head-node only, no per-node SSH)."""

    nodes: list[CnodeNodeInfo] = field(default_factory=list)
    scan_timestamp: float = 0.0
    scan_duration_sec: float = 0.0
    account_name: str = ""

    def sorted_by_score(self, descending: bool = True) -> list[CnodeNodeInfo]:
        return sorted(self.nodes, key=lambda n: n.idle_score, reverse=descending)

    def filter(
        self,
        *,
        cluster: str | None = None,
        min_score: float | None = None,
        require_idle_gpu: bool = False,
    ) -> list[CnodeNodeInfo]:
        nodes = list(self.nodes)
        if cluster:
            nodes = [n for n in nodes if n.cluster.lower() == cluster.lower()]
        if min_score is not None:
            nodes = [n for n in nodes if n.idle_score >= min_score]
        if require_idle_gpu:
            nodes = [n for n in nodes if n.gpu_likely_idle]
        return sorted(nodes, key=lambda n: -n.idle_score)


# ---------------------------------------------------------------------------
# Scheduler-internal models — used when SSHing to the user's OWN active nodes
# ---------------------------------------------------------------------------

class NodeState(str, Enum):
    """SSH reachability of a node the user already has a session on."""

    REACHABLE = "reachable"
    UNREACHABLE = "unreachable"


class WeightPreset(str, Enum):
    """Predefined weight presets for idle score calculation."""

    GPU_HEAVY = "gpu"
    CPU_HEAVY = "cpu"
    BALANCED = "balanced"


@dataclass
class GPUInfo:
    """Per-GPU status collected via ``nvidia-smi`` on the user's own node."""

    index: int
    name: str
    utilization_pct: float
    memory_used_mib: float
    memory_total_mib: float

    @property
    def memory_free_pct(self) -> float:
        if self.memory_total_mib == 0:
            return 0.0
        return (1 - self.memory_used_mib / self.memory_total_mib) * 100

    @property
    def is_idle(self) -> bool:
        return self.utilization_pct < 5.0


@dataclass
class NodeMetrics:
    """Detailed metrics collected via SSH on a node the user owns a session on.

    Only used by the scheduler — never for cluster-wide scanning.
    """

    hostname: str
    state: NodeState = NodeState.UNREACHABLE

    cpu_load_1min: float = 0.0
    cpu_cores: int = 1
    mem_total_mib: float = 0.0
    mem_available_mib: float = 0.0
    gpus: list[GPUInfo] = field(default_factory=list)
    logged_in_users: int = 0

    cluster: str = ""
    error_message: str = ""

    @property
    def idle_gpu_count(self) -> int:
        return sum(1 for g in self.gpus if g.is_idle)
