import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { KnowledgeConceptRead } from './types';
import './KnowledgeGraphCanvas.css';

const CANVAS_WIDTH = 1000;
const DEFAULT_HEIGHT = 560;
const CLICK_SLOP_PX = 4;
const RING_GAP = 28;
const ORPHANS_PER_ROW = 6;

type GraphNode = {
  id: string;
  concept: KnowledgeConceptRead;
  label: string;
  color: string;
  isSource: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
};

type GraphEdge = {
  source: number;
  target: number;
  kind: 'link' | 'citation';
};

type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type ViewTransform = {
  k: number;
  tx: number;
  ty: number;
};

const TYPE_STYLES: Record<string, { color: string }> = {
  'Source Document': { color: '#1a71ff' },
  'Source Section': { color: '#0ea5e9' },
  Topic: { color: '#22c55e' },
  Playbook: { color: '#a855f7' },
  'Business Rule': { color: '#f59e0b' },
  'Query Analysis': { color: '#d946ef' },
};
const FALLBACK_TYPE_STYLE = { color: '#94a3b8' };
const TYPE_ORDER = Object.keys(TYPE_STYLES);

export type KnowledgeGraphLabels = {
  empty: string;
  canvas: string;
  zoomIn: string;
  zoomOut: string;
  reset: string;
  fallbackType: string;
  typeLabels: Partial<Record<string, string>>;
  sortLocale?: string;
};

const DEFAULT_LABELS: KnowledgeGraphLabels = {
  empty: '暂无知识图谱数据',
  canvas: '知识图谱画布',
  zoomIn: '放大',
  zoomOut: '缩小',
  reset: '复位',
  fallbackType: '概念',
  typeLabels: {
    'Source Document': '原始资料',
    'Source Section': '资料页',
    Topic: '主题',
    Playbook: '流程知识',
    'Business Rule': '业务规则',
    'Query Analysis': '查询分析',
  },
  sortLocale: 'zh-CN',
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeConceptRef(target: string) {
  let value = target.trim();
  if (value.startsWith('/')) value = value.slice(1);
  if (value.endsWith('.md')) value = value.slice(0, -3);
  return value;
}

function extractCitationDocumentId(target: string) {
  const match = /documents\/([^/?#\s]+)/.exec(target);
  return match ? decodeURIComponent(match[1]) : null;
}

function truncateLabel(value: string, max = 12) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function measureLabel(text: string, fontSize: number) {
  let width = 0;
  for (const char of text) {
    width += /[⺀-鿿＀-･￠-￥]/.test(char) ? fontSize : fontSize * 0.56;
  }
  return width;
}

function buildGraph(concepts: KnowledgeConceptRead[]): GraphData {
  const nodes: GraphNode[] = [];
  const indexById = new Map<string, number>();
  const indexByDocument = new Map<string, number>();

  concepts.forEach((concept) => {
    if (!concept.concept_id || indexById.has(concept.concept_id)) return;
    const style = TYPE_STYLES[concept.concept_type] || FALLBACK_TYPE_STYLE;
    const isSource = concept.concept_type === 'Source Document';
    const label = truncateLabel(concept.title || concept.concept_id);
    const fontSize = isSource ? 12 : 11;
    const textWidth = measureLabel(label, fontSize);
    indexById.set(concept.concept_id, nodes.length);
    nodes.push({
      id: concept.concept_id,
      concept,
      label,
      color: style.color,
      isSource,
      width: Math.ceil(textWidth + (isSource ? 42 : 36)),
      height: isSource ? 32 : 28,
      x: 0,
      y: 0,
    });
  });

  nodes.forEach((node, index) => {
    const documentId = node.concept.document_id;
    if (!documentId) return;
    const existing = indexByDocument.get(documentId);
    if (existing === undefined || node.concept.concept_type === 'Source Document') {
      indexByDocument.set(documentId, index);
    }
  });

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  nodes.forEach((node, source) => {
    (Array.isArray(node.concept.links) ? node.concept.links : []).forEach((link) => {
      const rawTarget = typeof link?.target === 'string' ? link.target : '';
      if (!rawTarget) return;
      const target = indexById.get(normalizeConceptRef(rawTarget));
      if (target === undefined || target === source) return;
      const key = `${source}->${target}:link`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ source, target, kind: 'link' });
    });
    (Array.isArray(node.concept.citations) ? node.concept.citations : []).forEach((citation) => {
      const rawTarget = typeof citation?.target === 'string' ? citation.target : '';
      const documentId = rawTarget ? extractCitationDocumentId(rawTarget) : null;
      const target = documentId ? indexByDocument.get(documentId) : undefined;
      if (target === undefined || target === source) return;
      const key = `${source}->${target}:citation`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ source, target, kind: 'citation' });
    });
  });

  return { nodes, edges };
}

function compareNodeIndices(nodes: GraphNode[], locale: string | undefined) {
  return (left: number, right: number) => {
    const leftRank = TYPE_ORDER.indexOf(nodes[left].concept.concept_type);
    const rightRank = TYPE_ORDER.indexOf(nodes[right].concept.concept_type);
    const leftOrder = leftRank === -1 ? TYPE_ORDER.length : leftRank;
    const rightOrder = rightRank === -1 ? TYPE_ORDER.length : rightRank;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return nodes[left].label.localeCompare(nodes[right].label, locale);
  };
}

// Deterministic layered radial layout: source document at the center, its direct
// neighbors on the first ring, remaining connected nodes on a second ring, and
// orphan nodes in rows below. Positions are computed once; interactions never
// re-run the layout, so dragging a node can never move any other node.
function layoutGraph(graph: GraphData, locale?: string) {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return;

  const degree = new Array<number>(nodes.length).fill(0);
  const neighbors = nodes.map(() => new Set<number>());
  edges.forEach((edge) => {
    degree[edge.source] += 1;
    degree[edge.target] += 1;
    neighbors[edge.source].add(edge.target);
    neighbors[edge.target].add(edge.source);
  });

  let center = 0;
  let bestScore = -1;
  nodes.forEach((node, index) => {
    const score = (node.isSource ? 100000 : 0) + degree[index];
    if (score > bestScore) {
      bestScore = score;
      center = index;
    }
  });

  const byType = compareNodeIndices(nodes, locale);
  const ring1 = [...neighbors[center]].sort(byType);
  const assigned = new Set<number>([center, ...ring1]);
  const rest = nodes.map((_, index) => index).filter((index) => !assigned.has(index));
  const ring2 = rest.filter((index) => degree[index] > 0).sort(byType);
  const orphans = rest.filter((index) => degree[index] === 0).sort(byType);

  nodes[center].x = 0;
  nodes[center].y = 0;

  const ring1Arc = ring1.reduce((sum, index) => sum + nodes[index].width + RING_GAP, 0);
  const radius1 = Math.max(200, ring1Arc / (2 * Math.PI));
  ring1.forEach((index, position) => {
    const angle = -Math.PI / 2 + (position / ring1.length) * Math.PI * 2;
    nodes[index].x = Math.cos(angle) * radius1;
    nodes[index].y = Math.sin(angle) * radius1;
  });

  const ring2Arc = ring2.reduce((sum, index) => sum + nodes[index].width + RING_GAP, 0);
  const radius2 = Math.max(radius1 + 130, ring2Arc / (2 * Math.PI));
  ring2.forEach((index, position) => {
    const angle = -Math.PI / 2 + ((position + 0.5) / ring2.length) * Math.PI * 2;
    nodes[index].x = Math.cos(angle) * radius2;
    nodes[index].y = Math.sin(angle) * radius2;
  });

  const orphanTop = (ring2.length > 0 ? radius2 : radius1) + 140;
  for (let row = 0; row * ORPHANS_PER_ROW < orphans.length; row += 1) {
    const rowItems = orphans.slice(row * ORPHANS_PER_ROW, (row + 1) * ORPHANS_PER_ROW);
    const rowWidth =
      rowItems.reduce((sum, index) => sum + nodes[index].width, 0) + (rowItems.length - 1) * 20;
    let cursor = -rowWidth / 2;
    rowItems.forEach((index) => {
      nodes[index].x = cursor + nodes[index].width / 2;
      nodes[index].y = orphanTop + row * 48;
      cursor += nodes[index].width + 20;
    });
  }
}

function computeFitView(graph: GraphData, height: number): ViewTransform {
  if (graph.nodes.length === 0) {
    return { k: 1, tx: CANVAS_WIDTH / 2, ty: height / 2 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  graph.nodes.forEach((node) => {
    minX = Math.min(minX, node.x - node.width / 2);
    minY = Math.min(minY, node.y - node.height / 2);
    maxX = Math.max(maxX, node.x + node.width / 2);
    maxY = Math.max(maxY, node.y + node.height / 2);
  });
  const boundsWidth = Math.max(maxX - minX, 1);
  const boundsHeight = Math.max(maxY - minY, 1);
  const k = clamp(Math.min((CANVAS_WIDTH - 120) / boundsWidth, (height - 120) / boundsHeight), 0.2, 1.1);
  return {
    k,
    tx: CANVAS_WIDTH / 2 - ((minX + maxX) / 2) * k,
    ty: height / 2 - ((minY + maxY) / 2) * k,
  };
}

// Distance from a pill node center to its border along a unit direction,
// approximating the pill with an ellipse.
function nodeBorderRadius(node: GraphNode, ux: number, uy: number) {
  const a = node.width / 2 + 2;
  const b = node.height / 2 + 2;
  return (a * b) / Math.sqrt(b * b * ux * ux + a * a * uy * uy);
}

export default function KnowledgeGraphCanvas({
  concepts,
  onSelectConcept,
  height = DEFAULT_HEIGHT,
  labels = DEFAULT_LABELS,
}: {
  concepts: KnowledgeConceptRead[];
  onSelectConcept: (concept: KnowledgeConceptRead) => void;
  height?: number;
  labels?: KnowledgeGraphLabels;
}) {
  const graph = useMemo(() => {
    const data = buildGraph(concepts);
    layoutGraph(data, labels.sortLocale);
    return data;
  }, [concepts, labels.sortLocale]);
  const fitView = useMemo(() => computeFitView(graph, height), [graph, height]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef<ViewTransform>(fitView);
  const nodeDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);
  const [view, setView] = useState<ViewTransform>(fitView);
  const [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    setView(fitView);
    viewRef.current = fitView;
    setOffsets({});
    setSelectedId(null);
    setHoverId(null);
  }, [fitView]);

  const positions = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((node) => {
      const offset = offsets[node.id];
      map.set(node.id, { x: node.x + (offset?.x ?? 0), y: node.y + (offset?.y ?? 0) });
    });
    return map;
  }, [graph, offsets]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const localX = ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH;
      const localY = ((event.clientY - rect.top) / rect.height) * height;
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      setView((current) => {
        const k = clamp(current.k * factor, 0.2, 4);
        const worldX = (localX - current.tx) / current.k;
        const worldY = (localY - current.ty) / current.k;
        return { k, tx: localX - worldX * k, ty: localY - worldY * k };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [height]);

  const zoomBy = useCallback(
    (factor: number) => {
      setView((current) => {
        const k = clamp(current.k * factor, 0.2, 4);
        const centerX = CANVAS_WIDTH / 2;
        const centerY = height / 2;
        const worldX = (centerX - current.tx) / current.k;
        const worldY = (centerY - current.ty) / current.k;
        return { k, tx: centerX - worldX * k, ty: centerY - worldY * k };
      });
    },
    [height],
  );

  const resetView = useCallback(() => {
    setView(fitView);
  }, [fitView]);

  const handleNodePointerDown = useCallback(
    (event: ReactPointerEvent<SVGGElement>, node: GraphNode) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const offset = offsets[node.id];
      nodeDragRef.current = {
        id: node.id,
        startX: event.clientX,
        startY: event.clientY,
        baseX: offset?.x ?? 0,
        baseY: offset?.y ?? 0,
        moved: false,
      };
      svgRef.current?.setPointerCapture(event.pointerId);
    },
    [offsets],
  );

  const handleBackgroundPointerDown = useCallback((event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      tx: viewRef.current.tx,
      ty: viewRef.current.ty,
    };
    svgRef.current?.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const nodeDrag = nodeDragRef.current;
      if (nodeDrag) {
        if (Math.hypot(event.clientX - nodeDrag.startX, event.clientY - nodeDrag.startY) >= CLICK_SLOP_PX) {
          nodeDrag.moved = true;
        }
        const k = viewRef.current.k;
        const dx = ((event.clientX - nodeDrag.startX) * CANVAS_WIDTH) / Math.max(rect.width, 1) / k;
        const dy = ((event.clientY - nodeDrag.startY) * height) / Math.max(rect.height, 1) / k;
        setOffsets((current) => ({
          ...current,
          [nodeDrag.id]: { x: nodeDrag.baseX + dx, y: nodeDrag.baseY + dy },
        }));
        return;
      }
      const pan = panRef.current;
      if (pan) {
        const dx = ((event.clientX - pan.startX) / Math.max(rect.width, 1)) * CANVAS_WIDTH;
        const dy = ((event.clientY - pan.startY) / Math.max(rect.height, 1)) * height;
        setView((current) => ({ ...current, tx: pan.tx + dx, ty: pan.ty + dy }));
      }
    },
    [height],
  );

  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<SVGSVGElement>) => {
      const nodeDrag = nodeDragRef.current;
      if (nodeDrag) {
        const node = graph.nodes.find((item) => item.id === nodeDrag.id);
        if (node && !nodeDrag.moved) {
          setSelectedId(node.id);
          onSelectConcept(node.concept);
        }
        nodeDragRef.current = null;
      }
      panRef.current = null;
      setIsPanning(false);
      if (svgRef.current?.hasPointerCapture(event.pointerId)) {
        svgRef.current.releasePointerCapture(event.pointerId);
      }
    },
    [graph, onSelectConcept],
  );

  const neighborIds = useMemo(() => {
    if (hoverId === null) return null;
    const ids = new Set<string>([hoverId]);
    graph.edges.forEach((edge) => {
      const sourceId = graph.nodes[edge.source]?.id;
      const targetId = graph.nodes[edge.target]?.id;
      if (sourceId === hoverId && targetId) ids.add(targetId);
      if (targetId === hoverId && sourceId) ids.add(sourceId);
    });
    return ids;
  }, [graph, hoverId]);

  const legendItems = useMemo(() => {
    const present = new Set(graph.nodes.map((node) => node.concept.concept_type));
    const ordered = TYPE_ORDER.filter((type) => present.has(type));
    present.forEach((type) => {
      if (!TYPE_STYLES[type]) ordered.push(type);
    });
    return ordered.map((type) => ({
      type,
      ...(TYPE_STYLES[type] || FALLBACK_TYPE_STYLE),
      label: labels.typeLabels[type] || (TYPE_STYLES[type] ? type : labels.fallbackType),
    }));
  }, [graph, labels.fallbackType, labels.typeLabels]);

  if (graph.nodes.length === 0) {
    return <div className="knowledge-graph-empty">{labels.empty}</div>;
  }

  return (
    <div className="knowledge-graph-canvas">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CANVAS_WIDTH} ${height}`}
        style={{ height }}
        className={isPanning ? 'is-panning' : undefined}
        role="img"
        aria-label={labels.canvas}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <defs>
          <marker
            id="knowledge-graph-arrow-link"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0.6 0.9 L 7 4 L 0.6 7.1 z" fill="#c3c9d4" />
          </marker>
          <marker
            id="knowledge-graph-arrow-link-active"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0.6 0.9 L 7 4 L 0.6 7.1 z" fill="#9aa5b5" />
          </marker>
          <marker
            id="knowledge-graph-arrow-citation"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0.6 0.9 L 7 4 L 0.6 7.1 z" fill="#ddba85" />
          </marker>
          <marker
            id="knowledge-graph-arrow-citation-active"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6.5"
            markerHeight="6.5"
            orient="auto-start-reverse"
          >
            <path d="M 0.6 0.9 L 7 4 L 0.6 7.1 z" fill="#cf9a4a" />
          </marker>
        </defs>
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
          {graph.edges.map((edge) => {
            const source = graph.nodes[edge.source];
            const target = graph.nodes[edge.target];
            const sourcePos = source ? positions.get(source.id) : undefined;
            const targetPos = target ? positions.get(target.id) : undefined;
            if (!source || !target || !sourcePos || !targetPos) return null;
            const dx = targetPos.x - sourcePos.x;
            const dy = targetPos.y - sourcePos.y;
            const distance = Math.hypot(dx, dy) || 1;
            const ux = dx / distance;
            const uy = dy / distance;
            const direction = edge.source < edge.target ? 1 : -1;
            const bend = direction * clamp(distance * 0.12, 6, 34);
            const controlX = (sourcePos.x + targetPos.x) / 2 - uy * bend;
            const controlY = (sourcePos.y + targetPos.y) / 2 + ux * bend;
            const startTrim = nodeBorderRadius(source, ux, uy) + 3;
            const endTrim = nodeBorderRadius(target, ux, uy) + 8;
            const x1 = sourcePos.x + ux * startTrim;
            const y1 = sourcePos.y + uy * startTrim;
            const x2 = targetPos.x - ux * endTrim;
            const y2 = targetPos.y - uy * endTrim;
            const isCitation = edge.kind === 'citation';
            const isActive = hoverId !== null && (source.id === hoverId || target.id === hoverId);
            const isDimmed = neighborIds !== null && !isActive;
            const markerName = `knowledge-graph-arrow-${isCitation ? 'citation' : 'link'}${isActive ? '-active' : ''}`;
            return (
              <path
                key={`${source.id}->${target.id}:${edge.kind}`}
                className={`knowledge-graph-edge${isCitation ? ' is-citation' : ''}${isActive ? ' is-active' : ''}${isDimmed ? ' is-dimmed' : ''}`}
                d={`M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`}
                markerEnd={`url(#${markerName})`}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const position = positions.get(node.id);
            if (!position) return null;
            const isDimmed = neighborIds !== null && !neighborIds.has(node.id);
            const dotX = -node.width / 2 + 13;
            return (
              <g
                key={node.id}
                className={`knowledge-graph-node${isDimmed ? ' is-dimmed' : ''}${selectedId === node.id ? ' is-selected' : ''}`}
                transform={`translate(${position.x} ${position.y})`}
                onPointerDown={(event) => handleNodePointerDown(event, node)}
                onPointerEnter={() => setHoverId(node.id)}
                onPointerLeave={() => setHoverId(null)}
              >
                <g className="knowledge-graph-node-body">
                  <rect
                    className={`knowledge-graph-node-card${node.isSource ? ' is-source' : ''}`}
                    x={-node.width / 2}
                    y={-node.height / 2}
                    width={node.width}
                    height={node.height}
                    rx={node.height / 2}
                  />
                  <circle className="knowledge-graph-node-dot" cx={dotX} cy={0} r={3.5} fill={node.color} />
                  <text
                    className={`knowledge-graph-node-title${node.isSource ? ' is-source' : ''}`}
                    x={dotX + 10}
                    y={0}
                    dominantBaseline="central"
                  >
                    {node.label}
                  </text>
                </g>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="knowledge-graph-legend">
        {legendItems.map((item) => (
          <span key={item.type}>
            <i style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <div className="knowledge-graph-zoom-controls">
        <button type="button" className="knowledge-graph-zoom-btn" aria-label={labels.zoomIn} onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button type="button" className="knowledge-graph-zoom-btn" aria-label={labels.zoomOut} onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <button type="button" className="knowledge-graph-zoom-btn is-wide" onClick={resetView}>
          {labels.reset}
        </button>
      </div>
    </div>
  );
}
