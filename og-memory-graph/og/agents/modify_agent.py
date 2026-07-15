from __future__ import annotations
import os
from typing import Optional
from og.core.graph import OutlineGraph
from og.core.node import OGNode, NodeType, NodeStatus, DataBlock, ChangeLogEntry, StalenessRisk
from og.core.edge import OGEdge, EdgeType, EdgeStrength
from og.storage.vector_store import VectorStore
from og.storage.yaml_store import YAMLStore


AUGMENT_COMPRESS_THRESHOLD = int(os.environ.get("AUGMENT_COMPRESS_THRESHOLD", "1500"))


class ModifyAgent:

    def __init__(self, vector_store: VectorStore, yaml_store: YAMLStore):
        self.vs = vector_store
        self.ys = yaml_store

    def execute(self, og: OutlineGraph, target: OGNode, operation: str,
                delta: dict, version: str) -> OGNode:
        ops = {
            "CREATE": self._create,
            "UPDATE": self._update,
            "SUPERSEDE": self._supersede,
            "AUGMENT": self._augment,
            "DELETE": self._delete,
            "RECONTEXTUALIZE": self._recontextualize,
            "SPLIT": self._split,
        }
        handler = ops.get(operation)
        if not handler:
            raise ValueError(f"Unknown operation: {operation}")


        if operation != "CREATE" and target is not None:
            self._snapshot_target(target)
        return handler(og, target, delta, version)

    @staticmethod
    def _snapshot_target(node: OGNode) -> None:
        v = node.last_updated_version or "v?.?"
        if v in node.snapshot_version_history:
            return

        snap = node.to_dict()
        snap.pop("snapshot_version_history", None)
        node.snapshot_version_history[v] = snap

    def _create(self, og: OutlineGraph, parent: OGNode, delta: dict, version: str) -> OGNode:
        from og.core.node import RhetoricalRole as RR
        role_str = delta.get("rhetorical_role", "evidence")
        role = RR(role_str) if isinstance(role_str, str) else role_str
        new_node = OGNode(
            id=og.generate_id(),
            type=NodeType(delta.get("node_type", "Evidence")),
            title=delta.get("title", delta.get("content", "")[:30]),
            rhetorical_role=role,
            content_summary=delta.get("content", ""),
            data_blocks=[DataBlock(**db) for db in delta.get("data_points", [])],
            cited_refs=delta.get("cited_refs", []),
            temporal_scope=str(delta.get("data_year", "")),
            staleness_risk=StalenessRisk.HIGH,
            confidence=delta.get("confidence", 0.8),
            created_in_version=version,
            last_updated_version=version,
            change_log=[ChangeLogEntry(version, "CREATE", delta.get("id"), description="新建节点")]
        )
        og.add_node(new_node)
        og.add_edge(OGEdge(parent.id, new_node.id, EdgeType.CONTAINS, created_in_version=version))

        self._sync_vector_create(new_node, parent)
        self.ys.append_changelog("", version, {"action": "CREATE", "node_id": new_node.id,
                                                "delta_id": delta.get("id")})
        return new_node

    def _update(self, og: OutlineGraph, target: OGNode, delta: dict, version: str) -> OGNode:
        old_summary = target.content_summary
        target.content_summary = delta.get("content", target.content_summary)
        for db_dict in delta.get("data_points", []):
            target.data_blocks.append(DataBlock(**db_dict))
        target.temporal_scope = str(delta.get("data_year", target.temporal_scope))
        target.last_updated_version = version
        target.change_log.append(ChangeLogEntry(
            version, "UPDATE", delta.get("id"),
            description=f"就地更新",
            details={"old_summary": old_summary[:100]}
        ))
        og.update_node(target)

        self.vs.delete_by_node(target.id)
        self._sync_vector_create(target, None)
        return target

    def _supersede(self, og: OutlineGraph, old_node: OGNode, delta: dict, version: str) -> OGNode:



        delta_blocks = [DataBlock(**db) for db in delta.get("data_points", [])]
        delta_ids = {db.data_id for db in delta_blocks if db.data_id}
        inherited_blocks = [db for db in old_node.data_blocks if db.data_id not in delta_ids]
        merged_blocks = inherited_blocks + delta_blocks


        old_summary = old_node.content_summary or ""
        delta_content = delta.get("content", "")
        merged_summary = (old_summary + "\n" + delta_content).strip() if delta_content else old_summary

        new_node = OGNode(
            id=og.generate_id(),
            type=old_node.type,
            title=delta.get("title", old_node.title),
            rhetorical_role=old_node.rhetorical_role,
            content_summary=merged_summary,
            data_blocks=merged_blocks,
            cited_refs=list(set((delta.get("cited_refs", []) or []) + list(old_node.cited_refs))),
            temporal_scope=str(delta.get("data_year", old_node.temporal_scope or "")),
            staleness_risk=old_node.staleness_risk,
            confidence=delta.get("confidence", 0.85),
            created_in_version=version,
            last_updated_version=version,
            change_log=[ChangeLogEntry(version, "SUPERSEDE", delta.get("id"),
                                       description=f"替代{old_node.id}（合并式：继承旧节点信息）")]
        )
        og.add_node(new_node)

        for edge in og.get_outgoing_edges(old_node.id):
            if edge.type != EdgeType.SUPERSEDES:
                og.add_edge(OGEdge(new_node.id, edge.target_id, edge.type,
                                   edge.strength, version, f"从{old_node.id}迁移"))
                og.remove_edge(edge)

        for edge in og.get_incoming_edges(old_node.id, EdgeType.CONTAINS):
            og.add_edge(OGEdge(edge.source_id, new_node.id, EdgeType.CONTAINS,
                               created_in_version=version))

        og.add_edge(OGEdge(old_node.id, new_node.id, EdgeType.SUPERSEDES, created_in_version=version))
        old_node.status = NodeStatus.SUPERSEDED
        old_node.change_log.append(ChangeLogEntry(version, "SUPERSEDE", description=f"被{new_node.id}替代"))
        og.update_node(old_node)

        self.vs.update_node_status(old_node.id, "superseded")
        self._sync_vector_create(new_node, None)
        return new_node

    def _augment(self, og: OutlineGraph, target: OGNode, delta: dict, version: str) -> OGNode:
        for db_dict in delta.get("data_points", []):
            target.data_blocks.append(DataBlock(**db_dict))
        extra = delta.get("content", "")
        if extra:
            target.content_summary = target.content_summary + "\n" + extra

        compressed_from = None
        if len(target.content_summary) > AUGMENT_COMPRESS_THRESHOLD:
            compressed = self._llm_compress_content(
                target.content_summary,
                target.data_blocks,
                target.title,
            )
            if compressed and len(compressed) < len(target.content_summary):
                compressed_from = target.content_summary
                target.content_summary = compressed
        target.last_updated_version = version
        cl_details = {"compressed_from": compressed_from[:500]} if compressed_from else None
        target.change_log.append(ChangeLogEntry(version, "AUGMENT", delta.get("id"),
                                                description=("补充信息+LLM 压缩"
                                                             if compressed_from else "补充信息"),
                                                details=cl_details))
        og.update_node(target)
        self.vs.delete_by_node(target.id)
        self._sync_vector_create(target, None)
        return target

    def _llm_compress_content(self, long_text: str, data_blocks: list,
                                title: str) -> str | None:
        try:
            from openai import OpenAI
            try:
                from config_models import LLM_UTIL
            except ImportError:
                LLM_UTIL = "gpt-4o-mini"
            api_key = os.environ.get("OPENAI_API_KEY", "")
            if not api_key:
                return None
            base_url = os.environ.get("OPENAI_API_BASE", "https://yeysai.com/v1")
            client = OpenAI(api_key=api_key, base_url=base_url, timeout=60, max_retries=0)
            db_summary = "\n".join(
                f"- {db.label}: {db.value} ({db.data_year})"
                for db in data_blocks[:20]
            )
            sys_prompt = (
                "你是一位严谨的研究报告编辑助手. 给你一段经过多次 AUGMENT 拼接而成的"
                "OG 节点 content_summary, 它已经膨胀到 > 1500 字. 你的任务是\n"
                "**保留所有关键事实/数据/年份**, 重写成一段紧凑的客观陈述.\n\n"
                "硬约束:\n"
                "- 不要丢失 data_blocks 里出现过的任何数据点\n"
                "- 不要刻意压缩到固定字数 (LLM 自决), 但目标是 30-60% 原长\n"
                "- 行文流畅, 不要列表, 不要 markdown\n"
                "- 直接输出重写后的 content (不要解释, 不要前后文)"
            )
            user_msg = (
                f"【节点 title】 {title}\n\n"
                f"【data_blocks 事实】\n{db_summary}\n\n"
                f"【当前 content_summary (需压缩)】\n{long_text}"
            )
            r = client.chat.completions.create(
                model=LLM_UTIL,
                messages=[
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_msg},
                ],
                temperature=0.0, max_tokens=4000,
            )
            new_text = (r.choices[0].message.content or "").strip()
            return new_text or None
        except Exception as e:
            print(f"  [warn] AUGMENT 压缩失败 ({type(e).__name__}: {str(e)[:60]}), "
                  f"保留原文")
            return None

    def _delete(self, og: OutlineGraph, target: OGNode, delta: dict, version: str) -> OGNode:
        target.status = NodeStatus.DEPRECATED
        target.change_log.append(ChangeLogEntry(version, "DELETE", delta.get("id"),
                                                description=delta.get("reason", "内容被证伪")))
        og.update_node(target)
        self.vs.update_node_status(target.id, "deprecated")
        return target

    def _recontextualize(self, og: OutlineGraph, target: OGNode, delta: dict, version: str) -> OGNode:
        self._update(og, target, delta, version)
        target.change_log[-1].action = "RECONTEXTUALIZE"

        affected_ids = []
        for edge in og.get_outgoing_edges(target.id, EdgeType.CONTEXTUALIZES):
            claim = og.get_node(edge.target_id)
            if claim and claim.status == NodeStatus.ACTIVE:
                claim.change_log.append(ChangeLogEntry(
                    version, "RECONTEXTUALIZE",
                    description=f"背景节点{target.id}发生变化，措辞可能需调整"
                ))
                og.update_node(claim)
                affected_ids.append(claim.id)
        return target

    def _split(self, og: OutlineGraph, target: OGNode, delta: dict, version: str) -> OGNode:
        sub_units = delta.get("sub_units", [])
        parent_edges = og.get_incoming_edges(target.id, EdgeType.CONTAINS)
        parent_id = parent_edges[0].source_id if parent_edges else None

        new_nodes = []
        for unit in sub_units:
            unit["confidence"] = unit.get("confidence", 0.7)
            if parent_id:
                parent = og.get_node(parent_id)
                nn = self._create(og, parent, unit, version)
                new_nodes.append(nn)

        target.status = NodeStatus.DEPRECATED
        target.change_log.append(ChangeLogEntry(version, "SPLIT", description=f"拆分为{len(new_nodes)}个子节点"))
        og.update_node(target)
        self.vs.update_node_status(target.id, "deprecated")
        return new_nodes[0] if new_nodes else target

    def _sync_vector_create(self, node: OGNode, parent: Optional[OGNode]):
        section_id = ""
        if parent and parent.type == NodeType.SECTION:
            section_id = parent.id
        meta = {
            "node_type": node.type.value,
            "section_id": section_id,
            "temporal_scope": node.temporal_scope,
            "node_status": node.status.value,
            "report_id": "01",
        }
        self.vs.add_node_chunks(
            node.id, node.content_summary,
            [vars(db) for db in node.data_blocks], meta
        )
