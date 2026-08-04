from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    assert_internal_control_path,
    assert_valid_docx,
    file_sha256,
    load_json,
    pilotdeck_work_dir,
    pilotdeck_workspace_root,
    prepare_json_artifact_path,
    require_docx_path,
    write_json,
)
from .preflight import _visual_review_result, preflight_docx
from .protocol import (
    BUILTIN_TEMPLATE_ID,
    normalize_delivery_policy,
    normalize_document_policy,
    normalize_document_structure,
    normalize_style_policy,
)


VISUAL_REVIEW_PROTOCOL = "pilotdeck-docx-visual-review/v2"


def _require_turn_work_dir() -> Path:
    work_dir = pilotdeck_work_dir()
    if work_dir is None:
        raise DocxSkillError(
            "PILOTDECK_WORK_DIR is required for deterministic DOCX task setup",
            code="work-dir-unavailable",
            details={
                "next": (
                    "Set PILOTDECK_WORK_DIR to the current turn work directory. "
                    "Do not guess or search for another task's work directory."
                )
            },
        )
    work_dir.mkdir(parents=True, exist_ok=True)
    return work_dir


def docx_task_paths() -> dict[str, Path]:
    root = _require_turn_work_dir() / "docx"
    tmp = root / "tmp"
    qa = root / "qa"
    tmp.mkdir(parents=True, exist_ok=True)
    qa.mkdir(parents=True, exist_ok=True)
    return {
        "root": root,
        "tmp": tmp,
        "qa": qa,
        "candidate": tmp / "candidate.docx",
        "acceptance": qa / "acceptance.json",
        "initial_render": qa / "render-initial",
        "initial_report": qa / "preflight-initial.json",
        "visual_review": qa / "visual-review.json",
        "final_render": qa / "render-final",
        "final_report": qa / "preflight-final.json",
    }


def _parse_heading(value: str) -> dict[str, Any]:
    text = value.strip()
    if not text:
        raise DocxSkillError(
            "Required headings must not be empty",
            code="invalid-acceptance-manifest",
        )
    prefix, separator, remainder = text.partition(":")
    if separator and prefix.isdigit():
        level = int(prefix)
        if level < 1 or level > 9 or not remainder.strip():
            raise DocxSkillError(
                "Heading syntax is LEVEL:TEXT with LEVEL from 1 to 9",
                code="invalid-acceptance-manifest",
            )
        return {"text": remainder.strip(), "level": level}
    return {"text": text}


def prepare_docx_task(
    *,
    required_text: list[str] | None = None,
    required_headings: list[str] | None = None,
    min_pages: int | None = None,
    max_pages: int | None = None,
    min_images: int | None = None,
    require_toc: bool = False,
    document_structure: str = "simple",
    protected_sources: list[str] | None = None,
    style_mode: str = "builtin",
    style_source: str | None = None,
    style_requirements: list[str] | None = None,
    existing_document: bool = False,
    allow_header: bool = False,
    allow_footer: bool = False,
    allow_page_numbers: bool = False,
    external_output: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    if min_pages is not None and min_pages < 1:
        raise DocxSkillError(
            "min_pages must be positive",
            code="invalid-acceptance-manifest",
        )
    if max_pages is not None and max_pages < 1:
        raise DocxSkillError(
            "max_pages must be positive",
            code="invalid-acceptance-manifest",
        )
    if min_pages and max_pages and min_pages > max_pages:
        raise DocxSkillError(
            "min_pages cannot exceed max_pages",
            code="invalid-acceptance-manifest",
        )
    if min_images is not None and min_images < 0:
        raise DocxSkillError(
            "min_images must be non-negative",
            code="invalid-acceptance-manifest",
        )

    paths = docx_task_paths()
    acceptance_path = prepare_json_artifact_path(
        paths["acceptance"],
        purpose="Acceptance manifest",
    )
    if acceptance_path.exists() and not overwrite:
        raise DocxSkillError(
            "The acceptance manifest already exists and is frozen",
            status="blocked",
            code="acceptance-manifest-frozen",
            details={
                "acceptance": str(acceptance_path),
                "next": (
                    "Reuse the existing manifest. Pass --overwrite only when the "
                    "current user request changed the acceptance requirements."
                ),
            },
        )

    raw_style_policy: dict[str, Any] = {"mode": style_mode}
    if style_mode == "builtin":
        raw_style_policy["template"] = BUILTIN_TEMPLATE_ID
    else:
        if style_source is not None:
            raw_style_policy["source"] = style_source
        requirements = [
            value.strip()
            for value in (style_requirements or [])
            if isinstance(value, str) and value.strip()
        ]
        if requirements:
            raw_style_policy["requirements"] = list(dict.fromkeys(requirements))
    style_policy = normalize_style_policy(
        raw_style_policy,
        default_builtin=False,
    )
    if style_policy is None:
        raise DocxSkillError(
            "A style policy is required",
            code="invalid-style-policy",
        )

    document_policy = normalize_document_policy(
        {
            "origin": "existing" if existing_document else "new",
            "allow_header": allow_header,
            "allow_footer": allow_footer,
            "allow_page_numbers": allow_page_numbers,
        }
    )
    structure_policy = normalize_document_structure(
        {"archetype": document_structure}
    )
    workspace_root = pilotdeck_workspace_root()
    raw_delivery: dict[str, Any] = {
        "workspace_root": str(workspace_root),
        "scope": "workspace",
    }
    if external_output is not None:
        external = Path(external_output).expanduser()
        if not external.is_absolute():
            raise DocxSkillError(
                "--external-output must be the exact absolute .docx path "
                "explicitly supplied by the user",
                code="invalid-delivery-policy",
            )
        resolved_external = external.resolve()
        if resolved_external.suffix.lower() != ".docx":
            raise DocxSkillError(
                "--external-output must end in .docx",
                code="invalid-delivery-policy",
            )
        try:
            resolved_external.relative_to(workspace_root)
        except ValueError:
            raw_delivery = {
                "workspace_root": str(workspace_root),
                "scope": "exact-external",
                "path": str(resolved_external),
            }
    delivery_policy = normalize_delivery_policy(raw_delivery)

    manifest: dict[str, Any] = {
        "style_policy": style_policy,
        "document_policy": document_policy,
        "document_structure": structure_policy,
        "delivery": delivery_policy,
    }
    text_requirements = list(
        dict.fromkeys(
            value.strip()
            for value in (required_text or [])
            if isinstance(value, str) and value.strip()
        )
    )
    if text_requirements:
        manifest["required_text"] = text_requirements

    heading_requirements = [
        _parse_heading(value) for value in (required_headings or [])
    ]
    if heading_requirements:
        manifest["required_headings"] = heading_requirements

    if min_pages is not None or max_pages is not None:
        page_count: dict[str, int] = {}
        if min_pages is not None:
            page_count["min"] = min_pages
        if max_pages is not None:
            page_count["max"] = max_pages
        manifest["page_count"] = page_count

    if require_toc or structure_policy["archetype"] == "formal-report":
        manifest["toc"] = {"required": True, "populated": True}
    if min_images is not None:
        manifest["images"] = {"min": min_images}

    source_requirements: list[dict[str, str]] = []
    for value in protected_sources or []:
        source = Path(value).expanduser().resolve()
        if not source.is_file():
            raise DocxSkillError(
                f"Protected source not found: {source}",
                code="protected-source-not-found",
            )
        source_requirements.append(
            {"path": str(source), "sha256": file_sha256(source)}
        )
    if source_requirements:
        manifest["protected_sources"] = source_requirements

    write_json(acceptance_path, manifest)
    return {
        "status": "ok",
        "protocol": "pilotdeck-docx-task/v2",
        "acceptance_frozen": True,
        "paths": {name: str(path) for name, path in paths.items()},
        "acceptance": manifest,
        "next": (
            "Write specifications, helper scripts, candidates, and QA output only "
            "under these paths. Build the candidate, then run qa-init."
        ),
    }


def initialize_visual_qa(
    input_path: str | Path,
    *,
    acceptance_path: str | Path | None = None,
    output_dir: str | Path | None = None,
    report_path: str | Path | None = None,
    review_path: str | Path | None = None,
    profile: str = "final",
    dispositions_path: str | Path | None = None,
    dispositions: dict[str, str] | None = None,
    timeout_seconds: int = 120,
    overwrite: bool = False,
) -> dict[str, Any]:
    candidate = require_docx_path(input_path)
    paths = docx_task_paths()
    acceptance = acceptance_path or paths["acceptance"]
    render_dir = (
        Path(output_dir).expanduser().resolve()
        if output_dir
        else paths["initial_render"]
    )
    report = report_path or paths["initial_report"]
    review = prepare_json_artifact_path(
        review_path or paths["visual_review"],
        protected_paths=(candidate, acceptance, report),
        purpose="Visual review",
    )
    if review.exists() and not overwrite:
        raise DocxSkillError(
            "Visual review already exists",
            status="blocked",
            code="visual-review-exists",
            details={
                "visual_review": str(review),
                "next": (
                    "Reuse it for the unchanged candidate, or rerun qa-init with "
                    "--overwrite after the candidate changes."
                ),
            },
        )

    diagnostic = preflight_docx(
        candidate,
        render_dir,
        report_path=report,
        profile=profile,
        dispositions_path=dispositions_path,
        dispositions=dispositions,
        acceptance_path=acceptance,
        timeout_seconds=timeout_seconds,
    )
    page_evidence = diagnostic.get("render", {}).get("page_evidence", [])
    review_document = {
        "protocol": VISUAL_REVIEW_PROTOCOL,
        "artifact_sha256": diagnostic["artifact"]["sha256"],
        "status": "pending",
        "pages": [
            {
                "page": item["page"],
                "image_sha256": item["image_sha256"],
                "status": "pending",
                "notes": "",
            }
            for item in page_evidence
        ],
    }
    write_json(review, review_document)

    unresolved = diagnostic.get("unresolved", {})
    return {
        "status": "ok",
        "protocol": VISUAL_REVIEW_PROTOCOL,
        "candidate": str(candidate),
        "candidate_sha256": diagnostic["artifact"]["sha256"],
        "acceptance": str(Path(acceptance).expanduser().resolve()),
        "automated_gate": {
            "status": (
                "passed"
                if not unresolved.get("errors")
                and int(unresolved.get("warnings", {}).get("total", 0)) == 0
                else "needs-attention"
            ),
            "preflight_status": diagnostic["status"],
            "coverage": diagnostic.get("coverage", {}).get("status"),
            "errors": unresolved.get("errors", []),
            "warnings": unresolved.get("warnings", {}),
        },
        "report": str(Path(report).expanduser().resolve()),
        "visual_review": str(review),
        "pages": page_evidence,
        "next": (
            "Open every listed page image. Immediately record that page with "
            "qa-record; never calculate or replace image_sha256 manually."
        ),
    }


def record_visual_review(
    review_path: str | Path,
    *,
    page: int,
    status: str,
    notes: str,
) -> dict[str, Any]:
    review_file = assert_internal_control_path(
        review_path,
        purpose="Visual review",
    )
    review = load_json(review_file)
    if not isinstance(review, dict) or review.get("protocol") != VISUAL_REVIEW_PROTOCOL:
        raise DocxSkillError(
            "qa-record requires a visual review created by qa-init",
            code="invalid-visual-review",
        )
    if status not in {"passed", "failed"}:
        raise DocxSkillError(
            "qa-record status must be passed or failed",
            code="invalid-visual-review",
        )
    if page < 1 or not notes.strip():
        raise DocxSkillError(
            "qa-record requires a positive page number and page-specific notes",
            code="invalid-visual-review",
        )
    pages = review.get("pages")
    if not isinstance(pages, list):
        raise DocxSkillError(
            "Visual review pages must be an array",
            code="invalid-visual-review",
        )
    matching = [
        item
        for item in pages
        if isinstance(item, dict) and item.get("page") == page
    ]
    if len(matching) != 1:
        raise DocxSkillError(
            f"Visual review page {page} was not initialized exactly once",
            code="invalid-visual-review",
        )
    item = matching[0]
    item["status"] = status
    item["notes"] = notes.strip()
    item["reviewed_at"] = datetime.now(timezone.utc).isoformat()
    item["recorded_via"] = "docx.qa-record/v1"

    page_statuses = [
        value.get("status") if isinstance(value, dict) else None for value in pages
    ]
    pending_pages = [
        value.get("page")
        for value in pages
        if isinstance(value, dict) and value.get("status") == "pending"
    ]
    if pending_pages:
        review["status"] = "pending"
    elif any(value == "failed" for value in page_statuses):
        review["status"] = "failed"
    else:
        review["status"] = "passed"
    write_json(review_file, review)
    return {
        "status": "ok",
        "visual_review": str(review_file),
        "recorded_page": page,
        "page_status": status,
        "review_status": review["status"],
        "pending_pages": pending_pages,
    }


def finalize_visual_qa(
    input_path: str | Path,
    *,
    acceptance_path: str | Path | None = None,
    initial_report_path: str | Path | None = None,
    report_path: str | Path | None = None,
    review_path: str | Path | None = None,
) -> dict[str, Any]:
    paths = docx_task_paths()
    candidate = require_docx_path(input_path)
    acceptance = assert_internal_control_path(
        acceptance_path or paths["acceptance"],
        purpose="Acceptance manifest",
    )
    initial_report_file = assert_internal_control_path(
        initial_report_path or paths["initial_report"],
        purpose="Initial preflight report",
    )
    review = review_path or paths["visual_review"]
    final_report = prepare_json_artifact_path(
        report_path or paths["final_report"],
        protected_paths=(candidate, acceptance, initial_report_file, review),
        purpose="Final preflight report",
    )
    initial = load_json(initial_report_file)
    if not isinstance(initial, dict):
        raise DocxSkillError(
            "Initial preflight report must be a JSON object",
            code="invalid-preflight-report",
        )
    if (
        not isinstance(initial.get("artifact"), dict)
        or not isinstance(initial.get("acceptance"), dict)
        or not isinstance(initial.get("coverage"), dict)
        or not isinstance(initial.get("checks"), dict)
        or not isinstance(initial.get("unresolved"), dict)
        or not isinstance(initial.get("unresolved", {}).get("errors"), list)
        or not isinstance(initial.get("unresolved", {}).get("warnings"), list)
        or not isinstance(initial.get("gate_issues"), list)
    ):
        raise DocxSkillError(
            "Initial preflight report is incomplete or compacted",
            code="invalid-preflight-report",
        )

    result = deepcopy(initial)
    integrity_issues: list[dict[str, Any]] = []
    validation = assert_valid_docx(candidate)
    candidate_sha256 = file_sha256(candidate)
    expected_candidate_sha256 = (
        initial.get("artifact", {}).get("sha256")
        if isinstance(initial.get("artifact"), dict)
        else None
    )
    if expected_candidate_sha256 != candidate_sha256:
        integrity_issues.append(
            {
                "severity": "error",
                "code": "qa-candidate-changed",
                "message": (
                    "The DOCX candidate changed after qa-init; initialize and "
                    "inspect the new render again."
                ),
                "expected_sha256": expected_candidate_sha256,
                "actual_sha256": candidate_sha256,
                "resolved": False,
            }
        )

    expected_acceptance_sha256 = (
        initial.get("acceptance", {}).get("sha256")
        if isinstance(initial.get("acceptance"), dict)
        else None
    )
    actual_acceptance_sha256 = file_sha256(acceptance)
    if expected_acceptance_sha256 != actual_acceptance_sha256:
        integrity_issues.append(
            {
                "severity": "error",
                "code": "qa-acceptance-changed",
                "message": (
                    "The frozen acceptance manifest changed after qa-init; "
                    "rerun qa-init before visual review."
                ),
                "expected_sha256": expected_acceptance_sha256,
                "actual_sha256": actual_acceptance_sha256,
                "resolved": False,
            }
        )

    render = initial.get("render")
    if not isinstance(render, dict):
        raise DocxSkillError(
            "Initial preflight report has no render evidence",
            code="invalid-preflight-report",
        )
    rendered_images = render.get("images")
    rendered_pages = render.get("pages")
    if (
        not isinstance(rendered_images, list)
        or not all(isinstance(value, str) for value in rendered_images)
        or not isinstance(rendered_pages, int)
        or rendered_pages < 1
    ):
        raise DocxSkillError(
            "Initial preflight report has invalid render evidence",
            code="invalid-preflight-report",
        )
    for image in rendered_images:
        image_path = assert_internal_control_path(
            image,
            purpose="DOCX rendered page evidence",
        )
        if not image_path.is_file():
            raise DocxSkillError(
                f"Rendered page evidence is missing: {image_path}",
                code="render-evidence-missing",
            )

    visual_result, visual_issues = _visual_review_result(
        review,
        rendered_pages=rendered_pages,
        rendered_images=rendered_images,
        artifact_sha256=candidate_sha256,
        legacy_status="not-reviewed",
    )
    for item in visual_issues:
        item["resolved"] = False

    acceptance_requirements = (
        initial.get("acceptance", {}).get("requirements", {})
        if isinstance(initial.get("acceptance"), dict)
        else {}
    )
    protected_source_checks: list[dict[str, Any]] = []
    for source in acceptance_requirements.get("protected_sources", []):
        source_path = Path(source["path"])
        actual = file_sha256(source_path) if source_path.is_file() else None
        unchanged = actual == source["sha256"]
        protected_source_checks.append(
            {
                "path": str(source_path),
                "expected_sha256": source["sha256"],
                "actual_sha256": actual,
                "unchanged": unchanged,
            }
        )
        if not unchanged:
            integrity_issues.append(
                {
                    "severity": "error",
                    "code": "protected-source-changed",
                    "message": "A protected source file is missing or changed.",
                    "path": str(source_path),
                    "resolved": False,
                }
            )

    initial_unresolved = initial.get("unresolved", {})
    unresolved_errors = list(initial_unresolved.get("errors", []))
    unresolved_warnings = list(initial_unresolved.get("warnings", []))
    unresolved_errors.extend(integrity_issues)
    unresolved_errors.extend(visual_issues)
    passed = (
        not unresolved_errors
        and not unresolved_warnings
        and visual_result["status"] == "passed"
    )

    result["status"] = "ok" if passed else "partial"
    result["passed"] = passed
    result["input"] = str(candidate)
    result["validation"] = validation
    result["visual_review"] = visual_result
    result.setdefault("checks", {})["visual_review"] = visual_result["status"]
    result["gate_issues"] = [
        *list(initial.get("gate_issues", [])),
        *integrity_issues,
        *visual_issues,
    ]
    result["unresolved"] = {
        "errors": unresolved_errors,
        "warnings": unresolved_warnings,
    }
    result["artifact"] = {
        "sha256": candidate_sha256,
        "bytes": candidate.stat().st_size,
    }
    result["acceptance"]["manifest"] = str(acceptance)
    result["acceptance"]["sha256"] = actual_acceptance_sha256
    if protected_source_checks:
        result["coverage"]["protected_sources"] = protected_source_checks
    if any(
        item.get("code") == "protected-source-changed"
        for item in unresolved_errors
    ):
        result["coverage"]["status"] = "failed"
    write_json(final_report, result)

    compact = deepcopy(result)
    compact["unresolved"]["warnings"] = {
        "total": len(unresolved_warnings),
        "items": unresolved_warnings[:8],
        "truncated": len(unresolved_warnings) > 8,
    }
    compact["report"] = str(final_report)
    return compact
