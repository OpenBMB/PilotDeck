from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    assert_internal_candidate_path,
    assert_valid_docx,
    blocked,
    file_sha256,
    prepare_delivery_docx_path,
    require_docx_path,
    temporary_sibling,
)
from .fields import update_fields_on_open_enabled
from .lineage import (
    backup_replaced_source,
    latest_input_path,
    paths_are_same,
    record_delivery,
)
from .protocol import normalize_delivery_policy


def _load_preflight_report(path: str | Path) -> tuple[Path, dict[str, Any]]:
    report_path = Path(path).expanduser().resolve()
    try:
        value = json.loads(report_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise DocxSkillError(
            f"Preflight report not found: {report_path}",
            code="preflight-report-not-found",
        ) from exc
    except json.JSONDecodeError as exc:
        raise DocxSkillError(
            f"Invalid preflight report JSON: {exc}",
            code="invalid-preflight-report",
        ) from exc
    if not isinstance(value, dict):
        raise DocxSkillError(
            "Preflight report must be a JSON object",
            code="invalid-preflight-report",
        )
    return report_path, value


def deliver_docx(
    input_path: str | Path,
    preflight_report_path: str | Path,
    output_path: str | Path,
    *,
    source_path: str | Path | None = None,
    new_document: bool = False,
    replace_source: bool = False,
    use_exact_source: bool = False,
    overwrite: bool = False,
    allow_update_fields_on_open: bool = False,
) -> dict[str, Any]:
    if (source_path is None) == (not new_document):
        raise DocxSkillError(
            "Delivery requires exactly one origin mode: --source for a "
            "modified document, or --new-document for a newly created document",
            code="delivery-origin-required",
        )
    if replace_source and source_path is None:
        raise DocxSkillError(
            "--replace-source is valid only with --source",
            code="invalid-source-replacement",
        )
    if use_exact_source and source_path is None:
        raise DocxSkillError(
            "--use-exact-source is valid only with --source",
            code="invalid-exact-source",
        )

    candidate = assert_internal_candidate_path(require_docx_path(input_path))
    report_path, report = _load_preflight_report(preflight_report_path)
    expected_input = Path(str(report.get("input", ""))).expanduser().resolve()
    if expected_input != candidate:
        raise blocked(
            "The preflight report belongs to a different DOCX candidate",
            code="preflight-artifact-mismatch",
            details={
                "candidate": str(candidate),
                "report_input": str(expected_input),
                "report": str(report_path),
            },
        )
    artifact = report.get("artifact", {})
    expected_sha256 = (
        str(artifact.get("sha256", "")).lower()
        if isinstance(artifact, dict)
        else ""
    )
    actual_sha256 = file_sha256(candidate)
    if not expected_sha256 or expected_sha256 != actual_sha256:
        raise blocked(
            "The DOCX candidate changed after preflight",
            code="preflight-artifact-changed",
            details={
                "candidate": str(candidate),
                "expected_sha256": expected_sha256 or None,
                "actual_sha256": actual_sha256,
            },
        )
    gate_state = {
        "status": report.get("status"),
        "passed": report.get("passed"),
        "coverage": (
            report.get("coverage", {}).get("status")
            if isinstance(report.get("coverage"), dict)
            else None
        ),
        "visual_review": (
            report.get("visual_review", {}).get("status")
            if isinstance(report.get("visual_review"), dict)
            else None
        ),
        "acceptance_manifest": bool(
            report.get("acceptance", {}).get("manifest")
            if isinstance(report.get("acceptance"), dict)
            else None
        ),
    }
    if gate_state != {
        "status": "ok",
        "passed": True,
        "coverage": "passed",
        "visual_review": "passed",
        "acceptance_manifest": True,
    }:
        raise blocked(
            "Only a candidate that passed the complete preflight gate can be delivered",
            code="preflight-not-passed",
            details={"gate": gate_state, "report": str(report_path)},
        )
    report_acceptance = report.get("acceptance", {})
    acceptance_requirements = (
        report_acceptance.get("requirements", {})
        if isinstance(report_acceptance, dict)
        else {}
    )
    if not isinstance(acceptance_requirements, dict):
        raise blocked(
            "The preflight report does not contain normalized acceptance requirements",
            code="preflight-acceptance-invalid",
            details={"report": str(report_path)},
        )
    delivery_policy = normalize_delivery_policy(
        acceptance_requirements.get("delivery")
    )
    if (
        update_fields_on_open_enabled(candidate)
        and not allow_update_fields_on_open
    ):
        raise blocked(
            "The DOCX requests automatic field updates when Word opens it. "
            "Refresh cached fields and disable update-on-open before delivery, "
            "or use --allow-update-fields-on-open only when the user explicitly "
            "requested dynamic field updates and accepted the opening prompt.",
            code="fields-update-on-open",
            details={
                "candidate": str(candidate),
                "explicit_opt_in_flag": "--allow-update-fields-on-open",
            },
        )

    requested_source = (
        require_docx_path(source_path, must_exist=False)
        if source_path is not None
        else None
    )
    effective_source = (
        latest_input_path(
            requested_source,
            use_exact_input=use_exact_source,
        )
        if requested_source is not None
        else None
    )
    raw_output = Path(output_path).expanduser()
    workspace_root = Path(delivery_policy["workspace_root"])
    output_requested = require_docx_path(
        raw_output if raw_output.is_absolute() else workspace_root / raw_output,
        must_exist=False,
    )
    if new_document and output_requested.exists():
        raise blocked(
            "A newly created document must be delivered to a new path; "
            "--new-document never replaces an existing file",
            code="new-document-output-exists",
            details={
                "out": str(output_requested),
                "overwrite_flag_is_insufficient": overwrite,
            },
        )
    if replace_source:
        assert requested_source is not None
        require_docx_path(requested_source)
        if not paths_are_same(output_requested, requested_source):
            raise blocked(
                "--replace-source may replace only the exact path supplied by --source",
                code="source-replacement-path-mismatch",
                details={
                    "source": str(requested_source),
                    "out": str(output_requested),
                },
            )
    elif requested_source is not None and (
        paths_are_same(output_requested, requested_source)
        or (
            effective_source is not None
            and paths_are_same(output_requested, effective_source)
        )
    ):
        raise blocked(
            "The source DOCX is preserved by default. Choose a new final "
            "filename, or use --replace-source only when the user explicitly "
            "asked to overwrite the source in the current request",
            code="source-overwrite-requires-explicit-mode",
            details={
                "source": str(requested_source),
                "latest": (
                    str(effective_source)
                    if effective_source is not None
                    else None
                ),
                "out": str(output_requested),
                "overwrite_flag_is_insufficient": overwrite,
            },
        )

    source_sha256 = (
        file_sha256(effective_source)
        if effective_source is not None
        else None
    )
    backup = (
        backup_replaced_source(requested_source)
        if replace_source and requested_source is not None
        else None
    )
    output = prepare_delivery_docx_path(
        output_requested,
        overwrite=((overwrite and not new_document) or replace_source),
        workspace_root=workspace_root,
        authorized_external_path=delivery_policy.get("path"),
        replace_source_path=(requested_source if replace_source else None),
    )
    with temporary_sibling(output, suffix=".tmp.docx") as temporary:
        shutil.copy2(candidate, temporary)
        assert_valid_docx(temporary)
        if file_sha256(temporary) != actual_sha256:
            raise DocxSkillError(
                "The copied delivery candidate failed the digest check",
                code="delivery-copy-mismatch",
            )
        os.replace(temporary, output)
    if (
        effective_source is not None
        and not paths_are_same(output, effective_source)
        and file_sha256(effective_source) != source_sha256
    ):
        raise DocxSkillError(
            "The source DOCX changed during delivery",
            code="source-changed-during-delivery",
            details={"source": str(effective_source)},
        )
    lineage = record_delivery(
        output,
        source_path=effective_source,
        source_sha256=source_sha256,
        candidate_sha256=actual_sha256,
        operation=("replace-source" if replace_source else "deliver"),
        replace_source=replace_source,
        backup=backup,
    )
    return {
        "status": "ok",
        "code": "docx-delivered",
        "input": str(candidate),
        "out": str(output),
        "sha256": actual_sha256,
        "preflight_report": str(report_path),
        "source": str(effective_source) if effective_source is not None else None,
        "source_replaced": replace_source,
        "source_backup": backup,
        "lineage": lineage,
        "message": (
            "The final DOCX is delivered. Mention its filename in the response; "
            "PilotDeck renders the file card."
        ),
    }
