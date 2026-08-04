from __future__ import annotations

from copy import deepcopy
from typing import Any

from .common import DocxSkillError
from .protocol import BUILTIN_TEMPLATE_ID, normalize_style_policy


_NEUTRAL_SHARED: dict[str, Any] = {
    "title_color": "000000",
    "heading_color": "000000",
    "table_style": "Table Grid",
    "table_header_fill": None,
    "table_header_text_color": "000000",
    "table_border_color": "595959",
    "callout_fill": None,
    "callout_border_color": "595959",
    "space_after": 6,
}

_NEUTRAL_LOCALE_VARIANTS: dict[str, dict[str, Any]] = {
    "zh": {
        "body_font": "Times New Roman",
        "east_asia_font": "SimSun",
        "cjk_family": "serif",
        "body_size": 10.5,
        "title_size": 24,
        "heading_sizes": (14, 10.5, 10.5),
        "normal_alignment": "justify",
        "normal_first_line_indent_inches": 0.3,
        "normal_line_spacing_points": 18,
    },
    "default": {
        "body_font": "Times New Roman",
        "east_asia_font": "Noto Serif CJK SC",
        "cjk_family": "serif",
        "body_size": 11,
        "title_size": 22,
        "heading_sizes": (16, 13, 11),
        "normal_alignment": "left",
        "normal_first_line_indent_inches": None,
        "normal_line_spacing_points": None,
    },
}


def resolve_document_style(
    *,
    locale: str,
    style_policy_value: Any,
    style_overrides_value: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    policy = normalize_style_policy(style_policy_value)
    if policy is None:
        raise DocxSkillError(
            "style_policy is required",
            code="invalid-style-policy",
        )
    locale_key = "zh" if locale.strip().casefold().startswith("zh") else "default"
    style = {
        **deepcopy(_NEUTRAL_SHARED),
        **deepcopy(_NEUTRAL_LOCALE_VARIANTS[locale_key]),
        "template": BUILTIN_TEMPLATE_ID,
        "locale": locale,
    }
    overrides = (
        dict(style_overrides_value)
        if isinstance(style_overrides_value, dict)
        else {}
    )
    if policy["mode"] == "builtin" and overrides:
        raise DocxSkillError(
            "Builtin style_policy does not allow style_overrides",
            code="builtin-style-override",
        )
    if policy["mode"] == "user":
        style.update(overrides)
    return policy, style
