from __future__ import annotations

import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

import fitz

from .common import DocxSkillError, assert_valid_docx, require_docx_path


def find_soffice() -> str | None:
    configured = os.environ.get("DOCX_SKILL_SOFFICE", "").strip()
    if configured and Path(configured).is_file():
        return configured
    discovered = shutil.which("soffice")
    if discovered:
        return discovered
    mac_path = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")
    if mac_path.is_file():
        return str(mac_path)
    return None


def render_docx(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    dpi: int = 150,
    emit_pdf: bool = False,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    source = require_docx_path(input_path)
    assert_valid_docx(source)
    soffice = find_soffice()
    if not soffice:
        raise DocxSkillError(
            "LibreOffice soffice was not found; install LibreOffice to enable visual rendering"
        )
    if dpi < 72 or dpi > 300:
        raise DocxSkillError("DPI must be between 72 and 300")

    out_dir = Path(output_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("page-*.png"):
        stale.unlink()

    with tempfile.TemporaryDirectory(prefix="pilotdeck_soffice_profile_") as profile_dir:
        with tempfile.TemporaryDirectory(prefix="pilotdeck_soffice_output_") as convert_dir:
            profile_uri = Path(profile_dir).resolve().as_uri()
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
            try:
                process = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
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
            with fitz.open(pdf_path) as pdf:
                if pdf.page_count < 1:
                    raise DocxSkillError("Rendered PDF has no pages")
                for page_number, page in enumerate(pdf, start=1):
                    pixmap = page.get_pixmap(matrix=matrix, alpha=False)
                    page_path = out_dir / f"page-{page_number}.png"
                    pixmap.save(str(page_path))
                    page_paths.append(str(page_path))

            emitted_pdf = None
            if emit_pdf:
                emitted_pdf = out_dir / f"{source.stem}.pdf"
                temp_pdf = emitted_pdf.with_suffix(".pdf.tmp")
                shutil.copy2(pdf_path, temp_pdf)
                os.replace(temp_pdf, emitted_pdf)

    return {
        "status": "ok",
        "input": str(source),
        "out_dir": str(out_dir),
        "pages": len(page_paths),
        "images": page_paths,
        "pdf": str(emitted_pdf) if emitted_pdf else None,
        "dpi": dpi,
    }
