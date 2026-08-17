from __future__ import annotations

import fnmatch
import hashlib
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    assert_safe_mutation,
    assert_valid_docx,
    pack_docx,
    prepare_json_artifact_path,
    prepare_output_docx_path,
    require_docx_path,
    unpacked_copy,
    write_json,
)


FORBIDDEN_PATCH_PARTS = (
    "word/vbaProject.bin",
    "word/activeX/*",
    "_xmlsignatures/*",
    "word/signatures.xml",
    "word/signatureLine.xml",
    "word/embeddings/*",
)
SAFE_FALLBACK_ENVIRONMENT = (
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "WINDIR",
    "PATHEXT",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _package_hashes(package: Path) -> dict[str, str]:
    return {
        path.relative_to(package).as_posix(): _sha256(path)
        for path in sorted(package.rglob("*"))
        if path.is_file()
    }


def _matches(path: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def _matches_forbidden_part(path: str) -> bool:
    """Match security-sensitive OPC parts independently of path casing.

    OPC part names are normally case-sensitive, but the safety checks used by
    the rest of the DOCX pipeline intentionally recognize active-content and
    signature paths case-insensitively. A fallback allowlist must not be able
    to weaken that policy by adding a case-variant package part.
    """
    normalized = path.replace("\\", "/").casefold()
    return any(
        fnmatch.fnmatchcase(normalized, pattern.casefold())
        for pattern in FORBIDDEN_PATCH_PARTS
    )


def _require_scoped_script(script: Path) -> None:
    work_dir = os.environ.get("PILOTDECK_WORK_DIR", "").strip()
    if not work_dir:
        return
    allowed_root = Path(work_dir).expanduser().resolve()
    try:
        script.relative_to(allowed_root)
    except ValueError as exc:
        raise DocxSkillError(
            "Fallback scripts must be stored inside PILOTDECK_WORK_DIR",
            status="blocked",
            code="fallback-script-outside-workdir",
            details={"script": str(script), "work_dir": str(allowed_root)},
        ) from exc


def _fallback_environment(mode: str) -> dict[str, str]:
    environment = {
        key: os.environ[key]
        for key in SAFE_FALLBACK_ENVIRONMENT
        if key in os.environ
    }
    environment.update(
        {
            "DOCX_FALLBACK_MODE": mode,
            "PYTHONNOUSERSITE": "1",
            "PYTHONUTF8": "1",
        }
    )
    return environment


def _run_script(
    script: Path,
    arguments: list[str],
    *,
    timeout_seconds: int,
    environment: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    if script.suffix.lower() != ".py":
        raise DocxSkillError(
            "Controlled fallbacks currently require a .py script",
            status="unsupported",
            code="fallback-script-type",
        )
    try:
        return subprocess.run(
            [sys.executable, str(script), *arguments],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout_seconds,
            env=environment,
            cwd=str(script.parent),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise DocxSkillError(
            f"Fallback script timed out after {timeout_seconds} seconds",
            code="fallback-timeout",
        ) from exc


def fallback_patch(
    input_path: str | Path,
    script_path: str | Path,
    output_path: str | Path,
    report_path: str | Path,
    *,
    allow_parts: list[str] | None = None,
    reason: str,
    timeout_seconds: int = 120,
    overwrite: bool = False,
) -> dict[str, Any]:
    source = require_docx_path(input_path)
    output = require_docx_path(output_path, must_exist=False)
    script = Path(script_path).expanduser().resolve()
    report_output = prepare_json_artifact_path(
        report_path,
        protected_paths=(source, output, script),
        purpose="Fallback report",
    )
    if source == output:
        raise DocxSkillError("Fallback input and output must be different paths")
    output = prepare_output_docx_path(output, overwrite=overwrite)
    assert_safe_mutation(source, operation="fallback-patch")
    if not script.is_file():
        raise DocxSkillError(f"Fallback script not found: {script}")
    _require_scoped_script(script)
    if not reason.strip():
        raise DocxSkillError("--reason is required for a controlled fallback")
    patterns = tuple(allow_parts or ())
    if not patterns:
        raise DocxSkillError(
            "Controlled OOXML patching requires at least one explicit --allow-part",
            status="blocked",
            code="fallback-allowlist-required",
        )

    with unpacked_copy(source) as (_, package):
        before = _package_hashes(package)
        environment = _fallback_environment("targeted-ooxml-patch")
        process = _run_script(
            script,
            ["--package-dir", str(package)],
            timeout_seconds=timeout_seconds,
            environment=environment,
        )
        after = _package_hashes(package)
        changed = sorted(
            path
            for path in set(before) | set(after)
            if before.get(path) != after.get(path)
        )
        disallowed = sorted(path for path in changed if not _matches(path, patterns))
        forbidden = sorted(path for path in changed if _matches_forbidden_part(path))
        report: dict[str, Any] = {
            "mode": "targeted-ooxml-patch",
            "created_at": _utc_now(),
            "status": "ok",
            "reason": reason.strip(),
            "input": str(source),
            "out": str(output),
            "script": str(script),
            "script_sha256": _sha256(script),
            "script_cwd": str(script.parent),
            "environment_policy": "safe-allowlist",
            "allowed_parts": list(patterns),
            "changed_parts": changed,
            "disallowed_parts": disallowed,
            "forbidden_parts": forbidden,
            "script_exit_code": process.returncode,
            "script_stdout": process.stdout[-4000:],
            "script_stderr": process.stderr[-4000:],
        }
        if process.returncode != 0:
            report["status"] = "error"
            write_json(report_output, report)
            raise DocxSkillError(
                "Fallback script failed; see the report for stderr",
                code="fallback-script-failed",
                details={"report": str(report_output)},
            )
        if not changed:
            report["status"] = "partial"
            write_json(report_output, report)
            raise DocxSkillError(
                "Fallback script did not change any package part",
                status="partial",
                code="fallback-no-change",
                details={"report": str(report_output)},
            )
        if forbidden or disallowed:
            report["status"] = "blocked"
            write_json(report_output, report)
            raise DocxSkillError(
                "Fallback changed forbidden or non-allowlisted package parts",
                status="blocked",
                code="fallback-scope-violation",
                details={
                    "report": str(report_output),
                    "disallowed_parts": disallowed,
                    "forbidden_parts": forbidden,
                },
            )
        try:
            pack_docx(package, output)
        except DocxSkillError as exc:
            report["status"] = "error"
            report["validation_error"] = str(exc)
            write_json(report_output, report)
            raise DocxSkillError(
                "Fallback produced an invalid DOCX package; see the report",
                code="fallback-validation-failed",
                details={"report": str(report_output)},
            ) from exc
        report["output_sha256"] = _sha256(output)
        report["validation"] = assert_valid_docx(output)
        write_json(report_output, report)
        return {
            "status": "ok",
            "mode": report["mode"],
            "input": str(source),
            "out": str(output),
            "report": str(report_output),
            "changed_parts": changed,
            "validation": report["validation"],
        }
