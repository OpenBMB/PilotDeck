from __future__ import annotations

import difflib
import platform
import re
import shutil
import subprocess
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Iterator

from docx import Document
from docx.document import Document as DocumentObject
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Mm, Pt, RGBColor
from docx.table import _Cell, Table
from docx.text.paragraph import Paragraph
from lxml import etree

from .common import (
    DocxSkillError,
    active_content_parts,
    assert_control_path_is_distinct,
    assert_internal_control_path,
    assert_safe_mutation,
    assert_valid_docx,
    blocked,
    document_protection_details,
    effective_document_protection_details,
    load_json,
    prepare_output_docx_path,
    prepare_json_artifact_path,
    pack_docx,
    require_distinct_paths,
    require_docx_path,
    temporary_sibling,
    unpacked_copy,
    write_json,
)
from .fields import set_document_update_fields_on_open
from .media import normalized_image_stream, resolve_local_image
from .protocol import (
    SUPPORTED_FIELD_KEYWORDS,
    normalize_document_policy,
    normalize_document_structure,
    normalize_style_policy,
    validate_create_spec,
    validate_edit_patch,
)
from .templates import resolve_document_style


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"w": W_NS, "r": R_NS}

def _note_entry_count(
    archive: zipfile.ZipFile,
    part_name: str,
    element_name: str,
    parser: etree.XMLParser,
) -> int:
    if part_name not in archive.namelist():
        return 0
    root = etree.fromstring(archive.read(part_name), parser)
    count = 0
    for note in root.findall(f"w:{element_name}", NS):
        note_type = (note.get(qn("w:type")) or "").strip()
        if note_type in {
            "separator",
            "continuationSeparator",
            "continuationNotice",
        }:
            continue
        note_id = (note.get(qn("w:id")) or "").strip()
        try:
            if note_id and int(note_id) < 0:
                continue
        except ValueError:
            pass
        count += 1
    return count


CJK_FONT_CANDIDATES: dict[str, list[str]] = {
    "Darwin": ["PingFang SC", "Songti SC", "Heiti SC", "Arial Unicode MS"],
    "Windows": ["Microsoft YaHei", "DengXian", "SimSun", "Arial Unicode MS"],
    "Linux": ["Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei", "DejaVu Sans"],
}
CJK_SERIF_FONT_CANDIDATES: dict[str, list[str]] = {
    "Darwin": ["Songti SC", "STSong", "PingFang SC", "Arial Unicode MS"],
    "Windows": ["SimSun", "NSimSun", "Microsoft YaHei", "Arial Unicode MS"],
    "Linux": [
        "Noto Serif CJK SC",
        "Source Han Serif SC",
        "Noto Sans CJK SC",
        "DejaVu Sans",
    ],
}


def _fontconfig_match(font_name: str) -> str | None:
    executable = shutil.which("fc-match")
    if not executable:
        return None
    try:
        process = subprocess.run(
            [executable, "-f", "%{family}", font_name],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = (process.stdout or "").split(",", 1)[0].strip()
    return value or None


def resolve_fonts(style: dict[str, Any]) -> dict[str, str]:
    latin = str(style["body_font"])
    system = platform.system()
    candidate_map = (
        CJK_SERIF_FONT_CANDIDATES
        if style.get("cjk_family") == "serif"
        else CJK_FONT_CANDIDATES
    )
    candidates = candidate_map.get(system, candidate_map["Linux"])
    style_candidate = str(style["east_asia_font"])
    ordered = list(candidates)
    if style_candidate not in ordered:
        ordered.append(style_candidate)
    east_asia = ordered[0]
    if system == "Linux":
        for candidate in ordered:
            matched = _fontconfig_match(candidate)
            if matched and matched.casefold() == candidate.casefold():
                east_asia = candidate
                break
    return {"latin": latin, "east_asia": east_asia}


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


def _iter_table_tree(
    table: Table,
    location: str,
    seen: set[int],
) -> Iterator[tuple[str, Table]]:
    identity = id(table._tbl)
    if identity in seen:
        return
    seen.add(identity)
    yield location, table
    for row_index, row in enumerate(table.rows, start=1):
        for column_index, cell in enumerate(row.cells, start=1):
            for nested_index, nested in enumerate(cell.tables, start=1):
                yield from _iter_table_tree(
                    nested,
                    (
                        f"{location}.r{row_index}.c{column_index}"
                        f".table{nested_index}"
                    ),
                    seen,
                )


def iter_document_tables(doc: DocumentObject) -> Iterator[tuple[str, Table]]:
    seen: set[int] = set()
    for table_index, table in enumerate(doc.tables, start=1):
        yield from _iter_table_tree(table, f"table{table_index}", seen)

    seen_parts: set[str] = set()
    for section_index, section in enumerate(doc.sections, start=1):
        for label, part in (("header", section.header), ("footer", section.footer)):
            part_name = str(part.part.partname)
            if part_name in seen_parts:
                continue
            seen_parts.add(part_name)
            for table_index, table in enumerate(part.tables, start=1):
                yield from _iter_table_tree(
                    table,
                    f"section{section_index}.{label}.table{table_index}",
                    seen,
                )


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
    try:
        alignment = (
            str(paragraph.alignment)
            if paragraph.alignment is not None
            else None
        )
    except ValueError:
        alignment = paragraph._p.pPr.jc.val if paragraph._p.pPr is not None and paragraph._p.pPr.jc is not None else None
    return {
        "index": index,
        "location": location,
        "text": paragraph.text,
        "style": paragraph.style.name if paragraph.style else None,
        "alignment": alignment,
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
        "tracked_changes": {
            "insertions": 0,
            "deletions": 0,
            "moves_from": 0,
            "moves_to": 0,
            "property_changes": 0,
            "by_part": {},
        },
        "fields": [],
        "image_parts": 0,
        "external_relationships": [],
        "package_features": {},
        "inspection_coverage": {
            "status": "complete",
            "limitations": [],
        },
    }
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    with zipfile.ZipFile(docx_path) as archive:
        names = set(archive.namelist())
        fields: list[dict[str, str]] = []
        revision_totals = {
            "insertions": 0,
            "deletions": 0,
            "moves_from": 0,
            "moves_to": 0,
            "property_changes": 0,
        }
        revision_parts: dict[str, dict[str, int]] = {}
        property_change_xpath = (
            ".//w:pPrChange | .//w:rPrChange | .//w:tblPrChange | "
            ".//w:trPrChange | .//w:tcPrChange | .//w:sectPrChange"
        )
        for part_name in sorted(
            name
            for name in names
            if name.startswith("word/") and name.lower().endswith(".xml")
        ):
            root = etree.fromstring(archive.read(part_name), parser)
            counts = {
                "insertions": len(root.findall(".//w:ins", NS)),
                "deletions": len(root.findall(".//w:del", NS)),
                "moves_from": len(root.findall(".//w:moveFrom", NS)),
                "moves_to": len(root.findall(".//w:moveTo", NS)),
                "property_changes": len(root.xpath(property_change_xpath, namespaces=NS)),
            }
            if any(counts.values()):
                revision_parts[part_name] = counts
                for key, count in counts.items():
                    revision_totals[key] += count
            for node in root.findall(".//w:instrText", NS):
                value = " ".join((node.text or "").split())
                if value:
                    fields.append({"part": part_name, "instruction": value, "form": "complex"})
            for node in root.findall(".//w:fldSimple", NS):
                value = " ".join((node.get(qn("w:instr")) or "").split())
                if value:
                    fields.append({"part": part_name, "instruction": value, "form": "simple"})
        result["fields"] = fields
        result["tracked_changes"] = {
            **revision_totals,
            "by_part": revision_parts,
        }
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

        for rel_name in sorted(name for name in names if name.endswith(".rels")):
            rel_root = etree.fromstring(archive.read(rel_name), parser)
            rel_ns = {"pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
            for rel in rel_root.findall("pr:Relationship", rel_ns):
                if rel.get("TargetMode") == "External":
                    result["external_relationships"].append(
                        {
                            "part": rel_name,
                            "type": rel.get("Type"),
                            "target": rel.get("Target"),
                        }
                    )
        package_features = {
            "macros": any(name.lower().endswith("vbaproject.bin") for name in names),
            "active_content": active_content_parts(docx_path),
            "digital_signatures": any(
                name.startswith("_xmlsignatures/")
                or name in {
                    "word/signatures.xml",
                    "word/signatureLine.xml",
                }
                for name in names
            ),
            "embeddings": sorted(
                name for name in names if name.startswith("word/embeddings/") and not name.endswith("/")
            ),
            "charts": sorted(
                name for name in names if name.startswith("word/charts/") and name.endswith(".xml")
            ),
            "diagrams": sorted(
                name for name in names if name.startswith("word/diagrams/") and not name.endswith("/")
            ),
            "custom_xml": sorted(
                name for name in names if name.startswith("customXml/") and not name.endswith("/")
            ),
            "custom_xml_schemas": [],
            "content_controls": 0,
            "text_boxes": 0,
            "footnotes": _note_entry_count(
                archive, "word/footnotes.xml", "footnote", parser
            ),
            "endnotes": _note_entry_count(
                archive, "word/endnotes.xml", "endnote", parser
            ),
            "alt_chunks": 0,
            "office_math": 0,
            "document_protection_settings": document_protection_details(docx_path),
            "document_protection": effective_document_protection_details(docx_path),
        }
        custom_xml_schemas: set[str] = set()
        for part_name in sorted(
            name
            for name in names
            if name.startswith("customXml/itemProps") and name.endswith(".xml")
        ):
            root = etree.fromstring(archive.read(part_name), parser)
            for node in root.xpath(".//*[local-name()='schemaRef']"):
                uri = next(
                    (
                        value
                        for attr, value in node.attrib.items()
                        if etree.QName(attr).localname == "uri"
                    ),
                    "",
                )
                if uri:
                    custom_xml_schemas.add(uri)
        package_features["custom_xml_schemas"] = sorted(custom_xml_schemas)
        for part_name in sorted(
            name for name in names if name.startswith("word/") and name.endswith(".xml")
        ):
            root = etree.fromstring(archive.read(part_name), parser)
            package_features["content_controls"] += len(root.findall(".//w:sdt", NS))
            package_features["text_boxes"] += len(root.findall(".//w:txbxContent", NS))
            package_features["alt_chunks"] += len(root.findall(".//w:altChunk", NS))
            package_features["office_math"] += len(
                root.xpath(".//*[local-name()='oMath']")
            )
        result["package_features"] = package_features
        limitations: list[str] = []
        if package_features["text_boxes"]:
            limitations.append("Text boxes are inventoried but not included in normal reading order.")
        if package_features["charts"]:
            limitations.append("Chart parts are inventoried but chart semantics are not extracted.")
        if package_features["diagrams"]:
            limitations.append(
                "Diagram and SmartArt parts are inventoried but their visual semantics are not extracted."
            )
        if package_features["content_controls"]:
            limitations.append("Content controls are inventoried but their behavior is not modeled.")
        if package_features["footnotes"]:
            limitations.append(
                "Footnote content is inventoried but not included in normal reading order."
            )
        if package_features["endnotes"]:
            limitations.append(
                "Endnote content is inventoried but not included in normal reading order."
            )
        if package_features["alt_chunks"]:
            limitations.append(
                "Alternative-format imported content is inventoried but not interpreted."
            )
        if package_features["office_math"]:
            limitations.append(
                "Office Math objects are inventoried but mathematical semantics are not extracted."
            )
        nonstandard_custom_xml = sorted(
            uri
            for uri in custom_xml_schemas
            if uri
            != "http://schemas.openxmlformats.org/officeDocument/2006/bibliography"
        )
        package_features["custom_xml_nonstandard"] = nonstandard_custom_xml
        if nonstandard_custom_xml:
            limitations.append(
                "Nonstandard custom XML is inventoried but its application behavior is not modeled."
            )
        if package_features["embeddings"]:
            limitations.append("Embedded object contents are not inspected.")
        if package_features["active_content"]:
            limitations.append(
                "ActiveX or macro content is inventoried but never executed or interpreted."
            )
        if package_features["digital_signatures"]:
            limitations.append(
                "Digital signature validity and signer identity are not verified."
            )
        if package_features["document_protection"]:
            limitations.append(
                "Document protection settings are inventoried but credentials and enforcement are not verified."
            )
        if result["comments"]:
            limitations.append(
                "Comment text is inventoried but comment anchor ranges are not mapped to reading-order text."
            )
        if any(revision_totals.values()):
            limitations.append(
                "Tracked revisions are inventoried but accepted/rejected reading states are not reconstructed."
            )
        result["inspection_coverage"] = {
            "status": "partial" if limitations else "complete",
            "limitations": limitations,
        }
    return result


def inspect_docx(input_path: str | Path, output_json: str | Path | None = None) -> dict[str, Any]:
    path = require_docx_path(input_path)
    json_output = (
        prepare_json_artifact_path(
            output_json,
            protected_paths=(path,),
            purpose="Inspection output",
        )
        if output_json
        else None
    )
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
    for table_index, (location, table) in enumerate(
        iter_document_tables(doc),
        start=1,
    ):
        tables.append(
            {
                "index": table_index,
                "location": location,
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
    if result.get("inspection_coverage", {}).get("status") != "complete":
        result["status"] = "partial"
    if json_output:
        write_json(json_output, result)
        result["out"] = str(json_output)
    return result


def filter_inspection(
    result: dict[str, Any],
    *,
    summary: bool = False,
    search: str | None = None,
    location: str | None = None,
    max_items: int = 200,
) -> dict[str, Any]:
    if max_items < 1:
        raise DocxSkillError("max_items must be positive", code="invalid-inspection-filter")
    filtered = dict(result)
    paragraphs = list(result.get("paragraphs", []))
    if search:
        needle = search.casefold()
        paragraphs = [
            item
            for item in paragraphs
            if needle in str(item.get("text", "")).casefold()
        ]
    if location:
        paragraphs = [
            item
            for item in paragraphs
            if str(item.get("location", "")).startswith(location)
        ]
    total_matches = len(paragraphs)
    paragraphs = paragraphs[:max_items]
    filtered["query"] = {
        "search": search,
        "location": location,
        "total_matches": total_matches,
        "returned": len(paragraphs),
        "truncated": total_matches > len(paragraphs),
    }
    if summary:
        for key in ("paragraphs", "tables"):
            filtered.pop(key, None)
    else:
        filtered["paragraphs"] = paragraphs
        heading_indexes = {item.get("index") for item in paragraphs}
        filtered["headings"] = [
            item for item in result.get("headings", []) if item.get("index") in heading_indexes
        ]
        if search or location:
            filtered.pop("tables", None)
    return filtered


def _configure_document(doc: DocumentObject, spec: dict[str, Any], style_tokens: dict[str, Any]) -> None:
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
    _set_style_fonts(normal, style_tokens["body_font"], style_tokens["east_asia_font"], style_tokens["body_size"])
    normal.paragraph_format.space_after = Pt(style_tokens["space_after"])
    line_spacing_points = style_tokens.get("normal_line_spacing_points")
    normal.paragraph_format.line_spacing = (
        Pt(float(line_spacing_points)) if line_spacing_points else 1.15
    )
    first_line_indent = style_tokens.get("normal_first_line_indent_inches")
    if first_line_indent is not None:
        normal.paragraph_format.first_line_indent = Inches(
            float(first_line_indent)
        )
    if style_tokens.get("normal_alignment") == "justify":
        normal.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    heading_sizes = style_tokens.get("heading_sizes")
    for level in range(1, 4):
        style = styles[f"Heading {level}"]
        heading_size = (
            float(heading_sizes[level - 1])
            if isinstance(heading_sizes, (list, tuple))
            and len(heading_sizes) >= level
            else style_tokens["body_size"] + (7 - level * 1.5)
        )
        _set_style_fonts(
            style,
            style_tokens["body_font"],
            style_tokens["east_asia_font"],
            heading_size,
        )
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(style_tokens["heading_color"])
        style.paragraph_format.space_before = Pt(12 if level == 1 else 8)
        style.paragraph_format.space_after = Pt(5)
        style.paragraph_format.keep_with_next = True
        style.paragraph_format.keep_together = True
    caption = styles["Caption"]
    _set_style_fonts(
        caption,
        style_tokens["body_font"],
        style_tokens["east_asia_font"],
        style_tokens["body_size"],
    )
    caption.font.color.rgb = RGBColor.from_string(
        style_tokens["heading_color"]
    )
    caption.font.italic = False
    caption.paragraph_format.space_before = Pt(6)
    caption.paragraph_format.space_after = Pt(4)
    caption.paragraph_format.keep_with_next = True


def _shade_cell(cell: _Cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def _set_cell_text_color(cell: _Cell, color: str) -> None:
    rgb = RGBColor.from_string(color)
    for paragraph in cell.paragraphs:
        for run in paragraph.runs:
            run.font.color.rgb = rgb


def _set_table_borders(table: Table, color: str) -> None:
    properties = table._tbl.tblPr
    borders = properties.find(qn("w:tblBorders"))
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        properties.append(borders)
    for name in ("top", "left", "bottom", "right", "insideH", "insideV"):
        border = borders.find(qn(f"w:{name}"))
        if border is None:
            border = OxmlElement(f"w:{name}")
            borders.append(border)
        border.set(qn("w:val"), "single")
        border.set(qn("w:sz"), "4")
        border.set(qn("w:space"), "0")
        border.set(qn("w:color"), color)


def _format_paragraph_runs(paragraph: Paragraph, style_tokens: dict[str, Any]) -> None:
    for run in paragraph.runs:
        _set_run_fonts(run, style_tokens["body_font"], style_tokens["east_asia_font"])


def _populate_paragraph(paragraph: Paragraph, block: dict[str, Any], style_tokens: dict[str, Any]) -> None:
    runs = block.get("runs")
    if not isinstance(runs, list):
        paragraph.add_run(str(block.get("text", "")))
        _format_paragraph_runs(paragraph, style_tokens)
        return
    for item in runs:
        if not isinstance(item, dict):
            raise DocxSkillError("Every rich-text run must be an object")
        run = paragraph.add_run(str(item.get("text", "")))
        _set_run_fonts(run, style_tokens["body_font"], style_tokens["east_asia_font"])
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


def _set_paragraph_callout(
    paragraph: Paragraph,
    fill: str | None,
    accent: str,
) -> None:
    properties = paragraph._p.get_or_add_pPr()
    if fill:
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


def _keep_table_row_together(row: Any) -> None:
    properties = row._tr.get_or_add_trPr()
    keep = properties.find(qn("w:cantSplit"))
    if keep is None:
        keep = OxmlElement("w:cantSplit")
        properties.append(keep)
    keep.set(qn("w:val"), "true")


def _column_alignment(value: str) -> Any:
    normalized = value.lower()
    if normalized == "center":
        return WD_ALIGN_PARAGRAPH.CENTER
    if normalized == "right":
        return WD_ALIGN_PARAGRAPH.RIGHT
    if normalized != "left":
        raise DocxSkillError(f"Unsupported table alignment: {value}")
    return WD_ALIGN_PARAGRAPH.LEFT


def _paragraph_alignment(value: str) -> Any:
    normalized = value.lower()
    if normalized == "center":
        return WD_ALIGN_PARAGRAPH.CENTER
    if normalized == "right":
        return WD_ALIGN_PARAGRAPH.RIGHT
    if normalized != "left":
        raise DocxSkillError(f"Unsupported paragraph alignment: {value}")
    return WD_ALIGN_PARAGRAPH.LEFT


def _append_field(paragraph: Paragraph, instruction: str, placeholder: str = "") -> None:
    normalized = " ".join(instruction.split())
    keyword = normalized.split(maxsplit=1)[0].upper() if normalized else ""
    if keyword not in SUPPORTED_FIELD_KEYWORDS:
        raise DocxSkillError(
            f"Unsupported field instruction: {instruction}",
            status="unsupported",
            code="unsupported-field",
            details={"supported": list(SUPPORTED_FIELD_KEYWORDS)},
        )
    begin_run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    begin_run._r.append(begin)
    instruction_run = paragraph.add_run()
    instruction_node = OxmlElement("w:instrText")
    instruction_node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    instruction_node.text = f" {normalized} "
    instruction_run._r.append(instruction_node)
    separate_run = paragraph.add_run()
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    separate_run._r.append(separate)
    if placeholder:
        paragraph.add_run(placeholder)
    end_run = paragraph.add_run()
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    end_run._r.append(end)


def _populate_field_template(paragraph: Paragraph, text: str, style_tokens: dict[str, Any]) -> None:
    cursor = 0
    pattern = re.compile(r"\{(PAGE|NUMPAGES)\}")
    for match in pattern.finditer(text):
        if match.start() > cursor:
            run = paragraph.add_run(text[cursor : match.start()])
            _set_run_fonts(run, style_tokens["body_font"], style_tokens["east_asia_font"])
        _append_field(paragraph, match.group(1), "1")
        cursor = match.end()
    if cursor < len(text):
        run = paragraph.add_run(text[cursor:])
        _set_run_fonts(run, style_tokens["body_font"], style_tokens["east_asia_font"])


def _set_story(paragraph: Paragraph, value: str | dict[str, Any], style_tokens: dict[str, Any]) -> None:
    if isinstance(value, dict):
        text = str(value.get("text", ""))
        alignment = str(value.get("alignment", "center"))
    else:
        text = str(value)
        alignment = "center"
    paragraph.clear()
    paragraph.alignment = _paragraph_alignment(alignment)
    _populate_field_template(paragraph, text, style_tokens)


def _set_picture_alt_text(inline: Any, alt_text: str) -> None:
    if not alt_text:
        return
    for node in inline.findall(
        ".//wp:docPr",
        {
            "wp": (
                "http://schemas.openxmlformats.org/drawingml/"
                "2006/wordprocessingDrawing"
            )
        },
    ):
        node.set("descr", alt_text)
        node.set("title", alt_text)


def _add_normalized_picture(
    paragraph: Paragraph,
    image_path: Path,
    *,
    width_inches: float,
    alt_text: str = "",
) -> dict[str, Any]:
    # The built-in document style intentionally uses exact line spacing for
    # ordinary body text. An inline picture inherits that spacing unless the
    # picture paragraph explicitly opts out, which clips the drawing to one
    # text line in Word/LibreOffice. Give image paragraphs automatic line
    # spacing so their full inline extent participates in layout.
    paragraph.paragraph_format.line_spacing = 1.0
    paragraph.paragraph_format.line_spacing_rule = WD_LINE_SPACING.SINGLE
    stream, metadata = normalized_image_stream(image_path)
    inline = paragraph.add_run().add_picture(
        stream,
        width=Inches(width_inches),
    )._inline
    _set_picture_alt_text(inline, alt_text)
    return metadata


def _structured_content(
    content: list[dict[str, Any]],
    structure: dict[str, Any],
) -> list[dict[str, Any]]:
    if structure["archetype"] != "formal-report":
        return content
    toc_index = next(
        index
        for index, block in enumerate(content)
        if block.get("type") == "toc"
    )
    normalized: list[dict[str, Any]] = []
    skip_page_break_after_toc = False
    for index, original in enumerate(content):
        block = deepcopy(original)
        if index == toc_index:
            while normalized and normalized[-1].get("type") == "page_break":
                normalized.pop()
            normalized.append({"type": "page_break"})
            block["page_break_after"] = True
            normalized.append(block)
            skip_page_break_after_toc = True
            continue
        if (
            skip_page_break_after_toc
            and index == toc_index + 1
            and block.get("type") == "page_break"
        ):
            continue
        normalized.append(block)
    return normalized


def _add_content_block(doc: DocumentObject, block: dict[str, Any], style_tokens: dict[str, Any], base_dir: Path) -> None:
    block_type = str(block.get("type", "paragraph"))
    text = str(block.get("text", ""))
    if block_type == "title":
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        paragraph.paragraph_format.space_after = Pt(14)
        title_size = float(style_tokens["title_size"])
        paragraph.paragraph_format.line_spacing_rule = WD_LINE_SPACING.AT_LEAST
        paragraph.paragraph_format.line_spacing = Pt(max(title_size * 1.25, title_size + 4))
        _populate_paragraph(paragraph, block, style_tokens)
        for run in paragraph.runs:
            run.font.size = run.font.size or Pt(title_size)
            run.bold = True if run.bold is None else run.bold
            if run.font.color.rgb is None:
                run.font.color.rgb = RGBColor.from_string(style_tokens["title_color"])
    elif block_type == "subtitle":
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        _populate_paragraph(paragraph, block, style_tokens)
        for run in paragraph.runs:
            run.font.size = run.font.size or Pt(style_tokens["body_size"] + 2)
            if run.font.color.rgb is None:
                run.font.color.rgb = RGBColor(89, 89, 89)
    elif block_type == "heading":
        level = max(1, min(3, int(block.get("level", 1))))
        paragraph = doc.add_heading("", level=level)
        _populate_paragraph(paragraph, block, style_tokens)
        for run in paragraph.runs:
            _set_run_fonts(
                run,
                style_tokens["body_font"],
                style_tokens["east_asia_font"],
            )
            run.font.size = paragraph.style.font.size
            run.font.color.rgb = RGBColor.from_string(
                style_tokens["heading_color"]
            )
    elif block_type in {"paragraph", "body"}:
        paragraph = doc.add_paragraph(style=str(block.get("style", "Normal")))
        _populate_paragraph(paragraph, block, style_tokens)
        if block.get("bold"):
            for run in paragraph.runs:
                run.bold = True
    elif block_type == "bullet":
        paragraph = doc.add_paragraph(style="List Bullet")
        _populate_paragraph(paragraph, block, style_tokens)
    elif block_type == "numbered":
        paragraph = doc.add_paragraph(style="List Number")
        _populate_paragraph(paragraph, block, style_tokens)
    elif block_type == "quote":
        paragraph = doc.add_paragraph(style="Quote")
        _populate_paragraph(paragraph, block, style_tokens)
        paragraph.paragraph_format.left_indent = Inches(0.3)
    elif block_type == "callout":
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.left_indent = Inches(0.15)
        paragraph.paragraph_format.right_indent = Inches(0.08)
        paragraph.paragraph_format.space_before = Pt(5)
        paragraph.paragraph_format.space_after = Pt(8)
        locale = str(style_tokens.get("locale", "")).lower()
        default_label = "提示" if locale.startswith("zh") else "Note"
        label = str(block.get("label", default_label)).strip()
        if label:
            label_run = paragraph.add_run(f"{label}: ")
            label_run.bold = True
            _set_run_fonts(label_run, style_tokens["body_font"], style_tokens["east_asia_font"])
        if isinstance(block.get("runs"), list):
            _populate_paragraph(paragraph, {"runs": block["runs"]}, style_tokens)
        else:
            run = paragraph.add_run(text)
            _set_run_fonts(run, style_tokens["body_font"], style_tokens["east_asia_font"])
        raw_fill = block.get("fill", style_tokens["callout_fill"])
        fill = str(raw_fill).lstrip("#") if raw_fill else None
        _set_paragraph_callout(
            paragraph,
            fill,
            str(
                block.get("accent", style_tokens["callout_border_color"])
            ).lstrip("#"),
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
            _set_run_fonts(marker, style_tokens["body_font"], style_tokens["east_asia_font"])
            run = paragraph.add_run(str(item))
            _set_run_fonts(run, style_tokens["body_font"], style_tokens["east_asia_font"])
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
            _set_run_fonts(term, style_tokens["body_font"], style_tokens["east_asia_font"])
            definition = paragraph.add_run(str(item.get("definition", "")))
            _set_run_fonts(definition, style_tokens["body_font"], style_tokens["east_asia_font"])
    elif block_type == "source_list":
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise DocxSkillError("A source_list requires a non-empty items array")
        for item in items:
            paragraph = doc.add_paragraph(str(item), style="List Number")
            _format_paragraph_runs(paragraph, style_tokens)
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
        caption_text = str(block.get("caption", "")).strip()
        if caption_text:
            caption = doc.add_paragraph(style="Caption")
            caption.paragraph_format.keep_with_next = True
            caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
            caption.add_run(caption_text)
            _format_paragraph_runs(caption, style_tokens)
        table = doc.add_table(rows=1 if headers else 0, cols=column_count)
        table.style = str(block.get("style", style_tokens["table_style"]))
        table.alignment = WD_TABLE_ALIGNMENT.LEFT
        border_color = str(
            block.get("border_color", style_tokens["table_border_color"])
        ).lstrip("#")
        _set_table_borders(table, border_color)
        if headers:
            raw_header_fill = block.get(
                "header_fill",
                style_tokens["table_header_fill"],
            )
            header_fill = (
                str(raw_header_fill).lstrip("#") if raw_header_fill else None
            )
            raw_header_text_color = block.get(
                "header_text_color",
                style_tokens["table_header_text_color"],
            )
            header_text_color = (
                str(raw_header_text_color).lstrip("#")
                if raw_header_text_color
                else None
            )
            for index, value in enumerate(headers):
                cell = table.rows[0].cells[index]
                cell.text = str(value)
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                header_paragraph = cell.paragraphs[0]
                header_paragraph.alignment = paragraph_alignments[index]
                header_paragraph.paragraph_format.first_line_indent = Pt(0)
                header_paragraph.paragraph_format.line_spacing = 1
                if header_fill:
                    _shade_cell(cell, header_fill)
                for run in header_paragraph.runs:
                    run.bold = True
                    _set_run_fonts(run, style_tokens["body_font"], style_tokens["east_asia_font"])
                if header_text_color:
                    _set_cell_text_color(cell, header_text_color)
        for row_values in rows:
            if not isinstance(row_values, list) or len(row_values) != column_count:
                raise DocxSkillError("Every table row must match the column count")
            cells = table.add_row().cells
            for index, value in enumerate(row_values):
                cells[index].text = str(value)
                cells[index].vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                for paragraph in cells[index].paragraphs:
                    paragraph.alignment = paragraph_alignments[index]
                    paragraph.paragraph_format.first_line_indent = Pt(0)
                    paragraph.paragraph_format.line_spacing = 1
                    _format_paragraph_runs(paragraph, style_tokens)
        widths = _column_widths_twips(
            block, headers, rows, column_count, _table_available_twips(doc)
        )
        _set_table_geometry(table, widths, sum(widths))
        for row in table.rows:
            _keep_table_row_together(row)
        if headers and bool(block.get("repeat_header", True)):
            _repeat_table_header(table.rows[0])
        doc.add_paragraph()
    elif block_type == "image":
        image_path = resolve_local_image(block.get("path"), base_dir=base_dir)
        paragraph = doc.add_paragraph()
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        alt_text = str(block.get("alt_text", "")).strip()
        _add_normalized_picture(
            paragraph,
            image_path,
            width_inches=float(block.get("width_inches", 5.5)),
            alt_text=alt_text,
        )
        caption = block.get("caption")
        if caption:
            paragraph.paragraph_format.keep_with_next = True
            cap = doc.add_paragraph(str(caption))
            cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
            _format_paragraph_runs(cap, style_tokens)
    elif block_type == "toc":
        locale = str(style_tokens.get("locale", "")).lower()
        title = str(
            block.get("title", "目录" if locale.startswith("zh") else "Contents")
        ).strip()
        if title:
            doc.add_heading(title, level=1)
        levels = block.get("levels", [1, 2, 3])
        if (
            not isinstance(levels, list)
            or not levels
            or any(
                not isinstance(level, int)
                or isinstance(level, bool)
                or level < 1
                or level > 9
                for level in levels
            )
        ):
            raise DocxSkillError("toc.levels must contain integers from 1 to 9")
        first, last = min(levels), max(levels)
        paragraph = doc.add_paragraph()
        _append_field(
            paragraph,
            f'TOC \\o "{first}-{last}" \\h \\z \\u',
            (
                "目录将在最终校验时生成。"
                if locale.startswith("zh")
                else "The table of contents will be generated during final validation."
            ),
        )
        if bool(block.get("page_break_after", True)):
            doc.add_page_break()
    elif block_type == "field":
        paragraph = doc.add_paragraph()
        paragraph.alignment = _paragraph_alignment(str(block.get("alignment", "left")))
        _append_field(
            paragraph,
            str(block.get("instruction", "")),
            str(block.get("placeholder", "")),
        )
    elif block_type == "page_break":
        doc.add_page_break()
    elif block_type == "spacer":
        paragraph = doc.add_paragraph()
        paragraph.paragraph_format.space_after = Pt(float(block.get("points", 12)))
    else:
        raise DocxSkillError(f"Unsupported content block type: {block_type}")


def create_docx(
    spec_path: str | Path,
    output_path: str | Path,
    *,
    acceptance_path: str | Path | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    spec_file = assert_internal_control_path(
        spec_path,
        purpose="Create specification",
    )
    assert_control_path_is_distinct(
        spec_file,
        output_path,
        purpose="Create specification",
    )
    spec = load_json(spec_file)
    if not isinstance(spec, dict):
        raise DocxSkillError(
            "Create specification must be an object", code="invalid-spec"
        )
    validate_create_spec(spec)
    spec_policy = normalize_style_policy(spec.get("style_policy"))
    document_structure = normalize_document_structure(
        spec.get("document_structure")
    )
    if spec_policy is None:
        raise DocxSkillError(
            "Create specification requires style_policy",
            code="invalid-style-policy",
        )
    document_policy = normalize_document_policy(None)
    if acceptance_path is not None:
        acceptance_file = assert_internal_control_path(
            acceptance_path,
            purpose="Acceptance manifest",
        )
        acceptance = load_json(acceptance_file)
        if not isinstance(acceptance, dict):
            raise DocxSkillError(
                "Acceptance manifest must be an object",
                code="invalid-acceptance-manifest",
            )
        accepted_policy = normalize_style_policy(
            acceptance.get("style_policy"),
            default_builtin=False,
        )
        if accepted_policy is None:
            raise DocxSkillError(
                "Acceptance manifest does not freeze style_policy",
                code="style-policy-not-frozen",
            )
        if spec_policy != accepted_policy:
            raise DocxSkillError(
                "Create specification style_policy does not match the frozen acceptance manifest",
                code="style-policy-mismatch",
                details={
                    "specified": spec_policy,
                    "accepted": accepted_policy,
                },
            )
        document_policy = normalize_document_policy(
            acceptance.get("document_policy")
        )
        accepted_structure = normalize_document_structure(
            acceptance.get("document_structure")
        )
        if document_structure != accepted_structure:
            raise DocxSkillError(
                "Create specification document_structure does not match the frozen acceptance manifest",
                code="document-structure-mismatch",
                details={
                    "specified": document_structure,
                    "accepted": accepted_structure,
                },
            )
    for story_name, permission in (
        ("header", "allow_header"),
        ("footer", "allow_footer"),
    ):
        story = spec.get(story_name)
        story_text = (
            story
            if isinstance(story, str)
            else story.get("text", "")
            if isinstance(story, dict)
            else ""
        )
        if str(story_text).strip() and not document_policy[permission]:
            raise blocked(
                f"The create specification adds an unrequested {story_name}",
                code=f"unrequested-{story_name}",
                details={
                    "next": (
                        f"Remove {story_name} from the specification, or rerun "
                        f"prepare with --allow-{story_name} only when the user "
                        "explicitly requested it."
                    )
                },
            )
    page_number_requested = any(
        re.search(r"\{(?:PAGE|NUMPAGES)\}", str(value), re.IGNORECASE)
        for value in (
            spec.get("header", ""),
            spec.get("footer", ""),
        )
    ) or any(
        isinstance(block, dict)
        and block.get("type") == "field"
        and str(block.get("instruction", "")).strip().upper().split(maxsplit=1)[0]
        in {"PAGE", "NUMPAGES"}
        for block in spec.get("content", [])
    )
    if page_number_requested and not document_policy["allow_page_numbers"]:
        raise blocked(
            "The create specification adds page numbers that were not requested",
            code="unrequested-page-numbers",
            details={
                "next": (
                    "Remove PAGE/NUMPAGES fields, or rerun prepare with "
                    "--allow-page-numbers and the matching --allow-header or "
                    "--allow-footer only when explicitly requested."
                )
            },
        )
    locale = str(spec.get("locale", "en-US"))
    style_policy, style_tokens = resolve_document_style(
        locale=locale,
        style_policy_value=spec_policy,
        style_overrides_value=spec.get("style_overrides"),
    )
    resolved_fonts = resolve_fonts(style_tokens)
    style_tokens["body_font"] = resolved_fonts["latin"]
    style_tokens["east_asia_font"] = resolved_fonts["east_asia"]
    output = prepare_output_docx_path(output_path, overwrite=overwrite)

    doc = Document()
    _configure_document(doc, spec, style_tokens)
    set_document_update_fields_on_open(
        doc,
        enabled=bool(spec.get("update_fields_on_open", False)),
    )
    props = doc.core_properties
    props.author = ""
    props.last_modified_by = ""
    props.comments = ""
    metadata = spec.get("metadata", {})
    if isinstance(metadata, dict):
        for field in ("title", "subject", "author", "keywords", "category", "comments"):
            if field in metadata:
                setattr(props, field, str(metadata[field]))

    if spec.get("header"):
        for section in doc.sections:
            paragraph = section.header.paragraphs[0]
            _set_story(paragraph, spec["header"], style_tokens)
    if spec.get("footer"):
        for section in doc.sections:
            paragraph = section.footer.paragraphs[0]
            _set_story(paragraph, spec["footer"], style_tokens)

    content = spec.get("content", [])
    if not isinstance(content, list):
        raise DocxSkillError("content must be an array")
    rendered_content = _structured_content(content, document_structure)
    for block in rendered_content:
        if not isinstance(block, dict):
            raise DocxSkillError("Every content block must be an object")
        _add_content_block(doc, block, style_tokens, spec_file.parent)

    with temporary_sibling(output, suffix=".tmp.docx") as temp:
        doc.save(str(temp))
        assert_valid_docx(temp)
        temp.replace(output)
    validation = assert_valid_docx(output)
    return {
        "status": "ok",
        "out": str(output),
        "style_policy": style_policy,
        "template": style_tokens["template"],
        "fonts": resolved_fonts,
        "blocks": len(content),
        "document_structure": document_structure,
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


def _replace_range(
    paragraph: Paragraph, start: int, end: int, replacement: str
) -> None:
    spans = _run_spans(paragraph)
    start_index = next((i for i, (a, b, _) in enumerate(spans) if a <= start < b), None)
    end_index = next((i for i, (a, b, _) in enumerate(spans) if a < end <= b), None)
    if start_index is None or end_index is None:
        raise DocxSkillError(
            "Unable to map a text replacement back to Word runs",
            code="edit-run-mapping-failed",
        )
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


def _replace_all(paragraph: Paragraph, match: str, replacement: str) -> int:
    """Replace original non-overlapping matches without re-matching inserted text."""
    full_text = "".join(run.text for run in paragraph.runs)
    starts = _match_starts(full_text, match)
    for start in reversed(starts):
        _replace_range(paragraph, start, start + len(match), replacement)
    return len(starts)


def _match_starts(text: str, match: str) -> list[int]:
    starts: list[int] = []
    cursor = 0
    while True:
        start = text.find(match, cursor)
        if start < 0:
            break
        starts.append(start)
        cursor = start + len(match)
    return starts


def _replace_selected_text(
    matches: list[tuple[str, Paragraph]],
    match: str,
    replacement: str,
    occurrence: Any,
) -> tuple[int, list[str]]:
    if occurrence == "all":
        affected = 0
        locations: list[str] = []
        for location, paragraph in matches:
            count = _replace_all(paragraph, match, replacement)
            affected += count
            if count and location not in locations:
                locations.append(location)
        return affected, locations

    targets: list[tuple[str, Paragraph, int]] = []
    for location, paragraph in matches:
        text = "".join(run.text for run in paragraph.runs)
        targets.extend(
            (location, paragraph, start)
            for start in _match_starts(text, match)
        )

    if occurrence in (None, ""):
        if len(targets) > 1:
            raise DocxSkillError(
                f"replace_text matched {len(targets)} text occurrences; "
                "specify occurrence or location",
                status="partial",
                code="ambiguous-edit-target",
                details={"matches": [location for location, _, _ in targets[:20]]},
            )
        selected = targets[:1]
    elif occurrence == "first":
        selected = targets[:1]
    else:
        try:
            index = int(occurrence)
        except (TypeError, ValueError) as exc:
            raise DocxSkillError(
                "replace_text.occurrence must be 'all', 'first', or a positive integer"
            ) from exc
        if index < 1:
            raise DocxSkillError("replace_text.occurrence must be positive")
        selected = targets[index - 1 : index]

    for _, paragraph, start in selected:
        _replace_range(paragraph, start, start + len(match), replacement)
    locations = list(dict.fromkeys(location for location, _, _ in selected))
    return len(selected), locations


def _matching_paragraphs(
    doc: DocumentObject, match: str, location: str | None = None
) -> list[tuple[str, Paragraph]]:
    return [
        (paragraph_location, paragraph)
        for paragraph_location, paragraph in iter_document_paragraphs(doc)
        if match in paragraph.text
        and (not location or paragraph_location.startswith(location))
    ]


def _select_paragraphs(
    matches: list[tuple[str, Paragraph]],
    occurrence: Any,
    *,
    action: str,
) -> list[tuple[str, Paragraph]]:
    if occurrence == "all":
        return matches
    if occurrence in (None, ""):
        if len(matches) > 1:
            raise DocxSkillError(
                f"{action} matched {len(matches)} paragraphs; specify occurrence or location",
                status="partial",
                code="ambiguous-edit-target",
                details={"matches": [location for location, _ in matches[:20]]},
            )
        return matches[:1]
    if occurrence == "first":
        return matches[:1]
    try:
        index = int(occurrence)
    except (TypeError, ValueError) as exc:
        raise DocxSkillError(
            f"{action}.occurrence must be 'all', 'first', or a positive integer"
        ) from exc
    if index < 1:
        raise DocxSkillError(f"{action}.occurrence must be positive")
    return matches[index - 1 : index]


def _insert_after(paragraph: Paragraph, text: str, style: str | None) -> Paragraph:
    new_element = OxmlElement("w:p")
    paragraph._p.addnext(new_element)
    new_paragraph = Paragraph(new_element, paragraph._parent)
    if style:
        new_paragraph.style = style
    new_paragraph.add_run(text)
    return new_paragraph


def _insert_image_relative(
    paragraph: Paragraph,
    *,
    image_path: Path,
    placement: str,
    width_inches: float,
    caption: str,
    alt_text: str,
) -> dict[str, Any]:
    image_element = OxmlElement("w:p")
    image_paragraph = Paragraph(image_element, paragraph._parent)
    image_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    metadata = _add_normalized_picture(
        image_paragraph,
        image_path,
        width_inches=width_inches,
        alt_text=alt_text,
    )
    image_paragraph.paragraph_format.keep_with_next = bool(caption)
    if placement == "before":
        paragraph._p.addprevious(image_element)
    else:
        paragraph._p.addnext(image_element)
    if caption:
        caption_element = OxmlElement("w:p")
        caption_paragraph = Paragraph(caption_element, paragraph._parent)
        try:
            caption_paragraph.style = "Caption"
        except KeyError:
            pass
        caption_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        caption_paragraph.add_run(caption)
        image_element.addnext(caption_element)
    return metadata


def _delete_paragraph(paragraph: Paragraph) -> None:
    element = paragraph._element
    element.getparent().remove(element)
    paragraph._p = paragraph._element = None


def edit_docx(
    input_path: str | Path,
    patch_path: str | Path,
    output_path: str | Path,
    *,
    acceptance_path: str | Path | None = None,
    allow_lossy: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    source, output = require_distinct_paths(
        input_path, output_path, overwrite=overwrite
    )
    patch_file = assert_internal_control_path(
        patch_path,
        purpose="Edit patch",
    )
    assert_control_path_is_distinct(
        patch_file,
        output,
        purpose="Edit patch",
    )
    assert_safe_mutation(source, operation="edit")
    patch = load_json(patch_file)
    if not isinstance(patch, dict) or not isinstance(patch.get("operations"), list):
        raise DocxSkillError("Patch must contain an operations array")
    validate_edit_patch(patch)
    document_policy = normalize_document_policy(None)
    if acceptance_path is not None:
        acceptance_file = assert_internal_control_path(
            acceptance_path,
            purpose="Acceptance manifest",
        )
        acceptance = load_json(acceptance_file)
        if not isinstance(acceptance, dict):
            raise DocxSkillError(
                "Acceptance manifest must be an object",
                code="invalid-acceptance-manifest",
            )
        document_policy = normalize_document_policy(
            acceptance.get("document_policy")
        )
    for operation in patch["operations"]:
        if not isinstance(operation, dict):
            continue
        action = str(operation.get("action", ""))
        if action in {"set_header", "set_footer"}:
            story_name = "header" if action == "set_header" else "footer"
            if not document_policy[f"allow_{story_name}"]:
                raise blocked(
                    f"The edit patch adds or changes an unrequested {story_name}",
                    code=f"unrequested-{story_name}",
                    details={
                        "next": (
                            f"Remove set_{story_name}, or rerun prepare with "
                            f"--allow-{story_name} only when the user explicitly "
                            "requested the change."
                        )
                    },
                )
            if (
                re.search(
                    r"\{(?:PAGE|NUMPAGES)\}",
                    str(operation.get("text", "")),
                    re.IGNORECASE,
                )
                and not document_policy["allow_page_numbers"]
            ):
                raise blocked(
                    "The edit patch adds page numbers that were not requested",
                    code="unrequested-page-numbers",
                    details={
                        "next": (
                            "Remove PAGE/NUMPAGES fields, or rerun prepare with "
                            "--allow-page-numbers."
                        )
                    },
                )
    source_info = inspect_docx(source)
    features = source_info.get("package_features", {})
    high_risk = {
        "embeddings": features.get("embeddings"),
        "charts": features.get("charts"),
        "content_controls": features.get("content_controls"),
    }
    present_high_risk = {key: value for key, value in high_risk.items() if value}
    if present_high_risk and not allow_lossy:
        raise blocked(
            "The document contains package-sensitive features that a python-docx round trip "
            "may not preserve. Use fallback-patch for a targeted OOXML change or obtain explicit "
            "permission for --allow-lossy.",
            code="lossy-edit-blocked",
            details={"features": present_high_risk},
        )
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
            occurrence = operation.get("occurrence")
            location = str(operation.get("location", "")) or None
            matches = _matching_paragraphs(doc, match, location)
            affected, locations = _replace_selected_text(
                matches, match, replacement, occurrence
            )
            operation["_locations"] = locations
        elif action == "insert_after":
            match = str(operation.get("match", ""))
            matches = _matching_paragraphs(
                doc, match, str(operation.get("location", "")) or None
            )
            selected = _select_paragraphs(matches, operation.get("occurrence"), action=action)
            for _, paragraph in selected:
                _insert_after(paragraph, str(operation.get("text", "")), operation.get("style"))
                affected += 1
        elif action == "insert_image":
            match = str(operation.get("match", ""))
            matches = _matching_paragraphs(
                doc, match, str(operation.get("location", "")) or None
            )
            selected = _select_paragraphs(
                matches,
                operation.get("occurrence"),
                action=action,
            )
            image_path = resolve_local_image(
                operation.get("path"),
                base_dir=patch_file.parent,
            )
            image_metadata: list[dict[str, Any]] = []
            for _, paragraph in selected:
                image_metadata.append(
                    _insert_image_relative(
                        paragraph,
                        image_path=image_path,
                        placement=str(operation.get("placement", "after")),
                        width_inches=float(operation.get("width_inches", 5.5)),
                        caption=str(operation.get("caption", "")),
                        alt_text=str(operation.get("alt_text", "")),
                    )
                )
                affected += 1
            operation["_image_metadata"] = image_metadata
        elif action == "delete_paragraph":
            match = str(operation.get("match", ""))
            matches = _matching_paragraphs(
                doc, match, str(operation.get("location", "")) or None
            )
            selected = _select_paragraphs(matches, operation.get("occurrence"), action=action)
            for _, paragraph in selected:
                _delete_paragraph(paragraph)
                affected += 1
        elif action == "set_style":
            match = str(operation.get("match", ""))
            style = str(operation.get("style", ""))
            if not style:
                raise DocxSkillError("set_style requires style")
            matches = _matching_paragraphs(
                doc, match, str(operation.get("location", "")) or None
            )
            selected = _select_paragraphs(matches, operation.get("occurrence"), action=action)
            for _, paragraph in selected:
                paragraph.style = style
                affected += 1
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
        elif action in {"set_header", "set_footer"}:
            target_name = "header" if action == "set_header" else "footer"
            alignment = _paragraph_alignment(str(operation.get("alignment", "center")))
            seen_parts: set[str] = set()
            for section in doc.sections:
                story = getattr(section, target_name)
                part_name = str(story.part.partname)
                if part_name in seen_parts:
                    continue
                seen_parts.add(part_name)
                paragraph = story.paragraphs[0]
                paragraph.clear()
                paragraph.alignment = alignment
                _populate_field_template(
                    paragraph,
                    str(operation.get("text", "")),
                    {
                        "body_font": doc.styles["Normal"].font.name or "Arial",
                        "east_asia_font": doc.styles["Normal"].font.name or "Microsoft YaHei",
                    },
                )
                affected += 1
        elif action == "set_table_cell":
            table_index = int(operation.get("table", 0))
            row_index = int(operation.get("row", 0))
            column_index = int(operation.get("column", 0))
            if table_index < 1 or table_index > len(doc.tables):
                raise DocxSkillError("set_table_cell.table is out of range")
            table = doc.tables[table_index - 1]
            if row_index < 1 or row_index > len(table.rows):
                raise DocxSkillError("set_table_cell.row is out of range")
            if column_index < 1 or column_index > len(table.columns):
                raise DocxSkillError("set_table_cell.column is out of range")
            table.cell(row_index - 1, column_index - 1).text = str(operation.get("text", ""))
            affected = 1
        elif action == "append_table_row":
            table_index = int(operation.get("table", 0))
            values = operation.get("values")
            if table_index < 1 or table_index > len(doc.tables):
                raise DocxSkillError("append_table_row.table is out of range")
            table = doc.tables[table_index - 1]
            if not isinstance(values, list) or len(values) != len(table.columns):
                raise DocxSkillError(
                    "append_table_row.values must contain one value per table column"
                )
            new_row = table.add_row()
            _keep_table_row_together(new_row)
            cells = new_row.cells
            for index, value in enumerate(values):
                cells[index].text = str(value)
            affected = 1
        else:
            raise DocxSkillError(f"Unsupported edit action: {action}")
        if affected == 0 and not bool(operation.get("allow_missing", False)):
            raise DocxSkillError(
                f"{action} did not affect the document",
                status="partial",
                code="edit-target-not-found",
                details={"action": action, "match": operation.get("match")},
            )
        operation_results.append(
            {
                "action": action,
                "affected": affected,
                "locations": operation.pop("_locations", []),
                "images": operation.pop("_image_metadata", []),
            }
        )

    with temporary_sibling(output, suffix=".tmp.docx") as temp:
        doc.save(str(temp))
        assert_valid_docx(temp)
        temp.replace(output)
    validation = assert_valid_docx(output)
    return {
        "status": "ok",
        "input": str(source),
        "out": str(output),
        "operations": operation_results,
        "lossy_override": allow_lossy,
        "validation": validation,
    }


def compare_docx(before_path: str | Path, after_path: str | Path, output_json: str | Path) -> dict[str, Any]:
    before_source = require_docx_path(before_path)
    after_source = require_docx_path(after_path)
    json_output = prepare_json_artifact_path(
        output_json,
        protected_paths=(before_source, after_source),
        purpose="Comparison output",
    )
    before = inspect_docx(before_source)
    after = inspect_docx(after_source)
    comparison_coverage = {
        "before": before.get("inspection_coverage"),
        "after": after.get("inspection_coverage"),
    }
    coverage_complete = all(
        item.get("status") == "complete"
        for item in comparison_coverage.values()
        if isinstance(item, dict)
    )
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
        "status": "ok" if coverage_complete else "partial",
        "before": str(before_source),
        "after": str(after_source),
        "inspection_coverage": comparison_coverage,
        "paragraph_count_before": len(before_lines),
        "paragraph_count_after": len(after_lines),
        "table_count_before": before["table_count"],
        "table_count_after": after["table_count"],
        "heading_count_before": len(before["headings"]),
        "heading_count_after": len(after["headings"]),
        "section_count_before": len(before["sections"]),
        "section_count_after": len(after["sections"]),
        "field_count_before": len(before.get("fields", [])),
        "field_count_after": len(after.get("fields", [])),
        "image_count_before": before.get("image_parts", 0),
        "image_count_after": after.get("image_parts", 0),
        "package_feature_changes": {
            key: {
                "before": before.get("package_features", {}).get(key),
                "after": after.get("package_features", {}).get(key),
            }
            for key in sorted(
                set(before.get("package_features", {}))
                | set(after.get("package_features", {}))
            )
            if before.get("package_features", {}).get(key)
            != after.get("package_features", {}).get(key)
        },
        "metadata_changes": {
            key: {"before": before["metadata"].get(key), "after": after["metadata"].get(key)}
            for key in sorted(set(before["metadata"]) | set(after["metadata"]))
            if before["metadata"].get(key) != after["metadata"].get(key)
        },
        "diff": diff,
    }
    write_json(json_output, result)
    result["out"] = str(json_output)
    return result


def sanitize_docx(
    input_path: str | Path,
    output_path: str | Path,
    *,
    remove_comments: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    source, output = require_distinct_paths(
        input_path, output_path, overwrite=overwrite
    )
    assert_safe_mutation(source, operation="sanitize")
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
        "scope": [
            "core author, last-modified-by, subject, and keywords",
            "custom properties",
            "Word rsid attributes",
            "comments" if remove_comments else "comments retained",
        ],
        "remaining_risks": [
            "visible text and images are not redacted",
            "embedded object and image metadata are not recursively sanitized",
            "external relationship targets are not removed",
        ],
        "validation": assert_valid_docx(output),
    }
