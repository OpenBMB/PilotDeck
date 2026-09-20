"""Compare the native StaffDeck Knowledge lifecycle in B0 and the candidate.

The worker imports each checkout in an isolated interpreter and calls the
native Knowledge owner functions directly. Expected values are never produced
by the candidate adapter or module protocol. A second worker process reopens
the same SQLite database to exercise durable query and citation state.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from pathlib import Path
from typing import Any
from zipfile import ZipFile
from io import BytesIO

BASELINE_ROOT = Path(os.environ.get("STAFFDECK_B0_ROOT", "/tmp/pilotdeck-staffdeck-m0.j4voeS/staffdeck-b0"))
CANDIDATE_ROOT = Path(os.environ.get("STAFFDECK_CANDIDATE_ROOT", "/Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop"))
FIXTURE = "B0-C Knowledge owner lifecycle fixture"


def main() -> None:
    if len(sys.argv) == 5 and sys.argv[1] == "--worker":
        worker(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])
        return

    if not BASELINE_ROOT.exists():
        raise SystemExit(f"StaffDeck B0 root is missing: {BASELINE_ROOT}")
    with tempfile.TemporaryDirectory(prefix="staffdeck-knowledge-owner-diff-") as temp_dir:
        temp = Path(temp_dir)
        results: dict[str, dict[str, Any]] = {}
        for label, root in (("baseline", BASELINE_ROOT), ("candidate", CANDIDATE_ROOT)):
            database = temp / f"{label}.sqlite"
            state = temp / f"{label}.state.json"
            initial = _run_worker(root, database, state, "initial")
            resumed = _run_worker(root, database, state, "resume")
            okf = _run_worker(root, database, state, "okf")
            surface = _run_worker(root, database, state, "surface")
            management = _run_worker(root, database, state, "management")
            branch = _run_worker(root, database, state, "branch")
            race = _run_worker(root, database, state, "race")
            results[label] = {
                "initial": initial,
                "okf": okf,
                "surface": surface,
                "branch": branch,
                "race": race,
                "resume": resumed,
                "management": management,
            }

        if os.environ.get("STAFFDECK_KNOWLEDGE_OWNER_INJECT_MISMATCH") == "surface":
            results["candidate"]["surface"]["bucket"]["summary"] = "injected mismatch"
        if results["baseline"] != results["candidate"]:
            raise AssertionError(
                "StaffDeck Knowledge owner lifecycle differential mismatch\n"
                f"baseline={json.dumps(results['baseline'], ensure_ascii=False, sort_keys=True)}\n"
                f"candidate={json.dumps(results['candidate'], ensure_ascii=False, sort_keys=True)}"
            )

        altered = json.loads(json.dumps(results["candidate"], ensure_ascii=False))
        altered["resume"]["query"]["evidence"][0]["content"] += " altered"
        if altered == results["candidate"]:
            raise AssertionError("Comparator sensitivity fixture did not detect citation content change")

        print(
            json.dumps(
                {
                    "status": "PASS",
                    "baseline": str(BASELINE_ROOT),
                    "candidate": str(CANDIDATE_ROOT),
                    "cases": [
                        "list-and-create-base",
                        "import-and-persist-job",
                        "lexical-query-and-evidence-order",
                        "citation-resolution",
                        "fresh-process-query-and-citation-recovery",
                        "okf-concept-list-upsert-lint-and-export",
                        "base-document-bucket-job-discovery-public-owner-surface",
                        "tenant-isolation-and-optimistic-update-conflict",
                        "document-archive-and-queued-ingest-cancellation",
                        "agent-branch-version-publish-and-rollback",
                        "concurrent-branch-version-workers",
                    ],
                    "compared": 11,
                    "trace": results,
                },
                indent=2,
                ensure_ascii=False,
            )
        )


def _run_worker(root: Path, database: Path, state: Path, phase: str) -> dict[str, Any]:
    python_bin = os.environ.get("STAFFDECK_PYTHON")
    if python_bin:
        executable = Path(python_bin)
    else:
        candidate = root / "backend/.venv/bin/python"
        executable = candidate if candidate.exists() else Path("/tmp/staffdeck-portable-test.S8GP21/bin/python")
    command = [str(executable), str(Path(__file__).resolve()), "--worker", str(root), str(database), phase]
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [str(root / "backend"), str(root / "backend/src"), str(root / "portable_sop/src")]
            ),
            "DATABASE_URL": f"sqlite:///{database}",
            "DEMO_SEED_ENABLED": "true",
            "STARTUP_ORPHAN_CLEANUP_ENABLED": "false",
            "HARNESS_V3_ENABLED": "false",
            "HARNESS_ADMIN_API_ENABLED": "false",
            "PUBLIC_API_ENABLED": "false",
            "STAFFDECK_KNOWLEDGE_SEED": "true",
        },
        cwd=root / "backend",
    )
    if completed.returncode != 0:
        raise RuntimeError(
            f"Knowledge worker failed ({completed.returncode}) for {phase}:\n"
            f"stdout={completed.stdout}\nstderr={completed.stderr}"
        )
    return json.loads(completed.stdout)


def worker(root: Path, database: Path, phase: str) -> None:
    del root  # The root is carried by PYTHONPATH and retained for command evidence.
    from app.api.knowledge import (
        cancel_job,
        confirm_discovery,
        get_bucket_chunks,
        get_document,
        get_job,
        get_document_buckets,
        import_okf_bundle,
        list_discoveries,
        list_documents,
        list_jobs,
        reject_discovery,
        search_knowledge,
        update_bucket,
        update_chunk,
        update_document,
        upload_document,
    )
    from app.api.knowledge_bases import (
        create_knowledge_base,
        delete_knowledge_base,
        export_okf,
        get_knowledge_base,
        list_knowledge_base_versions,
        list_knowledge_bases,
        update_knowledge_base,
    )
    from app.agents.branching import (
        ensure_agent_private_knowledge_branch,
        knowledge_version_for_upload,
        promote_knowledge_branch_to_overall,
        rollback_knowledge_branch,
    )
    from app.async_jobs import shutdown_async_jobs, start_async_jobs
    from app.db import engine, init_db
    from app.db.models import (
        AgentKnowledgeBranch,
        AgentProfile,
        KnowledgeBase,
        KnowledgeDiscoverySuggestion,
        KnowledgeChunk,
        Tenant,
        User,
    )
    from app.db.seed import seed_demo_data
    from app.knowledge.schema import (
        KnowledgeBaseCreateRequest,
        KnowledgeBaseUpdateRequest,
        KnowledgeBucketUpdateRequest,
        KnowledgeChunkUpdateRequest,
        KnowledgeConceptUpdateRequest,
        KnowledgeDocumentUpdateRequest,
        KnowledgeDocumentUploadRequest,
        KnowledgeOkfImportRequest,
        KnowledgeSearchRequest,
    )
    from app.knowledge.service import IngestPayload, KnowledgeService
    from app.knowledge.okf import parse_okf_markdown
    from fastapi import HTTPException
    from sqlmodel import Session, select

    init_db()
    with Session(engine) as db:
        if phase == "initial":
            seed_demo_data(db)
        actor = db.get(User, "admin")
        if actor is None:
            raise RuntimeError("seed_demo_data did not create admin actor")

        if phase == "initial":
            start_async_jobs()
            try:
                before = list_knowledge_bases("tenant_demo", None, db)
                created = create_knowledge_base(
                    KnowledgeBaseCreateRequest(
                        tenant_id="tenant_demo",
                        name=FIXTURE,
                        description="B0/C native lifecycle fixture",
                    ),
                    None,
                    db,
                    actor,
                )
                content = (
                    "# Approval policy\n\n"
                    "All production changes require owner approval before release.\n\n"
                    "## Escalation\n\n"
                    "Security-sensitive changes require security review and an audit citation.\n"
                )
                job = upload_document(
                    KnowledgeDocumentUploadRequest(
                        tenant_id="tenant_demo",
                        knowledge_base_id=created.id,
                        filename="approval-policy.md",
                        title="Approval policy",
                        content_base64=base64.b64encode(content.encode()).decode(),
                    ),
                    None,
                    db,
                    actor,
                )
                latest = _wait_for_job(db, job.id, get_job)
                documents = list_documents("tenant_demo", created.id, None, False, db)
                query = search_knowledge(
                    KnowledgeSearchRequest(
                        tenant_id="tenant_demo",
                        knowledge_base_ids=[created.id],
                        query="owner approval before release",
                        max_chunks=8,
                        max_buckets=4,
                        budget_tokens=4000,
                        need_evidence_pack=True,
                    ),
                    db,
                    actor,
                )
                citation_id = query.evidence_pack[0]["chunk_id"]
                citation = db.get(KnowledgeChunk, citation_id)
                if citation is None:
                    raise RuntimeError(f"query returned missing citation chunk {citation_id}")
                Path(str(database) + ".state.json").write_text(
                    json.dumps(
                        {"base_id": created.id, "citation_id": citation_id, "job_id": job.id},
                        ensure_ascii=False,
                    )
                )
                print(
                    json.dumps(
                        {
                            "before_count": len(before),
                            "base": {"name": created.name, "status": created.status, "version": created.version},
                            "job": _job_projection(latest),
                            "documents": _document_projection(documents),
                            "query": _query_projection(query),
                            "citation": _citation_projection(citation),
                        },
                        ensure_ascii=False,
                    )
                )
            finally:
                shutdown_async_jobs()
            return

        state_path = Path(str(database) + ".state.json")
        state = json.loads(state_path.read_text())
        bases = list_knowledge_bases("tenant_demo", None, db)
        if not any(row.id == state["base_id"] for row in bases):
            raise AssertionError("created base is not visible after fresh owner process")
        if phase == "branch":
            agent_id = "agent_tenant_demo_branch"
            agent = db.get(AgentProfile, agent_id)
            if agent is None:
                agent = AgentProfile(
                    id=agent_id,
                    tenant_id="tenant_demo",
                    name="Branch fixture agent",
                    description="B0/C branch lifecycle fixture",
                    is_overall=False,
                    status="active",
                )
                db.add(agent)
                db.commit()
            branch = ensure_agent_private_knowledge_branch(
                db,
                "tenant_demo",
                agent_id,
                db.get(KnowledgeBase, state["base_id"]),
            )
            db.commit()
            initial_versions = list_knowledge_base_versions(
                state["base_id"], "tenant_demo", agent_id, db
            )
            private_version = knowledge_version_for_upload(
                db, "tenant_demo", state["base_id"], agent_id,
                metadata_json={"fixture": "branch"},
            )
            db.commit()
            private_branch = db.exec(
                select(AgentKnowledgeBranch).where(
                    AgentKnowledgeBranch.tenant_id == "tenant_demo",
                    AgentKnowledgeBranch.agent_id == agent_id,
                    AgentKnowledgeBranch.knowledge_base_id == state["base_id"],
                )
            ).one()
            private_versions = list_knowledge_base_versions(
                state["base_id"], "tenant_demo", agent_id, db
            )
            private_projection = _branch_projection(private_branch)
            rollback_version = private_branch.base_version
            promoted = promote_knowledge_branch_to_overall(
                db, "tenant_demo", agent_id, state["base_id"]
            )
            db.commit()
            promoted_branch = db.exec(
                select(AgentKnowledgeBranch).where(
                    AgentKnowledgeBranch.tenant_id == "tenant_demo",
                    AgentKnowledgeBranch.agent_id == agent_id,
                    AgentKnowledgeBranch.knowledge_base_id == state["base_id"],
                )
            ).one()
            promoted_versions = list_knowledge_base_versions(
                state["base_id"], "tenant_demo", agent_id, db
            )
            promoted_projection = _branch_projection(promoted_branch)
            rolled_back = rollback_knowledge_branch(
                db,
                "tenant_demo",
                agent_id,
                state["base_id"],
                rollback_version,
            )
            db.commit()
            rolled_versions = list_knowledge_base_versions(
                state["base_id"], "tenant_demo", agent_id, db
            )
            print(json.dumps({
                "initial": _branch_projection(branch),
                "initial_versions": _version_projection(initial_versions),
                "private_version": private_version.version,
                "private": private_projection,
                "private_versions": _version_projection(private_versions),
                "promoted_version": promoted.version,
                "promoted": promoted_projection,
                "promoted_versions": _version_projection(promoted_versions),
                "rolled_back": _branch_projection(rolled_back),
                "rolled_versions": _version_projection(rolled_versions),
            }, ensure_ascii=False))
            return
        if phase == "okf":
            from app.api.knowledge_bases import (
                export_okf,
                get_okf_concept,
                lint_okf,
                list_okf_concepts,
                upsert_okf_concept,
            )

            generated = list_okf_concepts(state["base_id"], "tenant_demo", None, None, db)
            if not generated:
                raise AssertionError("native owner did not generate OKF concepts from the imported document")
            generated_ids = [row.concept_id for row in generated]
            source = get_okf_concept(
                state["base_id"], generated_ids[0], "tenant_demo", None, db
            )
            custom_id = "rules/release-approval"
            custom_content = (
                "---\n"
                "type: Business Rule\n"
                "title: Release approval\n"
                "description: A release requires approval.\n"
                "---\n"
                "Release approval is required before production deployment.\n"
            )
            parsed = parse_okf_markdown(custom_id, custom_content)
            updated = upsert_okf_concept(
                state["base_id"],
                custom_id,
                KnowledgeConceptUpdateRequest(
                    tenant_id="tenant_demo",
                    content_md=custom_content,
                    status="active",
                ),
                None,
                db,
                actor,
            )
            lint = lint_okf(state["base_id"], "tenant_demo", None, db)
            archive = export_okf(state["base_id"], "tenant_demo", None, db)
            archive_names = sorted(ZipFile(BytesIO(archive.body)).namelist())
            print(json.dumps({
                "generated_ids": generated_ids,
                "first": {
                    "concept_id": source.concept_id,
                    "type": source.concept_type,
                    "title": source.title,
                    "content": _normalize_okf_content(source.content_md),
                },
                "upsert": {
                    "concept_id": updated.concept_id,
                    "type": updated.concept_type,
                    "title": updated.title,
                    "content": _normalize_okf_content(updated.content_md),
                    "parsed_title": parsed.frontmatter.get("title"),
                },
                "lint": {
                    "status": lint.get("status"),
                    "issue_count": lint.get("issue_count"),
                    "issue_codes": [item.get("code") for item in lint.get("issues", [])],
                },
                "export": {"media_type": archive.media_type, "entries": archive_names},
            }, ensure_ascii=False))
            return
        if phase == "surface":
            base = get_knowledge_base(state["base_id"], "tenant_demo", None, db)
            updated_base = update_knowledge_base(
                state["base_id"],
                KnowledgeBaseUpdateRequest(
                    tenant_id="tenant_demo",
                    description="Updated through the native public owner surface",
                ),
                None,
                db,
                actor,
            )
            versions = list_knowledge_base_versions(state["base_id"], "tenant_demo", None, db)
            documents = list_documents("tenant_demo", state["base_id"], None, False, db)
            if not documents:
                raise AssertionError("surface phase cannot find the imported document")
            document = get_document(documents[0].id, "tenant_demo", None, db)
            buckets = get_document_buckets(document.id, "tenant_demo", None, db)
            if not buckets:
                raise AssertionError("surface phase cannot find a generated bucket")
            bucket = update_bucket(
                buckets[0].id,
                KnowledgeBucketUpdateRequest(
                    tenant_id="tenant_demo",
                    title="Updated approval bucket",
                    summary="Updated by public owner surface",
                ),
                db,
                actor,
            )
            chunks = get_bucket_chunks(bucket.id, "tenant_demo", None, db)
            if not chunks:
                raise AssertionError("surface phase cannot find a generated chunk")
            chunk = update_chunk(
                chunks[0].id,
                KnowledgeChunkUpdateRequest(
                    tenant_id="tenant_demo",
                    summary="Updated by public owner surface",
                ),
                db,
                actor,
            )
            jobs = list_jobs("tenant_demo", None, None, 16, db)
            queued = KnowledgeService(db).create_ingest_job(IngestPayload(
                tenant_id="tenant_demo",
                knowledge_base_id=state["base_id"],
                filename="surface-cancelled.md",
                content_base64=base64.b64encode(b"cancel through public owner entry").decode(),
                title="Surface cancellation fixture",
            ))
            cancelled = cancel_job(queued.id, "tenant_demo", db, actor)

            disposable = create_knowledge_base(
                KnowledgeBaseCreateRequest(
                    tenant_id="tenant_demo",
                    name="Disposable public owner surface base",
                ),
                None,
                db,
                actor,
            )
            imported_okf = import_okf_bundle(
                KnowledgeOkfImportRequest(
                    tenant_id="tenant_demo",
                    knowledge_base_id=disposable.id,
                    filename="surface-okf.zip",
                    content_base64=base64.b64encode(
                        export_okf(state["base_id"], "tenant_demo", None, db).body
                    ).decode(),
                ),
                db,
                actor,
            )

            confirmed_suggestion = KnowledgeDiscoverySuggestion(
                tenant_id="tenant_demo",
                knowledge_base_id=state["base_id"],
                document_id=document.id,
                suggestion_type="warning",
                title="Confirm public owner discovery",
            )
            rejected_suggestion = KnowledgeDiscoverySuggestion(
                tenant_id="tenant_demo",
                knowledge_base_id=state["base_id"],
                document_id=document.id,
                suggestion_type="warning",
                title="Reject public owner discovery",
            )
            db.add(confirmed_suggestion)
            db.add(rejected_suggestion)
            db.commit()
            discoveries = list_discoveries("tenant_demo", state["base_id"], "pending", None, db)
            confirmed = confirm_discovery(confirmed_suggestion.id, "tenant_demo", db, actor)
            rejected = reject_discovery(rejected_suggestion.id, "tenant_demo", db, actor)

            deleted = delete_knowledge_base(disposable.id, "tenant_demo", None, db, actor)
            print(json.dumps({
                "base": {"name": base.name, "status": base.status},
                "updated_base": {"description": updated_base.description, "status": updated_base.status},
                "versions": [row.get("version") for row in versions],
                "document": {"filename": document.filename, "status": document.status},
                "bucket": {"title": bucket.title, "summary": bucket.summary, "chunk_count": bucket.chunk_count},
                "chunk": {"content": chunk.content, "summary": chunk.summary, "index": chunk.chunk_index},
                "jobs": [{"status": row.status, "stage": row.stage} for row in jobs],
                "cancelled": {"status": cancelled.status, "stage": cancelled.stage},
                "import_okf": {"status": imported_okf.get("status"), "concept_count": imported_okf.get("concept_count")},
                "discoveries": len(discoveries),
                "confirmed": confirmed.get("status"),
                "rejected": rejected.get("status"),
                "deleted": deleted.get("status"),
            }, ensure_ascii=False))
            return
        if phase == "race":
            agent_id = "agent_tenant_demo_race"
            agent = db.get(AgentProfile, agent_id)
            if agent is None:
                agent = AgentProfile(
                    id=agent_id,
                    tenant_id="tenant_demo",
                    name="Race fixture agent",
                    description="B0/C concurrent branch fixture",
                    is_overall=False,
                    status="active",
                )
                db.add(agent)
                db.commit()
            ensure_agent_private_knowledge_branch(
                db, "tenant_demo", agent_id, db.get(KnowledgeBase, state["base_id"])
            )
            db.commit()
            barrier = Barrier(2)

            def create_version(_worker_number: int) -> dict[str, Any]:
                # Keep the two owner operations aligned at the same logical
                # read point while each uses an independent SQLAlchemy session.
                with Session(engine) as worker_db:
                    worker_db.info["race_barrier"] = barrier
                    worker_agent = worker_db.get(AgentProfile, agent_id)
                    worker_kb = worker_db.get(KnowledgeBase, state["base_id"])
                    worker_db.expire_all()
                    barrier.wait(timeout=10)
                    try:
                        version = knowledge_version_for_upload(
                            worker_db,
                            "tenant_demo",
                            state["base_id"],
                            agent_id,
                            metadata_json={"race_worker": _worker_number},
                        )
                        worker_db.commit()
                        return {"status": "committed", "version": version.version}
                    except Exception as error:  # noqa: BLE001 - projection records owner race outcome.
                        worker_db.rollback()
                        return {"status": "error", "type": type(error).__name__}

            with ThreadPoolExecutor(max_workers=2) as executor:
                race_results = list(executor.map(create_version, [1, 2]))
            final_branch = db.exec(
                select(AgentKnowledgeBranch).where(
                    AgentKnowledgeBranch.tenant_id == "tenant_demo",
                    AgentKnowledgeBranch.agent_id == agent_id,
                    AgentKnowledgeBranch.knowledge_base_id == state["base_id"],
                )
            ).one()
            db.refresh(final_branch)
            print(json.dumps({
                "workers": sorted(race_results, key=lambda item: (item["status"], item.get("version", ""))),
                "final": _branch_projection(final_branch),
            }, ensure_ascii=False))
            return
        query = search_knowledge(
            KnowledgeSearchRequest(
                tenant_id="tenant_demo",
                knowledge_base_ids=[state["base_id"]],
                query="security review audit citation",
                max_chunks=8,
                max_buckets=4,
                budget_tokens=4000,
                need_evidence_pack=True,
            ),
            db,
            actor,
        )
        citation = db.get(KnowledgeChunk, state["citation_id"])
        if citation is None:
            raise AssertionError("original citation is not resolvable after fresh owner process")
        if phase == "management":
            documents = list_documents("tenant_demo", state["base_id"], None, False, db)
            if not documents:
                raise AssertionError("created document is not visible in management phase")
            document = documents[0]
            conflict_status = None
            try:
                update_document(
                    document.id,
                    KnowledgeDocumentUpdateRequest(
                        tenant_id="tenant_demo",
                        title="stale update",
                        expected_updated_at="2000-01-01T00:00:00",
                    ),
                    db,
                    actor,
                    None,
                )
            except HTTPException as error:
                conflict_status = error.status_code
            updated = update_document(
                document.id,
                KnowledgeDocumentUpdateRequest(
                    tenant_id="tenant_demo",
                    title="Updated approval policy",
                    expected_updated_at=str(document.updated_at),
                ),
                db,
                actor,
                None,
            )
            archived = update_document(
                document.id,
                KnowledgeDocumentUpdateRequest(
                    tenant_id="tenant_demo",
                    status="archived",
                    expected_updated_at=str(updated.updated_at),
                ),
                db,
                actor,
                None,
            )

            if db.get(Tenant, "tenant_other") is None:
                db.add(Tenant(id="tenant_other", name="Other tenant"))
                db.add(User(
                    id="admin_other",
                    tenant_id="tenant_other",
                    username="admin",
                    display_name="Other admin",
                    role="admin",
                    password_hash="test-only",
                ))
                db.commit()
            other_bases = list_knowledge_bases("tenant_other", None, db)
            wrong_tenant_status = None
            try:
                get_job(state["job_id"], "tenant_other", None, db)
            except HTTPException as error:
                wrong_tenant_status = error.status_code

            service = KnowledgeService(db)
            queued = service.create_ingest_job(IngestPayload(
                tenant_id="tenant_demo",
                knowledge_base_id=state["base_id"],
                filename="cancelled.md",
                content_base64=base64.b64encode(b"secret queued body").decode(),
                title="Cancelled fixture",
            ))
            cancelled = service.cancel_ingest_job(queued.id, "tenant_demo")
            if cancelled is None:
                raise AssertionError("queued Knowledge job cancellation returned no job")
            print(json.dumps({
                "conflict_status": conflict_status,
                "updated": {"title": updated.title, "status": updated.status},
                "archived": {"title": archived.title, "status": archived.status},
                "other_tenant_base_count": len(other_bases),
                "wrong_tenant_job_status": wrong_tenant_status,
                "cancelled": {
                    "status": cancelled.status,
                    "stage": cancelled.stage,
                    "content_cleared": "content_base64" not in (cancelled.metadata_json or {}),
                },
            }, ensure_ascii=False))
            return
        print(
            json.dumps(
                {
                    "base_present": True,
                    "query": _query_projection(query),
                    "citation": _citation_projection(citation),
                },
                ensure_ascii=False,
            )
        )


def _wait_for_job(db, job_id: str, get_job_function):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        row = get_job_function(job_id, "tenant_demo", None, db)
        if row.status in {"succeeded", "failed", "cancelled"}:
            if row.status != "succeeded":
                raise AssertionError(f"Knowledge job failed: {row.model_dump(mode='json')}")
            return row
        time.sleep(0.2)
    raise TimeoutError(f"Knowledge job did not finish: {job_id}")


def _job_projection(row) -> dict[str, Any]:
    return {"status": row.status, "stage": row.stage, "progress": row.progress, "error": row.error}


def _document_projection(rows) -> list[dict[str, Any]]:
    return [
        {
            "filename": row.filename,
            "status": row.status,
            "bucket_count": row.bucket_count,
            "chunk_count": row.chunk_count,
        }
        for row in rows
    ]


def _query_projection(row) -> dict[str, Any]:
    return {
        "evidence": [
            {
                "content": item.get("content"),
                "excerpt": item.get("excerpt"),
                "source_path": item.get("source_path"),
                "relevance_score": item.get("relevance_score"),
            }
            for item in row.evidence_pack
        ],
        "selected_documents": [
            {"filename": item.get("filename"), "title": item.get("title")}
            for item in row.selected_documents
        ],
        "route_phases": [item.get("phase") for item in row.route_trace],
    }


def _citation_projection(row) -> dict[str, Any]:
    return {
        "content": row.content,
        "summary": row.summary,
        "source_ref": row.source_ref,
        "chunk_index": row.chunk_index,
    }


def _normalize_okf_content(value: str) -> str:
    """Normalize generated resource IDs and timestamps, but retain OKF semantics."""
    value = re.sub(r"kdoc_[0-9a-f]+", "kdoc_<generated>", value)
    return re.sub(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?', "<generated-time>", value)


def _branch_projection(row) -> dict[str, Any]:
    return {
        "base_version": row.base_version,
        "head_version": row.head_version,
        "status": row.status,
        "sync_state": row.sync_state,
    }


def _version_projection(rows) -> list[dict[str, Any]]:
    return [
        {
            "version": row.get("version"),
            "status": row.get("status"),
            "is_head": row.get("is_head"),
            "is_base": row.get("is_base"),
        }
        for row in rows
    ]


if __name__ == "__main__":
    main()
