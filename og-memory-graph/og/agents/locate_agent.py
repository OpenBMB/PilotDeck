from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import json
import re
from pathlib import Path

from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus
from og.core.edge import EdgeType
from og.storage.vector_store import VectorStore






_METADATA_KEYWORDS = [
    "更新时间", "最新更新时间", "last_updated", "updated_at",
    "时间戳", "timestamp", "最后修改时间", "last_modified",
    "dream_updated_at",
]
_METADATA_TITLE_PATTERNS = [
    "更新时间", "最新更新时间", "时间修正", "时间更新",
    "MEMORY.md 最后更新时间", "MEMORY.md 更新时间",
]


def _is_metadata_delta(delta: dict) -> bool:
    title = (delta.get("title") or "").lower()
    content = (delta.get("content") or delta.get("summary") or "").lower()
    combined = title + " " + content


    for pat in _METADATA_TITLE_PATTERNS:
        if pat.lower() in title:
            return True

    has_ts = bool(re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", combined))
    has_kw = any(kw.lower() in combined for kw in _METADATA_KEYWORDS)
    if has_ts and has_kw:
        return True
    return False

try:
    from config_models import (
        LOCATE_VERIFICATION_TOP_K,
        LOCATE_CONFLICT_STRATEGY,
        LOCATE_VERIFICATION_USE_FULL_CONTENT,
    )
except ImportError:
    LOCATE_VERIFICATION_TOP_K = 10
    LOCATE_CONFLICT_STRATEGY = "hybrid"
    LOCATE_VERIFICATION_USE_FULL_CONTENT = True


@dataclass
class LocateResult:
    node: OGNode
    operation: str
    score: float
    confidence: float
    reason: str



    source: str = "fine"
    section_id: str | None = None


    llm_target_node: str | None = None
    retrieval_top_node_id: str | None = None
    retrieval_top_score: float | None = None
    retrieval_top_rerank_score: float | None = None
    retrieval_top_rrf_score: float | None = None
    retrieval_top_raw_score: float | None = None
    retrieval_top_has_rerank_score: bool | None = None
    verification_agreement: bool | None = None
    decision: str | None = None



DEFAULT_TOP_K_CHUNKS = 20
DEFAULT_COARSE_KEEP = None
DEFAULT_FINE_RESULTS_LIMIT = None


class LocateAgent:

    def __init__(
        self,
        agent_output: Optional[dict] = None,
        id_map: Optional[dict] = None,
        top_k_chunks: int = DEFAULT_TOP_K_CHUNKS,
        max_coarse_sections: int | None = DEFAULT_COARSE_KEEP,
        max_fine_results: int | None = DEFAULT_FINE_RESULTS_LIMIT,
    ):
        self.agent_output = agent_output
        self.id_map = id_map or {}
        self.top_k_chunks = top_k_chunks
        self.max_coarse_sections = max_coarse_sections
        self.max_fine_results = max_fine_results



    def locate(self, og: OutlineGraph, delta: dict,
                vector_store: VectorStore) -> list[LocateResult]:
        if self.agent_output and delta.get("id") in self.agent_output:
            return self._from_precomputed(og, delta)



        ver_hits = self._verification_retrieval(og, delta, vector_store)
        ver_top = ver_hits[0] if ver_hits else {}
        ver_top_node_id = ver_top.get("node_id")
        ver_top_score = ver_top.get("score")
        ver_top_rerank_score = ver_top.get("rerank_score")
        ver_top_rrf_score = ver_top.get("rrf_score")
        ver_top_raw_score = ver_top.get("raw_score")
        ver_top_has_rerank_score = ver_top.get("has_rerank_score")

        primary: list[LocateResult] = []

        if delta.get("target_node") and delta.get("target_op"):
            target_temp = delta["target_node"]
            real_id = self.id_map.get(target_temp)
            llm_node = og.get_node(real_id) if real_id else None
            src = "id_map"
            if llm_node is None or llm_node.status != NodeStatus.ACTIVE:
                llm_node = self._find_node_by_temp_id(og, target_temp)
                src = "temp_id_fuzzy"

            if llm_node is not None:

                ver_ids = {h["node_id"] for h in ver_hits}
                agree = (llm_node.id in ver_ids)

                strategy = (LOCATE_CONFLICT_STRATEGY or "hybrid").lower()
                if agree or strategy == "trust_llm":
                    decision = "trust_llm"
                    if not agree and strategy == "trust_llm":
                        decision = "trust_llm_override"
                    primary.append(LocateResult(
                        node=llm_node, operation=delta["target_op"],
                        score=0.95, confidence=0.9 if agree else 0.75,
                        reason=(f"LLM 选 {target_temp}, verification "
                                f"{'agree (top-10 命中)' if agree else 'disagree'}; "
                                f"decision={decision}"),
                        source=src + ("_verified" if agree else ""),
                        section_id=self._enclosing_section_id(og, llm_node),
                        llm_target_node=target_temp,
                        retrieval_top_node_id=ver_top_node_id,
                        retrieval_top_score=ver_top_score,
                        retrieval_top_rerank_score=ver_top_rerank_score,
                        retrieval_top_rrf_score=ver_top_rrf_score,
                        retrieval_top_raw_score=ver_top_raw_score,
                        retrieval_top_has_rerank_score=ver_top_has_rerank_score,
                        verification_agreement=agree,
                        decision=decision,
                    ))
                else:

                    ret_node = og.get_node(ver_top_node_id) if ver_top_node_id else None
                    if ret_node is not None and ret_node.status == NodeStatus.ACTIVE \
                            and ret_node.type not in (NodeType.SECTION, NodeType.REFERENCE):

                        op = self._determine_operation(ret_node, delta)
                        primary.append(LocateResult(
                            node=ret_node, operation=op,
                            score=float(ver_top_score or 0.85),
                            confidence=0.7,
                            reason=(f"LLM 选 {target_temp} 但不在 verification "
                                    f"top-{LOCATE_VERIFICATION_TOP_K}; 改用检索 top-1 "
                                    f"{ret_node.id}; decision=trust_retrieval"),
                            source="retrieval_override",
                            section_id=self._enclosing_section_id(og, ret_node),
                            llm_target_node=target_temp,
                            retrieval_top_node_id=ver_top_node_id,
                            retrieval_top_score=ver_top_score,
                            retrieval_top_rerank_score=ver_top_rerank_score,
                            retrieval_top_rrf_score=ver_top_rrf_score,
                            retrieval_top_raw_score=ver_top_raw_score,
                            retrieval_top_has_rerank_score=ver_top_has_rerank_score,
                            verification_agreement=False,
                            decision="trust_retrieval",
                        ))
                    else:

                        primary.append(LocateResult(
                            node=llm_node, operation=delta["target_op"],
                            score=0.85, confidence=0.6,
                            reason=(f"LLM 选 {target_temp}, verification 无可用 top-1, "
                                    f"兜底信 LLM"),
                            source=src + "_fallback",
                            section_id=self._enclosing_section_id(og, llm_node),
                            llm_target_node=target_temp,
                            retrieval_top_node_id=ver_top_node_id,
                            retrieval_top_score=ver_top_score,
                            retrieval_top_rerank_score=ver_top_rerank_score,
                            retrieval_top_rrf_score=ver_top_rrf_score,
                            retrieval_top_raw_score=ver_top_raw_score,
                            retrieval_top_has_rerank_score=ver_top_has_rerank_score,
                            verification_agreement=False,
                            decision="trust_llm_fallback",
                        ))


        coarse = self.locate_coarse(og, delta)

        fine = self._fine_results_from_verification(og, delta, ver_hits, coarse)

        if not fine:
            fine = self.locate_fine(og, delta, vector_store, coarse_sections=coarse)


        merged: dict[str, LocateResult] = {}
        for r in primary + fine:
            if r.node.id not in merged or r.score > merged[r.node.id].score:
                merged[r.node.id] = r

        results = sorted(merged.values(), key=lambda x: -x.score)


        if not results:
            best_section = coarse[0] if coarse else None
            if best_section is None:
                root = og.get_root()
                if root is not None:
                    sections = og.get_children(root.id, NodeType.SECTION)
                    best_section = sections[0] if sections else None
            if best_section is not None:
                results.append(LocateResult(
                    node=best_section, operation="CREATE",
                    score=0.0, confidence=0.6,
                    reason="无匹配节点, 推荐在最相关 section 下新建",
                    source="new_section",
                    section_id=best_section.id,
                ))

        if self.max_fine_results is not None and len(results) > self.max_fine_results:
            results = results[: self.max_fine_results]
        return results



    def _verification_retrieval(self, og: OutlineGraph, delta: dict,
                                 vector_store: VectorStore) -> list[dict]:
        delta_title = (delta.get("title") or "").strip()
        delta_content = (delta.get("content") or "").strip()
        if not delta_content and not delta_title:
            return []
        if LOCATE_VERIFICATION_USE_FULL_CONTENT:
            query = (delta_title + "。" + delta_content) if delta_title else delta_content
        else:
            query = (delta_title + "。" + delta_content[:600]) if delta_title else delta_content[:600]
        if not query.strip():
            return []

        try:
            hits = vector_store.search(query, top_k=max(LOCATE_VERIFICATION_TOP_K * 3, 30))
        except Exception as e:
            print(f"      [warn] verification retrieval failed: {e}")
            return []
        seen_nodes: dict[str, dict] = {}
        for h in hits:
            md = h.get("metadata") or {}
            node_id = md.get("node_id") or md.get("ref_id")
            if not node_id:
                continue
            node = og.get_node(node_id)
            if not node or node.status != NodeStatus.ACTIVE:
                continue
            if node.type in (NodeType.SECTION, NodeType.REFERENCE):
                continue
            existing = seen_nodes.get(node_id)
            raw_score = h.get("score")
            rerank_score = h.get("rerank_score")
            rrf_score = h.get("rrf_score")
            score = float(rerank_score if rerank_score is not None else raw_score if raw_score is not None else rrf_score if rrf_score is not None else 0.0)
            if existing is None or score > existing["score"]:
                seen_nodes[node_id] = {
                    "chunk_id": h.get("chunk_id"),
                    "node_id": node_id,
                    "score": score,
                    "raw_score": float(raw_score) if raw_score is not None else None,
                    "rerank_score": float(rerank_score) if rerank_score is not None else None,
                    "rrf_score": float(rrf_score) if rrf_score is not None else None,
                    "has_rerank_score": rerank_score is not None,
                    "text": h.get("text", ""),
                    "section_id": self._enclosing_section_id(og, node),
                }
            if len(seen_nodes) >= LOCATE_VERIFICATION_TOP_K:
                break
        return sorted(seen_nodes.values(), key=lambda d: -d["score"])

    def _fine_results_from_verification(
        self, og: OutlineGraph, delta: dict,
        ver_hits: list[dict], coarse_sections: list[OGNode],
    ) -> list[LocateResult]:
        if not ver_hits:
            return []
        coarse_ids = {s.id for s in coarse_sections} if coarse_sections else None
        out: list[LocateResult] = []
        for hit in ver_hits:
            node = og.get_node(hit["node_id"])
            if not node:
                continue
            sec_id = hit.get("section_id")
            if coarse_ids is not None and sec_id and sec_id not in coarse_ids:

                continue
            op = self._determine_operation(node, delta)
            out.append(LocateResult(
                node=node, operation=op,
                score=hit["score"], confidence=0.8,
                reason=f"verification fine: chunk score={hit['score']:.2f}",
                source="fine",
                section_id=sec_id,
                retrieval_top_node_id=hit.get("node_id"),
                retrieval_top_score=hit.get("score"),
                retrieval_top_rerank_score=hit.get("rerank_score"),
                retrieval_top_rrf_score=hit.get("rrf_score"),
                retrieval_top_raw_score=hit.get("raw_score"),
                retrieval_top_has_rerank_score=hit.get("has_rerank_score"),
            ))
        return out



    def locate_coarse(self, og: OutlineGraph, delta: dict) -> list[OGNode]:
        root = og.get_root()
        if not root:
            return []


        all_sections: list[OGNode] = []
        for n in og.get_all_nodes(NodeType.SECTION, NodeStatus.ACTIVE):
            if n.id == root.id:
                continue
            all_sections.append(n)
        if not all_sections:
            return []

        keywords = [kw for kw in delta.get("topic_keywords", []) if isinstance(kw, str) and kw]
        delta_title = (delta.get("title") or "").strip()
        delta_content = delta.get("content", "") or ""

        scored: list[tuple[float, OGNode]] = []
        for sec in all_sections:
            score = 0.0
            haystack = (sec.title or "") + " " + (sec.content_summary or "")
            for kw in keywords:
                if kw in haystack:
                    score += 1.0
            if delta_title and sec.title:
                if delta_title in sec.title or sec.title in delta_title:
                    score += 2.0
            if sec.title and sec.title in delta_content:
                score += 1.5
            t_lower = (sec.title or "").lower()
            if any(k in t_lower for k in ["结论", "展望", "摘要", "summary"]):
                score += 0.5
            if score > 0:
                scored.append((score, sec))

        scored.sort(key=lambda x: -x[0])
        if not scored:

            top = og.get_children(root.id, NodeType.SECTION)
            return [s for s in top if s.status == NodeStatus.ACTIVE]

        out = [s for _, s in scored]
        if self.max_coarse_sections is not None:
            out = out[: self.max_coarse_sections]
        return out



    def locate_fine(self, og: OutlineGraph, delta: dict,
                     vector_store: VectorStore,
                     coarse_sections: list[OGNode] | None = None
                     ) -> list[LocateResult]:
        if coarse_sections is None:
            coarse_sections = self.locate_coarse(og, delta)
        if not coarse_sections:
            return []


        delta_title = (delta.get("title") or "").strip()
        delta_content = (delta.get("content") or "").strip()

        query = (delta_title + "。" + delta_content[:600]) if delta_title else delta_content[:600]
        if not query.strip():
            return []

        merged: dict[str, LocateResult] = {}
        for sec in coarse_sections:
            try:
                hits = vector_store.search_in_section(query, sec.id,
                                                       top_k=self.top_k_chunks)
            except Exception as e:

                hits = []
            for hit in hits:
                node_id = hit["metadata"].get("node_id", "")
                if not node_id:
                    continue
                node = og.get_node(node_id)
                if not node or node.status != NodeStatus.ACTIVE:
                    continue
                if node.type in (NodeType.SECTION, NodeType.REFERENCE):
                    continue
                op = self._determine_operation(node, delta)
                lr = LocateResult(
                    node=node, operation=op,
                    score=float(hit.get("score", 0.0)),
                    confidence=0.8,
                    reason=f"chunk match @ section '{sec.title}'  score={hit.get('score', 0.0):.2f}",
                    source="fine",
                    section_id=sec.id,
                )
                if node.id not in merged or lr.score > merged[node.id].score:
                    merged[node.id] = lr

        results = sorted(merged.values(), key=lambda x: -x.score)
        return results



    @staticmethod
    def _enclosing_section_id(og: OutlineGraph, node: OGNode) -> str | None:
        for e in og.get_incoming_edges(node.id, EdgeType.CONTAINS):
            pn = og.get_node(e.source_id)
            if pn and pn.type == NodeType.SECTION:
                return pn.id
        return None

    def _find_node_by_temp_id(self, og: OutlineGraph,
                                temp_id: str) -> Optional[OGNode]:
        if not temp_id:
            return None
        for node in og.get_all_nodes():
            if node.status != NodeStatus.ACTIVE:
                continue
            if temp_id in node.title or temp_id in node.id:
                return node
            keywords = [kw for kw in temp_id.replace("-", " ").replace("_", " ").lower().split()
                        if len(kw) > 2]
            if keywords and any(kw in (node.title or "").lower() for kw in keywords):
                return node
        return None

    @staticmethod
    def _determine_operation(node: OGNode, delta: dict) -> str:
        delta_year = delta.get("data_year")
        node_year = None
        try:
            ts = node.temporal_scope
            if isinstance(ts, str) and ts.isdigit():
                node_year = int(ts)
        except (ValueError, AttributeError):
            pass

        if delta.get("delta_type") == "correction":
            return "UPDATE"



        if _is_metadata_delta(delta):
            return "AUGMENT"

        if delta_year and node_year and delta_year > node_year:
            return "SUPERSEDE"
        if node.type == NodeType.CONTEXT and delta.get("delta_type") == "context_shift":
            return "RECONTEXTUALIZE"
        return "AUGMENT"

    def _from_precomputed(self, og: OutlineGraph, delta: dict) -> list[LocateResult]:
        results = []
        for entry in self.agent_output[delta["id"]]:
            node = og.get_node(entry["node_id"])
            if node:
                results.append(LocateResult(
                    node=node, operation=entry["operation"],
                    score=entry.get("score", 0.8),
                    confidence=entry.get("confidence", 0.9),
                    reason=entry.get("reason", "预生成"),
                    source="precomputed",
                    section_id=self._enclosing_section_id(og, node),
                ))
        return results
