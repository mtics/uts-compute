"""Scheduler state persistence.

State is stored as JSON at ``state_path`` (configured in queue.yaml).
It survives scheduler restarts and is the source of truth for:
  - which experiments are pending / running / done / failed
  - which GPU index each running job was assigned
  - PID of each running job (for liveness checks)
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import time
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

STATE_VERSION = 2


class ExpStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


@dataclass
class RunningJob:
    """Metadata for a currently running experiment."""

    exp_name: str
    hostname: str
    pid: int
    gpu_index: int | None       # None for CPU-only experiments
    log_path: str               # absolute path on the remote node
    started_at: float           # Unix timestamp
    job_id: str | None = None
    command_hash: str | None = None
    queue_id: str | None = None
    slots_per_gpu: int | None = None
    wrapper_path: str | None = None
    placement_hash: str | None = None
    policy_snapshot: dict[str, Any] | None = None

    def matches(self, token: str) -> bool:
        return self.exp_name == token or self.job_id == token


@dataclass
class FinishedJob:
    """Metadata for a completed (done or failed) experiment."""

    exp_name: str
    hostname: str
    gpu_index: int | None
    log_path: str
    started_at: float
    finished_at: float
    exit_code: int              # 0 = success, non-zero = failure
    job_id: str | None = None
    command_hash: str | None = None
    queue_id: str | None = None
    slots_per_gpu: int | None = None
    wrapper_path: str | None = None
    placement_hash: str | None = None
    policy_snapshot: dict[str, Any] | None = None

    def matches(self, token: str) -> bool:
        return self.exp_name == token or self.job_id == token

    @classmethod
    def from_running(
        cls,
        job: RunningJob,
        exit_code: int,
        finished_at: float | None = None,
    ) -> FinishedJob:
        return cls(
            exp_name=job.exp_name,
            hostname=job.hostname,
            gpu_index=job.gpu_index,
            log_path=job.log_path,
            started_at=job.started_at,
            finished_at=time.time() if finished_at is None else finished_at,
            exit_code=exit_code,
            job_id=job.job_id,
            command_hash=job.command_hash,
            queue_id=job.queue_id,
            slots_per_gpu=job.slots_per_gpu,
            wrapper_path=job.wrapper_path,
            placement_hash=job.placement_hash,
            policy_snapshot=job.policy_snapshot,
        )


@dataclass
class SchedulerState:
    """Full scheduler state, serialisable to/from JSON."""

    version: int = STATE_VERSION
    queue_id: str | None = None
    queue_hash: str | None = None
    experiment_hash: str | None = None
    placement_hash: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    is_legacy: bool = False

    pending: list[str] = field(default_factory=list)        # exp names, FIFO order
    running: list[RunningJob] = field(default_factory=list)
    done: list[FinishedJob] = field(default_factory=list)
    failed: list[FinishedJob] = field(default_factory=list)

    last_blocked_notify: float = 0.0
    blocked_notify_count: int = 0
    heartbeat_at: float = 0.0
    scheduler_pid: int | None = None
    scheduler_host: str | None = None
    queue_path: str | None = None
    launch_command: str | None = None
    tmux_session: str | None = None
    node_policy_snapshot: list[dict[str, Any]] = field(default_factory=list)
    scheduler_settings_snapshot: dict[str, Any] = field(default_factory=dict)

    # ---------------------------------------------------------------------------
    # Queries
    # ---------------------------------------------------------------------------

    def running_on(self, hostname: str) -> list[RunningJob]:
        return [j for j in self.running if j.hostname == hostname]

    def gpu_in_use(self, hostname: str) -> set[int]:
        """Return set of GPU indices currently occupied on a node."""
        return {j.gpu_index for j in self.running_on(hostname) if j.gpu_index is not None}

    def gpu_job_counts(self, hostname: str) -> dict[int, int]:
        """Return {gpu_index: running_job_count} for a node."""
        counts: dict[int, int] = {}
        for j in self.running_on(hostname):
            if j.gpu_index is not None:
                counts[j.gpu_index] = counts.get(j.gpu_index, 0) + 1
        return counts

    def is_pending(self, exp_name: str) -> bool:
        return exp_name in self.pending

    def find_running(self, exp_name: str) -> RunningJob | None:
        for j in self.running:
            if j.matches(exp_name):
                return j
        return None

    def all_tracked_names(self) -> set[str]:
        """Return all experiment names represented in the state."""
        return (
            set(self.pending)
            | {j.exp_name for j in self.running}
            | {j.exp_name for j in self.done}
            | {j.exp_name for j in self.failed}
        )

    # ---------------------------------------------------------------------------
    # Transitions
    # ---------------------------------------------------------------------------

    def mark_running(self, job: RunningJob) -> None:
        if job.exp_name in self.pending:
            self.pending.remove(job.exp_name)
        self.running.append(job)

    def mark_done(self, exp_name: str, exit_code: int, finished_at: float | None = None) -> bool:
        job = self.find_running(exp_name)
        if job is None:
            return False
        self.running.remove(job)
        self.done.append(FinishedJob.from_running(job, exit_code, finished_at))
        return True

    def mark_failed(self, exp_name: str, exit_code: int = -1, finished_at: float | None = None) -> bool:
        job = self.find_running(exp_name)
        if job is None:
            return False
        self.running.remove(job)
        self.failed.append(FinishedJob.from_running(job, exit_code, finished_at))
        return True

    def requeue(self, exp_name: str) -> bool:
        """Move a failed experiment back to the front of the pending queue."""
        entry = next((j for j in self.failed if j.matches(exp_name)), None)
        if entry is None:
            return False
        self.failed.remove(entry)
        self.pending.insert(0, entry.exp_name)
        return True

    # ---------------------------------------------------------------------------
    # Persistence
    # ---------------------------------------------------------------------------

    def save(self, path: Path | None) -> None:
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        self.version = STATE_VERSION
        if self.created_at <= 0:
            self.created_at = time.time()
        self.updated_at = time.time()
        data = {
            "version": self.version,
            "queue_id": self.queue_id,
            "queue_hash": self.queue_hash,
            "experiment_hash": self.experiment_hash,
            "placement_hash": self.placement_hash,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "pending": self.pending,
            "running": [asdict(j) for j in self.running],
            "done": [asdict(j) for j in self.done],
            "failed": [asdict(j) for j in self.failed],
            "last_blocked_notify": self.last_blocked_notify,
            "blocked_notify_count": self.blocked_notify_count,
            "heartbeat_at": self.heartbeat_at,
            "scheduler_pid": self.scheduler_pid,
            "scheduler_host": self.scheduler_host,
            "queue_path": self.queue_path,
            "launch_command": self.launch_command,
            "tmux_session": self.tmux_session,
            "node_policy_snapshot": self.node_policy_snapshot,
            "scheduler_settings_snapshot": self.scheduler_settings_snapshot,
        }
        backup_path = path.with_name(f"{path.name}.bak")
        temp_path = path.with_name(f".{path.name}.tmp")
        if path.exists():
            shutil.copy2(path, backup_path)
        temp_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        temp_path.replace(path)

    @classmethod
    def load(cls, path: Path | None) -> SchedulerState:
        if path is None or not path.is_file():
            return cls()
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        is_legacy = "version" not in data
        return cls(
            version=int(data.get("version", 0)),
            queue_id=data.get("queue_id"),
            queue_hash=data.get("queue_hash"),
            experiment_hash=data.get("experiment_hash"),
            placement_hash=data.get("placement_hash"),
            created_at=float(data.get("created_at", 0.0)),
            updated_at=float(data.get("updated_at", 0.0)),
            is_legacy=is_legacy,
            pending=data.get("pending", []),
            running=[RunningJob(**j) for j in data.get("running", [])],
            done=[FinishedJob(**j) for j in data.get("done", [])],
            failed=[FinishedJob(**j) for j in data.get("failed", [])],
            last_blocked_notify=float(data.get("last_blocked_notify", 0.0)),
            blocked_notify_count=int(data.get("blocked_notify_count", 0)),
            heartbeat_at=float(data.get("heartbeat_at", 0.0)),
            scheduler_pid=data.get("scheduler_pid"),
            scheduler_host=data.get("scheduler_host"),
            queue_path=data.get("queue_path"),
            launch_command=data.get("launch_command"),
            tmux_session=data.get("tmux_session"),
            node_policy_snapshot=data.get("node_policy_snapshot", []),
            scheduler_settings_snapshot=data.get("scheduler_settings_snapshot", {}),
        )

    @classmethod
    def initialise(
        cls,
        experiment_names: list[str],
        existing_path: Path,
        queue_id: str | None = None,
        queue_hash: str | None = None,
        experiment_hash: str | None = None,
        placement_hash: str | None = None,
        allow_legacy: bool = False,
    ) -> SchedulerState:
        """Load existing state and add any new experiments not yet tracked."""
        state = cls.load(existing_path)
        if existing_path.is_file() and state.is_legacy and not allow_legacy:
            raise ValueError(
                "Legacy scheduler state has no queue identity. "
                "Use status/doctor to inspect it, then create a fresh queue-scoped state."
            )
        if existing_path.is_file() and not state.is_legacy:
            if state.experiment_hash is not None and experiment_hash is not None:
                if experiment_hash != state.experiment_hash:
                    raise ValueError(
                        "State experiment_hash mismatch: "
                        f"existing={state.experiment_hash!r}, current={experiment_hash!r}"
                    )
            elif queue_hash is not None and queue_hash != state.queue_hash:
                raise ValueError(
                    f"State queue_hash mismatch: existing={state.queue_hash!r}, current={queue_hash!r}"
                )
        state.queue_id = queue_id
        state.queue_hash = queue_hash
        state.experiment_hash = experiment_hash
        state.placement_hash = placement_hash
        tracked = (
            set(state.pending)
            | {j.exp_name for j in state.running}
            | {j.exp_name for j in state.done}
            | {j.exp_name for j in state.failed}
        )
        for name in experiment_names:
            if name not in tracked:
                state.pending.append(name)
        return state

    def refresh_heartbeat(self) -> None:
        self.heartbeat_at = time.time()
        self.scheduler_pid = os.getpid()
        self.scheduler_host = socket.gethostname()

    def set_provenance(
        self,
        *,
        queue_path: str | None,
        launch_command: str | None,
        tmux_session: str | None,
        node_policy_snapshot: list[dict[str, Any]],
        scheduler_settings_snapshot: dict[str, Any],
        experiment_hash: str | None = None,
        placement_hash: str | None = None,
    ) -> None:
        self.queue_path = queue_path
        self.launch_command = launch_command
        self.tmux_session = tmux_session
        self.node_policy_snapshot = node_policy_snapshot
        self.scheduler_settings_snapshot = scheduler_settings_snapshot
        if experiment_hash is not None:
            self.experiment_hash = experiment_hash
        if placement_hash is not None:
            self.placement_hash = placement_hash
