from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
from enum import Enum


class NodeType(str, Enum):
    SECTION = "Section"
    CLAIM = "Claim"
    EVIDENCE = "Evidence"
    CONTEXT = "Context"
    COMPARISON = "Comparison"
    SYNTHESIS = "Synthesis"
    TRANSITION = "Transition"
    REFERENCE = "Reference"
    TABLE = "Table"


class RhetoricalRole(str, Enum):
    CONTAINER = "container"
    CONCLUSION = "conclusion"
    SUB_CONCLUSION = "sub_conclusion"
    PREMISE = "premise"
    EVIDENCE = "evidence"
    BACKGROUND = "background"
    COUNTERPOINT = "counterpoint"
    QUALIFICATION = "qualification"
    TRANSITION = "transition"
    SUMMARY = "summary"
    ILLUSTRATION = "illustration"


class NodeStatus(str, Enum):
    ACTIVE = "active"
    SUPERSEDED = "superseded"
    DEPRECATED = "deprecated"


class StalenessRisk(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


@dataclass
class DataBlock:
    data_id: str
    value: str
    label: str
    data_year: Optional[int] = None
    source_ref: Optional[int] = None


@dataclass
class ChangeLogEntry:
    version: str
    action: str
    delta_id: Optional[str] = None
    timestamp: Optional[str] = None
    description: str = ""
    details: Optional[dict] = None


@dataclass
class OGNode:
    id: str
    type: NodeType
    title: str
    rhetorical_role: RhetoricalRole = RhetoricalRole.EVIDENCE
    content_summary: str = ""
    original_text: str = ""
    data_blocks: list[DataBlock] = field(default_factory=list)
    cited_refs: list[int] = field(default_factory=list)
    temporal_scope: str = ""
    staleness_risk: StalenessRisk = StalenessRisk.MEDIUM
    status: NodeStatus = NodeStatus.ACTIVE
    created_in_version: str = "v1.0"
    last_updated_version: str = "v1.0"
    confidence: float = 1.0
    change_log: list[ChangeLogEntry] = field(default_factory=list)


    level: Optional[int] = None
    line_start: Optional[int] = None
    line_end: Optional[int] = None


    ref_number: Optional[int] = None
    author: str = ""
    url: str = ""
    publish_date: str = ""
    data_year: str = ""
    tier: str = ""
    card_path: str = ""


    table_id: str = ""
    table_schema: list[str] = field(default_factory=list)
    table_data: list[list[str]] = field(default_factory=list)
    table_caption: str = ""



    display_order: Optional[int] = None
    display_title: str = ""

    placement: str = ""
    topic_label: str = ""
    appendix_id: str = ""




    snapshot_version_history: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "type": self.type.value,
            "title": self.title,
            "rhetorical_role": self.rhetorical_role.value,
            "content_summary": self.content_summary,
            "temporal_scope": self.temporal_scope,
            "staleness_risk": self.staleness_risk.value,
            "status": self.status.value,
            "created_in_version": self.created_in_version,
            "last_updated_version": self.last_updated_version,
            "confidence": self.confidence,
            "data_blocks": [vars(db) for db in self.data_blocks],
            "cited_refs": self.cited_refs,
            "change_log": [vars(cl) for cl in self.change_log],
        }
        if self.type == NodeType.SECTION:
            d["level"] = self.level
        if self.type == NodeType.REFERENCE:
            d.update(ref_number=self.ref_number, author=self.author, url=self.url,
                     publish_date=self.publish_date, data_year=self.data_year,
                     tier=self.tier, card_path=self.card_path)
        if self.type == NodeType.TABLE:
            d.update(table_id=self.table_id, table_schema=self.table_schema,
                     table_data=self.table_data, table_caption=self.table_caption,
                     placement=self.placement, topic_label=self.topic_label,
                     appendix_id=self.appendix_id)
        if self.display_order is not None:
            d["display_order"] = self.display_order
        if self.display_title:
            d["display_title"] = self.display_title

        if self.snapshot_version_history:
            d["snapshot_version_history"] = self.snapshot_version_history
        return d

    @classmethod
    def from_dict(cls, d: dict) -> OGNode:
        return cls(
            id=d["id"],
            type=NodeType(d["type"]),
            title=d["title"],
            rhetorical_role=RhetoricalRole(d.get("rhetorical_role", "evidence")),
            content_summary=d.get("content_summary", ""),
            temporal_scope=d.get("temporal_scope", ""),
            staleness_risk=StalenessRisk(d.get("staleness_risk", "medium")),
            status=NodeStatus(d.get("status", "active")),
            created_in_version=d.get("created_in_version", "v1.0"),
            last_updated_version=d.get("last_updated_version", "v1.0"),
            confidence=d.get("confidence", 1.0),
            data_blocks=[DataBlock(**db) for db in d.get("data_blocks", [])],
            cited_refs=d.get("cited_refs", []),
            change_log=[ChangeLogEntry(**cl) for cl in d.get("change_log", [])],
            level=d.get("level"),
            ref_number=d.get("ref_number"),
            author=d.get("author", ""),
            url=d.get("url", ""),
            publish_date=d.get("publish_date", ""),
            data_year=d.get("data_year", ""),
            tier=d.get("tier", ""),
            card_path=d.get("card_path", ""),
            table_id=d.get("table_id", ""),
            table_schema=d.get("table_schema", []),
            table_data=d.get("table_data", []),
            table_caption=d.get("table_caption", ""),
            display_order=d.get("display_order"),
            display_title=d.get("display_title", ""),
            placement=d.get("placement", ""),
            topic_label=d.get("topic_label", ""),
            appendix_id=d.get("appendix_id", ""),
            snapshot_version_history=d.get("snapshot_version_history", {}),
        )
