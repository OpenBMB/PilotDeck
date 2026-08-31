from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from docx import Document

from .annotations import annotate_docx, finalize_docx
from .common import assert_valid_docx, file_sha256
from .core import compare_docx, inspect_docx, sanitize_docx
from .delivery import deliver_docx
from .render import find_soffice, render_docx


def _create_candidate(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = Document()
    document.add_heading("项目简报", level=0)
    document.add_paragraph("这是模型直接使用 python-docx 生成的正文。")
    table = document.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "事项"
    table.rows[0].cells[1].text = "状态"
    row = table.add_row().cells
    row[0].text = "视觉检查"
    row[1].text = "待完成"
    document.save(path)


def _edit_candidate(source: Path, output: Path) -> None:
    document = Document(source)
    changed = 0
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                if "待完成" in cell.text:
                    cell.text = cell.text.replace("待完成", "完成")
                    changed += 1
    if changed != 1:
        raise AssertionError(f"expected one direct edit, got {changed}")
    document.save(output)


def run_smoke_test() -> dict[str, Any]:
    previous_work_dir = os.environ.get("PILOTDECK_WORK_DIR")
    previous_workspace = os.environ.get("PILOTDECK_WORKSPACE_CWD")
    checks: list[str] = []
    try:
        with tempfile.TemporaryDirectory(prefix="pilotdeck_docx_smoke_") as temporary:
            root = Path(temporary)
            work = root / ".pilotdeck" / "work" / "turn"
            project = root / "project"
            work.mkdir(parents=True)
            project.mkdir()
            os.environ["PILOTDECK_WORK_DIR"] = str(work)
            os.environ["PILOTDECK_WORKSPACE_CWD"] = str(project)

            candidate = work / "docx" / "tmp" / "candidate.docx"
            _create_candidate(candidate)
            validation = assert_valid_docx(candidate)
            assert validation["status"] == "ok"
            inspected = inspect_docx(candidate)
            assert any(item["text"] == "项目简报" for item in inspected["paragraphs"])
            assert inspected["table_count"] == 1
            checks.extend(("direct-python-docx", "validate", "inspect"))

            first_render_dir: str | None = None
            if find_soffice():
                rendered = render_docx(candidate, work / "docx" / "review" / "latest")
                assert rendered["status"] == "ok"
                assert rendered["images"]
                assert all(Path(image).is_file() for image in rendered["images"])
                first_render_dir = rendered["out_dir"]
                checks.append("render")

            source_hash = file_sha256(candidate)
            edited = work / "docx" / "tmp" / "edited.docx"
            _edit_candidate(candidate, edited)
            assert file_sha256(candidate) == source_hash
            assert "完成" in "\n".join(
                item["text"] for item in inspect_docx(edited)["paragraphs"]
            )
            checks.append("source-preserving-direct-edit")
            if first_render_dir is not None:
                edited_render = render_docx(
                    edited,
                    work / "docx" / "review" / "latest",
                )
                assert edited_render["out_dir"] != first_render_dir
                checks.append("revision-specific-render")

            comparison_path = work / "docx" / "review" / "comparison.json"
            comparison = compare_docx(candidate, edited, comparison_path)
            assert comparison["diff"]
            checks.append("compare")

            sanitized = work / "docx" / "tmp" / "sanitized.docx"
            sanitize_docx(edited, sanitized)
            assert_valid_docx(sanitized)
            checks.append("sanitize")

            annotation_spec = work / "docx" / "tmp" / "annotations.json"
            annotation_spec.write_text(
                json.dumps(
                    {
                        "comments": [
                            {
                                "match": "项目简报",
                                "text": "请确认标题。",
                                "author": "PilotDeck",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            annotated = work / "docx" / "tmp" / "annotated.docx"
            annotate_docx(edited, annotation_spec, annotated)
            assert len(inspect_docx(annotated)["comments"]) == 1
            clean = work / "docx" / "tmp" / "clean.docx"
            finalize_docx(annotated, clean, remove_comments=True)
            assert inspect_docx(clean)["comments"] == []
            checks.append("annotations-finalize")

            final = project / "项目简报.docx"
            delivered = deliver_docx(clean, final, source_path=candidate)
            assert delivered["status"] == "ok"
            assert file_sha256(final) == file_sha256(clean)
            assert file_sha256(candidate) == source_hash
            checks.append("atomic-delivery")

            return {
                "status": "ok",
                "checks": checks,
                "count": len(checks),
                "render_backend": "LibreOffice" if find_soffice() else None,
            }
    finally:
        if previous_work_dir is None:
            os.environ.pop("PILOTDECK_WORK_DIR", None)
        else:
            os.environ["PILOTDECK_WORK_DIR"] = previous_work_dir
        if previous_workspace is None:
            os.environ.pop("PILOTDECK_WORKSPACE_CWD", None)
        else:
            os.environ["PILOTDECK_WORKSPACE_CWD"] = previous_workspace
