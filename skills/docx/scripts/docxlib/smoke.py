from __future__ import annotations

import json
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from .accessibility import inspect_accessibility
from .annotations import annotate_docx, finalize_docx
from .builder import replace_text, run_builder, scaffold_builder
from .common import assert_valid_docx, file_sha256
from .core import compare_docx, inspect_docx, sanitize_docx
from .delivery import deliver_docx
from .evaluation import run_evaluator
from .fallback import fallback_patch
from .render import find_soffice
from .review import review_candidate


BUILDER_SOURCE = '''from docxlib.builder import BuildContext, add_table, add_toc


def build(context: BuildContext) -> None:
    document = context.new_document(locale="zh-CN")
    document.add_heading("项目简报", level=0)
    document.add_paragraph("这是用于验证轻量 DOCX builder 的正文。")
    document.add_heading("目录", level=1)
    add_toc(document, document.add_paragraph(), placeholder="在 Word 中更新目录")
    document.add_heading("进展", level=1)
    add_table(document, ["事项", "状态"], [["结构", "完成"], ["视觉", "待检查"]], widths=[3, 1])
    context.save(document)
'''


EDIT_BUILDER_SOURCE = '''from docxlib.builder import BuildContext, replace_text


def build(context: BuildContext) -> None:
    document = context.load_document()
    affected = replace_text(document, "待检查", "完成")
    if affected != 1:
        raise RuntimeError(f"expected one replacement, got {affected}")
    context.save(document)
'''


DROP_TOC_BUILDER_SOURCE = '''from docxlib.builder import BuildContext


def build(context: BuildContext) -> None:
    document = context.load_document()
    for paragraph in list(document.paragraphs):
        instructions = paragraph._p.xpath(".//w:instrText")
        if any((node.text or "").strip().startswith("TOC ") for node in instructions):
            paragraph._element.getparent().remove(paragraph._element)
    context.save(document)
'''


EVALUATOR_SOURCE = '''import argparse
import json
import zipfile


parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--out", required=True)
args = parser.parse_args()
with zipfile.ZipFile(args.input) as archive:
    text = archive.read("word/document.xml").decode("utf-8")
result = {"passed": "项目简报" in text and "进展" in text}
with open(args.out, "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=False)
'''


def _append_hyperlink_run(paragraph: Any, text: str) -> None:
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("w:anchor"), "replacement-test")
    run = OxmlElement("w:r")
    text_element = OxmlElement("w:t")
    text_element.text = text
    run.append(text_element)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


PATCH_SOURCE = '''import argparse
from lxml import etree


parser = argparse.ArgumentParser()
parser.add_argument("--package-dir", required=True)
args = parser.parse_args()
path = __import__("pathlib").Path(args.package_dir) / "docProps" / "core.xml"
tree = etree.parse(str(path))
root = tree.getroot()
namespace = {"dc": "http://purl.org/dc/elements/1.1/"}
node = root.find("dc:title", namespace)
if node is None:
    node = etree.SubElement(root, "{http://purl.org/dc/elements/1.1/}title")
node.text = "Patched title"
tree.write(str(path), encoding="UTF-8", xml_declaration=True, standalone=True)
'''


def _write(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


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

            builder = work / "docx" / "tmp" / "document.py"
            scaffold_builder(builder)
            starter_candidate = work / "docx" / "tmp" / "starter.docx"
            run_builder(builder, starter_candidate)
            assert_valid_docx(starter_candidate)
            checks.append("starter-builder")
            _write(builder, BUILDER_SOURCE)
            candidate = work / "docx" / "tmp" / "candidate.docx"
            built = run_builder(builder, candidate)
            assert built["status"] == "ok"
            assert_valid_docx(candidate)
            inspected = inspect_docx(candidate)
            assert any(item["text"] == "项目简报" for item in inspected["paragraphs"])
            assert inspected["table_count"] == 1
            assert any(
                item["instruction"].startswith('TOC \\o "1-3" \\h \\z \\u')
                for item in inspected["fields"]
            )
            with zipfile.ZipFile(candidate) as archive:
                document_xml = archive.read("word/document.xml")
                settings_xml = archive.read("word/settings.xml")
            assert b'w:dirty="true"' in document_xml
            assert b"w:updateFields" in settings_xml
            assert b'w:val="true"' in settings_xml
            accessibility = inspect_accessibility(candidate)
            assert accessibility["status"] == "ok"
            assert "passed" not in accessibility
            checks.extend(
                ("scaffold-build", "inspect-structure", "toc-field", "accessibility-evidence")
            )

            evaluation_script = work / "docx" / "tmp" / "evaluator.py"
            evaluation_output = work / "docx" / "review" / "evaluation.json"
            _write(evaluation_script, EVALUATOR_SOURCE)
            evaluation = run_evaluator(candidate, evaluation_script, evaluation_output)
            assert evaluation["evaluation"]["passed"] is True
            checks.append("task-evaluator")

            if find_soffice():
                first_review = review_candidate(candidate, work / "docx" / "review")
                assert first_review["status"] == "review_pending"
                assert first_review["visual_evidence"]["pages"]
                assert all(Path(item["image"]).is_file() for item in first_review["visual_evidence"]["pages"])
                assert "pdf" not in first_review["visual_evidence"]
                assert all("layout" not in item for item in first_review["visual_evidence"]["pages"])
                assert Path(first_review["report"]).is_file()
                checks.append("revision-review")

            final = project / "项目简报.docx"
            delivered = deliver_docx(candidate, final)
            assert delivered["status"] == "ok"
            assert file_sha256(final) == file_sha256(candidate)
            checks.append("atomic-delivery")

            edit_builder = work / "docx" / "tmp" / "edit.py"
            _write(edit_builder, EDIT_BUILDER_SOURCE)
            source_hash = file_sha256(final)
            edited = work / "docx" / "tmp" / "edited.docx"
            run_builder(edit_builder, edited, input_path=final)
            assert file_sha256(final) == source_hash
            assert "完成" in "\n".join(item["text"] for item in inspect_docx(edited)["paragraphs"])
            replacement_document = Document()
            replacement_paragraph = replacement_document.add_paragraph("foo foo")
            assert replace_text(replacement_document, "foo", "foobar") == 2
            assert replacement_paragraph.text == "foobar foobar"
            assert replace_text(replacement_document, "foobar", "foobar") == 2
            assert replacement_paragraph.text == "foobar foobar"

            hyperlink_document = Document()
            hyperlink_paragraph = hyperlink_document.add_paragraph()
            _append_hyperlink_run(hyperlink_paragraph, "foo")
            assert replace_text(hyperlink_document, "foo", "bar") == 1
            assert hyperlink_paragraph.text == "bar"

            boundary_document = Document()
            boundary_paragraph = boundary_document.add_paragraph("fo")
            _append_hyperlink_run(boundary_paragraph, "o")
            assert replace_text(boundary_document, "foo", "bar") == 1
            assert boundary_paragraph.text == "bar"

            empty_document = Document()
            empty_paragraph = empty_document.add_paragraph()
            _append_hyperlink_run(empty_paragraph, "foo")
            assert replace_text(empty_document, "foo", "") == 1
            assert empty_paragraph.text == ""
            checks.extend(
                (
                    "source-preserving-edit",
                    "replacement-forward-progress",
                    "replacement-hyperlink-runs",
                )
            )

            comparison_path = work / "docx" / "review" / "comparison.json"
            comparison = compare_docx(candidate, edited, comparison_path)
            assert comparison["diff"]
            assert comparison["fields_removed"] == []
            assert comparison["fields_added"] == []

            drop_toc_builder = work / "docx" / "tmp" / "drop_toc.py"
            _write(drop_toc_builder, DROP_TOC_BUILDER_SOURCE)
            without_toc = work / "docx" / "tmp" / "without_toc.docx"
            run_builder(drop_toc_builder, without_toc, input_path=candidate)
            field_comparison_path = work / "docx" / "review" / "field-comparison.json"
            field_comparison = compare_docx(candidate, without_toc, field_comparison_path)
            assert field_comparison["fields_added"] == []
            assert field_comparison["fields_removed"] == [
                {
                    "part": "word/document.xml",
                    "instruction": 'TOC \\o "1-3" \\h \\z \\u',
                    "form": "complex",
                    "count": 1,
                }
            ]
            sanitized = work / "docx" / "tmp" / "sanitized.docx"
            sanitize_docx(edited, sanitized)
            assert_valid_docx(sanitized)
            checks.extend(("compare", "field-delta", "sanitize"))

            annotation_spec = work / "docx" / "tmp" / "annotations.json"
            annotation_spec.write_text(
                json.dumps(
                    {
                        "comments": [
                            {"match": "项目简报", "text": "请确认标题。", "author": "PilotDeck"}
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

            patch_script = work / "docx" / "tmp" / "patch.py"
            patch_report = work / "docx" / "review" / "fallback.json"
            patched = work / "docx" / "tmp" / "patched.docx"
            _write(patch_script, PATCH_SOURCE)
            fallback = fallback_patch(
                clean,
                patch_script,
                patched,
                patch_report,
                allow_parts=["docProps/core.xml"],
                reason="Smoke-test a scoped metadata patch.",
            )
            assert fallback["changed_parts"] == ["docProps/core.xml"]
            assert inspect_docx(patched)["metadata"]["title"] == "Patched title"
            checks.append("scoped-fallback")

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
