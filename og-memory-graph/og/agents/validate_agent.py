from __future__ import annotations
from dataclasses import dataclass
from og.core.graph import OutlineGraph
from og.core.node import NodeType, NodeStatus
from og.core.edge import EdgeType


@dataclass
class ValidationIssue:
    check: str
    node_id: str
    severity: str
    description: str


class ValidateAgent:

    def validate(self, og: OutlineGraph,
                 task_year_range: tuple[int, int] | None = None,
                 abort_on_critical: bool = False) -> list[ValidationIssue]:
        issues = []

        issues.extend(self._check_orphans(og))
        issues.extend(self._check_unsupported_claims(og))
        issues.extend(self._check_synthesis_deps(og))
        issues.extend(self._check_comparisons(og))
        issues.extend(self._check_temporal(og))
        issues.extend(self._check_citations(og))
        issues.extend(self._check_supersede_chain(og))

        issues.extend(self._check_active_node_has_content(og))
        issues.extend(self._check_no_circular_supersedes(og))
        issues.extend(self._check_section_tree_well_formed(og))
        issues.extend(self._check_cited_refs_exist(og))
        if task_year_range is not None:
            issues.extend(self._check_data_year_in_task(og, task_year_range))


        if abort_on_critical:
            criticals = [i for i in issues if i.severity == "critical"]
            if criticals:
                msg = "; ".join(f"[{i.check}] {i.description}"
                                for i in criticals[:3])
                raise ValueError(f"Validate aborted: {len(criticals)} critical issue(s). "
                                  f"E.g.: {msg}")
        return issues

    def _check_orphans(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        for node in og.active_content_nodes():
            if not og.get_incoming_edges(node.id, EdgeType.CONTAINS):
                issues.append(ValidationIssue("orphan", node.id, "error",
                                              f"节点'{node.title}'无父Section"))
        return issues

    def _check_unsupported_claims(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        from og.core.node import RhetoricalRole
        for node in og.get_all_nodes(NodeType.CLAIM, NodeStatus.ACTIVE):
            if node.rhetorical_role in (RhetoricalRole.COUNTERPOINT, RhetoricalRole.QUALIFICATION):
                continue
            if og.count_active_supports(node.id) == 0:
                issues.append(ValidationIssue("unsupported_claim", node.id, "warning",
                                              f"论点'{node.title}'无有效证据支撑"))
        return issues

    def _check_synthesis_deps(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        for node in og.get_all_nodes(NodeType.SYNTHESIS, NodeStatus.ACTIVE):
            derives = og.get_incoming_edges(node.id, EdgeType.DERIVES_FROM)
            deprecated_count = sum(1 for e in derives
                                   if og.get_node(e.source_id) and
                                   og.get_node(e.source_id).status != NodeStatus.ACTIVE)
            if deprecated_count > 0:
                issues.append(ValidationIssue("stale_synthesis", node.id, "warning",
                                              f"综合判断'{node.title}'有{deprecated_count}个已废弃的前提"))
            if len(derives) < 2:
                issues.append(ValidationIssue("weak_synthesis", node.id, "warning",
                                              f"综合判断'{node.title}'仅有{len(derives)}条推导来源"))
        return issues

    def _check_comparisons(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        for node in og.get_all_nodes(NodeType.COMPARISON, NodeStatus.ACTIVE):
            compared = og.get_incoming_edges(node.id, EdgeType.COMPARED_IN)
            if len(compared) < 2:
                issues.append(ValidationIssue("incomplete_comparison", node.id, "warning",
                                              f"对照节点'{node.title}'仅有{len(compared)}条被比较入边"))
        return issues

    def _check_temporal(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if node.temporal_scope and node.temporal_scope.isdigit():
                if int(node.temporal_scope) > og.base_year:
                    issues.append(ValidationIssue("temporal_leak", node.id, "error",
                                                  f"节点'{node.title}'的data_year {node.temporal_scope} > base_year {og.base_year}"))
        return issues

    def _check_citations(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        for edge in [e for e in og._edges if e.type == EdgeType.CITES]:
            ref = og.get_node(edge.target_id)
            if ref and ref.status in (NodeStatus.DEPRECATED,):
                issues.append(ValidationIssue("retracted_citation", edge.source_id, "error",
                                              f"节点引用了已撤回的文献{edge.target_id}"))
        return issues

    def _check_supersede_chain(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        for node in og.get_all_nodes(status=NodeStatus.SUPERSEDED):
            supersede_edges = og.get_outgoing_edges(node.id, EdgeType.SUPERSEDES)
            if not supersede_edges:
                issues.append(ValidationIssue("broken_supersede", node.id, "error",
                                              f"已被替代节点'{node.title}'无supersedes出边"))
        return issues



    def _check_active_node_has_content(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        skip_types = {NodeType.SECTION, NodeType.REFERENCE, NodeType.TABLE,
                       NodeType.TRANSITION}
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if node.type in skip_types:
                continue
            if not (node.content_summary or "").strip():
                issues.append(ValidationIssue("empty_content", node.id, "warning",
                                                f"active 节点'{node.title}'的 content_summary 为空"))
        return issues

    def _check_no_circular_supersedes(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []

        visited = {}
        path = set()
        def _dfs(nid):
            if nid in path:
                issues.append(ValidationIssue("circular_supersedes", nid, "critical",
                                                f"SUPERSEDES 边出现环, 节点 {nid} 在环上"))
                return True
            if visited.get(nid) == "done":
                return False
            visited[nid] = "in"
            path.add(nid)
            for e in og.get_outgoing_edges(nid, EdgeType.SUPERSEDES):
                if _dfs(e.target_id):
                    return True
            path.discard(nid)
            visited[nid] = "done"
            return False
        for n in og.get_all_nodes():
            if visited.get(n.id) == "done":
                continue
            _dfs(n.id)
        return issues

    def _check_section_tree_well_formed(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []
        root = og.get_root()
        for sec in og.get_all_nodes(NodeType.SECTION, NodeStatus.ACTIVE):
            if root and sec.id == root.id:
                continue
            in_edges = og.get_incoming_edges(sec.id, EdgeType.CONTAINS)
            if len(in_edges) != 1:
                issues.append(ValidationIssue(
                    "section_tree_anomaly", sec.id, "warning",
                    f"section '{sec.title}' 有 {len(in_edges)} 条 CONTAINS 入边 (期望 1)"))
        return issues

    def _check_cited_refs_exist(self, og: OutlineGraph) -> list[ValidationIssue]:
        issues = []

        active_refs = {n.ref_number for n in og.get_all_nodes(NodeType.REFERENCE, NodeStatus.ACTIVE)
                        if n.ref_number is not None}
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if node.type in (NodeType.REFERENCE, NodeType.SECTION):
                continue
            missing = []
            for r in (node.cited_refs or []):
                try:
                    rn = int(r)
                except (TypeError, ValueError):
                    continue
                if rn not in active_refs:
                    missing.append(rn)
            if missing:
                issues.append(ValidationIssue(
                    "dangling_cited_refs", node.id, "warning",
                    f"节点'{node.title}'的 cited_refs {missing} 找不到对应 active Reference"))
        return issues

    def _check_data_year_in_task(self, og: OutlineGraph,
                                    task_year_range: tuple[int, int]) -> list[ValidationIssue]:
        issues = []
        lo, hi = task_year_range
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if not node.data_blocks:
                continue
            out_of_range = []
            for db in node.data_blocks:
                if db.data_year is None:
                    continue
                try:
                    y = int(db.data_year)
                except (ValueError, TypeError):
                    continue
                if not (lo <= y <= hi):
                    out_of_range.append(y)
            if out_of_range:
                issues.append(ValidationIssue(
                    "data_year_out_of_task", node.id, "warning",
                    f"节点'{node.title}'有 {len(out_of_range)} 个 data_block "
                    f"data_year ∉ [{lo},{hi}]: {out_of_range[:3]}"))
        return issues
