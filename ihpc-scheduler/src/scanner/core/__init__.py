"""Core domain layer — pure data models and scoring logic.

This layer has no external dependencies and no I/O.
"""

from .models import CnodeNodeInfo, GPUInfo, NodeMetrics, NodeState, ScanResult, WeightPreset
from .scorer import score_all, score_node

__all__ = [
    "CnodeNodeInfo",
    "GPUInfo",
    "NodeMetrics",
    "NodeState",
    "ScanResult",
    "WeightPreset",
    "score_all",
    "score_node",
]
