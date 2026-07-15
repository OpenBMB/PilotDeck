





import { useEffect, useState } from 'react';
import { fetchRefs, fetchRefContent } from '../api/client';
import type { ReferenceOut } from '../types';

interface Props {
  clusterId: string;
  model: string;
  highlightRef?: number | null;
}

const BORDER = '#e2e8f0';
const MUTED = '#64748b';
const ACCENT = '#6366f1';

export default function RefsViewLite({ clusterId, model, highlightRef }: Props) {
  const [refs, setRefs] = useState<ReferenceOut[]>([]);
  const [selected, setSelected] = useState<ReferenceOut | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setRefs([]);setSelected(null);setContent('');
    fetchRefs(clusterId, model).then(setRefs).catch(() => {});
  }, [clusterId, model]);


  useEffect(() => {
    if (!selected) return;
    setLoading(true);setContent('');
    fetchRefContent(clusterId, selected.id, model).
    then((r) => setContent(r.content)).
    finally(() => setLoading(false));
  }, [selected, clusterId, model]);


  useEffect(() => {
    if (!highlightRef || !refs.length) return;
    const targetFname = `ref_${highlightRef.toString().padStart(3, '0')}.txt`;
    const match = refs.find((r) => r.filename === targetFname);
    if (match) {
      setSelected(match);
      setTimeout(() => {
        document.getElementById(`ref-item-${targetFname}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 120);
    }
  }, [highlightRef, refs]);

  if (!refs.length) return <div className="empty">暂无参考文献</div>;

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {}
      <div style={{
        width: 280, flexShrink: 0, borderRight: `1px solid ${BORDER}`,
        overflowY: 'auto', background: '#f8fafc'
      }}>
        {refs.map((r) => {
          const isSel = selected?.id === r.id;
          const isHi = highlightRef != null &&
          r.filename === `ref_${highlightRef.toString().padStart(3, '0')}.txt`;
          return (
            <div key={r.id} id={`ref-item-${r.filename}`}
            onClick={() => setSelected(r)}
            style={{
              padding: '9px 14px', cursor: 'pointer', fontSize: 12,
              borderBottom: `1px solid ${BORDER}`,
              background: isHi ? '#fef3c7' : isSel ? '#eef2ff' : 'transparent',
              borderLeft: isHi ? '3px solid #f59e0b' : isSel ? '3px solid #6366f1' : '3px solid transparent',
              color: isSel ? ACCENT : '#334155', fontWeight: isSel ? 600 : 400,
              transition: 'background 0.1s'
            }}>
              <div style={{ fontWeight: 500 }}>{r.filename}</div>
              {r.title && <div style={{ fontSize: 11, color: MUTED, marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>}
            </div>);

        })}
      </div>

      {}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        {selected ?
        <>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 10 }}>
              {selected.filename}
            </div>
            {loading ?
          <div style={{ color: MUTED, fontSize: 13 }}>加载中…</div> :
          <pre style={{
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontSize: 13, lineHeight: 1.7, color: '#334155',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            margin: 0
          }}>{content}</pre>
          }
          </> :

        <div style={{ color: MUTED, fontSize: 13 }}>← 选择左侧文件查看内容</div>
        }
      </div>
    </div>);

}
