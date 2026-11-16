import { CalendarClock, Check, AlertCircle, X, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { notificationText } from '../../../../shared/notifications';
import { useTaskReminders } from '../useTaskReminders';

export default function TaskReminderNotifications() {
  const { reminders, closing, preview, error, reload, dismiss, nativePresented } = useTaskReminders();
  const { t } = useTranslation('alwaysOn');
  const navigate = useNavigate();
  if (nativePresented || (!reminders.length && !error)) return null;
  return <aside aria-label={t('cron.reminders.title')} className="fixed bottom-5 right-5 z-[9998] flex max-h-[calc(100vh-6rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto p-1">
    {reminders.map(reminder => {
      const Icon = reminder.kind === 'due' ? CalendarClock : reminder.kind === 'failed' ? AlertCircle : Check;
      return <article key={reminder.id} data-reminder-id={reminder.id} role="alert" className="rounded-2xl border border-neutral-200 bg-white p-4 text-neutral-900 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
        <div className="mb-2 flex items-center gap-2 text-xs text-[var(--pd-accent-strong)]">
          <Icon size={16} aria-hidden="true" /><span>{t(`cron.reminders.${reminder.kind}`)}</span>
          <button type="button" aria-label={t('cron.reminders.close', { title: reminder.title })} disabled={closing.has(reminder.id)}
            className="ml-auto rounded-md p-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
            onClick={() => { void dismiss(reminder.id); }}><X size={16} /></button>
        </div>
        <h2 className="mb-1 truncate text-sm font-semibold">{reminder.title}</h2>
        {preview && <p className="line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-5 text-neutral-600 dark:text-neutral-300">{notificationText(reminder.body, 400)}</p>}
        <div className="mt-3 flex items-center justify-between gap-3 text-xs">
          <time className="text-neutral-400" dateTime={reminder.createdAt}>{new Date(reminder.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          <button type="button" className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-[var(--pd-accent-strong)] hover:bg-[var(--pd-accent-soft)]"
            onClick={() => navigate(`/cron?taskId=${encodeURIComponent(reminder.taskId)}`)}>{t('cron.reminders.view')}<ArrowUpRight size={14} /></button>
        </div>
      </article>;
    })}
    {error && <div role="status" className="rounded-xl border border-neutral-200 bg-white p-3 text-xs shadow dark:border-neutral-700 dark:bg-neutral-900">
      {t('cron.reminders.error')} <button type="button" className="text-[var(--pd-accent-strong)]" onClick={() => void reload()}>{t('cron.reminders.retry')}</button>
    </div>}
  </aside>;
}
