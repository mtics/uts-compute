"""Main scanner orchestrator.

Connects ONLY to the iHPC head node.  All node data comes from
``cnode avail`` — no SSH connections to compute nodes are made.
"""

from __future__ import annotations

import logging
import time

from .config import ScannerConfig
from .core.models import ScanResult
from .core.scorer import score_all
from .infra.cache import ScanCache
from .infra.collector import discover_available_nodes
from .infra.ssh import SSHPool
from .presentation.formatter import format_csv, format_json, format_table

logger = logging.getLogger(__name__)


class NodeScanner:
    """Scan all available iHPC nodes and rank them by idle score.

    Uses only ``cnode avail`` on the head node — never connects to compute
    nodes directly.

    Usage::

        from scanner import NodeScanner, load_config

        config = load_config()
        scanner = NodeScanner(config)

        result = scanner.scan()
        result = scanner.scan(account_name="example-user")
        print(scanner.display(result))
    """

    def __init__(self, config: ScannerConfig) -> None:
        self._config = config
        self._cache = ScanCache(ttl=config.cache_ttl_sec)

    @property
    def config(self) -> ScannerConfig:
        return self._config

    def scan(
        self,
        *,
        account_name: str | None = None,
        force: bool = False,
    ) -> ScanResult:
        """Query ``cnode avail`` and return scored node list.

        One SSH connection to the head node is opened and closed.
        No compute nodes are contacted.
        """
        account = self._config.get_account(account_name)
        cache_key = account.name

        if not force:
            cached = self._cache.get(cache_key)
            if cached is not None:
                logger.info(
                    "Returning cached result for '%s' (%.0fs old)",
                    account.name,
                    self._cache.age_sec(cache_key),
                )
                return cached

        t0 = time.time()

        pool = SSHPool(
            account,
            head_node=self._config.head_node,
            ssh_timeout=self._config.ssh_timeout,
            command_timeout=self._config.command_timeout,
        )
        with pool:
            nodes = discover_available_nodes(pool)

        score_all(nodes, self._config.weights)

        result = ScanResult(
            nodes=nodes,
            scan_timestamp=t0,
            scan_duration_sec=round(time.time() - t0, 2),
            account_name=account.name,
        )

        self._cache.put(result, cache_key)
        logger.info(
            "[%s] Scan complete: %d nodes (%.1fs)",
            account.name,
            len(nodes),
            result.scan_duration_sec,
        )
        return result

    def display(
        self,
        result: ScanResult,
        *,
        fmt: str = "table",
        cluster: str | None = None,
        min_score: float | None = None,
        require_idle_gpu: bool = False,
    ) -> str:
        """Format scan results for display.

        Args:
            result: Scan result to format.
            fmt: ``"table"``, ``"json"``, or ``"csv"``.
            cluster: Only show nodes from this cluster.
            min_score: Only show nodes with idle score >= this value.
            require_idle_gpu: Only show nodes with likely-idle GPUs.
        """
        nodes = result.filter(
            cluster=cluster,
            min_score=min_score,
            require_idle_gpu=require_idle_gpu,
        )

        if fmt == "json":
            return format_json(nodes, scan_timestamp=result.scan_timestamp,
                               account_name=result.account_name)
        if fmt == "csv":
            return format_csv(nodes)
        return format_table(nodes, scan_timestamp=result.scan_timestamp,
                            account_name=result.account_name)

    def invalidate_cache(self, account_name: str | None = None) -> None:
        """Clear cached results. If account_name is None, clear all."""
        self._cache.invalidate(account_name)
