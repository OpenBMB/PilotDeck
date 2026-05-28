import type { RouterTokenSaverConfig } from "../config/schema.js";

export type JudgePromptInput = {
  userMessage: string;
  config: RouterTokenSaverConfig;
  /** Tier from the previous turn; helps the judge avoid mis-downgrading short continuation messages. */
  previousTier?: string;
};

export function generateJudgePrompt({ userMessage, config, previousTier }: JudgePromptInput): string {
  const tierLines = Object.entries(config.tiers)
    .map(([name, tier]) => {
      const desc = tier.description ? `: ${tier.description}` : "";
      return `- ${name}${desc}`;
    })
    .join("\n");

  const ruleLines = (config.rules ?? []).map((rule) => `- ${rule}`).join("\n");
  const rulesSection = ruleLines.length > 0 ? `\nRouting rules:\n${ruleLines}\n` : "";

  const contextSection = previousTier
    ? `\n## CRITICAL RULE — Continuation messages\nThe previous turn was classified as: **${previousTier}**.\nShort messages like "go", "continue", "ok", "yes", "好的", "继续", "开始", "冲" etc. are continuations of the previous task. They are NOT new simple requests.\nFor ANY message that is clearly a continuation or acknowledgment of the previous task, you MUST return <tier>${previousTier}</tier>.\nOnly reclassify if the user message introduces a genuinely NEW task with different complexity.\n`
    : "";

  return `You are a model-tier classifier for the PilotDeck router. Given the following user message, return exactly one tier wrapped in <tier>...</tier>.\n\nAvailable tiers:\n${tierLines}\n${rulesSection}${contextSection}\nUser message:\n"""\n${userMessage}\n"""\n\nDefault tier when uncertain: ${config.defaultTier}.\nRespond with only <tier>NAME</tier>.`;
}
