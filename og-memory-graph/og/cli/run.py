from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from og.cli._common import ScriptContext, setup_logging


ALL_CLUSTERS = [
    "DR-26", "DR-27", "DR-28", "DR-29", "DR-30",
    "DR-31", "DR-38", "DR-40", "DR-43", "DR-49",
    "DR-62", "DR-70", "DR-72",
]





def add_run_a_args(p: argparse.ArgumentParser) -> None:
    _add_common_run_args(p)

    p.add_argument("--max-version", default=None,
                   help="最大版本, e.g. v2.0 (默认一路跑到集群最大版)")
    p.add_argument("--resume-from-version", default=None,
                   help="从指定版本恢复, 跳过更早版本")
    p.add_argument("--no-auto-resume", action="store_true",
                   help="禁用自动 resume (默认跳过已完成中间产物)")
    p.add_argument("--year-axis", default=None,
                   help="显式年份轴, 逗号分隔, e.g. 2018,2020,2022,2024,2026")
    p.add_argument("--curation", action="store_true",
                   help="跑 curate (节点命名/表格/节合并)")
    p.add_argument("--rewrite", action="store_true",
                   help="跑散文化重写 (rewritten)")
    p.add_argument("--balanced", action="store_true",
                   help="跑 balanced 重写 (含「综合趋势分析」)")
    p.add_argument("--polish", action="store_true",
                   help="跑 polish 整篇重写 (去重+可读性+跑题过滤+洞察补强)")
    p.add_argument("--skip-build", action="store_true",
                   help="跳过 Step 1 (build+update), 只跑后续步骤")
    p.add_argument("--one-shot", action="store_true",
                   help="polish 走整篇一次性重写 (默认按章节分批)")
    p.add_argument("--keep-offtopic", action="store_true",
                   help="polish 跳过跑题过滤")
    p.add_argument("--no-insight", action="store_true",
                   help="polish 跳过洞察/分析段落补强")
    p.add_argument("--clean", action="store_true",
                   help="清空 intermediates 后重新跑")
    p.add_argument("--force-regen-lit", action="store_true",
                   help="强制重跑 LiteratureAnalysisAgent")
    p.add_argument("--auto-extract", action="store_true",
                   help="自动抽取 ref (跳过已存在的)")
    p.set_defaults(func=_run_a)


def _add_common_run_args(p: argparse.ArgumentParser) -> None:
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--cluster", help="集群 ID, e.g. DR-28")
    g.add_argument("--all", dest="run_all", action="store_true",
                   help=f"对所有 {len(ALL_CLUSTERS)} 个集群跑")
    p.add_argument("--model", dest="llm_main", default=None,
                   help="主模型 (覆盖 LLM_MAIN env), e.g. deepseek, doubao")
    p.add_argument("--llm-main", default=None, help=argparse.SUPPRESS)
    p.add_argument("--llm-util", default=None,
                   help="辅助模型 (覆盖 LLM_UTIL env)")
    p.add_argument("--llm-judge", default=None,
                   help="裁判模型 (覆盖 LLM_JUDGE env)")
    p.add_argument("--root", default=None,
                   help="v6 根目录 (默认自动检测)")
    p.add_argument("--log-level", default="INFO",
                   choices=["DEBUG", "INFO", "WARNING", "ERROR"])




def dispatch_run(args: argparse.Namespace) -> int:
    return args.func(args)




def _run_a(args: argparse.Namespace) -> int:
    from og.cli._common import ScriptContext, apply_paths_env, make_paths
    paths = make_paths(args.root)
    apply_paths_env(paths)
    logger = setup_logging(paths.root / "logs", args.log_level, "run_a")


    llm = args.llm_main or args.model if hasattr(args, "model") else args.llm_main
    if llm:
        os.environ["LLM_MAIN"] = llm
    if args.llm_util:
        os.environ["LLM_UTIL"] = args.llm_util
    if args.llm_judge:
        os.environ["LLM_JUDGE"] = args.llm_judge

    clusters = ALL_CLUSTERS if getattr(args, "run_all", False) else [args.cluster]

    for cluster in clusters:
        logger.info(f"\n{'='*60}\n[A] 集群: {cluster}\n{'='*60}")
        rc = _run_a_single(args, paths, logger, cluster)
        if rc != 0:
            logger.error(f"[A] {cluster} 失败, rc={rc}")
            if not getattr(args, "run_all", False):
                return rc
    return 0


def _run_a_single(args, paths, logger, cluster: str) -> int:
    cluster_dir = paths.cluster_dir(cluster)
    if not cluster_dir.exists():
        logger.error(f"缺少 cluster 目录 {cluster_dir}")
        return 1
    if not (cluster_dir / "reference_texts_v1").exists():
        logger.error(f"缺少 {cluster_dir}/reference_texts_v1/")
        return 1

    env = os.environ.copy()


    if not getattr(args, "skip_build", False):
        cmd = [sys.executable, "-m", "og.pipeline.run_cluster",
               "--cluster", cluster]
        if getattr(args, "max_version", None):
            cmd += ["--max-version", args.max_version]
        if getattr(args, "resume_from_version", None):
            cmd += ["--resume-from-version", args.resume_from_version]
        if getattr(args, "no_auto_resume", False):
            cmd += ["--no-auto-resume"]
        if getattr(args, "year_axis", None):
            cmd += ["--year-axis", args.year_axis]
        if getattr(args, "clean", False):
            cmd += ["--clean"]
        if getattr(args, "force_regen_lit", False):
            cmd += ["--force-regen-lit"]
        if getattr(args, "auto_extract", False):
            cmd += ["--auto-extract"]
        logger.info(f"[A] Step 1 build+update: {' '.join(cmd)}")
        rc = subprocess.call(cmd, env=env, cwd=str(paths.root))
        if rc != 0:
            logger.error(f"[A] Step 1 失败 rc={rc}")
            return rc
    else:
        logger.info("[A] Step 1: 跳过 (--skip-build)")


    if getattr(args, "curation", False) or getattr(args, "rewrite", False):
        cmd2 = [sys.executable, "-m", "og.pipeline.curate", "--cluster", cluster]
        logger.info(f"[A] Step 2 curate: {' '.join(cmd2)}")
        rc = subprocess.call(cmd2, env=env, cwd=str(paths.root))
        if rc != 0:
            logger.error(f"[A] Step 2 失败 rc={rc}")
            return rc


    if getattr(args, "balanced", False):
        cmd3 = [sys.executable, "-m", "og.pipeline.balanced", "--cluster", cluster]
        if os.environ.get("LLM_MAIN"):
            cmd3 += ["--llm-main", os.environ["LLM_MAIN"]]
        if os.environ.get("LLM_UTIL"):
            cmd3 += ["--llm-util", os.environ["LLM_UTIL"]]
        logger.info(f"[A] Step 3 balanced: {' '.join(cmd3)}")
        rc = subprocess.call(cmd3, env=env, cwd=str(paths.root))
        if rc != 0:
            logger.error(f"[A] Step 3 失败 rc={rc}")
            return rc


    if getattr(args, "polish", False):
        cmd4 = [sys.executable, "-m", "og.pipeline.polish", "--cluster", cluster]
        if os.environ.get("LLM_MAIN"):
            cmd4 += ["--llm-main", os.environ["LLM_MAIN"]]
        if os.environ.get("LLM_UTIL"):
            cmd4 += ["--llm-util", os.environ["LLM_UTIL"]]
        if getattr(args, "one_shot", False):
            cmd4 += ["--one-shot"]
        if getattr(args, "keep_offtopic", False):
            cmd4 += ["--keep-offtopic"]
        if getattr(args, "no_insight", False):
            cmd4 += ["--no-insight"]
        logger.info(f"[A] Step 4 polish: {' '.join(cmd4)}")
        rc = subprocess.call(cmd4, env=env, cwd=str(paths.root))
        if rc != 0:
            logger.error(f"[A] Step 4 失败 rc={rc}")
            return rc


    out_dir = paths.cluster_output(cluster)
    for cand in ("v5.0", "v4.0", "v3.0", "v2.0"):
        if (out_dir / f"output_report_{cand}.md").exists():
            ver = cand
            break
    else:
        ver = "vN.0"
    for label, fname in [
        ("raw", f"output_report_{ver}.md"),
        ("curated", f"output_report_{ver}_curated.md"),
        ("rewritten", f"output_report_{ver}_rewritten.md"),
        ("balanced", f"output_report_{ver}_balanced.md"),
        ("polished", f"output_report_{ver}_polished.md"),
    ]:
        p = out_dir / fname
        status = f"✓ {p.stat().st_size:,}B" if p.exists() else "–"
        logger.info(f"    {label:10s} {status}  {fname}")

    logger.info(f"[A] {cluster} 完成")
    return 0
