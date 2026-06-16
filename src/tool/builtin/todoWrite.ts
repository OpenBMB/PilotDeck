import type {
  PilotDeckTodoItem,
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
} from "../protocol/types.js";

export type TodoWriteInput = {
  markdown: string;
};

export type TodoWriteOutput = {
  markdown: string;
  todos: PilotDeckTodoItem[];
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
        "Update the execution todo list from a markdown checklist. Use `- [x]` for completed items and `- [ ]` for remaining items.",
        "This tool only updates a checklist; it does not write, submit, or replace a final plan.",
        "In plan mode, do not use todo_write to write the plan itself, and do not treat a todo list as the final plan.",
        "You may use todo_write in plan mode only to organize planning work such as exploration, analysis, writing a markdown plan under `.pilotdeck/plans/`, and submitting that plan with `exit_plan_mode`.",
      ].join(" "),
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["markdown"],
      additionalProperties: false,
      properties: {
        markdown: {
          type: "string",
          description: "Markdown checklist content using `- [ ]` and `- [x]` items.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<TodoWriteOutput>> => {
      const todos = parseTodoMarkdown(input.markdown);
      context.planTodo?.recordTodoWrite(input.markdown, todos);
      return {
        content: [{ type: "text", text: "Todo list updated" }],
        data: {
          markdown: input.markdown,
          todos,
        },
        metadata: {
          todoCount: todos.length,
        },
      };
    },
  };
}
