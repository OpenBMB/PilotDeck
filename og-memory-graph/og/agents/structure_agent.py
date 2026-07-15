from __future__ import annotations

from pathlib import Path
from typing import Optional


class StructureAgent:

    def __init__(self,
                 merge_cache: Optional[Path] = None,
                 reparent_cache: Optional[Path] = None,
                 merge_model: Optional[str] = None,
                 reparent_model: Optional[str] = None):
        self._merge_cache = merge_cache
        self._reparent_cache = reparent_cache
        self._merge_model = merge_model
        self._reparent_model = reparent_model
        self._merge_agent = None
        self._reparent_agent = None
        self._renumber_agent = None

    def _lazy_merge(self):
        if self._merge_agent is None:
            from og.agents.section_merge_agent import SectionMergeAgent
            kwargs = {}
            if self._merge_cache is not None:
                kwargs["cache_dir"] = self._merge_cache
            if self._merge_model is not None:
                kwargs["model"] = self._merge_model
            self._merge_agent = SectionMergeAgent(**kwargs)
        return self._merge_agent

    def _lazy_reparent(self):
        if self._reparent_agent is None:
            from og.agents.node_reparent_agent import NodeReparentAgent
            kwargs = {}
            if self._reparent_cache is not None:
                kwargs["cache_dir"] = self._reparent_cache
            if self._reparent_model is not None:
                kwargs["model"] = self._reparent_model
            self._reparent_agent = NodeReparentAgent(**kwargs)
        return self._reparent_agent

    def _lazy_renumber(self):
        if self._renumber_agent is None:
            from og.agents.section_renumber_agent import SectionRenumberAgent
            self._renumber_agent = SectionRenumberAgent()
        return self._renumber_agent

    def merge_sections(self, og, version: str = "merged") -> dict:
        return self._lazy_merge().merge(og, version=version)

    def reparent_nodes(self, og, version: str = "reparent") -> dict:
        return self._lazy_reparent().reparent(og, version=version)

    def renumber(self, og) -> dict:
        return self._lazy_renumber().renumber(og)

    def run_all(self, og, version: str = "v1.0") -> dict:
        return {
            "merge":    self.merge_sections(og, version=f"{version}-merged"),
            "reparent": self.reparent_nodes(og, version=f"{version}-reparent"),
            "renumber": self.renumber(og),
        }
