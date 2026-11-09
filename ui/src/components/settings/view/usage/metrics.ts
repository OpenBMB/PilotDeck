export type UsageDay = { date: string; tokens: number; callCount: number };
export type UsageStats = {
  timeZone: string;
  today: string;
  days: UsageDay[];
  totalTokens: number;
  totalCalls: number;
  updatedAt: string;
};

const DAY_MS = 86_400_000;

export function usageLevel(tokens: number, thresholds: readonly number[]): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return 1 + thresholds.filter(threshold => tokens >= threshold).length;
}

/** Relative bands make both small and large histories legible within a range. */
export function activityThresholds(days: UsageDay[]): number[] {
  const peak = days.reduce((max, day) => Math.max(max, day.tokens), 0);
  return [.25, .5, .75].map((fraction, index) => Math.max(index + 1, Math.ceil(peak * fraction)));
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function usageMetrics(data: UsageStats) {
  const activeDates = data.days.filter(day => day.tokens > 0).map(day => day.date).sort();
  const activeSet = new Set(activeDates);
  let streak = 0;
  let longestStreak = 0;
  let previous: string | undefined;
  for (const date of activeDates) {
    streak = previous && shiftDate(previous, 1) === date ? streak + 1 : 1;
    longestStreak = Math.max(longestStreak, streak);
    previous = date;
  }
  let currentStreak = 0;
  let cursor = activeSet.has(data.today) ? data.today : shiftDate(data.today, -1);
  while (activeSet.has(cursor)) {
    currentStreak++;
    cursor = shiftDate(cursor, -1);
  }
  return {
    todayTokens: data.days.find(day => day.date === data.today)?.tokens ?? 0,
    peakTokens: Math.max(0, ...data.days.map(day => day.tokens)),
    activeDays: activeSet.size,
    longestStreak,
    currentStreak,
  };
}

export function heatmapDates(today: string, first = shiftDate(today, -364)): Array<string | null> {
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const count = Math.round((Date.parse(today) - Date.parse(first)) / DAY_MS) + 1;
  return [
    ...Array<string | null>(weekday).fill(null),
    ...Array.from({ length: Math.max(0, count) }, (_, index) => shiftDate(first, index)),
  ];
}

export type UsagePoint = UsageDay & { cumulative: number };
export type UsageWeek = UsageDay & { end: string };

/** Fill calendar gaps without changing persisted records. Cumulative values
 * include the history before the selected year, not just the visible window. */
export function usageSeries(data: UsageStats, year = 'recent') {
  const start = year === 'recent' ? shiftDate(data.today, -364) : `${year}-01-01`;
  const end = year === 'recent' ? data.today : `${year}-12-31` < data.today ? `${year}-12-31` : data.today;
  const map = new Map(data.days.map(day => [day.date, day]));
  let cumulative = data.days.filter(day => day.date < start).reduce((sum, day) => sum + day.tokens, 0);
  const calendar = heatmapDates(end, start);
  const points: UsagePoint[] = calendar.filter((date): date is string => date !== null).map(date => {
    const day = map.get(date) ?? { date, tokens: 0, callCount: 0 };
    cumulative += day.tokens;
    return { ...day, cumulative };
  });
  const weeks: UsageWeek[] = [];
  for (const point of points) {
    const monday = shiftDate(point.date, -(new Date(`${point.date}T00:00:00Z`).getUTCDay() + 6) % 7);
    let week = weeks.at(-1);
    if (!week || week.date !== monday) {
      week = { date: monday, end: point.date, tokens: 0, callCount: 0 };
      weeks.push(week);
    }
    week.end = point.date;
    week.tokens += point.tokens;
    week.callCount += point.callCount;
  }
  return { start, end, calendar, points, weeks, thresholds: activityThresholds(points) };
}

export type UsageSeries = ReturnType<typeof usageSeries>;
export type ActivityView = 'daily' | 'weekly' | 'cumulative';
export const ACTIVITY_VIEWS: ActivityView[] = ['daily', 'weekly', 'cumulative'];
