from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path


_ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parent.parent.parent)))

from og.config.paths import Paths, make_paths, resolve_root




def add_root_arg(ap: argparse.ArgumentParser) -> None:
    ap.add_argument(
        "--root",
        default=None,
        help="v5 仓库根目录; 默认走 env V5_ROOT 或本仓库位置",
    )


def add_cluster_arg(ap: argparse.ArgumentParser, required: bool = True) -> None:
    ap.add_argument(
        "--cluster", required=required,
        help="cluster id, e.g. DR-28 (数据在 <root>/data/clusters/<cluster>/)",
    )


def add_model_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--llm-main", default=None,
                    help="主模型 (build/update/curate/rewrite, 默认 LLM_MAIN env)")
    ap.add_argument("--llm-util", default=None,
                    help="辅助模型 (翻译/抽词, 默认 LLM_UTIL env)")
    ap.add_argument("--llm-judge", default=None,
                    help="裁判模型 (RACE 评测, 默认 LLM_JUDGE env)")


def add_log_args(ap: argparse.ArgumentParser) -> None:
    ap.add_argument("--log-dir", default=None,
                    help="日志目录 (默认 <root>/logs/)")
    ap.add_argument("--log-level", default="INFO",
                    choices=["DEBUG", "INFO", "WARNING", "ERROR"])




def setup_logging(log_dir: Path | None, level: str = "INFO",
                  script_name: str = "script") -> logging.Logger:
    if log_dir is None:
        log_dir = _ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    log_path = log_dir / f"{script_name}_{ts}.log"

    logger = logging.getLogger(script_name)
    logger.setLevel(getattr(logging, level))
    logger.handlers.clear()


    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(fh)

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(logging.Formatter("[%(levelname)s] %(message)s"))
    logger.addHandler(sh)

    logger.info(f"日志: {log_path}")
    return logger




def apply_paths_env(paths: Paths) -> None:
    os.environ["V5_ROOT"] = str(paths.root)
    os.environ["V5_CLUSTERS_DIR"] = str(paths.data.clusters)


    _fqa = paths.data.freshqa_questions
    if not _fqa.exists():
        _legacy = paths.data.root / "freshqa_clustered_selected14_strict.json"
        if _legacy.exists():
            _fqa = _legacy
    os.environ["V5_FRESHQA_INDEX"] = str(_fqa)
    os.environ["V5_FRESHQA_SCHEMA"] = str(paths.data.freshqa_schema)
    os.environ["V5_REF_ROOT"] = str(paths.data.references)
    os.environ["V5_GT_KEYWORDS"] = str(paths.data.gt_keywords)
    os.environ["V5_OUTPUT_DIR"] = str(paths.outputs)
    os.environ["V5_OUT_A_OG"] = str(paths.out_a_og)
    os.environ["V5_OUT_B_INC"] = str(paths.out_b_incremental)
    os.environ["V5_OUT_C_ONE"] = str(paths.out_c_oneshot)
    os.environ["V5_OUT_RACE"] = str(paths.out_race)
    os.environ["V5_OUT_OBJ"] = str(paths.out_obj)



    try:
        import og.config.models
    except Exception:
        pass




class ScriptContext:

    def __init__(self, script_name: str, argv: list[str] | None = None,
                 need_cluster: bool = True, need_log: bool = True,
                 need_model: bool = True):
        ap = argparse.ArgumentParser(prog=script_name,
                                     description=f"v5: {script_name}")
        add_root_arg(ap)
        if need_cluster:
            add_cluster_arg(ap)
        if need_model:
            add_model_args(ap)
        if need_log:
            add_log_args(ap)
        self.ap = ap
        self.script_name = script_name

    def parse(self, argv: list[str] | None = None):
        args = self.ap.parse_args(argv)
        paths = make_paths(args.root)
        apply_paths_env(paths)
        logger = setup_logging(
            Path(args.log_dir) if getattr(args, "log_dir", None) else None,
            getattr(args, "log_level", "INFO"),
            self.script_name,
        )

        if getattr(args, "llm_main", None):
            os.environ["LLM_MAIN"] = args.llm_main
        if getattr(args, "llm_util", None):
            os.environ["LLM_UTIL"] = args.llm_util
        if getattr(args, "llm_judge", None):
            os.environ["LLM_JUDGE"] = args.llm_judge
        logger.info(f"v5 root: {paths.root}")
        if getattr(args, "cluster", None):
            logger.info(f"cluster: {args.cluster}")
        return args, paths, logger
