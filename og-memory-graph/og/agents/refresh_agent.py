from __future__ import annotations
import os
import re
from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus, StalenessRisk, ChangeLogEntry
from og.core.edge import EdgeType
from og.agents.propagate_agent import AffectedNode


_HISTORICAL_PREFIXES = (

    "较", "比", "从", "自",

    "since", "compared", "from", "versus", "vs", "relative to",
    "compared to", "compared with", "as of", "up to"
)










REFRESH_MAX_DATA_BLOCKS_PER_EVIDENCE: int | None = None
REFRESH_MAX_CONTENT_FALLBACK_CHARS: int | None = None
REFRESH_MAX_PARTS_IN_JOIN: int | None = None




import os as _os
REFRESH_REBUILD_MODE = _os.environ.get("REFRESH_REBUILD_MODE", "rules").lower()


_YEAR_RE = re.compile(r'(\d{4})年|(?:in|In)\s+(\d{4})|\b(\d{4})\s+(?:data|year|report)')




_DASH_YEAR_PATTERN = re.compile(r'(\d{4})-(?=[\u4e00-\u9fffA-Za-z])')





_ERA_ANCHORS = [
    (re.compile(r'新冠|疫情|covid|COVID|pandemic|Pandemic', re.IGNORECASE), 2020),
    (re.compile(r'(\d{4})年代|(\d{4})年初|(\d{4})年底|(\d{4})财年|FY(\d{4})|Q[1-4]\s*(\d{4})|'
                r'(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})|'
                r'(\d{4})\s+Q[1-4]', re.IGNORECASE),
     None),
]


class RefreshAgent:

    def refresh(self, og: OutlineGraph, old_base_year: int, new_base_year: int,
                affected: list[AffectedNode], version: str) -> dict:
        report = {
            "section_titles_updated": [],
            "temporal_framing_normalized": [],
            "titles_cleaned": [],
            "stale_nodes_refreshed": [],
            "stale_nodes_skipped_drift": [],
            "dash_year_fixed": [],
            "temporal_scopes_fixed": [],
        }

        self._update_section_titles(og, old_base_year, new_base_year, version, report)
        self._fix_dash_year_in_content(og, version, report)
        self._normalize_temporal_framing(og, old_base_year, new_base_year, version, report)
        self._clean_task_titles(og, version, report)
        self._refresh_stale_nodes(og, affected, old_base_year, new_base_year, version, report)
        self._fix_temporal_scopes(og, old_base_year, new_base_year, version, report)

        return report



    def _fix_dash_year_in_content(self, og: OutlineGraph, version: str, report: dict):
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if node.type in (NodeType.SECTION, NodeType.REFERENCE, NodeType.TABLE):
                continue
            if not node.content_summary:
                continue
            old = node.content_summary
            new = _DASH_YEAR_PATTERN.sub(r'\1年', old)
            if new != old:
                node.content_summary = new
                node.last_updated_version = version
                node.change_log.append(ChangeLogEntry(
                    version, "DASH_YEAR_FIX",
                    description="清理 'YYYY-名词' 残缺时间表述"
                ))
                og.update_node(node)
                report["dash_year_fixed"].append({"id": node.id, "title": node.title[:40]})


    _TASK_PATTERNS = [

        re.compile(r"^新增\s*"),
        re.compile(r"^补充\s*"),
        re.compile(r"^扩展至?\s*"),
        re.compile(r"更新至?\d*年?数据?$"),
        re.compile(r"^报告摘要更新$"),
        re.compile(r"^\d{4}年报告摘要更新$"),
        re.compile(r"^\d{4}年.*更新$"),
        re.compile(r"^结论新增[:：]\s*"),

        re.compile(r"^added\s+", re.IGNORECASE),
        re.compile(r"^new\s+", re.IGNORECASE),
        re.compile(r"^supplemented?\s+", re.IGNORECASE),
        re.compile(r"^expanded?\s+", re.IGNORECASE),
        re.compile(r"updated?\s+to\s+\d{4}", re.IGNORECASE),
        re.compile(r"^\d{4}\s+update", re.IGNORECASE),
    ]
    _QUANTITY_RE = re.compile(r"^[一二三四五六七八九十百千]+[条项大]")

    def _clean_task_titles(self, og: OutlineGraph, version: str, report: dict):
        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if node.type in (NodeType.SECTION, NodeType.REFERENCE, NodeType.TABLE):
                continue

            old_title = node.title
            new_title = old_title

            for pattern in self._TASK_PATTERNS:
                new_title = pattern.sub("", new_title)
            new_title = self._QUANTITY_RE.sub("", new_title)
            new_title = re.sub(r"^[:：\s]+", "", new_title).strip()

            if not new_title:
                new_title = "核心发现"

            if new_title != old_title:
                node.title = new_title
                node.last_updated_version = version
                node.change_log.append(ChangeLogEntry(
                    version, "TITLE_CLEAN",
                    description=f"'{old_title}' → '{new_title}'"
                ))
                og.update_node(node)
                report["titles_cleaned"].append({
                    "id": node.id, "old": old_title, "new": new_title,
                })



    def _update_section_titles(self, og: OutlineGraph, old_year: int, new_year: int,
                                version: str, report: dict):
        old_str = f"{old_year}年"
        new_str = f"{new_year}年"
        for section in og.get_sections():
            if old_str in section.title:
                old_title = section.title
                section.title = section.title.replace(old_str, new_str)
                section.last_updated_version = version
                section.change_log.append(ChangeLogEntry(
                    version, "REFRESH",
                    description=f"Section标题年份更新: {old_title} → {section.title}"
                ))
                og.update_node(section)
                report["section_titles_updated"].append({
                    "id": section.id, "old": old_title, "new": section.title
                })



    def _normalize_temporal_framing(self, og: OutlineGraph, old_year: int, new_year: int,
                                     version: str, report: dict):
        old_str = f"{old_year}年"

        for node in og.get_all_nodes(status=NodeStatus.ACTIVE):
            if node.type == NodeType.SECTION:
                continue
            if old_str not in node.title and old_str not in node.content_summary:
                continue

            continuity = self._assess_continuity(og, node, version)
            changes = []

            if old_str in node.title:
                old_title = node.title
                new_title = self._apply_title_policy(node.title, old_year, new_year, continuity)
                if new_title != old_title:
                    node.title = new_title
                    changes.append(f"标题: '{old_title}' → '{new_title}'")

            if old_str in node.content_summary:
                new_content = self._apply_content_policy(
                    node.content_summary, old_year, new_year, continuity
                )
                if new_content != node.content_summary:
                    node.content_summary = new_content
                    changes.append(f"内容({continuity})")

            if changes:
                node.last_updated_version = version
                node.change_log.append(ChangeLogEntry(
                    version, "TEMPORAL_NORMALIZE",
                    description=f"时间语义规范化({continuity}): {'; '.join(changes)}"
                ))
                og.update_node(node)
                report["temporal_framing_normalized"].append({
                    "id": node.id, "type": node.type.value,
                    "title": node.title, "continuity": continuity,
                    "changes": changes,
                })

    def _assess_continuity(self, og: OutlineGraph, node: OGNode, version: str) -> str:
        if node.type in (NodeType.EVIDENCE, NodeType.REFERENCE):
            return "data_only"

        if node.created_in_version == version:
            return "new"

        has_supersede_action = False
        for entry in node.change_log:
            if entry.version == version and entry.action in ("SUPERSEDE", "UPDATE"):
                has_supersede_action = True
                break

        if node.last_updated_version == version:
            if has_supersede_action:
                return "continuing"
            return "continuing"

        return "continuing"

    def _apply_title_policy(self, title: str, old_year: int, new_year: int,
                             continuity: str) -> str:
        old_str = f"{old_year}年"
        if continuity == "new":
            return title.replace(old_str, f"{new_year}年")
        if continuity == "continuing":
            return title.replace(old_str, "")
        if continuity == "data_only":
            return title
        return title.replace(old_str, "")

    def _apply_content_policy(self, content: str, old_year: int, new_year: int,
                               continuity: str) -> str:
        old_str = f"{old_year}年"

        if continuity == "data_only":
            return content

        result = []
        i = 0
        while i < len(content):
            pos = content.find(old_str, i)
            if pos == -1:
                result.append(content[i:])
                break

            result.append(content[i:pos])

            if self._is_historical_reference(content, pos, old_year):
                result.append(old_str)
            elif continuity == "new":
                result.append(f"{new_year}年")
            elif continuity == "continuing":
                result.append("")
            elif continuity == "changed":
                result.append(old_str)
            else:
                result.append("")

            i = pos + len(old_str)

        return "".join(result)

    @staticmethod
    def _is_historical_reference(text: str, pos: int, old_year: int) -> bool:
        if pos > 0:
            preceding = text[max(0, pos - 5):pos].strip()
            for prefix in _HISTORICAL_PREFIXES:
                if preceding.endswith(prefix):
                    return True

        old_str = f"{old_year}年"
        after_pos = pos + len(old_str)
        if after_pos < len(text):
            after_text = text[after_pos:after_pos + 5]
            if any(marker in after_text for marker in ["为10", "为0.", "为9"]):
                return True

        return False



    def _refresh_stale_nodes(self, og: OutlineGraph, affected: list[AffectedNode],
                              old_year: int, new_year: int,
                              version: str, report: dict):
        high_medium = [a for a in affected
                       if a.adjusted_priority in ("high", "medium")
                       and a.node.status == NodeStatus.ACTIVE
                       and a.node.last_updated_version != version]

        for an in high_medium:
            node = an.node
            if node.type not in (NodeType.CLAIM, NodeType.SYNTHESIS, NodeType.COMPARISON):
                continue

            new_evidence = self._gather_active_evidence(og, node)
            if not new_evidence:
                continue







            if self._is_era_drift(node, new_evidence, new_year):
                node.change_log.append(ChangeLogEntry(
                    version, "REFRESH_SKIPPED_DRIFT",
                    description=(f"跳过 inline 重建: 标题年代锚定与新证据 "
                                 f"data_year 偏离≥2年, 应使用 SUPERSEDE")
                ))
                og.update_node(node)
                report["stale_nodes_skipped_drift"].append({
                    "id": node.id, "title": node.title, "type": node.type.value,
                    "evidence_count": len(new_evidence),
                })
                continue


            if REFRESH_REBUILD_MODE == "llm":
                refreshed = self._llm_rebuild_node_content(og, node, new_evidence)
                rebuild_method = "llm"
            else:
                refreshed = self._rebuild_node_content(og, node, new_evidence)
                rebuild_method = "rules"
            if refreshed:
                node.content_summary = refreshed
                node.last_updated_version = version
                node.staleness_risk = StalenessRisk.LOW
                node.change_log.append(ChangeLogEntry(
                    version, "REFRESH",
                    description=f"基于更新后的支撑证据自动刷新内容 "
                                f"({an.impact_type}, mode={rebuild_method})"
                ))
                og.update_node(node)
                report["stale_nodes_refreshed"].append({
                    "id": node.id, "title": node.title, "type": node.type.value,
                    "reason": an.impact_type, "evidence_count": len(new_evidence),
                    "rebuild_method": rebuild_method,
                })

    def _llm_rebuild_node_content(self, og, node, evidence: list) -> str:
        try:
            from openai import OpenAI
            try:
                from config_models import LLM_UTIL
            except ImportError:
                LLM_UTIL = "gpt-4o-mini"
            api_key = os.environ.get("OPENAI_API_KEY", "")
            if not api_key:

                return self._rebuild_node_content(og, node, evidence)
            base_url = os.environ.get("OPENAI_API_BASE", "https://yeysai.com/v1")
            client = OpenAI(api_key=api_key, base_url=base_url, timeout=60, max_retries=0)

            ev_lines = []
            for ev in evidence[:20]:
                line = f"  - [{ev.id}] {ev.title or ''}\n    content: {(ev.content_summary or '')[:200]}"
                if ev.data_blocks:
                    db_str = "; ".join(f"{db.label}={db.value}({db.data_year})"
                                          for db in ev.data_blocks[:5])
                    line += f"\n    data_blocks: {db_str}"
                ev_lines.append(line)
            sys_prompt = (
                "你是一位严谨的研究报告编辑助手. 给定一个 OG 节点 (Claim/Synthesis/Comparison)\n"
                "与它相关的最新支撑 Evidence 节点列表, 请重写该节点的 content_summary.\n\n"
                "硬约束:\n"
                "- 完全保留 Evidence 里的关键事实/数据点/年份\n"
                "- 行文流畅客观, 不要列表, 不要 markdown\n"
                "- **不要硬编码字数** — 篇幅由证据信息密度决定, 不要刻意压缩\n"
                "- 直接输出重写后的 content_summary (不要解释, 不要前后文)"
            )
            user_msg = (
                f"【节点 type】 {node.type.value}\n"
                f"【节点 title】 {node.title}\n"
                f"【当前 content_summary (可能过时)】\n{(node.content_summary or '')[:800]}\n\n"
                f"【最新支撑 Evidence】\n" + "\n".join(ev_lines)
            )
            r = client.chat.completions.create(
                model=LLM_UTIL,
                messages=[
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_msg},
                ],
                temperature=0.0, max_tokens=4000,
            )
            new_text = (r.choices[0].message.content or "").strip()
            return new_text or self._rebuild_node_content(og, node, evidence)
        except Exception as e:
            print(f"  [warn] U5 LLM rebuild 失败 ({type(e).__name__}: {str(e)[:60]}), "
                  f"降级到规则")
            return self._rebuild_node_content(og, node, evidence)

    @staticmethod
    def _is_era_drift(node: OGNode, evidence: list[OGNode], new_year: int) -> bool:
        title = node.title or ""
        anchor_year = None
        for pat, fixed_year in _ERA_ANCHORS:
            m = pat.search(title)
            if not m:
                continue
            if fixed_year is not None:
                anchor_year = fixed_year
            else:
                for g in m.groups():
                    if g and g.isdigit():
                        anchor_year = int(g)
                        break
            if anchor_year:
                break
        if anchor_year is None:
            return False
        ev_years = [ev.data_blocks[0].data_year for ev in evidence
                    if ev.data_blocks and ev.data_blocks[0].data_year]
        if not ev_years:
            ev_years = [new_year]
        latest = max(ev_years)
        return abs(latest - anchor_year) >= 2



    def _fix_temporal_scopes(self, og: OutlineGraph, old_year: int, new_year: int,
                              version: str, report: dict):
        for node in og.active_content_nodes():
            if node.temporal_scope == str(old_year):
                should_update = False
                if node.last_updated_version == version:
                    should_update = True
                else:
                    for edge in og.get_incoming_edges(node.id, EdgeType.SUPPORTS):
                        ev = og.get_node(edge.source_id)
                        if ev and ev.status == NodeStatus.ACTIVE:
                            if ev.temporal_scope == str(new_year):
                                should_update = True
                                break
                    if not should_update:
                        for child in og.get_children(node.id):
                            if child.type != NodeType.SECTION and child.status == NodeStatus.ACTIVE:
                                if child.temporal_scope == str(new_year):
                                    should_update = True
                                    break

                if should_update:
                    old_scope = node.temporal_scope
                    node.temporal_scope = str(new_year)
                    og.update_node(node)
                    report["temporal_scopes_fixed"].append({
                        "id": node.id, "title": node.title,
                        "old_scope": old_scope, "new_scope": str(new_year),
                    })



    def _gather_active_evidence(self, og: OutlineGraph, node: OGNode) -> list[OGNode]:
        evidence = []
        seen = set()
        for edge in og.get_incoming_edges(node.id, EdgeType.SUPPORTS):
            ev = og.get_node(edge.source_id)
            if ev and ev.status == NodeStatus.ACTIVE and ev.id not in seen:
                evidence.append(ev)
                seen.add(ev.id)
        for child in og.get_children(node.id):
            if (child.type == NodeType.EVIDENCE and child.status == NodeStatus.ACTIVE
                    and child.id not in seen):
                evidence.append(child)
                seen.add(child.id)
        return evidence

    def _rebuild_node_content(self, og: OutlineGraph, node: OGNode,
                               evidence: list[OGNode]) -> str:
        data_parts = []
        for ev in evidence:
            if ev.data_blocks:

                blocks = (ev.data_blocks
                          if REFRESH_MAX_DATA_BLOCKS_PER_EVIDENCE is None
                          else ev.data_blocks[:REFRESH_MAX_DATA_BLOCKS_PER_EVIDENCE])
                for db in blocks:
                    ref_str = f"[{db.source_ref}]" if db.source_ref else ""
                    data_parts.append(f"{db.label}{db.value}{ref_str}")
            elif ev.content_summary:

                cs = (ev.content_summary
                      if REFRESH_MAX_CONTENT_FALLBACK_CHARS is None
                      else ev.content_summary[:REFRESH_MAX_CONTENT_FALLBACK_CHARS])
                data_parts.append(cs)

        if not data_parts:
            return ""

        base = node.title
        if node.type == NodeType.CLAIM:
            return f"{base}。具体而言，{self._join_parts(data_parts)}。"
        elif node.type == NodeType.SYNTHESIS:
            return f"{base}。综合最新数据：{self._join_parts(data_parts)}。"
        elif node.type == NodeType.COMPARISON:
            return f"{base}。对比数据显示：{self._join_parts(data_parts)}。"
        return ""

    @staticmethod
    def _join_parts(parts: list[str]) -> str:

        cap = REFRESH_MAX_PARTS_IN_JOIN
        if cap is None or len(parts) <= cap:
            return "；".join(parts)
        return "；".join(parts[:cap]) + f"等{len(parts)}项指标"
