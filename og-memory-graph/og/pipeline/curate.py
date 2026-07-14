from __future__ import annotations
import os

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

from og.agents.render_agent import RenderAgent
from og.core.node import NodeStatus, NodeType
from og.core.graph import OutlineGraph
from og.storage.graph_store import GraphStore


ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parent.parent.parent)))
DATA_DIR = ROOT / "data"

_QA_CANDS = [
    DATA_DIR / "freshqa" / "questions.json",
    DATA_DIR / "freshqa_clustered_selected14_strict.json",
]
QA_FILE = next((p for p in _QA_CANDS if p.exists()), _QA_CANDS[-1])
from og.config.paths import paths as _paths
INTER_DIR = _paths.data.intermediates
OG_DIR = INTER_DIR / "og"


def _auto_detect_version(cluster: str) -> str:
    cluster_og_dir = OG_DIR / cluster
    for v in ["v9.0", "v8.0", "v7.0", "v6.0", "v5.0", "v4.0", "v3.0", "v2.0", "v1.0"]:

        for fname in (f"og_{cluster}_{v}.json", f"og_{cluster}_{v.lstrip('vV')}.json"):
            if (cluster_og_dir / fname).exists():
                return v

    return "v5.0"


def resolve_topic(cluster_id: str) -> str:
    if not QA_FILE.exists():
        return ""
    base_id = cluster_id
    for suffix in ("-v2-balanced", "-v2-prose", "-v2-rewritten", "-v2-curated",
                   "-balanced", "-prose", "-curated", "-rewritten", "-v2"):
        if base_id.endswith(suffix):
            base_id = base_id[: -len(suffix)]
            break
    try:
        data = json.loads(QA_FILE.read_text(encoding="utf-8"))
        for c in data.get("clusters", []):
            if c.get("id") == base_id:
                return c.get("prompt", "") or ""
    except Exception:
        pass
    return ""


def _passthrough_titles(og: OutlineGraph, since: str) -> set[str]:
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
    return all_titles - changed


class CuratePipeline:

    def __init__(self, cluster: str, version: str = "v5.0",
                 topic: Optional[str] = None, parallel: int = 4):
        self.cluster = cluster
        self.version = version
        self.topic = topic if topic is not None else resolve_topic(cluster)
        self.parallel = parallel

        self.og_dir = INTER_DIR / "og" / cluster
        self.cache_root = INTER_DIR / "curation_v1" / cluster
        self.output_dir = _paths.cluster_output(cluster)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.cache_root.mkdir(parents=True, exist_ok=True)

        self.gs = GraphStore(self.og_dir)

    def _load_og(self) -> OutlineGraph:
        og = self.gs.load(self.cluster, self.version)
        og.topic = self.topic or "本调研课题"
        return og

    def run(self, run_rewrite: bool = True,
            rewrite_since: Optional[str] = None) -> dict:

        from og.agents.structure_agent import StructureAgent
        from og.agents.table_agent import TableAgent
        from og.agents.paragraph_rewrite_agent import ParagraphRewriteAgent

        print(f"\n{'=' * 70}")
        print(f"[CuratePipeline] cluster={self.cluster} version={self.version}")
        print(f"  topic = {self.topic or '(未解析到, 回落本调研课题)'}")
        print(f"{'=' * 70}")

        og = self._load_og()
        print(f"  OG loaded: {og.stats()}")


        structure = StructureAgent(
            merge_cache=self.cache_root / "section_merge_cache",
            reparent_cache=self.cache_root / "node_reparent_cache",
        )
        print("\n[A0] StructureAgent.merge_sections — LLM 合并同主体章节")


        import re as _re
        _ver_num = _re.match(r"v?(\d+)(?:\.\d+)?$", str(self.version))
        is_initial_build = bool(_ver_num) and _ver_num.group(1) == "1"
        if is_initial_build:
            MAX_MERGE_ROUNDS = 5
            for round_idx in range(1, MAX_MERGE_ROUNDS + 1):
                report = structure.merge_sections(og, version=f"{self.version}-merged-r{round_idx}")
                n_merged = report.get("n_merge_groups", 0)
                print(f"  [多轮合并 round {round_idx}] 合并 {n_merged} 组，剩余 {report.get('n_sections_after',0)} Section")
                if n_merged == 0:
                    print(f"  [多轮合并] round {round_idx} 无合并，收敛完成")
                    break
            else:
                print(f"  [多轮合并] 达到阈值 {MAX_MERGE_ROUNDS} 轮，停止")
        else:
            structure.merge_sections(og, version=f"{self.version}-merged")
        print("\n[A1] StructureAgent.reparent_nodes — 杂物章节内容节点归位")
        structure.reparent_nodes(og, version=f"{self.version}-reparent")
        print("\n[A] StructureAgent.renumber — 章节去前缀 + 重排")
        structure.renumber(og)


        tables = TableAgent(
            naming_cache=self.cache_root / "table_naming_cache",
            topic=self.topic or "本调研课题",
        )
        print("\n[B] TableAgent.curate — 表格主题聚类 + 附录化")
        tables.curate(og, version=f"{self.version}-curated")
        print("\n[B'] TableAgent.name_all — LLM 重写 caption + 自由 topic_label")
        tables.name_all(og, version=f"{self.version}-named")


        out_curated = self.output_dir / f"output_report_{self.version}_curated.md"
        out_rewritten = self.output_dir / f"output_report_{self.version}_rewritten.md"
        print(f"\n[C] RenderAgent — 渲染 {out_curated.name}")
        md_curated = RenderAgent().render_full_report(og)
        out_curated.write_text(md_curated, encoding="utf-8")


        self.gs.save_curated(og)

        report = {
            "cluster": self.cluster,
            "version": self.version,
            "topic": self.topic,
            "curated_md": str(out_curated.relative_to(ROOT)),
            "stats": og.stats(),
        }

        if not run_rewrite:
            print(f"\n[done] --no-rewrite, 跳过 D 阶段. curated md → {out_curated}")
            return report


        print("\n[D] ParagraphRewriteAgent — LLM 段落润色")
        unchanged: set[str] = set()
        if rewrite_since:
            unchanged = _passthrough_titles(og, rewrite_since)
            print(f"      [rewrite-since {rewrite_since}] passthrough "
                  f"{len(unchanged)} chapters")

        rewriter = ParagraphRewriteAgent(
            cache_dir=self.cache_root / "rewrite_cache",
            parallel=self.parallel,
            topic=self.topic or "本调研课题",
            unchanged_titles=unchanged,
        )
        new_md, rep = rewriter.rewrite_markdown(md_curated)
        out_rewritten.write_text(new_md, encoding="utf-8")
        print(f"    rewrite report: {rep['n_rewritten']} 重写, "
              f"{rep['n_cached']} 缓存, {rep['n_passthrough']} 跳过, "
              f"{rep['n_failed']} 失败")
        print(f"\n[done] rewritten md → {out_rewritten}")

        report.update({
            "rewritten_md": str(out_rewritten.relative_to(ROOT)),
            "rewrite_report": rep,
        })
        return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0],
                                  allow_abbrev=False)
    ap.add_argument("--cluster", required=True,
                    help="cluster id, e.g. DR-28")
    ap.add_argument("--version", default=None,
                    help="OG snapshot version (default: auto-detect latest)")
    ap.add_argument("--topic", default=None,
                    help="主题字符串 override; 默认从 freshqa GT 解析")
    ap.add_argument("--no-rewrite", action="store_true",
                    help="跳过 ParagraphRewriteAgent (D), 只产 _curated.md")
    ap.add_argument("--rewrite-since", default=None, metavar="VERSION",
                    help="仅重写自该版本起有节点变动的章节, 其余 passthrough v4.0")
    ap.add_argument("--parallel", type=int, default=4,
                    help="ParagraphRewriteAgent 并发度 (default=4)")
    args = ap.parse_args(argv)

    version = args.version or _auto_detect_version(args.cluster)
    pipeline = CuratePipeline(
        cluster=args.cluster, version=version,
        topic=args.topic, parallel=args.parallel,
    )
    try:
        pipeline.run(run_rewrite=not args.no_rewrite,
                     rewrite_since=args.rewrite_since)
    except FileNotFoundError as e:
        print(f"\n[error] {e}", file=sys.stderr)
        print("  提示: 确保已先跑过 build_pipeline + update_pipeline 产出 "
              f"intermediates/og/{args.cluster}/og_{args.cluster}_{version}.json",
              file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
