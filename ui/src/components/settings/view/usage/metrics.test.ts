import { describe, it, expect } from 'vitest';
import { heatmapDates, usageLevel, usageMetrics, type UsageStats } from './metrics';

describe('fixed daily usage bands', () => {
  it.each([
    [0, 0], [NaN, 0], [Infinity, 0], [-1, 0],
    [1, 1], [165_600, 1], [9_999_999, 1],
    [10_000_000, 2], [75_982_000, 2], [99_999_999, 2],
    [100_000_000, 3], [130_000_000, 3], [299_999_999, 3],
    [300_000_000, 4], [710_000_000, 4],
  ])('%s daily tokens use shade %s', (tokens, level) => {
    expect(usageLevel(tokens)).toBe(level);
  });
});

describe('usage calendar', () => {
  it('handles gaps and preserves yesterday’s streak until today becomes active', () => {
    const data: UsageStats = {
      timeZone: 'Asia/Shanghai', today: '2026-10-12', updatedAt: '', totalTokens: 24, totalCalls: 5,
      days: ['2026-10-07', '2026-10-08', '2026-10-10', '2026-10-11'].map(date => ({ date, tokens: 6, callCount: 1 })),
    };
    expect(usageMetrics(data)).toEqual({ todayTokens: 0, peakTokens: 6, longestStreak: 2, currentStreak: 2 });
    data.days.push({ date: data.today, tokens: 20, callCount: 1 });
    expect(usageMetrics(data)).toEqual({ todayTokens: 20, peakTokens: 20, longestStreak: 3, currentStreak: 3 });
  });
  it('renders 365 consecutive days with Monday aligned at the top of a week', () => {
    const dates = heatmapDates('2026-10-12');
    const actual = dates.filter(Boolean);
    expect(actual).toHaveLength(365);
    expect(actual.at(-1)).toBe('2026-10-12');
    expect((new Date(`${actual[0]}T00:00:00Z`).getUTCDay() + 6) % 7).toBe(dates.indexOf(actual[0]));
  });
});
