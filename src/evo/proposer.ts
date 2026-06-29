/**
 * Candidate proposers.
 *
 * A proposer turns (base content + target + evidence + project facts) into a
 * candidate version. The interface is pluggable so a future LLM-backed proposer
 * can drop in, while the default `HeuristicProposer` is deterministic — it
 * powers the "adapt a freshly installed skill to this project" flow and is
 * trivially testable without any model calls.
 */

import type {
  EvoCandidate,
  EvoProjectFacts,
  EvoSourceCard,
  EvoTarget,
} from "./protocol/types.js";

export type EvoProposeContext = {
  target: EvoTarget;
  baseContent: string;
  projectFacts?: EvoProjectFacts;
  sourceCards?: EvoSourceCard[];
  hypothesis?: string;
  /** When provided, used verbatim as the candidate content. */
  candidateContent?: string;
};

export interface EvoProposer {
  propose(ctx: EvoProposeContext): Promise<Omit<EvoCandidate, "riskLevel" | "riskNotes">>;
}

const PROJECT_ADAPTATION_HEADING = "## Project Adaptation (Evo)";

/**
 * Build the project-adaptation appendix for a skill from project facts. Returns
 * null when there is nothing concrete to add.
 */
export function buildProjectAdaptationSection(facts: EvoProjectFacts | undefined): string | null {
  if (!facts) return null;
  const lines: string[] = [];
  if (facts.projectName) lines.push(`- Project: ${facts.projectName}`);
  if (facts.description) lines.push(`- Context: ${facts.description}`);
  if (facts.testCommand) lines.push(`- Test command: \`${facts.testCommand}\``);
  if (facts.commonPaths && facts.commonPaths.length > 0) {
    lines.push(`- Common paths: ${facts.commonPaths.map((p) => `\`${p}\``).join(", ")}`);
  }
  if (facts.codeStyle) lines.push(`- Code style: ${facts.codeStyle}`);
  if (facts.notes) lines.push(`- Notes: ${facts.notes}`);
  if (lines.length === 0) return null;
  return [PROJECT_ADAPTATION_HEADING, "", ...lines, ""].join("\n");
}

/** Whether the content already carries an Evo project-adaptation section. */
export function hasProjectAdaptationSection(content: string): boolean {
  return content.includes(PROJECT_ADAPTATION_HEADING);
}

export class HeuristicProposer implements EvoProposer {
  async propose(
    ctx: EvoProposeContext,
  ): Promise<Omit<EvoCandidate, "riskLevel" | "riskNotes">> {
    const base = ctx.baseContent ?? "";

    // 1. Explicit override always wins.
    if (typeof ctx.candidateContent === "string" && ctx.candidateContent.length > 0) {
      return {
        baseContent: base,
        candidateContent: ctx.candidateContent,
        hypothesis:
          ctx.hypothesis ?? "Apply the explicitly supplied candidate content.",
      };
    }

    // 2. Skill project-adaptation: append a section derived from project facts.
    if (ctx.target.kind === "skill") {
      const section = buildProjectAdaptationSection(ctx.projectFacts);
      if (section && !hasProjectAdaptationSection(base)) {
        const separator = base.endsWith("\n") ? "\n" : "\n\n";
        const candidateContent = `${base}${separator}${section}`;
        return {
          baseContent: base,
          candidateContent,
          hypothesis:
            ctx.hypothesis ??
            "Newly relevant project facts are missing from this skill; append a project-adaptation section so the agent uses the right commands and paths.",
        };
      }
      // Nothing concrete to change — return base unchanged (no-op candidate).
      return {
        baseContent: base,
        candidateContent: base,
        hypothesis:
          ctx.hypothesis ??
          "No project facts available to adapt this skill; no change proposed.",
      };
    }

    // 3. Harness target without explicit content: no-op (an LLM proposer would
    //    fill this in). Keep the base so the run is still recorded.
    return {
      baseContent: base,
      candidateContent: base,
      hypothesis:
        ctx.hypothesis ?? "No candidate harness rule supplied; no change proposed.",
    };
  }
}
