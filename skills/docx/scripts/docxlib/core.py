from __future__ import annotations

import difflib
import os
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Iterator

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Mm, Pt, RGBColor
from docx.table import _Cell, Table
from docx.text.paragraph import Paragraph
from lxml import etree

from .common import (
    DocxSkillError,
    assert_valid_docx,
    load_json,
    pack_docx,
    require_distinct_paths,
    require_docx_path,
    unpacked_copy,
    write_json,
)


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"w": W_NS, "r": R_NS}

PRESETS: dict[str, dict[str, Any]] = {
    "business-report": {
        "body_font": "Arial",
        "east_asia_font": "Microsoft YaHei",
        "body_size": 10.5,
        "title_size": 24,
        "heading_color": "1F4E79",
        "accent": "D9EAF7",
        "space_after": 6,
    },
    "formal-memo": {
        "body_font": "Times New Roman",
        "east_asia_font": "SimSun",
        "body_size": 11,
        "title_size": 22,
        "heading_color": "222222",
        "accent": "E7E6E6",
        "space_after": 5,
    },
    "proposal": {
        "body_font": "Aptos",
        "east_asia_font": "Microsoft YaHei",
        "body_size": 10.5,
        "title_size": 26,
        "heading_color": "2F5597",
        "accent": "DEEAF6",
        "space_after": 7,
    },
    "sop": {
        "body_font": "Arial",
        "east_asia_font": "Microsoft YaHei",
        "body_size": 10,
        "title_size": 22,
        "heading_color": "375623",
        "accent": "E2F0D9",
        "space_after": 4,
    },
    "simple-document": {
        "body_font": "Arial",
        "east_asia_font": "Microsoft YaHei",
        "body_size": 11,
        "title_size": 22,
        "heading_color": "000000",
        "accent": "F2F2F2",
        "space_after": 6,
    },
}


def _set_run_fonts(run: Any, ascii_font: str, east_asia_font: str) -> None:
    run.font.name = ascii_font
    r_pr = run._element.get_or_add_rPr()
    r_fonts = r_pr.rFonts
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.insert(0, r_fonts)
    r_fonts.set(qn("w:ascii"), ascii_font)
    r_fonts.set(qn("w:hAnsi"), ascii_font)
    r_fonts.set(qn("w:eastAsia"), east_asia_font)
    r_fonts.set(qn("w:cs"), ascii_font)


def _set_style_fonts(style: Any, ascii_font: str, east_asia_font: str, size: float) -> None:
    style.font.name = ascii_font
    style.font.size = Pt(size)
    r_pr = style.element.get_or_add_rPr()
    r_fonts = r_pr.rFonts
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.insert(0, r_fonts)
    for attr, value in (
        ("w:ascii", ascii_font),
        ("w:hAnsi", ascii_font),
        ("w:eastAsia", east_asia_font),
        ("w:cs", ascii_font),
    ):
        r_fonts.set(qn(attr), value)


def _iter_table_paragraphs(table: Table, prefix: str) -> Iterator[tuple[str, Paragraph]]:
    for row_index, row in enumerate(table.rows):
        for col_index, cell in enumerate(row.cells):
            location = f"{prefix}.r{row_index + 1}.c{col_index + 1}"
            for paragraph in cell.paragraphs:
                yield location, paragraph
            for nested_index, nested in enumerate(cell.tables):
                yield from _iter_table_paragraphs(nested, f"{location}.table{nested_index + 1}")


def iter_document_paragraphs(doc: DocumentObject) -> Iterator[tuple[str, Paragraph]]:
    for paragraph in doc.paragraphs:
        yield "body", paragraph
    for table_index, table in enumerate(doc.tables):
        yield from _iter_table_paragraphs(table, f"table{table_index + 1}")

    seen_parts: set[str] = set()
    for section_index, section in enumerate(doc.sections):
        for label, part in (("header", section.header), ("footer", section.footer)):
            part_name = str(part.part.partname)
            if part_name in seen_parts:
                continue
            seen_parts.add(part_name)
            for paragraph in part.paragraphs:
                yield f"section{section_index + 1}.{label}", paragraph
            for table_index, table in enumerate(part.tables):
                yield from _iter_table_paragraphs(
                    table, f"section{section_index + 1}.{label}.table{table_index + 1}"
                )


def _paragraph_record(index: int, location: str, paragraph: Paragraph) -> dict[str, Any]:
    return {
        "index": index,
        "location": location,
        "text": paragraph.text,
        "style": paragraph.style.name if paragraph.style else None,
        "alignment": str(paragraph.alignment) if paragraph.alignment is not None else None,
        "runs": [
            {
                "text": run.text,
                "bold": run.bold,
                "italic": run.italic,
                "underline": run.underline,
                "font": run.font.name,
                "size_pt": run.font.size.pt if run.font.size else None,
            }
            for run in paragraph.runs
            if run.text
        ],
    }


def _ooxml_summary(docx_path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "comments": [],
        "tracked_changes": {"insertions": 0, "deletions": 0},
        "fields": [],
        "image_parts": 0,
        "external_relationships": [],
    }
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    with zipfile.ZipFile(docx_path) as archive:
        names = set(archive.namelist())
        document_root = etree.fromstring(archive.read("word/document.xml"), parser)
        result["tracked_changes"] = {
            "insertions": len(document_root.findall(".//w:ins", NS)),
            "deletions": len(document_root.findall(".//w:del", NS)),
        }
        fields: list[str] = []
        for node in document_root.findall(".//w:instrText", NS):
            value = " ".join((node.text or "").split())
            if value:
                fields.append(value)
        result["fields"] = fields
        result["image_parts"] = len(
            [name for name in names if name.startswith("word/media/") and not name.endswith("/")]
        )

        if "word/comments.xml" in names:
            comments_root = etree.fromstring(archive.read("word/comments.xml"), parser)
            for comment in comments_root.findall("w:comment", NS):
                text = "".join(comment.xpath(".//w:t/text()", namespaces=NS))
                result["comments"].append(
                    {
                        "id": comment.get(qn("w:id")),
                        "author": comment.get(qn("w:author")),
                        "date": comment.get(qn("w:date")),
                        "text": text,
                    }
                )

        rel_name = "word/_rels/document.xml.rels"
        if rel_name in names:
            rel_root = etree.fromstring(archive.read(rel_name), parser)
            rel_ns = {"pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
            for rel in rel_root.findall("pr:Relationship", rel_ns):
                if rel.get("TargetMode") == "External":
                    result["external_relationships"].append(
                        {"type": rel.get("Type"), "target": rel.get("Target")}
                    )
    return result


def inspect_docx(input_path: str | Path, output_json: str | Path | None = None) -> dict[str, Any]:
    path = require_docx_path(input_path)
    validation = assert_valid_docx(path)
    doc = Document(str(path))

    paragraphs: list[dict[str, Any]] = []
    headings: list[dict[str, Any]] = []
    for index, (location, paragraph) in enumerate(iter_document_paragraphs(doc), start=1):
        if not paragraph.text and not paragraph.runs:
            continue
        record = _paragraph_record(index, location, paragraph)
        paragraphs.append(record)
        if record["style"] and str(record["style"]).lower().startswith("heading"):
            headings.append(record)

    tables: list[dict[str, Any]] = []
    for table_index, table in enumerate(doc.tables, start=1):
        tables.append(
            {
                "index": table_index,
                "rows": len(table.rows),
                "columns": len(table.columns),
                "style": table.style.name if table.style else None,
                "cells": [[cell.text for cell in row.cells] for row in table.rows],
            }
        )

    sections = []
    for index, section in enumerate(doc.sections, start=1):
        sections.append(
            {
                "index": index,
                "width_inches": section.page_width.inches,
                "height_inches": section.page_height.inches,
                "orientation": str(section.orientation),
                "margins_inches": {
                    "top": section.top_margin.inches,
                    "right": section.right_margin.inches,
                    "bottom": section.bottom_margin.inches,
                    "left": section.left_margin.inches,
                },
            }
        )

    props = doc.core_properties
    result = {
        "status": "ok",
        "input": str(path),
        "metadata": {
            "title": props.title,
            "subject": props.subject,
            "author": props.author,
            "last_modified_by": props.last_modified_by,
            "keywords": props.keywords,
            "category": props.category,
            "comments": props.comments,
        },
        "paragraphs": paragraphs,
        "headings": headings,
        "tables": tables,
        "sections": sections,
        "paragraph_count": len(paragraphs),
        "table_count": len(tables),
        "validation": validation,
        **_ooxml_summary(path),
    }
    if output_json:
        write_json(output_json, result)
        result["out"] = str(Path(output_json).resolve())
    return result


def _configure_document(doc: DocumentObject, spec: dict[str, Any], preset: dict[str, Any]) -> None:
    page = str(spec.get("page", "a4")).lower()
    for section in doc.sections:
        if page == "letter":
            section.page_width = Inches(8.5)
            section.page_height = Inches(11)
        else:
            section.page_width = Mm(210)
            section.page_height = Mm(297)
        if str(spec.get("orientation", "portrait")).lower() == "landscape":
            section.orientation = WD_ORIENT.LANDSCAPE
            section.page_width, section.page_height = section.page_height, section.page_width
        margins = spec.get("margins_inches", {})
        section.top_margin = Inches(float(margins.get("top", 0.8)))
        section.right_margin = Inches(float(margins.get("right", 0.8)))
        section.bottom_margin = Inches(float(margins.get("bottom", 0.8)))
        section.left_margin = Inches(float(margins.get("left", 0.8)))

    styles = doc.styles
    normal = styles["Normal"]
    _set_style_fonts(normal, preset["body_font"], preset["east_asia_font"], preset["body_size"])
    normal.paragraph_format.space_after = Pt(preset["space_after"])
    normal.paragraph_format.line_spacing = 1.15
    for level in range(1, 4):
        style = styles[f"Heading {level}"]
        _set_style_fonts(
            style,
            preset["body_font"],
            preset["east_asia_font"],
            preset["body_size"] + (7 - level * 1.5),
        )
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(preset["heading_color"])
        style.paragraph_format.space_before = Pt(12 if level == 1 else 8)
        style.paragraph_format.space_after = Pt(5)


def _shade_cell(cell: _Cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def _format_paragraph_runs(paragraph: Paragraph, preset: dict[str, Any]) -> None:
    for run in paragraph.runs:
        _set_run_fonts(run, preset["body_font"], preset["east_asia_font"])


def _populate_paragraph(paragraph: Paragraph, block: dict[str, Any], preset: dict[str, Any]) -> None:
    runs = block.get("runs")
    if not isinstance(runs, list):
        paragraph.add_run(str(block.get("text", "")))
        _format_paragraph_runs(paragraph, preset)
        return
    for item in runs:
        if not isinstance(item, dict):
            raise DocxSkillError("Every rich-text run must be an object")
        run = paragraph.add_run(str(item.get("text", "")))
        _set_run_fonts(run, preset["body_font"], preset["east_asia_font"])
        run.bold = bool(item.get("bold", False))
        run.italic = bool(item.get("italic", False))
        run.underline = bool(item.get("underline", False))
        if item.get("color"):
            try:
                run.font.color.rgb = RGBColor.from_string(str(item["color"]).lstrip("#"))
            except ValueError as exc:
                raise DocxSkillError(f"Invalid rich-text color: {item['color']}") from exc
        if item.get("size_pt") is not None:
            run.font.size = Pt(float(item["size_pt"]))


def _set_paragraph_callout(paragraph: Paragraph, fill: str, accent: str) -> None:
    properties = paragraph._p.get_or_add_pPr()
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:fill"), fill)
    borders = properties.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        properties.append(borders)
    left = borders.find(qn("w:left"))
    if left is None:
        left = OxmlElement("w:left")
        borders.append(left)
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:space"), "8")
    left.set(qn("w:color"), accent)


def _set_cell_margins(cell: _Cell, *, top: int = 100, start: int = 120, bottom: int = 100, end: int = 120) -> None:
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.find(qn("w:tcMar"))
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for name, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{name}"))
        if node is None:
            node = OxmlElement(f"w:{name}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def _table_available_twips(doc: DocumentObject) -> int:
    section = doc.sections[-1]
    width_emu = int(section.page_width) - int(section.left_margin) - int(section.right_margin)
    return max(1, round(width_emu / 635))


def _column_widths_twips(
    block: dict[str, Any], headers: list[Any], rows: list[Any], column_count: int, total: int
) -> list[int]:
    requested = block.get("column_widths")
    if requested is not None:
        if not isinstance(requested, list) or len(requested) != column_count:
            raise DocxSkillError("column_widths must contain one positive number per table column")
        weights = [float(value) for value in requested]
        if any(value <= 0 for value in weights):
            raise DocxSkillError("column_widths values must be positive")
    else:
        values = [headers] + [row for row in rows if isinstance(row, list)]
        weights = []
        for column in range(column_count):
            longest = max((len(str(row[column])) for row in values if len(row) > column), default=8)
            weights.append(min(4.0, max(1.0, longest / 12.0)))
    weight_sum = sum(weights)
    widths = [max(240, round(total * weight / weight_sum)) for weight in weights]
    widths[-1] += total - sum(widths)
    return widths


def _set_table_geometry(table: Table, widths: list[int], total: int) -> None:
    table.autofit = False
    properties = table._tbl.tblPr
    table_width = properties.find(qn("w:tblW"))
    if table_width is None:
        table_width = OxmlElement("w:tblW")
        properties.insert(0, table_width)
    table_width.set(qn("w:w"), str(total))
    table_width.set(qn("w:type"), "dxa")
    layout = properties.find(qn("w:tblLayout"))
    if layout is None:
        layout = OxmlElement("w:tblLayout")
        properties.append(layout)
    layout.set(qn("w:type"), "fixed")
    indent = properties.find(qn("w:tblInd"))
    if indent is None:
        indent = OxmlElement("w:tblInd")
        properties.append(indent)
    indent.set(qn("w:w"), "0")
    indent.set(qn("w:type"), "dxa")

    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for width in widths:
        column = OxmlElement("w:gridCol")
        column.set(qn("w:w"), str(width))
        grid.append(column)

    for row in table.rows:
        for index, cell in enumerate(row.cells):
            properties = cell._tc.get_or_add_tcPr()
            cell_width = properties.find(qn("w:tcW"))
            if cell_width is None:
                cell_width = OxmlElement("w:tcW")
                properties.insert(0, cell_width)
            cell_width.set(qn("w:w"), str(widths[index]))
            cell_width.set(qn("w:type"), "dxa")
            _set_cell_margins(cell)


def _repeat_table_header(row: Any) -> None:
    properties = row._tr.get_or_add_trPr()
    header = properties.find(qn("w:tblHeader"))
    if header is None:
        header = OxmlElement("w:tblHeader")
        properties.append(header)
    header.set(qn("w:val"), "true")


def _column_alignment(value: str) -> Any:
    normalized = value.lower()
    if normalized == "center":
        return WD_ALIGN_PARAGRAPH.CENTER
    if normalized == "right":
        return WD_ALIGN_PARAGRAPH.RIGHT
    if normalized != "left":
        raise DocxSkillError(f"Unsupported table alignment: {value}")
    return WD_ALIGN_PARAGRAPH.LEFT


def _add_content_block(doc: DocumentObject, block: dict[str, Any], preset: dict[str, Any], base_dir: Path) -> None:
    block_type = str(block.get("type", "paragraph"))
    text = str(block.get("text", ""))
    if block_type == "title":
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.paragraph_format.space_after = Pt(14)
        _populate_paragraph(paragraph, block, preset)
        for run in paragraph.runs:
            run.font.size = run.font.size or Pt(preset["title_size"])
            run.bold = True if run.bold is None else run.bold
            if run.font.color.rgb is None:
                run.font.color.rgb = RGBColor.from_string(preset["heading_color"])
    elif block_type == "subtitle":
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        _populate_paragraph(paragraph, block, preset)
        for run in paragraph.runs:
            run.font.size = run.font.size or Pt(preset["body_size"] + 2)
            if run.font.color.rgb is None:
                run.font.color.rgb = RGBColor(89, 89, 89)
    elif block_type == "heading":
        level = max(1, min(3, int(block.get("level", 1))))
        paragraph = doc.add_heading("", level=level)
        _populate_paragraph(paragraph, block, preset)
    elif block_type in {"paragraph", "body"}:
        paragraph = doc.add_paragraph(style=str(block.get("style", "Normal")))
        _populate_paragraph(paragraph, block, preset)
        if block.get("bold"):
            for run in paragraph.runs:
                run.bold = True
    elif block_type == "bullet":
        paragraph = doc.add_paragraph(style="List Bullet")
        _populate_paragraph(paragraph, block, preset)
    elif block_type == "numbered":
        paragraph = doc.add_paragraph(style="List Number")
        _populate_paragraph(paragraph, block, preset)
    elif block_type == "quote":
        paragraph = doc.add_paragraph(style="Quote")
        _populate_paragraph(paragraph, block, preset)
        paragraph.paragraph_format.left_indent = Inches(0.3)
    elif block_type == "callout":
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.left_indent = Inches(0.15)
        paragraph.paragraph_format.right_indent = Inches(0.08)
        paragraph.paragraph_format.space_before = Pt(5)
        paragraph.paragraph_format.space_after = Pt(8)
        label = str(block.get("label", "Note")).strip()
        if label:
            label_run = paragraph.add_run(f"{label}: ")
            label_run.bold = True
            _set_run_fonts(label_run, preset["body_font"], preset["east_asia_font"])
        if isinstance(block.get("runs"), list):
            _populate_paragraph(paragraph, {"runs": block["runs"]}, preset)
        else:
            run = paragraph.add_run(text)
            _set_run_fonts(run, preset["body_font"], preset["east_asia_font"])
        _set_paragraph_callout(
            paragraph,
            str(block.get("fill", preset["accent"])).lstrip("#"),
            str(block.get("accent", preset["heading_color"])).lstrip("#"),
        )
    elif block_type == "checklist":
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise DocxSkillError("A checklist requires a non-empty items array")
        checked = block.get("checked", [])
        if checked is not None and not isinstance(checked, list):
            raise DocxSkillError("checklist.checked must be an array")
        checked_values = list(checked or [])
        for index, item in enumerate(items):
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Inches(0.28)
            paragraph.paragraph_format.first_line_indent = Inches(-0.24)
            is_checked = index < len(checked_values) and bool(checked_values[index])
            marker = paragraph.add_run("\u2612 " if is_checked else "\u2610 ")
            marker.bold = True
            _set_run_fonts(marker, preset["body_font"], preset["east_asia_font"])
            run = paragraph.add_run(str(item))
            _set_run_fonts(run, preset["body_font"], preset["east_asia_font"])
    elif block_type == "definition_list":
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise DocxSkillError("A definition_list requires a non-empty items array")
        for item in items:
            if not isinstance(item, dict) or "term" not in item:
                raise DocxSkillError("Every definition_list item requires term and definition fields")
            paragraph = doc.add_paragraph()
            term = paragraph.add_run(f"{item['term']}: ")
            term.bold = True
            _set_run_fonts(term, preset["body_font"], preset["east_asia_font"])
            definition = paragraph.add_run(str(item.get("definition", "")))
            _set_run_fonts(definition, preset["body_font"], preset["east_asia_font"])
    elif block_type == "source_list":
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise DocxSkillError("A source_list requires a non-empty items array")
        for item in items:
            paragraph = doc.add_paragraph(str(item), style="List Number")
            _format_paragraph_runs(paragraph, preset)
    elif block_type == "table":
        headers = block.get("headers", [])
        rows = block.get("rows", [])
        if not isinstance(headers, list) or not isinstance(rows, list):
            raise DocxSkillError("Table headers and rows must be arrays")
        column_count = len(headers) or (len(rows[0]) if rows else 0)
        if column_count < 1:
            raise DocxSkillError("Table must have at least one column")
        alignments = block.get("alignments", ["left"] * column_count)
        if not isinstance(alignments, list) or len(alignments) != column_count:
            raise DocxSkillError("alignments must contain one value per table column")
        paragraph_alignments = [_column_alignment(str(value)) for value in alignments]
        table = doc.add_table(rows=1 if headers else 0, cols=column_count)
        table.style = str(block.get("style", "Table Grid"))
        table.alignment = WD_TABLE_ALIGNMENT.LEFT
        if headers:
            for index, value in enumerate(headers):
                cell = table.rows[0].cells[index]
                cell.text = str(value)
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                cell.paragraphs[0].alignment = paragraph_alignments[index]
                _shade_cell(cell, preset["accent"])
                for run in cell.paragraphs[0].runs:
                    run.bold = True
                    _set_run_fonts(run, preset["body_font"], preset["east_asia_font"])
        for row_values in rows:
            if not isinstance(row_values, list) or len(row_values) != column_count:
                raise DocxSkillError("Every table row must match the column count")
            cells = table.add_row().cells
            for index, value in enumerate(row_values):
                cells[index].text = str(value)
                cells[index].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                for paragraph in cells[index].paragraphs:
                    paragraph.alignment = paragraph_alignments[index]
                    _format_paragraph_runs(paragraph, preset)
        widths = _column_widths_twips(
            block, headers, rows, column_count, _table_available_twips(doc)
        )
        _set_table_geometry(table, widths, sum(widths))
        if headers and bool(block.get("repeat_header", True)):
            _repeat_table_header(table.rows[0])
        if block.get("caption"):
            caption = doc.add_paragraph(str(block["caption"]))
            caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _format_paragraph_runs(caption, preset)
        doc.add_paragraph()
    elif block_type == "image":
        raw_path = Path(str(block.get("path", ""))).expanduser()
        image_path = raw_path if raw_path.is_absolute() else (base_dir / raw_path)
        image_path = image_path.resolve()
        if not image_path.is_file():
            raise DocxSkillError(f"Image not found: {image_path}")
        if str(block.get("path", "")).startswith(("http://", "https://")):
            raise DocxSkillError("Remote images are not allowed")
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = paragraph.add_run()
        run.add_picture(str(image_path), width=Inches(float(block.get("width_inches", 5.5))))
        caption = block.get("caption")
        if caption:
            cap = doc.add_paragraph(str(caption))
            cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _format_paragraph_runs(cap, preset)
    elif block_type == "page_break":
        doc.add_page_break()
    elif block_type == "spacer":
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(float(block.get("points", 12)))
    else:
        raise DocxSkillError(f"Unsupported content block type: {block_type}")


def create_docx(spec_path: str | Path, output_path: str | Path) -> dict[str, Any]:
    spec_file = Path(spec_path).expanduser().resolve()
    spec = load_json(spec_file)
    if isinstance(spec, list):
        spec = {"content": spec}
    if not isinstance(spec, dict):
        raise DocxSkillError("Create specification must be an object or content array")
    preset_name = str(spec.get("preset", "business-report"))
    if preset_name not in PRESETS:
        raise DocxSkillError(f"Unknown preset: {preset_name}")
    preset = dict(PRESETS[preset_name])
    output = require_docx_path(output_path, must_exist=False)
    output.parent.mkdir(parents=True, exist_ok=True)

    doc = Document()
    _configure_document(doc, spec, preset)
    props = doc.core_properties
    metadata = spec.get("metadata", {})
    if isinstance(metadata, dict):
        for field in ("title", "subject", "author", "keywords", "category", "comments"):
            if field in metadata:
                setattr(props, field, str(metadata[field]))

    if spec.get("header"):
        for section in doc.sections:
            paragraph = section.header.paragraphs[0]
            paragraph.text = str(spec["header"])
            paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            _format_paragraph_runs(paragraph, preset)
    if spec.get("footer"):
        for section in doc.sections:
            paragraph = section.footer.paragraphs[0]
            paragraph.text = str(spec["footer"])
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _format_paragraph_runs(paragraph, preset)

    content = spec.get("content", [])
    if not isinstance(content, list):
        raise DocxSkillError("content must be an array")
    for block in content:
        if not isinstance(block, dict):
            raise DocxSkillError("Every content block must be an object")
        _add_content_block(doc, block, preset, spec_file.parent)

    temp = output.with_suffix(".docx.tmp")
    doc.save(str(temp))
    os.replace(temp, output)
    validation = assert_valid_docx(output)
    return {
        "status": "ok",
        "out": str(output),
        "preset": preset_name,
        "blocks": len(content),
        "validation": validation,
    }


def _run_spans(paragraph: Paragraph) -> list[tuple[int, int, Any]]:
    spans = []
    position = 0
    for run in paragraph.runs:
        end = position + len(run.text)
        spans.append((position, end, run))
        position = end
    return spans


def _replace_once(paragraph: Paragraph, match: str, replacement: str) -> bool:
    full_text = "".join(run.text for run in paragraph.runs)
    start = full_text.find(match)
    if start < 0:
        return False
    end = start + len(match)
    spans = _run_spans(paragraph)
    start_index = next((i for i, (a, b, _) in enumerate(spans) if a <= start < b), None)
    end_index = next((i for i, (a, b, _) in enumerate(spans) if a < end <= b), None)
    if start_index is None or end_index is None:
        return False
    start_a, _, start_run = spans[start_index]
    end_a, _, end_run = spans[end_index]
    prefix = start_run.text[: start - start_a]
    suffix = end_run.text[end - end_a :]
    if start_index == end_index:
        start_run.text = prefix + replacement + suffix
    else:
        start_run.text = prefix + replacement
        for index in range(start_index + 1, end_index):
            spans[index][2].text = ""
        end_run.text = suffix
    return True


def _matching_paragraphs(doc: DocumentObject, match: str) -> list[Paragraph]:
    return [paragraph for _, paragraph in iter_document_paragraphs(doc) if match in paragraph.text]


def _insert_after(paragraph: Paragraph, text: str, style: str | None) -> Paragraph:
    new_element = OxmlElement("w:p")
    paragraph._p.addnext(new_element)
    new_paragraph = Paragraph(new_element, paragraph._parent)
    if style:
        new_paragraph.style = style
    new_paragraph.add_run(text)
    return new_paragraph


def _delete_paragraph(paragraph: Paragraph) -> None:
    element = paragraph._element
    element.getparent().remove(element)
    paragraph._p = paragraph._element = None


def edit_docx(
    input_path: str | Path, patch_path: str | Path, output_path: str | Path
) -> dict[str, Any]:
    source, output = require_distinct_paths(input_path, output_path)
    patch = load_json(patch_path)
    if not isinstance(patch, dict) or not isinstance(patch.get("operations"), list):
        raise DocxSkillError("Patch must contain an operations array")
    doc = Document(str(source))
    operation_results: list[dict[str, Any]] = []

    for operation in patch["operations"]:
        if not isinstance(operation, dict):
            raise DocxSkillError("Every edit operation must be an object")
        action = str(operation.get("action", ""))
        affected = 0
        if action == "replace_text":
            match = str(operation.get("match", ""))
            replacement = str(operation.get("replacement", ""))
            if not match:
                raise DocxSkillError("replace_text requires a non-empty match")
            limit_all = str(operation.get("occurrence", "first")) == "all"
            for _, paragraph in list(iter_document_paragraphs(doc)):
                while _replace_once(paragraph, match, replacement):
                    affected += 1
                    if not limit_all:
                        break
                if affected and not limit_all:
                    break
        elif action == "insert_after":
            match = str(operation.get("match", ""))
            matches = _matching_paragraphs(doc, match)
            if matches:
                _insert_after(matches[0], str(operation.get("text", "")), operation.get("style"))
                affected = 1
        elif action == "delete_paragraph":
            match = str(operation.get("match", ""))
            matches = _matching_paragraphs(doc, match)
            if matches:
                _delete_paragraph(matches[0])
                affected = 1
        elif action == "set_style":
            match = str(operation.get("match", ""))
            style = str(operation.get("style", ""))
            if not style:
                raise DocxSkillError("set_style requires style")
            matches = _matching_paragraphs(doc, match)
            if matches:
                matches[0].style = style
                affected = 1
        elif action == "append_paragraph":
            doc.add_paragraph(str(operation.get("text", "")), style=str(operation.get("style", "Normal")))
            affected = 1
        elif action == "add_page_break":
            doc.add_page_break()
            affected = 1
        elif action == "set_metadata":
            props = doc.core_properties
            for field in ("title", "subject", "author", "keywords", "category", "comments"):
                if field in operation:
                    setattr(props, field, str(operation[field]))
                    affected += 1
        else:
            raise DocxSkillError(f"Unsupported edit action: {action}")
        operation_results.append({"action": action, "affected": affected})

    temp = output.with_suffix(".docx.tmp")
    doc.save(str(temp))
    os.replace(temp, output)
    validation = assert_valid_docx(output)
    return {
        "status": "ok",
        "input": str(source),
        "out": str(output),
        "operations": operation_results,
        "validation": validation,
    }


def compare_docx(before_path: str | Path, after_path: str | Path, output_json: str | Path) -> dict[str, Any]:
    before = inspect_docx(before_path)
    after = inspect_docx(after_path)
    before_lines = [item["text"] for item in before["paragraphs"]]
    after_lines = [item["text"] for item in after["paragraphs"]]
    diff = list(
        difflib.unified_diff(
            before_lines,
            after_lines,
            fromfile=str(Path(before_path).name),
            tofile=str(Path(after_path).name),
            lineterm="",
        )
    )
    result = {
        "status": "ok",
        "before": str(Path(before_path).resolve()),
        "after": str(Path(after_path).resolve()),
        "paragraph_count_before": len(before_lines),
        "paragraph_count_after": len(after_lines),
        "table_count_before": before["table_count"],
        "table_count_after": after["table_count"],
        "diff": diff,
    }
    write_json(output_json, result)
    result["out"] = str(Path(output_json).resolve())
    return result


def sanitize_docx(
    input_path: str | Path, output_path: str | Path, *, remove_comments: bool = False
) -> dict[str, Any]:
    source, output = require_distinct_paths(input_path, output_path)
    with unpacked_copy(source) as (_, package):
        core_path = package / "docProps" / "core.xml"
        if core_path.exists():
            parser = etree.XMLParser(resolve_entities=False, no_network=True)
            tree = etree.parse(str(core_path), parser)
            root = tree.getroot()
            namespaces = {
                "dc": "http://purl.org/dc/elements/1.1/",
                "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
            }
            for xpath in ("dc:creator", "cp:lastModifiedBy", "dc:subject", "cp:keywords"):
                node = root.find(xpath, namespaces)
                if node is not None:
                    node.text = ""
            tree.write(str(core_path), encoding="UTF-8", xml_declaration=True, standalone=True)

        custom_path = package / "docProps" / "custom.xml"
        if custom_path.exists():
            custom_path.unlink()

        package_rels_path = package / "_rels" / ".rels"
        if package_rels_path.exists():
            parser = etree.XMLParser(resolve_entities=False, no_network=True)
            tree = etree.parse(str(package_rels_path), parser)
            root = tree.getroot()
            for relationship in list(root):
                if (relationship.get("Target") or "").lstrip("/") == "docProps/custom.xml":
                    root.remove(relationship)
            tree.write(
                str(package_rels_path),
                encoding="UTF-8",
                xml_declaration=True,
                standalone=True,
            )

        content_types_path = package / "[Content_Types].xml"
        if content_types_path.exists():
            parser = etree.XMLParser(resolve_entities=False, no_network=True)
            tree = etree.parse(str(content_types_path), parser)
            root = tree.getroot()
            for override in list(root):
                if (override.get("PartName") or "") == "/docProps/custom.xml":
                    root.remove(override)
            tree.write(
                str(content_types_path),
                encoding="UTF-8",
                xml_declaration=True,
                standalone=True,
            )

        for xml_path in (package / "word").rglob("*.xml"):
            parser = etree.XMLParser(resolve_entities=False, no_network=True)
            tree = etree.parse(str(xml_path), parser)
            changed = False
            for element in tree.getroot().iter():
                for attr_name in list(element.attrib):
                    if etree.QName(attr_name).localname.startswith("rsid"):
                        del element.attrib[attr_name]
                        changed = True
            if changed:
                tree.write(str(xml_path), encoding="UTF-8", xml_declaration=True, standalone=True)

        if remove_comments:
            from .review import strip_comments_from_package

            strip_comments_from_package(package)
        pack_docx(package, output)

    return {
        "status": "ok",
        "input": str(source),
        "out": str(output),
        "removed_comments": remove_comments,
        "validation": assert_valid_docx(output),
    }
