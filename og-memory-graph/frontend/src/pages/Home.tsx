import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useModel } from '../context/ModelContext';
import { fetchClusters, deleteCluster } from '../api/client';
import type { ClusterOut } from '../types';
import ClusterForm from '../components/ClusterForm';

export default function Home() {
  const { model } = useModel();
  const navigate = useNavigate();
  const [clusters, setClusters] = useState<ClusterOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{mode: 'create' | 'edit';cluster?: ClusterOut;} | null>(null);

  const reload = () => {
    setLoading(true);
    fetchClusters(model).
    then(setClusters).
    catch(() => {}).
    finally(() => setLoading(false));
  };

  useEffect(() => {reload();}, [model]);

  const handleDelete = async (e: React.MouseEvent, c: ClusterOut) => {
    e.preventDefault();e.stopPropagation();
    if (!confirm(`确定删除集群 ${c.id}？此操作不可恢复。`)) return;
    await deleteCluster(c.id, model).catch(() => {});
    reload();
  };

  const handleEdit = (e: React.MouseEvent, c: ClusterOut) => {
    e.preventDefault();e.stopPropagation();
    setForm({ mode: 'edit', cluster: c });
  };

  if (loading) return <div className="loading">加载集群列表…</div>;

  return (
    <div className="home">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ flex: 1, margin: 0 }}>集群总览</h1>
        <p style={{ margin: '0 16px', color: '#64748b', fontSize: 13 }}>
          模型：<strong>{model}</strong> · 共 {clusters.length} 个集群
        </p>
        <button className="btn-primary" onClick={() => setForm({ mode: 'create' })}>
          ＋ 新建集群
        </button>
      </div>

      <div className="grid">
        {clusters.map((c) =>
        <div key={c.id} className="card" onClick={() => navigate(`/cluster/${c.id}`)}>
            <div className="card-actions">
              <button className="icon-btn" title="编辑" onClick={(e) => handleEdit(e, c)}>✏️</button>
              <button className="icon-btn danger" title="删除" onClick={(e) => handleDelete(e, c)}>🗑</button>
            </div>
            <div className="card-id">{c.id}</div>
            <div className="card-topic">{c.topic}</div>
            <div className="card-chips">
              <span className="tag i">{c.stats.version_count} 期</span>
              <span className="tag">📄 {c.stats.report_count} 份报告</span>
              <span className="tag">📚 {c.stats.ref_count} 篇文献</span>
              {c.stats.has_graph && <span className="tag g">✓ 图谱</span>}
            </div>
          </div>
        )}
      </div>

      {form &&
      <ClusterForm
        mode={form.mode}
        model={model}
        existing={form.cluster}
        onDone={() => {setForm(null);reload();}}
        onClose={() => setForm(null)} />

      }
    </div>);

}
