from pathlib import Path

from src.scanner.config import AccountConfig
from src.scheduler.config import Experiment, NodeConfig, SchedulerConfig
from src.scheduler.placement import (
    CPU_SLOTS_PER_NODE,
    NodeSlots,
    SlotCandidate,
    running_placement_issues,
)
from src.scheduler.state import RunningJob, SchedulerState


class FakePool:
    pass


class FakeClient:
    hostname = "mars1"


def _config(tmp_path: Path, node: NodeConfig) -> SchedulerConfig:
    return SchedulerConfig(
        my_nodes=[node],
        experiments=[Experiment(name="gpu", command="echo gpu", job_id="q:gpu", command_hash="gpu")],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="hash",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
        slots_per_gpu=2,
        gpu_free_threshold_pct=55.0,
        min_free_mem_mb=2048,
        respect_external_gpu_processes=False,
    )


def test_node_slots_use_virtual_gpu_counts_for_same_dispatch_pass(tmp_path: Path) -> None:
    node = NodeConfig(hostname="mars1", gpu_count=2)
    config = _config(tmp_path, node)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        running=[RunningJob("old", "mars1", 1, 0, "/tmp/old.log", 1.0)],
    )

    slots = NodeSlots.from_state(
        config,
        node,
        state,
        virtual_gpu_counts={"mars1": {0: 2, 1: 1}},
    )

    assert slots.gpu_counts == {0: 2, 1: 1}
    assert slots.gpu_capacity == 4
    assert not slots.gpu_capacity_full


def test_node_slots_centralise_cpu_and_gpu_blocked_reasons(tmp_path: Path) -> None:
    node = NodeConfig(hostname="mars1", gpu_count=1)
    config = _config(tmp_path, node)
    running = [
        RunningJob(f"cpu-{idx}", "mars1", idx, None, f"/tmp/cpu-{idx}.log", 1.0)
        for idx in range(CPU_SLOTS_PER_NODE)
    ]
    state = SchedulerState(queue_id=config.queue_id, queue_hash=config.queue_hash, running=running)
    slots = NodeSlots.from_state(config, node, state)

    cpu_reason = slots.blocked_reason(
        Experiment(name="cpu", command="echo cpu", requires_gpu=False),
    )
    gpu_reason = slots.blocked_reason(
        Experiment(name="gpu", command="echo gpu", requires_gpu=True),
    )

    assert cpu_reason == {
        "hostname": "mars1",
        "reason": "cpu slots full",
        "cpu_jobs": CPU_SLOTS_PER_NODE,
        "cpu_capacity": CPU_SLOTS_PER_NODE,
    }
    assert gpu_reason == {
        "hostname": "mars1",
        "reason": "no usable GPU matched policy",
        "gpu_counts": {},
        "gpu_capacity": 2,
        "slots_per_gpu": 2,
    }


def test_slot_candidate_sort_key_prefers_less_loaded_more_free_gpu(tmp_path: Path) -> None:
    node = NodeConfig(hostname="mars1", gpu_count=2)
    config = _config(tmp_path, node)
    slots = NodeSlots.empty(config, node)
    pool = FakePool()
    client = FakeClient()

    busy = SlotCandidate.from_gpu_row(
        slots,
        {"gpu": 0, "tracked_jobs": 1, "free_pct": 95.0},
        pool,
        client,
    )
    free = SlotCandidate.from_gpu_row(
        slots,
        {"gpu": 1, "tracked_jobs": 0, "free_pct": 60.0},
        pool,
        client,
    )

    assert sorted([busy, free], key=lambda candidate: candidate.sort_key()) == [free, busy]


def test_node_slots_build_policy_snapshot_from_config_and_node(tmp_path: Path) -> None:
    node = NodeConfig(
        hostname="mars1",
        gpu_count=4,
        allowed_gpus=[1, 3],
        slots_per_gpu=5,
    )
    config = _config(tmp_path, node)
    slots = NodeSlots.empty(config, node)

    assert slots.policy_snapshot() == {
        "node": {
            "hostname": "mars1",
            "gpu_count": 4,
            "allowed_gpus": [1, 3],
            "blocked_gpus": None,
            "slots_per_gpu": 5,
        },
        "slots_per_gpu": 5,
        "gpu_free_threshold_pct": 55.0,
        "min_free_mem_mb": 2048,
        "respect_external_gpu_processes": False,
    }


def test_running_placement_issues_detect_removed_host_and_gpu_policy(tmp_path: Path) -> None:
    old_node = NodeConfig(hostname="mars1", gpu_count=4, slots_per_gpu=3)
    old_config = _config(tmp_path, old_node)
    state = SchedulerState(
        running=[
            RunningJob("gpu-a", "mars1", 10, 2, "/tmp/a.log", 1.0, slots_per_gpu=3),
            RunningJob("cpu-a", "mars2", 11, None, "/tmp/cpu.log", 1.0),
        ],
    )
    new_config = _config(
        tmp_path,
        NodeConfig(hostname="mars1", gpu_count=4, allowed_gpus=[0, 1], slots_per_gpu=2),
    )

    issues = running_placement_issues(new_config, state, previous=old_config, check_slots=True)

    assert [issue.reason for issue in issues] == [
        "decreased_slots",
        "excluded_gpu",
        "missing_host",
    ]
    assert "decreases slots_per_gpu" in issues[0].hot_reload_message()
    assert "exclude running job GPU mars1:2" in issues[1].mutation_message()
    assert "exclude running host mars2" in issues[2].mutation_message()


def test_running_placement_issues_detect_blocked_gpu(tmp_path: Path) -> None:
    state = SchedulerState(
        running=[RunningJob("gpu-a", "mars1", 10, 2, "/tmp/a.log", 1.0)],
    )
    config = _config(
        tmp_path,
        NodeConfig(hostname="mars1", gpu_count=4, blocked_gpus=[2]),
    )

    issues = running_placement_issues(config, state)

    assert [issue.reason for issue in issues] == ["blocked_gpu"]
    assert "blocks running GPU mars1:2" in issues[0].hot_reload_message()
    assert "block running job GPU mars1:2" in issues[0].mutation_message()


def test_running_placement_issues_do_not_apply_gpu_policy_to_cpu_jobs(tmp_path: Path) -> None:
    state = SchedulerState(
        running=[RunningJob("cpu-a", "mars1", 10, None, "/tmp/cpu.log", 1.0)],
    )
    config = _config(
        tmp_path,
        NodeConfig(hostname="mars1", gpu_count=4, allowed_gpus=[0], slots_per_gpu=1),
    )

    assert running_placement_issues(config, state, check_slots=True) == []
