"""Main scheduler loop.

Runs on the user's own compute node (e.g. turing2 in a tmux session).
Poll cycle (every poll_interval_sec):
  1. Check all running jobs — move finished ones to done/failed.
  2. Dispatch pending experiments to nodes with free GPU slots.
  3. Save state.
"""

from __future__ import annotations

import logging
import os
import time

from ..scanner.infra.ssh import SSHClient, SSHPool
from .config import Experiment, NodeConfig, SchedulerConfig, load_queue
from .monitor import check_job, send_mail, tail_log
from .lock import SchedulerLock
from .placement import (
    NodeSlots,
    SlotCandidate,
    running_placement_issues,
    usable_gpu_count,
)
from .summarizer import summarize_log
from .state import RunningJob, SchedulerState
from .submitter import connect_node, explain_gpu_slots, make_log_path, submit_job

logger = logging.getLogger(__name__)


class Scheduler:
    """Orchestrates experiment submission and monitoring."""

    def __init__(self, config: SchedulerConfig, lock: SchedulerLock | None = None) -> None:
        self._config = config
        self._lock = lock
        self._last_blocked_notify: float = time.time()
        self._blocked_notify_count: int = 0
        self._last_progress_notify: float = time.time()
        self._progress_events: list[dict] = []
        self._blocked_reasons: dict[str, dict[str, object]] = {}

    @property
    def blocked_reasons(self) -> dict[str, dict[str, object]]:
        """Structured reasons for jobs left pending by the last dispatch pass."""
        return self._blocked_reasons

    def run_forever(self) -> None:
        """Main loop — runs until interrupted (Ctrl-C or SIGTERM)."""
        cfg = self._config
        state = SchedulerState.initialise(
            [e.name for e in cfg.experiments],
            cfg.state_path,
            queue_id=cfg.queue_id,
            queue_hash=cfg.queue_hash,
            experiment_hash=cfg.experiment_hash,
            placement_hash=cfg.placement_hash,
        )
        self._validate_state_for_start(state)
        state.set_provenance(
            queue_path=str(cfg.queue_path) if cfg.queue_path is not None else None,
            launch_command=os.environ.get("IHPC_SCHED_LAUNCH_COMMAND"),
            tmux_session=os.environ.get("IHPC_SCHED_TMUX_SESSION"),
            node_policy_snapshot=cfg.node_policy_snapshot(),
            scheduler_settings_snapshot=cfg.settings_snapshot(),
            experiment_hash=cfg.experiment_hash,
            placement_hash=cfg.placement_hash,
        )
        if state.last_blocked_notify > 0:
            self._last_blocked_notify = state.last_blocked_notify
            self._blocked_notify_count = state.blocked_notify_count
        self._save_state(state)

        logger.info(
            "Scheduler started: %d pending, %d nodes",
            len(state.pending), len(cfg.my_nodes),
        )

        try:
            while True:
                self._poll(state)
                self._save_state(state)
                self._log_summary(state)

                if not state.pending and not state.running:
                    logger.info("All experiments complete. Scheduler exiting.")
                    self._notify_all_done(state)
                    break

                time.sleep(self._config.poll_interval_sec)
        except KeyboardInterrupt:
            logger.info("Scheduler interrupted.")
            self._save_state(state)

    def _save_state(self, state: SchedulerState) -> None:
        state.refresh_heartbeat()
        state.save(self._config.state_path)
        if self._lock is not None:
            self._lock.refresh()

    def _poll(self, state: SchedulerState) -> None:
        """Single poll cycle: check running jobs then dispatch pending ones."""
        reloaded = self._reload_config_if_changed(state)
        had_state_change = self._check_running(state)
        dispatched_any = self._dispatch_pending(state)
        self._check_blocked(state, progressing=reloaded or had_state_change or dispatched_any)
        self._maybe_send_progress(state)
        state.last_blocked_notify = self._last_blocked_notify
        state.blocked_notify_count = self._blocked_notify_count

    def _reload_config_if_changed(self, state: SchedulerState) -> bool:
        """Hot-reload queue placement policy while preserving running jobs.

        This lets ``ihpc-sched mutate --add-node`` or a safe slots/GPU update
        take effect without stopping a long-running scheduler.  The reload is
        limited to placement policy changes: the experiment set and state/log
        paths must stay fixed so a running scheduler cannot silently switch
        queues.
        """
        old = self._config
        if old.queue_path is None:
            return False

        fresh = load_queue(
            queue_path=old.queue_path,
            hardware_path=old.hardware_path,
            scanner_config_path=old.scanner_config_path,
        )
        if fresh.queue_hash == old.queue_hash:
            return False

        self._validate_hot_reload(old, fresh, state)
        self._config = fresh
        state.queue_hash = fresh.queue_hash
        state.experiment_hash = fresh.experiment_hash
        state.placement_hash = fresh.placement_hash
        state.set_provenance(
            queue_path=str(fresh.queue_path) if fresh.queue_path is not None else None,
            launch_command=state.launch_command,
            tmux_session=state.tmux_session,
            node_policy_snapshot=fresh.node_policy_snapshot(),
            scheduler_settings_snapshot=fresh.settings_snapshot(),
            experiment_hash=fresh.experiment_hash,
            placement_hash=fresh.placement_hash,
        )
        logger.info(
            "Reloaded queue policy: nodes=%s slots/GPU=%d placement=%s",
            ",".join(node.hostname for node in fresh.my_nodes),
            fresh.slots_per_gpu,
            fresh.placement_hash[:12],
        )
        return True

    def _validate_hot_reload(
        self,
        old: SchedulerConfig,
        fresh: SchedulerConfig,
        state: SchedulerState,
    ) -> None:
        if fresh.queue_id != old.queue_id:
            raise RuntimeError(
                f"Refusing hot reload across queue ids: {old.queue_id!r} -> {fresh.queue_id!r}"
            )
        if fresh.state_path != old.state_path:
            raise RuntimeError(
                f"Refusing hot reload with changed state_path: {old.state_path} -> {fresh.state_path}"
            )
        if fresh.log_dir != old.log_dir:
            raise RuntimeError(
                f"Refusing hot reload with changed log_dir: {old.log_dir} -> {fresh.log_dir}"
            )

        old_manifest = [
            (exp.name, exp.command_hash, exp.requires_gpu)
            for exp in old.experiments
        ]
        fresh_manifest = [
            (exp.name, exp.command_hash, exp.requires_gpu)
            for exp in fresh.experiments
        ]
        if fresh.experiment_hash != old.experiment_hash or fresh_manifest != old_manifest:
            raise RuntimeError("Refusing hot reload that changes the experiment manifest.")

        issues = running_placement_issues(fresh, state, previous=old, check_slots=True)
        if issues:
            raise RuntimeError(issues[0].hot_reload_message())

    # -----------------------------------------------------------------------
    # Phase 1 — check running jobs
    # -----------------------------------------------------------------------

    def _check_running(self, state: SchedulerState) -> bool:
        """Check running jobs. Returns True if any job completed or failed."""
        if not state.running:
            return False

        changed = False
        by_host: dict[str, list[RunningJob]] = {}
        for job in list(state.running):
            if job.hostname not in self._config.hosts():
                logger.error(
                    "Refusing to monitor job '%s' on non-queue host %s",
                    job.exp_name, job.hostname,
                )
                continue
            by_host.setdefault(job.hostname, []).append(job)

        for hostname, jobs in by_host.items():
            try:
                pool, client = connect_node(self._config, hostname)
            except Exception as exc:
                logger.warning("Cannot connect to %s for monitoring: %s", hostname, exc)
                continue

            try:
                for job in jobs:
                    try:
                        alive, exit_code = check_job(client, job)
                    except Exception as exc:
                        logger.warning("Error checking job '%s' on %s: %s", job.exp_name, hostname, exc)
                        continue

                    if alive:
                        logger.debug("Job '%s' still running (PID %d)", job.exp_name, job.pid)
                    elif exit_code == 0:
                        logger.info("Job '%s' DONE (exit 0)", job.exp_name)
                        duration = time.time() - job.started_at
                        if not state.mark_done(job.exp_name, exit_code=0):
                            raise RuntimeError(f"Running job vanished from state: {job.exp_name}")
                        self._progress_events.append({
                            "exp_name": job.exp_name, "status": "done",
                            "duration": duration, "exit_code": 0,
                            "hostname": job.hostname, "log_path": job.log_path,
                        })
                        changed = True
                    else:
                        code_str = str(exit_code) if exit_code is not None else "lost"
                        logger.warning("Job '%s' FAILED (exit %s)", job.exp_name, code_str)
                        duration = time.time() - job.started_at
                        ec = exit_code or -1
                        if not state.mark_failed(job.exp_name, exit_code=ec):
                            raise RuntimeError(f"Running job vanished from state: {job.exp_name}")
                        self._progress_events.append({
                            "exp_name": job.exp_name, "status": f"failed(exit {code_str})",
                            "duration": duration, "exit_code": ec,
                            "hostname": job.hostname, "log_path": job.log_path,
                        })
                        changed = True
            finally:
                pool.close()

        return changed

    # -----------------------------------------------------------------------
    # Phase 2 — dispatch pending experiments
    # -----------------------------------------------------------------------

    def _dispatch_pending(self, state: SchedulerState) -> bool:
        """Dispatch pending experiments to free slots. Returns True if any dispatched."""
        cfg = self._config
        dispatched = False
        failed_nodes: set[str] = set()
        virtual_gpu_counts = {
            node.hostname: state.gpu_job_counts(node.hostname)
            for node in cfg.my_nodes
        }
        self._blocked_reasons = {}

        for exp_name in list(state.pending):
            if exp_name not in state.pending:
                continue
            exp = cfg.experiment(exp_name)
            if exp is None:
                raise RuntimeError(
                    f"Unknown pending experiment {exp_name!r}; run ihpc-sched doctor "
                    "and create a fresh queue-scoped state instead of silently skipping it."
                )

            result = self._find_slot(
                state,
                exp,
                skip_nodes=failed_nodes,
                virtual_gpu_counts=virtual_gpu_counts,
            )
            if result is None:
                logger.debug("No free slot for '%s' — waiting", exp_name)
                self._blocked_reasons[exp_name] = self._slot_blocked_reason(state, exp, failed_nodes)
                continue

            node, gpu_index, pool, client = result
            try:
                log_path = make_log_path(cfg.log_dir, exp_name)
                submission = submit_job(client, exp, gpu_index, log_path, return_result=True)
            except Exception as exc:
                logger.error("Submission of '%s' to %s failed: %s", exp_name, node.hostname, exc)
                failed_nodes.add(node.hostname)
                self._blocked_reasons[exp_name] = {
                    "reason": "submission failed",
                    "node": node.hostname,
                    "error": str(exc),
                }
                continue
            finally:
                pool.close()

            state.mark_running(RunningJob(
                exp_name=exp_name,
                hostname=node.hostname,
                pid=submission.pid,
                gpu_index=gpu_index,
                log_path=log_path,
                started_at=time.time(),
                job_id=exp.job_id,
                command_hash=exp.command_hash,
                queue_id=cfg.queue_id,
                slots_per_gpu=cfg.slots(node),
                wrapper_path=submission.wrapper_path,
                placement_hash=cfg.placement_hash,
                policy_snapshot=NodeSlots.empty(cfg, node).policy_snapshot(),
            ))
            if gpu_index is not None:
                node_counts = virtual_gpu_counts.setdefault(node.hostname, {})
                node_counts[gpu_index] = node_counts.get(gpu_index, 0) + 1
            self._blocked_reasons.pop(exp_name, None)
            dispatched = True

        return dispatched

    def _find_slot(
        self,
        state: SchedulerState,
        exp: Experiment,
        skip_nodes: set[str] | None = None,
        virtual_gpu_counts: dict[str, dict[int, int]] | None = None,
    ) -> tuple[NodeConfig, int | None, SSHPool, SSHClient] | None:
        """Find a node + GPU index that can accept the experiment.

        For GPU experiments: opens an SSH connection to verify a GPU is
        actually free (memory threshold check via nvidia-smi).

        Returns (node, gpu_index, pool, client) with the SSH connection still open
        so the caller can reuse it for job submission without a second handshake.
        Returns None if no capacity is available right now.
        Caller is responsible for closing the returned pool.
        """
        cfg = self._config

        candidates: list[SlotCandidate] = []

        for node in self._ordered_nodes_by_load(state):
            if skip_nodes and node.hostname in skip_nodes:
                continue
            slots = NodeSlots.from_state(
                cfg,
                node,
                state,
                virtual_gpu_counts=virtual_gpu_counts,
            )
            if not exp.requires_gpu:
                if slots.has_cpu_slot:
                    try:
                        pool, client = connect_node(cfg, node.hostname)
                    except Exception as exc:
                        logger.warning("Cannot connect to %s: %s", node.hostname, exc)
                        continue
                    return node, None, pool, client
                continue

            # GPU experiment: check actual GPU availability
            if slots.gpu_capacity_full:
                logger.debug(
                    "Node %s: all %d GPU slots tracked as full (counts=%s)",
                    node.hostname, slots.gpu_capacity, slots.gpu_counts,
                )
                continue  # all GPU slots tracked as occupied

            try:
                pool, client = connect_node(cfg, node.hostname)
            except Exception as exc:
                logger.warning("Cannot connect to %s to check GPUs: %s", node.hostname, exc)
                continue

            try:
                rows = explain_gpu_slots(
                    client,
                    **slots.gpu_probe_kwargs(),
                )
            except Exception as exc:
                logger.warning("GPU check failed on %s: %s", node.hostname, exc)
                pool.close()
                continue

            node_candidates = [
                SlotCandidate.from_gpu_row(
                    slots=slots,
                    row=row,
                    pool=pool,
                    client=client,
                )
                for row in rows
                if row.get("usable") and row.get("gpu") is not None
            ]
            if node_candidates:
                candidates.extend(node_candidates)
                continue

            pool.close()

        if not candidates:
            return None

        candidates.sort(
            key=lambda candidate: candidate.sort_key()
        )
        selected = candidates[0]
        closed_pool_ids: set[int] = set()
        for candidate in candidates[1:]:
            if candidate.pool is selected.pool or id(candidate.pool) in closed_pool_ids:
                continue
            candidate.pool.close()
            closed_pool_ids.add(id(candidate.pool))
        return selected.node, selected.gpu_index, selected.pool, selected.client

    def _slot_blocked_reason(
        self,
        state: SchedulerState,
        exp: Experiment,
        skip_nodes: set[str],
    ) -> dict[str, object]:
        nodes: list[dict[str, object]] = []
        for node in self._ordered_nodes_by_load(state):
            slots = NodeSlots.from_state(self._config, node, state)
            nodes.append(
                slots.blocked_reason(
                    exp,
                    skipped_after_submission_failure=node.hostname in skip_nodes,
                )
            )
        return {
            "reason": "no dispatchable slot",
            "requires_gpu": exp.requires_gpu,
            "nodes": nodes,
        }

    def _ordered_nodes_by_load(self, state: SchedulerState) -> list[NodeConfig]:
        """Prefer less-loaded nodes while keeping deterministic tie-breaking."""
        return sorted(
            self._config.my_nodes,
            key=lambda node: NodeSlots.from_state(self._config, node, state).node_sort_key(),
        )

    # -----------------------------------------------------------------------
    # Notifications
    # -----------------------------------------------------------------------

    def _notify_all_done(self, state: SchedulerState) -> None:
        """Send a summary email when all experiments are complete."""
        email = self._config.notify_email
        if not email:
            return
        n_done = len(state.done)
        n_failed = len(state.failed)
        subject = f"[iHPC] Queue finished — {n_done} done, {n_failed} failed"

        done_lines = "\n".join(f"  ✓ {j.exp_name}" for j in state.done) or "  (none)"
        failed_lines = "\n".join(
            f"  ✗ {j.exp_name}  (exit {j.exit_code})  log: {j.log_path}"
            for j in state.failed
        ) or "  (none)"
        body = (
            f"All experiments have finished.\n\n"
            f"Done ({n_done}):\n{done_lines}\n\n"
            f"Failed ({n_failed}):\n{failed_lines}"
        )
        for node in self._config.my_nodes:
            try:
                pool, client = connect_node(self._config, node.hostname)
                try:
                    send_mail(client, email, subject, body)
                finally:
                    pool.close()
                return
            except Exception:
                continue
        logger.warning("Could not connect to any node to send all-done notification.")

    def _maybe_send_progress(self, state: SchedulerState) -> None:
        """Send a progress digest email if enough time has passed and events exist.

        For each completed/failed experiment, reads the log via SSH and generates
        an LLM summary (if the summarizer is enabled) to include in the email.
        """
        email = self._config.notify_email
        if not email or not self._progress_events:
            return
        now = time.time()
        interval = self._config.notify_progress_interval_min * 60
        if now - self._last_progress_notify < interval:
            return

        events = self._progress_events
        n_done = sum(1 for e in events if e["status"] == "done")
        n_failed = len(events) - n_done
        summ_cfg = self._config.summarizer

        def _fmt_dur(s: float) -> str:
            if s < 60:
                return f"{s:.0f}s"
            if s < 3600:
                return f"{s / 60:.1f}min"
            return f"{s / 3600:.1f}h"

        summaries = self._collect_log_summaries(events, summ_cfg)

        sections: list[str] = []
        for ev in events:
            name = ev["exp_name"]
            header = f"[{ev['status'].upper()}] {name}  ({_fmt_dur(ev['duration'])})"
            summary = summaries.get(name)
            if summary:
                sections.append(f"{header}\n{summary}")
            else:
                sections.append(header)

        subject = f"[iHPC] Progress — {n_done} done, {n_failed} failed since last update"
        body = (
            "Experiments completed since last digest:\n\n"
            + "\n\n".join(sections)
            + f"\n\n{'=' * 40}\n"
            f"Current state — pending:{len(state.pending)}  "
            f"running:{len(state.running)}  "
            f"done:{len(state.done)}  failed:{len(state.failed)}"
        )
        for node in self._config.my_nodes:
            try:
                pool, client = connect_node(self._config, node.hostname)
                try:
                    send_mail(client, email, subject, body)
                    self._last_progress_notify = now
                    self._last_blocked_notify = now
                    self._blocked_notify_count = 0
                    self._progress_events = []
                finally:
                    pool.close()
                return
            except Exception:
                continue
        logger.warning("Could not connect to any node to send progress notification.")

    def _collect_log_summaries(self, events: list[dict], summ_cfg) -> dict[str, str]:
        """Read logs via SSH and generate LLM summaries for each event.

        Returns {exp_name: summary_text}. Missing or unreadable logs are skipped.
        """
        if not summ_cfg.enabled:
            return {}

        result: dict[str, str] = {}
        for ev in events:
            try:
                pool, client = connect_node(self._config, ev["hostname"])
            except Exception as exc:
                logger.warning("Cannot connect to %s for log of '%s': %s", ev["hostname"], ev["exp_name"], exc)
                continue
            try:
                log_content = tail_log(client, ev["log_path"], lines=summ_cfg.max_log_lines)
                if "(log not found)" in log_content:
                    continue
                summary = summarize_log(
                    log_content, ev["exp_name"],
                    success=(ev["status"] == "done"),
                    config=summ_cfg,
                    exit_code=ev.get("exit_code"),
                )
                result[ev["exp_name"]] = summary
            except Exception as exc:
                logger.warning("Failed to summarize log for '%s': %s", ev["exp_name"], exc)
            finally:
                pool.close()

        return result

    def _check_blocked(self, state: SchedulerState, *, progressing: bool = False) -> None:
        """Send an email if pending experiments have had no slot for a while.

        Uses exponential backoff: base interval doubles after each notification,
        capped at 24 hours.  Resets when the queue makes progress.
        """
        email = self._config.notify_email
        if not email or not state.pending:
            self._last_blocked_notify = time.time()
            self._blocked_notify_count = 0
            return

        if progressing:
            self._blocked_notify_count = 0
            self._last_blocked_notify = time.time()
            return

        now = time.time()
        base_sec = self._config.notify_blocked_after_min * 60
        max_sec = self._config.notify_max_interval_min * 60
        backoff_sec = min(base_sec * (2 ** self._blocked_notify_count), max_sec)
        if now - self._last_blocked_notify < backoff_sec:
            return

        subject = f"[iHPC] Queue blocked — {len(state.pending)} experiments waiting"
        body = (
            f"{len(state.pending)} experiments are waiting with no progress.\n"
            f"Possible causes: no free GPU slots, or all nodes are unreachable.\n\n"
            f"Running ({len(state.running)}):\n"
            + "\n".join(f"  - {j.exp_name}  ({j.hostname} GPU{j.gpu_index})" for j in state.running)
            + f"\n\nPending ({len(state.pending)}):\n"
            + "\n".join(f"  - {name}" for name in state.pending)
        )
        for node in self._config.my_nodes:
            try:
                pool, client = connect_node(self._config, node.hostname)
                try:
                    send_mail(client, email, subject, body)
                    self._last_blocked_notify = now
                    self._blocked_notify_count += 1
                finally:
                    pool.close()
                return
            except Exception:
                continue
        self._last_blocked_notify = now
        self._blocked_notify_count += 1
        logger.warning("Could not connect to any node to send blocked notification.")

    def _validate_state_for_start(self, state: SchedulerState) -> None:
        """Refuse to run when state cannot be safely tied to this queue."""
        cfg = self._config
        if state.is_legacy:
            raise ValueError("Refusing to start from legacy state without queue identity.")
        if state.experiment_hash is not None:
            if state.experiment_hash != cfg.experiment_hash:
                raise ValueError(
                    "State experiment_hash mismatch: "
                    f"existing={state.experiment_hash!r}, current={cfg.experiment_hash!r}"
                )
        elif state.queue_hash != cfg.queue_hash:
            raise ValueError(
                f"State queue_hash mismatch: existing={state.queue_hash!r}, "
                f"current={cfg.queue_hash!r}"
            )

        unknown = sorted(state.all_tracked_names() - set(cfg.experiments_by_name()))
        if unknown:
            raise ValueError(f"State contains experiments not in this queue: {', '.join(unknown)}")

        foreign_hosts = sorted(
            {job.hostname for job in state.running if job.hostname not in cfg.hosts()}
        )
        if foreign_hosts:
            raise ValueError(
                "State contains running jobs on hosts outside queue my_nodes: "
                + ", ".join(foreign_hosts)
            )

    def _log_summary(self, state: SchedulerState) -> None:
        logger.info(
            "State — pending:%d  running:%d  done:%d  failed:%d",
            len(state.pending), len(state.running),
            len(state.done), len(state.failed),
        )
