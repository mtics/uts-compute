"""Command-line interface for the experiment scheduler."""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import logging
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import asdict
from json import JSONDecodeError
from pathlib import Path

import yaml

from ..scanner.infra.ssh import SSHPool
from .config import (
    Experiment,
    SchedulerConfig,
    load_queue,
    load_queue_from_raw,
    queue_identity,
)
from .lock import SchedulerLock
from .monitor import tail_log
from .placement import NodeSlots, running_placement_issues
from .scheduler import Scheduler
from .state import FinishedJob, RunningJob, SchedulerState
from .submitter import connect_node, explain_gpu_slots


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ihpc-sched",
        description="iHPC experiment scheduler — runs jobs on your active session nodes.",
    )
    p.add_argument(
        "--queue", metavar="PATH",
        help="Path to queue.yaml (default: auto-detect)",
    )
    p.add_argument(
        "--hardware", metavar="PATH",
        help="Path to hardware.yaml (default: auto-detect)",
    )
    p.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging",
    )

    sub = p.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="Start the scheduler loop (blocking; run inside tmux)")
    start.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the queue/state plan without writing state or submitting jobs",
    )

    status = sub.add_parser("status", help="Show current queue state without touching remote nodes")
    status.add_argument("--json", action="store_true", dest="json_output", help="Emit machine-readable JSON")
    status.add_argument("--limit", type=int, default=20, help="Rows per section to print in text mode")
    status.add_argument("--all", action="store_true", help="Print all rows in text mode")
    status.add_argument(
        "--explain",
        action="store_true",
        help="Probe only this queue's my_nodes and explain why pending jobs cannot dispatch",
    )

    doctor = sub.add_parser("doctor", help="Audit queue/state safety without touching remote nodes")
    doctor.add_argument(
        "--probe-nodes",
        action="store_true",
        help="Use head-node cnode output to check Connect status for this queue's my_nodes only",
    )

    report = sub.add_parser("report", aliases=["runs"], help="Read-only report for all queue-scoped states")
    report.add_argument("--json", action="store_true", dest="json_output", help="Emit machine-readable JSON")
    report.add_argument("--limit", type=int, default=20, help="Rows to print in text mode")

    artifacts = sub.add_parser("artifacts", help="Build a read-only JSON index from scheduler states")
    artifacts.add_argument("--output", metavar="PATH", help="Write JSON index to this path")
    artifacts.add_argument(
        "--status",
        choices=["all", "running", "done", "failed"],
        default="all",
        help="Filter indexed job status",
    )

    archive = sub.add_parser("archive", help="Move completed queue states to archive (dry-run by default)")
    archive.add_argument("--execute", action="store_true", help="Actually move completed states")
    archive.add_argument("--limit", type=int, default=20, help="Rows to print in dry-run text mode")

    migrate = sub.add_parser("migrate-state", help="Adopt the current queue hash in an existing scoped state")
    migrate.add_argument("--execute", action="store_true", help="Actually update state")

    mutate = sub.add_parser("mutate", help="Safely edit queue scheduling metadata and adopt state")
    mutate.add_argument("--set-slots", type=int, help="Set queue-local scheduler.slots_per_gpu")
    mutate.add_argument("--add-node", help="Add or replace a node in my_nodes")
    mutate.add_argument("--remove-node", help="Remove a node from my_nodes")
    mutate.add_argument("--replace-node", help="Replace one node with another, format OLD:NEW")
    mutate.add_argument("--gpus", help="Comma-separated allowed GPUs for --add-node")
    mutate.add_argument("--block-gpus", help="Comma-separated blocked GPUs for --add-node")
    mutate.add_argument("--execute", action="store_true", help="Actually write queue/state")

    retry = sub.add_parser("retry", help="Requeue failed jobs by exact job id or experiment name")
    retry.add_argument("job_ids", nargs="+", metavar="job-id", help="Exact job id/name(s)")
    retry.add_argument("--execute", action="store_true", help="Actually write state")

    kill = sub.add_parser("kill", help="Cancel running jobs by exact job id or experiment name")
    kill.add_argument("job_ids", nargs="+", metavar="job-id", help="Exact job id/name(s)")
    kill.add_argument("--execute", action="store_true", help="Actually send SIGTERM and write state")

    logs = sub.add_parser("logs", help="Tail a job's stdout/stderr log")
    logs.add_argument("job_id", help="Exact job id or experiment name")
    logs.add_argument("-n", "--lines", type=int, default=40, help="Number of lines to show")

    tmux = sub.add_parser("tmux", help="Thin tmux wrapper for this queue")
    tmux_sub = tmux.add_subparsers(dest="tmux_command", required=True)
    tmux_start = tmux_sub.add_parser("start", help="Start scheduler in a detached tmux session")
    tmux_start.add_argument("--session", help="tmux session name; defaults to a safe queue-scoped name")
    tmux_start.add_argument("--force", action="store_true", help="Allow a custom non-default session name")
    tmux_start.add_argument("--dry-run", action="store_true", help="Print command only")
    tmux_status = tmux_sub.add_parser("status", help="Check whether a tmux session exists")
    tmux_status.add_argument("--session", help="tmux session name; defaults to this queue's safe name")
    tmux_stop = tmux_sub.add_parser("stop", help="Send Ctrl-C to a tmux scheduler session")
    tmux_stop.add_argument("--session", help="tmux session name; defaults to this queue's safe name")
    tmux_stop.add_argument("--force", action="store_true", help="Stop even if the session name is not queue-scoped")

    p.add_argument(
        "--print-contract-version",
        action="store_true",
        help="Print the scheduler contract version and exit",
    )
    return p


def main(argv: list[str] | None = None) -> None:
    raw_argv = sys.argv[1:] if argv is None else argv
    if "--print-contract-version" in raw_argv:
        from ._contract import contract_version

        print(contract_version())
        return

    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("paramiko").setLevel(logging.WARNING)

    try:
        config = load_queue(
            queue_path=args.queue,
            hardware_path=getattr(args, "hardware", None),
        )
    except (FileNotFoundError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    if args.command == "start":
        _cmd_start(config, dry_run=args.dry_run)
    elif args.command == "status":
        _cmd_status(
            config,
            limit=args.limit,
            show_all=args.all,
            json_output=args.json_output,
            explain=args.explain,
        )
    elif args.command == "doctor":
        _cmd_doctor(config, probe_nodes=args.probe_nodes)
    elif args.command in {"report", "runs"}:
        _cmd_report(config, limit=args.limit, json_output=args.json_output)
    elif args.command == "artifacts":
        _cmd_artifacts(config, output=args.output, status=args.status)
    elif args.command == "archive":
        _cmd_archive(config, limit=args.limit, execute=args.execute)
    elif args.command == "migrate-state":
        _cmd_migrate_state(config, execute=args.execute)
    elif args.command == "mutate":
        _cmd_mutate(
            config,
            set_slots=args.set_slots,
            add_node=args.add_node,
            remove_node=args.remove_node,
            replace_node=args.replace_node,
            gpus=args.gpus,
            block_gpus=args.block_gpus,
            execute=args.execute,
        )
    elif args.command == "retry":
        _cmd_retry(config, args.job_ids, execute=args.execute)
    elif args.command == "kill":
        _cmd_kill(config, args.job_ids, execute=args.execute)
    elif args.command == "logs":
        _cmd_logs(config, args.job_id, args.lines)
    elif args.command == "tmux":
        _cmd_tmux(config, args)


def _cmd_start(config: SchedulerConfig, *, dry_run: bool) -> None:
    if dry_run:
        _cmd_doctor(config)
        print()
        print("DRY-RUN: scheduler was not started and state was not written.")
        return

    state = SchedulerState.load(config.state_path)
    issues = _blocking_state_issues(config, state)
    if issues:
        _print_blocking_issues(issues)
        sys.exit(1)

    lock = SchedulerLock(config.state_path, config.queue_id)
    lock.acquire()
    try:
        scheduler = Scheduler(config, lock=lock)
        scheduler.run_forever()
    finally:
        lock.release()


def _cmd_status(
    config: SchedulerConfig,
    *,
    limit: int = 20,
    show_all: bool = False,
    json_output: bool = False,
    explain: bool = False,
) -> None:
    state = SchedulerState.load(config.state_path)

    if json_output:
        print(json.dumps(_state_summary(config, state), indent=2))
        return

    print(f"Queue id   : {config.queue_id}")
    print(f"Queue hash : {config.queue_hash[:12]}")
    print(f"Experiment : {config.experiment_hash[:12]}")
    print(f"Placement  : {config.placement_hash[:12]}")
    print(f"State path : {config.state_path}")
    print(f"Nodes      : {_format_nodes(config)}")
    print(f"Slots/GPU  : {config.slots_per_gpu}")
    if state.heartbeat_at:
        ts = datetime.datetime.fromtimestamp(state.heartbeat_at).strftime("%m-%d %H:%M")
        print(f"Heartbeat  : {ts} pid={state.scheduler_pid} host={state.scheduler_host}")
    print()

    _print_state_warnings(config, state)
    _print_running(config, state.running, limit=limit, show_all=show_all)
    print()
    _print_pending(config, state.pending, limit=limit, show_all=show_all)
    _print_finished("DONE", state.done, limit=limit, show_all=show_all)
    _print_finished("FAILED", state.failed, limit=limit, show_all=show_all)
    if explain and state.pending:
        print()
        _print_dispatch_explain(config, state)


def _cmd_doctor(config: SchedulerConfig, *, probe_nodes: bool = False) -> None:
    state = SchedulerState.load(config.state_path)

    print("QUEUE")
    print(f"  id        : {config.queue_id}")
    print(f"  hash      : {config.queue_hash}")
    print(f"  experiment: {config.experiment_hash}")
    print(f"  placement : {config.placement_hash}")
    print(f"  state_path: {config.state_path}")
    print(f"  nodes     : {_format_nodes(config)}")
    print(f"  slots/GPU : {config.slots_per_gpu}")
    print(f"  jobs      : {len(config.experiments)}")
    print(f"  tmux      : {default_tmux_session(config)}")
    print()

    print("STATE")
    if config.state_path.is_file():
        print("  present   : yes")
        print(f"  legacy    : {'yes' if state.is_legacy else 'no'}")
        print(f"  queue_id  : {state.queue_id}")
        print(f"  queue_hash: {state.queue_hash}")
        print(f"  experiment: {state.experiment_hash}")
        print(f"  placement : {state.placement_hash}")
    else:
        print("  present   : no")
    print(
        f"  counts    : pending={len(state.pending)} running={len(state.running)} "
        f"done={len(state.done)} failed={len(state.failed)}"
    )
    legacy_path = _legacy_state_path(config)
    if legacy_path is not None and legacy_path.is_file() and legacy_path != config.state_path:
        legacy_state = SchedulerState.load(legacy_path)
        print()
        print("LEGACY GLOBAL STATE")
        print(f"  path      : {legacy_path}")
        print(
            f"  counts    : pending={len(legacy_state.pending)} running={len(legacy_state.running)} "
            f"done={len(legacy_state.done)} failed={len(legacy_state.failed)}"
        )
    sibling_paths = _sibling_scoped_state_paths(config)
    if sibling_paths:
        print()
        print("OTHER SCOPED STATES")
        for path in sibling_paths:
            sibling = SchedulerState.load(path)
            print(
                f"  {path.name}: pending={len(sibling.pending)} running={len(sibling.running)} "
                f"done={len(sibling.done)} failed={len(sibling.failed)}"
            )
    print()

    if probe_nodes:
        print("NODE PROBE")
        for row in _probe_queue_nodes(config):
            print(f"  {row['hostname']:<12} connect={row['connect']} source={row['source']}")
        print()

    issues = _blocking_state_issues(config, state)
    warnings = [issue for issue in _state_issues(config, state) if issue not in issues]
    print("DOCTOR")
    if not issues:
        print("  OK: state is compatible with this queue.")
    else:
        for issue in issues:
            print(f"  - {issue}")
    if warnings:
        print()
        print("WARNINGS")
        for warning in warnings:
            print(f"  - {warning}")

    print()
    print("PLAN")
    if issues:
        print("  start/retry/kill will refuse to execute until these issues are resolved.")
    elif config.state_path.is_file():
        print("  start can resume this queue-scoped state.")
    else:
        print("  start will create a fresh queue-scoped state with all jobs pending.")
    print()
    print("ACTIONABLE PLAN")
    print(f"  tmux start: ihpc-sched --queue {shlex.quote(str(config.queue_path))} tmux start")
    print(f"  tmux check: ihpc-sched --queue {shlex.quote(str(config.queue_path))} tmux status")
    if not probe_nodes:
        print("  node check: add --probe-nodes to doctor for head-node cnode Connect status")
    if issues:
        print("  next      : resolve the safety issues above before starting this queue")


def _state_summary(config: SchedulerConfig, state: SchedulerState) -> dict:
    return {
        "queue": {
            "id": config.queue_id,
            "hash": config.queue_hash,
            "experiment_hash": config.experiment_hash,
            "placement_hash": config.placement_hash,
            "state_path": str(config.state_path),
            "slots_per_gpu": config.slots_per_gpu,
            "nodes": [asdict(node) for node in config.my_nodes],
        },
        "state": {
            "present": config.state_path.is_file(),
            "legacy": state.is_legacy,
            "queue_id": state.queue_id,
            "queue_hash": state.queue_hash,
            "experiment_hash": state.experiment_hash,
            "placement_hash": state.placement_hash,
            "heartbeat_at": state.heartbeat_at,
            "scheduler_pid": state.scheduler_pid,
            "scheduler_host": state.scheduler_host,
            "provenance": {
                "queue_path": state.queue_path,
                "launch_command": state.launch_command,
                "tmux_session": state.tmux_session,
                "node_policy_snapshot": state.node_policy_snapshot,
                "scheduler_settings_snapshot": state.scheduler_settings_snapshot,
            },
            "counts": {
                "pending": len(state.pending),
                "running": len(state.running),
                "remaining": len(state.pending) + len(state.running),
                "done": len(state.done),
                "failed": len(state.failed),
            },
            "pending": state.pending,
            "running": [asdict(job) for job in state.running],
            "done": [asdict(job) for job in state.done],
            "failed": [asdict(job) for job in state.failed],
        },
        "blocking_issues": _blocking_state_issues(config, state),
        "warnings": _state_issues(config, state),
    }


def _format_nodes(config: SchedulerConfig) -> str:
    parts: list[str] = []
    for node in config.my_nodes:
        details: list[str] = []
        if node.allowed_gpus is not None:
            details.append("gpus=" + ",".join(str(gpu) for gpu in node.allowed_gpus))
        if node.blocked_gpus is not None:
            details.append("block=" + ",".join(str(gpu) for gpu in node.blocked_gpus))
        if node.slots_per_gpu is not None:
            details.append(f"slots={node.slots_per_gpu}")
        parts.append(f"{node.hostname}({';'.join(details)})" if details else node.hostname)
    return ", ".join(parts)


def _print_state_warnings(config: SchedulerConfig, state: SchedulerState) -> None:
    issues = _state_issues(config, state)
    if not issues:
        return
    print("WARNINGS")
    for issue in issues:
        print(f"  - {issue}")
    print()


def _print_running(config: SchedulerConfig, jobs: list[RunningJob], *, limit: int, show_all: bool) -> None:
    print(f"RUNNING ({len(jobs)})")
    exp_by_name = config.experiments_by_name()
    for j in _limited(jobs, limit, show_all):
        gpu = f"GPU:{j.gpu_index}" if j.gpu_index is not None else "CPU"
        job_id = j.job_id or "(legacy)"
        policy = _policy_note(config, j)
        command_note = _command_note(exp_by_name.get(j.exp_name), j.command_hash)
        print(
            f"  {j.exp_name:<30}  {j.hostname}  {gpu}  PID:{j.pid}  "
            f"job_id:{job_id}{policy}{command_note}"
        )
    _print_hidden_count(len(jobs), limit, show_all)


def _print_pending(config: SchedulerConfig, names: list[str], *, limit: int, show_all: bool) -> None:
    print(f"PENDING ({len(names)})")
    exp_by_name = config.experiments_by_name()
    for name in _limited(names, limit, show_all):
        exp = exp_by_name.get(name)
        job_id = exp.job_id if exp else "(unknown)"
        print(f"  {name:<30}  job_id:{job_id}")
    _print_hidden_count(len(names), limit, show_all)


def _print_finished(label: str, jobs: list[FinishedJob], *, limit: int, show_all: bool) -> None:
    print(f"{label} ({len(jobs)})")
    for j in _limited(jobs, limit, show_all):
        ts = datetime.datetime.fromtimestamp(j.finished_at).strftime("%m-%d %H:%M")
        job_id = j.job_id or "(legacy)"
        print(f"  {j.exp_name:<30}  exit:{j.exit_code}  {ts}  {j.hostname}  job_id:{job_id}")
    _print_hidden_count(len(jobs), limit, show_all)


def _limited(items: list, limit: int, show_all: bool) -> list:
    if show_all or limit < 1:
        return items
    return items[:limit]


def _print_hidden_count(total: int, limit: int, show_all: bool) -> None:
    if show_all or limit < 1 or total <= limit:
        return
    print(f"  ... {total - limit} more (use --all)")


def _cmd_migrate_state(config: SchedulerConfig, *, execute: bool) -> None:
    state = SchedulerState.load(config.state_path)
    if not config.state_path.is_file():
        print("No state file exists; nothing to migrate.")
        return

    issues = [
        issue for issue in _state_issues(config, state)
        if not _is_adoptable_identity_issue(issue, state)
    ]
    if issues:
        _print_blocking_issues(issues)
        if execute:
            sys.exit(1)

    print(f"{'Would adopt' if not execute else 'Adopt'} queue identity for {config.state_path}")
    print(f"  queue_id  : {state.queue_id!r} -> {config.queue_id!r}")
    print(f"  queue_hash: {state.queue_hash!r} -> {config.queue_hash!r}")
    print(f"  experiment: {state.experiment_hash!r} -> {config.experiment_hash!r}")
    print(f"  placement : {state.placement_hash!r} -> {config.placement_hash!r}")
    if not execute:
        print("DRY-RUN: pass --execute to write state.")
        return

    lock = SchedulerLock(config.state_path, config.queue_id)
    lock.acquire()
    try:
        state = SchedulerState.load(config.state_path)
        issues = [
            issue for issue in _state_issues(config, state)
            if not _is_adoptable_identity_issue(issue, state)
        ]
        if issues:
            _print_blocking_issues(issues)
            sys.exit(1)
        state.queue_id = config.queue_id
        state.queue_hash = config.queue_hash
        state.experiment_hash = config.experiment_hash
        state.placement_hash = config.placement_hash
        state.save(config.state_path)
    finally:
        lock.release()


def _cmd_mutate(
    config: SchedulerConfig,
    *,
    set_slots: int | None,
    add_node: str | None,
    remove_node: str | None,
    replace_node: str | None,
    gpus: str | None,
    block_gpus: str | None,
    execute: bool,
) -> None:
    if config.queue_path is None:
        print("This queue has no resolved queue_path.", file=sys.stderr)
        sys.exit(1)
    if set_slots is None and add_node is None and remove_node is None and replace_node is None:
        print("No mutation requested.", file=sys.stderr)
        sys.exit(1)
    if replace_node is not None:
        old_node, new_node = _parse_replace_node(replace_node)
        if remove_node is not None or add_node is not None:
            print("--replace-node cannot be combined with --add-node or --remove-node", file=sys.stderr)
            sys.exit(1)
        remove_node = old_node
        add_node = new_node
    if set_slots is not None and set_slots < 1:
        print("--set-slots must be >= 1", file=sys.stderr)
        sys.exit(1)
    if gpus and block_gpus:
        print("--gpus and --block-gpus cannot be used together", file=sys.stderr)
        sys.exit(1)

    raw = yaml.safe_load(config.queue_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Invalid queue format in {config.queue_path}")

    state = SchedulerState.load(config.state_path)
    issues = _blocking_state_issues(config, state)
    if issues:
        _print_blocking_issues(issues)
        if execute:
            sys.exit(1)

    raw_nodes = list(raw.get("my_nodes", []))
    if remove_node:
        if not any(_node_entry_hostname(entry) == remove_node for entry in raw_nodes):
            print(f"Node not present in my_nodes: {remove_node}", file=sys.stderr)
            sys.exit(1)
        if any(job.hostname == remove_node for job in state.running):
            print(f"Refusing to remove node with running jobs: {remove_node}", file=sys.stderr)
            sys.exit(1)
        raw_nodes = [entry for entry in raw_nodes if _node_entry_hostname(entry) != remove_node]
    if add_node:
        new_entry: dict[str, object] = {"hostname": add_node}
        if gpus:
            new_entry["gpus"] = _parse_csv_ints(gpus)
        if block_gpus:
            new_entry["block_gpus"] = _parse_csv_ints(block_gpus)
        raw_nodes = [entry for entry in raw_nodes if _node_entry_hostname(entry) != add_node]
        raw_nodes.append(new_entry)
    raw["my_nodes"] = raw_nodes

    if set_slots is not None:
        scheduler_section = raw.get("scheduler")
        if scheduler_section is None:
            scheduler_section = {}
            raw["scheduler"] = scheduler_section
        scheduler_section["slots_per_gpu"] = set_slots

    new_queue_id, new_queue_hash = queue_identity(config.queue_path, raw)
    mutated = _validate_mutated_queue(config, raw, state)
    print(f"{'Would mutate' if not execute else 'Mutate'} {config.queue_path}")
    print(f"  queue_id  : {config.queue_id!r} -> {new_queue_id!r}")
    print(f"  queue_hash: {config.queue_hash!r} -> {new_queue_hash!r}")
    print(f"  experiment: {config.experiment_hash!r} -> {mutated.experiment_hash!r}")
    print(f"  placement : {config.placement_hash!r} -> {mutated.placement_hash!r}")
    print(f"  nodes     : {', '.join(_node_entry_hostname(entry) for entry in raw_nodes)}")
    if set_slots is not None:
        print(f"  slots/GPU : {config.slots_per_gpu} -> {set_slots}")
    if not execute:
        print("DRY-RUN: pass --execute to write queue and adopt state.")
        return

    lock = SchedulerLock(config.state_path, config.queue_id)
    if lock.is_held_by_live_process():
        _validate_live_mutation_is_expanding(
            config,
            set_slots=set_slots,
            add_node=add_node,
            remove_node=remove_node,
            replace_node=replace_node,
        )
        _write_queue_atomic(config.queue_path, raw)
        print("Live scheduler detected; it will adopt this placement update on its next poll.")
        return
    lock.acquire()
    try:
        state = SchedulerState.load(config.state_path)
        mutated = _validate_mutated_queue(config, raw, state)
        _write_queue_atomic(config.queue_path, raw)
        if config.state_path.is_file():
            state = SchedulerState.load(config.state_path)
            state.queue_id = new_queue_id
            state.queue_hash = new_queue_hash
            state.experiment_hash = mutated.experiment_hash
            state.placement_hash = mutated.placement_hash
            state.save(config.state_path)
    finally:
        lock.release()


def _cmd_tmux(config: SchedulerConfig, args: argparse.Namespace) -> None:
    session = args.session or default_tmux_session(config)
    if args.tmux_command == "start":
        if not args.force:
            _validate_queue_scoped_session(config, session)
        launch_command = _scheduler_launch_command(config)
        command = (
            f"IHPC_SCHED_TMUX_SESSION={shlex.quote(session)} "
            f"IHPC_SCHED_LAUNCH_COMMAND={shlex.quote(launch_command)} "
            f"{launch_command}"
        )
        if args.dry_run:
            print(f"tmux new-session -d -s {shlex.quote(session)} {shlex.quote(command)}")
            return
        subprocess.run(["tmux", "new-session", "-d", "-s", session, command], check=True)
        print(f"Started tmux session {session!r}.")
    elif args.tmux_command == "status":
        result = subprocess.run(
            ["tmux", "has-session", "-t", session],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print("running" if result.returncode == 0 else "not running")
    elif args.tmux_command == "stop":
        if not args.force:
            _validate_queue_scoped_session(config, session)
        subprocess.run(["tmux", "send-keys", "-t", session, "C-c"], check=True)
        print(f"Sent Ctrl-C to tmux session {session!r}.")


def _parse_csv_ints(text: str) -> list[int]:
    return [int(part.strip()) for part in text.split(",") if part.strip()]


def _parse_replace_node(text: str) -> tuple[str, str]:
    parts = [part.strip() for part in text.split(":", 1)]
    if len(parts) != 2 or not parts[0] or not parts[1]:
        print("--replace-node must use OLD:NEW", file=sys.stderr)
        sys.exit(1)
    return parts[0], parts[1]


def _abort_if_state_unsafe(config: SchedulerConfig, state: SchedulerState) -> None:
    issues = _state_issues(config, state)
    if issues:
        _print_blocking_issues(issues)
        sys.exit(1)


def _node_entry_hostname(entry) -> str:
    if isinstance(entry, dict):
        return str(entry["hostname"]).strip()
    return str(entry).strip() if entry is not None else ""


def _write_queue_atomic(queue_path: Path, raw: dict) -> None:
    temp_path = queue_path.with_name(f".{queue_path.name}.tmp")
    temp_path.write_text(yaml.safe_dump(raw, sort_keys=False, width=100000), encoding="utf-8")
    temp_path.replace(queue_path)


def _validate_live_mutation_is_expanding(
    config: SchedulerConfig,
    *,
    set_slots: int | None,
    add_node: str | None,
    remove_node: str | None,
    replace_node: str | None,
) -> None:
    if remove_node is not None or replace_node is not None:
        print("Live mutation may only add nodes or increase slots/GPU.", file=sys.stderr)
        sys.exit(1)
    if set_slots is not None and set_slots < config.slots_per_gpu:
        print("Live mutation may not decrease slots/GPU.", file=sys.stderr)
        sys.exit(1)
    if add_node is None:
        return
    if add_node.strip() in config.hosts():
        print("Live mutation may not rewrite an existing node policy.", file=sys.stderr)
        sys.exit(1)


def _validate_mutated_queue(config: SchedulerConfig, raw: dict, state: SchedulerState) -> SchedulerConfig:
    if config.queue_path is None:
        print("This queue has no resolved queue_path.", file=sys.stderr)
        sys.exit(1)
    mutated = load_queue_from_raw(
        raw,
        queue_path=config.queue_path,
        hardware_path=config.hardware_path,
        scanner_config_path=config.scanner_config_path,
    )
    if mutated.experiment_hash != config.experiment_hash:
        print("Mutation would change the experiment manifest.", file=sys.stderr)
        sys.exit(1)
    if state.experiment_hash is not None and mutated.experiment_hash != state.experiment_hash:
        print("Mutation would detach state from its experiment manifest.", file=sys.stderr)
        sys.exit(1)

    if not mutated.my_nodes:
        print("Mutation would leave the queue with no nodes.", file=sys.stderr)
        sys.exit(1)
    issues = running_placement_issues(mutated, state, previous=config, check_slots=True)
    if issues:
        print(issues[0].mutation_message(), file=sys.stderr)
        sys.exit(1)
    return mutated


def _validate_queue_scoped_session(config: SchedulerConfig, session: str) -> None:
    expected = default_tmux_session(config)
    if session != expected:
        print(f"Use queue-scoped session name {expected!r}, or pass --force.", file=sys.stderr)
        sys.exit(1)


def default_tmux_session(config: SchedulerConfig) -> str:
    """Return a safe, stable default tmux session name for one queue."""
    stem = config.queue_path.stem if config.queue_path is not None else config.queue_id
    safe_stem = _safe_identifier(stem)[:32] or "queue"
    identity = hashlib.sha1(config.queue_id.encode("utf-8")).hexdigest()[:8]
    return f"ihpc_{safe_stem}_{identity}"


def _scheduler_launch_command(config: SchedulerConfig) -> str:
    queue_arg = shlex.quote(str(config.queue_path)) if config.queue_path is not None else ""
    executable = _scheduler_executable()
    return f"{executable} --queue {queue_arg} start"


def _scheduler_executable() -> str:
    entrypoint = shutil.which("ihpc-sched")
    if entrypoint:
        return shlex.quote(entrypoint)
    return f"{shlex.quote(sys.executable)} -m src.scheduler.cli"


def _safe_identifier(text: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", text).strip("_")
    return re.sub(r"_+", "_", safe)


def _cmd_retry(config: SchedulerConfig, job_ids: list[str], *, execute: bool) -> None:
    state = SchedulerState.load(config.state_path)
    jobs = [_resolve_failed_job(state, token) for token in job_ids]
    missing = [token for token, job in zip(job_ids, jobs, strict=True) if job is None]
    if missing:
        print(f"Not failed in this state: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    issues = _state_issues(config, state)
    if issues:
        _print_blocking_issues(issues)
        if execute:
            sys.exit(1)

    for job in jobs:
        assert job is not None
        note = _execution_safety_note(config, job)
        print(f"{'Would requeue' if not execute else 'Requeue'} {job.exp_name} ({job.job_id}){note}")

    if not execute:
        print("DRY-RUN: pass --execute to write state.")
        return

    lock = SchedulerLock(config.state_path, config.queue_id)
    lock.acquire()
    try:
        state = SchedulerState.load(config.state_path)
        _abort_if_state_unsafe(config, state)
        jobs = [_resolve_failed_job(state, token) for token in job_ids]
        missing = [token for token, job in zip(job_ids, jobs, strict=True) if job is None]
        if missing:
            print(f"Not failed in this state: {', '.join(missing)}", file=sys.stderr)
            sys.exit(1)
        for job in jobs:
            assert job is not None
            if not _job_matches_current_command(config, job):
                print(f"Refusing to requeue stale command for {job.exp_name}", file=sys.stderr)
                sys.exit(1)
            state.requeue(job.job_id or job.exp_name)
        state.save(config.state_path)
    finally:
        lock.release()


def _cmd_kill(config: SchedulerConfig, job_ids: list[str], *, execute: bool) -> None:
    state = SchedulerState.load(config.state_path)
    jobs = [_resolve_running_job(state, token) for token in job_ids]
    missing = [token for token, job in zip(job_ids, jobs, strict=True) if job is None]
    if missing:
        print(f"Not running in this state: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    issues = _state_issues(config, state)
    if issues:
        _print_blocking_issues(issues)
        if execute:
            sys.exit(1)

    for job in jobs:
        assert job is not None
        if job.hostname not in config.hosts():
            print(f"Refusing foreign host for {job.exp_name}: {job.hostname}", file=sys.stderr)
            sys.exit(1)
        note = _execution_safety_note(config, job)
        print(
            f"{'Would kill' if not execute else 'Kill'} {job.exp_name} ({job.job_id}) "
            f"on {job.hostname} PID:{job.pid}{note}"
        )

    if not execute:
        print("DRY-RUN: pass --execute to send SIGTERM and write state.")
        return

    lock = SchedulerLock(config.state_path, config.queue_id)
    lock.acquire()
    try:
        state = SchedulerState.load(config.state_path)
        _abort_if_state_unsafe(config, state)
        jobs = [_resolve_running_job(state, token) for token in job_ids]
        missing = [token for token, job in zip(job_ids, jobs, strict=True) if job is None]
        if missing:
            print(f"Not running in this state: {', '.join(missing)}", file=sys.stderr)
            sys.exit(1)
        for job in jobs:
            assert job is not None
            if not _job_matches_current_command(config, job):
                print(f"Refusing to kill stale command for {job.exp_name}", file=sys.stderr)
                sys.exit(1)
            if not job.wrapper_path:
                print(f"Refusing to kill legacy job without wrapper_path: {job.exp_name}", file=sys.stderr)
                sys.exit(1)
            pool, client = connect_node(config, job.hostname)
            try:
                output = client.exec_command(_remote_kill_command(job))
                if "KILLED" not in output and "GONE" not in output:
                    print(f"Remote kill refused for {job.exp_name}: {output}", file=sys.stderr)
                    sys.exit(1)
            finally:
                pool.close()
            if not state.mark_failed(job.job_id or job.exp_name, exit_code=-1):
                print(f"Could not mark failed: {job.exp_name}", file=sys.stderr)
                sys.exit(1)
        state.save(config.state_path)
    finally:
        lock.release()


def _remote_kill_command(job: RunningJob) -> str:
    wrapper = shlex.quote(job.wrapper_path or "")
    return (
        "bash -lc "
        + shlex.quote(
            "\n".join([
                f"pid={job.pid}",
                f"wrapper={wrapper}",
                'if [ ! -d "/proc/$pid" ]; then echo GONE; exit 0; fi',
                'cmd=$(tr "\\0" " " < "/proc/$pid/cmdline" 2>/dev/null || true)',
                'case "$cmd" in *"$wrapper"*) ;; *) echo "MISMATCH:$cmd"; exit 22;; esac',
                'pgid=$(ps -o pgid= -p "$pid" | tr -d " ")',
                'if [ -z "$pgid" ]; then echo NO_PGID; exit 23; fi',
                'kill -- "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true',
                "sleep 1",
                'if pgrep -g "$pgid" >/dev/null 2>&1; then echo ALIVE; exit 24; fi',
                "echo KILLED",
            ])
        )
    )


def _cmd_logs(config: SchedulerConfig, job_id: str, lines: int) -> None:
    state = SchedulerState.load(config.state_path)
    job = _resolve_running_job(state, job_id)
    log_path: str | None = None
    hostname: str | None = None

    if job:
        log_path = job.log_path
        hostname = job.hostname
    else:
        finished = _resolve_finished_job(state, job_id)
        if finished:
            log_path = finished.log_path
            hostname = finished.hostname

    if log_path is None or hostname is None:
        print(f"No log found for '{job_id}'.", file=sys.stderr)
        sys.exit(1)

    if hostname not in config.hosts():
        print(f"Refusing to fetch logs from non-queue host: {hostname}", file=sys.stderr)
        sys.exit(1)

    pool, client = connect_node(config, hostname)
    try:
        output = tail_log(client, log_path, lines=lines)
    finally:
        pool.close()

    print(f"=== {job_id} ({hostname}:{log_path}) ===")
    print(output)


def _cmd_report(config: SchedulerConfig, *, limit: int, json_output: bool) -> None:
    rows = _collect_state_report_rows(config)
    if json_output:
        print(json.dumps({"states": rows}, indent=2))
        return

    print("SCHEDULER RUNS")
    print(f"  state_dir: {_state_dir(config)}")
    print()
    for row in rows[:limit]:
        print(
            f"{row['state_file']:<58} {row['status']:<13} "
            f"P/R/D/F={row['pending']}/{row['running']}/{row['done']}/{row['failed']} "
            f"remaining={row['remaining']} heartbeat={row['heartbeat']} tmux={row['tmux']}"
        )
        if row["hosts"]:
            print(f"  hosts   : {row['hosts']}")
        if row["pending_head"]:
            print(f"  pending : {row['pending_head']}")
        if row["failed_head"]:
            print(f"  failed  : {row['failed_head']}")
        if row["warning"]:
            print(f"  warning : {row['warning']}")
        if row["blocked_reason"]:
            print(f"  blocked : {row['blocked_reason']}")
    if len(rows) > limit:
        print(f"... {len(rows) - limit} more (use --limit to show more)")


def _cmd_artifacts(config: SchedulerConfig, *, output: str | None, status: str) -> None:
    rows = _collect_artifact_rows(config, status=status)
    payload = {"artifacts": rows}
    encoded = json.dumps(payload, indent=2)
    if output is None:
        print(encoded)
        return
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(encoded, encoding="utf-8")
    print(f"Wrote {len(rows)} artifact records to {output_path}")


def _cmd_archive(config: SchedulerConfig, *, limit: int, execute: bool) -> None:
    rows = [
        row for row in _collect_state_report_rows(config)
        if row["status"] == "complete" and not row["warning"]
    ]
    archive_dir = _state_dir(config) / "archive"
    print("ARCHIVE COMPLETED STATES")
    print(f"  target: {archive_dir}")
    if not rows:
        print("  nothing to archive")
        return

    for row in rows[:limit]:
        source = Path(row["path"])
        target = archive_dir / source.name
        action = "Archive" if execute else "Would archive"
        print(f"  {action} {source.name} -> {target}")
        if execute:
            archive_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target))
    if len(rows) > limit:
        print(f"  ... {len(rows) - limit} more (raise --limit to include them)")
    if not execute:
        print("DRY-RUN: pass --execute to move these state files.")


def _collect_artifact_rows(config: SchedulerConfig, *, status: str) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for path in sorted(_state_dir(config).glob("*.json")):
        state = SchedulerState.load(path)
        if status in {"all", "running"}:
            for job in state.running:
                rows.append(_artifact_record(path, state, job, "running"))
        if status in {"all", "done"}:
            for job in state.done:
                rows.append(_artifact_record(path, state, job, "done"))
        if status in {"all", "failed"}:
            for job in state.failed:
                rows.append(_artifact_record(path, state, job, "failed"))
    return rows


def _artifact_record(
    path: Path,
    state: SchedulerState,
    job: RunningJob | FinishedJob,
    status: str,
) -> dict[str, object]:
    record = {
        "state_file": path.name,
        "queue_id": state.queue_id,
        "queue_hash": state.queue_hash,
        "experiment_hash": state.experiment_hash,
        "placement_hash": state.placement_hash,
        "status": status,
        "job_id": job.job_id,
        "exp_name": job.exp_name,
        "hostname": job.hostname,
        "gpu_index": job.gpu_index,
        "log_path": job.log_path,
        "wrapper_path": job.wrapper_path,
        "command_hash": job.command_hash,
        "started_at": job.started_at,
        "slots_per_gpu": job.slots_per_gpu,
    }
    if isinstance(job, FinishedJob):
        record["finished_at"] = job.finished_at
        record["exit_code"] = job.exit_code
    return record


def _collect_state_report_rows(config: SchedulerConfig) -> list[dict[str, object]]:
    sessions = _tmux_sessions()
    rows: list[dict[str, object]] = []
    for path in sorted(_state_dir(config).glob("*.json")):
        try:
            state = SchedulerState.load(path)
            warning = ""
        except (JSONDecodeError, TypeError, ValueError) as exc:
            rows.append({
                "path": str(path),
                "state_file": path.name,
                "status": "unreadable",
                "pending": 0,
                "running": 0,
                "remaining": 0,
                "done": 0,
                "failed": 0,
                "heartbeat": "(unreadable)",
                "tmux": "(unknown)",
                "hosts": "",
                "pending_head": "",
                "failed_head": "",
                "blocked_reason": "unreadable state",
                "warning": str(exc),
            })
            continue

        tmux_session = state.tmux_session
        heartbeat = _format_heartbeat(state.heartbeat_at)
        status = _run_status(state, tmux_session, sessions)
        rows.append({
            "path": str(path),
            "state_file": path.name,
            "status": status,
            "pending": len(state.pending),
            "running": len(state.running),
            "remaining": len(state.pending) + len(state.running),
            "done": len(state.done),
            "failed": len(state.failed),
            "heartbeat": heartbeat,
            "tmux": _format_tmux_state(tmux_session, sessions),
            "hosts": _format_running_hosts(state),
            "pending_head": ", ".join(state.pending[:3]),
            "failed_head": ", ".join(
                job.exp_name for job in sorted(state.failed, key=lambda job: job.finished_at, reverse=True)[:3]
            ),
            "blocked_reason": _blocked_reason(state, status),
            "warning": warning,
        })
    return rows


def _state_dir(config: SchedulerConfig) -> Path:
    return config.state_path.parent if config.state_path.parent.name == "scheduler_state" else config.state_path.parent


def _tmux_sessions() -> set[str]:
    try:
        result = subprocess.run(["tmux", "ls"], capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return set()
    if result.returncode != 0:
        return set()
    sessions: set[str] = set()
    for line in result.stdout.splitlines():
        name = line.split(":", 1)[0].strip()
        if name:
            sessions.add(name)
    return sessions


def _format_heartbeat(heartbeat_at: float) -> str:
    if heartbeat_at <= 0:
        return "(none)"
    return datetime.datetime.fromtimestamp(heartbeat_at).strftime("%m-%d %H:%M")


def _run_status(state: SchedulerState, tmux_session: str | None, sessions: set[str]) -> str:
    active = bool(state.pending or state.running)
    if not active:
        return "complete"
    if state.heartbeat_at > 0 and time_since(state.heartbeat_at) > 900 and (tmux_session is None or tmux_session not in sessions):
        return "stale-active"
    return "active"


def _blocked_reason(state: SchedulerState, status: str) -> str:
    if not state.pending:
        return ""
    if status == "stale-active":
        return "stale scheduler heartbeat; resume or inspect tmux"
    if not state.running:
        return "pending with no running jobs; run status --explain for live node reasons"
    return "capacity limited by tracked running jobs or live GPU checks"


def time_since(timestamp: float) -> float:
    return datetime.datetime.now().timestamp() - timestamp


def _default_tmux_session_from_state(path: Path, state: SchedulerState) -> str:
    queue_id = state.queue_id or path.stem
    safe_stem = _safe_identifier(path.stem.rsplit("-", 1)[0])[:32] or "queue"
    identity = hashlib.sha1(queue_id.encode("utf-8")).hexdigest()[:8]
    return f"ihpc_{safe_stem}_{identity}"


def _format_tmux_state(tmux_session: str | None, sessions: set[str]) -> str:
    if tmux_session is None:
        return "unknown"
    if tmux_session in sessions:
        return "yes"
    return f"no:{tmux_session}"


def _format_running_hosts(state: SchedulerState) -> str:
    counts: dict[str, dict[str, int]] = {}
    for job in state.running:
        host = counts.setdefault(job.hostname, {})
        gpu = "CPU" if job.gpu_index is None else f"GPU{job.gpu_index}"
        host[gpu] = host.get(gpu, 0) + 1
    return "; ".join(
        f"{host} " + ",".join(f"{gpu}:{count}" for gpu, count in sorted(gpus.items()))
        for host, gpus in sorted(counts.items())
    )


def _probe_queue_nodes(config: SchedulerConfig) -> list[dict[str, str]]:
    wanted = config.hosts()
    clusters = sorted({_cluster_prefix(hostname) for hostname in wanted})
    seen: dict[str, str] = {}
    pool = SSHPool(
        config.account,
        head_node=config.head_node,
        ssh_timeout=config.ssh_timeout,
        command_timeout=config.command_timeout,
    )
    with pool:
        pool.connect_head()
        for cluster in clusters:
            output = pool.head.exec_command(f"cnode {shlex.quote(cluster)}")
            seen.update(_parse_cnode_connectivity(output, wanted))
    rows: list[dict[str, str]] = []
    for hostname in sorted(wanted):
        rows.append({
            "hostname": hostname,
            "connect": seen.get(hostname, "unknown"),
            "source": "head-node cnode",
        })
    return rows


def _cluster_prefix(hostname: str) -> str:
    return re.sub(r"\d+$", "", hostname.lower())


def _parse_cnode_connectivity(text: str, wanted: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[0] in wanted:
            result[parts[0]] = parts[2]
    return result


def _print_dispatch_explain(config: SchedulerConfig, state: SchedulerState) -> None:
    exp_name = state.pending[0]
    print(f"DISPATCH EXPLAIN ({exp_name})")
    for node in config.my_nodes:
        node_slots = NodeSlots.from_state(config, node, state)
        print(
            f"  {node.hostname}: tracked={node_slots.gpu_counts or {}} "
            f"slots/GPU={node_slots.slots_per_gpu}"
        )
        try:
            pool, client = connect_node(config, node.hostname)
        except Exception as exc:
            print(f"    cannot connect: {exc}")
            continue
        try:
            rows = explain_gpu_slots(client, **node_slots.gpu_probe_kwargs())
        finally:
            pool.close()
        for row in rows:
            print(
                f"    GPU {row['gpu']}: usable={row['usable']} "
                f"tracked={row.get('tracked_jobs', '-')} free={row.get('free_pct', '-')}% "
                f"reason={row['reason']}"
            )


def _is_adoptable_identity_issue(issue: str, state: SchedulerState) -> bool:
    if issue.startswith("placement_hash mismatch"):
        return True
    if not issue.startswith("queue_hash mismatch"):
        return False
    if state.experiment_hash is not None:
        return True
    return not (state.pending or state.running or state.failed)


def _identity_issues(config: SchedulerConfig, state: SchedulerState, *, include_placement: bool) -> list[str]:
    issues: list[str] = []
    if state.experiment_hash is not None:
        if state.experiment_hash != config.experiment_hash:
            issues.append(
                f"experiment_hash mismatch: state={state.experiment_hash!r}, "
                f"queue={config.experiment_hash!r}"
            )
    elif state.queue_hash != config.queue_hash:
        issues.append(
            f"queue_hash mismatch: state={state.queue_hash!r}, queue={config.queue_hash!r}"
        )
    if include_placement and state.placement_hash is not None and state.placement_hash != config.placement_hash:
        issues.append(
            f"placement_hash mismatch: state={state.placement_hash!r}, "
            f"queue={config.placement_hash!r}"
        )
    return issues


def _state_issues(config: SchedulerConfig, state: SchedulerState) -> list[str]:
    return _state_issues_for(
        config,
        state,
        include_placement=True,
        legacy_message="legacy state has no queue identity; inspect only, do not resume automatically",
        include_running_policy=True,
    )


def _blocking_state_issues(config: SchedulerConfig, state: SchedulerState) -> list[str]:
    """Return issues that make state mutation unsafe."""
    issues: list[str] = []
    legacy_path = _legacy_state_path(config)
    if (
        not config.state_path.is_file()
        and legacy_path is not None
        and legacy_path.is_file()
        and legacy_path != config.state_path
    ):
        issues.append(
            "legacy global scheduler_state.json exists while this queue has no scoped state; "
            "inspect it with doctor/status before starting a fresh state"
        )
    issues.extend(_conflicting_scoped_state_issues(config))
    if not config.state_path.is_file():
        return issues
    issues.extend(_state_issues_for(
        config,
        state,
        include_placement=False,
        legacy_message="legacy state has no queue identity; inspect only, do not mutate",
        include_running_policy=False,
    ))
    return issues


def _state_issues_for(
    config: SchedulerConfig,
    state: SchedulerState,
    *,
    include_placement: bool,
    legacy_message: str,
    include_running_policy: bool,
) -> list[str]:
    if not config.state_path.is_file():
        return []

    issues: list[str] = []
    if state.is_legacy:
        issues.append(legacy_message)
    else:
        issues.extend(_identity_issues(config, state, include_placement=include_placement))

    experiments = config.experiments_by_name()
    unknown = sorted(state.all_tracked_names() - set(experiments))
    if unknown:
        issues.append("state contains experiments outside this queue: " + ", ".join(unknown))

    foreign = sorted({job.hostname for job in state.running if job.hostname not in config.hosts()})
    if foreign:
        issues.append("running jobs on hosts outside queue my_nodes: " + ", ".join(foreign))

    if include_running_policy:
        issues.extend(_running_policy_issues(config, state, experiments))
    return issues


def _running_policy_issues(
    config: SchedulerConfig,
    state: SchedulerState,
    experiments: dict[str, Experiment],
) -> list[str]:
    issues: list[str] = []
    for job in state.running:
        expected_slots = _expected_slots_for_job(config, job)
        if job.slots_per_gpu is not None and expected_slots is not None and job.slots_per_gpu != expected_slots:
            issues.append(
                f"slot policy mismatch for {job.exp_name}: "
                f"started={job.slots_per_gpu}, current={expected_slots}"
            )
        exp = experiments.get(job.exp_name)
        if exp and job.command_hash and job.command_hash != exp.command_hash:
            issues.append(f"command hash mismatch for running job {job.exp_name}")
    return issues


def _legacy_state_path(config: SchedulerConfig):
    if config.state_path.name == "scheduler_state.json":
        return None
    if config.state_path.parent.name != "scheduler_state":
        return None
    return config.state_path.parent.parent / "scheduler_state.json"


def _sibling_scoped_state_paths(config: SchedulerConfig):
    if config.state_path.parent.name != "scheduler_state":
        return []
    state_dir = config.state_path.parent
    if not state_dir.is_dir():
        return []
    return sorted(path for path in state_dir.glob("*.json") if path != config.state_path)


def _conflicting_scoped_state_issues(config: SchedulerConfig) -> list[str]:
    issues: list[str] = []
    current_names = {exp.name for exp in config.experiments}
    current_hashes = {exp.command_hash for exp in config.experiments}
    for path in _sibling_scoped_state_paths(config):
        sibling = SchedulerState.load(path)
        active_pending = set(sibling.pending)
        active_running = {job.exp_name for job in sibling.running}
        active_names = active_pending | active_running
        active_hashes = {job.command_hash for job in sibling.running if job.command_hash}
        overlap_names = sorted(active_names & current_names)
        overlap_hash_count = len(active_hashes & current_hashes)
        if overlap_names or overlap_hash_count:
            details: list[str] = []
            if overlap_names:
                details.append("jobs=" + ",".join(overlap_names[:5]))
                if len(overlap_names) > 5:
                    details.append(f"+{len(overlap_names) - 5} jobs")
            if overlap_hash_count:
                details.append(f"running_command_hashes={overlap_hash_count}")
            if sibling.pending or sibling.running:
                tmux_session = sibling.tmux_session or _default_tmux_session_from_state(path, sibling)
                stale_note = ""
                if sibling.heartbeat_at > 0 and time_since(sibling.heartbeat_at) > 900:
                    stale_note = f", possible stale heartbeat={_format_heartbeat(sibling.heartbeat_at)}"
                details.append(f"tmux={tmux_session}{stale_note}")
            issues.append(
                f"other scoped state has active overlapping jobs: {path} "
                f"(pending={len(sibling.pending)}, running={len(sibling.running)}; "
                + "; ".join(details)
                + ")"
            )
    return issues


def _print_blocking_issues(issues: list[str]) -> None:
    print("Safety issues:", file=sys.stderr)
    for issue in issues:
        print(f"  - {issue}", file=sys.stderr)


def _resolve_running_job(state: SchedulerState, token: str) -> RunningJob | None:
    for job in state.running:
        if job.matches(token):
            return job
    return None


def _resolve_failed_job(state: SchedulerState, token: str) -> FinishedJob | None:
    for job in state.failed:
        if job.matches(token):
            return job
    return None


def _resolve_finished_job(state: SchedulerState, token: str) -> FinishedJob | None:
    for job in (*state.done, *state.failed):
        if job.matches(token):
            return job
    return None


def _job_matches_current_command(config: SchedulerConfig, job: RunningJob | FinishedJob) -> bool:
    exp = config.experiment(job.exp_name)
    return exp is not None and job.command_hash == exp.command_hash


def _execution_safety_note(config: SchedulerConfig, job: RunningJob | FinishedJob) -> str:
    notes: list[str] = []
    if not job.job_id:
        notes.append("legacy job_id")
    if not _job_matches_current_command(config, job):
        notes.append("command mismatch")
    expected_slots = _expected_slots_for_job(config, job)
    if job.slots_per_gpu is not None and expected_slots is not None and job.slots_per_gpu != expected_slots:
        notes.append(f"slot policy started={job.slots_per_gpu}")
    return f" [{' | '.join(notes)}]" if notes else ""


def _policy_note(config: SchedulerConfig, job: RunningJob) -> str:
    expected_slots = _expected_slots_for_job(config, job)
    if job.slots_per_gpu is None or expected_slots is None or job.slots_per_gpu == expected_slots:
        return ""
    return f"  slot_policy:{job.slots_per_gpu}->{expected_slots}"


def _expected_slots_for_job(config: SchedulerConfig, job: RunningJob | FinishedJob) -> int | None:
    return config.slots_on(job.hostname)


def _command_note(exp: Experiment | None, job_hash: str | None) -> str:
    if exp is None:
        return "  command:unknown"
    if job_hash is None:
        return "  command:legacy"
    if job_hash != exp.command_hash:
        return "  command:mismatch"
    return ""


if __name__ == "__main__":
    main()
