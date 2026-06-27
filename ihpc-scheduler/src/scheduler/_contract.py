"""Contract-version stamp (FIRST-PARTY — part of this plugin; written by the stamp script).

Dependency-light: imports only the in-package state module, so the stamp is runnable
with a plain `python3 -c`. The three constants below are written by
scripts/stamp-scheduler-contract.mjs from this repo's pyproject version + a monotonic
BUILD ordinal + this repo's short commit SHA.

`contract_version()` emits the exact format the MCP server pins in
mcp-server/src/lib/ihpc-contract.ts (EXPECTED_SCHEDULER_CONTRACT).
"""

import re

from .state import STATE_VERSION

# Written by scripts/stamp-scheduler-contract.mjs (first-party; not upstream).
_VERSION = "0.1.0"
_BUILD = "1"
_GIT_SHA = "830bd4f"

CONTRACT_RE = re.compile(r"^(\d+\.\d+\.\d+)\+state(\d+)\+build(\d+)\+([0-9a-f]{7,40})$")


def contract_version() -> str:
    """Return e.g. '0.1.0+state2+build1+e6883a9'."""
    return f"{_VERSION}+state{STATE_VERSION}+build{_BUILD}+{_GIT_SHA}"
