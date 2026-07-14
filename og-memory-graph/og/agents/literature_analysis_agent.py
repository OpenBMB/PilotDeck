from __future__ import annotations

import os
import re
import json
import time
import hashlib
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

try:
    from openai import (OpenAI, APIError, RateLimitError,
                         APIConnectionError, APITimeoutError)
except ImportError:
    OpenAI = None

from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus
from og.agents.locate_agent import LocateAgent



try:
    from og.config.models import (
        LLM_MAIN as DEFAULT_MODEL,
        DEFAULT_MAX_CHARS_PER_REF,
        MENU_QUERY_MODE,
        MENU_WINDOW_SIZE,
        MENU_WINDOW_OVERLAP,
        MENU_MAX_WINDOWS,
        MENU_PER_WINDOW_TOP_K,
        MENU_RRF_K,
        MENU_FINAL_TOP_N,
        MENU_SINGLE_QUERY_CHARS,
        LITERATURE_DELTA_GRANULARITY,
    )
except ImportError:
    DEFAULT_MODEL = "deepseek-v4-pro"
    DEFAULT_MAX_CHARS_PER_REF = 2000
    MENU_QUERY_MODE = "multiwindow"
    MENU_WINDOW_SIZE = 600
    MENU_WINDOW_OVERLAP = 100
    MENU_MAX_WINDOWS = 8
    MENU_PER_WINDOW_TOP_K = 15
    MENU_RRF_K = 60
    MENU_FINAL_TOP_N = 30
    MENU_SINGLE_QUERY_CHARS = 600
    LITERATURE_DELTA_GRANULARITY = "fine"
DEFAULT_PARALLEL = 4
DEFAULT_MAX_TOKENS = int(os.environ.get("LIT_MAX_TOKENS") or 6000)
DEFAULT_TEMPERATURE = 0.0
DEFAULT_TIMEOUT = float(
    os.environ.get("LITERATURE_ANALYSIS_TIMEOUT")
    or os.environ.get("LLM_TIMEOUT")
    or os.environ.get("BC_LLM_TIMEOUT")
    or "600.0"
)
DEFAULT_CANDIDATE_NODE_TOP_K = int(os.environ.get("LIT_CANDIDATE_TOP_K") or MENU_FINAL_TOP_N)



REF_TEXT_MAX_CHARS_IN_PROMPT = int(os.environ.get("MAX_CHARS_PER_REF") or DEFAULT_MAX_CHARS_PER_REF)


OG_HASH_LEN = 12


CREATE_TITLE_JACCARD_THRESHOLD = 0.5

CREATE_TITLE_EMBEDDING_THRESHOLD = 0.85


DEFAULT_MAX_RETRIES = int(os.environ.get("LITERATURE_ANALYSIS_MAX_RETRIES", "4"))


def _is_thinking(model: str) -> bool:
    m = (model or "").lower()
    return any(h in m for h in (
        "v4-pro", "qwen3", "-reasoning", "-think", "o1", "r1", "o3", "o4",
        "gpt-5", "gemini-2.5", "gemini-3", "glm-4.7", "glm-zero", "glm-z",
        "claude-thinking", "claude-opus-thinking",
        "minimax",
    ))


def _thinking_multiplier(model: str) -> float:
    m = (model or "").lower()
    if "gemini-2.5" in m or "gemini-3" in m:
        return 3.0
    if "minimax" in m:
        return 2.0
    return 2.5


OP_STRENGTH_ORDER = ["UPDATE", "AUGMENT", "RECONTEXTUALIZE",
                      "SUPERSEDE", "DELETE", "SPLIT", "CREATE"]




ALLOWED_NODE_TYPES = {"Synthesis", "Context", "Claim", "Evidence",
                       "Comparison", "Section", "Transition",
                       "Reference", "Table"}
ALLOWED_RHETORICAL_ROLES = {
    "container", "conclusion", "sub_conclusion", "premise", "evidence",
    "background", "counterpoint", "qualification", "transition",
    "summary", "illustration",
}

DEFAULT_ROLE_FOR_TYPE = {
    "Synthesis": "summary",
    "Context": "background",
    "Claim": "conclusion",
    "Evidence": "evidence",
    "Comparison": "evidence",
    "Section": "container",
    "Transition": "transition",
    "Reference": "evidence",
    "Table": "evidence",
}




METADATA_SYSTEM_TEMPLATE = (
    "你是一位严谨的文献元数据抽取助手. 主题: 「{topic}」.\n"
    "你将拿到一篇参考文献的全文 (中文, 200-5000 字), 请抽取其元数据.\n\n"
    "【字段定义】\n"
    "  title       : 文献标题 (常见于第一行, 或在文中明确标注)\n"
    "  author      : 作者 / 机构名 (例: 'Apple Inc.', 'BBC Sport', 'Tim Cook'),\n"
    "                若无明显署名, 用发布机构名 (例: 'FIFA', 'Reuters')\n"
    "  url         : 文献链接 (常见于文末 '来源: <URL>' 一行)\n"
    "  publish_date: 发表日期 ISO 格式 'YYYY-MM-DD' 或 'YYYY-MM' 或 'YYYY'\n"
    "  data_year   : 文献所述事实/数据的年份, 注意可能跟 publish_date 不同 (例:\n"
    "                publish_date='2024-01-17' 但 data_year='2023', 因为是 2023 年报)\n"
    "                可以是 'YYYY' 或 'YYYY-YYYY' 跨年; 必须落在期窗口范围内\n"
    "  tier        : T1 / T2 / T3 — 文献来源权威等级\n"
    "                  T1 一手权威 (政府统计 / 上市公司财报 / 央行 / 体育组织官方公告)\n"
    "                  T2 二手研究 (学术 / 智库 / BBC / Reuters / AP / CNN / FIFA 等知名媒体)\n"
    "                  T3 评论 / 博客 / 自媒体\n"
    "  summary     : ★ 一句话总结 (40-80 字), 浓缩 ref 的核心事实/主张/数据.\n"
    "                与 title 不同, 应当客观陈述事实, 不带评论. 用作下游 menu\n"
    "                检索 rerank 阶段的 query, 比 title 信息密度更高.\n"
    "                例: 'BBC 2022年5月10日报道哈兰德将以6000万欧解约金从多特蒙德\n"
    "                     转会曼城, 签约 5 年至 2027 年, 周薪约 40 万英镑.'\n\n"
    "【已有部分元数据】 (若提供, 仅补全你判断里缺失的字段, 不要覆盖已填字段)\n"
    "{existing_meta}\n\n"
    "【硬约束】\n"
    "1. publish_date 与 data_year 必须落在 [{period_lo}, {period_hi}] 之间\n"
    "   (如果 ref 文本声明的日期超出, 用 ref 文本里的日期, 不要硬改; 但要在 issue 里报告)\n"
    "2. 不要捏造任何字段, 找不到的字段写空字符串\n"
    "3. tier 必须是 T1 / T2 / T3 之一\n"
    "4. JSON 字符串值内严禁出现未转义的 ASCII 双引号; 想表达引文请用「」或不加引号\n\n"
    "【输出格式 — 严格 JSON, 不要 markdown 包裹, 不要解释】\n"
    "{{\n"
    '  "title": "...",\n'
    '  "author": "...",\n'
    '  "url": "...",\n'
    '  "publish_date": "...",\n'
    '  "data_year": "...",\n'
    '  "tier": "T1" | "T2" | "T3",\n'
    '  "summary": "<40-80 字客观一句话总结>",\n'
    '  "issues": ["<可选, 列出抽取过程中发现的问题, 如日期超出窗口>"]\n'
    "}}"
)


DELTA_SYSTEM_TEMPLATE = (
    "你是一位资深研究分析师. 主题: 「{topic}」. 当前是第 {period_label} 期.\n"
    "任务总时间窗口 [{task_lo}, {task_hi}] (硬约束, data_year 必须在内).\n"
    "本期 ref 主要事件年份 [{period_lo}, {period_hi}] (软约束, LLM 应聚焦此范围).\n\n"
    "你将拿到:\n"
    "  1. 一篇本期【新参考文献】(ref_number={ref_number}) 的全文.\n"
    "  2. 一份【当前 OG 候选节点目录】(LocateAgent 检索 top-K), 列出当前\n"
    "     OG 中与本 ref 主题最相关的节点 (含 temp_id / 类型 / 标题 / parent_section /\n"
    "     content_summary 摘要), 你的 target_node 必须从这里挑选, 否则改用 CREATE.\n\n"
    "你的任务: 从该 ref 中识别出所有【对该主题的增量更新事实】, 对每条事实决定它\n"
    "应该 SUPERSEDE / AUGMENT / CREATE / UPDATE / DELETE / RECONTEXTUALIZE 哪个 OG 节点.\n\n"
    "【target_op 语义】\n"
    "  SUPERSEDE       : 新事实推翻旧事实 (例: 旧节点 'X 公司 CEO 是 A',\n"
    "                    新 ref '2021 年 B 接任 CEO' → SUPERSEDE)\n"
    "  AUGMENT         : 补充新维度, 旧事实仍成立 (例: 旧节点 '营收 1000 亿',\n"
    "                    新 ref '其中服务业务占比 20%' → AUGMENT)\n"
    "  CREATE          : 完全新事件 / 新主体, OG 之前未涵盖, 需要新建节点\n"
    "  UPDATE          : 就地修改 (少用; 主要给 'correction' 类纠错使用)\n"
    "  DELETE          : 记忆文件/事实被移除, 对应既有节点标 deprecated (不再成立)\n"
    "  RECONTEXTUALIZE : 仅 Context 节点适用, 当前的语境/制度发生变化\n\n"
    "【判定原则】\n"
    "1. 看 ref 描述的【主体】(公司 / 人物 / 球队 / 事件) 在【候选节点目录】里\n"
    "   是否已有专门节点. 有 → 优先 SUPERSEDE/AUGMENT 已有节点, 不要新建.\n"
    "2. 没有 → CREATE, parent_section 选目录里语义最近的那个 section.\n"
    "3. SUPERSEDE 与 AUGMENT 的边界: 新 ref 是否【否定】旧节点的核心数据?\n"
    "   是 (旧值不再成立) → SUPERSEDE; 否 (旧值仍成立, 只是补充) → AUGMENT.\n"
    "4. {granularity_rule}\n"
    "5. 不要假设主题是任何特定领域 (科技 / 体育 / 医药 / 政治皆有可能), 仅基于\n"
    "   提供给你的 candidate_node_menu + ref 全文做判断.\n"
    "6. 【属性值变更 — 重要】若 ref 描述的是某既有事实的【同一属性值更新】\n"
    "   (例: 旧节点 '项目状态 in_progress', 新 ref '状态改为 active'; 或旧值 100, 新值 120),\n"
    "   必须用 SUPERSEDE (旧值不再成立) 或 UPDATE (就地修正) 指向记录旧值的既有节点,\n"
    "   delta_type 用 data_update 或 superseding, 【严禁 CREATE 新节点】.\n"
    "   识别信号: 内容含 '由X改为Y' '从X变为Y' '更新为X' '状态/进度/数值变更' 等表述.\n"
    "   若候选目录里一时找不到记录旧值的节点, 仍应尝试 SUPERSEDE 语义最近的相关节点,\n"
    "   不要轻易退回 CREATE —— 属性值变更几乎总是针对既有事实, 而非全新事件.\n"
    "7. 【记忆删除 — 重要】若 ref 描述的是某记忆文件/事实【被移除/删除】\n"
    "   (delta 文档的「## 删除内容」段, 或内容含 '已从记忆中移除' '文件被删除' 等),\n"
    "   必须用 DELETE 操作指向【源自该被删文件】的既有节点, 把它们标为 deprecated,\n"
    "   delta_type 用 data_update, 【严禁 CREATE 描述'移除事件'的新节点】.\n"
    "   识别方法: delta 会列出被删文件路径(如 'Feedback/xxx.md'), 在候选节点目录里\n"
    "   找 title/摘要源自该文件内容的节点(通常 title 含文件主题词或文件名标记), 对其 DELETE.\n"
    "   若一个文件对应多个节点, 对每个相关节点都发一条 DELETE delta (target_node 各指一个).\n\n"
    "【硬约束】\n"
    "- target_node (除 CREATE 外) 必须严格等于 candidate_node_menu 里的 temp_id.\n"
    "- target_op ∈ {{SUPERSEDE, AUGMENT, CREATE, UPDATE, DELETE, RECONTEXTUALIZE}}\n"
    "- data_year 必须在任务总窗口 [{task_lo}, {task_hi}] 内 (硬约束)\n"
    "- 优先选择 data_year ∈ [{period_lo}, {period_hi}] (本期主要事件年份, 软约束)\n"
    "- cited_refs 必须包含本 ref 编号 [{ref_number}]; 不要引用还未出现过的 ref\n"
    "- 每条 delta 至少 1 个 data_point (qualification 类除外)\n"
    "- topic_keywords 用 1-3 个中文关键词\n"
    "- CREATE 时必填: node_type ∈ {{Synthesis, Context, Claim, Evidence, Comparison}},\n"
    "                  rhetorical_role, parent_section\n"
    "- ★ JSON 字符串值内严禁出现未转义的 ASCII 双引号 \" — 想表达引文请用「」或不加引号\n\n"
    "【输出格式 — 严格 JSON, 不要 markdown 包裹】\n"
    "{{\n"
    '  "ref_number": {ref_number},\n'
    '  "deltas": [\n'
    "    {{\n"
    '      "delta_type": "data_update" | "new_finding" | "superseding" | "qualification" | "new_section",\n'
    '      "title": "<delta 简短标题, 20-40 字>",\n'
    '      "content": "<完整内容描述, 100-400 字, 包含具体数据/日期/人名>",\n'
    '      "data_year": <int>,\n'
    '      "topic_keywords": ["...", "..."],\n'
    '      "data_points": [\n'
    "        {{\n"
    '          "data_id": "<D-XXX-YYY 形式的稳定 id>",\n'
    '          "value": "<值>", "label": "<标签>",\n'
    '          "data_year": <int>, "source_ref": {ref_number}\n'
    "        }}\n"
    "      ],\n"
    '      "cited_refs": [{ref_number}],\n'
    '      "target_node": "<menu 里的 temp_id, 或 CREATE 时省略>",\n'
    '      "target_op": "SUPERSEDE" | "AUGMENT" | "CREATE" | "UPDATE" | "DELETE" | "RECONTEXTUALIZE",\n'
    '      "node_type": "<CREATE 时必填>",\n'
    '      "rhetorical_role": "<CREATE 时必填>",\n'
    '      "parent_section": "<CREATE 时必填, 必须是 menu 里出现过的 section 名>"\n'
    "    }}\n"
    "  ],\n"
    '  "issues": ["<可选>"]\n'
    "}}\n\n"
    "如果该 ref 与当前主题无关 (例如纯背景介绍且无新事实), 返回 deltas=[]."
)


_JSON_QUOTE_RULE = (
    "★ JSON 字符串值内严禁出现 ASCII 双引号 \"  — 想表达引文请用中文「」"
    "或不加引号. 例如: 不要写 \"对标阿森纳\\\"不败神话\\\"对比\", "
    "应写 \"对标阿森纳「不败神话」对比\". 任何未转义的 \" 出现在 string value "
    "内会让 JSON 解析失败, 整段输出作废."
)


BUILD_OUTLINE_SYSTEM_TEMPLATE = (
    "你是一位资深的研究报告架构师. 主题: 「{topic}」. 当前是 v1 期 (基线), 数据\n"
    "年代窗口 [{period_lo}, {period_hi}]. 你拿到该期所有参考文献的【标题 + 摘要】,\n"
    "请设计一份能完整覆盖这些 refs 的报告章节框架.\n\n"
    "【输出要求】\n"
    "8-15 个顶层 section, 每个 section 一段 60-150 字的描述, 说明它将涵盖哪些主题.\n"
    "section 命名要保持中文研究报告的常规风格 (例: '一、xxx', '二、yyy'), 编号必须\n"
    "连续. section 必须直接对应 refs 里的实质主题, 不要凭空生成摘要 / 综述 / 结论 /\n"
    "展望等通用结构 section —— 除非这批 refs 的内容本身就是在做综述或展望.\n\n"
    "【硬约束 — 违反任一条响应将被丢弃】\n"
    "1. section 必须能被这批 refs 实际支撑 — 不要凭主题硬塞章节\n"
    "2. 不要假设主题是某个特定领域, 仅基于 refs 自身的 title+abstract 做判断\n"
    "3. 禁止生成空壳通用 section: 不要为了凑结构而加 '摘要 / 综述' / '结论 / 展望' /\n"
    "   '附录' 之类的章节 —— 每个 section 都必须有对应的实质 ref 内容支撑. 若某 ref\n"
    "   不适合任何主题 section, 将它归到语义最接近的主题 section (可跨 section 共享),\n"
    "   而非新建一个兜底通用 section.\n"
    + "4. " + _JSON_QUOTE_RULE + "\n"
    "5. 🔴 CRITICAL: 每个 section 的 candidate_ref_numbers 必须是非空数组, 至少包含\n"
    "   1 个相关 ref_number (整数). 空数组 [] 是不合法的, 会导致整批数据报废.\n"
    "6. 🔴 CRITICAL: 所有 ref (从 ref_001 到 ref_N) 必须被至少一个 section 覆盖.\n\n"
    "【正反例】\n"
    "✅ 正确示例:\n"
    '  {{"name": "二、美国大选", "description": "...", "candidate_ref_numbers": [1, 2, 5, 7]}}\n'
    '  {{"name": "三、欧洲领导人", "description": "...", "candidate_ref_numbers": [3, 6, 11]}}\n'
    "❌ 错误示例 (会被拒绝):\n"
    '  {{"name": "二、美国大选", "description": "...", "candidate_ref_numbers": []}}\n'
    "  ❌ 也错误 (空壳通用 section, 无对应实质 ref):\n"
    '  {{"name": "一、摘要与综述", "description": "本文综述...", "candidate_ref_numbers": [1,2,3,4,5]}}\n\n'
    "【分配策略建议】\n"
    "- 根据 ref title/abstract 中的关键词 (国家名、人名、事件类型) 分配到相应 section\n"
    "- 一个 ref 可以分配给多个 section (如果内容跨主题)\n"
    "- 每个 section 围绕一个具体主题, 覆盖 2-8 个相关 ref; 宁可 section 少也不要空壳\n\n"
    "【输出格式 — 严格 JSON】\n"
    "{{\n"
    '  "sections": [\n'
    "    {{\n"
    '      "name": "一、xxx",\n'
    '      "description": "<60-150 字, 描述该 section 将覆盖的主题与 ref 范围>",\n'
    '      "candidate_ref_numbers": [1, 3, 5]  // 必须非空整数数组\n'
    "    }}\n"
    "  ]\n"
    "}}"
)


BUILD_NODES_SYSTEM_TEMPLATE = (
    "你是一位资深研究分析师. 主题: 「{topic}」. v1 期, 数据窗口 [{period_lo}, {period_hi}].\n"
    "你正在为某一个章节生成 OG 节点 (Synthesis / Context / Claim / Evidence / Comparison).\n\n"
    "【该章节信息】\n"
    "  名称: {section_name}\n"
    "  描述: {section_description}\n\n"
    "你将拿到该章节相关的 ref 全文集. 请基于这些 refs, 为该章节产出一组 OG 节点,\n"
    "覆盖该章节描述里所提到的所有事实/数据/对照. 尽可能详细, 不要省略可被 ref 支撑\n"
    "的非冗余事实.\n\n"
    "【节点类型语义】\n"
    "  Synthesis  : 摘要 / 综合判断 (跨多篇 ref 的洞察, 全章首末位常见)\n"
    "  Context    : 背景 / 制度 / 概念 (long_term temporal_scope, 不易过时)\n"
    "  Claim      : 论点 / 主张 / 结论 (基于 evidence)\n"
    "  Evidence   : 数据点 / 证据 (一手数据 + 来源 ref)\n"
    "  Comparison : 跨主体对照 (例: 公司间, 球员间, 政策间)\n\n"
    "【硬约束】\n"
    "1. 每个节点必须 cite 至少 1 个 ref (cited_refs 来自上方 ref 集中的编号)\n"
    "2. data_blocks 里的 source_ref 必须出现在 cited_refs 里\n"
    "3. temp_id 命名: SUM-XXX (Synthesis), CTX-XXX (Context), C-XXX (Claim),\n"
    "                  E-XXX (Evidence), CMP-XXX (Comparison); XXX 用本章节 ref 关键词\n"
    "4. parent_section 必须等于 '{section_name}'\n"
    "5. temporal_scope 取值: 单年 'YYYY' / 跨年 'YYYY-YYYY' / 长期概念 'long_term'\n"
    "6. 不要捏造数据, 不要假设主题是任何特定领域\n"
    "7. ★ JSON 字符串值内严禁出现未转义的 ASCII 双引号 \" — content_summary / title 内想表达引文请用「」或不加引号\n\n"
    "【输出格式 — 严格 JSON】\n"
    "{{\n"
    '  "nodes": [\n'
    "    {{\n"
    '      "temp_id": "...",\n'
    '      "type": "Synthesis" | "Context" | "Claim" | "Evidence" | "Comparison",\n'
    '      "rhetorical_role": "summary" | "background" | "conclusion" | "sub_conclusion" | "evidence",\n'
    '      "title": "<25-60 字>",\n'
    '      "parent_section": "{section_name}",\n'
    '      "content_summary": "<150-500 字>",\n'
    '      "original_text": "",\n'
    '      "data_blocks": [\n'
    "        {{\n"
    '          "data_id": "<D-XXX>", "value": "<值>", "label": "<标签>",\n'
    '          "data_year": <int>, "source_ref": <ref_number>\n'
    "        }}\n"
    "      ],\n"
    '      "cited_refs": [<ref_number>, ...],\n'
    '      "temporal_scope": "<YYYY | YYYY-YYYY | long_term>",\n'
    '      "staleness_risk": "low" | "medium" | "high",\n'
    '      "confidence": <0.0-1.0>\n'
    "    }}\n"
    "  ]\n"
    "}}"
)


BUILD_EDGES_SYSTEM_TEMPLATE = (
    "你是一位 OG 关系分析师. 主题: 「{topic}」. 你将拿到一组节点 (来自同一份 v1 OG),\n"
    "请推断它们之间的语义边.\n\n"
    "【边类型】\n"
    "  supports        Evidence → Claim     证据支持论点\n"
    "  derives_from    Synthesis → Claim    综合衍生自论点\n"
    "  contradicts     Claim → Claim        论点相互矛盾 (谨慎使用)\n"
    "  parallels       Claim → Claim        平行类比\n"
    "  deepens         Evidence → Evidence  补充深化\n"
    "  contextualizes  Context → Claim/Evidence  背景为某主张提供语境\n"
    "  compared_in     Claim/Evidence → Comparison  被某 Comparison 节点对比\n"
    "  cites           Claim/Evidence → Reference   引用 (这一类由框架自动加,\n"
    "                  你不需要在这里输出, 但要确保每个 Claim/Evidence 有 cited_refs)\n\n"
    "【硬约束】\n"
    "1. 不要为了凑数量乱连边. 每条边都必须有清晰的语义理由 (放在 reason 字段).\n"
    "2. source 与 target 必须是输入节点列表里的 temp_id.\n"
    "3. 不要建反向 / 自环 / 重复边.\n"
    "4. cites 边由框架自动从 cited_refs 推, 不要在这里输出.\n"
    "5. ★ JSON 字符串值内严禁出现未转义的 ASCII 双引号 \" — reason 字段里想表达引文请用「」或不加引号\n\n"
    "【输出格式 — 严格 JSON】\n"
    "{{\n"
    '  "edges": [\n'
    "    {{\n"
    '      "source": "<temp_id>", "target": "<temp_id>",\n'
    '      "type": "supports" | "derives_from" | "contradicts" | "parallels" |\n'
    '              "deepens" | "contextualizes" | "compared_in",\n'
    '      "strength": "weak" | "moderate" | "strong",\n'
    '      "reason": "<10-40 字理由>",\n'
    '      "confidence": <0.0-1.0>\n'
    "    }}\n"
    "  ]\n"
    "}}"
)


def _format_metadata_system(topic: str, period_lo: int, period_hi: int,
                             existing_meta: dict | None) -> str:
    return METADATA_SYSTEM_TEMPLATE.format(
        topic=(topic or "").strip() or "本调研课题",
        period_lo=period_lo, period_hi=period_hi,
        existing_meta=(json.dumps(existing_meta or {}, ensure_ascii=False)
                       if existing_meta else "(无)"),
    )


_GRANULARITY_RULE_FINE = (
    "★【粒度 = 细粒度 atomic facts】★ 一篇 ref 应抽出 5-10 条 delta, 每条对应\n"
    "   一个【单一原子事实】 (e.g.「转会费」是一条,「合同年限」是另一条,\n"
    "  「周薪」又是一条). 每条 delta 的 title + content 必须【自包含】, 即:\n"
    "   单独读这一条就能理解事实, 不依赖其它 delta 上下文.\n"
    "   反例:「上文提到的合同」「同样的薪资水平」— 这种表达 ❌, 应改成\n"
    "        「2022 年 5 月哈兰德与曼城签订的 5 年合同」「哈兰德周薪 40 万英镑」\n"
    "   原子拆分让下游 vector 检索能精准匹配到对应的 OG 节点 — 每条 delta 的\n"
    "   content 会作为完整 query 去 OG 向量库重检索 verification.\n"
    "   合并由框架自动做 (同 target_node 的 delta 会被后处理合并), 你只管拆细"
)

_GRANULARITY_RULE_COARSE = (
    "不要为了凑数量编造 delta — 一篇 ref 实质性的增量事实通常 1-3 条;\n"
    "   超过 5 条很可能拆得太细或重复, 应合并成更高层级的 delta"
)


def _format_delta_system(topic: str, period_label: str,
                          period_lo: int, period_hi: int, ref_number: int,
                          granularity: str = "fine",
                          task_lo: int | None = None,
                          task_hi: int | None = None) -> str:
    rule = (_GRANULARITY_RULE_FINE if granularity == "fine"
            else _GRANULARITY_RULE_COARSE)
    if task_lo is None: task_lo = period_lo
    if task_hi is None: task_hi = period_hi
    return DELTA_SYSTEM_TEMPLATE.format(
        topic=(topic or "").strip() or "本调研课题",
        period_label=period_label, period_lo=period_lo, period_hi=period_hi,
        task_lo=task_lo, task_hi=task_hi,
        ref_number=ref_number,
        granularity_rule=rule,
    )


def _format_outline_system(topic: str, period_lo: int, period_hi: int) -> str:
    return BUILD_OUTLINE_SYSTEM_TEMPLATE.format(
        topic=(topic or "").strip() or "本调研课题",
        period_lo=period_lo, period_hi=period_hi,
    )


def _format_build_nodes_system(topic: str, period_lo: int, period_hi: int,
                                 section_name: str, section_description: str) -> str:
    return BUILD_NODES_SYSTEM_TEMPLATE.format(
        topic=(topic or "").strip() or "本调研课题",
        period_lo=period_lo, period_hi=period_hi,
        section_name=section_name, section_description=section_description,
    )


def _format_build_edges_system(topic: str) -> str:
    return BUILD_EDGES_SYSTEM_TEMPLATE.format(
        topic=(topic or "").strip() or "本调研课题",
    )




_client: OpenAI | None = None
_client_lock = threading.Lock()


def _get_client(timeout: float = DEFAULT_TIMEOUT, model: str | None = None) -> OpenAI:
    if OpenAI is None:
        raise RuntimeError("openai package not installed (pip install openai)")

    try:
        from og.config.models import get_client_for_model
        return get_client_for_model(model or DEFAULT_MODEL, timeout=timeout)
    except Exception:
        pass

    global _client
    if _client is not None:
        return _client
    with _client_lock:
        if _client is None:
            base = os.environ.get("OPENAI_API_BASE", "https://yeysai.com/v1")
            key = os.environ.get("OPENAI_API_KEY", "")
            if not key:
                raise RuntimeError("OPENAI_API_KEY env var not set")
            _client = OpenAI(base_url=base, api_key=key,
                             timeout=timeout, max_retries=0)
    return _client


def _call_llm(messages: list[dict],
               model: str = DEFAULT_MODEL,
               max_tokens: int = DEFAULT_MAX_TOKENS,
               temperature: float = DEFAULT_TEMPERATURE,
               max_retries: int = DEFAULT_MAX_RETRIES,
               timeout: float = DEFAULT_TIMEOUT) -> str:

    if "minimax" in (model or "").lower():
        max_tokens = min(max_tokens, 900)

        from og.config.models import _truncate_messages_for_minimax
        messages = _truncate_messages_for_minimax(messages, max_input_tokens=950)


    if _is_thinking(model):
        max_tokens = int(max_tokens * _thinking_multiplier(model))

    if "minimax" in (model or "").lower():
        max_tokens = min(max_tokens, 1000)
    last_err = None
    for i in range(max_retries):
        try:

            extra_body = None
            if "minimax" in (model or "").lower():
                extra_body = {"reasoning_effort": "none"}
            kwargs = dict(
                model=model, messages=messages,
                temperature=temperature, max_tokens=max_tokens,
                timeout=timeout,
            )
            if extra_body is not None:
                kwargs["extra_body"] = extra_body
            r = _get_client(timeout, model=model).chat.completions.create(**kwargs)
            return (r.choices[0].message.content or "").strip()
        except (RateLimitError, APIConnectionError, APITimeoutError, APIError) as e:
            last_err = e

            err_str = str(e).lower()
            if "503" in err_str or "no available" in err_str or "sub-groups" in err_str:
                wait = min(300, 60 * (i + 1))
            else:
                wait = min(180, 2 ** i + 5)
            print(f"      [warn] literature LLM error: {type(e).__name__}; retry in {wait}s")
            time.sleep(wait)
        except Exception as e:
            last_err = e
            print(f"      [warn] literature LLM unexpected: {e}; retry in 5s")
            time.sleep(5)
    raise RuntimeError(f"literature LLM failed after {max_retries} retries: {last_err}")


def _strip_md_fence(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:])
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return text


_CJK_RANGE = r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]"


def _repair_unescaped_inner_quotes(text: str) -> str:

    for _ in range(5):
        new = re.sub(rf"({_CJK_RANGE})\"({_CJK_RANGE})", r"\1\2", text)
        if new == text:
            break
        text = new
    return text


def _parse_json_strict(text: str) -> dict | None:
    raw = (text or "").strip()
    if not raw:
        return None

    try:
        return json.loads(raw)
    except Exception:
        pass

    stripped = _strip_md_fence(raw)
    try:
        return json.loads(stripped)
    except Exception:
        pass

    s, e = stripped.find("{"), stripped.rfind("}")
    if s == -1 or e == -1 or e <= s:
        return None
    block = stripped[s:e + 1]
    try:
        return json.loads(block)
    except Exception:
        pass

    repaired = _repair_unescaped_inner_quotes(block)
    try:
        return json.loads(repaired)
    except Exception:
        return None




def _sha256_short(s: str, n: int = OG_HASH_LEN) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:n]


def _ref_text_hash(text: str) -> str:
    return _sha256_short(text)


def _og_outline_hash(og: OutlineGraph) -> str:
    items = []
    for n in sorted(og.get_all_nodes(status=NodeStatus.ACTIVE),
                    key=lambda x: x.id):
        if n.type == NodeType.REFERENCE:
            continue
        items.append(f"{n.id}|{n.type.value}|{n.title or ''}")
    return _sha256_short("\n".join(items))


def _normalize_year(s: Any) -> int | None:
    if s is None:
        return None
    if isinstance(s, int):
        return s if 1900 <= s <= 2100 else None
    if isinstance(s, str):
        m = re.search(r"\b(19\d{2}|20\d{2})\b", s)
        return int(m.group(1)) if m else None
    return None




@dataclass
class CandidateDelta:
    ref_number: int
    delta_type: str
    title: str
    content: str
    data_year: int
    topic_keywords: list[str]
    data_points: list[dict]
    cited_refs: list[int]
    target_op: str
    target_node: str | None = None
    node_type: str | None = None
    rhetorical_role: str | None = None
    parent_section: str | None = None
    raw: dict = field(default_factory=dict)
    is_valid: bool = True
    issues: list[str] = field(default_factory=list)




class LiteratureAnalysisAgent:

    def __init__(
        self,
        mode: Literal["build", "delta"],
        topic: str,
        cache_dir: Path | None = None,
        model: str = DEFAULT_MODEL,
        parallel: int = DEFAULT_PARALLEL,
        candidate_node_top_k: int = DEFAULT_CANDIDATE_NODE_TOP_K,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        temperature: float = DEFAULT_TEMPERATURE,
        timeout: float = DEFAULT_TIMEOUT,
        existing_ref_meta: dict[int, dict] | None = None,
        task_year_range: tuple[int, int] | None = None,
    ):
        if mode not in ("build", "delta"):
            raise ValueError(f"mode must be 'build' or 'delta', got {mode!r}")
        self.mode = mode
        self.topic = topic
        self.cache_dir = cache_dir
        self.model = model
        self.parallel = parallel
        self.candidate_node_top_k = candidate_node_top_k
        self.max_tokens = max_tokens
        self.temperature = temperature
        self.timeout = timeout
        self.existing_ref_meta = existing_ref_meta or {}

        self.task_year_range = task_year_range
        if cache_dir is not None:
            cache_dir.mkdir(parents=True, exist_ok=True)



    def _cache_path(self, kind: str, key: str) -> Path | None:
        if self.cache_dir is None:
            return None
        safe = re.sub(r"[^\w-]+", "_", kind)[:40]
        return self.cache_dir / f"{safe}__{key}.json"

    def _read_cache(self, kind: str, key: str) -> Any:
        p = self._cache_path(kind, key)
        if p is None or not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return None

    def _write_cache(self, kind: str, key: str, data: Any) -> None:
        p = self._cache_path(kind, key)
        if p is None:
            return
        try:
            p.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                         encoding="utf-8")
        except Exception:
            pass

    def _candidate_from_dict(self, d: dict) -> CandidateDelta | None:
        if not isinstance(d, dict):
            return None
        allowed = set(CandidateDelta.__dataclass_fields__.keys())
        data = {k: v for k, v in d.items() if k in allowed}
        try:
            return CandidateDelta(**data)
        except TypeError:
            required_defaults = {
                "ref_number": 0,
                "delta_type": "new_finding",
                "title": "",
                "content": "",
                "data_year": 0,
                "topic_keywords": [],
                "data_points": [],
                "cited_refs": [],
                "target_op": "CREATE",
            }
            required_defaults.update(data)
            try:
                return CandidateDelta(**required_defaults)
            except Exception:
                return None

    def _load_partial_candidates(
        self,
        partial_path: Path,
        ref_texts: dict[int, str],
    ) -> dict[int, list[CandidateDelta]]:
        if not partial_path.exists():
            return {}
        try:
            partial = json.loads(partial_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  [warn] partial cache 读取失败 {partial_path.name}: {e}; 忽略")
            return {}
        raw_cands = partial.get("candidate_deltas_per_ref", {})
        out: dict[int, list[CandidateDelta]] = {}
        for k, vals in raw_cands.items():
            try:
                rn = int(k)
            except (TypeError, ValueError):
                continue
            if rn not in ref_texts or not isinstance(vals, list):
                continue
            cands = []
            for d in vals:
                cd = self._candidate_from_dict(d)
                if cd is not None:
                    cands.append(cd)
            out[rn] = cands
        if out:
            print(f"  [resume] 复用 {partial_path.name}: "
                  f"{len(out)}/{len(ref_texts)} refs 已完成")
        return out

    def _dump_failed_response(self, kind: str, raw: str, key_hint: str = "") -> None:
        if self.cache_dir is None:
            return
        fail_dir = self.cache_dir / "_failed"
        fail_dir.mkdir(exist_ok=True)
        ts = time.strftime("%Y%m%d_%H%M%S")
        safe_kind = re.sub(r"[^\w-]+", "_", kind)[:30]
        safe_hint = re.sub(r"[^\w-]+", "_", key_hint)[:30]
        p = fail_dir / f"{ts}__{safe_kind}__{safe_hint}.txt"
        try:
            p.write_text(raw or "<empty>", encoding="utf-8")
            print(f"      [debug] raw LLM response saved → "
                  f"{p.relative_to(self.cache_dir)}")
        except Exception:
            pass



    @staticmethod
    def _load_ref_texts(ref_dir: Path,
                         ref_range: tuple[int, int] | None = None,
                         ref_number_offset: int = 0) -> dict[int, str]:
        out: dict[int, str] = {}
        if not ref_dir.exists():
            return out
        

        all_files = sorted(ref_dir.glob("*.txt"))
        ref_numbered = []
        ref_others = []
        
        for p in all_files:
            m = re.match(r"ref_(\d+)\.txt$", p.name)
            if m:
                ref_numbered.append((int(m.group(1)), p))
            else:
                ref_others.append(p)
        

        for num, p in ref_numbered:
            if ref_range is not None:
                lo, hi = ref_range
                if not (lo <= num < hi):
                    continue
            try:
                out[num] = p.read_text(encoding="utf-8")
            except Exception as e:
                print(f"      [warn] failed to read {p.name}: {e}")
        

        used_nums = set(out.keys())
        next_num = 1
        for p in ref_others:

            while next_num in used_nums:
                next_num += 1
            if ref_range is not None:
                lo, hi = ref_range
                if not (lo <= next_num < hi):
                    continue
            try:
                out[next_num] = p.read_text(encoding="utf-8")
                used_nums.add(next_num)
            except Exception as e:
                print(f"      [warn] failed to read {p.name}: {e}")
            next_num += 1
        

        if ref_number_offset:
            out = {k + ref_number_offset: v for k, v in out.items()}
        
        return out



    REQUIRED_META_FIELDS = ("title", "author", "url", "publish_date",
                             "data_year", "tier")

    def _meta_is_complete(self, meta: dict | None) -> bool:
        if not meta:
            return False
        return all(meta.get(k) for k in self.REQUIRED_META_FIELDS)

    def _extract_ref_metadata(
        self,
        ref_number: int,
        ref_text: str,
        period_year_range: tuple[int, int],
    ) -> dict:
        existing = self.existing_ref_meta.get(ref_number) or {}
        if self._meta_is_complete(existing):
            return {**existing, "ref_number": ref_number,
                     "_source": "existing_ref_meta"}


        existing_key = json.dumps(
            {k: existing.get(k, "") for k in self.REQUIRED_META_FIELDS},
            ensure_ascii=False, sort_keys=True,
        )
        ckey = _sha256_short(
            f"{ref_number}|{_ref_text_hash(ref_text)}|{period_year_range}|"
            f"{self.topic}|{existing_key}"
        )
        cached = self._read_cache("metadata", ckey)
        if cached:
            return {**cached, "ref_number": ref_number, "_source": "cache"}

        sys_prompt = _format_metadata_system(
            self.topic, period_year_range[0], period_year_range[1],
            {k: existing.get(k, "") for k in self.REQUIRED_META_FIELDS},
        )
        user_msg = (
            f"【参考文献全文】(ref_number={ref_number})\n"
            f"{ref_text[:REF_TEXT_MAX_CHARS_IN_PROMPT]}\n"
        )

        try:
            raw = _call_llm(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                model=self.model, max_tokens=1500,
                temperature=self.temperature, timeout=self.timeout,
            )
        except Exception as e:
            print(f"      [warn] metadata LLM failed for ref_{ref_number:03d}: {e}")

            return self._fallback_metadata(ref_number, ref_text, existing)

        parsed = _parse_json_strict(raw)
        if not parsed:
            print(f"      [warn] metadata JSON parse failed for ref_{ref_number:03d}; using fallback")
            return self._fallback_metadata(ref_number, ref_text, existing)


        out = {}
        for k in self.REQUIRED_META_FIELDS:
            v = existing.get(k) or parsed.get(k) or ""
            out[k] = v
        out["ref_number"] = ref_number
        out["_source"] = "llm"
        if parsed.get("issues"):
            out["_issues"] = list(parsed.get("issues") or [])

        out["tier"] = self._normalize_tier(out.get("tier"))

        out["data_year"] = str(out.get("data_year") or "").strip()
        out["publish_date"] = str(out.get("publish_date") or "").strip()

        self._write_cache("metadata", ckey, out)
        return out

    @staticmethod
    def _normalize_tier(t: Any) -> str:
        s = (str(t or "")).strip().upper()
        if s in ("T1", "T2", "T3"):
            return s
        return "T2"

    @staticmethod
    def _fallback_metadata(ref_number: int, ref_text: str, existing: dict) -> dict:
        lines = [ln.strip() for ln in (ref_text or "").splitlines() if ln.strip()]
        title_guess = lines[0] if lines else f"参考文献[{ref_number}]"
        url_guess = ""
        for ln in reversed(lines):
            m = re.search(r"https?://\S+", ln)
            if m:
                url_guess = m.group(0).rstrip(".,;)")
                break
        out = {
            "title": existing.get("title") or title_guess[:120],
            "author": existing.get("author", ""),
            "url": existing.get("url") or url_guess,
            "publish_date": existing.get("publish_date", ""),
            "data_year": existing.get("data_year", ""),
            "tier": existing.get("tier") or "T2",
            "ref_number": ref_number,
            "_source": "fallback",
        }
        return out

    def extract_all_metadata(
        self,
        ref_texts: dict[int, str],
        period_year_range: tuple[int, int],
    ) -> dict[int, dict]:
        out: dict[int, dict] = {}
        if not ref_texts:
            return out
        print(f"  [Phase 1] 抽取 {len(ref_texts)} 篇 ref 的元数据 "
              f"(parallel={self.parallel})")
        with ThreadPoolExecutor(max_workers=self.parallel) as ex:
            futs = {
                ex.submit(self._extract_ref_metadata, n, t, period_year_range): n
                for n, t in ref_texts.items()
            }
            for fut in as_completed(futs):
                n = futs[fut]
                try:
                    out[n] = fut.result()
                    src = out[n].get("_source", "?")
                    title = (out[n].get("title") or "")[:50]
                    print(f"    [meta] ref_{n:03d} {src:>10}  {title}")
                except Exception as e:
                    print(f"    [meta] ref_{n:03d} ERROR: {e}")
                    out[n] = self._fallback_metadata(n, ref_texts[n], {})
        return out



    @staticmethod
    def _build_menu_queries(title: str, ref_text: str) -> list[str]:
        title = (title or "").strip()
        text = (ref_text or "").strip()
        if not text:
            return [title] if title else []
        if MENU_QUERY_MODE == "single":
            chunk = text[:MENU_SINGLE_QUERY_CHARS]
            q = (title + "。" + chunk) if title else chunk
            return [q]

        ws = max(100, MENU_WINDOW_SIZE)
        ov = max(0, min(ws - 50, MENU_WINDOW_OVERLAP))
        step = ws - ov
        queries: list[str] = []
        pos = 0
        while pos < len(text) and len(queries) < MENU_MAX_WINDOWS:
            window = text[pos : pos + ws]
            if not window.strip():
                break
            q = (title + "。" + window) if title else window
            queries.append(q)
            if pos + ws >= len(text):
                break
            pos += step
        return queries or ([title] if title else [])

    def _build_candidate_node_menu(
        self,
        og: OutlineGraph,
        ref_text: str,
        ref_metadata: dict,
        vector_store,
    ) -> tuple[str, list[str], dict[str, str]]:
        title = (ref_metadata.get("title") or "")[:200]



        ref_summary = (ref_metadata.get("summary") or "").strip()
        rerank_q = (title + "。" + ref_summary) if (title and ref_summary) else None


        queries = self._build_menu_queries(title, ref_text)
        cand_nodes: list[OGNode] = []
        seen_ids: set[str] = set()
        try:
            hits = vector_store.search_multi(
                queries,
                top_k_per_query=MENU_PER_WINDOW_TOP_K,
                top_n=self.candidate_node_top_k * 3,
                rrf_k=MENU_RRF_K,
                rerank_query=rerank_q,
            )
        except Exception as e:
            print(f"      [warn] multi-window retrieval failed ({type(e).__name__}: "
                  f"{str(e)[:80]}); fallback to LocateAgent")
            hits = []
        for hit in hits:
            md = hit.get("metadata") or {}
            node_id = md.get("node_id") or md.get("ref_id")
            if not node_id:
                continue
            node = og.get_node(node_id)
            if not node or node.status != NodeStatus.ACTIVE:
                continue
            if node.type == NodeType.REFERENCE:
                continue
            if node.id in seen_ids:
                continue
            seen_ids.add(node.id)
            cand_nodes.append(node)
            if len(cand_nodes) >= self.candidate_node_top_k:
                break


        if len(cand_nodes) < self.candidate_node_top_k:
            fake_delta = {
                "title": title,
                "content": (ref_text or "")[:REF_TEXT_MAX_CHARS_IN_PROMPT],
                "topic_keywords": [],
            }
            locator = LocateAgent(
                top_k_chunks=20,
                max_coarse_sections=None,
                max_fine_results=self.candidate_node_top_k,
            )
            try:
                cands = locator.locate(og, fake_delta, vector_store)
            except Exception as e:
                print(f"      [warn] LocateAgent fallback failed during ref menu build: {e}")
                cands = []
            for r in cands:
                if r.node and r.node.id not in seen_ids:
                    seen_ids.add(r.node.id)
                    cand_nodes.append(r.node)
                    if len(cand_nodes) >= self.candidate_node_top_k:
                        break


        if not cand_nodes:
            for n in og.get_all_nodes(NodeType.SECTION, NodeStatus.ACTIVE):
                if n.id not in seen_ids:
                    seen_ids.add(n.id)
                    cand_nodes.append(n)
            for n in og.get_all_nodes(status=NodeStatus.ACTIVE):
                if n.type in (NodeType.SECTION, NodeType.REFERENCE):
                    continue
                if n.id not in seen_ids and len(cand_nodes) < self.candidate_node_top_k:
                    seen_ids.add(n.id)
                    cand_nodes.append(n)



        section_titles: dict[str, str] = {}
        for n in cand_nodes:
            if n.type == NodeType.SECTION:
                section_titles[n.title] = n.id
        for n in cand_nodes:
            for e in og.get_incoming_edges(n.id):
                pn = og.get_node(e.source_id)
                if pn and pn.type == NodeType.SECTION and pn.title not in section_titles:
                    section_titles[pn.title] = pn.id


        all_section_titles = sorted({
            s.title for s in og.get_all_nodes(NodeType.SECTION, NodeStatus.ACTIVE)
            if s.title and s.title != "报告根节点"
        })


        lines: list[str] = []
        allowed_temp_ids: list[str] = []

        def _node_label(n: OGNode) -> str:

            tid = n.id
            allowed_temp_ids.append(tid)
            ps_title = ""
            for e in og.get_incoming_edges(n.id):
                pn = og.get_node(e.source_id)
                if pn and pn.type == NodeType.SECTION:
                    ps_title = pn.title
                    break
            content_preview = (n.content_summary or "")[:200].replace("\n", " ")
            return (f"  - temp_id={tid}  type={n.type.value}  "
                    f"parent_section='{ps_title}'\n"
                    f"    title: {n.title or ''}\n"
                    f"    content: {content_preview}")


        sec_block = [n for n in cand_nodes if n.type == NodeType.SECTION]
        non_sec_block = [n for n in cand_nodes if n.type != NodeType.SECTION]
        if sec_block:
            lines.append("[相关章节]")
            for n in sec_block:
                lines.append(_node_label(n))
        if non_sec_block:
            lines.append("[相关内容节点]")
            for n in non_sec_block:
                lines.append(_node_label(n))

        if all_section_titles:
            lines.append("\n[全部 active section 名字 — CREATE 时 parent_section 必须从这里选]")
            for t in all_section_titles:
                lines.append(f"  - {t}")

        return "\n".join(lines), allowed_temp_ids, {t: tid for t, tid in section_titles.items()}

    def _extract_candidate_deltas_for_ref(
        self,
        ref_number: int,
        ref_text: str,
        ref_metadata: dict,
        og: OutlineGraph,
        vector_store,
        period_label: str,
        period_year_range: tuple[int, int],
    ) -> list[CandidateDelta] | None:

        menu_text, allowed_ids, _section_lookup = self._build_candidate_node_menu(
            og, ref_text, ref_metadata, vector_store,
        )

        og_hash = _og_outline_hash(og)


        ckey = _sha256_short(
            f"{ref_number}|{_ref_text_hash(ref_text)}|{og_hash}|"
            f"{self.topic}|{period_label}|period={period_year_range}|"
            f"task={getattr(self, 'task_year_range', None)}|"
            f"menu={MENU_QUERY_MODE}|gran={LITERATURE_DELTA_GRANULARITY}|"
            f"win={MENU_WINDOW_SIZE}/{MENU_WINDOW_OVERLAP}/{MENU_MAX_WINDOWS}"
        )
        cached = self._read_cache("delta_ref", ckey)
        if cached is not None:
            return [CandidateDelta(**d) for d in cached]

        tlo, thi = (self.task_year_range
                    if getattr(self, "task_year_range", None)
                    else period_year_range)
        sys_prompt = _format_delta_system(
            self.topic, period_label, period_year_range[0],
            period_year_range[1], ref_number,
            granularity=LITERATURE_DELTA_GRANULARITY,
            task_lo=tlo, task_hi=thi,
        )
        user_msg = (
            f"【参考文献全文】(ref_number={ref_number})\n"
            f"{ref_text[:REF_TEXT_MAX_CHARS_IN_PROMPT]}\n\n"
            f"【ref 元数据】(已抽出, 仅供你参考)\n"
            f"{json.dumps({k: ref_metadata.get(k) for k in self.REQUIRED_META_FIELDS}, ensure_ascii=False)}\n\n"
            f"【当前 OG 候选节点目录】(LocateAgent 缩窄后, 共 {len(allowed_ids)} 个候选)\n"
            f"{menu_text}\n\n"
            "请按 system 消息要求, 为本 ref 输出 deltas. 如果该 ref 与当前 OG 主题无关, "
            "返回 deltas=[]."
        )

        if "minimax" in (self.model or "").lower():
            user_msg += (
                "\n\n[【硬约束 - MiniMax 模型】本模型 output 限制 1027 token, "
                "你必须且只能输出至多 1 个 delta (不允许多个). 选最重要的那个, 严格保证 JSON 完整. "
                "如果无相关事实, 返回 deltas=[]."
            )

        try:
            raw = _call_llm(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                model=self.model, max_tokens=self.max_tokens,
                temperature=self.temperature, timeout=self.timeout,
            )
        except Exception as e:
            print(f"      [warn] delta LLM failed for ref_{ref_number:03d}: {e}; skip")
            return None

        parsed = _parse_json_strict(raw)
        if not parsed or not isinstance(parsed.get("deltas"), list):
            print(f"      [warn] delta JSON parse failed for ref_{ref_number:03d}; skip")
            self._dump_failed_response(
                f"delta_ref{ref_number:03d}", raw, key_hint=ckey[:8],
            )
            return None

        cands: list[CandidateDelta] = []
        for d in parsed["deltas"]:
            cd = self._build_candidate(d, ref_number, allowed_ids, period_year_range)
            if cd is not None:
                cands.append(cd)


        self._write_cache("delta_ref", ckey, [self._candidate_to_dict(c) for c in cands])
        return cands

    def _build_candidate(
        self,
        d: dict,
        ref_number: int,
        allowed_temp_ids: list[str],
        period_year_range: tuple[int, int],
    ) -> CandidateDelta | None:
        if not isinstance(d, dict):
            return None
        issues: list[str] = []

        target_op = (d.get("target_op") or "").strip().upper()
        if target_op not in {"SUPERSEDE", "AUGMENT", "CREATE",
                              "UPDATE", "DELETE", "RECONTEXTUALIZE"}:
            issues.append(f"invalid target_op={target_op!r}; default to AUGMENT")
            target_op = "AUGMENT" if d.get("target_node") else "CREATE"

        target_node = (d.get("target_node") or "").strip() or None
        if target_op not in ("CREATE",) and target_node not in allowed_temp_ids:

            issues.append(f"target_node {target_node!r} not in candidate menu; switch to CREATE")
            target_op = "CREATE"
            target_node = None



        dy = _normalize_year(d.get("data_year"))
        plo, phi = period_year_range

        tlo, thi = (self.task_year_range
                    if getattr(self, "task_year_range", None)
                    else (plo, phi))
        if dy is None:
            issues.append("data_year 缺失; clip 到 task_year_range hi")
            dy = thi
        elif not (tlo <= dy <= thi):
            issues.append(f"data_year {dy} out of task [{tlo},{thi}]; clip")
            dy = max(tlo, min(thi, dy))
        elif not (plo <= dy <= phi):

            issues.append(f"data_year {dy} out of period [{plo},{phi}] "
                          f"(in task [{tlo},{thi}]); kept as-is")

        cited_refs = list(dict.fromkeys(int(x) for x in (d.get("cited_refs") or [])
                                          if isinstance(x, (int, float, str))
                                          and str(x).isdigit()))
        if ref_number not in cited_refs:
            cited_refs.append(ref_number)

        data_points: list[dict] = []
        for dp in (d.get("data_points") or []):
            if not isinstance(dp, dict):
                continue
            dpy = _normalize_year(dp.get("data_year")) or dy
            data_points.append({
                "data_id": str(dp.get("data_id") or f"D-{ref_number:03d}-{len(data_points)+1:02d}"),
                "value": str(dp.get("value", "")),
                "label": str(dp.get("label", "")),
                "data_year": dpy,
                "source_ref": int(dp.get("source_ref") or ref_number),
            })

        cd = CandidateDelta(
            ref_number=ref_number,
            delta_type=str(d.get("delta_type", "new_finding")),
            title=str(d.get("title", ""))[:120].strip(),
            content=str(d.get("content", "")).strip(),
            data_year=dy,
            topic_keywords=[str(k) for k in (d.get("topic_keywords") or [])][:5],
            data_points=data_points,
            cited_refs=cited_refs,
            target_op=target_op,
            target_node=target_node,
            node_type=(str(d.get("node_type")).strip()
                       if d.get("node_type") else None),
            rhetorical_role=(str(d.get("rhetorical_role")).strip()
                             if d.get("rhetorical_role") else None),
            parent_section=(str(d.get("parent_section")).strip()
                            if d.get("parent_section") else None),
            raw=d,
            issues=issues,
        )
        if not cd.title and not cd.content:
            return None
        if target_op == "CREATE":

            if not cd.node_type or cd.node_type not in ALLOWED_NODE_TYPES:
                old = cd.node_type
                cd.node_type = "Evidence"
                if old:
                    cd.issues.append(
                        f"CREATE node_type {old!r} not in whitelist; default Evidence"
                    )
                else:
                    cd.issues.append("CREATE missing node_type; default Evidence")
            if not cd.rhetorical_role or cd.rhetorical_role not in ALLOWED_RHETORICAL_ROLES:
                old = cd.rhetorical_role
                cd.rhetorical_role = DEFAULT_ROLE_FOR_TYPE.get(cd.node_type, "evidence")
                if old:
                    cd.issues.append(
                        f"CREATE rhetorical_role {old!r} not in whitelist; "
                        f"default {cd.rhetorical_role!r}"
                    )
                else:
                    cd.issues.append("CREATE missing rhetorical_role; "
                                     f"default {cd.rhetorical_role!r}")
            if not cd.parent_section:
                cd.issues.append("CREATE missing parent_section; will go to fallback section")
        return cd

    @staticmethod
    def _candidate_to_dict(c: CandidateDelta) -> dict:
        return {
            "ref_number": c.ref_number,
            "delta_type": c.delta_type,
            "title": c.title, "content": c.content,
            "data_year": c.data_year,
            "topic_keywords": c.topic_keywords,
            "data_points": c.data_points,
            "cited_refs": c.cited_refs,
            "target_op": c.target_op,
            "target_node": c.target_node,
            "node_type": c.node_type,
            "rhetorical_role": c.rhetorical_role,
            "parent_section": c.parent_section,
            "raw": c.raw,
            "issues": c.issues,
            "is_valid": c.is_valid,
        }

    def extract_all_candidate_deltas(
        self,
        ref_texts: dict[int, str],
        ref_metadata_map: dict[int, dict],
        og: OutlineGraph,
        vector_store,
        period_label: str,
        period_year_range: tuple[int, int],
        initial: dict[int, list[CandidateDelta]] | None = None,
        on_progress=None,
    ) -> dict[int, list[CandidateDelta]]:
        out: dict[int, list[CandidateDelta]] = dict(initial or {})
        if not ref_texts:
            return out
        pending = {n: t for n, t in ref_texts.items() if n not in out}
        print(f"  [Phase 2] 为 {len(ref_texts)} 篇 ref 抽 candidate deltas "
              f"(parallel={self.parallel}, top_k_candidates={self.candidate_node_top_k}, "
              f"cached={len(out)}, pending={len(pending)})")
        if not pending:
            return out


        with ThreadPoolExecutor(max_workers=self.parallel) as ex:
            futs = {
                ex.submit(
                    self._extract_candidate_deltas_for_ref,
                    n, t, ref_metadata_map.get(n, {}), og, vector_store,
                    period_label, period_year_range,
                ): n for n, t in pending.items()
            }
            for fut in as_completed(futs):
                n = futs[fut]
                try:
                    cands = fut.result()
                    if cands is None:
                        print(f"    [delta] ref_{n:03d} FAILED (will retry next run)")
                        continue
                    out[n] = cands
                    print(f"    [delta] ref_{n:03d} → {len(cands)} candidate(s)")
                    if on_progress is not None:
                        on_progress(n, cands, out)
                except Exception as e:
                    print(f"    [delta] ref_{n:03d} ERROR: {e}")
        return out



    @staticmethod
    def _op_strength(op: str) -> int:
        try:
            return OP_STRENGTH_ORDER.index(op)
        except ValueError:
            return -1

    def _compute_create_title_embeddings(self, creates: list) -> list | None:
        if not creates:
            return None
        try:



            from sentence_transformers import SentenceTransformer
            model_name = os.environ.get("EMBEDDER_BACKEND", "bge-m3")
            if model_name.startswith("openai"):

                return None
            hf_name = {
                "bge-m3": "BAAI/bge-m3",
                "bce": "maidalun1020/bce-embedding-base_v1",
                "minilm": "sentence-transformers/all-MiniLM-L6-v2",
            }.get(model_name, model_name)

            if not hasattr(self, "_embed_model"):
                self._embed_model = SentenceTransformer(hf_name)
            titles = [c.title or "" for c in creates]
            return self._embed_model.encode(titles, show_progress_bar=False).tolist()
        except Exception as e:
            print(f"  [warn] CREATE embedding 计算失败 ({type(e).__name__}: {str(e)[:60]}), "
                  f"fallback 仅用 Jaccard")
            return None

    @staticmethod
    def _cosine(a: list[float], b: list[float]) -> float:
        if not a or not b:
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(y * y for y in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    @staticmethod
    def _title_jaccard(a: str, b: str) -> float:
        def _bg(s: str) -> set[str]:
            s = re.sub(r"\s+", "", s or "")
            if len(s) < 2:
                return set([s]) if s else set()
            return {s[i:i+2] for i in range(len(s) - 1)}
        sa, sb = _bg(a), _bg(b)
        if not sa and not sb:
            return 1.0
        if not sa or not sb:
            return 0.0
        return len(sa & sb) / len(sa | sb)

    def _merge_data_points(self, *groups: list[dict]) -> list[dict]:
        seen = set()
        out: list[dict] = []
        for grp in groups:
            for dp in grp:
                key = ((dp.get("label") or "").strip(),
                       str(dp.get("value") or "").strip(),
                       _normalize_year(dp.get("data_year")))
                if key in seen:
                    continue
                seen.add(key)
                out.append(dp)
        return out

    def _merge_into_one(self, group: list[CandidateDelta]) -> CandidateDelta:

        primary = max(group, key=lambda c: self._op_strength(c.target_op))
        merged_cited = sorted({r for c in group for r in c.cited_refs})
        merged_dp = self._merge_data_points(*[c.data_points for c in group])
        merged_keywords: list[str] = []
        seen_kw = set()
        for c in group:
            for kw in c.topic_keywords:
                if kw and kw not in seen_kw:
                    seen_kw.add(kw)
                    merged_keywords.append(kw)

        primary_c = primary.content or ""
        for c in group:
            if c is primary:
                continue
            if c.content and c.content not in primary_c:

                first_sent = re.split(r"[。；\n]", c.content, 1)[0].strip()
                if first_sent and first_sent not in primary_c:
                    primary_c = primary_c.rstrip("。") + "。" + first_sent + "。"

        merged_issues = []
        for c in group:
            for iss in c.issues:
                if iss not in merged_issues:
                    merged_issues.append(iss)
        if len(group) > 1:
            merged_issues.append(
                f"merged from {len(group)} candidates "
                f"(refs={[c.ref_number for c in group]})"
            )
        return CandidateDelta(
            ref_number=primary.ref_number,
            delta_type=primary.delta_type,
            title=primary.title,
            content=primary_c,
            data_year=max(c.data_year for c in group),
            topic_keywords=merged_keywords[:5],
            data_points=merged_dp,
            cited_refs=merged_cited,
            target_op=primary.target_op,
            target_node=primary.target_node,
            node_type=primary.node_type,
            rhetorical_role=primary.rhetorical_role,
            parent_section=primary.parent_section,
            raw=primary.raw,
            issues=merged_issues,
        )

    def merge_candidate_deltas(
        self,
        per_ref: dict[int, list[CandidateDelta]],
    ) -> list[CandidateDelta]:

        flat: list[CandidateDelta] = []
        for refn, cands in per_ref.items():
            flat.extend(cands)


        by_target: dict[str, list[CandidateDelta]] = defaultdict(list)
        creates: list[CandidateDelta] = []
        for c in flat:
            if c.target_op != "CREATE" and c.target_node:
                by_target[c.target_node].append(c)
            else:
                creates.append(c)

        merged: list[CandidateDelta] = []
        for target, group in by_target.items():
            if len(group) == 1:
                merged.append(group[0])
            else:
                merged.append(self._merge_into_one(group))



        title_embeds = self._compute_create_title_embeddings(creates)
        used = [False] * len(creates)
        for i in range(len(creates)):
            if used[i]:
                continue
            cluster = [creates[i]]
            used[i] = True
            for j in range(i + 1, len(creates)):
                if used[j]:
                    continue
                ci, cj = creates[i], creates[j]
                same_section = (ci.parent_section or "") == (cj.parent_section or "")
                same_year = ci.data_year == cj.data_year
                if not (same_section and same_year):
                    continue
                jac = self._title_jaccard(ci.title, cj.title)
                similar = jac >= CREATE_TITLE_JACCARD_THRESHOLD
                if not similar and title_embeds is not None:
                    cos = self._cosine(title_embeds[i], title_embeds[j])
                    if cos >= CREATE_TITLE_EMBEDDING_THRESHOLD:
                        similar = True
                if similar:
                    cluster.append(cj)
                    used[j] = True
            merged.append(self._merge_into_one(cluster) if len(cluster) > 1
                          else cluster[0])

        n_pre = sum(len(v) for v in per_ref.values())
        print(f"  [Phase 3] 启发式合并: {n_pre} candidate(s) → {len(merged)} delta(s) "
              f"(↓{n_pre - len(merged)})")
        return merged



    def finalize_deltas(
        self,
        merged: list[CandidateDelta],
        period_label: str,
        period_year_range: tuple[int, int],
        og: OutlineGraph,
        new_references: list[dict],
    ) -> list[dict]:

        existing_ref_numbers = {n.ref_number for n in og.get_all_nodes(NodeType.REFERENCE)
                                 if n.ref_number is not None}
        new_ref_numbers = {int(r["ref_number"]) for r in new_references
                           if r.get("ref_number") is not None}
        valid_ref_numbers = existing_ref_numbers | new_ref_numbers

        out: list[dict] = []
        for i, c in enumerate(merged, 1):
            issues = list(c.issues)
            cited = [r for r in c.cited_refs if r in valid_ref_numbers]
            if not cited:

                if c.ref_number in valid_ref_numbers:
                    cited = [c.ref_number]
                else:
                    issues.append(f"all cited_refs invalid: {c.cited_refs}; "
                                  "no fallback available")
            elif len(cited) != len(c.cited_refs):
                issues.append(f"dropped invalid refs from cited_refs: "
                              f"{set(c.cited_refs) - set(cited)}")

            d: dict[str, Any] = {
                "id": f"D{period_label}-{i:02d}",
                "delta_type": c.delta_type,
                "title": c.title,
                "content": c.content,
                "data_year": c.data_year,
                "topic_keywords": c.topic_keywords,
                "data_points": c.data_points,
                "cited_refs": cited,
                "target_op": c.target_op,
            }
            if c.target_node:
                d["target_node"] = c.target_node
            if c.target_op == "CREATE":
                d["node_type"] = c.node_type or "Evidence"
                d["rhetorical_role"] = c.rhetorical_role or "evidence"
                if c.parent_section:
                    d["parent_section"] = c.parent_section
            if issues:
                d["_issues"] = issues
            out.append(d)
        return out



    def analyze_delta(
        self,
        new_ref_dir: Path,
        new_ref_range: tuple[int, int],
        current_og: OutlineGraph,
        vector_store,
        period_label: str,
        period_year_range: tuple[int, int],
        out_path: Path,
        audit_dir: Path | None = None,
        ref_number_offset: int = 0,
    ) -> dict:
        if self.mode != "delta":
            raise RuntimeError("analyze_delta() requires mode='delta'")

        if audit_dir is not None:
            audit_dir.mkdir(parents=True, exist_ok=True)

        ref_texts = self._load_ref_texts(new_ref_dir, new_ref_range, ref_number_offset)
        if not ref_texts:
            print(f"  [literature/delta v{period_label}] 0 篇 ref 可读, 写空 update")
            empty = {"deltas": [], "new_references": []}
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(empty, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
            return empty


        meta_map = self.extract_all_metadata(ref_texts, period_year_range)

        partial_path = out_path.with_name(f"{out_path.stem}.partial.json")
        partial_candidates = self._load_partial_candidates(partial_path, ref_texts)

        def _write_partial(_ref_number=None, _cands=None, current=None):
            current = current or partial_candidates
            payload = {
                "period_label": period_label,
                "period_year_range": list(period_year_range),
                "complete_refs": sorted(int(n) for n in current.keys()),
                "pending_refs": sorted(int(n) for n in ref_texts.keys()
                                       if int(n) not in current),
                "new_references": [
                    {
                        "ref_number": int(n),
                        "title": meta_map[n].get("title", ""),
                        "author": meta_map[n].get("author", ""),
                        "url": meta_map[n].get("url", ""),
                        "publish_date": meta_map[n].get("publish_date", ""),
                        "data_year": meta_map[n].get("data_year", ""),
                        "tier": meta_map[n].get("tier", "T2"),
                    }
                    for n in sorted(meta_map.keys())
                ],
                "candidate_deltas_per_ref": {
                    str(n): [self._candidate_to_dict(c) for c in cs]
                    for n, cs in sorted(current.items())
                },
                "updated_at": time.time(),
            }
            partial_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = partial_path.with_suffix(partial_path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2,
                                      default=str), encoding="utf-8")
            tmp.replace(partial_path)


        per_ref_cands = self.extract_all_candidate_deltas(
            ref_texts, meta_map, current_og, vector_store,
            period_label, period_year_range,
            initial=partial_candidates,
            on_progress=_write_partial,
        )
        _write_partial(current=per_ref_cands)
        missing_refs = sorted(n for n in ref_texts.keys() if n not in per_ref_cands)
        if missing_refs and os.environ.get("LITERATURE_ALLOW_PARTIAL_UPDATE", "0") != "1":
            raise RuntimeError(
                f"delta extraction incomplete for v{period_label}: "
                f"{len(missing_refs)} ref(s) failed/pending {missing_refs}. "
                f"Partial progress saved to {partial_path.name}; rerun will resume."
            )


        merged = self.merge_candidate_deltas(per_ref_cands)


        new_references = []
        for n in sorted(meta_map.keys()):
            m = meta_map[n]
            new_references.append({
                "ref_number": n,
                "title": m.get("title", ""),
                "author": m.get("author", ""),
                "url": m.get("url", ""),
                "publish_date": m.get("publish_date", ""),
                "data_year": m.get("data_year", ""),
                "tier": m.get("tier", "T2"),
            })

        deltas = self.finalize_deltas(
            merged, period_label, period_year_range,
            current_og, new_references,
        )

        update_dict = {"deltas": deltas, "new_references": new_references}
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(update_dict, ensure_ascii=False, indent=2),
                             encoding="utf-8")
        print(f"  [literature/delta v{period_label}] 写出 {out_path.name}: "
              f"{len(deltas)} deltas + {len(new_references)} new_references")

        if audit_dir is not None:
            audit_dir.mkdir(parents=True, exist_ok=True)
            (audit_dir / "01_per_ref_metadata.json").write_text(
                json.dumps(meta_map, ensure_ascii=False, indent=2,
                            default=str),
                encoding="utf-8",
            )
            (audit_dir / "02_candidate_deltas_per_ref.json").write_text(
                json.dumps(
                    {str(n): [self._candidate_to_dict(c) for c in cs]
                     for n, cs in per_ref_cands.items()},
                    ensure_ascii=False, indent=2, default=str,
                ),
                encoding="utf-8",
            )
            (audit_dir / "03_merged_candidates.json").write_text(
                json.dumps([self._candidate_to_dict(c) for c in merged],
                            ensure_ascii=False, indent=2, default=str),
                encoding="utf-8",
            )

        return update_dict



    def _design_outline(
        self,
        meta_map: dict[int, dict],
        ref_texts: dict[int, str],
        period_year_range: tuple[int, int],
    ) -> list[dict]:

        ref_keys = sorted(meta_map.keys())
        ckey = _sha256_short(
            f"outline|{self.topic}|{period_year_range}|"
            + json.dumps(ref_keys, ensure_ascii=False)
            + "|" + json.dumps([_ref_text_hash(ref_texts.get(n, ""))[:8]
                                  for n in ref_keys], ensure_ascii=False)
        )
        cached = self._read_cache("outline", ckey)
        if cached is not None:
            return cached


        ref_menu_lines = []
        for n in ref_keys:
            m = meta_map[n]
            text = ref_texts.get(n, "")
            abstract = (text[:300] or "").replace("\n", " ")
            ref_menu_lines.append(
                f"  ref_{n:03d}  ({m.get('publish_date', '')}, "
                f"{m.get('tier', 'T2')})\n"
                f"    title: {m.get('title', '')[:80]}\n"
                f"    abstract: {abstract}"
            )

        sys_prompt = _format_outline_system(
            self.topic, period_year_range[0], period_year_range[1],
        )
        user_msg = (
            f"【参考文献池】 (共 {len(ref_keys)} 篇)\n"
            f"{chr(10).join(ref_menu_lines)}\n\n"
            "请设计 8-15 个 section, 每个标注哪些 ref 最相关. 输出严格 JSON, "
            "**不要任何解释性前后文, 不要 markdown 代码块包裹, 直接以 { 开头以 } 结尾**."
        )


        def _try_outline(user_message: str) -> dict | None:
            try:
                raw = _call_llm(
                    [{"role": "system", "content": sys_prompt},
                     {"role": "user", "content": user_message}],
                    model=self.model, max_tokens=max(8000, self.max_tokens),
                    temperature=self.temperature, timeout=self.timeout,
                )
            except Exception as e:
                print(f"      [warn] outline LLM call failed: {e}")
                return None
            parsed = _parse_json_strict(raw)
            if not parsed or not isinstance(parsed.get("sections"), list):
                self._dump_failed_response("outline", raw, key_hint=ckey[:8])
                return None
            return parsed

        def _validate_outline_refs(parsed: dict) -> tuple[bool, str]:
            sections = parsed.get("sections") or []
            empty_secs = []
            covered_refs: set[int] = set()
            for sec in sections:
                nm = (sec.get("name") or "").strip()
                cand = sec.get("candidate_ref_numbers") or []
                valid_refs = []
                for r in cand:
                    try:
                        rn = int(r)
                        if rn in meta_map:
                            valid_refs.append(rn)
                    except (TypeError, ValueError):
                        continue
                if not valid_refs:
                    empty_secs.append(nm)
                else:
                    covered_refs.update(valid_refs)
            uncovered = sorted(set(meta_map.keys()) - covered_refs)
            errs = []
            if empty_secs:
                errs.append(
                    f"以下 {len(empty_secs)} 个 section 的 candidate_ref_numbers "
                    f"为空 (违反硬约束 5): {empty_secs[:5]}"
                )
            if uncovered:
                errs.append(
                    f"以下 {len(uncovered)} 个 ref 未被任何 section 覆盖 "
                    f"(违反硬约束 6): {uncovered[:10]}"
                )
            if errs:
                return False, " | ".join(errs)
            return True, ""


        parsed = _try_outline(user_msg)
        if parsed is None:
            print("      [retry-1] outline JSON parse 失败, 用更严的 prompt retry")
            stricter_msg = user_msg + (
                "\n\n!!! 上次输出 JSON 解析失败. 请极其严格地遵守: "
                "string value 里所有 ASCII \" 都必须转义为 \\\" 或改用「」中文引号. "
                "不要任何 markdown / 解释, 只输出能直接 json.loads 的 {} 块. "
                "若仍含未转义 \", 该响应将被丢弃, 整批 cluster 失败."
            )
            parsed = _try_outline(stricter_msg)


        if parsed is not None:
            ok, err_msg = _validate_outline_refs(parsed)
            if not ok:
                print(f"      [retry-2] outline 语义校验失败: {err_msg}")
                fix_msg = user_msg + (
                    f"\n\n!!! 上次输出违反硬约束:\n{err_msg}\n\n"
                    "请严格修正并重新输出完整 JSON:\n"
                    "1. 每个 section 的 candidate_ref_numbers 必须是非空整数数组 "
                    "(至少 1 个 ref_number).\n"
                    "2. 所有 ref 编号 (1 到 N) 都必须被至少一个 section 覆盖.\n"
                    "3. 如果你认为某些 ref 不适合分配到任何特定主题, 放入「摘要 / 综述」"
                    "或「附录 / 其他」section 兜底.\n"
                    "再次空数组或漏 ref 将导致响应被永久丢弃."
                )
                parsed_retry = _try_outline(fix_msg)
                if parsed_retry is not None:
                    ok2, _ = _validate_outline_refs(parsed_retry)
                    if ok2:
                        parsed = parsed_retry
                        print("      [retry-2] ✓ 修正成功, 使用新 outline")
                    else:
                        print("      [retry-2] 二次仍失败, 将走 similarity fallback")

        if parsed is None:
            print("      [warn] outline 多次重试仍失败; fallback to 1 generic section")
            return self._fallback_outline(meta_map)

        outline = []
        for sec in parsed["sections"]:
            if not isinstance(sec, dict):
                continue
            nm = (sec.get("name") or "").strip()
            if not nm:
                continue
            cand_refs = []
            for r in (sec.get("candidate_ref_numbers") or []):
                try:
                    rn = int(r)
                    if rn in meta_map:
                        cand_refs.append(rn)
                except (TypeError, ValueError):
                    continue
            outline.append({
                "name": nm,
                "description": (sec.get("description") or "").strip(),
                "candidate_ref_numbers": cand_refs,
            })




        outline = self._dedupe_outline(outline)



        outline = self._assign_refs_via_similarity(outline, meta_map, ref_texts)

        self._write_cache("outline", ckey, outline)
        return outline

    @staticmethod
    def _assign_refs_via_similarity(
        outline: list[dict],
        meta_map: dict[int, dict],
        ref_texts: dict[int, str],
        top_k: int = 8,
        min_score: float = 1.0,
    ) -> list[dict]:
        def _tokenize(text: str) -> set[str]:
            text = (text or "").lower()

            words = set(re.findall(r"[a-z]{3,}", text))

            cn = re.sub(r"[^\u4e00-\u9fff]", "", text)
            bigrams = {cn[i:i+2] for i in range(len(cn) - 1)} if len(cn) >= 2 else set()
            return words | bigrams


        ref_tokens: dict[int, tuple[set[str], set[str]]] = {}
        for n, m in meta_map.items():
            title = m.get("title", "") or ""
            body_head = (ref_texts.get(n, "") or "")[:500]
            ref_tokens[n] = (_tokenize(title), _tokenize(body_head))

        for sec in outline:
            if sec.get("candidate_ref_numbers"):
                continue
            sec_tokens = _tokenize(sec.get("name", "") + " " + sec.get("description", ""))
            if not sec_tokens:
                sec["candidate_ref_numbers"] = sorted(meta_map.keys())
                continue
            scores: list[tuple[int, float]] = []
            for n, (title_tok, body_tok) in ref_tokens.items():

                title_hits = len(sec_tokens & title_tok)
                body_hits = len(sec_tokens & body_tok)
                score = 2.0 * title_hits + 1.0 * body_hits
                if score > 0:
                    scores.append((n, score))
            scores.sort(key=lambda x: (-x[1], x[0]))

            passed = [n for n, s in scores if s >= min_score][:top_k]
            if not passed:

                passed = [n for n, _ in scores[:3]] or sorted(meta_map.keys())
            sec["candidate_ref_numbers"] = sorted(passed)
            print(f"      [auto-assign] '{sec.get('name', '')[:30]}' → "
                  f"{len(passed)} refs (top scores: "
                  f"{[(n, round(s,1)) for n, s in scores[:3]]})")
        return outline

    @staticmethod
    def _dedupe_outline(outline: list[dict]) -> list[dict]:
        def _bigrams(s: str) -> set[str]:
            s = re.sub(r"\s+", "", s or "")
            return {s[i:i+2] for i in range(len(s) - 1)} if len(s) >= 2 else set()
        def _jaccard(a: set, b: set) -> float:
            if not a and not b: return 1.0
            if not a or not b: return 0.0
            return len(a & b) / len(a | b)


        result = []
        merged_indices = set()
        for i, sec_i in enumerate(outline):
            if i in merged_indices:
                continue
            merged = dict(sec_i)
            cand_refs = list(merged.get("candidate_ref_numbers", []))
            for j in range(i + 1, len(outline)):
                if j in merged_indices:
                    continue
                sec_j = outline[j]
                ti = (sec_i.get("name") or "").strip()
                tj = (sec_j.get("name") or "").strip()

                ti_core = re.sub(r"^[一二三四五六七八九十百\d]+[、\.]\s*", "", ti)
                tj_core = re.sub(r"^[一二三四五六七八九十百\d]+[、\.]\s*", "", tj)
                jac = _jaccard(_bigrams(ti_core), _bigrams(tj_core))
                if jac >= 0.5 or (ti_core and tj_core and
                                    (ti_core in tj_core or tj_core in ti_core)):
                    print(f"      [B6] outline 重叠合并: '{ti}' ↔ '{tj}' "
                          f"(Jaccard={jac:.2f})")

                    cand_refs.extend(sec_j.get("candidate_ref_numbers", []))
                    if len(sec_j.get("description", "")) > len(merged.get("description", "")):
                        merged["description"] = sec_j["description"]
                    merged_indices.add(j)
            merged["candidate_ref_numbers"] = sorted(set(cand_refs))
            result.append(merged)
        if len(result) < len(outline):
            print(f"      [B6] outline 去重: {len(outline)} → {len(result)} sections")
        return result

    @staticmethod
    def _fallback_outline(meta_map: dict[int, dict]) -> list[dict]:
        return [{
            "name": "综述",
            "description": "本期所有内容的综合性综述 (LLM outline 步骤失败时的兜底)",
            "candidate_ref_numbers": sorted(meta_map.keys()),
        }]

    def _extract_nodes_for_section(
        self,
        section: dict,
        meta_map: dict[int, dict],
        ref_texts: dict[int, str],
        period_year_range: tuple[int, int],
    ) -> list[dict]:
        cand_refs = section.get("candidate_ref_numbers") or []



        if not cand_refs:
            cand_refs = sorted(meta_map.keys())
            print(f"      [warn] section '{section.get('name', '')}' 无 candidate_refs, "
                  f"fallback 到全部 {len(cand_refs)} refs")


        ref_block_lines = []
        total = 0
        max_total = 12000
        for rn in cand_refs:
            text = ref_texts.get(rn, "")
            if not text:
                continue
            chunk = text[:REF_TEXT_MAX_CHARS_IN_PROMPT]
            entry = (f"=== ref_{rn:03d} (title: {meta_map.get(rn, {}).get('title', '')[:80]}) ===\n"
                     f"{chunk}")
            if total + len(entry) > max_total:
                break
            ref_block_lines.append(entry)
            total += len(entry)

        ckey = _sha256_short(
            f"nodes|{self.topic}|{period_year_range}|{section['name']}|"
            f"{section.get('description', '')}|"
            + json.dumps([(rn, _ref_text_hash(ref_texts.get(rn, ""))[:8])
                          for rn in cand_refs], ensure_ascii=False)
        )
        cached = self._read_cache("nodes", ckey)
        if cached is not None:
            return cached

        sys_prompt = _format_build_nodes_system(
            self.topic, period_year_range[0], period_year_range[1],
            section["name"], section.get("description", ""),
        )
        user_msg = (
            f"【相关参考文献全文】\n\n"
            f"{chr(10).join(ref_block_lines)}\n\n"
            f"请基于这些 refs 为 section 「{section['name']}」 输出节点列表."
        )

        try:
            raw = _call_llm(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                model=self.model, max_tokens=max(16000, self.max_tokens),
                temperature=self.temperature, timeout=self.timeout,
            )
        except Exception as e:
            print(f"      [warn] nodes LLM failed for section '{section['name']}': {e}")
            return []

        parsed = _parse_json_strict(raw)
        if not parsed or not isinstance(parsed.get("nodes"), list):
            print(f"      [warn] nodes JSON parse failed for section '{section['name']}'")
            self._dump_failed_response(
                f"nodes_{section['name']}", raw, key_hint=ckey[:8],
            )
            return []

        valid_refs = set(cand_refs) | set(meta_map.keys())
        nodes = []
        for nd in parsed["nodes"]:
            sanitized = self._sanitize_build_node(nd, section["name"], valid_refs)
            if sanitized:
                nodes.append(sanitized)

        self._write_cache("nodes", ckey, nodes)
        return nodes

    @staticmethod
    def _sanitize_build_node(nd: dict, section_name: str,
                              valid_refs: set[int]) -> dict | None:
        if not isinstance(nd, dict):
            return None
        ntype = (nd.get("type") or "").strip()
        if ntype not in {"Synthesis", "Context", "Claim", "Evidence", "Comparison"}:
            return None
        cited = []
        for r in (nd.get("cited_refs") or []):
            try:
                rn = int(r)
                if rn in valid_refs:
                    cited.append(rn)
            except (TypeError, ValueError):
                continue

        data_blocks = []
        for db in (nd.get("data_blocks") or []):
            if not isinstance(db, dict):
                continue
            sr = db.get("source_ref")
            try:
                sr = int(sr) if sr is not None else None
            except (TypeError, ValueError):
                sr = None
            if sr is not None and sr not in valid_refs:
                sr = None
            data_blocks.append({
                "data_id": str(db.get("data_id") or ""),
                "value": str(db.get("value", "")),
                "label": str(db.get("label", "")),
                "data_year": _normalize_year(db.get("data_year")),
                "source_ref": sr,
            })

        rhet_raw = str(nd.get("rhetorical_role") or "").strip()
        if rhet_raw not in ALLOWED_RHETORICAL_ROLES:
            rhet_raw = DEFAULT_ROLE_FOR_TYPE.get(ntype, "evidence")

        stale_raw = (nd.get("staleness_risk") or "medium").strip().lower()
        if stale_raw not in ("low", "medium", "high"):
            stale_raw = "medium"
        out = {
            "temp_id": str(nd.get("temp_id") or "").strip()[:60],
            "type": ntype,
            "rhetorical_role": rhet_raw,
            "title": str(nd.get("title") or "")[:200],
            "parent_section": section_name,
            "content_summary": str(nd.get("content_summary", "")),
            "original_text": "",
            "data_blocks": data_blocks,
            "cited_refs": cited,
            "temporal_scope": str(nd.get("temporal_scope") or ""),
            "staleness_risk": stale_raw,
            "confidence": float(nd.get("confidence") or 0.85),
        }

        if not out["temp_id"]:
            return None

        if ntype in {"Claim", "Evidence"} and not cited:
            return None
        return out

    def _infer_edges(self, all_nodes: list[dict]) -> list[dict]:
        if len(all_nodes) < 2:
            return []


        from collections import defaultdict
        by_section: dict[str, list[dict]] = defaultdict(list)
        all_temp_ids: set[str] = set()
        seen_tids: set[str] = set()
        for nd in all_nodes:
            tid = nd.get("temp_id")
            if not tid or tid in seen_tids:
                continue
            seen_tids.add(tid)
            all_temp_ids.add(tid)
            sec = nd.get("parent_section") or "<no_section>"
            by_section[sec].append(nd)

        if len(all_temp_ids) < 2:
            return []


        all_edges: list[dict] = []
        valid_edge_types_intra = {"deepens", "supports", "parallels", "contradicts"}
        for sec_name, sec_nodes in by_section.items():
            if len(sec_nodes) < 2:
                continue
            edges_in_sec = self._infer_edges_intra_section(
                sec_name, sec_nodes, valid_edge_types_intra
            )
            all_edges.extend(edges_in_sec)

        cross_candidates = [n for n in all_nodes
                             if n.get("type") in ("Synthesis", "Context",
                                                   "Comparison", "Claim")]

        if len(cross_candidates) > 50:

            sorted_c = sorted(cross_candidates,
                               key=lambda n: 0 if n.get("type") in ("Synthesis", "Context")
                                              else (1 if n.get("type") == "Comparison"
                                                    else 2))
            cross_candidates = sorted_c[:50]
        if len(cross_candidates) >= 2:
            cross_edges = self._infer_edges_cross_section(cross_candidates)
            all_edges.extend(cross_edges)


        seen_keys = set()
        deduped = []
        for e in all_edges:
            k = (e.get("source"), e.get("target"), e.get("type"))
            if k in seen_keys:
                continue
            seen_keys.add(k)
            deduped.append(e)


        for nd in all_nodes:
            for r in (nd.get("cited_refs") or []):
                try:
                    rn = int(r)
                except (TypeError, ValueError):
                    continue
                ref_temp_id = f"REF-{rn:03d}"
                deduped.append({
                    "source": nd["temp_id"], "target": ref_temp_id,
                    "type": "cites", "strength": "moderate",
                    "reason": "数据来源 (auto-added)",
                    "confidence": 0.95,
                })

        return deduped

    def _infer_edges_intra_section(self, sec_name: str, sec_nodes: list[dict],
                                     valid_edge_types: set[str]) -> list[dict]:
        valid_tids = {nd["temp_id"] for nd in sec_nodes if nd.get("temp_id")}
        if len(valid_tids) < 2:
            return []

        ckey = _sha256_short(
            f"edges_intra|{self.topic}|sec={sec_name}|"
            + json.dumps(sorted(valid_tids), ensure_ascii=False)
        )
        cached = self._read_cache("edges", ckey)
        if cached is not None:
            return cached

        node_lines = []
        for nd in sec_nodes:
            tid = nd.get("temp_id")
            if not tid:
                continue
            node_lines.append(
                f"  {tid}  type={nd.get('type')}\n"
                f"    title: {nd.get('title', '')[:80]}\n"
                f"    content: {(nd.get('content_summary', '') or '')[:160]}"
            )
        sys_prompt = _format_build_edges_system(self.topic)
        user_msg = (
            f"【章节内节点】(section: {sec_name}, 共 {len(node_lines)} 个)\n\n"
            f"{chr(10).join(node_lines)}\n\n"
            "请只推断这个 section **内部**的边 (deepens / supports / parallels / "
            "contradicts). 跨 section 的 derives_from / contextualizes 由后续\n"
            "cross-section step 处理, 这里不要输出. cites 边由框架自动加."
        )
        try:
            raw = _call_llm(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                model=self.model, max_tokens=4000,
                temperature=self.temperature, timeout=self.timeout,
            )
        except Exception as e:
            print(f"      [warn] intra-section edges LLM failed for {sec_name}: {e}")
            return []
        edges = self._parse_edges(raw, valid_tids, valid_edge_types, ckey)
        self._write_cache("edges", ckey, edges)
        return edges

    def _infer_edges_cross_section(self, cand_nodes: list[dict]) -> list[dict]:
        valid_tids = {nd["temp_id"] for nd in cand_nodes if nd.get("temp_id")}
        if len(valid_tids) < 2:
            return []
        ckey = _sha256_short(
            f"edges_cross|{self.topic}|"
            + json.dumps(sorted(valid_tids), ensure_ascii=False)
        )
        cached = self._read_cache("edges", ckey)
        if cached is not None:
            return cached

        node_lines = []
        for nd in cand_nodes:
            tid = nd.get("temp_id")
            if not tid:
                continue
            node_lines.append(
                f"  {tid}  type={nd.get('type')}  parent='{nd.get('parent_section', '')}'\n"
                f"    title: {nd.get('title', '')[:80]}\n"
                f"    content: {(nd.get('content_summary', '') or '')[:120]}"
            )
        sys_prompt = _format_build_edges_system(self.topic)
        user_msg = (
            f"【跨章节关键节点】(共 {len(node_lines)} 个 Synthesis/Context/Comparison/Claim)\n\n"
            f"{chr(10).join(node_lines)}\n\n"
            "请只推断【跨 section】的边: derives_from (Synthesis ← Claim), "
            "contextualizes (Context → Claim/Evidence), contradicts (Claim ↔ Claim). "
            "同 section 的边已由 intra-section step 处理, 不要在这里输出. "
            "cites 边由框架自动加."
        )
        valid_edge_types_cross = {"derives_from", "contextualizes", "contradicts"}
        try:
            raw = _call_llm(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                model=self.model, max_tokens=max(8000, self.max_tokens),
                temperature=self.temperature, timeout=self.timeout,
            )
        except Exception as e:
            print(f"      [warn] cross-section edges LLM failed: {e}")
            return []
        edges = self._parse_edges(raw, valid_tids, valid_edge_types_cross, ckey)
        self._write_cache("edges", ckey, edges)
        return edges

    def _parse_edges(self, raw: str, valid_tids: set[str],
                       valid_edge_types: set[str], ckey: str) -> list[dict]:
        parsed = _parse_json_strict(raw)
        if not parsed or not isinstance(parsed.get("edges"), list):
            self._dump_failed_response("edges", raw, key_hint=ckey[:8])
            return []
        edges = []
        seen = set()
        for ed in parsed["edges"]:
            if not isinstance(ed, dict):
                continue
            src = (ed.get("source") or "").strip()
            tgt = (ed.get("target") or "").strip()
            et = (ed.get("type") or "").strip()
            if (src not in valid_tids or tgt not in valid_tids
                    or src == tgt or et not in valid_edge_types):
                continue
            key = (src, tgt, et)
            if key in seen:
                continue
            seen.add(key)
            edges.append({
                "source": src, "target": tgt, "type": et,
                "strength": (ed.get("strength") or "moderate"),
                "reason": str(ed.get("reason", ""))[:200],
                "confidence": float(ed.get("confidence") or 0.8),
            })
        return edges

    def _infer_edges_legacy_oneshot(self, all_nodes: list[dict]) -> list[dict]:
        if len(all_nodes) < 2:
            return []

        node_lines = []
        valid_temp_ids = set()
        for nd in all_nodes:
            tid = nd.get("temp_id")
            if not tid or tid in valid_temp_ids:
                continue
            valid_temp_ids.add(tid)
            node_lines.append(
                f"  {tid}  type={nd.get('type')}  parent='{nd.get('parent_section', '')}'\n"
                f"    title: {nd.get('title', '')[:80]}\n"
                f"    content: {(nd.get('content_summary', '') or '')[:160]}"
            )
        if len(valid_temp_ids) < 2:
            return []

        ckey = _sha256_short(
            f"edges|{self.topic}|"
            + json.dumps(sorted(valid_temp_ids), ensure_ascii=False)
        )
        cached = self._read_cache("edges", ckey)
        if cached is not None:
            return cached

        sys_prompt = _format_build_edges_system(self.topic)
        user_msg = (
            f"【节点列表】 (共 {len(node_lines)} 个)\n\n"
            f"{chr(10).join(node_lines)}\n\n"
            "请输出语义边的列表 (cites 边由框架自动加, 不要在这里输出)."
        )

        try:
            raw = _call_llm(
                [{"role": "system", "content": sys_prompt},
                 {"role": "user", "content": user_msg}],
                model=self.model, max_tokens=max(8000, self.max_tokens),
                temperature=self.temperature, timeout=self.timeout,
            )
        except Exception as e:
            print(f"      [warn] edges LLM failed: {e}; returning empty edge set")
            return []

        parsed = _parse_json_strict(raw)
        if not parsed or not isinstance(parsed.get("edges"), list):
            print("      [warn] edges JSON parse failed")
            self._dump_failed_response("edges", raw, key_hint=ckey[:8])
            return []

        valid_edge_types = {
            "supports", "derives_from", "contradicts", "parallels",
            "deepens", "contextualizes", "compared_in",
        }
        edges = []
        seen = set()
        for ed in parsed["edges"]:
            if not isinstance(ed, dict):
                continue
            src = (ed.get("source") or "").strip()
            tgt = (ed.get("target") or "").strip()
            et = (ed.get("type") or "").strip()
            if (src not in valid_temp_ids or tgt not in valid_temp_ids
                    or src == tgt or et not in valid_edge_types):
                continue
            key = (src, tgt, et)
            if key in seen:
                continue
            seen.add(key)
            edges.append({
                "source": src, "target": tgt, "type": et,
                "strength": (ed.get("strength") or "moderate"),
                "reason": str(ed.get("reason", ""))[:200],
                "confidence": float(ed.get("confidence") or 0.8),
            })


        for nd in all_nodes:
            for r in (nd.get("cited_refs") or []):
                try:
                    rn = int(r)
                except (TypeError, ValueError):
                    continue
                ref_temp_id = f"REF-{rn:03d}"
                edges.append({
                    "source": nd["temp_id"], "target": ref_temp_id,
                    "type": "cites", "strength": "moderate",
                    "reason": "数据来源 (auto-added)",
                    "confidence": 0.95,
                })

        self._write_cache("edges", ckey, edges)
        return edges



    @staticmethod
    def build_userdict_from_build_v1(
        build_v1_path: Path,
        out_path: Path | None = None,
        min_freq: int = 2,
    ) -> Path:
        if out_path is None:
            out_path = build_v1_path.parent.parent / "jieba_userdict.txt"

        try:
            data = json.loads(build_v1_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"  [warn] build_userdict 读 {build_v1_path} 失败: {e}")
            return out_path


        from collections import Counter
        word_freq: Counter = Counter()

        cjk_re = re.compile(r"[\u4e00-\u9fff]{2,6}")
        STOPWORDS = {"分析", "报告", "数据", "情况", "影响", "发展", "增长",
                      "市场", "公司", "中国", "全球", "世界", "国际", "国家",
                      "我们", "他们", "这些", "那些", "其他", "因此", "由于"}

        def _scan(text: str):
            if not text:
                return
            for m in cjk_re.finditer(text):
                w = m.group(0)
                if w in STOPWORDS:
                    continue
                word_freq[w] += 1

        for nd in data.get("nodes", []):
            _scan(nd.get("title", ""))
            _scan(nd.get("author", ""))

            _scan((nd.get("content_summary", "") or "")[:200])


        kept = [(w, f) for w, f in word_freq.most_common() if f >= min_freq]

        kept = kept[:1000]

        out_path.parent.mkdir(parents=True, exist_ok=True)
        with out_path.open("w", encoding="utf-8") as fp:
            for w, f in kept:
                fp.write(f"{w} {f} n\n")
        print(f"  [build_userdict] 写出 {len(kept)} 个领域词 → "
              f"{out_path.relative_to(out_path.parent.parent.parent) if out_path.is_absolute() else out_path}")
        return out_path

    def analyze_build(
        self,
        ref_dir: Path,
        ref_range: tuple[int, int],
        period_year_range: tuple[int, int],
        out_path: Path,
        audit_dir: Path | None = None,
    ) -> dict:
        if self.mode != "build":
            raise RuntimeError("analyze_build() requires mode='build'")
        if audit_dir is not None:
            audit_dir.mkdir(parents=True, exist_ok=True)

        ref_texts = self._load_ref_texts(ref_dir, ref_range)
        if not ref_texts:
            print("  [literature/build v1] 0 篇 ref 可读, 写空 build_v1")
            empty = {"nodes": [], "edges": []}
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(empty, ensure_ascii=False, indent=2),
                                 encoding="utf-8")
            return empty

        print(f"\n  [literature/build v1] 启动: {len(ref_texts)} 篇 ref, "
              f"period={period_year_range}")

        meta_map = self.extract_all_metadata(ref_texts, period_year_range)


        print("  [Phase A2] 设计 outline (LLM 一次性看全部 ref title+abstract)")
        outline = self._design_outline(meta_map, ref_texts, period_year_range)
        print(f"    → {len(outline)} sections: " +
              ", ".join(s["name"][:20] for s in outline))


        print(f"  [Phase A3] per-section 节点抽取 (parallel={self.parallel}, "
              f"{len(outline)} sections)")
        all_nodes: list[dict] = []

        for n in sorted(meta_map.keys()):
            m = meta_map[n]
            all_nodes.append({
                "temp_id": f"REF-{n:03d}",
                "type": "Reference",
                "rhetorical_role": "evidence",
                "title": m.get("title", "") or f"参考文献[{n}]",
                "parent_section": "参考文献",
                "content_summary": "",
                "original_text": "",
                "data_blocks": [],
                "cited_refs": [],
                "ref_number": n,
                "author": m.get("author", ""),
                "url": m.get("url", ""),
                "publish_date": m.get("publish_date", ""),
                "data_year": m.get("data_year", ""),
                "tier": m.get("tier", "T2"),
                "temporal_scope": str(m.get("data_year", "")),
                "staleness_risk": "low",
                "confidence": 1.0,
            })


        with ThreadPoolExecutor(max_workers=self.parallel) as ex:
            futs = {
                ex.submit(self._extract_nodes_for_section,
                           sec, meta_map, ref_texts, period_year_range): sec
                for sec in outline
            }

            results: dict[str, list[dict]] = {}
            for fut in as_completed(futs):
                sec = futs[fut]
                try:
                    section_nodes = fut.result()
                except Exception as e:
                    print(f"    [{sec['name'][:24]}] ERROR: {e}; 0 节点")
                    section_nodes = []
                print(f"    [{sec['name'][:24]}] → {len(section_nodes)} 节点")
                results[sec["name"]] = section_nodes
            for sec in outline:
                all_nodes.extend(results.get(sec["name"], []))


        print(f"  [Phase A4] 边推断 (LLM 一次性看 {len(all_nodes)} 节点)")
        edges = self._infer_edges([n for n in all_nodes
                                     if n.get("type") != "Reference"])
        print(f"    → {len(edges)} edges")


        build_dict = {"nodes": all_nodes, "edges": edges}
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(build_dict, ensure_ascii=False, indent=2),
                             encoding="utf-8")
        print(f"  [literature/build v1] 写出 {out_path.name}: "
              f"{len(all_nodes)} nodes ({sum(1 for n in all_nodes if n.get('type') == 'Reference')} Reference) "
              f"+ {len(edges)} edges")

        if audit_dir is not None:
            audit_dir.mkdir(parents=True, exist_ok=True)
            (audit_dir / "01_per_ref_metadata.json").write_text(
                json.dumps(meta_map, ensure_ascii=False, indent=2,
                            default=str),
                encoding="utf-8",
            )
            (audit_dir / "02_outline.json").write_text(
                json.dumps(outline, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (audit_dir / "03_nodes.json").write_text(
                json.dumps(all_nodes, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (audit_dir / "04_edges.json").write_text(
                json.dumps(edges, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        return build_dict
