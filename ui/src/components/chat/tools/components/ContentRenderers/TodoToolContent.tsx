import { useId, useState } from 'react';
import { ChevronRight, ListTodo } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AnimatedDisclosure } from '../../../../ui/AnimatedDisclosure';
import TodoList, { type TodoItem } from './TodoList';

/** One tool seat owns the checklist and its successful acknowledgement. */
export function TodoToolContent({ todos, resolved }: { todos: TodoItem[]; resolved: boolean }) {
  const { t } = useTranslation('common');
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const safeTodos = Array.isArray(todos) ? todos.filter(todo => todo && typeof todo.content === 'string') : [];
  const completed = safeTodos.filter(todo => todo.status === 'completed').length;
  const label = t(resolved ? 'uiText.todoList' : 'uiText.updatingTodos');
  const progress = safeTodos.length > 0 ? t('uiText.todoProgress', { completed, count: safeTodos.length }) : '';
  return <div data-todo-tool className="w-full min-w-0">
    <button type="button" className="chat-process-trigger hover-brand-text" aria-label={[label, progress].filter(Boolean).join(' ')} aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(!expanded)}>
      <ListTodo aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      <span>{label}</span>
      {progress && <span className="tabular-nums text-muted-foreground">{progress}</span>}
      <ChevronRight aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${expanded ? 'rotate-90' : ''}`} />
    </button>
    <AnimatedDisclosure id={id} expanded={expanded} contentClassName="ml-[22px] mt-2">
      <TodoList todos={safeTodos} />
    </AnimatedDisclosure>
  </div>;
}
