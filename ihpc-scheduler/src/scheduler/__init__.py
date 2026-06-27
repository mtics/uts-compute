"""iHPC Experiment Scheduler.

Manages experiment submission on the user's own active NoMachine session nodes.
Never connects to arbitrary compute nodes — only to nodes listed in my_nodes.

Quick start::

    # 1. Copy and fill in queue.example.yaml
    cp queue.example.yaml queue.yaml

    # 2. Start scheduler in a tmux session on turing2
    ihpc-sched start

    # 3. Check status from anywhere
    ihpc-sched status

    # 4. Requeue a failed experiment
    ihpc-sched retry bert-lr1e-4

    # 5. View logs
    ihpc-sched logs bert-lr1e-4
"""

from .config import Experiment, NodeConfig, SchedulerConfig, load_queue
from .scheduler import Scheduler
from .state import ExpStatus, RunningJob, SchedulerState

__all__ = [
    "Experiment",
    "ExpStatus",
    "NodeConfig",
    "RunningJob",
    "Scheduler",
    "SchedulerConfig",
    "SchedulerState",
    "load_queue",
]
