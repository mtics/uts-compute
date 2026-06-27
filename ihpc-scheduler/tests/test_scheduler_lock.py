import pytest

from src.scheduler.lock import SchedulerLock


def test_scheduler_lock_blocks_second_owner(tmp_path):
    state_path = tmp_path / "state.json"
    first = SchedulerLock(state_path, "queue")
    first.acquire()
    try:
        second = SchedulerLock(state_path, "queue")
        with pytest.raises(RuntimeError, match="already held"):
            second.acquire()
    finally:
        first.release()

    assert not state_path.with_name("state.json.lock").exists()
