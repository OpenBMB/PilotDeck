from __future__ import annotations

import asyncio
import json as _json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..db.session import get_db
from ..db import crud
from ..schemas import TaskCreate, TaskOut, TaskLogOut

router = APIRouter(prefix="/tasks", tags=["tasks"])


ROOT = Path(__file__).resolve().parents[2]
LOGS_DIR = ROOT / "logs"
LOGS_DIR.mkdir(exist_ok=True)


_procs: dict[str, asyncio.subprocess.Process] = {}




def _log_path(task_id: str) -> Path:
    return LOGS_DIR / f"task_{task_id}.log"


def _tail_log(task_id: str, n: int = 80) -> list[str]:
    p = _log_path(task_id)
    if not p.exists():
        return []
    lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
    return lines[-n:]




_PROVIDER_TO_LLM: dict[str, str] = {
    "deepseek": "deepseek-v4-pro",
    "doubao":   "doubao-seed-2-0-pro-260215",
    "qwen3":    "qwen3-7b-plus",
    "gemini":   "gemini-2.5-pro",
    "gpt-4o":   "gpt-4o",
    "claude":   "claude-sonnet-4-5",
    "minimax":  "MiniMax-M3",
}


def _build_cmd(task_id: str, cluster_id: str, cfg: dict) -> list[str]:
    raw_model = cfg.get("model", "deepseek-v4-pro")

    llm_model = _PROVIDER_TO_LLM.get(raw_model, raw_model)
    cmd = [
        sys.executable, "-m", "og", "run", "a",
        "--cluster", cluster_id,
        "--model",   llm_model,
    ]
    for flag in ("curation", "rewrite", "balanced", "polish", "skip_build"):
        if cfg.get(flag) or cfg.get(f"--{flag.replace('_', '-')}"):
            cmd.append(f"--{flag.replace('_', '-')}")
    return cmd


async def _watch_proc(task_id: str, proc: asyncio.subprocess.Process) -> None:
    await proc.wait()
    from ..db.session import SessionLocal
    db = SessionLocal()
    try:
        status_val = "done" if proc.returncode == 0 else "failed"
        crud.update_task_status(
            db, task_id, status_val,
            finished_at=datetime.now(timezone.utc),
        )
    finally:
        db.close()
    _procs.pop(task_id, None)




def recover_orphan_tasks(db: Session) -> None:
    tasks = crud.list_tasks(db)
    for t in tasks:
        if t.status == "running":
            crud.update_task_status(db, t.id, "failed",
                                    finished_at=datetime.now(timezone.utc))




@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
async def create_task(body: TaskCreate, db: Session = Depends(get_db)):
    if body.type != "run_a":
        raise HTTPException(400, f"当前只支持 type=run_a，收到: {body.type!r}")
    if not body.cluster_id:
        raise HTTPException(400, "cluster_id 不能为空")

    import json
    cfg_str = json.dumps(body.config)
    task = crud.create_task(db, cluster_id=body.cluster_id,
                            type=body.type, config=cfg_str)

    log_p = _log_path(task.id)
    cmd = _build_cmd(task.id, body.cluster_id, body.config)

    with open(log_p, "w", encoding="utf-8") as lf:
        lf.write(f"[启动] {' '.join(cmd)}\n")

    log_file = open(log_p, "a", encoding="utf-8")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=log_file,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(ROOT),
    )
    _procs[task.id] = proc


    task = crud.update_task_status(db, task.id, "running",
                                   log_path=str(log_p.relative_to(ROOT)),
                                   started_at=datetime.now(timezone.utc))

    asyncio.create_task(_watch_proc(task.id, proc))
    return task


@router.get("", response_model=list[TaskOut])
def list_tasks(cluster_id: Optional[str] = Query(None),
               db: Session = Depends(get_db)):
    return crud.list_tasks(db, cluster_id=cluster_id)


@router.get("/{task_id}", response_model=TaskLogOut)
def get_task(task_id: str, lines: int = Query(80, ge=1, le=500),
             db: Session = Depends(get_db)):
    task = crud.get_task(db, task_id)
    if task is None:
        raise HTTPException(404, f"任务 {task_id} 不存在")
    return TaskLogOut(
        id=task.id,
        cluster_id=task.cluster_id,
        type=task.type,
        status=task.status,
        config=task.config,
        log_path=task.log_path,
        started_at=task.started_at,
        finished_at=task.finished_at,
        log_tail=_tail_log(task_id, lines),
    )


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def cancel_task(task_id: str, db: Session = Depends(get_db)):
    task = crud.get_task(db, task_id)
    if task is None:
        raise HTTPException(404, f"任务 {task_id} 不存在")
    proc = _procs.get(task_id)
    if proc and proc.returncode is None:
        proc.kill()
    crud.update_task_status(db, task_id, "failed",
                            finished_at=datetime.now(timezone.utc))


@router.get("/{task_id}/stream")
async def stream_task_log(task_id: str, db: Session = Depends(get_db)):
    task = crud.get_task(db, task_id)
    if task is None:
        raise HTTPException(404, f"任务 {task_id} 不存在")

    async def _generator() -> AsyncGenerator[str, None]:
        log_p = _log_path(task_id)
        position = 0


        if log_p.exists():
            with open(log_p, encoding="utf-8", errors="replace") as f:
                existing = f.read()
                for line in existing.splitlines():
                    yield f"data: {_json.dumps(line)}\n\n"
                position = f.tell()

        while True:

            from ..db.session import SessionLocal
            _db = SessionLocal()
            try:
                t = crud.get_task(_db, task_id)
                if t and t.status in ("done", "failed"):

                    if log_p.exists():
                        with open(log_p, encoding="utf-8", errors="replace") as f:
                            f.seek(position)
                            for line in f.read().splitlines():
                                yield f"data: {_json.dumps(line)}\n\n"
                    yield f"event: {t.status}\ndata: {t.status}\n\n"
                    return
            finally:
                _db.close()


            if log_p.exists():
                with open(log_p, encoding="utf-8", errors="replace") as f:
                    f.seek(position)
                    new_text = f.read()
                    if new_text:
                        position = f.tell()
                        for line in new_text.splitlines():
                            yield f"data: {_json.dumps(line)}\n\n"

            await asyncio.sleep(0.5)

    return StreamingResponse(
        _generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
