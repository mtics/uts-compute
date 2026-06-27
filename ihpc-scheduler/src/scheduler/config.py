"""Scheduler configuration — loads queue.yaml and hardware.yaml."""

from __future__ import annotations

import re
import json
from dataclasses import dataclass, field
from hashlib import sha256
from pathlib import Path
from typing import Any

import yaml

from ..scanner.config import AccountConfig, ScannerConfig, find_config_file, load_config as load_scanner_config
from .summarizer import SummarizerConfig

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

_DEFAULT_QUEUE_PATHS = [
    Path("configs/queue.yaml"),
    Path("queue.yaml"),
    _PROJECT_ROOT / "configs" / "queue.yaml",
    _PROJECT_ROOT / "queue.yaml",
]

_DEFAULT_HARDWARE_PATHS = [
    Path("configs/hardware.yaml"),
    Path("hardware.yaml"),
    _PROJECT_ROOT / "configs" / "hardware.yaml",
    _PROJECT_ROOT / "hardware.yaml",
]


# ---------------------------------------------------------------------------
# Domain dataclasses
# ---------------------------------------------------------------------------

@dataclass
class Experiment:
    """A single experiment to be submitted."""

    name: str
    command: str
    requires_gpu: bool = True
    job_id: str = ""
    command_hash: str = ""


@dataclass
class NodeConfig:
    """A node the user has an active NoMachine session on."""

    hostname: str
    gpu_count: int  # resolved from hardware.yaml
    allowed_gpus: list[int] | None = None
    blocked_gpus: list[int] | None = None
    slots_per_gpu: int | None = None

    def snapshot(self) -> dict[str, object]:
        return {
            "hostname": self.hostname,
            "gpu_count": self.gpu_count,
            "allowed_gpus": list(self.allowed_gpus) if self.allowed_gpus is not None else None,
            "blocked_gpus": list(self.blocked_gpus) if self.blocked_gpus is not None else None,
            "slots_per_gpu": self.slots_per_gpu,
        }


@dataclass
class SchedulerConfig:
    """Full scheduler runtime configuration."""

    my_nodes: list[NodeConfig]
    experiments: list[Experiment]

    # SSH credentials (from scanner config.yaml)
    account: AccountConfig

    queue_id: str = ""
    queue_hash: str = ""
    experiment_hash: str = ""
    placement_hash: str = ""
    queue_path: Path | None = None
    hardware_path: Path | None = None
    scanner_config_path: Path | None = None

    gpu_free_threshold_pct: float = 40.0
    min_free_mem_mb: int | None = None
    respect_external_gpu_processes: bool = True
    slots_per_gpu: int = 1           # max concurrent experiments per GPU
    poll_interval_sec: int = 120
    notify_email: str | None = None          # e.g. "example-user@uts.edu.au"; None = no mail
    notify_blocked_after_min: int = 30       # send "queue blocked" mail after N idle minutes
    notify_max_interval_min: int = 1440      # max backoff cap for blocked notifications (default 24h)
    notify_progress_interval_min: int = 120  # send progress digest at most every N minutes

    state_path: Path = field(default_factory=lambda: (_PROJECT_ROOT / "outputs" / "scheduler_state.json"))
    log_dir: Path = field(default_factory=lambda: (_PROJECT_ROOT / "outputs" / "logs"))

    summarizer: SummarizerConfig = field(default_factory=SummarizerConfig)

    head_node: str = "access.ihpc.uts.edu.au"
    ssh_timeout: int = 10
    command_timeout: int = 15

    def hosts(self) -> set[str]:
        return {node.hostname for node in self.my_nodes}

    def node(self, hostname: str) -> NodeConfig | None:
        for node in self.my_nodes:
            if node.hostname == hostname:
                return node
        return None

    def experiment(self, token: str) -> Experiment | None:
        for exp in self.experiments:
            if exp.name == token or exp.job_id == token:
                return exp
        return None

    def experiments_by_name(self) -> dict[str, Experiment]:
        return {exp.name: exp for exp in self.experiments}

    def slots(self, node: NodeConfig | None) -> int:
        if node is not None and node.slots_per_gpu is not None:
            return node.slots_per_gpu
        return self.slots_per_gpu

    def slots_on(self, hostname: str) -> int | None:
        node = self.node(hostname)
        if node is None:
            return None
        return self.slots(node)

    def settings_snapshot(self) -> dict[str, Any]:
        return {
            "slots_per_gpu": self.slots_per_gpu,
            "gpu_free_threshold_pct": self.gpu_free_threshold_pct,
            "min_free_mem_mb": self.min_free_mem_mb,
            "respect_external_gpu_processes": self.respect_external_gpu_processes,
            "poll_interval_sec": self.poll_interval_sec,
        }

    def node_policy_snapshot(self) -> list[dict[str, object]]:
        return [node.snapshot() for node in self.my_nodes]


# ---------------------------------------------------------------------------
# Hardware resolution
# ---------------------------------------------------------------------------

def _load_hardware(path: str | Path | None = None) -> tuple[dict[str, int], dict[str, int]]:
    """Return a mapping of hostname → gpu_count from hardware.yaml."""
    hw_path = _resolve_path(path, _DEFAULT_HARDWARE_PATHS, "hardware.yaml")
    raw = yaml.safe_load(hw_path.read_text(encoding="utf-8"))

    cluster_defaults: dict[str, int] = {
        k: int(v) for k, v in raw.get("clusters", {}).items()
    }
    node_overrides: dict[str, int] = {
        k: int(v) for k, v in raw.get("node_overrides", {}).items()
    }
    return cluster_defaults, node_overrides


def resolve_hardware_path(path: str | Path | None = None) -> Path:
    """Resolve hardware.yaml using the same search rules as load_queue."""
    return _resolve_path(path, _DEFAULT_HARDWARE_PATHS, "hardware.yaml")


def resolve_gpu_count(hostname: str, cluster_defaults: dict[str, int], node_overrides: dict[str, int]) -> int:
    """Look up GPU count for a hostname using hardware config."""
    if hostname in node_overrides:
        return node_overrides[hostname]
    # Strip trailing digits to get cluster prefix (e.g. "turing2" → "turing")
    prefix = re.sub(r"\d+$", "", hostname.lower())
    return cluster_defaults.get(prefix, 0)


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

_PLACEMENT_HASH_SCHEDULER_KEYS = {
    "slots_per_gpu",
    "gpu_free_threshold_pct",
    "min_free_mem_mb",
    "respect_external_gpu_processes",
    "poll_interval_sec",
}


def _normalise_node_for_hash(entry: Any) -> dict[str, Any]:
    if isinstance(entry, str):
        return {"hostname": entry.strip()}
    if isinstance(entry, dict):
        node: dict[str, Any] = {"hostname": str(entry["hostname"]).strip()}
        if "gpus" in entry and entry["gpus"] is not None:
            node["gpus"] = sorted(int(gpu) for gpu in entry["gpus"])
        if "allow_gpus" in entry and entry["allow_gpus"] is not None:
            node["allow_gpus"] = sorted(int(gpu) for gpu in entry["allow_gpus"])
        if "block_gpus" in entry and entry["block_gpus"] is not None:
            node["block_gpus"] = sorted(int(gpu) for gpu in entry["block_gpus"])
        if "slots_per_gpu" in entry and entry["slots_per_gpu"] is not None:
            node["slots_per_gpu"] = int(entry["slots_per_gpu"])
        return node
    raise ValueError("Each my_nodes entry must be either a hostname string or a mapping")


def experiment_manifest_from_raw(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the immutable experiment manifest used for resume safety."""
    return [
        {
            "name": exp.get("name"),
            "command": exp.get("command"),
            "requires_gpu": exp.get("requires_gpu", True),
        }
        for exp in raw.get("experiments", [])
    ]


def placement_policy_from_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """Return the explicit placement policy that may change while scheduling."""
    queue_scheduler = raw.get("scheduler", {}) or {}
    return {
        "my_nodes": [_normalise_node_for_hash(entry) for entry in raw.get("my_nodes", [])],
        "scheduler": {
            key: queue_scheduler[key]
            for key in sorted(_PLACEMENT_HASH_SCHEDULER_KEYS)
            if key in queue_scheduler
        },
    }


def experiment_hash_from_raw(raw: dict[str, Any]) -> str:
    """Return a stable semantic hash for experiment identity only."""
    payload = {"experiments": experiment_manifest_from_raw(raw)}
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def placement_hash_from_raw(raw: dict[str, Any]) -> str:
    """Return a stable semantic hash for node and slot placement policy."""
    canonical = json.dumps(placement_policy_from_raw(raw), sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def queue_hash_from_raw(raw: dict[str, Any]) -> str:
    """Return a combined hash for display and legacy state checks."""
    payload = {
        "experiment_hash": experiment_hash_from_raw(raw),
        "placement_hash": placement_hash_from_raw(raw),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return sha256(canonical.encode("utf-8")).hexdigest()


def command_hash(command: str) -> str:
    """Return a stable hash for an experiment command."""
    return sha256(command.encode("utf-8")).hexdigest()


def experiment_job_id(queue_id: str, experiment_name: str) -> str:
    """Return the queue-scoped job id for an experiment name."""
    safe_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", experiment_name).strip("-")
    return f"{queue_id}:{safe_name or 'experiment'}"


def queue_identity(queue_path: Path, raw: dict[str, Any]) -> tuple[str, str]:
    """Return (queue_id, queue_hash) for state isolation and metadata."""
    q_hash = queue_hash_from_raw(raw)
    path_hash = sha256(queue_path.expanduser().resolve().as_posix().encode("utf-8")).hexdigest()
    safe_stem = re.sub(r"[^a-zA-Z0-9_.-]+", "-", queue_path.stem).strip("-")
    stem = safe_stem or "queue"
    return f"{stem}-{path_hash[:12]}", q_hash


def _parse_gpu_list(hostname: str, key: str, value: Any, gpu_count: int) -> list[int]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"queue.yaml node {hostname} field {key} must be a list")
    gpus = sorted(int(gpu) for gpu in value)
    invalid = [gpu for gpu in gpus if gpu < 0 or gpu >= gpu_count]
    if invalid:
        raise ValueError(f"queue.yaml node {hostname} has invalid GPU indices {invalid}")
    if len(set(gpus)) != len(gpus):
        raise ValueError(f"queue.yaml node {hostname} has duplicate GPU indices in {key}")
    return gpus


def _parse_node_config(
    entry: Any,
    cluster_defaults: dict[str, int],
    node_overrides: dict[str, int],
) -> NodeConfig:
    if isinstance(entry, dict):
        hostname = str(entry["hostname"]).strip()
        gpu_count = int(entry.get("gpu_count", resolve_gpu_count(hostname, cluster_defaults, node_overrides)))
        if "gpus" in entry and "allow_gpus" in entry:
            raise ValueError(f"queue.yaml node {hostname} cannot define both gpus and allow_gpus")
        raw_allowed = entry.get("allow_gpus", entry.get("gpus"))
        raw_blocked = entry.get("block_gpus")
        slots_per_gpu = entry.get("slots_per_gpu")
    else:
        hostname = str(entry).strip() if entry is not None else ""
        gpu_count = resolve_gpu_count(hostname, cluster_defaults, node_overrides)
        raw_allowed = None
        raw_blocked = None
        slots_per_gpu = None

    if not hostname:
        raise ValueError("queue.yaml contains an empty node hostname")
    if gpu_count < 0:
        raise ValueError(f"queue.yaml node {hostname} has negative gpu_count")

    allowed_gpus = _parse_gpu_list(hostname, "allow_gpus/gpus", raw_allowed, gpu_count)
    blocked_gpus = _parse_gpu_list(hostname, "block_gpus", raw_blocked, gpu_count)
    if allowed_gpus and blocked_gpus:
        raise ValueError(f"queue.yaml node {hostname} cannot define both allow_gpus/gpus and block_gpus")

    parsed_slots = None if slots_per_gpu is None else int(slots_per_gpu)
    if parsed_slots is not None and parsed_slots < 1:
        raise ValueError(f"queue.yaml node {hostname} slots_per_gpu must be >= 1")

    return NodeConfig(
        hostname=hostname,
        gpu_count=gpu_count,
        allowed_gpus=allowed_gpus or None,
        blocked_gpus=blocked_gpus or None,
        slots_per_gpu=parsed_slots,
    )


def load_queue(
    queue_path: str | Path | None = None,
    hardware_path: str | Path | None = None,
    scanner_config_path: str | Path | None = None,
) -> SchedulerConfig:
    """Load SchedulerConfig from queue.yaml + hardware.yaml + config.yaml."""
    q_path = _resolve_path(queue_path, _DEFAULT_QUEUE_PATHS, "queue.yaml")
    raw: dict[str, Any] = load_queue_raw(q_path)
    return load_queue_from_raw(
        raw,
        queue_path=q_path,
        hardware_path=hardware_path,
        scanner_config_path=scanner_config_path,
    )


def load_queue_raw(queue_path: str | Path) -> dict[str, Any]:
    q_path = Path(queue_path)
    queue_content = q_path.read_bytes()
    raw: dict[str, Any] = yaml.safe_load(queue_content.decode("utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Invalid queue format in {q_path}")
    return raw


def load_queue_from_raw(
    raw: dict[str, Any],
    *,
    queue_path: str | Path,
    hardware_path: str | Path | None = None,
    scanner_config_path: str | Path | None = None,
) -> SchedulerConfig:
    """Load SchedulerConfig from an already parsed queue mapping."""
    q_path = Path(queue_path)
    queue_id, q_hash = queue_identity(q_path, raw)
    exp_hash = experiment_hash_from_raw(raw)
    place_hash = placement_hash_from_raw(raw)

    resolved_hardware_path = resolve_hardware_path(hardware_path)
    cluster_defaults, node_overrides = _load_hardware(resolved_hardware_path)

    # Resolve node configs
    nodes: list[NodeConfig] = []
    raw_nodes = raw.get("my_nodes", [])
    if not raw_nodes:
        raise ValueError("queue.yaml must define at least one my_nodes entry")
    for entry in raw_nodes:
        nodes.append(_parse_node_config(entry, cluster_defaults, node_overrides))

    # Parse experiments (preserving queue order)
    experiments: list[Experiment] = []
    raw_experiments = raw.get("experiments", [])
    if not raw_experiments:
        raise ValueError("queue.yaml must define at least one experiment")
    seen_names: set[str] = set()
    for exp in raw_experiments:
        raw_name = exp["name"]
        raw_command = exp["command"]
        name = str(raw_name).strip() if raw_name is not None else ""
        command = str(raw_command).strip() if raw_command is not None else ""
        requires_gpu = exp.get("requires_gpu", True)
        if not name:
            raise ValueError("experiment name must be non-empty")
        if name in seen_names:
            raise ValueError(f"duplicate experiment name: {name}")
        if not command:
            raise ValueError(f"experiment '{name}' command must be non-empty")
        if not isinstance(requires_gpu, bool):
            raise ValueError(f"experiment '{name}' requires_gpu must be a bool")
        seen_names.add(name)
        experiments.append(Experiment(
            name=name,
            command=command,
            requires_gpu=requires_gpu,
            job_id=experiment_job_id(queue_id, name),
            command_hash=command_hash(command),
        ))

    # Load SSH credentials and scheduler settings from config.yaml
    scanner_cfg: ScannerConfig = load_scanner_config(scanner_config_path)
    account = scanner_cfg.get_account()  # use default account

    # Read scheduler: section from config.yaml for global settings
    cfg_path = find_config_file(scanner_config_path)
    cfg_raw: dict = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
    global_sched_section: dict = cfg_raw.get("scheduler", {}) or {}
    queue_sched_section: dict = raw.get("scheduler", {}) or {}
    sched_section: dict = {**global_sched_section, **queue_sched_section}

    slots_per_gpu = int(sched_section.get("slots_per_gpu", 1))
    if slots_per_gpu < 1:
        raise ValueError("scheduler.slots_per_gpu must be >= 1")

    min_free_mem_mb = sched_section.get("min_free_mem_mb")
    parsed_min_free_mem_mb = None if min_free_mem_mb is None else int(min_free_mem_mb)
    if parsed_min_free_mem_mb is not None and parsed_min_free_mem_mb < 0:
        raise ValueError("scheduler.min_free_mem_mb must be >= 0")

    if any(exp.requires_gpu for exp in experiments) and all(node.gpu_count == 0 for node in nodes):
        raise ValueError("GPU experiments require at least one node with gpu_count > 0")

    state_path = Path(sched_section["state_path"]).expanduser() if "state_path" in sched_section else _PROJECT_ROOT / "outputs" / "scheduler_state" / f"{queue_id}.json"
    log_dir = Path(sched_section["log_dir"]).expanduser() if "log_dir" in sched_section else _PROJECT_ROOT / "outputs" / "logs"

    summ_section: dict = {**(cfg_raw.get("summarizer", {}) or {}), **(raw.get("summarizer", {}) or {})}
    summarizer = SummarizerConfig(
        enabled=bool(summ_section.get("enabled", False)),
        model=str(summ_section.get("model", "claude-haiku-4-5-20251001")),
        api_key=summ_section.get("api_key") or None,
        api_base=summ_section.get("api_base") or None,
        max_log_lines=int(summ_section.get("max_log_lines", 150)),
        max_tokens=int(summ_section.get("max_tokens", 4096)),
    )

    return SchedulerConfig(
        my_nodes=nodes,
        experiments=experiments,
        queue_id=queue_id,
        queue_hash=q_hash,
        experiment_hash=exp_hash,
        placement_hash=place_hash,
        queue_path=q_path,
        hardware_path=resolved_hardware_path,
        scanner_config_path=cfg_path,
        account=account,
        gpu_free_threshold_pct=float(sched_section.get("gpu_free_threshold_pct", 40.0)),
        min_free_mem_mb=parsed_min_free_mem_mb,
        respect_external_gpu_processes=bool(sched_section.get("respect_external_gpu_processes", True)),
        slots_per_gpu=slots_per_gpu,
        poll_interval_sec=int(sched_section.get("poll_interval_sec", 120)),
        notify_email=sched_section.get("notify_email") or None,
        notify_blocked_after_min=int(sched_section.get("notify_blocked_after_min", 30)),
        notify_max_interval_min=int(sched_section.get("notify_max_interval_min", 1440)),
        notify_progress_interval_min=int(sched_section.get("notify_progress_interval_min", 120)),
        state_path=state_path,
        log_dir=log_dir,
        summarizer=summarizer,
        head_node=scanner_cfg.head_node,
        ssh_timeout=scanner_cfg.ssh_timeout,
        command_timeout=scanner_cfg.command_timeout,
    )


def _resolve_path(
    path: str | Path | None,
    defaults: list[Path],
    label: str,
) -> Path:
    if path is not None:
        p = Path(path)
        if not p.is_file():
            raise FileNotFoundError(f"{label} not found: {p}")
        return p
    for candidate in defaults:
        if candidate.is_file():
            return candidate
    searched = ", ".join(str(p) for p in defaults)
    raise FileNotFoundError(f"No {label} found. Searched: {searched}")
