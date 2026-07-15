from __future__ import annotations
import re
import json
from pathlib import Path
from typing import Optional

from og.core.node import OGNode, NodeType, RhetoricalRole, StalenessRisk, DataBlock
from og.core.edge import OGEdge, EdgeType, EdgeStrength
from og.core.graph import OutlineGraph




BUILD_SECTION_CONTENT_MAX_CHARS: int | None = None


class BuildAgent:

    def __init__(self, agent_output_path: Optional[Path] = None):
        self.agent_output = None
        if agent_output_path and agent_output_path.exists():
            with open(agent_output_path, encoding="utf-8") as f:
                self.agent_output = json.load(f)

    def build(self, raw_report: str, report_id: str = "01", base_year: int = 2023,
              version: str = "v1.0") -> OutlineGraph:
        og = OutlineGraph(report_id, base_year, version)
        sections = self._parse_sections(raw_report)

        root = OGNode(
            id=og.generate_id(), type=NodeType.SECTION, title="报告根节点",
            rhetorical_role=RhetoricalRole.CONTAINER, staleness_risk=StalenessRisk.LOW,
            created_in_version=version, last_updated_version=version,
        )
        og.add_node(root)

        section_nodes = {}
        for sec in sections:
            raw_content = sec["content"] or ""
            cap = BUILD_SECTION_CONTENT_MAX_CHARS
            content_summary = raw_content if cap is None else raw_content[:cap]
            sn = OGNode(
                id=og.generate_id(), type=NodeType.SECTION, title=sec["title"],
                rhetorical_role=RhetoricalRole.CONTAINER,
                content_summary=content_summary,
                level=sec["level"], line_start=sec.get("line_start"), line_end=sec.get("line_end"),
                staleness_risk=StalenessRisk.LOW,
                created_in_version=version, last_updated_version=version,
            )
            og.add_node(sn)
            section_nodes[sec["title"]] = sn

            parent_id = root.id
            if sec["level"] > 1:
                for prev in reversed(sections[:sections.index(sec)]):
                    if prev["level"] < sec["level"]:
                        parent_id = section_nodes[prev["title"]].id
                        break
            og.add_edge(OGEdge(parent_id, sn.id, EdgeType.CONTAINS, created_in_version=version))

        if self.agent_output:
            self._apply_agent_output(og, self.agent_output, version, section_nodes)

        self._update_patterns(og)
        return og

    @property
    def id_map(self) -> dict:
        return getattr(self, '_id_map', {})

    def _parse_sections(self, raw: str) -> list[dict]:
        sections = []
        lines = raw.split("\n")
        current_title, current_level, current_content, line_start = None, 0, [], 0

        for i, line in enumerate(lines):
            m = re.match(r'^(#{1,3})\s+(.+)$', line)
            if m:
                if current_title:
                    sections.append({
                        "title": current_title, "level": current_level,
                        "content": "\n".join(current_content),
                        "line_start": line_start, "line_end": i - 1,
                    })
                current_title = m.group(2).strip()
                current_level = len(m.group(1))
                current_content = []
                line_start = i
            elif current_title:
                current_content.append(line)

        if current_title:
            sections.append({
                "title": current_title, "level": current_level,
                "content": "\n".join(current_content),
                "line_start": line_start, "line_end": len(lines) - 1,
            })
        return sections

    def _apply_agent_output(self, og: OutlineGraph, output: dict, version: str,
                            section_nodes: dict):
        id_map = {}
        self._id_map = id_map

        for nd in output.get("nodes", []):
            node = OGNode(
                id=og.generate_id(nd.get("id_prefix", "OG")),
                type=NodeType(nd["type"]),
                title=nd["title"],
                rhetorical_role=RhetoricalRole(nd.get("rhetorical_role", "evidence")),
                content_summary=nd.get("content_summary", ""),
                original_text=nd.get("original_text", ""),
                data_blocks=[DataBlock(**db) for db in nd.get("data_blocks", [])],
                cited_refs=nd.get("cited_refs", []),
                temporal_scope=nd.get("temporal_scope", ""),
                staleness_risk=StalenessRisk(nd.get("staleness_risk", "medium")),
                confidence=nd.get("confidence", 0.9),
                created_in_version=version,
                last_updated_version=version,
            )
            if node.type == NodeType.REFERENCE:
                node.ref_number = nd.get("ref_number")
                node.author = nd.get("author", "")
                node.url = nd.get("url", "")
                node.publish_date = nd.get("publish_date", "")
                node.data_year = nd.get("data_year", "")
                node.tier = nd.get("tier", "")

            og.add_node(node)
            id_map[nd["temp_id"]] = node.id

            parent_section = nd.get("parent_section", "")
            if parent_section and parent_section in section_nodes:
                og.add_edge(OGEdge(section_nodes[parent_section].id, node.id,
                                   EdgeType.CONTAINS, created_in_version=version))

        for ed in output.get("edges", []):
            src = id_map.get(ed["source"], ed["source"])
            tgt = id_map.get(ed["target"], ed["target"])
            if og.get_node(src) and og.get_node(tgt):
                og.add_edge(OGEdge(
                    src, tgt, EdgeType(ed["type"]),
                    strength=EdgeStrength(ed.get("strength", "moderate")),
                    notes=ed.get("reason", ""),
                    confidence=ed.get("confidence", 0.8),
                    created_in_version=version,
                ))

    def _update_patterns(self, og: OutlineGraph):
        from og.core.node import NodeStatus
        patterns = {}
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            key = f"{node.type.value}_{node.rhetorical_role.value}"
            patterns[key] = patterns.get(key, 0) + 1
        self._learned_patterns = patterns
