from __future__ import annotations
from typing import Optional
import json
from pathlib import Path

from og.core.graph import OutlineGraph
from og.storage.graph_store import GraphStore
from og.storage.vector_store import VectorStore
from og.storage.yaml_store import YAMLStore
from og.agents.locate_agent import LocateAgent
from og.agents.modify_agent import ModifyAgent
from og.agents.propagate_agent import PropagateAgent
from og.agents.validate_agent import ValidateAgent
from og.agents.render_agent import RenderAgent


class UpdatePipeline:

    def __init__(self, graph_store: GraphStore, vector_store: VectorStore,
                 yaml_store: YAMLStore):
        self.gs = graph_store
        self.vs = vector_store
        self.ys = yaml_store

    def run(self, og: OutlineGraph, deltas: list[dict], new_version: str,
            new_base_year: int, agent_output_path: Optional[Path] = None,
            _deltas_override: Optional[list] = None) -> OutlineGraph:
        old_version = og.version
        og.version = new_version
        og.base_year = new_base_year

        print(f"\n{'='*60}")
        print(f"[UpdatePipeline] {old_version} → {new_version} (base_year={new_base_year})")
        print(f"  收到 {len(deltas)} 条 Delta")
        print(f"{'='*60}")

        locate_output = None
        id_map = {}
        if agent_output_path and agent_output_path.exists():
            with open(agent_output_path, encoding="utf-8") as f:
                data = json.load(f)
                locate_output = data.get("locate", {})

                for ref_data in data.get("new_references", []):
                    self._add_reference(og, ref_data, new_version)


        import glob
        for p in sorted(glob.glob(str(self.gs.store_dir / "id_map_*.json"))):
            with open(p) as f:
                id_map.update(json.load(f))


        locate_agent = LocateAgent(locate_output, id_map)
        all_locate_results = []
        for delta in deltas:
            results = locate_agent.locate(og, delta, self.vs)
            for r in results:
                all_locate_results.append((delta, r))
            if results:
                print(f"  Delta '{delta.get('id','?')}' → {results[0].operation} "
                      f"@{results[0].node.title[:30]} (score={results[0].score:.2f})")
            else:
                print(f"  Delta '{delta.get('id','?')}' → 无匹配")


        node_ops = {}
        for delta, lr in all_locate_results:
            key = lr.node.id
            if key not in node_ops or lr.score > node_ops[key][1].score:
                node_ops[key] = (delta, lr)


        modify_agent = ModifyAgent(self.vs, self.ys)
        modified_nodes = []
        for delta, lr in node_ops.values():
            result = modify_agent.execute(og, lr.node, lr.operation, delta, new_version)
            modified_nodes.append((result, lr.operation))
            print(f"  → {lr.operation}: {result.title[:40]}")


        propagate_agent = PropagateAgent()
        affected = propagate_agent.propagate(og, modified_nodes)
        report = propagate_agent.generate_report(affected)
        print(f"  → 传播影响: {report['total_affected']}个节点受影响 "
              f"(高:{len(report['high_impact'])}, 中:{len(report['medium_impact'])}, "
              f"低:{len(report['low_impact'])})")


        validator = ValidateAgent()
        issues = validator.validate(og)
        if issues:
            print(f"  → 校验: {len(issues)}个问题")
            for issue in issues[:3]:
                print(f"    [{issue.severity}] {issue.description}")
        else:
            print(f"  → 校验通过 ✓")


        renderer = RenderAgent()
        sections = renderer.identify_sections_to_rewrite(og, affected)
        if sections:
            sec_titles = [og.get_node(sid).title for sid in sections if og.get_node(sid)]
            print(f"  → 需重写章节: {sec_titles}")


        self.gs.save(og)
        self.ys.append_changelog(old_version, new_version, {
            "deltas_applied": len(node_ops),
            "nodes_modified": len(modified_nodes),
            "nodes_affected": report["total_affected"],
            "issues": len(issues),
        })

        print(f"  → OG 统计: {og.stats()}")
        return og

    def _add_reference(self, og: OutlineGraph, ref_data: dict, version: str):
        from og.core.node import OGNode, NodeType, RhetoricalRole, StalenessRisk
        ref_id = f"REF-{ref_data['ref_number']:03d}"
        if og.get_node(ref_id):
            return
        node = OGNode(
            id=ref_id, type=NodeType.REFERENCE,
            title=ref_data["title"],
            rhetorical_role=RhetoricalRole.EVIDENCE,
            ref_number=ref_data["ref_number"],
            author=ref_data.get("author", ""),
            url=ref_data.get("url", ""),
            publish_date=ref_data.get("publish_date", ""),
            data_year=ref_data.get("data_year", ""),
            tier=ref_data.get("tier", ""),
            staleness_risk=StalenessRisk.LOW,
            created_in_version=version,
            last_updated_version=version,
        )
        og.add_node(node)
