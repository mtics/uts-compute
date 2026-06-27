"""Configuration management — YAML loading and multi-account support."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .core.models import WeightPreset

HEAD_NODE = "access.ihpc.uts.edu.au"

CLUSTER_PREFIXES: dict[str, str] = {
    "mars": "Mars",
    "venus": "Venus",
    "mercury": "Mercury",
    "jupiter": "Jupiter",
    "neptune": "Neptune",
    "saturn": "Saturn",
    "helios": "Helios",
    "turing": "Turing",
}

WEIGHT_PRESETS: dict[WeightPreset, dict[str, float]] = {
    WeightPreset.GPU_HEAVY: {
        "cpu": 0.15,
        "mem": 0.15,
        "gpu": 0.60,
        "user": 0.10,
    },
    WeightPreset.CPU_HEAVY: {
        "cpu": 0.50,
        "mem": 0.25,
        "gpu": 0.10,
        "user": 0.15,
    },
    WeightPreset.BALANCED: {
        "cpu": 0.25,
        "mem": 0.25,
        "gpu": 0.35,
        "user": 0.15,
    },
}

def _project_root() -> Path:
    """Resolve project root: two levels up from this file (src/scanner/ → project)."""
    return Path(__file__).resolve().parent.parent.parent


_DEFAULT_CONFIG_PATHS = [
    Path("configs/config.yaml"),
    Path("config.yaml"),
    _project_root() / "configs" / "config.yaml",
    _project_root() / "config.yaml",
    Path.home() / ".ihpc" / "config.yaml",
]


# ── Account ──────────────────────────────────────────────────────────────


@dataclass
class AccountConfig:
    """SSH credentials for a single iHPC account."""

    name: str
    username: str
    password: str | None = None
    key_filename: str | None = None

    def to_auth_kwargs(self) -> dict[str, Any]:
        """Build paramiko-compatible authentication kwargs."""
        kwargs: dict[str, Any] = {"username": self.username}
        if self.password is not None:
            kwargs["password"] = self.password
        if self.key_filename is not None:
            path = os.path.expanduser(self.key_filename)
            kwargs["key_filename"] = path
        return kwargs


# ── Scanner Config ───────────────────────────────────────────────────────


@dataclass
class ScannerConfig:
    """Complete scanner configuration, supporting multiple accounts."""

    accounts: list[AccountConfig] = field(default_factory=list)
    default_account: str = ""

    head_node: str = HEAD_NODE
    ssh_timeout: int = 10
    command_timeout: int = 30
    max_workers: int = 8
    cache_ttl_sec: float = 120.0

    weight_preset: WeightPreset = WeightPreset.GPU_HEAVY
    custom_weights: dict[str, float] | None = None

    @property
    def weights(self) -> dict[str, float]:
        if self.custom_weights is not None:
            return self.custom_weights
        return WEIGHT_PRESETS[self.weight_preset]

    def get_account(self, name: str | None = None) -> AccountConfig:
        """Look up an account by name. Falls back to default, then first."""
        target = name or self.default_account
        if target:
            for acct in self.accounts:
                if acct.name == target:
                    return acct
            raise KeyError(
                f"Account '{target}' not found. "
                f"Available: {[a.name for a in self.accounts]}"
            )
        if self.accounts:
            return self.accounts[0]
        raise ValueError("No accounts configured")

    @property
    def account_names(self) -> list[str]:
        return [a.name for a in self.accounts]


# ── YAML Loading ─────────────────────────────────────────────────────────


def find_config_file(path: str | Path | None = None) -> Path:
    """Resolve the config.yaml path without parsing it (used by scheduler)."""
    return _resolve_config_path(path)


def load_config(path: str | Path | None = None) -> ScannerConfig:
    """Load configuration from a YAML file.

    Search order when *path* is None:
      1. ``config.yaml`` in current directory
      2. ``config.yml`` in current directory
      3. ``~/.ihpc/config.yaml``

    Raises FileNotFoundError if no config file is found.
    """
    config_path = _resolve_config_path(path)
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"Invalid config format in {config_path}")
    return _parse_config(raw)


def _resolve_config_path(path: str | Path | None) -> Path:
    if path is not None:
        p = Path(path)
        if not p.is_file():
            raise FileNotFoundError(f"Config file not found: {p}")
        return p

    for candidate in _DEFAULT_CONFIG_PATHS:
        if candidate.is_file():
            return candidate

    searched = ", ".join(str(p) for p in _DEFAULT_CONFIG_PATHS)
    raise FileNotFoundError(
        f"No config file found. Searched: {searched}\n"
        f"Copy config.example.yaml to config.yaml and fill in your credentials."
    )


def _parse_config(raw: dict[str, Any]) -> ScannerConfig:
    accounts: list[AccountConfig] = []
    for entry in raw.get("accounts", []):
        accounts.append(AccountConfig(
            name=entry.get("name", "default"),
            username=entry.get("username", ""),
            password=entry.get("password"),
            key_filename=entry.get("key_filename"),
        ))

    scanner_section = raw.get("scanner", {})
    scoring_section = raw.get("scoring", {})

    preset_str = scoring_section.get("preset", "gpu")
    preset_map = {p.value: p for p in WeightPreset}
    weight_preset = preset_map.get(preset_str, WeightPreset.GPU_HEAVY)

    custom_weights = scoring_section.get("custom_weights")

    return ScannerConfig(
        accounts=accounts,
        default_account=raw.get("default_account", ""),
        head_node=scanner_section.get("head_node", HEAD_NODE),
        ssh_timeout=scanner_section.get("ssh_timeout", 10),
        command_timeout=scanner_section.get("command_timeout", 30),
        max_workers=scanner_section.get("max_workers", 16),
        cache_ttl_sec=scanner_section.get("cache_ttl_sec", 120.0),
        weight_preset=weight_preset,
        custom_weights=custom_weights,
    )
