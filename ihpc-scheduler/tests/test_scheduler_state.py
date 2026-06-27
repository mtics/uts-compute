import json

import pytest

from src.scheduler.state import FinishedJob, RunningJob, SchedulerState


def test_loads_legacy_state_without_identity_fields(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({
        "pending": ["exp-pending"],
        "running": [{
            "exp_name": "exp-running",
            "hostname": "turing1",
            "pid": 123,
            "gpu_index": 0,
            "log_path": "/tmp/run.log",
            "started_at": 10.0,
        }],
        "done": [{
            "exp_name": "exp-done",
            "hostname": "turing1",
            "gpu_index": 1,
            "log_path": "/tmp/done.log",
            "started_at": 1.0,
            "finished_at": 2.0,
            "exit_code": 0,
        }],
        "failed": [],
    }), encoding="utf-8")

    state = SchedulerState.load(state_path)

    assert state.is_legacy is True
    assert state.version == 0
    assert state.queue_id is None
    assert state.queue_hash is None
    assert state.experiment_hash is None
    assert state.placement_hash is None
    assert state.created_at == 0.0
    assert state.updated_at == 0.0
    assert state.pending == ["exp-pending"]
    assert state.running[0].job_id is None
    assert state.running[0].command_hash is None
    assert state.done[0].wrapper_path is None


def test_new_state_saves_identity_and_job_metadata(tmp_path):
    state_path = tmp_path / "state.json"
    state = SchedulerState(
        queue_id="queue-1",
        queue_hash="hash-1",
        experiment_hash="experiment-1",
        placement_hash="placement-1",
        running=[RunningJob(
            exp_name="exp-1",
            hostname="turing1",
            pid=123,
            gpu_index=0,
            log_path="/tmp/exp-1.log",
            started_at=10.0,
            job_id="job-1",
            command_hash="command-hash-1",
            queue_id="queue-1",
            slots_per_gpu=2,
            wrapper_path="/tmp/wrapper.sh",
            placement_hash="placement-1",
            policy_snapshot={"slots_per_gpu": 2},
        )],
    )

    assert state.mark_done("exp-1", exit_code=0, finished_at=20.0) is True
    state.save(state_path)

    data = json.loads(state_path.read_text(encoding="utf-8"))
    assert data["version"] == 2
    assert data["queue_id"] == "queue-1"
    assert data["queue_hash"] == "hash-1"
    assert data["experiment_hash"] == "experiment-1"
    assert data["placement_hash"] == "placement-1"
    assert "queue_path" in data
    assert "tmux_session" in data
    assert data["created_at"] > 0
    assert data["updated_at"] >= data["created_at"]
    assert data["done"][0]["job_id"] == "job-1"
    assert data["done"][0]["command_hash"] == "command-hash-1"
    assert data["done"][0]["queue_id"] == "queue-1"
    assert data["done"][0]["slots_per_gpu"] == 2
    assert data["done"][0]["wrapper_path"] == "/tmp/wrapper.sh"
    assert data["done"][0]["placement_hash"] == "placement-1"
    assert data["done"][0]["policy_snapshot"] == {"slots_per_gpu": 2}


def test_finished_job_from_running_copies_lifecycle_metadata():
    running = RunningJob(
        exp_name="exp-1",
        hostname="turing1",
        pid=123,
        gpu_index=0,
        log_path="/tmp/exp-1.log",
        started_at=10.0,
        job_id="job-1",
        command_hash="command-hash-1",
        queue_id="queue-1",
        slots_per_gpu=2,
        wrapper_path="/tmp/wrapper.sh",
        placement_hash="placement-1",
        policy_snapshot={"slots_per_gpu": 2},
    )

    finished = FinishedJob.from_running(running, exit_code=7, finished_at=20.0)

    assert finished.exp_name == "exp-1"
    assert finished.hostname == "turing1"
    assert finished.gpu_index == 0
    assert finished.log_path == "/tmp/exp-1.log"
    assert finished.started_at == 10.0
    assert finished.finished_at == 20.0
    assert finished.exit_code == 7
    assert finished.job_id == "job-1"
    assert finished.command_hash == "command-hash-1"
    assert finished.queue_id == "queue-1"
    assert finished.slots_per_gpu == 2
    assert finished.wrapper_path == "/tmp/wrapper.sh"
    assert finished.placement_hash == "placement-1"
    assert finished.policy_snapshot == {"slots_per_gpu": 2}


def test_finished_job_from_running_preserves_explicit_zero_finished_at():
    running = RunningJob(
        exp_name="exp-1",
        hostname="turing1",
        pid=123,
        gpu_index=0,
        log_path="/tmp/exp-1.log",
        started_at=0.0,
    )

    finished = FinishedJob.from_running(running, exit_code=0, finished_at=0.0)

    assert finished.finished_at == 0.0


def test_jobs_match_experiment_name_or_queue_scoped_job_id():
    running = RunningJob(
        exp_name="exp-1",
        hostname="turing1",
        pid=123,
        gpu_index=0,
        log_path="/tmp/exp-1.log",
        started_at=0.0,
        job_id="queue:exp-1",
    )
    finished = FinishedJob.from_running(running, exit_code=0, finished_at=1.0)

    assert running.matches("exp-1")
    assert running.matches("queue:exp-1")
    assert not running.matches("missing")
    assert finished.matches("exp-1")
    assert finished.matches("queue:exp-1")
    assert not finished.matches("missing")


def test_mark_failed_preserves_running_job_metadata():
    state = SchedulerState(running=[RunningJob(
        exp_name="exp-1",
        hostname="turing1",
        pid=123,
        gpu_index=0,
        log_path="/tmp/exp-1.log",
        started_at=10.0,
        job_id="job-1",
        command_hash="command-hash-1",
        queue_id="queue-1",
        slots_per_gpu=2,
        wrapper_path="/tmp/wrapper.sh",
        placement_hash="placement-1",
        policy_snapshot={"slots_per_gpu": 2},
    )])

    assert state.mark_failed("exp-1", exit_code=7, finished_at=20.0) is True

    assert state.running == []
    assert state.failed[0].job_id == "job-1"
    assert state.failed[0].command_hash == "command-hash-1"
    assert state.failed[0].queue_id == "queue-1"
    assert state.failed[0].slots_per_gpu == 2
    assert state.failed[0].wrapper_path == "/tmp/wrapper.sh"
    assert state.failed[0].placement_hash == "placement-1"
    assert state.failed[0].policy_snapshot == {"slots_per_gpu": 2}


def test_initialise_rejects_non_legacy_queue_hash_mismatch(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({
        "version": 1,
        "queue_id": "queue-1",
        "queue_hash": "old-hash",
        "created_at": 1.0,
        "updated_at": 1.0,
        "pending": [],
        "running": [],
        "done": [],
        "failed": [],
        "last_blocked_notify": 0.0,
        "blocked_notify_count": 0,
    }), encoding="utf-8")

    with pytest.raises(ValueError, match="queue_hash mismatch"):
        SchedulerState.initialise(["exp-1"], state_path, queue_id="queue-1", queue_hash="new-hash")


def test_initialise_allows_placement_hash_change_when_experiment_hash_matches(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({
        "version": 2,
        "queue_id": "queue-1",
        "queue_hash": "old-combined",
        "experiment_hash": "experiment-1",
        "placement_hash": "old-placement",
        "created_at": 1.0,
        "updated_at": 1.0,
        "pending": [],
        "running": [],
        "done": [],
        "failed": [],
    }), encoding="utf-8")

    state = SchedulerState.initialise(
        ["exp-1"],
        state_path,
        queue_id="queue-1",
        queue_hash="new-combined",
        experiment_hash="experiment-1",
        placement_hash="new-placement",
    )

    assert state.queue_hash == "new-combined"
    assert state.experiment_hash == "experiment-1"
    assert state.placement_hash == "new-placement"


def test_initialise_rejects_experiment_hash_mismatch(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({
        "version": 2,
        "queue_id": "queue-1",
        "queue_hash": "old-combined",
        "experiment_hash": "experiment-1",
        "placement_hash": "placement-1",
        "created_at": 1.0,
        "updated_at": 1.0,
        "pending": [],
        "running": [],
        "done": [],
        "failed": [],
    }), encoding="utf-8")

    with pytest.raises(ValueError, match="experiment_hash mismatch"):
        SchedulerState.initialise(
            ["exp-1"],
            state_path,
            queue_id="queue-1",
            queue_hash="new-combined",
            experiment_hash="experiment-2",
            placement_hash="placement-1",
        )


def test_save_creates_backup_before_atomic_replace(tmp_path):
    state_path = tmp_path / "state.json"
    old_payload = {"pending": ["old"], "running": [], "done": [], "failed": []}
    state_path.write_text(json.dumps(old_payload), encoding="utf-8")

    state = SchedulerState(pending=["new"])
    state.save(state_path)

    backup_path = tmp_path / "state.json.bak"
    assert backup_path.is_file()
    assert json.loads(backup_path.read_text(encoding="utf-8")) == old_payload
    assert json.loads(state_path.read_text(encoding="utf-8"))["pending"] == ["new"]


def test_mark_done_and_failed_missing_jobs_return_false():
    state = SchedulerState()

    assert state.mark_done("missing", exit_code=0) is False
    assert state.mark_failed("missing", exit_code=-1) is False
    assert state.running == []
    assert state.done == []
    assert state.failed == []


def test_refresh_heartbeat_is_persisted(tmp_path):
    state_path = tmp_path / "state.json"
    state = SchedulerState(queue_id="queue", queue_hash="hash")

    state.refresh_heartbeat()
    state.save(state_path)
    loaded = SchedulerState.load(state_path)

    assert loaded.heartbeat_at > 0
    assert loaded.scheduler_pid is not None
    assert loaded.scheduler_host
