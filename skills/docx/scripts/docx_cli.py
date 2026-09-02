#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from docxlib.annotations import annotate_docx, finalize_docx
from docxlib.common import (
    DocxSkillError,
    assert_valid_docx,
    prepare_json_artifact_path,
    write_json,
)
from docxlib.core import compare_docx, filter_inspection, inspect_docx, sanitize_docx
from docxlib.delivery import deliver_docx
from docxlib.render import render_docx


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docx.sh",
        description="Inspect, render, validate, and deliver Word DOCX files.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_parser = sub.add_parser("inspect", help="Extract DOCX content, structure, and package facts")
    inspect_parser.add_argument("--input", required=True)
    inspect_parser.add_argument("--out")
    inspect_parser.add_argument("--summary", action="store_true")
    inspect_parser.add_argument("--search")
    inspect_parser.add_argument("--location")
    inspect_parser.add_argument("--max-items", type=int, default=200)

    validate = sub.add_parser("validate", help="Validate DOCX package structure")
    validate.add_argument("--input", required=True)

    render = sub.add_parser("render", help="Render DOCX pages to full-size PNG images")
    render.add_argument("--input", required=True)
    render.add_argument("--out-dir", required=True)
    render.add_argument("--dpi", type=int, default=150)
    render.add_argument("--timeout", type=int, default=180)

    deliver = sub.add_parser("deliver", help="Atomically publish a valid internal candidate")
    deliver.add_argument("--input", required=True)
    deliver.add_argument("--out", required=True)
    deliver.add_argument("--source")
    deliver.add_argument("--replace-source", action="store_true")
    deliver.add_argument("--overwrite", action="store_true")

    annotate = sub.add_parser("annotate", help="Add comments and tracked text replacements")
    annotate.add_argument("--input", required=True)
    annotate.add_argument("--spec", required=True)
    annotate.add_argument("--out", required=True)
    annotate.add_argument("--overwrite", action="store_true")

    finalize = sub.add_parser("finalize", help="Accept or reject revisions and optionally remove comments")
    finalize.add_argument("--input", required=True)
    finalize.add_argument("--out", required=True)
    finalize.add_argument("--overwrite", action="store_true")
    changes = finalize.add_mutually_exclusive_group()
    changes.add_argument("--accept-changes", action="store_true")
    changes.add_argument("--reject-changes", action="store_true")
    finalize.add_argument("--remove-comments", action="store_true")

    compare = sub.add_parser("compare", help="Compare document content and package facts")
    compare.add_argument("--before", required=True)
    compare.add_argument("--after", required=True)
    compare.add_argument("--out", required=True)

    sanitize = sub.add_parser("sanitize", help="Remove personal package metadata and revision identifiers")
    sanitize.add_argument("--input", required=True)
    sanitize.add_argument("--out", required=True)
    sanitize.add_argument("--remove-comments", action="store_true")
    sanitize.add_argument("--overwrite", action="store_true")

    sub.add_parser("self-test", help="Run the bundled DOCX regression tests")
    return parser


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "inspect":
        result = filter_inspection(
            inspect_docx(args.input),
            summary=args.summary,
            search=args.search,
            location=args.location,
            max_items=args.max_items,
        )
        if args.out:
            output = prepare_json_artifact_path(
                args.out,
                protected_paths=(args.input,),
                purpose="Inspection output",
            )
            write_json(output, result)
            result["out"] = str(output)
        return result
    if args.command == "validate":
        return assert_valid_docx(args.input)
    if args.command == "render":
        return render_docx(
            args.input,
            args.out_dir,
            dpi=args.dpi,
            timeout_seconds=args.timeout,
        )
    if args.command == "deliver":
        return deliver_docx(
            args.input,
            args.out,
            source_path=args.source,
            replace_source=args.replace_source,
            overwrite=args.overwrite,
        )
    if args.command == "annotate":
        return annotate_docx(args.input, args.spec, args.out, overwrite=args.overwrite)
    if args.command == "finalize":
        return finalize_docx(
            args.input,
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
            args.input,
            args.out,
            remove_comments=args.remove_comments,
            overwrite=args.overwrite,
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
        return 3 if result.get("status") in {"error", "blocked", "unsupported"} else 0
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
