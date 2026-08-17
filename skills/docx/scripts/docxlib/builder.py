from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt
from docx.text.hyperlink import Hyperlink
from docx.text.paragraph import Paragraph
from docx.text.run import Run

from .common import (
    DocxSkillError,
    assert_internal_control_path,
    assert_safe_mutation,
    assert_valid_docx,
    blocked,
    file_sha256,
    prepare_output_docx_path,
    require_docx_path,
    temporary_sibling,
)


SAFE_BUILDER_ENVIRONMENT = (
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
)


def _set_style_fonts(style: Any, latin: str, east_asia: str, size: float) -> None:
    style.font.name = latin
    style.font.size = Pt(size)
    properties = style.element.get_or_add_rPr()
    fonts = properties.rFonts
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        properties.insert(0, fonts)
    for attribute, value in (
        ("w:ascii", latin),
        ("w:hAnsi", latin),
        ("w:eastAsia", east_asia),
        ("w:cs", latin),
    ):
        fonts.set(qn(attribute), value)


def apply_neutral_styles(
    document: DocumentObject,
    *,
    locale: str,
    latin_font: str = "Arial",
    east_asia_font: str | None = None,
) -> DocumentObject:
    """Apply a restrained starting point without imposing a document design."""

    chinese = locale.casefold().startswith(("zh", "cmn"))
    cjk_font = east_asia_font or ("Songti SC" if sys.platform == "darwin" else "SimSun")
    normal = document.styles["Normal"]
    _set_style_fonts(normal, latin_font, cjk_font, 10.5 if chinese else 11)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.25

    heading_sizes = (18, 15, 12.5)
    for level, size in enumerate(heading_sizes, start=1):
        style = document.styles[f"Heading {level}"]
        _set_style_fonts(style, latin_font, cjk_font, size)
        style.font.bold = True
        style.font.color.rgb = None
        style.paragraph_format.space_before = Pt(12 if level == 1 else 9)
        style.paragraph_format.space_after = Pt(5)
        style.paragraph_format.keep_with_next = True

    title = document.styles["Title"]
    _set_style_fonts(title, latin_font, cjk_font, 22)
    title.font.bold = True
    title.font.color.rgb = None
    title.paragraph_format.space_after = Pt(10)

    if "Caption" in document.styles:
        caption = document.styles["Caption"]
        _set_style_fonts(caption, latin_font, cjk_font, 9)
        caption.font.italic = False
        caption.font.color.rgb = None
        caption.paragraph_format.keep_with_next = True

    for section in document.sections:
        section.top_margin = Inches(0.8)
        section.right_margin = Inches(0.8)
        section.bottom_margin = Inches(0.8)
        section.left_margin = Inches(0.8)
    return document


def add_table(
    document: DocumentObject,
    headers: list[str],
    rows: list[list[Any]],
    *,
    widths: list[float] | None = None,
    repeat_header: bool = True,
) -> Any:
    if not headers:
        raise ValueError("headers must not be empty")
    if any(len(row) != len(headers) for row in rows):
        raise ValueError("every table row must match the header column count")
    table = document.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False
    try:
        table.style = "Table Grid"
    except KeyError:
        pass
    for cell, value in zip(table.rows[0].cells, headers):
        cell.text = str(value)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        for run in cell.paragraphs[0].runs:
            run.bold = True
    if repeat_header:
        properties = table.rows[0]._tr.get_or_add_trPr()
        repeat = OxmlElement("w:tblHeader")
        repeat.set(qn("w:val"), "true")
        properties.append(repeat)
    for values in rows:
        cells = table.add_row().cells
        for cell, value in zip(cells, values):
            cell.text = "" if value is None else str(value)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    if widths:
        if len(widths) != len(headers) or any(value <= 0 for value in widths):
            raise ValueError("widths must contain one positive value per column")
        available = document.sections[-1].page_width - document.sections[-1].left_margin - document.sections[-1].right_margin
        total = sum(widths)
        for row in table.rows:
            for index, cell in enumerate(row.cells):
                cell.width = int(available * widths[index] / total)
    return table


def add_image(
    document: DocumentObject,
    path: str | Path,
    *,
    width_inches: float = 5.8,
    caption: str | None = None,
    alt_text: str | None = None,
) -> Any:
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.line_spacing = None
    inline = paragraph.add_run().add_picture(str(Path(path).expanduser().resolve()), width=Inches(width_inches))
    if alt_text is not None:
        properties = inline._inline.docPr
        properties.set("descr", alt_text)
        properties.set("title", alt_text)
    if caption:
        paragraph.paragraph_format.keep_with_next = True
        caption_paragraph = document.add_paragraph(caption)
        try:
            caption_paragraph.style = "Caption"
        except KeyError:
            pass
        caption_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    return inline


def add_field(paragraph: Any, instruction: str, placeholder: str = "") -> None:
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    begin.set(qn("w:dirty"), "true")
    text = OxmlElement("w:instrText")
    text.set(qn("xml:space"), "preserve")
    text.text = instruction
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend((begin, text, separate))
    if placeholder:
        run._r.append(OxmlElement("w:t"))
        run._r[-1].text = placeholder
    run._r.append(end)


def add_toc(
    document: DocumentObject,
    paragraph: Any,
    *,
    levels: tuple[int, int] = (1, 3),
    placeholder: str = "Open in Microsoft Word to update the table of contents.",
) -> Any:
    """Insert a real Word TOC field and request a field refresh on open."""

    start, end = levels
    if not (1 <= start <= end <= 9):
        raise ValueError("levels must be an inclusive range between 1 and 9")
    add_field(
        paragraph,
        f'TOC \\o "{start}-{end}" \\h \\z \\u',
        placeholder=placeholder,
    )
    settings = document.settings.element
    update_fields = settings.find(qn("w:updateFields"))
    if update_fields is None:
        update_fields = OxmlElement("w:updateFields")
        settings.append(update_fields)
    update_fields.set(qn("w:val"), "true")
    return paragraph


def _iter_paragraph_runs(paragraph: Paragraph) -> Iterator[Run]:
    """Yield direct and hyperlink runs in their paragraph text order."""

    for content in paragraph.iter_inner_content():
        if isinstance(content, Run):
            yield content
        elif isinstance(content, Hyperlink):
            yield from content.runs


def replace_text(document: DocumentObject, match: str, replacement: str) -> int:
    """Replace text across adjacent runs while preserving surrounding formatting."""

    if not match:
        raise ValueError("match must not be empty")
    from .core import iter_document_paragraphs

    affected = 0
    for _, paragraph in iter_document_paragraphs(document):
        search_from = 0
        while True:
            start = paragraph.text.find(match, search_from)
            if start < 0:
                break
            end = start + len(match)
            cursor = 0
            first_run = None
            for run in _iter_paragraph_runs(paragraph):
                run_start = cursor
                run_end = cursor + len(run.text)
                cursor = run_end
                if run_end <= start or run_start >= end:
                    continue
                if first_run is None:
                    first_run = run
                    local_start = max(0, start - run_start)
                    run.text = run.text[:local_start] + replacement + run.text[max(0, end - run_start):]
                else:
                    local_start = max(0, start - run_start)
                    local_end = min(len(run.text), end - run_start)
                    run.text = run.text[:local_start] + run.text[local_end:]
            if first_run is None:
                # paragraph.text should be composed from the runs above. If an
                # unsupported OOXML container contributes text, skip it without
                # reporting a replacement or repeatedly matching the same text.
                search_from = end
                continue
            affected += 1
            # Continue after the inserted replacement. Searching the mutated
            # paragraph from the beginning would repeatedly match replacement
            # text that contains `match` (including an unchanged replacement).
            search_from = start + len(replacement)
    return affected


@dataclass(frozen=True)
class BuildContext:
    input_path: Path | None
    output_path: Path

    def new_document(self, *, locale: str) -> DocumentObject:
        return apply_neutral_styles(Document(), locale=locale)

    def load_document(self) -> DocumentObject:
        if self.input_path is None:
            raise RuntimeError("This builder was not given an input document")
        return Document(str(self.input_path))

    def save(self, document: DocumentObject) -> None:
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        document.save(str(self.output_path))


STARTER_BUILDER = '''from docxlib.builder import BuildContext, add_image, add_table, replace_text


def build(context: BuildContext) -> None:
    # For a new document, start from neutral styles. For an edit, use
    # document = context.load_document() and preserve the source's visual language.
    # Choose the locale to match the document, for example "zh-CN" or "en-US".
    document = context.new_document(locale="en-US")
    document.add_heading("Document title", level=0)
    document.add_paragraph("Replace this scaffold with content derived from the request and sources.")
    context.save(document)
'''


def scaffold_builder(output_path: str | Path, *, overwrite: bool = False) -> dict[str, Any]:
    output = assert_internal_control_path(output_path, purpose="DOCX builder")
    if output.suffix.lower() != ".py":
        raise DocxSkillError("The DOCX builder must use a .py path")
    if output.exists() and not overwrite:
        raise blocked("The builder already exists", code="builder-exists", details={"builder": str(output)})
    output.parent.mkdir(parents=True, exist_ok=True)
    with temporary_sibling(output, suffix=".tmp.py") as temporary:
        temporary.write_text(STARTER_BUILDER, encoding="utf-8")
        os.replace(temporary, output)
    return {"status": "ok", "builder": str(output)}


def _builder_environment() -> dict[str, str]:
    environment = {key: os.environ[key] for key in SAFE_BUILDER_ENVIRONMENT if key in os.environ}
    scripts_root = Path(__file__).resolve().parents[1]
    environment.update(
        {
            "PYTHONNOUSERSITE": "1",
            "PYTHONUTF8": "1",
            "PYTHONPATH": str(scripts_root),
        }
    )
    return environment


def run_builder(
    builder_path: str | Path,
    output_path: str | Path,
    *,
    input_path: str | Path | None = None,
    overwrite: bool = False,
    timeout_seconds: int = 180,
) -> dict[str, Any]:
    builder = assert_internal_control_path(builder_path, purpose="DOCX builder")
    if not builder.is_file() or builder.suffix.lower() != ".py":
        raise DocxSkillError(f"DOCX builder not found: {builder}")
    output = prepare_output_docx_path(output_path, overwrite=overwrite)
    source = require_docx_path(input_path) if input_path is not None else None
    if source is not None:
        if source == output:
            raise blocked("The builder must not overwrite its input", code="source-overwrite-blocked")
        assert_safe_mutation(source, operation="build")
        from .core import inspect_docx

        features = inspect_docx(source).get("package_features", {})
        sensitive = {
            name: features.get(name)
            for name in ("embeddings", "charts", "diagrams", "content_controls", "custom_xml_nonstandard")
            if features.get(name)
        }
        if sensitive:
            raise blocked(
                "The input contains package-sensitive features that a python-docx round trip may not preserve. Use fallback-patch for a targeted OOXML edit.",
                code="package-sensitive-edit",
                details={"features": sensitive},
            )

    with temporary_sibling(output, suffix=".tmp.docx") as temporary:
        temporary.unlink(missing_ok=True)
        command = [sys.executable, "-m", "docxlib.builder_runner", "--builder", str(builder), "--out", str(temporary)]
        if source is not None:
            command.extend(("--input", str(source)))
        try:
            process = subprocess.run(
                command,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=timeout_seconds,
                cwd=str(builder.parent),
                env=_builder_environment(),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise DocxSkillError(f"DOCX builder timed out after {timeout_seconds} seconds", code="builder-timeout") from exc
        if process.returncode != 0 or not temporary.is_file():
            raise DocxSkillError(
                "DOCX builder failed",
                code="builder-failed",
                details={"stdout": process.stdout[-4000:], "stderr": process.stderr[-4000:]},
            )
        validation = assert_valid_docx(temporary)
        os.replace(temporary, output)
    return {
        "status": "ok",
        "input": str(source) if source is not None else None,
        "builder": str(builder),
        "out": str(output),
        "sha256": file_sha256(output),
        "validation": validation,
    }
