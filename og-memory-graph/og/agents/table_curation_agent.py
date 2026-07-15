from __future__ import annotations
import re
from dataclasses import dataclass
from collections import Counter, defaultdict
from typing import Optional

from og.core.graph import OutlineGraph
from og.core.node import (OGNode, NodeType, NodeStatus, RhetoricalRole,
                          StalenessRisk, DataBlock, ChangeLogEntry)
from og.core.edge import OGEdge, EdgeType




CLUSTER_THRESHOLD = 0.55
SMALL_CLUSTER_MAX = 2
BODY_TABLE_MAX_ROWS = 6
DEFAULT_INLINE_KEY_ROWS = 3
LARGE_TABLE_INLINE_KEY_ROWS = 5
LARGE_TABLE_THRESHOLD = 10


















_DIGIT_PAT = re.compile(r"\d")
_DATE_PAT = re.compile(r"(\d{4})[-./年](\d{1,2})(?:[-./月](\d{1,2}))?")

_NUM_W_UNIT = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*([KMBTkmbt%]|billion|million|thousand|亿|万|千万|百万|美元|元|￥|\$|€|£|倍)",
    re.IGNORECASE
)

_NUMERIC_UNITS_TOKENS = (

    "亿", "万", "千万", "百万", "件", "千", "百",

    "%", "$", "€", "£", "¥", "￥", "美元", "元",

    "倍", "K", "M", "B", "T", "k", "m", "b", "t",

    "billion", "million", "thousand", "trillion"
)


@dataclass
class _PooledBlock:
    db: DataBlock
    source_evidence_id: Optional[str]
    section_id: str
    evidence_title: str = ""




def _bigrams(s: str) -> set:
    if not s:
        return set()

    cleaned = re.sub(r"[\d.,%/\-]+", "", s)
    for u in _NUMERIC_UNITS_TOKENS:
        cleaned = cleaned.replace(u, "")
    cleaned = re.sub(r"\s+", "", cleaned)
    if len(cleaned) < 2:
        return set([cleaned]) if cleaned else set()
    return {cleaned[i:i + 2] for i in range(len(cleaned) - 1)}


def _jaccard(a: set, b: set) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    inter = a & b
    union = a | b
    return len(inter) / len(union) if union else 0.0


def _longest_common_substring(strings: list[str]) -> str:
    if not strings:
        return ""
    if len(strings) == 1:
        return strings[0][:12]
    pivot = min(strings, key=len)
    best = ""


    upper = min(len(pivot), 16)
    for L in range(upper, 1, -1):
        for start in range(len(pivot) - L + 1):
            cand = pivot[start:start + L]
            if all(cand in s for s in strings):
                if len(cand) > len(best):
                    best = cand
        if best:
            break
    return best


def _sanitize_label_for_lcs(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r"[\d.,%/\-()（）\[\]【】<>《》\"'`、，。：:]+", "", s)
    for u in _NUMERIC_UNITS_TOKENS:
        s = s.replace(u, "")
    s = re.sub(r"\s+", "", s)
    return s


def _max_numeric_value(s: str) -> float:
    best = 0.0
    for m in _NUM_W_UNIT.finditer(s or ""):
        try:
            v = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        unit = m.group(2)
        scale = {"亿": 1e8, "万": 1e4, "千万": 1e7, "百万": 1e6,
                 "倍": 1.0, "美元": 1.0, "元": 1.0, "%": 0.01}.get(unit, 1.0)
        v *= scale
        if v > best:
            best = v
    return best


def _latest_date(s: str) -> Optional[tuple[int, int, int]]:
    out = None
    for m in _DATE_PAT.finditer(s or ""):
        y, mo = int(m.group(1)), int(m.group(2))
        d = int(m.group(3)) if m.group(3) else 0
        if out is None or (y, mo, d) > out:
            out = (y, mo, d)
    return out




class TableCurationAgent:

    def __init__(self, threshold: float = CLUSTER_THRESHOLD):
        self.threshold = threshold



    def curate(self, og: OutlineGraph, version: str = "curated") -> dict:
        report = {
            "deprecated_tables": 0,
            "rebuilt_tables": 0,
            "body_tables": 0,
            "appendix_tables": 0,
            "demoted_to_inline": 0,
            "claims_inline_injected": 0,
            "appendix_groups": {},
        }


        pool_by_section, source_table_ids = self._collect_and_deprecate(
            og, version, report
        )


        new_tables: list[OGNode] = []
        for section_id, blocks in pool_by_section.items():
            section = og.get_node(section_id)
            if not section:
                continue
            self._rebuild_section_tables(
                og, section, blocks, version, new_tables, report
            )


        for tbl in new_tables:
            if tbl.placement != "appendix":
                continue
            self._inline_inject(og, tbl, version, report)


        meta = self._group_appendix(new_tables, report)
        og.curation_meta = meta


        self._assign_body_table_ids(og, new_tables)

        return report

    @staticmethod
    def _assign_body_table_ids(og: OutlineGraph, new_tables: list[OGNode]):
        root = og.get_root()
        if not root:
            return
        sections = [
            s for s in og.get_children(root.id, NodeType.SECTION)
            if s.status == NodeStatus.ACTIVE
        ]
        if any(s.display_order is not None for s in sections):
            sections.sort(key=lambda s: (s.display_order or 9999, s.id))

        new_table_ids = {t.id for t in new_tables}
        for sec in sections:
            sec_idx = sec.display_order if sec.display_order is not None else 0
            j = 0
            for child in og.get_children(sec.id):
                if (child.type == NodeType.TABLE
                        and child.status == NodeStatus.ACTIVE
                        and child.placement == "body"
                        and child.id in new_table_ids):
                    j += 1
                    child.table_id = f"表 {sec_idx}.{j}"
                    og.update_node(child)



    def _collect_and_deprecate(
        self, og: OutlineGraph, version: str, report: dict
    ) -> tuple[dict[str, list[_PooledBlock]], set[str]]:
        pool_by_section: dict[str, list[_PooledBlock]] = defaultdict(list)
        source_table_ids: set[str] = set()

        for tbl in og.get_all_nodes(NodeType.TABLE, NodeStatus.ACTIVE):

            section_id = self._parent_section_id(og, tbl)
            if not section_id:
                continue


            ev_ids = [e.target_id for e in og.get_outgoing_edges(tbl.id, EdgeType.TABULATES)]
            seen_data_ids: set[str] = set()


            for ev_id in ev_ids:
                ev = og.get_node(ev_id)
                if not ev:
                    continue
                for db in (ev.data_blocks or []):
                    if db.data_id in seen_data_ids:
                        continue
                    seen_data_ids.add(db.data_id)
                    pool_by_section[section_id].append(
                        _PooledBlock(db=db, source_evidence_id=ev_id, section_id=section_id,
                                     evidence_title=ev.title or "")
                    )


            for row in (tbl.table_data or []):
                if not row or len(row) < 2:
                    continue
                label = (row[0] or "").strip()
                value = (row[1] or "").strip() if len(row) > 1 else ""
                if not label or not value:
                    continue

                fingerprint = f"row::{label}::{value}"
                if fingerprint in seen_data_ids:
                    continue
                seen_data_ids.add(fingerprint)

                m_ref = re.search(r"\[(\d+)", " ".join(row))
                source_ref = int(m_ref.group(1)) if m_ref else None
                m_year = re.search(r"(\d{4})", " ".join(row))
                data_year = int(m_year.group(1)) if m_year else None
                pool_by_section[section_id].append(
                    _PooledBlock(
                        db=DataBlock(
                            data_id=f"row-{tbl.id}-{label[:20]}",
                            value=value,
                            label=label,
                            data_year=data_year,
                            source_ref=source_ref,
                        ),
                        source_evidence_id=None,
                        section_id=section_id,
                    )
                )


            for e in list(og.get_outgoing_edges(tbl.id, EdgeType.TABULATES)):
                og.remove_edge(e)
            for e in list(og.get_incoming_edges(tbl.id, EdgeType.ILLUSTRATED_BY)):
                og.remove_edge(e)
            tbl.status = NodeStatus.DEPRECATED
            tbl.change_log.append(ChangeLogEntry(
                version, "DEPRECATE_TABLE",
                description="表内容被 TableCurationAgent 重新聚类拆分"
            ))
            og.update_node(tbl)
            source_table_ids.add(tbl.id)
            report["deprecated_tables"] += 1

        return pool_by_section, source_table_ids



    def _rebuild_section_tables(
        self,
        og: OutlineGraph,
        section: OGNode,
        blocks: list[_PooledBlock],
        version: str,
        out_new_tables: list[OGNode],
        report: dict,
    ):
        if not blocks:
            return

        clusters = self._cluster_blocks(blocks)

        for cluster in clusters:
            if len(cluster) <= SMALL_CLUSTER_MAX:

                self._push_back_inline(og, cluster, section, version, report)
                continue


            new_tbl = self._build_table_node(og, section, cluster, version)


            if (
                len(cluster) <= BODY_TABLE_MAX_ROWS
                and self._has_illustrated_link(og, cluster)
                and self._labels_consistent(cluster)
            ):
                new_tbl.placement = "body"
                report["body_tables"] += 1
            else:
                new_tbl.placement = "appendix"
                report["appendix_tables"] += 1


            for pb in cluster:
                if pb.source_evidence_id:
                    og.add_edge(OGEdge(
                        new_tbl.id, pb.source_evidence_id, EdgeType.TABULATES,
                        created_in_version=version,
                    ))
            self._maybe_link_claim(og, section, new_tbl, version)

            og.update_node(new_tbl)
            out_new_tables.append(new_tbl)
            report["rebuilt_tables"] += 1

    def _push_back_inline(
        self,
        og: OutlineGraph,
        cluster: list[_PooledBlock],
        section: OGNode,
        version: str,
        report: dict,
    ):
        for pb in cluster:
            ev_id = pb.source_evidence_id
            ev = og.get_node(ev_id) if ev_id else None
            if ev and ev.status == NodeStatus.ACTIVE:

                ids = {d.data_id for d in (ev.data_blocks or [])}
                if pb.db.data_id not in ids:
                    ev.data_blocks.append(pb.db)
                    ev.last_updated_version = version
                    ev.change_log.append(ChangeLogEntry(
                        version, "RESTORE_DATA",
                        description="TableCurationAgent: 小簇退化为 Evidence inline"
                    ))
                    og.update_node(ev)
            else:

                existing = None
                want_title = (pb.db.label or "")[:30] or "数据点"
                for child in og.get_children(section.id, NodeType.EVIDENCE):
                    if child.status == NodeStatus.ACTIVE and child.title == want_title:
                        existing = child
                        break
                if existing:

                    ids = {d.data_id for d in (existing.data_blocks or [])}
                    if pb.db.data_id not in ids:
                        existing.data_blocks.append(pb.db)
                        existing.last_updated_version = version
                        og.update_node(existing)
                else:

                    synth = OGNode(
                        id=og.generate_id("EVS"),
                        type=NodeType.EVIDENCE,
                        title=want_title,
                        rhetorical_role=RhetoricalRole.EVIDENCE,
                        content_summary="",
                        data_blocks=[pb.db],
                        cited_refs=[pb.db.source_ref] if pb.db.source_ref else [],
                        temporal_scope=str(pb.db.data_year or ""),
                        staleness_risk=StalenessRisk.LOW,
                        created_in_version=version,
                        last_updated_version=version,
                        change_log=[ChangeLogEntry(
                            version, "CREATE_FROM_TABLE",
                            description="TableCurationAgent: 小簇 1-2 行从废弃表恢复为 Evidence"
                        )],
                    )
                    og.add_node(synth)
                    og.add_edge(OGEdge(section.id, synth.id, EdgeType.CONTAINS,
                                        created_in_version=version))
            report["demoted_to_inline"] += 1



    def _cluster_blocks(self, blocks: list[_PooledBlock]) -> list[list[_PooledBlock]]:
        if not blocks:
            return []
        if len(blocks) == 1:
            return [blocks]

        clusters: list[list[_PooledBlock]] = [[b] for b in blocks]
        sigs: list[set[str]] = [_bigrams(b.db.label) for b in blocks]

        def cluster_dist(i: int, j: int) -> float:

            sims = []
            for ci in clusters[i]:
                si = _bigrams(ci.db.label)
                for cj in clusters[j]:
                    sj = _bigrams(cj.db.label)
                    sims.append(_jaccard(si, sj))
            avg_sim = sum(sims) / len(sims) if sims else 0.0
            return 1.0 - avg_sim

        while len(clusters) > 1:
            best = (None, None, 1.0)
            for i in range(len(clusters)):
                for j in range(i + 1, len(clusters)):
                    d = cluster_dist(i, j)
                    if d < best[2]:
                        best = (i, j, d)
            if best[2] > self.threshold:
                break
            i, j, _ = best
            clusters[i] = clusters[i] + clusters[j]
            clusters.pop(j)

        return clusters



    def _infer_subject(self, pb: _PooledBlock, ref_title_map: dict) -> str:
        if pb.evidence_title and pb.evidence_title.strip() and pb.evidence_title != pb.db.label:
            return pb.evidence_title.strip()
        
        if pb.db.source_ref and pb.db.source_ref in ref_title_map:
            title = ref_title_map[pb.db.source_ref].strip()

            import re as _re
            for suffix in ["逝世", "去世", "葬礼", "国葬", "追悼"]:
                if suffix in title:
                    title = title.split(suffix)[0].strip('，,、：: ')
                    break
            else:

                m = _re.search(r"\b(?:death|funeral|state funeral)\s+of\s+(.+)$", title, _re.IGNORECASE)
                if m:
                    title = m.group(1).strip()
                else:

                    title = _re.sub(r"\s*[\(（].*$", "", title).strip()

            if len(title) > 30:
                for sep in ["，", ",", "：", ":", "—", "-"]:
                    if sep in title:
                        title = title.split(sep)[0].strip()
                        break
                title = title[:30]
            return title if title else "—"
        
        return "—"

    def _build_table_node(
        self,
        og: OutlineGraph,
        section: OGNode,
        cluster: list[_PooledBlock],
        version: str,
    ) -> OGNode:

        has_year = any(pb.db.data_year for pb in cluster)
        has_ref = any(pb.db.source_ref for pb in cluster)
        multi_year = (
            len(set(pb.db.data_year for pb in cluster if pb.db.data_year)) > 1
        )



        distinct_subjects = {pb.evidence_title for pb in cluster if pb.evidence_title}
        has_subject_by_evidence = len(distinct_subjects) >= 2
        

        label_values = {}
        for pb in cluster:
            label = pb.db.label
            if label not in label_values:
                label_values[label] = set()
            label_values[label].add(pb.db.value)
        has_subject_by_label = any(len(vals) >= 2 for vals in label_values.values())
        
        has_subject = has_subject_by_evidence or has_subject_by_label
        cols = []
        if has_subject:
            cols.append("主体")
        cols.extend(["指标", "数值"])
        if multi_year:
            cols.append("数据年份")
        if has_ref:
            cols.append("来源")

        rows = []

        ref_title_map = {
            getattr(n, "ref_number", None): n.title
            for n in og.get_all_nodes(NodeType.REFERENCE)
            if getattr(n, "ref_number", None) is not None and n.title
        }
        for pb in cluster:
            db = pb.db
            row = []
            if has_subject:
                subject = self._infer_subject(pb, ref_title_map)
                row.append(subject)
            row.extend([db.label, db.value])
            if multi_year:
                row.append(f"{db.data_year}年" if db.data_year else "—")
            if has_ref:
                row.append(f"[{db.source_ref}]" if db.source_ref else "—")
            rows.append(row)

        topic = self._derive_cluster_topic(cluster)
        section_short = self._section_short(section.title or section.display_title or "")






        if topic:
            caption = topic
        elif section_short:
            caption = f"{section_short}数据汇总"
        else:
            caption = "数据汇总"


        caption = self._sanitize_caption(caption)

        cited_refs = sorted({pb.db.source_ref for pb in cluster if pb.db.source_ref})

        node = OGNode(
            id=og.generate_id("TBL"),
            type=NodeType.TABLE,
            title=caption,
            rhetorical_role=RhetoricalRole.ILLUSTRATION,
            staleness_risk=StalenessRisk.LOW,
            created_in_version=version,
            last_updated_version=version,
            change_log=[ChangeLogEntry(
                version, "CREATE_TABLE",
                description=f"TableCurationAgent: 主题 '{topic}' 重建表格"
            )],
            table_schema=cols,
            table_data=rows,
            table_caption=caption,
            cited_refs=cited_refs,
            topic_label=topic or "其他",
        )
        og.add_node(node)
        og.add_edge(OGEdge(section.id, node.id, EdgeType.CONTAINS,
                           created_in_version=version))
        return node



    def _derive_cluster_topic(self, cluster: list[_PooledBlock]) -> str:
        labels = [pb.db.label for pb in cluster if pb.db.label]

        clean_labels = [_sanitize_label_for_lcs(L) for L in labels]
        clean_labels = [s for s in clean_labels if len(s) >= 2]
        lcs = _longest_common_substring(clean_labels)
        if 2 <= len(lcs) <= 12:
            return lcs
        if len(lcs) > 12:
            return lcs[:12]

        c = Counter()
        for L in clean_labels:
            for bg in _bigrams(L):
                c[bg] += 1
        if c:
            top, n = c.most_common(1)[0]
            if n >= 2 and len(top) >= 2:
                return top

        if clean_labels:
            return clean_labels[0][:8]
        return (labels[0] if labels else "")[:8]

    @staticmethod
    def _sanitize_caption(s: str) -> str:
        if not s:
            return ""
        s = re.sub(r"[\d.,%/\-]+", "", s)
        for u in _NUMERIC_UNITS_TOKENS:
            s = s.replace(u, "")
        s = re.sub(r"\s+", "", s)
        return s.strip("，,、:：·")

    @staticmethod
    def _section_short(section_title: str) -> str:
        if not section_title:
            return ""

        s = re.sub(r"^[一二三四五六七八九十百千万零两\d]+(?:章|节)?[、.\s]+", "", section_title)
        head = re.split(r"[：:，,]", s, maxsplit=1)[0]
        return head[:8]

    def _has_illustrated_link(self, og: OutlineGraph, cluster: list[_PooledBlock]) -> bool:
        for pb in cluster:
            if not pb.source_evidence_id:
                continue
            for e in og.get_outgoing_edges(pb.source_evidence_id, EdgeType.SUPPORTS):
                target = og.get_node(e.target_id)
                if target and target.type == NodeType.CLAIM:
                    return True
        return False

    def _labels_consistent(self, cluster: list[_PooledBlock]) -> bool:
        if len(cluster) < 2:
            return True
        sigs = [_bigrams(pb.db.label) for pb in cluster]
        sims = []
        for i in range(len(sigs)):
            for j in range(i + 1, len(sigs)):
                sims.append(_jaccard(sigs[i], sigs[j]))
        return (sum(sims) / len(sims) if sims else 0.0) >= 0.25

    def _maybe_link_claim(
        self, og: OutlineGraph, section: OGNode, table: OGNode, version: str
    ):
        claims = [
            n for n in og.get_children(section.id)
            if n.type == NodeType.CLAIM and n.status == NodeStatus.ACTIVE
        ]
        if not claims:
            return
        primary = next(
            (c for c in claims if c.rhetorical_role in
             (RhetoricalRole.CONCLUSION, RhetoricalRole.SUB_CONCLUSION)),
            claims[0],
        )
        og.add_edge(OGEdge(primary.id, table.id, EdgeType.ILLUSTRATED_BY,
                           created_in_version=version))

    @staticmethod
    def _parent_section_id(og: OutlineGraph, node: OGNode) -> Optional[str]:
        for e in og.get_incoming_edges(node.id, EdgeType.CONTAINS):
            parent = og.get_node(e.source_id)
            if parent and parent.type == NodeType.SECTION:
                return parent.id
        return None



    def _inline_inject(self, og: OutlineGraph, table: OGNode, version: str, report: dict):

        claim_id = None
        for e in og.get_incoming_edges(table.id, EdgeType.ILLUSTRATED_BY):
            n = og.get_node(e.source_id)
            if n and n.type == NodeType.CLAIM and n.status == NodeStatus.ACTIVE:
                claim_id = e.source_id
                break
        if not claim_id:
            return
        claim = og.get_node(claim_id)
        if not claim:
            return


        if any(c.action == "INLINE_INJECT" and table.id in (c.description or "")
               for c in claim.change_log):
            return


        n_rows = len(table.table_data or [])
        n_pick = (LARGE_TABLE_INLINE_KEY_ROWS if n_rows > LARGE_TABLE_THRESHOLD
                   else DEFAULT_INLINE_KEY_ROWS)
        key_rows = self._pick_key_rows(table.table_data, n_pick,
                                        table_caption=table.table_caption or "",
                                        topic_label=table.topic_label or "")
        if not key_rows:
            return


        bits = []
        for row in key_rows:
            label = (row[0] if len(row) > 0 else "").strip()
            value = (row[1] if len(row) > 1 else "").strip()
            if label and value:
                bits.append(f"{label} {value}")
            elif value:
                bits.append(value)

        if not bits:
            return

        joined = "、".join(bits)


        if joined not in (claim.content_summary or ""):
            base = (claim.content_summary or "").rstrip()

            if base and base[-1] not in "。.！？!?":
                base += "。"
            claim.content_summary = f"{base}{joined}。"
            claim.last_updated_version = version
            claim.change_log.append(ChangeLogEntry(
                version, "INLINE_INJECT",
                description=f"TableCurationAgent: 沉淀 {n_pick} 行附录 {table.id} 关键数据"
            ))
            og.update_node(claim)
            report["claims_inline_injected"] += 1

    def _score_rows_importance_llm(self, rows_text: str, context: str, n_rows: int) -> dict[int, float]:
        try:
            from openai import OpenAI
            import os
            import json as _json
        except ImportError:
            return {}

        prompt = (
            f"{context}\n\n"
            f"以下是表格的 {n_rows} 行数据, 请评估每行的语义重要性 (0-1 分), "
            f"重点关注: 关键转折点、最新进展、最大规模、里程碑事件。\n\n"
            f"{rows_text}\n\n"
            f"请以 JSON 格式返回, 形如: {{\"1\": 0.9, \"2\": 0.3, ...}}"
        )
        try:
            client = OpenAI(
                api_key=os.environ.get("OPENAI_API_KEY"),
                base_url=os.environ.get("OPENAI_API_BASE")
            )

            model = os.environ.get("LLM_UTIL", "gpt-4o-mini")
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=500,
                temperature=0.0
            )
            content = resp.choices[0].message.content.strip()
            m = re.search(r"\{[^{}]+\}", content)
            if not m:
                return {}
            raw = _json.loads(m.group(0))

            return {int(k) - 1: min(1.0, max(0.0, float(v))) for k, v in raw.items()}
        except Exception:
            return {}

    def _pick_key_rows(self, table_data: list[list[str]], n: int, 
                       table_caption: str = "", topic_label: str = "") -> list[list[str]]:
        if not table_data:
            return []
        

        scored = []
        for row in table_data:
            if not row:
                continue
            cells = [c or "" for c in row]
            joined = " ".join(cells)
            score = 0.0
            score += _max_numeric_value(joined) * 1e-9
            d = _latest_date(joined)
            if d:
                score += d[0] * 0.001 + d[1] * 0.0001
            scored.append((score, row, cells))
        
        if not scored:
            return []
        


        if len(scored) <= n:
            return [r for _, r, _ in scored]
        

        context = f"表格主题: {topic_label or table_caption or '数据汇总'}"
        rows_text = "\n".join([f"{i+1}. {' | '.join(cells)}" for i, (_, _, cells) in enumerate(scored)])
        
        llm_scores = self._score_rows_importance_llm(rows_text, context, len(scored))
        

        for i, (heur_score, row, cells) in enumerate(scored):
            llm_boost = llm_scores.get(i, 0.0)
            scored[i] = (heur_score + llm_boost, row)
        
        scored.sort(key=lambda x: -x[0])
        return [r for _, r in scored[:n]]



    def _group_appendix(self, new_tables: list[OGNode], report: dict) -> dict:
        appendix_tables = [t for t in new_tables if t.placement == "appendix"]


        by_topic: dict[str, list[OGNode]] = defaultdict(list)
        for t in appendix_tables:
            tag = (t.topic_label or "").strip() or "其他"
            by_topic[tag].append(t)


        ordered_topics = sorted(by_topic.keys(),
                                 key=lambda k: (-len(by_topic[k]), k))

        groups = []
        table_appendix_ids: dict[str, str] = {}
        claim_inline_refs: dict[str, str] = {}

        for idx, topic in enumerate(ordered_topics):
            letter = self._letter_for_index(idx)
            tables = by_topic[topic]
            ids = []
            for j, t in enumerate(tables, 1):
                appendix_id = f"表 {letter}.{j}"
                t.appendix_id = appendix_id
                ids.append(t.id)
                table_appendix_ids[t.id] = appendix_id
                claim_inline_refs[t.id] = f"(详见附录 {letter} {appendix_id})"
            groups.append({
                "letter": letter,
                "topic": topic,
                "tables": ids,
            })

        report["appendix_groups"] = {
            g["letter"]: f"{g['topic']} ({len(g['tables'])} 张表)" for g in groups
        }

        return {
            "appendix_groups": groups,
            "table_appendix_ids": table_appendix_ids,
            "claim_inline_refs": claim_inline_refs,
        }

    @staticmethod
    def _letter_for_index(i: int) -> str:
        if i < 26:
            return chr(ord("A") + i)

        first = chr(ord("A") + (i // 26) - 1)
        second = chr(ord("A") + (i % 26))
        return first + second
