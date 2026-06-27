from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.scanner.config import AccountConfig
from src.scheduler.cli import (
    _cmd_archive,
    _cmd_artifacts,
    _cmd_kill,
    _cmd_migrate_state,
    _cmd_mutate,
    _cmd_report,
    _cmd_retry,
    _cmd_start,
    _cmd_status,
    _scheduler_launch_command,
    _parse_cnode_connectivity,
    _remote_kill_command,
    default_tmux_session,
)
from src.scheduler.lock import SchedulerLock
from src.scheduler.config import Experiment, NodeConfig, SchedulerConfig, load_queue
from src.scheduler.scheduler import Scheduler
from src.scheduler.state import FinishedJob, RunningJob, SchedulerState


def _config(tmp_path: Path) -> SchedulerConfig:
    command = "python train.py"
    queue_id = "queue-abc"
    command_hash = "hash-command"
    return SchedulerConfig(
        my_nodes=[NodeConfig(hostname="turing1", gpu_count=3)],
        experiments=[
            Experiment(
                name="exp-one",
                command=command,
                requires_gpu=True,
                job_id=f"{queue_id}:exp-one",
                command_hash=command_hash,
            )
        ],
        account=AccountConfig(name="default", username="user"),
        queue_id=queue_id,
        queue_hash="hash-queue",
        slots_per_gpu=3,
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
    )


def test_scheduler_start_rejects_legacy_state(tmp_path: Path) -> None:
    config = _config(tmp_path)
    config.state_path.write_text(json.dumps({
        "pending": ["exp-one"],
        "running": [],
        "done": [],
        "failed": [],
    }), encoding="utf-8")

    with pytest.raises(ValueError, match="Legacy scheduler state"):
        SchedulerState.initialise(
            ["exp-one"],
            config.state_path,
            queue_id=config.queue_id,
            queue_hash=config.queue_hash,
        )


def test_scheduler_rejects_unknown_pending_in_state(tmp_path: Path) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        pending=["exp-one", "old-exp"],
    )

    with pytest.raises(ValueError, match="not in this queue"):
        Scheduler(config)._validate_state_for_start(state)


def test_status_is_read_only_on_legacy_state(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    config = _config(tmp_path)
    config.state_path.write_text(json.dumps({
        "pending": ["exp-one"],
        "running": [{
            "exp_name": "foreign",
            "hostname": "mars21",
            "pid": 123,
            "gpu_index": 0,
            "log_path": "/tmp/foreign.log",
            "started_at": 1.0,
        }],
        "done": [],
        "failed": [],
    }), encoding="utf-8")

    _cmd_status(config)

    output = capsys.readouterr().out
    assert "legacy state" in output
    assert "mars21" in output


def test_status_json_is_machine_readable(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        pending=["exp-one"],
    )
    state.save(config.state_path)

    _cmd_status(config, json_output=True)

    payload = json.loads(capsys.readouterr().out)
    assert payload["queue"]["id"] == config.queue_id
    assert payload["state"]["counts"]["pending"] == 1
    assert payload["warnings"] == []


def test_migrate_refuses_active_state_without_experiment_hash(tmp_path: Path) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash="old-combined-hash",
        pending=["exp-one"],
    )
    state.save(config.state_path)

    with pytest.raises(SystemExit):
        _cmd_migrate_state(config, execute=True)


def test_mutate_validates_new_queue_before_writing(tmp_path: Path) -> None:
    hardware = tmp_path / "hardware.yaml"
    hardware.write_text(
        """
clusters:
  turing: 3
node_overrides: {}
""".strip(),
        encoding="utf-8",
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        f"""
accounts:
  - name: default
    username: user
default_account: default
scheduler:
  state_path: {(tmp_path / "state.json").as_posix()}
""".strip(),
        encoding="utf-8",
    )
    queue = tmp_path / "queue.yaml"
    queue.write_text(
        """
my_nodes:
  - turing1
experiments:
  - name: exp-one
    command: echo one
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    loaded = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=config_path)
    before = queue.read_text(encoding="utf-8")

    with pytest.raises(ValueError, match="invalid GPU"):
        _cmd_mutate(
            loaded,
            set_slots=None,
            add_node="turing1",
            remove_node=None,
            replace_node=None,
            gpus="99",
            block_gpus=None,
            execute=False,
        )

    assert queue.read_text(encoding="utf-8") == before


def test_mutate_replace_node_updates_queue(tmp_path: Path) -> None:
    hardware = tmp_path / "hardware.yaml"
    hardware.write_text(
        """
clusters:
  mars: 2
node_overrides: {}
""".strip(),
        encoding="utf-8",
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        f"""
accounts:
  - name: default
    username: user
default_account: default
scheduler:
  state_path: {(tmp_path / "state.json").as_posix()}
""".strip(),
        encoding="utf-8",
    )
    queue = tmp_path / "queue.yaml"
    queue.write_text(
        """
my_nodes:
  - mars12
experiments:
  - name: exp-one
    command: echo one
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    loaded = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=config_path)

    _cmd_mutate(
        loaded,
        set_slots=None,
        add_node=None,
        remove_node=None,
        replace_node="mars12:mars29",
        gpus=None,
        block_gpus=None,
        execute=True,
    )

    updated = queue.read_text(encoding="utf-8")
    assert "mars29" in updated
    assert "mars12" not in updated


def test_mutate_rejects_slots_decrease_for_running_gpu_job(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    hardware = tmp_path / "hardware.yaml"
    hardware.write_text(
        """
clusters:
  turing: 3
node_overrides: {}
""".strip(),
        encoding="utf-8",
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        f"""
accounts:
  - name: default
    username: user
default_account: default
scheduler:
  state_path: {(tmp_path / "state.json").as_posix()}
""".strip(),
        encoding="utf-8",
    )
    queue = tmp_path / "queue.yaml"
    queue.write_text(
        """
my_nodes:
  - turing1
scheduler:
  slots_per_gpu: 2
experiments:
  - name: exp-one
    command: echo one
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    loaded = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=config_path)
    state = SchedulerState(
        queue_id=loaded.queue_id,
        queue_hash=loaded.queue_hash,
        experiment_hash=loaded.experiment_hash,
        placement_hash=loaded.placement_hash,
        running=[RunningJob("exp-one", "turing1", 123, 0, "/tmp/exp.log", 1.0, slots_per_gpu=2)],
    )
    state.save(loaded.state_path)

    with pytest.raises(SystemExit):
        _cmd_mutate(
            loaded,
            set_slots=1,
            add_node=None,
            remove_node=None,
            replace_node=None,
            gpus=None,
            block_gpus=None,
            execute=False,
        )

    assert "decrease slots_per_gpu" in capsys.readouterr().err
    assert "slots_per_gpu: 2" in queue.read_text(encoding="utf-8")


def test_live_mutate_add_node_writes_queue_without_state_adoption(tmp_path: Path) -> None:
    hardware = tmp_path / "hardware.yaml"
    hardware.write_text(
        """
clusters:
  mars: 2
node_overrides: {}
""".strip(),
        encoding="utf-8",
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        f"""
accounts:
  - name: default
    username: user
default_account: default
scheduler:
  state_path: {(tmp_path / "state.json").as_posix()}
""".strip(),
        encoding="utf-8",
    )
    queue = tmp_path / "queue.yaml"
    queue.write_text(
        """
my_nodes:
  - mars12
experiments:
  - name: exp-one
    command: echo one
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    loaded = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=config_path)
    state = SchedulerState(
        queue_id=loaded.queue_id,
        queue_hash=loaded.queue_hash,
        experiment_hash=loaded.experiment_hash,
        placement_hash=loaded.placement_hash,
        pending=["exp-one"],
    )
    state.save(loaded.state_path)
    lock = SchedulerLock(loaded.state_path, loaded.queue_id)
    lock.acquire()

    _cmd_mutate(
        loaded,
        set_slots=None,
        add_node="mars29",
        remove_node=None,
        replace_node=None,
        gpus=None,
        block_gpus=None,
        execute=True,
    )
    lock.release()

    updated = queue.read_text(encoding="utf-8")
    persisted = SchedulerState.load(loaded.state_path)
    assert "mars29" in updated
    assert persisted.placement_hash == loaded.placement_hash


def test_kill_defaults_to_dry_run_and_does_not_connect(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        running=[RunningJob(
            exp_name="exp-one",
            hostname="turing1",
            pid=123,
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            job_id="queue-abc:exp-one",
            command_hash="hash-command",
            queue_id=config.queue_id,
            slots_per_gpu=3,
            wrapper_path="/tmp/exp-one.wrapper.sh",
        )],
    )
    state.save(config.state_path)

    def fail_connect(*args, **kwargs):
        raise AssertionError("dry-run must not connect")

    monkeypatch.setattr("src.scheduler.cli.connect_node", fail_connect)

    _cmd_kill(config, ["queue-abc:exp-one"], execute=False)

    output = capsys.readouterr().out
    assert "Would kill exp-one" in output
    assert "DRY-RUN" in output


def test_retry_execute_refuses_command_mismatch(tmp_path: Path) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        failed=[FinishedJob(
            exp_name="exp-one",
            hostname="turing1",
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            finished_at=2.0,
            exit_code=1,
            job_id="queue-abc:exp-one",
            command_hash="old-command-hash",
            queue_id=config.queue_id,
            slots_per_gpu=3,
            wrapper_path="/tmp/exp-one.wrapper.sh",
        )],
    )
    state.save(config.state_path)

    with pytest.raises(SystemExit):
        _cmd_retry(config, ["queue-abc:exp-one"], execute=True)


def test_retry_execute_revalidates_state_after_lock(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        experiment_hash=config.experiment_hash,
        placement_hash=config.placement_hash,
        failed=[FinishedJob(
            exp_name="exp-one",
            hostname="turing1",
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            finished_at=2.0,
            exit_code=1,
            job_id="queue-abc:exp-one",
            command_hash="hash-command",
            queue_id=config.queue_id,
            slots_per_gpu=3,
            wrapper_path="/tmp/exp-one.wrapper.sh",
        )],
    )
    state.save(config.state_path)
    original_acquire = SchedulerLock.acquire

    def acquire_then_change_state(lock: SchedulerLock) -> None:
        original_acquire(lock)
        changed = SchedulerState(
            queue_id=config.queue_id,
            queue_hash=config.queue_hash,
            experiment_hash=config.experiment_hash,
            placement_hash=config.placement_hash,
            pending=["unknown-exp"],
        )
        changed.save(config.state_path)

    monkeypatch.setattr("src.scheduler.cli.SchedulerLock.acquire", acquire_then_change_state)

    with pytest.raises(SystemExit):
        _cmd_retry(config, ["queue-abc:exp-one"], execute=True)

    assert "state contains experiments outside this queue" in capsys.readouterr().err


def test_retry_execute_handles_missing_job_after_lock(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        experiment_hash=config.experiment_hash,
        placement_hash=config.placement_hash,
        failed=[FinishedJob(
            exp_name="exp-one",
            hostname="turing1",
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            finished_at=2.0,
            exit_code=1,
            job_id="queue-abc:exp-one",
            command_hash="hash-command",
            queue_id=config.queue_id,
            slots_per_gpu=3,
            wrapper_path="/tmp/exp-one.wrapper.sh",
        )],
    )
    state.save(config.state_path)
    original_acquire = SchedulerLock.acquire

    def acquire_then_remove_job(lock: SchedulerLock) -> None:
        original_acquire(lock)
        changed = SchedulerState(
            queue_id=config.queue_id,
            queue_hash=config.queue_hash,
            experiment_hash=config.experiment_hash,
            placement_hash=config.placement_hash,
        )
        changed.save(config.state_path)

    monkeypatch.setattr("src.scheduler.cli.SchedulerLock.acquire", acquire_then_remove_job)

    with pytest.raises(SystemExit):
        _cmd_retry(config, ["queue-abc:exp-one"], execute=True)

    assert "Not failed in this state: queue-abc:exp-one" in capsys.readouterr().err


def test_kill_execute_handles_missing_job_after_lock(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        experiment_hash=config.experiment_hash,
        placement_hash=config.placement_hash,
        running=[RunningJob(
            exp_name="exp-one",
            hostname="turing1",
            pid=123,
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            job_id="queue-abc:exp-one",
            command_hash="hash-command",
            queue_id=config.queue_id,
            slots_per_gpu=3,
            wrapper_path="/tmp/exp-one.wrapper.sh",
        )],
    )
    state.save(config.state_path)
    original_acquire = SchedulerLock.acquire

    def acquire_then_remove_job(lock: SchedulerLock) -> None:
        original_acquire(lock)
        changed = SchedulerState(
            queue_id=config.queue_id,
            queue_hash=config.queue_hash,
            experiment_hash=config.experiment_hash,
            placement_hash=config.placement_hash,
        )
        changed.save(config.state_path)

    def fail_connect(*args, **kwargs):
        raise AssertionError("missing job path must not connect")

    monkeypatch.setattr("src.scheduler.cli.SchedulerLock.acquire", acquire_then_remove_job)
    monkeypatch.setattr("src.scheduler.cli.connect_node", fail_connect)

    with pytest.raises(SystemExit):
        _cmd_kill(config, ["queue-abc:exp-one"], execute=True)

    assert "Not running in this state: queue-abc:exp-one" in capsys.readouterr().err


def test_kill_execute_revalidates_state_after_lock(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path)
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        experiment_hash=config.experiment_hash,
        placement_hash=config.placement_hash,
        running=[RunningJob(
            exp_name="exp-one",
            hostname="turing1",
            pid=123,
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            job_id="queue-abc:exp-one",
            command_hash="hash-command",
            queue_id=config.queue_id,
            slots_per_gpu=3,
            wrapper_path="/tmp/exp-one.wrapper.sh",
        )],
    )
    state.save(config.state_path)
    original_acquire = SchedulerLock.acquire

    def acquire_then_change_state(lock: SchedulerLock) -> None:
        original_acquire(lock)
        changed = SchedulerState(
            queue_id=config.queue_id,
            queue_hash=config.queue_hash,
            experiment_hash=config.experiment_hash,
            placement_hash=config.placement_hash,
            pending=["unknown-exp"],
        )
        changed.save(config.state_path)

    def fail_connect(*args, **kwargs):
        raise AssertionError("unsafe state path must not connect")

    monkeypatch.setattr("src.scheduler.cli.SchedulerLock.acquire", acquire_then_change_state)
    monkeypatch.setattr("src.scheduler.cli.connect_node", fail_connect)

    with pytest.raises(SystemExit):
        _cmd_kill(config, ["queue-abc:exp-one"], execute=True)

    assert "state contains experiments outside this queue" in capsys.readouterr().err


def test_remote_kill_command_checks_wrapper_and_process_group() -> None:
    job = RunningJob(
        exp_name="exp-one",
        hostname="turing1",
        pid=123,
        gpu_index=0,
        log_path="/tmp/exp-one.log",
        started_at=1.0,
        wrapper_path="/tmp/exp-one.wrapper.sh",
    )

    command = _remote_kill_command(job)

    assert "/tmp/exp-one.wrapper.sh" in command
    assert "MISMATCH" in command
    assert 'kill -- "-$pgid"' in command


def test_start_refuses_fresh_scoped_state_when_legacy_global_exists(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path)
    output_dir = tmp_path / "outputs"
    config.state_path = output_dir / "scheduler_state" / "queue-abc.json"
    legacy_state_path = output_dir / "scheduler_state.json"
    legacy_state_path.parent.mkdir(parents=True)
    legacy_state_path.write_text(json.dumps({
        "pending": [],
        "running": [{
            "exp_name": "already-running",
            "hostname": "turing1",
            "pid": 123,
            "gpu_index": 0,
            "log_path": "/tmp/already-running.log",
            "started_at": 1.0,
        }],
        "done": [],
        "failed": [],
    }), encoding="utf-8")

    def fail_run_forever(self):
        raise AssertionError("start must refuse before scheduler loop")

    monkeypatch.setattr("src.scheduler.scheduler.Scheduler.run_forever", fail_run_forever)

    with pytest.raises(SystemExit):
        _cmd_start(config, dry_run=False)


def test_default_tmux_session_is_safe_stable_and_short(tmp_path: Path) -> None:
    config = _config(tmp_path)
    config.queue_path = tmp_path / "queue.pacf.v34.yaml"

    session = default_tmux_session(config)

    assert session == default_tmux_session(config)
    assert session.startswith("ihpc_queue_pacf_v34_")
    assert "." not in session
    assert ":" not in session
    assert len(session) < 80


def test_scheduler_launch_command_uses_resolved_executable(tmp_path: Path) -> None:
    config = _config(tmp_path)
    config.queue_path = tmp_path / "queue.yaml"

    command = _scheduler_launch_command(config)

    assert " --queue " in command
    assert " start" in command
    assert not command.startswith("ihpc-sched --queue")


def test_report_reads_states_without_connecting(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    config = _config(tmp_path)
    state_dir = tmp_path / "outputs" / "scheduler_state"
    config.state_path = state_dir / "queue-abc.json"
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        pending=["exp-one"],
    )
    state.save(config.state_path)

    _cmd_report(config, limit=10, json_output=False)

    output = capsys.readouterr().out
    assert "SCHEDULER RUNS" in output
    assert "queue-abc.json" in output
    assert "P/R/D/F=1/0/0/0" in output
    assert "remaining=1" in output


def test_artifacts_indexes_scheduler_state_without_connecting(tmp_path: Path) -> None:
    config = _config(tmp_path)
    state_dir = tmp_path / "outputs" / "scheduler_state"
    config.state_path = state_dir / "queue-abc.json"
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        experiment_hash="experiment-hash",
        placement_hash="placement-hash",
        done=[FinishedJob(
            exp_name="exp-one",
            hostname="turing1",
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            finished_at=2.0,
            exit_code=0,
            job_id="queue-abc:exp-one",
            command_hash="hash-command",
        )],
    )
    state.save(config.state_path)
    output = tmp_path / "artifacts.json"

    _cmd_artifacts(config, output=str(output), status="done")

    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["artifacts"][0]["exp_name"] == "exp-one"
    assert payload["artifacts"][0]["status"] == "done"
    assert payload["artifacts"][0]["experiment_hash"] == "experiment-hash"


def test_archive_dry_run_keeps_completed_state(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    config = _config(tmp_path)
    state_dir = tmp_path / "outputs" / "scheduler_state"
    config.state_path = state_dir / "queue-abc.json"
    state = SchedulerState(
        queue_id=config.queue_id,
        queue_hash=config.queue_hash,
        done=[FinishedJob(
            exp_name="exp-one",
            hostname="turing1",
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            finished_at=2.0,
            exit_code=0,
        )],
    )
    state.save(config.state_path)

    _cmd_archive(config, limit=10, execute=False)

    output = capsys.readouterr().out
    assert "Would archive" in output
    assert config.state_path.is_file()


def test_cnode_probe_parser_only_reports_requested_nodes() -> None:
    text = """
   Node   Index  Connect  %CPU
   mars12   3      no     75.4
   mars29   2     yes      3.6
   mars30   2     yes     98.0
"""

    parsed = _parse_cnode_connectivity(text, {"mars12", "mars29"})

    assert parsed == {"mars12": "no", "mars29": "yes"}


def test_mutate_dry_run_does_not_create_temp_file(tmp_path: Path) -> None:
    hardware = tmp_path / "hardware.yaml"
    hardware.write_text(
        """
clusters:
  mars: 2
node_overrides: {}
""".strip(),
        encoding="utf-8",
    )
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        f"""
accounts:
  - name: default
    username: user
default_account: default
scheduler:
  state_path: {(tmp_path / "state.json").as_posix()}
""".strip(),
        encoding="utf-8",
    )
    queue = tmp_path / "queue.yaml"
    queue.write_text(
        """
my_nodes:
  - mars12
experiments:
  - name: exp-one
    command: echo one
    requires_gpu: true
""".strip(),
        encoding="utf-8",
    )
    loaded = load_queue(queue_path=queue, hardware_path=hardware, scanner_config_path=config_path)

    _cmd_mutate(
        loaded,
        set_slots=None,
        add_node=None,
        remove_node=None,
        replace_node="mars12:mars29",
        gpus=None,
        block_gpus=None,
        execute=False,
    )

    assert not list(tmp_path.glob(".*mutate-check*"))


def test_start_refuses_when_sibling_scoped_state_has_active_overlap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = _config(tmp_path)
    state_dir = tmp_path / "outputs" / "scheduler_state"
    config.state_path = state_dir / "new-queue.json"
    sibling_path = state_dir / "old-queue.json"
    sibling = SchedulerState(
        queue_id="old-queue",
        queue_hash="old-hash",
        running=[RunningJob(
            exp_name="exp-one",
            hostname="turing1",
            pid=123,
            gpu_index=0,
            log_path="/tmp/exp-one.log",
            started_at=1.0,
            job_id="old-queue:exp-one",
            command_hash="hash-command",
            queue_id="old-queue",
            slots_per_gpu=3,
            wrapper_path="/tmp/exp-one.wrapper.sh",
        )],
    )
    sibling.save(sibling_path)

    def fail_run_forever(self):
        raise AssertionError("start must refuse before scheduler loop")

    monkeypatch.setattr("src.scheduler.scheduler.Scheduler.run_forever", fail_run_forever)

    with pytest.raises(SystemExit):
        _cmd_start(config, dry_run=False)
