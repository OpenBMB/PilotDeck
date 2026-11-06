import { useEffect, useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { usageLevel, type ActivityView, type UsageSeries } from './metrics';

type Props = { series: UsageSeries; view: ActivityView; selected: string; engaged: boolean; onSelect: (date: string) => void; locale: string };

/** Fixed-size calendar cells and seven-step columns share one visual scale. */
export default function ActivityChart({ series, view, selected, engaged, onSelect, locale }: Props) {
  const { t } = useTranslation('settings');
  const scroll = useRef<HTMLDivElement>(null);
  const numbers = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const month = useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }), [locale]);
  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }), [locale]);
  const dateLabel = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`));
  const dayLabel = (date: string, tokens: number, count: number) => t('usage.dayDetail', { date: dateLabel(date), tokens: numbers.format(tokens), count });
  const weekIndex = Math.max(0, series.weeks.findIndex(week => week.date <= selected && week.end >= selected));
  const points = new Map(series.points.map(point => [point.date, point]));
  useEffect(() => {
    // Follow the latest dates when resizing, unless the user scrolled into history.
    const element = scroll.current;
    if (!element) return;
    let atEnd = true;
    const resize = () => { if (atEnd) element.scrollLeft = element.scrollWidth; };
    const onScroll = () => { atEnd = element.scrollWidth - element.clientWidth - element.scrollLeft < 2; };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { observer.disconnect(); element.removeEventListener('scroll', onScroll); };
  }, [view, series.start, series.end]);

  const navigate = (event: KeyboardEvent, index: number, dates: string[], daily = false) => {
    const offsets: Record<string, number> = { ArrowLeft: daily ? -7 : -1, ArrowRight: daily ? 7 : 1, ArrowUp: daily ? -1 : 1, ArrowDown: daily ? 1 : -1 };
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? dates.length - 1 : index + (offsets[event.key] ?? 0);
    if (!(event.key in offsets) && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const date = dates[Math.max(0, Math.min(dates.length - 1, next))];
    if (!date) return;
    onSelect(date);
    const target = scroll.current?.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const weekCount = Math.ceil(series.calendar.length / 7);
  const nextMonthWeek = Math.floor(series.calendar.findIndex(date => date?.endsWith('-01')) / 7);
  const months = Array.from({ length: weekCount }, (_, week) => {
    const dates = series.calendar.slice(week * 7, week * 7 + 7).filter((date): date is string => date !== null);
    const first = dates.find(date => date.endsWith('-01')) ?? (week === 0 && (nextMonthWeek >= 3 || nextMonthWeek < 0) ? dates[0] : undefined);
    if (!first) return null;
    // Keep the final month's label inside the chart instead of clipping it.
    const atEnd = week > weekCount - 3 && weekCount > 3;
    return <span key={week} style={{ gridColumn: `${atEnd ? weekCount - 2 : week + 1} / span ${Math.min(3, weekCount)}`, gridRow: 1, textAlign: atEnd ? 'end' : undefined }}>{month.format(new Date(`${first}T00:00:00Z`))}</span>;
  });
  const columns = series.weeks.map(week => ({ ...week, tokens: view === 'cumulative' ? points.get(week.end)?.cumulative ?? 0 : week.tokens }));
  const maximum = Math.max(1, ...columns.map(column => column.tokens));

  return <div ref={scroll} className="usage-heatmap-scroll" data-view={view}>
    {view === 'daily' ? <div className="usage-heatmap-layout" style={{ '--usage-weeks': Math.ceil(series.calendar.length / 7) } as CSSProperties}>
      <div className="usage-months" aria-hidden="true">{months}</div>
      <div className="usage-heatmap" role="group" aria-label={t('usage.dailyChart')}>
        {series.calendar.map((date, index) => {
          if (!date) return <span key={index} className="usage-cell usage-cell-placeholder" />;
          const day = points.get(date)!;
          const label = dayLabel(date, day.tokens, day.callCount);
          return <button key={date} type="button" data-date={date} className={`usage-cell usage-level-${usageLevel(day.tokens, series.thresholds)}`}
            tabIndex={date === selected ? 0 : -1} aria-label={label} title={label} aria-pressed={engaged && date === selected}
            onClick={() => onSelect(date)} onFocus={() => onSelect(date)}
            onKeyDown={event => navigate(event, series.points.indexOf(day), series.points.map(p => p.date), true)} />;
        })}
      </div>
    </div> : <div className="usage-heatmap-layout" style={{ '--usage-weeks': weekCount } as CSSProperties}>
      <div className={`usage-columns usage-${view}`} role="group" aria-label={t(view === 'weekly' ? 'usage.weeklyChart' : 'usage.cumulativeChart')}>
        {columns.map((column, index) => {
          const label = view === 'weekly'
            ? t('usage.weekDetail', { start: dateLabel(column.date < series.start ? series.start : column.date), end: dateLabel(column.end), tokens: numbers.format(column.tokens), count: column.callCount })
            : t('usage.cumulativeDetail', { date: dateLabel(column.end), tokens: numbers.format(column.tokens) });
          const filled = column.tokens > 0 ? Math.max(1, Math.ceil(column.tokens / maximum * 7)) : 0;
          return <button key={column.date} type="button" data-date={column.end} tabIndex={index === weekIndex ? 0 : -1}
            aria-label={label} title={label} aria-pressed={engaged && index === weekIndex} onFocus={() => onSelect(column.end)} onClick={() => onSelect(column.end)}
            onKeyDown={event => navigate(event, index, columns.map(point => point.end))}>
            {Array.from({ length: 7 }, (_, row) => <span key={row} aria-hidden="true" className={`usage-cell usage-level-${row >= 7 - filled ? 4 : 0}`} />)}
          </button>;
        })}
      </div>
      <div className="usage-months" aria-hidden="true">{months}</div>
    </div>}
  </div>;
}
