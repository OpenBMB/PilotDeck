from __future__ import annotations

import hashlib
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import (
    DocxSkillError,
    blocked,
    file_sha256,
    load_json,
    pilotdeck_work_dir,
    require_docx_path,
    write_json,
)


LINEAGE_SCHEMA_VERSION = 1
LINEAGE_FILE_NAME = "docx-lineage.json"
LINEAGE_DATA_DIR_NAME = "docx-lineage"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _session_dir() -> Path | None:
    work_dir = pilotdeck_work_dir()
    if work_dir is None:
        return None
    return work_dir.parent


def _state_path() -> Path | None:
    session_dir = _session_dir()
    return session_dir / LINEAGE_FILE_NAME if session_dir is not None else None


def _empty_state() -> dict[str, Any]:
    return {
        "schema_version": LINEAGE_SCHEMA_VERSION,
        "session_id": os.environ.get("PILOTDECK_SESSION_ID") or None,
        "updated_at": None,
        "documents": [],
    }


def _load_state() -> tuple[Path | None, dict[str, Any]]:
    path = _state_path()
    if path is None or not path.is_file():
        return path, _empty_state()
    value = load_json(path)
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != LINEAGE_SCHEMA_VERSION
        or not isinstance(value.get("documents"), list)
    ):
        raise DocxSkillError(
            f"Invalid DOCX lineage state: {path}",
            code="invalid-docx-lineage",
        )
    return path, value


def _normalized_path(path: str | Path) -> str:
    return str(Path(path).expanduser().resolve())


def _same_path(first: str | Path, second: str | Path) -> bool:
    left = Path(first).expanduser().resolve()
    right = Path(second).expanduser().resolve()
    if left == right:
        return True
    if left.exists() and right.exists():
        try:
            return os.path.samefile(left, right)
        except OSError:
            return False
    return False


def _chain_paths(chain: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    for key in ("origin", "current"):
        item = chain.get(key)
        if isinstance(item, dict) and item.get("path"):
            paths.append(_normalized_path(str(item["path"])))
    revisions = chain.get("revisions")
    if isinstance(revisions, list):
        for revision in revisions:
            if not isinstance(revision, dict):
                continue
            for key in ("source", "output"):
                item = revision.get(key)
                if isinstance(item, dict) and item.get("path"):
                    paths.append(_normalized_path(str(item["path"])))
    return list(dict.fromkeys(paths))


def _find_chain(
    state: dict[str, Any], path: str | Path
) -> dict[str, Any] | None:
    requested = Path(path).expanduser().resolve()
    for chain in state.get("documents", []):
        if not isinstance(chain, dict):
            continue
        if any(_same_path(requested, item) for item in _chain_paths(chain)):
            return chain
    return None


def resolve_latest_input(
    requested_path: str | Path,
    *,
    use_exact_input: bool = False,
) -> dict[str, Any]:
    requested = require_docx_path(requested_path, must_exist=False)
    if use_exact_input:
        requested = require_docx_path(requested)
        return {
            "status": "ok",
            "code": "exact-docx-input",
            "requested": str(requested),
            "resolved": str(requested),
            "tracked": False,
            "is_latest": True,
        }

    _, state = _load_state()
    chain = _find_chain(state, requested)
    if chain is None:
        requested = require_docx_path(requested)
        return {
            "status": "ok",
            "code": "untracked-docx-input",
            "requested": str(requested),
            "resolved": str(requested),
            "tracked": False,
            "is_latest": True,
        }

    current = chain.get("current")
    if not isinstance(current, dict) or not current.get("path"):
        raise DocxSkillError(
            "Tracked DOCX lineage has no current version",
            code="invalid-docx-lineage",
            details={"chain_id": chain.get("id")},
        )
    latest = require_docx_path(str(current["path"]))
    expected_sha256 = str(current.get("sha256", "")).lower()
    actual_sha256 = file_sha256(latest)
    if not expected_sha256 or expected_sha256 != actual_sha256:
        raise blocked(
            "The latest tracked DOCX changed outside the version chain; "
            "inspect it and use --use-exact-input only if that external version "
            "is intentionally the new editing base",
            code="docx-lineage-diverged",
            details={
                "requested": str(requested),
                "latest": str(latest),
                "expected_sha256": expected_sha256 or None,
                "actual_sha256": actual_sha256,
                "chain_id": chain.get("id"),
            },
        )
    return {
        "status": "ok",
        "code": (
            "latest-docx-resolved"
            if not _same_path(requested, latest)
            else "latest-docx-input"
        ),
        "requested": str(requested),
        "resolved": str(latest),
        "tracked": True,
        "is_latest": _same_path(requested, latest),
        "chain_id": chain.get("id"),
        "revision": len(chain.get("revisions", [])),
        "sha256": actual_sha256,
    }


def latest_input_path(
    requested_path: str | Path,
    *,
    use_exact_input: bool = False,
) -> Path:
    resolution = resolve_latest_input(
        requested_path, use_exact_input=use_exact_input
    )
    return Path(str(resolution["resolved"]))


def _new_chain_id(origin_path: Path) -> str:
    session_id = os.environ.get("PILOTDECK_SESSION_ID", "")
    material = f"{session_id}\0{origin_path}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:20]


def backup_replaced_source(source_path: str | Path) -> dict[str, Any]:
    source = require_docx_path(source_path)
    session_dir = _session_dir()
    if session_dir is None:
        raise blocked(
            "Replacing a source DOCX requires PILOTDECK_WORK_DIR so a hidden "
            "recovery copy and version record can be retained",
            code="source-replacement-requires-work-dir",
            details={"source": str(source)},
        )
    digest = file_sha256(source)
    backup_dir = session_dir / LINEAGE_DATA_DIR_NAME / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / f"{source.stem}-{digest[:16]}.docx"
    if not backup.exists():
        shutil.copy2(source, backup)
    if file_sha256(backup) != digest:
        raise DocxSkillError(
            "The hidden source recovery copy failed its digest check",
            code="source-backup-mismatch",
            details={"source": str(source), "backup": str(backup)},
        )
    return {
        "path": str(backup),
        "sha256": digest,
    }


def record_delivery(
    output_path: str | Path,
    *,
    source_path: str | Path | None,
    source_sha256: str | None,
    candidate_sha256: str,
    operation: str,
    replace_source: bool,
    backup: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    state_path, state = _load_state()
    if state_path is None:
        return None

    output = require_docx_path(output_path)
    output_item = {
        "path": str(output),
        "sha256": candidate_sha256,
    }
    source = (
        require_docx_path(source_path)
        if source_path is not None and Path(source_path).expanduser().resolve().is_file()
        else None
    )
    chain = _find_chain(state, source or output)
    if chain is None:
        origin_path = source or output
        origin_sha256 = source_sha256 or candidate_sha256
        chain = {
            "id": _new_chain_id(origin_path),
            "origin": {
                "path": str(origin_path),
                "sha256": origin_sha256,
            },
            "current": output_item,
            "revisions": [],
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
        }
        state["documents"].append(chain)

    revision_number = len(chain.get("revisions", [])) + 1
    revision = {
        "revision": revision_number,
        "operation": operation,
        "source": (
            {
                "path": str(source),
                "sha256": source_sha256,
            }
            if source is not None
            else None
        ),
        "output": output_item,
        "replace_source": replace_source,
        "backup": backup,
        "turn_id": os.environ.get("PILOTDECK_TURN_ID") or None,
        "created_at": _now_iso(),
    }
    chain.setdefault("revisions", []).append(revision)
    chain["current"] = output_item
    chain["updated_at"] = revision["created_at"]
    state["updated_at"] = revision["created_at"]
    write_json(state_path, state)
    return {
        "state": str(state_path),
        "chain_id": chain["id"],
        "revision": revision_number,
        "origin": chain["origin"],
        "current": output_item,
    }


def paths_are_same(first: str | Path, second: str | Path) -> bool:
    return _same_path(first, second)
