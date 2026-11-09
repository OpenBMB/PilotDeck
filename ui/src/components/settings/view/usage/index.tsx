import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';
import { ACTIVITY_VIEWS, usageMetrics, usageSeries, type ActivityView, type UsageStats } from './metrics';
import ActivityChart from './ActivityChart';
import './usage.css';

const VIEW_KEY = 'pilotdeck-usage-view-v1';
function savedView(): ActivityView {
  try {
    const value = localStorage.getItem(VIEW_KEY) as ActivityView;
    return ACTIVITY_VIEWS.includes(value) ? value : 'daily';
  } catch { return 'daily'; }
}

export default function UsageSections() {
  const { t, i18n } = useTranslation('settings');
  const [data, setData] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [view, setView] = useState<ActivityView>(savedView);
  const [year, setYear] = useState('recent');
  const request = useRef<AbortController | null>(null);
  const locale = i18n.resolvedLanguage || i18n.language;
  const fullNumber = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const shortNumber = useMemo(() => new Intl.NumberFormat(locale, { notation: 'compact', maximumSignificantDigits: 4 }), [locale]);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }), [locale]);
  const dateLabel = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
  const chooseView = (next: ActivityView) => {
    setView(next);
    setSelectedDate(null);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* View preferences are optional; usage stays on disk. */ }
  };
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/usage', { signal: controller.signal });
      if (!response.ok) throw new Error('usage_stats_unavailable');
      const result = await response.json();
      if (!controller.signal.aborted) { setData(result); setError(false); }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      request.current?.abort();
    };
  }, [refresh]);

  const metrics = useMemo(() => data ? usageMetrics(data) : null, [data]);
  const series = useMemo(() => data ? usageSeries(data, year) : null, [data, year]);
  const years = useMemo(() => data ? [...new Set([data.today.slice(0, 4), ...data.days.map(day => day.date.slice(0, 4)).filter(value => value <= data.today.slice(0, 4))])].sort().reverse() : [], [data]);
  const selected = series?.points.find(point => point.date === selectedDate) ?? series?.points.at(-1);
  const selectedWeek = series?.weeks.find(week => selected && week.date <= selected.date && week.end >= selected.date);
  const cards = metrics && data ? [
    { key: 'total', label: t('usage.total'), value: data.totalTokens, days: false },
    { key: 'peak', label: t('usage.peak'), value: metrics.peakTokens, days: false },
    { key: 'active', label: t('usage.activeDays'), value: metrics.activeDays, days: true },
    { key: 'longest', label: t('usage.longestStreak'), value: metrics.longestStreak, days: true },
    { key: 'current', label: t('usage.currentStreak'), value: metrics.currentStreak, days: true },
  ] : [];
  const legendTitle = (level: number) => {
    const thresholds = series?.thresholds ?? [];
    if (level === 0) return t('usage.legendZero');
    if (level === 1) return t('usage.legendBelow', { max: fullNumber.format(thresholds[0]) });
    if (level === 4) return t('usage.legendAtLeast', { min: fullNumber.format(thresholds[2]) });
    return t('usage.legendRange', { min: fullNumber.format(thresholds[level - 2]), max: fullNumber.format(thresholds[level - 1]) });
  };
  const detailDate = selected && series ? view === 'weekly' && selectedWeek
    ? `${dateLabel(selectedWeek.date < series.start ? series.start : selectedWeek.date)} – ${dateLabel(selectedWeek.end)}`
    : dateLabel(selected.date) : '';
  const detailTokens = view === 'cumulative' ? selected?.cumulative : view === 'weekly' ? selectedWeek?.tokens : selected?.tokens;
  const detailCalls = view === 'weekly' ? selectedWeek?.callCount : selected?.callCount;

  return <div className="usage-content">
    <header className="page-header usage-header">
      <h1>{t('settingsPage.menu.usage')}</h1>
      <div className="usage-header-actions">
        {data ? <select className="usage-year" value={year} aria-label={t('usage.period')} onChange={event => { setYear(event.target.value); setSelectedDate(null); }}>
          <option value="recent">{t('usage.lastYear')}</option>{years.map(value => <option key={value} value={value}>{t('usage.year', { year: value })}</option>)}
        </select> : null}
        <button type="button" className="usage-refresh" aria-label={t('usage.refresh')} title={t('usage.refresh')} onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'usage-spin' : undefined} aria-hidden="true" />
        </button>
      </div>
    </header>
    {error ? <div className="usage-error" role="alert">{t('usage.error')}</div> : null}
    {!data || !metrics || !series ? <div className="usage-loading" role="status">{loading ? t('usage.loading') : t('usage.unavailable')}</div> : <>
      <section className="usage-summary" aria-label={t('usage.overview')}>
        {cards.map(card => <div key={card.key} className={`usage-stat usage-stat-${card.key}`}>
          <div className="usage-stat-value"><strong title={fullNumber.format(card.value)}>{shortNumber.format(card.value)}</strong>
            {card.days ? <span className="usage-stat-unit">{t('usage.days', { count: card.value })}</span> : null}</div>
          <span className="usage-stat-label">{card.label}</span>
        </div>)}
      </section>
      <div className="usage-at-a-glance">
        <span className="usage-stat-today">{t('usage.today')} <strong title={fullNumber.format(metrics.todayTokens)}>{shortNumber.format(metrics.todayTokens)}</strong></span>
        <span>{t('usage.totalCalls')} <strong>{fullNumber.format(data.totalCalls)}</strong></span>
      </div>
      <section className="usage-activity" aria-labelledby="usage-activity-title">
        <div className="usage-section-heading">
          <h2 id="usage-activity-title">{t('usage.activity')}</h2>
          <div className="usage-tabs" role="tablist" aria-label={t('usage.activityView')}>
            {ACTIVITY_VIEWS.map((mode, index) => <button key={mode} type="button" role="tab" id={`usage-tab-${mode}`} aria-controls="usage-activity-panel" aria-selected={view === mode}
              tabIndex={view === mode ? 0 : -1} onClick={() => chooseView(mode)} onKeyDown={event => {
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : null;
                if (next === null) return;
                event.preventDefault(); chooseView(ACTIVITY_VIEWS[next]);
                document.getElementById(`usage-tab-${ACTIVITY_VIEWS[next]}`)?.focus();
              }}>{t(`usage.views.${mode}`)}</button>)}
          </div>
        </div>
        <div role="tabpanel" id="usage-activity-panel" aria-labelledby={`usage-tab-${view}`}>
          <ActivityChart series={series} view={view} selected={selected?.date ?? series.end} engaged={selectedDate !== null} onSelect={setSelectedDate} locale={locale} />
          <div className="usage-chart-caption">
            <span className="sr-only">{dateLabel(series.start)} – {dateLabel(series.end)}</span>
            {view === 'daily' ? <div className="usage-legend" role="group" aria-label={t('usage.intensity')}>
              <span>{t('usage.less')}</span>{[0, 1, 2, 3, 4].map(level => <span key={level} role="img" aria-label={legendTitle(level)} className={`usage-cell usage-level-${level}`} title={legendTitle(level)} />)}<span>{t('usage.more')}</span>
            </div> : null}
          </div>
          {selected && selectedDate ? <div className="usage-day-detail" aria-live="polite" aria-atomic="true">
            <span>{detailDate}</span><div><strong>{fullNumber.format(detailTokens ?? 0)} <span>{t('usage.tokens')}</span></strong>
              {view === 'cumulative' ? <span>{t('usage.totalToDate')}</span> : <span>{t('usage.calls', { count: detailCalls ?? 0 })}</span>}</div>
          </div> : null}
        </div>
      </section>
    </>}
  </div>;
}
