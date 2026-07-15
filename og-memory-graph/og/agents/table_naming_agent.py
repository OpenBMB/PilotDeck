from __future__ import annotations
import os
import re
import json
import time
import hashlib
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

try:
    from openai import OpenAI, APIError, RateLimitError, APIConnectionError, APITimeoutError
except ImportError:
    OpenAI = None

from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus, ChangeLogEntry


try:
    from og.config.models import LLM_MAIN as NAMING_MODEL
except ImportError:
    NAMING_MODEL = "claude-opus-4-7"
DEFAULT_PARALLEL = 5
DEFAULT_MAX_TOKENS = 800
DEFAULT_TEMPERATURE = 0.0
DEFAULT_TIMEOUT = 120.0
PROMPT_VERSION = "v2"




TOPIC_LABEL_MIN_LEN = 2
TOPIC_LABEL_MAX_LEN = 24


NAMING_SYSTEM_TEMPLATE = (
    "你是一位严谨的研究报告表格编辑. 给你一张表格的 schema (列名) 和 data (数据行), "
    "请基于实际数据内容为该表生成清晰、准确、信息密度高的中文标题, 同时给该表"
    "归一个用于附录分组的粗主题标签.\n\n"
    "【报告整体主题】「{topic}」\n"
    "请基于这个整体主题语境理解每张表的归属, 但 caption 与 topic_label 必须"
    "聚焦于本张表自身的内容,不要把整体主题原样塞进去.\n\n"
    "【caption 命名规则】\n"
    "1. 长度 8-22 个汉字 (允许少量必要英文术语,如机构/产品/技术原名)\n"
    "2. **不含数字/百分号/货币单位** (例如不能出现 '779亿', '5万亿', '+24%')\n"
    "3. **不含中文半词** (例如从 '服务收入' 切出 '务收入', 从 '欧冠决赛' 切出"
    " '冠决赛' 这种残块都不行)\n"
    "4. 应概括所有行的【共同主题】, 不要只描述其中一行\n"
    "5. 优先使用通用词 + 主体名: 抽象例 '<主体> <指标>多周期演进', "
    "'<事件类别>时间线', '<群体>对比' 等\n"
    "6. 不要重复章节名 (不要写 '<章节名>·<表名>'); "
    "也不要使用 '数据一览' / '数据汇总' 这种空洞后缀\n"
    "7. 一句话, 不要句号\n\n"
    "【schema 对齐检查】\n"
    "判断现有列名是否与每列实际数据语义匹配. 例:\n"
    "  - 列名 '数据年份' 但数据是 '美元'/'万吨' → 不匹配, 报告问题\n"
    "  - 列名 '指标' '数值' '数据年份' '来源' 与数据语义对应 → ok\n\n"
    "【topic_label 命名规则 — 自由生成,不再有白名单】\n"
    "请用一个 4-14 字的中文短语描述本表的【粗主题】,以便所有同主题的表能在"
    "附录里被自动聚到一起. 规则:\n"
    "1. 必须是【对一组同类表通用的标签】,不要把单张表的具体名字写进去 (例如不要"
    "写 '<X 公司 2024 财年营收表>',应写 '<X 公司 财务表现>')\n"
    "2. 不含数字、不含具体年份\n"
    "3. 长度 4-14 字\n"
    "4. 同一份报告里语义相同的表,你应该返回完全相同的 topic_label 字符串"
    "(用词、空格、标点都要一致),这样后处理才能把它们聚到同一个附录分组\n"
    "5. 实在没有可归的, 返回 '其他'\n\n"
    "【输出格式】\n"
    "返回严格 JSON, 不带 markdown 包裹. 字段:\n"
    "{{\n"
    '  "caption": "<8-22 字的中文表标题>",\n'
    '  "schema_check": "ok" | "<具体问题描述, 30 字内>",\n'
    '  "topic_label": "<4-14 字中文短语, 用于跨表聚合>"\n'
    "}}"
)


def _format_naming_system(topic: str | None) -> str:
    t = (topic or "").strip() or "本调研课题"
    return NAMING_SYSTEM_TEMPLATE.format(topic=t)




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
               model: str = NAMING_MODEL) -> str:
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
    raise RuntimeError(f"naming LLM failed: {last_err}")


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




class TableNamingAgent:

    def __init__(self, cache_dir: Path | None = None,
                  parallel: int = DEFAULT_PARALLEL,
                  model: str = NAMING_MODEL,
                  max_data_rows: int = 30,
                  topic: str | None = None):
        self.cache_dir = cache_dir
        self.parallel = parallel
        self.model = model
        self.max_data_rows = max_data_rows
        self.topic = topic
        self._system_prompt = _format_naming_system(topic)
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)



    def name_all(self, og: OutlineGraph, version: str = "naming") -> dict:
        report = {
            "n_total": 0,
            "n_renamed": 0,
            "n_cached": 0,
            "n_failed": 0,
            "n_unchanged": 0,
            "schema_warnings": [],
            "renamed": [],
        }

        tables = [t for t in og.get_all_nodes(NodeType.TABLE, NodeStatus.ACTIVE)
                  if t.table_data and t.table_schema]
        report["n_total"] = len(tables)
        if not tables:
            return report

        print(f"  [naming] {len(tables)} active tables to (re)name "
              f"(parallel={self.parallel})")


        with ThreadPoolExecutor(max_workers=self.parallel) as ex:
            futs = {ex.submit(self._name_one, t): t for t in tables}
            for fut in as_completed(futs):
                t = futs[fut]
                old_cap = t.table_caption or t.title
                old_topic = t.topic_label
                try:
                    res, hit = fut.result()
                except Exception as e:
                    report["n_failed"] += 1
                    print(f"    ✗ {t.id}  {e}")
                    continue

                new_cap = (res.get("caption") or "").strip() or old_cap
                new_topic = (res.get("topic_label") or "").strip()


                if (not new_topic
                        or len(new_topic) < TOPIC_LABEL_MIN_LEN
                        or len(new_topic) > TOPIC_LABEL_MAX_LEN):
                    new_topic = old_topic or "其他"

                changed = False
                if new_cap and new_cap != old_cap:
                    t.table_caption = new_cap
                    t.title = new_cap
                    changed = True
                if new_topic and new_topic != old_topic:
                    t.topic_label = new_topic
                    changed = True

                if changed:
                    t.last_updated_version = version
                    t.change_log.append(ChangeLogEntry(
                        version, "RENAME_TABLE",
                        description=(f"caption: '{old_cap}' → '{new_cap}'; "
                                     f"topic: '{old_topic}' → '{new_topic}'")
                    ))
                    og.update_node(t)
                    report["n_renamed"] += 1
                    report["renamed"].append({
                        "id": t.id,
                        "old_caption": old_cap,
                        "new_caption": new_cap,
                        "old_topic": old_topic,
                        "new_topic": new_topic,
                    })
                else:
                    report["n_unchanged"] += 1

                if hit:
                    report["n_cached"] += 1

                schema_check = (res.get("schema_check") or "").strip()
                if schema_check and schema_check.lower() not in ("ok", "对齐", ""):
                    report["schema_warnings"].append({
                        "id": t.id,
                        "caption": new_cap,
                        "warning": schema_check,
                    })

                flag = "·" if hit else ("✓" if changed else "=")
                print(f"    {flag} {t.id[:14]}  '{old_cap[:18]}'  →  "
                      f"'{new_cap[:24]}'  [{new_topic}]")


        if hasattr(og, "curation_meta") and og.curation_meta:
            self._refresh_curation_meta(og)

        return report



    def _name_one(self, table: OGNode) -> tuple[dict, bool]:
        cached = self._read_cache(table)
        if cached is not None:
            return cached, True

        rows_md = self._format_rows_for_prompt(table)
        user_msg = (
            f"【表格 schema (列名)】\n{table.table_schema}\n\n"
            f"【表格 data (前 {min(self.max_data_rows, len(table.table_data))} 行)】\n"
            f"{rows_md}\n\n"
            "请按系统消息规则返回 JSON."
        )
        raw = _call_llm(
            [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=DEFAULT_MAX_TOKENS,
            model=self.model,
        )
        parsed = _parse_json(raw)
        if not parsed:
            parsed = {"caption": "", "schema_check": "", "topic_label": ""}

        self._write_cache(table, parsed)
        return parsed, False

    def _format_rows_for_prompt(self, table: OGNode) -> str:
        schema = table.table_schema
        rows = table.table_data[:self.max_data_rows]
        lines = ["| " + " | ".join(schema) + " |"]
        lines.append("| " + " | ".join(["---"] * len(schema)) + " |")
        for r in rows:
            cells = [str(c)[:60] for c in r] + [""] * (len(schema) - len(r))
            lines.append("| " + " | ".join(cells[:len(schema)]) + " |")
        return "\n".join(lines)



    def _cache_key(self, table: OGNode) -> str:
        composite = json.dumps({
            "v": PROMPT_VERSION,
            "schema": table.table_schema,
            "data": table.table_data,
        }, ensure_ascii=False, sort_keys=True)
        h = hashlib.sha256(composite.encode("utf-8")).hexdigest()[:16]
        safe_id = re.sub(r"[^\w]+", "_", table.id)[:30]
        return f"{safe_id}__{h}.json"

    def _read_cache(self, table: OGNode) -> dict | None:
        if self.cache_dir is None:
            return None
        p = self.cache_dir / self._cache_key(table)
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                return None
        return None

    def _write_cache(self, table: OGNode, data: dict):
        if self.cache_dir is None:
            return
        p = self.cache_dir / self._cache_key(table)
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")



    @staticmethod
    def _refresh_curation_meta(og: OutlineGraph):
        from collections import defaultdict
        appendix_tables = [t for t in og.get_all_nodes(NodeType.TABLE, NodeStatus.ACTIVE)
                           if t.placement == "appendix"]
        by_topic = defaultdict(list)
        for t in appendix_tables:
            by_topic[t.topic_label or "其他"].append(t)
        ordered_topics = sorted(by_topic.keys(),
                                 key=lambda k: (-len(by_topic[k]), k))

        groups = []
        table_appendix_ids: dict[str, str] = {}
        claim_inline_refs: dict[str, str] = {}
        for idx, topic in enumerate(ordered_topics):
            letter = (chr(ord("A") + idx) if idx < 26
                      else chr(ord("A") + (idx // 26) - 1) + chr(ord("A") + idx % 26))
            tables = by_topic[topic]
            ids = []
            for j, t in enumerate(tables, 1):
                appendix_id = f"表 {letter}.{j}"
                t.appendix_id = appendix_id
                ids.append(t.id)
                table_appendix_ids[t.id] = appendix_id
                claim_inline_refs[t.id] = f"(详见附录 {letter} {appendix_id})"
                og.update_node(t)
            groups.append({"letter": letter, "topic": topic, "tables": ids})
        og.curation_meta = {
            "appendix_groups": groups,
            "table_appendix_ids": table_appendix_ids,
            "claim_inline_refs": claim_inline_refs,
        }
