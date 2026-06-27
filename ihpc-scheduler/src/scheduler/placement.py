"""Placement domain objects for scheduler decisions."""

from __future__ import annotations

from dataclasses import dataclass

from ..scanner.infra.ssh import SSHClient, SSHPool
from .config import Experiment, NodeConfig, SchedulerConfig
from .state import RunningJob, SchedulerState

CPU_SLOTS_PER_NODE = 4


def usable_gpu_count(node: NodeConfig) -> int:
    if node.allowed_gpus is not None:
        return len(node.allowed_gpus)
    if node.blocked_gpus is not None:
        return max(0, node.gpu_count - len(node.blocked_gpus))
    return node.gpu_count


@dataclass
class RunningPlacementIssue:
    """A running job that would no longer fit a queue placement policy."""

    reason: str
    exp_name: str
    hostname: str
    gpu_index: int | None = None
    old_slots: int | None = None
    new_slots: int | None = None

    def hot_reload_message(self) -> str:
        if self.reason == "missing_host":
            return f"Refusing hot reload that removes running host {self.hostname}."
        if self.reason == "missing_previous_host":
            return f"Running host missing from old config: {self.hostname}."
        if self.reason == "decreased_slots":
            return (
                "Refusing hot reload that decreases slots_per_gpu for running "
                f"GPU job {self.exp_name} on {self.hostname}: {self.old_slots} -> {self.new_slots}."
            )
        if self.reason == "excluded_gpu":
            return (
                "Refusing hot reload that excludes running GPU "
                f"{self.hostname}:{self.gpu_index}."
            )
        if self.reason == "blocked_gpu":
            return f"Refusing hot reload that blocks running GPU {self.hostname}:{self.gpu_index}."
        return f"Running job {self.exp_name} does not fit current placement policy."

    def mutation_message(self) -> str:
        if self.reason == "missing_host":
            return f"Mutation would exclude running host {self.hostname}"
        if self.reason == "excluded_gpu":
            return f"Mutation would exclude running job GPU {self.hostname}:{self.gpu_index}"
        if self.reason == "blocked_gpu":
            return f"Mutation would block running job GPU {self.hostname}:{self.gpu_index}"
        if self.reason == "decreased_slots":
            return (
                "Mutation would decrease slots_per_gpu for running "
                f"GPU job {self.exp_name} on {self.hostname}: {self.old_slots} -> {self.new_slots}"
            )
        return f"Mutation would make running job {self.exp_name} not fit placement policy"


def running_placement_issues(
    current: SchedulerConfig,
    state: SchedulerState,
    previous: SchedulerConfig | None = None,
    *,
    check_slots: bool = False,
) -> list[RunningPlacementIssue]:
    issues: list[RunningPlacementIssue] = []
    for job in state.running:
        node = current.node(job.hostname)
        if node is None:
            issues.append(RunningPlacementIssue(
                reason="missing_host",
                exp_name=job.exp_name,
                hostname=job.hostname,
                gpu_index=job.gpu_index,
            ))
            continue
        if job.gpu_index is None:
            continue

        if check_slots:
            old_slots = (
                previous.slots_on(job.hostname)
                if previous is not None
                else job.slots_per_gpu
            )
            if old_slots is None:
                issues.append(RunningPlacementIssue(
                    reason="missing_previous_host",
                    exp_name=job.exp_name,
                    hostname=job.hostname,
                    gpu_index=job.gpu_index,
                ))
            else:
                if job.slots_per_gpu is not None:
                    old_slots = max(old_slots, job.slots_per_gpu)
                new_slots = current.slots(node)
                if new_slots < old_slots:
                    issues.append(RunningPlacementIssue(
                        reason="decreased_slots",
                        exp_name=job.exp_name,
                        hostname=job.hostname,
                        gpu_index=job.gpu_index,
                        old_slots=old_slots,
                        new_slots=new_slots,
                    ))

        if node.allowed_gpus is not None and job.gpu_index not in node.allowed_gpus:
            issues.append(RunningPlacementIssue(
                reason="excluded_gpu",
                exp_name=job.exp_name,
                hostname=job.hostname,
                gpu_index=job.gpu_index,
            ))
        if node.blocked_gpus is not None and job.gpu_index in node.blocked_gpus:
            issues.append(RunningPlacementIssue(
                reason="blocked_gpu",
                exp_name=job.exp_name,
                hostname=job.hostname,
                gpu_index=job.gpu_index,
            ))
    return issues


@dataclass
class NodeSlots:
    """Runtime placement view for one node under the current queue policy."""

    config: SchedulerConfig
    node: NodeConfig
    running_jobs: list[RunningJob]
    gpu_counts: dict[int, int]

    @classmethod
    def from_state(
        cls,
        config: SchedulerConfig,
        node: NodeConfig,
        state: SchedulerState,
        virtual_gpu_counts: dict[str, dict[int, int]] | None = None,
    ) -> NodeSlots:
        gpu_counts = (
            dict(virtual_gpu_counts.get(node.hostname, {}))
            if virtual_gpu_counts is not None
            else state.gpu_job_counts(node.hostname)
        )
        return cls(
            config=config,
            node=node,
            running_jobs=state.running_on(node.hostname),
            gpu_counts=gpu_counts,
        )

    @classmethod
    def empty(cls, config: SchedulerConfig, node: NodeConfig) -> NodeSlots:
        return cls(config=config, node=node, running_jobs=[], gpu_counts={})

    @property
    def slots_per_gpu(self) -> int:
        return self.config.slots(self.node)

    @property
    def usable_gpu_count(self) -> int:
        return usable_gpu_count(self.node)

    @property
    def gpu_capacity(self) -> int:
        return self.usable_gpu_count * self.slots_per_gpu

    @property
    def total_gpu_jobs(self) -> int:
        return sum(self.gpu_counts.values())

    @property
    def cpu_job_count(self) -> int:
        return sum(1 for job in self.running_jobs if job.gpu_index is None)

    @property
    def has_cpu_slot(self) -> bool:
        return self.cpu_job_count < CPU_SLOTS_PER_NODE

    @property
    def gpu_capacity_full(self) -> bool:
        return self.total_gpu_jobs >= self.gpu_capacity

    @property
    def node_capacity(self) -> int:
        return max(1, self.gpu_capacity)

    @property
    def load_ratio(self) -> float:
        return len(self.running_jobs) / self.node_capacity

    def node_sort_key(self) -> tuple[float, int, str]:
        return (self.load_ratio, len(self.running_jobs), self.node.hostname)

    def gpu_probe_kwargs(self) -> dict[str, object]:
        return {
            "gpu_job_counts": self.gpu_counts,
            "threshold_pct": self.config.gpu_free_threshold_pct,
            "slots_per_gpu": self.slots_per_gpu,
            "allowed_gpus": set(self.node.allowed_gpus) if self.node.allowed_gpus is not None else None,
            "blocked_gpus": set(self.node.blocked_gpus) if self.node.blocked_gpus is not None else None,
            "min_free_mem_mb": self.config.min_free_mem_mb,
            "respect_external_processes": self.config.respect_external_gpu_processes,
        }

    def policy_snapshot(self) -> dict[str, object]:
        return {
            "node": self.node.snapshot(),
            "slots_per_gpu": self.slots_per_gpu,
            "gpu_free_threshold_pct": self.config.gpu_free_threshold_pct,
            "min_free_mem_mb": self.config.min_free_mem_mb,
            "respect_external_gpu_processes": self.config.respect_external_gpu_processes,
        }

    def blocked_reason(
        self,
        exp: Experiment,
        *,
        skipped_after_submission_failure: bool = False,
    ) -> dict[str, object]:
        if skipped_after_submission_failure:
            return {"hostname": self.node.hostname, "reason": "skipped after submission failure"}

        if not exp.requires_gpu:
            return {
                "hostname": self.node.hostname,
                "reason": (
                    "cpu slots full"
                    if not self.has_cpu_slot
                    else "connectivity or submission unavailable"
                ),
                "cpu_jobs": self.cpu_job_count,
                "cpu_capacity": CPU_SLOTS_PER_NODE,
            }

        reason = "tracked GPU slots full" if self.gpu_capacity_full else "no usable GPU matched policy"
        return {
            "hostname": self.node.hostname,
            "reason": reason,
            "gpu_counts": self.gpu_counts,
            "gpu_capacity": self.gpu_capacity,
            "slots_per_gpu": self.slots_per_gpu,
        }


@dataclass
class SlotCandidate:
    """A usable GPU slot plus the open connection used to probe it."""

    node: NodeConfig
    gpu_index: int
    pool: SSHPool
    client: SSHClient
    tracked_jobs: int
    free_pct: float
    load_ratio: float

    @classmethod
    def from_gpu_row(
        cls,
        slots: NodeSlots,
        row: dict[str, object],
        pool: SSHPool,
        client: SSHClient,
    ) -> SlotCandidate:
        return cls(
            node=slots.node,
            gpu_index=int(row["gpu"]),
            pool=pool,
            client=client,
            tracked_jobs=int(row["tracked_jobs"]),
            free_pct=float(row["free_pct"]),
            load_ratio=slots.load_ratio,
        )

    def sort_key(self) -> tuple[int, float, float, str, int]:
        return (
            self.tracked_jobs,
            -self.free_pct,
            self.load_ratio,
            self.node.hostname,
            self.gpu_index,
        )
