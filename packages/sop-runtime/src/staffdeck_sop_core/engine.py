from __future__ import annotations

import json
from collections.abc import Iterable
from copy import deepcopy
from dataclasses import asdict, is_dataclass
from typing import Any
from uuid import uuid4

from .graph import (
    actions,
    default_next,
    is_terminal,
    node,
    outgoing,
    required_tools,
    start_node,
    validate_graph,
)
from .models import (
    CapabilityReceipt,
    SopDefinition,
    SopState,
    StepProposal,
    TransitionResult,
    WaitRequest,
)
from .validation import SopResultValidator, slot_is_filled


class SopCoreError(ValueError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code, self.details = code, details or {}


def _json_only(value):
    try:
        json.dumps(asdict(value) if is_dataclass(value) else value, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise SopCoreError(
            "SOP_VALUE_INVALID", "Core accepts only JSON serializable values"
        ) from error


def _definition(value: SopDefinition | dict[str, Any]) -> SopDefinition:
    _json_only(value)
    result = (
        value if isinstance(value, SopDefinition) else SopDefinition.from_value(value)
    )
    try:
        validate_graph(result.content)
    except ValueError as error:
        raise SopCoreError("SOP_DEFINITION_INVALID", str(error)) from error
    return result


def _state(value: SopState | dict[str, Any], definition: SopDefinition) -> SopState:
    _json_only(value)
    state = (
        deepcopy(value)
        if isinstance(value, SopState)
        else SopState.from_dict(deepcopy(value))
    )
    if not state.session_id:
        raise SopCoreError("SESSION_ID_REQUIRED", "session_id is required")
    if state.sop_id and state.sop_id != definition.sop_id:
        raise SopCoreError("SOP_SCOPE_MISMATCH", "state belongs to another SOP")
    if state.sop_version != definition.version:
        raise SopCoreError(
            "SOP_VERSION_MISMATCH", "state is pinned to another SOP version"
        )
    if not state.sop_id:
        state.sop_id = definition.sop_id
    if not state.sop_version:
        state.sop_version = definition.version
    return state


def prepare(
    definition: SopDefinition | dict[str, Any], state: SopState | dict[str, Any]
) -> dict[str, Any]:
    definition = _definition(definition)
    current = _state(state, definition)
    if not current.active_node_id:
        current.active_node_id = start_node(definition.content)
    step = node(definition.content, current.active_node_id)
    if step is None:
        raise SopCoreError(
            "SOP_NODE_NOT_FOUND", f"node '{current.active_node_id}' does not exist"
        )
    allowed = outgoing(definition.content, current.active_node_id)
    return {
        "state": current.to_dict(),
        "step": {
            "sopId": definition.sop_id,
            "version": definition.version,
            "nodeId": current.active_node_id,
            "node": step,
            "instruction": str(step.get("instruction") or ""),
            "expectedUserInfo": list(step.get("expected_user_info") or []),
            "allowedNextNodeIds": [str(item.get("next_node_id")) for item in allowed],
            "requiredCapabilityIds": sorted(required_tools(step)),
            "capabilityRequirements": [
                vars(item)
                for item in definition.capability_requirements
                if item.node_id in {None, current.active_node_id}
            ],
            "transitions": [
                {
                    "nextNodeId": edge["next_node_id"],
                    "condition": edge.get("condition", ""),
                    "priority": edge.get("priority", 0),
                    "label": edge.get("label"),
                    "targetNode": node(definition.content, edge["next_node_id"]),
                }
                for edge in allowed
            ],
            "allowedActions": actions(step),
            "isTerminal": is_terminal(definition.content, current.active_node_id),
            "declaresHandoff": str(step.get("type") or "") == "handoff"
            or "handoff_human" in actions(step),
            "subSopId": step.get("sub_sop_id"),
        },
    }


def _receipts(
    value: Iterable[CapabilityReceipt | dict[str, Any]],
) -> list[CapabilityReceipt]:
    result = []
    for item in value:
        result.append(
            item
            if isinstance(item, CapabilityReceipt)
            else CapabilityReceipt(
                capability_id=str(
                    item.get("capability_id") or item.get("capabilityId") or ""
                ),
                operation_id=str(
                    item.get("operation_id") or item.get("operationId") or ""
                ),
                node_id=str(item.get("node_id") or item.get("nodeId") or ""),
                status=str(item.get("status") or "failed"),
                result=item.get("result"),
                evidence=item.get("evidence"),
                session_id=item.get("session_id") or item.get("sessionId"),
                turn_id=item.get("turn_id") or item.get("turnId"),
            )
        )
    return result


def submit(
    definition: SopDefinition | dict[str, Any],
    state: SopState | dict[str, Any],
    proposal: StepProposal | dict[str, Any],
    receipts: Iterable[CapabilityReceipt | dict[str, Any]] = (),
    *,
    turn_id: str | None = None,
) -> TransitionResult:
    _json_only(proposal)
    definition = _definition(definition)
    current = _state(state, definition)
    proposal = (
        proposal
        if isinstance(proposal, StepProposal)
        else StepProposal.from_value(proposal)
    )
    if current.status != "active":
        raise SopCoreError(
            "SOP_STATE_INACTIVE",
            "resume a pending wait before submitting another result",
        )
    step = node(definition.content, current.active_node_id)
    if step is None:
        raise SopCoreError("SOP_NODE_NOT_FOUND", "active node does not exist")
    if not proposal.reply and proposal.status not in {"failed", "blocked"}:
        raise SopCoreError("REPLY_REQUIRED", "SOP results require a reply")
    if proposal.status not in {
        "completed",
        "awaiting_user",
        "handoff",
        "failed",
        "blocked",
        "waiting_external_task",
    }:
        raise SopCoreError("INVALID_STATUS", "SOP result status is invalid")
    if proposal.status == "completed" and (
        str(step.get("type") or "") == "handoff" or "handoff_human" in actions(step)
    ):
        resumed_wait = current.metadata.get("resumed_wait") or {}
        if (
            resumed_wait.get("kind") != "approval"
            or resumed_wait.get("node_id") != current.active_node_id
        ):
            raise SopCoreError(
                "HANDOFF_REQUIRED",
                "human approval must be resumed before completing this node",
            )
    receipts = _receipts(receipts)
    for receipt in receipts:
        _json_only(receipt)
    requirements = [
        item
        for item in definition.capability_requirements
        if item.node_id in {None, current.active_node_id}
    ]
    declared = required_tools(step) | {item.capability_id for item in requirements}
    seen = set()
    consumed = set(current.metadata.get("consumed_receipt_ids", []))
    for receipt in receipts:
        if (
            not receipt.operation_id
            or receipt.operation_id in seen
            or receipt.operation_id in consumed
        ):
            raise SopCoreError(
                "RECEIPT_DUPLICATE", "receipt operation identifiers must be unique"
            )
        seen.add(receipt.operation_id)
        if receipt.capability_id not in declared:
            raise SopCoreError(
                "CAPABILITY_UNDECLARED",
                "receipt capability is not declared on this node",
            )
        if receipt.node_id != str(current.active_node_id):
            raise SopCoreError(
                "RECEIPT_SCOPE_MISMATCH", "capability receipt belongs to another node"
            )
        if receipt.status not in {"succeeded", "failed"}:
            raise SopCoreError(
                "RECEIPT_INVALID", "receipt status must be succeeded or failed"
            )
        if (
            receipt.session_id != current.session_id
            or not receipt.turn_id
            or (turn_id is not None and receipt.turn_id != turn_id)
        ):
            raise SopCoreError(
                "RECEIPT_SCOPE_MISMATCH",
                "capability receipt belongs to another session",
            )
    required = required_tools(step) | {
        item.capability_id for item in requirements if item.required
    }
    missing = SopResultValidator.missing_capabilities(required, receipts)
    if proposal.status == "completed" and missing:
        raise SopCoreError(
            "REQUIRED_CAPABILITY_NOT_INVOKED",
            "required capabilities are missing",
            {"missing": missing},
        )
    expected = [str(item) for item in step.get("expected_user_info") or []]
    slots = {**current.slots, **proposal.slot_updates}
    missing_slots = SopResultValidator.missing_slots(expected, slots)
    if is_terminal(definition.content, current.active_node_id):
        missing_slots = list(
            dict.fromkeys(
                [
                    *missing_slots,
                    *SopResultValidator.missing_slots(
                        definition.content.get("required_info", []), slots
                    ),
                ]
            )
        )
    if proposal.status == "completed" and missing_slots:
        raise SopCoreError(
            "REQUIRED_SLOT_MISSING",
            "required fields are missing",
            {"missing": missing_slots},
        )
    for field in expected:
        if (
            _filled(current.slots.get(field))
            and field in proposal.slot_updates
            and not _filled(proposal.slot_updates[field])
        ):
            raise SopCoreError(
                "REQUIRED_SLOT_ERASURE", "a filled required field cannot be erased"
            )
    allowed = {
        str(item.get("next_node_id"))
        for item in outgoing(definition.content, current.active_node_id)
    }
    next_node = str(proposal.next_node_id).strip() if proposal.next_node_id else None
    if next_node and next_node not in allowed:
        raise SopCoreError(
            "INVALID_TRANSITION", "next node is not an allowed transition"
        )
    current.slots = slots
    if proposal.status == "awaiting_user":
        if next_node:
            raise SopCoreError(
                "AWAITING_USER_CANNOT_ADVANCE", "a waiting node cannot advance"
            )
        if str(step.get("type") or "") == "handoff" or "handoff_human" in actions(step):
            raise SopCoreError(
                "HANDOFF_REQUIRED", "human approval requires an approval wait"
            )
        if not missing_slots and (
            expected or not {"ask_user", "ask_missing"}.intersection(actions(step))
        ):
            raise SopCoreError(
                "STEP_MUST_ADVANCE", "this node has no outstanding user input"
            )
        current.pending_wait = {
            "kind": "user_input",
            "wait_id": str(uuid4()),
            "node_id": current.active_node_id,
            "expected_fields": missing_slots,
        }
        current.status = "awaiting_user"
    elif proposal.status == "handoff":
        if not (
            str(step.get("type") or "") == "handoff" or "handoff_human" in actions(step)
        ):
            raise SopCoreError(
                "HANDOFF_NOT_ALLOWED", "current node does not declare human handoff"
            )
        current.pending_wait = {
            "kind": "approval",
            "wait_id": str(uuid4()),
            "node_id": current.active_node_id,
            "assignee_ref": step.get("assignee_user_id"),
        }
        current.status = "handoff"
    elif proposal.status == "waiting_external_task":
        current.pending_wait = {
            "kind": "external_task",
            "wait_id": str(uuid4()),
            "node_id": current.active_node_id,
        }
        current.status = proposal.status
    elif proposal.status in {"blocked", "failed"}:
        current.status = proposal.status
    else:
        current.slots, current.pending_wait, current.status = slots, None, "active"
        current.metadata.pop("resumed_wait", None)
        target = next_node or default_next(definition.content, current.active_node_id)
        if target is not None:
            current.active_node_id = target
        elif is_terminal(definition.content, current.active_node_id):
            current.status = "completed"
        else:
            raise SopCoreError(
                "NEXT_NODE_REQUIRED",
                "conditional branches require an explicit next node",
            )
    current.metadata["consumed_receipt_ids"] = sorted(consumed | seen)
    return TransitionResult(
        current,
        proposal.reply,
        current.status,
        _wait(current),
        proposal.structured_result,
    )


def resume(state: SopState | dict[str, Any], resume_input: dict[str, Any]) -> SopState:
    _json_only(state)
    _json_only(resume_input)
    from .protocol import ResumeInput

    if isinstance(resume_input, ResumeInput):
        resume_input = {
            **resume_input.response,
            "wait_id": resume_input.wait_id,
            "slot_updates": resume_input.slot_updates,
        }
    current = (
        deepcopy(state)
        if isinstance(state, SopState)
        else SopState.from_dict(deepcopy(state))
    )
    if current.pending_wait is None:
        raise SopCoreError("NO_PENDING_WAIT", "session has no pending wait")
    if resume_input.get("wait_id") != current.pending_wait.get("wait_id"):
        raise SopCoreError(
            "WAIT_SCOPE_MISMATCH", "resume does not belong to the pending wait"
        )
    current.slots.update(
        dict(resume_input.get("slot_updates") or resume_input.get("slotUpdates") or {})
    )
    current.metadata["last_resume"] = deepcopy(resume_input)
    current.metadata["resumed_wait"] = deepcopy(current.pending_wait)
    current.pending_wait = None
    current.status = "active"
    return current


def _wait(state: SopState) -> WaitRequest | None:
    value = state.pending_wait
    if not value:
        return None
    return WaitRequest(
        str(value.get("kind") or "user_input"),
        str(value.get("wait_id")),
        state.session_id,
        state.sop_id,
        str(value.get("node_id")),
        tuple(value.get("expected_fields") or ()),
        value.get("assignee_ref"),
    )


def _filled(value: Any) -> bool:
    return slot_is_filled(value)


class SopCore:
    prepare = staticmethod(prepare)
    submit = staticmethod(submit)
    resume = staticmethod(resume)
