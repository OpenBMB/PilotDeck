"""Authenticated v4 execution API. Deploy separately from the v3 runtime."""
import asyncio
import json
import os
from contextlib import asynccontextmanager
from secrets import compare_digest

from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from staffdeck_sop_core import SopCoreError, SopDefinition

from .execution_v4 import ExecutionService, strict, validate_definition
from .storage import SqliteStore


def create_app(path, token, max_concurrency=32):
    if not token:
        raise ValueError("SOP_V4_HOST_TOKEN is required")
    store = SqliteStore(path)
    service = ExecutionService(store, max_concurrency)

    @asynccontextmanager
    async def lifespan(_):
        yield
        store.close()

    app = FastAPI(title="SOP execution v4", lifespan=lifespan)
    app.state.execution = service

    @app.exception_handler(SopCoreError)
    async def core_error(_, error):
        return JSONResponse({"error": {"code": error.code, "message": str(error)}}, status_code=422)

    @app.exception_handler(ValueError)
    async def invalid(_, error):
        return JSONResponse({"error": {"code": "SOP_V4_INVALID", "message": str(error)}}, status_code=400)

    @app.middleware("http")
    async def authenticate(request, next_handler):
        if request.url.path != "/healthz" and not compare_digest(request.headers.get("authorization", ""), f"Bearer {token}"):
            return JSONResponse({"error": {"code": "SOP_HOST_UNAUTHORIZED"}}, status_code=401)
        return await next_handler(request)

    @app.get("/healthz")
    def health():
        return {"status": "ok", "contract": "sop.lifecycle/v4", "protocolVersion": "4.0", "transport": "sop-http-v4",
                "implementationId": "portable-sop", "maxConcurrency": service.maximum}

    @app.post("/v4/definitions")
    def publish(data: dict):
        validate_definition(data)
        with store.transaction():
            store.put(SopDefinition.from_value(data))
        return {"accepted": True}

    @app.post("/v4/runs")
    def start(data: dict, x_sop_scope: str = Header()):
        return service.start(x_sop_scope, data)

    @app.post("/v4/preflight")
    def preflight(data: dict):
        return service.preflight(data)

    @app.get("/v4/runs/{run_id}")
    def status(run_id: str, x_sop_scope: str = Header(), offset: int = 0, limit: int = 100):
        return service.status(x_sop_scope, run_id, max(0, offset), min(100, max(1, limit)))

    @app.get("/v4/runs/{run_id}/results")
    def results(run_id: str, x_sop_scope: str = Header(), offset: int = 0, limit: int = 100):
        return service.results(x_sop_scope, run_id, max(0, offset), min(100, max(1, limit)))

    @app.get("/v4/runs/{run_id}/events")
    async def events(run_id: str, request: Request, x_sop_scope: str = Header(), after: int = 0, stream: bool = False):
        if request.headers.get("last-event-id"):
            after = max(after, int(request.headers["last-event-id"]))
        initial = service.events(x_sop_scope, run_id, max(0, after))
        if not stream:
            return {"events": initial, "nextSequence": initial[-1]["sequence"] if initial else after}

        async def generate():
            cursor = after
            while not await request.is_disconnected():
                values = service.events(x_sop_scope, run_id, cursor)
                for event in values:
                    cursor = event["sequence"]
                    yield f"id: {cursor}\ndata: {json.dumps(event)}\n\n"
                if not values and service.status(x_sop_scope, run_id)["status"] in {"completed", "failed", "cancelled", "result_unknown"}:
                    break
                if not values:
                    yield ": heartbeat\n\n"
                    await asyncio.sleep(0.5)
        return StreamingResponse(generate(), media_type="text/event-stream")

    @app.post("/v4/runs/{run_id}/{operation}")
    def operation(run_id: str, operation: str, data: dict, x_sop_scope: str = Header()):
        if operation not in {"cancel", "retry", "resume"}:
            raise ValueError("Unknown run operation")
        return getattr(service, operation)(x_sop_scope, run_id, data)

    @app.post("/v4/worker/claim")
    def claim(data: dict):
        strict(data, {"workerId", "limit"}, {"workerId"})
        return {"calls": service.claim(data["workerId"], min(service.maximum, max(1, data.get("limit", 1))))}

    @app.post("/v4/calls/{call_id}/heartbeat")
    def heartbeat(call_id: str, data: dict):
        strict(data, {"leaseToken"}, {"leaseToken"})
        return service.heartbeat(call_id, data["leaseToken"])

    @app.post("/v4/calls/{call_id}/submit")
    def submit(call_id: str, data: dict):
        return service.submit(call_id, data)

    return app


def app_factory():
    return create_app(os.environ["SOP_V4_DB"], os.environ["SOP_V4_HOST_TOKEN"], int(os.environ.get("SOP_V4_MAX_CONCURRENCY", "32")))
