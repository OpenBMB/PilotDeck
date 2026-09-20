#!/usr/bin/env python3
"""Compare B0 and candidate StaffDeck's native SOP finalizer boundary.

The B0 product has no portable HTTP facade.  This runner therefore invokes the
same native post-reply owner boundary in separate interpreters and leaves the
candidate HTTP projection to the portable owner-contract and Gateway suites.
"""

from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path


BASELINE_ROOT = Path(os.environ.get(
    "STAFFDECK_B0_ROOT", "/tmp/pilotdeck-staffdeck-m0.j4voeS/staffdeck-b0"
))
CANDIDATE_ROOT = Path(os.environ.get(
    "STAFFDECK_CANDIDATE_ROOT", "/Users/a1/Desktop/claw/openbmb/StaffDeck-portable-sop"
))


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "--single":
        print(json.dumps(run_fixture(Path(sys.argv[2])), ensure_ascii=True, sort_keys=True))
        return

    expected = run_isolated(BASELINE_ROOT)
    actual = run_isolated(CANDIDATE_ROOT)
    if os.environ.get("STAFFDECK_SOP_FINALIZER_INJECT_MISMATCH") == "1":
        actual["handoff_routed"]["calls"].reverse()
    if actual != expected:
        raise AssertionError(
            "StaffDeck SOP finalizer B0 differential mismatch\n"
            f"expected={json.dumps(expected, ensure_ascii=True, sort_keys=True)}\n"
            f"actual={json.dumps(actual, ensure_ascii=True, sort_keys=True)}"
        )

    altered = copy.deepcopy(actual)
    altered["handoff_routed"]["calls"].reverse()
    if altered == actual:
        raise AssertionError("Comparator sensitivity fixture did not detect changed finalizer side-effect order")

    print(json.dumps({
        "status": "PASS",
        "baseline": str(BASELINE_ROOT),
        "candidate": str(CANDIDATE_ROOT),
        "cases": list(actual),
        "compared": len(actual),
        "sensitivity": "STAFFDECK_SOP_FINALIZER_INJECT_MISMATCH=1 exits nonzero for changed finalizer side-effect order",
    }, indent=2))


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
    sys.path.insert(0, str(root / "backend" / "src"))
    from app.core.turn_finalizer import TurnFinalizer  # pylint: disable=import-outside-toplevel

    return {
        "handoff_allowed": execute(TurnFinalizer, allows_handoff=True, route_to_handoff=False, decision="handoff_human", should_complete=False),
        "handoff_routed": execute(TurnFinalizer, allows_handoff=False, route_to_handoff=True, decision="handoff_human", should_complete=False),
        "handoff_rejected": execute(TurnFinalizer, allows_handoff=False, route_to_handoff=False, decision="handoff_human", should_complete=False),
        "completed": execute(TurnFinalizer, allows_handoff=False, route_to_handoff=False, decision="continue_active", should_complete=True),
        "continued": execute(TurnFinalizer, allows_handoff=False, route_to_handoff=False, decision="continue_active", should_complete=False),
    }


def execute(finalizer, *, allows_handoff: bool, route_to_handoff: bool, decision: str, should_complete: bool) -> dict[str, object]:
    class Session:
        id = "finalizer-session"
        active_skill_id = "approval"
        active_step_id = "collect"

    class Skill:
        skill_id = "approval"

    class Result:
        handoff = decision == "handoff_human"

    class Decision:
        def __init__(self, value: str):
            self.decision = value

    session = Session()
    calls: list[dict[str, object]] = []
    handoff_enabled = allows_handoff

    def current_step_allows(_skill, _step):
        return handoff_enabled or session.active_step_id == "handoff"

    def route(current_session, _skill):
        if route_to_handoff:
            current_session.active_step_id = "handoff"
            calls.append({"kind": "route", "step": current_session.active_step_id})
            return True
        return False

    def create_handoff(_tenant, current_session, _skill, _result):
        calls.append({"kind": "handoff", "step": current_session.active_step_id})

    def record_event(_tenant, _session_id, event, detail):
        calls.append({"kind": "event", "event": event, "detail": detail})

    def complete(_tenant, current_session, _skill, reason):
        calls.append({"kind": "complete", "reason": reason, "step": current_session.active_step_id})
        current_session.active_skill_id = None

    state = finalizer.finalize(
        "pilotdeck", session, Skill(), Decision(decision), Result(), None,
        current_step_allows_handoff=current_step_allows,
        route_to_handoff_node=route,
        create_handoff=create_handoff,
        record_event=record_event,
        should_complete=lambda *_args: should_complete,
        complete_skill=complete,
    )
    return {
        "state": state,
        "activeSkillId": session.active_skill_id,
        "activeStepId": session.active_step_id,
        "calls": calls,
    }


if __name__ == "__main__":
    main()
