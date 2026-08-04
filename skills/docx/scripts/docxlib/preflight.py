from __future__ import annotations

import json
import hashlib
import re
from pathlib import Path
from typing import Any

from PIL import Image
from docx import Document
from docx.oxml.ns import qn

from .audit import audit_docx
from .common import (
    DocxSkillError,
    assert_internal_control_path,
    assert_valid_docx,
    file_sha256,
    pilotdeck_workspace_root,
    prepare_json_artifact_path,
    write_json,
)
from .core import inspect_docx
from .protocol import (
    load_dispositions,
    normalize_delivery_policy,
    normalize_document_policy,
    normalize_document_structure,
    normalize_style_policy,
)
from .render import render_docx
from .toc import toc_status


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def _issue_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        code = str(item.get("code", "unknown"))
        counts[code] = counts.get(code, 0) + 1
    return dict(sorted(counts.items()))


def _compact_issues(
    items: list[dict[str, Any]],
    *,
    limit: int = 8,
) -> dict[str, Any]:
    return {
        "total": len(items),
        "by_code": _issue_counts(items),
        "items": items[:limit],
        "truncated": len(items) > limit,
    }


def _page_image_sha256(path: str | Path) -> str:
    """Hash decoded pixels rather than unstable PNG container metadata."""
    with Image.open(path) as image:
        normalized = image.convert("RGB")
        digest = hashlib.sha256()
        digest.update(f"{normalized.width}x{normalized.height}:RGB\0".encode())
        digest.update(normalized.tobytes())
        return digest.hexdigest()


def _load_json_object(
    path: str | Path | None,
    *,
    label: str,
) -> tuple[Path | None, dict[str, Any]]:
    if not path:
        return None, {}
    source = assert_internal_control_path(path, purpose=label)
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise DocxSkillError(
            f"{label} not found: {source}",
            code=f"{label.lower().replace(' ', '-')}-not-found",
        ) from exc
    except json.JSONDecodeError as exc:
        raise DocxSkillError(
            f"Invalid {label} JSON: {exc}",
            code=f"invalid-{label.lower().replace(' ', '-')}",
        ) from exc
    if not isinstance(value, dict):
        raise DocxSkillError(
            f"{label} must be a JSON object",
            code=f"invalid-{label.lower().replace(' ', '-')}",
        )
    return source, value


def _acceptance_requirements(
    acceptance: dict[str, Any],
) -> dict[str, Any]:
    allowed = {
        "style_policy",
        "document_policy",
        "document_structure",
        "delivery",
        "required_text",
        "required_headings",
        "page_count",
        "toc",
        "images",
        "protected_sources",
    }
    unknown = sorted(set(acceptance) - allowed)
    if unknown:
        raise DocxSkillError(
            f"Unknown acceptance field(s): {', '.join(unknown)}",
            code="invalid-acceptance-manifest",
            details={"unknown": unknown},
        )
    style_policy = normalize_style_policy(
        acceptance.get("style_policy"),
        default_builtin=False,
    )
    document_policy = normalize_document_policy(
        acceptance.get("document_policy")
    )
    document_structure = normalize_document_structure(
        acceptance.get("document_structure")
    )
    delivery_policy = normalize_delivery_policy(
        acceptance.get("delivery")
        or {
            "workspace_root": str(pilotdeck_workspace_root()),
            "scope": "workspace",
        }
    )
    required_text = acceptance.get("required_text", [])
    if not isinstance(required_text, list) or any(
        not isinstance(value, str) or not value.strip() for value in required_text
    ):
        raise DocxSkillError(
            "acceptance.required_text must be an array of non-empty strings",
            code="invalid-acceptance-manifest",
        )
    required_headings = acceptance.get("required_headings", [])
    if not isinstance(required_headings, list):
        raise DocxSkillError(
            "acceptance.required_headings must be an array",
            code="invalid-acceptance-manifest",
        )
    normalized_headings: list[dict[str, Any]] = []
    for item in required_headings:
        if isinstance(item, str):
            if not item.strip():
                raise DocxSkillError(
                    "acceptance.required_headings cannot contain empty text",
                    code="invalid-acceptance-manifest",
                )
            normalized_headings.append({"text": item.strip(), "level": None})
            continue
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("text"), str)
            or not item["text"].strip()
            or set(item) - {"text", "level"}
        ):
            raise DocxSkillError(
                "Each required heading must be a string or {text, optional level}",
                code="invalid-acceptance-manifest",
            )
        level = item.get("level")
        if level is not None and (
            not isinstance(level, int)
            or isinstance(level, bool)
            or level < 1
            or level > 9
        ):
            raise DocxSkillError(
                "required_headings.level must be an integer from 1 to 9",
                code="invalid-acceptance-manifest",
            )
        normalized_headings.append(
            {"text": item["text"].strip(), "level": level}
        )
    page_count = acceptance.get("page_count", {})
    if not isinstance(page_count, dict) or set(page_count) - {"min", "max"}:
        raise DocxSkillError(
            "acceptance.page_count may contain only min and max",
            code="invalid-acceptance-manifest",
        )
    for name, value in page_count.items():
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise DocxSkillError(
                f"acceptance.page_count.{name} must be a positive integer",
                code="invalid-acceptance-manifest",
            )
    if page_count.get("min") and page_count.get("max"):
        if page_count["min"] > page_count["max"]:
            raise DocxSkillError(
                "acceptance.page_count.min cannot exceed max",
                code="invalid-acceptance-manifest",
            )
    toc = acceptance.get("toc", {})
    if not isinstance(toc, dict) or set(toc) - {"required", "populated"}:
        raise DocxSkillError(
            "acceptance.toc may contain only required and populated",
            code="invalid-acceptance-manifest",
        )
    if any(not isinstance(value, bool) for value in toc.values()):
        raise DocxSkillError(
            "acceptance.toc values must be boolean",
            code="invalid-acceptance-manifest",
        )
    images = acceptance.get("images", {})
    if not isinstance(images, dict) or set(images) - {"min"}:
        raise DocxSkillError(
            "acceptance.images may contain only min",
            code="invalid-acceptance-manifest",
        )
    if "min" in images and (
        not isinstance(images["min"], int)
        or isinstance(images["min"], bool)
        or images["min"] < 0
    ):
        raise DocxSkillError(
            "acceptance.images.min must be a non-negative integer",
            code="invalid-acceptance-manifest",
        )
    protected_sources = acceptance.get("protected_sources", [])
    if not isinstance(protected_sources, list):
        raise DocxSkillError(
            "acceptance.protected_sources must be an array",
            code="invalid-acceptance-manifest",
        )
    normalized_sources: list[dict[str, str]] = []
    for item in protected_sources:
        if (
            not isinstance(item, dict)
            or set(item) != {"path", "sha256"}
            or not isinstance(item["path"], str)
            or not isinstance(item["sha256"], str)
            or not re.fullmatch(r"[0-9a-fA-F]{64}", item["sha256"])
        ):
            raise DocxSkillError(
                "Each protected source must contain path and a 64-character sha256",
                code="invalid-acceptance-manifest",
            )
        normalized_sources.append(
            {
                "path": str(Path(item["path"]).expanduser().resolve()),
                "sha256": item["sha256"].lower(),
            }
        )
    return {
        "style_policy": style_policy,
        "document_policy": document_policy,
        "document_structure": document_structure,
        "delivery": delivery_policy,
        "required_text": required_text,
        "required_headings": normalized_headings,
        "page_count": page_count,
        "toc": toc,
        "images": images,
        "protected_sources": normalized_sources,
    }


def _paragraph_has_page_break(paragraph: Any) -> bool:
    properties = paragraph._p.pPr
    if (
        properties is not None
        and properties.find(qn("w:pageBreakBefore")) is not None
    ):
        return True
    return any(
        (node.get(qn("w:type")) or "text") == "page"
        for node in paragraph._p.findall(".//w:br", paragraph._p.nsmap)
    )


def _paragraph_is_toc_field(paragraph: Any) -> bool:
    instructions = [
        str(node.text or "").strip()
        for node in paragraph._p.findall(".//w:instrText", paragraph._p.nsmap)
    ]
    return any(
        instruction.upper().split(maxsplit=1)[0] == "TOC"
        for instruction in instructions
        if instruction
    )


def _document_structure_gate_issues(
    acceptance: dict[str, Any],
    input_path: str | Path,
) -> list[dict[str, Any]]:
    structure = acceptance.get("document_structure", {})
    if structure.get("archetype") != "formal-report":
        return []
    doc = Document(str(input_path))
    paragraphs = doc.paragraphs
    issues: list[dict[str, Any]] = []
    toc_indexes = [
        index
        for index, paragraph in enumerate(paragraphs)
        if _paragraph_is_toc_field(paragraph)
    ]
    if len(toc_indexes) != 1:
        return [
            {
                "severity": "error",
                "code": "formal-report-toc-count",
                "message": (
                    "A formal report requires exactly one semantic TOC field; "
                    f"found {len(toc_indexes)}."
                ),
            }
        ]
    toc_index = toc_indexes[0]
    nonempty_before = [
        index
        for index, paragraph in enumerate(paragraphs[:toc_index])
        if paragraph.text.strip()
    ]
    if not nonempty_before:
        issues.append(
            {
                "severity": "error",
                "code": "formal-report-cover-missing",
                "message": "The formal report has no cover content before its TOC.",
            }
        )
    elif not any(
        _paragraph_has_page_break(paragraph)
        for paragraph in paragraphs[nonempty_before[0] : toc_index]
    ):
        issues.append(
            {
                "severity": "error",
                "code": "formal-report-cover-not-separated",
                "message": "The TOC must start on a new page after the cover.",
            }
        )

    body_break_seen = False
    body_found = False
    for paragraph in paragraphs[toc_index + 1 :]:
        body_break_seen = body_break_seen or _paragraph_has_page_break(paragraph)
        if paragraph.text.strip():
            body_found = True
            break
    if not body_found:
        issues.append(
            {
                "severity": "error",
                "code": "formal-report-body-missing",
                "message": "The formal report has no body content after its TOC.",
            }
        )
    elif not body_break_seen:
        issues.append(
            {
                "severity": "error",
                "code": "formal-report-body-not-separated",
                "message": "The report body must start on a new page after the TOC.",
            }
        )
    return issues


def _builtin_style_gate_issues(
    acceptance: dict[str, Any],
    audit: dict[str, Any],
) -> list[dict[str, Any]]:
    policy = acceptance.get("style_policy")
    if not isinstance(policy, dict) or policy.get("mode") != "builtin":
        return []
    summary = audit.get("summary", {})
    checks = (
        (
            "chromatic_filled_table_cells",
            "builtin-style-chromatic-table-fill",
            "The built-in neutral template does not allow chromatic table fills.",
        ),
        (
            "accent_table_styles",
            "builtin-style-accent-table",
            "The built-in neutral template does not allow Accent table styles.",
        ),
        (
            "chromatic_text_runs",
            "builtin-style-chromatic-text",
            "The built-in neutral template requires black or neutral text.",
        ),
        (
            "chromatic_paragraph_fills",
            "builtin-style-chromatic-paragraph-fill",
            "The built-in neutral template does not allow chromatic paragraph fills.",
        ),
        (
            "chromatic_table_borders",
            "builtin-style-chromatic-table-border",
            "The built-in neutral template requires neutral table borders.",
        ),
    )
    issues: list[dict[str, Any]] = []
    for metric, code, message in checks:
        count = int(summary.get(metric, 0) or 0)
        if count:
            issues.append(
                {
                    "severity": "error",
                    "code": code,
                    "message": message,
                    "metric": metric,
                    "count": count,
                }
            )
    return issues


def _document_policy_gate_issues(
    acceptance: dict[str, Any],
    audit: dict[str, Any],
) -> list[dict[str, Any]]:
    policy = acceptance.get("document_policy", {})
    if policy.get("origin") != "new":
        return []
    summary = audit.get("summary", {})
    checks = (
        (
            "allow_header",
            "header_content_items",
            "unrequested-header",
            "The new document contains a header that was not requested.",
        ),
        (
            "allow_footer",
            "footer_content_items",
            "unrequested-footer",
            "The new document contains a footer that was not requested.",
        ),
        (
            "allow_page_numbers",
            "page_number_fields",
            "unrequested-page-numbers",
            "The new document contains page-number fields that were not requested.",
        ),
    )
    issues: list[dict[str, Any]] = []
    for permission, metric, code, message in checks:
        count = int(summary.get(metric, 0) or 0)
        if not bool(policy.get(permission)) and count:
            issues.append(
                {
                    "severity": "error",
                    "code": code,
                    "message": message,
                    "count": count,
                }
            )
    return issues


def _visual_review_result(
    path: str | Path | None,
    *,
    rendered_pages: int,
    rendered_images: list[str],
    artifact_sha256: str,
    legacy_status: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    review_path, review = _load_json_object(path, label="Visual review")
    issues: list[dict[str, Any]] = []
    if not review:
        if legacy_status == "passed":
            issues.append(
                {
                    "severity": "error",
                    "code": "visual-review-evidence-missing",
                    "message": (
                        "A bare passed status is insufficient; provide a visual review "
                        "report covering every current rendered page."
                    ),
                }
            )
        elif legacy_status == "failed":
            issues.append(
                {
                    "severity": "error",
                    "code": "visual-review-failed",
                    "message": "One or more rendered pages failed visual inspection.",
                }
            )
        return (
            {
                "status": "failed" if legacy_status == "failed" else "not-reviewed",
                "required": True,
                "report": None,
                "pages_reviewed": [],
            },
            issues,
        )
    allowed_review_fields = {"protocol", "artifact_sha256", "status", "pages"}
    if set(review) - allowed_review_fields:
        raise DocxSkillError(
            "Visual review contains unsupported fields",
            code="invalid-visual-review",
        )
    protocol = review.get("protocol")
    if protocol not in {None, "pilotdeck-docx-visual-review/v2"}:
        raise DocxSkillError(
            "Unsupported visual review protocol",
            code="invalid-visual-review",
        )
    reviewed_sha256 = review.get("artifact_sha256")
    if (
        not isinstance(reviewed_sha256, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", reviewed_sha256)
    ):
        raise DocxSkillError(
            "visual review artifact_sha256 must be a 64-character SHA-256 digest",
            code="invalid-visual-review",
        )
    if reviewed_sha256.lower() != artifact_sha256:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-artifact-mismatch",
                "message": "The visual review belongs to a different DOCX candidate.",
                "expected_sha256": artifact_sha256,
                "reviewed_sha256": reviewed_sha256.lower(),
            }
        )
    if review.get("status") not in {"pending", "passed", "failed"}:
        raise DocxSkillError(
            "visual review status must be pending, passed, or failed",
            code="invalid-visual-review",
        )
    pages = review.get("pages")
    if not isinstance(pages, list):
        raise DocxSkillError(
            "visual review pages must be an array",
            code="invalid-visual-review",
        )
    seen: set[int] = set()
    completed_pages: list[int] = []
    failed_pages: list[int] = []
    pending_pages: list[int] = []
    notes: list[str] = []
    expected_image_hashes = {
        index: _page_image_sha256(image)
        for index, image in enumerate(rendered_images, start=1)
    }
    for item in pages:
        allowed_page_fields = {
            "page",
            "status",
            "notes",
            "image_sha256",
            "reviewed_at",
            "recorded_via",
        }
        if not isinstance(item, dict) or set(item) - allowed_page_fields:
            raise DocxSkillError(
                "Visual review page contains unsupported fields",
                code="invalid-visual-review",
            )
        item_status = item.get("status")
        item_notes = item.get("notes")
        if (
            not isinstance(item.get("page"), int)
            or isinstance(item.get("page"), bool)
            or item["page"] < 1
            or item_status not in {"pending", "passed", "failed"}
            or not isinstance(item_notes, str)
            or not isinstance(item.get("image_sha256"), str)
            or not re.fullmatch(r"[0-9a-fA-F]{64}", item["image_sha256"])
        ):
            raise DocxSkillError(
                "Each visual review page requires page, image_sha256, "
                "pending/passed/failed status, and notes",
                code="invalid-visual-review",
            )
        if item_status != "pending" and not item_notes.strip():
            raise DocxSkillError(
                "Completed visual review pages require page-specific notes",
                code="invalid-visual-review",
            )
        if protocol is not None and item_status != "pending":
            if (
                not isinstance(item.get("reviewed_at"), str)
                or not item["reviewed_at"].strip()
                or item.get("recorded_via") != "docx.qa-record/v1"
            ):
                raise DocxSkillError(
                    "Protocol v2 page reviews must be recorded with qa-record",
                    code="invalid-visual-review",
                )
        if item["page"] in seen:
            raise DocxSkillError(
                f"Visual review page {item['page']} is duplicated",
                code="invalid-visual-review",
            )
        seen.add(item["page"])
        if item_status == "pending":
            pending_pages.append(item["page"])
        else:
            completed_pages.append(item["page"])
            notes.append(re.sub(r"\s+", " ", item_notes.strip()).casefold())
        expected_image_hash = expected_image_hashes.get(item["page"])
        if expected_image_hash != item["image_sha256"].lower():
            issues.append(
                {
                    "severity": "error",
                    "code": "visual-review-page-image-mismatch",
                    "message": (
                        "A page review belongs to a stale or different rendered image."
                    ),
                    "page": item["page"],
                    "expected_sha256": expected_image_hash,
                    "reviewed_sha256": item["image_sha256"].lower(),
                }
            )
        if item_status == "failed":
            failed_pages.append(item["page"])
    expected = set(range(1, rendered_pages + 1))
    if seen != expected:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-page-coverage",
                "message": "Visual review must cover every current rendered page exactly once.",
                "missing_pages": sorted(expected - seen),
                "unexpected_pages": sorted(seen - expected),
            }
        )
    if pending_pages:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-incomplete",
                "message": (
                    "Every current rendered page must be inspected and recorded "
                    "with qa-record."
                ),
                "pending_pages": sorted(pending_pages),
            }
        )
    if review["status"] == "failed" or failed_pages:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-failed",
                "message": "One or more rendered pages failed visual inspection.",
                "failed_pages": failed_pages,
            }
        )
    if review["status"] == "pending" and not pending_pages:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-status-incomplete",
                "message": "The visual review is still marked pending.",
            }
        )
    if review["status"] == "passed" and (pending_pages or failed_pages):
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-status-mismatch",
                "message": "The visual review status conflicts with page results.",
            }
        )
    if rendered_pages > 1 and len(notes) == rendered_pages and len(set(notes)) == 1:
        issues.append(
            {
                "severity": "error",
                "code": "visual-review-generic-duplication",
                "message": (
                    "Every page has the same visual-review note. Record a "
                    "page-specific observation for each rendered page."
                ),
            }
        )
    status = "passed" if not issues and review["status"] == "passed" else "failed"
    return (
        {
            "status": status,
            "required": status != "passed",
            "report": str(review_path),
            "protocol": protocol,
            "artifact_sha256": reviewed_sha256.lower(),
            "pages_reviewed": sorted(completed_pages),
            "pending_pages": sorted(pending_pages),
        },
        issues,
    )


def preflight_docx(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    report_path: str | Path | None = None,
    profile: str = "final",
    dispositions_path: str | Path | None = None,
    dispositions: dict[str, str] | None = None,
    acceptance_path: str | Path | None = None,
    visual_review_path: str | Path | None = None,
    required_text: list[str] | None = None,
    min_pages: int | None = None,
    max_pages: int | None = None,
    visual_review_status: str = "not-reviewed",
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    if min_pages is not None and min_pages < 1:
        raise DocxSkillError("min_pages must be positive", code="invalid-preflight")
    if max_pages is not None and max_pages < 1:
        raise DocxSkillError("max_pages must be positive", code="invalid-preflight")
    if min_pages and max_pages and min_pages > max_pages:
        raise DocxSkillError("min_pages cannot exceed max_pages", code="invalid-preflight")
    if visual_review_status not in {"not-reviewed", "passed", "failed"}:
        raise DocxSkillError(
            "visual_review_status must be not-reviewed, passed, or failed",
            code="invalid-preflight",
        )
    report_output = (
        prepare_json_artifact_path(
            report_path,
            protected_paths=(input_path,),
            purpose="Preflight report",
        )
        if report_path
        else None
    )

    acceptance_file, acceptance_raw = _load_json_object(
        acceptance_path,
        label="Acceptance manifest",
    )
    acceptance = _acceptance_requirements(acceptance_raw)
    manifest_min = acceptance["page_count"].get("min")
    manifest_max = acceptance["page_count"].get("max")
    min_pages = manifest_min if manifest_min is not None else min_pages
    max_pages = manifest_max if manifest_max is not None else max_pages
    if min_pages and max_pages and min_pages > max_pages:
        raise DocxSkillError(
            "Combined acceptance and CLI page constraints are inconsistent",
            code="invalid-preflight",
        )
    required_text = list(
        dict.fromkeys([*(required_text or []), *acceptance["required_text"]])
    )
    validation = assert_valid_docx(input_path)
    artifact_sha256 = file_sha256(input_path)
    inspection = inspect_docx(input_path)
    audit = audit_docx(input_path, profile=profile)
    warning_dispositions = load_dispositions(dispositions_path)
    for code, rationale in (dispositions or {}).items():
        if not isinstance(rationale, str) or not rationale.strip():
            raise DocxSkillError(
                f"Disposition for {code} must be a non-empty string",
                code="invalid-warning-disposition",
            )
        warning_dispositions[str(code)] = rationale.strip()

    audit_issues: list[dict[str, Any]] = []
    unknown_dispositions = set(warning_dispositions)
    for issue in audit["issues"]:
        item = dict(issue)
        code = str(item.get("code", ""))
        if code in warning_dispositions and item.get("severity") != "error":
            item["disposition"] = warning_dispositions[code]
            item["resolved"] = True
            unknown_dispositions.discard(code)
        else:
            item["resolved"] = False
        audit_issues.append(item)

    render_result = render_docx(
        input_path,
        output_dir,
        dpi=150,
        emit_pdf=True,
        include_text=True,
        timeout_seconds=timeout_seconds,
    )
    rendered_text = "\n".join(
        str(item.get("text", "")) for item in render_result.get("page_text", [])
    )
    normalized_rendered = _normalize_text(rendered_text)
    render_result["page_evidence"] = [
        {
            "page": page,
            "path": str(image),
            "image_sha256": _page_image_sha256(image),
        }
        for page, image in enumerate(render_result.get("images", []), start=1)
    ]
    for item in render_result.get("page_text", []):
        item.pop("text", None)
    coverage_checks = []
    for value in required_text or []:
        present = _normalize_text(value) in normalized_rendered
        coverage_checks.append({"text": value, "present": present})

    gate_issues: list[dict[str, Any]] = _builtin_style_gate_issues(
        acceptance,
        audit,
    )
    if acceptance_file is not None:
        gate_issues.extend(_document_policy_gate_issues(acceptance, audit))
        gate_issues.extend(
            _document_structure_gate_issues(acceptance, input_path)
        )
    for warning in validation.get("warnings", []):
        gate_issues.append(
            {
                "severity": "warning",
                "code": "package-validation-warning",
                "message": str(warning),
            }
        )
    inspection_coverage = inspection.get("inspection_coverage", {})
    if inspection_coverage.get("status") != "complete":
        gate_issues.append(
            {
                "severity": "warning",
                "code": "inspection-coverage-partial",
                "message": "Some package features are inventoried but not fully interpreted.",
                "limitations": list(inspection_coverage.get("limitations", [])),
            }
        )
    pages = int(render_result["pages"])
    visual_review, visual_issues = _visual_review_result(
        visual_review_path,
        rendered_pages=pages,
        rendered_images=list(render_result.get("images", [])),
        artifact_sha256=artifact_sha256,
        legacy_status=visual_review_status,
    )
    if min_pages is not None and pages < min_pages:
        gate_issues.append(
            {
                "severity": "error",
                "code": "page-count-below-minimum",
                "message": f"Rendered {pages} page(s), below the required minimum {min_pages}.",
            }
        )
    if max_pages is not None and pages > max_pages:
        gate_issues.append(
            {
                "severity": "error",
                "code": "page-count-above-maximum",
                "message": f"Rendered {pages} page(s), above the allowed maximum {max_pages}.",
            }
        )
    missing_text = [item["text"] for item in coverage_checks if not item["present"]]
    if missing_text:
        gate_issues.append(
            {
                "severity": "error",
                "code": "rendered-text-coverage",
                "message": "Required text is missing from the rendered PDF.",
                "missing": missing_text,
            }
        )
    available_headings = [
        {
            "text": _normalize_text(str(item.get("text", ""))),
            "level": int(
                re.search(
                    r"(\d+)$",
                    str(item.get("style", "")),
                ).group(1)
            )
            if re.search(r"(\d+)$", str(item.get("style", "")))
            else None,
        }
        for item in inspection.get("headings", [])
    ]
    missing_headings: list[dict[str, Any]] = []
    for required_heading in acceptance["required_headings"]:
        normalized_heading = _normalize_text(required_heading["text"])
        if not any(
            item["text"] == normalized_heading
            and (
                required_heading["level"] is None
                or item["level"] == required_heading["level"]
            )
            for item in available_headings
        ):
            missing_headings.append(required_heading)
    if missing_headings:
        gate_issues.append(
            {
                "severity": "error",
                "code": "required-heading-missing",
                "message": "One or more required semantic headings are missing.",
                "missing": missing_headings,
            }
        )
    toc = toc_status(input_path)
    toc_requirement = acceptance["toc"]
    if toc_requirement.get("required") and not toc["present"]:
        gate_issues.append(
            {
                "severity": "error",
                "code": "toc-missing",
                "message": "The acceptance manifest requires a table of contents.",
            }
        )
    if toc_requirement.get("populated") and not toc["populated"]:
        gate_issues.append(
            {
                "severity": "error",
                "code": "toc-not-populated",
                "message": (
                    "The table of contents has no visible cached entries and page numbers; "
                    "run refresh-toc before preflight."
                ),
                "toc": toc,
            }
        )
    minimum_images = acceptance["images"].get("min")
    actual_images = int(audit.get("summary", {}).get("images", 0) or 0)
    if minimum_images is not None and actual_images < minimum_images:
        gate_issues.append(
            {
                "severity": "error",
                "code": "image-count-below-minimum",
                "message": (
                    f"The document contains {actual_images} image(s), below "
                    f"the required minimum {minimum_images}."
                ),
                "required": minimum_images,
                "actual": actual_images,
            }
        )
    protected_source_checks: list[dict[str, Any]] = []
    for source in acceptance["protected_sources"]:
        path = Path(source["path"])
        actual = file_sha256(path) if path.is_file() else None
        unchanged = actual == source["sha256"]
        protected_source_checks.append(
            {
                "path": str(path),
                "expected_sha256": source["sha256"],
                "actual_sha256": actual,
                "unchanged": unchanged,
            }
        )
        if not unchanged:
            gate_issues.append(
                {
                    "severity": "error",
                    "code": "protected-source-changed",
                    "message": "A protected source file is missing or changed.",
                    "path": str(path),
                }
            )
    if int(render_result.get("text_characters", 0)) == 0 and inspection["paragraph_count"]:
        gate_issues.append(
            {
                "severity": "error",
                "code": "rendered-text-empty",
                "message": "The document has text, but the rendered PDF exposes no text.",
            }
        )
    for metrics in render_result.get("layout_metrics", []):
        page_number = int(metrics.get("page", 0))
        if metrics.get("blank_body"):
            gate_issues.append(
                {
                    "severity": "error",
                    "code": "blank-body-page",
                    "message": (
                        "A rendered page has no meaningful ink in its body area; "
                        "remove the unintended blank page or repair pagination."
                    ),
                    "page": page_number,
                    "metrics": metrics,
                }
            )
        elif (
            page_number > 1
            and metrics.get("sparse_body")
            and int(metrics.get("text_characters", 0)) < 220
        ):
            gate_issues.append(
                {
                    "severity": "warning",
                    "code": "sparse-page-layout",
                    "message": (
                        "A rendered page contains unusually little body content. "
                        "Check for orphaned table rows, accidental page breaks, "
                        "or a stranded heading."
                    ),
                    "page": page_number,
                    "metrics": metrics,
                }
            )
    gate_issues.extend(visual_issues)
    for item in gate_issues:
        code = str(item.get("code", ""))
        if code in warning_dispositions and item.get("severity") != "error":
            item["disposition"] = warning_dispositions[code]
            item["resolved"] = True
            unknown_dispositions.discard(code)
        else:
            item["resolved"] = False

    if unknown_dispositions:
        gate_issues.append(
            {
                "severity": "warning",
                "code": "unused-warning-disposition",
                "message": "Some warning disposition codes did not match current audit issues.",
                "codes": sorted(unknown_dispositions),
                "resolved": False,
            }
        )

    unresolved_audit = [item for item in audit_issues if not item["resolved"]]
    unresolved_gate = [item for item in gate_issues if not item.get("resolved", False)]
    unresolved_errors = [
        item
        for item in [*unresolved_audit, *unresolved_gate]
        if item.get("severity") == "error"
    ]
    unresolved_warnings = [
        item
        for item in [*unresolved_audit, *unresolved_gate]
        if item.get("severity") == "warning"
    ]
    coverage_error_codes = {
        "page-count-above-maximum",
        "page-count-below-minimum",
        "protected-source-changed",
        "rendered-text-coverage",
        "rendered-text-empty",
        "required-heading-missing",
        "toc-missing",
        "toc-not-populated",
        "blank-body-page",
        "unrequested-header",
        "unrequested-footer",
        "unrequested-page-numbers",
    }
    coverage_passed = not any(
        item.get("code") in coverage_error_codes for item in unresolved_errors
    )
    automated_passed = not unresolved_errors and not unresolved_warnings
    passed = automated_passed and visual_review["status"] == "passed"
    result: dict[str, Any] = {
        "status": "ok" if passed else "partial",
        "passed": passed,
        "input": str(Path(input_path).expanduser().resolve()),
        "profile": profile,
        "checks": {
            "package_validation": "passed",
            "audit": "passed" if not unresolved_audit else "needs-attention",
            "render": "passed",
            "text_coverage": "passed" if not missing_text else "failed",
            "visual_review": visual_review["status"],
            "layout": (
                "passed"
                if not any(
                    item.get("code") in {"blank-body-page", "sparse-page-layout"}
                    for item in unresolved_gate
                )
                else "needs-attention"
            ),
        },
        "coverage": {
            "status": "passed" if coverage_passed else "failed",
            "required_text": coverage_checks,
            "required_headings": {
                "required": acceptance["required_headings"],
                "missing": missing_headings,
            },
            "protected_sources": protected_source_checks,
            "inspection": inspection.get("inspection_coverage"),
        },
        "visual_review": visual_review,
        "toc": toc,
        "acceptance": {
            "manifest": str(acceptance_file) if acceptance_file else None,
            "sha256": file_sha256(acceptance_file) if acceptance_file else None,
            "requirements": acceptance,
        },
        "artifact": {
            "sha256": artifact_sha256,
            "bytes": Path(input_path).expanduser().resolve().stat().st_size,
        },
        "render": render_result,
        "audit": {
            "summary": audit["summary"],
            "issues": audit_issues,
        },
        "gate_issues": gate_issues,
        "unresolved": {
            "errors": unresolved_errors,
            "warnings": unresolved_warnings,
        },
        "validation": validation,
    }
    if report_output:
        write_json(report_output, result)
        result["report"] = str(report_output)

    compact = dict(result)
    compact["audit"] = {
        "summary": audit["summary"],
        "issues": _compact_issues(audit_issues),
    }
    compact["unresolved"] = {
        "errors": unresolved_errors,
        "warnings": _compact_issues(unresolved_warnings, limit=0),
    }
    return compact
