from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool


from og.mcp_server.tools import (
    init_project as _init_project,
    sync_changes as _sync_changes,
    rebuild_project as _rebuild_project,
    get_status   as _get_status,
    _make_cluster_id,
    _is_proc_running,
    _cluster_config_path,
    CLUSTERS_DIR,
)
from og.mcp_server.watcher import MANIFESTS_DIR

router = APIRouter(prefix="/pd", tags=["pilotdeck"])


def _find_cluster_by_memory_path(memory_path: str) -> Optional[str]:
    if not memory_path:
        return None
    target = os.path.realpath(memory_path).rstrip("/")
    if not CLUSTERS_DIR.exists():
        return None
    for cfg_path in CLUSTERS_DIR.glob("pd-*/cluster_config.json"):
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        stored = cfg.get("_pilotdeck", {}).get("memory_path", "")
        if stored and os.path.realpath(stored).rstrip("/") == target:
            return cfg_path.parent.name
    return None




class InitRequest(BaseModel):
    workspace:      str
    memory_path:    Optional[str] = None
    workspace_name: str
    workspace_desc: str = ""
    model:          str = "deepseek-v4-pro"


class InitResponse(BaseModel):
    cluster_id: str
    status:     str
    message:    str
    refs_count: Optional[int] = None
    log_path:   Optional[str] = None


class SyncResponse(BaseModel):
    cluster_id:    str
    status:        str
    message:       str
    changed_files: Optional[list] = None
    new_phase:     Optional[int] = None




def _manifest_status(cluster_id: str) -> Optional[str]:
    p = MANIFESTS_DIR / f"{cluster_id}.json"
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data.get("pipeline_status")
    except (json.JSONDecodeError, OSError):
        return None


def _cluster_exists(cluster_id: str) -> bool:
    return _cluster_config_path(cluster_id).exists()


def _resolve_memory_path(raw: str, workspace: Optional[str] = None) -> str:
    p = Path(raw)


    if p.is_dir():
        looks_like_memory = (
            (p / "Project").exists() or (p / "Feedback").exists() or
            (p / "project").exists() or (p / "feedback").exists() or
            (p / "control.sqlite").exists() or
            (p.parent / "control.sqlite").exists()
        )
        if looks_like_memory:
            return str(p.resolve())

    ws = workspace or raw
    ws_resolved = str(Path(ws).resolve())


    workspace_id = hashlib.sha1(ws_resolved.encode("utf-8")).hexdigest()[:10]
    global_memory = Path.home() / ".pilotdeck" / "memory" / "workspaces" / workspace_id / "memory"
    if global_memory.exists() and any(global_memory.rglob("*.md")):
        return str(global_memory)

    if not p.exists():
        return raw


    local_memory = p / ".pilotdeck" / "memory"
    if local_memory.exists() and any(local_memory.rglob("*.md")):
        return str(local_memory)


    dot_pd = p / ".pilotdeck"
    if dot_pd.exists() and any(dot_pd.rglob("*.md")):
        return str(dot_pd)

    return raw




@router.post("/init", response_model=InitResponse)
async def init_memory_graph(req: InitRequest) -> InitResponse:

    resolved_path = _resolve_memory_path(req.memory_path or req.workspace, req.workspace)



    _path_hash = hashlib.md5(req.workspace.encode("utf-8")).hexdigest()[:8]
    cluster_id = f"pd-{_path_hash}"


    if _cluster_exists(cluster_id):
        ms = _manifest_status(cluster_id)
        if ms not in (None, "failed"):
            return InitResponse(
                cluster_id=cluster_id,
                status="exists",
                message=f"Cluster '{cluster_id}' 已存在（pipeline_status={ms}）。",
            )


    result: dict = await run_in_threadpool(
        _init_project,
        resolved_path,
        req.workspace_name,
        req.workspace_desc,
        ["--curation", "--rewrite", "--balanced", "--polish"],
        cluster_id,
        req.workspace,
    )

    return InitResponse(
        cluster_id=result.get("cluster_id", cluster_id),
        status=result.get("status", "started"),
        message=result.get("message", ""),
        refs_count=result.get("refs_count"),
        log_path=result.get("log_path"),
    )




@router.post("/sync/{cluster_id}", response_model=SyncResponse)
async def sync_memory_graph(cluster_id: str) -> SyncResponse:
    if not _cluster_exists(cluster_id):
        raise HTTPException(404, f"Cluster '{cluster_id}' 不存在，请先调用 /pd/init")

    result: dict = await run_in_threadpool(_sync_changes, cluster_id)

    return SyncResponse(
        cluster_id=cluster_id,
        status=result.get("status", "error"),
        message=result.get("message", ""),
        changed_files=result.get("changed_files"),
        new_phase=result.get("new_phase"),
    )




class SyncByMemoryPathRequest(BaseModel):
    memory_path: str


@router.post("/sync-by-memory-path", response_model=SyncResponse)
async def sync_by_memory_path(req: SyncByMemoryPathRequest) -> SyncResponse:
    cluster_id = _find_cluster_by_memory_path(req.memory_path)
    if not cluster_id:

        raise HTTPException(404, f"未找到 memory_path 对应的 cluster：{req.memory_path}")

    result: dict = await run_in_threadpool(_sync_changes, cluster_id)

    return SyncResponse(
        cluster_id=cluster_id,
        status=result.get("status", "error"),
        message=result.get("message", ""),
        changed_files=result.get("changed_files"),
        new_phase=result.get("new_phase"),
    )




@router.post("/rebuild/{cluster_id}", response_model=InitResponse)
async def rebuild_memory_graph(cluster_id: str) -> InitResponse:
    if not _cluster_exists(cluster_id):
        raise HTTPException(404, f"Cluster '{cluster_id}' 不存在，请先调用 /pd/init")

    result: dict = await run_in_threadpool(_rebuild_project, cluster_id)

    return InitResponse(
        cluster_id=result.get("cluster_id", cluster_id),
        status=result.get("status", "error"),
        message=result.get("message", ""),
        refs_count=result.get("refs_count"),
        log_path=result.get("log_path"),
    )




@router.get("/status/{cluster_id}")
async def get_memory_graph_status(cluster_id: str) -> dict:
    if not _cluster_exists(cluster_id):
        raise HTTPException(404, f"Cluster '{cluster_id}' 不存在")

    return await run_in_threadpool(_get_status, cluster_id)




@router.get("/graph/{cluster_id}")
async def get_memory_graph_data(
    cluster_id: str,
    version: str = "latest",
    model:   str = "deepseek",
) -> RedirectResponse:
    if not _cluster_exists(cluster_id):
        raise HTTPException(404, f"Cluster '{cluster_id}' 不存在")

    redirect_url = f"/api/clusters/{cluster_id}/graph?version={version}&model={model}"
    return RedirectResponse(url=redirect_url, status_code=302)
