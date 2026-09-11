export type RoutePhase = "understand" | "execute" | "verify";

export type TaskSnapshotTodo = {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
};

export type TaskSnapshot = {
  approvedPlan?: string;
  requiresInitialization: boolean;
  todos: TaskSnapshotTodo[];
  activeTodoCount: number;
  allCompleted: boolean;
  keyFiles: string[];
};

export type TaskCard = {
  goal?: string;
  phase?: RoutePhase;
  keyFiles: string[];
  taskDone: boolean;
  updatedAt: number;
};

export type UpgradeEvidence =
  | "verification_failed"
  | "todo_expanded"
  | "repeated_tool_error"
  | "high_reliability_request";

export type ContinuationRoutingInfo = {
  matched: true;
  previousTier: string;
  previousProvider: string;
  previousModel: string;
};

const GOAL_MAX_LENGTH = 600;
const KEY_FILE_MAX_COUNT = 5;
const KEY_FILE_MAX_LENGTH = 240;

export function buildTaskCard(
  snapshot: TaskSnapshot | undefined,
  now: number,
): TaskCard | undefined {
  if (!snapshot) {
    return undefined;
  }

  const keyFiles = normalizeKeyFiles(snapshot.keyFiles);
  const nonEmptyTodoContents = snapshot.todos
    .map(todo => normalizeText(todo.content))
    .filter(content => content.length > 0);
  const planGoal = normalizeText(firstNonEmptyPlanLine(snapshot.approvedPlan));
  const todoGoal = normalizeText(nonEmptyTodoContents.slice(0, 3).join("; "));
  const goal = planGoal.length > 0 ? planGoal : todoGoal;

  if (!goal && nonEmptyTodoContents.length === 0 && keyFiles.length === 0) {
    return undefined;
  }

  const taskDone =
    snapshot.todos.length > 0
    && (snapshot.allCompleted === true
      || snapshot.todos.every(
        todo => todo.status === "completed" || todo.status === "cancelled",
      ));

  return {
    goal: goal || undefined,
    phase: derivePhase(snapshot, taskDone),
    keyFiles,
    taskDone,
    updatedAt: now,
  };
}

function firstNonEmptyPlanLine(plan: string | undefined): string | undefined {
  if (!plan) {
    return undefined;
  }
  const lines = plan.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length > 0) {
      return line;
    }
  }
  return undefined;
}

function normalizeText(text: string | undefined): string {
  if (!text) {
    return "";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, GOAL_MAX_LENGTH);
}

function normalizeKeyFiles(keyFiles: string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const keyFile of keyFiles ?? []) {
    const trimmed = keyFile.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed.slice(0, KEY_FILE_MAX_LENGTH));
    if (normalized.length >= KEY_FILE_MAX_COUNT) {
      break;
    }
  }
  return normalized;
}

function derivePhase(snapshot: TaskSnapshot, taskDone: boolean): RoutePhase | undefined {
  if (snapshot.requiresInitialization === true) {
    return "understand";
  }
  if (snapshot.todos.some(todo => todo.status === "in_progress")) {
    return "execute";
  }
  if (snapshot.todos.length > 0 && !taskDone) {
    return "verify";
  }
  return undefined;
}
