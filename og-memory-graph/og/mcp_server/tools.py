from __future__ import annotations

import json
import os
import re
import hashlib
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .watcher import FileTracker, manager as watcher_manager
from .locks import is_busy, reap_if_dead


ROOT = Path(os.environ.get("V5_ROOT", str(Path(__file__).resolve().parents[2])))
CLUSTERS_DIR = ROOT / "data" / "clusters"
LOGS_DIR = ROOT / "logs"
LOGS_DIR.mkdir(exist_ok=True)


_running_procs: dict[str, subprocess.Popen] = {}


REBUILD_SYNC_THRESHOLD = 5




def _make_cluster_id(workspace_path: str) -> str:
    return f"pd-{hashlib.md5(workspace_path.encode('utf-8')).hexdigest()[:8]}"


def _cluster_dir(cluster_id: str) -> Path:
    return CLUSTERS_DIR / cluster_id


def _cluster_config_path(cluster_id: str) -> Path:
    return _cluster_dir(cluster_id) / "cluster_config.json"


def _read_cluster_config(cluster_id: str) -> dict:
    p = _cluster_config_path(cluster_id)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def _write_cluster_config(cluster_id: str, cfg: dict) -> None:
    p = _cluster_config_path(cluster_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def _refs_dir(cluster_id: str, phase: int) -> Path:
    d = _cluster_dir(cluster_id) / f"reference_texts_v{phase}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _output_dir(cluster_id: str) -> Path:
    d = _cluster_dir(cluster_id) / "output"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _log_path(cluster_id: str, tag: str = "") -> Path:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    name = f"pd_{cluster_id}_{tag}_{ts}.log" if tag else f"pd_{cluster_id}_{ts}.log"
    return LOGS_DIR / name


def _is_proc_running(cluster_id: str) -> bool:
    proc = _running_procs.get(cluster_id)
    if proc is None:
        return False
    return proc.poll() is None


def _proc_returncode(cluster_id: str) -> Optional[int]:
    proc = _running_procs.get(cluster_id)
    if proc is None:
        return None
    return proc.poll()


def _reload_manifest(manifest_path: Path, fallback: dict) -> dict:
    try:
        return json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def _trigger_pipeline(cluster_id: str, flags: list[str], log_path: Path) -> subprocess.Popen:
    cmd = [
        sys.executable, "-m", "og", "run", "a",
        "--cluster", cluster_id,
        "--model", "deepseek-v4-pro",
        "--auto-extract",
    ] + flags
    log_f = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        cmd,
        stdout=log_f,
        stderr=log_f,
        cwd=str(ROOT),
        env={**os.environ, "V5_ROOT": str(ROOT)},
    )
    _running_procs[cluster_id] = proc
    return proc


def _add_phase_to_config(cluster_id: str, new_phase: int) -> None:
    cfg = _read_cluster_config(cluster_id)
    prs = cfg.setdefault("period_year_ranges", {})
    prs[f"v{new_phase}"] = [2026, 2026]
    _write_cluster_config(cluster_id, cfg)


def rebuild_watchers_from_clusters() -> int:
    if not CLUSTERS_DIR.exists():
        return 0
    count = 0
    for cfg_path in CLUSTERS_DIR.glob("pd-*/cluster_config.json"):
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        pd_meta = cfg.get("_pilotdeck", {})
        memory_path = pd_meta.get("memory_path", "")
        project_name = pd_meta.get("project_name", cfg_path.parent.name)
        topic = cfg.get("topic", cfg_path.parent.name)
        cluster_id = cfg_path.parent.name
        if not memory_path:
            continue
        try:
            tracker = FileTracker(cluster_id, memory_path, project_name, topic)

            def _on_change(cid: str, _changes: list) -> None:
                sync_changes(cid)
            watcher_manager.register(cluster_id, tracker, on_change=_on_change)
            count += 1
        except Exception as exc:
            print(f"[watcher-rebuild] {cluster_id} 注册失败: {exc}", flush=True)
    if count:
        watcher_manager.start()
        print(f"[watcher-rebuild] 已注册 {count} 个 cluster 的 60s 轮询同步", flush=True)
    return count




def init_project(
    memory_path: str,
    project_name: str,
    description: str = "",
    pipeline_flags: Optional[list] = None,
    cluster_id_override: Optional[str] = None,
    workspace_path: Optional[str] = None,
) -> dict[str, Any]:
    if pipeline_flags is None:
        pipeline_flags = ["--curation", "--rewrite", "--balanced", "--polish"]


    if cluster_id_override:
        cluster_id = cluster_id_override
    elif workspace_path:
        cluster_id = _make_cluster_id(workspace_path)
    else:
        cluster_id = _make_cluster_id(project_name)
    topic = project_name + (f" — {description}" if description else "")


    if is_busy(cluster_id):
        return {
            "cluster_id": cluster_id,
            "status": "already_running",
            "message": "Pipeline 正在运行，请稍后用 get_status 查询进度。",
        }


    cfg = {
        "_doc": f"PilotDeck project: {project_name}",
        "topic": topic,
        "task_year_range": [2026, 2026],
        "period_year_ranges": {"v1": [2026, 2026]},
        "_pilotdeck": {
            "memory_path": memory_path,
            "project_name": project_name,
        },
    }
    _write_cluster_config(cluster_id, cfg)


    tracker = FileTracker(cluster_id, memory_path, project_name, topic)
    refs = tracker.generate_initial_refs()

    refs_dir = _refs_dir(cluster_id, 1)
    if refs:
        for fname, content in refs.items():
            (refs_dir / fname).write_text(content, encoding="utf-8")
    else:

        placeholder = (
            f"# {project_name}\n\n{description or '项目初始化中，暂无记忆内容。'}\n\n"
            f"来源: PilotDeck Memory — 占位\n"
            f"search_date: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}\n"
            f"data_year: 2026\n"
        )
        (refs_dir / "ref_001.md").write_text(placeholder, encoding="utf-8")


    def _on_change(cid: str, changes: list) -> None:
        sync_changes(cid)

    watcher_manager.register(cluster_id, tracker, on_change=_on_change)


    log_p = _log_path(cluster_id, "init")
    proc = _trigger_pipeline(cluster_id, pipeline_flags, log_p)
    tracker.update_pipeline_status("running", proc.pid)


    tracker.init_manifest_from_scan()

    return {
        "cluster_id": cluster_id,
        "status": "started",
        "message": (
            f"已创建 cluster '{cluster_id}'，写入 {len(refs)} 个参考文献，"
            f"pipeline 已在后台启动（PID {proc.pid}）。"
            f"用 get_status('{cluster_id}') 查询进度。"
        ),
        "log_path": str(log_p),
        "refs_count": len(refs),
    }


def sync_changes(cluster_id: str) -> dict[str, Any]:

    if is_busy(cluster_id):
        return {
            "cluster_id": cluster_id,
            "status": "pipeline_running",
            "message": "Pipeline 仍在运行，本次 sync 跳过。",
        }

    cfg = _read_cluster_config(cluster_id)
    if not cfg:
        return {"cluster_id": cluster_id, "status": "error", "message": "Cluster 不存在，请先调用 init_project。"}





    memory_path_pd = cfg.get("_pilotdeck", {}).get("memory_path", "")
    project_name_pd = cfg.get("_pilotdeck", {}).get("project_name", cluster_id)
    topic_pd = cfg.get("topic", cluster_id)
    _tracker_probe = FileTracker(cluster_id, memory_path_pd, project_name_pd, topic_pd)
    if _tracker_probe.is_rebuild_pending:
        _tracker_probe.update_pipeline_status("idle")
        result = rebuild_project(cluster_id)
        return {
            "cluster_id": cluster_id,
            "status": "rebuild_started",
            "message": f"已达 {REBUILD_SYNC_THRESHOLD} 次实质性同步，触发全量重建。" + result.get("message", ""),
            "refs_count": result.get("refs_count"),
            "log_path": result.get("log_path"),
        }

    memory_path = cfg.get("_pilotdeck", {}).get("memory_path", "")
    project_name = cfg.get("_pilotdeck", {}).get("project_name", cluster_id)
    topic = cfg.get("topic", cluster_id)

    tracker = FileTracker(cluster_id, memory_path, project_name, topic)
    changes = tracker.detect_changes()

    if not changes:
        tracker.update_pipeline_status("idle")
        return {
            "cluster_id": cluster_id,
            "status": "no_changes",
            "message": "没有检测到文件变化，无需更新。",
            "changed_files": [],
        }



    def _has_substantive_content(change_list) -> bool:
        from .watcher import _strip_noise_lines
        for ch in change_list:
            if ch.change_type == "added":
                if ch.new_content.strip():
                    return True
            elif ch.change_type == "modified":
                if ch.file_type == "append":

                    new_part = ch.new_content[len(ch.old_content):].strip() if ch.old_content else ch.new_content.strip()

                    if _strip_noise_lines(new_part).strip():
                        return True
                else:

                    if _strip_noise_lines(ch.new_content).strip() != _strip_noise_lines(ch.old_content).strip():
                        return True
            elif ch.change_type == "deleted":
                return True
        return False

    if not _has_substantive_content(changes):

        tracker.update_manifest_after_sync(changes, tracker.current_phase + 1)
        tracker.update_pipeline_status("idle")
        return {
            "cluster_id": cluster_id,
            "status": "no_changes",
            "message": "检测到的变化均为元信息（时间戳/空白），无实质内容更新。",
            "changed_files": [{"path": c.rel_path, "type": c.change_type} for c in changes],
        }


    new_phase = tracker.current_phase + 1


    delta_doc = tracker.generate_delta_doc(changes)
    refs_dir = _refs_dir(cluster_id, new_phase)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    delta_path = refs_dir / f"delta_{ts}.txt"
    delta_path.write_text(delta_doc, encoding="utf-8")


    _add_phase_to_config(cluster_id, new_phase)


    tracker.update_manifest_after_sync(changes, new_phase)


    flags = ["--curation", "--rewrite", "--balanced", "--polish"]
    log_p = _log_path(cluster_id, f"sync_v{new_phase}")
    proc = _trigger_pipeline(cluster_id, flags, log_p)
    tracker.update_pipeline_status("running", proc.pid)


    now_pending = tracker.increment_sync_count(REBUILD_SYNC_THRESHOLD)

    changed_files = [{"path": c.rel_path, "type": c.change_type} for c in changes]
    pending_note = (
        f"（已达 {REBUILD_SYNC_THRESHOLD} 次同步阈值，下一次 sync 将触发全量重建。）"
        if now_pending else ""
    )
    return {
        "cluster_id": cluster_id,
        "status": "started",
        "new_phase": new_phase,
        "changed_files": changed_files,
        "delta_file": str(delta_path.relative_to(ROOT)),
        "message": (
            f"检测到 {len(changes)} 个文件变化，新增 phase v{new_phase}，"
            f"增量 pipeline 已启动（PID {proc.pid}）。{pending_note}"
        ),
        "log_path": str(log_p),
        "rebuild_pending": now_pending,
    }


def rebuild_project(cluster_id: str) -> dict[str, Any]:
    cfg = _read_cluster_config(cluster_id)
    if not cfg:
        return {"cluster_id": cluster_id, "status": "error",
                "message": "Cluster 不存在，请先调用 init_project。"}


    if is_busy(cluster_id):
        return {"cluster_id": cluster_id, "status": "already_running",
                "message": "Pipeline 正在运行，请稍后用 get_status 查询进度后再 rebuild。"}

    memory_path = cfg.get("_pilotdeck", {}).get("memory_path", "")
    project_name = cfg.get("_pilotdeck", {}).get("project_name", cluster_id)
    description = ""
    if " — " in (cfg.get("topic", "")):
        description = cfg["topic"].split(" — ", 1)[1]


    from .watcher import MANIFESTS_DIR, SNAPSHOTS_DIR
    paths_to_clean = [
        _cluster_dir(cluster_id),
        ROOT / "data" / "intermediates" / "og" / cluster_id,
        ROOT / "data" / "intermediates" / "run_cluster" / cluster_id,
        ROOT / "data" / "intermediates" / "balanced_rewrite_v1" / cluster_id,
        MANIFESTS_DIR / f"{cluster_id}.json",
        SNAPSHOTS_DIR / cluster_id,
        ROOT / "outputs" / "polish_diagnostics" / cluster_id,
    ]
    for p in paths_to_clean:
        if not p.exists():
            continue


        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            try:
                p.unlink()
            except OSError:
                pass


    try:
        import chromadb
        client = chromadb.PersistentClient(path=str(ROOT / "data" / "chroma"))
        for col in client.list_collections():
            if cluster_id.lower().replace("-", "_") in col.name.lower() \
                    or cluster_id.lower() in col.name.lower():
                client.delete_collection(col.name)
    except Exception as e:
        print(f"[rebuild] 清 vector DB 警告: {e}")


    cfg["period_year_ranges"] = {"v1": [2026, 2026]}
    _write_cluster_config(cluster_id, cfg)


    from .watcher import FileTracker
    tracker = FileTracker(cluster_id, memory_path, project_name, cfg.get("topic", cluster_id))
    refs = tracker.generate_initial_refs()
    refs_dir = _refs_dir(cluster_id, 1)
    if refs:
        for fname, content in refs.items():
            (refs_dir / fname).write_text(content, encoding="utf-8")
    else:
        placeholder = (
            f"# {project_name}\n\n{description or '项目重建中，暂无记忆内容。'}\n\n"
            f"来源: PilotDeck Memory — 占位\n"
            f"search_date: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}\n"
            f"data_year: 2026\n"
        )
        (refs_dir / "ref_001.md").write_text(placeholder, encoding="utf-8")


    tracker.init_manifest_from_scan()
    tracker.update_pipeline_status("idle")


    flags = ["--curation", "--rewrite", "--balanced", "--polish"]
    log_p = _log_path(cluster_id, "rebuild")

    proc = _trigger_pipeline(cluster_id, flags + ["--clean"], log_p)
    tracker.update_pipeline_status("running", proc.pid)

    return {
        "cluster_id": cluster_id,
        "status": "started",
        "message": (
            f"已清空历史产物并用当前 memory 重新全量 build (PID {proc.pid})。"
            f"写入 {len(refs)} 个参考文献。用 get_status('{cluster_id}') 查询进度。"
        ),
        "refs_count": len(refs),
        "log_path": str(log_p),
    }


def get_status(cluster_id: str) -> dict[str, Any]:
    cfg = _read_cluster_config(cluster_id)
    if not cfg:
        return {"cluster_id": cluster_id, "status": "not_found", "message": "Cluster 不存在。"}


    from .watcher import MANIFESTS_DIR
    manifest_path = MANIFESTS_DIR / f"{cluster_id}.json"
    manifest: dict = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass




    running = _is_proc_running(cluster_id)
    rc = _proc_returncode(cluster_id)
    out_dir = _output_dir(cluster_id)

    if running:
        pipeline_status = "running"
    elif rc == 0:
        pipeline_status = "done"

        reap_if_dead(cluster_id)
        manifest = _reload_manifest(manifest_path, manifest)
    elif rc is not None:
        pipeline_status = f"failed (code={rc})"
    else:

        pipeline_status = reap_if_dead(cluster_id)
        manifest = _reload_manifest(manifest_path, manifest)


    reports = []
    if out_dir.exists():
        reports = sorted(
            f.name for f in out_dir.iterdir()
            if f.suffix in (".md", ".json") and not f.name.startswith("_")
        )

    return {
        "cluster_id": cluster_id,
        "pipeline_status": pipeline_status,
        "current_phase": manifest.get("current_phase", 0),
        "last_sync": manifest.get("last_sync"),
        "tracked_files": len(manifest.get("files", {})),
        "output_files": reports,
        "topic": cfg.get("topic", ""),
        "memory_path": cfg.get("_pilotdeck", {}).get("memory_path", ""),
    }


def get_graph_summary(cluster_id: str) -> dict[str, Any]:
    cluster_dir = _cluster_dir(cluster_id)
    if not cluster_dir.exists():
        return {"cluster_id": cluster_id, "error": "Cluster 不存在。"}


    og_files = sorted(cluster_dir.glob(f"og_{cluster_id}_*.json"))
    if not og_files:
        return {"cluster_id": cluster_id, "error": "图谱 JSON 尚未生成，请先运行 init_project 或 sync_changes。"}

    latest = og_files[-1]
    try:
        data = json.loads(latest.read_text(encoding="utf-8"))
    except Exception as e:
        return {"cluster_id": cluster_id, "error": f"读取图谱失败：{e}"}

    nodes = data.get("nodes", [])
    edges = data.get("edges", [])


    type_count: dict[str, int] = {}
    for n in nodes:
        t = n.get("type", "Unknown")
        type_count[t] = type_count.get(t, 0) + 1


    sections = [
        {"id": n.get("id"), "title": n.get("title", ""), "summary": n.get("summary", "")[:120]}
        for n in nodes if n.get("type") == "Section"
    ][:15]

    return {
        "cluster_id": cluster_id,
        "version": data.get("version", latest.stem.split("_")[-1]),
        "graph_file": latest.name,
        "total_nodes": len(nodes),
        "total_edges": len(edges),
        "node_types": type_count,
        "edge_types": _count_types(edges, "type"),
        "top_sections": sections,
    }


def _count_types(items: list, key: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        t = item.get(key, "unknown")
        counts[t] = counts.get(t, 0) + 1
    return counts


def get_report(cluster_id: str, variant: str = "polished7") -> str:
    out_dir = _output_dir(cluster_id)
    if not out_dir.exists():
        return f"[错误] Cluster '{cluster_id}' 的输出目录不存在，请先运行 init_project。"


    pattern = re.compile(rf"output_report_.*_{re.escape(variant)}\.md$")
    candidates = sorted(
        [f for f in out_dir.iterdir() if pattern.search(f.name)],
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )

    if not candidates:

        available = [f.name for f in out_dir.glob("output_report_*.md")]
        return (
            f"[错误] 未找到变体 '{variant}' 的报告。\n"
            f"可用报告：{', '.join(available) if available else '暂无'}"
        )

    return candidates[0].read_text(encoding="utf-8", errors="replace")




TOOL_DEFS = [
    {
        "name": "init_project",
        "description": (
            "为 PilotDeck 项目创建 og 知识图谱 cluster 并启动初次全量 build。"
            "首次使用时调用。pipeline 在后台运行，用 get_status 轮询进度。"
        ),
        "inputSchema": {
            "type": "object",
            "required": ["memory_path", "project_name", "workspace_path"],
            "properties": {
                "memory_path": {
                    "type": "string",
                    "description": "PilotDeck project memory 目录的绝对路径（已解析，用于扫描 .md 记忆文件）",
                },
                "project_name": {
                    "type": "string",
                    "description": "项目名称，用于 topic 显示",
                },
                "workspace_path": {
                    "type": "string",
                    "description": "PilotDeck project 根路径，用于派生 cluster_id（pd-<md5(workspace_path)[:8]>）",
                },
                "description": {
                    "type": "string",
                    "description": "项目描述（可选，追加到 topic）",
                    "default": "",
                },
            },
        },
        "handler": init_project,
    },
    {
        "name": "sync_changes",
        "description": (
            "检测 PilotDeck 项目记忆文件的变化（新增/修改/删除），"
            "生成 delta 文档并触发增量 og pipeline 更新。"
            "定期调用以保持图谱和报告最新。"
        ),
        "inputSchema": {
            "type": "object",
            "required": ["cluster_id"],
            "properties": {
                "cluster_id": {
                    "type": "string",
                    "description": "og cluster ID，格式为 'pd-<md5(workspace_path)[:8]>'",
                },
            },
        },
        "handler": sync_changes,
    },
    {
        "name": "rebuild_project",
        "description": (
            "用当前 memory 文件全量重建 cluster —— 清空该 cluster 所有历史产物"
            "（v1..vN 图谱/报告/manifest/vector DB）后重新跑完整 build。"
            "适用于属性值变更/大改等增量 update 难以正确处理的修改；"
            "正常增量同步请用 sync_changes，仅在需要全量重建时调用本工具。"
        ),
        "inputSchema": {
            "type": "object",
            "required": ["cluster_id"],
            "properties": {
                "cluster_id": {
                    "type": "string",
                    "description": "og cluster ID",
                },
            },
        },
        "handler": rebuild_project,
    },
    {
        "name": "get_status",
        "description": "查看 og cluster 的 pipeline 运行状态、当前 phase、最新输出文件列表。",
        "inputSchema": {
            "type": "object",
            "required": ["cluster_id"],
            "properties": {
                "cluster_id": {"type": "string", "description": "og cluster ID"},
            },
        },
        "handler": get_status,
    },
    {
        "name": "get_graph_summary",
        "description": "读取 og 知识图谱 JSON，返回节点/边统计和顶层 Section 结构。",
        "inputSchema": {
            "type": "object",
            "required": ["cluster_id"],
            "properties": {
                "cluster_id": {"type": "string", "description": "og cluster ID"},
            },
        },
        "handler": get_graph_summary,
    },
    {
        "name": "get_report",
        "description": "读取指定变体的汇总报告 Markdown 内容。",
        "inputSchema": {
            "type": "object",
            "required": ["cluster_id"],
            "properties": {
                "cluster_id": {"type": "string", "description": "og cluster ID"},
                "variant": {
                    "type": "string",
                    "description": "报告变体：polished7 / balanced / curated / rewritten",
                    "default": "polished7",
                },
            },
        },
        "handler": get_report,
    },
]
