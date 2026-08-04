from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import warnings
import zipfile
from xml.etree import ElementTree as ET
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from .audit import audit_docx
from .common import (
    DocxSkillError,
    assert_valid_docx,
    file_sha256,
    pack_docx,
    prepare_json_artifact_path,
    unpacked_copy,
)
from .core import (
    compare_docx,
    create_docx,
    edit_docx,
    filter_inspection,
    inspect_docx,
    sanitize_docx,
)
from .delivery import deliver_docx
from .fallback import _fallback_environment, fallback_create, fallback_patch
from .fields import (
    set_package_update_fields_on_open,
    update_fields_on_open_enabled,
)
from .lineage import latest_input_path, resolve_latest_input
from .preflight import preflight_docx
from .protocol import capabilities, schema_for
from .qa import (
    finalize_visual_qa,
    initialize_visual_qa,
    record_visual_review,
)
from .render import find_soffice, render_docx
from .review import finalize_docx, review_docx
from .toc import refresh_toc, toc_status


def _dump(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def _expect_error(
    function: Callable[..., Any],
    expected_status: str,
    expected_code: str,
    *args: Any,
    **kwargs: Any,
) -> None:
    try:
        function(*args, **kwargs)
    except DocxSkillError as exc:
        assert exc.status == expected_status, (exc.status, str(exc))
        assert exc.code == expected_code, (exc.code, str(exc))
        return
    raise AssertionError(f"Expected {expected_status}/{expected_code}")


def run_smoke_test() -> dict[str, Any]:
    steps: list[str] = []
    negative_checks: list[str] = []
    smoke_parent_value = os.environ.get("PILOTDECK_WORK_DIR", "").strip()
    smoke_parent = (
        Path(smoke_parent_value).expanduser().resolve()
        if smoke_parent_value
        else None
    )
    if smoke_parent:
        smoke_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="pilotdeck_docx_smoke_",
        dir=str(smoke_parent) if smoke_parent else None,
    ) as temp_dir:
        root = Path(temp_dir)

        capability_result = capabilities()
        assert capability_result["protocol_version"] == 8
        assert len(capability_result["capability_states"]) == len(
            set(capability_result["capability_states"])
        )
        assert capability_result["output_policy"][
            "atomic_validation_before_replace"
        ]
        assert capability_result["output_policy"][
            "mutation_outputs_are_internal_candidates"
        ]
        assert capability_result["output_policy"][
            "control_artifacts_are_internal"
        ]
        assert capability_result["output_policy"][
            "visual_review_requires_page_image_sha256"
        ]
        assert capability_result["output_policy"][
            "automated_blank_page_gate"
        ]
        assert (
            capability_result["output_policy"]["final_output_requires_command"]
            == "deliver"
        )
        os.environ["PILOTDECK_DOCX_TEST_SECRET"] = "must-not-leak"
        try:
            fallback_environment = _fallback_environment("test")
        finally:
            os.environ.pop("PILOTDECK_DOCX_TEST_SECRET", None)
        assert "PILOTDECK_DOCX_TEST_SECRET" not in fallback_environment
        assert fallback_environment["DOCX_FALLBACK_MODE"] == "test"
        create_schema = schema_for("create")["schema"]
        edit_schema = schema_for("edit")["schema"]
        review_schema = schema_for("review")["schema"]
        assert create_schema["additionalProperties"] is False
        assert (
            create_schema["$defs"]["block_image"]["properties"]["path"]["type"]
            == "string"
        )
        assert "enum" in create_schema["$defs"]["block_table"]["properties"]["style"]
        assert (
            edit_schema["properties"]["operations"]["items"]["oneOf"][0][
                "additionalProperties"
            ]
            is False
        )
        assert any(
            item["properties"].get("action", {}).get("const") == "insert_image"
            for item in edit_schema["properties"]["operations"]["items"]["oneOf"]
        )
        assert review_schema["properties"]["comments"]["items"]["additionalProperties"] is False
        steps.append("capability-contract")

        invalid_spec = root / "invalid-create.json"
        _dump(invalid_spec, {"content": [], "unsupported_magic": True})
        _expect_error(
            create_docx,
            "error",
            "unknown-spec-fields",
            invalid_spec,
            root / "invalid.docx",
        )
        negative_checks.append("unknown-create-field")

        invalid_table_style_spec = root / "invalid-table-style.json"
        _dump(
            invalid_table_style_spec,
            {
                "style_policy": {
                    "mode": "user",
                    "source": "explicit-requirements",
                    "requirements": ["Use the requested shaded table style."],
                },
                "content": [
                    {
                        "type": "table",
                        "headers": ["A"],
                        "rows": [["B"]],
                        "style": "shaded",
                    }
                ]
            },
        )
        _expect_error(
            create_docx,
            "error",
            "invalid-spec",
            invalid_table_style_spec,
            root / "invalid-table-style.docx",
        )
        negative_checks.append("invalid-table-style")

        create_spec = root / "create.json"
        _dump(
            create_spec,
            {
                "style_policy": {
                    "mode": "user",
                    "source": "explicit-requirements",
                    "requirements": [
                        "Use a blue report hierarchy and Arial typography."
                    ],
                },
                "style_overrides": {
                    "body_font": "Arial",
                    "title_color": "1F4E79",
                    "heading_color": "1F4E79",
                    "table_header_fill": "D9EAF7",
                },
                "locale": "zh-CN",
                "metadata": {
                    "title": "2026 项目复盘报告",
                    "author": "PilotDeck Test",
                },
                "header": {"text": "内部资料", "alignment": "right"},
                "footer": {"text": "第 {PAGE} 页 / 共 {NUMPAGES} 页", "alignment": "center"},
                "content": [
                    {"type": "title", "text": "2026 项目复盘报告"},
                    {"type": "subtitle", "text": "能力声明—执行—降级—验收"},
                    {
                        "type": "toc",
                        "title": "目录",
                        "levels": [1, 2],
                        "page_break_after": True,
                    },
                    {"type": "heading", "level": 1, "text": "项目概览"},
                    {
                        "type": "paragraph",
                        "text": "计划于五月发布，目标增长 20%。",
                    },
                    {
                        "type": "paragraph",
                        "runs": [
                            {"text": "跨", "bold": True},
                            {"text": "运行修订", "italic": True},
                        ],
                    },
                    {"type": "bullet", "text": "完成需求分析"},
                    {
                        "type": "callout",
                        "label": "决策",
                        "text": "最终就绪评审通过后继续。",
                    },
                    {
                        "type": "checklist",
                        "items": ["确认负责人", "确认发布日期"],
                    },
                    {
                        "type": "table",
                        "headers": ["工作流", "状态"],
                        "rows": [["需求", "完成"], ["开发", "进行中"]],
                        "column_widths": [3, 1],
                        "alignments": ["left", "center"],
                    },
                ],
            },
        )
        create_acceptance = root / "create-acceptance.json"
        _dump(
            create_acceptance,
            {
                "style_policy": {
                    "mode": "user",
                    "source": "explicit-requirements",
                    "requirements": [
                        "Use a blue report hierarchy and Arial typography."
                    ],
                },
                "document_policy": {
                    "origin": "new",
                    "allow_header": True,
                    "allow_footer": True,
                    "allow_page_numbers": True,
                },
            },
        )
        _expect_error(
            create_docx,
            "blocked",
            "unrequested-header",
            create_spec,
            root / "unrequested-header.docx",
        )
        negative_checks.append("unrequested-document-chrome-blocked")
        created = root / "created.docx"
        creation = create_docx(
            create_spec,
            created,
            acceptance_path=create_acceptance,
        )
        assert creation["fonts"]["east_asia"]
        _expect_error(
            create_docx,
            "blocked",
            "output-exists",
            create_spec,
            created,
            acceptance_path=create_acceptance,
        )
        create_docx(
            create_spec,
            created,
            acceptance_path=create_acceptance,
            overwrite=True,
        )
        assert not update_fields_on_open_enabled(created)

        neutral_spec = root / "neutral-create.json"
        _dump(
            neutral_spec,
            {
                "locale": "zh-CN",
                "content": [
                    {"type": "title", "text": "中文技术报告"},
                    {"type": "heading", "level": 1, "text": "总体结论"},
                    {
                        "type": "paragraph",
                        "text": "正文通过字体、层级、间距和线条组织内容。",
                    },
                    {
                        "type": "callout",
                        "label": "结论",
                        "text": "默认不使用装饰性色块。",
                    },
                    {
                        "type": "table",
                        "headers": ["指标", "结果", "说明", "状态"],
                        "rows": [["覆盖率", "100%", "已核验", "通过"]],
                        "column_widths": [2, 1, 2, 1],
                    },
                ],
            },
        )
        neutral_docx = root / "neutral.docx"
        neutral_creation = create_docx(neutral_spec, neutral_docx)
        assert neutral_creation["template"] == "neutral-document-v1"
        assert neutral_creation["style_policy"] == {
            "mode": "builtin",
            "template": "neutral-document-v1",
        }
        assert not update_fields_on_open_enabled(neutral_docx)
        with zipfile.ZipFile(neutral_docx) as archive:
            neutral_document = ET.fromstring(archive.read("word/document.xml"))
            neutral_styles = ET.fromstring(archive.read("word/styles.xml"))
            direct_fills = neutral_document.findall(
                ".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tcPr/"
                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}shd"
            )
            assert not direct_fills
            direct_colors = {
                node.get(
                    "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val"
                )
                for node in neutral_document.findall(
                    ".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}color"
                )
            }
            assert "1F4E79" not in direct_colors
            caption_style = neutral_styles.find(
                ".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}style"
                "[@{http://schemas.openxmlformats.org/wordprocessingml/2006/main}styleId='Caption']"
            )
            assert caption_style is not None
            caption_color = caption_style.find(
                ".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}color"
            )
            assert caption_color is not None
            assert caption_color.get(
                "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val"
            ) == "000000"
        neutral_audit = audit_docx(neutral_docx, profile="final")
        neutral_codes = {
            item["code"] for item in neutral_audit["issues"]
        }
        assert "text-line-height-clipping" not in neutral_codes
        assert "fields-update-on-open" not in neutral_codes
        assert "excessive-chromatic-table-fill" not in neutral_codes
        assert "repeated-accent-table-styles" not in neutral_codes
        steps.append("neutral-chinese-default")

        illustration = root / "illustration.png"
        Image.new("RGB", (640, 360), (245, 245, 245)).save(illustration)
        with Image.open(illustration) as image:
            pixels = image.load()
            for index in range(80, 560):
                pixels[index, 180] = (20, 20, 20)
            image.save(illustration)
        formal_spec = root / "formal-create.json"
        _dump(
            formal_spec,
            {
                "style_policy": {
                    "mode": "builtin",
                    "template": "neutral-document-v1",
                },
                "document_structure": {"archetype": "formal-report"},
                "locale": "zh-CN",
                "content": [
                    {"type": "title", "text": "正式报告"},
                    {"type": "subtitle", "text": "封面副标题"},
                    {"type": "toc", "title": "目录"},
                    {"type": "heading", "level": 1, "text": "第一章"},
                    {"type": "paragraph", "text": "正文从新页面开始。"},
                    {
                        "type": "image",
                        "path": str(illustration),
                        "caption": "图 1 示例图",
                        "alt_text": "一条横向深色线条",
                    },
                ],
            },
        )
        formal_docx = root / "formal.docx"
        formal_creation = create_docx(formal_spec, formal_docx)
        assert formal_creation["document_structure"]["archetype"] == "formal-report"
        with zipfile.ZipFile(formal_docx) as archive:
            formal_document = ET.fromstring(archive.read("word/document.xml"))
            page_breaks = formal_document.findall(
                ".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}br"
                "[@{http://schemas.openxmlformats.org/wordprocessingml/2006/main}type='page']"
            )
            assert len(page_breaks) >= 2
        formal_audit = audit_docx(formal_docx, profile="final")
        assert formal_audit["summary"]["images"] == 1
        assert {
            "text-line-height-clipping",
            "image-line-height-clipping",
        }.isdisjoint({
            item["code"] for item in formal_audit["issues"]
        })
        steps.append("formal-report-pagination-and-image")

        image_patch = root / "insert-image.json"
        _dump(
            image_patch,
            {
                "operations": [
                    {
                        "action": "insert_image",
                        "match": "总体结论",
                        "path": str(illustration),
                        "placement": "after",
                        "caption": "图 2 编辑插图",
                        "alt_text": "编辑流程插入的示例图",
                    }
                ]
            },
        )
        image_edited = root / "image-edited.docx"
        image_edit_result = edit_docx(
            neutral_docx,
            image_patch,
            image_edited,
        )
        assert image_edit_result["operations"][0]["affected"] == 1
        image_edit_audit = audit_docx(image_edited, profile="final")
        assert image_edit_audit["summary"]["images"] == 1
        assert "image-line-height-clipping" not in {
            item["code"] for item in image_edit_audit["issues"]
        }
        steps.append("anchored-image-edit")

        builtin_override_specs = {
            "style-overrides": {
                "style_policy": {
                    "mode": "builtin",
                    "template": "neutral-document-v1",
                },
                "style_overrides": {"title_color": "1F4E79"},
                "content": [{"type": "title", "text": "Rejected"}],
            },
            "run-color": {
                "content": [
                    {
                        "type": "paragraph",
                        "runs": [{"text": "Rejected", "color": "1F4E79"}],
                    }
                ],
            },
            "table-style": {
                "content": [
                    {
                        "type": "table",
                        "headers": ["A"],
                        "rows": [["B"]],
                        "style": "Light Shading Accent 1",
                    }
                ],
            },
        }
        for label, value in builtin_override_specs.items():
            spec_path = root / f"builtin-{label}.json"
            _dump(spec_path, value)
            _expect_error(
                create_docx,
                "error",
                "builtin-style-override",
                spec_path,
                root / f"builtin-{label}.docx",
            )
            negative_checks.append(f"builtin-style-{label}-blocked")

        builtin_acceptance = root / "builtin-acceptance.json"
        _dump(
            builtin_acceptance,
            {
                "style_policy": {
                    "mode": "builtin",
                    "template": "neutral-document-v1",
                }
            },
        )
        _expect_error(
            create_docx,
            "error",
            "style-policy-mismatch",
            create_spec,
            root / "style-policy-mismatch.docx",
            acceptance_path=builtin_acceptance,
        )
        negative_checks.append("style-policy-mismatch")

        dynamic_field_spec = root / "dynamic-field-create.json"
        _dump(
            dynamic_field_spec,
            {
                "locale": "zh-CN",
                "update_fields_on_open": True,
                "content": [
                    {"type": "title", "text": "显式动态域"},
                    {
                        "type": "field",
                        "instruction": "DATE",
                        "placeholder": "2026-07-30",
                    },
                ],
            },
        )
        dynamic_field_docx = root / "dynamic-field.docx"
        create_docx(dynamic_field_spec, dynamic_field_docx)
        assert update_fields_on_open_enabled(dynamic_field_docx)
        dynamic_field_codes = {
            item["code"]
            for item in audit_docx(
                dynamic_field_docx,
                profile="final",
            )["issues"]
        }
        assert "fields-update-on-open" in dynamic_field_codes
        steps.append("field-update-opt-in-audit")
        negative_checks.append("output-overwrite-guard")
        _expect_error(
            inspect_docx,
            "error",
            "invalid-json-artifact-path",
            created,
            root / "inspection.txt",
        )
        control_collision = root / "control-collision.docx"
        control_collision.write_text(
            create_spec.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        control_before = control_collision.read_bytes()
        _expect_error(
            create_docx,
            "blocked",
            "artifact-path-collision",
            control_collision,
            control_collision,
            overwrite=True,
        )
        assert control_collision.read_bytes() == control_before
        negative_checks.append("artifact-path-separation")
        steps.append("create-cjk-fields")

        partial_inspection_docx = root / "partial-inspection.docx"
        with unpacked_copy(created) as (_, package):
            document_xml = package / "word" / "document.xml"
            tree = ET.parse(document_xml)
            namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            body = tree.getroot().find(f"{{{namespace}}}body")
            assert body is not None
            first_paragraph = body.find(f"{{{namespace}}}p")
            assert first_paragraph is not None
            body.remove(first_paragraph)
            content_control = ET.Element(f"{{{namespace}}}sdt")
            content = ET.SubElement(content_control, f"{{{namespace}}}sdtContent")
            content.append(first_paragraph)
            body.insert(0, content_control)
            tree.write(document_xml, encoding="utf-8", xml_declaration=True)
            pack_docx(package, partial_inspection_docx)
        partial_inspection = inspect_docx(partial_inspection_docx)
        assert partial_inspection["status"] == "partial"
        assert partial_inspection["inspection_coverage"]["status"] == "partial"
        assert partial_inspection["package_features"]["content_controls"] == 1
        negative_checks.append("partial-inspection-is-not-success")
        partial_comparison = compare_docx(
            created,
            partial_inspection_docx,
            root / "partial-comparison.json",
        )
        assert partial_comparison["status"] == "partial"
        assert (
            partial_comparison["inspection_coverage"]["after"]["status"]
            == "partial"
        )
        negative_checks.append("partial-comparison-is-not-success")

        signed_docx = root / "signed.docx"
        with unpacked_copy(created) as (_, package):
            signature_dir = package / "_xmlsignatures"
            signature_dir.mkdir()
            (signature_dir / "sig1.xml").write_text(
                "<Signature xmlns='http://www.w3.org/2000/09/xmldsig#'/>",
                encoding="utf-8",
            )
            pack_docx(package, signed_docx)
        signed_inspection = inspect_docx(signed_docx)
        assert signed_inspection["status"] == "partial"
        assert signed_inspection["package_features"]["digital_signatures"]
        signed_edit_patch = root / "signed-edit.json"
        _dump(
            signed_edit_patch,
            {
                "operations": [
                    {"action": "append_paragraph", "text": "不得修改已签名文档"}
                ]
            },
        )
        _expect_error(
            edit_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            signed_edit_patch,
            root / "signed-edit-output.docx",
            allow_lossy=True,
        )
        signed_review_spec = root / "signed-review.json"
        _dump(
            signed_review_spec,
            {
                "comments": [
                    {
                        "match": "2026 项目复盘报告",
                        "text": "不得修改已签名文档",
                    }
                ]
            },
        )
        _expect_error(
            review_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            signed_review_spec,
            root / "signed-review-output.docx",
        )
        _expect_error(
            finalize_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            root / "signed-finalize-output.docx",
            remove_comments=True,
        )
        _expect_error(
            sanitize_docx,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            root / "signed-sanitize-output.docx",
        )
        negative_checks.append("signed-document-mutations-blocked")

        protected_docx = root / "protected.docx"
        with unpacked_copy(created) as (_, package):
            settings_xml = package / "word" / "settings.xml"
            tree = ET.parse(settings_xml)
            namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            protection = ET.Element(f"{{{namespace}}}documentProtection")
            protection.set(f"{{{namespace}}}edit", "readOnly")
            protection.set(f"{{{namespace}}}enforcement", "1")
            tree.getroot().append(protection)
            tree.write(settings_xml, encoding="utf-8", xml_declaration=True)
            pack_docx(package, protected_docx)
        protected_inspection = inspect_docx(protected_docx)
        assert protected_inspection["status"] == "partial"
        assert protected_inspection["package_features"]["document_protection"]
        _expect_error(
            edit_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            signed_edit_patch,
            root / "protected-edit-output.docx",
            allow_lossy=True,
        )
        _expect_error(
            review_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            signed_review_spec,
            root / "protected-review-output.docx",
        )
        _expect_error(
            finalize_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            root / "protected-finalize-output.docx",
            remove_comments=True,
        )
        _expect_error(
            sanitize_docx,
            "blocked",
            "document-protection-blocked",
            protected_docx,
            root / "protected-sanitize-output.docx",
        )
        negative_checks.append("protected-document-mutations-blocked")

        disabled_protection_docx = root / "disabled-protection.docx"
        with unpacked_copy(created) as (_, package):
            settings_xml = package / "word" / "settings.xml"
            tree = ET.parse(settings_xml)
            namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            protection = ET.Element(f"{{{namespace}}}documentProtection")
            protection.set(f"{{{namespace}}}edit", "readOnly")
            protection.set(f"{{{namespace}}}enforcement", "0")
            tree.getroot().append(protection)
            tree.write(settings_xml, encoding="utf-8", xml_declaration=True)
            pack_docx(package, disabled_protection_docx)
        disabled_protection_inspection = inspect_docx(disabled_protection_docx)
        assert disabled_protection_inspection["package_features"][
            "document_protection_settings"
        ]
        assert not disabled_protection_inspection["package_features"][
            "document_protection"
        ]
        disabled_protection_output = root / "disabled-protection-edit.docx"
        disabled_protection_edit = edit_docx(
            disabled_protection_docx,
            signed_edit_patch,
            disabled_protection_output,
        )
        assert disabled_protection_edit["status"] == "ok"
        steps.append("protection-state-semantics")

        active_content_docx = root / "active-content.docx"
        with unpacked_copy(created) as (_, package):
            active_dir = package / "word" / "activeX"
            active_dir.mkdir()
            (active_dir / "activeX1.bin").write_bytes(b"untrusted-control")
            pack_docx(package, active_content_docx)
        active_inspection = inspect_docx(active_content_docx)
        assert active_inspection["status"] == "partial"
        assert active_inspection["package_features"]["active_content"]
        _expect_error(
            edit_docx,
            "blocked",
            "active-content-blocked",
            active_content_docx,
            signed_edit_patch,
            root / "active-content-edit-output.docx",
            allow_lossy=True,
        )
        negative_checks.append("active-content-mutation-blocked")

        duplicate_package = root / "duplicate-package.docx"
        with zipfile.ZipFile(created) as source_archive:
            document_xml = source_archive.read("word/document.xml")
            with zipfile.ZipFile(
                duplicate_package, "w", compression=zipfile.ZIP_DEFLATED
            ) as destination_archive:
                for member in source_archive.infolist():
                    destination_archive.writestr(
                        member, source_archive.read(member.filename)
                    )
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    destination_archive.writestr(
                        "word/document.xml", document_xml
                    )
        _expect_error(
            assert_valid_docx,
            "error",
            "operation-failed",
            duplicate_package,
        )
        negative_checks.append("duplicate-package-parts")

        unknown_edit = root / "unknown-edit.json"
        _dump(
            unknown_edit,
            {
                "operations": [
                    {
                        "action": "append_paragraph",
                        "text": "不会执行",
                        "unsupported_magic": True,
                    }
                ]
            },
        )
        _expect_error(
            edit_docx,
            "error",
            "unknown-spec-fields",
            created,
            unknown_edit,
            root / "unknown-edit.docx",
        )
        negative_checks.append("unknown-edit-field")

        unknown_review = root / "unknown-review.json"
        _dump(
            unknown_review,
            {
                "comments": [
                    {
                        "match": "项目",
                        "text": "不会执行",
                        "replacement": "schema 不允许",
                    }
                ]
            },
        )
        _expect_error(
            review_docx,
            "error",
            "unknown-spec-fields",
            created,
            unknown_review,
            root / "unknown-review.docx",
        )
        negative_checks.append("unknown-review-field")

        reentrant_spec = root / "reentrant-create.json"
        _dump(
            reentrant_spec,
            {
                "content": [{"type": "paragraph", "text": "aba aba"}],
            },
        )
        reentrant_source = root / "reentrant-source.docx"
        create_docx(reentrant_spec, reentrant_source)
        reentrant_patch = root / "reentrant-patch.json"
        _dump(
            reentrant_patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "aba",
                        "replacement": "aba+",
                        "occurrence": "all",
                    }
                ]
            },
        )
        reentrant_output = root / "reentrant-output.docx"
        reentrant_result = edit_docx(
            reentrant_source, reentrant_patch, reentrant_output
        )
        assert reentrant_result["operations"][0]["affected"] == 2
        assert any(
            item["text"] == "aba+ aba+"
            for item in inspect_docx(reentrant_output)["paragraphs"]
        )
        negative_checks.append("replace-all-does-not-rematch-output")

        ambiguous_repeated_patch = root / "ambiguous-repeated-patch.json"
        _dump(
            ambiguous_repeated_patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "aba",
                        "replacement": "changed",
                    }
                ]
            },
        )
        _expect_error(
            edit_docx,
            "partial",
            "ambiguous-edit-target",
            reentrant_source,
            ambiguous_repeated_patch,
            root / "ambiguous-repeated-output.docx",
        )
        assert not (root / "ambiguous-repeated-output.docx").exists()
        negative_checks.append("replace-text-detects-repeated-occurrences")

        second_replacement_patch = root / "second-replacement-patch.json"
        _dump(
            second_replacement_patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "aba",
                        "replacement": "changed",
                        "occurrence": 2,
                    }
                ]
            },
        )
        second_replacement_output = root / "second-replacement-output.docx"
        second_replacement = edit_docx(
            reentrant_source,
            second_replacement_patch,
            second_replacement_output,
        )
        assert second_replacement["operations"][0]["affected"] == 1
        assert any(
            item["text"] == "aba changed"
            for item in inspect_docx(second_replacement_output)["paragraphs"]
        )
        negative_checks.append("replace-text-counts-text-occurrences")

        repeated_review_spec = root / "repeated-review.json"
        _dump(
            repeated_review_spec,
            {
                "tracked_replacements": [
                    {
                        "match": "aba",
                        "replacement": "changed",
                        "occurrence": 2,
                    }
                ]
            },
        )
        repeated_review = root / "repeated-review.docx"
        review_docx(
            reentrant_source, repeated_review_spec, repeated_review
        )
        repeated_final = root / "repeated-final.docx"
        finalize_docx(repeated_review, repeated_final, accept_changes=True)
        assert any(
            item["text"] == "aba changed"
            for item in inspect_docx(repeated_final)["paragraphs"]
        )
        negative_checks.append("tracked-replacement-counts-run-occurrences")

        inspected = inspect_docx(created, root / "created-inspect.json")
        assert inspected["table_count"] == 1
        assert any("项目概览" in item["text"] for item in inspected["headings"])
        instructions = " ".join(item["instruction"] for item in inspected["fields"])
        assert "TOC" in instructions and "PAGE" in instructions and "NUMPAGES" in instructions
        filtered = filter_inspection(inspected, search="目标增长", max_items=5)
        assert filtered["query"]["total_matches"] == 1
        steps.append("inspect-fields-and-filters")

        audit = audit_docx(created, root / "created-audit.json", profile="accessible")
        assert not any(item["code"] == "table-width-not-explicit" for item in audit["issues"])
        steps.append("audit")

        patch = root / "patch.json"
        _dump(
            patch,
            {
                "operations": [
                    {
                        "action": "replace_text",
                        "match": "2026 项目",
                        "replacement": "2027 项目",
                        "occurrence": "all",
                    },
                    {"action": "set_table_cell", "table": 1, "row": 3, "column": 2, "text": "已完成"},
                    {"action": "append_table_row", "table": 1, "values": ["验收", "待确认"]},
                    {"action": "set_header", "text": "受控文件", "alignment": "right"},
                    {"action": "append_paragraph", "text": "附加说明。"},
                ]
            },
        )
        edited = root / "edited.docx"
        edit_result = edit_docx(
            created,
            patch,
            edited,
            acceptance_path=create_acceptance,
        )
        assert sum(item["affected"] for item in edit_result["operations"]) >= 5
        edited_info = inspect_docx(edited)
        assert edited_info["tables"][0]["cells"][2][1] == "已完成"
        assert edited_info["tables"][0]["cells"][-1] == ["验收", "待确认"]
        edited_fields = " ".join(item["instruction"] for item in edited_info["fields"])
        assert "TOC" in edited_fields and "NUMPAGES" in edited_fields
        steps.append("edit-structured-targets")

        missing_patch = root / "missing-patch.json"
        _dump(
            missing_patch,
            {"operations": [{"action": "replace_text", "match": "不存在", "replacement": "x"}]},
        )
        _expect_error(
            edit_docx,
            "partial",
            "edit-target-not-found",
            edited,
            missing_patch,
            root / "missing.docx",
        )
        negative_checks.append("zero-match-edit")

        cross_run_review = root / "cross-run-review.json"
        _dump(
            cross_run_review,
            {
                "tracked_replacements": [
                    {"match": "跨运行", "replacement": "跨段运行", "author": "PilotDeck"}
                ]
            },
        )
        _expect_error(
            review_docx,
            "unsupported",
            "cross-run-redline",
            edited,
            cross_run_review,
            root / "cross-run.docx",
        )
        negative_checks.append("cross-run-redline")

        review_spec = root / "review.json"
        _dump(
            review_spec,
            {
                "comments": [
                    {
                        "match": "目标增长 20%",
                        "text": "请补充数据来源。",
                        "author": "PilotDeck",
                    }
                ],
                "tracked_replacements": [
                    {
                        "match": "五月发布",
                        "replacement": "六月发布",
                        "author": "PilotDeck",
                    }
                ],
            },
        )
        reviewed = root / "reviewed.docx"
        review_docx(edited, review_spec, reviewed)
        reviewed_info = inspect_docx(reviewed)
        assert reviewed_info["status"] == "partial"
        assert reviewed_info["inspection_coverage"]["status"] == "partial"
        assert len(reviewed_info["comments"]) == 1
        assert reviewed_info["tracked_changes"]["insertions"] == 1
        assert reviewed_info["tracked_changes"]["deletions"] == 1
        reviewed_audit = audit_docx(reviewed, profile="final")
        assert reviewed_audit["status"] == "partial"
        assert not reviewed_audit["passed"]
        assert any(
            item["code"] == "tracked-changes-remain"
            for item in reviewed_audit["issues"]
        )
        negative_checks.append("failed-audit-is-not-success")
        steps.append("review")

        final = root / "final.docx"
        finalize_docx(reviewed, final, accept_changes=True, remove_comments=True)
        final_info = inspect_docx(final)
        assert not final_info["comments"]
        assert not any(
            final_info["tracked_changes"][key]
            for key in ("insertions", "deletions", "moves_from", "moves_to", "property_changes")
        )
        assert any("六月发布" in item["text"] for item in final_info["paragraphs"])
        steps.append("finalize")

        _expect_error(
            finalize_docx,
            "error",
            "finalize-action-required",
            reviewed,
            root / "finalize-no-action.docx",
        )
        assert not (root / "finalize-no-action.docx").exists()
        negative_checks.append("finalize-action-required")

        patch_script = root / "patch_package.py"
        patch_script.write_text(
            """\
import argparse
from pathlib import Path
from xml.etree import ElementTree as ET
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
path = Path(a.package_dir) / "word" / "document.xml"
tree = ET.parse(path)
changed = False
for node in tree.getroot().iter():
    if node.text and "附加说明" in node.text:
        node.text = node.text.replace("附加说明", "受控降级说明")
        changed = True
if not changed:
    raise SystemExit(2)
tree.write(path, encoding="utf-8", xml_declaration=True)
""",
            encoding="utf-8",
        )
        fallback_output = root / "fallback.docx"
        fallback_manifest = root / "fallback-manifest.json"
        _expect_error(
            fallback_patch,
            "blocked",
            "digital-signature-blocked",
            signed_docx,
            patch_script,
            root / "signed-fallback-output.docx",
            root / "signed-fallback-manifest.json",
            allow_parts=["word/document.xml"],
            reason="Signed packages must remain immutable.",
        )
        _expect_error(
            fallback_patch,
            "blocked",
            "fallback-allowlist-required",
            final,
            patch_script,
            root / "no-allowlist.docx",
            root / "no-allowlist-manifest.json",
            reason="Negative explicit allowlist test.",
        )
        negative_checks.append("fallback-explicit-allowlist")
        fallback_patch(
            final,
            patch_script,
            fallback_output,
            fallback_manifest,
            allow_parts=["word/document.xml"],
            reason="Bundled edit does not expose this run-level preservation test.",
        )
        assert "word/document.xml" in json.loads(
            fallback_manifest.read_text(encoding="utf-8")
        )["changed_parts"]
        assert any(
            "受控降级说明" in item["text"]
            for item in inspect_docx(fallback_output)["paragraphs"]
        )
        cli_output = root / "fallback-cli.docx"
        cli_manifest = root / "fallback-cli-manifest.json"
        cli = Path(__file__).resolve().parents[1] / "docx_cli.py"
        cli_process = subprocess.run(
            [
                sys.executable,
                str(cli),
                "fallback-patch",
                "--input",
                str(final),
                "--script",
                str(patch_script),
                "--out",
                str(cli_output),
                "--manifest",
                str(cli_manifest),
                "--allow-part",
                "word/document.xml",
                "--reason",
                "Exercise the public CLI fallback wiring.",
            ],
            capture_output=True,
            text=True,
            errors="replace",
            timeout=30,
            check=False,
        )
        assert cli_process.returncode == 0, (
            cli_process.stdout,
            cli_process.stderr,
        )
        cli_result = json.loads(cli_process.stdout)
        assert cli_result["status"] == "ok"
        assert cli_output.is_file()
        assert cli_manifest.is_file()
        steps.append("public-cli-dispatch")
        steps.append("controlled-ooxml-fallback")

        violating_script = root / "violating_patch.py"
        violating_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
(Path(a.package_dir) / "unexpected.bin").write_bytes(b"not allowed")
""",
            encoding="utf-8",
        )
        _expect_error(
            fallback_patch,
            "blocked",
            "fallback-scope-violation",
            final,
            violating_script,
            root / "violating.docx",
            root / "violating-manifest.json",
            allow_parts=["word/document.xml"],
            reason="Negative scope test.",
        )
        negative_checks.append("fallback-scope")

        active_patch_script = root / "active_patch.py"
        active_patch_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
active = Path(a.package_dir) / "word" / "aCtIvEx"
active.mkdir()
(active / "activeX1.bin").write_bytes(b"untrusted-control")
""",
            encoding="utf-8",
        )
        _expect_error(
            fallback_patch,
            "blocked",
            "fallback-scope-violation",
            final,
            active_patch_script,
            root / "active-patch-output.docx",
            root / "active-patch-manifest.json",
            allow_parts=["word/*"],
            reason="ActiveX additions must remain forbidden despite a broad allowlist.",
        )
        negative_checks.append("fallback-patch-active-content-blocked")

        corrupting_script = root / "corrupting_patch.py"
        corrupting_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--package-dir", required=True)
a = p.parse_args()
(Path(a.package_dir) / "word" / "document.xml").write_text("<broken", encoding="utf-8")
""",
            encoding="utf-8",
        )
        invalid_patch_manifest = root / "invalid-patch-manifest.json"
        _expect_error(
            fallback_patch,
            "error",
            "fallback-validation-failed",
            final,
            corrupting_script,
            root / "invalid-patch-output.docx",
            invalid_patch_manifest,
            allow_parts=["word/document.xml"],
            reason="Negative fallback validation test.",
        )
        assert invalid_patch_manifest.is_file()
        assert not (root / "invalid-patch-output.docx").exists()
        negative_checks.append("fallback-patch-validation")

        creator_script = root / "full_create.py"
        creator_script.write_text(
            """\
import argparse
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_heading("受控完整创建", 0)
d.add_paragraph("只有标准 create 无法满足需求时才允许。")
d.save(a.out)
""",
            encoding="utf-8",
        )
        custom = root / "custom.docx"
        fallback_create(
            creator_script,
            custom,
            root / "custom-manifest.json",
            reason="Exercise the declared full-create fallback contract.",
        )
        assert inspect_docx(custom)["paragraph_count"] >= 2
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-output-exists",
            creator_script,
            custom,
            root / "overwrite-manifest.json",
            reason="Negative overwrite test.",
        )
        negative_checks.append("fallback-create-no-overwrite")

        invalid_creator_script = root / "invalid_full_create.py"
        invalid_creator_script.write_text(
            """\
import argparse
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
Path(a.out).write_bytes(b"not a docx")
""",
            encoding="utf-8",
        )
        invalid_create_manifest = root / "invalid-create-manifest.json"
        _expect_error(
            fallback_create,
            "error",
            "fallback-validation-failed",
            invalid_creator_script,
            root / "invalid-create-output.docx",
            invalid_create_manifest,
            reason="Negative full-create validation test.",
        )
        assert invalid_create_manifest.is_file()
        assert not (root / "invalid-create-output.docx").exists()
        negative_checks.append("fallback-create-validation")

        signed_creator_script = root / "signed_full_create.py"
        signed_creator_script.write_text(
            """\
import argparse
import zipfile
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Unsigned content with an unverifiable signature marker.")
d.save(a.out)
with zipfile.ZipFile(a.out, "a", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(
        "_xmlsignatures/sig1.xml",
        "<Signature xmlns='http://www.w3.org/2000/09/xmldsig#'/>",
    )
""",
            encoding="utf-8",
        )
        signed_create_manifest = root / "signed-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-signature-blocked",
            signed_creator_script,
            root / "signed-create-output.docx",
            signed_create_manifest,
            reason="Unverifiable signature output must be blocked.",
        )
        assert signed_create_manifest.is_file()
        assert not (root / "signed-create-output.docx").exists()
        negative_checks.append("fallback-create-signature-blocked")

        protected_creator_script = root / "protected_full_create.py"
        protected_creator_script.write_text(
            """\
import argparse
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Protected fallback output.")
protection = OxmlElement("w:documentProtection")
protection.set(qn("w:edit"), "readOnly")
protection.set(qn("w:enforcement"), "1")
d.settings.element.append(protection)
d.save(a.out)
""",
            encoding="utf-8",
        )
        protected_create_manifest = root / "protected-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-protection-blocked",
            protected_creator_script,
            root / "protected-create-output.docx",
            protected_create_manifest,
            reason="Unverifiable protected output must be blocked.",
        )
        assert protected_create_manifest.is_file()
        assert not (root / "protected-create-output.docx").exists()
        negative_checks.append("fallback-create-protection-blocked")

        active_creator_script = root / "active_full_create.py"
        active_creator_script.write_text(
            """\
import argparse
import zipfile
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Active content must not be accepted.")
d.save(a.out)
with zipfile.ZipFile(a.out, "a", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("word/activeX/activeX1.bin", b"untrusted-control")
""",
            encoding="utf-8",
        )
        active_create_manifest = root / "active-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-active-content-blocked",
            active_creator_script,
            root / "active-create-output.docx",
            active_create_manifest,
            reason="Active content output must be blocked.",
        )
        assert active_create_manifest.is_file()
        assert not (root / "active-create-output.docx").exists()
        negative_checks.append("fallback-create-active-content-blocked")

        macro_creator_script = root / "macro_full_create.py"
        macro_creator_script.write_text(
            """\
import argparse
import zipfile
from docx import Document
p = argparse.ArgumentParser()
p.add_argument("--out", required=True)
a = p.parse_args()
d = Document()
d.add_paragraph("Macro content must not be accepted.")
d.save(a.out)
with zipfile.ZipFile(a.out, "a", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("word/vbaProject.bin", b"untrusted-macro")
""",
            encoding="utf-8",
        )
        macro_create_manifest = root / "macro-create-manifest.json"
        _expect_error(
            fallback_create,
            "blocked",
            "fallback-active-content-blocked",
            macro_creator_script,
            root / "macro-create-output.docx",
            macro_create_manifest,
            reason="Macro output must be blocked.",
        )
        assert macro_create_manifest.is_file()
        assert not (root / "macro-create-output.docx").exists()
        negative_checks.append("fallback-create-macro-blocked")
        steps.append("controlled-full-create")

        clean = root / "clean.docx"
        sanitize_docx(fallback_output, clean, remove_comments=True)
        clean_info = inspect_docx(clean)
        assert clean_info["metadata"]["author"] in {"", None}
        steps.append("sanitize")

        comparison = compare_docx(created, clean, root / "diff.json")
        assert comparison["diff"]
        assert "metadata_changes" in comparison
        steps.append("compare-structure")

        rendered_pages = 0
        preflight_status = "not-run"
        if find_soffice():
            builtin_style_gate = preflight_docx(
                created,
                root / "builtin-style-gate-render",
                acceptance_path=builtin_acceptance,
                profile="draft",
            )
            builtin_style_error_codes = {
                item["code"]
                for item in builtin_style_gate["unresolved"]["errors"]
            }
            assert "builtin-style-chromatic-text" in builtin_style_error_codes
            assert "builtin-style-chromatic-table-fill" in builtin_style_error_codes
            negative_checks.append("builtin-style-preflight-gate")

            toc_candidate = root / "toc-refreshed.docx"
            toc_refresh = refresh_toc(
                created,
                toc_candidate,
                root / "toc-render",
            )
            assert toc_refresh["toc"]["populated"]
            assert toc_refresh["iterations"] >= 2
            assert toc_status(toc_candidate)["entries"] >= 1
            assert not update_fields_on_open_enabled(toc_candidate)
            steps.append("refresh-visible-toc")

            long_toc_spec = root / "long-toc.json"
            long_toc_content: list[dict[str, Any]] = [
                {
                    "type": "toc",
                    "title": "目录",
                    "levels": [1],
                    "page_break_after": True,
                }
            ]
            for section_number in range(1, 71):
                long_toc_content.extend(
                    [
                        {
                            "type": "heading",
                            "level": 1,
                            "text": f"第 {section_number} 节验收主题",
                        },
                        {
                            "type": "paragraph",
                            "text": (
                                "本节用于验证长目录写入后造成的分页变化能够收敛，"
                                "且最终目录页码与稳定版正文保持一致。"
                            ),
                        },
                    ]
                )
            _dump(
                long_toc_spec,
                {
                    "locale": "zh-CN",
                    "page": "a4",
                    "content": long_toc_content,
                },
            )
            long_toc_source = root / "long-toc-source.docx"
            long_toc_candidate = root / "long-toc-refreshed.docx"
            create_docx(long_toc_spec, long_toc_source)
            long_toc_refresh = refresh_toc(
                long_toc_source,
                long_toc_candidate,
                root / "long-toc-render",
            )
            assert long_toc_refresh["toc"]["entries"] == 70
            assert long_toc_refresh["iterations"] >= 3
            assert long_toc_refresh["rendered_pages"] >= 3
            steps.append("refresh-multipage-toc-convergence")

            blank_page_spec = root / "blank-page-spec.json"
            _dump(
                blank_page_spec,
                {
                    "content": [
                        {"type": "title", "text": "Blank-page regression"},
                        {"type": "page_break"},
                        {"type": "page_break"},
                        {"type": "heading", "level": 1, "text": "Final section"},
                    ],
                },
            )
            blank_page_candidate = root / "blank-page.docx"
            create_docx(blank_page_spec, blank_page_candidate)
            blank_page_render = render_docx(
                blank_page_candidate,
                root / "blank-page-render",
                include_text=True,
            )
            assert any(
                item["blank_body"]
                for item in blank_page_render["layout_metrics"]
            ), blank_page_render["layout_metrics"]
            negative_checks.append("blank-body-page-detection")

            previous_qa_work_dir = os.environ.get("PILOTDECK_WORK_DIR")
            qa_command_work = root / "qa-command-work"
            os.environ["PILOTDECK_WORK_DIR"] = str(qa_command_work)
            try:
                prepare_process = subprocess.run(
                    [
                        sys.executable,
                        str(cli),
                        "prepare",
                        "--style-mode",
                        "user",
                        "--style-source",
                        "explicit-requirements",
                        "--style-requirement",
                        "Use the blue report hierarchy exercised by this smoke test.",
                        "--require-text",
                        "项目概览",
                        "--require-heading",
                        "1:项目概览",
                        "--min-pages",
                        "1",
                        "--require-toc",
                        "--allow-header",
                        "--allow-footer",
                        "--allow-page-numbers",
                        "--protect-source",
                        str(create_spec),
                    ],
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=30,
                    check=False,
                    env=os.environ.copy(),
                )
                assert prepare_process.returncode == 0, (
                    prepare_process.stdout,
                    prepare_process.stderr,
                )
                prepared = json.loads(prepare_process.stdout)
                assert prepared["status"] == "ok"
                assert prepared["acceptance"]["style_policy"]["mode"] == "user"
                assert (
                    Path(prepared["paths"]["acceptance"]).parent
                    == qa_command_work.resolve() / "docx" / "qa"
                )
                initialized = initialize_visual_qa(
                    toc_candidate,
                    dispositions={
                        "personal-metadata": (
                            "The smoke test intentionally sets an author."
                        )
                    },
                )
                assert initialized["status"] == "ok"
                assert initialized["automated_gate"]["status"] == "passed"
                initialized_review = json.loads(
                    Path(initialized["visual_review"]).read_text(encoding="utf-8")
                )
                assert initialized_review["status"] == "pending"
                assert [
                    item["image_sha256"] for item in initialized_review["pages"]
                ] == [
                    item["image_sha256"] for item in initialized["pages"]
                ]
                incomplete_qa = finalize_visual_qa(
                    toc_candidate,
                )
                assert incomplete_qa["status"] == "partial"
                assert any(
                    item["code"] == "visual-review-incomplete"
                    for item in incomplete_qa["unresolved"]["errors"]
                )
                negative_checks.append("visual-review-recording-required")
                for item in initialized["pages"]:
                    recorded = record_visual_review(
                        initialized["visual_review"],
                        page=item["page"],
                        status="passed",
                        notes=(
                            f"Page {item['page']} has readable content and "
                            "no clipped page edge."
                        ),
                    )
                    assert recorded["status"] == "ok"
                assert recorded["review_status"] == "passed"
                qa_final = finalize_visual_qa(
                    toc_candidate,
                )
                assert qa_final["status"] == "ok", qa_final
                assert qa_final["passed"]
                changed_after_review = (
                    qa_command_work / "docx" / "tmp" / "changed-after-review.docx"
                )
                sanitize_docx(
                    toc_candidate,
                    changed_after_review,
                    remove_comments=False,
                )
                stale_qa = finalize_visual_qa(
                    changed_after_review,
                    report_path=(
                        qa_command_work
                        / "docx"
                        / "qa"
                        / "preflight-stale-candidate.json"
                    ),
                )
                assert stale_qa["status"] == "partial"
                assert any(
                    item["code"] == "qa-candidate-changed"
                    for item in stale_qa["unresolved"]["errors"]
                )
                negative_checks.append("qa-candidate-change-invalidates-review")
                steps.append("deterministic-qa-protocol")
            finally:
                if previous_qa_work_dir is None:
                    os.environ.pop("PILOTDECK_WORK_DIR", None)
                else:
                    os.environ["PILOTDECK_WORK_DIR"] = previous_qa_work_dir

            acceptance_path = root / "acceptance.json"
            _dump(
                acceptance_path,
                {
                    "style_policy": {
                        "mode": "user",
                        "source": "explicit-requirements",
                        "requirements": [
                            "Use a blue report hierarchy and Arial typography."
                        ],
                    },
                    "required_text": ["项目概览"],
                    "required_headings": [
                        {"text": "项目概览", "level": 1},
                    ],
                    "page_count": {"min": 1},
                    "toc": {"required": True, "populated": True},
                    "document_policy": {
                        "origin": "new",
                        "allow_header": True,
                        "allow_footer": True,
                        "allow_page_numbers": True,
                    },
                    "delivery": {
                        "workspace_root": str(root),
                        "scope": "workspace",
                    },
                },
            )
            initial_preflight = preflight_docx(
                toc_candidate,
                root / "rendered-initial",
                profile="final",
                dispositions={
                    "personal-metadata": "The smoke test intentionally sets an author."
                },
                acceptance_path=acceptance_path,
            )
            assert initial_preflight["status"] == "partial"
            assert not initial_preflight["passed"]
            assert initial_preflight["visual_review"]["status"] == "not-reviewed"
            rendered_pages = initial_preflight["render"]["pages"]
            rendered_image_hashes = {
                item["page"]: item["image_sha256"]
                for item in initial_preflight["render"]["page_evidence"]
            }
            visual_review_path = root / "visual-review.json"
            _dump(
                visual_review_path,
                {
                    "artifact_sha256": file_sha256(toc_candidate),
                    "status": "passed",
                    "pages": [
                        {
                            "page": page,
                            "image_sha256": rendered_image_hashes[page],
                            "status": "passed",
                            "notes": f"Smoke-test page {page} checked for clipping and layout.",
                        }
                        for page in range(1, rendered_pages + 1)
                    ],
                },
            )
            preflight = preflight_docx(
                toc_candidate,
                root / "rendered",
                report_path=root / "preflight.json",
                profile="final",
                dispositions={
                    "personal-metadata": "The smoke test intentionally sets an author."
                },
                acceptance_path=acceptance_path,
                visual_review_path=visual_review_path,
            )
            preflight_status = preflight["status"]
            assert preflight["coverage"]["status"] == "passed"
            assert preflight["passed"], preflight
            assert preflight["toc"]["populated"]
            assert preflight["artifact"]["sha256"]
            assert all(
                "text" not in item for item in preflight["render"]["page_text"]
            )
            assert all(
                item["ratio"] is None
                or item["characters"] < 8
                or item["ratio"] >= 0.7
                for item in preflight["render"]["cjk_glyph_coverage"]
            )
            steps.append("preflight-render-coverage")

            failed_visual = preflight_docx(
                toc_candidate,
                root / "rendered-failed",
                profile="final",
                dispositions={
                    "personal-metadata": "The smoke test intentionally sets an author."
                },
                acceptance_path=acceptance_path,
                visual_review_status="passed",
            )
            assert failed_visual["status"] == "partial"
            assert not failed_visual["passed"]
            assert any(
                item["code"] == "visual-review-evidence-missing"
                for item in failed_visual["unresolved"]["errors"]
            )
            assert failed_visual["unresolved"]["warnings"]["total"] == 0
            negative_checks.append("visual-review-evidence-required")

            stale_visual_review_path = root / "stale-visual-review.json"
            _dump(
                stale_visual_review_path,
                {
                    "artifact_sha256": "0" * 64,
                    "status": "passed",
                    "pages": [
                        {
                            "page": page,
                            "image_sha256": rendered_image_hashes[page],
                            "status": "passed",
                            "notes": f"Stale page {page} review.",
                        }
                        for page in range(1, rendered_pages + 1)
                    ],
                },
            )
            stale_visual = preflight_docx(
                toc_candidate,
                root / "rendered-stale-visual",
                profile="final",
                dispositions={
                    "personal-metadata": "The smoke test intentionally sets an author."
                },
                acceptance_path=acceptance_path,
                visual_review_path=stale_visual_review_path,
            )
            assert not stale_visual["passed"]
            assert any(
                item["code"] == "visual-review-artifact-mismatch"
                for item in stale_visual["unresolved"]["errors"]
            )
            negative_checks.append("visual-review-digest-binding")

            generic_visual_review_path = root / "generic-visual-review.json"
            _dump(
                generic_visual_review_path,
                {
                    "artifact_sha256": file_sha256(toc_candidate),
                    "status": "passed",
                    "pages": [
                        {
                            "page": page,
                            "image_sha256": rendered_image_hashes[page],
                            "status": "passed",
                            "notes": "Checked and passed.",
                        }
                        for page in range(1, rendered_pages + 1)
                    ],
                },
            )
            generic_visual = preflight_docx(
                toc_candidate,
                root / "rendered-generic-visual",
                profile="final",
                dispositions={
                    "personal-metadata": "The smoke test intentionally sets an author."
                },
                acceptance_path=acceptance_path,
                visual_review_path=generic_visual_review_path,
            )
            assert not generic_visual["passed"]
            assert any(
                item["code"] == "visual-review-generic-duplication"
                for item in generic_visual["unresolved"]["errors"]
            )
            negative_checks.append("visual-review-page-specific-notes")

            previous_work_dir = os.environ.get("PILOTDECK_WORK_DIR")
            delivery_session = root / "delivery-session"
            delivery_work = delivery_session / "turn-1"
            delivery_work.mkdir(parents=True)
            internal_candidate = delivery_work / "candidate.docx"
            internal_report = delivery_work / "preflight.json"
            internal_render = delivery_work / "rendered"
            internal_visual = delivery_work / "visual-review.json"
            internal_acceptance = delivery_work / "acceptance.json"
            internal_create_spec = delivery_work / "create.json"
            internal_candidate.write_bytes(toc_candidate.read_bytes())
            internal_visual.write_bytes(visual_review_path.read_bytes())
            internal_acceptance.write_bytes(acceptance_path.read_bytes())
            internal_create_spec.write_bytes(create_spec.read_bytes())
            os.environ["PILOTDECK_WORK_DIR"] = str(delivery_work)
            try:
                _expect_error(
                    create_docx,
                    "blocked",
                    "candidate-output-outside-work-dir",
                    internal_create_spec,
                    root / "leaked-candidate.docx",
                    acceptance_path=internal_acceptance,
                )
                negative_checks.append("candidate-output-is-internal")
                _expect_error(
                    prepare_json_artifact_path,
                    "blocked",
                    "control-artifact-outside-work-dir",
                    root / "leaked-inspection.json",
                    purpose="Inspection output",
                )
                negative_checks.append("control-artifacts-are-internal")
                delivery_preflight = preflight_docx(
                    internal_candidate,
                    internal_render,
                    report_path=internal_report,
                    profile="final",
                    dispositions={
                        "personal-metadata": "The smoke test intentionally sets an author."
                    },
                    acceptance_path=internal_acceptance,
                    visual_review_path=internal_visual,
                )
                assert delivery_preflight["passed"]
                field_update_candidate = (
                    delivery_work / "field-update-candidate.docx"
                )
                with unpacked_copy(internal_candidate) as (_, package):
                    set_package_update_fields_on_open(
                        package,
                        enabled=True,
                    )
                    pack_docx(package, field_update_candidate)
                field_update_report = (
                    delivery_work / "field-update-preflight.json"
                )
                field_update_report_value = json.loads(
                    json.dumps(delivery_preflight)
                )
                field_update_report_value["input"] = str(
                    field_update_candidate.resolve()
                )
                field_update_report_value["artifact"]["sha256"] = (
                    file_sha256(field_update_candidate)
                )
                _dump(field_update_report, field_update_report_value)
                _expect_error(
                    deliver_docx,
                    "blocked",
                    "fields-update-on-open",
                    field_update_candidate,
                    field_update_report,
                    root / "field-update-delivery.docx",
                    new_document=True,
                )
                negative_checks.append(
                    "delivery-blocks-field-update-prompt"
                )
                no_acceptance_report = delivery_work / "preflight-no-acceptance.json"
                no_acceptance_preflight = preflight_docx(
                    internal_candidate,
                    delivery_work / "rendered-no-acceptance",
                    report_path=no_acceptance_report,
                    profile="final",
                    dispositions={
                        "personal-metadata": "The smoke test intentionally sets an author."
                    },
                    visual_review_path=internal_visual,
                )
                assert no_acceptance_preflight["passed"]
                _expect_error(
                    deliver_docx,
                    "blocked",
                    "preflight-not-passed",
                    internal_candidate,
                    no_acceptance_report,
                    root / "missing-acceptance-delivery.docx",
                    new_document=True,
                )
                negative_checks.append("delivery-requires-acceptance")
                _expect_error(
                    deliver_docx,
                    "blocked",
                    "delivery-output-outside-workspace",
                    internal_candidate,
                    internal_report,
                    root.parent / "outside-workspace.docx",
                    new_document=True,
                )
                negative_checks.append(
                    "delivery-defaults-to-current-workspace"
                )
                final_delivery = root / "delivered.docx"
                delivered = deliver_docx(
                    internal_candidate,
                    internal_report,
                    final_delivery,
                    new_document=True,
                )
                assert delivered["status"] == "ok"
                assert final_delivery.is_file()
                assert delivered["lineage"]["revision"] == 1

                source_original = root / "source-original.docx"
                source_original.write_bytes(created.read_bytes())
                original_sha256 = file_sha256(source_original)
                _expect_error(
                    deliver_docx,
                    "blocked",
                    "new-document-output-exists",
                    internal_candidate,
                    internal_report,
                    source_original,
                    new_document=True,
                    overwrite=True,
                )
                assert file_sha256(source_original) == original_sha256
                negative_checks.append(
                    "new-document-cannot-replace-existing-file"
                )
                _expect_error(
                    deliver_docx,
                    "blocked",
                    "source-overwrite-requires-explicit-mode",
                    internal_candidate,
                    internal_report,
                    source_original,
                    source_path=source_original,
                    overwrite=True,
                )
                assert file_sha256(source_original) == original_sha256
                negative_checks.append(
                    "generic-overwrite-cannot-replace-source"
                )

                revised_delivery = root / "source-revised.docx"
                revised = deliver_docx(
                    internal_candidate,
                    internal_report,
                    revised_delivery,
                    source_path=source_original,
                )
                assert revised_delivery.is_file()
                assert file_sha256(source_original) == original_sha256
                assert revised["lineage"]["revision"] == 1
                turn_two_work = delivery_session / "turn-2"
                turn_two_work.mkdir()
                os.environ["PILOTDECK_WORK_DIR"] = str(turn_two_work)
                latest = resolve_latest_input(source_original)
                assert latest["resolved"] == str(revised_delivery.resolve())
                assert latest["tracked"]
                assert latest_input_path(source_original) == revised_delivery.resolve()
                exact = resolve_latest_input(
                    source_original, use_exact_input=True
                )
                assert exact["resolved"] == str(source_original.resolve())
                steps.append("session-latest-version-resolution")
                follow_up_candidate = turn_two_work / "follow-up.docx"
                follow_up_process = subprocess.run(
                    [
                        sys.executable,
                        str(cli),
                        "sanitize",
                        "--input",
                        str(source_original),
                        "--out",
                        str(follow_up_candidate),
                        "--remove-comments",
                    ],
                    capture_output=True,
                    text=True,
                    errors="replace",
                    timeout=30,
                    check=False,
                )
                assert follow_up_process.returncode == 0, (
                    follow_up_process.stdout,
                    follow_up_process.stderr,
                )
                follow_up_result = json.loads(follow_up_process.stdout)
                assert follow_up_result["input"] == str(
                    revised_delivery.resolve()
                )
                assert follow_up_candidate.is_file()
                steps.append("mutation-uses-latest-version")

                os.environ["PILOTDECK_WORK_DIR"] = str(delivery_work)
                replaced = deliver_docx(
                    internal_candidate,
                    internal_report,
                    source_original,
                    source_path=source_original,
                    replace_source=True,
                )
                assert replaced["source_replaced"]
                assert replaced["source_backup"]
                assert Path(replaced["source_backup"]["path"]).is_file()
                assert (
                    replaced["source_backup"]["sha256"] == original_sha256
                )
                assert file_sha256(source_original) == file_sha256(
                    internal_candidate
                )
                assert (
                    resolve_latest_input(source_original)["resolved"]
                    == str(source_original.resolve())
                )
                steps.append("explicit-source-replacement-with-backup")

                internal_candidate.write_bytes(created.read_bytes())
                _expect_error(
                    deliver_docx,
                    "blocked",
                    "preflight-artifact-changed",
                    internal_candidate,
                    internal_report,
                    root / "changed-delivery.docx",
                    new_document=True,
                )
                negative_checks.append("delivery-digest-binding")
                steps.append("single-final-delivery")
            finally:
                if previous_work_dir is None:
                    os.environ.pop("PILOTDECK_WORK_DIR", None)
                else:
                    os.environ["PILOTDECK_WORK_DIR"] = previous_work_dir

    return {
        "status": "ok",
        "steps": steps,
        "negative_checks": negative_checks,
        "rendered_pages": rendered_pages,
        "preflight_status": preflight_status,
    }
