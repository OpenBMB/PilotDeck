from __future__ import annotations
import os
import re
import json
import time
import hashlib
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
    from og.config.models import LLM_MAIN as REPARENT_MODEL
except ImportError:
    REPARENT_MODEL = "claude-opus-4-7"
DEFAULT_MAX_TOKENS = 6000
DEFAULT_TEMPERATURE = 0.0
DEFAULT_TIMEOUT = 300.0
PROMPT_VERSION = "v1"




DEFAULT_DUMP_THRESHOLD = 20









NODE_CONTENT_PREVIEW_CHARS = 220
SECTION_TOPIC_PREVIEW_CHARS = 280


REPARENT_SYSTEM = (
    "你是一位资深的研究报告章节归类编辑. 你将拿到:\n"
    "  1. 一组【候选目标章节】(每章 id / 标题 / 该章现有子节点的 title 摘要), 这些是\n"
    "     该报告中除杂物章节外的全部正文章节.\n"
    "  2. 一组【待归类节点】(每节点 id / 当前所在章节 / 节点 title / content 摘要 / "
    "cited_refs), 这些节点目前都堆在一个'杂物章节'下, 但它们讲述的主体或主题可能"
    "更适合归到某个候选目标章节.\n\n"
    "你的任务: 为每个待归类节点选择最合适的目标章节 id, 或者保留在原章节(返回 'keep').\n\n"
    "【判定原则 — 必须严格遵守】\n"
    "1. 优先看节点 title 与 content 中描述的【主体 / 事件】, 把它归到讲述同一主体 / "
    "事件的目标章节. 抽象例: 节点讲 '<主体 X> 的 <子事件 Y>', 候选章节里有一章是"
    " '<主体 X>...' 的专章, 则应归到该章节.\n"
    "2. cited_refs 是辅助信号: 同一 ref 经常被同主题节点引用, 可参考.\n"
    "3. **严格只能选候选章节列表中的 id**. 不能编造章节, 也不能选不在列表里的章节.\n"
    "4. **保守原则**: 若节点讲述的是【跨主体的总览 / 整体趋势 / 制度变革 / 行业格局】, "
    "不要强行归到某个具体主体的专章, 应返回 'keep' 让其留在原章节(原章节通常是"
    "该报告的'综述/背景/挑战与展望'类容器).\n"
    "5. 若节点同时涉及多个主体, 选其中【最核心 / 最深入展开的】那个对应章节.\n"
    "6. 节点的归类应该让它和目标章节现有内容【自然衔接】, 不要把孤立或跑题的节点强塞.\n"
    "7. 不要假设报告主题是任何特定领域(科技/体育/医药/政治皆有可能), 仅基于"
    "提供给你的章节标题与节点内容做判断.\n\n"
    "【输出格式 — 严格 JSON, 不要 markdown 包裹】\n"
    "{\n"
    '  "reparent": [\n'
    '    {"node_id": "<待归类节点 id>", '
    '"target_section_id": "<目标章节 id, 或 \\"keep\\">", '
    '"reason": "<30-80 字归类理由>"}\n'
    "  ]\n"
    "}\n\n"
    "【关键提醒】\n"
    "- 每个待归类节点 id 必须在 reparent 数组中出现一次, 不能漏.\n"
    "- target_section_id 必须严格等于候选章节列表中的 id 字符串, 或 'keep'.\n"
    "- 不要为了减少 'keep' 数量而强行归类: 不确定时 keep 是更安全的选择."
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
               model: str = REPARENT_MODEL) -> str:
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
    raise RuntimeError(f"reparent LLM failed: {last_err}")


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

                cleaned = re.sub(r",(\s*[}\]])", r"\1", text[s:e + 1])
                try:
                    return json.loads(cleaned)
                except Exception:
                    return None
    return None


def _is_excluded_title(title: str) -> bool:
    title_lower = title.lower() if title else ""

    if any(kw in title_lower for kw in ["summary", "abstract", "appendix", "references", "bibliography"]):
        return True

    if any(kw in (title or "") for kw in ["摘要", "参考来源", "参考文献", "附录"]):
        return True
    return False




class NodeReparentAgent:

    REPARENTABLE_NODE_TYPES = (
        NodeType.CLAIM,
        NodeType.EVIDENCE,
        NodeType.SYNTHESIS,
        NodeType.COMPARISON,
        NodeType.CONTEXT,
    )

    def __init__(self, dump_threshold: int = DEFAULT_DUMP_THRESHOLD,
                  model: str = REPARENT_MODEL,
                  cache_dir: Path | None = None):
        self.dump_threshold = dump_threshold
        self.model = model
        self.cache_dir = cache_dir
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)



    def reparent(self, og: OutlineGraph, version: str = "reparent") -> dict:


        self._og_handle = og
        report = {
            "n_dump_sections": 0,
            "dump_sections": [],
            "n_target_sections": 0,
            "n_nodes_considered": 0,
            "n_nodes_moved": 0,
            "n_nodes_kept": 0,
            "n_invalid_target": 0,
            "n_nodes_skipped_stable": 0,
            "moves": [],
        }

        root = og.get_root()
        if not root:
            return report





        current_ver = version.split("-")[0] if "-" in version else version

        all_sections = [s for s in og.get_children(root.id, NodeType.SECTION)
                        if s.status == NodeStatus.ACTIVE]


        dump_secs: list[OGNode] = []
        target_pool: list[OGNode] = []
        for s in all_sections:
            if _is_excluded_title(s.title):
                continue
            content_kids = [n for n in og.get_children(s.id)
                            if n.status == NodeStatus.ACTIVE
                            and n.type in self.REPARENTABLE_NODE_TYPES]
            if len(content_kids) >= self.dump_threshold:
                dump_secs.append(s)
            else:
                target_pool.append(s)

        report["n_dump_sections"] = len(dump_secs)
        report["dump_sections"] = [
            {"id": s.id, "title": s.title,
             "n_content_children": len([n for n in og.get_children(s.id)
                                         if n.status == NodeStatus.ACTIVE
                                         and n.type in self.REPARENTABLE_NODE_TYPES])}
            for s in dump_secs
        ]
        report["n_target_sections"] = len(target_pool)

        if not dump_secs:
            print("  [reparent] no dump section detected — nothing to do")
            return report
        if not target_pool:
            print("  [reparent] no target sections available — skipping")
            return report





        nodes_with_origin = []
        for ds in dump_secs:
            for n in og.get_children(ds.id):
                if n.status == NodeStatus.ACTIVE and n.type in self.REPARENTABLE_NODE_TYPES:
                    lu = (n.last_updated_version or "")
                    if current_ver and lu and not lu.startswith(current_ver):

                        report["n_nodes_skipped_stable"] += 1
                        continue
                    nodes_with_origin.append((n, ds))
        report["n_nodes_considered"] = len(nodes_with_origin)
        if not nodes_with_origin:
            if report["n_nodes_skipped_stable"]:
                print(f"  [reparent] {report['n_nodes_skipped_stable']} stable nodes kept; "
                      f"no changed nodes to reparent")
            else:
                print("  [reparent] no candidate nodes in dump sections")
            return report

        print(f"  [reparent] dump sections={len(dump_secs)}; "
              f"candidate targets={len(target_pool)}; nodes={len(nodes_with_origin)}")


        plan = self._llm_decide(target_pool, nodes_with_origin)
        if plan is None:
            print("  [reparent] LLM call failed or returned unparseable JSON; skipping")
            return report

        target_ids = {s.id for s in target_pool}
        decisions: dict[str, dict] = {}
        for entry in plan.get("reparent", []) or []:
            nid = entry.get("node_id")
            tgt = entry.get("target_section_id")
            reason = entry.get("reason", "")
            if not nid or not tgt:
                continue
            decisions[nid] = {"target": tgt, "reason": reason}


        for n, origin in nodes_with_origin:
            d = decisions.get(n.id)
            if not d:

                report["n_nodes_kept"] += 1
                continue
            tgt = d["target"]
            if tgt == "keep":
                report["n_nodes_kept"] += 1
                continue
            if tgt not in target_ids:
                report["n_invalid_target"] += 1
                continue
            target_node = og.get_node(tgt)
            if target_node is None or target_node.status != NodeStatus.ACTIVE:
                report["n_invalid_target"] += 1
                continue

            self._move_node(og, n, origin, target_node, version, d["reason"])
            report["n_nodes_moved"] += 1
            report["moves"].append({
                "node_id": n.id,
                "node_title": n.title[:60],
                "from": origin.id,
                "from_title": origin.title,
                "to": target_node.id,
                "to_title": target_node.title,
                "reason": d["reason"][:120],
            })

        return report



    @staticmethod
    def _move_node(og: OutlineGraph, node: OGNode, source: OGNode,
                   target: OGNode, version: str, reason: str):


        for edge in list(og.get_incoming_edges(node.id, EdgeType.CONTAINS)):
            if edge.source_id == source.id:
                og.remove_edge(edge)

        og.add_edge(OGEdge(
            target.id, node.id, EdgeType.CONTAINS,
            created_in_version=version,
            notes=f"reparented from {source.id} ({reason[:80]})",
        ))

        node.last_updated_version = version
        node.change_log.append(ChangeLogEntry(
            version, "REPARENT_NODE",
            description=(f"从 {source.id} ('{source.title[:30]}') 迁移到 "
                         f"{target.id} ('{target.title[:30]}'). "
                         f"原因: {reason[:120]}")
        ))
        og.update_node(node)

    def _llm_decide(self, target_pool: list[OGNode],
                     nodes_with_origin: list[tuple[OGNode, OGNode]]) -> dict | None:

        og = self._og_handle

        target_summary = []
        for s in target_pool:
            child_titles = []
            for c in og.get_children(s.id):
                if c.status != NodeStatus.ACTIVE:
                    continue
                if c.type in (NodeType.SECTION, NodeType.REFERENCE, NodeType.TABLE):
                    continue
                t = (c.title or c.content_summary[:30] or "").strip()
                if t:
                    child_titles.append(t[:40])
            topics = " / ".join(child_titles[:8])
            target_summary.append({
                "id": s.id,
                "title": s.title,
                "topics": topics[:SECTION_TOPIC_PREVIEW_CHARS],
            })

        node_summary = []
        for n, origin in nodes_with_origin:
            node_summary.append({
                "id": n.id,
                "current_section_id": origin.id,
                "current_section_title": origin.title,
                "node_type": n.type.value,
                "title": (n.title or "")[:80],
                "content": (n.content_summary or "")[:NODE_CONTENT_PREVIEW_CHARS],
                "cited_refs": list(n.cited_refs)[:8],
            })

        cache_key = self._cache_key(target_summary, node_summary)
        cached = self._read_cache(cache_key)
        if cached is not None:
            print(f"  [reparent] cache hit: {cache_key}")
            return cached

        user_msg = (
            f"【候选目标章节】(共 {len(target_summary)} 个)\n"
            + json.dumps(target_summary, ensure_ascii=False, indent=2)
            + f"\n\n【待归类节点】(共 {len(node_summary)} 个)\n"
            + json.dumps(node_summary, ensure_ascii=False, indent=2)
            + "\n\n请按系统消息中的 JSON schema 返回归类决策."
        )
        try:
            raw = _call_llm(
                [
                    {"role": "system", "content": REPARENT_SYSTEM},
                    {"role": "user", "content": user_msg},
                ],
                max_tokens=DEFAULT_MAX_TOKENS,
                model=self.model,
            )
        except Exception as e:
            print(f"  [reparent] LLM call failed: {e}")
            return None

        plan = _parse_json(raw)
        if plan is None:

            if self.cache_dir is not None:
                debug = self.cache_dir / f"{cache_key}.raw_failed.txt"
                debug.write_text(raw[:8000], encoding="utf-8")
                print(f"  [reparent] saved raw output for debug: {debug}")
            return None

        self._write_cache(cache_key, plan)
        return plan



    def _cache_key(self, target_summary: list[dict],
                    node_summary: list[dict]) -> str:
        composite = json.dumps({
            "v": PROMPT_VERSION,
            "targets": target_summary,
            "nodes": node_summary,
        }, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256(composite.encode("utf-8")).hexdigest()[:16]
        return f"reparent_plan__{h}.json"

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
