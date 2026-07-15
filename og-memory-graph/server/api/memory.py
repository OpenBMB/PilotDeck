from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/memory", tags=["memory"])

MEMORY_ROOT = Path(__file__).resolve().parents[2] / "data" / "memory"
MEMORY_ROOT.mkdir(parents=True, exist_ok=True)
(MEMORY_ROOT / "clusters").mkdir(exist_ok=True)


def local_memory_enabled() -> bool:
    return os.environ.get("OG_DISABLE_LOCAL_MEMORY", "").lower() not in ("1", "true", "yes")


def _require_local_memory_enabled() -> None:
    if not local_memory_enabled():
        raise HTTPException(
            410,
            "og6 local memory 已禁用（OG_DISABLE_LOCAL_MEMORY=1）。"
            "PD 集成场景记忆走 PilotDeck workspace memory，本端点不适用。",
        )


router.dependencies = [Depends(_require_local_memory_enabled)]


def _memory_path(level: str, cluster_id: Optional[str] = None) -> Path:
    if level == "project":
        if not cluster_id:
            raise ValueError("project 层级需要 cluster_id")
        return MEMORY_ROOT / "clusters" / f"{cluster_id}.md"
    elif level in ("global", "user"):
        return MEMORY_ROOT / f"{level}.md"
    else:
        raise ValueError(f"未知层级: {level!r}，可选: global / user / project")


def read_memory_file(level: str, cluster_id: Optional[str] = None) -> str:
    try:
        p = _memory_path(level, cluster_id)
    except ValueError:
        return ""
    return p.read_text(encoding="utf-8") if p.exists() else ""


def _insert_under_section(content: str, section: str, new_text: str) -> str:
    pattern = re.compile(rf"(## {re.escape(section)}.*?)(\n## |\Z)", re.DOTALL)
    m = pattern.search(content)
    if m:
        insert_pos = m.end(1)
        return content[:insert_pos] + f"\n{new_text}" + content[insert_pos:]
    return content


def write_memory_file(level: str, content: str,
                      cluster_id: Optional[str] = None,
                      section: Optional[str] = None) -> Path:
    p = _memory_path(level, cluster_id)
    p.parent.mkdir(parents=True, exist_ok=True)

    if section:
        existing = p.read_text(encoding="utf-8") if p.exists() else ""
        if f"## {section}" in existing:
            new_text = _insert_under_section(existing, section, content)
        else:
            new_text = existing.rstrip() + f"\n\n## {section}\n{content}\n"
        p.write_text(new_text, encoding="utf-8")
    else:
        with p.open("a", encoding="utf-8") as f:
            f.write(f"\n{content}\n")

    return p


def list_cluster_memory_files() -> list[str]:
    d = MEMORY_ROOT / "clusters"
    if not d.exists():
        return []
    return [f.stem for f in sorted(d.glob("*.md"))]




class MemoryAppendBody(BaseModel):
    content:    str
    section:    Optional[str] = None
    cluster_id: Optional[str] = None


@router.get("/{level}")
def get_memory(level: str, cluster_id: Optional[str] = Query(None)):
    try:
        text = read_memory_file(level, cluster_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"level": level, "cluster_id": cluster_id, "content": text}


@router.put("/{level}")
def put_memory(level: str, body: MemoryAppendBody):
    try:
        p = _memory_path(level, body.cluster_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content, encoding="utf-8")
    return {"ok": True, "path": str(p.relative_to(MEMORY_ROOT.parent.parent))}


@router.post("/{level}/append")
def append_memory(level: str, body: MemoryAppendBody):
    try:
        p = write_memory_file(level, body.content, body.cluster_id, body.section)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "path": str(p.relative_to(MEMORY_ROOT.parent.parent))}


@router.get("")
def list_memory_files():
    files = []
    for level in ("global", "user"):
        p = MEMORY_ROOT / f"{level}.md"
        files.append({"level": level, "exists": p.exists(),
                       "size": p.stat().st_size if p.exists() else 0})
    for cid in list_cluster_memory_files():
        p = MEMORY_ROOT / "clusters" / f"{cid}.md"
        files.append({"level": "project", "cluster_id": cid,
                       "exists": True, "size": p.stat().st_size})
    return {"files": files}
