from __future__ import annotations

import re
import zipfile
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

from .common import prepare_json_artifact_path, require_docx_path, write_json
from .core import inspect_docx, iter_document_paragraphs, iter_document_tables


WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
HEADING = re.compile(r"^heading\s+(\d+)$", re.IGNORECASE)


def _image_alt_texts(path: Path) -> list[str]:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    values: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for part_name in archive.namelist():
            if not part_name.startswith("word/") or not part_name.endswith(".xml"):
                continue
            root = etree.fromstring(archive.read(part_name), parser)
            for node in root.findall(f".//{{{WP_NS}}}docPr"):
                values.append((node.get("descr") or node.get("title") or "").strip())
    return values


def _has_repeat_header(row: Any) -> bool:
    properties = row._tr.trPr
    return properties is not None and properties.find(qn("w:tblHeader")) is not None


def inspect_accessibility(
    input_path: str | Path,
    output_json: str | Path | None = None,
) -> dict[str, Any]:
    """Report semantic accessibility evidence without declaring compliance."""

    path = require_docx_path(input_path)
    output = (
        prepare_json_artifact_path(
            output_json,
            protected_paths=(path,),
            purpose="Accessibility report",
        )
        if output_json
        else None
    )
    inspection = inspect_docx(path)
    document = Document(str(path))
    advisories: list[dict[str, Any]] = []
    headings: list[tuple[int, str, str]] = []

    for location, paragraph in iter_document_paragraphs(document):
        text = paragraph.text.strip()
        style_name = paragraph.style.name if paragraph.style else ""
        match = HEADING.match(style_name)
        if match and text:
            headings.append((int(match.group(1)), text[:80], location))

    for index, (level, text, location) in enumerate(headings):
        previous_level = headings[index - 1][0] if index else 0
        if level > previous_level + 1:
            advisories.append(
                {
                    "code": "heading-level-jump",
                    "message": f"Heading hierarchy jumps from level {previous_level} to {level}: {text}",
                    "location": location,
                }
            )

    for table_index, (location, table) in enumerate(iter_document_tables(document), start=1):
        if len(table.rows) > 1 and not _has_repeat_header(table.rows[0]):
            advisories.append(
                {
                    "code": "table-header-not-marked",
                    "message": "The first row is not marked as a repeating table header.",
                    "location": f"{location} (table {table_index})",
                }
            )

    alt_texts = _image_alt_texts(path)
    for index, alt_text in enumerate(alt_texts, start=1):
        if not alt_text:
            advisories.append(
                {
                    "code": "missing-image-alt-text",
                    "message": "The image has no alternative text.",
                    "location": f"image {index}",
                }
            )

    result: dict[str, Any] = {
        "status": "ok",
        "message": "Use these semantic facts as review evidence; this is not a compliance verdict.",
        "input": str(path),
        "summary": {
            "headings": len(headings),
            "tables": inspection["table_count"],
            "images": len(alt_texts),
            "advisories": len(advisories),
        },
        "advisories": advisories,
        "validation": inspection["validation"],
    }
    if output:
        write_json(output, result)
        result["out"] = str(output)
    return result
