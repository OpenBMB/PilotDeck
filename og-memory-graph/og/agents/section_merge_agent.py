from __future__ import annotations
import os
import re
import json
import time
import threading
from pathlib import Path

try:
    from openai import OpenAI, APIError, RateLimitError, APIConnectionError, APITimeoutError
except ImportError:
    OpenAI = None

from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus, ChangeLogEntry
from og.core.edge import OGEdge, EdgeType


try:
    from og.config.models import LLM_MAIN as MERGE_MODEL
except ImportError:
    MERGE_MODEL = "claude-opus-4-7"
DEFAULT_MAX_TOKENS = 4000
DEFAULT_TEMPERATURE = 0.0
DEFAULT_TIMEOUT = 240.0
PROMPT_VERSION = "v1"








MERGE_SYSTEM = (
    "你是一位资深的研究报告章节结构分析师. 你将拿到一份深度调研报告中的【全部一级章节】"
    "结构信息(每个章节的 id / title / 子节点 title 列表). 你的任务是判断哪些章节"
    "由于讲述同一【主体 / 主题】或同一【时间段+主题】, 应该合并为一个章节, 以减少冗余、"
    "提升整体可读性.\n\n"
    "【判定原则 — 必须严格遵守】\n"
    "1. **同一主体 (人/公司/产品/项目) 在多个章节出现** → 强烈建议合并. 例如 2 个章节"
    "都讲述同一公司的不同时间阶段, 或 2 个章节都围绕同一产品的不同维度.\n"
    "2. **同一时间段同一主题** → 建议合并. 例如多个章节都在描述某一年的某一类事件.\n"
    "3. **袖珍章节 (≤2 个子节点)** 如果与某个相邻章节主体相关, 优先合并到那个章节.\n"
    "4. **不要把不同公司 / 不同主题 / 不同时间段的章节强行合并**. 'AI 军备竞赛' 与 "
    "'反垄断与监管' 是不同主题, **不要**合并.\n"
    "5. **保留独立的章节也很重要**: 如果一个章节虽然子节点少但主题独立 (e.g. 单独的"
    "某事件或某主题), 应保持独立.\n"
    "6. **不要把摘要 / 总览类章节合并到具体公司/事件章节**.\n\n"
    "【输出格式 — 严格 JSON, 不要 markdown 包裹】\n"
    "{\n"
    '  "merge_groups": [\n'
    "    {\n"
    '      "kept_section_id": "<目标章节 id, 一般选子节点最多者>",\n'
    '      "merge_section_ids": ["<被合并的章节 id 列表, 不含 kept_section_id>"],\n'
    '      "merged_title": "<合并后该章节的新标题, 简洁(8-25 字), 能涵盖所有源章节主题, 不含数字/百分号>",\n'
    '      "reason": "<为什么这几个章节应该合并, 50-100 字>"\n'
    "    }\n"
    "  ],\n"
    '  "no_merge_section_ids": ["<保持独立的章节 id 列表>"]\n'
    "}\n\n"
    "【关键提醒】\n"
    "- 每个章节 id 必须出现在 merge_groups 或 no_merge_section_ids 中, 且只能出现一次.\n"
    "- merged_title 必须是合理的中文标题, 不是把多个标题硬拼在一起.\n"
    "- 如果某些章节主题独立, 不应合并, 保留在 no_merge_section_ids.\n"
    "- 不要为了减少章节数而强行合并. 宁缺毋滥.\n"
    "- merge_groups 可以为空数组 (如果无任何合理合并)."
)




_client = None
_lock = threading.Lock()


def _get_client():
    global _client
    if _client is not None:
        return _client
    if OpenAI is None:
        raise RuntimeError("openai package is not installed (pip install openai)")
    with _lock:
        if _client is None:
            base = os.environ.get("OPENAI_API_BASE", "https://yeysai.com/v1")
            key = os.environ.get("OPENAI_API_KEY", "")
            if not key:
                raise RuntimeError("OPENAI_API_KEY env var not set")
            _client = OpenAI(base_url=base, api_key=key,
                             timeout=DEFAULT_TIMEOUT, max_retries=0)
    return _client


def _call_llm(messages: list[dict], max_retries: int = 3,
               max_tokens: int = DEFAULT_MAX_TOKENS,
               temperature: float = DEFAULT_TEMPERATURE,
               model: str = MERGE_MODEL) -> str:
    last_err = None
    for i in range(max_retries):
        try:
            r = _get_client().chat.completions.create(
                model=model, messages=messages,
                temperature=temperature, max_tokens=max_tokens,
            )
            return (r.choices[0].message.content or "").strip()
        except (RateLimitError, APIConnectionError, APITimeoutError, APIError) as e:
            last_err = e
            time.sleep(2 ** i + 1)
        except Exception as e:
            last_err = e
            time.sleep(2)
    raise RuntimeError(f"merge LLM failed: {last_err}")


def _parse_json(text: str) -> dict | None:
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:])
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    try:
        return json.loads(text)
    except Exception:
        s, e = text.find("{"), text.rfind("}")
        if s != -1 and e != -1 and e > s:
            try:
                return json.loads(text[s:e + 1])
            except Exception:
                return None
    return None


def _is_excluded(title: str) -> bool:
    title_lower = title.lower() if title else ""

    if any(kw in title_lower for kw in ["summary", "abstract", "appendix", "references", "bibliography"]):
        return True

    if any(kw in (title or "") for kw in ["摘要", "参考来源", "参考文献", "附录"]):
        return True
    return False




class SectionMergeAgent:

    def __init__(self, model: str = MERGE_MODEL,
                  max_child_titles_per_section: int = 6,
                  cache_dir: Path | None = None):
        self.model = model
        self.max_child_titles_per_section = max_child_titles_per_section
        self.cache_dir = cache_dir
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)



    def merge(self, og: OutlineGraph, version: str = "merged") -> dict:
        report = {
            "n_sections_before": 0,
            "n_sections_after": 0,
            "n_merge_groups": 0,
            "n_sections_deprecated": 0,
            "merge_groups": [],
            "skipped_excluded": [],
        }

        root = og.get_root()
        if not root:
            return report

        all_sections = [s for s in og.get_children(root.id, NodeType.SECTION)
                        if s.status == NodeStatus.ACTIVE]
        report["n_sections_before"] = len(all_sections)

        candidates: list[OGNode] = []
        for s in all_sections:
            if _is_excluded(s.title):
                report["skipped_excluded"].append({"id": s.id, "title": s.title})
            else:
                candidates.append(s)

        if len(candidates) < 2:
            report["n_sections_after"] = report["n_sections_before"]
            return report


        section_summaries = []
        for sec in candidates:
            child_titles = self._child_titles(og, sec)
            section_summaries.append({
                "id": sec.id,
                "title": sec.title,
                "n_children": len(child_titles),
                "child_titles": child_titles[:self.max_child_titles_per_section],
            })


        cache_key = self._cache_key(section_summaries)
        plan = self._read_cache(cache_key)
        if plan is None:
            print(f"  [merge] LLM batch call: {len(candidates)} sections")
            user_msg = (
                f"【报告主题 / 上下文】\n"
                f"以下是来自一份深度调研报告的全部一级章节. 请按系统消息的判定原则识别合并组.\n\n"
                f"【一级章节列表 (共 {len(candidates)} 个)】\n"
                + json.dumps(section_summaries, ensure_ascii=False, indent=2)
                + "\n\n请按系统消息中的 JSON schema 返回合并方案."
            )
            try:
                raw = _call_llm(
                    [
                        {"role": "system", "content": MERGE_SYSTEM},
                        {"role": "user", "content": user_msg},
                    ],
                    max_tokens=DEFAULT_MAX_TOKENS,
                    model=self.model,
                )
                plan = _parse_json(raw)
            except Exception as e:
                print(f"  [merge] LLM call failed: {e}; skipping merge")
                report["n_sections_after"] = report["n_sections_before"]
                return report

            if plan is None:
                print(f"  [merge] LLM returned unparseable JSON; skipping merge")
                report["n_sections_after"] = report["n_sections_before"]
                return report

            self._write_cache(cache_key, plan)

        merge_groups = plan.get("merge_groups", []) or []


        valid_ids = {s.id for s in candidates}
        used_ids: set[str] = set()
        n_deprecated = 0
        for grp in merge_groups:
            kept = grp.get("kept_section_id")
            sources = grp.get("merge_section_ids") or []
            new_title = (grp.get("merged_title") or "").strip()
            reason = (grp.get("reason") or "").strip()

            if kept not in valid_ids:
                print(f"    [warn] invalid kept_section_id {kept}; skipping group")
                continue
            sources = [s for s in sources if s in valid_ids and s != kept and s not in used_ids]
            if not sources:
                continue

            target = og.get_node(kept)
            srcs = [og.get_node(sid) for sid in sources]
            if not target or any(s is None for s in srcs):
                continue

            self._merge_into(og, target, srcs, version, new_title=new_title, reason=reason)
            used_ids.update(sources)
            used_ids.add(kept)
            report["merge_groups"].append({
                "kept_section_id": kept,
                "kept_old_title": target.title,
                "kept_new_title": new_title or target.title,
                "merge_section_ids": sources,
                "reason": reason,
            })
            n_deprecated += len(sources)

        report["n_sections_deprecated"] = n_deprecated
        report["n_merge_groups"] = len(report["merge_groups"])
        report["n_sections_after"] = report["n_sections_before"] - n_deprecated


        for grp in report["merge_groups"]:
            target = og.get_node(grp["kept_section_id"])
            if target and grp["kept_new_title"]:
                target.title = grp["kept_new_title"]
                og.update_node(target)

        return report



    def _child_titles(self, og: OutlineGraph, section: OGNode) -> list[str]:
        out = []
        for n in og.get_children(section.id):
            if n.type in (NodeType.SECTION, NodeType.REFERENCE, NodeType.TABLE):
                continue
            if n.status != NodeStatus.ACTIVE:
                continue
            t = (n.title or n.content_summary or "").strip()
            if t:
                out.append(t[:80])
        return out

    @staticmethod
    def _merge_into(og: OutlineGraph, target: OGNode, sources: list[OGNode],
                    version: str, new_title: str = "", reason: str = ""):
        for src in sources:
            for edge in list(og.get_outgoing_edges(src.id, EdgeType.CONTAINS)):
                child = og.get_node(edge.target_id)
                if not child:
                    continue

                og.remove_edge(edge)

                og.add_edge(OGEdge(
                    target.id, edge.target_id, EdgeType.CONTAINS,
                    edge.strength, version,
                    notes=f"merged from section {src.id}",
                    confidence=edge.confidence,
                ))




            target.change_log.append(ChangeLogEntry(
                version, "MERGE_SECTIONS",
                description=(f"合并了 {src.id} ('{src.title}'). 原因: {reason[:120]}")
            ))
            og.update_node(target)
            og.remove_node(src.id)



    def _cache_key(self, section_summaries: list[dict]) -> str:
        import hashlib
        composite = json.dumps({
            "v": PROMPT_VERSION,
            "sections": section_summaries,
        }, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256(composite.encode("utf-8")).hexdigest()[:16]
        return f"merge_plan__{h}.json"

    def _read_cache(self, key: str) -> dict | None:
        if self.cache_dir is None:
            return None
        p = self.cache_dir / key
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                return None
        return None

    def _write_cache(self, key: str, data: dict):
        if self.cache_dir is None:
            return
        p = self.cache_dir / key
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
