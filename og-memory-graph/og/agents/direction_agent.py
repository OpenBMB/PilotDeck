from __future__ import annotations

import hashlib
import json
import os
from typing import Optional

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

try:
    from config_models import LLM_UTIL
except ImportError:
    LLM_UTIL = "gpt-4o-mini"


_DIRECTION_SYSTEM = (
    "你是一位语义分析助手. 给定:\n"
    "  - source 节点的【修改前内容】(content_pre)\n"
    "  - source 节点的【修改后内容】(content_post)\n"
    "  - 通过某种语义边连接的 neighbor 节点内容\n\n"
    "请判断 source 的修改对 neighbor 的影响方向:\n"
    "  - strengthen : source 修改让 neighbor 的核心主张/事实【更可信/更被支持】\n"
    "  - weaken     : source 修改让 neighbor 的核心主张/事实【受到挑战/被弱化】\n"
    "  - neutral    : source 修改不影响 neighbor 的可信度 (仅扩展/无关)\n\n"
    "【输出严格 JSON】\n"
    "{\n"
    '  "direction": "strengthen" | "weaken" | "neutral",\n'
    '  "confidence": <0.0-1.0>,\n'
    '  "reason": "<10-30 字简短理由>"\n'
    "}"
)


def _hash_short(s: str, n: int = 12) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:n]


class LLMDirectionAgent:

    def __init__(self, model: str = LLM_UTIL,
                 cache: Optional[dict] = None,
                 timeout: float = 60.0,
                 max_retries: int = 3):
        self.model = model
        self._cache: dict[str, str] = cache if cache is not None else {}
        self.timeout = timeout
        self.max_retries = max_retries
        self._client = None

    def _get_client(self):
        if self._client is not None:
            return self._client
        if OpenAI is None:
            return None
        api_key = os.environ.get("OPENAI_API_KEY", "")
        base_url = os.environ.get("OPENAI_API_BASE", "https://yeysai.com/v1")
        if not api_key:
            return None
        self._client = OpenAI(api_key=api_key, base_url=base_url,
                                timeout=self.timeout, max_retries=0)
        return self._client

    def judge(self, source, neighbor, edge) -> str:


        pre = getattr(source, "_prev_content", "") or ""
        post = source.content_summary or ""
        nbr_content = neighbor.content_summary or ""


        pre = pre[:600]
        post = post[:600]
        nbr_content = nbr_content[:600]

        cache_key = _hash_short(f"{pre}|||{post}|||{nbr_content}|||{edge.type.value}")
        if cache_key in self._cache:
            return self._cache[cache_key]

        client = self._get_client()
        if client is None:
            self._cache[cache_key] = "neutral"
            return "neutral"

        user_msg = (
            f"【source 修改前】\n{pre}\n\n"
            f"【source 修改后】\n{post}\n\n"
            f"【neighbor 内容】(通过 {edge.type.value} 边连接)\n{nbr_content}"
        )

        for _ in range(self.max_retries):
            try:
                r = client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": _DIRECTION_SYSTEM},
                        {"role": "user", "content": user_msg},
                    ],
                    temperature=0.0, max_tokens=500,
                )
                content = (r.choices[0].message.content or "").strip()

                if content.startswith("```"):
                    lines = content.split("\n")
                    content = "\n".join(lines[1:])
                    if content.endswith("```"):
                        content = content[:-3]
                    content = content.strip()
                    if content.lower().startswith("json"):
                        content = content[4:].strip()

                try:
                    data = json.loads(content)
                except Exception:
                    s, e = content.find("{"), content.rfind("}")
                    if s == -1 or e == -1:
                        continue
                    data = json.loads(content[s:e+1])
                d = (data.get("direction") or "neutral").strip().lower()
                if d not in ("strengthen", "weaken", "neutral"):
                    d = "neutral"
                self._cache[cache_key] = d
                return d
            except Exception:
                continue


        self._cache[cache_key] = "neutral"
        return "neutral"
