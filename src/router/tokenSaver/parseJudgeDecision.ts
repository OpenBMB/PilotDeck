import { parseTier } from "./parseTier.js";

export type JudgeTaskRelation = "continuation" | "new_task" | "unclear";

export type ParsedJudgeDecision = {
  tier: string;
  confidence?: number;
  taskRelation: JudgeTaskRelation;
};

export function parseJudgeDecision(
  text: string,
  knownTiers: string[],
): ParsedJudgeDecision | undefined {
  const tier = parseTier(text, knownTiers);
  if (!tier) return undefined;

  const confidence = parseConfidence(text);
  const relation = /<task_relation>\s*(continuation|new[_ -]?task|unclear)\s*<\/task_relation>/i.exec(text)?.[1]
    ?.toLowerCase()
    .replace(/[ -]/g, "_");

  return {
    tier,
    ...(confidence === undefined ? {} : { confidence }),
    taskRelation: relation === "continuation" || relation === "new_task"
      ? relation
      : "unclear",
  };
}

function parseConfidence(text: string): number | undefined {
  const raw = /<confidence>\s*([0-9]+(?:\.[0-9]+)?%?)\s*<\/confidence>/i.exec(text)?.[1];
  if (!raw) return undefined;
  const percentage = raw.endsWith("%");
  const parsed = Number.parseFloat(percentage ? raw.slice(0, -1) : raw);
  if (!Number.isFinite(parsed)) return undefined;
  const normalized = percentage || parsed > 1 ? parsed / 100 : parsed;
  if (normalized < 0 || normalized > 1) return undefined;
  return normalized;
}
