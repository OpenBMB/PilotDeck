from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/preferences", tags=["preferences"])

MEMORY_ROOT   = Path(__file__).resolve().parents[2] / "data" / "memory"
PREFS_PATH    = MEMORY_ROOT / "user_prefs.json"
USER_MD_PATH  = MEMORY_ROOT / "user.md"


_DEFAULTS: dict[str, Any] = {
    "preferred_model":   "deepseek-v4-pro",
    "default_flags":     [],
    "chat_model":        "deepseek-v4-pro",
    "response_language": "zh",
    "expertise_level":   "researcher",
}


_VALID_KEYS = set(_DEFAULTS)


def _read_prefs() -> dict[str, Any]:
    if PREFS_PATH.exists():
        try:
            return json.loads(PREFS_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {}


def _write_prefs(prefs: dict[str, Any]) -> None:
    MEMORY_ROOT.mkdir(parents=True, exist_ok=True)
    PREFS_PATH.write_text(json.dumps(prefs, ensure_ascii=False, indent=2),
                          encoding="utf-8")
    _sync_to_user_md(prefs)


def _sync_to_user_md(prefs: dict[str, Any]) -> None:
    if not USER_MD_PATH.exists():
        return
    content = USER_MD_PATH.read_text(encoding="utf-8")
    json_str = json.dumps(prefs, ensure_ascii=False, indent=2)

    pattern = re.compile(
        r'(## 机器偏好[^\n]*\n```json\n)([^`]*)(```)',
        re.DOTALL
    )
    if pattern.search(content):
        new_content = pattern.sub(rf'\g<1>{json_str}\n\g<3>', content)
    else:

        new_content = content + f"\n## 机器偏好（系统自动读取）\n```json\n{json_str}\n```\n"
    USER_MD_PATH.write_text(new_content, encoding="utf-8")


def get_all_preferences() -> dict[str, Any]:
    stored = _read_prefs()
    return {k: stored.get(k, v) for k, v in _DEFAULTS.items()}




class PrefValue(BaseModel):
    value: Any


@router.get("")
def list_preferences():
    return get_all_preferences()


@router.get("/{key}")
def get_preference(key: str):
    if key not in _VALID_KEYS:
        raise HTTPException(400, f"未知偏好 key: {key!r}")
    prefs = _read_prefs()
    return {"key": key, "value": prefs.get(key, _DEFAULTS[key])}


@router.put("/{key}")
def set_preference(key: str, body: PrefValue):
    if key not in _VALID_KEYS:
        raise HTTPException(400, f"未知偏好 key: {key!r}，可选: {sorted(_VALID_KEYS)}")
    prefs = _read_prefs()
    prefs[key] = body.value
    _write_prefs(prefs)
    return {"ok": True, "key": key, "value": body.value}


@router.patch("")
def patch_preferences(updates: dict[str, Any]):
    bad = set(updates) - _VALID_KEYS
    if bad:
        raise HTTPException(400, f"未知偏好 key: {bad}")
    prefs = _read_prefs()
    prefs.update(updates)
    _write_prefs(prefs)
    return {"ok": True, "updated": list(updates)}
