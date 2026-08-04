from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import fitz

from .common import (
    DocxSkillError,
    assert_internal_control_path,
    assert_valid_docx,
    require_docx_path,
    temporary_sibling,
)


MINIMAL_CJK_REGISTRY = """\
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry"
 xmlns:xs="http://www.w3.org/2001/XMLSchema"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/I18N/CJK">
<prop oor:name="AsianTypography" oor:op="fuse"><value>true</value></prop>
</item>
<item oor:path="/org.openoffice.Office.Common/I18N/CJK">
<prop oor:name="CJKFont" oor:op="fuse"><value>true</value></prop>
</item>
</oor:items>
"""


def _is_cjk_character(value: str) -> bool:
    if len(value) != 1:
        return False
    codepoint = ord(value)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xF900 <= codepoint <= 0xFAFF
    )


def _page_cjk_glyph_coverage(
    page: fitz.Page, pixmap: fitz.Pixmap, scale: float
) -> dict[str, Any]:
    total = 0
    visible = 0
    samples = memoryview(pixmap.samples)
    channels = pixmap.n
    for block in page.get_text("rawdict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                for character in span.get("chars", []):
                    if not _is_cjk_character(character.get("c", "")):
                        continue
                    x0, y0, x1, y1 = character["bbox"]
                    left = max(0, int(x0 * scale))
                    top = max(0, int(y0 * scale))
                    right = min(pixmap.width, int(x1 * scale + 1))
                    bottom = min(pixmap.height, int(y1 * scale + 1))
                    if right <= left or bottom <= top:
                        continue
                    total += 1
                    ink_pixels = 0
                    pixel_count = 0
                    for y in range(top, bottom):
                        row_start = y * pixmap.stride + left * channels
                        row_end = y * pixmap.stride + right * channels
                        for offset in range(row_start, row_end, channels):
                            pixel = samples[offset : offset + min(channels, 3)]
                            pixel_count += 1
                            if any(channel < 245 for channel in pixel):
                                ink_pixels += 1
                    if pixel_count and ink_pixels / pixel_count >= 0.03:
                        visible += 1
    return {
        "characters": total,
        "visible_characters": visible,
        "ratio": round(visible / total, 4) if total else None,
    }


def _page_layout_metrics(pixmap: fitz.Pixmap) -> dict[str, Any]:
    """Estimate whether the printable body is blank or suspiciously sparse."""
    channels = pixmap.n
    samples = memoryview(pixmap.samples)
    top = max(0, int(pixmap.height * 0.12))
    bottom = min(pixmap.height, int(pixmap.height * 0.88))
    step = 4
    sampled = 0
    ink = 0
    min_x = pixmap.width
    min_y = pixmap.height
    max_x = -1
    max_y = -1
    for y in range(top, bottom, step):
        row_start = y * pixmap.stride
        for x in range(0, pixmap.width, step):
            offset = row_start + x * channels
            pixel = samples[offset : offset + min(channels, 3)]
            sampled += 1
            if pixel and any(channel < 235 for channel in pixel):
                ink += 1
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)
    ink_ratio = ink / sampled if sampled else 0.0
    if ink:
        bbox_ratio = (
            ((max_x - min_x + step) * (max_y - min_y + step))
            / max(1, pixmap.width * (bottom - top))
        )
    else:
        bbox_ratio = 0.0
    return {
        "body_ink_ratio": round(ink_ratio, 6),
        "body_bbox_ratio": round(bbox_ratio, 6),
        "blank_body": ink_ratio < 0.00045,
        "sparse_body": ink_ratio < 0.002,
    }


def find_soffice() -> str | None:
    configured = os.environ.get("DOCX_SKILL_SOFFICE", "").strip()
    if configured and Path(configured).is_file():
        return configured
    mac_path = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")
    if mac_path.is_file():
        return str(mac_path)
    discovered = shutil.which("soffice")
    if discovered:
        return discovered
    return None


def _seed_libreoffice_profile(profile_root: Path) -> str:
    user_dir = profile_root / "user"
    user_dir.mkdir(parents=True, exist_ok=True)
    # A profile containing only registrymodifications.xcu is treated by the
    # macOS LibreOffice launcher as an incomplete first-run profile. In that
    # mode its headless fontconfig HOME is synthetic and CJK glyphs can be
    # replaced by blank Western-font boxes during the very first conversion.
    # Creating the standard writable profile directories is sufficient to
    # keep font discovery on the normal desktop path without copying the
    # user's entire LibreOffice profile.
    for directory_name in ("autocorr", "config", "pack", "temp"):
        (user_dir / directory_name).mkdir(exist_ok=True)
    destination = user_dir / "registrymodifications.xcu"
    profile_candidates = [
        Path.home()
        / "Library"
        / "Application Support"
        / "LibreOffice"
        / "4"
        / "user",
        Path.home() / ".config" / "libreoffice" / "4" / "user",
    ]
    app_data = os.environ.get("APPDATA", "").strip()
    if app_data:
        profile_candidates.append(
            Path(app_data) / "LibreOffice" / "4" / "user"
        )
    for candidate in profile_candidates:
        registry = candidate / "registrymodifications.xcu"
        if registry.is_file():
            shutil.copy2(registry, destination)
            # LibreOffice's headless macOS launcher relies on the generated
            # registry pack/config state to discover the same CJK fonts as the
            # desktop app. Copy only those non-document configuration caches;
            # do not copy macros, databases, templates, or user content.
            for directory_name in ("config", "pack"):
                source_dir = candidate / directory_name
                if source_dir.is_dir():
                    shutil.copytree(
                        source_dir,
                        user_dir / directory_name,
                        dirs_exist_ok=True,
                    )
            return "user-font-config"
    destination.write_text(MINIMAL_CJK_REGISTRY, encoding="utf-8")
    return "minimal-cjk-registry"


def render_docx(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    dpi: int = 150,
    emit_pdf: bool = False,
    include_text: bool = False,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    source = require_docx_path(input_path)
    assert_valid_docx(source)
    soffice = find_soffice()
    if not soffice:
        raise DocxSkillError(
            "LibreOffice soffice was not found; install LibreOffice to enable visual rendering",
            status="unsupported",
            code="render-backend-unavailable",
            details={"backend": "LibreOffice"},
        )
    if dpi < 72 or dpi > 300:
        raise DocxSkillError("DPI must be between 72 and 300")

    out_dir = assert_internal_control_path(
        output_dir,
        purpose="DOCX render directory",
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("page-*.png"):
        stale.unlink()

    # On macOS, LibreOffice can start with a different font configuration when
    # its profile lives inside the per-app /var/folders tree used by
    # tempfile.gettempdir(). Keeping the isolated profile under /private/tmp
    # gives the headless process the same font visibility as a normal desktop
    # launch while still avoiding the user's live profile and lock files.
    isolated_temp_root = (
        "/private/tmp"
        if platform.system() == "Darwin" and Path("/private/tmp").is_dir()
        else None
    )
    profile_seed = "none"
    with tempfile.TemporaryDirectory(
        prefix="pilotdeck_soffice_profile_", dir=isolated_temp_root
    ) as profile_dir:
        with tempfile.TemporaryDirectory(
            prefix="pilotdeck_soffice_output_", dir=isolated_temp_root
        ) as convert_dir:
            profile_path = Path(profile_dir).resolve()
            profile_seed = _seed_libreoffice_profile(profile_path)
            profile_uri = profile_path.as_uri()
            env = os.environ.copy()
            env["HOME"] = profile_dir
            if platform.system() == "Darwin" and Path("/private/tmp").is_dir():
                env["TMPDIR"] = "/private/tmp"
            command = [
                soffice,
                f"-env:UserInstallation={profile_uri}",
                "--headless",
                "--invisible",
                "--norestore",
                "--convert-to",
                "pdf",
                "--outdir",
                convert_dir,
                str(source),
            ]
            # Python may launch subprocesses through macOS posix_spawn. The
            # LibreOffice app launcher then initializes a synthetic fontconfig
            # HOME and loses CJK fonts in headless exports. Going through the
            # system shell's exec path avoids that launcher discrepancy. The
            # command is still passed entirely as positional arguments, so no
            # path or filename is interpolated into shell source.
            launch_command = (
                ["/bin/sh", "-c", 'exec "$@"', "pilotdeck-soffice", *command]
                if platform.system() == "Darwin"
                else command
            )
            try:
                process = subprocess.run(
                    launch_command,
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=timeout_seconds,
                    env=env,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise DocxSkillError(
                    f"LibreOffice rendering timed out after {timeout_seconds} seconds"
                ) from exc

            pdf_candidates = sorted(Path(convert_dir).glob("*.pdf"))
            if not pdf_candidates or pdf_candidates[0].stat().st_size == 0:
                detail = (process.stderr or process.stdout or "unknown conversion error").strip()
                raise DocxSkillError(f"LibreOffice failed to create a PDF: {detail}")
            pdf_path = pdf_candidates[0]

            scale = dpi / 72.0
            matrix = fitz.Matrix(scale, scale)
            page_paths: list[str] = []
            page_text: list[dict[str, Any]] = []
            cjk_glyph_coverage: list[dict[str, Any]] = []
            layout_metrics: list[dict[str, Any]] = []
            with fitz.open(pdf_path) as pdf:
                if pdf.page_count < 1:
                    raise DocxSkillError("Rendered PDF has no pages")
                for page_number, page in enumerate(pdf, start=1):
                    text_value = page.get_text("text")
                    page_text.append(
                        {
                            "page": page_number,
                            "characters": len(text_value),
                            **({"text": text_value} if include_text else {}),
                        }
                    )
                    pixmap = page.get_pixmap(matrix=matrix, alpha=False)
                    coverage = _page_cjk_glyph_coverage(page, pixmap, scale)
                    coverage["page"] = page_number
                    cjk_glyph_coverage.append(coverage)
                    metrics = _page_layout_metrics(pixmap)
                    metrics["page"] = page_number
                    metrics["text_characters"] = len(text_value)
                    layout_metrics.append(metrics)
                    page_path = out_dir / f"page-{page_number}.png"
                    pixmap.save(str(page_path))
                    page_paths.append(str(page_path))

            failed_cjk_pages = [
                item
                for item in cjk_glyph_coverage
                if item["characters"] >= 8
                and item["ratio"] is not None
                and item["ratio"] < 0.7
            ]
            if failed_cjk_pages:
                raise DocxSkillError(
                    "Rendered PDF text exists but CJK glyphs are not visibly painted",
                    status="error",
                    code="render-cjk-glyphs-missing",
                    details={
                        "backend": "LibreOffice",
                        "profile_seed": profile_seed,
                        "pages": failed_cjk_pages,
                    },
                )

            emitted_pdf = None
            if emit_pdf:
                emitted_pdf = out_dir / f"{source.stem}.pdf"
                with temporary_sibling(emitted_pdf, suffix=".tmp.pdf") as temp_pdf:
                    shutil.copy2(pdf_path, temp_pdf)
                    os.replace(temp_pdf, emitted_pdf)

    return {
        "status": "ok",
        "input": str(source),
        "out_dir": str(out_dir),
        "pages": len(page_paths),
        "images": page_paths,
        "page_text": page_text,
        "cjk_glyph_coverage": cjk_glyph_coverage,
        "layout_metrics": layout_metrics,
        "text_characters": sum(item["characters"] for item in page_text),
        "pdf": str(emitted_pdf) if emitted_pdf else None,
        "dpi": dpi,
        "libreoffice_profile_seed": profile_seed,
    }
