import type { RouterTokenSaverConfig } from "../config/schema.js";
import type { TaskCard } from "./buildTaskCard.js";

export type JudgePromptInput = {
  userMessage: string;
  config: RouterTokenSaverConfig;
  /** Deterministic read-only snapshot of the current task; background context only. */
  taskCard?: TaskCard;
  /** Tier from the previous turn; background context only — never a forced inheritance. */
  previousTier?: string;
};

/** Total budget (chars) for the serialized card block sent to the judge. */
const CARD_TEXT_BUDGET_CHARS = 1500;

export function generateJudgePrompt({ userMessage, config, taskCard, previousTier }: JudgePromptInput): string {
  const tierLines = Object.entries(config.tiers)
    .map(([name, tier]) => {
      const desc = tier.description ? `: ${tier.description}` : "";
      return `- ${name}${desc}`;
    })
    .join("\n");

  const ruleLines = (config.rules ?? []).map((rule) => `- ${rule}`).join("\n");
  const rulesSection = ruleLines.length > 0 ? `\nRouting rules:\n${ruleLines}\n` : "";

  const cardSection = taskCard
    ? `\n## Current task card\n${formatTaskCardBlock(taskCard)}\n`
    : "";

  const contextSection = previousTier
    ? `\n## Background\nThe previous turn was classified as tier: **${previousTier}**. Treat this strictly as background context; do not assume the message continues that task, and do not force the same tier.\n`
    : "";

  return `You are a model-tier classifier for the PilotDeck router. Given the following user message, classify it into exactly one of the available tiers.\n\nAvailable tiers:\n${tierLines}\n${rulesSection}${cardSection}${contextSection}\nUser message:\n"""\n${userMessage}\n"""\n\nDefault tier when uncertain: ${config.defaultTier}.\n\nRespond with exactly:\n<tier>reasoning</tier>\n<new_task>yes|no</new_task>\n\nOutput rules:\n- <tier> is required and its content must be one of the available tier names.\n- <new_task> is optional; include it only when you are confident. Answer "yes" when the user message starts a genuinely different task instead of continuing the current one, otherwise "no".\n- Do not rewrite the goal, do not emit free-form explanations outside the tags.`;
}

/**
 * Serialize only the four judge-relevant card fields (goal, phase, keyFiles,
 * taskDone). updatedAt, todos and plan bodies never enter the prompt. When the
 * serialized block would exceed the budget, truncate the goal first, then drop
 * files from the end of the list; XML tags are never cut.
 */
function formatTaskCardBlock(card: TaskCard): string {
  let goal = card.goal?.trim() ?? "";
  let keyFiles = card.keyFiles ?? [];

  const render = (): string =>
    [
      "<task_card>",
      goal.length > 0 ? `<goal>${goal}</goal>` : "",
      card.phase ? `<phase>${card.phase}</phase>` : "",
      keyFiles.length > 0
        ? ["<key_files>", ...keyFiles.map((file) => `- ${file}`), "</key_files>"].join("\n")
        : "",
      `<task_done>${card.taskDone ? "true" : "false"}</task_done>`,
      "</task_card>",
    ]
      .filter((line) => line.length > 0)
      .join("\n");

  let block = render();
  if (block.length <= CARD_TEXT_BUDGET_CHARS) {
    return block;
  }

  // Truncate the goal first; slicing goal text can never cut an XML tag.
  if (goal.length > 0) {
    const ELLIPSIS = "...";
    const overhead = block.length - goal.length;
    const allowedGoalChars = CARD_TEXT_BUDGET_CHARS - overhead - ELLIPSIS.length;
    goal = allowedGoalChars > 0 ? `${goal.slice(0, allowedGoalChars)}${ELLIPSIS}` : "";
    block = render();
    if (block.length <= CARD_TEXT_BUDGET_CHARS) {
      return block;
    }
  }

  // Then drop whole file entries from the end of the list.
  while (keyFiles.length > 0 && block.length > CARD_TEXT_BUDGET_CHARS) {
    keyFiles = keyFiles.slice(0, -1);
    block = render();
  }
  return block;
}
