from pathlib import Path

import pytest

from src.scanner.config import AccountConfig
from src.scheduler.config import (
    Experiment,
    NodeConfig,
    SchedulerConfig,
    command_hash,
    experiment_hash_from_raw,
    load_queue,
    placement_hash_from_raw,
    queue_hash_from_raw,
)


def _write_hardware(tmp_path: Path) -> Path:
    path = tmp_path / "hardware.yaml"
    path.write_text(
        """
clusters:
  turing: 3
  jupiter: 0
node_overrides: {}
""".strip(),
        encoding="utf-8",
    )
    return path


def _write_config(tmp_path: Path, scheduler_yaml: str = "") -> Path:
    scheduler_block = f"\nscheduler:\n{scheduler_yaml}" if scheduler_yaml else ""
    path = tmp_path / "config.yaml"
    path.write_text(
        f"""
accounts:
  - name: default
    username: test-user
default_account: default{scheduler_block}
""".strip(),
        encoding="utf-8",
    )
    return path


def _write_queue(tmp_path: Path, content: str, name: str = "queue.yaml") -> Path:
    path = tmp_path / name
    path.write_text(content.strip(), encoding="utf-8")
    return path


def _load(tmp_path: Path, queue: Path, config: Path | None = None):
    return load_queue(
        queue_path=queue,
        hardware_path=_write_hardware(tmp_path),
        scanner_config_path=config or _write_config(tmp_path),
    )


def test_scheduler_config_centralises_common_queue_queries(tmp_path: Path) -> None:
    node = NodeConfig(hostname="turing1", gpu_count=3, slots_per_gpu=4)
    exp = Experiment(name="exp", command="echo exp", job_id="q:exp", command_hash="hash")
    config = SchedulerConfig(
        my_nodes=[node],
        experiments=[exp],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="queue",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
        slots_per_gpu=2,
        gpu_free_threshold_pct=55.0,
        min_free_mem_mb=1024,
        respect_external_gpu_processes=False,
        poll_interval_sec=30,
    )

    assert config.hosts() == {"turing1"}
    assert config.node("turing1") is node
    assert config.node("mars1") is None
    assert config.experiment("exp") is exp
    assert config.experiment("q:exp") is exp
    assert config.experiment("missing") is None
    assert config.experiments_by_name() == {"exp": exp}
    assert config.slots(node) == 4
    assert config.slots(None) == 2
    assert config.slots_on("turing1") == 4
    assert config.slots_on("mars1") is None
    assert config.settings_snapshot() == {
        "slots_per_gpu": 2,
        "gpu_free_threshold_pct": 55.0,
        "min_free_mem_mb": 1024,
        "respect_external_gpu_processes": False,
        "poll_interval_sec": 30,
    }
    assert config.node_policy_snapshot() == [{
        "hostname": "turing1",
        "gpu_count": 3,
        "allowed_gpus": None,
        "blocked_gpus": None,
        "slots_per_gpu": 4,
    }]


def test_duplicate_experiment_names_fail(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - turing1
experiments:
  - name: same
    command: echo one
    requires_gpu: true
  - name: same
    command: echo two
    requires_gpu: true
""",
    )

    with pytest.raises(ValueError, match="duplicate experiment name"):
        _load(tmp_path, queue)


def test_string_requires_gpu_fails(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - turing1
experiments:
  - name: bad-bool
    command: echo one
    requires_gpu: "false"
""",
    )

    with pytest.raises(ValueError, match="requires_gpu must be a bool"):
        _load(tmp_path, queue)


def test_empty_nodes_fail(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
my_nodes: []
experiments:
  - name: no-nodes
    command: echo one
    requires_gpu: false
""",
    )

    with pytest.raises(ValueError, match="my_nodes"):
        _load(tmp_path, queue)


def test_slots_per_gpu_zero_fails(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - turing1
experiments:
  - name: one
    command: echo one
    requires_gpu: true
""",
    )
    config = _write_config(tmp_path, "  slots_per_gpu: 0")

    with pytest.raises(ValueError, match="slots_per_gpu must be >= 1"):
        _load(tmp_path, queue, config)


def test_gpu_experiments_require_gpu_nodes(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - jupiter1
experiments:
  - name: gpu-job
    command: echo one
    requires_gpu: true
""",
    )

    with pytest.raises(ValueError, match="at least one node with gpu_count > 0"):
        _load(tmp_path, queue)


def test_default_state_path_is_queue_scoped(tmp_path: Path) -> None:
    first_queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - turing1
experiments:
  - name: one
    command: echo one
    requires_gpu: true
""",
        name="first.yaml",
    )
    second_queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - turing1
experiments:
  - name: two
    command: echo two
    requires_gpu: true
""",
        name="second.yaml",
    )
    config = _write_config(tmp_path)

    first = _load(tmp_path, first_queue, config)
    second = _load(tmp_path, second_queue, config)

    assert first.queue_hash != second.queue_hash
    assert first.queue_id != second.queue_id
    assert first.state_path != second.state_path
    assert first.state_path.name == f"{first.queue_id}.json"
    assert first.experiments[0].command_hash == command_hash("echo one")


def test_queue_id_is_stable_across_comment_only_changes(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
# initial comment
my_nodes:
  - turing1
experiments:
  - name: one
    command: echo one
    requires_gpu: true
""",
    )
    config = _write_config(tmp_path)

    first = _load(tmp_path, queue, config)
    queue.write_text(
        """
# edited comment
my_nodes:
  - turing1
experiments:
  - name: one
    command: echo one
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    second = _load(tmp_path, queue, config)

    assert first.queue_id == second.queue_id
    assert first.queue_hash == second.queue_hash
    assert first.state_path == second.state_path


def test_explicit_state_path_keeps_compatibility(tmp_path: Path) -> None:
    explicit_state_path = tmp_path / "scheduler_state.json"
    queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - turing1
experiments:
  - name: one
    command: echo one
    requires_gpu: true
""",
    )
    config = _write_config(tmp_path, f"  state_path: {explicit_state_path.as_posix()}")

    loaded = _load(tmp_path, queue, config)

    assert loaded.state_path == explicit_state_path


def test_queue_scheduler_overrides_global_scheduler_and_node_gpus(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - hostname: turing1
    gpus: [1]
    slots_per_gpu: 2
scheduler:
  slots_per_gpu: 4
  gpu_free_threshold_pct: 55
  min_free_mem_mb: 2048
  respect_external_gpu_processes: false
experiments:
  - name: one
    command: echo one
    requires_gpu: true
""",
    )
    config = _write_config(tmp_path, "  slots_per_gpu: 1\n  gpu_free_threshold_pct: 10")

    loaded = _load(tmp_path, queue, config)

    assert loaded.slots_per_gpu == 4
    assert loaded.gpu_free_threshold_pct == 55
    assert loaded.min_free_mem_mb == 2048
    assert loaded.respect_external_gpu_processes is False
    assert loaded.my_nodes[0].allowed_gpus == [1]
    assert loaded.my_nodes[0].slots_per_gpu == 2


def test_node_allow_and_block_gpus_conflict_fails(tmp_path: Path) -> None:
    queue = _write_queue(
        tmp_path,
        """
my_nodes:
  - hostname: turing1
    gpus: [1]
    block_gpus: [2]
experiments:
  - name: one
    command: echo one
    requires_gpu: true
""",
    )

    with pytest.raises(ValueError, match="cannot define both"):
        _load(tmp_path, queue)


def test_experiment_and_placement_hashes_are_separate() -> None:
    base = {
        "my_nodes": ["turing1"],
        "scheduler": {"gpu_free_threshold_pct": 40, "slots_per_gpu": 1},
        "experiments": [{"name": "one", "command": "echo one", "requires_gpu": True}],
    }
    threshold_changed = {
        **base,
        "scheduler": {"gpu_free_threshold_pct": 80, "slots_per_gpu": 1},
    }
    slots_changed = {
        **base,
        "scheduler": {"gpu_free_threshold_pct": 40, "slots_per_gpu": 4},
    }
    command_changed = {
        **base,
        "experiments": [{"name": "one", "command": "echo changed", "requires_gpu": True}],
    }

    assert experiment_hash_from_raw(base) == experiment_hash_from_raw(threshold_changed)
    assert experiment_hash_from_raw(base) == experiment_hash_from_raw(slots_changed)
    assert experiment_hash_from_raw(base) != experiment_hash_from_raw(command_changed)
    assert placement_hash_from_raw(base) != placement_hash_from_raw(threshold_changed)
    assert placement_hash_from_raw(base) != placement_hash_from_raw(slots_changed)
    assert queue_hash_from_raw(base) != queue_hash_from_raw(threshold_changed)
    assert queue_hash_from_raw(base) != queue_hash_from_raw(slots_changed)


def test_queue_hash_canonicalizes_gpu_list_order() -> None:
    first = {
        "my_nodes": [{"hostname": "turing1", "gpus": [1, 2]}],
        "experiments": [{"name": "one", "command": "echo one", "requires_gpu": True}],
    }
    second = {
        "my_nodes": [{"hostname": "turing1", "gpus": [2, 1]}],
        "experiments": [{"name": "one", "command": "echo one", "requires_gpu": True}],
    }

    assert queue_hash_from_raw(first) == queue_hash_from_raw(second)
