from __future__ import annotations
from pathlib import Path
from og.core.graph import OutlineGraph


class GraphStore:

    def __init__(self, store_dir: Path):
        self.store_dir = store_dir
        self.store_dir.mkdir(parents=True, exist_ok=True)
        self._graphs: dict[str, OutlineGraph] = {}
        self._global_refs: dict[str, str] = {}

    def _graph_path(self, report_id: str, version: str) -> Path:
        return self.store_dir / f"og_{report_id}_{version}.json"

    def _curated_path(self, report_id: str, version: str) -> Path:
        return self.store_dir / f"og_{report_id}_{version}_curated.json"

    def save(self, og: OutlineGraph):
        path = self._graph_path(og.report_id, og.version)
        og.save(path)
        self._graphs[f"{og.report_id}_{og.version}"] = og
        self._register_refs(og)

    def save_curated(self, og: OutlineGraph):
        path = self._curated_path(og.report_id, og.version)
        og.save(path)
        self._graphs[f"{og.report_id}_{og.version}"] = og
        self._register_refs(og)

    def load(self, report_id: str, version: str) -> OutlineGraph:
        key = f"{report_id}_{version}"
        if key in self._graphs:
            return self._graphs[key]

        curated = self._curated_path(report_id, version)
        path = curated if curated.exists() else self._graph_path(report_id, version)
        if not path.exists():

            alt = version.lstrip("vV")
            if alt != version:
                alt_path = self._graph_path(report_id, alt)
                if alt_path.exists():
                    path = alt_path
        og = OutlineGraph.load(path)
        self._graphs[key] = og
        return og

    def _register_refs(self, og: OutlineGraph):
        from og.core.node import NodeType
        for node in og.get_all_nodes(NodeType.REFERENCE):
            ref_key = f"{node.author}_{node.title}"
            if ref_key not in self._global_refs:
                self._global_refs[ref_key] = node.id
