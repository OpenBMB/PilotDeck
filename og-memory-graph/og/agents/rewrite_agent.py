from __future__ import annotations
import re
from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus, ChangeLogEntry
from og.core.edge import EdgeType

_TASK_PATTERNS = [
    r"^新增", r"^补充", r"^扩展至?", r"更新至?\d*年?数据?$",
    r"^报告摘要更新$", r"^\d{4}年报告摘要更新$",
    r"^\d{4}年.*更新$", r"^结论新增[:：]",
]
_TASK_RE = [re.compile(p) for p in _TASK_PATTERNS]

_QUANTITY_PATTERNS = [
    (re.compile(r"^[一二三四五六七八九十百千]+条"), ""),
    (re.compile(r"^[一二三四五六七八九十百千]+项"), ""),
    (re.compile(r"^[一二三四五六七八九十百千]+大"), ""),
]


class RewriteAgent:

    def rewrite(self, og: OutlineGraph, version: str) -> dict:
        report = {
            "redundancies_merged": [],
            "syntheses_merged": [],
            "titles_normalized": [],
        }

        self._detect_and_merge_redundancy(og, version, report)
        self._merge_syntheses_per_section(og, version, report)
        self._normalize_titles(og, version, report)

        return report

    def _detect_and_merge_redundancy(self, og: OutlineGraph, version: str, report: dict):
        for section in og.get_sections():
            children = [n for n in og.get_children(section.id)
                        if n.type not in (NodeType.SECTION, NodeType.REFERENCE, NodeType.TABLE)
                        and n.status == NodeStatus.ACTIVE]

            seen_contents = {}
            for node in children:
                sig = self._content_signature(node.content_summary)
                if not sig:
                    continue
                if sig in seen_contents:
                    existing = seen_contents[sig]
                    older, newer = (existing, node) if existing.created_in_version <= node.created_in_version else (node, existing)
                    older.status = NodeStatus.DEPRECATED
                    older.change_log.append(ChangeLogEntry(
                        version, "MERGE_DEDUP",
                        description=f"与{newer.id}内容重复，合并后废弃"
                    ))
                    og.update_node(older)
                    report["redundancies_merged"].append({
                        "kept": newer.id, "removed": older.id,
                        "title": newer.title[:40],
                    })
                    seen_contents[sig] = newer
                else:
                    seen_contents[sig] = node

    @staticmethod
    def _content_signature(text: str) -> str:
        if not text or len(text) < 20:
            return ""
        clean = re.sub(r'[\s\d,.%:：;；。，！？()（）\[\]【】]', '', text)
        return clean[:60]

    def _merge_syntheses_per_section(self, og: OutlineGraph, version: str, report: dict):


        current_ver = version.split("-")[0] if "-" in version else version

        for section in og.get_sections():
            syntheses = [n for n in og.get_children(section.id)
                         if n.type == NodeType.SYNTHESIS and n.status == NodeStatus.ACTIVE]

            if len(syntheses) <= 1:
                continue



            has_current_new = any(
                (s.created_in_version or "") == current_ver for s in syntheses
            )
            if not has_current_new:
                continue

            syntheses.sort(key=lambda n: n.created_in_version)
            primary = syntheses[-1]
            for old_syn in syntheses[:-1]:
                primary.content_summary = self._merge_synthesis_content(
                    primary.content_summary, old_syn.content_summary
                )
                for ref in old_syn.cited_refs:
                    if ref not in primary.cited_refs:
                        primary.cited_refs.append(ref)

                old_syn.status = NodeStatus.DEPRECATED
                old_syn.change_log.append(ChangeLogEntry(
                    version, "MERGE_SYNTHESIS",
                    description=f"合并入{primary.id}"
                ))
                og.update_node(old_syn)

            primary.last_updated_version = version
            primary.change_log.append(ChangeLogEntry(
                version, "MERGE_SYNTHESIS",
                description=f"合并了{len(syntheses)-1}个旧版Synthesis"
            ))
            og.update_node(primary)
            report["syntheses_merged"].append({
                "section": section.title[:30],
                "kept": primary.id,
                "merged_count": len(syntheses) - 1,
            })

    @staticmethod
    def _merge_synthesis_content(new_content: str, old_content: str) -> str:
        if not old_content:
            return new_content
        if old_content in new_content:
            return new_content
        return new_content

    def _normalize_titles(self, og: OutlineGraph, version: str, report: dict):
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if node.type in (NodeType.SECTION, NodeType.REFERENCE, NodeType.TABLE):
                continue

            old_title = node.title
            new_title = self._clean_title(old_title)

            if new_title != old_title:
                node.title = new_title
                node.last_updated_version = version
                node.change_log.append(ChangeLogEntry(
                    version, "TITLE_NORMALIZE",
                    description=f"'{old_title}' → '{new_title}'"
                ))
                og.update_node(node)
                report["titles_normalized"].append({
                    "id": node.id, "old": old_title, "new": new_title,
                })

    @staticmethod
    def _clean_title(title: str) -> str:
        for pattern in _TASK_RE:
            title = pattern.sub("", title)

        for pattern, replacement in _QUANTITY_PATTERNS:
            title = pattern.sub(replacement, title)

        title = re.sub(r"^[:：\s]+", "", title)
        title = title.strip()

        return title if title else "核心发现"
