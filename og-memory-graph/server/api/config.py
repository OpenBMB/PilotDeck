from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..schemas import ConfigOut, ConfigPatch, ConfigField

router = APIRouter(prefix="/config", tags=["config"])

MODELS_PY = Path(__file__).resolve().parents[2] / "og" / "config" / "models.py"




_FIELDS: list[tuple[str, str, bool, str]] = [

    ("_DEFAULT_API_KEY",  "API Key",  True,  "deepseek"),
    ("_DEFAULT_API_BASE", "API Base", False, "deepseek"),

    ("_MINIMAX_API_KEY",  "API Key",  True,  "minimax"),
    ("_MINIMAX_API_BASE", "API Base", False, "minimax"),

    ("_QWEN_API_KEY",     "API Key",  True,  "qwen"),
    ("_QWEN_API_BASE",    "API Base", False, "qwen"),

    ("_DOUBAO_API_KEY",   "API Key",  True,  "doubao"),
    ("_DOUBAO_API_BASE",  "API Base", False, "doubao"),

    ("_YEYSAI_API_KEY",   "API Key",  True,  "yeysai"),
    ("_YEYSAI_API_BASE",  "API Base", False, "yeysai"),

    ("_DEFAULT_LLM_MAIN",  "主模型 (LLM_MAIN)",   False, "llm"),
    ("_DEFAULT_LLM_UTIL",  "辅助模型 (LLM_UTIL)",  False, "llm"),
    ("_DEFAULT_LLM_JUDGE", "评测模型 (LLM_JUDGE)", False, "llm"),
]


_TEST_MODEL: dict[str, str] = {
    "deepseek": "deepseek-chat",
    "minimax":  "MiniMax-M3",
    "qwen":     "qwen-turbo",
    "doubao":   "doubao-lite-32k",
    "yeysai":   "gpt-4o-mini",
}

PROVIDER_LABELS = {
    "deepseek": "DeepSeek",
    "minimax":  "MiniMax",
    "qwen":     "Qwen",
    "doubao":   "Doubao",
    "yeysai":   "YeySAI (Gemini/GPT/Claude)",
    "llm":      "默认模型",
}




def _mask(value: str) -> str:
    if len(value) <= 8:
        return value
    return value[:8] + "***"


def _read_field(src: str, varname: str) -> str | None:
    pattern = re.compile(
        rf'^{re.escape(varname)}\s*=\s*["\']([^"\']*)["\']',
        re.MULTILINE,
    )
    m = pattern.search(src)
    return m.group(1) if m else None


def _write_field(src: str, varname: str, new_value: str) -> str:
    pattern = re.compile(
        rf'^({re.escape(varname)}\s*=\s*)["\']([^"\']*)["\']',
        re.MULTILINE,
    )
    replacement = rf'\g<1>"{new_value}"'
    new_src, n = pattern.subn(replacement, src)
    if n == 0:
        raise ValueError(f"未找到变量 {varname!r} 的赋值行（非注释行）")
    return new_src


def _build_fields(src: str) -> list[ConfigField]:
    result = []
    for varname, label, is_key, provider in _FIELDS:
        raw = _read_field(src, varname) or ""
        displayed = _mask(raw) if is_key else raw
        result.append(ConfigField(
            key=varname,
            label=label,
            provider=provider,
            value=displayed,
            masked=is_key,
        ))
    return result




@router.get("", response_model=ConfigOut)
def get_config():
    if not MODELS_PY.exists():
        raise HTTPException(500, "og/config/models.py 不存在")
    src = MODELS_PY.read_text(encoding="utf-8")
    return ConfigOut(fields=_build_fields(src))


@router.put("", response_model=ConfigOut)
def update_config(body: ConfigPatch):
    if not MODELS_PY.exists():
        raise HTTPException(500, "og/config/models.py 不存在")

    valid_keys = {v for v, _, _, _ in _FIELDS}
    bad_keys = set(body.updates) - valid_keys
    if bad_keys:
        raise HTTPException(400, f"不支持的字段: {bad_keys}")

    src = MODELS_PY.read_text(encoding="utf-8")
    for varname, new_val in body.updates.items():
        if "***" in new_val:
            continue
        try:
            src = _write_field(src, varname, new_val)
        except ValueError as e:
            raise HTTPException(400, str(e))

    MODELS_PY.write_text(src, encoding="utf-8")
    return ConfigOut(fields=_build_fields(src))


class TestBody(BaseModel):
    provider: str


class TestResult(BaseModel):
    ok:         bool
    latency_ms: Optional[int] = None
    error:      Optional[str] = None


@router.post("/test", response_model=TestResult)
async def test_connection(body: TestBody):
    if body.provider not in _TEST_MODEL:
        raise HTTPException(400, f"不支持的 provider: {body.provider!r}")

    model = _TEST_MODEL[body.provider]

    def _do_test() -> TestResult:
        try:
            import sys
            sys.path.insert(0, str(MODELS_PY.parents[2]))
            from og.config.models import get_client_for_model
            client = get_client_for_model(model)
            t0 = time.monotonic()
            client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=1,
                timeout=15,
            )
            return TestResult(ok=True, latency_ms=int((time.monotonic() - t0) * 1000))
        except Exception as e:
            return TestResult(ok=False, error=str(e)[:200])

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _do_test)




import uuid as _uuid_mod
import json as _json

_CUSTOM_PATH = MODELS_PY.parents[2] / "data" / "memory" / "user_config.json"


def _load_custom() -> list[dict]:
    if _CUSTOM_PATH.exists():
        try:
            return _json.loads(_CUSTOM_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_custom(items: list[dict]) -> None:
    _CUSTOM_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CUSTOM_PATH.write_text(_json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


class CustomProviderCreate(BaseModel):
    label:      str
    api_base:   str
    api_key:    str = "none"
    test_model: str = "llama3"


class CustomProviderOut(CustomProviderCreate):
    id: str


@router.get("/custom", response_model=list[CustomProviderOut])
def list_custom_providers():
    return _load_custom()


@router.post("/custom", response_model=CustomProviderOut, status_code=201)
def add_custom_provider(body: CustomProviderCreate):
    items = _load_custom()
    entry = {"id": str(_uuid_mod.uuid4()), **body.model_dump()}
    items.append(entry)
    _save_custom(items)
    return entry


@router.put("/custom/{provider_id}", response_model=CustomProviderOut)
def update_custom_provider(provider_id: str, body: CustomProviderCreate):
    items = _load_custom()
    for item in items:
        if item["id"] == provider_id:
            item.update(body.model_dump())
            _save_custom(items)
            return item
    raise HTTPException(404, f"Provider {provider_id} 不存在")


@router.delete("/custom/{provider_id}", status_code=204)
def delete_custom_provider(provider_id: str):
    items = _load_custom()
    new_items = [x for x in items if x["id"] != provider_id]
    if len(new_items) == len(items):
        raise HTTPException(404, f"Provider {provider_id} 不存在")
    _save_custom(new_items)


@router.post("/custom/{provider_id}/test", response_model=TestResult)
async def test_custom_provider(provider_id: str):
    items = _load_custom()
    provider = next((x for x in items if x["id"] == provider_id), None)
    if provider is None:
        raise HTTPException(404, f"Provider {provider_id} 不存在")

    api_base   = provider["api_base"]
    api_key    = provider["api_key"]
    test_model = provider["test_model"]

    def _do_test() -> TestResult:
        try:
            from openai import OpenAI
            client = OpenAI(base_url=api_base, api_key=api_key, timeout=15)
            t0 = time.monotonic()
            client.chat.completions.create(
                model=test_model,
                messages=[{"role": "user", "content": "hi"}],
                max_tokens=1,
            )
            return TestResult(ok=True, latency_ms=int((time.monotonic() - t0) * 1000))
        except Exception as e:
            return TestResult(ok=False, error=str(e)[:200])

    return await asyncio.get_event_loop().run_in_executor(None, _do_test)
