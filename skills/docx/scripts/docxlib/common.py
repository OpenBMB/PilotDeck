from __future__ import annotations

import json
import os
import shutil
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from xml.etree import ElementTree as ET


MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 128 * 1024 * 1024
MAX_COMPRESSION_RATIO = 1_000
REQUIRED_PARTS = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}


class DocxSkillError(RuntimeError):
    """An expected, user-actionable DOCX operation failure."""


def load_json(path: str | Path) -> Any:
    try:
        with Path(path).open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError as exc:
        raise DocxSkillError(f"JSON file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise DocxSkillError(f"Invalid JSON in {path}: {exc}") from exc


def write_json(path: str | Path, value: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, target)


def require_docx_path(path: str | Path, *, must_exist: bool = True) -> Path:
    resolved = Path(path).expanduser().resolve()
    if resolved.suffix.lower() != ".docx":
        raise DocxSkillError(f"Only .docx files are supported: {resolved}")
    if must_exist and not resolved.is_file():
        raise DocxSkillError(f"DOCX file not found: {resolved}")
    return resolved


def require_distinct_paths(source: str | Path, target: str | Path) -> tuple[Path, Path]:
    src = require_docx_path(source)
    dst = require_docx_path(target, must_exist=False)
    if src == dst:
        raise DocxSkillError("Input and output must be different paths")
    dst.parent.mkdir(parents=True, exist_ok=True)
    return src, dst


def _unsafe_archive_name(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = Path(normalized)
    return normalized.startswith("/") or ".." in path.parts or path.is_absolute()


def validate_docx(path: str | Path) -> dict[str, Any]:
    docx_path = require_docx_path(path)
    errors: list[str] = []
    warnings: list[str] = []
    total_expanded = 0
    xml_parts = 0

    if not zipfile.is_zipfile(docx_path):
        raise DocxSkillError(f"File is not a valid ZIP-based DOCX: {docx_path}")

    try:
        with zipfile.ZipFile(docx_path) as archive:
            names = set(archive.namelist())
            missing = sorted(REQUIRED_PARTS - names)
            if missing:
                errors.append("Missing required parts: " + ", ".join(missing))

            for info in archive.infolist():
                if _unsafe_archive_name(info.filename):
                    errors.append(f"Unsafe archive path: {info.filename}")
                    continue
                total_expanded += info.file_size
                if info.file_size > MAX_MEMBER_BYTES:
                    errors.append(f"Archive member is too large: {info.filename}")
                if total_expanded > MAX_EXPANDED_BYTES:
                    errors.append("Expanded archive exceeds the 512 MB safety limit")
                    break
                if info.compress_size == 0:
                    ratio = info.file_size if info.file_size else 1
                else:
                    ratio = info.file_size / info.compress_size
                if ratio > MAX_COMPRESSION_RATIO and info.file_size > 1024 * 1024:
                    errors.append(f"Suspicious compression ratio: {info.filename}")

            if not errors:
                for name in sorted(names):
                    if not name.lower().endswith((".xml", ".rels")):
                        continue
                    xml_parts += 1
                    try:
                        ET.fromstring(archive.read(name))
                    except ET.ParseError as exc:
                        errors.append(f"Malformed XML in {name}: {exc}")

            if "word/vbaProject.bin" in names:
                errors.append("Macro payload detected; macro-enabled packages are not supported")
            if "docProps/custom.xml" in names:
                warnings.append("Document contains custom properties")
    except zipfile.BadZipFile as exc:
        raise DocxSkillError(f"Invalid DOCX ZIP package: {docx_path}") from exc

    return {
        "status": "ok" if not errors else "error",
        "input": str(docx_path),
        "errors": errors,
        "warnings": warnings,
        "expanded_bytes": total_expanded,
        "xml_parts": xml_parts,
    }


def assert_valid_docx(path: str | Path) -> dict[str, Any]:
    result = validate_docx(path)
    if result["errors"]:
        raise DocxSkillError("; ".join(result["errors"]))
    return result


@contextmanager
def unpacked_copy(source: str | Path) -> Iterator[tuple[Path, Path]]:
    src = require_docx_path(source)
    assert_valid_docx(src)
    with tempfile.TemporaryDirectory(prefix="pilotdeck_docx_") as temp_dir:
        root = Path(temp_dir)
        package = root / "package"
        package.mkdir()
        with zipfile.ZipFile(src) as archive:
            for info in archive.infolist():
                if _unsafe_archive_name(info.filename):
                    raise DocxSkillError(f"Unsafe archive path: {info.filename}")
                archive.extract(info, package)
        yield root, package


def pack_docx(package_dir: str | Path, output: str | Path) -> Path:
    package = Path(package_dir)
    target = require_docx_path(output, must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file_path in sorted(package.rglob("*")):
            if file_path.is_file():
                archive.write(file_path, file_path.relative_to(package).as_posix())
    os.replace(temp, target)
    assert_valid_docx(target)
    return target


def copy_docx(source: str | Path, output: str | Path) -> tuple[Path, Path]:
    src, dst = require_distinct_paths(source, output)
    temp = dst.with_suffix(dst.suffix + ".tmp")
    shutil.copy2(src, temp)
    os.replace(temp, dst)
    return src, dst
