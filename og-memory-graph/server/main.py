from __future__ import annotations

from pathlib import Path as _Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .db.session import init_db, SessionLocal
from .api import clusters, references, graphs, reports, tasks, config, memory, preferences, chat
from .api import pilotdeck as pd_routes



app = FastAPI(
    title="og_impl_v6 API",
    description="Outline Graph 多版本报告生成与评估框架 — 后端接口",
    version="0.1.0",
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://localhost:3001",
        "http://localhost:4000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)



@app.on_event("startup")
def on_startup():
    init_db()

    db = SessionLocal()
    try:
        tasks.recover_orphan_tasks(db)
    finally:
        db.close()

    try:
        from og.mcp_server.tools import rebuild_watchers_from_clusters
        rebuild_watchers_from_clusters()
    except Exception as exc:
        print(f"[startup] 重建 og6 watcher 失败（不影响其余功能）: {exc}", flush=True)




API_PREFIX = "/api"

app.include_router(clusters.router,   prefix=API_PREFIX)
app.include_router(references.router, prefix=API_PREFIX)
app.include_router(graphs.router,     prefix=API_PREFIX)
app.include_router(reports.router,    prefix=API_PREFIX)
app.include_router(tasks.router,       prefix=API_PREFIX)
app.include_router(config.router,      prefix=API_PREFIX)
app.include_router(memory.router,      prefix=API_PREFIX)
app.include_router(preferences.router, prefix=API_PREFIX)
app.include_router(chat.router,        prefix=API_PREFIX)
app.include_router(pd_routes.router,   prefix=API_PREFIX)




@app.get("/api/status", tags=["system"])
def status():
    from . import filestore
    cluster_ids = filestore.list_cluster_ids()
    return {
        "status":        "ok",
        "cluster_count": len(cluster_ids),
        "clusters":      cluster_ids,
    }


@app.get("/api/models", tags=["system"])
def list_models():
    from . import filestore
    return {"models": filestore.list_models()}





_DIST = _Path(__file__).resolve().parent.parent / "frontend" / "dist"

if _DIST.exists():

    app.mount("/assets", StaticFiles(directory=str(_DIST / "assets")), name="assets")

    @app.get("/favicon.svg", include_in_schema=False)
    def favicon():
        return FileResponse(str(_DIST / "favicon.svg"))




    from fastapi.responses import Response
    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        html = (_DIST / "index.html").read_text(encoding="utf-8")
        return Response(
            content=html,
            media_type="text/html",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
