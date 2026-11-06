import { useTranslation } from 'react-i18next';
import { memo, useMemo } from 'react';
import { CheckCircle2, Circle, Clock, type LucideIcon } from 'lucide-react';

type TodoStatus = 'completed' | 'in_progress' | 'pending';

export type TodoItem = {
  id?: string;
  content: string;
  status: string;
  priority?: string;
};

type NormalizedTodoItem = {
  id?: string;
  content: string;
  status: TodoStatus;
};

type StatusConfig = {
  icon: LucideIcon;
  iconClassName: string;
  textClassName: string;
};

// Centralized visual config keeps rendering logic compact and easier to scan.
const STATUS_CONFIG: Record<TodoStatus, StatusConfig> = {
  completed: {
    icon: CheckCircle2,
    iconClassName: 'h-3.5 w-3.5 text-muted-foreground',
    textClassName: 'line-through text-muted-foreground',
  },
  in_progress: {
    icon: Clock,
    iconClassName: 'h-3.5 w-3.5 text-[var(--brand-strong)]',
    textClassName: 'text-foreground',
  },
  pending: {
    icon: Circle,
    iconClassName: 'h-3.5 w-3.5 text-muted-foreground',
    textClassName: 'text-foreground',
  },
};

// Incoming tool payloads can vary; normalize to supported UI states.
const normalizeStatus = (status: string): TodoStatus => {
  if (status === 'completed' || status === 'in_progress') {
    return status;
  }
  return 'pending';
};

const TodoRow = memo(
  ({ todo }: { todo: NormalizedTodoItem }) => {
    const { t } = useTranslation('common');
    const statusConfig = STATUS_CONFIG[todo.status];
    const StatusIcon = statusConfig.icon;

    return (
      <div className="flex min-w-0 items-start gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0">
        <div className="mt-0.5 flex-shrink-0">
          <StatusIcon className={statusConfig.iconClassName} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className={`min-w-0 break-words text-[13px] leading-5 ${statusConfig.textClassName}`}>
              {todo.content}
            </p>
            <span className="shrink-0 text-[12px] leading-5 text-muted-foreground">
                {t(`uiText.taskStatus.${todo.status}`)}
            </span>
          </div>
        </div>
      </div>
    );
  }
);

const TodoList = memo(
  ({
    todos,
    isResult = false,
  }: {
    todos: TodoItem[];
    isResult?: boolean;
  }) => {
    const { t } = useTranslation('common');
    // Memoize normalization to avoid recomputing list metadata on every render.
    const normalizedTodos = useMemo<NormalizedTodoItem[]>(
      () =>
        todos.map((todo) => ({
          id: todo.id,
          content: todo.content,
          status: normalizeStatus(todo.status),
        })),
      [todos]
    );

    if (normalizedTodos.length === 0) {
      return null;
    }

    return (
      <div className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card">
        {isResult && (
          <div className="mb-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">
            {t('uiText.todoCount', { count: normalizedTodos.length })}
          </div>
        )}
        {normalizedTodos.map((todo, index) => (
          <TodoRow key={todo.id ?? `${todo.content}-${index}`} todo={todo} />
        ))}
      </div>
    );
  }
);

export default TodoList;
