import type { TFunction } from 'i18next';

export function formatProcessDuration(ms: number | null | undefined, t: TFunction<'chat'>): string {
  const rawMs = Number(ms);
  const totalSeconds = Number.isFinite(rawMs)
    ? Math.max(0, Math.floor(rawMs / 1000))
    : 0;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const unit = (value: number, name: 'day' | 'hour' | 'minute' | 'second', fallback: string) =>
    t(`process.duration.${name}`, { count: value, defaultValue: `${value}${fallback}` });

  if (days > 0) {
    return [
      unit(days, 'day', 'd'),
      hours > 0 ? unit(hours, 'hour', 'h') : null,
      minutes > 0 ? unit(minutes, 'minute', 'm') : null,
    ].filter(Boolean).join(' ');
  }

  if (hours > 0) {
    return [
      unit(hours, 'hour', 'h'),
      minutes > 0 ? unit(minutes, 'minute', 'm') : null,
      seconds > 0 ? unit(seconds, 'second', 's') : null,
    ].filter(Boolean).join(' ');
  }

  if (minutes > 0) {
    return [unit(minutes, 'minute', 'm'), seconds > 0 ? unit(seconds, 'second', 's') : null].filter(Boolean).join(' ');
  }

  return unit(seconds, 'second', 's');
}
