"""HTTP API for the independent SOP lifecycle runtime."""
from __future__ import annotations

from typing import Any, Literal
import os
from pathlib import Path
import json
from hashlib import sha256
from datetime import datetime, timezone
from dataclasses import replace
from contextlib import asynccontextmanager
from secrets import compare_digest
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from staffdeck_sop_core import SopCoreError, SopDefinition, SopState
from staffdeck_sop_core import prepare as core_prepare, resume as core_resume, submit as core_submit
from .storage import SqliteStore
from .management import ManagementService
from .features import SopFeatures
from staffdeck_sop_core.nesting import expand

PROTOCOL_VERSION = "3.0"
MODULE_ID = "sop.runtime"
CONTRACT = "sop.lifecycle/v3"
OPERATIONS = ("prepare", "submit", "resume")

class Envelope(BaseModel):
    protocolVersion: Literal["3.0"]
    requestId: str = Field(min_length=1)
    operationId: str = Field(min_length=1)
    turnId: str = Field(min_length=1)
    expectedRevision: int | None = Field(default=None, ge=0)
    idempotencyKey: str | None = None

class SessionPrepare(BaseModel):
    sopId: str = Field(min_length=1)
    version: str | None = None

class SessionSubmit(BaseModel):
    proposal: dict[str, Any]
    receipts: list[dict[str, Any]] = Field(default_factory=list)

class SessionResume(BaseModel):
    waitId: str | None = None
    slotUpdates: dict[str, Any] = Field(default_factory=dict)
    response: dict[str, Any] = Field(default_factory=dict)

def create_app(state_path: str = ":memory:", *, publish_token: str | None = None, features: SopFeatures | None = None) -> FastAPI:
    store = SqliteStore(state_path)
    store.features = features or SopFeatures()
    @asynccontextmanager
    async def lifespan(_app):
        yield
        store.close()
    app = FastAPI(title="Independent SOP Runtime", version=PROTOCOL_VERSION, lifespan=lifespan)
    app.state.sop_store = store
    management = ManagementService(store, _snapshot, store.features)
    app.state.sop_management = management
    for path in sorted(Path(os.environ.get("SOP_DEFINITIONS_DIR", "/nonexistent")).glob("*.json")):
        raw = json.loads(path.read_text())
        for value in raw.get("sops", [raw]):
            definition = _snapshot(value)
            core_prepare(definition, SopState("validate", definition.sop_id, definition.version))
            try:
                existing = store.get(definition.sop_id, definition.version)
            except SopCoreError:
                existing = None
            if existing and existing.content == definition.content and existing.capability_requirements == definition.capability_requirements:
                continue
            store.put(definition)

    @app.exception_handler(RequestValidationError)
    async def malformed_request(_request: Request, error: RequestValidationError) -> JSONResponse:
        body = error.body if isinstance(error.body, dict) else {}
        return _failed(str(body.get("requestId") or "unknown"), "SOP_RUNTIME_PROTOCOL", str(error), 400)

    @app.exception_handler(ValidationError)
    async def malformed_payload(_request, error):
        return _failed("unknown", "SOP_RUNTIME_PROTOCOL", str(error), 400)

    @app.exception_handler(SopCoreError)
    async def core_error(_request, error):
        return _failed("unknown", error.code, str(error), 422)

    @app.exception_handler(ValueError)
    async def invalid_definition(_request, error):
        return _failed("unknown", "SOP_DEFINITION_INVALID", str(error), 422)

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return {"status": "ok", "protocolVersion": PROTOCOL_VERSION, "moduleId": MODULE_ID,
                "contract": CONTRACT, "operations": list(OPERATIONS), "implementationId": "portable-sop",
                "descriptorVersion": "1.0", "implementationVersion": "0.1.0", "transport": "sop-http-v3",
                "state": {"ownership": "runtime", "schema": CONTRACT, "scope": "session"},
                "requires": {"hostCapabilities": ["sop.capability-receipt/v1", "sop.approval/v1"]}}

    @app.post("/v1/definitions")
    def publish_definition(payload: dict[str, Any], request: Request):
        if publish_token and not compare_digest(request.headers.get("authorization", ""), f"Bearer {publish_token}"):
            return _failed("publish", "SOP_PUBLISH_UNAUTHORIZED", "definition publication requires the publisher credential", 401)
        definition = _snapshot(payload)
        store.features.check_definition(definition)
        core_prepare(definition, SopState("validate", definition.sop_id, definition.version))
        with store.transaction():
            if not store.features.knowledge:
                catalog = store.definitions()
                catalog[(definition.sop_id, definition.version)] = definition
                catalog[definition.sop_id] = definition
                store.features.check_definition(expand(definition, catalog))
            try:
                existing = store.get(definition.sop_id, definition.version)
            except SopCoreError:
                existing = None
            if existing and existing.content == definition.content and existing.capability_requirements == definition.capability_requirements:
                return {"ok": True, "definition": existing.to_dict()}
            store.put(definition)
        return {"ok": True, "definition": definition.to_dict()}

    @app.post("/v1/management/call")
    def management_call(payload: dict[str, Any], request: Request):
        if publish_token and not compare_digest(request.headers.get("authorization", ""), f"Bearer {publish_token}"):
            return _failed("management", "SOP_PUBLISH_UNAUTHORIZED", "Management requires the publisher credential", 401)
        return {"ok": True, "result": management.call(payload.get("operation"), payload.get("input", {}))}

    @app.get("/v1/management/catalog")
    def management_catalog():
        with store._lock:
            return {"ok": True, **management.catalog()}

    @app.get("/v1/sessions/{session_id}")
    def get_session(session_id: str) -> JSONResponse:
        state = store.read(session_id)
        if state is None:
            return _failed("unknown", "SESSION_NOT_FOUND", "SOP session was not found.", 404)
        return JSONResponse({"ok": True, "state": state.to_dict(), "definition": store.session_definition(session_id).to_dict()})

    @app.post("/v1/sessions/{session_id}/prepare")
    def session_prepare(session_id: str, payload: dict[str, Any]) -> JSONResponse:
        envelope, request = _payload(Envelope, SessionPrepare, payload)
        return _run(store, envelope, session_id, "prepare", payload, lambda: _prepare(store, session_id, envelope, request, management))

    @app.post("/v1/sessions/{session_id}/submit")
    def session_submit(session_id: str, payload: dict[str, Any]) -> JSONResponse:
        envelope, request = _payload(Envelope, SessionSubmit, payload)
        return _run(store, envelope, session_id, "submit", payload, lambda: _submit(store, session_id, envelope, request))

    @app.post("/v1/sessions/{session_id}/resume")
    def session_resume(session_id: str, payload: dict[str, Any]) -> JSONResponse:
        envelope, request = _payload(Envelope, SessionResume, payload)
        return _run(store, envelope, session_id, "resume", payload, lambda: _resume(store, session_id, envelope, request))

    return app


def _snapshot(value):
    definition = SopDefinition.from_value(value)
    digest = sha256(json.dumps({"content": definition.content, "capability_requirements": definition.to_dict()["capability_requirements"]}, sort_keys=True).encode()).hexdigest()
    if definition.content_digest and definition.content_digest != digest:
        raise SopCoreError("SOP_DEFINITION_INVALID", "definition digest does not match its content")
    return replace(definition, published_at=definition.published_at or datetime.now(timezone.utc).isoformat(), content_digest=digest)

def _prepare(store: SqliteStore, session_id: str, envelope: Envelope, request: SessionPrepare, management=None) -> dict[str, Any]:
    state = store.read(session_id)
    if envelope.expectedRevision is not None and envelope.expectedRevision != (state.revision if state else 0):
        raise SopCoreError("SOP_REVISION_CONFLICT", "session revision is stale")
    if state is None:
        if management and not management.available(request.sopId):
            raise SopCoreError("SOP_UNPUBLISHED", "SOP is not available for new executions")
        definition = store.get(request.sopId, request.version)
        if management and request.version is None:
            row = store._connection.execute("SELECT sop_id FROM sop_management WHERE sop_id=?", (request.sopId,)).fetchone()
            if row:
                definition = management.definition(request.sopId)
        definition = expand(definition, store.definitions())
        store.features.check_definition(definition)
        prepared = core_prepare(definition, SopState(session_id, definition.sop_id, definition.version))
        state = store.create(SopState.from_dict(prepared["state"]))
        store.bind_definition(session_id, definition)
    elif state.sop_id != request.sopId:
        raise SopCoreError("SOP_SCOPE_MISMATCH", "session is bound to another SOP")
    elif request.version and state.sop_version != request.version:
        raise SopCoreError("SOP_VERSION_MISMATCH", "session is pinned to another SOP version")
    definition = store.session_definition(session_id)
    return core_prepare(definition, state)


def _payload(envelope_model, operation_model, payload: dict[str, Any]):
    envelope = envelope_model.model_validate(payload)
    return envelope, operation_model.model_validate(payload)

def _submit(store: SqliteStore, session_id: str, envelope: Envelope, request: SessionSubmit) -> dict[str, Any]:
    state = _required_state(store, session_id)
    if envelope.expectedRevision is not None and state.revision != envelope.expectedRevision:
        raise SopCoreError("SOP_REVISION_CONFLICT", "session revision is stale")
    if envelope.expectedRevision is None:
        raise SopCoreError("SOP_REVISION_REQUIRED", "submit requires expectedRevision")
    for receipt in request.receipts:
        if (receipt.get("session_id") or receipt.get("sessionId")) != session_id or (receipt.get("turn_id") or receipt.get("turnId")) != envelope.turnId:
            raise SopCoreError("RECEIPT_SCOPE_MISMATCH", "receipt requires matching session and turn")
    result = core_submit(store.session_definition(session_id), state, request.proposal, request.receipts, turn_id=envelope.turnId)
    updated = store.compare_and_swap(session_id, state.revision, result.state)
    return {"state": updated.to_dict(), "result": {"status": result.status, "reply": result.reply, "wait": _wait_dict(result.wait), "structuredResult": result.structured_result}}

def _resume(store: SqliteStore, session_id: str, envelope: Envelope, request: SessionResume) -> dict[str, Any]:
    state = _required_state(store, session_id)
    if envelope.expectedRevision is not None and state.revision != envelope.expectedRevision:
        raise SopCoreError("SOP_REVISION_CONFLICT", "session revision is stale")
    if envelope.expectedRevision is None:
        raise SopCoreError("SOP_REVISION_REQUIRED", "resume requires expectedRevision")
    updated = store.compare_and_swap(session_id, state.revision, core_resume(state, {**request.response, "wait_id": request.waitId, "slot_updates": request.slotUpdates}))
    return {"state": updated.to_dict()}

def _required_state(store: SqliteStore, session_id: str) -> SopState:
    state = store.read(session_id)
    if state is None:
        raise SopCoreError("SESSION_NOT_FOUND", "SOP session was not found")
    return state

def _run(store: SqliteStore, envelope: Envelope, session_id: str, operation_name: str, input: dict, operation) -> JSONResponse:
    if "state" in input or "metadata" in input:
        return _failed(envelope.requestId, "SOP_RUNTIME_PROTOCOL", "host cannot supply mutable runtime state", 400)
    if input.get("sessionId", session_id) != session_id or input.get("session_id", session_id) != session_id:
        return _failed(envelope.requestId, "SESSION_SCOPE_MISMATCH", "request session must match the URL", 422)
    input = {**input, "_operation": operation_name}
    if envelope.idempotencyKey:
        input.pop("requestId", None)
    try:
        with store.transaction():
            replay = store.get_request(session_id, envelope.idempotencyKey or envelope.requestId, input)
            if replay is not None:
                return JSONResponse(replay)
            if store.read(session_id) is not None:
                store.features.check_definition(store.session_definition(session_id))
            result = operation()
            response = {"protocolVersion": PROTOCOL_VERSION, "requestId": envelope.requestId, "ok": True, "outcome": "completed", "payload": result}
            store.event(session_id, envelope.operationId, SopState.from_dict(result["state"]))
            store.put_request(session_id, envelope.idempotencyKey or envelope.requestId, input, response)
        return JSONResponse(response)
    except (SopCoreError, KeyError, ValueError) as error:
        code = getattr(error, "code", None) or (str(error) if str(error).startswith("SOP_") else "SOP_RUNTIME_REJECTED")
        return _failed(envelope.requestId, code, str(error), 404 if code == "SESSION_NOT_FOUND" else 409 if code in {"SOP_REVISION_CONFLICT", "SOP_REQUEST_CONFLICT"} else 422)

def _failed(request_id: str, code: str, message: str, status_code: int) -> JSONResponse:
    return JSONResponse({"protocolVersion": PROTOCOL_VERSION, "requestId": request_id, "ok": False, "outcome": "failed", "error": {"code": code, "message": message, "retryability": "unsafe", "details": {}}}, status_code=status_code)

def _wait_dict(wait) -> dict[str, Any] | None:
    if wait is None:
        return None
    return {"kind": wait.kind, "waitId": wait.wait_id, "sessionId": wait.session_id, "sopId": wait.sop_id, "nodeId": wait.node_id, "requestedFields": list(wait.requested_fields), "assigneeRef": wait.assignee_ref}

app = create_app(os.environ.get("SOP_RUNTIME_DB", "./data/sop-runtime.sqlite"), publish_token=os.environ.get("SOP_PUBLISH_TOKEN"), features=SopFeatures.from_env())
