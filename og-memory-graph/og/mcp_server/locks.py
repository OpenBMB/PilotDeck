from __future__ import annotations

import fcntl
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parents[2])))
MANIFESTS_DIR = ROOT / "data" / "pd_manifests"
LOCKS_DIR = ROOT / "data" / "pd_locks"
CLUSTERS_DIR = ROOT / "data" / "clusters"
MANIFESTS_DIR.mkdir(parents=True, exist_ok=True)
LOCKS_DIR.mkdir(parents=True, exist_ok=True)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _manifest_path(cid: str) -> Path:
    return MANIFESTS_DIR / f"{cid}.json"


@contextmanager
def manifest_lock(cid: str):
    lock_path = LOCKS_DIR / f"{cid}.lock"
    fh = open(lock_path, "w", encoding="utf-8")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield fh
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            fh.close()


def _read_manifest(cid: str) -> dict:
    p = _manifest_path(cid)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _write_manifest_atomic(cid: str, data: dict) -> None:
    p = _manifest_path(cid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def _pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def _infer_terminal_status(cid: str, manifest: dict) -> str:
    current_phase = manifest.get("current_phase", 1)
    out_dir = CLUSTERS_DIR / cid / "output"
    if out_dir.exists():

        if (out_dir / f"output_report_v{current_phase}.0_polished7.md").exists() or \
           (out_dir / f"output_report_{current_phase}.0_polished7.md").exists():
            return "done"
        if any(out_dir.glob("output_report_*.md")):
            return "partial"
    return "failed"


def reap_if_dead(cid: str) -> str:
    with manifest_lock(cid):
        m = _read_manifest(cid)
        status = m.get("pipeline_status", "idle")
        if status != "running":
            return status
        pid = m.get("pipeline_pid")
        if _pid_alive(pid):
            return "running"

        inferred = _infer_terminal_status(cid, m)
        m["pipeline_status"] = inferred
        m["pipeline_pid"] = None
        m["last_sync"] = _now_iso()
        _write_manifest_atomic(cid, m)
        return inferred


def is_busy(cid: str) -> bool:
    reap_if_dead(cid)
    with manifest_lock(cid):
        m = _read_manifest(cid)
        if m.get("pipeline_status") != "running":
            return False
        return _pid_alive(m.get("pipeline_pid"))
