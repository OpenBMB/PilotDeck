"""Versioned JSON contracts; host identity is never part of SOP graph state."""

from dataclasses import dataclass, field
from typing import Any

PROTOCOL = "sop.lifecycle/v3"


@dataclass(frozen=True)
class ResumeInput:
    wait_id: str
    slot_updates: dict[str, Any] = field(default_factory=dict)
    response: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class CapabilityBinding:
    capability_id: str
    kind: str
    host_ref: str


@dataclass(frozen=True)
class ExecutionProfile:
    profile_id: str
    allowed_sop_ids: tuple[str, ...]
    capability_bindings: tuple[CapabilityBinding, ...] = ()
    model_policy: dict[str, Any] = field(default_factory=dict)
    session_policy: dict[str, Any] = field(default_factory=dict)
