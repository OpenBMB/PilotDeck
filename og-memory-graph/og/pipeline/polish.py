
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

_ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parent.parent.parent)))
from og.cli._common import ScriptContext

try:
    import og.config.models
    from og.config.models import LLM_MAIN
    from og.config.models import patch_openai_for_reasoning_fallback
    patch_openai_for_reasoning_fallback()
except Exception:
    pass

from openai import OpenAI

DEFAULT_LLM = "deepseek-v4-flash"
SUFFIX = "polished7"
MAX_RETRY = 9
CONCURRENCY = 5



_VERSION_CANDIDATES = ["v9.0", "v8.0", "v7.0", "v6.0", "v5.0", "v4.0", "v3.0", "v2.0", "v1.0"]
_HEADER_RE = re.compile(r"^(#{1,6})\s+")

_META_PATTERNS = [
    re.compile(r"^\s*我们分析一下任务", re.M),
    re.compile(r"^\s*约束(?:很多|如下|列表)", re.M),
    re.compile(r"^\s*以下是(?:打磨|重写|修改|优化)后", re.M),
    re.compile(r"^\s*\(0\)", re.M),
    re.compile(r"^\s*\(1\)", re.M),
    re.compile(r"^\s*\(2\)", re.M),
    re.compile(r"^\s*\(3\)", re.M),
    re.compile(r"^\s*\(4\)", re.M),
    re.compile(r"^\s*\(5\)", re.M),
    re.compile(r"^\s*任务说明", re.M),
    re.compile(r"^\s*输出格式[：:]", re.M),
    re.compile(r"\[CUT-OFRANGE", re.I),
    re.compile(r"\[CUT:", re.I),
    re.compile(r"^\s*#\s+\[?说明", re.M),
]


POLISH6_PROMPT = """\
你是一位资深研究主编, 现在手上有 1 份"调研报告 (balanced 版)", 你的任务是基于它, **围绕给定研究主题, 重新组织成 1 篇干净的、主题聚焦的最终报告**.

────────────────────────
【研究主题 — 报告的唯一中心】
────────────────────────
{topic}

【时间窗参考 (来自 cluster_config.task_year_range)】
{range_start} - {range_end}

────────────────────────
【balanced 报告原文 — {balanced_chars} 字符 (仅作信息密度参考)】
────────────────────────

ℹ️ balanced 报告 {balanced_chars} 字符. 这份报告的价值是"信息密度", 不是"精炼".

**字符数硬下限: 重写后报告字符数必须 ≥ {min_chars} 字符 (即 balanced 的 30%).**
**低于 30% 视为"过度压缩", 直接不合格, 必须重写到 ≥ 30%.**
**目标区间: balanced 的 30% - 60%. 低于 30% = 不及格; 高于 60% = 信息冗余.**

如何达到 30% 下限 (具体方法, 不是堆字数, 是补内容):
  · 多保留 balanced 里 1-2 句话就能讲清的具体事件 (年份/日期/人物/机构/型号/数字);
  · 多保留 1-2 个表格 (历史事件表 / 关键人物表 / 数据对比表);
  · 每个 ## 章节 3-6 段, 每段 3-5 行, 不要 1 段就讲完;
  · 涉及"对比/演变/分类"的内容, 用表格列出 3-5 行;
  · [研判] / [对比] 两段至少 3-5 行, 包含具体数字和事件;
  · 引用列表保留 balanced 中所有 [N] 编号引用, 不删.

什么算"过度压缩" (必须避免的反面教材):
  · balanced 里的具体事件/日期/数字被你"1 句话带过", 数据没了;
  · balanced 里的多组同类数据被你合并成"近 N 年来…, 出现了…";
  · balanced 里的引用编号 [N] 被你直接删掉, 不出现在文末;
  · 章节从 balanced 的 6+ 个被你压到 2-3 个;
  · 表格被你去掉, 改成 1 段文字描述;
  · 写完后字数为 balanced 的 5-15%.

────────────────────────
【重写要求 — 必须全部满足】
────────────────────────

(核心) 把 balanced 当作"素材库", 不要保留 balanced 的章节顺序或章节标题.
      按主题逻辑重新组织 (主题 → 关键事实/数据/事件 → 分析 → 结尾).
      报告标题由你根据【研究主题】拟定, 不沿用 balanced 的标题.
      章节数你自由组织 (不限, 主题需要多少就多少).

(主题聚焦) 跟【研究主题】直接相关的内容, 是报告主体.
            跟主题弱关联的, 合并到主题段, 不单独成段.
            跟主题无关的 (无论时间窗内外), 整段删除 — 不保留不解释不标 [CUT].

(去重)    同一事件/数据/论述, 全文只许出现 1 次; 重复出现的, 合并/删除次要,
         保留处可写"详见第 X 节".

(信息密度) 详细数据/具体事件/数字, 全部保留;
         这份报告的价值是"信息密度", 不是"精炼".
         balanced 中 90%+ 的具体数据/事件/日期/数字, 都要写进新报告.

(不严删窗口外) 时间窗是参考, 不是硬约束.
              窗口外但对理解主题有用的, 可作为"前史/锚点/对照"保留, 1 段以内.
              但窗口外内容不能成为某章主体.

(可读性)  段落建议 ≤ 4 行; 引用统一放文末;
         关键数据 (≥ 3 个数字) 改 markdown 表格;
         标题层级 ≤ 3 级 (不出现 H4+).

(可读性 - 表格)  同一维度的多项数据 (如: 多场比赛/多位球员/多年数据), 优先用表格.

(洞察 — 硬要求) 报告末尾 (参考文献之前), 补 2 段:
         · [研判] 趋势/因果/拐点/取代关系 (含 1 个数字或 1 个时点)
         · [对比] 横向对比 (含 1 个具体反例或具体对手)
         必须以 "[研判]" / "[对比]" 开头, 不要用 "##" 标题, 直接接正文段落.
         这 2 段必须有, 不允许省略.

(唯一 H1) 整篇报告只许 1 个 # 标题. 多个 H1 自动降级为 H2.

────────────────────────
【3 通用原则 (p6 新增 — 主题无关, 适用于任何研究主题)】
────────────────────────

① 数据点保留 (Data preservation):
   balanced 报告里所有明确写出的**具体数据 / 事件 / 数字 / 日期 / 名称 / 人名 / 机构名 / 版本号 / 型号 / 比分 / 排名 / 引用编号**,
   重写时**必须完整保留**, 不允许因精简/排版/改写等任何原因删除.
   "压缩"只允许发生在: 解释性铺陈、过渡句、形容词、副词;
   任何硬数据 (数字/日期/名字/事件) 都不许丢.
   如果你认为某个数据点不重要, 不要删除它, 而是用 1 句话带过, 仍然保留原数据.

② 时间明示 (Time scope declaration):
   报告开头 (在 # 标题之后, 第一个 ## 章节之前) 必须有 1 个**元信息块**, 2-3 行, 显式写出:
   · 覆盖时间范围 (从 … 到 …)
   · 主要事件/数据最新时点 (引用 1 个最晚的日期/事件作为"截止锚")
   · balanced 报告中明引用的关键资料数 (如 "参考 balanced 报告 4 大节" 或 "引用 N 条原始资料")
   这一段**不算正式章节**, 不需要 ## 标题, 但必须有, 不许省略.

③ 一致性自检 (Consistency check):
   写完后, **通读一遍**全文, 确保:
   · 同一事件/数据点, 全文表述的日期/数字/名字前后一致;
   · 不出现 "刚说 2024, 下一段说 2025" 或 "上一段说 2025 冠军, 下一段说 2026 冠军";
   · 不混淆相邻年份 (如 2025/2026, 2024/2025);
   · 不混淆同一时点的不同说法 (如 "5 月" vs "6 月", "Q3" vs "Q4").
   发现矛盾, 必须修改后再输出.

────────────────────────
【子项强约束 (p6 新增 — 解决漏报子项)】
────────────────────────

(子项提取) 在动笔前, **从【研究主题】中** 拆出 3-7 个**子项** (e.g. 子领域 / 子类别 / 子主体 / 子时段).
         主题里出现的每个并列名词/每个并列项目/每个并列时段, 都是一个子项.
         拆完后, 在心里 (不必显式输出) 逐项问: "这一项, balanced 报告里有没有? 我重写时有没有覆盖?"

(子项覆盖) 报告**必须覆盖**主题里**所有**并列子项.
         如果某个子项在 balanced 报告里**完全没有** (e.g. 主题说 "覆盖 A B C D", 但 balanced 只写 A B C):
            · **不**编造不存在的 D 数据;
            · 仍然**在报告里留 1 个小节/段**说 "D: 本期未观察到独立数据/事件, 与 A/B/C 暂无强关联"
              这样评审能 100% 知道你没漏, 而是"主题里有但本期 balanced 没数据".
         如果某子项在 balanced 报告里**有**但你重写时漏了: **必须**补回, 不许漏.

(子项自查) 写完后, 在 [研判] 段之前, 加 1 段"覆盖说明" (2-3 行):
         "本报告覆盖主题子项: [列出 3-7 个子项, 用 · 分隔]. 其中 X 项因 balanced 报告无数据, 仅作占位说明, 其余 N 项已覆盖."
         这段**不是正式 H2 章节**, 不需要 ## 标题; 放在 [研判] 段之前.

────────────────────────
【绝对禁止 — 输出任何这些就是失败, 必须重写】
────────────────────────

1. 禁止任何"思考/解释/约束回顾"文字, 包括但不限于:
   · "我们分析一下任务..."
   · "约束很多, 需要..."
   · "以下是重写后内容"
   · "任务说明" / "输出格式" / "打磨要求" 等标题段
   · "(0)(1)(2)(3)(4)(5)" 这种段落编号
   · "本指令优先级..."
   · "────────────────────────" 等分隔线

2. 禁止任何"待删"标记: [CUT-OFRANGE] / [CUT: ...] / [删除] 等.

3. 禁止"假标题"章节: "## 说明" / "## 概述" / "## 引言" (除非里面真有内容).

4. 禁止在报告里引用"约束"或"上一版"或"balanced" — 报告是独立的最终稿.

────────────────────────
【输入 — balanced 报告全文 ({balanced_chars} 字符)】
────────────────────────
{balanced_text}

────────────────────────
【输出格式 — 严格】
────────────────────────
- 直接以 `# <你的报告标题>` 开始
- 紧接 2-3 行**元信息块** (覆盖时间范围 + 主要事件最新时点 + 参考资料数) — 不算正式章节
- 用 H2 (##) 分章节
- 在 [研判] 段之前, 加 1 段"覆盖说明" (列出主题子项 + 标注哪些有数据哪些占位)
- 末尾写 [研判] + [对比] 两段 (按上面要求, 硬要求)
- 文末引用列表 (## 引用 或 "---" 之后)
- 任何说明性文字, 全部省略
"""


def detect_version(cluster_output_dir: Path) -> str | None:
    for v in _VERSION_CANDIDATES:
        p = cluster_output_dir / f"output_report_{v}_balanced.md"
        if p.exists():
            return v
    return None


def load_cluster_config(cluster: str) -> tuple[str, tuple[int | None, int | None]]:
    cfg_path = _ROOT / "data" / "clusters" / cluster / "cluster_config.json"
    if not cfg_path.exists():
        return ("", (None, None))
    try:
        d = json.loads(cfg_path.read_text(encoding="utf-8"))
    except Exception:
        return ("", (None, None))
    topic = d.get("topic", "") or ""
    rng = d.get("task_year_range", []) or []
    if isinstance(rng, list) and len(rng) == 2:
        try:
            return topic, (int(rng[0]), int(rng[1]))
        except Exception:
            return topic, (None, None)
    return topic, (None, None)


def make_client():

    api_key = (os.environ.get("LLM_API_KEY")
               or os.environ.get("OPENAI_API_KEY", "EMPTY"))
    base_url = (os.environ.get("LLM_BASE_URL")
                or os.environ.get("OPENAI_API_BASE", "http://localhost:8000/v1"))

    return OpenAI(api_key=api_key, base_url=base_url, timeout=240.0)


def call_llm(client, model: str, prompt: str, max_tokens: int = 16000,
             temperature: float = 0.3, timeout: float = 480.0) -> str:
    r = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=max_tokens,
        temperature=temperature,
        timeout=timeout,
    )
    msg = r.choices[0].message
    return (msg.content or "").strip() or (getattr(msg, "reasoning_content", "") or "").strip()


def strip_meta(text: str) -> tuple[str, dict]:
    notes = {"meta_paragraphs_dropped": 0, "cut_markers_stripped": 0}

    paragraphs = re.split(r"(\n\s*\n)", text)
    cleaned: list[str] = []
    drop_n = 0
    for p in paragraphs:
        if any(pat.search(p) for pat in _META_PATTERNS):
            drop_n += 1
            continue
        cleaned.append(p)
    if drop_n:
        notes["meta_paragraphs_dropped"] = drop_n
        text = "".join(cleaned)

    for pat in (re.compile(r"\[CUT-OFRANGE[^\]]*\]", re.I),
                re.compile(r"\[CUT[^\]]*\]", re.I),
                re.compile(r"\[删除\]", re.I)):
        n = len(pat.findall(text))
        if n:
            notes["cut_markers_stripped"] += n
            text = pat.sub("", text)


    h1_count = 0
    new_lines: list[str] = []
    for ln in text.split("\n"):
        m = re.match(r"^#\s+(.+?)\s*$", ln)
        if m:
            h1_count += 1
            if h1_count > 1:
                ln = "## " + m.group(1)
        new_lines.append(ln)
    text = "\n".join(new_lines)

    return text, notes





_SPECIAL_PATTERNS = [
    re.compile(r"^参考(文献|资料|引用|引文)"),
    re.compile(r"^引文(列表|总览)?"),
    re.compile(r"^附(录|件|表)"),
    re.compile(r"^综合趋势分析"),
    re.compile(r"^数据(来源|汇总|表)"),
    re.compile(r"^脚注"),
    re.compile(r"^致谢"),
]


def _is_special_chapter(title: str) -> bool:
    title_clean = title.strip()
    for pat in _SPECIAL_PATTERNS:
        if pat.search(title_clean):
            return True
    return False


def split_into_chapters(md_text: str) -> list[dict]:
    lines = md_text.split("\n")
    chapters: list[dict] = []
    cur_h1: list[str] = []
    cur_title = ""
    cur_body: list[str] = []
    cur_idx = 0
    in_h1 = True

    def flush_chapter():
        nonlocal cur_idx, cur_title, cur_body, in_h1
        if cur_title or cur_body:
            content = "\n".join(cur_body).rstrip()
            if content or cur_title:
                chapters.append({
                    "idx": cur_idx,
                    "title": cur_title,
                    "content": content,
                    "special": _is_special_chapter(cur_title),
                })
                cur_idx += 1
        cur_title = ""
        cur_body = []

    for line in lines:
        m_h1 = re.match(r"^#\s+(.+?)\s*$", line)
        m_h2 = re.match(r"^##\s+(.+?)\s*$", line)
        if m_h2:
            flush_chapter()
            cur_title = m_h2.group(1).strip()
            in_h1 = False
        elif m_h1:

            cur_h1.append(line)
            in_h1 = True
        else:
            if in_h1:
                cur_h1.append(line)
            else:
                cur_body.append(line)
    flush_chapter()


    if cur_h1 and chapters:
        preface = "\n".join(cur_h1).rstrip()
        chapters[0]["content"] = preface + "\n\n" + chapters[0]["content"]

    return chapters




def extract_citations(text: str) -> set[str]:
    urls = set(re.findall(r'https?://[^\s\)\]\}\>,;]+', text))
    refs: set[str] = set()
    for m in re.finditer(r'\[([^\[\]]+)\]', text):
        inner = m.group(1).strip()

        if re.match(r'^\d+(?:[-,]\s*\d+)*$', inner):
            for piece in inner.split(','):
                piece = piece.strip()
                if '-' in piece:
                    a, b = piece.split('-', 1)
                    a_i, b_i = int(a.strip()), int(b.strip())
                    for n in range(a_i, b_i + 1):
                        refs.add(str(n))
                else:
                    refs.add(piece)
            continue

        if re.match(r'^ref[_-]?\d+', inner, re.I):
            refs.add(inner)
            continue
    return urls | refs




SUBTOPIC_A_PROMPT = """\
你是一位资深研究主编. 你的任务是从"研究主题"字符串中, 拆出 5-12 个**并列子项**.

────────────────────────
【研究主题】
────────────────────────
{topic}

────────────────────────
【要求】
────────────────────────

1. 主题里出现的每个并列名词/每个并列项目/每个并列时段, 都是一个子项.
2. 拆 5-12 个, 不要少于 5 个也不要超过 12 个.
3. 每个子项**简短** (4-12 字), 不带"等" "等等" "相关" 这种模糊词.
4. 子项之间**互不重叠**, 粒度大致一致.
5. 输出**严格 JSON 数组**, 不要任何其他文字/解释/思考过程.

────────────────────────
【输出格式 — 严格 JSON】
────────────────────────
["子项1", "子项2", "子项3", ...]
"""


def extract_subtopics(client, model: str, topic: str, max_tokens: int = 1000,
                      temperature: float = 0.2) -> list[str]:
    prompt = SUBTOPIC_A_PROMPT.format(topic=topic or "(未指定)")
    out = call_llm(client, model, prompt, max_tokens=max_tokens,
                   temperature=temperature)


    candidates: list[str] = []
    for m in re.finditer(r'\[\s*"', out):
        start = m.start()

        depth = 0
        end = -1
        for i in range(start, len(out)):
            if out[i] == '[':
                depth += 1
            elif out[i] == ']':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        if end > start:
            candidates.append(out[start:end])


    for cand in candidates:
        try:
            arr = json.loads(cand)
            if isinstance(arr, list) and len(arr) > 0 and all(isinstance(x, str) for x in arr):
                return [str(x).strip() for x in arr if str(x).strip()]
        except Exception:
            continue
    return []




SUBTOPIC_B_PROMPT = """\
你是一位资深研究主编. 你的任务是评估: 给定一组"子项", 某篇报告中每个子项的**覆盖度**.

覆盖度评分标准:
  2 = 详细覆盖 (有独立章节或多个段落展开)
  1 = 简短带过 (一句话或一个表格提及)
  0 = 未覆盖 (报告里完全没提到这个子项)

────────────────────────
【子项列表 (来自主题拆解)】
────────────────────────
{subtopics}

────────────────────────
【报告章节标题 (H2/H3)】
────────────────────────
{headings}

────────────────────────
【报告全文】
────────────────────────
{report_text}

────────────────────────
【输出格式 — 严格 JSON】
────────────────────────
{{
  "子项1": 0|1|2,
  "子项2": 0|1|2,
  ...
}}

只输出 JSON, 不输出其他文字.
"""


def eval_coverage(client, model: str, subtopics: list[str], headings: list[str],
                  report_text: str, max_tokens: int = 2000,
                  temperature: float = 0.2) -> dict[str, int]:
    if not subtopics:
        return {}
    prompt = SUBTOPIC_B_PROMPT.format(
        subtopics="\n".join(f"- {s}" for s in subtopics),
        headings="\n".join(headings[:30]) if headings else "(无 H2/H3 标题)",
        report_text=report_text[:60000],
    )
    out = call_llm(client, model, prompt, max_tokens=max_tokens,
                   temperature=temperature)

    m = re.search(r'\{[^{}]*\}', out, re.S)
    if not m:

        m = re.search(r'\{.*?\}', out, re.S)
    if not m:
        return {s: 0 for s in subtopics}
    try:
        d = json.loads(m.group(0))
        return {s: int(d.get(s, 0)) for s in subtopics}
    except Exception:
        return {s: 0 for s in subtopics}


def map_subtopics_to_chapters(subtopics: list[str], coverage: dict[str, int],
                              chapters: list[dict]) -> dict[int, list[str]]:
    mapping: dict[int, list[str]] = {i: [] for i in range(len(chapters))}
    for sub in subtopics:
        placed = False
        sub_lower = sub.lower()
        for ch in chapters:
            content_lower = ch["content"].lower()
            title_lower = ch["title"].lower()
            if sub_lower in content_lower or sub_lower in title_lower:
                mapping[ch["idx"]].append(sub)
                placed = True
        if not placed:

            if chapters:
                mapping[chapters[0]["idx"]].append(sub)
    return mapping





POLISH7_CHAPTER_PROMPT = """\
你是一位资深研究主编. 现在你手上有 1 份"调研报告 (balanced 版) 的 **单个 H2 章节**", 你的任务是**重写这个章节**, 围绕给定的【研究主题】和该章节涉及的【子项】, 输出干净的、信息密度高的章节内容.

────────────────────────
【研究主题 — 报告的唯一中心】
────────────────────────
{topic}

【时间窗参考 (来自 cluster_config.task_year_range)】
{range_start} - {range_end}

────────────────────────
【该章节涉及的子项 (覆盖度)】
────────────────────────
{chapter_subtopics}

────────────────────────
【balanced 原章节 ({chapter_chars} 字符)】
────────────────────────
{chapter_text}

────────────────────────
【重写要求 — 必须全部满足】
────────────────────────

(核心) 围绕【研究主题】重写该章节, 保留核心论点和数据.
       章节标题可以重命名, 但**子标题层级 ≤ 3 级** (不出现 H4+).
       保持章节内 H3 小节的有序, 不要删除 H3 (除非该 H3 真的与主题无关).

(主题聚焦) 跟【研究主题】直接相关的内容, 是章节主体.
           跟主题弱关联的, 合并到主题段, 不单独成段.
           跟主题无关的 (无论时间窗内外), 整段删除 — 不保留不解释不标 [CUT].

(子项覆盖) 该章节涉及的子项, **全部覆盖**.
           · 如果某子项在原章节里**完全没有**: 在章节内**留 1-2 句话**说明 "{{子项}}: 本节未观察到独立数据" (不编造数据).
           · 如果某子项在原章节里**有**但你重写时漏了: 找回来, 不许漏.

(去重)    同一事件/数据/论述, 章节内只许出现 1 次; 重复出现的, 合并/删除次要.

(信息密度) 详细数据/具体事件/数字, 全部保留;
           balanced 中该章节 90%+ 的具体数据/事件/日期/数字, 都要写进新章节.

(不严删窗口外) 时间窗是参考, 不是硬约束.
              窗口外但对理解主题有用的, 可作为"前史/锚点/对照"保留, 1 段以内.
              但窗口外内容不能成为某章主体.

(可读性)  段落建议 ≤ 4 行; 关键数据 (≥ 3 个数字) 改 markdown 表格;
         标题层级 ≤ 3 级.

(可读性 - 表格)  同一维度的多项数据, 优先用表格.

(字符数硬下限) 章节输出字符数 **必须 ≥ balanced 该章节的 30%** (硬下限).
              低于 30% 视为"过度压缩", 不及格, 必须重写.
              目标区间: balanced 该章节的 30% - 60%.
              如何达到: 多保留具体事件/数字/日期/名字; 多保留 1-2 个表格.

(引用格式) balanced 章节里的所有 [N] 引用编号必须保留; 不允许新增引用, 不允许编造引用.
          (引用重新编号由后续全文重写阶段统一处理, 你只需保留原编号.)

(数据点保留) balanced 章节里所有明确写出的**具体数据 / 事件 / 数字 / 日期 / 名称 / 人名 / 机构名 / 版本号 / 型号 / 比分 / 排名 / 引用编号**,
          重写时**必须完整保留**, 不允许因精简/排版等任何原因删除.

(一致性自检) 写完后, 通读一遍, 确保日期/数字/名字前后一致; 不混淆相邻年份.

────────────────────────
【绝对禁止 — 输出任何这些就是失败, 必须重写】
────────────────────────

1. 禁止任何"思考/解释/约束回顾"文字, 包括但不限于:
   · "我们分析一下任务..." / "约束很多, 需要..." / "以下是重写后内容"
   · "任务说明" / "输出格式" / "打磨要求" 等标题段
   · "(0)(1)(2)..." 段落编号 / "本指令优先级..."

2. 禁止任何"待删"标记: [CUT-OFRANGE] / [CUT: ...] / [删除] 等.

3. 禁止在章节里引用"约束"或"上一版"或"balanced" — 章节是独立的最终稿.

4. **禁止**输出 H1 (#) 标题 (那是全文阶段的事); 你只输出 ## 章节标题 + 内容.

5. **禁止**输出末尾 [研判]/[对比] 双段 (那是全文阶段的事); 只输出章节主体内容.

6. **禁止**输出元信息块 (那是全文阶段的事).

────────────────────────
【输出格式 — 严格】
────────────────────────
- 以 `## <你的章节标题>` 开始
- 紧接章节主体内容 (可以包含 ### H3 小节, 表格, 段落)
- 文末引用编号 [N] 保留原 balanced 章节的编号
- 不输出 # H1, 不输出 [研判]/[对比], 不输出元信息块
- 任何说明性文字, 全部省略
"""


def build_chapter_prompt(topic: str, time_range: tuple[int | None, int | None],
                         chapter: dict, chapter_subtopics: list[str]) -> tuple[str, int]:
    rs, re_ = time_range
    rs_s = str(rs) if rs else "未指定"
    re_s = str(re_) if re_ else "未指定"
    chapter_text = chapter["content"]
    chapter_chars = len(chapter_text)
    subtopics_str = "\n".join(f"- {s}" for s in chapter_subtopics) if chapter_subtopics else "(本章节无明确子项)"
    prompt = POLISH7_CHAPTER_PROMPT.format(
        topic=topic or "(未指定)",
        range_start=rs_s, range_end=re_s,
        chapter_subtopics=subtopics_str,
        chapter_text=chapter_text,
        chapter_chars=chapter_chars,
    )
    return prompt, chapter_chars








PROTECTION_SUFFIX = """

────────────────────────
【⚠️ 保护语 (polished7 全文阶段) — 必须遵守】
────────────────────────

你本次的输入是 **balanced 报告** (与 polished6 完全相同).
**【研究主题】** = {topic}, 请围绕它做整体结构优化.

本次重写与 polished6 的**唯一区别**是: 子主题覆盖要求更严格.

【必须覆盖的子主题 (来自主题拆解)】
{subtopics}

要求:
  · 上述每个子主题都必须在正文中**至少有一段** (或表格行) 明确讨论.
  · 若某子主题在 balanced 中**完全没有数据**: 在报告合适位置**留 1-2 句话**说明 "<子主题>: 本报告未观察到独立数据" (不要编造数据).
  · 不允许任何子主题被整体删除.
  · 数据点 (具体事件/数字/日期/名字) 必须保留, 不要在结构优化中丢失.

【引用规则】
  · 只允许使用 balanced 中**已经出现**的 [N] 引用编号, 不允许新增/编造引用.
  · 允许重新连续编号 [1]-[N], 但语义必须对应.

【结构要求 — 与 polished6 完全相同】
  · 唯一 # H1 标题
  · 2-3 行元信息块
  · 末尾 [研判] + [对比] 双段 (各 3-5 行, 含具体数字/事件)

【字符数 — 软警告】
  · 目标 ≥ balanced 30% (即 ≥ {min_chars} 字符).
  · 这是**软建议**, 不是硬约束; 实际经验是 LLM 输出常 < 30%, 请尽量保信息密度, 不要过度压缩.
"""


def build_finalize_prompt(topic: str, time_range: tuple[int | None, int | None],
                          balanced_text: str, balanced_chars: int,
                          subtopics: list[str]) -> str:
    rs, re_ = time_range
    rs_s = str(rs) if rs else "未指定"
    re_s = str(re_) if re_ else "未指定"
    min_chars = int(balanced_chars * 0.30)
    subtopics_str = "\n".join(f"- {s}" for s in subtopics) if subtopics else "(未抽取)"

    base_prompt = POLISH6_PROMPT.format(
        topic=topic or "(未指定)",
        range_start=rs_s, range_end=re_s,
        balanced_text=balanced_text,
        balanced_chars=balanced_chars,
        min_chars=min_chars,
    )
    suffix = PROTECTION_SUFFIX.format(topic=topic or "(未指定)",
                                      subtopics=subtopics_str,
                                      min_chars=min_chars)
    return base_prompt + suffix




def verify_p7(p7_text: str, balanced_text: str, polished6_v3_text: str | None = None) -> dict:
    checks: dict = {}


    bal_cites = extract_citations(balanced_text)
    p7_cites = extract_citations(p7_text)
    new_cites = p7_cites - bal_cites
    checks["citations_subset"] = {
        "ok": len(new_cites) == 0,
        "msg": f"p7_cites={len(p7_cites)}, balanced={len(bal_cites)}, new={len(new_cites)}",
        "new_citations": sorted(new_cites)[:10],
    }


    bal_chars = len(balanced_text)
    min_chars = int(bal_chars * 0.30)
    p7_chars = len(p7_text)
    checks["char_min_30pct"] = {
        "ok": p7_chars >= min_chars,
        "msg": f"p7={p7_chars}, balanced={bal_chars}, min={min_chars}",
        "ratio": round(p7_chars / bal_chars, 3) if bal_chars > 0 else 0,
        "soft": True,
    }


    h1_count = len(re.findall(r"^# .+$", p7_text, re.M))
    checks["single_h1"] = {
        "ok": h1_count == 1,
        "msg": f"H1 count = {h1_count}, must be 1",
    }


    has_yanpan = "[研判]" in p7_text.split("\n## 引用")[0]
    has_duibai = "[对比]" in p7_text.split("\n## 引用")[0]
    checks["yanpan_duibai"] = {
        "ok": has_yanpan and has_duibai,
        "msg": f"研判={'✓' if has_yanpan else '✗'} 对比={'✓' if has_duibai else '✗'}",
    }


    fail_count = sum(1 for c in checks.values() if not c["ok"] and not c.get("soft"))
    return {
        "pass": fail_count == 0,
        "checks": checks,
        "fail_count": fail_count,
    }




def main(argv: list[str] | None = None) -> int:
    ctx = ScriptContext("_polished7_rewrite", argv, need_log=True, need_model=True)
    ap = ctx.ap
    ap.add_argument("--balanced", default=None)
    ap.add_argument("--version", default=None)
    ap.add_argument("--max-tokens", type=int, default=16000)
    ap.add_argument("--max-tokens-chapter", type=int, default=8000)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-strip", action="store_true")
    ap.add_argument("--temperature", type=float, default=0.3)
    ap.add_argument("--skip-subtopics", action="store_true",
                    help="跳过子主题抽取 (调试用)")
    ap.add_argument("--skip-chapter-rewrite", action="store_true",
                    help="跳过章节级重写 (直接用 balanced 当 polished6_v3, 调试用)")
    ap.add_argument("--skip-finalize", action="store_true",
                    help="跳过全文重写 (只输出 polished6_v3, 调试用)")
    args, paths, logger = ctx.parse(argv)

    cluster = args.cluster
    out_dir = paths.cluster_output(cluster)

    ver = args.version or detect_version(out_dir)
    if not ver:
        logger.error(f"找不到 balanced 报告, 目录: {out_dir}")
        return 1
    logger.info(f"使用版本: {ver}, 变体: balanced → {SUFFIX}")

    balanced_path = Path(args.balanced) if args.balanced else (
        out_dir / f"output_report_{ver}_balanced.md")
    polished7_path = out_dir / f"output_report_{ver}_{SUFFIX}.md"
    intermediate_dir = out_dir / "_polished7"
    intermediate_dir.mkdir(parents=True, exist_ok=True)
    chapter_paths: list[Path] = []
    v3_path = intermediate_dir / "polished6_v3.md"

    if not balanced_path.exists():
        logger.error(f"balanced 报告不存在: {balanced_path}")
        return 1

    balanced_text = balanced_path.read_text(encoding="utf-8")
    topic, time_range = load_cluster_config(cluster)
    balanced_chars = len(balanced_text)
    logger.info(f"cluster={cluster}  topic='{topic[:60]}'  range={time_range}  "
                f"balanced_chars={balanced_chars}")

    if args.dry_run:
        chapters = split_into_chapters(balanced_text)
        logger.info(f"  balanced: {balanced_path}")
        logger.info(f"  out:      {polished7_path}")
        logger.info(f"  topic:    {topic}")
        logger.info(f"  range:    {time_range}")
        logger.info(f"  balanced_chars: {balanced_chars}")
        logger.info(f"  h2 章节数: {len(chapters)}")
        for ch in chapters:
            logger.info(f"    [{ch['idx']}] ## {ch['title']} ({len(ch['content'])} chars)")
        return 0

    client = make_client()

    try:
        from og.config.models import LLM_MAIN as _LLM_MAIN
        model = _LLM_MAIN or DEFAULT_LLM
    except Exception:
        model = os.environ.get("LLM_MAIN", DEFAULT_LLM)

    if "minimax" in model.lower():
        logger.warning(f"  ⚠️  检测到 minimax-* 模型 {model!r}, 强制改用 deepseek-v4-pro")
        model = "deepseek-v4-pro"
    logger.info(f"  LLM model = {model}")


    subtopics_path = paths.outputs / "polish_diagnostics" / cluster / "_subtopics.json"
    subtopics_path.parent.mkdir(parents=True, exist_ok=True)

    if args.skip_subtopics:
        subtopics = []
        coverage: dict[str, int] = {}
        logger.info("⚠️ 跳过子主题抽取 (--skip-subtopics)")
    else:
        logger.info("=" * 60)
        logger.info("Step 1: 任务 A — topic 拆解")
        subtopics = extract_subtopics(client, model, topic)
        logger.info(f"  拆出 {len(subtopics)} 个子项: {subtopics}")

        logger.info("Step 2: balanced H2/H3 抽取 (规则)")
        chapters_for_subtopic = split_into_chapters(balanced_text)
        headings = []
        for ch in chapters_for_subtopic:
            headings.append(f"## {ch['title']}")
            for h3 in re.findall(r"^###\s+(.+?)$", ch["content"], re.M):
                headings.append(f"  ### {h3}")

        logger.info(f"Step 3: 任务 B — 覆盖度评估 (共 {len(headings)} 个标题)")
        coverage = eval_coverage(client, model, subtopics, headings, balanced_text)
        cov_str = ", ".join(f"{s}={coverage.get(s, 0)}" for s in subtopics)
        logger.info(f"  覆盖度: {cov_str}")


        subtopics_data = {
            "cluster": cluster,
            "topic": topic,
            "subtopics": subtopics,
            "coverage": coverage,
            "headings": headings,
        }
        subtopics_path.write_text(json.dumps(subtopics_data, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
        logger.info(f"  子主题已存: {subtopics_path}")


    chapters = split_into_chapters(balanced_text)
    if not chapters:
        logger.error("balanced 报告没有 H2 章节, 无法进行章节级重写")
        return 1
    logger.info(f"=" * 60)
    logger.info(f"Step 4: 章节级重写 (共 {len(chapters)} 个 H2 章节, 并发={CONCURRENCY})")

    if args.skip_chapter_rewrite:
        logger.info("⚠️ 跳过章节级重写, 直接用 balanced 当 polished6_v3")
        chapter_outputs = [ch["content"] for ch in chapters]
    else:

        subtopic_to_chapter: dict[int, list[str]] = {i: [] for i in range(len(chapters))}
        for sub in subtopics:
            placed = False
            sub_lower = sub.lower()
            for ch in chapters:
                content_lower = ch["content"].lower()
                title_lower = ch["title"].lower()
                if sub_lower in content_lower or sub_lower in title_lower:
                    subtopic_to_chapter[ch["idx"]].append(sub)
                    placed = True
            if not placed and chapters:
                subtopic_to_chapter[chapters[0]["idx"]].append(sub)

        def rewrite_chapter(ch: dict) -> tuple[int, str, str]:

            if ch.get("special"):
                logger.info(f"  [章{ch['idx']}] {ch['title']}: 特殊章节, 跳过重写")
                return (ch["idx"], ch["title"], ch["content"])

            chapter_subs = subtopic_to_chapter.get(ch["idx"], [])
            prompt, chapter_chars = build_chapter_prompt(topic, time_range, ch, chapter_subs)
            min_chars = int(chapter_chars * 0.30)
            last_err = ""
            out = ""
            for attempt in range(MAX_RETRY + 1):
                try:
                    out = call_llm(client, model, prompt,
                                   max_tokens=args.max_tokens_chapter,
                                   temperature=args.temperature)
                    out, _ = strip_meta(out) if not args.no_strip else (out, {})
                    break
                except Exception as e:
                    last_err = f"LLM 异常: {e}"
                    logger.warning(f"  [章{ch['idx']}] {ch['title']}: 尝试 {attempt+1}/{MAX_RETRY+1}, {last_err}")
                    out = ""
            if not out:

                logger.error(f"  [章{ch['idx']}] {ch['title']}: LLM 异常 {MAX_RETRY+1} 次, 返回原章节 ({len(ch['content'])} chars). 最后错误: {last_err}")
                return (ch["idx"], ch["title"], ch["content"])
            if len(out) < min_chars:

                logger.warning(f"  [章{ch['idx']}] {ch['title']}: 字符数 {len(out)} < 软下限 {min_chars} ({len(out)/min_chars*100:.0f}%), 仍采用 LLM 输出 (按用户约定)")
            return (ch["idx"], ch["title"], out)

        chapter_outputs = [None] * len(chapters)
        chapter_titles_rewritten: dict[int, str] = {}
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
            futures = {ex.submit(rewrite_chapter, ch): ch for ch in chapters}
            for fut in as_completed(futures):
                idx, new_title, content = fut.result()
                chapter_outputs[idx] = content

                first_line = content.split("\n", 1)[0].strip()
                m_h2 = re.match(r"^##\s+(.+?)\s*$", first_line)
                if m_h2:
                    chapter_titles_rewritten[idx] = m_h2.group(1).strip()
                else:
                    chapter_titles_rewritten[idx] = chapters[idx]["title"]


        for idx, content in enumerate(chapter_outputs):
            ch_path = intermediate_dir / f"chapter_{idx:02d}.md"
            ch_path.write_text(content, encoding="utf-8")
            chapter_paths.append(ch_path)
            logger.info(f"  [章{idx}] {chapter_titles_rewritten[idx]} → {ch_path.name} ({len(content)} chars)")


    logger.info("=" * 60)
    logger.info("Step 5: 拼回 polished6_v3")
    polished6_v3_parts: list[str] = []
    for idx, content in enumerate(chapter_outputs):
        if not content.startswith("## "):
            content = f"## {chapter_titles_rewritten.get(idx, chapters[idx]['title'])}\n\n{content}"
        polished6_v3_parts.append(content)
    polished6_v3_text = "\n\n".join(polished6_v3_parts)
    v3_path.write_text(polished6_v3_text, encoding="utf-8")
    logger.info(f"  polished6_v3: {v3_path} ({len(polished6_v3_text)} chars)")

    if args.skip_finalize:
        logger.info("⚠️ 跳过全文重写, 只输出 polished6_v3")

        polished7_path.write_text(polished6_v3_text, encoding="utf-8")
        logger.info(f"✅ 已写入: {polished7_path}")
        return 0



    logger.info("=" * 60)
    logger.info("Step 6: 全文重写 (POLISH6_PROMPT + 保护语) — 输入 balanced")
    finalize_prompt = build_finalize_prompt(topic, time_range, balanced_text, balanced_chars, subtopics)
    min_chars_final = int(balanced_chars * 0.30)

    last_err = ""
    out_final = ""
    for attempt in range(MAX_RETRY + 1):
        try:
            t0 = time.time()
            out_final = call_llm(client, model, finalize_prompt,
                                 max_tokens=args.max_tokens,
                                 temperature=args.temperature)
            dt = time.time() - t0
            logger.info(f"  LLM 完成, 耗时 {dt:.1f}s, 输出 {len(out_final)} chars")
            if not args.no_strip:
                out_final, strip_notes = strip_meta(out_final)
                if strip_notes.get("meta_paragraphs_dropped") or strip_notes.get("cut_markers_stripped"):
                    logger.info(f"  兜底清理: {strip_notes}")
            break
        except Exception as e:
            last_err = f"LLM 异常: {e}"
            logger.warning(f"  尝试 {attempt+1}/{MAX_RETRY+1}, {last_err}")
    if not out_final:

        logger.error(f"  全文 LLM 异常 {MAX_RETRY+1} 次, 用 polished6_v3 兜底. 最后错误: {last_err}")
        out_final = polished6_v3_text
    elif len(out_final) < min_chars_final:

        logger.warning(f"  字符数 {len(out_final)} < 软下限 {min_chars_final} ({len(out_final)/min_chars_final*100:.0f}%), 仍采用 LLM 输出")


    logger.info("=" * 60)
    logger.info("Step 7: 硬约束自检")
    verify_result = verify_p7(out_final, balanced_text, polished6_v3_text)
    for name, ck in verify_result["checks"].items():
        is_soft = ck.get("soft", False)
        flag = "✅" if ck["ok"] else ("⚠️ " if is_soft else "❌")
        tag = "(soft)" if is_soft else ""
        logger.info(f"  {flag} {name} {tag}: {ck['msg']}")
    fail_count = verify_result["fail_count"]
    if verify_result["pass"]:
        pass_msg = "✅ 全部 hard 检查通过"
    else:
        pass_msg = f"⚠️  {fail_count} 项 hard 失败 (已记录)"
    logger.info(f"  {pass_msg}")


    polished7_path.write_text(out_final, encoding="utf-8")
    logger.info(f"✅ 已写入: {polished7_path} ({len(out_final)} chars)")


    diag = {
        "cluster": cluster,
        "version": ver,
        "balanced_chars": balanced_chars,
        "polished6_v3_chars": len(polished6_v3_text),
        "polished7_chars": len(out_final),
        "compression_ratio": round(len(out_final) / balanced_chars, 3) if balanced_chars > 0 else 0,
        "hard_min_30pct": min_chars_final,
        "meets_30pct": len(out_final) >= min_chars_final,
        "subtopics": subtopics,
        "coverage": coverage,
        "chapter_count": len(chapters),
        "chapter_titles_rewritten": chapter_titles_rewritten,
        "verify": verify_result,
    }
    diag_path = paths.outputs / "polish_diagnostics" / cluster / f"diagnostics_{SUFFIX}.json"
    diag_path.write_text(json.dumps(diag, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"   诊断: {diag_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
