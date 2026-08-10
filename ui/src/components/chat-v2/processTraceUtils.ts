export function formatProcessDuration(ms?: number | null): string {
  const rawMs = Number(ms);
  const totalSeconds = Number.isFinite(rawMs)
    ? Math.max(0, Math.floor(rawMs / 1000))
    : 0;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return [
      `${days}d`,
      hours > 0 ? `${hours}h` : null,
      minutes > 0 ? `${minutes}m` : null,
    ].filter(Boolean).join(' ');
  }

  if (hours > 0) {
    return [
      `${hours}h`,
      minutes > 0 ? `${minutes}m` : null,
      seconds > 0 ? `${seconds}s` : null,
    ].filter(Boolean).join(' ');
  }

  if (minutes > 0) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${seconds}s`;
}
