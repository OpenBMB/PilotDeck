import { useState, useEffect } from 'react';
import type { ClusterOut } from '../types';
import { createCluster, updateCluster } from '../api/client';

interface Props {
  mode: 'create' | 'edit';
  model: string;
  existing?: ClusterOut;
  onDone: () => void;
  onClose: () => void;
}

interface PeriodRow {start: number;end: number;}

const currentYear = new Date().getFullYear();

function rangesFromObject(obj: Record<string, [number, number]>): PeriodRow[] {
  return Object.values(obj).map(([s, e]) => ({ start: s, end: e }));
}

function rangesToObject(rows: PeriodRow[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  rows.forEach((r, i) => {out[`v${i + 1}`] = [r.start, r.end];});
  return out;
}

export default function ClusterForm({ mode, model, existing, onDone, onClose }: Props) {
  const [cid, setCid] = useState(existing?.id ?? '');
  const [topic, setTopic] = useState(existing?.topic ?? '');
  const [desc, setDesc] = useState(existing?.description ?? '');
  const [periods, setPeriods] = useState<PeriodRow[]>(
    existing?.period_year_ranges ?
    rangesFromObject(existing.period_year_ranges as Record<string, [number, number]>) :
    [{ start: 2020, end: currentYear }]
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (existing) {
      setCid(existing.id);
      setTopic(existing.topic);
      setDesc(existing.description ?? '');
      setPeriods(rangesFromObject(existing.period_year_ranges as Record<string, [number, number]>));
    }
  }, [existing]);

  const addPeriod = () => {
    const last = periods[periods.length - 1];
    setPeriods((prev) => [...prev, { start: last?.end ?? currentYear, end: currentYear + 1 }]);
  };

  const removePeriod = (i: number) => {
    if (periods.length <= 1) return;
    setPeriods((prev) => prev.filter((_, idx) => idx !== i));
  };

  const updatePeriod = (i: number, field: 'start' | 'end', val: number) => {
    setPeriods((prev) => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  };

  const handleSubmit = async () => {
    setError('');

    for (let i = 0; i < periods.length; i++) {
      const { start, end } = periods[i];
      if (isNaN(start) || isNaN(end)) {setError(`第 ${i + 1} 期年份不完整`);return;}
      if (start >= end) {setError(`第 ${i + 1} 期：起始年须小于截止年`);return;}
    }
    const parsed = rangesToObject(periods);
    setSaving(true);
    try {
      if (mode === 'create') {
        await createCluster({ id: cid, topic, description: desc || undefined, period_year_ranges: parsed }, model);
      } else {
        await updateCluster(cid, { topic, description: desc || undefined, period_year_ranges: parsed }, model);
      }
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => {if (e.target === e.currentTarget) onClose();}}>
      <div className="modal-box">
        <div className="modal-hd">
          {mode === 'create' ? '新建集群' : `编辑 ${cid}`}
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {mode === 'create' &&
          <label className="form-row">
              <span>集群 ID <span style={{ color: '#94a3b8', fontWeight: 400 }}>（格式 DR-99）</span></span>
              <input className="form-input" placeholder="DR-99"
            value={cid} onChange={(e) => setCid(e.target.value)} />
            </label>
          }

          <label className="form-row">
            <span>调研主题 (topic)</span>
            <input className="form-input" placeholder="输入主题描述…"
            value={topic} onChange={(e) => setTopic(e.target.value)} />
          </label>

          <label className="form-row">
            <span>描述（可选）</span>
            <input className="form-input" placeholder="简短说明"
            value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>

          {}
          <div className="form-row">
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ flex: 1, fontSize: 12, color: '#475569' }}>期数范围</span>
              <button className="btn-ghost btn-sm" onClick={addPeriod}>＋ 添加期</button>
            </div>

            <div className="period-list">
              {periods.map((r, i) =>
              <div key={i} className="period-row">
                  <span className="period-tag">v{i + 1}</span>
                  <input
                  type="number" className="period-year" min={1900} max={2100}
                  value={r.start}
                  onChange={(e) => updatePeriod(i, 'start', parseInt(e.target.value))} />
                
                  <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>
                  <input
                  type="number" className="period-year" min={1900} max={2100}
                  value={r.end}
                  onChange={(e) => updatePeriod(i, 'end', parseInt(e.target.value))} />
                
                  <button className="icon-btn danger" onClick={() => removePeriod(i)}
                disabled={periods.length <= 1} style={{ marginLeft: 4 }}>×</button>
                </div>
              )}
            </div>

            <div style={{ marginTop: 6, fontSize: 11, color: '#94a3b8' }}>
              将生成：{JSON.stringify(rangesToObject(periods))}
            </div>
          </div>

          {error && <div className="form-err">{error}</div>}
        </div>

        <div className="modal-ft">
          <button className="btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn-primary" onClick={handleSubmit}
          disabled={saving || !topic || mode === 'create' && !cid}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>);

}
