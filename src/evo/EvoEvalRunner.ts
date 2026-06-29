/**
 * Baseline vs candidate evaluation over a manual eval set.
 *
 * The interface is pluggable so a future replay-based evaluator (re-running a
 * batch of historical tasks through the agent with each version) can drop in.
 * The default `KeywordCoverageEvaluator` is deterministic: for each eval item
 * it scores how well the target content covers the item's expected keywords,
 * approximating the plan's "error rate / rounds / output quality" report at the
 * MVP level without any model calls.
 */

import type { EvoEvalItem, EvoEvalReport, EvoEvalScore } from "./protocol/types.js";

export type EvoEvaluateInput = {
  baseContent: string;
  candidateContent: string;
  evalSet: EvoEvalItem[];
};

export interface EvoEvaluator {
  evaluate(input: EvoEvaluateInput): Promise<EvoEvalReport>;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Fraction (0..1) of `expected` keywords present (case-insensitive) in content. */
function coverage(content: string, expected: string[] | undefined): number {
  if (!expected || expected.length === 0) {
    // No expectations: presence of any non-empty content scores 1.
    return content.trim().length > 0 ? 1 : 0;
  }
  const haystack = content.toLowerCase();
  let hits = 0;
  for (const kw of expected) {
    const needle = kw.trim().toLowerCase();
    if (needle.length === 0) continue;
    if (haystack.includes(needle)) hits += 1;
  }
  return hits / expected.length;
}

export class KeywordCoverageEvaluator implements EvoEvaluator {
  async evaluate(input: EvoEvaluateInput): Promise<EvoEvalReport> {
    const scores: EvoEvalScore[] = [];
    let baselineTotal = 0;
    let candidateTotal = 0;
    let baselineErrors = 0;
    let candidateErrors = 0;

    for (const item of input.evalSet) {
      const baselineScore = round(coverage(input.baseContent, item.expected));
      const candidateScore = round(coverage(input.candidateContent, item.expected));
      baselineTotal += baselineScore;
      candidateTotal += candidateScore;
      if (baselineScore <= 0) baselineErrors += 1;
      if (candidateScore <= 0) candidateErrors += 1;
      scores.push({
        itemId: item.id,
        baselineScore,
        candidateScore,
        note:
          candidateScore > baselineScore
            ? "candidate covers more"
            : candidateScore < baselineScore
              ? "candidate covers less"
              : "no change",
      });
    }

    const itemCount = input.evalSet.length;
    const baselineScore = itemCount > 0 ? round(baselineTotal / itemCount) : 0;
    const candidateScore = itemCount > 0 ? round(candidateTotal / itemCount) : 0;
    const delta = round(candidateScore - baselineScore);

    return {
      itemCount,
      baselineScore,
      candidateScore,
      delta,
      improved: delta > 0,
      baselineErrorRate: itemCount > 0 ? round(baselineErrors / itemCount) : 0,
      candidateErrorRate: itemCount > 0 ? round(candidateErrors / itemCount) : 0,
      scores,
    };
  }
}
