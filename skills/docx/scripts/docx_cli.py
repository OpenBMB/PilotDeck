#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from docxlib.accessibility import inspect_accessibility
from docxlib.annotations import annotate_docx, finalize_docx
from docxlib.builder import run_builder, scaffold_builder
from docxlib.common import (
    DocxSkillError,
    prepare_json_artifact_path,
    write_json,
)
from docxlib.core import compare_docx, filter_inspection, inspect_docx, sanitize_docx
from docxlib.delivery import deliver_docx
from docxlib.evaluation import run_evaluator
from docxlib.fallback import fallback_patch
from docxlib.review import review_candidate


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="docx.sh",
        description="Create, edit, inspect, render, and verify Word DOCX files.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    scaffold = sub.add_parser("scaffold", help="Create a minimal reproducible Python builder")
    scaffold.add_argument("--out", required=True)
    scaffold.add_argument("--overwrite", action="store_true")

    build = sub.add_parser("build", help="Run a Python builder and validate an internal DOCX candidate")
    build.add_argument("--builder", required=True)
    build.add_argument("--input")
    build.add_argument("--out", required=True)
    build.add_argument("--overwrite", action="store_true")
    build.add_argument("--timeout", type=int, default=180)

    inspect_parser = sub.add_parser("inspect", help="Extract DOCX content, structure, and package facts")
    inspect_parser.add_argument("--input", required=True)
    inspect_parser.add_argument("--out")
    inspect_parser.add_argument("--summary", action="store_true")
    inspect_parser.add_argument("--search")
    inspect_parser.add_argument("--location")
    inspect_parser.add_argument("--max-items", type=int, default=200)

    review = sub.add_parser("review", help="Produce structural evidence and revision-specific page images")
    review.add_argument("--input", required=True)
    review.add_argument("--out-dir", required=True)
    review.add_argument("--report")
    review.add_argument("--dpi", type=int, default=150)
    review.add_argument("--timeout", type=int, default=180)

    evaluate = sub.add_parser("evaluate", help="Run a task-specific evaluator against a candidate")
    evaluate.add_argument("--input", required=True)
    evaluate.add_argument("--script", required=True)
    evaluate.add_argument("--out", required=True)
    evaluate.add_argument("--timeout", type=int, default=180)

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

    accessibility = sub.add_parser(
        "accessibility",
        help="Report semantic accessibility evidence without declaring compliance",
    )
    accessibility.add_argument("--input", required=True)
    accessibility.add_argument("--out")

    patch = sub.add_parser("fallback-patch", help="Run a scoped OOXML patch against an internal copy")
    patch.add_argument("--input", required=True)
    patch.add_argument("--script", required=True)
    patch.add_argument("--out", required=True)
    patch.add_argument("--report", required=True)
    patch.add_argument("--allow-part", action="append", required=True)
    patch.add_argument("--reason", required=True)
    patch.add_argument("--timeout", type=int, default=180)
    patch.add_argument("--overwrite", action="store_true")

    sub.add_parser("self-test", help="Run the bundled DOCX regression tests")
    return parser


def _execute(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "scaffold":
        return scaffold_builder(args.out, overwrite=args.overwrite)
    if args.command == "build":
        return run_builder(
            args.builder,
            args.out,
            input_path=args.input,
            overwrite=args.overwrite,
            timeout_seconds=args.timeout,
        )
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
    if args.command == "review":
        return review_candidate(
            args.input,
            args.out_dir,
            report_path=args.report,
            dpi=args.dpi,
            timeout_seconds=args.timeout,
        )
    if args.command == "evaluate":
        return run_evaluator(args.input, args.script, args.out, timeout_seconds=args.timeout)
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
    if args.command == "accessibility":
        return inspect_accessibility(args.input, args.out)
    if args.command == "fallback-patch":
        return fallback_patch(
            args.input,
            args.script,
            args.out,
            args.report,
            allow_parts=args.allow_part,
            reason=args.reason,
            timeout_seconds=args.timeout,
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
