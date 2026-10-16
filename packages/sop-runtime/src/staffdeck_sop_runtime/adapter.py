"""Host-neutral adapter helpers.

Hosts map their own identity, capability execution, and approval systems into
these JSON values before calling the runtime. No StaffDeck object is accepted.
"""
from __future__ import annotations

from typing import Any, Protocol

from staffdeck_sop_core import CapabilityReceipt, SopDefinition


class CapabilityHost(Protocol):
    def authorize(self, kind: str, capability_id: str, node_id: str) -> bool: ...
    def execute(self, kind: str, capability_id: str, node_id: str, input: dict[str, Any]) -> CapabilityReceipt: ...


class ApprovalPort(Protocol):
    def create(self, request: dict[str, Any]) -> dict[str, Any]: ...
    def resume(self, response: dict[str, Any]) -> dict[str, Any]: ...


def definition_from_host(value: dict[str, Any]) -> SopDefinition:
    """Normalize a published host record without retaining its object identity."""
    return SopDefinition.from_value(dict(value))


def receipt_from_host(value: dict[str, Any], *, session_id: str, turn_id: str) -> CapabilityReceipt:
    return CapabilityReceipt(
        capability_id=str(value.get("capability_id") or value.get("capabilityId") or ""),
        operation_id=str(value.get("operation_id") or value.get("operationId") or ""),
        node_id=str(value.get("node_id") or value.get("nodeId") or ""),
        status="succeeded" if value.get("status") == "succeeded" else "failed",
        result=value.get("result") if isinstance(value.get("result"), dict) else None,
        evidence=value.get("evidence") if isinstance(value.get("evidence"), dict) else None,
        session_id=session_id,
        turn_id=turn_id,
    )
