"""Output formatting for scan results — table, JSON, CSV.

All functions accept ``list[CnodeNodeInfo]`` — data sourced from
``cnode avail`` on the head node only.  No per-node SSH data is present.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timezone

from ..core.models import CnodeNodeInfo


# ---------------------------------------------------------------------------
# Table format
# ---------------------------------------------------------------------------

def format_table(
    nodes: list[CnodeNodeInfo],
    *,
    scan_timestamp: float = 0.0,
    account_name: str = "",
) -> str:
    """Render nodes as a human-readable table, grouped by cluster."""
    headers = ["Node", "Score", "Load", "Connect", "CPU%", "Mem%", "GPU%", "Users"]

    lines: list[str] = []
    if account_name:
        lines.append(f"Account: {account_name}")
    if scan_timestamp > 0:
        dt = datetime.fromtimestamp(scan_timestamp, tz=timezone.utc)
        lines.append(f"Scan time: {dt:%Y-%m-%d %H:%M:%S UTC}")
    if lines:
        lines.append("")

    for cluster_name, members in _group_by_cluster(nodes):
        connectable = [n for n in members if n.connectable]
        lines.append(f"[{cluster_name}] ({len(connectable)}/{len(members)} connectable)")

        rows = [_node_row(n) for n in members]
        col_widths = [len(h) for h in headers]
        for row in rows:
            for i, cell in enumerate(row):
                col_widths[i] = max(col_widths[i], len(cell))

        separator = "  ".join("-" * w for w in col_widths)

        def _fmt(cells: list[str]) -> str:
            return "  ".join(c.ljust(col_widths[i]) for i, c in enumerate(cells))

        lines.append(_fmt(headers))
        lines.append(separator)
        for row in rows:
            lines.append(_fmt(row))
        lines.append("")

    return "\n".join(lines).rstrip()


def _node_row(n: CnodeNodeInfo) -> list[str]:
    score = str(int(n.idle_score)) if n.idle_score >= 0 else "--"
    users = ",".join(n.users) if n.users else "-"
    return [
        n.hostname,
        score,
        n.load_label,
        "yes" if n.connectable else "no",
        f"{n.cpu_pct:.0f}%",
        f"{n.mem_pct:.0f}%",
        f"{n.gpu_pct:.0f}%",
        users,
    ]


def _group_by_cluster(
    nodes: list[CnodeNodeInfo],
) -> list[tuple[str, list[CnodeNodeInfo]]]:
    """Group nodes by cluster, sorted by best idle score descending."""
    from collections import OrderedDict

    groups: dict[str, list[CnodeNodeInfo]] = OrderedDict()
    for n in nodes:
        groups.setdefault(n.cluster or "Unknown", []).append(n)

    def _key(item: tuple[str, list[CnodeNodeInfo]]) -> float:
        return -max((n.idle_score for n in item[1] if n.idle_score >= 0), default=0.0)

    return sorted(groups.items(), key=_key)


# ---------------------------------------------------------------------------
# JSON format
# ---------------------------------------------------------------------------

def format_json(
    nodes: list[CnodeNodeInfo],
    *,
    scan_timestamp: float = 0.0,
    account_name: str = "",
    indent: int = 2,
) -> str:
    """Serialize nodes to a JSON string."""
    data: dict = {"scan_timestamp": scan_timestamp}
    if account_name:
        data["account"] = account_name
    data["nodes"] = [_node_to_dict(n) for n in nodes]
    return json.dumps(data, indent=indent, ensure_ascii=False)


def _node_to_dict(n: CnodeNodeInfo) -> dict:
    return {
        "hostname": n.hostname,
        "cluster": n.cluster,
        "idle_score": n.idle_score,
        "load_index": n.load_index,
        "load_label": n.load_label,
        "connectable": n.connectable,
        "cpu_pct": n.cpu_pct,
        "mem_pct": n.mem_pct,
        "gpu_pct": n.gpu_pct,
        "gpu_mem_pct": n.gpu_mem_pct,
        "users": n.users,
    }


# ---------------------------------------------------------------------------
# CSV format
# ---------------------------------------------------------------------------

def format_csv(nodes: list[CnodeNodeInfo]) -> str:
    """Serialize nodes to CSV."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "hostname", "cluster", "idle_score", "load_index", "load_label",
        "connectable", "cpu_pct", "mem_pct", "gpu_pct", "gpu_mem_pct", "users",
    ])
    for n in nodes:
        writer.writerow([
            n.hostname,
            n.cluster,
            n.idle_score,
            n.load_index,
            n.load_label,
            n.connectable,
            f"{n.cpu_pct:.1f}",
            f"{n.mem_pct:.1f}",
            f"{n.gpu_pct:.1f}",
            f"{n.gpu_mem_pct:.1f}",
            ",".join(n.users),
        ])
    return buf.getvalue()
