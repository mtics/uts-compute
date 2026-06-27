"""Job monitoring — checks PID liveness and reads exit codes.

Only connects to the user's own active session nodes.
"""

from __future__ import annotations

import base64
import logging
import shlex

from ..scanner.infra.ssh import SSHClient
from .state import RunningJob

logger = logging.getLogger(__name__)


def check_pid_alive(client: SSHClient, pid: int) -> bool:
    """Return True if the process is still running on the remote node."""
    # `kill -0 PID` returns 0 if the process exists, non-zero otherwise
    output = client.exec_command(f"kill -0 {pid} 2>/dev/null; echo $?")
    return output.strip() == "0"


def read_exit_code(client: SSHClient, log_path: str) -> int | None:
    """Read the exit code written by the job wrapper to ``<log_path>.exitcode``.

    Returns None if the file does not exist yet (process may still be running
    or was killed abnormally).
    """
    exitcode_path = log_path + ".exitcode"
    raw = client.exec_command(
        f"cat {shlex.quote(exitcode_path)} 2>/dev/null || echo MISSING"
    )
    raw = raw.strip()
    if raw == "MISSING":
        return None
    try:
        return int(raw)
    except ValueError:
        logger.warning("Unexpected exit code content at %s: %r", exitcode_path, raw)
        return None


def check_job(client: SSHClient, job: RunningJob) -> tuple[bool, int | None]:
    """Check whether a job is still running and return its exit code if done.

    Returns:
        (alive, exit_code):
          - (True,  None)   — job is still running
          - (False, 0)      — job finished successfully
          - (False, N)      — job finished with error (N != 0)
          - (False, None)   — job disappeared without writing exit code (killed)
    """
    alive = check_pid_alive(client, job.pid)
    if alive:
        return True, None

    exit_code = read_exit_code(client, job.log_path)
    return False, exit_code


def send_mail(client: SSHClient, to: str, subject: str, body: str) -> None:
    """Send an email via the cluster's ``mail`` command.

    The body is base64-encoded before transmission so that newlines and special
    characters in log output don't break shell quoting on the remote side.
    """
    b64 = base64.b64encode(body.encode()).decode()
    cmd = f"echo {b64} | base64 -d | mail -s {shlex.quote(subject)} {shlex.quote(to)}"
    client.exec_command(cmd)
    logger.info("Mail sent to %s: %s", to, subject)


def tail_log(client: SSHClient, log_path: str, lines: int = 40) -> str:
    """Return the last N lines of a job's log file."""
    raw = client.exec_command(
        f"tail -n {lines} {shlex.quote(log_path)} 2>/dev/null || echo '(log not found)'"
    )
    return raw
