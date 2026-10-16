from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class CapabilityRequirement:
    kind: Literal["tool", "skill", "knowledge"]
    capability_id: str
    required: bool = True
    node_id: str | None = None


@dataclass(frozen=True)
class CapabilityReceipt:
    capability_id: str
    operation_id: str
    node_id: str
    status: Literal["succeeded", "failed"]
    result: dict[str, Any] | None = None
    evidence: dict[str, Any] | None = None
    session_id: str | None = None
    turn_id: str | None = None


@dataclass(frozen=True)
class SopDefinition:
    sop_id: str
    version: str
    name: str
    content: dict[str, Any]
    capability_requirements: tuple[CapabilityRequirement, ...] = ()
    source: str = "runtime"
    published_at: str | None = None
    content_digest: str | None = None

    @classmethod
    def from_value(cls, value: dict[str, Any]) -> SopDefinition:
        if not isinstance(value, dict):
            raise ValueError("SOP definition must be an object")  # noqa: TRY004 - public validation contract
        content = (
            value.get("content")
            if isinstance(value.get("content"), dict)
            else value.get("content_json")
        )
        if not isinstance(content, dict):
            content = value
        raw_requirements = (
            value.get("capability_requirements")
            or content.get("capability_requirements")
            or []
        )
        if not isinstance(raw_requirements, (list, tuple)) or any(
            not isinstance(item, dict) for item in raw_requirements
        ):
            raise ValueError("capability_requirements must be an array of objects")
        requirements = tuple(
            CapabilityRequirement(
                kind=str(item.get("kind")),
                capability_id=str(item.get("capability_id") or item.get("id")),
                required=bool(item.get("required", True)),
                node_id=item.get("node_id"),
            )
            for item in raw_requirements
            if isinstance(item, dict)
            and item.get("kind")
            and item.get("capability_id", item.get("id"))
        )
        for requirement in requirements:
            if requirement.kind not in {"tool", "skill", "knowledge"}:
                raise ValueError("capability kind must be tool, skill or knowledge")
        if len(requirements) != len(raw_requirements):
            raise ValueError("capability requirements need kind and capability_id")
        sop_id = str(
            value.get("sop_id")
            or value.get("skill_id")
            or value.get("id")
            or content.get("skill_id")
            or ""
        ).strip()
        if not sop_id:
            raise ValueError("SOP definition requires sop_id")
        derived = []
        for node in content.get("nodes", []):
            refs = node.get("capability_refs") or {}
            for kind, resource_field in (
                ("tool", "tool_ids"),
                ("skill", "general_skill_ids"),
                ("knowledge", "knowledge_base_ids"),
            ):
                selected = refs.get(resource_field, [])
                required = refs.get("required_" + resource_field, [])
                for capability_id in dict.fromkeys([*selected, *required]):
                    derived.append(
                        CapabilityRequirement(
                            kind,
                            str(capability_id),
                            capability_id in required,
                            node.get("node_id"),
                        )
                    )
            if node.get("type") == "knowledge_query":
                capability = (
                    "knowledge_search"
                    if "call_tool:knowledge_search" in node.get("allowed_actions", [])
                    else "knowledge_query"
                )
                derived.append(
                    CapabilityRequirement(
                        "knowledge", capability, True, node.get("node_id")
                    )
                )
        return cls(
            sop_id,
            str(value.get("version") or content.get("version") or "1.0.0"),
            str(value.get("name") or content.get("name") or sop_id),
            content,
            tuple(dict.fromkeys([*requirements, *derived])),
            str(value.get("source") or "runtime"),
            value.get("published_at"),
            value.get("content_digest"),
        )

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["capability_requirements"] = [
            asdict(item) for item in self.capability_requirements
        ]
        return value


@dataclass
class SopState:
    session_id: str
    sop_id: str
    sop_version: str
    active_node_id: str | None = None
    slots: dict[str, Any] = field(default_factory=dict)
    pending_wait: dict[str, Any] | None = None
    status: str = "active"
    revision: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> SopState:
        return cls(
            session_id=str(value.get("session_id") or value.get("sessionId") or ""),
            sop_id=str(
                value.get("sop_id")
                or value.get("sopId")
                or value.get("selected_skill_id")
                or ""
            ),
            sop_version=str(
                value.get("sop_version")
                or value.get("sopVersion")
                or value.get("version")
                or "1.0.0"
            ),
            active_node_id=value.get("active_node_id") or value.get("active_step_id"),
            slots=dict(value.get("slots") or value.get("slots_json") or {}),
            pending_wait=value.get("pending_wait") or value.get("awaiting_input_json"),
            status=str(value.get("status") or "active"),
            revision=int(value.get("revision") or 0),
            metadata=dict(value.get("metadata") or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "sop_id": self.sop_id,
            "sop_version": self.sop_version,
            "active_node_id": self.active_node_id,
            "slots": self.slots,
            "pending_wait": self.pending_wait,
            "status": self.status,
            "revision": self.revision,
            "metadata": self.metadata,
        }


@dataclass(frozen=True)
class StepProposal:
    status: str
    reply: str
    slot_updates: dict[str, Any] = field(default_factory=dict)
    next_node_id: str | None = None
    structured_result: Any = None
    wait: dict[str, Any] | None = None

    @classmethod
    def from_value(cls, value: dict[str, Any]) -> StepProposal:
        return cls(
            str(value.get("status") or ""),
            str(value.get("reply") or value.get("replyFragment") or ""),
            dict(value.get("slot_updates") or value.get("slotUpdates") or {}),
            value.get("next_node_id") or value.get("nextStepId"),
            value.get("structured_result", value.get("structuredResult")),
            value.get("wait"),
        )


@dataclass(frozen=True)
class WaitRequest:
    kind: Literal["approval", "external_task", "user_input"]
    wait_id: str
    session_id: str
    sop_id: str
    node_id: str
    requested_fields: tuple[str, ...] = ()
    assignee_ref: str | None = None


@dataclass(frozen=True)
class TransitionResult:
    state: SopState
    reply: str = ""
    status: str = "active"
    wait: WaitRequest | None = None
    structured_result: Any = None
