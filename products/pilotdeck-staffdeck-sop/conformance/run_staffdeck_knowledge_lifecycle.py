#!/usr/bin/env python3
"""Exercise the real StaffDeck Knowledge module across a process restart.

The script starts the Knowledge-only ASGI entrypoint from the sibling
StaffDeck checkout, drives the public module protocol, then starts a fresh
process against the same SQLite database and verifies query/citation state.
It is deliberately independent of PilotDeck adapters and does not construct
expected values from candidate glue.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_STAFFDECK_ROOT = Path("/Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop")
TRACE: list[dict[str, Any]] = []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--staffdeck-root", type=Path, default=DEFAULT_STAFFDECK_ROOT)
    parser.add_argument("--python", dest="python_bin", type=Path)
    parser.add_argument("--port", type=int, default=18296)
    parser.add_argument("--artifact-dir", type=Path)
    args = parser.parse_args()

    staffdeck_root = args.staffdeck_root.resolve()
    python_bin = args.python_bin or staffdeck_root / "backend/.venv/bin/python"
    if not python_bin.exists():
        raise SystemExit(f"StaffDeck Python runtime not found: {python_bin}")

    with tempfile.TemporaryDirectory(prefix="staffdeck-knowledge-lifecycle-") as temp_dir:
        database = Path(temp_dir) / "knowledge.sqlite"
        env = os.environ.copy()
        env.update(
            {
                "PYTHONPATH": os.pathsep.join(
                    [str(staffdeck_root / "backend"), str(staffdeck_root / "backend/src"), str(staffdeck_root / "portable_sop/src")]
                ),
                "DATABASE_URL": f"sqlite:///{database}",
                "DEMO_SEED_ENABLED": "false",
                "STAFFDECK_KNOWLEDGE_SEED": "true",
                "STARTUP_ORPHAN_CLEANUP_ENABLED": "false",
                "PUBLIC_API_ENABLED": "false",
                "HARNESS_V3_ENABLED": "false",
                "HARNESS_ADMIN_API_ENABLED": "false",
                "STAFFDECK_KNOWLEDGE_USER_ID": "admin",
                "STAFFDECK_KNOWLEDGE_TENANT_ID": "tenant_demo",
                "PYTHONUNBUFFERED": "1",
            }
        )

        base_url = f"http://127.0.0.1:{args.port}"
        process = _start_process(staffdeck_root, python_bin, args.port, env)
        try:
            _wait_for_health(base_url, process)
            first = _exercise_before_restart(base_url)
            _stop_process(process)
            process = _start_process(staffdeck_root, python_bin, args.port, env)
            _wait_for_health(base_url, process)
            second = _exercise_after_restart(base_url, first)
            management = _exercise_public_management_surface(base_url, first)
            result = {
                "status": "PASS",
                "database": str(database),
                "endpoint": base_url,
                "stages": [
                    "manifest",
                    "list_bases",
                    "create_base",
                    "import_document",
                    "get_job_ready",
                    "list_documents",
                    "list_okf_concepts",
                    "lint_okf",
                    "export_okf",
                    "query",
                    "resolve_citation",
                    "restart_query",
                    "restart_resolve_citation",
                    "public_management_surface",
                ],
                "baseId": first["base_id"],
                "documentId": first["document_id"],
                "jobId": first["job_id"],
                "citationId": first["citation_id"],
                "restart": second,
                "management": management,
            }
            if args.artifact_dir:
                args.artifact_dir.mkdir(parents=True, exist_ok=True)
                artifact = args.artifact_dir / "staffdeck-knowledge-lifecycle.json"
                artifact.write_text(
                    json.dumps({**result, "trace": TRACE}, indent=2, ensure_ascii=False) + "\n"
                )
                result["artifact"] = str(artifact)
            print(json.dumps(result, indent=2, ensure_ascii=False))
        finally:
            _stop_process(process)


def _start_process(root: Path, python_bin: Path, port: int, env: dict[str, str]) -> subprocess.Popen[str]:
    command = [
        str(python_bin),
        "-m",
        "uvicorn",
        "app.module_knowledge_app:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
    ]
    return subprocess.Popen(
        command,
        cwd=root / "backend",
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def _stop_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _wait_for_health(base_url: str, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 20
    last_error = ""
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise RuntimeError(
                f"Knowledge process exited {process.returncode}: stdout={stdout[-2000:]} stderr={stderr[-4000:]}"
            )
        try:
            body = _request(base_url + "/api/health", None)
            if body.get("status") == "ok":
                return
        except Exception as exc:  # noqa: BLE001 - startup polling is retried.
            last_error = str(exc)
        time.sleep(0.15)
    raise RuntimeError(f"Knowledge process did not become healthy: {last_error}")


def _exercise_before_restart(base_url: str) -> dict[str, str]:
    manifest = _request(base_url + "/module-manifest", None)
    required_methods = {
        "list_bases",
        "create_base",
        "import_document",
        "get_job",
        "list_documents",
        "list_okf_concepts",
        "lint_okf",
        "export_okf",
        "query",
        "resolve_citation",
    }
    if not required_methods.issubset(set(manifest.get("methods", []))):
        raise AssertionError(f"Knowledge manifest is missing required methods: {manifest}")

    list_result = _call(base_url, "list_bases", {})
    if not isinstance(list_result, list):
        raise AssertionError(f"list_bases did not return a list: {list_result}")

    suffix = str(int(time.time() * 1000))
    created = _call(
        base_url,
        "create_base",
        {
            "tenantId": "tenant_demo",
            "actorUserId": "admin",
            "name": f"Approval policy {suffix}",
            "description": "Cross-process Knowledge lifecycle fixture",
        },
    )
    base_id = _text(created, "id")

    content = """# Approval policy\n\nAll production changes require owner approval before release.\n\n## Escalation\n\nSecurity-sensitive changes require security review and an audit citation.\n"""
    imported = _call(
        base_url,
        "import_document",
        {
            "tenantId": "tenant_demo",
            "actorUserId": "admin",
            "knowledgeBaseId": base_id,
            "filename": "approval-policy.md",
            "title": "Approval policy",
            "contentBase64": base64.b64encode(content.encode()).decode(),
        },
    )
    job_id = _text(imported, "id")
    job = _poll_job(base_url, job_id)
    if job.get("status") not in {"succeeded", "completed", "success"}:
        raise AssertionError(f"Knowledge ingestion did not finish successfully: {job}")

    documents = _call(
        base_url,
        "list_documents",
        {"tenantId": "tenant_demo", "knowledgeBaseId": base_id},
    )
    if not documents:
        raise AssertionError("list_documents returned no imported document")
    document_id = _text(documents[0], "id")

    concepts = _call(
        base_url,
        "list_okf_concepts",
        {"tenantId": "tenant_demo", "knowledgeBaseId": base_id},
    )
    if not concepts:
        raise AssertionError("list_okf_concepts returned no generated owner concepts")
    lint = _call(
        base_url,
        "lint_okf",
        {"tenantId": "tenant_demo", "knowledgeBaseId": base_id},
    )
    if lint.get("status") != "ok":
        raise AssertionError(f"lint_okf did not return native success: {lint}")
    exported = _call(
        base_url,
        "export_okf",
        {"tenantId": "tenant_demo", "knowledgeBaseId": base_id},
    )
    if exported.get("media_type") != "application/zip" or not exported.get("content_base64"):
        raise AssertionError(f"export_okf did not return a portable archive: {exported}")

    query = _call(
        base_url,
        "query",
        {
            "tenantId": "tenant_demo",
            "actorUserId": "admin",
            "knowledgeBaseIds": [base_id],
            "query": "owner approval before release",
            "queryType": "answer",
            "maxChunks": 8,
            "maxBuckets": 4,
            "budgetTokens": 4000,
            "needEvidencePack": True,
        },
    )
    citation_id = _citation_id(query)
    citation = _call(
        base_url,
        "resolve_citation",
        {"tenantId": "tenant_demo", "chunkId": citation_id},
    )
    if _text(citation, "id") != citation_id or "owner approval" not in _text(citation, "content").lower():
        raise AssertionError(f"resolve_citation did not return persisted source snapshot: {citation}")

    return {
        "base_id": base_id,
        "document_id": document_id,
        "job_id": job_id,
        "citation_id": citation_id,
        "concept_id": _text(concepts[0], "concept_id"),
    }


def _exercise_after_restart(base_url: str, first: dict[str, str]) -> dict[str, Any]:
    bases = _call(base_url, "list_bases", {"tenantId": "tenant_demo"})
    if not any(_text(item, "id") == first["base_id"] for item in bases):
        raise AssertionError("Knowledge base was not durable across process restart")
    query = _call(
        base_url,
        "query",
        {
            "tenantId": "tenant_demo",
            "actorUserId": "admin",
            "knowledgeBaseIds": [first["base_id"]],
            "query": "security review audit citation",
            "maxChunks": 8,
            "maxBuckets": 4,
            "budgetTokens": 4000,
            "needEvidencePack": True,
        },
    )
    citation = _call(
        base_url,
        "resolve_citation",
        {"tenantId": "tenant_demo", "chunkId": first["citation_id"]},
    )
    if _text(citation, "id") != first["citation_id"]:
        raise AssertionError("Persisted citation could not be resolved after restart")
    concepts = _call(
        base_url,
        "list_okf_concepts",
        {"tenantId": "tenant_demo", "knowledgeBaseId": first["base_id"]},
    )
    if not any(_text(item, "concept_id") == first["concept_id"] for item in concepts):
        raise AssertionError("Generated OKF concepts were not durable across process restart")
    return {
        "base_present": True,
        "query_has_evidence": bool(_evidence_rows(query)),
        "citation_present": True,
        "okf_concept_present": True,
    }


def _exercise_public_management_surface(base_url: str, first: dict[str, str]) -> dict[str, Any]:
    """Drive each remaining public facade operation through the module process.

    Branch mutations need a non-overall agent, which the Knowledge-only
    deployment intentionally does not create.  Those entries still traverse
    their native owner and must return the owner's documented overall-agent
    rejection rather than a facade-specific failure.
    """
    scope = {"tenantId": "tenant_demo", "actorUserId": "admin"}
    base = _call(base_url, "get_base", {**scope, "knowledgeBaseId": first["base_id"]})
    if _text(base, "id") != first["base_id"]:
        raise AssertionError(f"get_base returned the wrong base: {base}")
    updated_base = _call(
        base_url,
        "update_base",
        {**scope, "knowledgeBaseId": first["base_id"], "description": "Updated through module HTTP"},
    )
    if updated_base.get("description") != "Updated through module HTTP":
        raise AssertionError(f"update_base did not preserve the owner update: {updated_base}")
    versions = _call(base_url, "list_versions", {**scope, "knowledgeBaseId": first["base_id"]})
    if not versions:
        raise AssertionError("list_versions returned no native base version")

    document = _call(base_url, "get_document", {**scope, "documentId": first["document_id"]})
    if _text(document, "id") != first["document_id"]:
        raise AssertionError(f"get_document returned the wrong document: {document}")
    buckets = _call(
        base_url, "list_document_buckets", {**scope, "documentId": first["document_id"]}
    )
    if not buckets:
        raise AssertionError("list_document_buckets returned no native bucket")
    bucket = _call(
        base_url,
        "update_bucket",
        {
            **scope,
            "bucketId": _text(buckets[0], "id"),
            "summary": "Updated through module HTTP",
        },
    )
    chunks = _call(base_url, "list_bucket_chunks", {**scope, "bucketId": _text(bucket, "id")})
    if not chunks:
        raise AssertionError("list_bucket_chunks returned no native chunk")
    chunk = _call(
        base_url,
        "update_chunk",
        {
            **scope,
            "chunkId": _text(chunks[0], "id"),
            "summary": "Updated through module HTTP",
        },
    )
    if chunk.get("summary") != "Updated through module HTTP":
        raise AssertionError(f"update_chunk did not preserve the owner update: {chunk}")

    jobs = _call(base_url, "list_jobs", {**scope, "limit": 16})
    if not any(_text(job, "id") == first["job_id"] for job in jobs):
        raise AssertionError("list_jobs did not expose the imported job")
    job = _call(base_url, "get_job", {**scope, "jobId": first["job_id"]})
    if _text(job, "id") != first["job_id"]:
        raise AssertionError(f"get_job returned the wrong job: {job}")
    cancelled = _call(base_url, "cancel_job", {**scope, "jobId": first["job_id"]})

    concepts = _call(
        base_url, "list_okf_concepts", {**scope, "knowledgeBaseId": first["base_id"]}
    )
    concept = _call(
        base_url,
        "get_okf_concept",
        {**scope, "knowledgeBaseId": first["base_id"], "conceptId": first["concept_id"]},
    )
    custom_concept = _call(
        base_url,
        "upsert_okf_concept",
        {
            **scope,
            "knowledgeBaseId": first["base_id"],
            "conceptId": "rules/module-http",
            "contentMd": "---\ntype: Business Rule\ntitle: Module HTTP\n---\nModule HTTP preserves owner facts.\n",
        },
    )
    if _text(custom_concept, "concept_id") != "rules/module-http":
        raise AssertionError(f"upsert_okf_concept returned the wrong concept: {custom_concept}")

    archive = _call(base_url, "export_okf", {**scope, "knowledgeBaseId": first["base_id"]})
    disposable = _call(
        base_url,
        "create_base",
        {**scope, "name": f"Disposable module HTTP {time.time_ns()}"},
    )
    imported_okf = _call(
        base_url,
        "import_okf",
        {
            **scope,
            "knowledgeBaseId": _text(disposable, "id"),
            "filename": "module-http.okf.zip",
            "contentBase64": _text(archive, "content_base64"),
        },
    )
    deleted = _call(
        base_url,
        "delete_base",
        {**scope, "knowledgeBaseId": _text(disposable, "id")},
    )

    updated_document = _call(
        base_url,
        "update_document",
        {
            **scope,
            "documentId": first["document_id"],
            "title": "Approval policy via module HTTP",
        },
    )
    archived_document = _call(
        base_url,
        "delete_document",
        {**scope, "documentId": first["document_id"]},
    )
    all_documents = _call(
        base_url,
        "list_documents",
        {**scope, "knowledgeBaseId": first["base_id"], "includeAllVersions": True},
    )
    if not any(_text(row, "id") == first["document_id"] for row in all_documents):
        raise AssertionError("includeAllVersions did not retain the archived document")

    discoveries = _call(
        base_url,
        "list_discoveries",
        {**scope, "knowledgeBaseId": first["base_id"], "status": "pending"},
    )
    if not discoveries:
        raise AssertionError("native discovery did not produce a pending record")
    confirmed = _call(
        base_url, "confirm_discovery", {**scope, "suggestionId": _text(discoveries[0], "id")}
    )
    rejected = _call_expect_error(
        base_url,
        "reject_discovery",
        {**scope, "suggestionId": "missing-module-discovery"},
        "STAFFDECK_HTTP_404",
    )
    overall_agent = "agent_tenant_demo_overall"
    branch_errors = {
        operation: _call_expect_error(
            base_url,
            operation,
            {
                **scope,
                "knowledgeBaseId": first["base_id"],
                "agentId": overall_agent,
                "version": _text(versions[0], "version"),
            },
            "STAFFDECK_HTTP_400",
        )
        for operation in ("sync_base", "publish_version", "rollback_version")
    }
    return {
        "base": _text(updated_base, "id"),
        "version_count": len(versions),
        "bucket": _text(bucket, "id"),
        "chunk": _text(chunk, "id"),
        "job_status_after_cancel": cancelled.get("status"),
        "concept_count": len(concepts),
        "concept": _text(concept, "concept_id"),
        "custom_concept": _text(custom_concept, "concept_id"),
        "okf_import_status": imported_okf.get("status"),
        "delete_base_status": deleted.get("status"),
        "updated_document_status": updated_document.get("status"),
        "archived_document_status": archived_document.get("status"),
        "discovery_count": len(discoveries),
        "discovery_statuses": [confirmed.get("status"), rejected["code"]],
        "branch_errors": branch_errors,
    }


def _poll_job(base_url: str, job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30
    latest: dict[str, Any] = {}
    while time.monotonic() < deadline:
        latest = _call(
            base_url,
            "get_job",
            {"tenantId": "tenant_demo", "actorUserId": "admin", "jobId": job_id},
        )
        if latest.get("status") in {"succeeded", "completed", "success", "failed", "cancelled"}:
            return latest
        time.sleep(0.2)
    raise TimeoutError(f"Knowledge job did not reach a terminal state: {latest}")


def _call(base_url: str, operation: str, value: dict[str, Any]) -> dict[str, Any] | list[Any]:
    response = _call_response(base_url, operation, value)
    if response.get("ok") is not True:
        raise AssertionError(f"Knowledge operation {operation} failed: {json.dumps(response, ensure_ascii=False)}")
    return response.get("payload", {}).get("result")


def _call_expect_error(
    base_url: str, operation: str, value: dict[str, Any], expected_code: str
) -> dict[str, Any]:
    response = _call_response(base_url, operation, value)
    if response.get("ok") is not False or response.get("code") != expected_code:
        raise AssertionError(
            f"Knowledge operation {operation} did not preserve native error {expected_code}: {response}"
        )
    return {"code": response["code"], "message": response.get("error", {}).get("message")}


def _call_response(base_url: str, operation: str, value: dict[str, Any]) -> dict[str, Any]:
    envelope = {
        "kind": "request",
        "method": "module_call",
        "messageId": f"message-{operation}-{time.time_ns()}",
        "runId": "knowledge-lifecycle",
        "operationId": f"operation-{operation}-{time.time_ns()}",
        "requestId": f"request-{operation}-{time.time_ns()}",
        "module": "knowledge",
        "payload": {"operation": operation, "input": value},
    }
    response = _request(base_url + "/v2/module/call", envelope)
    TRACE.append(
        {
            "operation": operation,
            "request": envelope,
            "response": response,
        }
    )
    return response


def _request(url: str, body: dict[str, Any] | None) -> dict[str, Any]:
    request = urllib.request.Request(url, method="POST" if body is not None else "GET")
    if body is not None:
        request.add_header("Content-Type", "application/json")
        data = json.dumps(body, ensure_ascii=False).encode()
    else:
        data = None
    try:
        with urllib.request.urlopen(request, data=data, timeout=10) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        payload = error.read().decode()
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"HTTP {error.code} from {url}: {payload}") from exc


def _text(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise AssertionError(f"Expected non-empty {key} in {value}")
    return result


def _evidence_rows(value: dict[str, Any]) -> list[Any]:
    rows = value.get("evidence_pack")
    return rows if isinstance(rows, list) else []


def _citation_id(value: dict[str, Any]) -> str:
    evidence = _evidence_rows(value)
    if not evidence:
        raise AssertionError(f"Knowledge query returned no evidence pack: {value}")
    for row in evidence:
        if isinstance(row, dict):
            for key in ("chunk_id", "chunkId", "id"):
                candidate = row.get(key)
                if isinstance(candidate, str) and candidate:
                    return candidate
    raise AssertionError(f"Knowledge evidence has no citation id: {value}")


if __name__ == "__main__":
    main()
