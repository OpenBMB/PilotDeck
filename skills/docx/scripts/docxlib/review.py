from __future__ import annotations

from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    assert_internal_control_path,
    file_sha256,
    prepare_json_artifact_path,
    require_docx_path,
    write_json,
)
from .core import inspect_docx
from .render import render_docx


def review_candidate(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    report_path: str | Path | None = None,
    dpi: int = 150,
    timeout_seconds: int = 180,
) -> dict[str, Any]:
    candidate = require_docx_path(input_path)
    digest = file_sha256(candidate)
    root = assert_internal_control_path(output_dir, purpose="DOCX review directory")
    revision_dir = root / digest[:16]
    revision_dir.mkdir(parents=True, exist_ok=True)
    report = prepare_json_artifact_path(
        report_path or revision_dir / "report.json",
        protected_paths=(candidate,),
        purpose="DOCX review report",
    )

    inspection = inspect_docx(candidate)
    validation = inspection["validation"]
    try:
        render = render_docx(
            candidate,
            revision_dir,
            dpi=dpi,
            timeout_seconds=timeout_seconds,
        )
        status = "review_pending"
        evidence_status = "ready"
        render_error = None
    except DocxSkillError as exc:
        if exc.status != "unsupported":
            raise
        render = {
            "status": "unsupported",
            "images": [],
            "pages": None,
            "page_text": [],
        }
        status = "evidence_unavailable"
        evidence_status = "unavailable"
        render_error = {
            "code": exc.code,
            "message": str(exc),
            "details": exc.details,
        }

    page_records = []
    image_paths = render.get("images", [])
    text_records = render.get("page_text", [])
    for page_number, image_path in enumerate(image_paths, start=1):
        text_record = text_records[page_number - 1] if page_number <= len(text_records) else {}
        page_records.append(
            {
                "page": page_number,
                "image": image_path,
                "text_characters": text_record.get("characters"),
            }
        )
    result: dict[str, Any] = {
        "status": status,
        "message": (
            "Open the relevant full-size page images before making visual claims. "
            "This report describes evidence; it does not declare the document visually passed."
            if evidence_status == "ready"
            else "Structural evidence is available, but page images could not be produced."
        ),
        "input": str(candidate),
        "revision": digest,
        "review_dir": str(revision_dir),
        "report": str(report),
        "visual_evidence": {
            "status": evidence_status,
            "pages": page_records,
            "error": render_error,
        },
        "structure": {
            "paragraphs": inspection.get("paragraph_count"),
            "headings": inspection.get("headings", []),
            "tables": inspection.get("table_count"),
            "sections": inspection.get("sections", []),
            "images": inspection.get("image_parts", 0),
            "fields": inspection.get("fields", []),
            "comments": inspection.get("comments", []),
            "tracked_changes": inspection.get("tracked_changes", {}),
            "external_relationships": inspection.get("external_relationships", []),
            "package_features": inspection.get("package_features", {}),
            "inspection_coverage": inspection.get("inspection_coverage", {}),
        },
        "validation": validation,
    }
    write_json(report, result)
    return result
