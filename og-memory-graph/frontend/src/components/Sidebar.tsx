import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useModel } from '../context/ModelContext';
import { fetchClusters } from '../api/client';
import type { ClusterOut } from '../types';
import ChatPanel from './ChatPanel';

export default function Sidebar() {
  const { model, setModel, models } = useModel();
  const [clusters, setClusters] = useState<ClusterOut[]>([]);
  const [showChat, setShowChat] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();


  const clusterMatch = location.pathname.match(/\/cluster\/([^/]+)/);
  const currentClusterId = clusterMatch ? clusterMatch[1] : undefined;

  useEffect(() => {
    setClusters([]);
    fetchClusters(model).
    then(setClusters).
    catch(() => {});
  }, [model]);

  const handleModelChange = (m: string) => {
    setModel(m);
    navigate('/');
  };


  return (
    <aside className="sidebar">
      <div className="sidebar-logo">OG <span>v6</span></div>

      <div className="model-wrap">
        <div className="model-label">模型</div>
        <select
          className="model-select"
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}>
          
          {models.map((m) =>
          <option key={m} value={m}>{m}</option>
          )}
        </select>
      </div>

      <nav className="cluster-list">
        {clusters.map((c) =>
        <NavLink
          key={c.id}
          to={`/cluster/${c.id}`}
          className={({ isActive }) => `ci${isActive ? ' active' : ''}`}>
          
            <div className="ci-id">{c.id}</div>
            <div className="ci-topic">{c.topic}</div>
            <div className="ci-chips">
              <span className="chip i">v×{c.stats.version_count}</span>
              <span className="chip">📄{c.stats.report_count}</span>
              {c.stats.has_graph && <span className="chip g">图谱</span>}
            </div>
          </NavLink>
        )}
        {clusters.length === 0 &&
        <div style={{ padding: '20px 10px', fontSize: 12, color: '#475569' }}>加载中…</div>
        }
      </nav>

      <div className="sidebar-footer">
        <button
          className={`sidebar-cfg${showChat ? ' active' : ''}`}
          onClick={() => setShowChat((o) => !o)}>
          💬 助手
        </button>
        <NavLink to="/config" className={({ isActive }) => `sidebar-cfg${isActive ? ' active' : ''}`}>
          ⚙ 配置
        </NavLink>
      </div>

      {}
      {showChat &&
      <ChatPanel
        clusterId={currentClusterId}
        onClose={() => setShowChat(false)}
        onNavigate={(detail) => {
          const clusterId = detail.cluster_id as string;
          navigate(`/cluster/${clusterId}`);
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('og-navigate', { detail }));
          }, 150);
        }} />

      }
    </aside>);

}
