from __future__ import annotations
import json
from pathlib import Path
from typing import Optional
import networkx as nx

from .node import OGNode, NodeType, NodeStatus
from .edge import OGEdge, EdgeType


class OutlineGraph:

    def __init__(self, report_id: str = "REPORT", base_year: int = 0, version: str = "v1.0",
                 topic: str = ""):
        self.report_id = report_id
        self.base_year = base_year
        self.version = version
        self.topic = topic
        self._g = nx.DiGraph()
        self._nodes: dict[str, OGNode] = {}
        self._edges: list[OGEdge] = []
        self._id_counter = 0

    def generate_id(self, prefix: str = "OG") -> str:
        self._id_counter += 1
        return f"{prefix}-{self.report_id}-{self._id_counter:04d}"



    def add_node(self, node: OGNode):
        self._nodes[node.id] = node
        self._g.add_node(node.id, type=node.type.value, status=node.status.value)

    def get_node(self, node_id: str) -> Optional[OGNode]:
        return self._nodes.get(node_id)

    def get_node_at_version(self, node_id: str,
                              version: str) -> Optional[dict]:
        node = self._nodes.get(node_id)
        if not node:
            return None
        if version == node.last_updated_version:
            d = node.to_dict()
            d.pop("snapshot_version_history", None)
            return d
        return node.snapshot_version_history.get(version)

    def update_node(self, node: OGNode):
        self._nodes[node.id] = node
        self._g.nodes[node.id]["status"] = node.status.value

    def get_all_nodes(self, node_type: Optional[NodeType] = None,
                      status: Optional[NodeStatus] = None) -> list[OGNode]:
        result = list(self._nodes.values())
        if node_type:
            result = [n for n in result if n.type == node_type]
        if status:
            result = [n for n in result if n.status == status]
        return result

    def active_content_nodes(self) -> list[OGNode]:
        return [n for n in self._nodes.values()
                if n.status == NodeStatus.ACTIVE and n.type not in (NodeType.SECTION, NodeType.REFERENCE)]



    def add_edge(self, edge: OGEdge):
        self._edges.append(edge)
        self._g.add_edge(edge.source_id, edge.target_id,
                         type=edge.type.value, strength=edge.strength.value)

    def get_outgoing_edges(self, node_id: str, edge_type: Optional[EdgeType] = None) -> list[OGEdge]:
        return [e for e in self._edges
                if e.source_id == node_id and (edge_type is None or e.type == edge_type)]

    def get_incoming_edges(self, node_id: str, edge_type: Optional[EdgeType] = None) -> list[OGEdge]:
        return [e for e in self._edges
                if e.target_id == node_id and (edge_type is None or e.type == edge_type)]

    def get_all_edges_for(self, node_id: str) -> list[OGEdge]:
        return [e for e in self._edges if e.source_id == node_id or e.target_id == node_id]

    def count_active_supports(self, target_id: str) -> int:
        return sum(1 for e in self._edges
                   if e.target_id == target_id and e.type == EdgeType.SUPPORTS
                   and self._nodes.get(e.source_id, OGNode("", NodeType.EVIDENCE, "")).status == NodeStatus.ACTIVE)

    def remove_edge(self, edge: OGEdge):
        self._edges = [e for e in self._edges
                       if not (e.source_id == edge.source_id and e.target_id == edge.target_id and e.type == edge.type)]
        if self._g.has_edge(edge.source_id, edge.target_id):
            self._g.remove_edge(edge.source_id, edge.target_id)

    def remove_node(self, node_id: str):

        self._edges = [e for e in self._edges
                       if e.source_id != node_id and e.target_id != node_id]

        if self._g.has_node(node_id):
            self._g.remove_node(node_id)

        self._nodes.pop(node_id, None)



    def get_children(self, node_id: str, node_type: Optional[NodeType] = None) -> list[OGNode]:
        children = []
        for e in self.get_outgoing_edges(node_id, EdgeType.CONTAINS):
            child = self.get_node(e.target_id)
            if child and (node_type is None or child.type == node_type):
                children.append(child)
        return children

    def get_sections(self) -> list[OGNode]:
        return self.get_all_nodes(NodeType.SECTION, NodeStatus.ACTIVE)

    def get_root(self) -> Optional[OGNode]:
        sections = self.get_sections()
        for s in sections:
            if not self.get_incoming_edges(s.id, EdgeType.CONTAINS):
                return s
        return sections[0] if sections else None

    def get_leaf_sections(self) -> list[OGNode]:
        result = []
        for s in self.get_sections():
            child_sections = self.get_children(s.id, NodeType.SECTION)
            if not child_sections:
                result.append(s)
        return result

    def get_section_subtree_nodes(self, section_id: str) -> list[OGNode]:
        nodes = []
        queue = [section_id]
        visited = set()
        while queue:
            nid = queue.pop(0)
            if nid in visited:
                continue
            visited.add(nid)
            node = self.get_node(nid)
            if node:
                nodes.append(node)
                for child in self.get_children(nid):
                    queue.append(child.id)
        return nodes



    def stats(self) -> dict:
        active = [n for n in self._nodes.values() if n.status == NodeStatus.ACTIVE]
        type_counts = {}
        for n in active:
            type_counts[n.type.value] = type_counts.get(n.type.value, 0) + 1
        edge_type_counts = {}
        for e in self._edges:
            edge_type_counts[e.type.value] = edge_type_counts.get(e.type.value, 0) + 1
        return {
            "total_nodes": len(active),
            "total_edges": len(self._edges),
            "node_types": type_counts,
            "edge_types": edge_type_counts,
            "version": self.version,
            "base_year": self.base_year,
        }



    def to_dict(self) -> dict:
        return {
            "report_id": self.report_id,
            "base_year": self.base_year,
            "version": self.version,
            "topic": self.topic,
            "id_counter": self._id_counter,
            "nodes": {nid: n.to_dict() for nid, n in self._nodes.items()},
            "edges": [e.to_dict() for e in self._edges],
        }

    @classmethod
    def from_dict(cls, d: dict) -> OutlineGraph:
        og = cls(d["report_id"], d["base_year"], d["version"],
                 topic=d.get("topic", ""))
        og._id_counter = d.get("id_counter", 0)
        for nid, nd in d["nodes"].items():
            og.add_node(OGNode.from_dict(nd))
        for ed in d["edges"]:
            og.add_edge(OGEdge.from_dict(ed))
        return og

    def save(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: Path) -> OutlineGraph:
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))
