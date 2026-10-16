"""Backward-compatible import path for the independent runtime.

Historically this module imported StaffDeck ORM and Harness classes. The
compatibility path now delegates to the standalone JSON Core instead.
"""

from staffdeck_sop_core import SopCoreError as SopRuntimeError, prepare, submit, resume

__all__ = ["SopRuntimeError", "prepare", "submit", "resume"]
