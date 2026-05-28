import type {
  PilotDeckPlanTodoStateHandle,
  PilotDeckPlanTodoStateSnapshot,
  PilotDeckTodoItem,
} from "../../tool/protocol/types.js";

type SessionPlanTodoState = {
  approvedPlan?: string;
  requiresInitialization: boolean;
  requiresRefresh: boolean;
  lastMarkdown?: string;
  todos: PilotDeckTodoItem[];
};

export type PlanTodoStateManager = {
  forSession(sessionId: string): PilotDeckPlanTodoStateHandle;
};

const TODO_WRITE_TOOL_NAME = "todo_write";

export function createPlanTodoStateManager(): PlanTodoStateManager {
  const states = new Map<string, SessionPlanTodoState>();

  function ensureState(sessionId: string): SessionPlanTodoState {
    let state = states.get(sessionId);
    if (!state) {
      state = {
        requiresInitialization: false,
        requiresRefresh: false,
        todos: [],
      };
      states.set(sessionId, state);
    }
    return state;
  }

  function snapshot(state: SessionPlanTodoState): PilotDeckPlanTodoStateSnapshot {
    return {
      approvedPlan: state.approvedPlan,
      requiresInitialization: state.requiresInitialization,
      requiresRefresh: state.requiresRefresh,
      lastMarkdown: state.lastMarkdown,
      todos: state.todos,
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
    if (state.requiresRefresh) {
      return [
        "Your todo checklist is stale.",
        `Before the next non-read-only tool call, you MUST call \`${TODO_WRITE_TOOL_NAME}\` again and update the markdown checklist to reflect the latest completed steps.`,
      ].join("\n");
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
    if (state.requiresRefresh) {
      return [
        "The todo list is stale after progress was made on the approved plan.",
        `Call \`${TODO_WRITE_TOOL_NAME}\` first to update the markdown checklist and mark completed items, then retry this tool.`,
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
          state.requiresRefresh = false;
          state.lastMarkdown = undefined;
          state.todos = [];
        },
        recordTodoWrite(markdown: string, todos: PilotDeckTodoItem[]) {
          state.lastMarkdown = markdown;
          state.todos = todos;
          state.requiresInitialization = false;
          state.requiresRefresh = false;
        },
        markToolProgressChanged(toolName: string) {
          if (!state.approvedPlan || toolName === TODO_WRITE_TOOL_NAME) {
            return;
          }
          if (state.requiresInitialization) {
            return;
          }
          state.requiresRefresh = true;
        },
        buildPromptAddendum: () => buildPromptAddendum(state),
        blockingMessageFor: (toolName, isReadOnly) =>
          blockingMessageFor(state, toolName, isReadOnly),
      };
    },
  };
}
