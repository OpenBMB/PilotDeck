from staffdeck_sop_core.graph import validate_graph
from staffdeck_sop_core.models import SopDefinition
from staffdeck_sop_core.nesting import expand


def test_subflow_retry_edge_returns_from_each_terminal_to_child_start():
    child = SopDefinition.from_value({
        "skill_id": "child", "version": "1", "start_node_id": "work",
        "nodes": [{"node_id": "work"}, {"node_id": "other"}],
        "terminal_node_ids": ["work", "other"],
    })
    parent = SopDefinition.from_value({
        "skill_id": "parent", "version": "1", "start_node_id": "sub",
        "nodes": [{"node_id": "sub", "type": "subflow", "sub_sop_id": "child"},
                  {"node_id": "done"}], "terminal_node_ids": ["done"],
        "edges": [{"source_node_id": "sub", "next_node_id": "sub", "condition": "retry", "priority": 1},
                  {"source_node_id": "sub", "next_node_id": "done", "condition": "else", "priority": 2}],
    })
    content = expand(parent, {"child": child}).content
    validate_graph(content)
    assert content["start_node_id"] == "sub::child::work"
    for terminal in ["work", "other"]:
        assert {"source_node_id": f"sub::child::{terminal}",
                "next_node_id": "sub::child::work", "condition": "retry", "priority": 1} in content["edges"]
        assert {"source_node_id": f"sub::child::{terminal}",
                "next_node_id": "done", "condition": "else", "priority": 2} in content["edges"]
    assert len(content["edges"]) == 4
