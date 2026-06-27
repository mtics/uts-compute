from __future__ import annotations

import base64
import shlex

import pytest

from src.scanner.config import AccountConfig
from src.scanner.infra import ssh as ssh_module
from src.scanner.infra.ssh import SSHPool
from src.scheduler.config import Experiment, NodeConfig, SchedulerConfig
from src.scheduler.submitter import connect_node, explain_gpu_slots, find_free_gpu, submit_job


class FakeSSHClient:
    def __init__(self, output: str) -> None:
        self.hostname = "node1"
        self.output = output
        self.commands: list[tuple[str, bool]] = []

    def exec_command(self, command: str, *, read_line: bool = False) -> str:
        self.commands.append((command, read_line))
        return self.output


class MappingSSHClient:
    def __init__(self, gpu_output: str, apps_output: str) -> None:
        self.hostname = "node1"
        self.gpu_output = gpu_output
        self.apps_output = apps_output

    def exec_command(self, command: str, *, read_line: bool = False) -> str:
        if "--query-compute-apps" in command:
            return self.apps_output
        return self.gpu_output


class DummyTransport:
    def set_keepalive(self, seconds: int) -> None:
        self.keepalive = seconds

    def open_channel(self, kind: str, dest_addr: tuple[str, int], src_addr: tuple[str, int]):
        return object()


class DummyParamikoClient:
    def __init__(self, created: list["DummyParamikoClient"]) -> None:
        self.closed = False
        self.created = created
        self.transport = DummyTransport()
        created.append(self)

    def set_missing_host_key_policy(self, policy) -> None:
        self.policy = policy

    def connect(self, hostname: str, **kwargs) -> None:
        self.hostname = hostname

    def get_transport(self) -> DummyTransport:
        return self.transport

    def close(self) -> None:
        self.closed = True


def _decode_wrapper(remote_cmd: str) -> str:
    prefix = "printf %s "
    start = remote_cmd.index(prefix) + len(prefix)
    end = remote_cmd.index(" | base64 -d", start)
    token = remote_cmd[start:end]
    encoded = shlex.split(token)[0]
    return base64.b64decode(encoded).decode("utf-8")


def test_submit_job_writes_wrapper_and_preserves_param_overrides() -> None:
    client = FakeSSHClient("123\n")
    command = "python main.py --param_overrides '{\"ablation_mode\":\"x\"}'"
    experiment = Experiment(name="ablation", command=command)
    log_path = "/scratch/user/log dir/ablation.log"

    result = submit_job(client, experiment, 0, log_path, return_result=True)

    assert result.pid == 123
    assert result.wrapper_path == log_path + ".wrapper.sh"
    assert len(client.commands) == 1
    remote_cmd, read_line = client.commands[0]
    assert read_line is True
    assert "bash -lc" not in remote_cmd
    assert command not in remote_cmd
    assert shlex.quote(log_path) in remote_cmd
    assert shlex.quote(result.wrapper_path) in remote_cmd

    wrapper = _decode_wrapper(remote_cmd)
    assert command in wrapper
    assert "export CUDA_VISIBLE_DEVICES=0" in wrapper
    assert f"> {shlex.quote(log_path + '.exitcode')}" in wrapper


def test_submit_job_quotes_log_paths_with_spaces() -> None:
    client = FakeSSHClient("456\n")
    experiment = Experiment(name="cpu", command="python train.py", requires_gpu=False)
    log_path = "/tmp/logs with spaces/cpu run.log"

    pid = submit_job(client, experiment, None, log_path)

    assert pid == 456
    remote_cmd, _ = client.commands[0]
    assert f"mkdir -p {shlex.quote('/tmp/logs with spaces')}" in remote_cmd
    assert f"> {shlex.quote(log_path)}" in remote_cmd
    assert shlex.quote(log_path + ".wrapper.sh") in remote_cmd

    wrapper = _decode_wrapper(remote_cmd)
    assert "CUDA_VISIBLE_DEVICES" not in wrapper
    assert f"> {shlex.quote(log_path + '.exitcode')}" in wrapper


def test_find_free_gpu_respects_slots_per_gpu_capacity() -> None:
    raw = "0, 100, 1000\n1, 100, 1000\n"

    at_capacity = FakeSSHClient(raw)
    assert find_free_gpu(
        at_capacity,
        gpu_job_counts={0: 1, 1: 1},
        threshold_pct=50.0,
        slots_per_gpu=1,
    ) is None

    under_capacity = FakeSSHClient(raw)
    assert find_free_gpu(
        under_capacity,
        gpu_job_counts={0: 1, 1: 1},
        threshold_pct=50.0,
        slots_per_gpu=2,
    ) == 0


def test_find_free_gpu_skips_external_compute_processes() -> None:
    gpu_raw = (
        "0, 00000000:01:00.0, 100, 1000\n"
        "1, 00000000:02:00.0, 100, 1000\n"
    )
    apps_raw = "00000000:01:00.0, 111, python, 600\n"
    client = MappingSSHClient(gpu_raw, apps_raw)

    assert find_free_gpu(
        client,
        gpu_job_counts={},
        threshold_pct=50.0,
        slots_per_gpu=2,
        respect_external_processes=True,
    ) == 1


def test_find_free_gpu_allows_tracked_jobs_on_gpu_with_processes() -> None:
    gpu_raw = (
        "0, 00000000:01:00.0, 100, 1000\n"
        "1, 00000000:02:00.0, 100, 1000\n"
    )
    apps_raw = "00000000:01:00.0, 111, python, 600\n"
    client = MappingSSHClient(gpu_raw, apps_raw)

    assert find_free_gpu(
        client,
        gpu_job_counts={0: 1},
        threshold_pct=50.0,
        slots_per_gpu=2,
        allowed_gpus={0},
        respect_external_processes=True,
    ) == 0


def test_find_free_gpu_respects_blocked_gpus_and_min_free_memory() -> None:
    gpu_raw = (
        "0, 00000000:01:00.0, 100, 1000\n"
        "1, 00000000:02:00.0, 900, 1000\n"
        "2, 00000000:03:00.0, 100, 1000\n"
    )
    client = MappingSSHClient(gpu_raw, "")

    assert find_free_gpu(
        client,
        gpu_job_counts={},
        threshold_pct=5.0,
        slots_per_gpu=1,
        blocked_gpus={0},
        min_free_mem_mb=200,
    ) == 2


def test_find_free_gpu_prefers_fewer_tracked_jobs_before_memory() -> None:
    raw = (
        "0, 00000000:01:00.0, 400, 1000\n"
        "1, 00000000:02:00.0, 50, 1000\n"
    )
    client = MappingSSHClient(raw, "")

    assert find_free_gpu(
        client,
        gpu_job_counts={1: 1},
        threshold_pct=50.0,
        slots_per_gpu=2,
        respect_external_processes=False,
    ) == 0


def test_find_free_gpu_prefers_more_memory_when_tracked_jobs_tie() -> None:
    raw = (
        "0, 00000000:01:00.0, 400, 1000\n"
        "1, 00000000:02:00.0, 50, 1000\n"
    )
    client = MappingSSHClient(raw, "")

    assert find_free_gpu(
        client,
        gpu_job_counts={0: 1, 1: 1},
        threshold_pct=50.0,
        slots_per_gpu=2,
        respect_external_processes=False,
    ) == 1


def test_find_free_gpu_uses_same_policy_as_explain_gpu_slots() -> None:
    gpu_raw = (
        "0, 00000000:01:00.0, 100, 1000\n"
        "1, 00000000:02:00.0, 100, 1000\n"
        "2, 00000000:03:00.0, 900, 1000\n"
    )
    apps_raw = "00000000:01:00.0, 111, python, 600\n"
    explain_client = MappingSSHClient(gpu_raw, apps_raw)
    find_client = MappingSSHClient(gpu_raw, apps_raw)

    rows = explain_gpu_slots(
        explain_client,
        gpu_job_counts={1: 1},
        threshold_pct=50.0,
        slots_per_gpu=2,
        blocked_gpus={2},
        min_free_mem_mb=200,
        respect_external_processes=True,
    )
    selected = find_free_gpu(
        find_client,
        gpu_job_counts={1: 1},
        threshold_pct=50.0,
        slots_per_gpu=2,
        blocked_gpus={2},
        min_free_mem_mb=200,
        respect_external_processes=True,
    )

    assert selected == 1
    assert rows == [
        {
            "gpu": 0,
            "usable": False,
            "tracked_jobs": 0,
            "slots_per_gpu": 2,
            "free_mem_mb": 900.0,
            "free_pct": 90.0,
            "reason": "external compute process present",
        },
        {
            "gpu": 1,
            "usable": True,
            "tracked_jobs": 1,
            "slots_per_gpu": 2,
            "free_mem_mb": 900.0,
            "free_pct": 90.0,
            "reason": "usable",
        },
        {
            "gpu": 2,
            "usable": False,
            "tracked_jobs": 0,
            "slots_per_gpu": 2,
            "free_mem_mb": 100.0,
            "free_pct": 10.0,
            "reason": (
                "blocked by queue policy; free memory below floor (100 < 200 MiB); "
                "free memory below threshold (10% < 50%)"
            ),
        },
    ]


def test_explain_gpu_slots_reports_no_gpu_and_unparseable_rows() -> None:
    no_gpu = FakeSSHClient("NO_GPU\n")
    assert explain_gpu_slots(no_gpu, {}, threshold_pct=50.0) == [
        {"gpu": None, "usable": False, "reason": "no GPU reported by nvidia-smi"}
    ]

    malformed = FakeSSHClient("not,a,gpu,row\n0, 100, 1000\n")
    assert explain_gpu_slots(
        malformed,
        {},
        threshold_pct=50.0,
        respect_external_processes=False,
    ) == [
        {"gpu": None, "usable": False, "reason": "unparseable nvidia-smi row: not,a,gpu,row"},
        {
            "gpu": 0,
            "usable": True,
            "tracked_jobs": 0,
            "slots_per_gpu": 1,
            "free_mem_mb": 900.0,
            "free_pct": 90.0,
            "reason": "usable",
        },
    ]

    short_row = FakeSSHClient("0, 100\n1, 100, 1000\n")
    assert explain_gpu_slots(
        short_row,
        {},
        threshold_pct=50.0,
        respect_external_processes=False,
    ) == [
        {"gpu": None, "usable": False, "reason": "unparseable nvidia-smi row: 0, 100"},
        {
            "gpu": 1,
            "usable": True,
            "tracked_jobs": 0,
            "slots_per_gpu": 1,
            "free_mem_mb": 900.0,
            "free_pct": 90.0,
            "reason": "usable",
        },
    ]

    zero_total = FakeSSHClient("0, 100, 0\n1, 100, 1000\n")
    assert explain_gpu_slots(
        zero_total,
        {},
        threshold_pct=0.0,
        respect_external_processes=False,
    ) == [
        {
            "gpu": 0,
            "usable": False,
            "tracked_jobs": 0,
            "slots_per_gpu": 1,
            "free_mem_mb": -100.0,
            "free_pct": 0.0,
            "reason": "invalid memory total",
        },
        {
            "gpu": 1,
            "usable": True,
            "tracked_jobs": 0,
            "slots_per_gpu": 1,
            "free_mem_mb": 900.0,
            "free_pct": 90.0,
            "reason": "usable",
        },
    ]


def test_connect_node_rejects_non_queue_host(tmp_path) -> None:
    config = SchedulerConfig(
        my_nodes=[NodeConfig(hostname="turing1", gpu_count=3)],
        experiments=[Experiment(name="exp", command="echo exp")],
        account=AccountConfig(name="default", username="user"),
        state_path=tmp_path / "state.json",
        log_dir=tmp_path / "logs",
    )

    with pytest.raises(ValueError, match="non-queue node"):
        connect_node(config, "mars29")


def test_ssh_pool_close_closes_head_and_compute_node_clients(monkeypatch) -> None:
    created: list[DummyParamikoClient] = []

    monkeypatch.setattr(
        ssh_module.paramiko,
        "SSHClient",
        lambda: DummyParamikoClient(created),
    )

    pool = SSHPool(AccountConfig(name="default", username="user"))
    node_client = pool.connect_node("mars1")

    assert node_client.hostname == "mars1"
    assert len(created) == 2

    pool.close()

    assert all(client.closed for client in created)
