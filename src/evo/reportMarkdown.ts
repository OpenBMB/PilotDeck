/**
 * Render an EvoRun into a human-readable markdown report. Surfaced verbatim by
 * the UI report panel — it explains the hypothesis, the evidence (source
 * cards), the risk grading, the baseline-vs-candidate comparison and how to
 * roll back.
 */

import type { EvoRun, EvoTarget } from "./protocol/types.js";

function describeTarget(target: EvoTarget): string {
  if (target.kind === "skill") {
    return `skill \`${target.slug}\` (${target.scope})`;
  }
  return `harness \`${target.configKey}\``;
}

export function renderReportMarkdown(run: EvoRun): string {
  const lines: string[] = [];
  lines.push(`# Evo report — ${describeTarget(run.target)}`);
  lines.push("");
  lines.push(`- Status: **${run.status}**${run.autoApplied ? " (auto-applied)" : ""}`);
  lines.push(`- Risk: **${run.candidate.riskLevel}**`);
  lines.push(`- Policy: \`${run.policy}\``);
  lines.push(`- Recommendation: **${run.report.recommendation}**`);
  lines.push("");

  lines.push("## Hypothesis");
  lines.push("");
  lines.push(run.candidate.hypothesis || "(none)");
  lines.push("");

  lines.push("## Why (reason)");
  lines.push("");
  lines.push(run.reason || "(none)");
  lines.push("");

  if (run.candidate.riskNotes.length > 0) {
    lines.push("## Risk notes");
    lines.push("");
    for (const note of run.candidate.riskNotes) lines.push(`- ${note}`);
    lines.push("");
  }

  if (run.report.sourceCards.length > 0) {
    lines.push("## Evidence (source cards)");
    lines.push("");
    for (const card of run.report.sourceCards) {
      const ref = card.ref ? ` — \`${card.ref}\`` : "";
      lines.push(`- **[${card.kind}]** ${card.title}${ref}`);
      if (card.detail) lines.push(`  - ${card.detail}`);
    }
    lines.push("");
  }

  const evalReport = run.report.eval;
  if (evalReport) {
    lines.push("## Replay comparison (baseline vs candidate)");
    lines.push("");
    lines.push(`- Items: ${evalReport.itemCount}`);
    lines.push(`- Baseline score: ${evalReport.baselineScore}`);
    lines.push(`- Candidate score: ${evalReport.candidateScore}`);
    lines.push(`- Delta: ${evalReport.delta >= 0 ? "+" : ""}${evalReport.delta} (${evalReport.improved ? "improved" : "not improved"})`);
    lines.push(`- Error rate: ${evalReport.baselineErrorRate} → ${evalReport.candidateErrorRate}`);
    lines.push("");
    if (evalReport.scores.length > 0) {
      lines.push("| Item | Baseline | Candidate | Note |");
      lines.push("| --- | --- | --- | --- |");
      for (const s of evalReport.scores) {
        lines.push(`| ${s.itemId} | ${s.baselineScore} | ${s.candidateScore} | ${s.note ?? ""} |`);
      }
      lines.push("");
    }
  } else {
    lines.push("## Replay comparison");
    lines.push("");
    lines.push("No eval set was supplied for this run.");
    lines.push("");
  }

  if (run.rollback) {
    lines.push("## Rollback");
    lines.push("");
    lines.push(
      run.rollback.createdByApply
        ? "This change created the target; rolling back removes the added content."
        : "Previous content is stored on the run and can be restored on revert.",
    );
    lines.push("");
  }

  return lines.join("\n");
}
