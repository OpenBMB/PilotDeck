"""Portable SOP runtime with no StaffDeck backend dependency."""

from staffdeck_sop_core import SopCoreError as SopRuntimeError, prepare, submit, resume

__all__ = ["SopRuntimeError", "prepare", "submit", "resume"]
