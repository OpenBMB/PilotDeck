/**
 * Risk grading + policy decision for Evo candidates.
 *
 * The grading deliberately stays simple and explainable: it inspects the
 * target kind and the shape of the diff (frontmatter-only vs body changes,
 * which harness config category) and produces a `low | medium | high` level
 * with human-readable notes. The policy decision then maps a level + project
 * policy to "apply automatically" or "needs approval".
 */

import type {
  EvoCandidate,
  EvoHarnessConfigKey,
  EvoPolicyMode,
  EvoRiskLevel,
  EvoTarget,
} from "./protocol/types.js";

export type RiskClassification = {
  level: EvoRiskLevel;
  notes: string[];
};

/** Split a SKILL.md document into (frontmatter, body). */
function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: "", body: content };
  }
  const endRel = content.slice(3).search(/\r?\n---/);
  if (endRel === -1) {
    return { frontmatter: "", body: content };
  }
  const frontmatter = content.slice(0, 3 + endRel);
  const afterFence = content.slice(3 + endRel);
  const body = afterFence.replace(/^\r?\n---\r?\n?/, "");
  return { frontmatter, body };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Medium-risk harness categories. Router / tool-policy / context / always-on /
 * prompt-fragment are all rule-level changes the agent runs *around* the model,
 * so they are medium. Harness core code and executable scripts are not
 * addressable through this surface at all — those stay high-risk and manual.
 */
const HARNESS_MEDIUM: ReadonlySet<EvoHarnessConfigKey> = new Set<EvoHarnessConfigKey>([
  "router",
  "tool-policy",
  "context",
  "always-on",
  "prompt-fragment",
]);

export function classifyRisk(target: EvoTarget, candidate: EvoCandidate): RiskClassification {
  const notes: string[] = [];

  if (target.kind === "skill") {
    const base = splitFrontmatter(candidate.baseContent);
    const next = splitFrontmatter(candidate.candidateContent);
    const bodyChanged = normalize(base.body) !== normalize(next.body);
    const frontmatterChanged = normalize(base.frontmatter) !== normalize(next.frontmatter);

    // A pure additive "project adaptation" appendix (only new lines appended to
    // the end of the body, nothing removed) is treated as low risk: we are
    // supplementing project usage, not rewriting the flow.
    const additiveOnly = isAdditiveAppend(base.body, next.body);

    if (!bodyChanged && frontmatterChanged) {
      notes.push("Only the skill frontmatter (name/description/metadata) changed.");
      return { level: "low", notes };
    }
    if (additiveOnly) {
      notes.push("Change only appends project-adaptation content; nothing was removed.");
      return { level: "low", notes };
    }
    if (bodyChanged) {
      notes.push("Skill body / flow was rewritten — review the procedure for regressions.");
      return { level: "medium", notes };
    }
    notes.push("No meaningful change detected.");
    return { level: "low", notes };
  }

  // Harness target.
  if (HARNESS_MEDIUM.has(target.configKey)) {
    notes.push(
      `Harness "${target.configKey}" is a rule/config change applied around the model (medium risk).`,
    );
    return { level: "medium", notes };
  }
  notes.push("Unknown harness config category — defaulting to high risk, approval required.");
  return { level: "high", notes };
}

/**
 * True when `next` is `base` with extra content appended at the end and the
 * shared prefix is byte-identical (ignoring trailing-whitespace differences).
 */
function isAdditiveAppend(base: string, next: string): boolean {
  const b = base.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  const n = next.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (n.length <= b.length) return false;
  return n.startsWith(b);
}

/**
 * Decide whether a candidate at `risk` should be applied automatically under
 * `policy`. High-risk changes always require approval regardless of policy.
 */
export function shouldAutoApply(policy: EvoPolicyMode, risk: EvoRiskLevel): boolean {
  if (risk === "high") return false;
  switch (policy) {
    case "manual":
      return false;
    case "auto-low-risk":
      return risk === "low";
    case "auto-all":
      return risk === "low" || risk === "medium";
    default:
      return false;
  }
}
