"""Small file lock for one scheduler process per queue state."""

from __future__ import annotations

import json
import os
import socket
import time
from pathlib import Path


class SchedulerLock:
    """Best-effort process lock scoped to one scheduler state file."""

    def __init__(self, state_path: Path, queue_id: str) -> None:
        self.path = state_path.with_name(f"{state_path.name}.lock")
        self.queue_id = queue_id
        self.pid = os.getpid()
        self.hostname = socket.gethostname()
        self._owned = False

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                self._write_new_lock()
                self._owned = True
                return
            except FileExistsError:
                self._remove_stale_lock()

    def refresh(self) -> None:
        if self._owned:
            self.path.write_text(json.dumps(self._payload(), indent=2), encoding="utf-8")

    def is_held_by_live_process(self) -> bool:
        """Return True when another active scheduler owns this queue lock."""
        if not self.path.is_file():
            return False
        return self._payload_alive(self._read_payload())

    def release(self) -> None:
        if self._owned and self.path.is_file():
            payload = self._read_payload()
            if payload.get("pid") == self.pid and payload.get("hostname") == self.hostname:
                self.path.unlink()
        self._owned = False

    def _write_new_lock(self) -> None:
        fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(self._payload(), handle, indent=2)

    def _payload(self) -> dict[str, object]:
        now = time.time()
        return {
            "queue_id": self.queue_id,
            "pid": self.pid,
            "hostname": self.hostname,
            "updated_at": now,
        }

    def _read_payload(self) -> dict[str, object]:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _remove_stale_lock(self) -> None:
        stat = self.path.stat()
        payload = self._read_payload()
        if self._payload_alive(payload):
            raise RuntimeError(
                f"scheduler lock already held by pid={payload.get('pid')} "
                f"host={payload.get('hostname')} path={self.path}"
            )
        current = self.path.stat()
        if current.st_mtime_ns != stat.st_mtime_ns or current.st_size != stat.st_size:
            return
        self.path.unlink()

    def _payload_alive(self, payload: dict[str, object]) -> bool:
        if payload.get("hostname") != self.hostname:
            return True
        pid = int(payload["pid"])
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True
