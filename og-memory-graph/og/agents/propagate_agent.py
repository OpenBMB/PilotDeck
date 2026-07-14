from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus
from og.core.edge import OGEdge, EdgeType
from og.config.constants import PROPAGATION_DECAY, PROPAGATION_MAX_HOP


@dataclass
class AffectedNode:
    node: OGNode
    impact_type: str
    base_priority: str
    direction: str
    adjusted_priority: str
    hop: int
    decay_factor: float
    effective_impact: float
    reason: str = ""


class PropagateAgent:

    PRIORITY_WEIGHT = {"high": 1.0, "medium": 0.6, "low": 0.3}

    def propagate(self, og: OutlineGraph, modified_nodes: list[tuple[OGNode, str]],
                  direction_fn=None,
                  use_llm_direction: bool = False) -> list[AffectedNode]:
        if direction_fn is None and use_llm_direction:
            try:
                from og.agents.direction_agent import LLMDirectionAgent
                direction_fn = LLMDirectionAgent().judge
            except Exception as e:
                print(f"  [warn] LLMDirectionAgent 加载失败 ({e}), 用 _simple_direction")
        affected = []
        visited = set()
        queue = [(n, op, 0) for n, op in modified_nodes]

        while queue:
            node, op, hop = queue.pop(0)
            if node.id in visited:
                continue
            visited.add(node.id)

            for edge in og.get_all_edges_for(node.id):
                neighbor_id = edge.target_id if edge.source_id == node.id else edge.source_id
                neighbor = og.get_node(neighbor_id)
                if not neighbor or neighbor.id in visited or neighbor.status != NodeStatus.ACTIVE:
                    continue

                impact = self._assess_impact(og, node, neighbor, edge, op)
                if not impact:
                    continue

                impact_type, base_priority = impact

                direction = "neutral"
                if direction_fn:
                    direction = direction_fn(node, neighbor, edge)
                elif hasattr(node, '_prev_content'):
                    direction = self._simple_direction(node, neighbor)

                adjusted = self._adjust_priority(base_priority, direction)
                decay = PROPAGATION_DECAY.get(hop + 1, 0.1)
                effective = decay * self.PRIORITY_WEIGHT.get(adjusted, 0.3)

                an = AffectedNode(
                    node=neighbor, impact_type=impact_type,
                    base_priority=base_priority, direction=direction,
                    adjusted_priority=adjusted, hop=hop + 1,
                    decay_factor=decay, effective_impact=effective,
                    reason=f"{impact_type}(方向:{direction}, 衰减:{decay})"
                )
                affected.append(an)

                max_hop = PROPAGATION_MAX_HOP.get(adjusted, 1)
                if hop + 1 < max_hop:
                    queue.append((neighbor, "propagated", hop + 1))

        affected.sort(key=lambda a: -a.effective_impact)
        return affected

    def _assess_impact(self, og: OutlineGraph, source: OGNode, neighbor: OGNode,
                       edge: OGEdge, op: str) -> Optional[tuple[str, str]]:
        et = edge.type


        if source.type == NodeType.EVIDENCE and et == EdgeType.SUPPORTS and edge.source_id == source.id:
            n_supports = og.count_active_supports(neighbor.id)
            if n_supports <= 1:
                return ("sole_evidence_changed", "high")
            return ("evidence_changed", "medium")


        if source.type == NodeType.EVIDENCE and et == EdgeType.COMPARED_IN and edge.source_id == source.id:
            return ("comparison_input_changed", "high")


        if et == EdgeType.DERIVES_FROM and edge.source_id == source.id:
            return ("premise_changed", "high")


        if et == EdgeType.PARALLELS:
            return ("check_consistency", "low")


        if et == EdgeType.DEEPENS and edge.source_id == source.id:
            return ("foundation_changed", "high")


        if et == EdgeType.CONTRADICTS:
            return ("counterpoint_shifted", "medium")


        if source.type == NodeType.CONTEXT and et == EdgeType.CONTEXTUALIZES and edge.source_id == source.id:
            return ("context_shifted", "medium")


        if source.type == NodeType.COMPARISON and et == EdgeType.SUPPORTS and edge.source_id == source.id:
            return ("comparison_result_changed", "medium")


        if source.type == NodeType.TRANSITION and et == EdgeType.TRANSITIONS_TO:
            return ("transition_needs_update", "low")


        if et == EdgeType.CONTAINS and edge.source_id == source.id:
            return ("structure_changed", "low")


        if source.type == NodeType.REFERENCE and et == EdgeType.CITED_BY and edge.source_id == source.id:
            if source.status == NodeStatus.DEPRECATED:
                return ("source_retracted", "high")
            return ("source_changed", "medium")

        return None

    def _adjust_priority(self, base: str, direction: str) -> str:
        levels = ["low", "medium", "high"]
        idx = levels.index(base)
        if direction == "strengthen":
            return levels[max(0, idx - 1)]
        elif direction == "weaken":
            return levels[min(2, idx + 1)]
        return base

    def _simple_direction(self, source: OGNode, downstream: OGNode) -> str:
        return "neutral"

    def generate_report(self, affected: list[AffectedNode]) -> dict:
        high = [a for a in affected if a.adjusted_priority == "high"]
        medium = [a for a in affected if a.adjusted_priority == "medium"]
        low = [a for a in affected if a.adjusted_priority == "low"]
        return {
            "total_affected": len(affected),
            "high_impact": [{"node_id": a.node.id, "title": a.node.title,
                            "type": a.impact_type, "direction": a.direction,
                            "hop": a.hop, "effective": round(a.effective_impact, 3)} for a in high],
            "medium_impact": [{"node_id": a.node.id, "title": a.node.title,
                              "type": a.impact_type, "direction": a.direction,
                              "hop": a.hop, "effective": round(a.effective_impact, 3)} for a in medium],
            "low_impact": [{"node_id": a.node.id, "title": a.node.title,
                           "type": a.impact_type, "hop": a.hop} for a in low],
            "sections_to_rewrite": list(set(
                a.node.title for a in affected
                if a.adjusted_priority in ("high", "medium") and a.node.type == NodeType.SECTION
            )),
        }
