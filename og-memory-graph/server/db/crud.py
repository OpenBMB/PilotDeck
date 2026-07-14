from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from .models import Cluster, Reference, Task




def get_cluster(db: Session, cluster_id: str) -> Cluster | None:
    return db.query(Cluster).filter(Cluster.id == cluster_id).first()


def list_clusters(db: Session) -> list[Cluster]:
    return db.query(Cluster).order_by(Cluster.id).all()


def upsert_cluster(db: Session, cluster_id: str, topic: str,
                   description: Optional[str] = None) -> Cluster:
    obj = get_cluster(db, cluster_id)
    if obj is None:
        obj = Cluster(id=cluster_id, topic=topic, description=description)
        db.add(obj)
    else:
        obj.topic = topic
        if description is not None:
            obj.description = description
    db.commit()
    db.refresh(obj)
    return obj


def delete_cluster(db: Session, cluster_id: str) -> bool:
    obj = get_cluster(db, cluster_id)
    if obj is None:
        return False
    db.delete(obj)
    db.commit()
    return True




def list_references(db: Session, cluster_id: str,
                    version: Optional[int] = None) -> list[Reference]:
    q = db.query(Reference).filter(Reference.cluster_id == cluster_id)
    if version is not None:
        q = q.filter(Reference.version == version)
    return q.order_by(Reference.version, Reference.filename).all()


def get_reference(db: Session, ref_id: str) -> Reference | None:
    return db.query(Reference).filter(Reference.id == ref_id).first()


def create_reference(db: Session, *, cluster_id: str, version: int,
                     filename: str, title: Optional[str] = None,
                     source_url: Optional[str] = None,
                     word_count: Optional[int] = None,
                     lang: str = "zh") -> Reference:
    obj = Reference(
        cluster_id=cluster_id, version=version, filename=filename,
        title=title, source_url=source_url, word_count=word_count, lang=lang,
    )
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


def update_reference(db: Session, ref_id: str, **kwargs) -> Reference | None:
    obj = get_reference(db, ref_id)
    if obj is None:
        return None
    for k, v in kwargs.items():
        if hasattr(obj, k) and v is not None:
            setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj


def delete_reference(db: Session, ref_id: str) -> bool:
    obj = get_reference(db, ref_id)
    if obj is None:
        return False
    db.delete(obj)
    db.commit()
    return True




def create_task(db: Session, *, cluster_id: Optional[str], type: str,
                config: Optional[str] = None) -> Task:
    obj = Task(cluster_id=cluster_id, type=type, config=config)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


def get_task(db: Session, task_id: str) -> Task | None:
    return db.query(Task).filter(Task.id == task_id).first()


def list_tasks(db: Session, cluster_id: Optional[str] = None,
               limit: int = 50) -> list[Task]:
    q = db.query(Task)
    if cluster_id:
        q = q.filter(Task.cluster_id == cluster_id)
    return q.order_by(Task.started_at.desc().nullsfirst()).limit(limit).all()


def update_task_status(db: Session, task_id: str, status: str,
                       **kwargs) -> Task | None:
    obj = get_task(db, task_id)
    if obj is None:
        return None
    obj.status = status
    for k, v in kwargs.items():
        if hasattr(obj, k):
            setattr(obj, k, v)
    db.commit()
    db.refresh(obj)
    return obj
