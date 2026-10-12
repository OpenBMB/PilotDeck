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

/** Fixed daily-token bands keep the same usage the same shade across history. */
export const USAGE_THRESHOLDS = [10_000_000, 100_000_000, 300_000_000] as const;
export function usageLevel(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return 1 + USAGE_THRESHOLDS.filter(threshold => tokens >= threshold).length;
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
    longestStreak,
    currentStreak,
  };
}

export function heatmapDates(today: string): Array<string | null> {
  const first = shiftDate(today, -364);
  const weekday = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  return [
    ...Array<string | null>(weekday).fill(null),
    ...Array.from({ length: 365 }, (_, index) => shiftDate(first, index)),
  ];
}
