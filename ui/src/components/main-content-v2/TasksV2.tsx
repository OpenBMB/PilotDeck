import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus } from 'lucide-react';
import { useTaskMaster } from '../../contexts/TaskMasterContext';
import type { TaskMasterTask, TaskStatus } from '../task-master/types';
import { authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';

type TasksV2Props = {
  isVisible: boolean;
};

type UpdatingState = {
  id: string;
  nextStatus: TaskStatus;
};

function flattenTasks(tasks: TaskMasterTask[]): TaskMasterTask[] {
  const out: TaskMasterTask[] = [];
  const walk = (arr: TaskMasterTask[]) => {
    for (const task of arr) {
      out.push(task);
      if (Array.isArray(task.subtasks) && task.subtasks.length) walk(task.subtasks);
    }
  };
  walk(tasks);
  return out;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Not started',
  'in-progress': 'In progress',
  done: 'Done',
  review: 'In review',
  blocked: 'Blocked',
  deferred: 'Deferred',
  cancelled: 'Cancelled',
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  pending: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
  'in-progress':
    'bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  review: 'bg-blue-100 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  blocked: 'bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400',
  deferred: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-500',
  cancelled: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-500',
};

export default function TasksV2({ isVisible }: TasksV2Props) {
  const { t } = useTranslation();
  const {
    tasks,
    currentProject,
    refreshTasks,
    isLoadingTasks,
  } = useTaskMaster();
  const [updating, setUpdating] = useState<UpdatingState | null>(null);

  const flat = useMemo(() => flattenTasks(tasks ?? []), [tasks]);
  const inProgressCount = flat.filter((task) => task.status === 'in-progress').length;

  const handleToggle = useCallback(
    async (task: TaskMasterTask) => {
      const projectName = currentProject?.name;
      if (!projectName) return;
      const nextStatus: TaskStatus = task.status === 'done' ? 'pending' : 'done';
      setUpdating({ id: String(task.id), nextStatus });
      try {
        const response = await authenticatedFetch(
          `/api/taskmaster/update-task/${encodeURIComponent(projectName)}/${encodeURIComponent(String(task.id))}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: nextStatus }),
          },
        );
        if (response.ok) {
          void refreshTasks();
        }
      } catch (error) {
        console.error('Failed to update task status', error);
      } finally {
        setUpdating(null);
      }
    },
    [currentProject?.name, refreshTasks],
  );

  if (!isVisible) return null;

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-neutral-950">
      <div className="mx-auto w-full max-w-[880px] space-y-4 px-8 py-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
              Tasks
            </h2>
            <p className="mt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
              {flat.length} tasks · {inProgressCount} in progress
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshTasks()}
            className="text-xxs inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-white transition hover:opacity-90 dark:bg-neutral-50 dark:text-neutral-900"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            <span>Refresh</span>
          </button>
        </div>

        {isLoadingTasks && flat.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-neutral-200 py-10 text-[13px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : flat.length === 0 ? (
          <div className="rounded-xl border border-neutral-200 p-10 text-center text-[13px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            No tasks yet. Initialize Task Master from the legacy tasks panel to get started.
          </div>
        ) : (
          <div className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {flat.map((task) => {
              const isDone = task.status === 'done';
              const status = String(task.status ?? 'pending');
              const isUpdating = updating?.id === String(task.id);

              return (
                <label
                  key={String(task.id)}
                  className="flex cursor-pointer items-start gap-3 p-4 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
                >
                  <input
                    type="checkbox"
                    checked={isDone}
                    disabled={isUpdating}
                    onChange={() => void handleToggle(task)}
                    className="mt-0.5 h-4 w-4 accent-neutral-900 dark:accent-neutral-50"
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'text-[13.5px]',
                        isDone
                          ? 'text-neutral-400 line-through dark:text-neutral-500'
                          : 'text-neutral-900 dark:text-neutral-100',
                      )}
                    >
                      {task.title}
                    </div>
                    <div className="text-xxs mt-0.5 text-neutral-500 dark:text-neutral-400">
                      {STATUS_LABEL[status] ?? status}
                      {task.priority ? ` · ${task.priority}` : ''}
                    </div>
                  </div>
                  {status !== 'pending' && status !== 'done' ? (
                    <span
                      className={cn(
                        'rounded-md px-2 py-0.5 text-xxs',
                        STATUS_BADGE_CLASS[status] ??
                          'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400',
                      )}
                    >
                      {STATUS_LABEL[status] ?? status}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
