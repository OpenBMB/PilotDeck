import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DatabaseZap, Layers3 } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import type { WebReadSessionMessagesResult } from '../../../../src/web/client/protocol';
import './context-panel.css';

export type ContextTarget = {
  sessionId: string;
  projectPath: string;
  sessionKind?: string;
  parentSessionId?: string;
  relativeTranscriptPath?: string;
};

type Breakdown = { systemTokens: number; toolsTokens: number; messageTokens: number };
const sections = [
  { label: 'systemPrompt', tokens: 'systemTokens', color: 'system' },
  { label: 'tools', tokens: 'toolsTokens', color: 'tools' },
  { label: 'messages', tokens: 'messageTokens', color: 'messages' },
] as const;
const tokenFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 });
const tokenCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
type TurnUsage = NonNullable<WebReadSessionMessagesResult['lastTurnUsage']>;
const usageCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const hasUsage = (value?: TurnUsage | null): value is TurnUsage => Boolean(value &&
  [value.usage?.inputTokens, value.usage?.outputTokens, value.usage?.cacheReadTokens,
    value.usage?.cacheWriteTokens, value.usage?.totalTokens].some(tokens => (usageCount(tokens) ?? 0) > 0));

export default function ContextPanel({ target, used, total, percent, percentLabel }: {
  target?: ContextTarget; used: number; total: number; percent: number; percentLabel: string;
}) {
  const { t } = useTranslation('chat');
  const [snapshot, setSnapshot] = useState<{ targetKey: string; breakdown: Breakdown | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [cacheSnapshot, setCacheSnapshot] = useState<{ targetKey: string; turn: TurnUsage | null } | null>(null);
  const targetKey = target ? new URLSearchParams(Object.entries(target).filter((entry): entry is [string, string] => typeof entry[1] === 'string')).toString() : '';
  const updateCache = useCallback((turn?: TurnUsage | null) => {
    const incoming = hasUsage(turn) ? turn : null;
    setCacheSnapshot(current => {
      if (current?.targetKey === targetKey && current.turn && (!incoming ||
        Date.parse(current.turn.completedAt) > Date.parse(incoming.completedAt))) return current;
      return { targetKey, turn: incoming };
    });
  }, [targetKey]);
  useEffect(() => {
    if (!targetKey) return;
    const params = new URLSearchParams(targetKey);
    const onComplete = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.sessionId === params.get('sessionId') && detail.projectPath === params.get('projectPath')
        && hasUsage(detail.lastTurnUsage)) updateCache(detail.lastTurnUsage);
    };
    window.addEventListener('pilotdeck:agent-turn-complete', onComplete);
    return () => window.removeEventListener('pilotdeck:agent-turn-complete', onComplete);
  }, [targetKey, updateCache]);
  useEffect(() => {
    setSnapshot(null);
    setLoading(false);
    if (!targetKey) return;
    const controller = new AbortController();
    const params = new URLSearchParams(targetKey);
    const sessionId = params.get('sessionId')!;
    params.delete('sessionId');
    params.set('includeModelContext', 'summary');
    params.set('limit', '1');
    setLoading(true);
    void authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?${params}`, { signal: controller.signal, suppressServerErrorToast: true })
      .then(async response => {
        if (!response.ok) return;
        const data = await response.json();
        if (!controller.signal.aborted) {
          setSnapshot({ targetKey, breakdown: data.contextBreakdown ?? null });
          updateCache(data.lastTurnUsage);
        }
      }).catch(() => { /* Unavailable estimates stay as dashes. Reopening retries. */ })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [targetKey, used, total, updateCache]);
  const breakdown = snapshot?.targetKey === targetKey ? snapshot.breakdown : null;
  const counts = sections.map(row => tokenCount(breakdown?.[row.tokens]));
  const estimated = counts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const occupied = total > 0 ? Math.max(0, Math.min(100, percent)) : 0;
  const lastTurn = cacheSnapshot?.targetKey === targetKey ? cacheSnapshot.turn : null;
  const lastUsage = lastTurn?.usage;
  const calls = typeof lastTurn?.calls === 'number' && Number.isSafeInteger(lastTurn.calls) && lastTurn.calls >= 0 ? lastTurn.calls : null;
  const cacheRead = usageCount(lastUsage?.cacheReadTokens);
  const uncached = usageCount(lastUsage?.inputTokens);
  const inputTokens = uncached !== null ? uncached + (cacheRead ?? 0) + (usageCount(lastUsage?.cacheWriteTokens) ?? 0) : null;
  const cachePercent = cacheRead !== null && inputTokens !== null && inputTokens > 0
    ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(cacheRead / inputTokens * 100)}%` : '—';
  const cacheState = !lastUsage ? 'cacheEmpty' : cacheRead === null ? 'cacheUnreported' : cacheRead > 0 ? 'cacheHit' : 'cacheMiss';
  return <div className="pd-context-panel" aria-busy={loading}>
    <div className="pd-context-header">
      <span className="pd-context-title"><Layers3 size={15} strokeWidth={1.7} aria-hidden="true" />{t('context.title')}</span>
      <span className="pd-context-status"><span>{t('context.used')}</span><strong>{total > 0 ? percentLabel : '—'}</strong></span>
    </div>
    <div className="pd-context-total"><span>{total > 0 ? `~${tokenFormat.format(used)} / ${tokenFormat.format(total)}` : '— / —'}</span><span className="pd-context-unit">{t('context.tokenUnit')}</span></div>
    <div className="pd-context-bar" role={total > 0 ? 'meter' : undefined}
      aria-label={total > 0 ? t('context.title') : undefined} aria-hidden={total <= 0 || undefined}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={total > 0 ? occupied : undefined} aria-valuetext={total > 0 ? percentLabel : undefined}>
      <div className="pd-context-bar-fill" style={{ width: `${occupied}%` }}>
        {estimated > 0 ? sections.map((row, index) => (counts[index] ?? 0) > 0
          ? <span key={row.label} className={`pd-context-${row.color}`} style={{ flexGrow: counts[index]! }} /> : null)
          : <span className="pd-context-messages" style={{ flexGrow: 1 }} />}
      </div>
    </div>
    <dl className="pd-context-legend" aria-label={t('context.estimates')}>
      {sections.map((row, index) => <div key={row.label}>
        <dt><span className={`pd-context-swatch pd-context-${row.color}`} />{t(`context.${row.label}`)}</dt>
        <dd>{counts[index] === null ? '—' : `~${tokenFormat.format(counts[index])}`}</dd>
      </div>)}
    </dl>
    <section className="pd-context-cache" aria-label={t('context.cacheTitle')}>
      <div className="pd-context-header">
        <span className="pd-context-title"><DatabaseZap size={15} strokeWidth={1.7} aria-hidden="true" />{t('context.cacheTitle')}</span>
        <span className="pd-context-status"><span>{t('context.cacheBadge')}</span><strong>{cachePercent}</strong></span>
      </div>
      <dl className="pd-context-legend pd-context-cache-legend">
        <div><dt><span className="pd-context-swatch pd-context-system" />{t('context.cacheCalls')}</dt>
          <dd>{calls === null ? '—' : t('context.cacheCallsValue', { count: calls })}</dd></div>
        <div><dt><span className={`pd-context-swatch ${cacheRead !== null && cacheRead > 0 ? 'pd-context-messages' : 'pd-context-system'}`} />{t(`context.${cacheState}`)}</dt>
          <dd>{cacheRead !== null ? t('context.cacheCounts', {
            read: tokenFormat.format(cacheRead), input: inputTokens !== null ? tokenFormat.format(inputTokens) : '—',
          }) : '—'}</dd></div>
      </dl>
    </section>
  </div>;
}
