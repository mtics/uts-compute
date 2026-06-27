"""Node data collection helpers.

Two distinct functions:
- ``discover_available_nodes()``: parses ``cnode avail`` on the head node.
  Makes ONE SSH connection (to the head node only).  Never connects to compute
  nodes.  Used by the scanner for cluster-wide overview.

- ``collect_node_metrics()``: runs nvidia-smi / free / etc. on a single node
  the caller is already connected to.  Used by the scheduler on the user's
  OWN active nodes only — never called in bulk.
"""

from __future__ import annotations

import logging
import re

from ..config import CLUSTER_PREFIXES
from ..core.models import CnodeNodeInfo, GPUInfo, NodeMetrics, NodeState
from .ssh import SSHClient, SSHPool

logger = logging.getLogger(__name__)

_VALID_HOSTNAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9]+-?\d+$")


def _is_valid_hostname(token: str) -> bool:
    return bool(_VALID_HOSTNAME_RE.match(token))


def _parse_pct(value: str) -> float:
    try:
        return float(value.rstrip("%"))
    except ValueError:
        return 0.0


def infer_cluster(hostname: str) -> str:
    """Infer cluster name from a hostname prefix, e.g. ``mars5`` → ``Mars``."""
    name_lower = hostname.lower()
    for prefix, cluster in CLUSTER_PREFIXES.items():
        if name_lower.startswith(prefix):
            return cluster
    return "Unknown"


# ---------------------------------------------------------------------------
# Head-node only — safe to call anytime (no compute node connections)
# ---------------------------------------------------------------------------

def discover_available_nodes(pool: SSHPool) -> list[CnodeNodeInfo]:
    """Query ``cnode avail`` and return rich per-node info.

    Only one SSH connection is used: to the head node.
    No compute nodes are contacted.
    """
    raw = pool.head.exec_command("cnode avail")
    nodes: list[CnodeNodeInfo] = []
    seen: set[str] = set()

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        # Expected columns: Node Index Connect %CPU %Mem %GPU %GPUMem [User(s)]
        if len(parts) < 7:
            continue
        hostname = parts[0]
        if not _is_valid_hostname(hostname) or hostname in seen:
            continue

        try:
            info = CnodeNodeInfo(
                hostname=hostname,
                cluster=infer_cluster(hostname),
                load_index=int(parts[1]),
                connectable=parts[2].lower() == "yes",
                cpu_pct=float(parts[3]),
                mem_pct=float(parts[4]),
                gpu_pct=_parse_pct(parts[5]),
                gpu_mem_pct=_parse_pct(parts[6]),
                users=[u for u in parts[7].split(",") if u] if len(parts) > 7 else [],
            )
        except (ValueError, IndexError):
            logger.debug("Could not parse cnode avail line: %s", line)
            continue

        nodes.append(info)
        seen.add(hostname)

    return nodes


# ---------------------------------------------------------------------------
# Scheduler-only — call on the user's OWN active nodes, never in bulk
# ---------------------------------------------------------------------------

def collect_node_metrics(client: SSHClient) -> NodeMetrics:
    """Collect detailed CPU/mem/GPU metrics from a node the caller owns.

    WARNING: Only call this on nodes where the user already has an active
    NoMachine session.  Never call this in a loop over all available nodes.
    """
    hostname = client.hostname
    metrics = NodeMetrics(
        hostname=hostname,
        state=NodeState.REACHABLE,
        cluster=infer_cluster(hostname),
    )

    combined = client.exec_command(
        "cat /proc/loadavg; echo '---DELIM---'; "
        "nproc; echo '---DELIM---'; "
        "free -m; echo '---DELIM---'; "
        "ps -eo uid= | awk '$1 >= 1000' | sort -u | wc -l; echo '---DELIM---'; "
        "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total "
        "--format=csv,noheader,nounits 2>/dev/null || echo 'NO_GPU'"
    )

    sections = combined.split("---DELIM---")
    if len(sections) < 5:
        metrics.error_message = "Unexpected command output format"
        return metrics

    _parse_loadavg(sections[0].strip(), metrics)
    _parse_nproc(sections[1].strip(), metrics)
    _parse_free(sections[2].strip(), metrics)
    _parse_users(sections[3].strip(), metrics)
    _parse_nvidia_smi(sections[4].strip(), metrics)

    return metrics


def _parse_loadavg(raw: str, m: NodeMetrics) -> None:
    try:
        m.cpu_load_1min = float(raw.split()[0])
    except (IndexError, ValueError):
        logger.warning("Failed to parse loadavg on %s: %s", m.hostname, raw)


def _parse_nproc(raw: str, m: NodeMetrics) -> None:
    try:
        m.cpu_cores = int(raw.strip())
    except ValueError:
        logger.warning("Failed to parse nproc on %s: %s", m.hostname, raw)


def _parse_free(raw: str, m: NodeMetrics) -> None:
    for line in raw.splitlines():
        if line.lower().startswith("mem:"):
            parts = line.split()
            try:
                m.mem_total_mib = float(parts[1])
                m.mem_available_mib = float(parts[-1])
            except (IndexError, ValueError):
                logger.warning("Failed to parse free on %s: %s", m.hostname, line)
            break


def _parse_users(raw: str, m: NodeMetrics) -> None:
    try:
        m.logged_in_users = int(raw.strip())
    except ValueError:
        logger.warning("Failed to parse user count on %s: %s", m.hostname, raw)


def _parse_nvidia_smi(raw: str, m: NodeMetrics) -> None:
    if "NO_GPU" in raw or not raw.strip():
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        try:
            m.gpus.append(GPUInfo(
                index=int(parts[0]),
                name=parts[1],
                utilization_pct=float(parts[2]),
                memory_used_mib=float(parts[3]),
                memory_total_mib=float(parts[4]),
            ))
        except (ValueError, IndexError):
            logger.warning("Failed to parse GPU line on %s: %s", m.hostname, line)
