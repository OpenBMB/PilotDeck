from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional


ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parents[2])))
MANIFESTS_DIR = ROOT / "data" / "pd_manifests"
SNAPSHOTS_DIR = ROOT / "data" / "pd_snapshots"
MANIFESTS_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)




def _sha256(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


def _sanitize_filename(rel_path: str) -> str:
    return rel_path.replace("/", "__").replace("\\", "__")


def _slug(name: str, max_len: int = 20) -> str:
    s = re.sub(r"[^a-z0-9-]", "-", name.lower())
    s = re.sub(r"-+", "-", s).strip("-")
    if not s:

        import hashlib
        s = hashlib.md5(name.encode("utf-8")).hexdigest()[:8]
    return s[:max_len]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")







_NOISE_LINE_PATTERNS = [
    re.compile(r'^\s*updated\s*:\s*\S+\s*$', re.IGNORECASE),
    re.compile(r'^\s*updated_at\s*:\s*\S+\s*$', re.IGNORECASE),
    re.compile(r'^\s*dream_updated_at\s*:\s*\S+\s*$', re.IGNORECASE),
    re.compile(r'^\s*last_modified\s*:\s*\S+\s*$', re.IGNORECASE),
    re.compile(r'^\s*<!--\s*updated.*?-->\s*$', re.IGNORECASE),
    re.compile(r'^\s*_?timestamp\s*:\s*\S+\s*$', re.IGNORECASE),
]


def _strip_noise_lines(text: str) -> str:
    kept = []
    for line in text.splitlines():
        if any(p.match(line) for p in _NOISE_LINE_PATTERNS):
            continue
        kept.append(line)
    return "\n".join(kept)


def _extract_timestamps(text: str) -> dict[str, str]:
    ts: dict[str, str] = {}
    for line in text.splitlines():

        m = re.match(r'^\s*updated\s*:\s*(\S+)\s*$', line, re.IGNORECASE)
        if m:
            ts["updated"] = m.group(1)
            continue
        m = re.match(r'^\s*updated_at\s*:\s*(\S+)\s*$', line, re.IGNORECASE)
        if m:
            ts["updated_at"] = m.group(1)
            continue
        m = re.match(r'^\s*dream_updated_at\s*:\s*(\S+)\s*$', line, re.IGNORECASE)
        if m:
            ts["dream_updated_at"] = m.group(1)
            continue
        m = re.match(r'^\s*last_modified\s*:\s*(\S+)\s*$', line, re.IGNORECASE)
        if m:
            ts["last_modified"] = m.group(1)
    return ts


def _is_noise_only_change(old: str, new: str) -> bool:
    if not old or not new:
        return False

    def normalize(text: str) -> str:
        stripped = _strip_noise_lines(text)

        return re.sub(r'\n\s*\n+', '\n', stripped).strip()
    return normalize(old) == normalize(new) and normalize(old) != ""




class FileChange:
    __slots__ = ("rel_path", "change_type", "new_content", "old_content", "file_type")

    def __init__(
        self,
        rel_path: str,
        change_type: str,
        new_content: str = "",
        old_content: str = "",
        file_type: str = "overwrite",
    ):
        self.rel_path = rel_path
        self.change_type = change_type
        self.new_content = new_content
        self.old_content = old_content
        self.file_type = file_type




class FileTracker:

    def __init__(self, cluster_id: str, memory_path: str, project_name: str, topic: str):
        self.cluster_id = cluster_id
        self.memory_path = Path(memory_path)
        self.project_name = project_name
        self.topic = topic
        self._manifest_path = MANIFESTS_DIR / f"{cluster_id}.json"
        self._snapshot_dir = SNAPSHOTS_DIR / cluster_id
        self._snapshot_dir.mkdir(parents=True, exist_ok=True)
        self._manifest: dict[str, Any] = self._load_manifest()



    def _load_manifest(self) -> dict[str, Any]:
        if self._manifest_path.exists():
            try:
                data = json.loads(self._manifest_path.read_text(encoding="utf-8"))

                data.setdefault("sync_count_since_rebuild", 0)
                data.setdefault("pending_rebuild", False)
                return data
            except (json.JSONDecodeError, OSError):
                pass
        return {
            "cluster_id": self.cluster_id,
            "memory_path": str(self.memory_path),
            "project_name": self.project_name,
            "topic": self.topic,
            "current_phase": 0,
            "last_sync": None,
            "pipeline_status": "idle",
            "pipeline_pid": None,
            "files": {},
            "sync_count_since_rebuild": 0,
            "pending_rebuild": False,
        }

    def save_manifest(self) -> None:
        tmp = self._manifest_path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(self._manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, self._manifest_path)

    @property
    def current_phase(self) -> int:
        return self._manifest.get("current_phase", 0)

    @property
    def is_rebuild_pending(self) -> bool:
        return bool(self._manifest.get("pending_rebuild", False))

    def increment_sync_count(self, threshold: int) -> bool:
        count = int(self._manifest.get("sync_count_since_rebuild", 0)) + 1
        self._manifest["sync_count_since_rebuild"] = count
        pending = count >= threshold
        if pending:
            self._manifest["pending_rebuild"] = True
        self.save_manifest()
        return pending

    def update_pipeline_status(self, status: str, pid: Optional[int] = None) -> None:
        self._manifest["pipeline_status"] = status
        self._manifest["pipeline_pid"] = pid
        self._manifest["last_sync"] = _now_iso()
        self.save_manifest()



    def _guess_file_type(self, rel_path: str, old_content: str, new_content: str) -> str:
        entry = self._manifest["files"].get(rel_path, {})
        if entry.get("file_type"):
            recorded = entry["file_type"]

            if old_content and new_content.startswith(old_content.rstrip()):
                return "append"
            return recorded


        if old_content and new_content.startswith(old_content.rstrip()):
            return "append"


        parts = rel_path.replace("\\", "/").split("/")
        if parts and parts[0].lower() in ("feedback", "trace", "dream"):
            return "append"
        return "overwrite"



    def _snapshot_path(self, rel_path: str) -> Path:
        return self._snapshot_dir / _sanitize_filename(rel_path)

    def _read_snapshot(self, rel_path: str) -> str:
        p = self._snapshot_path(rel_path)
        if p.exists():
            return p.read_text(encoding="utf-8", errors="replace")
        return ""

    def _write_snapshot(self, rel_path: str, content: str) -> None:
        self._snapshot_path(rel_path).write_text(content, encoding="utf-8")



    def detect_changes(self) -> list[FileChange]:
        if not self.memory_path.exists():
            return []

        current_files: dict[str, str] = {}
        for md_file in self.memory_path.rglob("*.md"):
            try:
                rel = md_file.relative_to(self.memory_path).as_posix()
                current_files[rel] = md_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass

        changes: list[FileChange] = []
        manifest_files = self._manifest["files"]


        for rel, new_content in current_files.items():
            new_hash = _sha256(new_content)
            entry = manifest_files.get(rel, {})
            old_hash = entry.get("hash", "")

            if not old_hash:

                changes.append(FileChange(
                    rel_path=rel,
                    change_type="added",
                    new_content=new_content,
                    file_type="append" if self._guess_file_type(rel, "", new_content) == "append" else "overwrite",
                ))
            elif new_hash != old_hash:

                old_content = self._read_snapshot(rel) if entry.get("file_type") == "overwrite" else ""
                if entry.get("file_type") == "append":

                    byte_offset = entry.get("last_byte_offset", 0)
                    try:
                        old_content = new_content.encode("utf-8")[:byte_offset].decode("utf-8", errors="ignore")
                    except Exception:
                        old_content = new_content[:byte_offset]


                if entry.get("file_type") == "overwrite" and _is_noise_only_change(old_content, new_content):
                    continue
                ft = self._guess_file_type(rel, old_content, new_content)
                changes.append(FileChange(
                    rel_path=rel,
                    change_type="modified",
                    new_content=new_content,
                    old_content=old_content,
                    file_type=ft,
                ))


        for rel in manifest_files:
            if rel not in current_files:

                old_content = ""
                ft = manifest_files[rel].get("file_type", "overwrite")
                if ft == "overwrite":
                    old_content = self._read_snapshot(rel)
                changes.append(FileChange(
                    rel_path=rel,
                    change_type="deleted",
                    old_content=old_content,
                    file_type=ft,
                ))

        return changes

    def update_manifest_after_sync(self, changes: list[FileChange], new_phase: int) -> None:
        if not changes:
            return

        current_files: dict[str, str] = {}
        for md_file in self.memory_path.rglob("*.md"):
            try:
                rel = md_file.relative_to(self.memory_path).as_posix()
                current_files[rel] = md_file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                pass

        manifest_files = self._manifest["files"]
        for ch in changes:
            if ch.change_type == "deleted":
                manifest_files.pop(ch.rel_path, None)
                snap = self._snapshot_path(ch.rel_path)
                snap.unlink(missing_ok=True)
                continue

            content = current_files.get(ch.rel_path, "")
            entry = manifest_files.get(ch.rel_path, {})
            entry["hash"] = _sha256(content)
            entry["file_type"] = ch.file_type
            entry.setdefault("phase_first_seen", new_phase)
            entry["phase_last_modified"] = new_phase

            if ch.file_type == "append":
                entry["last_byte_offset"] = len(content.encode("utf-8"))
            else:

                self._write_snapshot(ch.rel_path, content)

            manifest_files[ch.rel_path] = entry

        self._manifest["current_phase"] = new_phase
        self._manifest["last_sync"] = _now_iso()
        self.save_manifest()



    def generate_delta_doc(self, changes: list[FileChange]) -> str:
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        today = _today()
        parts = [f"# OG 同步增量 — {ts}\n"]
        parts.append(f"项目：{self.project_name}\n")

        added = [c for c in changes if c.change_type == "added"]
        modified = [c for c in changes if c.change_type == "modified"]
        deleted = [c for c in changes if c.change_type == "deleted"]

        if added:
            parts.append("\n## 新增内容\n")
            for ch in added:
                parts.append(f"\n### {ch.rel_path}\n")
                parts.append(ch.new_content.strip())
                parts.append("\n")

        if modified:
            parts.append("\n## 修改内容\n")
            for ch in modified:
                parts.append(f"\n### {ch.rel_path}\n")
                if ch.file_type == "append":

                    new_part = ch.new_content[len(ch.old_content):].strip() if ch.old_content else ch.new_content.strip()
                    parts.append("**新增段落：**\n\n")
                    parts.append(new_part)
                    parts.append("\n")
                else:

                    old_lines = ch.old_content.splitlines(keepends=True)
                    new_lines = ch.new_content.splitlines(keepends=True)
                    diff = list(difflib.unified_diff(
                        old_lines, new_lines,
                        fromfile=f"{ch.rel_path} (旧版本)",
                        tofile=f"{ch.rel_path} (新版本)",
                        n=3,
                    ))
                    if diff:
                        parts.append("```diff\n")
                        parts.extend(diff[:200])
                        parts.append("```\n")
                    else:
                        parts.append(ch.new_content.strip())
                        parts.append("\n")

        if deleted:
            parts.append("\n## 删除内容（记忆文件移除 — 需废弃对应图谱节点）\n")
            parts.append("以下记忆文件已从记忆中移除。OG 图谱中【源自这些文件内容】的节点")
            parts.append("已不再成立，必须用 DELETE 操作将其标为 deprecated，")
            parts.append("不得新建描述“移除事件”的节点。\n\n")
            for ch in deleted:
                parts.append(f"### 已删除文件: `{ch.rel_path}`\n")

                import re as _re
                fname = ch.rel_path.split("/")[-1]

                topic = _re.sub(r"-[0-9a-f]{8,10}\.md$", "", fname)
                topic = _re.sub(r"\.md$", "", topic)
                parts.append(f"- 主题词: {topic} (图谱节点 title/摘要含此主题或该文件内容的，应 DELETE)\n")

                if ch.old_content:
                    old_summary = ch.old_content.strip()[:300]
                    parts.append(f"- 旧内容摘要:\n```\n{old_summary}\n```\n")
                parts.append("\n")


        parts.append(f"\n来源: PilotDeck Memory Delta — {self.project_name}\n")
        parts.append(f"search_date: {today}\n")
        parts.append("data_year: 2026\n")

        return "".join(parts)



    def generate_initial_refs(self) -> dict[str, str]:
        if not self.memory_path.exists():
            return {}

        refs: dict[str, str] = {}
        today = _today()
        idx = 1
        for md_file in sorted(self.memory_path.rglob("*.md")):
            try:
                rel = md_file.relative_to(self.memory_path).as_posix()
                raw = md_file.read_text(encoding="utf-8", errors="replace").strip()
                if not raw:
                    continue
                content = (
                    f"{raw}\n\n"
                    f"来源: PilotDeck Memory — {rel}\n"
                    f"search_date: {today}\n"
                    f"data_year: 2026\n"
                )
                fname = f"ref_{idx:03d}.txt"
                refs[fname] = content
                idx += 1
            except OSError:
                pass
        return refs



    def init_manifest_from_scan(self) -> None:
        if not self.memory_path.exists():
            return
        manifest_files = self._manifest["files"]
        for md_file in self.memory_path.rglob("*.md"):
            try:
                rel = md_file.relative_to(self.memory_path).as_posix()
                content = md_file.read_text(encoding="utf-8", errors="replace")
                parts_path = rel.replace("\\", "/").split("/")
                ft = "append" if parts_path and parts_path[0].lower() in ("feedback", "trace", "dream") else "overwrite"
                entry = {
                    "hash": _sha256(content),
                    "file_type": ft,
                    "phase_first_seen": 1,
                    "phase_last_modified": 1,
                }
                if ft == "append":
                    entry["last_byte_offset"] = len(content.encode("utf-8"))
                else:
                    self._write_snapshot(rel, content)
                manifest_files[rel] = entry
            except OSError:
                pass
        self._manifest["current_phase"] = 1
        self._manifest["last_sync"] = _now_iso()
        self.save_manifest()




class WatcherManager:

    def __init__(self, poll_interval_seconds: int = 60):
        self._trackers: dict[str, FileTracker] = {}
        self._callbacks: dict[str, Callable] = {}
        self._poll_interval = poll_interval_seconds
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def register(
        self,
        cluster_id: str,
        tracker: FileTracker,
        on_change: Optional[Callable] = None,
    ) -> None:
        self._trackers[cluster_id] = tracker
        if on_change:
            self._callbacks[cluster_id] = on_change

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="og-watcher")
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def _loop(self) -> None:
        while not self._stop_event.wait(self._poll_interval):
            for cluster_id, tracker in list(self._trackers.items()):
                try:
                    changes = tracker.detect_changes()
                    if changes:
                        cb = self._callbacks.get(cluster_id)
                        if cb:
                            cb(cluster_id, changes)
                except Exception as exc:
                    print(f"[watcher] {cluster_id} error: {exc}", flush=True)



manager = WatcherManager()
