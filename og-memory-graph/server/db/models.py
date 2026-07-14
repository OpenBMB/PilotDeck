from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    Column, String, Integer, Text, DateTime, ForeignKey, func
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


def _uuid() -> str:
    return str(uuid.uuid4())


class Cluster(Base):
    __tablename__ = "clusters"

    id          = Column(String, primary_key=True)
    topic       = Column(Text,   nullable=False)
    description = Column(Text,   nullable=True)
    created_at  = Column(DateTime, server_default=func.now())
    updated_at  = Column(DateTime, onupdate=func.now())

    references  = relationship("Reference", back_populates="cluster",
                                cascade="all, delete-orphan")
    tasks       = relationship("Task", back_populates="cluster",
                                cascade="all, delete-orphan")


class Reference(Base):
    __tablename__ = "references"

    id          = Column(String,  primary_key=True, default=_uuid)
    cluster_id  = Column(String,  ForeignKey("clusters.id", ondelete="CASCADE"),
                         nullable=False)
    version     = Column(Integer, nullable=False)
    filename    = Column(String,  nullable=False)
    title       = Column(Text,    nullable=True)
    source_url  = Column(Text,    nullable=True)
    lang        = Column(String(8), default="zh")
    word_count  = Column(Integer, nullable=True)
    uploaded_at = Column(DateTime, server_default=func.now())

    cluster     = relationship("Cluster", back_populates="references")


class Task(Base):
    __tablename__ = "tasks"

    id          = Column(String,  primary_key=True, default=_uuid)
    cluster_id  = Column(String,  ForeignKey("clusters.id", ondelete="SET NULL"),
                         nullable=True)
    type        = Column(String,  nullable=False)
    status      = Column(String,  default="pending")
    config      = Column(Text,    nullable=True)
    log_path    = Column(Text,    nullable=True)
    started_at  = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)

    cluster     = relationship("Cluster", back_populates="tasks")
