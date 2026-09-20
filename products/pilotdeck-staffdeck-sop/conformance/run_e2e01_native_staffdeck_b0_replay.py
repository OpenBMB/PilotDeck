#!/usr/bin/env python3
"""Replay E2E-01's saved StaffDeck owner calls against frozen StaffDeck B0.

The candidate module facade is deliberately not imported.  A worker using only
the B0 checkout recreates the persisted Knowledge state, then applies B0's
native graph predicates to the saved SOP definition and state projections.
Dynamic record IDs and timestamps are not compared; request fields, durable
content, citations, and the graph predicates remain observable and exact.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


BASELINE_ROOT = Path(
    os.environ.get("STAFFDECK_B0_ROOT", "/tmp/pilotdeck-staffdeck-m0.j4voeS/staffdeck-b0")
)


def main() -> None:
    if len(sys.argv) == 5 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
        return
    if len(sys.argv) != 2:
        raise SystemExit("Usage: run_e2e01_native_staffdeck_b0_replay.py <e2e01-native-owner-trace.json>")
    trace_path = Path(sys.argv[1]).resolve()
    trace = json.loads(trace_path.read_text())
    validate_trace(trace)
    if not BASELINE_ROOT.exists():
        raise SystemExit(f"StaffDeck B0 root is missing: {BASELINE_ROOT}")

    try:
        with tempfile.TemporaryDirectory(prefix="staffdeck-e2e01-b0-replay-") as temp_dir:
            result = run_worker(trace_path, Path(temp_dir) / "knowledge.sqlite")
        compare(trace, result)
        if os.environ.get("STAFFDECK_E2E_REPLAY_INJECT_MISMATCH") == "1":
            result["knowledge"]["documentLifecycle"]["updatedCitation"]["content"] = "injected mismatch"
            compare(trace, result)
        if os.environ.get("STAFFDECK_E2E_REPLAY_INJECT_DISPATCH_MISMATCH") == "1":
            trace["knowledge"]["lostResponseRecovery"]["dispatchCount"] = 2
            compare(trace, result)
    except Exception as error:  # Keep evidence machines parseable on intentional failures.
        print(json.dumps({
            "status": "FAIL",
            "baseline": str(BASELINE_ROOT),
            "trace": str(trace_path),
            "error": str(error),
        }, indent=2, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from error

    print(json.dumps({
        "status": "PASS",
        "baseline": str(BASELINE_ROOT),
        "trace": str(trace_path),
        "replayed": [
            "native Knowledge create_base, import_document, asynchronous ingest job, query, and durable citation lookup",
            "saved Knowledge request fields and imported-document side effect",
            "saved document update, stale-citation rejection, updated query/citation, and archive state",
            "native GraphRules handoff, allowed-tool, and terminal predicates for the saved SOP definition",
        ],
        "notCovered": [
            "B0 does not expose the candidate's standalone sop.lifecycle/v2 state machine; this replays its native graph-owner predicates, not a fabricated B0 HTTP runtime",
            "native Context automatic compaction",
            "PilotDeck Gateway/session entry and persisted automatic-compaction evidence, covered separately by run-e2e01-native-pilotdeck-b0-gateway-session-replay.mjs",
        ],
    }, indent=2, ensure_ascii=False))


def validate_trace(trace: dict[str, Any]) -> None:
    if trace.get("scenario") != "E2E-01-native-owner":
        raise ValueError("trace is not an E2E-01 native-owner artifact")
    imported = trace.get("knowledge", {}).get("importDocument", {})
    if not all(isinstance(imported.get(key), str) and imported[key] for key in ("filename", "title", "content")):
        raise ValueError("trace schema v2 with knowledge.importDocument filename/title/content is required")
    if not isinstance(trace.get("sop", {}).get("definition"), dict):
        raise ValueError("trace schema v2 with sop.definition is required")
    lifecycle = trace.get("knowledge", {}).get("documentLifecycle", {})
    if not isinstance(lifecycle.get("update"), dict) or not isinstance(lifecycle.get("updatedQuery"), dict):
        raise ValueError("trace schema v3 with knowledge.documentLifecycle is required")


def b0_python() -> str:
    explicit = os.environ.get("STAFFDECK_PYTHON")
    if explicit:
        return explicit
    return "/tmp/staffdeck-portable-test.S8GP21/bin/python"


def run_worker(trace_path: Path, database: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [b0_python(), str(Path(__file__).resolve()), "--worker", str(BASELINE_ROOT), str(trace_path), str(database)],
        check=False,
        capture_output=True,
        text=True,
        cwd=BASELINE_ROOT / "backend",
        env={
            **os.environ,
            "PYTHONPATH": os.pathsep.join([str(BASELINE_ROOT / "backend"), str(BASELINE_ROOT / "backend/src")]),
            "DATABASE_URL": f"sqlite:///{database}",
            "DEMO_SEED_ENABLED": "true",
            "STARTUP_ORPHAN_CLEANUP_ENABLED": "false",
            "HARNESS_V3_ENABLED": "false",
            "HARNESS_ADMIN_API_ENABLED": "false",
            "PUBLIC_API_ENABLED": "false",
            "STAFFDECK_KNOWLEDGE_SEED": "true",
        },
    )
    if completed.returncode:
        raise RuntimeError(f"B0 worker exited {completed.returncode}: {completed.stderr.strip() or completed.stdout.strip()}")
    return json.loads(completed.stdout)


def worker(root: Path, trace_path: Path, database: Path) -> None:
    del root, database
    trace = json.loads(trace_path.read_text())
    knowledge = trace["knowledge"]
    imported = knowledge["importDocument"]
    query_request = knowledge["queryRequests"][0]

    from app.api.knowledge import get_job, list_documents, search_knowledge, update_document, upload_document
    from app.api.knowledge_bases import create_knowledge_base
    from app.async_jobs import shutdown_async_jobs, start_async_jobs
    from app.core.graph_rules import GraphRules
    from app.db import engine, init_db
    from app.db.models import KnowledgeChunk, User
    from app.db.seed import seed_demo_data
    from app.knowledge.schema import (
        KnowledgeBaseCreateRequest,
        KnowledgeDocumentUpdateRequest,
        KnowledgeDocumentUploadRequest,
        KnowledgeSearchRequest,
    )
    from sqlmodel import Session

    init_db()
    with Session(engine) as db:
        seed_demo_data(db)
        actor_id = str(query_request.get("actorUserId") or "admin")
        actor = db.get(User, actor_id)
        if actor is None:
            raise RuntimeError(f"B0 seed does not contain actor {actor_id}")
        tenant_id = str(query_request["tenantId"])
        created = create_knowledge_base(
            KnowledgeBaseCreateRequest(tenant_id=tenant_id, name=knowledge["createBase"]["name"]),
            None,
            db,
            actor,
        )
        job = upload_document(
            KnowledgeDocumentUploadRequest(
                tenant_id=tenant_id,
                knowledge_base_id=created.id,
                filename=imported["filename"],
                title=imported["title"],
                content_base64=base64.b64encode(imported["content"].encode()).decode(),
            ),
            None,
            db,
            actor,
        )
        start_async_jobs()
        try:
            final_job = wait_for_job(db, job.id, tenant_id, get_job)
            response = search_knowledge(
                KnowledgeSearchRequest(
                    tenant_id=tenant_id,
                    knowledge_base_ids=[created.id],
                    query=query_request["query"],
                    query_type=query_request["queryType"],
                    max_chunks=query_request["maxChunks"],
                    max_buckets=query_request["maxBuckets"],
                    budget_tokens=query_request["budgetTokens"],
                    need_evidence_pack=query_request["needEvidencePack"],
                ),
                db,
                actor,
            )
        finally:
            shutdown_async_jobs()
        if not response.evidence_pack:
            raise AssertionError("B0 query returned no durable evidence")
        citation_id = response.evidence_pack[0].get("chunk_id")
        citation = db.get(KnowledgeChunk, citation_id)
        if citation is None:
            raise AssertionError("B0 query returned an unresolvable citation")
        initial_citation_content = citation.content

        documents = list_documents(tenant_id, created.id, None, False, db)
        source_document = next((item for item in documents if item.filename == imported["filename"]), None)
        if source_document is None:
            raise AssertionError("B0 import did not produce the saved document")
        lifecycle = knowledge["documentLifecycle"]
        update = lifecycle["update"]
        updated = update_document(
            source_document.id,
            KnowledgeDocumentUpdateRequest(
                tenant_id=tenant_id,
                title=update["title"],
                content_md=update["content"],
            ),
            db,
            actor,
        )
        stale_citation = db.get(KnowledgeChunk, citation_id) is None
        updated_query_request = lifecycle["updatedQuery"]
        updated_response = search_knowledge(
            KnowledgeSearchRequest(
                tenant_id=tenant_id,
                knowledge_base_ids=[created.id],
                query=updated_query_request["query"],
                query_type=updated_query_request["queryType"],
                max_chunks=updated_query_request["maxChunks"],
                max_buckets=updated_query_request["maxBuckets"],
                budget_tokens=updated_query_request["budgetTokens"],
                need_evidence_pack=updated_query_request["needEvidencePack"],
            ),
            db,
            actor,
        )
        if not updated_response.evidence_pack:
            raise AssertionError("B0 updated-document query returned no durable evidence")
        updated_citation_id = updated_response.evidence_pack[0].get("chunk_id")
        updated_citation = db.get(KnowledgeChunk, updated_citation_id)
        if updated_citation is None:
            raise AssertionError("B0 updated-document query returned an unresolvable citation")
        archived = update_document(
            updated.id,
            KnowledgeDocumentUpdateRequest(tenant_id=tenant_id, status="archived"),
            db,
            actor,
        )
        archived_response = search_knowledge(
            KnowledgeSearchRequest(
                tenant_id=tenant_id,
                knowledge_base_ids=[created.id],
                query=updated_query_request["query"],
                query_type=updated_query_request["queryType"],
                max_chunks=updated_query_request["maxChunks"],
                max_buckets=updated_query_request["maxBuckets"],
                budget_tokens=updated_query_request["budgetTokens"],
                need_evidence_pack=updated_query_request["needEvidencePack"],
            ),
            db,
            actor,
        )

        definition = trace["sop"]["definition"]["content"]
        waiting = trace["sop"]["waiting"]["state"]
        completed = trace["sop"]["completed"]["state"]
        active_step = str(waiting["active_step_id"])
        current = GraphRules.current_step(definition, active_step)
        print(json.dumps({
            "knowledge": {
                "base": {"name": created.name},
                "job": {"status": final_job.status, "stage": final_job.stage},
                "document": {"filename": imported["filename"], "title": imported["title"]},
                "query": {
                    "query": query_request["query"],
                    "queryType": query_request["queryType"],
                    "maxChunks": query_request["maxChunks"],
                    "maxBuckets": query_request["maxBuckets"],
                    "budgetTokens": query_request["budgetTokens"],
                    "needEvidencePack": query_request["needEvidencePack"],
                    "evidenceContent": response.evidence_pack[0].get("content"),
                },
                "citation": {"content": initial_citation_content},
                "documentLifecycle": {
                    "updatedCitation": {"content": updated_citation.content},
                    "previousCitationRejected": stale_citation,
                    "archive": {
                        "status": archived.status,
                        "evidenceCount": len(archived_response.evidence_pack or []),
                    },
                },
            },
            "sop": {
                "activeStep": active_step,
                "isHandoff": bool(current and GraphRules.is_handoff_node(current)),
                "allowedActions": GraphRules.step_actions(current or {}),
                "terminalWithCompletedSlots": GraphRules.terminal_position(
                    definition, str(completed["active_step_id"]), dict(completed["slots_json"])
                ),
            },
        }, ensure_ascii=False))


def wait_for_job(db: Any, job_id: str, tenant_id: str, get_job: Any) -> Any:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job = get_job(job_id, tenant_id, None, db)
        if job.status in {"succeeded", "failed", "cancelled"}:
            if job.status != "succeeded":
                raise AssertionError(f"B0 ingest job finished as {job.status}")
            return job
        time.sleep(0.2)
    raise TimeoutError("B0 Knowledge ingest job did not finish")


def compare(trace: dict[str, Any], actual: dict[str, Any]) -> None:
    knowledge = trace["knowledge"]
    expected_content = knowledge["citation"]["content"]
    if actual["knowledge"]["base"]["name"] != knowledge["createBase"]["name"]:
        raise AssertionError("B0 create_base result differs from saved E2E trace")
    if actual["knowledge"]["job"]["status"] != "succeeded":
        raise AssertionError("B0 import job did not preserve successful side effect")
    if actual["knowledge"]["document"] != {
        "filename": knowledge["importDocument"]["filename"],
        "title": knowledge["importDocument"]["title"],
    }:
        raise AssertionError("B0 imported-document side effect differs from saved E2E trace")
    if actual["knowledge"]["query"]["evidenceContent"] != expected_content:
        raise AssertionError("B0 query result differs from saved durable citation content")
    if actual["knowledge"]["citation"]["content"] != expected_content:
        raise AssertionError("B0 durable citation lookup differs from saved E2E trace")
    lifecycle = knowledge["documentLifecycle"]
    actual_lifecycle = actual["knowledge"]["documentLifecycle"]
    if not actual_lifecycle["previousCitationRejected"] or not lifecycle["previousCitationRejected"]:
        raise AssertionError("B0 updated document retained the saved stale citation")
    if actual_lifecycle["updatedCitation"]["content"] != lifecycle["updatedCitation"]["content"]:
        raise AssertionError("B0 updated-document citation differs from saved E2E trace")
    if actual_lifecycle["archive"] != lifecycle["archive"]:
        raise AssertionError("B0 archive state or post-archive evidence differs from saved E2E trace")
    outage = knowledge.get("outageRecovery")
    if not isinstance(outage, dict):
        raise AssertionError("saved E2E trace has no Knowledge outage/recovery projection")
    if outage.get("sopBefore") != outage.get("sopDuring"):
        raise AssertionError("Knowledge outage advanced the saved SOP state")
    if outage.get("recoveredCitation", {}).get("content") != expected_content:
        raise AssertionError("Knowledge recovery did not preserve the saved durable citation")
    isolation = knowledge.get("sessionIsolation")
    if not isinstance(isolation, dict):
        raise AssertionError("saved E2E trace has no cross-session stale-resume projection")
    if isolation.get("firstBeforeStaleResume") != isolation.get("firstAfterStaleResume"):
        raise AssertionError("cross-session stale resume advanced the saved first-session SOP state")
    if isolation.get("second", {}).get("state", {}).get("status") != "handoff":
        raise AssertionError("saved second session did not retain its independent SOP handoff")
    lost_response = knowledge.get("lostResponseRecovery")
    if not isinstance(lost_response, dict) or lost_response.get("documentCount") != 1:
        raise AssertionError("lost import response did not recover exactly one saved document")
    if lost_response.get("dispatchCount") != 1:
        raise AssertionError("lost import response did not preserve exactly one candidate dispatch")
    sop = actual["sop"]
    if sop["activeStep"] != trace["sop"]["waiting"]["state"]["active_step_id"] or not sop["isHandoff"]:
        raise AssertionError("B0 graph does not classify the saved waiting step as handoff")
    if not {"call_tool:read_file", "call_tool:knowledge_query"}.issubset(sop["allowedActions"]):
        raise AssertionError("B0 graph no longer permits the saved SOP tool side effects")
    if not sop["terminalWithCompletedSlots"]:
        raise AssertionError("B0 graph does not accept the saved completion terminal predicate")


if __name__ == "__main__":
    main()
