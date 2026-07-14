from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]



TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "list_clusters",
            "description": "列出所有可用集群及其统计信息（版本数、参考文献数、是否有图谱）",
            "parameters": {
                "type": "object",
                "properties": {
                    "model": {"type": "string", "description": "模型名，默认 deepseek", "default": "deepseek"}
                },
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_cluster_info",
            "description": "获取指定集群的详细配置：topic、period_year_ranges、stats、最新报告列表",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id": {"type": "string", "description": "集群ID，如 DR-28"},
                    "model": {"type": "string", "default": "deepseek"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_graph_summary",
            "description": "获取知识图谱摘要：节点类型分布、顶层 Section 结构、高置信度 Claim 节点列表",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "version":    {"type": "string", "default": "latest"},
                    "model":      {"type": "string", "default": "deepseek"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_nodes",
            "description": "在知识图谱中按关键词搜索节点（匹配标题和摘要），返回前 N 个节点详情",
            "parameters": {
                "type": "object",
                "required": ["cluster_id", "query"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "query":      {"type": "string", "description": "搜索关键词"},
                    "version":    {"type": "string", "default": "latest"},
                    "top_k":      {"type": "integer", "default": 8},
                    "model":      {"type": "string", "default": "deepseek"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_report_content",
            "description": "读取指定报告的 Markdown 内容（用于总结/分析，超长时截断）",
            "parameters": {
                "type": "object",
                "required": ["cluster_id", "filename"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "filename":   {"type": "string", "description": "报告文件名，如 output_report_4.0_polished.md"},
                    "model":      {"type": "string", "default": "deepseek"},
                    "max_chars":  {"type": "integer", "default": 8000},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_pipeline",
            "description": "启动 og Framework A 流水线（等同于 og run a 命令）。执行前必须向用户确认。",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "model":      {"type": "string", "default": "deepseek-v4-pro"},
                    "flags": {
                        "type": "array",
                        "items": {"type": "string", "enum": ["curation","rewrite","balanced","polish","skip_build"]},
                        "default": [],
                    },
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_task_status",
            "description": "查询最近任务的运行状态（含日志尾部，最多5条）",
            "parameters": {
                "type": "object",
                "properties": {
                    "cluster_id": {"type": "string", "description": "按集群过滤，可选"},
                    "limit":      {"type": "integer", "default": 5},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_memory",
            "description": "向指定层级的记忆文件追加内容。用户说'记住'、'记录一下'时调用。",
            "parameters": {
                "type": "object",
                "required": ["level", "content"],
                "properties": {
                    "level":      {"type": "string", "enum": ["global","user","project"]},
                    "content":    {"type": "string", "description": "要追加的 Markdown 内容"},
                    "cluster_id": {"type": "string", "description": "仅 level=project 时需要"},
                    "section":    {"type": "string", "description": "追加到哪个 ## 标题下"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "set_preference",
            "description": "保存机器可读偏好（影响 RunPanel 等 UI 默认值）。用户说'记住默认用 X'时调用。",
            "parameters": {
                "type": "object",
                "required": ["key", "value"],
                "properties": {
                    "key":   {"type": "string", "enum": ["preferred_model","default_flags","chat_model","response_language","expertise_level"]},
                    "value": {"description": "新值"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_memory",
            "description": "主动读取某层记忆文件完整内容（当 context 中的记忆不够详细时调用）",
            "parameters": {
                "type": "object",
                "required": ["level"],
                "properties": {
                    "level":      {"type": "string", "enum": ["global","user","project"]},
                    "cluster_id": {"type": "string"},
                }
            }
        }
    },


    {
        "type": "function",
        "function": {
            "name": "test_connection",
            "description": "测试指定 provider 的 API 连通性（发送 1-token 请求，返回延迟或报错）",
            "parameters": {
                "type": "object",
                "required": ["provider"],
                "properties": {
                    "provider": {
                        "type": "string",
                        "enum": ["deepseek", "minimax", "qwen", "doubao", "yeysai"],
                        "description": "要测试的 provider 名称"
                    }
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_config",
            "description": "读取 og/config/models.py 中的 API Key、API Base URL、默认 LLM 模型配置（密钥打码）",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_config",
            "description": "修改 og/config/models.py 中的配置字段（API Key、Base URL、默认模型）",
            "parameters": {
                "type": "object",
                "required": ["updates"],
                "properties": {
                    "updates": {
                        "type": "object",
                        "description": "要更新的字段字典，如 {\"_DEFAULT_LLM_MAIN\": \"deepseek-v4-flash\"}"
                    }
                }
            }
        }
    },


    {
        "type": "function",
        "function": {
            "name": "create_cluster",
            "description": "新建集群（初始化目录 + 写 cluster_config.json）",
            "parameters": {
                "type": "object",
                "required": ["cluster_id", "topic"],
                "properties": {
                    "cluster_id":         {"type": "string", "description": "格式 DR-XX"},
                    "topic":              {"type": "string"},
                    "period_year_ranges": {"type": "object", "description": "如 {\"v1\":[2020,2024]}"},
                    "model":              {"type": "string", "default": "deepseek"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "update_cluster",
            "description": "修改集群配置（topic、description、period_year_ranges）",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id":         {"type": "string"},
                    "topic":              {"type": "string"},
                    "description":        {"type": "string"},
                    "period_year_ranges": {"type": "object"},
                    "model":              {"type": "string", "default": "deepseek"},
                }
            }
        }
    },


    {
        "type": "function",
        "function": {
            "name": "list_refs",
            "description": "列出指定集群的所有参考文献文件（含版本、字数）",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "model":      {"type": "string", "default": "deepseek"},
                    "version":    {"type": "integer", "description": "按期过滤，可选"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "add_ref",
            "description": "粘贴文本内容新增一篇参考文献，自动按发表年份分配到对应期文件夹",
            "parameters": {
                "type": "object",
                "required": ["cluster_id", "content", "year"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "content":    {"type": "string", "description": "参考文献全文"},
                    "year":       {"type": "integer", "description": "发表年份，用于自动分配期数"},
                    "model":      {"type": "string", "default": "deepseek"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "detect_periods",
            "description": "扫描各期参考文献目录，自动推算 period_year_ranges 建议值",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "model":      {"type": "string", "default": "deepseek"},
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "distribute_refs",
            "description": "按 period_year_ranges 自动将参考文献分配到对应期文件夹（可先预览再执行）",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "model":      {"type": "string", "default": "deepseek"},
                    "dry_run":    {"type": "boolean", "default": True, "description": "True=只预览，False=实际执行"},
                }
            }
        }
    },


    {
        "type": "function",
        "function": {
            "name": "list_reports",
            "description": "列出指定集群的所有报告文件（按修改时间倒序）",
            "parameters": {
                "type": "object",
                "required": ["cluster_id"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "model":      {"type": "string", "default": "deepseek"},
                }
            }
        }
    },


    {
        "type": "function",
        "function": {
            "name": "compare_reports",
            "description": "在前端打开报告对比模式，让用户直观地看两份报告的差异（高亮对比）。当用户要求对比两份报告时调用。",
            "parameters": {
                "type": "object",
                "required": ["cluster_id", "report_a", "report_b"],
                "properties": {
                    "cluster_id": {"type": "string"},
                    "report_a":   {"type": "string", "description": "左侧报告文件名"},
                    "report_b":   {"type": "string", "description": "右侧报告文件名"},
                    "model":      {"type": "string", "default": "deepseek"},
                }
            }
        }
    },


    {
        "type": "function",
        "function": {
            "name": "cancel_task",
            "description": "中止正在运行的流水线任务",
            "parameters": {
                "type": "object",
                "required": ["task_id"],
                "properties": {
                    "task_id": {"type": "string", "description": "任务 ID（完整 UUID 或 8 位前缀）"},
                }
            }
        }
    },
]




def execute(name: str, args: dict) -> Any:
    fn = _TOOL_MAP.get(name)
    if fn is None:
        return {"error": f"未知工具: {name!r}"}
    try:
        return fn(**args)
    except Exception as e:
        return {"error": str(e)[:300]}


def _tool_list_clusters(model: str = "deepseek") -> dict:
    from .. import filestore
    ids = filestore.list_cluster_ids(model)
    result = []
    for cid in ids:
        stats = filestore.cluster_stats(cid, model)
        cfg   = filestore.read_cluster_config(cid, model) or {}
        result.append({
            "id":            cid,
            "topic":         cfg.get("topic", ""),
            "version_count": stats["version_count"],
            "ref_count":     stats["ref_count"],
            "has_graph":     stats["has_graph"],
        })
    return {"clusters": result, "total": len(result)}


def _tool_get_cluster_info(cluster_id: str, model: str = "deepseek") -> dict:
    from .. import filestore
    cfg   = filestore.read_cluster_config(cluster_id, model)
    if cfg is None:
        return {"error": f"集群 {cluster_id} 不存在"}
    stats   = filestore.cluster_stats(cluster_id, model)
    reports = filestore.list_reports(cluster_id, model)[:5]
    og_vers = filestore.list_og_versions(cluster_id, model)
    return {
        "cluster_id":         cluster_id,
        "topic":              cfg.get("topic", ""),
        "period_year_ranges": cfg.get("period_year_ranges", {}),
        "stats":              stats,
        "og_versions":        og_vers,
        "recent_reports":     [r["filename"] for r in reports],
    }


def _tool_get_graph_summary(cluster_id: str, version: str = "latest",
                             model: str = "deepseek") -> dict:
    from .. import filestore
    data = filestore.read_og_graph(cluster_id, version, model)
    if data is None:
        return {"error": f"集群 {cluster_id} 无图谱数据（version={version}）"}

    nodes = data["nodes"]
    edges = data["edges"]


    type_dist: dict[str, int] = {}
    for n in nodes:
        t = n.get("type", "Unknown")
        type_dist[t] = type_dist.get(t, 0) + 1


    section_nodes = {n["temp_id"]: n for n in nodes if n.get("type") == "Section"}
    contains_edges = [(e["source"], e["target"]) for e in edges if e.get("type") == "contains"]
    children_map: dict[str, list[str]] = {}
    for src, tgt in contains_edges:
        if src not in children_map:
            children_map[src] = []
        children_map[src].append(tgt)


    all_targets = {tgt for _, tgt in contains_edges}
    roots = [n for n in section_nodes if n not in all_targets]

    def _section_tree(nid: str, depth: int = 0) -> list[dict]:
        if depth > 3:
            return []
        node = section_nodes.get(nid, {})
        result = [{"title": node.get("title", nid), "id": nid, "depth": depth}]
        for child_id in children_map.get(nid, []):
            if child_id in section_nodes:
                result.extend(_section_tree(child_id, depth + 1))
        return result

    tree = []
    for root_id in roots[:3]:
        tree.extend(_section_tree(root_id))


    claims = sorted(
        [n for n in nodes if n.get("type") == "Claim"],
        key=lambda n: n.get("confidence", 0), reverse=True
    )[:5]

    return {
        "cluster_id":   cluster_id,
        "version":      version,
        "node_count":   len(nodes),
        "edge_count":   len(edges),
        "type_distribution": type_dist,
        "section_tree": tree,
        "top_claims":   [{"title": n.get("title",""), "confidence": n.get("confidence",0)} for n in claims],
        "_navigate":    {"cluster_id": cluster_id, "tab": "graph", "version": version, "model": model},
    }


def _tool_search_nodes(cluster_id: str, query: str, version: str = "latest",
                        top_k: int = 8, model: str = "deepseek") -> dict:
    from .. import filestore
    data = filestore.read_og_graph(cluster_id, version, model)
    if data is None:
        return {"error": f"集群 {cluster_id} 无图谱数据"}

    pattern = re.compile(query, re.IGNORECASE)
    results = []
    for n in data["nodes"]:
        title   = n.get("title", "")
        summary = n.get("content_summary", "")
        if pattern.search(title) or pattern.search(summary):
            results.append({
                "id":      n["temp_id"],
                "type":    n.get("type", ""),
                "title":   title,
                "summary": summary[:200],
            })
        if len(results) >= top_k:
            break

    return {"query": query, "matches": results, "total": len(results),
            "_navigate": {"cluster_id": cluster_id, "tab": "graph"}}


def _tool_get_report_content(cluster_id: str, filename: str,
                              model: str = "deepseek", max_chars: int = 8000) -> dict:
    from .. import filestore
    content = filestore.read_report(cluster_id, filename, model)
    if content is None:
        return {"error": f"报告 {filename} 不存在"}
    truncated = len(content) > max_chars
    return {
        "filename":  filename,
        "content":   content[:max_chars],
        "truncated": truncated,
        "total_chars": len(content),
        "_navigate": {"cluster_id": cluster_id, "tab": "reports", "filename": filename, "model": model},
    }


def _tool_run_pipeline(cluster_id: str, model: str = "deepseek-v4-pro",
                        flags: list | None = None) -> dict:
    import asyncio
    from .tasks import _build_cmd, _log_path, _procs, _watch_proc, LOGS_DIR
    from ..db.session import SessionLocal
    from ..db import crud
    from datetime import datetime, timezone

    flags = flags or []
    cfg = {"model": model}
    for flag in flags:
        cfg[flag.replace("-", "_")] = True

    cfg_str = json.dumps(cfg)
    db = SessionLocal()
    try:
        task = crud.create_task(db, cluster_id=cluster_id, type="run_a", config=cfg_str)
        task_id = task.id
    finally:
        db.close()

    cmd = _build_cmd(task_id, cluster_id, cfg)
    log_p = _log_path(task_id)
    log_p.parent.mkdir(parents=True, exist_ok=True)

    async def _start():
        with open(log_p, "w", encoding="utf-8") as lf:
            lf.write(f"[启动] {' '.join(cmd)}\n")
        log_file = open(log_p, "a", encoding="utf-8")
        import asyncio as _asyncio
        proc = await _asyncio.create_subprocess_exec(
            *cmd, stdout=log_file, stderr=_asyncio.subprocess.STDOUT,
            cwd=str(ROOT),
        )
        _procs[task_id] = proc
        db2 = SessionLocal()
        try:
            crud.update_task_status(db2, task_id, "running",
                                    log_path=str(log_p.relative_to(ROOT)),
                                    started_at=datetime.now(timezone.utc))
        finally:
            db2.close()
        _asyncio.create_task(_watch_proc(task_id, proc))

    try:
        loop = asyncio.get_event_loop()
        loop.create_task(_start())
    except RuntimeError:
        asyncio.run(_start())

    return {"ok": True, "task_id": task_id, "cluster_id": cluster_id,
            "model": model, "flags": flags,
            "message": f"流水线已启动，任务 ID: {task_id[:8]}…",
            "_navigate": {"cluster_id": cluster_id, "tab": "run"}}


def _tool_get_task_status(cluster_id: str | None = None, limit: int = 5) -> dict:
    from .tasks import _tail_log
    from ..db.session import SessionLocal
    from ..db import crud

    db = SessionLocal()
    try:
        tasks = crud.list_tasks(db, cluster_id=cluster_id, limit=limit)
        result = []
        for t in tasks:
            log_tail = _tail_log(t.id, 10) if t.log_path else []
            result.append({
                "id":          t.id[:8] + "…",
                "status":      t.status,
                "cluster_id":  t.cluster_id,
                "started_at":  str(t.started_at or ""),
                "finished_at": str(t.finished_at or ""),
                "log_tail":    log_tail[-5:],
            })
    finally:
        db.close()

    return {"tasks": result}


def _tool_write_memory(level: str, content: str,
                        cluster_id: str | None = None, section: str | None = None) -> dict:

    from .memory import write_memory_file, local_memory_enabled
    if not local_memory_enabled():
        return {"ok": False, "error": "og6 local memory 已禁用（OG_DISABLE_LOCAL_MEMORY=1）"}
    p = write_memory_file(level, content, cluster_id, section)
    return {"ok": True, "path": str(p.relative_to(ROOT))}


def _tool_set_preference(key: str, value: Any) -> dict:
    from .preferences import _read_prefs, _write_prefs
    prefs = _read_prefs()
    prefs[key] = value
    _write_prefs(prefs)
    return {"ok": True, "key": key, "value": value}


def _tool_read_memory(level: str, cluster_id: str | None = None) -> dict:

    from .memory import read_memory_file, local_memory_enabled
    if not local_memory_enabled():
        return {"level": level, "cluster_id": cluster_id, "content": "（og6 local memory 已禁用）"}
    content = read_memory_file(level, cluster_id)
    return {"level": level, "cluster_id": cluster_id, "content": content or "（空）"}




def _tool_test_connection(provider: str) -> dict:
    import time
    _TEST_MODEL = {
        "deepseek": "deepseek-chat",
        "minimax":  "MiniMax-M3",
        "qwen":     "qwen-turbo",
        "doubao":   "doubao-lite-32k",
        "yeysai":   "gpt-4o-mini",
    }
    model = _TEST_MODEL.get(provider)
    if not model:
        return {"ok": False, "error": f"未知 provider: {provider}"}
    try:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        from og.config.models import get_client_for_model
        client = get_client_for_model(model)
        t0 = time.monotonic()
        client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=1,
            timeout=15,
        )
        latency = int((time.monotonic() - t0) * 1000)
        return {"ok": True, "provider": provider, "model_used": model,
                "latency_ms": latency}
    except Exception as e:
        return {"ok": False, "provider": provider, "model_used": model,
                "error": str(e)[:300]}


def _tool_get_config() -> dict:
    from .config import _build_fields, MODELS_PY
    if not MODELS_PY.exists():
        return {"error": "models.py 不存在"}
    src = MODELS_PY.read_text(encoding="utf-8")
    fields = _build_fields(src)
    return {"fields": [{"key": f.key, "label": f.label, "provider": f.provider,
                         "value": f.value, "masked": f.masked} for f in fields]}


def _tool_update_config(updates: dict) -> dict:
    from .config import _build_fields, _write_field, MODELS_PY
    src = MODELS_PY.read_text(encoding="utf-8")
    changed = []
    for k, v in updates.items():
        if "***" in str(v):
            continue
        try:
            src = _write_field(src, k, str(v))
            changed.append(k)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
    MODELS_PY.write_text(src, encoding="utf-8")
    return {"ok": True, "changed": changed,
            "note": "修改已写入 models.py，重启后端后生效"}


def _tool_create_cluster(cluster_id: str, topic: str,
                          period_year_ranges: dict | None = None,
                          model: str = "deepseek") -> dict:
    from .. import filestore
    from ..db.session import SessionLocal
    from ..db import crud
    if filestore.read_cluster_config(cluster_id, model) is not None:
        return {"error": f"集群 {cluster_id} 已存在"}
    cfg = {
        "topic": topic,
        "task_year_range": [1900, 2026],
        "period_year_ranges": period_year_ranges or {"v1": [2020, 2024]},
    }
    filestore.create_cluster_dirs(cluster_id, model)
    filestore.write_cluster_config(cluster_id, cfg, model)
    db = SessionLocal()
    try:
        crud.upsert_cluster(db, cluster_id, topic)
    finally:
        db.close()
    return {"ok": True, "cluster_id": cluster_id, "topic": topic}


def _tool_update_cluster(cluster_id: str, topic: str | None = None,
                          description: str | None = None,
                          period_year_ranges: dict | None = None,
                          model: str = "deepseek") -> dict:
    from .. import filestore
    from ..db.session import SessionLocal
    from ..db import crud
    cfg = filestore.read_cluster_config(cluster_id, model)
    if cfg is None:
        return {"error": f"集群 {cluster_id} 不存在"}
    if topic is not None:
        cfg["topic"] = topic
    if period_year_ranges is not None:
        cfg["period_year_ranges"] = period_year_ranges
    filestore.write_cluster_config(cluster_id, cfg, model)
    db = SessionLocal()
    try:
        crud.upsert_cluster(db, cluster_id, cfg.get("topic", ""), description)
    finally:
        db.close()
    return {"ok": True, "cluster_id": cluster_id, "updated": cfg}


def _tool_list_refs(cluster_id: str, model: str = "deepseek",
                    version: int | None = None) -> dict:
    from .. import filestore
    items = filestore.list_ref_files(cluster_id, version, filestore.DEFAULT_MODEL)
    summary: dict[int, int] = {}
    for it in items:
        v = it["version"]
        summary[v] = summary.get(v, 0) + 1
    return {
        "cluster_id": cluster_id,
        "total":      len(items),
        "by_version": summary,
        "files":      [{"filename": x["filename"], "version": x["version"],
                         "size_kb": round(x["size"] / 1024, 1)} for x in items[:30]],
        "truncated":  len(items) > 30,
        "_navigate":  {"cluster_id": cluster_id, "tab": "refs"},
    }


def _tool_add_ref(cluster_id: str, content: str, year: int,
                  model: str = "deepseek") -> dict:
    from .. import filestore
    from ..db.session import SessionLocal
    from ..db import crud
    cfg = filestore.read_cluster_config(cluster_id, model) or {}
    period_ranges = cfg.get("period_year_ranges", {})
    v_str = filestore.assign_version(year, period_ranges) if period_ranges else None
    target_v = int(v_str.lstrip("v")) if v_str else 1
    fname = filestore.next_ref_filename(cluster_id, target_v, filestore.DEFAULT_MODEL)
    filestore.save_ref_file(cluster_id, target_v, fname,
                            content.encode("utf-8"), filestore.DEFAULT_MODEL)
    wc = len("".join(content.split()))
    db = SessionLocal()
    try:
        crud.create_reference(db, cluster_id=cluster_id,
                              version=target_v, filename=fname, word_count=wc)
    finally:
        db.close()
    return {"ok": True, "filename": fname, "version": target_v,
            "year": year, "word_count": wc}


def _tool_detect_periods(cluster_id: str, model: str = "deepseek") -> dict:
    from .. import filestore
    suggested = filestore.detect_periods_from_refs(cluster_id, model)
    return {"cluster_id": cluster_id, "suggested": suggested,
            "note": "可用 update_cluster 将 suggested 写入配置"}


def _tool_distribute_refs(cluster_id: str, model: str = "deepseek",
                           dry_run: bool = True) -> dict:
    from .. import filestore
    from ..db.session import SessionLocal
    from ..db import crud
    cfg = filestore.read_cluster_config(cluster_id, model) or {}
    period_ranges = cfg.get("period_year_ranges", {})
    if not period_ranges:
        return {"error": "cluster_config.json 中没有 period_year_ranges"}

    base = filestore.cluster_dir(cluster_id, filestore.DEFAULT_MODEL)
    plan = []
    for v_dir in sorted(base.glob("reference_texts_v*")):
        v_str = v_dir.name.replace("reference_texts_", "")
        for f in sorted(v_dir.glob("*.txt")):
            content = f.read_text(encoding="utf-8", errors="replace")
            year    = filestore.extract_ref_year(content)
            target  = filestore.assign_version(year, period_ranges)
            action  = "skip" if target is None else ("move" if target != v_str else "keep")
            plan.append({"filename": f.name, "current_v": v_str,
                          "target_v": target, "detected_year": year, "action": action})

    summary = {a: sum(1 for x in plan if x["action"] == a)
               for a in ("move", "keep", "skip")}

    if not dry_run:
        db = SessionLocal()
        try:
            for item in plan:
                if item["action"] != "move" or not item["target_v"]:
                    continue
                from_v = int(item["current_v"].lstrip("v"))
                to_v   = int(item["target_v"].lstrip("v"))
                filestore.move_ref_file(cluster_id, from_v, to_v, item["filename"])
                db_refs = crud.list_references(db, cluster_id)
                for ref in db_refs:
                    if ref.filename == item["filename"] and ref.version == from_v:
                        ref.version = to_v
                        db.commit()
                        break
        finally:
            db.close()

    return {"dry_run": dry_run, "summary": summary, "plan": plan[:20],
            "note": "plan 仅展示前20条" if len(plan) > 20 else ""}


def _tool_list_reports(cluster_id: str, model: str = "deepseek") -> dict:
    from .. import filestore
    reports = filestore.list_reports(cluster_id, model)
    return {
        "cluster_id": cluster_id,
        "model":      model,
        "total":      len(reports),
        "reports":    [{"filename": r["filename"],
                         "size_kb": round(r["size"] / 1024, 1)} for r in reports],
    }


def _tool_compare_reports(cluster_id: str, report_a: str, report_b: str,
                           model: str = "deepseek") -> dict:
    from .. import filestore

    ok_a = filestore.read_report(cluster_id, report_a, model) is not None
    ok_b = filestore.read_report(cluster_id, report_b, model) is not None
    if not ok_a:
        return {"error": f"报告 {report_a} 不存在"}
    if not ok_b:
        return {"error": f"报告 {report_b} 不存在"}
    return {
        "ok": True,
        "cluster_id": cluster_id,
        "report_a": report_a,
        "report_b": report_b,
        "message": f"正在打开对比视图：{report_a} vs {report_b}",
        "_navigate": {
            "cluster_id": cluster_id,
            "tab": "reports",
            "compare": True,
            "selA": report_a,
            "selB": report_b,
        },
    }


def _tool_cancel_task(task_id: str) -> dict:
    from .tasks import _procs, _log_path
    from ..db.session import SessionLocal
    from ..db import crud
    from datetime import datetime, timezone


    matched_id = task_id
    if len(task_id) < 36:
        for full_id in list(_procs):
            if full_id.startswith(task_id):
                matched_id = full_id
                break

    proc = _procs.get(matched_id)
    if proc and proc.returncode is None:
        proc.kill()
        _procs.pop(matched_id, None)

    db = SessionLocal()
    try:
        task = crud.get_task(db, matched_id)
        if task is None:
            return {"error": f"任务 {task_id} 不存在"}
        crud.update_task_status(db, matched_id, "failed",
                                finished_at=datetime.now(timezone.utc))
    finally:
        db.close()
    return {"ok": True, "task_id": matched_id, "status": "failed"}



_TOOL_MAP = {

    "list_clusters":      _tool_list_clusters,
    "get_cluster_info":   _tool_get_cluster_info,
    "get_graph_summary":  _tool_get_graph_summary,
    "search_nodes":       _tool_search_nodes,
    "get_report_content": _tool_get_report_content,
    "run_pipeline":       _tool_run_pipeline,
    "get_task_status":    _tool_get_task_status,
    "write_memory":       _tool_write_memory,
    "set_preference":     _tool_set_preference,
    "read_memory":        _tool_read_memory,

    "test_connection":    _tool_test_connection,
    "get_config":         _tool_get_config,
    "update_config":      _tool_update_config,
    "create_cluster":     _tool_create_cluster,
    "update_cluster":     _tool_update_cluster,
    "list_refs":          _tool_list_refs,
    "add_ref":            _tool_add_ref,
    "detect_periods":     _tool_detect_periods,
    "distribute_refs":    _tool_distribute_refs,
    "list_reports":       _tool_list_reports,
    "cancel_task":        _tool_cancel_task,
    "compare_reports":    _tool_compare_reports,
}
