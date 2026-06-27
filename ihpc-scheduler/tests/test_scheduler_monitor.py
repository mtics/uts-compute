from __future__ import annotations

import shlex

from src.scheduler.monitor import read_exit_code, tail_log


class FakeSSHClient:
    def __init__(self, output: str) -> None:
        self.output = output
        self.commands: list[str] = []

    def exec_command(self, command: str, *, read_line: bool = False) -> str:
        self.commands.append(command)
        return self.output


def test_read_exit_code_quotes_path_with_spaces() -> None:
    client = FakeSSHClient("7\n")
    log_path = "/scratch/log dir/run one.log"

    assert read_exit_code(client, log_path) == 7

    assert client.commands == [
        f"cat {shlex.quote(log_path + '.exitcode')} 2>/dev/null || echo MISSING"
    ]


def test_tail_log_quotes_path_with_spaces() -> None:
    client = FakeSSHClient("last lines")
    log_path = "/scratch/log dir/run one.log"

    assert tail_log(client, log_path, lines=5) == "last lines"

    assert client.commands == [
        f"tail -n 5 {shlex.quote(log_path)} 2>/dev/null || echo '(log not found)'"
    ]
