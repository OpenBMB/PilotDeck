import { describe, it, expect } from 'vitest';
import { activityThresholds, heatmapDates, usageLevel, usageMetrics, usageSeries, type UsageStats } from './metrics';

describe('usage intensity bands', () => {
  it.each([
    [0, 0], [NaN, 0], [Infinity, 0], [-1, 0],
    [1, 1], [165_600, 1], [9_999_999, 1],
    [10_000_000, 2], [75_982_000, 2], [99_999_999, 2],
    [100_000_000, 3], [130_000_000, 3], [299_999_999, 3],
    [300_000_000, 4], [710_000_000, 4],
  ])('%s daily tokens use shade %s', (tokens, level) => {
    expect(usageLevel(tokens, [10_000_000, 100_000_000, 300_000_000])).toBe(level);
  });
});

describe('usage calendar', () => {
  it('handles gaps and preserves yesterday’s streak until today becomes active', () => {
    const data: UsageStats = {
      timeZone: 'Asia/Shanghai', today: '2026-10-12', updatedAt: '', totalTokens: 24, totalCalls: 5,
      days: ['2026-10-07', '2026-10-08', '2026-10-10', '2026-10-11'].map(date => ({ date, tokens: 6, callCount: 1 })),
    };
    expect(usageMetrics(data)).toEqual({ todayTokens: 0, peakTokens: 6, activeDays: 4, longestStreak: 2, currentStreak: 2 });
    data.days.push({ date: data.today, tokens: 20, callCount: 1 });
    expect(usageMetrics(data)).toEqual({ todayTokens: 20, peakTokens: 20, activeDays: 5, longestStreak: 3, currentStreak: 3 });
  });
  it('renders 365 consecutive days with Monday aligned at the top of a week', () => {
    const dates = heatmapDates('2026-10-12');
    const actual = dates.filter(Boolean);
    expect(actual).toHaveLength(365);
    expect(actual.at(-1)).toBe('2026-10-12');
    expect((new Date(`${actual[0]}T00:00:00Z`).getUTCDay() + 6) % 7).toBe(dates.indexOf(actual[0]));
  });
});

describe('activity views over durable daily records', () => {
  const data: UsageStats = { timeZone: 'Asia/Shanghai', today: '2026-01-05', updatedAt: '', totalTokens: 155, totalCalls: 5,
    days: [
      { date: '2024-02-29', tokens: 100, callCount: 1 },
      { date: '2025-12-31', tokens: 10, callCount: 1 },
      { date: '2026-01-01', tokens: 20, callCount: 1 },
      { date: '2026-01-04', tokens: 15, callCount: 1 },
      { date: '2026-01-05', tokens: 10, callCount: 1 },
    ] };
  it('clips weekly totals to the range and separates Monday across year boundaries', () => {
    const series = usageSeries(data, '2026');
    expect(series.points).toHaveLength(5);
    expect(series.weeks).toEqual([
      { date: '2025-12-29', end: '2026-01-04', tokens: 35, callCount: 2 },
      { date: '2026-01-05', end: '2026-01-05', tokens: 10, callCount: 1 },
    ]);
  });
  it('fills gaps while keeping earlier history in cumulative totals without mutating input', () => {
    const copy = structuredClone(data);
    const series = usageSeries(data, '2026');
    expect(series.points[0].cumulative).toBe(130);
    expect(series.points[1]).toEqual({ date: '2026-01-02', tokens: 0, callCount: 0, cumulative: 130 });
    expect(series.points.at(-1)?.cumulative).toBe(data.totalTokens);
    expect(data).toEqual(copy);
  });
  it('keeps leap days and all older years available without truncating lifetime metrics', () => {
    const series = usageSeries(data, '2024');
    expect(series.points).toHaveLength(366);
    expect(series.points.find(point => point.date === '2024-02-29')?.tokens).toBe(100);
    expect(series.points.at(-1)?.cumulative).toBe(100);
    expect(usageMetrics(data).activeDays).toBe(5);
  });
  it('keeps empty and single-day ranges finite and sets useful relative bands', () => {
    const empty = usageSeries({ ...data, today: '2026-01-01', days: [], totalTokens: 0, totalCalls: 0 }, '2026');
    expect(empty.points).toEqual([{ date: '2026-01-01', tokens: 0, callCount: 0, cumulative: 0 }]);
    expect(empty.thresholds).toEqual([1, 2, 3]);
    const thresholds = activityThresholds(data.days);
    expect(thresholds).toEqual([25, 50, 75]);
    expect([0, 10, 30, 60, 100].map(tokens => usageLevel(tokens, thresholds))).toEqual([0, 1, 2, 3, 4]);
  });
});
