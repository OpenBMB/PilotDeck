from __future__ import annotations

import re
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from lxml import etree
from PIL import Image, ImageChops, UnidentifiedImageError

from .common import (
    DocxSkillError,
    assert_valid_docx,
    prepare_json_artifact_path,
    require_docx_path,
    write_json,
)
from .core import inspect_docx, iter_document_paragraphs, iter_document_tables
from .fields import update_fields_on_open_enabled


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
NS = {"w": W_NS, "wp": WP_NS}
FAKE_BULLET = re.compile(r"^\s*[-*\u2022\u25aa\u25e6]\s+")
FAKE_NUMBER = re.compile(r"^\s*\d+[.)]\s+")
HEADING = re.compile(r"^heading\s+(\d+)$", re.IGNORECASE)


def _issue(
    issues: list[dict[str, Any]],
    severity: str,
    code: str,
    message: str,
    location: str | None = None,
) -> None:
    item: dict[str, Any] = {"severity": severity, "code": code, "message": message}
    if location:
        item["location"] = location
    issues.append(item)


def _has_repeat_header(row: Any) -> bool:
    properties = row._tr.trPr
    return properties is not None and properties.find(qn("w:tblHeader")) is not None


def _image_alt_texts(path: Path) -> list[str]:
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    values: list[str] = []
    with zipfile.ZipFile(path) as archive:
        for part_name in archive.namelist():
            if not part_name.startswith("word/") or not part_name.endswith(".xml"):
                continue
            root = etree.fromstring(archive.read(part_name), parser)
            for node in root.findall(".//wp:docPr", NS):
                values.append((node.get("descr") or node.get("title") or "").strip())
    return values


def _raster_media_issues(path: Path) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    raster_suffixes = {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".bmp",
        ".tif",
        ".tiff",
    }
    with zipfile.ZipFile(path) as archive:
        for part_name in archive.namelist():
            if (
                not part_name.startswith("word/media/")
                or Path(part_name).suffix.lower() not in raster_suffixes
            ):
                continue
            try:
                with Image.open(BytesIO(archive.read(part_name))) as image:
                    image.load()
                    rgba = image.convert("RGBA")
                    if rgba.getchannel("A").getbbox() is None:
                        issues.append(
                            {
                                "code": "embedded-image-transparent",
                                "message": "An embedded raster image is fully transparent.",
                                "location": part_name,
                            }
                        )
                        continue
                    flattened = Image.alpha_composite(
                        Image.new("RGBA", rgba.size, (255, 255, 255, 255)),
                        rgba,
                    ).convert("RGB")
                    white = Image.new("RGB", flattened.size, (255, 255, 255))
                    if ImageChops.difference(flattened, white).getbbox() is None:
                        issues.append(
                            {
                                "code": "embedded-image-blank",
                                "message": "An embedded raster image is visually blank.",
                                "location": part_name,
                            }
                        )
            except (
                KeyError,
                Image.DecompressionBombError,
                UnidentifiedImageError,
                OSError,
                ValueError,
            ) as exc:
                issues.append(
                    {
                        "code": "embedded-image-invalid",
                        "message": f"An embedded raster image cannot be decoded: {exc}",
                        "location": part_name,
                    }
                )
    return issues


def _exact_line_spacing_points(paragraph: Any) -> float | None:
    style = paragraph.style
    candidates = [paragraph._p.pPr]
    seen: set[int] = set()
    while style is not None and id(style) not in seen:
        seen.add(id(style))
        candidates.append(style.element.pPr)
        style = style.base_style
    for properties in candidates:
        if properties is None:
            continue
        spacing = properties.find(qn("w:spacing"))
        if spacing is None or spacing.get(qn("w:line")) is None:
            continue
        if (spacing.get(qn("w:lineRule")) or "").lower() != "exact":
            return None
        if spacing.get(qn("w:line")):
            try:
                return int(spacing.get(qn("w:line"))) / 20
            except (TypeError, ValueError):
                return None
    return None


def _maximum_font_size_points(paragraph: Any) -> float | None:
    values: list[float] = []
    style_size = paragraph.style.font.size if paragraph.style else None
    for run in paragraph.runs:
        if not run.text.strip():
            continue
        size = run.font.size or style_size
        if size is not None:
            values.append(float(size.pt))
    return max(values) if values else None


def _maximum_inline_height_points(paragraph: Any) -> float | None:
    values: list[float] = []
    for extent in paragraph._p.findall(".//wp:extent", paragraph._p.nsmap):
        raw_height = extent.get("cy")
        if raw_height is None:
            continue
        try:
            values.append(int(raw_height) / 12_700)
        except (TypeError, ValueError):
            continue
    return max(values) if values else None


def _cell_fill(cell: Any) -> str | None:
    properties = cell._tc.tcPr
    if properties is None:
        return None
    shading = properties.find(qn("w:shd"))
    if shading is None:
        return None
    value = (shading.get(qn("w:fill")) or "").strip().upper()
    if not value or value in {"AUTO", "NONE", "FFFFFF"}:
        return None
    return value


def _paragraph_fill(paragraph: Any) -> str | None:
    properties = paragraph._p.pPr
    if properties is None:
        return None
    shading = properties.find(qn("w:shd"))
    if shading is None:
        return None
    value = (shading.get(qn("w:fill")) or "").strip().upper()
    if not value or value in {"AUTO", "NONE", "FFFFFF"}:
        return None
    return value


def _table_border_colors(table: Any) -> set[str]:
    properties = table._tbl.tblPr
    if properties is None:
        return set()
    borders = properties.find(qn("w:tblBorders"))
    if borders is None:
        return set()
    values: set[str] = set()
    for border in borders:
        value = (border.get(qn("w:color")) or "").strip().upper()
        if value and value not in {"AUTO", "NONE", "FFFFFF"}:
            values.add(value)
    return values


def _is_chromatic_fill(value: str) -> bool:
    if not re.fullmatch(r"[0-9A-F]{6}", value):
        return False
    red, green, blue = (
        int(value[index : index + 2], 16)
        for index in (0, 2, 4)
    )
    return max(red, green, blue) - min(red, green, blue) >= 12


def audit_docx(
    input_path: str | Path,
    output_json: str | Path | None = None,
    *,
    profile: str = "draft",
) -> dict[str, Any]:
    if profile not in {"draft", "final", "accessible"}:
        raise DocxSkillError(
            "Audit profile must be draft, final, or accessible",
            code="invalid-audit-profile",
        )

    path = require_docx_path(input_path)
    json_output = (
        prepare_json_artifact_path(
            output_json,
            protected_paths=(path,),
            purpose="Audit output",
        )
        if output_json
        else None
    )
    validation = assert_valid_docx(path)
    info = inspect_docx(path)
    doc = Document(str(path))
    issues: list[dict[str, Any]] = []

    heading_levels: list[tuple[int, str]] = []
    direct_font_runs = 0
    visible_runs = 0
    body_paragraphs = 0
    chromatic_text_runs = 0
    chromatic_used_styles: set[str] = set()
    chromatic_paragraph_fills = 0
    header_content_items = 0
    footer_content_items = 0
    for location, paragraph in iter_document_paragraphs(doc):
        text = paragraph.text.strip()
        if text:
            body_paragraphs += 1
            if ".header" in location:
                header_content_items += 1
            elif ".footer" in location:
                footer_content_items += 1
        style_name = paragraph.style.name if paragraph.style else ""
        paragraph_fill = _paragraph_fill(paragraph)
        if paragraph_fill and _is_chromatic_fill(paragraph_fill):
            chromatic_paragraph_fills += 1
        if (
            text
            and style_name.casefold() == "caption"
            and not paragraph.paragraph_format.keep_with_next
        ):
            _issue(
                issues,
                "warning",
                "caption-not-kept-with-object",
                "Keep a caption with the following table or image to avoid an orphaned caption.",
                location,
            )
        heading_match = HEADING.match(style_name)
        if heading_match and text:
            heading_levels.append((int(heading_match.group(1)), text[:80]))
        if text and not style_name.lower().startswith("list"):
            if FAKE_BULLET.match(text):
                _issue(
                    issues,
                    "warning",
                    "fake-bullet",
                    "Use a real Word list style instead of a typed bullet character.",
                    location,
                )
            elif FAKE_NUMBER.match(text):
                _issue(
                    issues,
                    "warning",
                    "fake-numbering",
                    "Use a real Word numbering definition instead of a typed number prefix.",
                    location,
                )
        for run in paragraph.runs:
            if not run.text.strip():
                continue
            visible_runs += 1
            style_font = paragraph.style.font if paragraph.style else None
            run_color = str(run.font.color.rgb) if run.font.color.rgb is not None else None
            style_color = (
                str(style_font.color.rgb)
                if style_font is not None and style_font.color.rgb is not None
                else None
            )
            effective_color = run_color or style_color
            if effective_color and _is_chromatic_fill(effective_color.upper()):
                chromatic_text_runs += 1
                if not run_color and style_name:
                    chromatic_used_styles.add(style_name)
            differs_from_style = bool(
                (run.font.name and (style_font is None or run.font.name != style_font.name))
                or (run.font.size and (style_font is None or run.font.size != style_font.size))
                or (run_color and run_color != style_color)
            )
            if differs_from_style:
                direct_font_runs += 1
            if run.font.size and run.font.size.pt < 8:
                _issue(
                    issues,
                    "warning",
                    "small-text",
                    f"Text is set to {run.font.size.pt:g} pt; verify readability.",
                    location,
                )
        exact_line = _exact_line_spacing_points(paragraph)
        max_font = _maximum_font_size_points(paragraph)
        max_inline_height = _maximum_inline_height_points(paragraph)
        if (
            text
            and exact_line is not None
            and max_font is not None
            and exact_line + 0.5 < max_font * 1.1
        ):
            _issue(
                issues,
                "error" if profile in {"final", "accessible"} else "warning",
                "text-line-height-clipping",
                (
                    f"The paragraph uses {exact_line:g} pt exact line height "
                    f"for text up to {max_font:g} pt, which can clip glyphs. "
                    "Use automatic or at-least line spacing."
                ),
                location,
            )
        if (
            exact_line is not None
            and max_inline_height is not None
            and exact_line + 0.5 < max_inline_height
        ):
            _issue(
                issues,
                "error" if profile in {"final", "accessible"} else "warning",
                "image-line-height-clipping",
                (
                    f"The paragraph uses {exact_line:g} pt exact line height "
                    f"for an inline image up to {max_inline_height:g} pt high, "
                    "which clips the image. Use automatic line spacing."
                ),
                location,
            )

    for index, (level, text) in enumerate(heading_levels):
        if index == 0 and level > 1:
            _issue(
                issues,
                "warning",
                "heading-start-level",
                f"The first heading starts at level {level}: {text}",
            )
        if index and level > heading_levels[index - 1][0] + 1:
            previous = heading_levels[index - 1][0]
            _issue(
                issues,
                "warning",
                "heading-level-jump",
                f"Heading hierarchy jumps from level {previous} to level {level}: {text}",
            )

    if body_paragraphs >= 15 and not heading_levels:
        _issue(
            issues,
            "warning",
            "missing-headings",
            "A long document has no semantic Heading styles.",
        )

    blank_run = 0
    for index, paragraph in enumerate(doc.paragraphs, start=1):
        if paragraph.text.strip():
            blank_run = 0
            continue
        blank_run += 1
        if blank_run == 3:
            _issue(
                issues,
                "warning",
                "blank-paragraph-spacing",
                "Three or more consecutive empty paragraphs are used for spacing.",
                f"body paragraph {index}",
            )

    for index, section in enumerate(doc.sections, start=1):
        margins = {
            "top": section.top_margin.inches,
            "right": section.right_margin.inches,
            "bottom": section.bottom_margin.inches,
            "left": section.left_margin.inches,
        }
        for side, value in margins.items():
            if value < 0.4:
                _issue(
                    issues,
                    "warning",
                    "narrow-margin",
                    f"The {side} margin is {value:.2f} in; inspect for clipping and crowding.",
                    f"section {index}",
                )

    table_cell_count = 0
    explicitly_filled_cells = 0
    chromatic_filled_cells = 0
    accent_table_styles = 0
    accent_tables_with_manual_fill = 0
    chromatic_table_borders = 0
    for table_index, (table_location, table) in enumerate(
        iter_document_tables(doc),
        start=1,
    ):
        location = f"{table_location} (table {table_index})"
        style_name = table.style.name if table.style is not None else ""
        is_accent_style = "accent" in style_name.casefold()
        if is_accent_style:
            accent_table_styles += 1
        if any(
            _is_chromatic_fill(value)
            for value in _table_border_colors(table)
        ):
            chromatic_table_borders += 1
        table_has_manual_fill = False
        seen_cells: set[int] = set()
        for row in table.rows:
            for cell in row.cells:
                cell_id = id(cell._tc)
                if cell_id in seen_cells:
                    continue
                seen_cells.add(cell_id)
                table_cell_count += 1
                fill = _cell_fill(cell)
                if fill:
                    table_has_manual_fill = True
                    explicitly_filled_cells += 1
                    if _is_chromatic_fill(fill):
                        chromatic_filled_cells += 1
        if is_accent_style and table_has_manual_fill:
            accent_tables_with_manual_fill += 1
        grid = table._tbl.tblGrid
        grid_columns = list(grid) if grid is not None else []
        if len(grid_columns) != len(table.columns):
            _issue(
                issues,
                "warning",
                "table-grid-mismatch",
                "The table grid does not define one width for every column.",
                location,
            )
        table_width = table._tbl.tblPr.find(qn("w:tblW"))
        if table_width is None or table_width.get(qn("w:type")) != "dxa":
            _issue(
                issues,
                "warning",
                "table-width-not-explicit",
                "Set an explicit DXA table width for stable rendering.",
                location,
            )
        for row_index, row in enumerate(table.rows, start=1):
            properties = row._tr.trPr
            if properties is not None:
                for height in properties.findall(qn("w:trHeight")):
                    if height.get(qn("w:hRule")) == "exact":
                        _issue(
                            issues,
                            "warning",
                            "fixed-row-height",
                            "Exact table row height can clip wrapped text.",
                            f"{location}, row {row_index}",
                        )
            for cell_index, cell in enumerate(row.cells, start=1):
                tc_width = cell._tc.get_or_add_tcPr().find(qn("w:tcW"))
                if tc_width is None or tc_width.get(qn("w:type")) != "dxa":
                    _issue(
                        issues,
                        "warning",
                        "cell-width-not-explicit",
                        "Set an explicit DXA cell width.",
                        f"{location}, row {row_index}, cell {cell_index}",
                    )
        if profile == "accessible" and len(table.rows) > 1 and not _has_repeat_header(table.rows[0]):
            _issue(
                issues,
                "warning",
                "table-header-not-marked",
                "Mark the first row as a repeating table header.",
                location,
            )
        if table.rows:
            for cell_index, cell in enumerate(table.rows[0].cells, start=1):
                if not cell.text.strip():
                    _issue(
                        issues,
                        "warning",
                        "empty-table-header",
                        "A header cell is empty.",
                        f"{location}, header cell {cell_index}",
                    )

    chromatic_fill_ratio = (
        chromatic_filled_cells / table_cell_count
        if table_cell_count
        else 0.0
    )
    if chromatic_filled_cells >= 4 and chromatic_fill_ratio >= 0.2:
        _issue(
            issues,
            "warning",
            "excessive-chromatic-table-fill",
            (
                f"{chromatic_filled_cells} of {table_cell_count} table cells "
                "use explicit non-neutral fills. Confirm that a colored theme "
                "was requested; otherwise use white body cells and neutral headers."
            ),
        )
    if accent_table_styles >= 2:
        _issue(
            issues,
            "warning",
            "repeated-accent-table-styles",
            (
                f"{accent_table_styles} tables use Accent styles. Repeated Accent "
                "tables can dominate a formal report; use neutral styles unless "
                "the user requested a branded or colorful design."
            ),
        )
    if accent_tables_with_manual_fill:
        _issue(
            issues,
            "warning",
            "accent-style-with-manual-fill",
            (
                f"{accent_tables_with_manual_fill} Accent-style table(s) also "
                "contain direct cell shading. Choose the table style or explicit "
                "fills, not both."
            ),
        )

    image_alt_texts = _image_alt_texts(path)
    for image_issue in _raster_media_issues(path):
        _issue(
            issues,
            "error",
            image_issue["code"],
            image_issue["message"],
            image_issue["location"],
        )
    if profile == "accessible":
        for index, alt_text in enumerate(image_alt_texts, start=1):
            if not alt_text:
                _issue(
                    issues,
                    "warning",
                    "missing-image-alt-text",
                    "Add useful alternative text or explicitly mark the image decorative.",
                    f"image {index}",
                )

    if visible_runs >= 20 and direct_font_runs / visible_runs > 0.75:
        _issue(
            issues,
            "warning",
            "direct-formatting-heavy",
            "Most text uses direct font formatting; prefer reusable Word styles for consistency.",
        )

    if profile in {"final", "accessible"}:
        if update_fields_on_open_enabled(path):
            _issue(
                issues,
                "warning",
                "fields-update-on-open",
                (
                    "The document requests automatic field updates when Word "
                    "opens it. This can trigger an external-field warning even "
                    "when only a TOC is present. Refresh cached field results and "
                    "disable update-on-open before delivery unless the user "
                    "explicitly requested dynamic updates."
                ),
            )
        if info["comments"]:
            _issue(
                issues,
                "error",
                "comments-remain",
                f"The document still contains {len(info['comments'])} comment(s).",
            )
        tracked = info["tracked_changes"]
        tracked_total = sum(
            int(tracked.get(key, 0))
            for key in (
                "insertions",
                "deletions",
                "moves_from",
                "moves_to",
                "property_changes",
            )
        )
        if tracked_total:
            _issue(
                issues,
                "error",
                "tracked-changes-remain",
                f"The document still contains {tracked_total} unfinalized revision element(s).",
            )
        metadata = info["metadata"]
        if metadata.get("author") or metadata.get("last_modified_by"):
            _issue(
                issues,
                "warning",
                "personal-metadata",
                "Author or last-modified-by metadata remains in the package.",
            )
        package_features = info.get("package_features", {})
        if package_features.get("digital_signatures"):
            _issue(
                issues,
                "error",
                "digital-signature-present",
                "A digital signature remains; editing or sanitizing would invalidate it.",
            )
        if package_features.get("document_protection"):
            _issue(
                issues,
                "error",
                "document-protection-present",
                "Document protection remains; bundled mutation operations will not bypass it.",
            )
        if package_features.get("active_content"):
            _issue(
                issues,
                "error",
                "active-content-present",
                "ActiveX or macro content is present and is outside the safe mutation contract.",
            )
        if package_features.get("embeddings"):
            _issue(
                issues,
                "warning",
                "embedded-objects-present",
                "Embedded objects were not recursively inspected.",
            )
        if info.get("external_relationships"):
            _issue(
                issues,
                "warning",
                "external-relationships-present",
                "External relationships remain; confirm every target is intentional.",
            )

    fields = info.get("fields", [])
    page_number_fields = 0
    for field in fields:
        part = str(field.get("part", "")).casefold()
        instruction = str(field.get("instruction", "")).strip().upper()
        keyword = instruction.split(maxsplit=1)[0] if instruction else ""
        if part.startswith("word/header"):
            header_content_items += 1
        elif part.startswith("word/footer"):
            footer_content_items += 1
        if keyword in {"PAGE", "NUMPAGES"}:
            page_number_fields += 1

    counts = {
        severity: sum(1 for item in issues if item["severity"] == severity)
        for severity in ("error", "warning", "info")
    }
    coverage_complete = (
        info.get("inspection_coverage", {}).get("status") == "complete"
    )
    passed = counts["error"] == 0 and coverage_complete
    result: dict[str, Any] = {
        "status": "ok" if passed else "partial",
        "input": str(path),
        "profile": profile,
        "passed": passed,
        "summary": {
            **counts,
            "paragraphs": info["paragraph_count"],
            "headings": len(info["headings"]),
            "tables": info["table_count"],
            "images": len(image_alt_texts),
            "fields": len(info.get("fields", [])),
            "header_content_items": header_content_items,
            "footer_content_items": footer_content_items,
            "page_number_fields": page_number_fields,
            "table_cells": table_cell_count,
            "explicitly_filled_table_cells": explicitly_filled_cells,
            "chromatic_filled_table_cells": chromatic_filled_cells,
            "accent_table_styles": accent_table_styles,
            "chromatic_text_runs": chromatic_text_runs,
            "chromatic_used_style_count": len(chromatic_used_styles),
            "chromatic_paragraph_fills": chromatic_paragraph_fills,
            "chromatic_table_borders": chromatic_table_borders,
            "inspection_coverage": info.get("inspection_coverage", {}).get("status"),
        },
        "issues": issues,
        "validation": validation,
    }
    if json_output:
        write_json(json_output, result)
        result["out"] = str(json_output)
    return result
