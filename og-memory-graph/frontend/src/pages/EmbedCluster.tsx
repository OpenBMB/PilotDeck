










import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import GraphView from '../components/GraphView';
import ReportView from '../components/ReportView';

type EmbedTab = 'graph' | 'reports';

const EMBED_BG = '#0f172a';

export default function EmbedCluster() {
  const { id } = useParams<{id: string;}>();
  const [searchParams] = useSearchParams();

  const initTab = searchParams.get('tab') as EmbedTab || 'graph';
  const model = searchParams.get('model') || 'deepseek';

  const [tab, setTab] = useState<EmbedTab>(initTab);


  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data || e.data.type !== 'og-navigate') return;
      const t = e.data.tab as EmbedTab;
      if (t === 'graph' || t === 'reports') setTab(t);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  if (!id) return null;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      height: '100vh', width: '100%',
      background: EMBED_BG, color: '#e2e8f0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      overflow: 'hidden'
    }}>
      {}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '8px 12px', borderBottom: '1px solid #1e293b',
        background: '#0a1628', flexShrink: 0
      }}>
        <span style={{ fontSize: '12px', color: '#64748b', marginRight: '8px', fontWeight: 600 }}>
          {id}
        </span>
        {(['graph', 'reports'] as EmbedTab[]).map((t) =>
        <button
          key={t}
          onClick={() => setTab(t)}
          style={{
            padding: '5px 14px',
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            background: tab === t ? 'rgba(99,102,241,0.25)' : 'transparent',
            color: tab === t ? '#a5b4fc' : '#94a3b8',
            transition: 'background 0.12s, color 0.12s'
          }}>
          
            {t === 'graph' ? '图谱' : '报告'}
          </button>
        )}
      </div>

      {}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {tab === 'graph' &&
        <GraphView clusterId={id} model={model} />
        }
        {tab === 'reports' &&
        <ReportView clusterId={id} model={model} />
        }
      </div>
    </div>);

}
