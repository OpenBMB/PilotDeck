import { useEffect, useRef, useState } from 'react';
import {
  fetchRefs, fetchRefContent, updateRefContent, deleteRef,
  pasteRef, distributeRefs, fetchCluster, updateCluster, detectPeriods,
  uploadRefsBatch } from
'../api/client';
import type { ReferenceOut, DistributePlan } from '../types';

interface Props {
  clusterId: string;
  model: string;
  highlightRef?: number | null;
}

interface PeriodRow {start: number;end: number;}
const currentYear = new Date().getFullYear();

function rangesFromObj(obj: Record<string, [number, number]>): PeriodRow[] {
  return Object.entries(obj).
  sort((a, b) => a[1][0] - b[1][0]).
  map(([, [s, e]]) => ({ start: s, end: e }));
}
function rangesToObj(rows: PeriodRow[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  rows.forEach((r, i) => {out[`v${i + 1}`] = [r.start, r.end];});
  return out;
}

export default function RefsView({ clusterId, model, highlightRef }: Props) {

  const [periods, setPeriods] = useState<PeriodRow[]>([{ start: 2020, end: currentYear }]);
  const [periodsOpen, setPeriodsOpen] = useState(false);
  const [savingPeriods, setSavingPeriods] = useState(false);
  const [periodsMsg, setPeriodsMsg] = useState('');
  const [detectingPeriods, setDetectingPeriods] = useState(false);


  const [refs, setRefs] = useState<ReferenceOut[]>([]);
  const [filterV, setFilterV] = useState<number | undefined>(undefined);
  const [selected, setSelected] = useState<ReferenceOut | null>(null);
  const [content, setContent] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [editTxt, setEditTxt] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingTxt, setLoadingTxt] = useState(false);


  const [distributing, setDistributing] = useState(false);
  const [distPlan, setDistPlan] = useState<DistributePlan | null>(null);
  const [distExecuting, setDistExecuting] = useState(false);
  const [distMsg, setDistMsg] = useState('');


  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTxt, setPasteTxt] = useState('');
  const [pasteYear, setPasteYear] = useState(currentYear);
  const [savingPaste, setSavingPaste] = useState(false);
  const [pasteMsg, setPasteMsg] = useState('');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadResults, setUploadResults] = useState<Array<{filename: string;version_assigned: number;detected_year: number | null;ok: boolean;error?: string;}>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const versions = [...new Set(refs.map((r) => r.version))].sort();


  const loadCluster = () => {
    fetchCluster(clusterId, model).
    then((c) => {
      const pr = c.period_year_ranges as Record<string, [number, number]>;
      if (pr && Object.keys(pr).length) setPeriods(rangesFromObj(pr));
    }).
    catch(() => {});
  };

  const reload = () => {
    setLoadingList(true);
    fetchRefs(clusterId, model).
    then((r) => {setRefs(r);if (filterV && !r.find((x) => x.version === filterV)) setFilterV(undefined);}).
    finally(() => setLoadingList(false));
  };

  useEffect(() => {
    setRefs([]);setSelected(null);setContent('');setFilterV(undefined);
    setPasteOpen(false);setPeriodsOpen(false);setDistMsg('');setPeriodsMsg('');
    loadCluster();
    reload();
  }, [clusterId, model]);


  useEffect(() => {
    if (!highlightRef || !refs.length) return;
    const targetFname = `ref_${highlightRef.toString().padStart(3, '0')}.txt`;
    const match = refs.find((r) => r.filename === targetFname);
    if (match) {
      setSelected(match);
      setFilterV(undefined);
      setTimeout(() => {
        document.getElementById(`ref-item-${targetFname}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [highlightRef, refs]);

  useEffect(() => {
    if (!selected) return;
    setEditing(false);
    setLoadingTxt(true);setContent('');
    fetchRefContent(clusterId, selected.id, model).
    then((r) => {setContent(r.content);setEditTxt(r.content);}).
    finally(() => setLoadingTxt(false));
  }, [selected, clusterId, model]);


  const addPeriod = () => {
    const last = periods[periods.length - 1];
    setPeriods((prev) => [...prev, { start: last?.end ?? currentYear, end: currentYear + 1 }]);
  };
  const removePeriod = (i: number) => {if (periods.length > 1) setPeriods((prev) => prev.filter((_, idx) => idx !== i));};
  const updatePeriod = (i: number, f: 'start' | 'end', v: number) =>
  setPeriods((prev) => prev.map((r, idx) => idx === i ? { ...r, [f]: v } : r));

  const handleSavePeriods = async () => {
    for (let i = 0; i < periods.length; i++) {
      if (periods[i].start >= periods[i].end) {
        setPeriodsMsg(`第 ${i + 1} 期：起始年须小于截止年`);return;
      }
    }
    setSavingPeriods(true);setPeriodsMsg('');
    try {
      await updateCluster(clusterId, { period_year_ranges: rangesToObj(periods) }, model);
      setPeriodsMsg('✅ 已保存');
    } catch (e: unknown) {
      setPeriodsMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPeriods(false);
    }
  };

  const handleDetectPeriods = async () => {
    setDetectingPeriods(true);setPeriodsMsg('');
    try {
      const r = await detectPeriods(clusterId, model);
      const suggested = r.suggested;
      if (!Object.keys(suggested).length) {
        setPeriodsMsg('未能从文件中检测到年份，请手动配置');return;
      }
      setPeriods(rangesFromObj(suggested));
      setPeriodsMsg(`✅ 已从 ${Object.keys(suggested).length} 个期文件夹自动检测，请确认后保存`);
    } catch (e: unknown) {
      setPeriodsMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setDetectingPeriods(false);
    }
  };

  const handleUpload = async (files: File[]) => {
    const txts = files.filter((f) => f.name.endsWith('.txt'));
    if (!txts.length) {alert('请选择 .txt 文件');return;}
    setUploading(true);setUploadResults([]);
    try {
      const results = await uploadRefsBatch(clusterId, txts, model);
      setUploadResults(results);
      reload();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };


  const handleDelete = async (r: ReferenceOut, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`删除 ${r.filename}？`)) return;
    await deleteRef(clusterId, r.id, model).catch(() => {});
    if (selected?.id === r.id) {setSelected(null);setContent('');}
    reload();
  };

  const handleEditSave = async () => {
    if (!selected) return;
    setSavingEdit(true);
    try {
      await updateRefContent(clusterId, selected.id, editTxt, model);
      setContent(editTxt);setEditing(false);reload();
    } catch (e) {alert(String(e));} finally
    {setSavingEdit(false);}
  };

  const handlePaste = async () => {
    if (!pasteTxt.trim()) return;
    setSavingPaste(true);setPasteMsg('');
    try {
      await pasteRef(clusterId, pasteTxt, pasteYear, model);
      setPasteTxt('');setPasteOpen(false);reload();
    } catch (e: unknown) {
      setPasteMsg(e instanceof Error ? e.message : String(e));
    } finally {setSavingPaste(false);}
  };


  const handleDistributePreview = async () => {
    setDistributing(true);setDistMsg('');setDistPlan(null);
    try {setDistPlan(await distributeRefs(clusterId, model, true));}
    catch (e: unknown) {setDistMsg(e instanceof Error ? e.message : String(e));} finally
    {setDistributing(false);}
  };

  const handleDistributeExecute = async () => {
    if (!distPlan) return;
    setDistExecuting(true);
    try {
      await distributeRefs(clusterId, model, false);
      setDistPlan(null);
      setDistMsg(`✅ 已移动 ${distPlan.summary.move} 篇，跳过 ${distPlan.summary.skip} 篇`);
      reload();
    } catch (e: unknown) {setDistMsg(e instanceof Error ? e.message : String(e));} finally
    {setDistExecuting(false);}
  };

  const visible = filterV != null ? refs.filter((r) => r.version === filterV) : refs;

  return (
    <div className="refw">
      {}
      <div className="refl">

        {}
        <div className="ref-section-hd">
          <button className="btn-ghost btn-sm" onClick={() => {setPeriodsOpen((o) => !o);setPeriodsMsg('');}}>
            {periodsOpen ? '▲ 收起期数配置' : '⚙ 期数配置'}
          </button>
          <button className="btn-ghost btn-sm" onClick={handleDistributePreview} disabled={distributing}>
            {distributing ? '分析中…' : '🔄 自动分配'}
          </button>
        </div>

        {distMsg &&
        <div className="ref-status-bar" style={{ color: distMsg.startsWith('✅') ? '#166534' : '#991b1b' }}>
            {distMsg}
          </div>
        }

        {periodsOpen &&
        <div className="ref-period-box">
            <div className="period-list">
              {periods.map((r, i) =>
            <div key={i} className="period-row">
                  <span className="period-tag">v{i + 1}</span>
                  <input type="number" className="period-year" min={1990} max={2100}
              value={r.start} onChange={(e) => updatePeriod(i, 'start', +e.target.value)} />
                  <span className="period-sep">—</span>
                  <input type="number" className="period-year" min={1990} max={2100}
              value={r.end} onChange={(e) => updatePeriod(i, 'end', +e.target.value)} />
                  <button className="icon-btn danger" onClick={() => removePeriod(i)}
              disabled={periods.length <= 1}>×</button>
                </div>
            )}
            </div>
            <div className="period-actions">
              <button className="btn-ghost btn-sm" onClick={addPeriod}>＋ 添加期</button>
              <button className="btn-ghost btn-sm" onClick={handleDetectPeriods}
            disabled={detectingPeriods}>
                {detectingPeriods ? '检测中…' : '🔍 从文件自动检测'}
              </button>
              <button className="btn-primary btn-sm" onClick={handleSavePeriods} disabled={savingPeriods}>
                {savingPeriods ? '保存中…' : '保存配置'}
              </button>
            </div>
            {periodsMsg &&
          <div className="ref-status-bar" style={{ color: periodsMsg.startsWith('✅') ? '#166534' : '#991b1b' }}>
                {periodsMsg}
              </div>
          }
          </div>
        }

        {}
        <div className="ref-filter">
          <button className={`vpill${filterV == null ? ' on' : ''}`}
          onClick={() => {setFilterV(undefined);setSelected(null);}}>全部</button>
          {versions.map((v) =>
          <button key={v} className={`vpill${filterV === v ? ' on' : ''}`}
          onClick={() => {setFilterV(v);setSelected(null);}}>v{v}</button>
          )}
        </div>

        {}
        <div className="ref-paste-hd">
          <button className="btn-ghost btn-sm" onClick={() => {setPasteOpen((o) => !o);setPasteMsg('');setUploadOpen(false);}}>
            {pasteOpen ? '▲ 收起粘贴' : '＋ 粘贴新增'}
          </button>
          <button className="btn-ghost btn-sm" onClick={() => {setUploadOpen((o) => !o);setPasteOpen(false);setUploadResults([]);}}>
            {uploadOpen ? '▲ 收起上传' : '📂 上传文件'}
          </button>
        </div>

        {}
        {uploadOpen &&
        <div className="ref-upload-box">
            <input ref={fileInputRef} type="file" multiple accept=".txt"
          style={{ display: 'none' }}
          onChange={(e) => {if (e.target.files) handleUpload([...e.target.files]);}} />
            <div
            className={`drop-zone${isDragging ? ' drag-over' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {e.preventDefault();setIsDragging(true);}}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {e.preventDefault();setIsDragging(false);if (e.dataTransfer.files) handleUpload([...e.dataTransfer.files]);}}>
              {uploading ?
            '上传中…' :
            <>
                    <span style={{ fontSize: 24 }}>📂</span>
                    <span>拖拽 .txt 文件到此，或点击选择</span>
                    <span style={{ fontSize: 11, color: '#94a3b8' }}>自动按年份分配到对应期</span>
                  </>
            }
            </div>
            {uploadResults.length > 0 &&
          <div className="upload-results">
                {uploadResults.map((r, i) =>
            <div key={i} className={`upload-result-row${r.ok ? '' : ' fail'}`}>
                    <span className="upload-fname">{r.filename}</span>
                    {r.ok ?
              <span>→ v{r.version_assigned}{r.detected_year ? ` (${r.detected_year}年)` : ' (年份未识别)'}</span> :
              <span className="form-err">{r.error}</span>
              }
                  </div>
            )}
              </div>
          }
          </div>
        }

        {pasteOpen &&
        <div className="ref-paste-box">
            <div className="paste-year-row">
              <span style={{ fontSize: 12, color: '#475569' }}>发表年份</span>
              <input type="number" className="period-year" style={{ width: 90 }}
            min={1990} max={2100} value={pasteYear}
            onChange={(e) => setPasteYear(+e.target.value)} />
              <span style={{ fontSize: 11, color: '#94a3b8' }}>自动分配到对应期</span>
            </div>
            <textarea className="ref-paste-ta"
          placeholder="粘贴参考文献文本内容…"
          value={pasteTxt} onChange={(e) => setPasteTxt(e.target.value)} rows={5} />
            {pasteMsg && <div style={{ fontSize: 12, color: '#991b1b', padding: '4px 0' }}>{pasteMsg}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button className="btn-primary btn-sm" onClick={handlePaste}
            disabled={savingPaste || !pasteTxt.trim()}>
                {savingPaste ? '保存中…' : '保存'}
              </button>
              <button className="btn-ghost btn-sm"
            onClick={() => {setPasteOpen(false);setPasteTxt('');setPasteMsg('');}}>
                取消
              </button>
            </div>
          </div>
        }

        {}
        <div className="ref-list">
          {loadingList ?
          <div className="loading">加载中…</div> :
          visible.length === 0 ?
          <div className="empty">暂无文献</div> :
          visible.map((r) => {
            const isHighlighted = highlightRef != null &&
            r.filename === `ref_${highlightRef.toString().padStart(3, '0')}.txt`;
            return (
              <div key={r.id} id={`ref-item-${r.filename}`}
              className={`ri${selected?.id === r.id ? ' on' : ''}${isHighlighted ? ' highlighted' : ''}`}
              onClick={() => setSelected(r)}>
                    <div className="ri-row">
                      <div className="ri-name">{r.filename}</div>
                      <div className="ri-btns">
                        <button className="icon-btn sm" title="删除"
                    onClick={(e) => handleDelete(r, e)}>🗑</button>
                      </div>
                    </div>
                    <div className="ri-meta">
                      v{r.version}{r.word_count ? ` · ${r.word_count.toLocaleString()} 字` : ''}
                    </div>
                  </div>);

          })
          }
        </div>
      </div>

      {}
      <div className="refr">
        {selected ?
        <>
              <div className="refr-hd">
                <span>{selected.filename} — v{selected.version}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {editing ?
              <>
                        <button className="btn-primary btn-sm" onClick={handleEditSave}
                disabled={savingEdit}>{savingEdit ? '保存中…' : '保存'}</button>
                        <button className="btn-ghost btn-sm"
                onClick={() => {setEditing(false);setEditTxt(content);}}>取消</button>
                      </> :
              <button className="btn-ghost btn-sm"
              onClick={() => {setEditing(true);setEditTxt(content);}}>✏️ 编辑</button>
              }
                </div>
              </div>
              <div className="refr-body">
                {loadingTxt ?
            '加载中…' :
            editing ?
            <textarea className="ref-edit-ta" value={editTxt}
            onChange={(e) => setEditTxt(e.target.value)} /> :
            content || '（空文件）'
            }
              </div>
            </> :
        <div className="empty">← 点击左侧文件查看内容</div>
        }
      </div>

      {}
      {distPlan &&
      <div className="modal-overlay"
      onClick={(e) => {if (e.target === e.currentTarget) setDistPlan(null);}}>
          <div className="modal-box" style={{ width: 680, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-hd">
              🔄 自动分配预览
              <span style={{ marginLeft: 12, fontSize: 12, fontWeight: 400, color: '#64748b' }}>
                移动 <b style={{ color: '#3b82f6' }}>{distPlan.summary.move}</b> 篇 ·
                保持 {distPlan.summary.keep} 篇 ·
                跳过 <b style={{ color: '#f59e0b' }}>{distPlan.summary.skip}</b> 篇（年份未识别）
              </span>
              <button className="modal-close" onClick={() => setDistPlan(null)}>×</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <table className="dist-table">
                <thead>
                  <tr><th>文件名</th><th>检测年份</th><th>当前期</th><th>分配到</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {distPlan.plan.map((item, i) =>
                <tr key={i} className={`dist-row-${item.action}`}>
                      <td className="dist-fname">{item.filename}</td>
                      <td>{item.detected_year ?? <span style={{ color: '#f59e0b' }}>未识别</span>}</td>
                      <td>{item.current_v}</td>
                      <td>{item.target_v ?? '—'}</td>
                      <td>
                        <span className={`dist-badge ${item.action}`}>
                          {item.action === 'move' ? '移动' : item.action === 'keep' ? '保持' : '跳过'}
                        </span>
                      </td>
                    </tr>
                )}
                </tbody>
              </table>
            </div>
            <div className="modal-ft">
              {distPlan.summary.skip > 0 &&
            <span style={{ fontSize: 11, color: '#94a3b8', flex: 1 }}>
                  跳过的文件保持原位，可在右侧内容区手动调整
                </span>
            }
              <button className="btn-ghost" onClick={() => setDistPlan(null)} disabled={distExecuting}>取消</button>
              <button className="btn-primary" onClick={handleDistributeExecute}
            disabled={distExecuting || distPlan.summary.move === 0}>
                {distExecuting ? '执行中…' : `确认移动 ${distPlan.summary.move} 篇`}
              </button>
            </div>
          </div>
        </div>
      }
    </div>);

}
