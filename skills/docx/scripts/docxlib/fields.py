from __future__ import annotations

import zipfile
from pathlib import Path

from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from lxml import etree


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W_NS}
FALSE_VALUES = {"0", "false", "off", "no"}


def update_fields_on_open_enabled(path: str | Path) -> bool:
    document = Path(path).expanduser().resolve()
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    with zipfile.ZipFile(document) as archive:
        try:
            root = etree.fromstring(archive.read("word/settings.xml"), parser)
        except KeyError:
            return False
    nodes = root.findall("w:updateFields", NS)
    if not nodes:
        return False
    value = nodes[-1].get(qn("w:val"))
    return value is None or value.strip().casefold() not in FALSE_VALUES


def set_document_update_fields_on_open(document: object, *, enabled: bool) -> None:
    settings = document.settings.element
    nodes = list(settings.findall(qn("w:updateFields")))
    if enabled:
        update = nodes[-1] if nodes else OxmlElement("w:updateFields")
        if not nodes:
            settings.append(update)
        update.set(qn("w:val"), "true")
        for duplicate in nodes[:-1]:
            settings.remove(duplicate)
        return
    for update in nodes:
        settings.remove(update)


def set_package_update_fields_on_open(
    package_dir: str | Path,
    *,
    enabled: bool,
) -> None:
    settings_path = Path(package_dir) / "word" / "settings.xml"
    if not settings_path.is_file():
        return
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    tree = etree.parse(str(settings_path), parser)
    root = tree.getroot()
    nodes = list(root.findall("w:updateFields", NS))
    if enabled:
        update = nodes[-1] if nodes else etree.SubElement(root, qn("w:updateFields"))
        update.set(qn("w:val"), "true")
        for duplicate in nodes[:-1]:
            root.remove(duplicate)
    else:
        for update in nodes:
            root.remove(update)
    tree.write(
        str(settings_path),
        encoding="UTF-8",
        xml_declaration=True,
        standalone=True,
    )
