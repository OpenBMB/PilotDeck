from __future__ import annotations
import os
import re
import json
import time
import threading
import hashlib
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

try:
    from openai import OpenAI, APIError, RateLimitError, APIConnectionError, APITimeoutError
except ImportError:
    OpenAI = None


try:
    from og.config.models import LLM_MAIN as REWRITE_MODEL
except ImportError:
    REWRITE_MODEL = "claude-opus-4-7"
DEFAULT_PARALLEL = 4
DEFAULT_MAX_TOKENS = 12000
DEFAULT_TEMPERATURE = 0.2
DEFAULT_TIMEOUT = 600.0



CHAPTER_CHUNK_THRESHOLD = 8000


SHORT_CHAPTER_MAX_CHARS = 1500


PROMPT_VERSION = "v3"




DEDUP_MIN_CHAPTERS = 3
DEDUP_MIN_LABEL_LEN = 4
DEDUP_MAX_CANDIDATES = 200





DEDUP_LABEL_BLACKLIST = (

    "小结", "综述", "概述", "前言", "结论", "展望", "背景", "摘要",
    "总结", "数据来源", "数据汇总", "概要", "亮点", "要点", "本期",

    "summary", "overview", "introduction", "conclusion", "background",
    "abstract", "outlook", "highlight", "highlights", "key points",
    "key takeaway", "data source", "this period", "preface"
)





REWRITE_SYSTEM_TEMPLATE = (
    "你是一位严谨的研究报告润色编辑, 任务是对一份主题为「{topic}」的"
    "深度调研报告做【段落级重写】, 让它在不丢失任何事实的前提下变得更易读、更结构化、更具洞察.\n\n"
    "【硬约束 — 必须严格遵守】\n"
    "1. 绝对禁止编造或修改任何事实: 数字、日期、人名、机构名、产品名、地名、引用编号必须照原样保留;\n"
    "   不能新增任何文中没有的具体数字 / 日期 / 人物 / 实体.\n"
    "2. 必须保留所有原文中的引用标记, 包括 [12]、[2,4-6]、[5-9] 等形式; 不要修改它们的位置含义.\n"
    "3. 不得新增小节级标题 (### / **粗体小标题**), 只对现有段落做拆分 / 顺序重排 / 残句修复 / 加结论句.\n"
    "4. 不得移除原段中的关键事实信息, 只做'分段 / 改写 / 添加总结句'.\n"
    "5. 不能加'根据上文'/'根据资料显示'/'笔者认为'等寒暄套话.\n"
    "6. 不要把原文里没出现过的领域术语/专有名词写进来.\n\n"
    "【★ 引用合并规则 — 必须严格遵守】\n"
    "在同一段或同一句子中, 当多个连续的事实**共享同一个引用标记** (例如 [N]) 时, "
    "**只能在该组事实的最后一处保留一次引用**, 中间事实不要重复引用. 抽象例:\n"
    "  反面 (错): \"<实体> <指标 a> <值1>[N]; <指标 b> <值2>[N]; <指标 c> <值3>[N]\"\n"
    "  正面 (对): \"<实体> <指标 a> <值1>, <指标 b> <值2>, <指标 c> <值3>[N]\"\n"
    "如果一段里只用到一个引用源, 仅在段尾出现一次 [N] 即可. 不要把同一个 [N] 在一段里写 3 次以上.\n"
    "若不同事实来自不同引用 (如 [N] 与 [M] 各管一部分), 仍按各自的最末位置保留;\n"
    "多个共用引用的连续事实可以折叠成一组 (用顿号 '、' 或者分号 ';' 连接), 末尾合并一个 [a,b-c] 形式.\n\n"
    "【可以做的事】\n"
    "A. 残句修复: 识别并补全被截断的句子 (如句末数字带小数点未补完). 若上下文足以补全, 就用"
    "现有信息补; 若无法补全, 就把它合并到前后完整句中, 或者直接删除残句的孤立片段.\n"
    "B. 段落分行: 把多个事件挤在一段的长 prose, 按 时间 / 实体 / 主题 拆成多个 2-4 句的"
    "段落, 用空行分隔; 注意保持因果时序.\n"
    "C. 洞见性结论 (★ 重要): 在每个【二级章节】末尾追加一行简短的【小结句】 (开头用 **小结**: ),\n"
    "   该小结句必须 100% 基于该章节内出现的事实, 给出一句话趋势 / 拐点 / 结构性判断, 30-80 字.\n"
    "   小结句不能引入章节外的事实.\n"
    "D. 引用整理 (与硬约束 #2 + 引用合并规则配合): 在保持引用编号不变的前提下, 把每段"
    "末尾的多个 [N][M][...] 折叠为单个 [a,b,c] 或 [a-c] 形式 (升序 + 去重 + 连续号段折叠).\n\n"
    "【输出格式】\n"
    "只输出重写后的章节正文 (markdown), 不要 JSON, 不要解释自己的修改, 也不要重复章节标题; "
    "保留原有的 **粗体小标题** 行 (如有), 但允许调整段落顺序.\n"
    "不要输出 ``` 代码块包裹."
)


def _format_system(topic: str | None) -> str:
    t = (topic or "").strip() or "本调研课题"
    return REWRITE_SYSTEM_TEMPLATE.format(topic=t)




_client = None
_client_lock = threading.Lock()


def _get_client():
    global _client
    if _client is not None:
        return _client
    if OpenAI is None:
        raise RuntimeError("openai package is not installed (pip install openai)")
    with _client_lock:
        if _client is None:
            base = os.environ.get("OPENAI_API_BASE", "https://yeysai.com/v1")
            key = os.environ.get("OPENAI_API_KEY", "")
            if not key:
                raise RuntimeError("OPENAI_API_KEY env var not set")
            _client = OpenAI(base_url=base, api_key=key,
                             timeout=DEFAULT_TIMEOUT, max_retries=0)
    return _client


def _is_thinking_pr(model: str) -> bool:
    m = (model or "").lower()
    return any(h in m for h in (
        "v4-pro", "qwen3", "-reasoning", "-think", "o1", "r1", "o3", "o4",
        "gpt-5", "gemini-2.5", "gemini-3", "glm-4.7", "glm-zero", "glm-z",
        "claude-thinking", "claude-opus-thinking",
    ))


def _thinking_mul_pr(model: str) -> float:
    m = (model or "").lower()
    if "gemini-2.5" in m or "gemini-3" in m:
        return 3.0
    return 2.5


def _call_llm(messages: list[dict], max_retries: int = 8,
               max_tokens: int = DEFAULT_MAX_TOKENS,
               temperature: float = DEFAULT_TEMPERATURE,
               model: str = REWRITE_MODEL) -> str:
    if _is_thinking_pr(model):
        max_tokens = int(max_tokens * _thinking_mul_pr(model))
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
            err_s = str(e).lower()
            if "503" in err_s or "429" in err_s or "no available" in err_s or "无可用渠道" in str(e):
                wait = min(300, 60 * (i + 1))
            else:
                wait = min(180, 2 ** i + 5)
            print(f"      [warn] rewrite LLM error: {type(e).__name__}; retry in {wait}s")
            time.sleep(wait)
        except Exception as e:
            last_err = e
            print(f"      [warn] rewrite LLM unexpected: {e}; retry in 5s")
            time.sleep(5)
    raise RuntimeError(f"rewrite LLM failed: {last_err}")





_CHAPTER_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)


def _split_chapters(md: str) -> list[tuple[str, str, int]]:
    chapters: list[tuple[str, str, int]] = []
    matches = list(_CHAPTER_HEADING_RE.finditer(md))
    if not matches:
        return [("", md, 0)]


    if matches[0].start() > 0:
        chapters.append(("", md[:matches[0].start()], 0))

    for i, m in enumerate(matches):
        heading_line = m.group(0)
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(md)
        body = md[body_start:body_end]
        chapters.append((heading_line, body, m.start()))
    return chapters


def _chapter_title(heading_line: str) -> str:
    m = _CHAPTER_HEADING_RE.match(heading_line.strip())
    return m.group(1).strip() if m else heading_line.strip()


def _is_passthrough(title: str) -> bool:
    title_lower = title.lower()

    if any(kw in title_lower for kw in ["summary", "abstract", "appendix", "references", "bibliography"]):
        return True

    if any(kw in title for kw in ["摘要", "附录", "参考文献", "参考来源"]):
        return True
    return False




class ParagraphRewriteAgent:

    def __init__(
        self,
        cache_dir: Path | None = None,
        parallel: int = DEFAULT_PARALLEL,
        model: str = REWRITE_MODEL,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        topic: str | None = None,
        unchanged_titles: set[str] | None = None,
    ):
        self.cache_dir = cache_dir
        self.parallel = parallel
        self.model = model
        self.max_tokens = max_tokens
        self.topic = topic
        self._system_prompt = _format_system(topic)
        self.unchanged_titles = unchanged_titles or set()
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)



    def rewrite_markdown(self, md: str) -> tuple[str, dict]:
        chapters = _split_chapters(md)



        canonical_events = self._detect_canonical_chapters(chapters)
        if canonical_events:
            print("  [dedup] cross-chapter canonical-chapter map:")
            for event, primary in canonical_events.items():
                print(f"    • {event} → 主章节: {primary}")

        report = {
            "n_chapters": len(chapters),
            "n_passthrough": 0,
            "n_rewritten": 0,
            "n_cached": 0,
            "n_failed": 0,
            "n_short_no_summary": 0,
            "canonical_events": dict(canonical_events),
            "per_chapter": [],
        }


        tasks = []
        for idx, (heading, body, _) in enumerate(chapters):
            if not heading:

                tasks.append((idx, heading, body, "<preamble>", "passthrough"))
                continue
            title = _chapter_title(heading)
            if _is_passthrough(title):
                tasks.append((idx, heading, body, title, "passthrough"))
                continue


            if title in self.unchanged_titles:
                tasks.append((idx, heading, body, title, "passthrough_unchanged"))
                continue
            tasks.append((idx, heading, body, title, "rewrite"))


        results: dict[int, str] = {}
        rewrite_tasks = [(idx, heading, body, title)
                         for idx, heading, body, title, action in tasks
                         if action == "rewrite"]


        for idx, heading, body, title, action in tasks:
            if action in ("passthrough", "passthrough_unchanged"):
                results[idx] = (heading + body) if heading else body
                report["n_passthrough"] += 1
                report["per_chapter"].append({
                    "title": title,
                    "status": action,
                })


        to_call: list[tuple[int, str, str, str]] = []
        for idx, heading, body, title in rewrite_tasks:
            cached = self._read_cache(title, body, canonical_events)
            if cached is not None:
                results[idx] = heading + "\n" + cached + "\n"
                report["n_cached"] += 1
                report["per_chapter"].append({"title": title, "status": "cached"})
            else:
                to_call.append((idx, heading, body, title))


        if to_call:
            print(f"  [rewrite] LLM calls needed: {len(to_call)} (parallel={self.parallel})")
            with ThreadPoolExecutor(max_workers=self.parallel) as ex:
                fut_map = {
                    ex.submit(self._rewrite_chapter, title, body, canonical_events):
                        (idx, heading, body, title)
                    for (idx, heading, body, title) in to_call
                }
                for fut in as_completed(fut_map):
                    idx, heading, body, title = fut_map[fut]
                    try:
                        rewritten = fut.result()
                        results[idx] = heading + "\n" + rewritten + "\n"
                        report["n_rewritten"] += 1
                        if len(body) <= SHORT_CHAPTER_MAX_CHARS:
                            report["n_short_no_summary"] += 1
                        report["per_chapter"].append({"title": title, "status": "rewritten",
                                                       "len_in": len(body),
                                                       "len_out": len(rewritten),
                                                       "short": len(body) <= SHORT_CHAPTER_MAX_CHARS})
                        self._write_cache(title, body, rewritten, canonical_events)
                        print(f"    ✓ {title}  ({len(body)}→{len(rewritten)} chars)")
                    except Exception as e:
                        results[idx] = heading + body
                        report["n_failed"] += 1
                        report["per_chapter"].append({"title": title, "status": "failed",
                                                       "error": str(e)[:200]})
                        print(f"    ✗ {title}  {e}")


        ordered = [results[i] for i in sorted(results.keys())]
        return "".join(ordered), report



    def _detect_canonical_chapters(
        self, chapters: list[tuple[str, str, int]]
    ) -> dict[str, str]:


        candidates: dict[str, dict[str, int]] = {}
        bold_re = re.compile(r"\*\*([^*\n]{2,80}?)\*\*")
        for heading, body, _ in chapters:
            if not heading:
                continue
            title = _chapter_title(heading)
            if _is_passthrough(title):
                continue
            for m in bold_re.finditer(body):
                label = m.group(1).strip().rstrip(":：。，,;； ")
                if len(label) < DEDUP_MIN_LABEL_LEN:
                    continue

                label_lower = label.lower()
                if any(bk in label for bk in DEDUP_LABEL_BLACKLIST if not bk.islower()) or \
                   any(bk in label_lower for bk in DEDUP_LABEL_BLACKLIST if bk.islower()):
                    continue

                if len(label) > 60:
                    continue
                d = candidates.setdefault(label, {})
                d[title] = d.get(title, 0) + 1




        result: dict[str, str] = {}
        scored = []
        for label, ch_map in candidates.items():
            if len(ch_map) < DEDUP_MIN_CHAPTERS:
                continue
            total = sum(ch_map.values())
            scored.append((label, ch_map, total))

        scored.sort(key=lambda x: -x[2])
        for label, ch_map, _total in scored[:DEDUP_MAX_CANDIDATES]:

            main = max(ch_map.items(), key=lambda kv: kv[1])[0]
            result[label] = main
        return result



    def _cache_key(self, title: str, body: str,
                    canonical_events: dict[str, str] | None = None) -> str:




        ce_repr = json.dumps(canonical_events or {}, ensure_ascii=False,
                              sort_keys=True)
        composite = f"{PROMPT_VERSION}\n{ce_repr}\n{body}"
        h = hashlib.sha256(composite.encode("utf-8")).hexdigest()[:16]
        safe_title = re.sub(r"[^\w\u4e00-\u9fff]+", "_", title)[:40]
        return f"{safe_title}__{h}.md"

    def _read_cache(self, title: str, body: str,
                     canonical_events: dict[str, str] | None = None) -> str | None:
        if self.cache_dir is None:
            return None
        p = self.cache_dir / self._cache_key(title, body, canonical_events)
        if p.exists():
            return p.read_text(encoding="utf-8")
        return None

    def _write_cache(self, title: str, body: str, rewritten: str,
                      canonical_events: dict[str, str] | None = None):
        if self.cache_dir is None:
            return
        p = self.cache_dir / self._cache_key(title, body, canonical_events)
        p.write_text(rewritten, encoding="utf-8")



    @staticmethod
    def _build_dedup_hint(title: str, canonical_events: dict[str, str]) -> str:
        if not canonical_events:
            return ""
        other = []
        for event, primary in canonical_events.items():
            if primary == title:
                continue
            other.append(f"  - {event} → 主章节: 「{primary}」")
        if not other:
            return ""
        return (
            "\n\n【跨章节去重 — 重要】以下事件已在其他章节作为【主章节】详述. "
            "本章遇到这些事件时, **只用 1-2 句简短提及** (可附带 1-2 个最关键的数字), "
            "**不要再次完整展开**, 也**不要**手动加 '详见第X章' 之类的引文 — 读者会自然在主章节找到. "
            "如果本段几乎全部是这些事件, 大胆删减或移除整段:\n"
            + "\n".join(other)
        )

    def _rewrite_chapter(self, title: str, body: str,
                          canonical_events: dict[str, str] | None = None) -> str:
        canonical_events = canonical_events or {}


        if len(body) > CHAPTER_CHUNK_THRESHOLD:
            return self._rewrite_oversized_chapter(title, body, canonical_events)

        is_short = len(body) <= SHORT_CHAPTER_MAX_CHARS
        summary_directive = (
            "**本章节较短, 不要加 '**小结**:' 这一句, 仅做段落重写.**"
            if is_short else
            "章节末尾必须加一行 '**小结**: ...' (30-80 字, 仅基于本章节内事实)."
        )
        dedup_hint = self._build_dedup_hint(title, canonical_events)

        user_msg = (
            f"【章节标题】{title}\n\n"
            f"【章节原始内容】\n{body.strip()}\n"
            f"{dedup_hint}\n\n"
            "请按系统消息中的硬约束 + 可以做的事重写本章节, 输出重写后的 markdown 段落 "
            f"(可包含 **粗体小标题** 行); {summary_directive}"
        )
        rewritten = _call_llm(
            [
                {"role": "system", "content": self._system_prompt},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=self.max_tokens,
            model=self.model,
        )
        return self._postprocess(rewritten, title)

    def _rewrite_oversized_chapter(self, title: str, body: str,
                                     canonical_events: dict[str, str] | None = None) -> str:
        canonical_events = canonical_events or {}
        chunks = self._split_oversized_body(body)
        print(f"      [oversized] {title}: split into {len(chunks)} chunks "
              f"(total {len(body)} chars)")
        dedup_hint = self._build_dedup_hint(title, canonical_events)

        out_parts = []
        for i, chunk in enumerate(chunks, 1):
            is_last = (i == len(chunks))
            last_note = (
                "本段是该章节最后一段, 末尾必须加一行 '**小结**: ...' (30-80 字, "
                "仅基于本章节内事实)."
                if is_last else "本段不是最后一段, **不要**加小结句."
            )
            user_msg = (
                f"【章节标题】{title}\n"
                f"【说明】这是该章节的第 {i}/{len(chunks)} 段, "
                "已按主题切片. 请只重写这段, **不要**重复章节标题. "
                f"{last_note}{dedup_hint}\n\n"
                f"【本段原始内容】\n{chunk.strip()}\n\n"
                "请输出重写后的段落 (可包含 **粗体小标题** 行)."
            )
            rewritten = _call_llm(
                [
                    {"role": "system", "content": self._system_prompt},
                    {"role": "user", "content": user_msg},
                ],
                max_tokens=self.max_tokens,
                model=self.model,
            )
            out_parts.append(self._postprocess(rewritten, title))

        return "\n\n".join(p for p in out_parts if p.strip())

    @staticmethod
    def _split_oversized_body(body: str) -> list[str]:

        sub_re = re.compile(r"(?m)^\*\*[^*\n]+\*\*\s*$")
        sub_positions = [m.start() for m in sub_re.finditer(body)]

        target_chunks = max(2, (len(body) + CHAPTER_CHUNK_THRESHOLD - 1) // CHAPTER_CHUNK_THRESHOLD)



        if len(sub_positions) >= target_chunks:
            ideal_size = len(body) / target_chunks
            cuts = [0]
            next_target = ideal_size
            for pos in sub_positions[1:]:
                if pos >= next_target:
                    cuts.append(pos)
                    next_target = pos + ideal_size
            cuts.append(len(body))
            chunks = [body[cuts[i]:cuts[i + 1]] for i in range(len(cuts) - 1)]
            chunks = [c for c in chunks if c.strip()]
            if chunks:
                return chunks


        paras = re.split(r"\n{2,}", body)
        chunks = []
        cur = []
        cur_len = 0
        target_size = len(body) / target_chunks
        for p in paras:
            cur.append(p)
            cur_len += len(p) + 2
            if cur_len >= target_size:
                chunks.append("\n\n".join(cur))
                cur = []
                cur_len = 0
        if cur:
            chunks.append("\n\n".join(cur))
        return [c for c in chunks if c.strip()]

    @staticmethod
    def _postprocess(rewritten: str, title: str) -> str:
        rewritten = rewritten.strip()
        if rewritten.startswith("```"):
            lines = rewritten.split("\n")
            rewritten = "\n".join(lines[1:])
            if rewritten.endswith("```"):
                rewritten = rewritten[:-3].rstrip()
        first_line = rewritten.split("\n", 1)[0].strip()
        if first_line.startswith("## ") and title in first_line:
            rewritten = rewritten.split("\n", 1)[1] if "\n" in rewritten else ""
        return rewritten.strip()
