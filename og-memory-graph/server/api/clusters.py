from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from ..db.session import get_db
from ..db import crud
from ..schemas import ClusterCreate, ClusterOut, ClusterPatch, ClusterStats
from .. import filestore

router = APIRouter(prefix="/clusters", tags=["clusters"])

_MODEL_Q = Query(filestore.DEFAULT_MODEL, description="模型名，如 deepseek / gpt-4o / gemini / claude / doubao / qwen3 / minimax")


def _build_cluster_out(cluster_id: str, db: Session,
                        model: str = filestore.DEFAULT_MODEL) -> ClusterOut:
    obj    = crud.get_cluster(db, cluster_id)
    config = filestore.read_cluster_config(cluster_id, model) or {}
    stats  = filestore.cluster_stats(cluster_id, model)

    topic  = config.get("topic", obj.topic if obj else "")
    period = config.get("period_year_ranges", {})

    return ClusterOut(
        id=cluster_id,
        model=model,
        topic=topic,
        description=obj.description if obj else None,
        period_year_ranges=period,
        created_at=obj.created_at if obj else None,
        stats=ClusterStats(**stats),
    )


@router.get("", response_model=list[ClusterOut])
def list_clusters(model: str = _MODEL_Q, db: Session = Depends(get_db)):
    ids = filestore.list_cluster_ids(model)
    result = []
    for cid in ids:
        config = filestore.read_cluster_config(cid, model)
        if config and not crud.get_cluster(db, cid):
            crud.upsert_cluster(db, cid, config.get("topic", cid))
        result.append(_build_cluster_out(cid, db, model))
    return result


@router.post("", response_model=ClusterOut, status_code=status.HTTP_201_CREATED)
def create_cluster(body: ClusterCreate, model: str = _MODEL_Q,
                   db: Session = Depends(get_db)):
    if filestore.read_cluster_config(body.id, model) is not None:
        raise HTTPException(409, f"集群 {body.id} 在模型 {model} 下已存在")

    config = {
        "topic":              body.topic,
        "task_year_range":    [1900, 2026],
        "period_year_ranges": body.period_year_ranges,
    }
    filestore.create_cluster_dirs(body.id, model)
    filestore.write_cluster_config(body.id, config, model)
    crud.upsert_cluster(db, body.id, body.topic, body.description)
    return _build_cluster_out(body.id, db, model)


@router.get("/{cluster_id}", response_model=ClusterOut)
def get_cluster(cluster_id: str, model: str = _MODEL_Q,
                db: Session = Depends(get_db)):
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")
    return _build_cluster_out(cluster_id, db, model)


@router.patch("/{cluster_id}", response_model=ClusterOut)
def patch_cluster(cluster_id: str, body: ClusterPatch,
                  model: str = _MODEL_Q, db: Session = Depends(get_db)):
    config = filestore.read_cluster_config(cluster_id, model)
    if config is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")

    if body.topic is not None:
        config["topic"] = body.topic
    if body.period_year_ranges is not None:
        config["period_year_ranges"] = body.period_year_ranges

    filestore.write_cluster_config(cluster_id, config, model)
    crud.upsert_cluster(db, cluster_id, config["topic"], body.description)
    return _build_cluster_out(cluster_id, db, model)


@router.delete("/{cluster_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cluster(cluster_id: str, model: str = _MODEL_Q,
                   db: Session = Depends(get_db)):
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")
    filestore.delete_cluster_dir(cluster_id, model)
    crud.delete_cluster(db, cluster_id)
