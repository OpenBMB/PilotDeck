from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

from .audit import audit_docx
from .core import compare_docx, create_docx, edit_docx, inspect_docx, sanitize_docx
from .render import find_soffice, render_docx
from .review import finalize_docx, review_docx


def _dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def run_smoke_test() -> dict[str, Any]:
    steps: list[str] = []
    with tempfile.TemporaryDirectory(prefix="pilotdeck_docx_smoke_") as temp_dir:
        root = Path(temp_dir)
        create_spec = root / "create.json"
        _dump(
            create_spec,
            {
                "preset": "business-report",
                "locale": "en-US",
                "metadata": {"title": "2025 Program Report", "author": "PilotDeck Test"},
                "header": "INTERNAL",
                "footer": "PilotDeck",
                "content": [
                    {"type": "title", "text": "2025 Program Report"},
                    {"type": "heading", "level": 1, "text": "Program Overview"},
                    {"type": "paragraph", "text": "Launch is planned for May with 20% growth."},
                    {"type": "bullet", "text": "Complete requirements analysis"},
                    {
                        "type": "callout",
                        "label": "Decision",
                        "text": "Proceed after the final readiness review.",
                    },
                    {
                        "type": "checklist",
                        "items": ["Confirm owner", "Confirm launch date"],
                    },
                    {
                        "type": "table",
                        "headers": ["Workstream", "Status"],
                        "rows": [["Requirements", "Complete"], ["Development", "In progress"]],
                        "column_widths": [3, 1],
                        "alignments": ["left", "center"],
                    },
                ],
            },
        )
        created = root / "created.docx"
        create_docx(create_spec, created)
        steps.append("create")
        inspected = inspect_docx(created, root / "created-inspect.json")
        assert inspected["table_count"] == 1
        assert any("Program Overview" in item["text"] for item in inspected["headings"])
        steps.append("inspect")

        audit = audit_docx(created, root / "created-audit.json", profile="accessible")
        assert audit["status"] == "ok"
        assert not any(item["code"] == "table-width-not-explicit" for item in audit["issues"])
        steps.append("audit")

        patch = root / "patch.json"
        _dump(
            patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "2025 Program",
                        "replacement": "2026 Program",
                        "occurrence": "all",
                    },
                    {"action": "append_paragraph", "text": "Additional note."},
                ]
            },
        )
        edited = root / "edited.docx"
        edit_result = edit_docx(created, patch, edited)
        assert sum(item["affected"] for item in edit_result["operations"]) >= 2
        steps.append("edit")

        review_spec = root / "review.json"
        _dump(
            review_spec,
            {
                "comments": [
                    {"match": "20% growth", "text": "Add the supporting data source.", "author": "PilotDeck"}
                ],
                "tracked_replacements": [
                    {
                        "match": "Launch is planned for May",
                        "replacement": "Launch is planned for June",
                        "author": "PilotDeck",
                    }
                ],
            },
        )
        reviewed = root / "reviewed.docx"
        review_docx(edited, review_spec, reviewed)
        reviewed_info = inspect_docx(reviewed)
        assert len(reviewed_info["comments"]) == 1
        assert reviewed_info["tracked_changes"] == {"insertions": 1, "deletions": 1}
        steps.append("review")

        final = root / "final.docx"
        finalize_docx(reviewed, final, accept_changes=True, remove_comments=True)
        final_info = inspect_docx(final)
        assert not final_info["comments"]
        assert final_info["tracked_changes"] == {"insertions": 0, "deletions": 0}
        assert any("June" in item["text"] for item in final_info["paragraphs"])
        steps.append("finalize")

        clean = root / "clean.docx"
        sanitize_docx(final, clean)
        clean_info = inspect_docx(clean)
        assert clean_info["metadata"]["author"] in {"", None}
        steps.append("sanitize")

        comparison = compare_docx(created, clean, root / "diff.json")
        assert comparison["diff"]
        steps.append("compare")

        rendered_pages = 0
        if find_soffice():
            render_result = render_docx(clean, root / "rendered", dpi=96)
            rendered_pages = render_result["pages"]
            assert rendered_pages >= 1
            assert all(Path(path).is_file() for path in render_result["images"])
            steps.append("render")

    return {
        "status": "ok",
        "steps": steps,
        "rendered_pages": rendered_pages,
    }
