"""Remote shell command construction for scheduler submissions."""

from __future__ import annotations

import base64
import posixpath
import shlex
from dataclasses import dataclass


@dataclass(frozen=True)
class SubmissionResult:
    """Metadata returned by a remote job submission."""

    pid: int
    wrapper_path: str


def make_exitcode_path(log_path: str) -> str:
    """Return the remote exit-code path for a log file."""
    return log_path + ".exitcode"


def make_wrapper_path(log_path: str) -> str:
    """Return the remote wrapper script path for a log file."""
    return log_path + ".wrapper.sh"


def build_wrapper_script(
    command: str,
    gpu_index: int | None,
    exitcode_path: str,
) -> str:
    """Build the remote wrapper script content."""
    lines = [
        "#!/usr/bin/env bash",
        "set +e",
    ]
    if gpu_index is not None:
        lines.append(f"export CUDA_VISIBLE_DEVICES={gpu_index}")
    lines.extend([
        command,
        "status=$?",
        f"printf '%s\\n' \"$status\" > {shlex.quote(exitcode_path)}",
        'exit "$status"',
        "",
    ])
    return "\n".join(lines)


def build_submission_command(
    wrapper_script: str,
    wrapper_path: str,
    log_path: str,
) -> str:
    """Build the remote command that writes and launches the wrapper."""
    log_dir = posixpath.dirname(log_path) or "."
    wrapper_b64 = base64.b64encode(wrapper_script.encode("utf-8")).decode("ascii")
    quoted_wrapper = shlex.quote(wrapper_path)
    return (
        f"mkdir -p {shlex.quote(log_dir)} && "
        f"printf %s {shlex.quote(wrapper_b64)} | base64 -d > {quoted_wrapper} && "
        f"chmod 700 {quoted_wrapper} && "
        f"(setsid nohup bash -l {quoted_wrapper} > {shlex.quote(log_path)} "
        "2>&1 </dev/null & echo $!)"
    )
