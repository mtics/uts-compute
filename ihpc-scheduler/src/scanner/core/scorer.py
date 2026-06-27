"""Idle score calculation from cnode avail data."""

from __future__ import annotations

from .models import CnodeNodeInfo


def score_node(node: CnodeNodeInfo, weights: dict[str, float]) -> float:
    """Compute a 0–100 idle score from ``cnode avail`` head-node data.

    Score = w_cpu × cpu_free% + w_mem × mem_free% + w_gpu × gpu_free% + w_user × user_penalty

    All inputs come from the head node's load-balancer view.
    No SSH connection to the compute node is required.
    """
    w_cpu  = weights.get("cpu",  0.25)
    w_mem  = weights.get("mem",  0.25)
    w_gpu  = weights.get("gpu",  0.35)
    w_user = weights.get("user", 0.15)

    user_penalty = max(0.0, 100.0 - node.user_count * 20.0)

    score = (
        w_cpu  * node.cpu_free_pct
        + w_mem  * node.mem_free_pct
        + w_gpu  * node.gpu_free_pct
        + w_user * user_penalty
    )
    return round(max(0.0, min(100.0, score)), 1)


def score_all(nodes: list[CnodeNodeInfo], weights: dict[str, float]) -> None:
    """Assign idle scores to all nodes in-place."""
    for node in nodes:
        node.idle_score = score_node(node, weights)
