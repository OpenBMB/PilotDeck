import type {
  PilotDeckTodoDiagnostics,
  PilotDeckPlanTodoStateHandle,
  PilotDeckPlanTodoStateSnapshot,
  PilotDeckTodoItem,
  PilotDeckTodoWriteHistoryEntry,
} from "../../tool/protocol/types.js";

type SessionPlanTodoState = {
  approvedPlan?: string;
  requiresInitialization: boolean;
  toolCallsSinceLastTodoWrite: number;
  lastMarkdown?: string;
  todos: PilotDeckTodoItem[];
  todoHistory: PilotDeckTodoWriteHistoryEntry[];
  largeRewriteCount: number;
  deletedOpenItemCount: number;
  completedWithoutActiveCount: number;
  lastWrite?: PilotDeckTodoDiagnostics["lastWrite"];
};

export type PlanTodoStateManager = {
  forSession(sessionId: string): PilotDeckPlanTodoStateHandle;
};

const TODO_WRITE_TOOL_NAME = "todo_write";
const VALID_TODO_STATUSES = new Set<PilotDeckTodoItem["status"]>([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

function normalizeTodoItem(item: PilotDeckTodoItem, index: number): PilotDeckTodoItem {
  const content = item.content.trim() || "(no description)";
  const status = VALID_TODO_STATUSES.has(item.status) ? item.status : "pending";
  return {
    id: item.id?.trim() || `todo-${index + 1}`,
    content,
    status,
    ...(item.priority?.trim() ? { priority: item.priority.trim() } : {}),
  };
}

function dedupeById(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  const lastIndex = new Map<string, number>();
  todos.forEach((todo, index) => {
    const id = todo.id?.trim() || `todo-${index + 1}`;
    lastIndex.set(id, index);
  });
  return [...lastIndex.values()].sort((a, b) => a - b).map((index) => todos[index]!);
}

function replaceTodos(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  return dedupeById(todos).map((todo, index) => normalizeTodoItem(todo, index));
}

function activeTodos(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  return todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
}

function cloneTodos(todos: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function mergeTodos(existingTodos: PilotDeckTodoItem[], updates: PilotDeckTodoItem[]): PilotDeckTodoItem[] {
  const existingById = new Map<string, PilotDeckTodoItem>();
  for (const [index, todo] of existingTodos.entries()) {
    const normalized = normalizeTodoItem(todo, index);
    existingById.set(normalized.id!, normalized);
  }

  const append: PilotDeckTodoItem[] = [];
  for (const update of dedupeById(updates)) {
    const id = update.id?.trim();
    if (id && existingById.has(id)) {
      const current = existingById.get(id)!;
      existingById.set(id, {
        ...current,
        ...(update.content.trim() ? { content: update.content.trim() } : {}),
        ...(VALID_TODO_STATUSES.has(update.status) ? { status: update.status } : {}),
        ...(update.priority?.trim() ? { priority: update.priority.trim() } : {}),
      });
      continue;
    }
    append.push(update);
  }

  const merged: PilotDeckTodoItem[] = [];
  const seen = new Set<string>();
  for (const [index, todo] of existingTodos.entries()) {
    const id = todo.id?.trim() || `todo-${index + 1}`;
    const current = existingById.get(id) ?? normalizeTodoItem(todo, index);
    if (!seen.has(current.id!)) {
      merged.push(current);
      seen.add(current.id!);
    }
  }
  const firstNewIndex = merged.length;
  append.forEach((todo, index) => {
    const normalized = normalizeTodoItem(todo, firstNewIndex + index);
    if (!seen.has(normalized.id!)) {
      merged.push(normalized);
      seen.add(normalized.id!);
    }
  });
  return merged;
}

function buildTodoDiagnostics(state: SessionPlanTodoState): PilotDeckTodoDiagnostics {
  const activeCount = activeTodos(state.todos).length;
  const completedCount = state.todos.filter((todo) => todo.status === "completed").length;
  const cancelledCount = state.todos.filter((todo) => todo.status === "cancelled").length;
  return {
    writeCount: state.todoHistory.length,
    todoCount: state.todos.length,
    activeCount,
    completedCount,
    cancelledCount,
    largeRewriteCount: state.largeRewriteCount,
    deletedOpenItemCount: state.deletedOpenItemCount,
    completedWithoutActiveCount: state.completedWithoutActiveCount,
    ...(state.lastWrite ? { lastWrite: state.lastWrite } : {}),
  };
}

function recordWrite(
  state: SessionPlanTodoState,
  nextTodos: PilotDeckTodoItem[],
  options: { mode: "markdown" | "structured"; merge?: boolean; markdown?: string; reason?: string },
): PilotDeckTodoItem[] {
  const previousTodos = state.todos;
  const previousById = new Map(previousTodos.map((todo) => [todo.id ?? todo.content, todo]));
  const nextById = new Map(nextTodos.map((todo) => [todo.id ?? todo.content, todo]));
  const removed = previousTodos.filter((todo) => !nextById.has(todo.id ?? todo.content));
  const added = nextTodos.filter((todo) => !previousById.has(todo.id ?? todo.content));
  const changed = nextTodos.filter((todo) => {
    const previous = previousById.get(todo.id ?? todo.content);
    return Boolean(previous) && (
      previous!.content !== todo.content ||
      previous!.status !== todo.status ||
      previous!.priority !== todo.priority
    );
  });
  const deletedOpenItemCount = removed.filter((todo) => todo.status === "pending" || todo.status === "in_progress").length;
  const previousActiveCount = activeTodos(previousTodos).length;
  const preservedCount = nextTodos.filter((todo) => previousById.has(todo.id ?? todo.content)).length;
  const largeRewrite = previousTodos.length > 0 && nextTodos.length > 0 && preservedCount < Math.ceil(previousTodos.length / 2);
  const allCompleted = nextTodos.length > 0 && activeTodos(nextTodos).length === 0 && nextTodos.every((todo) => todo.status === "completed" || todo.status === "cancelled");

  state.todos = cloneTodos(nextTodos);
  state.lastMarkdown = options.markdown;
  state.requiresInitialization = false;
  state.toolCallsSinceLastTodoWrite = 0;

  if (largeRewrite) state.largeRewriteCount += 1;
  state.deletedOpenItemCount += deletedOpenItemCount;
  if (allCompleted && previousActiveCount > 0) state.completedWithoutActiveCount += 1;

  state.lastWrite = {
    mode: options.mode,
    merge: Boolean(options.merge),
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    deletedOpenItemCount,
    largeRewrite,
    allCompleted,
  };

  const diagnostics = buildTodoDiagnostics(state);
  state.todoHistory.push({
    createdAt: new Date().toISOString(),
    mode: options.mode,
    merge: Boolean(options.merge),
    ...(options.reason?.trim() ? { reason: options.reason.trim() } : {}),
    ...(options.markdown !== undefined ? { markdown: options.markdown } : {}),
    todos: cloneTodos(state.todos),
    diagnostics,
  });
  return state.todos;
}

export function createPlanTodoStateManager(): PlanTodoStateManager {
  const states = new Map<string, SessionPlanTodoState>();

  function ensureState(sessionId: string): SessionPlanTodoState {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        requiresInitialization: false,
        toolCallsSinceLastTodoWrite: 0,
        todos: [],
        todoHistory: [],
        largeRewriteCount: 0,
        deletedOpenItemCount: 0,
        completedWithoutActiveCount: 0,
      };
      states.set(sessionId, state);
    }
    return state;
  }

  function snapshot(state: SessionPlanTodoState): PilotDeckPlanTodoStateSnapshot {
    return {
      approvedPlan: state.approvedPlan,
      requiresInitialization: state.requiresInitialization,
      toolCallsSinceLastTodoWrite: state.toolCallsSinceLastTodoWrite,
      lastMarkdown: state.lastMarkdown,
      todos: state.todos,
      activeTodos: activeTodos(state.todos),
      todoHistory: state.todoHistory,
      todoDiagnostics: buildTodoDiagnostics(state),
    };
  }

  function buildPromptAddendum(state: SessionPlanTodoState): string | undefined {
    if (!state.approvedPlan) return undefined;
    if (state.requiresInitialization) {
      return [
        "You are executing an approved plan.",
        `Before using any non-read-only tool, you MUST call \`${TODO_WRITE_TOOL_NAME}\` with a markdown checklist derived from the approved plan.`,
        "Represent completed items as `- [x]` and remaining items as `- [ ]`.",
      ].join("\n");
    }
    if (state.toolCallsSinceLastTodoWrite >= 10) {
      return [
        `You haven't updated the todo list in a while (${state.toolCallsSinceLastTodoWrite} tool calls since last update).`,
        `Consider calling \`${TODO_WRITE_TOOL_NAME}\` to reflect your current progress.`,
        "This is a gentle reminder — ignore if not applicable.",
      ].join(" ");
    }
    return undefined;
  }

  function blockingMessageFor(
    state: SessionPlanTodoState,
    toolName: string,
    isReadOnly: boolean,
  ): string | undefined {
    if (toolName === TODO_WRITE_TOOL_NAME || isReadOnly) {
      return undefined;
    }
    if (state.requiresInitialization) {
      return [
        "An approved plan is active, but the todo list has not been initialized yet.",
        `Call \`${TODO_WRITE_TOOL_NAME}\` first with a markdown checklist based on the approved plan, then retry this tool.`,
      ].join(" ");
    }
    return undefined;
  }

  return {
    forSession(sessionId: string): PilotDeckPlanTodoStateHandle {
      const state = ensureState(sessionId);
      return {
        getSnapshot: () => snapshot(state),
        markPlanApproved(plan: string) {
          state.approvedPlan = plan.trim() || undefined;
          state.requiresInitialization = Boolean(state.approvedPlan);
          state.toolCallsSinceLastTodoWrite = 0;
          state.lastMarkdown = undefined;
          state.todos = [];
          state.todoHistory = [];
          state.largeRewriteCount = 0;
          state.deletedOpenItemCount = 0;
          state.completedWithoutActiveCount = 0;
          state.lastWrite = undefined;
        },
        recordTodoWrite(markdown: string, todos: PilotDeckTodoItem[], options?: { reason?: string }) {
          return recordWrite(state, replaceTodos(todos), { mode: "markdown", markdown, reason: options?.reason });
        },
        writeTodos(todos: PilotDeckTodoItem[], options?: { markdown?: string; merge?: boolean; reason?: string }) {
          const nextTodos = options?.merge ? mergeTodos(state.todos, todos) : replaceTodos(todos);
          return recordWrite(state, nextTodos, {
            mode: "structured",
            merge: options?.merge,
            markdown: options?.markdown,
            reason: options?.reason,
          });
        },
        markToolProgressChanged(toolName: string) {
          if (!state.approvedPlan || toolName === TODO_WRITE_TOOL_NAME) {
            return;
          }
          if (state.requiresInitialization) {
            return;
          }
          state.toolCallsSinceLastTodoWrite += 1;
        },
        buildPromptAddendum: () => buildPromptAddendum(state),
        blockingMessageFor: (toolName, isReadOnly) =>
          blockingMessageFor(state, toolName, isReadOnly),
      };
    },
  };
}
