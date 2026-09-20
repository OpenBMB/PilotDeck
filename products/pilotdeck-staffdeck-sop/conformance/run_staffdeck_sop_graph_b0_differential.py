#!/usr/bin/env python3
"""Compare StaffDeck's frozen graph rules with the candidate re-export."""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path


BASELINE_ROOT = Path(
    os.environ.get("STAFFDECK_B0_ROOT", "/tmp/pilotdeck-staffdeck-m0.j4voeS/staffdeck-b0")
)
CANDIDATE_ROOT = Path(
    os.environ.get("STAFFDECK_CANDIDATE_ROOT", "/Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop")
)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--single":
        print(json.dumps(run_fixture(Path(sys.argv[2])), ensure_ascii=True, sort_keys=True))
        return

    baseline = run_isolated(BASELINE_ROOT)
    candidate = run_isolated(CANDIDATE_ROOT)
    if candidate != baseline:
        raise AssertionError(
            "StaffDeck SOP graph differential mismatch\n"
            f"expected={json.dumps(baseline, ensure_ascii=True, sort_keys=True)}\n"
            f"actual={json.dumps(candidate, ensure_ascii=True, sort_keys=True)}"
        )

    altered = copy.deepcopy(candidate)
    altered["nextSteps"].reverse()
    if altered == candidate:
        raise AssertionError("Comparator sensitivity fixture did not detect changed SOP edge order")

    print(
        json.dumps(
            {
                "status": "PASS",
                "baseline": str(BASELINE_ROOT),
                "candidate": str(CANDIDATE_ROOT),
                "cases": [
                    "graph-order-and-default-transition",
                    "terminal-slots-and-actions",
                    "slot-value-domain-and-handoff-search",
                ],
                "compared": 3,
            },
            indent=2,
        )
    )


def run_isolated(root: Path) -> dict[str, object]:
    completed = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "--single", str(root)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def run_fixture(root: Path) -> dict[str, object]:
    sys.path.insert(0, str(root / "backend"))
    from app.core.graph_rules import GraphRules  # pylint: disable=import-outside-toplevel

    content = {
        "start_node_id": "start",
        "required_info": ["global"],
        "nodes": [
            {"node_id": "start", "type": "task", "name": "Start", "allowed_actions": ["answer_user"]},
            {"node_id": "review", "type": "task", "name": "Review", "expected_user_info": ["approval"]},
            {"node_id": "handoff", "type": "handoff", "name": "Human review", "allowed_actions": ["handoff_human"]},
            {"node_id": "finish", "type": "task", "name": "Finish", "expected_user_info": ["approval"], "allowed_actions": ["answer_user"]},
        ],
        "edges": [
            {"source_node_id": "start", "next_node_id": "handoff", "priority": 3, "condition": "requires_review"},
            {"source_node_id": "start", "next_node_id": "review", "priority": 1, "condition": "default"},
            {"source_node_id": "start", "next_node_id": "finish", "priority": 2, "condition": "auto"},
            {"source_node_id": "review", "next_node_id": "finish", "priority": 1},
        ],
    }
    step_ids = [step["step_id"] for step in GraphRules.steps(content)]
    next_steps = [step["step_id"] for step in GraphRules.next_steps(content, "start")]
    default = GraphRules.default_next_step(content, "start")
    slot_values = [None, "", "   ", 0, False, [], {}, ["value"], {"value": 1}]
    terminal_missing = GraphRules.terminal_position(content, "finish", {"global": "ready", "approval": ""})
    terminal_filled = GraphRules.terminal_position(content, "finish", {"global": "ready", "approval": "yes"})
    return {
        "ordered": [node["node_id"] for node in GraphRules.ordered_nodes(content)],
        "steps": step_ids,
        "nextSteps": next_steps,
        "defaultNext": default["step_id"] if default else None,
        "edgeConditions": [
            GraphRules.edge_condition(edge)
            for edge in GraphRules.outgoing_edges(content)["start"]
        ],
        "terminalMissing": terminal_missing,
        "terminalFilled": terminal_filled,
        "slotHasValue": [GraphRules.slot_has_value({"value": value}, "value") for value in slot_values],
        "slotSatisfied": [GraphRules.slot_satisfied({"value": value}, " value ") for value in slot_values],
        "actionsAllowFinalReply": GraphRules.actions_allow_final_reply(["answer_user", "call_tool:lookup"]),
        "normalizedPending": GraphRules.normalize_pending_steps(["review", "", "review", 7, "finish"]),
        "handoffFromStart": GraphRules.find_handoff_node_id(content, "start"),
    }


if __name__ == "__main__":
    main()
