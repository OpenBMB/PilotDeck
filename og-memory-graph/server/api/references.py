from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..db.session import get_db
from ..db import crud
from ..schemas import ReferenceOut, ReferencePatch
from .. import filestore


class RefContentBody(BaseModel):
    content: str

class RefPasteBody(BaseModel):
    content: str
    version: Optional[int] = None
    year:    Optional[int] = None

router = APIRouter(prefix="/clusters/{cluster_id}/references", tags=["references"])

_MODEL_Q = Query(filestore.DEFAULT_MODEL, description="模型名")


def _check_cluster(cluster_id: str, model: str) -> None:
    if filestore.read_cluster_config(cluster_id, model) is None:
        raise HTTPException(404, f"集群 {cluster_id}（模型={model}）不存在")


@router.get("", response_model=list[ReferenceOut])
def list_refs(cluster_id: str, version: Optional[int] = None,
              model: str = _MODEL_Q, db: Session = Depends(get_db)):
    _check_cluster(cluster_id, model)

    fs_files = {
        (item["version"], item["filename"]): item
        for item in filestore.list_ref_files(cluster_id, version, filestore.DEFAULT_MODEL)
    }

    if model != filestore.DEFAULT_MODEL:

        return [
            ReferenceOut(
                id=f"{cluster_id}:{model}:v{v}:{fname}",
                cluster_id=cluster_id,
                version=v,
                filename=fname,
                title=None,
                source_url=None,
                lang="zh",
                word_count=None,
                uploaded_at=None,
            )
            for (v, fname) in fs_files
        ]


    db_refs = {
        (r.version, r.filename): r
        for r in crud.list_references(db, cluster_id, version)
    }
    for (v, fname) in fs_files:
        if (v, fname) not in db_refs:
            text = filestore.read_ref_content(cluster_id, v, fname, filestore.DEFAULT_MODEL) or ""

            wc = len("".join(text.split()))
            ref = crud.create_reference(
                db, cluster_id=cluster_id, version=v,
                filename=fname, word_count=wc,
            )
            db_refs[(v, fname)] = ref

    return [db_refs[k] for k in fs_files if k in db_refs]


@router.post("", response_model=list[ReferenceOut],
             status_code=status.HTTP_201_CREATED)
async def upload_refs(
    cluster_id: str,
    files:      list[UploadFile] = File(...),
    version:    int              = Form(1),
    model:      str              = Form(filestore.DEFAULT_MODEL),
    title:      Optional[str]    = Form(None),
    source_url: Optional[str]    = Form(None),
    db: Session = Depends(get_db),
):
    _check_cluster(cluster_id, model)
    created = []
    for f in files:
        content = await f.read()
        fname = f.filename or filestore.next_ref_filename(cluster_id, version, model)
        if not fname.endswith(".txt"):
            fname = fname.rsplit(".", 1)[0] + ".txt"

        existing = {item["filename"]
                    for item in filestore.list_ref_files(cluster_id, version, model)}
        if fname in existing:
            fname = filestore.next_ref_filename(cluster_id, version, model)

        filestore.save_ref_file(cluster_id, version, fname, content, model)
        wc = len(content.decode("utf-8", errors="replace").split())

        ref = crud.create_reference(
            db, cluster_id=cluster_id, version=version, filename=fname,
            title=title, source_url=source_url, word_count=wc,
        )
        created.append(ref)
    return created


def _resolve_ref_file(cluster_id: str, ref_id: str, model: str,
                      db: Session) -> tuple[int, str]:
    if model != filestore.DEFAULT_MODEL:
        try:
            _, _, ver_str, fname = ref_id.split(":", 3)
            return int(ver_str.lstrip("v")), fname
        except ValueError:
            raise HTTPException(400, "非默认模型请使用 list 返回的复合 ref_id")
    ref = crud.get_reference(db, ref_id)
    if ref is None or ref.cluster_id != cluster_id:
        raise HTTPException(404, "参考文献不存在")
    return ref.version, ref.filename


@router.get("/{ref_id}/content")
def get_ref_content(cluster_id: str, ref_id: str,
                    model: str = _MODEL_Q, db: Session = Depends(get_db)):
    _check_cluster(cluster_id, model)
    v, fname = _resolve_ref_file(cluster_id, ref_id, model, db)
    text = filestore.read_ref_content(cluster_id, v, fname, filestore.DEFAULT_MODEL)
    if text is None:
        raise HTTPException(404, "文件不存在")
    return {"content": text}


@router.put("/{ref_id}/content")
def update_ref_content(cluster_id: str, ref_id: str,
                       body: RefContentBody,
                       model: str = _MODEL_Q, db: Session = Depends(get_db)):
    _check_cluster(cluster_id, model)
    v, fname = _resolve_ref_file(cluster_id, ref_id, model, db)
    filestore.save_ref_file(cluster_id, v, fname,
                            body.content.encode("utf-8"), filestore.DEFAULT_MODEL)
    wc = len("".join(body.content.split()))

    if model == filestore.DEFAULT_MODEL:
        ref = crud.get_reference(db, ref_id)
        if ref:
            ref.word_count = wc
            db.commit()
    return {"ok": True, "word_count": wc}


@router.post("/paste", response_model=ReferenceOut,
             status_code=status.HTTP_201_CREATED)
def paste_ref(cluster_id: str, body: RefPasteBody,
              model: str = _MODEL_Q, db: Session = Depends(get_db)):
    _check_cluster(cluster_id, model)


    target_version: int
    if body.year is not None:
        cfg = filestore.read_cluster_config(cluster_id, model) or {}
        period_ranges = cfg.get("period_year_ranges", {})
        v_str = filestore.assign_version(body.year, period_ranges)
        if v_str is None:
            raise HTTPException(400, f"年份 {body.year} 无法匹配任何期数，请先配置 period_year_ranges")
        target_version = int(v_str.lstrip("v"))
    elif body.version is not None:
        target_version = body.version
    else:
        raise HTTPException(400, "请提供 year（推荐）或 version")

    fname = filestore.next_ref_filename(cluster_id, target_version,
                                        filestore.DEFAULT_MODEL)
    filestore.save_ref_file(cluster_id, target_version, fname,
                            body.content.encode("utf-8"), filestore.DEFAULT_MODEL)
    wc = len("".join(body.content.split()))
    ref = crud.create_reference(
        db, cluster_id=cluster_id, version=target_version,
        filename=fname, word_count=wc,
    )
    return ref


@router.patch("/{ref_id}", response_model=ReferenceOut)
def patch_ref(cluster_id: str, ref_id: str, body: ReferencePatch,
              model: str = _MODEL_Q, db: Session = Depends(get_db)):
    _check_cluster(cluster_id, model)
    ref = crud.update_reference(
        db, ref_id,
        title=body.title, source_url=body.source_url,
        version=body.version, lang=body.lang,
    )
    if ref is None:
        raise HTTPException(404, "参考文献不存在")
    return ref


@router.delete("/{ref_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_ref(cluster_id: str, ref_id: str,
               model: str = _MODEL_Q, db: Session = Depends(get_db)):
    _check_cluster(cluster_id, model)
    ref = crud.get_reference(db, ref_id)
    if ref is None or ref.cluster_id != cluster_id:
        raise HTTPException(404, "参考文献不存在")
    filestore.delete_ref_file(cluster_id, ref.version, ref.filename, model)
    crud.delete_reference(db, ref_id)




class BatchUploadItem(BaseModel):
    filename:       str
    version_assigned: int
    detected_year:  Optional[int]
    word_count:     int
    ok:             bool
    error:          Optional[str] = None


@router.post("/upload-batch", response_model=List[BatchUploadItem],
             status_code=status.HTTP_201_CREATED)
async def upload_batch(
    cluster_id: str,
    files: List[UploadFile] = File(...),
    model: str = _MODEL_Q,
    db: Session = Depends(get_db),
):
    _check_cluster(cluster_id, model)
    cfg = filestore.read_cluster_config(cluster_id, model) or {}
    period_ranges = cfg.get("period_year_ranges", {})

    results: List[BatchUploadItem] = []
    for f in files:
        try:
            content_bytes = await f.read()
            content = content_bytes.decode("utf-8", errors="replace")
            year = filestore.extract_ref_year(content)
            v_str = filestore.assign_version(year, period_ranges) if year else None
            target_v = int(v_str.lstrip("v")) if v_str else 1

            fname = filestore.next_ref_filename(cluster_id, target_v,
                                                filestore.DEFAULT_MODEL)
            if not fname.endswith(".txt"):
                fname = fname.rsplit(".", 1)[0] + ".txt"
            filestore.save_ref_file(cluster_id, target_v, fname,
                                    content_bytes, filestore.DEFAULT_MODEL)
            wc = len("".join(content.split()))
            crud.create_reference(db, cluster_id=cluster_id,
                                  version=target_v, filename=fname, word_count=wc)
            results.append(BatchUploadItem(
                filename=fname, version_assigned=target_v,
                detected_year=year, word_count=wc, ok=True,
            ))
        except Exception as e:
            results.append(BatchUploadItem(
                filename=getattr(f, "filename", "unknown"),
                version_assigned=1, detected_year=None,
                word_count=0, ok=False, error=str(e)[:200],
            ))
    return results




@router.get("/detect-periods")
def detect_periods(cluster_id: str, model: str = _MODEL_Q):
    _check_cluster(cluster_id, model)
    suggested = filestore.detect_periods_from_refs(cluster_id, model)
    return {"suggested": suggested}




class DistributeBody(BaseModel):
    dry_run: bool = True


class DistributeItem(BaseModel):
    filename:      str
    current_v:     str
    target_v:      Optional[str]
    detected_year: Optional[int]
    action:        str


class DistributePlan(BaseModel):
    plan:    List[DistributeItem]
    summary: Dict[str, int]
    dry_run: bool
    executed: bool = False


@router.post("/distribute", response_model=DistributePlan)
def distribute_refs(cluster_id: str, body: DistributeBody,
                    model: str = _MODEL_Q, db: Session = Depends(get_db)):
    _check_cluster(cluster_id, model)
    config = filestore.read_cluster_config(cluster_id, model)
    if config is None:
        raise HTTPException(404, "集群配置不存在")

    period_ranges: Dict[str, Any] = config.get("period_year_ranges", {})
    if not period_ranges:
        raise HTTPException(400, "cluster_config.json 中没有 period_year_ranges，请先配置期数")


    base = filestore.cluster_dir(cluster_id, filestore.DEFAULT_MODEL)
    plan: List[DistributeItem] = []

    for v_dir in sorted(base.glob("reference_texts_v*")):
        v_str = v_dir.name.replace("reference_texts_", "")
        v_num = int(v_str.lstrip("v"))
        for f in sorted(v_dir.glob("*.txt")):
            content = f.read_text(encoding="utf-8", errors="replace")
            year = filestore.extract_ref_year(content)
            target = filestore.assign_version(year, period_ranges)
            if target is None:
                action = "skip"
            elif target == v_str:
                action = "keep"
            else:
                action = "move"
            plan.append(DistributeItem(
                filename=f.name,
                current_v=v_str,
                target_v=target,
                detected_year=year,
                action=action,
            ))

    summary = {
        "move": sum(1 for x in plan if x.action == "move"),
        "keep": sum(1 for x in plan if x.action == "keep"),
        "skip": sum(1 for x in plan if x.action == "skip"),
    }

    if body.dry_run:
        return DistributePlan(plan=plan, summary=summary, dry_run=True)


    for item in plan:
        if item.action != "move" or item.target_v is None:
            continue
        from_v = int(item.current_v.lstrip("v"))
        to_v   = int(item.target_v.lstrip("v"))
        ok = filestore.move_ref_file(cluster_id, from_v, to_v, item.filename)
        if not ok:
            continue

        db_refs = crud.list_references(db, cluster_id)
        for ref in db_refs:
            if ref.filename == item.filename and ref.version == from_v:
                ref.version = to_v
                db.commit()
                break

    return DistributePlan(plan=plan, summary=summary, dry_run=False, executed=True)
