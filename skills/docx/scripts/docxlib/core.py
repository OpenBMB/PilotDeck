from __future__ import annotations

import difflib
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterator

from docx import Document
from docx.document import Document as DocumentObject
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from lxml import etree

from .common import (
    DocxSkillError,
    active_content_parts,
    assert_safe_mutation,
    assert_valid_docx,
    document_protection_details,
    effective_document_protection_details,
    pack_docx,
    prepare_json_artifact_path,
    require_distinct_paths,
    require_docx_path,
    unpacked_copy,
    write_json,
)


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
    before_fields = before.get("fields", [])
    after_fields = after.get("fields", [])

    def field_counter(fields: list[dict[str, str]]) -> Counter[tuple[str, str, str]]:
        return Counter(
            (
                str(field.get("part", "")),
                str(field.get("instruction", "")),
                str(field.get("form", "")),
            )
            for field in fields
        )

    def field_changes(
        source: Counter[tuple[str, str, str]],
        target: Counter[tuple[str, str, str]],
    ) -> list[dict[str, Any]]:
        return [
            {
                "part": part,
                "instruction": instruction,
                "form": form,
                "count": count,
            }
            for (part, instruction, form), count in sorted((source - target).items())
        ]

    before_field_counter = field_counter(before_fields)
    after_field_counter = field_counter(after_fields)
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
        "field_count_before": len(before_fields),
        "field_count_after": len(after_fields),
        "fields_removed": field_changes(before_field_counter, after_field_counter),
        "fields_added": field_changes(after_field_counter, before_field_counter),
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
            from .annotations import strip_comments_from_package

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
