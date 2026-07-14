from __future__ import annotations
from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus, RhetoricalRole
from og.core.edge import EdgeType
from og.agents.propagate_agent import AffectedNode
try:
    from og.agents.section_renumber_agent import chinese_num
except ImportError:
    def chinese_num(n: int) -> str:
        return str(n)





RENDER_MAX_INLINE_DATA_BLOCKS: int | None = None


class RenderAgent:

    def __init__(self):
        self._ref_tier_map: dict[int, str] = {}

    def identify_sections_to_rewrite(self, og: OutlineGraph,
                                      affected: list[AffectedNode]) -> list[str]:
        section_ids = set()
        for an in affected:
            if an.adjusted_priority in ("high", "medium"):
                for p in og.get_incoming_edges(an.node.id, EdgeType.CONTAINS):
                    parent = og.get_node(p.source_id)
                    if parent and parent.type == NodeType.SECTION:
                        section_ids.add(parent.id)
        root = og.get_root()
        if root:
            for sec in og.get_children(root.id, NodeType.SECTION):
                if any(kw in sec.title.lower() for kw in ["结论", "展望", "摘要"]):
                    section_ids.add(sec.id)
        return list(section_ids)

    def render_full_report(self, og: OutlineGraph) -> str:
        self._build_ref_tier_map(og)
        self._curation_meta = getattr(og, "curation_meta", {}) or {}

        topic = (getattr(og, "topic", "") or "").strip() or "本调研课题"
        lines = [
            f"# {topic}\n",
            f"> 检索信息截止到{og.base_year}年（包含{og.base_year}年）",
            f"> 报告版本 {og.version} | 数据基线 {og.base_year}年\n",
            "---\n",
        ]

        root = og.get_root()
        if not root:
            return "（OG为空）"


        sections = [
            s for s in og.get_children(root.id, NodeType.SECTION)
            if s.status == NodeStatus.ACTIVE
            and not any(kw in (s.title or "").lower() for kw in ["参考来源", "参考文献"])
        ]
        if any(s.display_order is not None for s in sections):
            sections.sort(key=lambda s: (s.display_order or 9999, s.id))

        for section in sections:
            lines.append(self._render_section(og, section, level=2))


        appendix_md = self._render_appendix(og)
        if appendix_md.strip():
            lines.append("\n---\n")
            lines.append(appendix_md)

        lines.append("\n---\n\n## 参考文献\n")
        for ref in sorted(
            [n for n in og.get_all_nodes(NodeType.REFERENCE) if n.status == NodeStatus.ACTIVE],
            key=lambda r: r.ref_number or 0
        ):
            pub = f" {ref.publish_date}" if ref.publish_date else ""
            lines.append(f"[{ref.ref_number}] {ref.author}. {ref.title}.{pub}")
            if ref.url:
                lines.append(f"    URL: {ref.url}")
            lines.append("")

        s = og.stats()
        lines.append(f"\n---\n*报告版本 {og.version} | 数据基线 {og.base_year}年 | "
                     f"OG节点 {s['total_nodes']} | OG边 {s['total_edges']}*\n")
        return "\n".join(lines)

    def _build_ref_tier_map(self, og):
        self._ref_tier_map = {ref.ref_number: ref.tier
                               for ref in og.get_all_nodes(NodeType.REFERENCE)
                               if ref.ref_number and ref.tier}



    def _render_section(self, og, section, level):
        subs = og.get_children(section.id, NodeType.SECTION)
        content = [n for n in og.get_children(section.id)
                   if n.type != NodeType.SECTION and n.status == NodeStatus.ACTIVE]

        if not content and not any(self._has_content(og, s) for s in subs):
            return ""


        if level == 2 and section.display_order is not None and section.display_title:
            heading = f"{chinese_num(section.display_order)}、{section.display_title}"
        else:
            heading = section.title

        lines = [f"\n{'#' * level} {heading}\n"]
        if content:
            lines.append(self._render_content(og, content))
        for s in subs:
            r = self._render_section(og, s, level + 1)
            if r.strip():
                lines.append(r)
        return "\n".join(lines)

    def _has_content(self, og, section):
        if any(n.type != NodeType.SECTION and n.status == NodeStatus.ACTIVE
               for n in og.get_children(section.id)):
            return True
        return any(self._has_content(og, s) for s in og.get_children(section.id, NodeType.SECTION))



    def _render_content(self, og, nodes):
        lines = []
        rendered = set()

        contexts = [n for n in nodes if n.type == NodeType.CONTEXT]
        claims = [n for n in nodes if n.type == NodeType.CLAIM]
        evidences = [n for n in nodes if n.type == NodeType.EVIDENCE]
        comparisons = [n for n in nodes if n.type == NodeType.COMPARISON]
        syntheses = [n for n in nodes if n.type == NodeType.SYNTHESIS]
        all_tables = [n for n in nodes if n.type == NodeType.TABLE]



        tables = [t for t in all_tables if t.placement != "appendix"]

        tabulated_ev = set()
        for t in all_tables:
            for e in og.get_outgoing_edges(t.id, EdgeType.TABULATES):
                tabulated_ev.add(e.target_id)

        for ctx in contexts:
            rendered.add(ctx.id)
            lines.append(self._prose(og, ctx) + "\n")

        for claim in claims:
            if claim.id in rendered:
                continue
            rendered.add(claim.id)
            lines.append(self._render_claim(og, claim, rendered, tabulated_ev,
                                            tables, contexts_in_section=contexts))

        ev_used = set()
        for c in claims:
            for e in og.get_incoming_edges(c.id, EdgeType.SUPPORTS):
                ev_used.add(e.source_id)
            for ch in og.get_children(c.id):
                if ch.type == NodeType.EVIDENCE:
                    ev_used.add(ch.id)

        standalone_ev = [e for e in evidences
                         if e.id not in ev_used and e.id not in rendered and e.id not in tabulated_ev]
        if standalone_ev:
            lines.append(self._render_ev_group(og, standalone_ev, tabulated_ev))
            rendered.update(e.id for e in standalone_ev)

        for t in tables:
            if t.id not in rendered:
                rendered.add(t.id)
                lines.append(self._render_table(og, t))

        for comp in comparisons:
            if comp.id not in rendered:
                rendered.add(comp.id)
                lines.append(self._prose(og, comp) + "\n")

        for syn in syntheses:
            rendered.add(syn.id)
            lines.append(f"\n**{syn.title}**：{self._prose(og, syn)}\n")

        return "\n".join(lines)



    def _render_appendix(self, og: OutlineGraph) -> str:
        meta = self._curation_meta or {}
        groups = meta.get("appendix_groups") or []
        if not groups:
            return ""
        lines = ["\n## 附录\n"]
        for g in groups:
            letter = g["letter"]
            topic = g.get("topic", "其他")
            tbl_ids = g.get("tables", [])
            if not tbl_ids:
                continue
            lines.append(f"\n### 附录 {letter}: {topic}\n")
            for tid in tbl_ids:
                t = og.get_node(tid)
                if not t or t.status != NodeStatus.ACTIVE:
                    continue
                lines.append(self._render_table(og, t, force_id=t.appendix_id))
        return "\n".join(lines)



    def _render_table(self, og, table, force_id: str = ""):
        parts = []
        tid = force_id or table.table_id or ""
        cap = table.table_caption or table.title
        header = f"**{tid} {cap}**" if tid else f"**{cap}**"
        parts.append(f"\n{header}\n")

        if table.table_schema and table.table_data:
            parts.append("| " + " | ".join(table.table_schema) + " |")
            parts.append("| " + " | ".join(["---"] * len(table.table_schema)) + " |")
            for row in table.table_data:
                padded = row + [""] * (len(table.table_schema) - len(row))
                parts.append("| " + " | ".join(padded[:len(table.table_schema)]) + " |")

        refs = self._fmtrefs(table.cited_refs)
        if refs:
            parts.append(f"\n数据来源：{refs}\n")
        return "\n".join(parts)

    def _find_table_refs(self, og, node, tables):
        refs = []
        for edge in og.get_outgoing_edges(node.id, EdgeType.ILLUSTRATED_BY):
            t = og.get_node(edge.target_id)
            if not (t and t.type == NodeType.TABLE and t.status == NodeStatus.ACTIVE):
                continue
            if t.placement == "appendix":
                if t.appendix_id:

                    letter = self._appendix_letter_for_table(t.id)
                    refs.append((f"详见附录 {letter} {t.appendix_id}", None))
            elif t.table_id:
                refs.append((t.table_id, t))
        return refs

    def _appendix_letter_for_table(self, table_id: str) -> str:
        meta = getattr(self, "_curation_meta", {}) or {}
        for g in meta.get("appendix_groups", []):
            if table_id in g.get("tables", []):
                return g.get("letter", "Z")
        return "Z"



    def _render_claim(self, og, claim, rendered, tabulated_ev, tables,
                      contexts_in_section=None):
        parts = []

        if claim.rhetorical_role in (RhetoricalRole.SUB_CONCLUSION, RhetoricalRole.CONCLUSION):
            parts.append(f"**{claim.title}**\n")

        table_refs = self._find_table_refs(og, claim, tables)
        body_table_refs = [(s, t) for (s, t) in table_refs if t is not None]




        claim_text = self._prose(og, claim)
        if body_table_refs:
            ref_str = "、".join(s for s, _ in body_table_refs)
            claim_text += f"（如{ref_str}所示）"
        parts.append(claim_text)

        for _ref_s, t in body_table_refs:
            if t is not None and t.id not in rendered:
                rendered.add(t.id)
                parts.append(self._render_table(og, t))

        ev_list = self._gather_evidence(og, claim)
        ev_prose = [e for e in ev_list if e.id not in tabulated_ev]
        if ev_prose:
            rendered.update(e.id for e in ev_prose)
            group = self._render_ev_group(og, ev_prose, tabulated_ev)
            if group.strip():
                parts.append(group.rstrip())




        section_ctx_ids = {c.id for c in (contexts_in_section or [])}
        for ce in og.get_incoming_edges(claim.id, EdgeType.CONTEXTUALIZES):
            ctx = og.get_node(ce.source_id)
            if not ctx or ctx.status != NodeStatus.ACTIVE:
                continue
            if ctx.id in rendered or ctx.id in section_ctx_ids:
                continue
            rendered.add(ctx.id)
            parts.append(f"从宏观背景看，{self._prose(og, ctx)}")

        for ce in og.get_incoming_edges(claim.id, EdgeType.CONTRADICTS):
            cn = og.get_node(ce.source_id)
            if cn and cn.status == NodeStatus.ACTIVE:
                rendered.add(cn.id)
                parts.append(f"但需注意，{self._prose(og, cn)}")

        parts.append("")
        return "\n".join(parts)

    def _gather_evidence(self, og, claim):
        evs = []
        seen = set()
        for e in og.get_incoming_edges(claim.id, EdgeType.SUPPORTS):
            ev = og.get_node(e.source_id)
            if ev and ev.status == NodeStatus.ACTIVE and ev.type == NodeType.EVIDENCE and ev.id not in seen:
                evs.append(ev)
                seen.add(ev.id)
        for ch in og.get_children(claim.id):
            if ch.type == NodeType.EVIDENCE and ch.status == NodeStatus.ACTIVE and ch.id not in seen:
                evs.append(ch)
                seen.add(ch.id)
        return evs



    def _render_ev_group(self, og, evidences, tabulated_ev):
        parts = []
        for ev in evidences:
            if ev.id in tabulated_ev:
                continue
            parts.append(self._prose(og, ev).strip().rstrip("。；，"))

        parts = [p for p in parts if p]
        if not parts:
            return ""
        if len(parts) <= 3:
            return "；".join(parts) + "。\n"
        return "；".join(parts[:3]) + "。" + "；".join(parts[3:]) + "。\n"



    def _prose(self, og, node):
        refs = self._fmtrefs(node.cited_refs)
        text = node.content_summary

        if not node.data_blocks:
            return f"{text}{refs}"

        inline = self._inline_data(node.data_blocks)
        if text and inline:
            return f"{text}（{inline}）{refs}"
        return f"{inline}{refs}" if inline else f"{text}{refs}"

    def _inline_data(self, blocks):
        if not blocks:
            return ""
        segs = [f"{db.label}{db.value}{self._refcell(db.source_ref)}" for db in blocks]
        cap = RENDER_MAX_INLINE_DATA_BLOCKS
        if cap is None or len(segs) <= cap:
            return "，".join(segs)
        return "，".join(segs[:cap]) + f"等{len(segs)}项"



    def _fmtrefs(self, refs):
        if not refs:
            return ""
        cleaned = sorted({r for r in refs if r})
        if not cleaned:
            return ""
        parts = []
        i = 0
        while i < len(cleaned):
            j = i
            while j + 1 < len(cleaned) and cleaned[j + 1] == cleaned[j] + 1:
                j += 1
            if j > i:
                parts.append(f"{cleaned[i]}-{cleaned[j]}")
            else:
                parts.append(str(cleaned[i]))
            i = j + 1
        return f"[{','.join(parts)}]"

    def _refcell(self, ref_num):
        if not ref_num:
            return ""
        return f"[{ref_num}]"
