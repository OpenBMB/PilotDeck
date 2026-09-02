from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    assert_internal_candidate_path,
    assert_valid_docx,
    blocked,
    file_sha256,
    pilotdeck_work_dir,
    pilotdeck_workspace_root,
    require_docx_path,
    temporary_sibling,
)


def _same_path(left: Path, right: Path) -> bool:
    if left == right:
        return True
    if left.exists() and right.exists():
        try:
            return os.path.samefile(left, right)
        except OSError:
            return False
    return False


def _backup_source(source: Path) -> dict[str, str]:
    work_dir = pilotdeck_work_dir()
    if work_dir is None:
        raise blocked(
            "Replacing a source DOCX requires PILOTDECK_WORK_DIR so a recovery copy can be retained",
            code="source-replacement-requires-work-dir",
        )
    digest = file_sha256(source)
    backup_dir = work_dir / "docx" / "recovery"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / f"{source.stem}-{digest[:16]}.docx"
    if not backup.exists():
        shutil.copy2(source, backup)
    if file_sha256(backup) != digest:
        raise DocxSkillError("The source recovery copy failed its digest check", code="source-backup-mismatch")
    return {"path": str(backup), "sha256": digest}


def deliver_docx(
    input_path: str | Path,
    output_path: str | Path,
    *,
    source_path: str | Path | None = None,
    replace_source: bool = False,
    overwrite: bool = False,
) -> dict[str, Any]:
    candidate = assert_internal_candidate_path(require_docx_path(input_path))
    validation = assert_valid_docx(candidate)
    digest = file_sha256(candidate)
    source = require_docx_path(source_path) if source_path is not None else None

    raw_output = Path(output_path).expanduser()
    output = require_docx_path(
        raw_output if raw_output.is_absolute() else pilotdeck_workspace_root() / raw_output,
        must_exist=False,
    )
    work_dir = pilotdeck_work_dir()
    if work_dir is not None:
        try:
            output.relative_to(work_dir)
        except ValueError:
            pass
        else:
            raise blocked(
                "The final DOCX must be delivered outside PILOTDECK_WORK_DIR",
                code="delivery-output-is-internal",
                details={"out": str(output)},
            )

    replacing_source = source is not None and _same_path(output, source)
    if replacing_source and not replace_source:
        raise blocked(
            "The source is preserved by default. Use --replace-source only when the current request explicitly asks to overwrite it.",
            code="source-overwrite-requires-explicit-mode",
        )
    if replace_source and not replacing_source:
        raise blocked(
            "--replace-source may replace only the exact path supplied by --source",
            code="source-replacement-path-mismatch",
        )
    if output.exists() and not (overwrite or replacing_source):
        raise blocked(
            "The final output already exists; choose a new path or pass --overwrite",
            code="output-exists",
            details={"out": str(output)},
        )
    if output.exists() and not output.is_file():
        raise blocked("The output path is not a regular file", code="output-path-invalid")

    backup = _backup_source(source) if replacing_source and source is not None else None
    source_digest = file_sha256(source) if source is not None else None
    output.parent.mkdir(parents=True, exist_ok=True)
    with temporary_sibling(output, suffix=".tmp.docx") as temporary:
        shutil.copy2(candidate, temporary)
        assert_valid_docx(temporary)
        if file_sha256(temporary) != digest:
            raise DocxSkillError("The delivered copy does not match the candidate", code="delivery-copy-mismatch")
        os.replace(temporary, output)
    if source is not None and not replacing_source and file_sha256(source) != source_digest:
        raise DocxSkillError("The source DOCX changed during delivery", code="source-changed-during-delivery")
    return {
        "status": "ok",
        "input": str(candidate),
        "out": str(output),
        "sha256": digest,
        "source": str(source) if source is not None else None,
        "source_replaced": replacing_source,
        "source_backup": backup,
        "validation": validation,
    }
