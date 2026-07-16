#!/usr/bin/env python3
"""Starter builder for a polished, offline ReportLab PDF."""

from __future__ import annotations

import argparse
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#5F6B7A")
ACCENT = colors.HexColor("#2563EB")
PALE = colors.HexColor("#EEF4FF")
RULE = colors.HexColor("#D8E0EA")


def register_document_font() -> tuple[str, bool]:
    """Return a usable font name and whether it supports the sample CJK text."""
    candidates = [
        ("PilotDeckCJK", "/System/Library/Fonts/PingFang.ttc", 0),
        ("PilotDeckCJK", "/System/Library/Fonts/STHeiti Light.ttc", 0),
        ("PilotDeckCJK", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
        ("PilotDeckCJK", "C:/Windows/Fonts/msyh.ttc", 0),
        ("PilotDeckSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", None),
    ]
    for name, raw_path, subfont in candidates:
        path = Path(raw_path)
        if not path.is_file():
            continue
        try:
            kwargs = {} if subfont is None else {"subfontIndex": subfont}
            pdfmetrics.registerFont(TTFont(name, str(path), **kwargs))
            return name, name == "PilotDeckCJK"
        except Exception:
            continue
    return "Helvetica", False


def header_footer(canvas, doc) -> None:
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(doc.leftMargin, 18 * mm, A4[0] - doc.rightMargin, 18 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont(doc.body_font, 8)
    canvas.drawString(doc.leftMargin, 11 * mm, "PilotDeck PDF starter")
    canvas.drawRightString(A4[0] - doc.rightMargin, 11 * mm, f"Page {doc.page}")
    canvas.restoreState()


def build_pdf(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    font_name, supports_cjk = register_document_font()
    doc = SimpleDocTemplate(
        str(output),
        pagesize=A4,
        rightMargin=20 * mm,
        leftMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=25 * mm,
        title="PilotDeck PDF starter",
        author="PilotDeck",
    )
    doc.body_font = font_name

    base = getSampleStyleSheet()
    title = ParagraphStyle(
        "DocumentTitle",
        parent=base["Title"],
        fontName=font_name,
        fontSize=25,
        leading=31,
        textColor=INK,
        alignment=TA_LEFT,
        spaceAfter=7 * mm,
    )
    heading = ParagraphStyle(
        "SectionHeading",
        parent=base["Heading2"],
        fontName=font_name,
        fontSize=13,
        leading=18,
        textColor=INK,
        spaceBefore=4 * mm,
        spaceAfter=2.5 * mm,
    )
    body = ParagraphStyle(
        "Body",
        parent=base["BodyText"],
        fontName=font_name,
        fontSize=10,
        leading=15,
        textColor=INK,
        spaceAfter=3 * mm,
    )
    small = ParagraphStyle(
        "Small",
        parent=body,
        fontSize=8.5,
        leading=12,
        textColor=MUTED,
        spaceAfter=0,
    )

    story = [
        Paragraph("A clear PDF starts with a repeatable builder", title),
        Paragraph(
            "This starter keeps typography, spacing, tables, and page numbering "
            "deterministic. Replace this sample content while preserving the "
            "single-builder workflow.",
            body,
        ),
    ]
    if supports_cjk:
        story.append(Paragraph("已检测到中文字体，可直接替换为中文内容。", body))

    story.extend(
        [
            Spacer(1, 3 * mm),
            KeepTogether(
                [
                    Paragraph("Build contract", heading),
                    Table(
                        [
                            [Paragraph("Stage", small), Paragraph("Required result", small)],
                            [Paragraph("Build", small), Paragraph("One executable Python source", small)],
                            [Paragraph("Audit", small), Paragraph("No structural hard failures", small)],
                            [Paragraph("Render", small), Paragraph("Every page inspected as PNG", small)],
                        ],
                        colWidths=[38 * mm, 112 * mm],
                        repeatRows=1,
                        style=TableStyle(
                            [
                                ("BACKGROUND", (0, 0), (-1, 0), PALE),
                                ("TEXTCOLOR", (0, 0), (-1, 0), ACCENT),
                                ("FONTNAME", (0, 0), (-1, -1), font_name),
                                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                ("GRID", (0, 0), (-1, -1), 0.5, RULE),
                                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                                ("TOPPADDING", (0, 0), (-1, -1), 7),
                                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                            ]
                        ),
                    ),
                ]
            ),
            Paragraph("Before delivery", heading),
            Paragraph(
                "Run the structural audit, render all pages with Poppler, and inspect "
                "the individual page images at full size. Revise this builder and rerun "
                "the checks after the final content change.",
                body,
            ),
        ]
    )

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="Output PDF path")
    args = parser.parse_args()
    build_pdf(args.out.expanduser().resolve())


if __name__ == "__main__":
    main()
