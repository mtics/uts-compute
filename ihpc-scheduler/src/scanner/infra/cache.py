"""Scan result caching to avoid redundant SSH round-trips."""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..core.models import ScanResult


class ScanCache:
    """Time-based cache for scan results, keyed by account name.

    Results older than ``ttl`` seconds are considered stale.
    """

    def __init__(self, ttl: float = 120.0) -> None:
        self._ttl = ttl
        self._store: dict[str, tuple[ScanResult, float]] = {}

    @property
    def ttl(self) -> float:
        return self._ttl

    @ttl.setter
    def ttl(self, value: float) -> None:
        self._ttl = max(0.0, value)

    def get(self, account: str = "") -> ScanResult | None:
        """Return cached result for *account* if still fresh, else None."""
        entry = self._store.get(account)
        if entry is None:
            return None
        result, timestamp = entry
        if time.time() - timestamp > self._ttl:
            return None
        return result

    def put(self, result: ScanResult, account: str = "") -> None:
        self._store[account] = (result, time.time())

    def invalidate(self, account: str | None = None) -> None:
        """Invalidate cache for a specific account, or all if None."""
        if account is None:
            self._store.clear()
        else:
            self._store.pop(account, None)

    def age_sec(self, account: str = "") -> float:
        entry = self._store.get(account)
        if entry is None:
            return float("inf")
        return time.time() - entry[1]
