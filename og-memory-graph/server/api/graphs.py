from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..schemas import GraphVersionsOut
from .. import filestore

router = APIRouter(prefix="/clusters/{cluster_id}/graph", tags=["graph"])

_MODEL_Q = Query(filestore.DEFAULT_MODEL, description="模型名")


@router.get("/versions", response_model=GraphVersionsOut)
def graph_versions(cluster_id: str, model: str = _MODEL_Q):
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")

    versions = filestore.list_og_versions(cluster_id, model)
    items = filestore.list_og_versions_with_mtime(cluster_id, model)
    if not versions:
        versions = filestore.list_graph_versions(cluster_id, model)

        items = [{"version": v, "mtime": 0.0} for v in versions]

    return GraphVersionsOut(cluster_id=cluster_id, versions=versions, items=items)


@router.get("")
def get_graph(
    cluster_id: str,
    version: str = Query("latest", description="如 v1 / v2 / v3 / latest"),
    model:   str = _MODEL_Q,
):
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")


    data = filestore.read_og_graph(cluster_id, version, model)


    if data is None:
        data = filestore.read_graph_json(cluster_id, version, model)

    if data is None:
        raise HTTPException(404, f"集群 {cluster_id} 暂无图谱数据（version={version}, model={model}）")

    nodes_raw = data.get("nodes", [])
    edges_raw = data.get("edges", [])


    if isinstance(nodes_raw, dict):
        nodes = list(nodes_raw.values())
    else:
        nodes = list(nodes_raw)

    return {
        "cluster_id": cluster_id,
        "version":    version,
        "node_count": len(nodes),
        "edge_count": len(edges_raw),
        "nodes":      nodes,
        "edges":      list(edges_raw),
    }
