from __future__ import annotations

import json
import math
import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable

from .common import DocxSkillError, assert_internal_control_path


PROTOCOL_VERSION = 8
RESULT_STATUSES = ("ok", "partial", "unsupported", "blocked", "error")
RICH_RUN_FIELDS = {"text", "bold", "italic", "underline", "color", "size_pt"}
ALIGNMENTS = ("left", "center", "right")
SUPPORTED_FIELD_KEYWORDS = ("TOC", "PAGE", "NUMPAGES", "DATE", "TIME")
BUILTIN_TEMPLATE_ID = "neutral-document-v1"
STYLE_POLICY_MODES = ("builtin", "user")
USER_STYLE_SOURCES = (
    "explicit-requirements",
    "reference-template",
    "existing-document",
)
DOCUMENT_ORIGINS = ("new", "existing")
DOCUMENT_ARCHETYPES = ("simple", "formal-report")
SUPPORTED_TABLE_STYLES = (
    "Table Grid",
    "Light Grid",
    "Light Shading",
    "Light Shading Accent 1",
    "Light Grid Accent 1",
    "Medium Shading 1 Accent 1",
)
HEX_COLOR_PATTERN = r"^#?[0-9A-Fa-f]{6}$"
STYLE_OVERRIDE_FIELDS = {
    "body_font",
    "east_asia_font",
    "body_size",
    "title_size",
    "title_color",
    "heading_color",
    "heading_sizes",
    "normal_alignment",
    "normal_first_line_indent_inches",
    "normal_line_spacing_points",
    "table_style",
    "table_header_fill",
    "table_header_text_color",
    "table_border_color",
    "callout_fill",
    "callout_border_color",
    "space_after",
}
JSON_SCALAR_SCHEMA: dict[str, Any] = {
    "type": ["string", "number", "boolean", "null"]
}
RICH_RUN_PROPERTY_SCHEMAS: dict[str, Any] = {
    "text": {"type": "string"},
    "bold": {"type": "boolean"},
    "italic": {"type": "boolean"},
    "underline": {"type": "boolean"},
    "color": {"type": "string", "pattern": HEX_COLOR_PATTERN},
    "size_pt": {"type": "number", "exclusiveMinimum": 0},
}


CREATE_BLOCK_SCHEMAS: dict[str, set[str]] = {
    "title": {"type", "text", "runs"},
    "subtitle": {"type", "text", "runs"},
    "heading": {"type", "level", "text", "runs"},
    "paragraph": {"type", "text", "runs", "style", "bold"},
    "body": {"type", "text", "runs", "style", "bold"},
    "bullet": {"type", "text", "runs"},
    "numbered": {"type", "text", "runs"},
    "quote": {"type", "text", "runs"},
    "callout": {"type", "label", "text", "runs", "fill", "accent"},
    "checklist": {"type", "items", "checked"},
    "definition_list": {"type", "items"},
    "source_list": {"type", "items"},
    "table": {
        "type",
        "headers",
        "rows",
        "column_widths",
        "alignments",
        "repeat_header",
        "style",
        "caption",
        "header_fill",
        "header_text_color",
        "border_color",
    },
    "image": {"type", "path", "width_inches", "caption", "alt_text"},
    "toc": {"type", "title", "levels", "page_break_after"},
    "field": {"type", "instruction", "placeholder", "alignment"},
    "page_break": {"type"},
    "spacer": {"type", "points"},
}


def _rich_text_properties(block_type: str) -> dict[str, Any]:
    return {
        "type": {"const": block_type},
        "text": {"type": "string"},
        "runs": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": deepcopy(RICH_RUN_PROPERTY_SCHEMAS),
                "required": ["text"],
            },
        },
    }


CREATE_BLOCK_PROPERTY_SCHEMAS: dict[str, dict[str, Any]] = {
    "title": _rich_text_properties("title"),
    "subtitle": _rich_text_properties("subtitle"),
    "heading": {
        **_rich_text_properties("heading"),
        "level": {"type": "integer", "minimum": 1, "maximum": 3},
    },
    "paragraph": {
        **_rich_text_properties("paragraph"),
        "style": {"type": "string"},
        "bold": {"type": "boolean"},
    },
    "body": {
        **_rich_text_properties("body"),
        "style": {"type": "string"},
        "bold": {"type": "boolean"},
    },
    "bullet": _rich_text_properties("bullet"),
    "numbered": _rich_text_properties("numbered"),
    "quote": _rich_text_properties("quote"),
    "callout": {
        **_rich_text_properties("callout"),
        "label": {"type": "string"},
        "fill": {"type": "string", "pattern": HEX_COLOR_PATTERN},
        "accent": {"type": "string", "pattern": HEX_COLOR_PATTERN},
    },
    "checklist": {
        "type": {"const": "checklist"},
        "items": {
            "type": "array",
            "minItems": 1,
            "items": deepcopy(JSON_SCALAR_SCHEMA),
        },
        "checked": {
            "type": "array",
            "items": {"type": "boolean"},
        },
    },
    "definition_list": {
        "type": {"const": "definition_list"},
        "items": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "term": deepcopy(JSON_SCALAR_SCHEMA),
                    "definition": deepcopy(JSON_SCALAR_SCHEMA),
                },
                "required": ["term", "definition"],
            },
        },
    },
    "source_list": {
        "type": {"const": "source_list"},
        "items": {
            "type": "array",
            "minItems": 1,
            "items": deepcopy(JSON_SCALAR_SCHEMA),
        },
    },
    "table": {
        "type": {"const": "table"},
        "headers": {
            "type": "array",
            "items": deepcopy(JSON_SCALAR_SCHEMA),
        },
        "rows": {
            "type": "array",
            "items": {
                "type": "array",
                "items": deepcopy(JSON_SCALAR_SCHEMA),
            },
        },
        "column_widths": {
            "type": "array",
            "items": {"type": "number", "exclusiveMinimum": 0},
        },
        "alignments": {
            "type": "array",
            "items": {"enum": list(ALIGNMENTS)},
        },
        "repeat_header": {"type": "boolean"},
        "style": {"enum": list(SUPPORTED_TABLE_STYLES)},
        "caption": {"type": "string"},
        "header_fill": {
            "oneOf": [
                {"type": "string", "pattern": HEX_COLOR_PATTERN},
                {"type": "null"},
            ]
        },
        "header_text_color": {
            "oneOf": [
                {"type": "string", "pattern": HEX_COLOR_PATTERN},
                {"type": "null"},
            ]
        },
        "border_color": {"type": "string", "pattern": HEX_COLOR_PATTERN},
    },
    "image": {
        "type": {"const": "image"},
        "path": {"type": "string", "minLength": 1},
        "width_inches": {"type": "number", "exclusiveMinimum": 0},
        "caption": {"type": "string"},
        "alt_text": {"type": "string"},
    },
    "toc": {
        "type": {"const": "toc"},
        "title": {"type": "string"},
        "levels": {
            "type": "array",
            "minItems": 1,
            "items": {"type": "integer", "minimum": 1, "maximum": 9},
        },
        "page_break_after": {"type": "boolean"},
    },
    "field": {
        "type": {"const": "field"},
        "instruction": {"type": "string", "minLength": 1},
        "placeholder": {"type": "string"},
        "alignment": {"enum": list(ALIGNMENTS)},
    },
    "page_break": {"type": {"const": "page_break"}},
    "spacer": {
        "type": {"const": "spacer"},
        "points": {"type": "number", "minimum": 0},
    },
}


def _required_for_create_block(name: str) -> list[str]:
    return {
        "heading": ["type", "level"],
        "checklist": ["type", "items"],
        "definition_list": ["type", "items"],
        "source_list": ["type", "items"],
        "image": ["type", "path"],
        "field": ["type", "instruction"],
        "spacer": ["type", "points"],
    }.get(name, ["type"])


def _create_block_schema(name: str) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "properties": deepcopy(CREATE_BLOCK_PROPERTY_SCHEMAS[name]),
        "required": _required_for_create_block(name),
    }
    if name in {
        "title",
        "subtitle",
        "heading",
        "paragraph",
        "body",
        "bullet",
        "numbered",
        "quote",
        "callout",
    }:
        schema["anyOf"] = [{"required": ["text"]}, {"required": ["runs"]}]
    if name == "table":
        schema["anyOf"] = [{"required": ["headers"]}, {"required": ["rows"]}]
    return schema


CREATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "style_policy": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "mode": {"enum": list(STYLE_POLICY_MODES)},
                "template": {"const": BUILTIN_TEMPLATE_ID},
                "source": {"enum": list(USER_STYLE_SOURCES)},
                "requirements": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                },
            },
            "required": ["mode"],
        },
        "style_overrides": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "body_font": {"type": "string", "minLength": 1},
                "east_asia_font": {"type": "string", "minLength": 1},
                "body_size": {"type": "number", "exclusiveMinimum": 0},
                "title_size": {"type": "number", "exclusiveMinimum": 0},
                "title_color": {"type": "string", "pattern": HEX_COLOR_PATTERN},
                "heading_color": {"type": "string", "pattern": HEX_COLOR_PATTERN},
                "heading_sizes": {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 3,
                    "items": {"type": "number", "exclusiveMinimum": 0},
                },
                "normal_alignment": {"enum": ["left", "justify"]},
                "normal_first_line_indent_inches": {
                    "type": "number",
                    "minimum": 0,
                },
                "normal_line_spacing_points": {
                    "type": "number",
                    "exclusiveMinimum": 0,
                },
                "table_style": {"enum": list(SUPPORTED_TABLE_STYLES)},
                "table_header_fill": {
                    "oneOf": [
                        {"type": "string", "pattern": HEX_COLOR_PATTERN},
                        {"type": "null"},
                    ]
                },
                "table_header_text_color": {
                    "oneOf": [
                        {"type": "string", "pattern": HEX_COLOR_PATTERN},
                        {"type": "null"},
                    ]
                },
                "table_border_color": {
                    "type": "string",
                    "pattern": HEX_COLOR_PATTERN,
                },
                "callout_fill": {
                    "oneOf": [
                        {"type": "string", "pattern": HEX_COLOR_PATTERN},
                        {"type": "null"},
                    ]
                },
                "callout_border_color": {
                    "type": "string",
                    "pattern": HEX_COLOR_PATTERN,
                },
                "space_after": {"type": "number", "minimum": 0},
            },
        },
        "document_structure": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "archetype": {"enum": list(DOCUMENT_ARCHETYPES)},
                "cover_page": {"type": "boolean"},
                "toc_page": {"type": "boolean"},
                "body_starts_on_new_page": {"type": "boolean"},
            },
            "required": ["archetype"],
        },
        "locale": {"type": "string", "minLength": 1},
        "update_fields_on_open": {"type": "boolean"},
        "page": {"enum": ["a4", "letter"]},
        "orientation": {"enum": ["portrait", "landscape"]},
        "margins_inches": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "top": {"type": "number", "exclusiveMinimum": 0},
                "right": {"type": "number", "exclusiveMinimum": 0},
                "bottom": {"type": "number", "exclusiveMinimum": 0},
                "left": {"type": "number", "exclusiveMinimum": 0},
            },
        },
        "metadata": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                name: {"type": "string"}
                for name in ("title", "subject", "author", "keywords", "category", "comments")
            },
        },
        "header": {"oneOf": [{"type": "string"}, {"$ref": "#/$defs/story"}]},
        "footer": {"oneOf": [{"type": "string"}, {"$ref": "#/$defs/story"}]},
        "content": {
            "type": "array",
            "items": {
                "oneOf": [
                    {"$ref": f"#/$defs/block_{name}"}
                    for name in CREATE_BLOCK_SCHEMAS
                ]
            },
        },
    },
    "$defs": {
        "story": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "text": {"type": "string"},
                "alignment": {"enum": ["left", "center", "right"]},
            },
            "required": ["text"],
        },
        **{
            f"block_{name}": _create_block_schema(name)
            for name in CREATE_BLOCK_SCHEMAS
        },
    },
}

EDIT_ACTION_SCHEMAS: dict[str, set[str]] = {
    "replace_text": {
        "action",
        "match",
        "replacement",
        "occurrence",
        "location",
        "allow_missing",
    },
    "insert_after": {"action", "match", "text", "style", "occurrence", "location", "allow_missing"},
    "insert_image": {
        "action",
        "match",
        "path",
        "placement",
        "width_inches",
        "caption",
        "alt_text",
        "occurrence",
        "location",
        "allow_missing",
    },
    "delete_paragraph": {"action", "match", "occurrence", "location", "allow_missing"},
    "set_style": {"action", "match", "style", "occurrence", "location", "allow_missing"},
    "append_paragraph": {"action", "text", "style"},
    "add_page_break": {"action"},
    "set_metadata": {
        "action",
        "title",
        "subject",
        "author",
        "keywords",
        "category",
        "comments",
    },
    "set_header": {"action", "text", "alignment"},
    "set_footer": {"action", "text", "alignment"},
    "set_table_cell": {"action", "table", "row", "column", "text"},
    "append_table_row": {"action", "table", "values"},
}


OCCURRENCE_SCHEMA: dict[str, Any] = {
    "oneOf": [
        {"enum": ["all", "first"]},
        {"type": "integer", "minimum": 1},
    ]
}
EDIT_COMMON_TARGET_PROPERTIES: dict[str, Any] = {
    "match": {"type": "string", "minLength": 1},
    "occurrence": deepcopy(OCCURRENCE_SCHEMA),
    "location": {"type": "string"},
    "allow_missing": {"type": "boolean"},
}
EDIT_ACTION_PROPERTY_SCHEMAS: dict[str, dict[str, Any]] = {
    "replace_text": {
        "action": {"const": "replace_text"},
        **deepcopy(EDIT_COMMON_TARGET_PROPERTIES),
        "replacement": {"type": "string"},
    },
    "insert_after": {
        "action": {"const": "insert_after"},
        **deepcopy(EDIT_COMMON_TARGET_PROPERTIES),
        "text": {"type": "string"},
        "style": {"type": "string"},
    },
    "insert_image": {
        "action": {"const": "insert_image"},
        **deepcopy(EDIT_COMMON_TARGET_PROPERTIES),
        "path": {"type": "string", "minLength": 1},
        "placement": {"enum": ["before", "after"]},
        "width_inches": {"type": "number", "exclusiveMinimum": 0},
        "caption": {"type": "string"},
        "alt_text": {"type": "string"},
    },
    "delete_paragraph": {
        "action": {"const": "delete_paragraph"},
        **deepcopy(EDIT_COMMON_TARGET_PROPERTIES),
    },
    "set_style": {
        "action": {"const": "set_style"},
        **deepcopy(EDIT_COMMON_TARGET_PROPERTIES),
        "style": {"type": "string", "minLength": 1},
    },
    "append_paragraph": {
        "action": {"const": "append_paragraph"},
        "text": {"type": "string"},
        "style": {"type": "string"},
    },
    "add_page_break": {"action": {"const": "add_page_break"}},
    "set_metadata": {
        "action": {"const": "set_metadata"},
        **{
            name: {"type": "string"}
            for name in ("title", "subject", "author", "keywords", "category", "comments")
        },
    },
    "set_header": {
        "action": {"const": "set_header"},
        "text": {"type": "string"},
        "alignment": {"enum": list(ALIGNMENTS)},
    },
    "set_footer": {
        "action": {"const": "set_footer"},
        "text": {"type": "string"},
        "alignment": {"enum": list(ALIGNMENTS)},
    },
    "set_table_cell": {
        "action": {"const": "set_table_cell"},
        "table": {"type": "integer", "minimum": 1},
        "row": {"type": "integer", "minimum": 1},
        "column": {"type": "integer", "minimum": 1},
        "text": {"type": "string"},
    },
    "append_table_row": {
        "action": {"const": "append_table_row"},
        "table": {"type": "integer", "minimum": 1},
        "values": {
            "type": "array",
            "items": deepcopy(JSON_SCALAR_SCHEMA),
        },
    },
}
EDIT_ACTION_REQUIRED_FIELDS: dict[str, list[str]] = {
    "replace_text": ["action", "match", "replacement"],
    "insert_after": ["action", "match", "text"],
    "insert_image": ["action", "match", "path"],
    "delete_paragraph": ["action", "match"],
    "set_style": ["action", "match", "style"],
    "append_paragraph": ["action", "text"],
    "add_page_break": ["action"],
    "set_metadata": ["action"],
    "set_header": ["action", "text"],
    "set_footer": ["action", "text"],
    "set_table_cell": ["action", "table", "row", "column", "text"],
    "append_table_row": ["action", "table", "values"],
}


def _edit_action_schema(action: str) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "additionalProperties": False,
        "properties": deepcopy(EDIT_ACTION_PROPERTY_SCHEMAS[action]),
        "required": EDIT_ACTION_REQUIRED_FIELDS[action],
    }
    if action == "set_metadata":
        schema["anyOf"] = [
            {"required": [field]}
            for field in ("title", "subject", "author", "keywords", "category", "comments")
        ]
    return schema


EDIT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["operations"],
    "properties": {
        "operations": {
            "type": "array",
            "items": {
                "oneOf": [
                    _edit_action_schema(action)
                    for action in EDIT_ACTION_SCHEMAS
                ]
            },
            "minItems": 1,
        }
    },
}

COMMENT_FIELDS = {
    "match", "text", "author", "date", "occurrence", "location"
}
TRACKED_REPLACEMENT_FIELDS = {
    "match", "replacement", "author", "date", "occurrence", "location"
}
REVIEW_COMMON_PROPERTY_SCHEMAS: dict[str, Any] = {
    "match": {"type": "string", "minLength": 1},
    "author": {"type": "string"},
    "date": {"type": "string"},
    "occurrence": {"type": "integer", "minimum": 1},
    "location": {"type": "string"},
}
REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "anyOf": [
        {"required": ["comments"]},
        {"required": ["tracked_replacements"]},
    ],
    "properties": {
        "comments": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    **deepcopy(REVIEW_COMMON_PROPERTY_SCHEMAS),
                    "text": {"type": "string", "minLength": 1},
                },
                "required": ["match", "text"],
            },
        },
        "tracked_replacements": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    **deepcopy(REVIEW_COMMON_PROPERTY_SCHEMAS),
                    "replacement": {"type": "string"},
                },
                "required": ["match", "replacement"],
            },
        },
    },
}


def _capability(
    status: str,
    *,
    command: str | None = None,
    fallback: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {"status": status}
    if command:
        item["command"] = command
    if fallback:
        item["fallback"] = fallback
    if reason:
        item["reason"] = reason
    return item


def capabilities() -> dict[str, Any]:
    return {
        "status": "ok",
        "protocol_version": PROTOCOL_VERSION,
        "result_statuses": list(RESULT_STATUSES),
        "capability_states": [
            "supported",
            "partial",
            "fallback",
            "unsupported",
            "blocked",
        ],
        "output_policy": {
            "mutations_require_distinct_input_and_output": True,
            "mutation_outputs_are_internal_candidates": True,
            "control_artifacts_are_internal": True,
            "final_output_requires_command": "deliver",
            "delivery_requires_matching_preflight_sha256": True,
            "visual_review_requires_page_image_sha256": True,
            "task_setup_command": "prepare",
            "canonical_visual_review_commands": [
                "qa-init",
                "qa-record",
                "qa-finalize",
            ],
            "page_image_sha256_is_generated_by_cli": True,
            "manual_page_hashing_is_blocked_by_protocol": True,
            "automated_blank_page_gate": True,
            "existing_outputs_blocked_by_default": True,
            "explicit_overwrite_flag": "--overwrite",
            "source_replacement_requires_flag": "--replace-source",
            "source_replacement_requires_current_user_authorization": True,
            "source_replacement_creates_hidden_backup": True,
            "new_document_must_use_new_path": True,
            "new_document_chrome_disabled_by_default": True,
            "header_footer_page_numbers_require_explicit_acceptance": True,
            "final_output_defaults_to_current_workspace": True,
            "external_output_requires_exact_frozen_path": True,
            "session_lineage_resolves_latest_version": True,
            "exact_older_input_requires_flag": "--use-exact-input",
            "field_updates_on_open_disabled_by_default": True,
            "field_updates_on_open_delivery_requires_flag": (
                "--allow-update-fields-on-open"
            ),
            "fallback_create_can_overwrite": False,
            "atomic_validation_before_replace": True,
        },
        "mutation_blockers": {
            "digital_signatures": {
                "status": "blocked",
                "applies_to": [
                    "edit",
                    "review",
                    "finalize",
                    "sanitize",
                    "fallback-patch",
                ],
                "reason": (
                    "Any content or package mutation invalidates the signature; "
                    "the source must remain unchanged."
                ),
            },
            "macros_and_activex": {
                "status": "blocked",
                "applies_to": [
                    "edit",
                    "review",
                    "finalize",
                    "sanitize",
                    "fallback-patch",
                    "fallback-create",
                ],
                "reason": (
                    "Macro payloads are rejected and ActiveX content is never "
                    "executed, interpreted, or preserved through mutation."
                ),
            },
            "document_protection": {
                "status": "blocked",
                "applies_to": [
                    "edit",
                    "review",
                    "finalize",
                    "sanitize",
                    "fallback-patch",
                ],
                "reason": (
                    "The skill will not bypass declared document or write protection."
                ),
            },
        },
        "runtime_dependencies": {
            "libreoffice": {
                "required_for": [
                    "render",
                    "refresh-toc",
                    "preflight",
                    "qa-init",
                ],
                "probe_command": "check",
                "installation": "external",
                "missing_result": "unsupported",
            }
        },
        "operations": {
            "inspect": {
                "command": "inspect",
                "features": {
                    "paragraphs_tables_headers_footers": _capability("supported"),
                    "fields_and_relationship_inventory": _capability("supported"),
                    "known_package_feature_inventory": _capability("supported"),
                    "summary_search_and_location_filters": _capability("supported"),
                    "digital_signature_cryptographic_verification": _capability(
                        "unsupported",
                        reason=(
                            "Signature parts are inventoried, but cryptographic validity "
                            "and signer identity are not verified."
                        ),
                    ),
                    "text_boxes_notes_math_smartart_chart_semantics": _capability(
                        "partial",
                        reason=(
                            "Package parts are inventoried but not fully converted "
                            "to reading-order text or semantic objects."
                        ),
                    ),
                },
            },
            "create": {
                "command": "create",
                "features": {
                    "structured_prose_lists_tables_images": _capability("supported"),
                    "formal_report_pagination": _capability(
                        "supported",
                        reason=(
                            "The formal-report structure enforces a separate cover, "
                            "TOC page, and body start page and is checked during preflight."
                        ),
                    ),
                    "image_normalization_and_acceptance": _capability(
                        "supported",
                        reason=(
                            "Raster images are decoded, transparency is flattened, "
                            "blank assets are rejected, and prepare can freeze a "
                            "minimum image count."
                        ),
                    ),
                    "two_path_style_policy": _capability(
                        "supported",
                        reason=(
                            "Every task freezes either the built-in neutral template "
                            "or a concrete user-provided style source. Generic document "
                            "genres do not activate a colored theme."
                        ),
                    ),
                    "neutral_builtin_template": _capability(
                        "supported",
                        reason=(
                            "The single built-in template uses black hierarchy, "
                            "white tables, neutral borders, and restrained callouts "
                            "with locale-aware Chinese and Latin typography."
                        ),
                    ),
                    "user_style_overrides": _capability(
                        "supported",
                        reason=(
                            "Concrete user requirements, a reference template, or an "
                            "existing document may provide explicit style tokens."
                        ),
                    ),
                    "page_and_numpages_fields": _capability("supported"),
                    "toc_field": _capability(
                        "partial",
                        command="refresh-toc",
                        reason=(
                            "Create inserts a live TOC field; refresh-toc must populate "
                            "its visible cached entries and page numbers before delivery. "
                            "The refreshed result disables update-on-open to avoid a "
                            "Word opening prompt."
                        ),
                    ),
                    "headers_footers_and_cjk_fonts": _capability("supported"),
                    "chart_as_image": _capability(
                        "fallback", fallback="Generate a local image asset, then use an image block."
                    ),
                    "native_word_charts": _capability(
                        "fallback", fallback="Use chart-as-image or declare full-create fallback."
                    ),
                    "content_controls": _capability(
                        "fallback",
                        fallback=(
                            "Use fallback-create only when native controls are a "
                            "material requirement, then inspect and preflight the result."
                        ),
                    ),
                    "signatures_macros_activex": _capability(
                        "blocked",
                        reason=(
                            "The creator cannot establish signature validity and "
                            "will not synthesize macro or ActiveX content."
                        ),
                    ),
                },
            },
            "edit": {
                "command": "edit",
                "features": {
                    "text_paragraph_metadata": _capability("supported"),
                    "header_footer_and_table_cells": _capability("supported"),
                    "anchored_image_insertion": _capability(
                        "supported",
                        reason=(
                            "A local raster image can be inserted before or after an "
                            "unambiguous paragraph target with caption and alt text."
                        ),
                    ),
                    "fields_sections_and_complex_styles": _capability(
                        "fallback", fallback="Use fallback-patch with an explicit OOXML part allowlist."
                    ),
                    "signed_or_protected_documents": _capability(
                        "blocked", reason="Editing would invalidate protection or signatures."
                    ),
                },
            },
            "review": {
                "command": "review",
                "features": {
                    "paragraph_comments": _capability("supported"),
                    "single_run_tracked_replacement": _capability("supported"),
                    "cross_run_or_structural_redline": _capability(
                        "fallback", fallback="Use fallback-patch or report unsupported fidelity."
                    ),
                },
            },
            "finalize": {
                "command": "finalize",
                "features": {
                    "insertions_deletions_all_story_parts": _capability("supported"),
                    "moves_property_changes_complex_nesting": _capability(
                        "blocked", reason="Full Microsoft Word revision semantics are not implemented."
                    ),
                },
            },
            "compare": {
                "command": "compare",
                "features": {
                    "paragraph_and_structure_diff": _capability("supported"),
                    "pixel_or_legal_redline": _capability(
                        "unsupported",
                        reason="Render both documents or use Microsoft Word Compare when legally required.",
                    ),
                },
            },
            "sanitize": {
                "command": "sanitize",
                "features": {
                    "core_metadata_custom_properties_revision_ids": _capability("supported"),
                    "comments": _capability("supported"),
                    "visible_redaction_image_metadata_embedded_files": _capability(
                        "unsupported",
                        reason="Use a separate, explicitly verified redaction workflow.",
                    ),
                },
            },
            "validate_audit_render": {
                "command": "qa-init",
                "features": {
                    "package_validation": _capability("supported"),
                    "warning_dispositions": _capability("supported"),
                    "acceptance_manifest": _capability(
                        "supported", command="prepare"
                    ),
                    "per_page_visual_review_evidence": _capability(
                        "supported",
                        command="qa-record",
                        reason=(
                            "qa-init binds the current candidate and rendered page "
                            "pixels; qa-record records one inspected page without "
                            "manual path or digest copying."
                        ),
                    ),
                    "libreoffice_render": _capability(
                        "supported",
                        reason=(
                            "Requires a LibreOffice executable detected by the check "
                            "command; a missing runtime returns unsupported."
                        ),
                    ),
                    "automatic_visual_judgment": _capability(
                        "partial",
                        reason="The command checks text coverage; a model or human must inspect page images.",
                    ),
                },
            },
            "deliver": {
                "command": "deliver",
                "features": {
                    "single_final_artifact": _capability("supported"),
                    "preflight_digest_binding": _capability("supported"),
                    "atomic_promotion": _capability("supported"),
                    "default_new_version": _capability("supported"),
                    "explicit_source_replacement_with_backup": _capability(
                        "supported"
                    ),
                    "session_version_lineage": _capability("supported"),
                },
            },
            "controlled_fallback": {
                "features": {
                    "targeted_ooxml_patch": _capability("supported", command="fallback-patch"),
                    "full_custom_new_document": _capability("supported", command="fallback-create"),
                    "silent_direct_python_mutation": _capability(
                        "blocked", reason="Use the controlled fallback commands and emit a manifest."
                    ),
                    "unverifiable_digital_signature_output": _capability(
                        "blocked",
                        reason=(
                            "Fallback output containing signature parts is rejected "
                            "because signature validity cannot be established."
                        ),
                    ),
                    "unverifiable_protected_output": _capability(
                        "blocked",
                        reason=(
                            "Fallback output containing document protection is rejected "
                            "because credentials and enforcement cannot be verified."
                        ),
                    ),
                    "active_content_output": _capability(
                        "blocked",
                        reason=(
                            "Fallback output containing macros or ActiveX is rejected "
                            "and active content is never executed."
                        ),
                    ),
                    "host_process_isolation": _capability(
                        "partial",
                        reason=(
                            "The wrapper fixes cwd, passes a safe environment allowlist, "
                            "enforces the PilotDeck work directory when available, and "
                            "verifies DOCX output scope. Operating-system sandboxing still "
                            "depends on the host tool permission model."
                        ),
                    ),
                }
            },
        },
    }


def schema_for(command: str) -> dict[str, Any]:
    normalized = command.strip().lower()
    schemas = {
        "create": CREATE_SCHEMA,
        "edit": EDIT_SCHEMA,
        "review": REVIEW_SCHEMA,
    }
    if normalized not in schemas:
        raise DocxSkillError(
            f"No declarative schema is available for command: {command}",
            status="unsupported",
            code="schema-unavailable",
            details={"available": sorted(schemas)},
        )
    return {
        "status": "ok",
        "protocol_version": PROTOCOL_VERSION,
        "command": normalized,
        "schema": deepcopy(schemas[normalized]),
    }


def _reject_unknown(mapping: dict[str, Any], allowed: Iterable[str], context: str) -> None:
    unknown = sorted(set(mapping) - set(allowed))
    if unknown:
        raise DocxSkillError(
            f"Unknown {context} field(s): {', '.join(unknown)}",
            code="unknown-spec-fields",
            details={"context": context, "unknown": unknown},
        )


def _is_number(value: Any) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and (not isinstance(value, float) or math.isfinite(value))
    )


def _is_json_scalar(value: Any) -> bool:
    return (
        value is None
        or isinstance(value, (str, bool))
        or _is_number(value)
    )


def _require_string(value: Any, context: str, *, allow_empty: bool = True) -> None:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        suffix = "a string" if allow_empty else "a non-empty string"
        raise DocxSkillError(f"{context} must be {suffix}", code="invalid-spec")


def _require_hex_color(value: Any, context: str) -> None:
    _require_string(value, context, allow_empty=False)
    if not re.fullmatch(HEX_COLOR_PATTERN, value):
        raise DocxSkillError(
            f"{context} must be a six-digit RGB hex color",
            code="invalid-spec",
        )


def normalize_style_policy(
    value: Any,
    *,
    default_builtin: bool = True,
) -> dict[str, Any] | None:
    if value is None:
        if not default_builtin:
            return None
        return {
            "mode": "builtin",
            "template": BUILTIN_TEMPLATE_ID,
        }
    if not isinstance(value, dict):
        raise DocxSkillError(
            "style_policy must be an object",
            code="invalid-style-policy",
        )
    _reject_unknown(
        value,
        {"mode", "template", "source", "requirements"},
        "style_policy",
    )
    mode = value.get("mode")
    if mode not in STYLE_POLICY_MODES:
        raise DocxSkillError(
            "style_policy.mode must be builtin or user",
            code="invalid-style-policy",
        )
    requirements = value.get("requirements", [])
    if not isinstance(requirements, list) or any(
        not isinstance(item, str) or not item.strip()
        for item in requirements
    ):
        raise DocxSkillError(
            "style_policy.requirements must contain non-empty strings",
            code="invalid-style-policy",
        )
    normalized_requirements = list(
        dict.fromkeys(item.strip() for item in requirements)
    )
    if mode == "builtin":
        if value.get("source") is not None or normalized_requirements:
            raise DocxSkillError(
                "Builtin style_policy cannot declare a user style source or requirements",
                code="invalid-style-policy",
            )
        template = value.get("template", BUILTIN_TEMPLATE_ID)
        if template != BUILTIN_TEMPLATE_ID:
            raise DocxSkillError(
                f"Unsupported builtin template: {template!r}",
                code="invalid-style-policy",
                details={"supported": [BUILTIN_TEMPLATE_ID]},
            )
        return {
            "mode": "builtin",
            "template": BUILTIN_TEMPLATE_ID,
        }

    if value.get("template") is not None:
        raise DocxSkillError(
            "User style_policy cannot select a builtin template",
            code="invalid-style-policy",
        )
    source = value.get("source")
    if source not in USER_STYLE_SOURCES:
        raise DocxSkillError(
            "User style_policy requires a declared source",
            code="invalid-style-policy",
            details={"supported_sources": list(USER_STYLE_SOURCES)},
        )
    if source == "explicit-requirements" and not normalized_requirements:
        raise DocxSkillError(
            "Explicit user style requires at least one concrete requirement",
            code="invalid-style-policy",
        )
    normalized: dict[str, Any] = {
        "mode": "user",
        "source": source,
    }
    if normalized_requirements:
        normalized["requirements"] = normalized_requirements
    return normalized


def normalize_document_policy(value: Any) -> dict[str, Any]:
    """Normalize the frozen rules for recurring document chrome."""
    if value is None:
        return {
            "origin": "new",
            "allow_header": False,
            "allow_footer": False,
            "allow_page_numbers": False,
        }
    if not isinstance(value, dict):
        raise DocxSkillError(
            "document_policy must be an object",
            code="invalid-document-policy",
        )
    _reject_unknown(
        value,
        {
            "origin",
            "allow_header",
            "allow_footer",
            "allow_page_numbers",
        },
        "document_policy",
    )
    origin = value.get("origin", "new")
    if origin not in DOCUMENT_ORIGINS:
        raise DocxSkillError(
            "document_policy.origin must be new or existing",
            code="invalid-document-policy",
        )
    normalized: dict[str, Any] = {"origin": origin}
    for name in ("allow_header", "allow_footer", "allow_page_numbers"):
        setting = value.get(name, False)
        if not isinstance(setting, bool):
            raise DocxSkillError(
                f"document_policy.{name} must be boolean",
                code="invalid-document-policy",
            )
        normalized[name] = setting
    return normalized


def normalize_document_structure(value: Any) -> dict[str, Any]:
    """Normalize pagination rules that define the document's major sections."""
    if value is None:
        return {
            "archetype": "simple",
            "cover_page": False,
            "toc_page": False,
            "body_starts_on_new_page": False,
        }
    if not isinstance(value, dict):
        raise DocxSkillError(
            "document_structure must be an object",
            code="invalid-document-structure",
        )
    _reject_unknown(
        value,
        {
            "archetype",
            "cover_page",
            "toc_page",
            "body_starts_on_new_page",
        },
        "document_structure",
    )
    archetype = value.get("archetype", "simple")
    if archetype not in DOCUMENT_ARCHETYPES:
        raise DocxSkillError(
            "document_structure.archetype must be simple or formal-report",
            code="invalid-document-structure",
        )
    formal = archetype == "formal-report"
    normalized: dict[str, Any] = {"archetype": archetype}
    for name in ("cover_page", "toc_page", "body_starts_on_new_page"):
        setting = value.get(name, formal)
        if not isinstance(setting, bool):
            raise DocxSkillError(
                f"document_structure.{name} must be boolean",
                code="invalid-document-structure",
            )
        normalized[name] = setting
    if formal and not all(
        normalized[name]
        for name in ("cover_page", "toc_page", "body_starts_on_new_page")
    ):
        raise DocxSkillError(
            "formal-report requires a separate cover, TOC page, and body start page",
            code="invalid-document-structure",
        )
    if not formal and any(
        normalized[name]
        for name in ("cover_page", "toc_page", "body_starts_on_new_page")
    ):
        raise DocxSkillError(
            "Separate cover/TOC/body pagination requires archetype formal-report",
            code="invalid-document-structure",
        )
    return normalized


def normalize_delivery_policy(value: Any) -> dict[str, Any]:
    """Normalize the workspace-scoped final output contract."""
    if not isinstance(value, dict):
        raise DocxSkillError(
            "delivery must be an object",
            code="invalid-delivery-policy",
        )
    _reject_unknown(
        value,
        {"workspace_root", "scope", "path"},
        "delivery",
    )
    workspace_root = value.get("workspace_root")
    if not isinstance(workspace_root, str) or not workspace_root.strip():
        raise DocxSkillError(
            "delivery.workspace_root must be a non-empty absolute path",
            code="invalid-delivery-policy",
        )
    root = Path(workspace_root).expanduser()
    if not root.is_absolute():
        raise DocxSkillError(
            "delivery.workspace_root must be absolute",
            code="invalid-delivery-policy",
        )
    scope = value.get("scope", "workspace")
    if scope not in {"workspace", "exact-external"}:
        raise DocxSkillError(
            "delivery.scope must be workspace or exact-external",
            code="invalid-delivery-policy",
        )
    normalized: dict[str, Any] = {
        "workspace_root": str(root.resolve()),
        "scope": scope,
    }
    path = value.get("path")
    if scope == "exact-external":
        if not isinstance(path, str) or not path.strip():
            raise DocxSkillError(
                "delivery.path is required for exact-external scope",
                code="invalid-delivery-policy",
            )
        external = Path(path).expanduser()
        if not external.is_absolute() or external.suffix.lower() != ".docx":
            raise DocxSkillError(
                "delivery.path must be an absolute .docx path",
                code="invalid-delivery-policy",
            )
        normalized["path"] = str(external.resolve())
    elif path is not None:
        raise DocxSkillError(
            "delivery.path is valid only for exact-external scope",
            code="invalid-delivery-policy",
        )
    return normalized


def _validate_style_overrides(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise DocxSkillError(
            "style_overrides must be an object",
            code="invalid-style-policy",
        )
    _reject_unknown(value, STYLE_OVERRIDE_FIELDS, "style_overrides")
    for field in ("body_font", "east_asia_font"):
        if field in value:
            _require_string(
                value[field],
                f"style_overrides.{field}",
                allow_empty=False,
            )
    for field in (
        "body_size",
        "title_size",
        "normal_line_spacing_points",
    ):
        if field in value and (
            not _is_number(value[field]) or value[field] <= 0
        ):
            raise DocxSkillError(
                f"style_overrides.{field} must be a positive number",
                code="invalid-style-policy",
            )
    for field in ("normal_first_line_indent_inches", "space_after"):
        if field in value and (
            not _is_number(value[field]) or value[field] < 0
        ):
            raise DocxSkillError(
                f"style_overrides.{field} must be a non-negative number",
                code="invalid-style-policy",
            )
    heading_sizes = value.get("heading_sizes")
    if heading_sizes is not None and (
        not isinstance(heading_sizes, list)
        or len(heading_sizes) != 3
        or any(not _is_number(item) or item <= 0 for item in heading_sizes)
    ):
        raise DocxSkillError(
            "style_overrides.heading_sizes must contain three positive numbers",
            code="invalid-style-policy",
        )
    for field in (
        "title_color",
        "heading_color",
        "table_border_color",
        "callout_border_color",
    ):
        if field in value:
            _require_hex_color(value[field], f"style_overrides.{field}")
    for field in (
        "table_header_fill",
        "table_header_text_color",
        "callout_fill",
    ):
        if field in value and value[field] is not None:
            _require_hex_color(value[field], f"style_overrides.{field}")
    if value.get("normal_alignment") not in {None, "left", "justify"}:
        raise DocxSkillError(
            "style_overrides.normal_alignment must be left or justify",
            code="invalid-style-policy",
        )
    if (
        "table_style" in value
        and value["table_style"] not in SUPPORTED_TABLE_STYLES
    ):
        raise DocxSkillError(
            f"Unsupported table style: {value['table_style']!r}",
            code="invalid-style-policy",
            details={"supported_table_styles": list(SUPPORTED_TABLE_STYLES)},
        )
    return dict(value)


def validate_create_spec(spec: dict[str, Any]) -> None:
    _reject_unknown(spec, CREATE_SCHEMA["properties"], "create specification")
    style_policy = normalize_style_policy(spec.get("style_policy"))
    document_structure = normalize_document_structure(
        spec.get("document_structure")
    )
    style_overrides = _validate_style_overrides(spec.get("style_overrides"))
    if style_policy["mode"] == "builtin" and style_overrides:
        raise DocxSkillError(
            "Builtin style_policy does not allow style_overrides",
            code="builtin-style-override",
        )
    if "page" in spec and (
        not isinstance(spec["page"], str) or spec["page"] not in {"a4", "letter"}
    ):
        raise DocxSkillError("page must be 'a4' or 'letter'", code="invalid-spec")
    if "orientation" in spec and (
        not isinstance(spec["orientation"], str)
        or spec["orientation"] not in {"portrait", "landscape"}
    ):
        raise DocxSkillError(
            "orientation must be 'portrait' or 'landscape'", code="invalid-spec"
        )
    if "locale" in spec:
        _require_string(spec["locale"], "locale", allow_empty=False)
    if "update_fields_on_open" in spec and not isinstance(
        spec["update_fields_on_open"], bool
    ):
        raise DocxSkillError(
            "update_fields_on_open must be boolean",
            code="invalid-spec",
        )
    margins = spec.get("margins_inches")
    if margins is not None:
        if not isinstance(margins, dict):
            raise DocxSkillError("margins_inches must be an object", code="invalid-spec")
        _reject_unknown(margins, {"top", "right", "bottom", "left"}, "margins_inches")
        for name, value in margins.items():
            if not _is_number(value) or value <= 0:
                raise DocxSkillError(
                    f"margins_inches.{name} must be a positive number",
                    code="invalid-spec",
                )
    metadata = spec.get("metadata")
    if metadata is not None:
        if not isinstance(metadata, dict):
            raise DocxSkillError("metadata must be an object", code="invalid-spec")
        _reject_unknown(
            metadata,
            {"title", "subject", "author", "keywords", "category", "comments"},
            "metadata",
        )
        for name, value in metadata.items():
            _require_string(value, f"metadata.{name}")
    for story_name in ("header", "footer"):
        story = spec.get(story_name)
        if story is not None and not isinstance(story, (str, dict)):
            raise DocxSkillError(f"{story_name} must be a string or object", code="invalid-spec")
        if isinstance(story, dict):
            _reject_unknown(story, {"text", "alignment"}, story_name)
            if "text" not in story:
                raise DocxSkillError(f"{story_name}.text is required", code="invalid-spec")
            _require_string(story["text"], f"{story_name}.text")
            if story.get("alignment", "left") not in ALIGNMENTS:
                raise DocxSkillError(
                    f"{story_name}.alignment must be left, center, or right",
                    code="invalid-spec",
                )
    content = spec.get("content", [])
    if not isinstance(content, list):
        raise DocxSkillError("content must be an array", code="invalid-spec")
    if document_structure["archetype"] == "formal-report":
        block_types = [
            str(block.get("type", ""))
            for block in content
            if isinstance(block, dict)
        ]
        if not block_types or block_types[0] != "title":
            raise DocxSkillError(
                "formal-report content must start with a title block",
                code="invalid-document-structure",
            )
        if block_types.count("toc") != 1:
            raise DocxSkillError(
                "formal-report content must contain exactly one toc block",
                code="invalid-document-structure",
            )
        toc_index = block_types.index("toc")
        if not any(
            block_type in {
                "heading",
                "paragraph",
                "body",
                "table",
                "image",
                "bullet",
                "numbered",
            }
            for block_type in block_types[toc_index + 1 :]
        ):
            raise DocxSkillError(
                "formal-report content requires body content after the TOC",
                code="invalid-document-structure",
            )
    for index, block in enumerate(content):
        if not isinstance(block, dict):
            raise DocxSkillError("Every content block must be an object", code="invalid-spec")
        block_type = str(block.get("type", ""))
        if block_type not in CREATE_BLOCK_SCHEMAS:
            raise DocxSkillError(
                f"Unsupported content block type: {block_type or '<missing>'}",
                status="unsupported",
                code="unsupported-create-block",
                details={
                    "index": index,
                    "supported": sorted(CREATE_BLOCK_SCHEMAS),
                    "fallback": "Use a supported block, generate an image asset, or declare a controlled fallback.",
                },
            )
        _reject_unknown(block, CREATE_BLOCK_SCHEMAS[block_type], f"{block_type} block")
        rich_text_block = block_type in {
            "title",
            "subtitle",
            "heading",
            "paragraph",
            "body",
            "bullet",
            "numbered",
            "quote",
            "callout",
        }
        if rich_text_block and "text" not in block and "runs" not in block:
            raise DocxSkillError(
                f"{block_type} requires text or runs", code="invalid-spec"
            )
        if "text" in block:
            _require_string(block["text"], f"{block_type}.text")
        if "runs" in block:
            runs = block["runs"]
            if not isinstance(runs, list) or not runs:
                raise DocxSkillError(
                    f"{block_type}.runs must be a non-empty array",
                    code="invalid-spec",
                )
            for run in runs:
                if not isinstance(run, dict):
                    raise DocxSkillError(
                        f"Every {block_type}.runs item must be an object", code="invalid-spec"
                    )
                _reject_unknown(run, RICH_RUN_FIELDS, f"{block_type}.runs item")
                if "text" not in run:
                    raise DocxSkillError(
                        f"Every {block_type}.runs item requires text", code="invalid-spec"
                    )
                _require_string(run["text"], f"{block_type}.runs.text")
                for name in ("bold", "italic", "underline"):
                    if name in run and not isinstance(run[name], bool):
                        raise DocxSkillError(
                            f"{block_type}.runs.{name} must be boolean",
                            code="invalid-spec",
                        )
                if "color" in run:
                    if style_policy["mode"] == "builtin":
                        raise DocxSkillError(
                            "Builtin style_policy does not allow run color overrides",
                            code="builtin-style-override",
                            details={"block": block_type, "index": index},
                        )
                    _require_hex_color(
                        run["color"], f"{block_type}.runs.color"
                    )
                if (
                    "size_pt" in run
                    and (not _is_number(run["size_pt"]) or run["size_pt"] <= 0)
                ):
                    raise DocxSkillError(
                        f"{block_type}.runs.size_pt must be a positive number",
                        code="invalid-spec",
                    )
                if (
                    "size_pt" in run
                    and style_policy["mode"] == "builtin"
                ):
                    raise DocxSkillError(
                        "Builtin style_policy does not allow run size overrides",
                        code="builtin-style-override",
                        details={"block": block_type, "index": index},
                    )
        if block_type == "heading":
            level = block.get("level")
            if (
                not isinstance(level, int)
                or isinstance(level, bool)
                or level < 1
                or level > 3
            ):
                raise DocxSkillError("heading.level must be an integer from 1 to 3")
        if block_type in {"paragraph", "body"}:
            if "style" in block:
                if style_policy["mode"] == "builtin":
                    raise DocxSkillError(
                        "Builtin style_policy does not allow paragraph style overrides",
                        code="builtin-style-override",
                        details={"block": block_type, "index": index},
                    )
                _require_string(
                    block["style"], f"{block_type}.style", allow_empty=False
                )
            if "bold" in block and not isinstance(block["bold"], bool):
                raise DocxSkillError(
                    f"{block_type}.bold must be boolean", code="invalid-spec"
                )
        if block_type == "callout":
            for field in ("label", "fill", "accent"):
                if field in block:
                    if field == "label":
                        _require_string(block[field], "callout.label")
                    else:
                        if style_policy["mode"] == "builtin":
                            raise DocxSkillError(
                                f"Builtin style_policy does not allow callout.{field}",
                                code="builtin-style-override",
                                details={"index": index},
                            )
                        _require_hex_color(block[field], f"callout.{field}")
        if block_type in {"checklist", "source_list"}:
            items = block.get("items")
            if not isinstance(items, list) or not items:
                raise DocxSkillError(
                    f"{block_type}.items must be a non-empty array",
                    code="invalid-spec",
                )
            if any(not _is_json_scalar(item) for item in items):
                raise DocxSkillError(
                    f"{block_type}.items must contain scalar values",
                    code="invalid-spec",
                )
        if block_type == "checklist" and "checked" in block:
            checked = block["checked"]
            if not isinstance(checked, list) or any(
                not isinstance(value, bool) for value in checked
            ):
                raise DocxSkillError(
                    "checklist.checked must be an array of booleans",
                    code="invalid-spec",
                )
        if block_type == "definition_list":
            items = block.get("items")
            if not isinstance(items, list) or not items:
                raise DocxSkillError(
                    "definition_list.items must be a non-empty array",
                    code="invalid-spec",
                )
            for item in items:
                if not isinstance(item, dict):
                    raise DocxSkillError(
                        "Every definition_list item must be an object",
                        code="invalid-spec",
                    )
                _reject_unknown(
                    item, {"term", "definition"}, "definition_list item"
                )
                if not {"term", "definition"} <= set(item):
                    raise DocxSkillError(
                        "Every definition_list item requires term and definition",
                        code="invalid-spec",
                    )
                if any(not _is_json_scalar(value) for value in item.values()):
                    raise DocxSkillError(
                        "definition_list values must be scalar",
                        code="invalid-spec",
                    )
        if block_type == "table":
            forbidden_builtin_table_fields = {
                "style",
                "header_fill",
                "header_text_color",
                "border_color",
            } & set(block)
            if (
                style_policy["mode"] == "builtin"
                and forbidden_builtin_table_fields
            ):
                raise DocxSkillError(
                    "Builtin style_policy does not allow table style overrides",
                    code="builtin-style-override",
                    details={
                        "index": index,
                        "fields": sorted(forbidden_builtin_table_fields),
                    },
                )
            headers = block.get("headers", [])
            rows = block.get("rows", [])
            if not isinstance(headers, list) or not isinstance(rows, list):
                raise DocxSkillError("table headers and rows must be arrays", code="invalid-spec")
            column_count = len(headers) or (len(rows[0]) if rows and isinstance(rows[0], list) else 0)
            if column_count < 1:
                raise DocxSkillError("table requires at least one column", code="invalid-spec")
            for row in rows:
                if not isinstance(row, list) or len(row) != column_count:
                    raise DocxSkillError(
                        "Every table row must match the column count", code="invalid-spec"
                    )
            if any(not _is_json_scalar(value) for value in headers):
                raise DocxSkillError(
                    "table.headers must contain scalar values", code="invalid-spec"
                )
            if any(
                not _is_json_scalar(value)
                for row in rows
                for value in row
            ):
                raise DocxSkillError(
                    "table.rows must contain scalar values", code="invalid-spec"
                )
            widths = block.get("column_widths")
            if widths is not None and (
                not isinstance(widths, list)
                or len(widths) != column_count
                or any(not _is_number(value) or value <= 0 for value in widths)
            ):
                raise DocxSkillError(
                    "table.column_widths must contain one positive number per column",
                    code="invalid-spec",
                )
            alignments = block.get("alignments")
            if alignments is not None and (
                not isinstance(alignments, list)
                or len(alignments) != column_count
                or any(value not in ALIGNMENTS for value in alignments)
            ):
                raise DocxSkillError(
                    "table.alignments must contain left, center, or right for every column",
                    code="invalid-spec",
                )
            if "repeat_header" in block and not isinstance(
                block["repeat_header"], bool
            ):
                raise DocxSkillError(
                    "table.repeat_header must be boolean", code="invalid-spec"
                )
            for field in ("style", "caption"):
                if field in block:
                    _require_string(block[field], f"table.{field}")
            for field in (
                "header_fill",
                "header_text_color",
                "border_color",
            ):
                if field in block and block[field] is not None:
                    _require_hex_color(block[field], f"table.{field}")
            if (
                "style" in block
                and block["style"] not in SUPPORTED_TABLE_STYLES
            ):
                raise DocxSkillError(
                    f"Unsupported table style: {block['style']!r}",
                    code="invalid-spec",
                    details={
                        "supported_table_styles": list(SUPPORTED_TABLE_STYLES),
                    },
                )
        if block_type == "image" and not str(block.get("path", "")).strip():
            raise DocxSkillError("image.path is required", code="invalid-spec")
        if block_type == "image":
            _require_string(block["path"], "image.path", allow_empty=False)
            if (
                "width_inches" in block
                and (
                    not _is_number(block["width_inches"])
                    or block["width_inches"] <= 0
                )
            ):
                raise DocxSkillError(
                    "image.width_inches must be a positive number",
                    code="invalid-spec",
                )
            for field in ("caption", "alt_text"):
                if field in block:
                    _require_string(block[field], f"image.{field}")
        if block_type == "toc" and "levels" in block:
            levels = block["levels"]
            if (
                not isinstance(levels, list)
                or not levels
                or any(
                    not isinstance(level, int)
                    or isinstance(level, bool)
                    or level < 1
                    or level > 9
                    for level in levels
                )
            ):
                raise DocxSkillError("toc.levels must contain integers from 1 to 9")
        if block_type == "toc":
            if "title" in block:
                _require_string(block["title"], "toc.title")
            if "page_break_after" in block and not isinstance(
                block["page_break_after"], bool
            ):
                raise DocxSkillError(
                    "toc.page_break_after must be boolean", code="invalid-spec"
                )
        if block_type == "field" and not str(block.get("instruction", "")).strip():
            raise DocxSkillError("field.instruction is required", code="invalid-spec")
        if block_type == "field":
            _require_string(
                block["instruction"], "field.instruction", allow_empty=False
            )
            keyword = block["instruction"].split(maxsplit=1)[0].upper()
            if keyword not in SUPPORTED_FIELD_KEYWORDS:
                raise DocxSkillError(
                    f"Unsupported field instruction: {block['instruction']}",
                    status="unsupported",
                    code="unsupported-field",
                    details={"supported": list(SUPPORTED_FIELD_KEYWORDS)},
                )
            if "placeholder" in block:
                _require_string(block["placeholder"], "field.placeholder")
            if block.get("alignment", "left") not in ALIGNMENTS:
                raise DocxSkillError(
                    "field.alignment must be left, center, or right",
                    code="invalid-spec",
                )
        if block_type == "spacer":
            if not _is_number(block.get("points")) or block["points"] < 0:
                raise DocxSkillError(
                    "spacer.points must be a non-negative number",
                    code="invalid-spec",
                )


def validate_edit_patch(patch: dict[str, Any]) -> None:
    _reject_unknown(patch, {"operations"}, "edit patch")
    operations = patch.get("operations")
    if not isinstance(operations, list) or not operations:
        raise DocxSkillError("Patch must contain a non-empty operations array", code="invalid-patch")
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict):
            raise DocxSkillError("Every edit operation must be an object", code="invalid-patch")
        action = str(operation.get("action", ""))
        if action not in EDIT_ACTION_SCHEMAS:
            raise DocxSkillError(
                f"Unsupported edit action: {action or '<missing>'}",
                status="unsupported",
                code="unsupported-edit-action",
                details={
                    "index": index,
                    "supported": sorted(EDIT_ACTION_SCHEMAS),
                    "fallback": "Use fallback-patch with an explicit OOXML part allowlist.",
                },
            )
        _reject_unknown(operation, EDIT_ACTION_SCHEMAS[action], f"{action} operation")
        if action in {
            "replace_text",
            "insert_after",
            "insert_image",
            "delete_paragraph",
            "set_style",
        }:
            if not isinstance(operation.get("match"), str) or not operation["match"]:
                raise DocxSkillError(f"{action} requires a non-empty match", code="invalid-patch")
        if "location" in operation and not isinstance(operation["location"], str):
            raise DocxSkillError(
                f"{action}.location must be a string", code="invalid-patch"
            )
        if "allow_missing" in operation and not isinstance(
            operation["allow_missing"], bool
        ):
            raise DocxSkillError(
                f"{action}.allow_missing must be boolean", code="invalid-patch"
            )
        occurrence = operation.get("occurrence")
        if occurrence is not None and occurrence not in {"all", "first"}:
            if not isinstance(occurrence, int) or isinstance(occurrence, bool):
                raise DocxSkillError(
                    f"{action}.occurrence must be all, first, or a positive integer"
                )
            if occurrence < 1:
                raise DocxSkillError(f"{action}.occurrence must be positive")
        if action == "replace_text" and not isinstance(
            operation.get("replacement"), str
        ):
            raise DocxSkillError(
                "replace_text.replacement is required and must be a string",
                code="invalid-patch",
            )
        if action in {"insert_after", "append_paragraph"} and not isinstance(
            operation.get("text"), str
        ):
            raise DocxSkillError(
                f"{action}.text is required and must be a string",
                code="invalid-patch",
            )
        if action in {"insert_after", "append_paragraph"} and "style" in operation:
            if not isinstance(operation["style"], str):
                raise DocxSkillError(
                    f"{action}.style must be a string", code="invalid-patch"
                )
        if action == "insert_image":
            if not isinstance(operation.get("path"), str) or not operation["path"].strip():
                raise DocxSkillError(
                    "insert_image.path is required and must be a non-empty string",
                    code="invalid-patch",
                )
            if operation.get("placement", "after") not in {"before", "after"}:
                raise DocxSkillError(
                    "insert_image.placement must be before or after",
                    code="invalid-patch",
                )
            if "width_inches" in operation and (
                not _is_number(operation["width_inches"])
                or operation["width_inches"] <= 0
            ):
                raise DocxSkillError(
                    "insert_image.width_inches must be a positive number",
                    code="invalid-patch",
                )
            for field in ("caption", "alt_text"):
                if field in operation and not isinstance(operation[field], str):
                    raise DocxSkillError(
                        f"insert_image.{field} must be a string",
                        code="invalid-patch",
                    )
        if action == "set_style" and not str(operation.get("style", "")).strip():
            raise DocxSkillError("set_style.style is required", code="invalid-patch")
        if action == "set_metadata":
            metadata_fields = {
                "title", "subject", "author", "keywords", "category", "comments"
            }
            supplied = metadata_fields & set(operation)
            if not supplied:
                raise DocxSkillError(
                    "set_metadata requires at least one metadata field",
                    code="invalid-patch",
                )
            for field in supplied:
                if not isinstance(operation[field], str):
                    raise DocxSkillError(
                        f"set_metadata.{field} must be a string",
                        code="invalid-patch",
                    )
        if action in {"set_header", "set_footer"}:
            if not isinstance(operation.get("text"), str):
                raise DocxSkillError(
                    f"{action}.text is required and must be a string",
                    code="invalid-patch",
                )
            if operation.get("alignment", "center") not in ALIGNMENTS:
                raise DocxSkillError(f"{action}.alignment is invalid", code="invalid-patch")
        if action == "set_table_cell":
            for field in ("table", "row", "column"):
                value = operation.get(field)
                if not isinstance(value, int) or isinstance(value, bool):
                    raise DocxSkillError(
                        f"set_table_cell.{field} must be an integer"
                    )
                if value < 1:
                    raise DocxSkillError(f"set_table_cell.{field} must be positive")
            if not isinstance(operation.get("text"), str):
                raise DocxSkillError(
                    "set_table_cell.text is required and must be a string",
                    code="invalid-patch",
                )
        if action == "append_table_row":
            table_index = operation.get("table")
            if not isinstance(table_index, int) or isinstance(table_index, bool):
                raise DocxSkillError(
                    "append_table_row.table must be an integer",
                    code="invalid-patch",
                )
            values = operation.get("values")
            if (
                table_index < 1
                or not isinstance(values, list)
                or any(not _is_json_scalar(value) for value in values)
            ):
                raise DocxSkillError(
                    "append_table_row requires a positive table and scalar values array"
                )


def validate_review_spec(spec: dict[str, Any]) -> None:
    _reject_unknown(spec, {"comments", "tracked_replacements"}, "review specification")
    if not any(spec.get(collection) for collection in ("comments", "tracked_replacements")):
        raise DocxSkillError(
            "Review specification requires at least one comment or tracked replacement",
            code="invalid-review-spec",
        )
    for collection in ("comments", "tracked_replacements"):
        items = spec.get(collection, [])
        if not isinstance(items, list):
            raise DocxSkillError(f"{collection} must be an array", code="invalid-review-spec")
        for item in items:
            if not isinstance(item, dict):
                raise DocxSkillError(
                    f"Every {collection} item must be an object", code="invalid-review-spec"
                )
            allowed = (
                COMMENT_FIELDS
                if collection == "comments"
                else TRACKED_REPLACEMENT_FIELDS
            )
            _reject_unknown(item, allowed, f"{collection} item")
            if not isinstance(item.get("match"), str) or not item["match"]:
                raise DocxSkillError(
                    f"Every {collection} item requires a non-empty match",
                    code="invalid-review-spec",
                )
            occurrence = item.get("occurrence")
            if occurrence is not None:
                if not isinstance(occurrence, int) or isinstance(occurrence, bool):
                    raise DocxSkillError(
                        f"{collection}.occurrence must be a positive integer"
                    )
                if occurrence < 1:
                    raise DocxSkillError(
                        f"{collection}.occurrence must be positive"
                    )
            for field in ("author", "date", "location"):
                if field in item and not isinstance(item[field], str):
                    raise DocxSkillError(
                        f"{collection}.{field} must be a string",
                        code="invalid-review-spec",
                    )
            if collection == "comments" and (
                not isinstance(item.get("text"), str) or not item["text"].strip()
            ):
                raise DocxSkillError(
                    "Every comment requires non-empty text",
                    code="invalid-review-spec",
                )
            if collection == "tracked_replacements" and not isinstance(
                item.get("replacement"), str
            ):
                raise DocxSkillError(
                    "Every tracked replacement requires a string replacement",
                    code="invalid-review-spec",
                )


def load_dispositions(path: str | Path | None) -> dict[str, str]:
    if not path:
        return {}
    source = assert_internal_control_path(
        path,
        purpose="Warning dispositions",
    )
    try:
        value = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise DocxSkillError(f"Disposition file not found: {source}") from exc
    except json.JSONDecodeError as exc:
        raise DocxSkillError(f"Invalid disposition JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise DocxSkillError("Warning dispositions must be a JSON object")
    result: dict[str, str] = {}
    for code, rationale in value.items():
        if not isinstance(rationale, str) or not rationale.strip():
            raise DocxSkillError(f"Disposition for {code} must be a non-empty string")
        result[str(code)] = rationale.strip()
    return result
