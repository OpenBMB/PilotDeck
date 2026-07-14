import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchReports, fetchReportContent } from '../api/client';
import type { ReportItem } from '../types';

interface Props {
  clusterId: string;
  model: string;
  onCitationClick?: (refNum: number) => void;
}



function downloadMd(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();URL.revokeObjectURL(url);
}


function fmtMtime(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


function pickPolished7(reports: ReportItem[]): ReportItem[] {
  return reports.
  filter((r) => r.filename.includes('polished7')).
  sort((a, b) => b.mtime - a.mtime);
}






function renderTextWithCitations(text: string, onCitationClick: (n: number) => void, keyBase: string) {
  const parts = text.split(/(\[[\d,\s\-–]+\])/);
  return parts.map((part, i) => {
    const m = part.match(/^\[([\d,\s\-–]+)\]$/);
    if (!m) return <span key={`${keyBase}-${i}`}>{part}</span>;
    const nums: number[] = [];
    for (const seg of m[1].split(',')) {
      const t = seg.trim();
      const range = t.match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (range) {
        const a = parseInt(range[1]),b = parseInt(range[2]);
        for (let n = a; n <= b; n++) nums.push(n);
      } else if (/^\d+$/.test(t)) {
        nums.push(parseInt(t));
      }
    }
    if (!nums.length) return <span key={`${keyBase}-${i}`}>{part}</span>;
    return (
      <span key={`${keyBase}-${i}`} className="citation-group">[
        {nums.map((n, idx) =>
        <button key={idx} className="citation-btn"
        onClick={() => onCitationClick(n)}>{n}{idx < nums.length - 1 ? ',' : ''}</button>
        )}
        ]</span>);

  });
}


function processChildren(children: React.ReactNode, onCitationClick: (n: number) => void, keyBase = 'c'): React.ReactNode {
  if (typeof children === 'string') return renderTextWithCitations(children, onCitationClick, keyBase);
  if (typeof children === 'number') return children;
  if (Array.isArray(children)) {
    return children.map((c, i) => processChildren(c, onCitationClick, `${keyBase}-${i}`));
  }
  return children;
}

function makeParagraphRenderer(onCitationClick?: (n: number) => void) {
  if (!onCitationClick) return undefined;
  return function CiteParagraph({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
    return <p {...props}>{processChildren(children, onCitationClick)}</p>;
  };
}

function makeListItemRenderer(onCitationClick?: (n: number) => void) {
  if (!onCitationClick) return undefined;
  return function CiteListItem({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) {
    return <li {...props}>{processChildren(children, onCitationClick)}</li>;
  };
}



function ExternalLink({ href, children }: {href?: string;children?: React.ReactNode;}) {
  const handleClick = (e: React.MouseEvent) => {
    if (!href) return;
    e.preventDefault();

    const win = window.open(href, '_blank', 'noopener,noreferrer');
    if (!win) {
      try {window.top!.location.href = href;}
      catch {window.location.href = href;}
    }
  };
  return <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick}>{children}</a>;
}



export default function ReportView({ clusterId, model, onCitationClick }: Props) {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [sel, setSel] = useState<string>('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  const mdComponents = {
    p: makeParagraphRenderer(onCitationClick),
    li: makeListItemRenderer(onCitationClick),
    a: ExternalLink
  };


  useEffect(() => {
    setReports([]);setSel('');setContent('');
    fetchReports(clusterId, model).then((rs) => {
      const polished = pickPolished7(rs);
      setReports(polished);
      if (polished.length) setSel(polished[0].filename);
    }).catch(() => {});
  }, [clusterId, model]);


  useEffect(() => {
    if (!sel) return;
    setLoading(true);setContent('');
    fetchReportContent(clusterId, sel, model).then(setContent).finally(() => setLoading(false));
  }, [sel, clusterId, model]);

  if (!reports.length) return <div className="empty">暂无报告</div>;

  const selected = reports.find((r) => r.filename === sel);
  const displayName = selected ? fmtMtime(selected.mtime) : '';

  return (
    <div className="rw">
      <div className="rtb">
        {}
        <span className="rsz" style={{ fontWeight: 500, color: '#0f172a', fontSize: 13 }}>
          {displayName}
        </span>
        <div style={{ flex: 1 }} />
        {sel && content &&
        <button className="btn-ghost btn-sm"
        onClick={() => downloadMd(content, sel)}>⬇ 下载</button>
        }
      </div>
      <div className="rc">
        {loading ?
        <div className="loading">加载报告…</div> :
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as never}>{content}</ReactMarkdown>
        }
      </div>
    </div>);

}
