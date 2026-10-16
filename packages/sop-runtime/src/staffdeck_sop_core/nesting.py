"""Expand subflows into a pinned graph without querying host resources."""

from copy import deepcopy
from dataclasses import asdict, replace

from .engine import SopCoreError
from .models import CapabilityRequirement, SopDefinition


def expand(
    definition: SopDefinition,
    definitions: dict[str, SopDefinition],
    path=(),
    source_path=(),
) -> SopDefinition:
    path = (*path, definition.sop_id)
    if len(path) > 8:
        raise SopCoreError("INVALID_SOP_NESTING", "SOP nesting exceeds 8 levels")
    if len(set(path)) != len(path):
        raise SopCoreError("INVALID_SOP_NESTING", "SOP nesting cycle detected")
    content = deepcopy(definition.content)
    source_path = (*source_path, str(content.get("skill_id") or definition.sop_id))
    requirements = list(definition.capability_requirements)
    for placeholder in list(content.get("nodes", [])):
        if placeholder.get("type") != "subflow":
            continue
        child_id = placeholder.get("sub_sop_id")
        child_version = placeholder.get("sub_sop_version")
        child_key = (child_id, str(child_version)) if child_version else child_id
        if child_key not in definitions:
            raise SopCoreError("INVALID_SOP_NESTING", f"missing child SOP: {child_id}")
        child = expand(definitions[child_key], definitions, path, source_path)
        child_content = child.content
        for field in ("required_info", "response_rules"):
            content[field] = list(
                dict.fromkeys([*content.get(field, []), *child_content.get(field, [])])
            )
        source_id = str(child_content.get("skill_id") or child_id)
        prefix = f"{placeholder['node_id']}::{source_id}::"
        mapping = {
            item["node_id"]: prefix + item["node_id"] for item in child_content["nodes"]
        }
        child_start = mapping[child_content["start_node_id"]]
        terminals = child_content.get("terminal_node_ids") or [
            n["node_id"]
            for n in child_content["nodes"]
            if not any(
                e["source_node_id"] == n["node_id"]
                for e in child_content.get("edges", [])
            )
        ]
        original_edges = content.get("edges", [])
        incoming = [
            e for e in original_edges if e["next_node_id"] == placeholder["node_id"]
        ]
        outgoing = [
            e for e in original_edges if e["source_node_id"] == placeholder["node_id"]
        ]
        content["edges"] = [
            e for e in original_edges if e not in incoming and e not in outgoing
        ]
        content["edges"] += [{**e, "next_node_id": child_start} for e in incoming]
        content["edges"] += [
            {**e, "source_node_id": mapping[t]} for t in terminals for e in outgoing
        ]
        content["edges"] += [
            {
                **e,
                "source_node_id": mapping[e["source_node_id"]],
                "next_node_id": mapping[e["next_node_id"]],
            }
            for e in child_content.get("edges", [])
        ]
        content["nodes"] = [
            n for n in content["nodes"] if n["node_id"] != placeholder["node_id"]
        ]
        expanded_nodes = []
        for n in child_content["nodes"]:
            metadata = deepcopy(n.get("metadata", {}))
            metadata.setdefault("source_sop_id", source_id)
            metadata.setdefault("source_node_id", n["node_id"])
            metadata.setdefault("nested_sop_path", [*source_path, source_id])
            metadata.setdefault("parent_sop_node_id", placeholder["node_id"])
            metadata.setdefault("slot_scope", "parent_task_frame")
            expanded_nodes.append(
                {**n, "node_id": mapping[n["node_id"]], "metadata": metadata}
            )
        content["nodes"] += expanded_nodes
        if content["start_node_id"] == placeholder["node_id"]:
            content["start_node_id"] = child_start
        if placeholder["node_id"] in content.get("terminal_node_ids", []):
            content["terminal_node_ids"] = [
                t for t in content["terminal_node_ids"] if t != placeholder["node_id"]
            ] + [mapping[t] for t in terminals]
        requirements += [
            CapabilityRequirement(
                r.kind, r.capability_id, r.required, mapping[r.node_id]
            )
            for r in child.capability_requirements
            if r.node_id in mapping
        ]
        requirements += [
            CapabilityRequirement(
                r.kind, r.capability_id, r.required, mapping[n["node_id"]]
            )
            for r in child.capability_requirements
            if r.node_id is None
            for n in child_content["nodes"]
        ]
    content["runtime_expanded"] = True
    for field in ("required_info", "response_rules", "edges", "terminal_node_ids"):
        content.setdefault(field, [])
    requirements = [
        r
        for r in requirements
        if r.node_id is None or r.node_id in {n["node_id"] for n in content["nodes"]}
    ]
    content["capability_requirements"] = [asdict(r) for r in requirements]
    return replace(
        definition, content=content, capability_requirements=tuple(requirements)
    )
