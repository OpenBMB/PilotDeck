import type {
  PilotDeckTodoDiagnostics,
  PilotDeckTodoItem,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type TodoWriteInput = {
  markdown?: string;
  todos?: PilotDeckTodoItem[];
  merge?: boolean;
  reason?: string;
};

export type TodoWriteOutput = {
  markdown?: string;
  todos: PilotDeckTodoItem[];
  mode: "read" | "markdown" | "structured";
  merge: boolean;
  reason?: string;
  diagnostics?: PilotDeckTodoDiagnostics;
};

const TODO_LINE_PATTERN = /^\s*[-*]\s+\[( |x|X)\]\s+(.*?)\s*$/u;

export function parseTodoMarkdown(markdown: string): PilotDeckTodoItem[] {
  const lines = markdown.split(/\r?\n/u);
  const parsed: Array<{ checked: boolean; content: string }> = [];
  for (const line of lines) {
    const match = TODO_LINE_PATTERN.exec(line);
    if (!match) continue;
    const content = match[2]?.trim();
    if (!content) continue;
    parsed.push({
      checked: match[1].toLowerCase() === "x",
      content,
    });
  }

  let assignedInProgress = false;
  return parsed.map((item, index) => {
    let status: PilotDeckTodoItem["status"];
    if (item.checked) {
      status = "completed";
    } else if (!assignedInProgress) {
      status = "in_progress";
      assignedInProgress = true;
    } else {
      status = "pending";
    }
    return {
      id: `todo-${index + 1}`,
      content: item.content,
      status,
    };
  });
}

export function createTodoWriteTool(): PilotDeckToolDefinition<TodoWriteInput, TodoWriteOutput> {
  return {
    name: "todo_write",
    aliases: ["TodoWrite"],
    description:
      [
        "Read or update a lightweight session checklist for complex work.",
        "Call with no arguments to read the current todo list.",
        "For editable todos, provide `todos` with stable ids and optional `merge=true` to update by id and append new items.",
        "For legacy checklist updates, provide `markdown` using `- [x]` for completed items and `- [ ]` for remaining items.",
        "Use for complex 3+ step tasks, multi-deliverable work, codebase exploration, batch processing, information gathering, or generation work.",
        "Do a small amount of exploration before writing a detailed list; use todos as checkable checkpoints, not a rigid plan lock.",
        "Use status pending, in_progress, completed, or cancelled. Keep only one item in_progress when possible.",
        "Mark an item completed only after checking relevant evidence. If an approach fails or assumptions change, mark the old item cancelled and add a revised item instead of silently rewriting it as completed.",
        "When changing the todo structure mid-task, include `reason` so the change is auditable in the tool result.",
        "Prefer a final verification checkpoint that checks outputs, format, counts, extra artifacts, and key constraints when applicable.",
        "This tool only updates a checklist; it does not write files, submit, or replace a final plan.",
        "In plan mode, do not use todo_write to write the plan itself, and do not treat a todo list as the final plan.",
        "You may use todo_write in plan mode only to organize planning work such as exploration, analysis, writing a markdown plan under `.pilotdeck/plans/`, and submitting that plan with `exit_plan_mode`.",
      ].join(" "),
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        markdown: {
          type: "string",
          description: "Legacy markdown checklist content using `- [ ]` and `- [x]` items. Replaces the current list.",
        },
        todos: {
          type: "array",
          description: "Editable todo items. Omit to read current list, or provide with merge=true to update by id.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "status"],
            properties: {
              id: {
                type: "string",
                description: "Stable todo identifier. Required for reliable merge updates.",
              },
              content: {
                type: "string",
                description: "Todo item description.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed", "cancelled"],
                description: "Current todo status.",
              },
              priority: {
                type: "string",
                description: "Optional priority label such as high, medium, or low.",
              },
            },
          },
        },
        merge: {
          type: "boolean",
          description: "When todos are provided, true updates existing items by id and appends new items; false replaces the list.",
          default: false,
        },
        reason: {
          type: "string",
          description: "Optional reason for structural todo changes, especially added/cancelled/reordered items.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<TodoWriteOutput>> => {
      let mode: TodoWriteOutput["mode"] = "read";
      let snapshot = context.planTodo?.getSnapshot();
      let todos = snapshot?.todos ?? [];
      const merge = Boolean(input.merge);
      const reason = input.reason?.trim();

      if (Array.isArray(input.todos)) {
        mode = "structured";
        todos = context.planTodo?.writeTodos(input.todos, { merge, reason }) ?? input.todos;
      } else if (typeof input.markdown === "string") {
        mode = "markdown";
        todos = parseTodoMarkdown(input.markdown);
        todos = context.planTodo?.recordTodoWrite(input.markdown, todos, { reason }) ?? todos;
      }
      snapshot = context.planTodo?.getSnapshot();
      const diagnostics = snapshot?.todoDiagnostics;

      return {
        content: [{ type: "text", text: mode === "read" ? "Todo list read" : "Todo list updated" }],
        data: {
          ...(typeof input.markdown === "string" ? { markdown: input.markdown } : {}),
          todos,
          mode,
          merge,
          ...(reason ? { reason } : {}),
          ...(diagnostics ? { diagnostics } : {}),
        },
        metadata: {
          todoCount: todos.length,
          mode,
          ...(diagnostics ? { diagnostics } : {}),
        },
      };
    },
  };
}
