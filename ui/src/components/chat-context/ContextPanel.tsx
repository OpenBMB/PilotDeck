import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Copy, Loader2, RefreshCw, Search } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import './context-panel.css';

export type ContextTarget = {
  sessionId: string;
  projectPath: string;
  sessionKind?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
};
type Snapshot = {
  capturedAt: string;
  provider: string;
  model: string;
  systemPrompt: string;
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
  messages: Array<{ role: string; content: unknown[]; metadata?: Record<string, unknown> }>;
  breakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number };
  mediaOmitted: boolean;
};
const sections = [
  { key: 'systemPrompt', tokens: 'systemTokens', color: 'system' },
  { key: 'tools', tokens: 'toolsTokens', color: 'tools' },
  { key: 'messages', tokens: 'messageTokens', color: 'messages' },
] as const;
type Section = typeof sections[number]['key'];

export default function ContextPanel({ target, used, total }: { target?: ContextTarget; used: number; total: number }) {
  const { t } = useTranslation('chat');
  const id = useId();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [section, setSection] = useState<Section>('systemPrompt');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const targetKey = target ? new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString() : '';
  useEffect(() => {
    setSnapshot(null); setError(false); setCopied(false); setQuery(''); setLoading(false);
    if (!targetKey) return;
    const controller = new AbortController();
    const params = new URLSearchParams(targetKey);
    const sessionId = params.get('sessionId')!;
    params.delete('sessionId');
    params.set('includeModelContext', 'true'); params.set('limit', '1');
    setLoading(true);
    void authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${params}`, { signal: controller.signal, suppressServerErrorToast: true })
      .then(async response => {
        if (!response.ok) throw new Error('Context unavailable');
        const data = await response.json();
        if (!controller.signal.aborted) setSnapshot(data.modelContext ?? null);
      }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [targetKey, revision]);
  const labels = {
    systemPrompt: t('context.systemPrompt'), tools: t('context.tools'), messages: t('context.messages'),
  };
  const breakdown = snapshot?.breakdown;
  const estimated = breakdown ? sections.reduce((sum, row) => sum + Math.max(0, breakdown[row.tokens] || 0), 0) : 0;
  const occupied = total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0;
  const entries = useMemo(() => {
    if (!snapshot) return [];
    if (section === 'systemPrompt') return [{ title: '', text: snapshot.systemPrompt }];
    if (section === 'tools') return snapshot.tools.map(tool => ({ title: tool.name, text: JSON.stringify(tool, null, 2) }));
    return snapshot.messages.map((message, index) => ({ title: `${index + 1} · ${message.role}`, text: JSON.stringify(message, null, 2) }));
  }, [snapshot, section]);
  const filtered = entries.filter(entry => `${entry.title}\n${entry.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="pd-context-panel">
    <div className="pd-context-bar" aria-hidden="true">
      {estimated > 0 ? sections.map(row => <span key={row.key} className={`pd-context-${row.color}`}
        style={{ width: `${occupied * Math.max(0, breakdown?.[row.tokens] || 0) / estimated}%` }} />)
        : <span className="pd-context-messages" style={{ width: `${occupied}%` }} />}
    </div>
    <dl className="pd-context-legend">
      {sections.map(row => <div key={row.key}>
        <dt><span className={`pd-context-swatch pd-context-${row.color}`} />{labels[row.key]}</dt>
        <dd>{breakdown ? `~${Math.max(0, breakdown[row.tokens] || 0).toLocaleString()}` : '—'}</dd>
      </div>)}
    </dl>
    <p className="pd-context-caption">{t('context.estimates')}</p>
    {loading && <p className="pd-context-caption" role="status"><Loader2 size={13} className="animate-spin" />{t('context.loading')}</p>}
    {error && <p role="alert" className="pd-context-caption">{t('context.loadError')}</p>}
    {!loading && !error && !snapshot && <p className="pd-context-caption">{t('context.empty')}</p>}
    <div className="pd-context-actions">
      <button type="button" disabled={!snapshot} aria-expanded={expanded} aria-controls={`${id}-body`} onClick={() => setExpanded(value => !value)}>
        <ChevronDown size={14} className={expanded ? 'rotate-180' : ''} />{t('context.inspect')}
      </button>
      <button type="button" disabled={!target || loading} onClick={() => setRevision(value => value + 1)} aria-label={t('context.refresh')} title={t('context.refresh')}><RefreshCw size={13} /></button>
    </div>
    {expanded && snapshot && <div id={`${id}-body`} className="pd-context-inspector">
      <p className="pd-context-caption">{snapshot.provider} / {snapshot.model} · {new Date(snapshot.capturedAt).toLocaleString()}</p>
      <div className="pd-context-tabs" role="tablist" aria-label={t('context.inspect')}>
        {sections.map((row, index) => <button key={row.key} id={`${id}-${row.key}`} type="button" role="tab" aria-selected={section === row.key}
          tabIndex={section === row.key ? 0 : -1} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : sections.length - 1)) % sections.length;
            setSection(sections[next].key); setCopied(false);
            (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
          }}
          aria-controls={`${id}-content`} onClick={() => { setSection(row.key); setCopied(false); }}>
          {labels[row.key]}{row.key === 'tools' ? ` (${snapshot.tools.length})` : row.key === 'messages' ? ` (${snapshot.messages.length})` : ''}
        </button>)}
      </div>
      <div className="pd-context-search"><Search size={13} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('context.search')} aria-label={t('context.search')} />
        <button type="button" aria-label={t('context.copy')} title={t('context.copy')} onClick={() => {
          void navigator.clipboard?.writeText(entries.map(entry => entry.text).join('\n\n')).then(() => setCopied(true)).catch(() => setCopied(false));
        }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      </div>
      <div id={`${id}-content`} role="tabpanel" aria-labelledby={`${id}-${section}`} className="pd-context-content" tabIndex={0}>
        {filtered.map((entry, index) => section === 'systemPrompt'
          ? <pre key={section}>{entry.text || t('context.noContent')}</pre>
          : <details key={`${section}-${index}`}><summary>{entry.title}</summary><pre>{entry.text}</pre></details>)}
        {filtered.length === 0 && <p className="pd-context-caption">{t('context.noResults')}</p>}
      </div>
      <p className="pd-context-caption">{t('context.lastRequest')}{snapshot.mediaOmitted ? ` ${t('context.mediaOmitted')}` : ''}</p>
    </div>}
  </div>;
}
