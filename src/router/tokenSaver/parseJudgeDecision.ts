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
  return {
    tier,
    ...(confidence === undefined ? {} : { confidence }),
    taskRelation: parseRelation(text),
  };
}

/**
 * Some reasoning-capable compatible APIs may exhaust max_tokens before they
 * emit the requested final tags, while their reasoning block already contains
 * the classification. Recover only explicit conclusion phrases from that
 * block. A generic tier mention is unsafe because the reasoning often repeats
 * the previous tier before reaching its conclusion. The ordinary text parser
 * remains the primary path.
 */
export function parseJudgeDecisionFromThinking(
  text: string,
  knownTiers: string[],
): ParsedJudgeDecision | undefined {
  const tierAlternation = knownTiers.map(escapeRegex).join("|");
  if (!tierAlternation) return undefined;
  const conclusionPatterns = [
    new RegExp(
      `\\b(?:so|therefore|thus|hence|choose|select|return(?:ing)?|`
        + `classif(?:y|ied|ying)(?:\\s+(?:it\\s+)?as)?|`
        + `route(?:d|ing)?(?:\\s+(?:it\\s+)?to)?|`
        + `assign(?:ed|ing)?(?:\\s+(?:it\\s+)?to)?)`
        + `\\s+(?:the\\s+)?(${tierAlternation})(?:\\s+tier)?\\b`,
      "gi",
    ),
    new RegExp(
      `\\b(?:appropriate|chosen|final|resulting)\\s+tier\\s*(?:is|:)?\\s*`
        + `(${tierAlternation})\\b`,
      "gi",
    ),
    new RegExp(
      `(?:因此|所以|故|选择|判定为|归类为|应为|应该是|路由到)\\s*`
        + `(${tierAlternation})(?:\\s*(?:档|层级|tier))?`,
      "gi",
    ),
  ];
  let selected: { tier: string; index: number } | undefined;
  for (const pattern of conclusionPatterns) {
    for (const match of text.matchAll(pattern)) {
      const tier = knownTiers.find((candidate) => candidate.toLowerCase() === match[1]?.toLowerCase());
      const index = match.index ?? -1;
      if (tier && (!selected || index > selected.index)) selected = { tier, index };
    }
  }
  if (!selected) return undefined;
  const confidence = parseConfidence(text);
  return {
    tier: selected.tier,
    ...(confidence === undefined ? {} : { confidence }),
    taskRelation: parseRelation(text),
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

function parseRelation(text: string): JudgeTaskRelation {
  const relation = /<task_relation>\s*(continuation|new[_ -]?task|unclear)\s*<\/task_relation>/i.exec(text)?.[1]
    ?.toLowerCase()
    .replace(/[ -]/g, "_");
  return relation === "continuation" || relation === "new_task" ? relation : "unclear";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
