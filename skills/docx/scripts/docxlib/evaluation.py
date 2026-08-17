from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    assert_internal_control_path,
    prepare_json_artifact_path,
    require_docx_path,
)


SAFE_EVALUATOR_ENVIRONMENT = (
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


def run_evaluator(
    input_path: str | Path,
    script_path: str | Path,
    output_path: str | Path,
    *,
    timeout_seconds: int = 180,
) -> dict[str, Any]:
    candidate = require_docx_path(input_path)
    script = assert_internal_control_path(script_path, purpose="DOCX evaluator")
    output = prepare_json_artifact_path(
        output_path,
        protected_paths=(candidate, script),
        purpose="DOCX evaluation",
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    if not script.is_file() or script.suffix.lower() != ".py":
        raise DocxSkillError(f"DOCX evaluator not found: {script}")
    environment = {key: os.environ[key] for key in SAFE_EVALUATOR_ENVIRONMENT if key in os.environ}
    environment.update({"PYTHONNOUSERSITE": "1", "PYTHONUTF8": "1"})
    try:
        process = subprocess.run(
            [sys.executable, str(script), "--input", str(candidate), "--out", str(output)],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout_seconds,
            cwd=str(script.parent),
            env=environment,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise DocxSkillError(f"DOCX evaluator timed out after {timeout_seconds} seconds", code="evaluator-timeout") from exc
    if process.returncode != 0 or not output.is_file():
        raise DocxSkillError(
            "DOCX evaluator failed",
            code="evaluator-failed",
            details={"stdout": process.stdout[-4000:], "stderr": process.stderr[-4000:]},
        )
    try:
        result = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DocxSkillError("The evaluator did not write a valid JSON object", code="invalid-evaluation") from exc
    if not isinstance(result, dict):
        raise DocxSkillError("The evaluator result must be a JSON object", code="invalid-evaluation")
    return {
        "status": "ok",
        "input": str(candidate),
        "script": str(script),
        "out": str(output),
        "evaluation": result,
    }
