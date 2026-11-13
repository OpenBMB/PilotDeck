import { useTranslation } from 'react-i18next';
import { CalendarClock } from 'lucide-react';
import { objectValue, resultText } from '../../toolPresentation';

export function scheduledTaskResult(result: unknown): { task: Record<string, unknown>; nextRuns?: string[] } {
  const root = objectValue(result);
  const metadata = objectValue(root.toolUseResult);
  const content = objectValue(resultText(root.content));
  const blocks = Array.isArray(root.content) ? root.content.map(block => objectValue(objectValue(block).value)) : [];
  for (const value of [objectValue(metadata.data), metadata, objectValue(root.data), root, content, ...blocks]) {
    const task = objectValue(value.task);
    if (typeof task.taskId === 'string') return { task, nextRuns: value.nextRuns as string[] | undefined };
    if (typeof value.taskId === 'string') return { task: value };
  }
  return { task: {} };
}

export default function ScheduledTaskCard({ result }: { result: unknown }) {
  const { t } = useTranslation('alwaysOn');
  const { task } = scheduledTaskResult(result);
  if (!task.taskId) return <pre className="whitespace-pre-wrap text-xs">{resultText(objectValue(result).content || result)}</pre>;
  const timezone = typeof task.timezone === 'string' ? task.timezone : 'UTC';
  return <div className="space-y-2 rounded-xl border border-[var(--pd-accent-border,#c7d2fe)] bg-white p-4 dark:bg-neutral-900">
    <div className="flex items-center gap-2 text-sm font-medium"><CalendarClock size={17} /><span>{String(task.name || task.message || '').split('\n')[0]}</span></div>
    <p className="text-xs text-neutral-500">{t(`cron.execution.${String(task.executionMode || 'persistent')}`)} · {timezone}</p>
    {typeof task.nextRunAt === 'string' && <p className="text-xs">{t('cron.columns.nextRunAt', { defaultValue: 'Next run' })}: {new Date(task.nextRunAt).toLocaleString(undefined, { timeZone: timezone })}</p>}
    <a className="inline-block text-xs font-medium text-[var(--pd-accent-strong,#4f46e5)] hover:underline" href={`/cron?taskId=${encodeURIComponent(String(task.taskId))}`}>{t('cron.history.title', { defaultValue: 'Run history and results' })}</a>
  </div>;
}
