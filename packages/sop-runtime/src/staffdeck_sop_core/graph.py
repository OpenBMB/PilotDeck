from __future__ import annotations

from typing import Any

MAX_NESTED_SOP_DEPTH = 8


def nodes(content: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item
        for item in content.get("nodes", [])
        if isinstance(item, dict) and item.get("node_id")
    ]


def node(content: dict[str, Any], node_id: str | None) -> dict[str, Any] | None:
    return next(
        (item for item in nodes(content) if str(item.get("node_id")) == str(node_id)),
        None,
    )


def start_node(content: dict[str, Any]) -> str | None:
    configured = str(content.get("start_node_id") or "").strip()
    return (
        configured
        if node(content, configured)
        else (str(nodes(content)[0]["node_id"]) if nodes(content) else None)
    )


def outgoing(content: dict[str, Any], source: str | None) -> list[dict[str, Any]]:
    values = [
        item
        for item in content.get("edges", [])
        if isinstance(item, dict) and str(item.get("source_node_id")) == str(source)
    ]
    return sorted(values, key=lambda item: int(item.get("priority") or 0))


def default_next(content: dict[str, Any], source: str | None) -> str | None:
    edges = outgoing(content, source)
    if len(edges) == 1:
        return str(edges[0].get("next_node_id"))
    defaults = [
        edge
        for edge in edges
        if str(edge.get("condition") or "").strip().lower() in {"", "default", "else"}
    ]
    return str(defaults[0].get("next_node_id")) if len(defaults) == 1 else None


def is_terminal(content: dict[str, Any], node_id: str | None) -> bool:
    terminal = {str(item) for item in content.get("terminal_node_ids", [])}
    return (
        str(node_id) in terminal
        if terminal
        else (node_id is not None and not outgoing(content, node_id))
    )


def actions(step: dict[str, Any]) -> list[str]:
    values = []
    for value in step.get("allowed_actions", []):
        text = str(value or "").strip().strip("`'\"").strip()
        if text.startswith("call_tool:"):
            name = text.split(":", 1)[1].strip().strip("`'\"").strip()
            text = f"call_tool:{name}" if name else ""
        if text:
            values.append(text)
    return values


def required_tools(step: dict[str, Any]) -> set[str]:
    return {
        action.partition(":")[2].strip()
        for action in actions(step)
        if action.startswith("call_tool:") and action.partition(":")[2].strip()
    }


def validate_graph(content: dict[str, Any]) -> None:
    all_nodes = nodes(content)
    ids = {str(item["node_id"]) for item in all_nodes}
    if not ids:
        raise ValueError("SOP graph requires at least one node")
    if len(ids) != len(all_nodes):
        raise ValueError("SOP node identifiers must be unique")
    if content.get("start_node_id") not in ids:
        raise ValueError("SOP start node is missing")
    for edge in content.get("edges", []):
        if (
            not isinstance(edge, dict)
            or edge.get("source_node_id") not in ids
            or edge.get("next_node_id") not in ids
        ):
            raise ValueError("SOP edge references a missing node")
    if any(item not in ids for item in content.get("terminal_node_ids", [])):
        raise ValueError("SOP terminal references a missing node")
