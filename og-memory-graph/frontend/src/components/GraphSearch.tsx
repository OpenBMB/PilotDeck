import { useState, useMemo } from 'react';
import type { OGNode } from '../types';

interface Props {
  nodes: OGNode[];
  onFocus: (tempId: string) => void;
}

const TYPE_COLOR: Record<string, string> = {
  Evidence: '#22c55e', Claim: '#10b981', Section: '#8b5cf6',
  Reference: '#6366f1', Synthesis: '#8b5cf6', Context: '#14b8a6',
  Comparison: '#eab308', Table: '#94a3b8'
};

export default function GraphSearch({ nodes, onFocus }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return nodes.
    filter((n) =>
    n.title?.toLowerCase().includes(q) ||
    n.content_summary?.toLowerCase().includes(q)
    ).
    slice(0, 30);
  }, [nodes, query]);

  return (
    <div className="gsearch">
      <button
        className="gs-btn"
        title="搜索节点"
        onClick={() => {setOpen((o) => !o);setQuery('');}}>
        🔍</button>

      {open &&
      <div className="gs-panel">
          <input
          className="gs-input"
          placeholder="搜索节点标题 / 摘要…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus />
        
          <div className="gs-list">
            {query && results.length === 0 &&
          <div className="gs-empty">无匹配</div>
          }
            {results.map((n) =>
          <div
            key={n.temp_id}
            className="gs-item"
            onClick={() => {onFocus(n.temp_id);setOpen(false);setQuery('');}}>
            
                <span
              className="gs-badge"
              style={{ background: (TYPE_COLOR[n.type] ?? '#64748b') + '22',
                color: TYPE_COLOR[n.type] ?? '#64748b' }}>
              
                  {n.type}
                </span>
                <span className="gs-title">{n.title || n.temp_id}</span>
              </div>
          )}
          </div>
        </div>
      }
    </div>);

}
