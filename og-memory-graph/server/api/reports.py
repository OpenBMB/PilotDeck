from __future__ import annotations

import difflib
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from ..schemas import ReportItem
from .. import filestore


class DiffChunk(BaseModel):
    type: str
    text: str

class ReportDiffResult(BaseModel):
    filename_a: str
    filename_b: str
    left:  list[DiffChunk]
    right: list[DiffChunk]
    stats: dict[str, int]

router = APIRouter(prefix="/clusters/{cluster_id}/reports", tags=["reports"])

_MODEL_Q = Query(filestore.DEFAULT_MODEL, description="模型名")


@router.get("", response_model=list[ReportItem])
def list_reports(cluster_id: str, model: str = _MODEL_Q):
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")
    return filestore.list_reports(cluster_id, model)


@router.get("/{filename}")
def get_report(cluster_id: str, filename: str, model: str = _MODEL_Q):
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")
    content = filestore.read_report(cluster_id, filename, model)
    if content is None:
        raise HTTPException(404, f"报告 {filename} 不存在")
    return PlainTextResponse(content, media_type="text/markdown; charset=utf-8")


@router.get("/{filename_a}/diff/{filename_b}", response_model=ReportDiffResult)
def diff_reports(
    cluster_id: str,
    filename_a: str,
    filename_b: str,
    model: str = _MODEL_Q,
) -> ReportDiffResult:
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id} 不存在")

    content_a = filestore.read_report(cluster_id, filename_a, model)
    content_b = filestore.read_report(cluster_id, filename_b, model)
    if content_a is None:
        raise HTTPException(404, f"报告 {filename_a} 不存在")
    if content_b is None:
        raise HTTPException(404, f"报告 {filename_b} 不存在")


    def split_para(text: str) -> list[str]:
        return [p.strip() for p in text.split("\n\n") if p.strip()]

    paras_a = split_para(content_a)
    paras_b = split_para(content_b)

    left:  list[DiffChunk] = []
    right: list[DiffChunk] = []
    stats = {"del": 0, "ins": 0, "equal": 0}

    matcher = difflib.SequenceMatcher(None, paras_a, paras_b, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for p in paras_a[i1:i2]:
                left.append(DiffChunk(type="equal", text=p))
                right.append(DiffChunk(type="equal", text=p))
                stats["equal"] += 1
        elif tag == "replace":
            for p in paras_a[i1:i2]:
                left.append(DiffChunk(type="del", text=p))
                stats["del"] += 1
            for p in paras_b[j1:j2]:
                right.append(DiffChunk(type="ins", text=p))
                stats["ins"] += 1
        elif tag == "delete":
            for p in paras_a[i1:i2]:
                left.append(DiffChunk(type="del", text=p))
                stats["del"] += 1
        elif tag == "insert":
            for p in paras_b[j1:j2]:
                right.append(DiffChunk(type="ins", text=p))
                stats["ins"] += 1

    return ReportDiffResult(
        filename_a=filename_a,
        filename_b=filename_b,
        left=left,
        right=right,
        stats=stats,
    )


@router.delete("/{filename}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report(cluster_id: str, filename: str, model: str = _MODEL_Q):
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")
    ok = filestore.delete_report(cluster_id, filename, model)
    if not ok:
        raise HTTPException(404, f"报告 {filename} 不存在")
