from pathlib import Path

import pytest

from src.scanner.config import AccountConfig
from src.scheduler.config import Experiment, NodeConfig, SchedulerConfig, load_queue
from src.scheduler.scheduler import Scheduler, usable_gpu_count
from src.scheduler.state import RunningJob, SchedulerState


class FakePool:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeClient:
    def __init__(self, hostname: str, gpu_output: str = "") -> None:
        self.hostname = hostname
        self.gpu_output = gpu_output

    def exec_command(self, command: str, *, read_line: bool = False) -> str:
        if "--query-compute-apps" in command:
            return ""
        return self.gpu_output


def _config(tmp_path: Path) -> SchedulerConfig:
    return SchedulerConfig(
        my_nodes=[
            NodeConfig(hostname="mars1", gpu_count=4),
            NodeConfig(hostname="neptune1", gpu_count=4),
        ],
        experiments=[Experiment(name="exp", command="echo exp", job_id="q:exp", command_hash="hash")],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="hash",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
    )


def test_scheduler_orders_nodes_by_current_load(tmp_path: Path) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        running=[
            RunningJob(
                exp_name="busy",
                hostname="mars1",
                pid=123,
                gpu_index=0,
                log_path="/tmp/busy.log",
                started_at=1.0,
            )
        ],
    )

    ordered = Scheduler(config)._ordered_nodes_by_load(state)

    assert [node.hostname for node in ordered] == ["neptune1", "mars1"]


def test_scheduler_orders_nodes_by_load_ratio(tmp_path: Path) -> None:
    config = SchedulerConfig(
        my_nodes=[
            NodeConfig(hostname="small", gpu_count=4, allowed_gpus=[0]),
            NodeConfig(hostname="large", gpu_count=4),
        ],
        experiments=[Experiment(name="exp", command="echo exp", job_id="q:exp", command_hash="hash")],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="hash",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
    )
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        running=[
            RunningJob("small-busy", "small", 1, 0, "/tmp/small.log", 1.0),
            RunningJob("large-busy-1", "large", 2, 0, "/tmp/large1.log", 1.0),
            RunningJob("large-busy-2", "large", 3, 1, "/tmp/large2.log", 1.0),
        ],
    )

    ordered = Scheduler(config)._ordered_nodes_by_load(state)

    assert [node.hostname for node in ordered] == ["large", "small"]


def test_dispatch_skips_blocked_head_gpu_job_and_runs_later_cpu_job(monkeypatch, tmp_path: Path) -> None:
    config = SchedulerConfig(
        my_nodes=[NodeConfig(hostname="mars1", gpu_count=1)],
        experiments=[
            Experiment(name="gpu-blocked", command="echo gpu", requires_gpu=True, job_id="q:gpu", command_hash="gpu"),
            Experiment(name="cpu-ready", command="echo cpu", requires_gpu=False, job_id="q:cpu", command_hash="cpu"),
        ],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="hash",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
        slots_per_gpu=1,
    )
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        pending=["gpu-blocked", "cpu-ready"],
        running=[RunningJob("already-running", "mars1", 1, 0, "/tmp/running.log", 1.0)],
    )
    submissions: list[tuple[str, str, int | None]] = []

    def fake_connect(_config: SchedulerConfig, hostname: str) -> tuple[FakePool, FakeClient]:
        return FakePool(), FakeClient(hostname)

    def fake_submit(client: FakeClient, exp: Experiment, gpu_index: int | None, log_path: str, *, return_result: bool):
        submissions.append((client.hostname, exp.name, gpu_index))
        return type("Submission", (), {"pid": 200 + len(submissions), "wrapper_path": log_path + ".wrapper.sh"})()

    monkeypatch.setattr("src.scheduler.scheduler.connect_node", fake_connect)
    monkeypatch.setattr("src.scheduler.scheduler.submit_job", fake_submit)

    assert Scheduler(config)._dispatch_pending(state)

    assert submissions == [("mars1", "cpu-ready", None)]
    assert state.pending == ["gpu-blocked"]
    assert [job.exp_name for job in state.running] == ["already-running", "cpu-ready"]


def test_dispatch_virtual_gpu_counts_prevent_oversubscribing_one_round(monkeypatch, tmp_path: Path) -> None:
    config = SchedulerConfig(
        my_nodes=[NodeConfig(hostname="mars1", gpu_count=1)],
        experiments=[
            Experiment(name="gpu-a", command="echo a", requires_gpu=True, job_id="q:a", command_hash="a"),
            Experiment(name="gpu-b", command="echo b", requires_gpu=True, job_id="q:b", command_hash="b"),
        ],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="hash",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
        slots_per_gpu=1,
        respect_external_gpu_processes=False,
    )
    state = SchedulerState(queue_id=config.queue_id, queue_hash=config.queue_hash, pending=["gpu-a", "gpu-b"])
    submissions: list[tuple[str, int | None]] = []

    def fake_connect(_config: SchedulerConfig, hostname: str) -> tuple[FakePool, FakeClient]:
        return FakePool(), FakeClient(hostname, "0, 00000000:01:00.0, 100, 1000\n")

    def fake_submit(client: FakeClient, exp: Experiment, gpu_index: int | None, log_path: str, *, return_result: bool):
        submissions.append((exp.name, gpu_index))
        return type("Submission", (), {"pid": 300 + len(submissions), "wrapper_path": log_path + ".wrapper.sh"})()

    monkeypatch.setattr("src.scheduler.scheduler.connect_node", fake_connect)
    monkeypatch.setattr("src.scheduler.scheduler.submit_job", fake_submit)

    assert Scheduler(config)._dispatch_pending(state)

    assert submissions == [("gpu-a", 0)]
    assert state.pending == ["gpu-b"]
    assert [(job.exp_name, job.gpu_index) for job in state.running] == [("gpu-a", 0)]


def test_dispatch_selects_global_best_gpu_across_nodes(monkeypatch, tmp_path: Path) -> None:
    config = SchedulerConfig(
        my_nodes=[
            NodeConfig(hostname="alpha", gpu_count=1),
            NodeConfig(hostname="beta", gpu_count=1),
        ],
        experiments=[Experiment(name="gpu", command="echo gpu", requires_gpu=True, job_id="q:gpu", command_hash="gpu")],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="hash",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
        slots_per_gpu=1,
        respect_external_gpu_processes=False,
    )
    state = SchedulerState(queue_id=config.queue_id, queue_hash=config.queue_hash, pending=["gpu"])
    gpu_outputs = {
        "alpha": "0, 00000000:01:00.0, 500, 1000\n",
        "beta": "0, 00000000:02:00.0, 100, 1000\n",
    }
    submissions: list[tuple[str, int | None]] = []

    def fake_connect(_config: SchedulerConfig, hostname: str) -> tuple[FakePool, FakeClient]:
        return FakePool(), FakeClient(hostname, gpu_outputs[hostname])

    def fake_submit(client: FakeClient, exp: Experiment, gpu_index: int | None, log_path: str, *, return_result: bool):
        submissions.append((client.hostname, gpu_index))
        return type("Submission", (), {"pid": 400, "wrapper_path": log_path + ".wrapper.sh"})()

    monkeypatch.setattr("src.scheduler.scheduler.connect_node", fake_connect)
    monkeypatch.setattr("src.scheduler.scheduler.submit_job", fake_submit)

    assert Scheduler(config)._dispatch_pending(state)

    assert submissions == [("beta", 0)]


def test_dispatch_records_structured_blocked_reasons(monkeypatch, tmp_path: Path) -> None:
    config = SchedulerConfig(
        my_nodes=[NodeConfig(hostname="mars1", gpu_count=1)],
        experiments=[Experiment(name="gpu", command="echo gpu", requires_gpu=True, job_id="q:gpu", command_hash="gpu")],
        account=AccountConfig(name="default", username="user"),
        queue_id="q",
        queue_hash="hash",
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
        slots_per_gpu=1,
    )
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        pending=["gpu"],
        running=[RunningJob("busy", "mars1", 1, 0, "/tmp/busy.log", 1.0)],
    )

    scheduler = Scheduler(config)

    assert not scheduler._dispatch_pending(state)
    assert scheduler.blocked_reasons["gpu"]["reason"] == "no dispatchable slot"
    assert scheduler.blocked_reasons["gpu"]["nodes"][0]["hostname"] == "mars1"


def test_usable_gpu_count_respects_allow_and_block_lists() -> None:
    assert usable_gpu_count(NodeConfig(hostname="n1", gpu_count=4, allowed_gpus=[1])) == 1
    assert usable_gpu_count(NodeConfig(hostname="n2", gpu_count=4, blocked_gpus=[0, 2])) == 2


def _write_reload_config(tmp_path: Path) -> tuple[Path, Path, Path]:
    hardware = tmp_path / "hardware.yaml"
    hardware.write_text(
        """
clusters:
  mars: 2
  neptune: 2
node_overrides: {}
""".strip(),
        encoding="utf-8",
    )
    scanner_config = tmp_path / "config.yaml"
    scanner_config.write_text(
        """
accounts:
  - name: default
    username: user
default_account: default
scheduler:
  slots_per_gpu: 1
""".strip(),
        encoding="utf-8",
    )
    queue = tmp_path / "queue.yaml"
    queue.write_text(
        """
my_nodes:
  - mars1
experiments:
  - name: exp
    command: echo exp
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    return hardware, scanner_config, queue


def test_scheduler_hot_reloads_added_nodes(tmp_path: Path) -> None:
    hardware, scanner_config, queue = _write_reload_config(tmp_path)
    config = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=scanner_config)
    state = SchedulerState(queue_id=config.queue_id, queue_hash=config.queue_hash, pending=["exp"])
    scheduler = Scheduler(config)

    queue.write_text(
        """
my_nodes:
  - mars1
  - neptune1
experiments:
  - name: exp
    command: echo exp
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )

    assert scheduler._reload_config_if_changed(state)
    assert [node.hostname for node in scheduler._config.my_nodes] == ["mars1", "neptune1"]
    assert state.queue_hash == scheduler._config.queue_hash
    assert state.experiment_hash == scheduler._config.experiment_hash
    assert state.placement_hash == scheduler._config.placement_hash


def test_scheduler_hot_reload_rejects_global_slots_per_gpu_decrease_for_running_gpu_job(tmp_path: Path) -> None:
    hardware, scanner_config, queue = _write_reload_config(tmp_path)
    scanner_config.write_text(
        """
accounts:
  - name: default
    username: user
default_account: default
scheduler:
  slots_per_gpu: 2
""".strip(),
        encoding="utf-8",
    )
    config = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=scanner_config)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        running=[RunningJob("exp", "mars1", 123, 0, "/tmp/exp.log", 1.0, slots_per_gpu=2)],
    )
    scheduler = Scheduler(config)

    queue.write_text(
        """
my_nodes:
  - mars1
scheduler:
  slots_per_gpu: 1
experiments:
  - name: exp
    command: echo exp
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="decreases slots_per_gpu"):
        scheduler._reload_config_if_changed(state)


def test_scheduler_hot_reload_rejects_node_slots_per_gpu_decrease_for_running_gpu_job(tmp_path: Path) -> None:
    hardware, scanner_config, queue = _write_reload_config(tmp_path)
    queue.write_text(
        """
my_nodes:
  - hostname: mars1
    slots_per_gpu: 2
experiments:
  - name: exp
    command: echo exp
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    config = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=scanner_config)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        running=[RunningJob("exp", "mars1", 123, 0, "/tmp/exp.log", 1.0, slots_per_gpu=2)],
    )
    scheduler = Scheduler(config)

    queue.write_text(
        """
my_nodes:
  - hostname: mars1
    slots_per_gpu: 1
experiments:
  - name: exp
    command: echo exp
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="decreases slots_per_gpu"):
        scheduler._reload_config_if_changed(state)


def test_scheduler_hot_reload_rejects_experiment_changes(tmp_path: Path) -> None:
    hardware, scanner_config, queue = _write_reload_config(tmp_path)
    config = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=scanner_config)
    state = SchedulerState(queue_id=config.queue_id, queue_hash=config.queue_hash, pending=["exp"])
    scheduler = Scheduler(config)

    queue.write_text(
        """
my_nodes:
  - mars1
experiments:
  - name: other-exp
    command: echo other
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="experiment manifest"):
        scheduler._reload_config_if_changed(state)


def test_scheduler_hot_reload_rejects_command_changes(tmp_path: Path) -> None:
    hardware, scanner_config, queue = _write_reload_config(tmp_path)
    config = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=scanner_config)
    state = SchedulerState(queue_id=config.queue_id, queue_hash=config.queue_hash, pending=["exp"])
    scheduler = Scheduler(config)

    queue.write_text(
        """
my_nodes:
  - mars1
experiments:
  - name: exp
    command: echo changed
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="experiment manifest"):
        scheduler._reload_config_if_changed(state)
