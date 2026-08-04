#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from docxlib.audit import audit_docx
from docxlib.common import (
    DocxSkillError,
    prepare_json_artifact_path,
    validate_docx,
    write_json,
)
from docxlib.core import (
    compare_docx,
    create_docx,
    edit_docx,
    filter_inspection,
    inspect_docx,
    sanitize_docx,
)
from docxlib.delivery import deliver_docx
from docxlib.fallback import fallback_create, fallback_patch
from docxlib.lineage import latest_input_path, resolve_latest_input
from docxlib.preflight import preflight_docx
from docxlib.protocol import capabilities, schema_for
from docxlib.qa import (
    docx_task_paths,
    finalize_visual_qa,
    initialize_visual_qa,
    prepare_docx_task,
    record_visual_review,
)
from docxlib.render import render_docx
from docxlib.review import finalize_docx, review_docx
from docxlib.toc import refresh_toc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docx.sh",
        description="Create, inspect, edit, review, render, and validate Word DOCX files.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("capabilities", help="Report exact supported, fallback, and blocked capabilities")

    schema_parser = sub.add_parser("schema", help="Emit the strict JSON schema for an operation")
    schema_parser.add_argument(
        "--command",
        dest="schema_command",
        required=True,
        choices=("create", "edit", "review"),
    )

    prepare_parser = sub.add_parser(
        "prepare",
        help="Create turn-scoped DOCX paths and freeze an acceptance manifest",
    )
    prepare_parser.add_argument("--require-text", action="append")
    prepare_parser.add_argument(
        "--require-heading",
        action="append",
        help="Required heading as TEXT or LEVEL:TEXT; may be repeated",
    )
    prepare_parser.add_argument("--min-pages", type=int)
    prepare_parser.add_argument("--max-pages", type=int)
    prepare_parser.add_argument(
        "--min-images",
        type=int,
        help="Minimum number of embedded images required in the final DOCX",
    )
    prepare_parser.add_argument("--require-toc", action="store_true")
    prepare_parser.add_argument(
        "--document-structure",
        choices=("simple", "formal-report"),
        default="simple",
        help=(
            "Use formal-report when the user expects a separate cover, TOC "
            "page, and body start page"
        ),
    )
    prepare_parser.add_argument("--protect-source", action="append")
    prepare_parser.add_argument(
        "--existing-document",
        action="store_true",
        help=(
            "Declare an edit of an existing DOCX. Existing recurring content "
            "may be preserved, but must not be added unless explicitly allowed."
        ),
    )
    prepare_parser.add_argument(
        "--allow-header",
        action="store_true",
        help="Use only when the current user explicitly requested a header",
    )
    prepare_parser.add_argument(
        "--allow-footer",
        action="store_true",
        help="Use only when the current user explicitly requested a footer",
    )
    prepare_parser.add_argument(
        "--allow-page-numbers",
        action="store_true",
        help="Use only when the current user explicitly requested page numbers",
    )
    prepare_parser.add_argument(
        "--external-output",
        help=(
            "Freeze the exact absolute external .docx destination explicitly "
            "supplied by the user; otherwise delivery stays in the workspace"
        ),
    )
    prepare_parser.add_argument(
        "--style-mode",
        choices=("builtin", "user"),
        default="builtin",
        help=(
            "Freeze either the built-in neutral template or a user-provided "
            "style source for this task"
        ),
    )
    prepare_parser.add_argument(
        "--style-source",
        choices=(
            "explicit-requirements",
            "reference-template",
            "existing-document",
        ),
        help="Required when --style-mode user",
    )
    prepare_parser.add_argument(
        "--style-requirement",
        action="append",
        help=(
            "Concrete user-supplied visual requirement; repeat as needed. "
            "Required for an explicit-requirements style source."
        ),
    )
    prepare_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace the frozen manifest only after the user changes requirements",
    )

    inspect_parser = sub.add_parser("inspect", help="Extract DOCX structure and metadata")
    inspect_parser.add_argument("--input", required=True)
    inspect_parser.add_argument("--out")
    inspect_parser.add_argument("--summary", action="store_true")
    inspect_parser.add_argument("--search")
    inspect_parser.add_argument("--location")
    inspect_parser.add_argument("--max-items", type=int, default=200)

    create_parser = sub.add_parser("create", help="Create a DOCX from a JSON specification")
    create_parser.add_argument("--spec", required=True)
    create_parser.add_argument("--out", required=True)
    create_parser.add_argument(
        "--acceptance",
        help=(
            "Frozen acceptance manifest. Defaults to the current task manifest "
            "when PILOTDECK_WORK_DIR is set."
        ),
    )
    create_parser.add_argument("--overwrite", action="store_true")

    edit_parser = sub.add_parser("edit", help="Apply local edits from a JSON patch")
    edit_parser.add_argument("--input", required=True)
    edit_parser.add_argument("--patch", required=True)
    edit_parser.add_argument("--out", required=True)
    edit_parser.add_argument(
        "--acceptance",
        help=(
            "Frozen acceptance manifest. Defaults to the current task manifest "
            "when PILOTDECK_WORK_DIR is set."
        ),
    )
    edit_parser.add_argument("--overwrite", action="store_true")
    edit_parser.add_argument(
        "--use-exact-input",
        action="store_true",
        help=(
            "Bypass the tracked latest version only when the user explicitly "
            "requests an older/original base"
        ),
    )
    edit_parser.add_argument(
        "--allow-lossy",
        action="store_true",
        help="Explicitly allow a python-docx round trip on a package-sensitive document",
    )

    review_parser = sub.add_parser("review", help="Add comments and tracked replacements")
    review_parser.add_argument("--input", required=True)
    review_parser.add_argument("--spec", required=True)
    review_parser.add_argument("--out", required=True)
    review_parser.add_argument("--overwrite", action="store_true")
    review_parser.add_argument("--use-exact-input", action="store_true")

    finalize_parser = sub.add_parser("finalize", help="Accept/reject changes and remove comments")
    finalize_parser.add_argument("--input", required=True)
    finalize_parser.add_argument("--out", required=True)
    finalize_parser.add_argument("--overwrite", action="store_true")
    finalize_parser.add_argument("--use-exact-input", action="store_true")
    changes = finalize_parser.add_mutually_exclusive_group()
    changes.add_argument("--accept-changes", action="store_true")
    changes.add_argument("--reject-changes", action="store_true")
    finalize_parser.add_argument("--remove-comments", action="store_true")

    compare_parser = sub.add_parser("compare", help="Compare paragraph text between two DOCX files")
    compare_parser.add_argument("--before", required=True)
    compare_parser.add_argument("--after", required=True)
    compare_parser.add_argument("--out", required=True)

    sanitize_parser = sub.add_parser("sanitize", help="Remove personal metadata and revision IDs")
    sanitize_parser.add_argument("--input", required=True)
    sanitize_parser.add_argument("--out", required=True)
    sanitize_parser.add_argument("--overwrite", action="store_true")
    sanitize_parser.add_argument("--use-exact-input", action="store_true")
    sanitize_parser.add_argument("--remove-comments", action="store_true")

    refresh_toc_parser = sub.add_parser(
        "refresh-toc",
        help="Populate the cached TOC entries and page numbers from a rendered candidate",
    )
    refresh_toc_parser.add_argument("--input", required=True)
    refresh_toc_parser.add_argument("--out", required=True)
    refresh_toc_parser.add_argument("--render-dir", required=True)
    refresh_toc_parser.add_argument("--timeout", type=int, default=120)
    refresh_toc_parser.add_argument("--overwrite", action="store_true")

    render_parser = sub.add_parser("render", help="Render DOCX pages to PNG through LibreOffice")
    render_parser.add_argument("--input", required=True)
    render_parser.add_argument("--out-dir", required=True)
    render_parser.add_argument("--dpi", type=int, default=150)
    render_parser.add_argument("--emit-pdf", action="store_true")
    render_parser.add_argument("--timeout", type=int, default=120)

    validate_parser = sub.add_parser("validate", help="Validate DOCX ZIP and OOXML integrity")
    validate_parser.add_argument("--input", required=True)

    audit_parser = sub.add_parser(
        "audit", help="Audit structure, layout risk, accessibility, and finalization state"
    )
    audit_parser.add_argument("--input", required=True)
    audit_parser.add_argument("--out")
    audit_parser.add_argument(
        "--profile", choices=("draft", "final", "accessible"), default="draft"
    )

    fallback_patch_parser = sub.add_parser(
        "fallback-patch",
        help="Run a declared OOXML patch and enforce the allowed package-part scope",
    )
    fallback_patch_parser.add_argument("--input", required=True)
    fallback_patch_parser.add_argument("--script", required=True)
    fallback_patch_parser.add_argument("--out", required=True)
    fallback_patch_parser.add_argument("--manifest", required=True)
    fallback_patch_parser.add_argument("--allow-part", action="append")
    fallback_patch_parser.add_argument("--reason", required=True)
    fallback_patch_parser.add_argument("--timeout", type=int, default=120)
    fallback_patch_parser.add_argument("--overwrite", action="store_true")
    fallback_patch_parser.add_argument("--use-exact-input", action="store_true")

    fallback_create_parser = sub.add_parser(
        "fallback-create",
        help="Run a declared custom creator and validate the resulting DOCX",
    )
    fallback_create_parser.add_argument("--script", required=True)
    fallback_create_parser.add_argument("--out", required=True)
    fallback_create_parser.add_argument("--manifest", required=True)
    fallback_create_parser.add_argument("--reason", required=True)
    fallback_create_parser.add_argument("--timeout", type=int, default=120)

    preflight_parser = sub.add_parser(
        "preflight",
        help="Gate package integrity, audit warnings, render coverage, and visual review",
    )
    preflight_parser.add_argument("--input", required=True)
    preflight_parser.add_argument("--out-dir", required=True)
    preflight_parser.add_argument("--report")
    preflight_parser.add_argument(
        "--profile", choices=("draft", "final", "accessible"), default="final"
    )
    preflight_parser.add_argument("--dispositions")
    preflight_parser.add_argument(
        "--disposition",
        action="append",
        help="Inline warning disposition in code=rationale form; may be repeated",
    )
    preflight_parser.add_argument(
        "--acceptance",
        help="JSON acceptance manifest with content, page, TOC, and source-integrity requirements",
    )
    preflight_parser.add_argument(
        "--visual-review",
        help="Candidate-SHA-bound JSON report with a passed/failed record and notes for every rendered page",
    )
    preflight_parser.add_argument("--require-text", action="append")
    preflight_parser.add_argument("--min-pages", type=int)
    preflight_parser.add_argument("--max-pages", type=int)
    visual_review = preflight_parser.add_mutually_exclusive_group()
    visual_review.add_argument(
        "--visual-review-status",
        choices=("passed", "failed"),
        help="Record the explicit result after inspecting every current page image",
    )
    visual_review.add_argument(
        "--visual-reviewed",
        action="store_true",
        help="Deprecated alias for --visual-review-status passed",
    )
    preflight_parser.add_argument("--timeout", type=int, default=120)

    qa_init_parser = sub.add_parser(
        "qa-init",
        help=(
            "Run the automated gate and create a page-review skeleton with "
            "canonical page-image hashes"
        ),
    )
    qa_init_parser.add_argument("--input", required=True)
    qa_init_parser.add_argument("--acceptance")
    qa_init_parser.add_argument("--out-dir")
    qa_init_parser.add_argument("--report")
    qa_init_parser.add_argument("--visual-review")
    qa_init_parser.add_argument(
        "--profile", choices=("draft", "final", "accessible"), default="final"
    )
    qa_init_parser.add_argument("--dispositions")
    qa_init_parser.add_argument(
        "--disposition",
        action="append",
        help="Inline warning disposition in code=rationale form; may be repeated",
    )
    qa_init_parser.add_argument("--timeout", type=int, default=120)
    qa_init_parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace stale review evidence after the candidate changes",
    )

    qa_record_parser = sub.add_parser(
        "qa-record",
        help="Record one inspected page without copying paths or image hashes",
    )
    qa_record_parser.add_argument("--visual-review")
    qa_record_parser.add_argument("--page", required=True, type=int)
    qa_record_parser.add_argument(
        "--status", required=True, choices=("passed", "failed")
    )
    qa_record_parser.add_argument("--notes", required=True)

    qa_finalize_parser = sub.add_parser(
        "qa-finalize",
        help=(
            "Finalize the gate against the exact render and candidate created "
            "by qa-init"
        ),
    )
    qa_finalize_parser.add_argument("--input", required=True)
    qa_finalize_parser.add_argument("--acceptance")
    qa_finalize_parser.add_argument("--initial-report")
    qa_finalize_parser.add_argument("--report")
    qa_finalize_parser.add_argument("--visual-review")

    deliver_parser = sub.add_parser(
        "deliver",
        help="Atomically promote a fully preflighted internal candidate to the requested output",
    )
    deliver_parser.add_argument("--input", required=True)
    deliver_parser.add_argument("--preflight-report", required=True)
    deliver_parser.add_argument("--out", required=True)
    delivery_origin = deliver_parser.add_mutually_exclusive_group(required=True)
    delivery_origin.add_argument(
        "--source",
        help="The existing user document from which this result descends",
    )
    delivery_origin.add_argument(
        "--new-document",
        action="store_true",
        help="Declare that this result is a newly created document",
    )
    deliver_parser.add_argument(
        "--replace-source",
        action="store_true",
        help=(
            "Replace --source only when the current user request explicitly "
            "asks for in-place overwrite"
        ),
    )
    deliver_parser.add_argument(
        "--use-exact-source",
        action="store_true",
        help=(
            "Bypass the tracked latest source only when the user explicitly "
            "requests an older/original base"
        ),
    )
    deliver_parser.add_argument(
        "--allow-update-fields-on-open",
        action="store_true",
        help=(
            "Deliver a DOCX that requests field updates when Word opens it only "
            "after the user explicitly accepts the opening prompt"
        ),
    )
    deliver_parser.add_argument("--overwrite", action="store_true")

    resolve_latest_parser = sub.add_parser(
        "resolve-latest",
        help=(
            "Resolve an original or prior DOCX path to the latest delivered "
            "version in this session"
        ),
    )
    resolve_latest_parser.add_argument("--input", required=True)
    resolve_latest_parser.add_argument("--use-exact-input", action="store_true")

    sub.add_parser("self-test", help="Run the bundled end-to-end smoke test")
    return parser


def _inline_dispositions(values: list[str] | None) -> dict[str, str]:
    dispositions: dict[str, str] = {}
    for item in values or []:
        if "=" not in item:
            raise DocxSkillError(
                "--disposition must use code=rationale syntax",
                code="invalid-warning-disposition",
            )
        code, rationale = item.split("=", 1)
        if not code.strip() or not rationale.strip():
            raise DocxSkillError(
                "--disposition requires a non-empty code and rationale",
                code="invalid-warning-disposition",
            )
        dispositions[code.strip()] = rationale.strip()
    return dispositions


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "capabilities":
        return capabilities()
    if args.command == "schema":
        return schema_for(args.schema_command)
    if args.command == "prepare":
        return prepare_docx_task(
            required_text=args.require_text,
            required_headings=args.require_heading,
            min_pages=args.min_pages,
            max_pages=args.max_pages,
            min_images=args.min_images,
            require_toc=args.require_toc,
            document_structure=args.document_structure,
            protected_sources=args.protect_source,
            style_mode=args.style_mode,
            style_source=args.style_source,
            style_requirements=args.style_requirement,
            existing_document=args.existing_document,
            allow_header=args.allow_header,
            allow_footer=args.allow_footer,
            allow_page_numbers=args.allow_page_numbers,
            external_output=args.external_output,
            overwrite=args.overwrite,
        )
    if args.command == "inspect":
        result = inspect_docx(args.input)
        result = filter_inspection(
            result,
            summary=args.summary,
            search=args.search,
            location=args.location,
            max_items=args.max_items,
        )
        if args.out:
            json_output = prepare_json_artifact_path(
                args.out,
                protected_paths=(args.input,),
                purpose="Inspection output",
            )
            write_json(json_output, result)
            result["out"] = str(json_output)
        return result
    if args.command == "create":
        acceptance = args.acceptance
        if acceptance is None and os.environ.get("PILOTDECK_WORK_DIR"):
            acceptance = str(docx_task_paths()["acceptance"])
        return create_docx(
            args.spec,
            args.out,
            acceptance_path=acceptance,
            overwrite=args.overwrite,
        )
    if args.command == "edit":
        acceptance = args.acceptance
        if acceptance is None and os.environ.get("PILOTDECK_WORK_DIR"):
            acceptance = str(docx_task_paths()["acceptance"])
        return edit_docx(
            latest_input_path(
                args.input, use_exact_input=args.use_exact_input
            ),
            args.patch,
            args.out,
            acceptance_path=acceptance,
            allow_lossy=args.allow_lossy,
            overwrite=args.overwrite,
        )
    if args.command == "review":
        return review_docx(
            latest_input_path(
                args.input, use_exact_input=args.use_exact_input
            ),
            args.spec,
            args.out,
            overwrite=args.overwrite,
        )
    if args.command == "finalize":
        return finalize_docx(
            latest_input_path(
                args.input, use_exact_input=args.use_exact_input
            ),
            args.out,
            accept_changes=args.accept_changes,
            reject_changes=args.reject_changes,
            remove_comments=args.remove_comments,
            overwrite=args.overwrite,
        )
    if args.command == "compare":
        return compare_docx(args.before, args.after, args.out)
    if args.command == "sanitize":
        return sanitize_docx(
            latest_input_path(
                args.input, use_exact_input=args.use_exact_input
            ),
            args.out,
            remove_comments=args.remove_comments,
            overwrite=args.overwrite,
        )
    if args.command == "refresh-toc":
        return refresh_toc(
            args.input,
            args.out,
            args.render_dir,
            overwrite=args.overwrite,
            timeout_seconds=args.timeout,
        )
    if args.command == "render":
        return render_docx(
            args.input,
            args.out_dir,
            dpi=args.dpi,
            emit_pdf=args.emit_pdf,
            timeout_seconds=args.timeout,
        )
    if args.command == "validate":
        return validate_docx(args.input)
    if args.command == "audit":
        return audit_docx(args.input, args.out, profile=args.profile)
    if args.command == "fallback-patch":
        return fallback_patch(
            latest_input_path(
                args.input, use_exact_input=args.use_exact_input
            ),
            args.script,
            args.out,
            args.manifest,
            allow_parts=args.allow_part,
            reason=args.reason,
            timeout_seconds=args.timeout,
            overwrite=args.overwrite,
        )
    if args.command == "fallback-create":
        return fallback_create(
            args.script,
            args.out,
            args.manifest,
            reason=args.reason,
            timeout_seconds=args.timeout,
        )
    if args.command == "preflight":
        visual_review_status = (
            "passed"
            if args.visual_reviewed
            else (args.visual_review_status or "not-reviewed")
        )
        return preflight_docx(
            args.input,
            args.out_dir,
            report_path=args.report,
            profile=args.profile,
            dispositions_path=args.dispositions,
            dispositions=_inline_dispositions(args.disposition),
            acceptance_path=args.acceptance,
            visual_review_path=args.visual_review,
            required_text=args.require_text,
            min_pages=args.min_pages,
            max_pages=args.max_pages,
            visual_review_status=visual_review_status,
            timeout_seconds=args.timeout,
        )
    if args.command == "qa-init":
        return initialize_visual_qa(
            args.input,
            acceptance_path=args.acceptance,
            output_dir=args.out_dir,
            report_path=args.report,
            review_path=args.visual_review,
            profile=args.profile,
            dispositions_path=args.dispositions,
            dispositions=_inline_dispositions(args.disposition),
            timeout_seconds=args.timeout,
            overwrite=args.overwrite,
        )
    if args.command == "qa-record":
        review = args.visual_review or docx_task_paths()["visual_review"]
        return record_visual_review(
            review,
            page=args.page,
            status=args.status,
            notes=args.notes,
        )
    if args.command == "qa-finalize":
        return finalize_visual_qa(
            args.input,
            acceptance_path=args.acceptance,
            initial_report_path=args.initial_report,
            report_path=args.report,
            review_path=args.visual_review,
        )
    if args.command == "deliver":
        return deliver_docx(
            args.input,
            args.preflight_report,
            args.out,
            source_path=args.source,
            new_document=args.new_document,
            replace_source=args.replace_source,
            use_exact_source=args.use_exact_source,
            overwrite=args.overwrite,
            allow_update_fields_on_open=args.allow_update_fields_on_open,
        )
    if args.command == "resolve-latest":
        return resolve_latest_input(
            args.input,
            use_exact_input=args.use_exact_input,
        )
    if args.command == "self-test":
        from docxlib.smoke import run_smoke_test

        return run_smoke_test()
    raise DocxSkillError(f"Unsupported command: {args.command}")


def main() -> int:
    args = _parser().parse_args()
    try:
        result = _execute(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("status") == "ok" else 3
    except DocxSkillError as exc:
        print(
            json.dumps(
                {
                    "status": exc.status,
                    "code": exc.code,
                    "error": str(exc),
                    "details": exc.details,
                    "command": args.command,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 3
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": f"Unexpected {type(exc).__name__}: {exc}",
                    "command": args.command,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
