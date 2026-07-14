from __future__ import annotations

import os



_DEFAULT_API_BASE = "https://api.deepseek.com"
_MINIMAX_API_BASE = "https://api.minimaxi.com/v1"
_QWEN_API_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
_DOUBAO_API_BASE = "https://ark.cn-beijing.volces.com/api/v3"
_DEFAULT_API_KEY = ""
_MINIMAX_API_KEY = ""
_QWEN_API_KEY = ""
_DOUBAO_API_KEY = ""
_YEYSAI_API_BASE = "https://yeysai.com/v1"
_YEYSAI_API_KEY  = ""




_DEFAULT_LLM_MAIN = "deepseek-v4-pro"
_DEFAULT_LLM_UTIL = "deepseek-v4-flash"
_DEFAULT_LLM_JUDGE = "deepseek-v4-flash"



DEFAULT_MAX_CHARS_PER_REF = 2000



def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
    except Exception:
        pass

try:
    from pathlib import Path
    _here = Path(__file__).resolve().parent
    _load_dotenv(_here / ".env")
    _load_dotenv(_here.parent / ".env")
except Exception:
    pass




LLM_MAIN = os.environ.get("LLM_MAIN") or _DEFAULT_LLM_MAIN

LLM_UTIL = os.environ.get("LLM_UTIL") or _DEFAULT_LLM_UTIL

LLM_JUDGE = os.environ.get("LLM_JUDGE") or _DEFAULT_LLM_JUDGE



_default_answers = [
    "deepseek-v4-flash"
]
_env_answers = os.environ.get("ANSWER_MODELS", "").strip()
ANSWER_MODELS: list[str] = (
    [m.strip() for m in _env_answers.split(",") if m.strip()]
    if _env_answers else _default_answers
)























def _resolve_endpoint(model: str) -> tuple[str, str]:
    if not model:
        return (os.environ.get("OPENAI_API_BASE", _DEFAULT_API_BASE),
                os.environ.get("OPENAI_API_KEY", _DEFAULT_API_KEY))
    m = model.lower()
    if "minimax" in m:
        base = os.environ.get("MINIMAX_API_BASE", _MINIMAX_API_BASE)
        key  = os.environ.get("MINIMAX_API_KEY",  _MINIMAX_API_KEY)
        if not key:
            raise RuntimeError(
                f"MiniMax API key 未配置 (env MINIMAX_API_KEY 或 "
                f"config/models.py 顶部 _MINIMAX_API_KEY). model={model!r}")
        return base, key
    if "qwen" in m:
        base = os.environ.get("QWEN_API_BASE", _QWEN_API_BASE)
        key  = os.environ.get("QWEN_API_KEY",  _QWEN_API_KEY)
        if not key:
            raise RuntimeError(
                f"Qwen API key 未配置 (env QWEN_API_KEY 或 "
                f"config/models.py 顶部 _QWEN_API_KEY). model={model!r}")
        return base, key
    if "doubao" in m:
        base = os.environ.get("DOUBAO_API_BASE", _DOUBAO_API_BASE)
        key  = os.environ.get("DOUBAO_API_KEY",  _DOUBAO_API_KEY)
        if not key:
            raise RuntimeError(
                f"Doubao API key 未配置 (env DOUBAO_API_KEY 或 "
                f"config/models.py 顶部 _DOUBAO_API_KEY). model={model!r}")
        return base, key
    if "gemini" in m or "gpt-4o" in m or "claude-sonnet" in m:


        base = os.environ.get("YEYSAI_API_BASE", _YEYSAI_API_BASE)
        key  = os.environ.get("YEYSAI_API_KEY",  _YEYSAI_API_KEY)
        if not key:
            raise RuntimeError(
                f"YeySai API key 未配置 (env YEYSAI_API_KEY 或 "
                f"config/models.py 顶部 _YEYSAI_API_KEY). model={model!r}")
        return base, key
    if "deepseek" in m:
        base = os.environ.get("DEEPSEEK_API_BASE", _DEFAULT_API_BASE)
        key  = os.environ.get("DEEPSEEK_API_KEY",  _DEFAULT_API_KEY)
        return base, key

    return (os.environ.get("OPENAI_API_BASE", _DEFAULT_API_BASE),
            os.environ.get("OPENAI_API_KEY",  _DEFAULT_API_KEY))


def _truncate_messages_for_minimax(
    messages: list[dict],
    max_input_tokens: int = 950,
) -> list[dict]:
    if not messages:
        return messages

    total_chars = sum(len(str(m.get("content", ""))) for m in messages)
    if total_chars / 1.5 <= max_input_tokens:
        return messages

    target_chars = int(max_input_tokens * 1.5 * 0.9)
    system_chars = sum(
        len(str(m.get("content", "")))
        for m in messages
        if m.get("role") in ("system",)
    )
    user_budget = max(100, target_chars - system_chars)
    out = []
    user_count = 0
    for m in messages:
        role = m.get("role", "")
        content = m.get("content", "")
        if role == "user":
            user_count += 1
            if isinstance(content, str) and len(content) > user_budget:

                kept = content[:user_budget]
                content = kept + "\n\n[注: 参考文献已截断, 仅参考上文]"
        out.append({**m, "content": content})
    return out


try:
    from functools import lru_cache
    from openai import OpenAI as _OpenAI

    @lru_cache(maxsize=32)
    def _cached_client(model: str, timeout: float) -> "_OpenAI":
        base, key = _resolve_endpoint(model)
        return _OpenAI(base_url=base, api_key=key, timeout=timeout, max_retries=0)

    def get_client_for_model(model: str, timeout: float = 60.0) -> "_OpenAI":
        return _cached_client(model, timeout)

    _PATCHED = False

    def patch_openai_for_model_dispatch() -> bool:
        global _PATCHED
        if _PATCHED:
            return True
        try:
            from openai.resources.chat.completions import Completions
            if getattr(Completions, "_og_dispatched", False):
                _PATCHED = True
                return True

            _orig_create = Completions.create

            def _dispatched_create(self, *, model, **kwargs):






                raw_to = kwargs.get("timeout")
                if isinstance(raw_to, (int, float)) and raw_to > 0:
                    to = float(raw_to)
                else:
                    to = 60.0
                target = get_client_for_model(model, timeout=to)



                from openai.resources.chat.completions import Completions as _C
                fresh = _C(target)
                r = _orig_create(fresh, model=model, **kwargs)

                try:
                    for ch in r.choices:
                        msg = ch.message
                        content = getattr(msg, "content", None) or ""
                        if content.strip():
                            continue
                        rc = getattr(msg, "reasoning_content", None) or ""
                        if rc.strip():
                            msg.content = rc.strip()
                except Exception:
                    pass
                return r

            _dispatched_create._og_dispatched = True
            Completions.create = _dispatched_create
            _PATCHED = True
            return True
        except Exception as e:
            print(f"  [models] patch_openai_for_model_dispatch 失败: {e}")
            return False
except Exception as e:
    print(f"  [models] per-model dispatch 初始化失败: {e}")
    def get_client_for_model(model: str, timeout: float = 60.0):
        raise RuntimeError("per-model dispatch 不可用 (openai 未装或 lru_cache 失败)")
    def patch_openai_for_model_dispatch() -> bool:
        return False




EMBEDDER_BACKEND = os.environ.get("EMBEDDER_BACKEND", "openai:text-embedding-3-small")
"""向量编码器后端. {bge-m3, bce, minilm, openai, openai:<model>}.

默认 openai:text-embedding-3-small (1536 维), 与 g25 现有 Chroma collection
一致。切回 bge-m3 (1024 维) 前需要清空/重建对应 collection, Chroma 不允许
同一 collection 混用不同维度的 embedding。
"""

RERANKER_BACKEND = os.environ.get("RERANKER_BACKEND", "bge-reranker-v2-m3")
"""二阶段交叉编码器 reranker. {bge-reranker-v2-m3, bce-reranker-base_v1, none}.

Reranker 是 cross-encoder: 输入 (query, candidate_text), 输出标量相关性分数。
它不复用 embedder 向量, 所以不受 embedding 维度影响。
"""

RETRIEVAL_MODE = os.environ.get("RETRIEVAL_MODE", "hybrid").lower()
"""检索模式 (v5 实装). 在 storage.vector_store.VectorStore.search 内部按此切换.

  hybrid (默认): vector (chroma cosine) + BM25 (rank_bm25) → RRF 融合
                 → cross-encoder rerank (ms-marco-MiniLM-L-6-v2)
  vector        : 纯向量 (v4 老行为, 缺依赖时自动 fallback)
  bm25          : 只用 BM25 (测试 / 调试)

依赖缺失自动 fallback:
  - 缺 rank_bm25       → 跳过 BM25, 走 vector + rerank
  - 缺 jieba           → 用字符级 bigram (切词退化但仍可用)
  - 缺 sentence_transformers / cross-encoder 模型没下 → 跳过 rerank, 走 RRF 排名

缺哪个 fallback 哪个, 不报错. 改 env: export RETRIEVAL_MODE=vector 走纯向量."""







MENU_QUERY_MODE = os.environ.get("MENU_QUERY_MODE", "multiwindow").lower()
"""Phase 2 menu 构建检索模式. {multiwindow (默认), single, hyde}.
- multiwindow: title 始终前置, ref 内容切多个滑窗, 每窗一次 hybrid, RRF 融合.
- single: v3 行为, 单一 query = title + content[:MENU_SINGLE_QUERY_CHARS].
- hyde: TODO[R1] 占位 — LLM 先写"假设 OG 节点", 用它作 query
        (跟 OG 节点 embedding 同分布, 召回精度可能 +10-20%).
        实施代价: 多 1 次 small LLM call/ref. 后续消融验证.
        当前传 'hyde' 等同 'multiwindow'."""

MENU_WINDOW_SIZE = int(os.environ.get("MENU_WINDOW_SIZE", "600"))
"""multiwindow 模式: 每个滑窗的字符数 (与 v3 单 query 长度一致便于对照)."""

MENU_WINDOW_OVERLAP = int(os.environ.get("MENU_WINDOW_OVERLAP", "100"))
"""multiwindow 模式: 相邻滑窗的字符重叠 (避免句子被切坏导致召回降级)."""

MENU_MAX_WINDOWS = int(os.environ.get("MENU_MAX_WINDOWS", "8"))
"""multiwindow 模式: 单 ref 最多切几个窗口. 8 个窗可覆盖 ~4000 字 ref, 超长截断."""

MENU_PER_WINDOW_TOP_K = int(os.environ.get("MENU_PER_WINDOW_TOP_K", "15"))
"""multiwindow 模式: 每个窗口检索 top-K candidates, 用于 RRF 融合."""

MENU_RRF_K = int(os.environ.get("MENU_RRF_K", "60"))
"""multiwindow 模式: RRF 平滑常数 (TREC 经验值 60)."""

MENU_FINAL_TOP_N = int(os.environ.get("MENU_FINAL_TOP_N", "30"))
"""Phase 2 menu 最终列出多少个候选节点 (跟 v3 一致便于 A/B 对比)."""

MENU_SINGLE_QUERY_CHARS = int(os.environ.get("MENU_SINGLE_QUERY_CHARS", "600"))
"""single 模式: query 取 title + content[:此长度]. 仅 MENU_QUERY_MODE=single 时生效."""







LOCATE_VERIFICATION_TOP_K = int(os.environ.get("LOCATE_VERIFICATION_TOP_K", "10"))
"""LocateAgent verification 阶段: 用 delta.content 跑 hybrid, 取 top-K 候选.
LLM 选的 target_node 出现在这 top-K 内 → 信 LLM; 不在 → 走 conflict 策略."""

LOCATE_CONFLICT_STRATEGY = os.environ.get("LOCATE_CONFLICT_STRATEGY", "hybrid").lower()
"""LLM target_node 与 verification 检索 top-1 不一致时的决策:
- hybrid (默认): LLM 选的 id 出现在 verification top-K → 信 LLM; 不出现 → 信检索 top-1
- trust_llm: 永远信 LLM target_node, verification 仅记录 audit
- trust_retrieval: 永远用 verification top-1 覆盖 LLM 选择
- llm_judge: TODO[R6] 占位 — 当 LLM 跟检索冲突时调小 LLM (gpt-4o-mini) 二审,
              比纯启发式更准. 代价: ~5-15% delta 触发额外 LLM call.
              当前传 'llm_judge' 等同 'hybrid'.
"""

LOCATE_VERIFICATION_USE_FULL_CONTENT = os.environ.get(
    "LOCATE_VERIFICATION_USE_FULL_CONTENT", "1") == "1"
"""verification 检索是否用完整 delta.content (vs v3 的 content[:600]).
默认 ON — delta.content 是 LLM 产的紧凑事实 (~200-400 字), 完整用不会稀释."""




LITERATURE_DELTA_GRANULARITY = os.environ.get(
    "LITERATURE_DELTA_GRANULARITY", "fine").lower()
"""Phase 2 LLM 抽 delta 的粒度. {fine (默认), coarse}.
- fine: 鼓励 LLM 拆 atomic facts, 5-10 条/ref. 每条 delta 内容自包含, 单一事实.
- coarse: v3 行为, 1-3 条/ref. 多事实可合并到一条 delta.
注: 同 target_node 的多 delta 会在 Phase 3 自动合并, 所以 fine 模式不会真的
让 OG 节点变碎 — 仅检索匹配阶段更精细."""








def _maybe_override_env(name: str, default_val: str) -> None:
    if not default_val:
        return
    old = os.environ.get(name, "")
    if old and old != default_val:
        print(f"  [models] {name}: models.py 覆盖了 env (env 旧值: ****{old[-4:]})")
    os.environ[name] = default_val

_maybe_override_env("OPENAI_API_BASE", _DEFAULT_API_BASE)
_maybe_override_env("OPENAI_API_KEY", _DEFAULT_API_KEY)

DEFAULT_API_BASE = os.environ["OPENAI_API_BASE"]
"""所有脚本默认走的 OpenAI-compatible endpoint. 本地化时改成 http://localhost:8000/v1."""




TASK_MODEL_MAP: dict[str, str] = {

    "build": LLM_MAIN,
    "update": LLM_MAIN,
    "literature_analysis": LLM_MAIN,
    "locate": LLM_MAIN,
    "modify": LLM_MAIN,
    "propagate": LLM_MAIN,
    "refresh": LLM_MAIN,

    "paragraph_rewrite": LLM_MAIN,
    "table_curation": LLM_MAIN,
    "table_naming": LLM_MAIN,
    "section_merge": LLM_MAIN,
    "node_reparent": LLM_MAIN,

    "balanced_rewrite": LLM_MAIN,
    "prose_rewrite": LLM_MAIN,

    "race_judge": LLM_JUDGE,

    "translation": LLM_UTIL,
    "gt_keyword_extract": LLM_UTIL,
    "refusal_judge": LLM_UTIL,
}


def model_for(task: str) -> str:
    return TASK_MODEL_MAP.get(task, LLM_MAIN)


def dump() -> dict:
    return {
        "LLM_MAIN": LLM_MAIN,
        "LLM_UTIL": LLM_UTIL,
        "LLM_JUDGE": LLM_JUDGE,
        "ANSWER_MODELS": ANSWER_MODELS,
        "EMBEDDER_BACKEND": EMBEDDER_BACKEND,
        "RERANKER_BACKEND": RERANKER_BACKEND,
        "DEFAULT_API_BASE": DEFAULT_API_BASE,
        "TASK_MODEL_MAP": TASK_MODEL_MAP,
    }








def patch_openai_for_reasoning_fallback() -> bool:
    try:
        from openai.resources.chat.completions import Completions
        if getattr(Completions, "_reasoning_patched", False):
            return True
        original_create = Completions.create

        def wrapped(self, *args, **kwargs):
            r = original_create(self, *args, **kwargs)
            try:
                for ch in r.choices:
                    msg = ch.message
                    content = getattr(msg, "content", None) or ""
                    if content.strip():
                        continue
                    rc = getattr(msg, "reasoning_content", None) or ""
                    if rc.strip():
                        msg.content = rc.strip()
            except Exception:
                pass
            return r

        Completions.create = wrapped
        Completions._reasoning_patched = True
        return True
    except Exception:
        return False


if os.environ.get("REASONING_FALLBACK", "1") == "1":

    patch_openai_for_model_dispatch()


if __name__ == "__main__":
    import json
    print(json.dumps(dump(), ensure_ascii=False, indent=2))
