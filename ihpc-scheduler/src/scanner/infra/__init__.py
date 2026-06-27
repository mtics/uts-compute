"""Infrastructure layer — SSH connections, remote metric collection, caching.

This layer handles all I/O and external communication.
"""

from .cache import ScanCache
from .collector import collect_node_metrics, discover_available_nodes
from .ssh import SSHClient, SSHPool

__all__ = [
    "SSHClient",
    "SSHPool",
    "ScanCache",
    "collect_node_metrics",
    "discover_available_nodes",
]
