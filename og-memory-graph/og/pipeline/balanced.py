
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

_ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parent.parent.parent)))
from og.cli._common import ScriptContext


try:
    from config_models import LLM_MAIN, OPENAI_API_BASE, OPENAI_API_KEY
    from config_models import patch_openai_for_reasoning_fallback
    patch_openai_for_reasoning_fallback()
except Exception:
    pass

from openai import OpenAI

DEFAULT_LLM = "deepseek-v4-flash"




_VERSION_CANDIDATES = ["v9.0", "v8.0", "v7.0", "v6.0", "v5.0", "v4.0", "v3.0", "v2.0", "v1.0"]


def detect_version(cluster_output_dir: Path, suffix: str) -> str | None:
    for v in _VERSION_CANDIDATES:
        p = cluster_output_dir / f"output_report_{v}_{suffix}.md"
        if p.exists():
            return v
    return None


def make_client() -> OpenAI:
    return OpenAI(
        base_url=os.environ.get("OPENAI_API_BASE", "https://yeysai.com/v1"),
        api_key=os.environ.get("OPENAI_API_KEY", ""),
    )


def call_llm(client: OpenAI, model: str, prompt: str,
             max_tokens: int = 2000, temperature: float = 0.4,
             timeout: float | None = None) -> str:

    env_to = os.environ.get("LLM_BALANCED_TIMEOUT")
    if timeout is None and env_to:
        try:
            timeout = float(env_to)
        except ValueError:
            timeout = None
    env_mt = os.environ.get("LLM_BALANCED_MAX_TOKENS")
    if env_mt:
        try:
            max_tokens = int(env_mt)
        except ValueError:
            pass
    kwargs = dict(model=model,
                  messages=[{"role": "user", "content": prompt}],
                  max_tokens=max_tokens,
                  temperature=temperature)
    if timeout is not None:
        kwargs["timeout"] = timeout
    r = client.chat.completions.create(**kwargs)
    msg = r.choices[0].message
    return (msg.content or "").strip() or (getattr(msg, "reasoning_content", "") or "").strip()


def load_og_nodes(inter_dir: Path, cluster: str, version: str = "v5.0") -> list[dict]:
    p = inter_dir / f"og_{cluster}_{version}.json"
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return []
    raw = d.get("nodes", []) or []

    if isinstance(raw, dict):
        return list(raw.values())
    return raw


def extract_claim_texts(og_nodes: list[dict], n: int = 60) -> list[str]:
    out, seen = [], set()
    for nd in og_nodes:
        t = (nd.get("type") or "").lower()
        if t not in ("claim", "synthesis", "evidence"):
            continue
        title = (nd.get("title") or "").strip()
        if title and title not in seen:
            seen.add(title)
            out.append(title)
        if len(out) >= n:
            break
    return out


def extract_section_titles(og_nodes: list[dict]) -> list[str]:
    out, seen = [], set()
    for nd in og_nodes:
        if (nd.get("type") or "").lower() != "section":
            continue
        t = (nd.get("title") or "").strip()
        if t and t not in seen and t not in ("报告根节点", "本报告"):
            seen.add(t)
            out.append(t)
    return out


def build_prompt(topic: str, section_titles: list[str], claim_titles: list[str],
                 n_trends: int) -> str:
    sec_block = "\n".join(f"- {s}" for s in section_titles[:30])
    claim_block = "\n".join(f"- {c}" for c in claim_titles[:60])
    return f"""你是顶级研究分析师. 基于以下章节标题与核心 Claim/Synthesis 节点, 提炼 {n_trends} 条 **跨章节宏观趋势**, 供深度调研报告「综合趋势分析」章节使用.

【研究主题】
{topic or "(未指定)"}

【报告主要章节】
{sec_block or "(无)"}

【核心 Claim / Synthesis 节点 (事实单元)】
{claim_block or "(无)"}

【输出要求】
1. 输出 {n_trends} 条宏观趋势, 每条 1-2 句中文, 约 30-50 字.
2. 每条必须能对应到章节中至少 2 处事实, 用 `[证据: <章节名短关键词>]` 标注引用, 每条 1-2 个证据.
3. 趋势之间不重复, 维度互补: 政治/经济/社会/技术/地缘/治理/长期主义等.
4. 直接以编号列表输出, 不要前言, 不要 JSON, 不要 markdown 标题.

【示例格式】
1. [趋势名] 趋势要点 1, 趋势要点 2. [证据: 章节A; 章节B]
2. ...
"""


def parse_trends(text: str) -> list[str]:
    out = []
    for line in text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        m = re.match(r"^\d+[\.\)、]\s*(.+)$", line)
        if m:
            out.append(m.group(1).strip())
    return out


def main(argv: list[str] | None = None) -> int:
    ctx = ScriptContext("_balanced_rewrite", argv, need_log=True, need_model=True)
    ap = ctx.ap
    ap.add_argument("--rewritten", default=None,
                    help="rewritten 报告路径 (默认自动检测 v4.0/v5.0)")
    ap.add_argument("--balanced", default=None,
                    help="balanced 输出路径 (默认同目录 output_report_<ver>_balanced.md)")
    ap.add_argument("--og-version", default=None,
                    help="OG snapshot version, e.g. v4.0 / v5.0 (默认自动检测)")
    ap.add_argument("--n-trends", type=int, default=7)
    ap.add_argument("--max-claims", type=int, default=60)
    args, paths, logger = ctx.parse(argv)

    cluster = args.cluster
    out_dir = paths.cluster_output(cluster)


    ver = args.og_version
    if not ver:
        ver = detect_version(out_dir, "rewritten")
    if not ver:
        logger.error(f"找不到 rewritten 报告, 目录: {out_dir}")
        logger.error(f"  请先跑: python3 scripts/generate_a.py --cluster {cluster} --rewrite")
        return 1
    logger.info(f"使用版本: {ver}")

    rewritten_path = Path(args.rewritten) if args.rewritten else (
        out_dir / f"output_report_{ver}_rewritten.md")
    balanced_path = Path(args.balanced) if args.balanced else (
        out_dir / f"output_report_{ver}_balanced.md")

    if not rewritten_path.exists():
        logger.error(f"缺少 rewritten 报告: {rewritten_path}")
        logger.error(f"  请先跑: python3 scripts/generate_a.py --cluster {cluster} --rewrite")
        return 1


    topic = ""
    try:
        data = json.loads(paths.data.freshqa_questions.read_text(encoding="utf-8"))
        for c in data.get("clusters", []):
            if c.get("id") == cluster or c.get("id", "").endswith(cluster):
                topic = c.get("prompt", "")
                break
    except Exception:
        pass


    og_nodes = load_og_nodes(paths.intermediates_og(cluster), cluster,
                             version=ver)
    sections = extract_section_titles(og_nodes)
    claims = extract_claim_texts(og_nodes, n=args.max_claims)
    logger.info(f"OG 节点: {len(og_nodes)} 个, 章节 {len(sections)}, 事实 {len(claims)}")


    client = make_client()
    model = os.environ.get("LLM_MAIN", DEFAULT_LLM)
    logger.info(f"LLM: {model}")
    prompt = build_prompt(topic, sections, claims, n_trends=args.n_trends)
    t0 = time.time()
    txt = call_llm(client, model, prompt, max_tokens=2000, temperature=0.4)
    trends = parse_trends(txt)
    logger.info(f"  解析到 {len(trends)} 条趋势 ({time.time()-t0:.1f}s)")


    rewritten_text = rewritten_path.read_text(encoding="utf-8")
    if "## 综合趋势分析" in rewritten_text:

        new_text = re.sub(
            r"## 综合趋势分析.*?(?=\n## |\Z)",
            "## 综合趋势分析\n\n" + "\n".join(f"{i+1}. {t}" for i, t in enumerate(trends)) + "\n",
            rewritten_text, flags=re.S)
    else:
        new_text = rewritten_text.rstrip() + "\n\n## 综合趋势分析\n\n" + \
                   "\n".join(f"{i+1}. {t}" for i, t in enumerate(trends)) + "\n"

    balanced_path.parent.mkdir(parents=True, exist_ok=True)
    balanced_path.write_text(new_text, encoding="utf-8")
    logger.info(f"[balanced] → {balanced_path} ({len(new_text)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
