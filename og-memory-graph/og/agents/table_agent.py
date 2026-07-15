from __future__ import annotations
import re
from collections import Counter
from og.core.graph import OutlineGraph
from og.core.node import (OGNode, NodeType, NodeStatus, RhetoricalRole,
                          StalenessRisk, DataBlock, ChangeLogEntry)
from og.core.edge import OGEdge, EdgeType

SINGLE_NODE_TABLE_MIN = 5
MULTI_NODE_TABLE_MIN = 3
MAX_TABLE_ROWS = 12




TABLE_TITLE_CELL_MAX_CHARS: int | None = None

_BRACKET_PATTERN = re.compile(r'[（(]([^)）]+)[)）]')
_HAS_DIGIT = re.compile(r'\d')

_NUMERIC_UNITS = (

    "亿", "万", "千万", "百万", "件", "千", "百",

    "%", "$", "€", "£", "¥", "￥", "美元", "元",

    "倍", "K", "M", "B", "T", "k", "m", "b", "t",

    "billion", "million", "thousand", "trillion",

    "次", "人", "天", "个", "家", "位", "台", "款", "项", "条", "篇", "份",
    "首", "部", "场", "届", "枚", "艘", "架"
)


def _truncate_title(title: str, cap: int | None = None) -> str:
    if cap is None:
        cap = TABLE_TITLE_CELL_MAX_CHARS
    if cap is None or len(title) <= cap:
        return title
    return title[:max(1, cap - 3)] + "..."


class TableLifecycleAgent:

    def __init__(self, ref_tier_map: dict[int, str] | None = None):
        self._ref_tier_map = ref_tier_map or {}

    def process_all(self, og: OutlineGraph, version: str) -> dict:
        report = {"created": [], "updated": [], "split": [], "referenced": [],
                  "evidence_cleaned": 0}

        for section in og.get_sections():
            self._process_section(og, section, version, report)

        self._assign_ids_and_refs(og, version, report)

        return report

    def _process_section(self, og, section, version, report):
        children = [n for n in og.get_children(section.id) if n.status == NodeStatus.ACTIVE]


        ver_plain = str(version).lstrip("v")
        evidence_with_data = [n for n in children
                              if n.type in (NodeType.EVIDENCE, NodeType.COMPARISON) and n.data_blocks
                              and (str(n.created_in_version or "").lstrip("v") == ver_plain
                                   or str(n.last_updated_version or "").lstrip("v") == ver_plain)]
        existing_tables = [n for n in children if n.type == NodeType.TABLE and n.status == NodeStatus.ACTIVE]

        if existing_tables:
            for table in existing_tables:
                self._update_existing_table(og, table, evidence_with_data, version, report)
            for table in existing_tables:
                if table.status == NodeStatus.ACTIVE and len(table.table_data) > MAX_TABLE_ROWS:
                    self._split_table(og, table, section, version, report)
            return



        section_used_captions = self._collect_section_captions(og, section)

        paired = self._detect_paired_nodes(evidence_with_data)
        if paired and len(paired) >= MULTI_NODE_TABLE_MIN:
            self._create_paired_table(og, section, paired, version, report,
                                       section_used_captions)

        remaining = [n for n in evidence_with_data if n.id not in {p.id for p in paired}]
        all_remaining_blocks = sum(len(n.data_blocks) for n in remaining)
        if all_remaining_blocks >= SINGLE_NODE_TABLE_MIN:
            self._create_simple_table(og, section, remaining, version, report,
                                       section_used_captions)

    def _collect_section_captions(self, og, section) -> set[str]:
        used = set()
        for n in og.get_children(section.id):
            if n.type == NodeType.TABLE and n.status == NodeStatus.ACTIVE:
                if n.table_caption:
                    used.add(n.table_caption)
        return used



    def _create_paired_table(self, og, section, nodes, version, report,
                              used_captions=None):
        ref_col_count = len(nodes[0].data_blocks)
        col_names = self._infer_paired_columns(nodes, ref_col_count)
        rows = []
        source_ids = []
        all_refs = set()

        for node in nodes:
            row = [_truncate_title(node.title)]
            for db in node.data_blocks[:ref_col_count]:
                row.append(db.value)
                if db.source_ref:
                    all_refs.add(db.source_ref)
            row.append(self._ref_cell(node.data_blocks[0].source_ref if node.data_blocks else None))
            rows.append(row)
            source_ids.append(node.id)

        caption = self._infer_caption(nodes, section_title=section.title,
                                       used=used_captions)
        if used_captions is not None:
            used_captions.add(caption)
        columns = [col_names[0]] + col_names[1:ref_col_count + 1] + ["来源"]

        table = self._create_table_node(og, section, columns, rows, caption, list(all_refs), version)
        self._link_and_clean(og, table, source_ids, section, version, report)
        report["created"].append({"id": table.id, "caption": caption, "rows": len(rows)})

    def _create_simple_table(self, og, section, evidence_nodes, version, report,
                              used_captions=None):
        all_blocks = []
        source_ids = []
        for ev in evidence_nodes:
            all_blocks.extend(ev.data_blocks)
            source_ids.append(ev.id)

        if len(all_blocks) < SINGLE_NODE_TABLE_MIN:
            return

        schema, rows = self._infer_flat_schema(all_blocks)
        if len(rows) < 3:
            return

        caption = self._infer_caption(evidence_nodes, section_title=section.title,
                                       used=used_captions)
        if used_captions is not None:
            used_captions.add(caption)
        table = self._create_table_node(og, section, schema, rows, caption,
                                         list(set(db.source_ref for db in all_blocks if db.source_ref)),
                                         version)
        self._link_and_clean(og, table, source_ids, section, version, report)
        report["created"].append({"id": table.id, "caption": caption, "rows": len(rows)})

    def _create_table_node(self, og, section, schema, rows, caption, refs, version):
        node = OGNode(
            id=og.generate_id("TBL"), type=NodeType.TABLE,
            title=caption, rhetorical_role=RhetoricalRole.ILLUSTRATION,
            table_schema=schema, table_data=rows, table_caption=caption,
            cited_refs=refs, staleness_risk=StalenessRisk.LOW,
            created_in_version=version, last_updated_version=version,
            change_log=[ChangeLogEntry(version, "CREATE_TABLE")],
        )
        og.add_node(node)
        og.add_edge(OGEdge(section.id, node.id, EdgeType.CONTAINS, created_in_version=version))
        return node

    def _link_and_clean(self, og, table, source_ids, section, version, report):
        for sid in source_ids:
            og.add_edge(OGEdge(table.id, sid, EdgeType.TABULATES, created_in_version=version))
            src = og.get_node(sid)
            if src and src.data_blocks:
                src.data_blocks = []
                og.update_node(src)
                report["evidence_cleaned"] += 1

        claims = [n for n in og.get_children(section.id)
                  if n.type == NodeType.CLAIM and n.status == NodeStatus.ACTIVE]
        if claims:
            og.add_edge(OGEdge(claims[0].id, table.id, EdgeType.ILLUSTRATED_BY,
                               created_in_version=version))



    def _update_existing_table(self, og, table, evidence_nodes, version, report):
        existing_labels = {row[0] for row in table.table_data if row}
        new_rows = []
        cleaned = 0

        for ev in evidence_nodes:
            for db in ev.data_blocks:
                if db.label in existing_labels:
                    for i, row in enumerate(table.table_data):
                        if row and row[0] == db.label:
                            new_row = self._block_to_row(db, table.table_schema)
                            table.table_data[i] = new_row
                            break
                else:
                    new_rows.append(self._block_to_row(db, table.table_schema))

            has_tabulates = any(
                e.type == EdgeType.TABULATES and e.target_id == ev.id
                for e in og.get_outgoing_edges(table.id)
            )
            if not has_tabulates and ev.data_blocks:
                og.add_edge(OGEdge(table.id, ev.id, EdgeType.TABULATES,
                                   created_in_version=version))
            if ev.data_blocks:
                ev.data_blocks = []
                og.update_node(ev)
                cleaned += 1

        for nr in new_rows:
            table.table_data.append(nr)

        if new_rows or cleaned:
            table.last_updated_version = version
            og.update_node(table)
            report["updated"].append({"id": table.id, "new_rows": len(new_rows), "updated_rows": cleaned})
            report["evidence_cleaned"] += cleaned



    def _split_table(self, og, table, section, version, report):
        rows = table.table_data
        mid = len(rows) // 2

        base_caption = re.sub(r'[（(][上下续][）)]$', '', table.table_caption).strip()

        table.table_data = rows[:mid]
        table.table_caption = f"{base_caption}（上）"
        table.title = table.table_caption
        table.last_updated_version = version
        og.update_node(table)

        new = OGNode(
            id=og.generate_id("TBL"), type=NodeType.TABLE,
            title=f"{base_caption}（下）",
            rhetorical_role=RhetoricalRole.ILLUSTRATION,
            table_schema=list(table.table_schema),
            table_data=rows[mid:],
            table_caption=f"{base_caption}（下）",
            cited_refs=list(table.cited_refs),
            staleness_risk=StalenessRisk.LOW,
            created_in_version=version, last_updated_version=version,
        )
        og.add_node(new)
        og.add_edge(OGEdge(section.id, new.id, EdgeType.CONTAINS, created_in_version=version))
        report["split"].append({"original": table.id, "new": new.id})



    def _assign_ids_and_refs(self, og, version, report):
        root = og.get_root()
        if not root:
            return

        for i, section in enumerate(og.get_children(root.id, NodeType.SECTION), 1):
            tables = self._collect_tables(og, section)
            for j, table in enumerate(tables, 1):
                new_tid = f"表{i}.{j}"
                if table.table_id != new_tid:
                    table.table_id = new_tid
                    og.update_node(table)

                has_illust = any(e.type == EdgeType.ILLUSTRATED_BY and e.target_id == table.id
                                for e in og._edges)
                if not has_illust:
                    claims = [n for n in og.get_children(section.id)
                              if n.type == NodeType.CLAIM and n.status == NodeStatus.ACTIVE]
                    if claims:
                        og.add_edge(OGEdge(claims[0].id, table.id, EdgeType.ILLUSTRATED_BY,
                                           created_in_version=version))
                        report["referenced"].append({"table": new_tid, "claim": claims[0].title[:30]})

    def _collect_tables(self, og, section):
        result = []
        for n in og.get_children(section.id):
            if n.type == NodeType.TABLE and n.status == NodeStatus.ACTIVE:
                result.append(n)
        for sub in og.get_children(section.id, NodeType.SECTION):
            result.extend(self._collect_tables(og, sub))
        return result



    def _detect_paired_nodes(self, nodes):
        if len(nodes) < MULTI_NODE_TABLE_MIN:
            return []
        counts = [len(n.data_blocks) for n in nodes]
        if not counts:
            return []
        common = Counter(counts).most_common(1)[0]
        if common[0] < 2 or common[1] < MULTI_NODE_TABLE_MIN:
            return []
        target = common[0]
        return [n for n in nodes if len(n.data_blocks) == target]



    def _infer_paired_columns(self, nodes, n_cols):
        col_candidates = [["分类"]]
        for i in range(n_cols):
            labels = [n.data_blocks[i].label for n in nodes if i < len(n.data_blocks)]
            suffix = self._common_suffix(labels)
            col_candidates.append([suffix if suffix and len(suffix) >= 2 else (labels[0] if labels else f"字段{i+1}")])
        return [c[0] for c in col_candidates]

    @staticmethod
    def _common_suffix(strings):
        if not strings:
            return ""
        rev = [s[::-1] for s in strings]
        common = []
        for chars in zip(*rev):
            if len(set(chars)) == 1:
                common.append(chars[0])
            else:
                break
        return "".join(common)[::-1]

    def _infer_flat_schema(self, blocks):
        has_year = any(db.data_year for db in blocks)
        has_ref = any(db.source_ref for db in blocks)
        multi_year = len(set(db.data_year for db in blocks if db.data_year)) > 1
        has_paren = sum(1 for db in blocks if _BRACKET_PATTERN.search(db.value)) >= 3

        if has_paren and len(blocks) >= 4:
            cols = ["指标", "数值", "变化/注释", "来源"]
            rows = []
            for db in blocks:
                m = _BRACKET_PATTERN.search(db.value)
                val = db.value[:m.start()].strip() if m else db.value
                ann = m.group(1) if m else ""
                rows.append([db.label, val, ann, self._ref_cell(db.source_ref)])
            return cols, rows

        cols = ["指标", "数值"]
        if multi_year:
            cols.append("数据年份")
        if has_ref:
            cols.append("来源")

        rows = []
        for db in blocks:
            row = [db.label, db.value]
            if multi_year:
                row.append(f"{db.data_year}年" if db.data_year else "-")
            if has_ref:
                row.append(self._ref_cell(db.source_ref))
            rows.append(row)
        return cols, rows

    def _infer_caption(self, nodes, section_title: str = "",
                        used: set[str] | None = None) -> str:
        keywords: list[str] = []
        seen = set()
        for t in (n.title for n in nodes[:8]):
            for seg in re.split(r'[：:,，、/()（）\s]', t):
                seg = seg.strip()
                if not (2 <= len(seg) <= 10):
                    continue
                if _HAS_DIGIT.search(seg):
                    continue
                if any(unit in seg for unit in _NUMERIC_UNITS):
                    continue
                if seg in seen:
                    continue
                seen.add(seg)
                keywords.append(seg)
                if len(keywords) >= 3:
                    break
            if len(keywords) >= 3:
                break

        if keywords:
            cap = "、".join(keywords) + "数据一览"
        else:
            short = section_title.split("、", 1)[-1].split("：", 1)[0].strip()
            short = short[:8] if short else "汇总"
            cap = f"{short}数据汇总"

        if used is None:
            return cap
        if cap not in used:
            return cap
        i = 2
        while f"{cap}·补充{i}" in used:
            i += 1
        return f"{cap}·补充{i}" if f"{cap}·补充" in used else f"{cap}·补充"

    def _block_to_row(self, db, schema):
        row = [db.label, db.value]
        if "数据年份" in schema:
            row.append(f"{db.data_year}年" if db.data_year else "-")
        if "变化/注释" in schema:
            m = _BRACKET_PATTERN.search(db.value)
            if m:
                row[1] = db.value[:m.start()].strip()
                row.insert(2, m.group(1))
            else:
                row.insert(2, "")
        if "来源" in schema:
            row.append(self._ref_cell(db.source_ref))
        while len(row) < len(schema):
            row.append("-")
        return row[:len(schema)]

    def _ref_cell(self, ref_num):
        if not ref_num:
            return "-"
        tier = self._ref_tier_map.get(ref_num, "")
        return f"[{ref_num}]({tier})" if tier else f"[{ref_num}]"










class TableAgent:

    def __init__(self,
                 ref_tier_map: dict[int, str] | None = None,
                 curation_cache=None,
                 naming_cache=None,
                 topic: str | None = None,
                 naming_model: str | None = None):
        self._lifecycle = TableLifecycleAgent(ref_tier_map=ref_tier_map)
        self._curation_cache = curation_cache
        self._naming_cache = naming_cache
        self._topic = topic
        self._naming_model = naming_model
        self._curation_agent = None
        self._naming_agent = None

    def _lazy_curation(self):
        if self._curation_agent is None:
            from og.agents.table_curation_agent import TableCurationAgent
            self._curation_agent = TableCurationAgent()
        return self._curation_agent

    def _lazy_naming(self):
        if self._naming_agent is None:
            from og.agents.table_naming_agent import TableNamingAgent
            kwargs = {}
            if self._naming_cache is not None:
                kwargs["cache_dir"] = self._naming_cache
            if self._topic is not None:
                kwargs["topic"] = self._topic
            if self._naming_model is not None:
                kwargs["model"] = self._naming_model
            self._naming_agent = TableNamingAgent(**kwargs)
        return self._naming_agent

    def lifecycle(self, og, version: str = "v1.0") -> dict:
        return self._lifecycle.process_all(og, version)

    def curate(self, og, version: str = "curated") -> dict:
        return self._lazy_curation().curate(og, version=version)

    def name_all(self, og, version: str = "named") -> dict:
        return self._lazy_naming().name_all(og, version=version)

    def run_all(self, og, version: str = "v1.0") -> dict:
        return {
            "lifecycle": self.lifecycle(og, version=version),
            "curate":    self.curate(og, version=f"{version}-curated"),
            "name_all":  self.name_all(og, version=f"{version}-named"),
        }
