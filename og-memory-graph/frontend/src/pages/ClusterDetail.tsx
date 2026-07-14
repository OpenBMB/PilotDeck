import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useModel } from '../context/ModelContext';
import { fetchCluster } from '../api/client';
import type { ClusterOut } from '../types';
import GraphView from '../components/GraphView';
import ReportView from '../components/ReportView';
import RefsView from '../components/RefsView';
import RunPanel from '../components/RunPanel';

type Tab = 'graph' | 'reports' | 'refs' | 'run';

export default function ClusterDetail() {
  const { id } = useParams<{id: string;}>();
  const { model } = useModel();
  const [cluster, setCluster] = useState<ClusterOut | null>(null);
  const [tab, setTab] = useState<Tab>('graph');
  const [highlightRef, setHighlightRef] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchCluster(id, model).then(setCluster).catch(() => setCluster(null));
  }, [id, model]);


  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail;

      const dClusterId = d.cluster_id ?? d.clusterId;
      if (dClusterId !== id) return;

      if (d.tab) setTab(d.tab as Tab);
    };
    window.addEventListener('og-navigate', handler);
    return () => window.removeEventListener('og-navigate', handler);
  }, [id]);

  const handleCitationClick = (refNum: number) => {
    setHighlightRef(refNum);
    setTab('refs');
  };

  const handleTabChange = (t: Tab) => {
    if (t !== 'refs') setHighlightRef(null);
    setTab(t);
  };

  if (!id) return null;

  return (
    <>
      <div className="dh">
        <div className="dh-bc">
          <Link to="/">总览</Link> / {model} / {id}
        </div>
        <div className="dh-title">{cluster?.topic ?? id}</div>
        <div className="tabs">
          <button className={`tab${tab === 'graph' ? ' on' : ''}`} onClick={() => handleTabChange('graph')}>图谱</button>
          <button className={`tab${tab === 'reports' ? ' on' : ''}`} onClick={() => handleTabChange('reports')}>报告</button>
          <button className={`tab${tab === 'refs' ? ' on' : ''}`} onClick={() => handleTabChange('refs')}>参考文献</button>
          <button className={`tab${tab === 'run' ? ' on' : ''}`} onClick={() => handleTabChange('run')}>▶ 运行</button>
        </div>
      </div>

      <div className="body">
        {tab === 'graph' && <GraphView clusterId={id} model={model} />}
        {tab === 'reports' &&
        <ReportView
          clusterId={id} model={model}
          onCitationClick={handleCitationClick} />

        }
        {tab === 'refs' && <RefsView clusterId={id} model={model} highlightRef={highlightRef} />}
        {tab === 'run' && <RunPanel clusterId={id} model={model} />}
      </div>
    </>);

}
