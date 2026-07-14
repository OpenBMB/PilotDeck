from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parent.parent.parent)))
from og.pipeline import simulation as sim
from og.config.paths import paths as _paths


CLUSTERS_DIR = ROOT / "data" / "clusters"
QA_FILE = ROOT / "data" / "freshqa" / "questions.json"


FALLBACK_YEAR_AXIS = [2020, 2022, 2024, 2026, 2026]




def _topic_for(cluster_id: str) -> str:
    if not QA_FILE.exists():
        return ""
    data = json.loads(QA_FILE.read_text(encoding="utf-8"))
    candidates = [cluster_id]

    cur = cluster_id
    while True:
        m = re.match(r"^(.+)-[^-]+$", cur)
        if not m:
            break
        cur = m.group(1)
        candidates.append(cur)
    for cand in candidates:
        for c in data.get("clusters", []):
            if c.get("id") == cand:
                return c.get("prompt", "")
    return ""


def _collect_ref_meta(agent_dir: Path) -> dict[int, dict]:
    meta: dict[int, dict] = {}
    build_path = agent_dir / "build_v1.json"
    if build_path.exists():
        try:
            build = json.loads(build_path.read_text(encoding="utf-8"))
            for nd in build.get("nodes", []):
                if nd.get("type") == "Reference" and nd.get("ref_number") is not None:
                    meta[int(nd["ref_number"])] = {
                        "title": nd.get("title", ""),
                        "author": nd.get("author", ""),
                        "url": nd.get("url", ""),
                        "publish_date": nd.get("publish_date", ""),
                        "data_year": nd.get("data_year", ""),
                        "tier": nd.get("tier", "T2"),
                    }
        except (json.JSONDecodeError, OSError) as e:
            print(f"  [warn] skip build_v1.json: {e}")


    for upd_file in sorted(agent_dir.glob("update_v*.json")):
        p = upd_file
        if not p.exists():
            continue
        try:
            upd = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"  [warn] skip {upd_file}: {e}")
            continue
        for ref in upd.get("new_references", []):
            try:
                n = int(ref["ref_number"])
            except (KeyError, TypeError, ValueError):
                continue
            meta[n] = {
                "title": ref.get("title", ""),
                "author": ref.get("author", ""),
                "url": ref.get("url", ""),
                "publish_date": ref.get("publish_date", ""),
                "data_year": ref.get("data_year", ""),
                "tier": ref.get("tier", "T2"),
            }
    return meta


def _ref_range_from_dir(period_dir: Path) -> tuple[int, int]:
    if not period_dir.exists():
        return (0, 0)
    count = sum(1 for p in period_dir.iterdir() if p.is_file() and p.suffix == ".txt")
    if count == 0:
        return (0, 0)
    return (1, count + 1)


def _infer_year_axis(agent_dir: Path) -> list[int]:
    years_per_period: list[set[int]] = [set() for _ in range(5)]
    for idx, fname in enumerate(["build_v1.json", "update_v2.json",
                                  "update_v3.json", "update_v4.json",
                                  "update_v5.json"]):
        p = agent_dir / fname
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        for nd in data.get("nodes", []) + data.get("new_references", []):
            y = nd.get("data_year") or nd.get("publish_date", "")[:4]
            try:
                yi = int(str(y).strip()[:4])
                if 1900 < yi < 2100:
                    years_per_period[idx].add(yi)
            except (ValueError, AttributeError):
                continue
    axis = []
    last = FALLBACK_YEAR_AXIS[0]
    for i, ys in enumerate(years_per_period):
        if ys:
            last = max(ys)
        else:
            last = FALLBACK_YEAR_AXIS[i] if i < len(FALLBACK_YEAR_AXIS) else last
        axis.append(last)
    return axis


def _version_key(version: str) -> tuple[int, int]:
    m = re.match(r"^v(\d+)(?:\.(\d+))?$", version or "")
    if not m:
        return (0, 0)
    return (int(m.group(1)), int(m.group(2) or 0))


def _latest_saved_version(og_store: Path, cluster: str) -> str | None:
    versions = []
    for p in og_store.glob(f"og_{cluster}_v*.json"):

        m = re.match(rf"^og_{re.escape(cluster)}_(v\d+(?:\.\d+)?)(?:_curated)?\.json$", p.name)
        if m:
            versions.append(m.group(1))
    if not versions:
        return None
    return max(versions, key=_version_key)




def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cluster", required=True,
                    help="cluster id, e.g. DR-27-v2 (data 在 data/clusters/<id>/)")
    ap.add_argument("--max-version", default=None,
                    help="跑到该版本后停; 字符串字典序比较 (默认跑全 v1→v5)")
    ap.add_argument("--resume-from-version", default=None,
                    help="从已保存的 OG 版本继续, 例如 v2.0 表示加载 og_*_v2.0.json 并从 v3 开始")
    ap.add_argument("--no-auto-resume", action="store_true",
                    help="关闭默认自动续跑; 未显式 --resume-from-version 时强制从 v1 重放")
    ap.add_argument("--year-axis", default=None,
                    help="覆盖自动推断的年份轴, 逗号分隔, 例: 2018,2020,2022,2024,2026")
    ap.add_argument("--curation", action="store_true",
                    help="末尾跑 curation chain (Section/Table/Reparent)")
    ap.add_argument("--rewrite", action="store_true",
                    help="curation 后再跑 ParagraphRewriteAgent (隐含 --curation)")
    ap.add_argument("--clean", action="store_true",
                    help="清空 og_store / intermediates / output 后从头跑")
    ap.add_argument("--force-regen-lit", action="store_true",
                    help="用 LLM_MAIN 重新跑 LiteratureAnalysisAgent 重生 "
                         "build_v1.json + update_v{2..5}.json (即使已存在). "
                         "搭配新模型 (如 deepseek-v4-pro) 时使用, 让全链产物源自新模型.")
    ap.add_argument("--auto-extract", action="store_true",
                    help="不存在 build_v1.json / update_v{2..5}.json 时自动 "
                         "调 LiteratureAnalysisAgent 生成. 默认行为是失败报错.")
    args = ap.parse_args(argv)

    cluster = args.cluster

    cluster_dir_v2 = ROOT / "data" / "clusters2" / cluster
    cluster_dir_v1 = CLUSTERS_DIR / cluster
    if cluster_dir_v2.exists():
        cluster_dir = cluster_dir_v2
    elif cluster_dir_v1.exists():
        cluster_dir = cluster_dir_v1
    else:
        print(f"\n[error] cluster dir not found in clusters/ or clusters2/: {cluster}",
              file=sys.stderr)
        print(f"  期望布局: data/clusters{{,2}}/{cluster}/reference_texts_v{{N}}/ + agent_outputs/",
              file=sys.stderr)
        return 2

    agent_dir = _paths.cluster_agent_outputs(cluster)
    output_dir = _paths.cluster_output(cluster)
    og_store = _paths.intermediates_og(cluster)
    inter = _paths.intermediates_subdir("run_cluster", cluster)

    vector_collection = f"og_{cluster.lower().replace('-', '_')}"

    if args.clean:
        for d in (output_dir, og_store, inter):
            if d.exists():
                shutil.rmtree(d)
                print(f"  [clean] rm -rf {d.relative_to(ROOT)}")
        try:
            from og.storage.vector_store import VectorStore
            vs_clean = VectorStore(vector_collection)
            vs_clean.reset()
            print(f"  [clean] reset vector collection {vector_collection}")
        except Exception as e:
            print(f"  [warn] reset vector collection failed: {type(e).__name__}: {e}")
    for d in (output_dir, og_store, inter):
        d.mkdir(parents=True, exist_ok=True)

    print(f"  pid      = {os.getpid()}", flush=True)
    print(f"  cluster  = {cluster}", flush=True)

    topic = _topic_for(cluster) or "本调研课题"


    cluster_cfg_path = cluster_dir / "cluster_config.json"
    cluster_cfg: dict = {}
    if cluster_cfg_path.exists():
        try:
            cluster_cfg = json.loads(cluster_cfg_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  [warn] cluster_config.json 解析失败: {e}; 走 fallback")
            cluster_cfg = {}

    if args.year_axis:
        yr = [int(x.strip()) for x in args.year_axis.split(",")]
        if len(yr) < 1:
            print("[error] --year-axis 需要至少 1 个值", file=sys.stderr)
            return 2
        period_year_ranges = None
        task_year_range = None
    elif cluster_cfg.get("period_year_ranges"):
        prs = cluster_cfg["period_year_ranges"]


        present_periods = sorted(
            [k for k in prs.keys() if k.startswith("v") and k[1:].isdigit()],
            key=lambda k: int(k[1:])
        )
        if not present_periods:
            print("[error] cluster_config.json period_year_ranges 为空或键名不符 v<N>",
                  file=sys.stderr)
            return 2
        period_year_ranges = {k: tuple(prs[k]) for k in present_periods}
        yr = [period_year_ranges[k][1] for k in present_periods]
        last_period = present_periods[-1]
        task_year_range = tuple(cluster_cfg.get("task_year_range",
                                                  [period_year_ranges["v1"][0],
                                                   period_year_ranges[last_period][1]]))
    else:
        yr = _infer_year_axis(agent_dir)
        period_year_ranges = None
        task_year_range = None

    print(f"  topic    = {topic}")
    if period_year_ranges:
        print(f"  cluster_config: 显式 period_year_ranges =")
        for k, (lo, hi) in period_year_ranges.items():
            print(f"     {k}: [{lo}, {hi}]")
        print(f"  task_year_range = {task_year_range}")
    else:
        print(f"  year_axis= {yr}  (无 cluster_config; 用 _infer_year_axis 推)")


    ref_meta_map = _collect_ref_meta(agent_dir)
    print(f"  ref_meta = {len(ref_meta_map)} entries "
          f"({min(ref_meta_map) if ref_meta_map else '-'}.."
          f"{max(ref_meta_map) if ref_meta_map else '-'})")


    all_ref_ranges = {}

    ref_dirs = sorted(
        cluster_dir.glob("reference_texts_v*"),
        key=lambda p: int(p.name.replace("reference_texts_v", ""))
    )
    for ref_dir_path in ref_dirs:
        v_key = ref_dir_path.name.replace("reference_texts_", "")
        lo, hi = _ref_range_from_dir(ref_dir_path)
        all_ref_ranges[v_key] = (lo, hi)

    for v_num in range(1, 6):
        v_key = f"v{v_num}"
        if v_key not in all_ref_ranges:
            all_ref_ranges[v_key] = (0, 0)


    v1_lo, v1_hi = all_ref_ranges["v1"]
    v2_lo, v2_hi = all_ref_ranges["v2"]
    v3_lo, v3_hi = all_ref_ranges["v3"]
    v4_lo, v4_hi = all_ref_ranges["v4"]
    v5_lo, v5_hi = all_ref_ranges["v5"]
    for label, lo, hi in [("v1", v1_lo, v1_hi), ("v2", v2_lo, v2_hi),
                           ("v3", v3_lo, v3_hi), ("v4", v4_lo, v4_hi),
                           ("v5", v5_lo, v5_hi)]:
        print(f"    {label} refs = ({lo}, {hi})  ({hi - lo if hi > lo else 0} 篇)")

    if v1_hi == 0:
        print(f"\n[error] reference_texts_v1/ 为空或缺失. 请先准备数据.",
              file=sys.stderr)
        return 2


    def _period(k: str, fallback_lo: int, fallback_hi: int) -> tuple[int, int]:
        if period_year_ranges and k in period_year_ranges:
            return period_year_ranges[k]
        return (fallback_lo, fallback_hi)




    update_configs = {}
    cumulative_offset = v1_hi - 1

    max_period_num = 7
    if period_year_ranges:
        max_period_num = max(int(k[1:]) for k in period_year_ranges.keys())
    for i in range(2, max_period_num + 1):
        v_key = f"v{i}"
        prev_key = f"v{i-1}"


        lo, hi = all_ref_ranges.get(v_key, (0, 0))
        if lo == 0 and hi == 0:
            continue


        fallback_lo = yr[i-1] if len(yr) > i-1 else yr[-1]
        fallback_hi = yr[i] if len(yr) > i else yr[-1]
        pv = _period(v_key, fallback_lo, fallback_hi)
        
        update_configs[v_key] = {
            "old_year": pv[0],
            "new_year": pv[1],
            "period_year_range": list(pv),
            "old_version": f"{prev_key[1:]}.0",
            "new_version": f"{v_key[1:]}.0",
            "delta_file": f"update_{v_key}.json",
            "ref_dir": str(cluster_dir / f"reference_texts_{v_key}"),
            "ref_range": (lo, hi),
            "ref_number_offset": cumulative_offset,
            "phase_name": f"phase{i}_{v_key}",
        }

        cumulative_offset += (hi - lo)
    
    print(f"  检测到 {len(update_configs)} 个 update 期: {list(update_configs.keys())}")

    curation_config = {}
    if args.curation or args.rewrite:
        curation_config = {
            "run_curation": True,
            "run_rewrite": args.rewrite,
            "rewrite_parallel": 4,
        }

    v1_period = (period_year_ranges["v1"] if period_year_ranges
                  else (yr[0], yr[0]))

    config = {
        "topic_id": cluster,
        "topic_title": topic,
        "base_year_initial": yr[0],
        "base_version_initial": "v1.0",
        "initial_ref_range": (v1_lo, v1_hi),
        "v1_period_year_range": list(v1_period),
        "task_year_range": list(task_year_range) if task_year_range else None,
        "ref_dir": str(cluster_dir / "reference_texts_v1"),
        "agent_dir": str(agent_dir),
        "initial_build_file": "build_v1.json",
        "raw_report_path": str(cluster_dir / "_no_raw_report.md"),
        "og_store": str(og_store),
        "inter": str(inter),
        "output_dir": str(output_dir),
        "vector_collection": f"og_{cluster.lower().replace('-', '_')}",
        "ref_meta_map": ref_meta_map,
        "update_configs": update_configs,
        "curation_config": curation_config,
    }
    if args.max_version:
        config["max_version"] = args.max_version

    resume_version = args.resume_from_version
    if not resume_version and not args.no_auto_resume and not args.clean:
        latest = _latest_saved_version(og_store, cluster)


        if latest:
            resume_version = latest
            print(f"  [auto-resume] 检测到已保存 OG {latest}, 将从该版本继续增量更新; "
                  "如需从头重放请加 --no-auto-resume 或 --clean")
    if resume_version:
        config["resume_from_version"] = resume_version





    agent_dir = cluster_dir / "agent_outputs"
    build_v1_path = agent_dir / "build_v1.json"
    need_auto_extract = args.auto_extract
    if not args.force_regen_lit:
        missing_lit = []
        if not build_v1_path.exists():
            missing_lit.append("build_v1.json")

        for n in range(2, 6):
            full = agent_dir / f"update_v{n}.json"
            partial = agent_dir / f"update_v{n}.partial.json"

            if not full.exists():
                if partial.exists():
                    missing_lit.append(f"update_v{n}.json (有 partial, 需续跑)")
                else:
                    missing_lit.append(f"update_v{n}.json")
        if missing_lit and not need_auto_extract:
            need_auto_extract = True
            print(f"  [auto-extract] 缺 lit agent 产物, 自动启用 LiteratureAnalysisAgent: "
                  f"{', '.join(missing_lit)}")
    if args.force_regen_lit or need_auto_extract:
        config["literature_analysis_config"] = {
            **sim.LITERATURE_ANALYSIS_CONFIG,
            "enabled": True,
            "force_regenerate": args.force_regen_lit,
        }
        print(f"  literature_analysis enabled "
              f"(force_regenerate={args.force_regen_lit}, "
              f"model={config['literature_analysis_config']['model']})")
    sim.configure(config)





    print(f"\n  [run_cluster] starting pipeline for {cluster} "
          f"(max_version={args.max_version or 'v5.0'})", flush=True)
    sim.run_topic_pipeline()

    print(f"\n=== 完成. 输出位于 {output_dir.relative_to(ROOT)} ===")
    for f in sorted(output_dir.glob("output_report_v*.md")):
        print(f"  - {f.name} ({f.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
