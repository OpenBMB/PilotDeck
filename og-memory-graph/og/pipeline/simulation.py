
from __future__ import annotations
import os
import sys
import json
import yaml
import time
from pathlib import Path
from datetime import datetime

from og.core.graph import OutlineGraph
from og.core.node import (OGNode, NodeType, RhetoricalRole, StalenessRisk,
                          NodeStatus, DataBlock, ChangeLogEntry)
from og.core.edge import OGEdge, EdgeType, EdgeStrength
from og.storage.graph_store import GraphStore
from og.storage.vector_store import VectorStore
from og.storage.yaml_store import YAMLStore
from og.agents.propagate_agent import PropagateAgent
from og.agents.validate_agent import ValidateAgent
from og.agents.render_agent import RenderAgent
from og.agents.locate_agent import LocateAgent, LocateResult
from og.agents.refresh_agent import RefreshAgent
from og.agents.rewrite_agent import RewriteAgent
from og.agents.table_agent import TableLifecycleAgent
from og.config.paths import paths as _paths

BASE = Path(__file__).parent


def _ensure_build_v1_exists(out_path: Path,
                             period_year_range: tuple[int, int]) -> None:
    cfg = LITERATURE_ANALYSIS_CONFIG
    if out_path.exists() and not cfg.get("force_regenerate"):
        return
    if not cfg.get("enabled"):
        raise SystemExit(
            f"[error] {out_path.name} 不存在且 LiteratureAnalysisAgent 未启用.\n"
            f"  请加 --auto-extract (run_cluster_generic.py) 让框架自动生成,\n"
            f"  或者离线生成 {out_path}."
        )
    from og.agents.literature_analysis_agent import LiteratureAnalysisAgent

    agent = LiteratureAnalysisAgent(
        mode="build",
        topic=TOPIC_TITLE,
        cache_dir=INTER / "literature_analysis_cache",
        model=cfg.get("model", "claude-opus-4-7"),
        parallel=cfg.get("parallel", 4),
        candidate_node_top_k=cfg.get("candidate_node_top_k", 30),
        max_tokens=cfg.get("max_tokens", 6000),
        temperature=cfg.get("temperature", 0.0),
        existing_ref_meta=REF_META_MAP,
        task_year_range=tuple(TASK_YEAR_RANGE) if TASK_YEAR_RANGE else None,
    )
    audit_dir = INTER / "literature_analysis_v1"
    agent.analyze_build(
        ref_dir=REF_DIR,
        ref_range=INITIAL_REF_RANGE,
        period_year_range=period_year_range,
        out_path=out_path,
        audit_dir=audit_dir,
    )


def _ensure_update_vN_exists(out_path: Path,
                              ref_dir: Path,
                              ref_range: tuple[int, int],
                              period_label: str,
                              period_year_range: tuple[int, int],
                              current_og: OutlineGraph,
                              vector_store,
                              force_resume: bool = False,
                              ref_number_offset: int = 0) -> None:
    cfg = LITERATURE_ANALYSIS_CONFIG
    partial_path = out_path.with_name(f"{out_path.stem}.partial.json")
    if out_path.exists() and not cfg.get("force_regenerate") and not force_resume:
        return
    if force_resume and partial_path.exists():
        print(f"  [resume] 检测到 {partial_path.name}, 继续补齐未完成 ref")
    if not cfg.get("enabled"):
        raise SystemExit(
            f"[error] {out_path.name} 不存在且 LiteratureAnalysisAgent 未启用.\n"
            f"  请加 --auto-extract (run_cluster_generic.py) 让框架自动生成,\n"
            f"  或者离线生成 {out_path}."
        )
    from og.agents.literature_analysis_agent import LiteratureAnalysisAgent

    agent = LiteratureAnalysisAgent(
        mode="delta",
        topic=TOPIC_TITLE,
        cache_dir=INTER / "literature_analysis_cache",
        model=cfg.get("model", "claude-opus-4-7"),
        parallel=cfg.get("parallel", 4),
        candidate_node_top_k=cfg.get("candidate_node_top_k", 30),
        max_tokens=cfg.get("max_tokens", 6000),
        temperature=cfg.get("temperature", 0.0),
        existing_ref_meta=REF_META_MAP,
        task_year_range=tuple(TASK_YEAR_RANGE) if TASK_YEAR_RANGE else None,
    )
    audit_dir = INTER / f"literature_analysis_v{period_label}"
    agent.analyze_delta(
        new_ref_dir=ref_dir,
        new_ref_range=ref_range,
        current_og=current_og,
        vector_store=vector_store,
        period_label=period_label,
        period_year_range=period_year_range,
        out_path=out_path,
        audit_dir=audit_dir,
        ref_number_offset=ref_number_offset,
    )


def _resolve_or_materialize_section(og: OutlineGraph, parent_sec_name: str,
                                     version: str):
    if parent_sec_name:

        for n in og.get_sections():
            if n.title == parent_sec_name:
                return n, "section_exact"


        for n in og.get_sections():
            if parent_sec_name in n.title or n.title in parent_sec_name:
                return n, "section_lenient_match"

        root = og.get_root()
        if root is not None:
            new_sec = OGNode(
                id=og.generate_id(),
                type=NodeType.SECTION,
                title=parent_sec_name,
                rhetorical_role=RhetoricalRole.CONTAINER,
                level=2,
                staleness_risk=StalenessRisk.LOW,
                created_in_version=version,
                last_updated_version=version,
                change_log=[ChangeLogEntry(
                    version, "CREATE",
                    description=f"自动物化新 section: {parent_sec_name}"
                )],
            )
            og.add_node(new_sec)
            og.add_edge(OGEdge(root.id, new_sec.id, EdgeType.CONTAINS,
                               created_in_version=version))
            return new_sec, "section_created"


    root = og.get_root()
    if root is not None:
        for sec in og.get_children(root.id, NodeType.SECTION):
            if "结论" in sec.title or "展望" in sec.title:
                return sec, "section_fallback_outlook"
    return root, "section_fallback_root"










TOPIC_ID: str = "01"
TOPIC_TITLE: str = "中国九阶层收入结构与中产阶级深度研究报告"
BASE_YEAR_INITIAL: int = 2023
BASE_VERSION_INITIAL: str = "v1.0"


TASK_YEAR_RANGE: list[int] | None = None
V1_PERIOD_YEAR_RANGE: list[int] | None = None
INITIAL_REF_RANGE: tuple[int, int] = (1, 9)

REF_DIR: Path = BASE / "reference_texts"
AGENT_DIR: Path = BASE / "agent_outputs"
INITIAL_BUILD_FILE: str = "build_2023.json"
RAW_REPORT_PATH: Path = BASE.parent.parent / "results2023" / "01_中国9阶层收入与中产研究.md"

OG_STORE: Path = BASE.parent / "og_store"
INTER: Path = _paths.data.intermediates
OUTPUT_DIR: Path = BASE
VECTOR_COLLECTION: str = "og_full_v2"



MAX_VERSION: str | None = None
RESUME_FROM_VERSION: str | None = None






try:
    from og.config.models import LLM_MAIN as _DEFAULT_LIT_MODEL
except ImportError:
    _DEFAULT_LIT_MODEL = "deepseek-v4-pro"

_LIT_PARALLEL = int(os.environ.get("LITERATURE_ANALYSIS_PARALLEL", "4"))
LITERATURE_ANALYSIS_CONFIG: dict = {
    "enabled": False,
    "force_regenerate": False,
    "model": _DEFAULT_LIT_MODEL,
    "parallel": _LIT_PARALLEL,
    "candidate_node_top_k": 30,
    "max_tokens": 6000,
    "temperature": 0.0,
}








CURATION_CONFIG: dict = {
    "run_curation": False,
    "run_rewrite": False,
    "rewrite_only_changed_since_version": None,
    "rewrite_parallel": 4,
}


UPDATE_CONFIGS: dict = {
    "2024": {"old_year": 2023, "new_year": 2024, "old_version": "v1.0", "new_version": "v2.0",
             "delta_file": "update_2024.json", "ref_dir": "reference_texts_2024",
             "ref_range": (9, 20), "phase_name": "phase2_2024"},
    "2025": {"old_year": 2024, "new_year": 2025, "old_version": "v2.0", "new_version": "v3.0",
             "delta_file": "update_2025.json", "ref_dir": "reference_texts_2025",
             "ref_range": (20, 26), "phase_name": "phase3_2025"},
    "2026": {"old_year": 2025, "new_year": 2026, "old_version": "v3.0", "new_version": "v4.0",
             "delta_file": "update_2026.json", "ref_dir": "reference_texts_2026",
             "ref_range": (26, 37), "phase_name": "phase4_2026"},
}


REF_META_MAP: dict[int, dict] = {
    1: {"title": "国家统计局《2023年居民收入和消费支出情况》", "author": "国家统计局",
        "url": "https://www.stats.gov.cn/sj/zxfb/202401/t20240117_1946624.html",
        "publish_date": "2024-01", "data_year": "2023", "tier": "T1"},
    2: {"title": "国家统计局《2023年中国社会统计年鉴》", "author": "国家统计局",
        "url": "https://www.stats.gov.cn/sj/ndsj/",
        "publish_date": "2023", "data_year": "2023", "tier": "T1"},
    3: {"title": "《中国家庭财富变动趋势（2023-Q2/Q3）》", "author": "西南财经大学CHFS",
        "url": "https://chfs.swufe.edu.cn/",
        "publish_date": "2023", "data_year": "2023", "tier": "T2"},
    4: {"title": "《2022-2023中国家庭资产配置白皮书》", "author": "普益基金/普益标准",
        "url": "https://www.puyi.com/",
        "publish_date": "2023", "data_year": "2022-2023", "tier": "T2"},
    5: {"title": "《2023年中国高净值人群家庭财富报告》", "author": "胡润研究院",
        "url": "https://www.hurun.net/",
        "publish_date": "2023", "data_year": "2023", "tier": "T3"},
    6: {"title": "《新中产2023年六大消费趋势》", "author": "吴晓波频道",
        "url": "https://www.wuxiaobo.com/",
        "publish_date": "2023", "data_year": "2023", "tier": "T3"},
    7: {"title": "《中国居民收入分配年度报告（2023）》", "author": "发改委/北师大ICID",
        "url": "http://icid.bnu.edu.cn/",
        "publish_date": "2023", "data_year": "2023", "tier": "T1"},
    8: {"title": "21世纪经济报道：高收入组数据分析", "author": "21世纪经济报道",
        "url": "https://www.21jingji.com/",
        "publish_date": "2024-01", "data_year": "2023", "tier": "T3"},
}


def configure(cfg: dict):
    global TOPIC_ID, TOPIC_TITLE, BASE_YEAR_INITIAL, BASE_VERSION_INITIAL
    global INITIAL_REF_RANGE, REF_DIR, AGENT_DIR, INITIAL_BUILD_FILE
    global RAW_REPORT_PATH, OG_STORE, INTER, OUTPUT_DIR, VECTOR_COLLECTION
    global TASK_YEAR_RANGE, V1_PERIOD_YEAR_RANGE
    global REF_META_MAP, UPDATE_CONFIGS, CURATION_CONFIG, LITERATURE_ANALYSIS_CONFIG
    global MAX_VERSION, RESUME_FROM_VERSION
    TOPIC_ID = cfg["topic_id"]
    TOPIC_TITLE = cfg["topic_title"]
    BASE_YEAR_INITIAL = cfg["base_year_initial"]
    BASE_VERSION_INITIAL = cfg.get("base_version_initial", "v1.0")
    INITIAL_REF_RANGE = cfg["initial_ref_range"]
    REF_DIR = Path(cfg["ref_dir"])
    AGENT_DIR = Path(cfg["agent_dir"])
    INITIAL_BUILD_FILE = cfg["initial_build_file"]
    RAW_REPORT_PATH = Path(cfg["raw_report_path"])
    OG_STORE = Path(cfg["og_store"])
    INTER = Path(cfg["inter"])
    OUTPUT_DIR = Path(cfg["output_dir"])
    VECTOR_COLLECTION = cfg["vector_collection"]
    REF_META_MAP = cfg["ref_meta_map"]
    UPDATE_CONFIGS = cfg["update_configs"]
    if "curation_config" in cfg:
        CURATION_CONFIG = {**CURATION_CONFIG, **cfg["curation_config"]}
    if "literature_analysis_config" in cfg:
        LITERATURE_ANALYSIS_CONFIG = {**LITERATURE_ANALYSIS_CONFIG,
                                       **cfg["literature_analysis_config"]}
    MAX_VERSION = cfg.get("max_version")
    RESUME_FROM_VERSION = cfg.get("resume_from_version")
    TASK_YEAR_RANGE = cfg.get("task_year_range")
    V1_PERIOD_YEAR_RANGE = cfg.get("v1_period_year_range")


def _rel(path):
    try:
        return str(path.relative_to(BASE))
    except ValueError:
        try:
            return str(path.relative_to(BASE.parent))
        except ValueError:
            return str(path)


def save_json(data, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)
    print(f"    📄 已保存: {_rel(path)}")


def save_text(text, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    print(f"    📄 已保存: {_rel(path)}")


def print_header(text):
    print(f"\n{'='*70}")
    print(f"  {text}")
    print(f"{'='*70}")


def print_step(text):
    print(f"\n  >> {text}")






def phase1_build_from_references():
    init_v = BASE_VERSION_INITIAL
    init_y = BASE_YEAR_INITIAL
    print_header(f"Phase 1: 基于参考文献构建{init_y}年OG知识库 [{TOPIC_TITLE}]")
    p1 = INTER / "phase1"
    p1.mkdir(parents=True, exist_ok=True)


    v1_pr = (tuple(V1_PERIOD_YEAR_RANGE) if V1_PERIOD_YEAR_RANGE
             else (init_y, init_y))
    _ensure_build_v1_exists(
        out_path=AGENT_DIR / INITIAL_BUILD_FILE,
        period_year_range=v1_pr,
    )

    gs = GraphStore(OG_STORE)
    vs = VectorStore(VECTOR_COLLECTION)
    ys = YAMLStore(OG_STORE)

    ref_lo, ref_hi = INITIAL_REF_RANGE
    

    import re
    all_ref_files = sorted(REF_DIR.glob("*.txt"))
    ref_numbered = []
    ref_others = []
    
    for p in all_ref_files:
        m = re.match(r"ref_(\d+)\.txt$", p.name)
        if m:
            ref_numbered.append((int(m.group(1)), p))
        else:
            ref_others.append(p)
    

    ref_numbered_filtered = [(num, p) for num, p in ref_numbered if ref_lo <= num < ref_hi]
    

    used_nums = {num for num, _ in ref_numbered_filtered}
    next_num = ref_lo
    ref_others_mapped = []
    for p in ref_others:
        while next_num in used_nums:
            next_num += 1
        if next_num < ref_hi:
            ref_others_mapped.append((next_num, p))
            used_nums.add(next_num)
            next_num += 1
    
    all_refs_to_load = ref_numbered_filtered + ref_others_mapped
    print_step(f"Step 1.1: 加载{len(all_refs_to_load)}篇参考文献到向量DB + 生成Paper Card")
    print(f"    (含 {len(ref_numbered_filtered)} 个 ref_NNN.txt + {len(ref_others_mapped)} 个 ref_gt_*.txt)")

    ref_meta_map = REF_META_MAP
    ref_chunk_summary = []
    
    for i, path in all_refs_to_load:
        text = path.read_text(encoding="utf-8")
        ref_id = f"REF-{i:03d}"
        meta = ref_meta_map.get(i, {})

        vs.add_reference_chunks(ref_id, text, "", {"report_id": TOPIC_ID, "tier": meta.get("tier", "T3")})
        ys.save_ref_cache(ref_id, text)

        card = {
            "ref_number": i, "id": ref_id,
            "title": meta.get("title", f"参考文献[{i}]"),
            "author": meta.get("author", ""),
            "url": meta.get("url", ""),
            "publish_date": meta.get("publish_date", ""),
            "data_year": meta.get("data_year", ""),
            "tier": meta.get("tier", ""),
            "abstract": text[:300],
            "full_text_length": len(text),
        }
        ys.save_paper_card(ref_id, card, init_v)

        chunk_count = len(vs.chunk_text(text, 300))
        ref_chunk_summary.append({
            "ref_id": ref_id, "title": meta.get("title", ""),
            "text_length": len(text), "chunks": chunk_count
        })
        print(f"    [{ref_id}] {meta.get('title', '')[:50]}... ({len(text)}字, {chunk_count} chunks)")

    total_ref_chunks = vs.total_chunks()
    print(f"    → 向量DB: {total_ref_chunks} chunks (来自参考文献)")

    save_json({"total_refs": len(all_refs_to_load), "total_chunks": total_ref_chunks,
               "refs": ref_chunk_summary}, p1 / "01_ref_chunks_summary.json")


    print_step("Step 1.2: Agent基于参考文献构建OG图谱")

    with open(AGENT_DIR / INITIAL_BUILD_FILE, encoding="utf-8") as f:
        agent_output = json.load(f)

    og = OutlineGraph(TOPIC_ID, init_y, init_v, topic=TOPIC_TITLE)

    raw_report = RAW_REPORT_PATH.read_text(encoding="utf-8") if RAW_REPORT_PATH.exists() else ""

    root = OGNode(og.generate_id(), NodeType.SECTION, "报告根节点",
                  RhetoricalRole.CONTAINER, staleness_risk=StalenessRisk.LOW,
                  created_in_version=init_v, last_updated_version=init_v)
    og.add_node(root)

    import re
    sections = {}
    section_list = []
    if raw_report:
        for line in raw_report.split("\n"):
            m = re.match(r'^(#{1,3})\s+(.+)$', line)
            if m:
                level = len(m.group(1))
                title = m.group(2).strip()
                if level == 1:
                    continue
                sec = OGNode(og.generate_id(), NodeType.SECTION, title,
                             RhetoricalRole.CONTAINER, level=level,
                             staleness_risk=StalenessRisk.LOW,
                             created_in_version=init_v, last_updated_version=init_v)
                og.add_node(sec)
                sections[title] = sec
                section_list.append(sec)


    if not section_list:
        for nd in agent_output.get("nodes", []):
            ps = nd.get("parent_section", "")
            if ps and ps not in sections:
                sec = OGNode(og.generate_id(), NodeType.SECTION, ps,
                             RhetoricalRole.CONTAINER, level=2,
                             staleness_risk=StalenessRisk.LOW,
                             created_in_version=init_v, last_updated_version=init_v)
                og.add_node(sec)
                sections[ps] = sec
                section_list.append(sec)

    for i, sec in enumerate(section_list):
        if sec.level and sec.level >= 3:
            found_parent = False
            for prev in reversed(section_list[:i]):
                if prev.level and prev.level < sec.level:
                    og.add_edge(OGEdge(prev.id, sec.id, EdgeType.CONTAINS, created_in_version=init_v))
                    found_parent = True
                    break
            if not found_parent:
                og.add_edge(OGEdge(root.id, sec.id, EdgeType.CONTAINS, created_in_version=init_v))
        else:
            og.add_edge(OGEdge(root.id, sec.id, EdgeType.CONTAINS, created_in_version="v1.0"))

    id_map = {}
    node_count_by_type = {}
    for nd in agent_output.get("nodes", []):
        ntype = NodeType(nd["type"])
        node = OGNode(
            id=og.generate_id(),
            type=ntype,
            title=nd["title"],
            rhetorical_role=RhetoricalRole(nd.get("rhetorical_role", "evidence")),
            content_summary=nd.get("content_summary", ""),
            original_text=nd.get("original_text", ""),
            data_blocks=[DataBlock(**db) for db in nd.get("data_blocks", [])],
            cited_refs=nd.get("cited_refs", []),
            temporal_scope=nd.get("temporal_scope", ""),
            staleness_risk=StalenessRisk(nd.get("staleness_risk", "medium")),
            confidence=nd.get("confidence", 0.9),
            created_in_version=init_v, last_updated_version=init_v,
        )
        if ntype == NodeType.REFERENCE:
            node.ref_number = nd.get("ref_number")
            node.author = nd.get("author", "")
            node.url = nd.get("url", "")
            node.publish_date = nd.get("publish_date", "")
            node.data_year = nd.get("data_year", "")
            node.tier = nd.get("tier", "")

        og.add_node(node)
        id_map[nd["temp_id"]] = node.id
        node_count_by_type[ntype.value] = node_count_by_type.get(ntype.value, 0) + 1

        parent_sec = nd.get("parent_section", "")
        if parent_sec and parent_sec in sections:
            og.add_edge(OGEdge(sections[parent_sec].id, node.id, EdgeType.CONTAINS,
                               created_in_version=init_v))

    edge_count = 0
    for ed in agent_output.get("edges", []):
        src = id_map.get(ed["source"], ed["source"])
        tgt = id_map.get(ed["target"], ed["target"])
        if og.get_node(src) and og.get_node(tgt):
            og.add_edge(OGEdge(src, tgt, EdgeType(ed["type"]),
                               EdgeStrength(ed.get("strength", "moderate")),
                               init_v, ed.get("reason", ""),
                               ed.get("confidence", 0.8)))
            edge_count += 1

    stats = og.stats()
    print(f"    → OG构建: {stats['total_nodes']}个活跃节点, {stats['total_edges']}条边")
    print(f"    → 节点类型: {node_count_by_type}")

    save_json(id_map, p1 / f"02_id_map_{init_v}.json")
    save_json(id_map, OG_STORE / f"id_map_{init_v}.json")
    save_json({"og_stats": stats, "node_counts": node_count_by_type,
               "edge_count_from_json": edge_count,
               "sections_parsed": list(sections.keys())},
              p1 / "03_og_build_result.json")


    print_step("Step 1.3: OG节点内容chunk到向量DB")

    node_chunk_count = 0
    for node in og.active_content_nodes():
        section_id = ""
        parents = og.get_incoming_edges(node.id, EdgeType.CONTAINS)
        for p in parents:
            pn = og.get_node(p.source_id)
            if pn and pn.type == NodeType.SECTION:
                section_id = pn.id
                break
        meta = {"node_type": node.type.value, "section_id": section_id,
                "temporal_scope": node.temporal_scope, "node_status": "active", "report_id": TOPIC_ID}
        vs.add_node_chunks(node.id, node.content_summary,
                           [vars(db) for db in node.data_blocks], meta, "report")
        node_chunk_count += 1

    total_chunks = vs.total_chunks()
    print(f"    → {node_chunk_count}个节点已入库, 向量DB总量: {total_chunks} chunks")
    save_json({"ref_chunks": total_ref_chunks, "node_chunks_added": node_chunk_count,
               "total_chunks": total_chunks}, p1 / "04_vector_db_stats.json")


    print_step("Step 1.4: 校验OG一致性")
    validator = ValidateAgent()
    issues = validator.validate(og)
    issue_list = [{"check": i.check, "node_id": i.node_id,
                   "severity": i.severity, "description": i.description} for i in issues]
    print(f"    → {len(issues)} 个校验问题")
    for issue in issues[:10]:
        print(f"      [{issue.severity}] {issue.description}")
    save_json({"total_issues": len(issues), "issues": issue_list}, p1 / "05_validation_report.json")

    gs.save(og)
    print(f"    → OG已保存: {OG_STORE / f'og_{TOPIC_ID}_{og.version}.json'}")


    print_step(f"Step 1.5: 渲染{init_v}报告")
    renderer = RenderAgent()
    report = renderer.render_full_report(og)
    output_path = OUTPUT_DIR / f"output_report_{init_v}.md"
    save_text(report, output_path)
    print(f"    → {init_v}报告: {len(report.split(chr(10)))} 行, {len(report)} 字符")

    return og, gs, vs, ys, id_map







def phase_update(og, gs, vs, ys, id_map, config):
    old_year = config["old_year"]
    new_year = config["new_year"]
    new_version = config["new_version"]
    phase_dir = INTER / config["phase_name"]
    phase_dir.mkdir(parents=True, exist_ok=True)

    print_header(f"Phase: {old_year}→{new_year} 增量更新 ({new_version})")

    ref_dir_name = config["ref_dir"]
    ref_dir = (BASE / ref_dir_name) if not Path(ref_dir_name).is_absolute() else Path(ref_dir_name)
    if not ref_dir.exists():
        ref_dir = REF_DIR.parent / ref_dir_name
    ref_start, ref_end = config["ref_range"]
    

    import re
    all_ref_files = sorted(ref_dir.glob("*.txt"))
    ref_numbered = []
    ref_others = []
    
    for p in all_ref_files:
        m = re.match(r"ref_(\d+)\.txt$", p.name)
        if m:
            ref_numbered.append((int(m.group(1)), p))
        else:
            ref_others.append(p)
    
    ref_numbered_filtered = [(num, p) for num, p in ref_numbered if ref_start <= num < ref_end]
    
    used_nums = {num for num, _ in ref_numbered_filtered}
    next_num = ref_start
    ref_others_mapped = []
    for p in ref_others:
        while next_num in used_nums:
            next_num += 1
        if next_num < ref_end:
            ref_others_mapped.append((next_num, p))
            used_nums.add(next_num)
            next_num += 1
    
    all_refs_to_load = ref_numbered_filtered + ref_others_mapped
    print_step(f"加载{len(all_refs_to_load)}篇{new_year}年新参考文献到向量DB")

    new_ref_summary = []


    ref_offset = config.get("ref_number_offset", 0)
    
    for i, path in all_refs_to_load:
        global_ref_num = i + ref_offset
        text = path.read_text(encoding="utf-8")
        ref_id = f"REF-{global_ref_num:03d}"
        meta = REF_META_MAP.get(i, {})

        vs.add_reference_chunks(ref_id, text, "", {"report_id": TOPIC_ID,
                                                     "tier": meta.get("tier", "T2")})
        ys.save_ref_cache(ref_id, text)

        text_lines = text.strip().split("\n")
        title_line = meta.get("title") or (text_lines[0] if text_lines else f"参考文献[{global_ref_num}]")
        card = {
            "ref_number": global_ref_num, "id": ref_id,
            "title": title_line,
            "author": meta.get("author", ""),
            "url": meta.get("url", ""),
            "publish_date": meta.get("publish_date", ""),
            "data_year": meta.get("data_year", ""),
            "tier": meta.get("tier", "T2"),
            "abstract": text[:300],
            "full_text_length": len(text),
        }
        ys.save_paper_card(ref_id, card, new_version)

        chunk_count = len(vs.chunk_text(text, 300))
        new_ref_summary.append({"ref_id": ref_id, "title": title_line[:60],
                                 "text_length": len(text), "chunks": chunk_count})
        print(f"    [{ref_id}] {title_line[:50]}... ({len(text)}字, {chunk_count} chunks)")

    print(f"    → 向量DB总量: {vs.total_chunks()} chunks")
    save_json({"new_refs": len(new_ref_summary), "refs": new_ref_summary,
               "total_chunks_after": vs.total_chunks()},
              phase_dir / "01_new_ref_chunks_summary.json")


    update_path = AGENT_DIR / config["delta_file"]
    period_label = config["new_version"].lstrip("v").rstrip(".0")
    pyr = (tuple(config["period_year_range"])
           if config.get("period_year_range")
           else (config["old_year"], config["new_year"]))
    _ensure_update_vN_exists(
        out_path=update_path,
        ref_dir=Path(config["ref_dir"]),
        ref_range=tuple(config["ref_range"]),
        period_label=period_label,
        period_year_range=pyr,
        current_og=og,
        vector_store=vs,
        force_resume=(RESUME_FROM_VERSION is not None and update_path.with_name(
            f"{update_path.stem}.partial.json").exists()),
        ref_number_offset=config.get("ref_number_offset", 0),
    )

    print_step("加载 Delta 和新参考文献定义 (来自 agent_outputs/, 可能由 LiteratureAnalysisAgent 在线生成)")

    with open(update_path, encoding="utf-8") as f:
        update_data = json.load(f)
    deltas = update_data["deltas"]
    new_refs = update_data.get("new_references", [])

    save_json({"total_deltas": len(deltas), "total_new_refs": len(new_refs),
               "deltas": deltas, "new_references": new_refs},
              phase_dir / "02_delta_extraction.json")
    print(f"    → {len(deltas)} 条Delta + {len(new_refs)} 条新参考文献定义")

    print_step("添加新参考文献节点到OG")
    for ref in new_refs:
        ref_node = OGNode(
            id=f"REF-{ref['ref_number']:03d}",
            type=NodeType.REFERENCE, title=ref["title"],
            rhetorical_role=RhetoricalRole.EVIDENCE,
            ref_number=ref["ref_number"], author=ref.get("author", ""),
            url=ref.get("url", ""), publish_date=ref.get("publish_date", ""),
            data_year=ref.get("data_year", ""), tier=ref.get("tier", ""),
            staleness_risk=StalenessRisk.LOW,
            created_in_version=new_version, last_updated_version=new_version,
        )
        if not og.get_node(ref_node.id):
            og.add_node(ref_node)
            print(f"    + REF-{ref['ref_number']:03d}: {ref['title'][:50]}")

    print_step("对每条 Delta 用 LocateAgent (粗 section 树 + 细 chunk 检索) 定位目标节点")









    locator = LocateAgent(id_map=id_map)

    locate_results = []
    modify_operations = []
    modified_nodes = []

    for delta in deltas:
        target_temp = delta.get("target_node")
        target_op = delta.get("target_op", "AUGMENT")
        delta_id = delta.get("id", "<no-id>")


        try:
            cands: list[LocateResult] = locator.locate(og, delta, vs)
        except Exception as e:
            print(f"    [warn] {delta_id} LocateAgent 抛异常: {e}; 回落到旧路径")
            cands = []


        candidate_dump = [{
            "node_id": c.node.id,
            "title": c.node.title[:50],
            "operation": c.operation,
            "score": round(c.score, 3),
            "source": c.source,
            "section_id": c.section_id,
            "reason": c.reason,

            "llm_target_node": c.llm_target_node,
            "retrieval_top_node_id": c.retrieval_top_node_id,
            "retrieval_top_score": (round(c.retrieval_top_score, 3)
                                     if c.retrieval_top_score is not None else None),
            "retrieval_top_rerank_score": (round(c.retrieval_top_rerank_score, 3)
                                           if c.retrieval_top_rerank_score is not None else None),
            "retrieval_top_rrf_score": (round(c.retrieval_top_rrf_score, 6)
                                        if c.retrieval_top_rrf_score is not None else None),
            "retrieval_top_raw_score": (round(c.retrieval_top_raw_score, 3)
                                        if c.retrieval_top_raw_score is not None else None),
            "retrieval_top_has_rerank_score": c.retrieval_top_has_rerank_score,
            "verification_agreement": c.verification_agreement,
            "decision": c.decision,
        } for c in cands]


        node: OGNode | None = None
        chosen_source = "none"
        conflict = False

        if target_op == "CREATE" or not cands:

            target_op = "CREATE"
            parent_sec_name = delta.get("parent_section", "")
            node, locate_method = _resolve_or_materialize_section(
                og, parent_sec_name, new_version
            )
            chosen_source = locate_method
        else:

            primary = next((c for c in cands
                            if c.source in ("id_map", "temp_id_fuzzy", "precomputed")), None)
            top_fine = next((c for c in cands
                              if c.source not in ("id_map", "temp_id_fuzzy",
                                                  "precomputed", "new_section")),
                             None)
            if primary is not None:
                node = primary.node
                target_op = primary.operation or target_op
                chosen_source = primary.source
                if top_fine and top_fine.node.id != primary.node.id:
                    conflict = True
            elif top_fine is not None:
                node = top_fine.node
                target_op = top_fine.operation or target_op
                chosen_source = top_fine.source
            else:

                cn = cands[0]
                node = cn.node
                target_op = cn.operation
                chosen_source = cn.source


        primary_lr = next((c for c in cands
                           if c.source.startswith(("id_map", "temp_id_fuzzy",
                                                    "retrieval_override"))), None)
        ver_audit = {
            "llm_target_node": (primary_lr.llm_target_node
                                 if primary_lr is not None else target_temp),
            "retrieval_top_node_id": (primary_lr.retrieval_top_node_id
                                       if primary_lr is not None else None),
            "retrieval_top_score": (round(primary_lr.retrieval_top_score, 3)
                                     if primary_lr is not None
                                     and primary_lr.retrieval_top_score is not None
                                     else None),
            "retrieval_top_rerank_score": (round(primary_lr.retrieval_top_rerank_score, 3)
                                           if primary_lr is not None
                                           and primary_lr.retrieval_top_rerank_score is not None
                                           else None),
            "retrieval_top_rrf_score": (round(primary_lr.retrieval_top_rrf_score, 6)
                                        if primary_lr is not None
                                        and primary_lr.retrieval_top_rrf_score is not None
                                        else None),
            "retrieval_top_raw_score": (round(primary_lr.retrieval_top_raw_score, 3)
                                        if primary_lr is not None
                                        and primary_lr.retrieval_top_raw_score is not None
                                        else None),
            "retrieval_top_has_rerank_score": (primary_lr.retrieval_top_has_rerank_score
                                                if primary_lr is not None else None),
            "verification_agreement": (primary_lr.verification_agreement
                                        if primary_lr is not None else None),
            "decision": (primary_lr.decision if primary_lr is not None else None),
        }
        locate_entry = {
            "delta_id": delta_id,
            "target_temp_id": target_temp,
            "resolved_node_id": node.id if node else None,
            "resolved_node_title": node.title[:80] if node else None,
            "operation": target_op,
            "chosen_source": chosen_source,
            "conflict_id_map_vs_locate": conflict,
            "verification": ver_audit,
            "candidates": candidate_dump,
        }
        locate_results.append(locate_entry)

        result_node = _execute_operation(og, node, target_op, delta, vs, ys, new_version)
        if result_node:
            modified_nodes.append((result_node, target_op))
            modify_entry = {
                "delta_id": delta_id,
                "operation": target_op,
                "target_node_id": node.id if node else None,
                "result_node_id": result_node.id,
                "result_node_title": result_node.title[:80],
                "data_blocks_count": len(result_node.data_blocks),
            }
            modify_operations.append(modify_entry)
            flag = " ⚠ conflict" if conflict else ""
            print(f"    {delta_id}: {target_op} → '{result_node.title[:40]}' "
                  f"({chosen_source}){flag}")

    n_conflicts = sum(1 for r in locate_results
                      if r.get("conflict_id_map_vs_locate"))

    ver_stats = {"agree": 0, "disagree": 0,
                 "trust_llm": 0, "trust_retrieval": 0,
                 "trust_llm_override": 0, "trust_llm_fallback": 0}
    for r in locate_results:
        v = r.get("verification") or {}
        if v.get("verification_agreement") is True:
            ver_stats["agree"] += 1
        elif v.get("verification_agreement") is False:
            ver_stats["disagree"] += 1
        d = v.get("decision")
        if d in ver_stats:
            ver_stats[d] += 1
    print(f"\n    → 执行了 {len(modified_nodes)} 个操作 "
          f"(id_map vs locate 冲突: {n_conflicts})")
    print(f"    → verification: agree={ver_stats['agree']} "
          f"disagree={ver_stats['disagree']} "
          f"| decisions: trust_llm={ver_stats['trust_llm']} "
          f"trust_retrieval={ver_stats['trust_retrieval']} "
          f"override={ver_stats['trust_llm_override']} "
          f"fallback={ver_stats['trust_llm_fallback']}")
    save_json({"total": len(locate_results), "results": locate_results},
              phase_dir / "03_locate_results.json")
    save_json({"total": len(modify_operations), "operations": modify_operations},
              phase_dir / "04_modify_operations.json")

    print_step("影响传播")
    propagator = PropagateAgent()
    affected = propagator.propagate(og, modified_nodes)
    prop_report = propagator.generate_report(affected)

    print(f"    → {prop_report['total_affected']} 个节点受影响")
    print(f"      高: {len(prop_report['high_impact'])} | 中: {len(prop_report['medium_impact'])} | 低: {len(prop_report['low_impact'])}")
    save_json(prop_report, phase_dir / "05_propagation_report.json")

    print_step("RefreshAgent — 时间语义规范化")
    og.version = new_version
    og.base_year = new_year
    refresher = RefreshAgent()
    refresh_report = refresher.refresh(og, old_base_year=old_year, new_base_year=new_year,
                                        affected=affected, version=new_version)

    print(f"    → Section标题: {len(refresh_report['section_titles_updated'])} | "
          f"时间语义: {len(refresh_report['temporal_framing_normalized'])} | "
          f"标题清洗: {len(refresh_report.get('titles_cleaned', []))} | "
          f"时间范围: {len(refresh_report['temporal_scopes_fixed'])}")
    save_json(refresh_report, phase_dir / "06_refresh_report.json")

    print_step("RewriteAgent — 去重 + 合并Synthesis + 标题规范化")
    rewriter = RewriteAgent()
    rewrite_report = rewriter.rewrite(og, new_version)
    print(f"    → 去重: {len(rewrite_report['redundancies_merged'])} | "
          f"Synthesis合并: {len(rewrite_report['syntheses_merged'])} | "
          f"标题规范化: {len(rewrite_report['titles_normalized'])}")
    save_json(rewrite_report, phase_dir / "07_rewrite_report.json")

    print_step("TableLifecycleAgent — 表格创建/更新/拆分/引用")
    ref_tier_map = {}
    for ref in og.get_all_nodes(NodeType.REFERENCE):
        if ref.ref_number and ref.tier:
            ref_tier_map[ref.ref_number] = ref.tier
    table_mgr = TableLifecycleAgent(ref_tier_map)
    table_report = table_mgr.process_all(og, new_version)
    print(f"    → 创建: {len(table_report['created'])} | "
          f"更新: {len(table_report['updated'])} | "
          f"拆分: {len(table_report['split'])} | "
          f"引用: {len(table_report['referenced'])}")
    save_json(table_report, phase_dir / "08_table_report.json")

    print_step("校验")
    validator = ValidateAgent()
    issues = validator.validate(og)
    issue_list = [{"check": i.check, "node_id": i.node_id,
                   "severity": i.severity, "description": i.description} for i in issues]
    print(f"    → {len(issues)} 个校验问题")
    save_json({"total_issues": len(issues), "issues": issue_list},
              phase_dir / "09_validation_report.json")

    print_step(f"渲染{new_version}报告")
    renderer = RenderAgent()
    report_text = renderer.render_full_report(og)
    output_path = OUTPUT_DIR / f"output_report_{new_version}.md"
    save_text(report_text, output_path)
    print(f"    → {new_version}报告: {len(report_text.split(chr(10)))} 行, {len(report_text)} 字符")

    gs.save(og)

    final_stats = og.stats()
    save_json({
        "version": new_version, "base_year": new_year,
        "og_stats": final_stats,
        "modified_count": len(modified_nodes),
        "propagated_count": prop_report["total_affected"],
        "validation_issues": len(issues),
        "refresh_sections": len(refresh_report["section_titles_updated"]),
        "refresh_temporal": len(refresh_report["temporal_framing_normalized"]),
        "rewrite_dedup": len(rewrite_report["redundancies_merged"]),
        "rewrite_synth_merge": len(rewrite_report["syntheses_merged"]),
        "tables_created": len(table_report["created"]),
    }, phase_dir / "10_final_summary.json")

    print(f"\n    → 最终OG: {final_stats}")
    return og


def _execute_operation(og, target, op, delta, vs, ys, version="v2.0"):

    if op == "SUPERSEDE":
        new_node = OGNode(
            id=og.generate_id(),
            type=target.type if target.type != NodeType.SECTION else NodeType.EVIDENCE,
            title=delta.get("title", target.title),
            rhetorical_role=(target.rhetorical_role if target.type != NodeType.SECTION
                             else RhetoricalRole.EVIDENCE),
            content_summary=delta["content"],
            data_blocks=[DataBlock(**db) for db in delta.get("data_points", [])],
            cited_refs=delta.get("cited_refs", []),
            temporal_scope=str(delta.get("data_year", "")),
            staleness_risk=StalenessRisk.HIGH,
            confidence=0.9, created_in_version=version, last_updated_version=version,
            change_log=[ChangeLogEntry(version, "SUPERSEDE", delta["id"],
                                       description=f"替代{target.id}")]
        )
        og.add_node(new_node)

        for edge in og.get_outgoing_edges(target.id):
            if edge.type != EdgeType.SUPERSEDES:
                og.add_edge(OGEdge(new_node.id, edge.target_id, edge.type,
                                   edge.strength, version))
                og.remove_edge(edge)

        for edge in og.get_incoming_edges(target.id, EdgeType.CONTAINS):
            og.add_edge(OGEdge(edge.source_id, new_node.id, EdgeType.CONTAINS,
                               created_in_version=version))

        for edge in og.get_incoming_edges(target.id):
            if edge.type in (EdgeType.SUPPORTS, EdgeType.CONTEXTUALIZES,
                             EdgeType.COMPARED_IN, EdgeType.CITES):
                pass

        og.add_edge(OGEdge(target.id, new_node.id, EdgeType.SUPERSEDES,
                           created_in_version=version))
        target.status = NodeStatus.SUPERSEDED
        target.change_log.append(ChangeLogEntry(version, "SUPERSEDE",
                                                description=f"被{new_node.id}替代"))
        og.update_node(target)
        vs.update_node_status(target.id, "superseded")
        _write_chunks(vs, new_node, og)
        ys.append_changelog(og.version, version,
                            {"action": "SUPERSEDE", "old": target.id,
                             "new": new_node.id, "delta": delta["id"]})
        return new_node

    elif op == "AUGMENT":
        target.content_summary += "\n" + delta["content"]
        for db in delta.get("data_points", []):
            target.data_blocks.append(DataBlock(**db))
        for ref in delta.get("cited_refs", []):
            if ref not in target.cited_refs:
                target.cited_refs.append(ref)
        target.last_updated_version = version
        target.change_log.append(ChangeLogEntry(version, "AUGMENT", delta["id"],
                                                description="补充信息"))
        og.update_node(target)
        vs.delete_by_node(target.id)
        _write_chunks(vs, target, og)
        ys.append_changelog(og.version, version,
                            {"action": "AUGMENT", "node": target.id, "delta": delta["id"]})
        return target

    elif op == "CREATE":
        new_node = OGNode(
            id=og.generate_id(),
            type=NodeType(delta.get("node_type", "Evidence")),
            title=delta.get("title", delta["content"][:30]),
            rhetorical_role=RhetoricalRole(delta.get("rhetorical_role", "evidence")),
            content_summary=delta["content"],
            data_blocks=[DataBlock(**db) for db in delta.get("data_points", [])],
            cited_refs=delta.get("cited_refs", []),
            temporal_scope=str(delta.get("data_year", "")),
            staleness_risk=StalenessRisk.HIGH,
            confidence=0.8, created_in_version=version, last_updated_version=version,
            change_log=[ChangeLogEntry(version, "CREATE", delta["id"], description="新建")]
        )
        og.add_node(new_node)
        if target:
            og.add_edge(OGEdge(target.id, new_node.id, EdgeType.CONTAINS,
                               created_in_version=version))
        _write_chunks(vs, new_node, og)
        ys.append_changelog(og.version, version,
                            {"action": "CREATE", "node": new_node.id, "delta": delta["id"]})
        return new_node

    elif op == "UPDATE":
        old_summary = target.content_summary
        target.content_summary = delta["content"]
        for db in delta.get("data_points", []):
            target.data_blocks.append(DataBlock(**db))
        target.last_updated_version = version
        target.change_log.append(ChangeLogEntry(version, "UPDATE", delta["id"],
                                                description="就地更新"))
        og.update_node(target)
        vs.delete_by_node(target.id)
        _write_chunks(vs, target, og)
        ys.append_changelog(og.version, version,
                            {"action": "UPDATE", "node": target.id, "delta": delta["id"]})
        return target

    return None


def _write_chunks(vs, node, og):
    section_id = ""
    for p in og.get_incoming_edges(node.id, EdgeType.CONTAINS):
        pn = og.get_node(p.source_id)
        if pn and pn.type == NodeType.SECTION:
            section_id = pn.id
            break
    meta = {"node_type": node.type.value, "section_id": section_id,
            "temporal_scope": node.temporal_scope, "node_status": "active", "report_id": TOPIC_ID}
    vs.add_node_chunks(node.id, node.content_summary,
                       [vars(db) for db in node.data_blocks], meta, "report")






def _generate_trend_section(og, topic: str) -> str:
    import os
    from openai import OpenAI


    nodes = og.get_all_nodes(status=NodeStatus.ACTIVE)
    snippets = []
    for n in nodes:
        if n.type not in (NodeType.CLAIM, NodeType.SYNTHESIS, NodeType.COMPARISON):
            continue
        text = (n.content_summary or n.title or "").strip()
        if text and len(text) > 10:
            snippets.append(f"- {text[:300]}")
        if len(snippets) >= 80:
            break

    if not snippets:
        return ""

    prompt = (
        f"你是一名资深政治与时事分析师。以下是一份主题为「{topic}」的深度调研报告中"
        f"抽取的关键事实与结论（{len(snippets)} 条）：\n\n"
        + "\n".join(snippets)
        + "\n\n请基于以上内容，归纳出 **5-7 条宏观趋势**，要求：\n"
        "1. 每条趋势有一个简短标题（加粗），后跟 2-3 句具体说明\n"
        "2. 趋势之间应有时间跨度感（历史→当前→未来展望）\n"
        "3. 用中文书写，专业严谨\n\n"
        "请直接输出趋势列表，不要有前言/后记。"
    )

    try:
        client = OpenAI(
            api_key=os.environ.get("OPENAI_API_KEY"),
            base_url=os.environ.get("OPENAI_API_BASE"),
        )
        model = os.environ.get("LLM_MAIN", "deepseek-v4-pro")
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=2000,
            temperature=0.3,
        )
        trend_content = resp.choices[0].message.content.strip()
        return f"## 综合趋势分析\n\n{trend_content}\n"
    except Exception as e:
        print(f"      [C+] 趋势生成失败: {e}")
        return ""






def phase_curation(og, version: str):




    from og.agents.structure_agent import StructureAgent
    from og.agents.table_agent import TableAgent
    from og.agents.paragraph_rewrite_agent import ParagraphRewriteAgent

    cfg = CURATION_CONFIG
    print_header(f"Phase Curation [{TOPIC_TITLE}] @ {version}")

    cluster_inter = INTER
    out_curated = OUTPUT_DIR / f"output_report_{version}_curated.md"
    out_rewritten = OUTPUT_DIR / f"output_report_{version}_rewritten.md"



    structure = StructureAgent(
        merge_cache=cluster_inter / "section_merge_cache",
        reparent_cache=cluster_inter / "node_reparent_cache",
    )
    print_step("[A0] StructureAgent.merge_sections — LLM 合并同主体章节")
    structure.merge_sections(og, version=f"{version}-merged")

    print_step("[A1] StructureAgent.reparent_nodes — 杂物章节内容节点归位")
    structure.reparent_nodes(og, version=f"{version}-reparent")

    print_step("[A] StructureAgent.renumber — 章节去前缀 + 重新编号")
    structure.renumber(og)


    tables = TableAgent(
        naming_cache=cluster_inter / "table_naming_cache",
        topic=getattr(og, "topic", None) or TOPIC_TITLE,
    )
    print_step("[B] TableAgent.curate — 表格主题聚类 + 附录化")
    tables.curate(og, version=f"{version}-curated")

    print_step("[B'] TableAgent.name_all — LLM 重写 caption + 自由 topic_label")
    tables.name_all(og, version=f"{version}-named")


    print_step(f"[C] RenderAgent — 渲染 {out_curated.name}")
    md = RenderAgent().render_full_report(og)


    if cfg.get("run_trend_synthesis", True):
        print_step("[C+] TrendSynthesisAgent — LLM 生成宏观趋势综合章节")
        trend_md = _generate_trend_section(og, getattr(og, "topic", None) or TOPIC_TITLE)
        if trend_md:
            md = md + "\n\n" + trend_md

    save_text(md, out_curated)


    from og.storage.graph_store import GraphStore
    GraphStore(OG_STORE).save(og)


    if not cfg.get("run_rewrite"):
        return md

    print_step("[D] ParagraphRewriteAgent — LLM 段落润色")
    unchanged: set[str] = set()
    since = cfg.get("rewrite_only_changed_since_version")
    if since:

        all_titles: set[str] = set()
        changed: set[str] = set()
        for sec in og.get_all_nodes(NodeType.SECTION, NodeStatus.ACTIVE):
            if sec.title in ("报告根节点",):
                continue
            all_titles.add(sec.title)
            for child in og.get_children(sec.id):
                if child.status != NodeStatus.ACTIVE:
                    continue
                if child.type == NodeType.REFERENCE:
                    continue
                if child.last_updated_version and child.last_updated_version >= since:
                    changed.add(sec.title)
                    break
        unchanged = all_titles - changed
        print(f"      [rewrite-since {since}] "
              f"changed={len(changed)} chapters, passthrough={len(unchanged)}")

    rewriter = ParagraphRewriteAgent(
        cache_dir=cluster_inter / "rewrite_cache",
        parallel=cfg.get("rewrite_parallel", 4),
        topic=getattr(og, "topic", None) or TOPIC_TITLE,
        unchanged_titles=unchanged,
    )
    new_md, rep = rewriter.rewrite_markdown(md)
    save_text(new_md, out_rewritten)
    print(f"    rewrite report: {rep['n_rewritten']} 重写, "
          f"{rep['n_cached']} 缓存命中, {rep['n_passthrough']} 跳过, "
          f"{rep['n_failed']} 失败")
    return new_md






def run_topic_pipeline():
    try:
        start = time.time()
        versions_iter = list(UPDATE_CONFIGS.keys())
        print_header(f"OG Framework 全链路 [{TOPIC_TITLE}] "
                     f"({BASE_YEAR_INITIAL} + {len(versions_iter)} updates)")
        print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        gs = GraphStore(OG_STORE)
        vs = VectorStore(VECTOR_COLLECTION)
        ys = YAMLStore(OG_STORE)
        id_map_path = OG_STORE / f"id_map_{BASE_VERSION_INITIAL}.json"
        if id_map_path.exists():
            id_map = json.loads(id_map_path.read_text(encoding="utf-8"))
        else:
            id_map = {}

        if RESUME_FROM_VERSION:


            print(f"  [resume] 从已保存 OG {RESUME_FROM_VERSION} 继续, 跳过之前版本重放")
            og = gs.load(TOPIC_ID, RESUME_FROM_VERSION)
            og.topic = TOPIC_TITLE
            last_version = RESUME_FROM_VERSION
            base_year = BASE_YEAR_INITIAL
            for cfg in UPDATE_CONFIGS.values():
                if cfg["new_version"] == RESUME_FROM_VERSION:
                    base_year = cfg["new_year"]
                    break
            version_stats = [{
                "version": RESUME_FROM_VERSION,
                "base_year": base_year,
                "stats": og.stats(),
            }]
        else:
            og, gs, vs, ys, id_map = phase1_build_from_references()
            version_stats = [{"version": BASE_VERSION_INITIAL, "base_year": BASE_YEAR_INITIAL,
                              "stats": og.stats()}]
            last_version = BASE_VERSION_INITIAL

        for year_key in versions_iter:
            config = UPDATE_CONFIGS[year_key]

            def _ver_num(v):
                try: return float(str(v).lstrip("v"))
                except: return 0.0
            if RESUME_FROM_VERSION and _ver_num(config["new_version"]) <= _ver_num(RESUME_FROM_VERSION):
                print(f"  [resume_from={RESUME_FROM_VERSION}] 跳过 {config['new_version']}")
                continue
            if MAX_VERSION and _ver_num(config["new_version"]) > _ver_num(MAX_VERSION):
                print(f"  [max_version={MAX_VERSION}] 跳过 {config['new_version']} 及之后")
                break
            og = phase_update(og, gs, vs, ys, id_map, config)
            last_version = config["new_version"]
            version_stats.append({
                "version": last_version,
                "base_year": config["new_year"],
                "stats": og.stats(),
            })

        if CURATION_CONFIG.get("run_curation"):
            try:
                phase_curation(og, last_version)
            except Exception as e:
                print(f"  [warn] curation 阶段失败: {type(e).__name__}: {e}")

        elapsed = time.time() - start
        print_header(f"全链路完成 [{TOPIC_TITLE}]")
        print(f"  耗时: {elapsed:.1f}秒")
        print(f"\n  版本演进:")
        for vs_entry in version_stats:
            s = vs_entry["stats"]
            print(f"    {vs_entry['version']} ({vs_entry['base_year']}年): "
                  f"{s['total_nodes']}节点 / {s['total_edges']}边 / "
                  f"{s['node_types'].get('Reference', 0)}篇参考文献")

        print(f"\n  向量DB: {vs.total_chunks()} chunks")
        print(f"\n  输出报告:")
        for f in sorted(OUTPUT_DIR.glob("output_report_v*.md")):
            print(f"    - {f.name}")
        print(f"\n  OG图谱:")
        for f in sorted(OG_STORE.glob(f"og_{TOPIC_ID}_*.json")):
            print(f"    - {f.name}")
        print(f"\n  中间文件目录:")
        if INTER.exists():
            for d in sorted(INTER.iterdir()):
                if d.is_dir():
                    count = len(list(d.glob("*.json")))
                    print(f"    - {d.name}: {count}个JSON")
        return version_stats
    except Exception as e:
        print(f"\n  ⚠ [ERROR] run_topic_pipeline 失败: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        raise SystemExit(1)


if __name__ == "__main__":
    run_topic_pipeline()
