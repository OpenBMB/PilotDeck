from __future__ import annotations
from dataclasses import dataclass
from typing import Optional
from enum import Enum


class EdgeType(str, Enum):
    CONTAINS = "contains"
    TRANSITIONS_TO = "transitions_to"
    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    PARALLELS = "parallels"
    DEEPENS = "deepens"
    DERIVES_FROM = "derives_from"
    CONTEXTUALIZES = "contextualizes"
    COMPARED_IN = "compared_in"
    SUPERSEDES = "supersedes"
    CITES = "cites"
    CITED_BY = "cited_by"
    ILLUSTRATED_BY = "illustrated_by"
    TABULATES = "tabulates"


class EdgeStrength(str, Enum):
    STRONG = "strong"
    MODERATE = "moderate"
    WEAK = "weak"


@dataclass
class OGEdge:
    source_id: str
    target_id: str
    type: EdgeType
    strength: EdgeStrength = EdgeStrength.MODERATE
    created_in_version: str = "v1.0"
    notes: str = ""
    confidence: float = 1.0

    def to_dict(self) -> dict:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "type": self.type.value,
            "strength": self.strength.value,
            "created_in_version": self.created_in_version,
            "notes": self.notes,
            "confidence": self.confidence,
        }

    @classmethod
    def from_dict(cls, d: dict) -> OGEdge:
        return cls(
            source_id=d["source_id"],
            target_id=d["target_id"],
            type=EdgeType(d["type"]),
            strength=EdgeStrength(d.get("strength", "moderate")),
            created_in_version=d.get("created_in_version", "v1.0"),
            notes=d.get("notes", ""),
            confidence=d.get("confidence", 1.0),
        )
