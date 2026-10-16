"""Pure SOP lifecycle core.

This package is intentionally independent from StaffDeck, PilotDeck, ORM
models, channels, identity providers, and model/tool implementations.
"""

from .engine import SopCore, SopCoreError, prepare, resume, submit
from .models import (
    CapabilityReceipt,
    CapabilityRequirement,
    SopDefinition,
    SopState,
    StepProposal,
    TransitionResult,
    WaitRequest,
)
from .protocol import CapabilityBinding, ExecutionProfile, ResumeInput
from .validation import SopResultValidator

__all__ = [
    "CapabilityBinding",
    "CapabilityReceipt",
    "CapabilityRequirement",
    "ExecutionProfile",
    "ResumeInput",
    "SopCore",
    "SopCoreError",
    "SopDefinition",
    "SopResultValidator",
    "SopState",
    "StepProposal",
    "TransitionResult",
    "WaitRequest",
    "prepare",
    "resume",
    "submit",
]
