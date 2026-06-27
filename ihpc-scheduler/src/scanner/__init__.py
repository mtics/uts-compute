"""iHPC Node Availability Scanner.

Layered architecture:
  - core/           Pure data models and scoring logic (no I/O)
  - infra/          SSH connections, metric collection, caching
  - presentation/   Output formatting and CLI
  - config.py       YAML-based multi-account configuration
  - scanner.py      Application-level orchestrator

Quick start (with config.yaml)::

    from scanner import NodeScanner
    from scanner.config import load_config

    config = load_config()
    scanner = NodeScanner(config)

    result = scanner.scan()                            # default account
    result = scanner.scan(account_name="secondary")    # specific account
    print(scanner.display(result))

Quick start (inline credentials)::

    from scanner import NodeScanner
    from scanner.config import AccountConfig, ScannerConfig

    config = ScannerConfig(
        accounts=[AccountConfig(name="me", username="myuser", password="mypass")],
    )
    scanner = NodeScanner(config)
    result = scanner.scan()
    print(scanner.display(result))
"""

from .config import AccountConfig, ScannerConfig, load_config
from .core.models import (
    GPUInfo,
    NodeMetrics,
    NodeState,
    ScanResult,
    WeightPreset,
)
from .infra.collector import CnodeNodeInfo, discover_available_nodes
from .scanner import NodeScanner

__all__ = [
    "AccountConfig",
    "CnodeNodeInfo",
    "GPUInfo",
    "NodeMetrics",
    "NodeScanner",
    "NodeState",
    "ScannerConfig",
    "ScanResult",
    "WeightPreset",
    "discover_available_nodes",
    "load_config",
]
