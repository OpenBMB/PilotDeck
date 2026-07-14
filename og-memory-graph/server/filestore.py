from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Optional, Any




_og_cache: dict[str, tuple[float, dict]] = {}


_stats_cache: dict[str, tuple[float, dict]] = {}
_STATS_TTL = 30.0

ROOT = Path(os.environ.get("V5_ROOT") or str(Path(__file__).resolve().parents[1]))


_MODEL_DIR_MAP: dict[str, str] = {
    "deepseek": "clusters",
    "doubao":   "clusters_doubao_seed_2_0_pro_260215",
    "qwen3":    "clusters_qwen3_7_plus",
    "gemini":   "clusters_gemini2_5_pro",
    "gpt-4o":   "clusters_gpt_4o",
    "claude":   "clusters_claude_sonnet_4_5",
    "minimax":  "clusters_MiniMax_M3",
}


_INTERMEDIATES_DIR_MAP: dict[str, str] = {
    "deepseek": "intermediates",
    "doubao":   "intermediates_doubao_seed_2_0_pro_260215",
    "qwen3":    "intermediates_qwen3_7_plus",
    "gemini":   "intermediates_gemini2_5_pro",
    "gpt-4o":   "intermediates_gpt_4o",
    "claude":   "intermediates_claude_sonnet_4_5",
    "minimax":  "intermediates_MiniMax_M3",
}

DEFAULT_MODEL = "deepseek"


def list_models() -> list[str]:
    return [
        model for model, dirname in _MODEL_DIR_MAP.items()
        if (ROOT / "data" / dirname).exists()
    ]


def clusters_dir(model: str = DEFAULT_MODEL) -> Path:
    dirname = _MODEL_DIR_MAP.get(model)
    if dirname is None:
        raise ValueError(f"未知模型: {model!r}，可选值: {list(_MODEL_DIR_MAP)}")
    return ROOT / "data" / dirname




def cluster_dir(cluster_id: str, model: str = DEFAULT_MODEL) -> Path:
    return clusters_dir(model) / cluster_id


def list_cluster_ids(model: str = DEFAULT_MODEL) -> list[str]:
    d = clusters_dir(model)
    if not d.exists():
        return []
    return sorted(
        x.name for x in d.iterdir()
        if x.is_dir() and re.match(r"DR-\d+", x.name)
    )


def read_cluster_config(cluster_id: str,
                        model: str = DEFAULT_MODEL) -> dict[str, Any] | None:

    if not cluster_dir(cluster_id, model).exists():
        return None

    p = cluster_dir(cluster_id, model) / "cluster_config.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))

    p_default = cluster_dir(cluster_id, DEFAULT_MODEL) / "cluster_config.json"
    if p_default.exists():
        return json.loads(p_default.read_text(encoding="utf-8"))
    return None


def write_cluster_config(cluster_id: str, config: dict[str, Any],
                         model: str = DEFAULT_MODEL) -> None:
    d = cluster_dir(cluster_id, model)
    d.mkdir(parents=True, exist_ok=True)
    p = d / "cluster_config.json"
    p.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")


def create_cluster_dirs(cluster_id: str, model: str = DEFAULT_MODEL) -> None:
    base = cluster_dir(cluster_id, model)
    for sub in ["reference_texts_v1", "agent_outputs", "output"]:
        (base / sub).mkdir(parents=True, exist_ok=True)


def delete_cluster_dir(cluster_id: str, model: str = DEFAULT_MODEL) -> None:
    d = cluster_dir(cluster_id, model)
    if d.exists():
        shutil.rmtree(d)




def extract_ref_year(content: str) -> Optional[int]:
    hits = re.findall(r'(20[012]\d)年', content[:600])
    if hits:
        years = [int(y) for y in hits if 2000 <= int(y) <= 2030]
        return max(years) if years else None
    hits2 = re.findall(r'\b(20[012]\d)\b', content[:600])
    if hits2:
        years = [int(y) for y in hits2 if 2000 <= int(y) <= 2030]
        return max(years) if years else None
    return None


def assign_version(year: Optional[int],
                   period_year_ranges: dict[str, Any]) -> Optional[str]:
    if year is None:
        return None

    sorted_versions = sorted(
        period_year_ranges.items(),
        key=lambda kv: kv[1][0],
    )
    for vname, (lo, hi) in sorted_versions:
        if lo <= year <= hi:
            return vname

    if year < sorted_versions[0][1][0]:
        return sorted_versions[0][0]
    return sorted_versions[-1][0]


def move_ref_file(cluster_id: str, from_version: int, to_version: int,
                  filename: str, model: str = DEFAULT_MODEL) -> bool:
    src = ref_dir(cluster_id, from_version, DEFAULT_MODEL) / filename
    dst_dir = ref_dir(cluster_id, to_version, DEFAULT_MODEL)
    if not src.exists():
        return False
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / filename

    if dst.exists():
        stem = dst.stem
        suffix = dst.suffix
        n = 1
        while dst.exists():
            dst = dst_dir / f"{stem}_{n}{suffix}"
            n += 1
    shutil.move(str(src), str(dst))
    return True


def ref_dir(cluster_id: str, version: int,
            model: str = DEFAULT_MODEL) -> Path:
    return cluster_dir(cluster_id, model) / f"reference_texts_v{version}"


def list_ref_files(cluster_id: str,
                   version: Optional[int] = None,
                   model: str = DEFAULT_MODEL) -> list[dict[str, Any]]:
    base = cluster_dir(cluster_id, model)
    result = []
    pattern = f"reference_texts_v{version}" if version else "reference_texts_v*"
    for d in sorted(base.glob(pattern)):
        v = int(d.name.split("_v")[1])
        for f in sorted(d.glob("*.txt")):
            stat = f.stat()
            result.append({
                "filename":  f.name,
                "version":   v,
                "size":      stat.st_size,
                "path":      str(f.relative_to(ROOT)),
            })
    return result


def read_ref_content(cluster_id: str, version: int,
                     filename: str,
                     model: str = DEFAULT_MODEL) -> Optional[str]:
    p = ref_dir(cluster_id, version, model) / filename
    if not p.exists():
        return None
    return p.read_text(encoding="utf-8", errors="replace")


def save_ref_file(cluster_id: str, version: int,
                  filename: str, content: bytes,
                  model: str = DEFAULT_MODEL) -> Path:
    d = ref_dir(cluster_id, version, model)
    d.mkdir(parents=True, exist_ok=True)
    p = d / filename
    p.write_bytes(content)
    return p


def next_ref_filename(cluster_id: str, version: int,
                      model: str = DEFAULT_MODEL) -> str:
    d = ref_dir(cluster_id, version, model)
    existing = {f.name for f in d.glob("ref_*.txt")} if d.exists() else set()
    n = 1
    while True:
        name = f"ref_{n:03d}.txt"
        if name not in existing:
            return name
        n += 1


def delete_ref_file(cluster_id: str, version: int, filename: str,
                    model: str = DEFAULT_MODEL) -> bool:
    p = ref_dir(cluster_id, version, model) / filename
    if p.exists():
        p.unlink()
        return True
    return False




def intermediates_og_dir(cluster_id: str,
                         model: str = DEFAULT_MODEL) -> Path:
    dirname = _INTERMEDIATES_DIR_MAP.get(model)
    if dirname is None:
        raise ValueError(f"未知模型: {model!r}")
    return ROOT / "data" / dirname / "og" / cluster_id


def list_og_versions(cluster_id: str,
                     model: str = DEFAULT_MODEL) -> list[str]:
    d = intermediates_og_dir(cluster_id, model)
    if not d.exists():
        return []
    pattern = re.compile(rf"og_{re.escape(cluster_id)}_v?(\d+(?:\.\d+)?)\.json$")
    entries: list[tuple[float, str]] = []
    for f in d.glob(f"og_{cluster_id}_*.json"):
        m = pattern.match(f.name)
        if m:
            ver_float = float(m.group(1))
            entries.append((ver_float, f))
    entries.sort(key=lambda x: x[0])
    return [f"v{int(ver)}" for ver, _ in entries]


def list_og_versions_with_mtime(cluster_id: str,
                                model: str = DEFAULT_MODEL) -> list[dict]:
    d = intermediates_og_dir(cluster_id, model)
    if not d.exists():
        return []
    pattern = re.compile(rf"og_{re.escape(cluster_id)}_v?(\d+(?:\.\d+)?)\.json$")
    entries: list[tuple[float, Path]] = []
    for f in d.glob(f"og_{cluster_id}_*.json"):
        m = pattern.match(f.name)
        if m:
            ver_float = float(m.group(1))
            entries.append((ver_float, f))
    entries.sort(key=lambda x: x[0])
    return [{"version": f"v{int(ver)}", "mtime": f.stat().st_mtime} for ver, f in entries]


def read_og_graph(cluster_id: str,
                  version: str = "latest",
                  model: str = DEFAULT_MODEL) -> Optional[dict]:
    d = intermediates_og_dir(cluster_id, model)
    if not d.exists():
        return None


    pattern = re.compile(rf"og_{re.escape(cluster_id)}_v?(\d+(?:\.\d+)?)\.json$")
    ver_map: dict[str, Path] = {}
    for f in d.glob(f"og_{cluster_id}_*.json"):
        m = pattern.match(f.name)
        if m:
            ver_float = float(m.group(1))
            display = f"v{int(ver_float)}"
            ver_map[display] = f

    if not ver_map:
        return None
    if version == "latest":

        version = max(ver_map, key=lambda v: int(v[1:]))
    if version not in ver_map:
        return None

    og_file = ver_map[version]

    curated_file = og_file.with_name(og_file.stem + "_curated.json")
    if curated_file.exists():
        og_file = curated_file
    file_mtime = og_file.stat().st_mtime
    cache_key = f"{cluster_id}:{version}:{model}"
    if cache_key in _og_cache:
        cached_mtime, cached_data = _og_cache[cache_key]
        if cached_mtime == file_mtime:
            return cached_data

    raw = json.loads(og_file.read_text(encoding="utf-8"))

    _DROP = {"snapshot_version_history", "original_text", "data_blocks", "change_log"}


    current_ver = version
    current_ver_plain = current_ver.lstrip("v")



    all_ids: set[str] = set()
    nodes: list[dict] = []
    for node_dict in raw.get("nodes", {}).values():

        title = node_dict.get("title", "") or ""
        if node_dict.get("type") == "Reference" and "OG 同步增量" in title:
            continue
        node_id = node_dict.get("id", "")
        all_ids.add(node_id)
        converted = {
            ("temp_id" if k == "id" else k): v
            for k, v in node_dict.items()
            if k not in _DROP
        }

        civ = str(converted.get("created_in_version", ""))
        if civ in (current_ver, current_ver_plain):
            converted["is_delta"] = True
            converted["delta_version"] = current_ver
        nodes.append(converted)


    edges: list[dict] = []
    for edge_dict in raw.get("edges", []):
        src = edge_dict.get("source_id", "")
        tgt = edge_dict.get("target_id", "")
        if src not in all_ids or tgt not in all_ids:
            continue
        converted_edge = {
            ("source" if k == "source_id" else
             "target" if k == "target_id" else k): v
            for k, v in edge_dict.items()
        }
        edges.append(converted_edge)



    ref_section_id: Optional[str] = None
    for n in nodes:
        if n.get("type") == "Section" and "参考" in n.get("title", ""):
            ref_section_id = n["temp_id"]
            break

    if ref_section_id:
        already_contained = {
            e["target"] for e in edges if e["type"] == "contains"
        }
        for n in nodes:
            if n.get("type") == "Reference" and n["temp_id"] not in already_contained:
                edges.append({
                    "source":     ref_section_id,
                    "target":     n["temp_id"],
                    "type":       "contains",
                    "strength":   "weak",
                    "confidence": 0.8,
                    "notes":      "auto-linked",
                })

    result = {"nodes": nodes, "edges": edges}
    _og_cache[cache_key] = (file_mtime, result)
    return result




def list_graph_versions(cluster_id: str,
                        model: str = DEFAULT_MODEL) -> list[str]:
    d = cluster_dir(cluster_id, model) / "agent_outputs"
    if not d.exists():
        return []
    names: list[str] = []
    for f in sorted(d.glob("build_v*.json")):
        if ".partial" not in f.name:
            names.append(f.stem.replace("build_", ""))
    for f in sorted(d.glob("update_v*.json")):
        if ".partial" not in f.name:
            stem = f.stem.replace("update_", "")
            if stem not in names:
                names.append(stem)
    return names


def _keyword_match_score(keywords: list[str], title: str, node: dict[str, Any]) -> int:
    text = " ".join([
        node.get("title", ""),
        node.get("content_summary", ""),
        node.get("parent_section", ""),
    ])
    score = sum(1 for kw in keywords if kw and kw in text)

    score += sum(1 for kw in keywords if kw and kw in node.get("title", ""))

    for word in title:
        if len(word) >= 2 and word in node.get("title", ""):
            score += 1
    return score


def _find_best_og_match(delta: dict[str, Any],
                        base_nodes: list[dict[str, Any]]) -> Optional[str]:
    keywords = delta.get("topic_keywords", [])
    title    = delta.get("title", "")
    best_score, best_id = 0, None
    for node in base_nodes:
        if node.get("type") == "Reference" or node.get("is_delta"):
            continue
        s = _keyword_match_score(keywords, title, node)
        if s > best_score:
            best_score, best_id = s, node.get("temp_id")
    return best_id if best_score >= 2 else None


def _ref_to_node(ref: dict[str, Any], ref_version: str) -> dict[str, Any]:
    num = ref.get("ref_number", 0)
    return {
        "temp_id":    f"REF-{num:03d}",
        "type":       "Reference",
        "title":      ref.get("title") or f"参考文献[{num}]",
        "author":     ref.get("author", ""),
        "url":        ref.get("url", ""),
        "publish_date": ref.get("publish_date", ""),
        "data_year":  str(ref.get("data_year", "")),
        "tier":       ref.get("tier", "T2"),
        "confidence": 1.0,
        "is_delta":   True,
        "delta_version": ref_version,
        "ref_number": num,
    }


def _delta_to_node(delta: dict[str, Any], delta_version: str) -> dict[str, Any]:
    return {
        "temp_id":       delta["id"],
        "type":          "Finding",
        "title":         delta.get("title", ""),
        "content_summary": (delta.get("content") or "")[:400],
        "data_year":     str(delta.get("data_year", "")),
        "cited_refs":    delta.get("cited_refs", []),
        "confidence":    0.9,
        "tier":          "T2",
        "is_delta":      True,
        "delta_version": delta_version,
        "target_op":     delta.get("target_op", "CREATE"),
        "target_node":   delta.get("target_node"),
    }


def read_graph_json(cluster_id: str, version: str = "latest",
                    model: str = DEFAULT_MODEL) -> Optional[dict]:
    d = cluster_dir(cluster_id, model) / "agent_outputs"
    if not d.exists():
        return None

    versions = list_graph_versions(cluster_id, model)
    if not versions:
        return None
    if version == "latest":
        version = versions[-1]


    build_path = d / "build_v1.json"
    if not build_path.exists():
        return None
    base = json.loads(build_path.read_text(encoding="utf-8"))

    nodes_raw = base.get("nodes", {})
    if isinstance(nodes_raw, dict):
        nodes: list[dict] = list(nodes_raw.values())
    else:
        nodes = list(nodes_raw)
    edges: list[dict] = list(base.get("edges", []))

    if version == "v1":
        return {"nodes": nodes, "edges": edges}


    try:
        target_idx = versions.index(version)
    except ValueError:
        target_idx = len(versions) - 1

    existing_ids: set[str] = {n.get("temp_id", "") for n in nodes}
    edge_idx = len(edges)

    for ver in versions[1: target_idx + 1]:
        upd_path = d / f"update_{ver}.json"
        if not upd_path.exists():
            continue
        upd = json.loads(upd_path.read_text(encoding="utf-8"))


        for ref in upd.get("new_references", []):
            node = _ref_to_node(ref, ver)
            if node["temp_id"] not in existing_ids:
                nodes.append(node)
                existing_ids.add(node["temp_id"])


        for delta in upd.get("deltas", []):
            fn = _delta_to_node(delta, ver)
            if fn["temp_id"] not in existing_ids:
                nodes.append(fn)
                existing_ids.add(fn["temp_id"])


            for ref_num in delta.get("cited_refs", []):
                ref_id = f"REF-{int(ref_num):03d}"
                if ref_id in existing_ids:
                    edges.append({
                        "source":     fn["temp_id"],
                        "target":     ref_id,
                        "type":       "cites",
                        "strength":   "medium",
                        "confidence": 0.95,
                    })
                    edge_idx += 1


            if delta.get("target_op") in ("AUGMENT", "SUPERSEDE"):
                matched = _find_best_og_match(delta, nodes)
                if matched:
                    edge_type = "supersedes" if delta["target_op"] == "SUPERSEDE" else "augments"
                    edges.append({
                        "source":     fn["temp_id"],
                        "target":     matched,
                        "type":       edge_type,
                        "strength":   "strong",
                        "confidence": 0.75,
                        "reason":     f"关键词匹配: {delta.get('topic_keywords', [])[:3]}",
                    })
                    edge_idx += 1

    return {"nodes": nodes, "edges": edges}




def detect_periods_from_refs(cluster_id: str,
                             model: str = DEFAULT_MODEL) -> dict[str, list[int]]:
    base = cluster_dir(cluster_id, DEFAULT_MODEL)
    result: dict[str, list[int]] = {}
    for v_dir in sorted(base.glob("reference_texts_v*")):
        v_str = v_dir.name.replace("reference_texts_", "")
        years: list[int] = []
        for f in v_dir.glob("*.txt"):
            try:
                content = f.read_text(encoding="utf-8", errors="replace")
                yr = extract_ref_year(content)
                if yr:
                    years.append(yr)
            except OSError:
                pass
        if years:
            result[v_str] = [min(years), max(years)]


    if len(result) > 1:
        sorted_keys = sorted(result, key=lambda k: result[k][0])
        for i in range(len(sorted_keys) - 1):
            cur_key  = sorted_keys[i]
            next_key = sorted_keys[i + 1]
            if result[cur_key][1] >= result[next_key][0]:
                result[cur_key][1] = result[next_key][0] - 1

        result = {k: result[k] for k in sorted_keys}

    return result




def list_reports(cluster_id: str,
                 model: str = DEFAULT_MODEL) -> list[dict[str, Any]]:
    d = cluster_dir(cluster_id, model) / "output"
    if not d.exists():
        return []
    reports = []
    for f in sorted(d.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
        stat = f.stat()
        reports.append({
            "filename": f.name,
            "size":     stat.st_size,
            "mtime":    stat.st_mtime,
        })
    return reports


def read_report(cluster_id: str, filename: str,
                model: str = DEFAULT_MODEL) -> Optional[str]:
    p = cluster_dir(cluster_id, model) / "output" / filename
    if not p.exists():
        return None
    return p.read_text(encoding="utf-8", errors="replace")


def delete_report(cluster_id: str, filename: str,
                  model: str = DEFAULT_MODEL) -> bool:
    p = cluster_dir(cluster_id, model) / "output" / filename
    if p.exists():
        p.unlink()
        return True
    return False




def invalidate_stats_cache(cluster_id: str, model: str = DEFAULT_MODEL) -> None:
    key = f"{cluster_id}:{model}"
    _stats_cache.pop(key, None)


def cluster_stats(cluster_id: str,
                  model: str = DEFAULT_MODEL) -> dict[str, Any]:
    key = f"{cluster_id}:{model}"
    now = time.monotonic()
    if key in _stats_cache:
        ts, cached = _stats_cache[key]
        if now - ts < _STATS_TTL:
            return cached

    base = cluster_dir(cluster_id, model)
    base_ref = base if model == DEFAULT_MODEL else cluster_dir(cluster_id, DEFAULT_MODEL)
    version_count = len(list(base_ref.glob("reference_texts_v*")))
    ref_count     = sum(len(list(d.glob("*.txt")))
                        for d in base_ref.glob("reference_texts_v*"))
    report_count  = len(list((base / "output").glob("*.md"))) if (base / "output").exists() else 0
    has_og        = bool(list_og_versions(cluster_id, model))
    has_raw       = bool(list((base / "agent_outputs").glob("build_*.json"))) \
                    if (base / "agent_outputs").exists() else False
    result = {
        "version_count": version_count,
        "ref_count":     ref_count,
        "report_count":  report_count,
        "has_graph":     has_og or has_raw,
    }
    _stats_cache[key] = (now, result)
    return result
