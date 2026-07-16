from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lxml import etree

from .common import (
    DocxSkillError,
    assert_valid_docx,
    load_json,
    pack_docx,
    require_distinct_paths,
    unpacked_copy,
)


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
NS = {"w": W_NS, "r": R_NS}


def _qn(namespace: str, local: str) -> str:
    return f"{{{namespace}}}{local}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _parser() -> etree.XMLParser:
    return etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)


def _write_tree(tree: etree._ElementTree, path: Path) -> None:
    tree.write(str(path), encoding="UTF-8", xml_declaration=True, standalone=True)


def _paragraph_text(paragraph: etree._Element) -> str:
    return "".join(paragraph.xpath(".//w:t/text() | .//w:delText/text()", namespaces=NS))


def _next_numeric_id(root: etree._Element, xpath: str) -> int:
    used: list[int] = []
    for element in root.xpath(xpath, namespaces=NS):
        value = element.get(_qn(W_NS, "id"))
        try:
            used.append(int(value))
        except (TypeError, ValueError):
            continue
    return (max(used) + 1) if used else 0


def _ensure_comments_part(package: Path) -> tuple[etree._ElementTree, Path]:
    comments_path = package / "word" / "comments.xml"
    if comments_path.exists():
        comments_tree = etree.parse(str(comments_path), _parser())
    else:
        root = etree.Element(_qn(W_NS, "comments"), nsmap={"w": W_NS})
        comments_tree = etree.ElementTree(root)
        _write_tree(comments_tree, comments_path)

    rels_path = package / "word" / "_rels" / "document.xml.rels"
    rels_path.parent.mkdir(parents=True, exist_ok=True)
    if rels_path.exists():
        rels_tree = etree.parse(str(rels_path), _parser())
        rels_root = rels_tree.getroot()
    else:
        rels_root = etree.Element(_qn(PKG_REL_NS, "Relationships"), nsmap={None: PKG_REL_NS})
        rels_tree = etree.ElementTree(rels_root)
    comment_type = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
    if not any(rel.get("Type") == comment_type for rel in rels_root):
        used_ids = []
        for rel in rels_root:
            value = rel.get("Id", "")
            if value.startswith("rId") and value[3:].isdigit():
                used_ids.append(int(value[3:]))
        rel = etree.SubElement(rels_root, _qn(PKG_REL_NS, "Relationship"))
        rel.set("Id", f"rId{(max(used_ids) + 1) if used_ids else 1}")
        rel.set("Type", comment_type)
        rel.set("Target", "comments.xml")
        _write_tree(rels_tree, rels_path)

    content_types_path = package / "[Content_Types].xml"
    content_tree = etree.parse(str(content_types_path), _parser())
    content_root = content_tree.getroot()
    if not any(
        element.get("PartName") == "/word/comments.xml"
        for element in content_root.findall(_qn(CT_NS, "Override"))
    ):
        override = etree.SubElement(content_root, _qn(CT_NS, "Override"))
        override.set("PartName", "/word/comments.xml")
        override.set(
            "ContentType",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
        )
        _write_tree(content_tree, content_types_path)
    return comments_tree, comments_path


def _add_comment(
    document_root: etree._Element,
    comments_root: etree._Element,
    match: str,
    comment_text: str,
    author: str,
    date_iso: str,
) -> dict[str, Any]:
    if not match:
        raise DocxSkillError("Comment match must not be empty")
    target = next(
        (paragraph for paragraph in document_root.xpath(".//w:p", namespaces=NS) if match in _paragraph_text(paragraph)),
        None,
    )
    if target is None:
        raise DocxSkillError(f"Comment match was not found: {match}")
    runs = target.xpath("./w:r | ./w:hyperlink/w:r", namespaces=NS)
    if not runs:
        raise DocxSkillError(f"Matched paragraph has no commentable runs: {match}")

    existing_ids = []
    for comment in comments_root.findall(_qn(W_NS, "comment")):
        try:
            existing_ids.append(int(comment.get(_qn(W_NS, "id"))))
        except (TypeError, ValueError):
            continue
    comment_id = (max(existing_ids) + 1) if existing_ids else 0

    first_direct = runs[0]
    while first_direct.getparent() is not target:
        first_direct = first_direct.getparent()
    last_direct = runs[-1]
    while last_direct.getparent() is not target:
        last_direct = last_direct.getparent()

    start = etree.Element(_qn(W_NS, "commentRangeStart"))
    start.set(_qn(W_NS, "id"), str(comment_id))
    target.insert(target.index(first_direct), start)

    end = etree.Element(_qn(W_NS, "commentRangeEnd"))
    end.set(_qn(W_NS, "id"), str(comment_id))
    target.insert(target.index(last_direct) + 1, end)

    reference_run = etree.Element(_qn(W_NS, "r"))
    reference = etree.SubElement(reference_run, _qn(W_NS, "commentReference"))
    reference.set(_qn(W_NS, "id"), str(comment_id))
    target.insert(target.index(end) + 1, reference_run)

    comment = etree.SubElement(comments_root, _qn(W_NS, "comment"))
    comment.set(_qn(W_NS, "id"), str(comment_id))
    comment.set(_qn(W_NS, "author"), author)
    comment.set(_qn(W_NS, "date"), date_iso)
    paragraph = etree.SubElement(comment, _qn(W_NS, "p"))
    run = etree.SubElement(paragraph, _qn(W_NS, "r"))
    text = etree.SubElement(run, _qn(W_NS, "t"))
    text.text = comment_text
    return {"match": match, "comment_id": comment_id}


def _run_with_text(original: etree._Element, text_value: str, *, deleted: bool = False) -> etree._Element:
    run = etree.Element(_qn(W_NS, "r"))
    r_pr = original.find("w:rPr", NS)
    if r_pr is not None:
        run.append(deepcopy(r_pr))
    text = etree.SubElement(run, _qn(W_NS, "delText" if deleted else "t"))
    if text_value[:1].isspace() or text_value[-1:].isspace() or "  " in text_value:
        text.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    text.text = text_value
    return run


def _next_change_id(document_root: etree._Element) -> int:
    used: list[int] = []
    for element in document_root.xpath(".//*[@w:id]", namespaces=NS):
        try:
            used.append(int(element.get(_qn(W_NS, "id"))))
        except (TypeError, ValueError):
            continue
    return (max(used) + 1) if used else 1


def _add_tracked_replacement(
    document_root: etree._Element,
    match: str,
    replacement: str,
    author: str,
    date_iso: str,
) -> dict[str, Any]:
    if not match:
        raise DocxSkillError("Tracked replacement match must not be empty")
    target_run = None
    target_text = ""
    for run in document_root.xpath(".//w:r[not(ancestor::w:del) and not(ancestor::w:ins)]", namespaces=NS):
        run_text = "".join(run.xpath(".//w:t/text()", namespaces=NS))
        if match in run_text:
            target_run = run
            target_text = run_text
            break
    if target_run is None:
        raise DocxSkillError(
            f"Tracked replacement match was not found in a single text run: {match}"
        )

    parent = target_run.getparent()
    position = parent.index(target_run)
    before, after = target_text.split(match, 1)
    change_id = _next_change_id(document_root)
    inserted: list[etree._Element] = []
    if before:
        inserted.append(_run_with_text(target_run, before))

    deletion = etree.Element(_qn(W_NS, "del"))
    deletion.set(_qn(W_NS, "id"), str(change_id))
    deletion.set(_qn(W_NS, "author"), author)
    deletion.set(_qn(W_NS, "date"), date_iso)
    deletion.append(_run_with_text(target_run, match, deleted=True))
    inserted.append(deletion)

    insertion = etree.Element(_qn(W_NS, "ins"))
    insertion.set(_qn(W_NS, "id"), str(change_id + 1))
    insertion.set(_qn(W_NS, "author"), author)
    insertion.set(_qn(W_NS, "date"), date_iso)
    insertion.append(_run_with_text(target_run, replacement))
    inserted.append(insertion)
    if after:
        inserted.append(_run_with_text(target_run, after))

    parent.remove(target_run)
    for offset, element in enumerate(inserted):
        parent.insert(position + offset, element)
    return {"match": match, "replacement": replacement, "change_id": change_id}


def _enable_track_revisions(package: Path) -> None:
    settings_path = package / "word" / "settings.xml"
    if not settings_path.exists():
        raise DocxSkillError("word/settings.xml is missing; cannot enable tracked changes safely")
    tree = etree.parse(str(settings_path), _parser())
    root = tree.getroot()
    if root.find("w:trackRevisions", NS) is None:
        root.insert(0, etree.Element(_qn(W_NS, "trackRevisions")))
        _write_tree(tree, settings_path)


def _disable_track_revisions(package: Path) -> None:
    settings_path = package / "word" / "settings.xml"
    if not settings_path.exists():
        return
    tree = etree.parse(str(settings_path), _parser())
    root = tree.getroot()
    changed = False
    for element in root.findall("w:trackRevisions", NS):
        root.remove(element)
        changed = True
    if changed:
        _write_tree(tree, settings_path)


def review_docx(
    input_path: str | Path, spec_path: str | Path, output_path: str | Path
) -> dict[str, Any]:
    source, output = require_distinct_paths(input_path, output_path)
    spec = load_json(spec_path)
    if not isinstance(spec, dict):
        raise DocxSkillError("Review specification must be an object")
    comments = spec.get("comments", [])
    replacements = spec.get("tracked_replacements", [])
    if not isinstance(comments, list) or not isinstance(replacements, list):
        raise DocxSkillError("comments and tracked_replacements must be arrays")

    with unpacked_copy(source) as (_, package):
        document_path = package / "word" / "document.xml"
        document_tree = etree.parse(str(document_path), _parser())
        document_root = document_tree.getroot()
        date_iso = _now_iso()
        comment_results: list[dict[str, Any]] = []
        replacement_results: list[dict[str, Any]] = []

        if comments:
            comments_tree, comments_path = _ensure_comments_part(package)
            comments_root = comments_tree.getroot()
            for item in comments:
                if not isinstance(item, dict):
                    raise DocxSkillError("Every comment must be an object")
                comment_results.append(
                    _add_comment(
                        document_root,
                        comments_root,
                        str(item.get("match", "")),
                        str(item.get("text", "")),
                        str(item.get("author", "PilotDeck")),
                        str(item.get("date", date_iso)),
                    )
                )
            _write_tree(comments_tree, comments_path)

        if replacements:
            _enable_track_revisions(package)
            for item in replacements:
                if not isinstance(item, dict):
                    raise DocxSkillError("Every tracked replacement must be an object")
                replacement_results.append(
                    _add_tracked_replacement(
                        document_root,
                        str(item.get("match", "")),
                        str(item.get("replacement", "")),
                        str(item.get("author", "PilotDeck")),
                        str(item.get("date", date_iso)),
                    )
                )

        _write_tree(document_tree, document_path)
        pack_docx(package, output)

    return {
        "status": "ok",
        "input": str(source),
        "out": str(output),
        "comments": comment_results,
        "tracked_replacements": replacement_results,
        "validation": assert_valid_docx(output),
    }


def _unwrap(element: etree._Element, *, deleted_text_to_text: bool = False) -> None:
    parent = element.getparent()
    position = parent.index(element)
    children = list(element)
    for child in children:
        element.remove(child)
        if deleted_text_to_text:
            for text in child.xpath(".//w:delText", namespaces=NS):
                text.tag = _qn(W_NS, "t")
        parent.insert(position, child)
        position += 1
    parent.remove(element)


def strip_comments_from_package(package: Path) -> None:
    document_path = package / "word" / "document.xml"
    if document_path.exists():
        tree = etree.parse(str(document_path), _parser())
        root = tree.getroot()
        for marker_name in ("commentRangeStart", "commentRangeEnd"):
            for marker in root.xpath(f".//w:{marker_name}", namespaces=NS):
                marker.getparent().remove(marker)
        for reference in root.xpath(".//w:commentReference", namespaces=NS):
            run = reference.getparent()
            parent = run.getparent()
            if len(run) == 1:
                parent.remove(run)
            else:
                run.remove(reference)
        _write_tree(tree, document_path)

    for path in (package / "word").glob("comments*.xml"):
        path.unlink(missing_ok=True)
    (package / "word" / "people.xml").unlink(missing_ok=True)

    rels_path = package / "word" / "_rels" / "document.xml.rels"
    if rels_path.exists():
        tree = etree.parse(str(rels_path), _parser())
        root = tree.getroot()
        for rel in list(root):
            if "comments" in (rel.get("Type") or "") or (rel.get("Target") or "") in {
                "people.xml",
                "comments.xml",
                "commentsExtended.xml",
                "commentsIds.xml",
            }:
                root.remove(rel)
        _write_tree(tree, rels_path)

    content_path = package / "[Content_Types].xml"
    if content_path.exists():
        tree = etree.parse(str(content_path), _parser())
        root = tree.getroot()
        for override in list(root.findall(_qn(CT_NS, "Override"))):
            part_name = override.get("PartName") or ""
            if part_name.startswith("/word/comments") or part_name == "/word/people.xml":
                root.remove(override)
        _write_tree(tree, content_path)


def finalize_docx(
    input_path: str | Path,
    output_path: str | Path,
    *,
    accept_changes: bool = False,
    reject_changes: bool = False,
    remove_comments: bool = False,
) -> dict[str, Any]:
    if accept_changes and reject_changes:
        raise DocxSkillError("Choose either accept_changes or reject_changes, not both")
    source, output = require_distinct_paths(input_path, output_path)
    with unpacked_copy(source) as (_, package):
        document_path = package / "word" / "document.xml"
        tree = etree.parse(str(document_path), _parser())
        root = tree.getroot()
        accepted = 0
        rejected = 0
        if accept_changes:
            for element in list(root.xpath(".//w:ins", namespaces=NS)):
                _unwrap(element)
                accepted += 1
            for element in list(root.xpath(".//w:del", namespaces=NS)):
                element.getparent().remove(element)
                accepted += 1
        elif reject_changes:
            for element in list(root.xpath(".//w:ins", namespaces=NS)):
                element.getparent().remove(element)
                rejected += 1
            for element in list(root.xpath(".//w:del", namespaces=NS)):
                _unwrap(element, deleted_text_to_text=True)
                rejected += 1
        _write_tree(tree, document_path)
        if accept_changes or reject_changes:
            _disable_track_revisions(package)

        if remove_comments:
            strip_comments_from_package(package)
        pack_docx(package, output)

    return {
        "status": "ok",
        "input": str(source),
        "out": str(output),
        "accepted_elements": accepted,
        "rejected_elements": rejected,
        "removed_comments": remove_comments,
        "validation": assert_valid_docx(output),
    }
