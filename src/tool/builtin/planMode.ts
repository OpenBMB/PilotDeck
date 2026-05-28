import { readFileSync } from "node:fs";
import type { PilotDeckElicitationAnswer, PilotDeckElicitationRequest } from "../elicitation/PilotDeckElicitationChannel.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type { PilotDeckToolDefinition } from "../protocol/types.js";

export type ExitPlanModeInput = {
  plan_file_path: string;
};
export type ExitPlanModeOutput = {
  plan: string;
  requestedMode?: "default";
  action?: "continue_planning" | "execute_plan" | "cancelled";
  feedback?: string;
  planFilePath?: string;
  planTitle?: string;
  planSummary?: string;
};

const EXIT_PLAN_MODE_QUESTION = "What should happen next?";
const EXIT_PLAN_MODE_CONTINUE = "continue_planning";
const EXIT_PLAN_MODE_EXECUTE = "execute_plan";

const ENTER_PLAN_MODE_DESCRIPTION =
  "Enter plan mode for complex tasks requiring exploration and design. " +
  "Switches to a read-only phase where you explore the codebase, understand patterns, " +
  "and write a structured plan to a plan file before making any changes. " +
  "Prefer using this tool for non-trivial implementation tasks, especially when: " +
  "multiple valid approaches exist, the task touches many files, " +
  "or requirements need exploration to fully understand. " +
  "Do NOT call this tool if you are already in plan mode.";

const EXIT_PLAN_MODE_DESCRIPTION =
  "Signal that your plan is complete and ready for user review. " +
  "Pass the plan_file_path for the markdown plan you want to submit from `.pilotdeck/plans`. " +
  "Do NOT use ask_user_question to ask about plan approval — that is exactly what this tool does.";

function buildEnterPlanModeResult(planDirectoryPath: string | undefined): string {
  const planDirectorySection = planDirectoryPath
    ? `## Plan Directory\nCreate your plan as a markdown file under: ${planDirectoryPath}\nYou may name the file yourself, but it must live under this directory.\n`
    : "";

  return [
    "Plan mode activated. You are now in a read-only exploration and planning phase.",
    "",
    planDirectorySection,
    "## What To Do",
    "1. Explore the codebase using read_file, grep, glob to understand existing patterns and structure",
    "2. Identify the key files, functions, and data flows relevant to the task",
    "3. Design your implementation approach — consider trade-offs between alternatives",
    ...(planDirectoryPath
      ? [
          "4. Create and refine your own markdown plan file under the plan directory above",
          "5. When your plan is ready, call exit_plan_mode with the plan_file_path you want to submit",
        ]
      : ["4. When your plan is ready, call exit_plan_mode to present it for user approval"]),
    "",
    "## Rules",
    `- DO NOT call write_file, edit_file, or bash (non-readonly) on any file${planDirectoryPath ? " except markdown plan files under the designated plan directory" : ""}`,
    "- You MAY use ask_user_question to clarify requirements or choose between approaches",
    "- Focus on understanding before proposing — read first, plan second",
  ].join("\n");
}

function buildAlreadyInPlanModeResult(planDirectoryPath: string | undefined): string {
  return [
    "Plan mode is already active.",
    "",
    ...(planDirectoryPath
      ? [
          `Your plan directory is: ${planDirectoryPath}`,
          "Continue refining markdown plan files under that directory, then submit one explicitly with exit_plan_mode(plan_file_path).",
          "",
        ]
      : []),
    "Stay in read-only exploration/planning until you are ready to call exit_plan_mode.",
  ].join("\n");
}

function buildApprovedPlanResult(plan: string, planFilePath: string | undefined): string {
  const locationSection = planFilePath
    ? [
        `Submitted plan file: ${planFilePath}`,
        "You can refer back to it during implementation if needed.",
        "",
      ]
    : [];
  return [
    "User has approved your plan. You can now start coding.",
    'Do NOT output any confirmation text like "Plan approved, starting implementation" — the user already knows. Proceed directly with todo_write and implementation.',
    "Before using any non-read-only tool, you MUST call todo_write with a markdown checklist derived from the approved plan.",
    "After each completed implementation step, call todo_write again to refresh the checklist and mark completed items with `- [x]`.",
    "",
    ...locationSection,
    "## Approved Plan",
    plan,
  ].join("\n");
}

function buildContinuePlanningResult(feedback: string | undefined): string {
  const feedbackSection = feedback
    ? `\n\nUser feedback:\n${feedback}`
    : "\n\nNo additional feedback was provided.";
  return [
    "The user wants to continue planning before implementation.",
    "Stay in plan mode, refine the plan file, and call exit_plan_mode again when the updated plan is ready.",
  ].join(" ") + feedbackSection;
}

function getExitPlanFeedback(answer: PilotDeckElicitationAnswer): string | undefined {
  if (answer.type !== "answered" || !answer.annotations) {
    return undefined;
  }
  for (const annotation of Object.values(answer.annotations)) {
    if (annotation?.notes?.trim()) {
      return annotation.notes.trim();
    }
  }
  return undefined;
}

function getExitPlanAction(answer: PilotDeckElicitationAnswer): "continue_planning" | "execute_plan" | undefined {
  if (answer.type !== "answered") {
    return undefined;
  }
  for (const value of Object.values(answer.answers)) {
    if (Array.isArray(value)) {
      const action = value.find((entry) => entry === EXIT_PLAN_MODE_CONTINUE || entry === EXIT_PLAN_MODE_EXECUTE);
      if (action) return action;
      continue;
    }
    if (value === EXIT_PLAN_MODE_CONTINUE || value === EXIT_PLAN_MODE_EXECUTE) {
      return value;
    }
  }
  return undefined;
}

export function createEnterPlanModeTool(): PilotDeckToolDefinition<Record<string, never>> {
  return {
    name: "enter_plan_mode",
    aliases: ["EnterPlanMode"],
    description: ENTER_PLAN_MODE_DESCRIPTION,
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async (_input, context) => {
      if (context?.permissionMode === "plan") {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          buildAlreadyInPlanModeResult(context?.planDirectory?.path),
        );
      }
      const text = buildEnterPlanModeResult(context?.planDirectory?.path);
      return {
        content: [{ type: "text", text }],
        data: { requestedMode: "plan" },
      };
    },
  };
}

export function createExitPlanModeTool(): PilotDeckToolDefinition<ExitPlanModeInput, ExitPlanModeOutput> {
  return {
    name: "exit_plan_mode",
    aliases: ["ExitPlanMode"],
    description: EXIT_PLAN_MODE_DESCRIPTION,
    kind: "session",
    inputSchema: {
      type: "object",
      required: ["plan_file_path"],
      additionalProperties: false,
      properties: {
        plan_file_path: {
          type: "string",
          description: "Path to the markdown plan file to submit from the current project's `.pilotdeck/plans` directory.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    execute: async (input, context) => {
      const channel = context?.elicitation;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "exit_plan_mode requires a connected user interaction channel.",
        );
      }
      const resolvedPlanFilePath = context?.planDirectory?.resolve(input.plan_file_path);
      if (!resolvedPlanFilePath) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "plan_file_path must point to a markdown file under the current project's .pilotdeck/plans directory.",
        );
      }
      let plan: string;
      try {
        plan = readFileSync(resolvedPlanFilePath, "utf8").trim();
      } catch {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Plan file does not exist or could not be read: ${resolvedPlanFilePath}`,
        );
      }
      if (!plan) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          "Plan file is empty. Write your plan first before calling exit_plan_mode.",
        );
      }
      const request: PilotDeckElicitationRequest = {
        toolCallId: context.turnId,
        toolName: "exit_plan_mode",
        previewFormat: "markdown",
        questions: [
          {
            question: EXIT_PLAN_MODE_QUESTION,
            header: "Plan",
            options: [
              {
                label: EXIT_PLAN_MODE_CONTINUE,
                description: "Keep planning and update the plan before any implementation starts.",
              },
              {
                label: EXIT_PLAN_MODE_EXECUTE,
                description: "Leave plan mode and let the agent execute this plan.",
              },
            ],
          },
        ],
        metadata: {
          source: "exit_plan_mode",
          plan,
          planFilePath: resolvedPlanFilePath,
        },
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
      };
      const answer = await channel.askUser(request);
      const action = getExitPlanAction(answer);
      const feedback = getExitPlanFeedback(answer);

      if (answer.type === "cancelled" || !action) {
        return {
          content: [{
            type: "text",
            text: "Exit plan mode was cancelled. Stay in plan mode and continue refining the plan file.",
          }],
          data: { plan, action: "cancelled" },
        };
      }

      if (action === EXIT_PLAN_MODE_EXECUTE) {
        context.planTodo?.markPlanApproved(plan);
        const titleMatch = plan.match(/^#\s+(.+)$/m);
        const planTitle = titleMatch?.[1];
        const summaryLines = plan.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
        const planSummary = summaryLines.slice(0, 2).join("\n").slice(0, 200) || undefined;
        return {
          content: [{
            type: "text",
            text: buildApprovedPlanResult(plan, resolvedPlanFilePath),
          }],
          data: { plan, action, requestedMode: "default", planFilePath: resolvedPlanFilePath, planTitle, planSummary },
        };
      }

      return {
        content: [{
          type: "text",
          text: buildContinuePlanningResult(feedback),
        }],
        data: { plan, action, ...(feedback ? { feedback } : {}) },
      };
    },
  };
}
