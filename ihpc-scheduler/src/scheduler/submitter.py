"""Job submission to the user's own active compute nodes.

IMPORTANT: Only call these functions on nodes where the user already has
an active NoMachine session.  Never call in a loop over arbitrary nodes.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

from ..scanner.infra.ssh import SSHClient, SSHPool
from .config import Experiment, SchedulerConfig
from .remote_command import (
    SubmissionResult,
    build_submission_command,
    build_wrapper_script,
    make_exitcode_path,
    make_wrapper_path,
)

logger = logging.getLogger(__name__)


@dataclass
class _GpuSlot:
    gpu: int | None
    usable: bool
    reason: str
    tracked_jobs: int = 0
    slots_per_gpu: int = 1
    free_mem_mb: float = 0.0
    free_pct: float = 0.0

    def explain(self) -> dict[str, object]:
        if self.gpu is None:
            return {"gpu": None, "usable": self.usable, "reason": self.reason}
        return {
            "gpu": self.gpu,
            "usable": self.usable,
            "tracked_jobs": self.tracked_jobs,
            "slots_per_gpu": self.slots_per_gpu,
            "free_mem_mb": round(self.free_mem_mb, 1),
            "free_pct": round(self.free_pct, 1),
            "reason": self.reason,
        }


def find_free_gpu(
    client: SSHClient,
    gpu_job_counts: dict[int, int],
    threshold_pct: float,
    slots_per_gpu: int = 1,
    allowed_gpus: set[int] | None = None,
    blocked_gpus: set[int] | None = None,
    min_free_mem_mb: int | None = None,
    respect_external_processes: bool = True,
) -> int | None:
    """Return the best usable GPU, preferring fewer tracked jobs then freer memory.

    Args:
        client: SSH connection to the compute node.
        gpu_job_counts: {gpu_index: current_job_count} from scheduler state.
        threshold_pct: Minimum required free memory percentage (0–100).
        slots_per_gpu: Max concurrent jobs allowed per GPU.
        allowed_gpus: Optional set of GPU indices this node may use.
        blocked_gpus: Optional set of GPU indices this node must not use.
        min_free_mem_mb: Optional absolute free-memory floor.
        respect_external_processes: Treat a GPU with external compute
            processes as busy until this scheduler already has a tracked job
            on it. This protects manually started HPO jobs.

    Returns:
        GPU index to use, or None if no suitable GPU is available.
    """
    slots = _probe_gpu_slots(
        client,
        gpu_job_counts=gpu_job_counts,
        threshold_pct=threshold_pct,
        slots_per_gpu=slots_per_gpu,
        allowed_gpus=allowed_gpus,
        blocked_gpus=blocked_gpus,
        min_free_mem_mb=min_free_mem_mb,
        respect_external_processes=respect_external_processes,
    )
    usable_slots = [slot for slot in slots if slot.usable and slot.gpu is not None]
    usable_slots.sort(key=lambda slot: (slot.tracked_jobs, -slot.free_pct))
    best = usable_slots[0] if usable_slots else None

    if best is None:
        logger.warning(
            "No free GPU on %s (threshold=%.0f%%, min_free_mem_mb=%s, "
            "job_counts=%s, allowed_gpus=%s, blocked_gpus=%s)",
            client.hostname, threshold_pct, min_free_mem_mb, gpu_job_counts,
            sorted(allowed_gpus) if allowed_gpus is not None else None,
            sorted(blocked_gpus) if blocked_gpus is not None else None,
        )
    else:
        logger.info(
            "Selected GPU %d on %s (%.0f%% memory free)",
            best.gpu, client.hostname, best.free_pct,
        )
    return best.gpu if best is not None else None


def explain_gpu_slots(
    client: SSHClient,
    gpu_job_counts: dict[int, int],
    threshold_pct: float,
    slots_per_gpu: int = 1,
    allowed_gpus: set[int] | None = None,
    blocked_gpus: set[int] | None = None,
    min_free_mem_mb: int | None = None,
    respect_external_processes: bool = True,
) -> list[dict[str, object]]:
    """Return per-GPU placement diagnostics using the same policy as scheduling."""
    return [
        slot.explain()
        for slot in _probe_gpu_slots(
            client,
            gpu_job_counts=gpu_job_counts,
            threshold_pct=threshold_pct,
            slots_per_gpu=slots_per_gpu,
            allowed_gpus=allowed_gpus,
            blocked_gpus=blocked_gpus,
            min_free_mem_mb=min_free_mem_mb,
            respect_external_processes=respect_external_processes,
        )
    ]


def _probe_gpu_slots(
    client: SSHClient,
    gpu_job_counts: dict[int, int],
    threshold_pct: float,
    slots_per_gpu: int = 1,
    allowed_gpus: set[int] | None = None,
    blocked_gpus: set[int] | None = None,
    min_free_mem_mb: int | None = None,
    respect_external_processes: bool = True,
) -> list[_GpuSlot]:
    raw = client.exec_command(
        "nvidia-smi --query-gpu=index,pci.bus_id,memory.used,memory.total "
        "--format=csv,noheader,nounits 2>/dev/null || echo NO_GPU"
    )
    if "NO_GPU" in raw or not raw.strip():
        return [_GpuSlot(gpu=None, usable=False, reason="no GPU reported by nvidia-smi")]

    external_by_bus_id: set[str] = set()
    if respect_external_processes:
        apps_raw = client.exec_command(
            "nvidia-smi --query-compute-apps=gpu_bus_id,pid,process_name,used_memory "
            "--format=csv,noheader,nounits 2>/dev/null || true"
        )
        external_by_bus_id = _parse_compute_app_bus_ids(apps_raw)

    slots: list[_GpuSlot] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        parsed = _parse_gpu_row(parts)
        if parsed is None:
            slots.append(_GpuSlot(
                gpu=None,
                usable=False,
                reason=f"unparseable nvidia-smi row: {line}",
            ))
            continue

        idx, bus_id, mem_used, mem_total = parsed
        reasons: list[str] = []
        tracked_jobs = gpu_job_counts.get(idx, 0)
        free_mem_mb = mem_total - mem_used
        free_pct = (1.0 - mem_used / mem_total) * 100.0 if mem_total else 0.0

        if mem_total <= 0:
            reasons.append("invalid memory total")
        if allowed_gpus is not None and idx not in allowed_gpus:
            reasons.append("not in allowed GPU list")
        if blocked_gpus is not None and idx in blocked_gpus:
            reasons.append("blocked by queue policy")
        if tracked_jobs >= slots_per_gpu:
            reasons.append(f"tracked slots full ({tracked_jobs}/{slots_per_gpu})")
        if min_free_mem_mb is not None and free_mem_mb < min_free_mem_mb:
            reasons.append(f"free memory below floor ({free_mem_mb:.0f} < {min_free_mem_mb} MiB)")
        if free_pct < threshold_pct:
            reasons.append(f"free memory below threshold ({free_pct:.0f}% < {threshold_pct:.0f}%)")
        if (
            respect_external_processes
            and bus_id is not None
            and bus_id in external_by_bus_id
            and tracked_jobs == 0
        ):
            reasons.append("external compute process present")

        slots.append(_GpuSlot(
            gpu=idx,
            usable=not reasons,
            tracked_jobs=tracked_jobs,
            slots_per_gpu=slots_per_gpu,
            free_mem_mb=free_mem_mb,
            free_pct=free_pct,
            reason="; ".join(reasons) if reasons else "usable",
        ))
    return slots


def _parse_gpu_row(parts: list[str]) -> tuple[int, str | None, float, float] | None:
    """Parse either new 4-column or legacy 3-column nvidia-smi GPU rows."""
    if len(parts) < 3:
        return None
    try:
        idx = int(parts[0])
        if len(parts) >= 4:
            bus_id = parts[1]
            mem_used = float(parts[2])
            mem_total = float(parts[3])
        else:
            bus_id = None
            mem_used = float(parts[1])
            mem_total = float(parts[2])
    except ValueError:
        return None
    return idx, bus_id, mem_used, mem_total


def _parse_compute_app_bus_ids(raw: str) -> set[str]:
    bus_ids: set[str] = set()
    for line in raw.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) >= 2 and parts[0] and parts[0] != "[Not Supported]":
            bus_ids.add(parts[0])
    return bus_ids


def submit_job(
    client: SSHClient,
    experiment: Experiment,
    gpu_index: int | None,
    log_path: str,
    *,
    return_result: bool = False,
) -> int | SubmissionResult:
    """Submit an experiment via nohup on a remote node and return its PID.

    The command is wrapped so that the exit code is written to
    ``<log_path>.exitcode`` when the process finishes.  The monitor uses this
    file to determine success vs failure after the PID disappears.

    Args:
        client: SSH connection to the target compute node.
        experiment: The experiment to run.
        gpu_index: GPU to assign via CUDA_VISIBLE_DEVICES, or None.
        log_path: Absolute path on the remote node for stdout/stderr output.
        return_result: Return PID plus wrapper path metadata when True.

    Returns:
        PID of the background process, or submission metadata when requested.
    """
    exitcode_path = make_exitcode_path(log_path)
    wrapper_path = make_wrapper_path(log_path)
    wrapper_script = build_wrapper_script(
        experiment.command,
        gpu_index,
        exitcode_path,
    )
    remote_cmd = build_submission_command(wrapper_script, wrapper_path, log_path)

    pid_str = client.exec_command(remote_cmd, read_line=True)
    pid = int(pid_str.strip())
    logger.info(
        "Submitted '%s' on %s GPU=%s PID=%d log=%s wrapper=%s",
        experiment.name, client.hostname, gpu_index, pid, log_path, wrapper_path,
    )
    if return_result:
        return SubmissionResult(pid=pid, wrapper_path=wrapper_path)
    return pid


def connect_node(config: SchedulerConfig, hostname: str) -> tuple[SSHPool, SSHClient]:
    """Open an SSHPool (head → compute node) connection.

    Returns both the pool (to keep the head connection alive) and the
    compute node client.  Caller is responsible for closing the pool.
    """
    if hostname not in config.hosts():
        raise ValueError(f"Refusing to connect to non-queue node: {hostname}")
    pool = SSHPool(
        config.account,
        head_node=config.head_node,
        ssh_timeout=config.ssh_timeout,
        command_timeout=config.command_timeout,
    )
    pool.connect_head()
    client = pool.connect_node(hostname)
    return pool, client


def make_log_path(log_dir: Path, exp_name: str) -> str:
    """Build the remote log file path for an experiment.

    Uses a timestamp suffix so re-runs don't overwrite previous logs.
    """
    ts = time.strftime("%Y%m%d_%H%M%S")
    filename = f"{exp_name}_{ts}.log"
    return str(log_dir / filename)
