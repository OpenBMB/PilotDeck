from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import zipfile
from collections import Counter
from contextlib import contextmanager
from posixpath import dirname, normpath
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET


MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_MEMBER_BYTES = 128 * 1024 * 1024
MAX_COMPRESSION_RATIO = 1_000
REQUIRED_PARTS = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
RELATIONSHIP_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
WORDPROCESSINGML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


class DocxSkillError(RuntimeError):
    """An expected, user-actionable DOCX operation failure."""

    def __init__(
        self,
        message: str,
        *,
        status: str = "error",
        code: str = "operation-failed",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}


def unsupported(
    message: str,
    *,
    code: str = "unsupported-capability",
    details: dict[str, Any] | None = None,
) -> DocxSkillError:
    return DocxSkillError(message, status="unsupported", code=code, details=details)


def blocked(
    message: str,
    *,
    code: str = "operation-blocked",
    details: dict[str, Any] | None = None,
) -> DocxSkillError:
    return DocxSkillError(message, status="blocked", code=code, details=details)


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
    with temporary_sibling(target, suffix=".tmp.json") as temp:
        with temp.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp, target)


def prepare_json_artifact_path(
    path: str | Path,
    *,
    protected_paths: Iterable[str | Path] = (),
    purpose: str = "JSON artifact",
) -> Path:
    target = assert_internal_control_path(path, purpose=purpose)
    if target.suffix.lower() != ".json":
        raise DocxSkillError(
            f"{purpose} must use a .json path: {target}",
            code="invalid-json-artifact-path",
        )
    if target.exists() and not target.is_file():
        raise DocxSkillError(
            f"{purpose} path is not a file: {target}",
            code="invalid-json-artifact-path",
        )
    for protected in protected_paths:
        protected_path = Path(protected).expanduser().resolve()
        if target == protected_path:
            raise blocked(
                f"{purpose} must not overwrite an input, output, specification, or script",
                code="artifact-path-collision",
                details={
                    "artifact": str(target),
                    "protected": str(protected_path),
                },
            )
    return target


def assert_control_path_is_distinct(
    control_path: str | Path,
    output_path: str | Path,
    *,
    purpose: str,
) -> None:
    control = Path(control_path).expanduser().resolve()
    output = Path(output_path).expanduser().resolve()
    if control == output:
        raise blocked(
            f"{purpose} must not be reused as the DOCX output path",
            code="artifact-path-collision",
            details={"control": str(control), "out": str(output)},
        )


def require_docx_path(path: str | Path, *, must_exist: bool = True) -> Path:
    resolved = Path(path).expanduser().resolve()
    if resolved.suffix.lower() != ".docx":
        raise DocxSkillError(f"Only .docx files are supported: {resolved}")
    if must_exist and not resolved.is_file():
        raise DocxSkillError(f"DOCX file not found: {resolved}")
    return resolved


def file_sha256(path: str | Path) -> str:
    source = Path(path).expanduser().resolve()
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pilotdeck_work_dir() -> Path | None:
    configured = os.environ.get("PILOTDECK_WORK_DIR", "").strip()
    return Path(configured).expanduser().resolve() if configured else None


def pilotdeck_workspace_root() -> Path:
    """Return the workspace that owns the current PilotDeck task."""
    for name in ("PILOTDECK_WORKSPACE_CWD", "PILOTDECK_PROJECT_ROOT"):
        configured = os.environ.get(name, "").strip()
        if configured:
            root = Path(configured).expanduser().resolve()
            if not root.is_dir():
                raise blocked(
                    f"{name} does not identify an existing workspace directory",
                    code="workspace-root-invalid",
                    details={"environment": name, "workspace_root": str(root)},
                )
            return root

    work_dir = pilotdeck_work_dir()
    if work_dir is not None:
        for ancestor in (work_dir, *work_dir.parents):
            if (
                ancestor.name == "work"
                and ancestor.parent.name == ".pilotdeck"
            ):
                return ancestor.parent.parent.resolve()
        # Standalone tests and manual CLI runs may provide an isolated work
        # directory without PilotDeck's normal .pilotdeck/work hierarchy.
        return work_dir.parent.resolve()
    return Path.cwd().resolve()


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def assert_internal_control_path(
    path: str | Path,
    *,
    purpose: str = "DOCX control artifact",
) -> Path:
    """Keep non-deliverable task artifacts inside the turn work directory."""
    target = Path(path).expanduser().resolve()
    work_dir = pilotdeck_work_dir()
    if work_dir is not None and not _is_relative_to(target, work_dir):
        raise blocked(
            f"{purpose} is an internal task artifact and must be written under "
            "PILOTDECK_WORK_DIR",
            code="control-artifact-outside-work-dir",
            details={
                "artifact": str(target),
                "work_dir": str(work_dir),
                "next": (
                    "Move reports, manifests, specifications, helper scripts, "
                    "renders, and QA output under PILOTDECK_WORK_DIR."
                ),
            },
        )
    return target


def assert_internal_candidate_path(path: str | Path) -> Path:
    target = Path(path).expanduser().resolve()
    work_dir = pilotdeck_work_dir()
    if work_dir is not None and not _is_relative_to(target, work_dir):
        raise blocked(
            "DOCX mutation outputs are internal candidates until delivery; "
            "write them under PILOTDECK_WORK_DIR and use the deliver command "
            "for the requested project output",
            code="candidate-output-outside-work-dir",
            details={
                "out": str(target),
                "work_dir": str(work_dir),
                "next": "Run preflight on an internal candidate, then deliver it.",
            },
        )
    return target


def prepare_output_docx_path(
    path: str | Path, *, overwrite: bool = False
) -> Path:
    target = assert_internal_candidate_path(
        require_docx_path(path, must_exist=False)
    )
    if target.exists() and not target.is_file():
        raise blocked(
            "Output DOCX path exists but is not a regular file",
            code="output-path-invalid",
            details={"out": str(target)},
        )
    if target.exists() and not overwrite:
        raise blocked(
            "Output DOCX already exists; choose a new path or pass --overwrite explicitly",
            code="output-exists",
            details={"out": str(target)},
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def prepare_delivery_docx_path(
    path: str | Path,
    *,
    overwrite: bool = False,
    workspace_root: str | Path | None = None,
    authorized_external_path: str | Path | None = None,
    replace_source_path: str | Path | None = None,
) -> Path:
    root = (
        Path(workspace_root).expanduser().resolve()
        if workspace_root is not None
        else pilotdeck_workspace_root()
    )
    if not root.is_dir():
        raise blocked(
            "The frozen workspace root is not an existing directory",
            code="workspace-root-invalid",
            details={"workspace_root": str(root)},
        )
    raw_target = Path(path).expanduser()
    target = require_docx_path(
        raw_target if raw_target.is_absolute() else root / raw_target,
        must_exist=False,
    )
    external = (
        require_docx_path(authorized_external_path, must_exist=False)
        if authorized_external_path is not None
        else None
    )
    replace_source = (
        require_docx_path(replace_source_path, must_exist=False)
        if replace_source_path is not None
        else None
    )
    if (
        not _is_relative_to(target, root)
        and target != external
        and target != replace_source
    ):
        raise blocked(
            "Final DOCX output must stay inside the current workspace unless "
            "the user explicitly supplied this exact external destination",
            code="delivery-output-outside-workspace",
            details={
                "out": str(target),
                "workspace_root": str(root),
                "authorized_external_path": (
                    str(external) if external is not None else None
                ),
                "next": (
                    "Choose a path under the workspace, or freeze the exact "
                    "user-requested external path during prepare."
                ),
            },
        )
    work_dir = pilotdeck_work_dir()
    if work_dir is not None and _is_relative_to(target, work_dir):
        raise blocked(
            "The delivered DOCX must be outside PILOTDECK_WORK_DIR",
            code="delivery-output-is-internal",
            details={"out": str(target), "work_dir": str(work_dir)},
        )
    if target.exists() and not target.is_file():
        raise blocked(
            "Delivery DOCX path exists but is not a regular file",
            code="output-path-invalid",
            details={"out": str(target)},
        )
    if target.exists() and not overwrite:
        raise blocked(
            "Delivery DOCX already exists; choose a new path or pass --overwrite explicitly",
            code="output-exists",
            details={"out": str(target)},
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def require_distinct_paths(
    source: str | Path,
    target: str | Path,
    *,
    overwrite: bool = False,
) -> tuple[Path, Path]:
    src = require_docx_path(source)
    dst = require_docx_path(target, must_exist=False)
    if src == dst:
        raise DocxSkillError("Input and output must be different paths")
    dst = prepare_output_docx_path(dst, overwrite=overwrite)
    return src, dst


@contextmanager
def temporary_sibling(
    target: str | Path, *, suffix: str = ".tmp"
) -> Iterator[Path]:
    destination = Path(target).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=suffix,
        dir=destination.parent,
    )
    os.close(descriptor)
    temporary = Path(name)
    try:
        yield temporary
    finally:
        temporary.unlink(missing_ok=True)


def _unsafe_archive_name(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = Path(normalized)
    return normalized.startswith("/") or ".." in path.parts or path.is_absolute()


def _relationship_source_part(relationship_part: str) -> str:
    normalized = relationship_part.replace("\\", "/")
    if normalized == "_rels/.rels":
        return ""
    marker = "/_rels/"
    if marker not in normalized or not normalized.endswith(".rels"):
        raise DocxSkillError(f"Invalid relationship part name: {relationship_part}")
    prefix, filename = normalized.split(marker, 1)
    return f"{prefix}/{filename[:-5]}"


def _resolve_relationship_target(relationship_part: str, target: str) -> str:
    parsed = urlsplit(target)
    decoded = unquote(parsed.path).replace("\\", "/")
    if decoded.startswith("/"):
        resolved = normpath(decoded.lstrip("/"))
    else:
        source_part = _relationship_source_part(relationship_part)
        resolved = normpath(f"{dirname(source_part)}/{decoded}" if source_part else decoded)
    if resolved in {"", "."} or resolved.startswith("../") or "/../" in f"/{resolved}/":
        raise DocxSkillError(
            f"Unsafe relationship target in {relationship_part}: {target}",
            code="unsafe-relationship-target",
        )
    return resolved


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
            member_names = archive.namelist()
            names = set(member_names)
            duplicate_parts = sorted(
                name for name, count in Counter(member_names).items() if count > 1
            )
            if duplicate_parts:
                errors.append(
                    "Duplicate package parts are not allowed: "
                    + ", ".join(duplicate_parts[:20])
                )
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

            if not errors:
                for rel_name in sorted(name for name in names if name.endswith(".rels")):
                    root = ET.fromstring(archive.read(rel_name))
                    for relationship in root.findall(
                        f"{{{RELATIONSHIP_NS}}}Relationship"
                    ):
                        if relationship.get("TargetMode") == "External":
                            continue
                        target = relationship.get("Target", "")
                        try:
                            resolved = _resolve_relationship_target(rel_name, target)
                        except DocxSkillError as exc:
                            errors.append(str(exc))
                            continue
                        if resolved not in names:
                            errors.append(
                                f"Relationship target is missing: {rel_name} -> {target}"
                            )

            if not errors and "[Content_Types].xml" in names:
                content_root = ET.fromstring(archive.read("[Content_Types].xml"))
                defaults = {
                    element.get("Extension", "").lower()
                    for element in content_root.findall(
                        f"{{{CONTENT_TYPES_NS}}}Default"
                    )
                }
                overrides = {
                    element.get("PartName", "").lstrip("/")
                    for element in content_root.findall(
                        f"{{{CONTENT_TYPES_NS}}}Override"
                    )
                }
                for name in sorted(names):
                    if name.endswith("/") or name in {
                        "[Content_Types].xml",
                        "_rels/.rels",
                    } or name.endswith(".rels"):
                        continue
                    extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                    if name not in overrides and extension not in defaults:
                        warnings.append(f"No content type declaration for part: {name}")

            if any(name.lower() == "word/vbaproject.bin" for name in names):
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


def digital_signature_parts(path: str | Path) -> list[str]:
    docx_path = require_docx_path(path)
    try:
        with zipfile.ZipFile(docx_path) as archive:
            return sorted(
                name
                for name in archive.namelist()
                if name.lower().startswith("_xmlsignatures/")
                or name.lower()
                in {
                    "word/signatures.xml",
                    "word/signatureline.xml",
                }
            )
    except zipfile.BadZipFile as exc:
        raise DocxSkillError(
            f"File is not a valid ZIP-based DOCX: {docx_path}"
        ) from exc


def active_content_parts(path: str | Path) -> list[str]:
    docx_path = require_docx_path(path)
    try:
        with zipfile.ZipFile(docx_path) as archive:
            return sorted(
                name
                for name in archive.namelist()
                if name.lower() == "word/vbaproject.bin"
                or name.lower().startswith("word/activex/")
            )
    except zipfile.BadZipFile as exc:
        raise DocxSkillError(
            f"File is not a valid ZIP-based DOCX: {docx_path}"
        ) from exc


def document_protection_details(path: str | Path) -> dict[str, dict[str, str]]:
    docx_path = require_docx_path(path)
    try:
        with zipfile.ZipFile(docx_path) as archive:
            if "word/settings.xml" not in archive.namelist():
                return {}
            root = ET.fromstring(archive.read("word/settings.xml"))
    except zipfile.BadZipFile as exc:
        raise DocxSkillError(
            f"File is not a valid ZIP-based DOCX: {docx_path}"
        ) from exc
    details: dict[str, dict[str, str]] = {}
    for local_name in ("documentProtection", "writeProtection"):
        element = root.find(f"{{{WORDPROCESSINGML_NS}}}{local_name}")
        if element is None:
            continue
        details[local_name] = {
            key.rsplit("}", 1)[-1]: value
            for key, value in sorted(element.attrib.items())
        }
    return details


def effective_document_protection_details(
    path: str | Path,
) -> dict[str, dict[str, str]]:
    """Return only protection settings that should block mutation.

    Word commonly leaves a disabled ``w:documentProtection`` element with
    ``w:enforcement="0"`` in otherwise editable documents. Treating mere
    element presence as protection creates false blockers. ``writeProtection``
    is still treated conservatively because its presence declares an
    intentional write-protection workflow.
    """

    declared = document_protection_details(path)
    effective: dict[str, dict[str, str]] = {}
    if "writeProtection" in declared:
        effective["writeProtection"] = declared["writeProtection"]
    document = declared.get("documentProtection")
    if document:
        enforcement = document.get("enforcement", "").strip().lower()
        if enforcement in {"1", "true", "on", "yes"}:
            effective["documentProtection"] = document
    return effective


def assert_safe_mutation(path: str | Path, *, operation: str) -> None:
    active_content = active_content_parts(path)
    if active_content:
        raise blocked(
            f"{operation} is blocked because the document contains active content",
            code="active-content-blocked",
            details={"active_content_parts": active_content},
        )
    parts = digital_signature_parts(path)
    if parts:
        raise blocked(
            f"{operation} would invalidate the document's digital signature",
            code="digital-signature-blocked",
            details={"signature_parts": parts},
        )
    assert_valid_docx(path)
    protection = effective_document_protection_details(path)
    if protection:
        raise blocked(
            f"{operation} is blocked because the document declares editing or write protection",
            code="document-protection-blocked",
            details={"protection": protection},
        )


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
    with temporary_sibling(target, suffix=".tmp.docx") as temp:
        with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file_path in sorted(package.rglob("*")):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(package).as_posix())
        assert_valid_docx(temp)
        os.replace(temp, target)
    assert_valid_docx(target)
    return target


def copy_docx(
    source: str | Path, output: str | Path, *, overwrite: bool = False
) -> tuple[Path, Path]:
    src, dst = require_distinct_paths(source, output, overwrite=overwrite)
    with temporary_sibling(dst, suffix=".tmp.docx") as temp:
        shutil.copy2(src, temp)
        assert_valid_docx(temp)
        os.replace(temp, dst)
    return src, dst
