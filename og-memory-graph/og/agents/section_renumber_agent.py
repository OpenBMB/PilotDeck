from __future__ import annotations
import re
from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus



_CN_PREFIX_RE = re.compile(
    r"^\s*(?:第)?[一二三四五六七八九十百千万零两\d]+(?:章|节)?[、.\.\s]+"
)


def strip_prefix(title: str) -> str:
    return _CN_PREFIX_RE.sub("", title or "").strip()



_CN_DIGITS = "零一二三四五六七八九"


def chinese_num(n: int) -> str:
    if n <= 0:
        return str(n)
    if n < 10:
        return _CN_DIGITS[n]
    if n == 10:
        return "十"
    if n < 20:
        return "十" + _CN_DIGITS[n - 10]
    if n < 100:
        tens, ones = divmod(n, 10)
        s = _CN_DIGITS[tens] + "十"
        if ones:
            s += _CN_DIGITS[ones]
        return s
    return str(n)


class SectionRenumberAgent:

    def __init__(self, sort_key: str = "version_then_id"):
        self.sort_key = sort_key






    _EXCLUDED_TITLE_KEYWORDS = ("参考来源", "参考文献", "附录")

    def _is_excluded(self, title: str) -> bool:
        t = (title or "").lower()
        return any(kw in (title or "") or kw.lower() in t
                   for kw in self._EXCLUDED_TITLE_KEYWORDS)

    def renumber(self, og: OutlineGraph) -> dict:
        report = {
            "renumbered": [],
            "prefix_collisions": {},
            "skipped": 0,
            "excluded": [],
        }

        root = og.get_root()
        if not root:
            return report


        all_sections = og.get_children(root.id, NodeType.SECTION)
        sections = []
        for s in all_sections:
            if s.status != NodeStatus.ACTIVE:
                report["skipped"] += 1
                continue
            if self._is_excluded(s.title):
                report["excluded"].append({"id": s.id, "title": s.title})


                s.display_order = None
                s.display_title = ""
                og.update_node(s)
                continue
            sections.append(s)


        from collections import defaultdict
        prefix_groups: dict[str, list[str]] = defaultdict(list)
        for s in sections:
            m = _CN_PREFIX_RE.match(s.title or "")
            if m:
                prefix_groups[m.group(0).strip()].append(s.title)
        report["prefix_collisions"] = {
            k: v for k, v in prefix_groups.items() if len(v) > 1
        }


        if self.sort_key == "version_then_id":
            sections.sort(key=lambda s: (s.created_in_version, s.id))
        else:
            sections.sort(key=lambda s: s.id)


        for i, sec in enumerate(sections, 1):
            stripped = strip_prefix(sec.title)
            if not stripped:

                stripped = sec.title or f"section_{i}"
            sec.display_order = i
            sec.display_title = stripped
            og.update_node(sec)
            report["renumbered"].append({
                "id": sec.id,
                "old_title": sec.title,
                "display_order": i,
                "display_title": stripped,
            })

        return report
