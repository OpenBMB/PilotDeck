from __future__ import annotations

import re
import tempfile
import unicodedata
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree

from .common import (
    DocxSkillError,
    pack_docx,
    require_distinct_paths,
    unpacked_copy,
)
from .fields import set_package_update_fields_on_open
from .render import render_docx


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}
TOC_PLACEHOLDERS = (
    "update this field to populate the table of contents",
    "right-click and choose update field",
    "目录将在最终校验时生成",
    "the table of contents will be generated during final validation",
)
HEADING_STYLE = re.compile(r"^heading\s+([1-9])$", re.IGNORECASE)


def _normalized(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def _heading_needles(value: str) -> list[str]:
    normalized = _normalized(value)
    without_numbering = re.sub(
        r"^(?:第?[0-9一二三四五六七八九十百]+(?:章|节|部分)?|[a-z])",
        "",
        normalized,
        flags=re.IGNORECASE,
    )
    return list(
        dict.fromkeys(
            item
            for item in (normalized, without_numbering)
            if len(item) >= 2
        )
    )


def _page_match_score(needle: str, haystack: str) -> float:
    if not needle or not haystack:
        return 0.0
    if needle in haystack:
        return 1.0
    if len(needle) < 4:
        return 0.0
    grams = {needle[index : index + 2] for index in range(len(needle) - 1)}
    if not grams:
        return 0.0
    matched = sum(1 for gram in grams if gram in haystack)
    anchor_bonus = 0.1 if needle[:4] in haystack or needle[-4:] in haystack else 0.0
    return min(1.0, matched / len(grams) + anchor_bonus)


def _field_paragraph(root: etree._Element) -> etree._Element | None:
    for instruction in root.xpath(".//w:instrText", namespaces=NS):
        if re.search(r"\bTOC\b", str(instruction.text or ""), re.IGNORECASE):
            return instruction.getparent().getparent()
    return None


def _paragraph_text(paragraph: etree._Element) -> str:
    return "".join(paragraph.xpath(".//w:t/text()", namespaces=NS))


def toc_status(input_path: str | Path) -> dict[str, Any]:
    source = Path(input_path).expanduser().resolve()
    with unpacked_copy(source) as (_, package):
        document_xml = package / "word" / "document.xml"
        parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
        root = etree.parse(str(document_xml), parser).getroot()
        paragraph = _field_paragraph(root)
        if paragraph is None:
            return {
                "present": False,
                "populated": False,
                "entries": 0,
                "placeholder": False,
            }
        field_text = _paragraph_text(paragraph).strip()
        normalized = field_text.casefold()
        placeholder = any(value in normalized for value in TOC_PLACEHOLDERS)
        page_numbers = re.findall(r"(?:^|\s)(\d{1,4})(?=\s|$)", field_text)
        line_breaks = len(paragraph.xpath(".//w:br", namespaces=NS))
        entries = max(line_breaks + (1 if field_text else 0), len(page_numbers))
        return {
            "present": True,
            "populated": bool(field_text and not placeholder and entries > 0),
            "entries": entries,
            "placeholder": placeholder,
            "cached_text": field_text[:500],
        }


def _heading_records(source: Path) -> tuple[list[dict[str, Any]], str | None]:
    document = Document(str(source))
    records: list[dict[str, Any]] = []
    toc_title: str | None = None
    paragraphs = list(document.paragraphs)
    for index, paragraph in enumerate(paragraphs):
        text = paragraph.text.strip()
        style_name = paragraph.style.name if paragraph.style else ""
        match = HEADING_STYLE.match(style_name)
        if not match or not text:
            continue
        if index + 1 < len(paragraphs):
            next_xml = paragraphs[index + 1]._p.xml
            if re.search(r"\bTOC\b", next_xml, re.IGNORECASE):
                toc_title = text
                continue
        records.append(
            {
                "text": text,
                "level": int(match.group(1)),
            }
        )
    return records, toc_title


def _assign_pages(
    headings: list[dict[str, Any]],
    page_text: list[dict[str, Any]],
    toc_title: str | None,
) -> list[dict[str, Any]]:
    pages = [
        {
            "page": int(item["page"]),
            "text": _normalized(str(item.get("text", ""))),
        }
        for item in page_text
    ]
    first_body_page = 1
    if toc_title:
        normalized_title = _normalized(toc_title)
        toc_pages = [item["page"] for item in pages if normalized_title in item["text"]]
        if toc_pages:
            first_body_page = min(toc_pages) + 1
        stream = ""
        page_spans: list[tuple[int, int, int]] = []
        for item in pages:
            start = len(stream)
            stream += item["text"]
            page_spans.append((start, len(stream), item["page"]))
        title_position = stream.find(normalized_title)
        cursor_position = (
            title_position + len(normalized_title)
            if title_position >= 0
            else 0
        )
        complete_cached_sequence = True
        for heading in headings:
            position = stream.find(_normalized(heading["text"]), cursor_position)
            if position < 0:
                complete_cached_sequence = False
                break
            cursor_position = position + len(_normalized(heading["text"]))
        if complete_cached_sequence and headings:
            first_body_position = stream.find(
                _normalized(headings[0]["text"]),
                cursor_position,
            )
            if first_body_position >= 0:
                first_body_page = next(
                    (
                        page
                        for start, end, page in page_spans
                        if start <= first_body_position < end
                    ),
                    first_body_page,
                )
    cursor = first_body_page
    assigned: list[dict[str, Any]] = []
    missing: list[str] = []
    for heading in headings:
        needles = _heading_needles(heading["text"])
        candidates = [
            (
                max(
                    (_page_match_score(needle, item["text"]) for needle in needles),
                    default=0.0,
                ),
                item,
            )
            for item in pages
            if item["page"] >= cursor
        ]
        match_score, match = max(
            candidates,
            key=lambda candidate: (candidate[0], -candidate[1]["page"]),
            default=(0.0, None),
        )
        if match_score < 0.72:
            match = None
        if match is None:
            missing.append(heading["text"])
            continue
        assigned.append({**heading, "page": match["page"]})
        cursor = match["page"]
    if missing:
        raise DocxSkillError(
            "Could not locate every semantic heading in the rendered document",
            status="partial",
            code="toc-heading-page-unresolved",
            details={"missing_headings": missing},
        )
    return assigned


def _append_text_run(paragraph: etree._Element, text: str) -> etree._Element:
    run = etree.SubElement(paragraph, qn("w:r"))
    node = etree.SubElement(run, qn("w:t"))
    if text.startswith(" ") or text.endswith(" "):
        node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    node.text = text
    return run


def _replace_cached_result(
    package: Path,
    entries: list[dict[str, Any]],
) -> None:
    document_xml = package / "word" / "document.xml"
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    tree = etree.parse(str(document_xml), parser)
    root = tree.getroot()
    paragraph = _field_paragraph(root)
    if paragraph is None:
        raise DocxSkillError(
            "The document has no TOC field to refresh",
            status="unsupported",
            code="toc-not-found",
        )
    children = list(paragraph)
    separate_index = next(
        (
            index
            for index, child in enumerate(children)
            if child.find(
                './/w:fldChar[@w:fldCharType="separate"]',
                namespaces=NS,
            )
            is not None
        ),
        None,
    )
    end_index = next(
        (
            index
            for index, child in enumerate(children)
            if child.find(
                './/w:fldChar[@w:fldCharType="end"]',
                namespaces=NS,
            )
            is not None
        ),
        None,
    )
    if separate_index is None or end_index is None or end_index <= separate_index:
        raise DocxSkillError(
            "The TOC field has an invalid cached-result boundary",
            code="toc-field-invalid",
        )
    for child in children[separate_index + 1 : end_index]:
        paragraph.remove(child)
    end_run = list(paragraph)[separate_index + 1]

    properties = paragraph.find(qn("w:pPr"))
    if properties is None:
        properties = etree.Element(qn("w:pPr"))
        paragraph.insert(0, properties)
    tabs = properties.find(qn("w:tabs"))
    if tabs is None:
        tabs = etree.SubElement(properties, qn("w:tabs"))
    for existing in list(tabs):
        tabs.remove(existing)
    tab_stop = etree.SubElement(tabs, qn("w:tab"))
    tab_stop.set(qn("w:val"), "right")
    tab_stop.set(qn("w:leader"), "dot")
    tab_stop.set(qn("w:pos"), "9000")

    insertion_index = list(paragraph).index(end_run)
    for index, entry in enumerate(entries):
        indent = "\u3000" * max(0, int(entry["level"]) - 1)
        text_run = _append_text_run(
            paragraph,
            f"{indent}{entry['text']}",
        )
        paragraph.remove(text_run)
        paragraph.insert(insertion_index, text_run)
        insertion_index += 1
        tab_run = etree.Element(qn("w:r"))
        etree.SubElement(tab_run, qn("w:tab"))
        paragraph.insert(insertion_index, tab_run)
        insertion_index += 1
        page_run = etree.Element(qn("w:r"))
        page_text = etree.SubElement(page_run, qn("w:t"))
        page_text.text = str(entry["page"])
        if index < len(entries) - 1:
            etree.SubElement(page_run, qn("w:br"))
        paragraph.insert(insertion_index, page_run)
        insertion_index += 1
    tree.write(
        str(document_xml),
        encoding="UTF-8",
        xml_declaration=True,
        standalone=True,
    )


def refresh_toc(
    input_path: str | Path,
    output_path: str | Path,
    render_dir: str | Path,
    *,
    overwrite: bool = False,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    source, output = require_distinct_paths(
        input_path,
        output_path,
        overwrite=overwrite,
    )
    headings, toc_title = _heading_records(source)
    if not headings:
        raise DocxSkillError(
            "A populated TOC requires semantic Heading styles",
            status="partial",
            code="toc-has-no-headings",
        )
    render_root = Path(render_dir).expanduser().resolve()
    render_root.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    stable_source: Path | None = None
    completed_iterations = 0
    with tempfile.TemporaryDirectory(
        prefix="toc-refresh-",
        dir=render_root,
    ) as temporary_dir:
        working_source = source
        previous_entries: list[dict[str, Any]] | None = None
        for iteration in range(1, 6):
            completed_iterations = iteration
            iteration_root = Path(temporary_dir) / f"iteration-{iteration}"
            rendered = render_docx(
                working_source,
                iteration_root,
                dpi=120,
                emit_pdf=False,
                include_text=True,
                timeout_seconds=timeout_seconds,
            )
            entries = _assign_pages(
                headings,
                rendered["page_text"],
                toc_title,
            )
            if previous_entries is not None and entries == previous_entries:
                stable_source = working_source
                break
            next_source = Path(temporary_dir) / f"candidate-{iteration}.docx"
            with unpacked_copy(working_source) as (_, package):
                _replace_cached_result(package, entries)
                pack_docx(package, next_source)
            working_source = next_source
            previous_entries = entries
        if stable_source is None:
            raise DocxSkillError(
                "TOC page numbers did not stabilize after five render cycles",
                status="partial",
                code="toc-pagination-did-not-converge",
                details={"iterations": 5},
            )
        with unpacked_copy(stable_source) as (_, package):
            set_package_update_fields_on_open(package, enabled=False)
            pack_docx(package, output)
    final_render = render_docx(
        output,
        render_root,
        dpi=120,
        emit_pdf=False,
        include_text=False,
        timeout_seconds=timeout_seconds,
    )
    status = toc_status(output)
    if not status["populated"]:
        raise DocxSkillError(
            "The refreshed TOC did not produce a visible cached result",
            code="toc-refresh-failed",
        )
    return {
        "status": "ok",
        "code": "toc-refreshed",
        "input": str(source),
        "out": str(output),
        "entries": entries,
        "toc": status,
        "rendered_pages": int(final_render["pages"]),
        "iterations": completed_iterations,
    }
