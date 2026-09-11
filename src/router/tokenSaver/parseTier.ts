const TIER_TAG_PATTERN = /<tier>\s*([a-z0-9_-]+)\s*<\/tier>/i;
const NEW_TASK_TAG_PATTERN = /<new_task>\s*([a-z]+)\s*<\/new_task>/i;

export type ParsedJudgeDecision = {
  tier?: string;
  isNewTask?: boolean;
};

export function parseJudgeDecision(
  judgeOutput: string,
  knownTiers: string[],
): ParsedJudgeDecision {
  const cleaned = stripFences(judgeOutput);
  const decision: ParsedJudgeDecision = {};

  const tier = parseTier(judgeOutput, knownTiers);
  if (tier) {
    decision.tier = tier;
  }

  const newTaskMatch = NEW_TASK_TAG_PATTERN.exec(cleaned);
  if (newTaskMatch) {
    const value = newTaskMatch[1].toLowerCase();
    if (value === "yes") {
      decision.isNewTask = true;
    } else if (value === "no") {
      decision.isNewTask = false;
    }
    // Anything else (maybe, misspellings, ...) stays undefined without
    // breaking a valid tier decision.
  }

  return decision;
}

function stripFences(judgeOutput: string): string {
  return judgeOutput.replace(/```[a-z]*\n?/g, "").replace(/```/g, "").trim();
}

export function parseTier(judgeOutput: string, knownTiers: string[]): string | undefined {
  const cleaned = stripFences(judgeOutput);

  const match = TIER_TAG_PATTERN.exec(cleaned);
  if (match) {
    const candidate = match[1];
    const found = knownTiers.find(t => t.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }

  for (const tier of knownTiers) {
    const pattern = new RegExp(`\\b${escapeRegex(tier)}\\b`, "i");
    if (pattern.test(cleaned)) {
      return tier;
    }
  }

  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
