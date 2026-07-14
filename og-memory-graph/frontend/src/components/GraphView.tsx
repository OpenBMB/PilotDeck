import { useEffect, useState, useCallback, useMemo } from 'react';
import Dagre from '@dagrejs/dagre';
import {
  ReactFlow, Background, Controls, MiniMap, Panel,
  type Node, type Edge, type NodeTypes,
  Handle, Position, useNodesState, useEdgesState } from
'@xyflow/react';
import '@xyflow/react/dist/style.css';
import { fetchGraphVersions, fetchGraph } from '../api/client';
import type { OGNode, OGEdge } from '../types';




export const NODE_COLOR: Record<string, string> = {
  Section: '#8b5cf6',
  Reference: '#6366f1',
  Evidence: '#22c55e',
  Claim: '#10b981',
  Synthesis: '#8b5cf6',
  Context: '#14b8a6',
  Comparison: '#eab308',
  Table: '#94a3b8',
  Event: '#f59e0b',
  Entity: '#ef4444',
  Finding: '#0ea5e9'
};
const defColor = '#64748b';

const TIER_W: Record<string, number> = { T1: 180, T2: 150, T3: 120 };

export const EDGE_COLOR: Record<string, string> = {
  contains: '#cbd5e1',
  supports: '#10b981',
  deepens: '#6366f1',
  parallels: '#a78bfa',
  contradicts: '#ef4444',
  derives_from: '#f59e0b',
  contextualizes: '#2dd4bf',
  cites: '#94a3b8',
  supersedes: '#f97316',
  illustrated_by: '#94a3b8',
  extends: '#f59e0b',
  challenges: '#f97316',
  refutes: '#dc2626',
  augments: '#0ea5e9'
};
const EDGE_W: Record<string, number> = { strong: 2.5, moderate: 1.5, medium: 1.5, weak: 1 };



function getDescendants(id: string, edges: OGEdge[]): Set<string> {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.type === 'contains' && e.source === cur && !result.has(e.target)) {
        result.add(e.target);
        queue.push(e.target);
      }
    }
  }
  return result;
}



function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (!nodes.length) return nodes;
  const g = new Dagre.graphlib.Graph({ multigraph: true });
  g.setDefaultEdgeLabel(() => ({}));




  g.setGraph({
    rankdir: 'TB', ranksep: 90, nodesep: 0, marginx: 0, marginy: 0,
    ranker: 'network-simplex'
  });
  nodes.forEach((n) => {
    const d = n.data as Record<string, unknown>;
    const t = d.type as string || '';

    const w = t === 'Section' ? 72 : 60;
    const h = t === 'Section' ? 56 : 44;
    g.setNode(n.id, { width: w, height: h });
  });
  edges.forEach((e, i) => g.setEdge(e.source, e.target, {}, `e${i}`));
  Dagre.layout(g);
  let isolatedIdx = 0;
  return nodes.map((n) => {
    const pos = g.node(n.id);
    if (pos && pos.x != null)
    return { ...n, position: { x: pos.x - pos.width / 2, y: pos.y - pos.height / 2 } };

    const col = isolatedIdx % 12,row = Math.floor(isolatedIdx / 12);
    isolatedIdx++;
    return { ...n, position: { x: col * 80, y: 1400 + row * 50 } };
  });
}










export function getNodeChangeColor(data: Record<string, unknown>): {
  changeType: 'new' | 'updated' | 'deprecated' | 'superseded' | 'normal';
  color: string;
} {
  if (data.is_delta) return { changeType: 'new', color: '#0ea5e9' };
  if (data.status === 'deprecated')
  return { changeType: 'deprecated', color: '#94a3b8' };
  if (data.status === 'superseded')
  return { changeType: 'superseded', color: '#cbd5e1' };
  const created = data.created_in_version as string | undefined;
  const updated = data.last_updated_version as string | undefined;



  const stripCurateSuffix = (v: string) => v.replace(/-(merged|reparent|curated|named|rewritten|balanced|polished).*$/, '');
  const c0 = stripCurateSuffix(created || '');
  const u0 = stripCurateSuffix(updated || '');
  const isRealUpdate = created && updated && c0 !== u0;
  if (isRealUpdate)
  return { changeType: 'updated', color: '#f97316' };
  return { changeType: 'normal', color: NODE_COLOR[data.type as string] ?? defColor };
}

function OGNodeComp({ data }: {data: Record<string, unknown>;}) {
  const { changeType, color } = getNodeChangeColor(data);
  const isDelta = changeType === 'new';
  const isDeprecated = changeType === 'deprecated';
  const isSuperseded = changeType === 'superseded';
  const isInactive = isDeprecated || isSuperseded;
  const focused = !!data.focused;
  const isCollapsed = !!data.is_collapsed;
  const childCount = data.collapsed_child_count as number ?? 0;
  const label = data.title as string || data.temp_id as string || '?';
  const type = data.type as string || '';


  const size = type === 'Section' ? 44 :
  type === 'Reference' ? 32 :
  TIER_W[data.tier as string] ? 26 : 24;


  const border = focused ? '3px solid #f59e0b' :
  isCollapsed ? `2px dashed ${color}` :
  isInactive ? `2px dashed ${color}` :
  `${isDelta ? 2.5 : 2}px solid ${color}`;

  const bg = focused ? '#f59e0b' :
  isCollapsed ? color + '60' :
  isInactive ? color + '50' :
  color;


  const inactiveBadge = isDeprecated ? '废' : isSuperseded ? '代' : '';


  const maxLen = type === 'Section' ? 16 : 12;
  const text = label.length > maxLen ? label.slice(0, maxLen - 1) + '…' : label;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      cursor: 'pointer', userSelect: 'none', position: 'relative',
      opacity: isInactive ? 0.55 : 1
    }}
    title={`${label} [${type}]${isDeprecated ? ' 已废弃' : ''}${isSuperseded ? ' 已被取代' : ''}${isCollapsed ? ' (已折叠)' : ''}${type === 'Section' ? ' · 双击折叠/展开 · 单击查看详情' : ' · 单击查看详情'}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      {}
      <div style={{
        width: size, height: size, background: bg, border, borderRadius: '50%',
        position: 'relative',
        boxShadow: focused ? '0 0 0 4px #f59e0b33' : 'none',
        transition: 'box-shadow 0.12s, transform 0.12s',
        flexShrink: 0
      }}>
        {}
        {isDelta &&
        <span style={{ position: 'absolute', top: -6, right: -8, fontSize: 8,
          background: color, color: 'white', borderRadius: 6, padding: '0 4px', lineHeight: '14px',
          border: '1.5px solid white' }}>
            {data.delta_version as string || '新'}
          </span>
        }
        {changeType === 'updated' &&
        <span style={{ position: 'absolute', top: -6, right: -8, fontSize: 8,
          background: '#f97316', color: 'white', borderRadius: 6, padding: '0 4px', lineHeight: '14px',
          border: '1.5px solid white' }}>
            改
          </span>
        }
        {isInactive &&
        <span style={{ position: 'absolute', top: -6, right: -8, fontSize: 8,
          background: color, color: 'white', borderRadius: 6, padding: '0 4px', lineHeight: '14px',
          border: '1.5px solid white' }}>
            {inactiveBadge}
          </span>
        }
        {}
        {isCollapsed && childCount > 0 &&
        <span style={{ position: 'absolute', bottom: -7, left: -6, fontSize: 8,
          background: color, color: 'white', borderRadius: 6, padding: '0 4px', lineHeight: '14px',
          border: '1.5px solid white' }}>
            {childCount}
          </span>
        }
      </div>
      {}
      <span style={{
        marginTop: 3, fontSize: 9, lineHeight: 1.2, color: focused ? '#d97706' : '#475569',
        fontWeight: type === 'Section' ? 600 : 400,
        textAlign: 'center', maxWidth: 70, wordBreak: 'break-all',
        fontStyle: isInactive ? 'italic' : 'normal',
        textDecoration: isSuperseded ? 'line-through' : 'none'
      }}>
        {text}
      </span>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>);

}

const nodeTypes: NodeTypes = { ogNode: OGNodeComp as never };



function toRFNodes(nodes: OGNode[], collapsedSections: Set<string>, ogEdges: OGEdge[]): Node[] {
  return nodes.map((n) => {
    const isCollapsed = collapsedSections.has(n.temp_id);
    const childCount = isCollapsed ?
    ogEdges.filter((e) => e.type === 'contains' && e.source === n.temp_id).length :
    0;
    return {
      id: n.temp_id,
      type: 'ogNode',
      position: { x: 0, y: 0 },
      data: { ...n, is_collapsed: isCollapsed, collapsed_child_count: childCount } as Record<string, unknown>
    };
  });
}

function toRFEdges(edges: OGEdge[]): Edge[] {
  return edges.map((e, i) => ({
    id: `e-${i}`, source: e.source, target: e.target,

    type: 'straight',
    style: {
      stroke: EDGE_COLOR[e.type] ?? defColor,
      strokeWidth: EDGE_W[e.strength ?? ''] ?? 1.2
    }
  }));
}



function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}


function fmtGraphMtime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}



interface Props {clusterId: string;model: string;}

export default function GraphView({ clusterId, model }: Props) {
  const [versions, setVersions] = useState<string[]>([]);
  const [versionItems, setVersionItems] = useState<{version: string;mtime: number;}[]>([]);
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<OGNode | null>(null);
  const [nodeCount, setNodeCount] = useState(0);
  const [edgeCount, setEdgeCount] = useState(0);


  const [ogNodes, setOgNodes] = useState<OGNode[]>([]);
  const [ogEdges, setOgEdges] = useState<OGEdge[]>([]);


  const [hiddenNodeTypes, setHiddenNodeTypes] = useState<Set<string>>(new Set());
  const [hiddenEdgeTypes, setHiddenEdgeTypes] = useState<Set<string>>(new Set());
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');


  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);


  const allNodeTypes = useMemo(() => [...new Set(ogNodes.map((n) => n.type))].sort(), [ogNodes]);
  const allEdgeTypes = useMemo(() => [...new Set(ogEdges.map((e) => e.type))].sort(), [ogEdges]);


  const hiddenIds = useMemo(() => {
    const s = new Set<string>();
    for (const sId of collapsedSections)
    for (const d of getDescendants(sId, ogEdges)) s.add(d);
    return s;
  }, [collapsedSections, ogEdges]);


  const visibleOgNodes = useMemo(() =>
  ogNodes.filter((n) => {
    if (hiddenIds.has(n.temp_id)) return false;
    if (hiddenNodeTypes.has(n.type)) return false;

    const status = (n as Record<string, unknown>).status as string | undefined;
    if (status && hiddenStatuses.has(status)) return false;
    return true;
  }),
  [ogNodes, hiddenIds, hiddenNodeTypes, hiddenStatuses]);

  const visibleOgEdges = useMemo(() => {
    const activeIds = new Set(visibleOgNodes.map((n) => n.temp_id));
    return ogEdges.filter((e) =>
    !hiddenEdgeTypes.has(e.type) &&
    activeIds.has(e.source) && activeIds.has(e.target));
  }, [ogEdges, visibleOgNodes, hiddenEdgeTypes]);


  useEffect(() => {
    setVersions([]);setVersionItems([]);setVersion('');setNodes([]);setEdges([]);
    setOgNodes([]);setOgEdges([]);
    setCollapsedSections(new Set());
    fetchGraphVersions(clusterId, model).
    then((r) => {
      setVersions(r.versions);
      setVersionItems(r.items ?? []);
      if (r.versions.length) setVersion(r.versions[r.versions.length - 1]);
    }).
    catch(() => {});
  }, [clusterId, model]);


  useEffect(() => {
    if (!version) return;
    setLoading(true);setSelected(null);setCollapsedSections(new Set());
    fetchGraph(clusterId, version, model).then((d) => {
      setOgNodes(d.nodes);
      setOgEdges(d.edges as OGEdge[]);
      setNodeCount(d.node_count);
      setEdgeCount(d.edge_count);
    }).finally(() => setLoading(false));
  }, [clusterId, version, model]);


  useEffect(() => {
    if (!visibleOgNodes.length) {setNodes([]);setEdges([]);return;}
    const rfEdges = toRFEdges(visibleOgEdges);
    const rfNodes = applyDagreLayout(toRFNodes(visibleOgNodes, collapsedSections, ogEdges), rfEdges);
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [visibleOgNodes, visibleOgEdges, collapsedSections, ogEdges]);


  const onNodeClick = useCallback((_: unknown, node: Node) => {
    setSelected(ogNodes.find((n) => n.temp_id === node.id) ?? null);
  }, [ogNodes]);


  const onNodeDoubleClick = useCallback((_: unknown, node: Node) => {
    const nd = node.data as Record<string, unknown>;
    if (nd.type !== 'Section') return;
    const hasChildren = ogEdges.some((e) => e.type === 'contains' && e.source === node.id);
    if (!hasChildren) return;
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) next.delete(node.id);else next.add(node.id);
      return next;
    });
  }, [ogEdges]);

  const onFocusNode = useCallback((tempId: string) => {
    setNodes((prev) => prev.map((n) => ({ ...n, data: { ...n.data, focused: n.id === tempId } })));
    setSelected(ogNodes.find((n) => n.temp_id === tempId) ?? null);
  }, [ogNodes, setNodes]);


  const toggleNodeType = (t: string) =>
  setHiddenNodeTypes((prev) => {const s = new Set(prev);s.has(t) ? s.delete(t) : s.add(t);return s;});
  const toggleEdgeType = (t: string) =>
  setHiddenEdgeTypes((prev) => {const s = new Set(prev);s.has(t) ? s.delete(t) : s.add(t);return s;});
  const collapseAllSections = () =>
  setCollapsedSections(new Set(ogNodes.filter((n) => n.type === 'Section').map((n) => n.temp_id)));
  const expandAllSections = () => setCollapsedSections(new Set());
  const resetFilters = () => {
    setHiddenNodeTypes(new Set());
    setHiddenEdgeTypes(new Set());
    setHiddenStatuses(new Set());
  };
  const toggleNodeStatus = (s: string) =>
  setHiddenStatuses((prev) => {const n = new Set(prev);n.has(s) ? n.delete(s) : n.add(s);return n;});


  const selectAllNodeTypes = () => setHiddenNodeTypes(new Set());
  const selectNoneNodeTypes = () => setHiddenNodeTypes(new Set(allNodeTypes));
  const invertNodeTypes = () => setHiddenNodeTypes((prev) => {
    const s = new Set<string>();
    for (const t of allNodeTypes) if (!prev.has(t)) s.add(t);
    return s;
  });
  const selectAllEdgeTypes = () => setHiddenEdgeTypes(new Set());
  const selectNoneEdgeTypes = () => setHiddenEdgeTypes(new Set(allEdgeTypes));
  const invertEdgeTypes = () => setHiddenEdgeTypes((prev) => {
    const s = new Set<string>();
    for (const t of allEdgeTypes) if (!prev.has(t)) s.add(t);
    return s;
  });

  const sectionIds = useMemo(() => new Set(ogNodes.filter((n) => n.type === 'Section').map((n) => n.temp_id)), [ogNodes]);

  if (!versions.length && !loading) return <div className="empty">该集群暂无图谱数据</div>;

  return (
    <div className="gw">
      {}
      <div className="vbar">
        <span className="vbar-lbl">版本</span>
        {versions.map((v) => {

          const item = versionItems.find((it) => it.version === v);
          const label = item && item.mtime ? fmtGraphMtime(item.mtime) : v;
          return (
            <button key={v} className={`vbtn${version === v ? ' on' : ''}`} onClick={() => setVersion(v)}>{label}</button>);

        })}
        {loading && <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>布局中…</span>}
        {!loading && nodeCount > 0 &&
        <span style={{ fontSize: 12, color: '#94a3b8', marginLeft: 8 }}>
            {visibleOgNodes.length}/{nodeCount} 节点 · {visibleOgEdges.length}/{edgeCount} 边
          </span>
        }
        {}
        {!loading && (() => {
          const hasNew = ogNodes.some((n) => (n as Record<string, unknown>).is_delta);
          const hasUpdated = ogNodes.some((n) => {
            const d = n as Record<string, unknown>;
            const stripCurate = (v: string) => v.replace(/-(merged|reparent|curated|named|rewritten|balanced|polished).*$/, '');
            const c = stripCurate(d.created_in_version as string || '');
            const u = stripCurate(d.last_updated_version as string || '');
            return !d.is_delta && c && u && c !== u;
          });
          const hasDeprecated = ogNodes.some((n) => (n as Record<string, unknown>).status === 'deprecated');
          const hasSuperseded = ogNodes.some((n) => (n as Record<string, unknown>).status === 'superseded');
          if (!hasNew && !hasUpdated && !hasDeprecated && !hasSuperseded) return null;
          const dot = (c: string) =>
          <span style={{ width: 10, height: 10, borderRadius: 2,
            background: c, display: 'inline-block', flexShrink: 0 }} />;

          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 11, color: '#64748b', marginLeft: 10,
              padding: '2px 8px', background: '#f8fafc',
              border: '1px solid #e2e8f0', borderRadius: 6, flexShrink: 0 }}>
              {hasNew && <>{dot('#0ea5e9')}<span>新增</span></>}
              {hasUpdated && <>{dot('#f97316')}<span>已更新</span></>}
              {hasDeprecated && <>{dot('#94a3b8')}<span>已废弃</span></>}
              {hasSuperseded && <>{dot('#cbd5e1')}<span>已取代</span></>}
            </div>);

        })()}
        <div style={{ flex: 1 }} />
        <button className="btn-ghost btn-sm" onClick={() => {setFilterOpen((o) => !o);setSearchOpen(false);}}>
          {filterOpen ? '▲ 过滤' : '▼ 过滤'}
        </button>
        {sectionIds.size > 0 &&
        <>
            <button className="btn-ghost btn-sm" onClick={collapseAllSections}>折叠全部</button>
            <button className="btn-ghost btn-sm" onClick={expandAllSections}>展开全部</button>
          </>
        }
        <button className="btn-ghost btn-sm" onClick={() =>
        downloadJson({ nodes: ogNodes, edges: ogEdges }, `${clusterId}_${version}_graph.json`)}>
          ⬇ JSON
        </button>
        <button className="btn-ghost btn-sm" onClick={() => {setSearchOpen((o) => !o);setFilterOpen(false);}}>
          {searchOpen ? '▲ 搜索' : '🔍 搜索'}
        </button>
      </div>

      {}
      {filterOpen &&
      <div className="filter-panel">
          <div className="filter-col">
            <div className="filter-hd">
              节点类型
              <span className="filter-quick">
                <button className="filter-quick-btn" onClick={selectAllNodeTypes}>全选</button>
                <button className="filter-quick-btn" onClick={selectNoneNodeTypes}>全不选</button>
                <button className="filter-quick-btn" onClick={invertNodeTypes}>反选</button>
              </span>
            </div>
            {allNodeTypes.map((t) =>
          <label key={t} className="filter-row">
                <input type="checkbox" checked={!hiddenNodeTypes.has(t)}
            onChange={() => toggleNodeType(t)} />
                <span className="filter-dot" style={{ background: NODE_COLOR[t] ?? defColor }} />
                <span>{t}</span>
              </label>
          )}
          </div>
          <div className="filter-col">
            <div className="filter-hd">
              边类型
              <span className="filter-quick">
                <button className="filter-quick-btn" onClick={selectAllEdgeTypes}>全选</button>
                <button className="filter-quick-btn" onClick={selectNoneEdgeTypes}>全不选</button>
                <button className="filter-quick-btn" onClick={invertEdgeTypes}>反选</button>
              </span>
            </div>
            {allEdgeTypes.map((t) =>
          <label key={t} className="filter-row">
                <input type="checkbox" checked={!hiddenEdgeTypes.has(t)}
            onChange={() => toggleEdgeType(t)} />
                <span className="filter-line" style={{ background: EDGE_COLOR[t] ?? defColor }} />
                <span>{t}</span>
              </label>
          )}
          </div>
          {}
          {(() => {
          const hasDeprecated = ogNodes.some((n) => (n as Record<string, unknown>).status === 'deprecated');
          const hasSuperseded = ogNodes.some((n) => (n as Record<string, unknown>).status === 'superseded');
          if (!hasDeprecated && !hasSuperseded) return null;
          const STATUS_META: Record<string, {color: string;label: string;}> = {
            deprecated: { color: '#94a3b8', label: '已废弃' },
            superseded: { color: '#cbd5e1', label: '已取代' }
          };
          const statuses = [
          ...(hasDeprecated ? ['deprecated'] : []),
          ...(hasSuperseded ? ['superseded'] : [])];

          return (
            <div className="filter-col">
                <div className="filter-hd">节点状态</div>
                <label key="active" className="filter-row">
                  <input type="checkbox" checked disabled style={{ opacity: 0.5 }} />
                  <span className="filter-dot" style={{ background: '#22c55e' }} />
                  <span>活跃（始终显示）</span>
                </label>
                {statuses.map((s) =>
              <label key={s} className="filter-row">
                    <input type="checkbox" checked={!hiddenStatuses.has(s)}
                onChange={() => toggleNodeStatus(s)} />
                    <span className="filter-dot" style={{ background: STATUS_META[s].color }} />
                    <span>{STATUS_META[s].label}</span>
                  </label>
              )}
              </div>);

        })()}
          <div style={{ padding: '8px 0' }}>
            <button className="btn-ghost btn-sm" onClick={resetFilters}>重置</button>
          </div>
        </div>
      }

      {}
      {searchOpen &&
      <div className="filter-panel" style={{ flexDirection: 'column', gap: 0, padding: '10px 16px' }}>
          <input
          className="gs-input" style={{ width: '100%', marginBottom: 8, border: '1px solid #e2e8f0', borderRadius: 6 }}
          placeholder="搜索节点标题 / 摘要…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoFocus />
        
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {searchQuery && (() => {
            const q = searchQuery.toLowerCase();
            const results = ogNodes.filter((n) =>
            n.title?.toLowerCase().includes(q) || n.content_summary?.toLowerCase().includes(q)
            ).slice(0, 30);
            return results.length === 0 ?
            <div className="gs-empty">无匹配</div> :
            results.map((n) =>
            <div key={n.temp_id} className="gs-item"
            onClick={() => {onFocusNode(n.temp_id);setSearchOpen(false);setSearchQuery('');}}>
                      <span className="gs-badge"
              style={{ background: (NODE_COLOR[n.type] ?? defColor) + '22', color: NODE_COLOR[n.type] ?? defColor }}>
                        {n.type}
                      </span>
                      <span className="gs-title">{n.title || n.temp_id}</span>
                    </div>
            );
          })()}
          </div>
        </div>
      }

      {}
      <div className="gc" style={{ height: '100%' }}>
        <ReactFlow nodes={nodes} edges={edges}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick} onNodeDoubleClick={onNodeDoubleClick} nodeTypes={nodeTypes}
        fitView fitViewOptions={{ padding: 0.15 }} minZoom={0.05} maxZoom={3}
        defaultEdgeOptions={{ animated: false }}>
          <Background gap={24} color="#e2e8f0" />
          <Controls />
          <MiniMap nodeColor={(n) => {
            const d = n.data as Record<string, unknown>;
            return getNodeChangeColor(d).color;
          }} style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }} />
          {}
          <Panel position="bottom-left" style={{ pointerEvents: 'none' }}>
            <div style={{
              background: 'rgba(255,255,255,0.92)', border: '1px solid #e2e8f0',
              borderRadius: 6, padding: '6px 9px', fontSize: 10, color: '#475569',
              lineHeight: 1.5, maxWidth: 220, backdropFilter: 'blur(2px)'
            }}>
              {}
              {allNodeTypes.length > 0 &&
              <div style={{ marginBottom: 4 }}>
                  <div style={{ fontWeight: 600, color: '#334155', marginBottom: 2 }}>节点</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px' }}>
                    {allNodeTypes.map((t) =>
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 9, height: 9, borderRadius: '50%',
                      background: NODE_COLOR[t] ?? defColor, display: 'inline-block' }} />
                        {t}
                      </span>
                  )}
                  </div>
                </div>
              }
              {}
              {allEdgeTypes.length > 0 &&
              <div>
                  <div style={{ fontWeight: 600, color: '#334155', marginBottom: 2 }}>边</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 8px' }}>
                    {allEdgeTypes.map((t) =>
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ width: 14, height: 2,
                      background: EDGE_COLOR[t] ?? defColor, display: 'inline-block' }} />
                        {t}
                      </span>
                  )}
                  </div>
                </div>
              }
            </div>
          </Panel>
        </ReactFlow>
      </div>

      {}
      {selected &&
      <div className="np">
          <button className="np-close" onClick={() => setSelected(null)}>×</button>
          <div className="np-type-badge" style={{ background: (NODE_COLOR[selected.type] ?? defColor) + '22',
          color: NODE_COLOR[selected.type] ?? defColor }}>
            {selected.type}
          </div>
          <h3 style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: '#0f172a', lineHeight: 1.4 }}>
            {selected.title || selected.temp_id}
          </h3>

          {}
          {[
        ['ID', selected.temp_id],
        ['Tier', selected.tier],
        ['置信度', selected.confidence != null ? (selected.confidence * 100).toFixed(0) + '%' : undefined],
        ['年份', (selected as Record<string, unknown>).data_year as string],
        ['版本创建', (selected as Record<string, unknown>).created_in_version as string],
        ['最后更新', (selected as Record<string, unknown>).last_updated_version as string]].
        filter(([, v]) => v).map(([k, v]) =>
        <div className="np-row" key={k as string}>
              <span className="np-k">{k}</span>
              <span className="np-v">{v as string}</span>
            </div>
        )}

          {}
          {selected.type === 'Reference' &&
        <>
              {(selected as Record<string, unknown>).author &&
          <div className="np-row">
                  <span className="np-k">作者</span>
                  <span className="np-v">{(selected as Record<string, unknown>).author as string}</span>
                </div>
          }
              {(selected as Record<string, unknown>).publish_date &&
          <div className="np-row">
                  <span className="np-k">发布日</span>
                  <span className="np-v">{(selected as Record<string, unknown>).publish_date as string}</span>
                </div>
          }
              {(selected as Record<string, unknown>).url &&
          <div className="np-row">
                  <span className="np-k">链接</span>
                  <a className="np-link" href={(selected as Record<string, unknown>).url as string}
            target="_blank" rel="noreferrer">
                    外链 ↗
                  </a>
                </div>
          }
            </>
        }

          {}
          {Array.isArray((selected as Record<string, unknown>).cited_refs) &&
        ((selected as Record<string, unknown>).cited_refs as number[]).length > 0 &&
        <div className="np-row">
              <span className="np-k">引用文献</span>
              <span className="np-v">
                {((selected as Record<string, unknown>).cited_refs as number[]).map((n) => `[${n}]`).join(' ')}
              </span>
            </div>
        }

          {}
          {selected.content_summary &&
        <div className="np-section">
              <div className="np-section-hd">摘要</div>
              <div className="np-summary">{selected.content_summary}</div>
            </div>
        }

          {}
          {Array.isArray((selected as Record<string, unknown>).change_log) &&
        ((selected as Record<string, unknown>).change_log as unknown[]).length > 0 &&
        <div className="np-section">
              <div className="np-section-hd">变更记录</div>
              {((selected as Record<string, unknown>).change_log as string[]).map((c, i) =>
          <div key={i} className="np-change">{c}</div>
          )}
            </div>
        }
        </div>
      }
    </div>);

}
