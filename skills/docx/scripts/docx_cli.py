#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from docxlib.audit import audit_docx
from docxlib.common import DocxSkillError, validate_docx
from docxlib.core import compare_docx, create_docx, edit_docx, inspect_docx, sanitize_docx
from docxlib.render import render_docx
from docxlib.review import finalize_docx, review_docx


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docx.sh",
        description="Create, inspect, edit, review, render, and validate Word DOCX files.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_parser = sub.add_parser("inspect", help="Extract DOCX structure and metadata")
    inspect_parser.add_argument("--input", required=True)
    inspect_parser.add_argument("--out")

    create_parser = sub.add_parser("create", help="Create a DOCX from a JSON specification")
    create_parser.add_argument("--spec", required=True)
    create_parser.add_argument("--out", required=True)

    edit_parser = sub.add_parser("edit", help="Apply local edits from a JSON patch")
    edit_parser.add_argument("--input", required=True)
    edit_parser.add_argument("--patch", required=True)
    edit_parser.add_argument("--out", required=True)

    review_parser = sub.add_parser("review", help="Add comments and tracked replacements")
    review_parser.add_argument("--input", required=True)
    review_parser.add_argument("--spec", required=True)
    review_parser.add_argument("--out", required=True)

    finalize_parser = sub.add_parser("finalize", help="Accept/reject changes and remove comments")
    finalize_parser.add_argument("--input", required=True)
    finalize_parser.add_argument("--out", required=True)
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
    sanitize_parser.add_argument("--remove-comments", action="store_true")

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

    sub.add_parser("self-test", help="Run the bundled end-to-end smoke test")
    return parser


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "inspect":
        return inspect_docx(args.input, args.out)
    if args.command == "create":
        return create_docx(args.spec, args.out)
    if args.command == "edit":
        return edit_docx(args.input, args.patch, args.out)
    if args.command == "review":
        return review_docx(args.input, args.spec, args.out)
    if args.command == "finalize":
        return finalize_docx(
            args.input,
            args.out,
            accept_changes=args.accept_changes,
            reject_changes=args.reject_changes,
            remove_comments=args.remove_comments,
        )
    if args.command == "compare":
        return compare_docx(args.before, args.after, args.out)
    if args.command == "sanitize":
        return sanitize_docx(args.input, args.out, remove_comments=args.remove_comments)
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
                {"status": "error", "error": str(exc), "command": args.command},
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
