from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field




class ClusterCreate(BaseModel):
    id:                 str   = Field(..., pattern=r"^DR-\d+$",
                                      description="如 DR-28")
    topic:              str
    description:        Optional[str] = None
    period_year_ranges: Dict[str, List[int]] = Field(
        default={"v1": [2020, 2024]},
        description="版本 → [起始年, 结束年]",
    )


class ClusterPatch(BaseModel):
    topic:              Optional[str]                      = None
    description:        Optional[str]                      = None
    period_year_ranges: Optional[Dict[str, List[int]]]     = None


class ClusterStats(BaseModel):
    version_count: int
    ref_count:     int
    report_count:  int
    has_graph:     bool


class ClusterOut(BaseModel):
    id:                 str
    model:              str
    topic:              str
    description:        Optional[str]
    period_year_ranges: Dict[str, Any]
    created_at:         Optional[datetime]
    stats:              ClusterStats

    class Config:
        from_attributes = True




class ReferenceOut(BaseModel):
    id:          str
    cluster_id:  str
    version:     int
    filename:    str
    title:       Optional[str]
    source_url:  Optional[str]
    lang:        str
    word_count:  Optional[int]
    uploaded_at: Optional[datetime]

    class Config:
        from_attributes = True


class ReferencePatch(BaseModel):
    title:      Optional[str] = None
    source_url: Optional[str] = None
    version:    Optional[int] = None
    lang:       Optional[str] = None




class GraphVersionItem(BaseModel):
    version: str
    mtime:   float


class GraphVersionsOut(BaseModel):
    cluster_id: str
    versions:   List[str]
    items:      List[GraphVersionItem] = []




class ReportItem(BaseModel):
    filename: str
    size:     int
    mtime:    float




class TaskCreate(BaseModel):
    cluster_id: Optional[str]       = None
    type:       str                 = Field(..., description="run_a / eval_race / …")
    config:     Dict[str, Any]      = Field(default_factory=dict)


class TaskOut(BaseModel):
    id:          str
    cluster_id:  Optional[str]
    type:        str
    status:      str
    config:      Optional[str]
    log_path:    Optional[str]
    started_at:  Optional[datetime]
    finished_at: Optional[datetime]

    class Config:
        from_attributes = True


class TaskLogOut(TaskOut):
    log_tail: List[str] = []




class ConfigField(BaseModel):
    key:      str
    label:    str = ""
    provider: str = ""
    value:    str
    masked:   bool
    editable: bool = True


class ConfigOut(BaseModel):
    fields: List[ConfigField]


class ConfigPatch(BaseModel):
    updates: Dict[str, str]
