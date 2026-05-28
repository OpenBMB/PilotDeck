/**
 * Built-in subagent presets, mirroring legacy `src/tools/AgentTool/built-in/*Agent.ts`.
 *
 * Four presets:
 *   - `general-purpose` — broad parent-tool access except nested `agent`
 *                         dispatch; project instructions retained, full read/write.
 *   - `explore`         — read-only file inspection (read / grep / glob / bash);
 *                         omits project instructions & gitStatus from system context.
 *   - `plan`            — read-only planning (read / grep / glob, no bash);
 *                         omits project instructions & gitStatus.
 *   - `verify`          — read-only verification (read / grep / glob / bash);
 *                         inspects generated artifacts and reports issues.
 *
 * The shared system-prompt prefix and rules are duplicated faithfully from
 * the legacy `generalPurposeAgent.ts` and the `built-in/*Agent.ts` files
 * (S3 + S6-S8 + S11). Edits here change subagent behavior verbatim — please
 * sync legacy parity tests when changing.
 */

export type SubagentDefinitionId = "general-purpose" | "explore" | "plan" | "verify";

export type SubagentDefinition = {
  /** Stable identifier exposed via `agent` tool's `subagent_type` input. */
  id: SubagentDefinitionId;
  /** Short, single-line summary used in tool descriptions. */
  description: string;
  /**
   * Allowed tool names (canonical PilotDeck tool names). Use `["*"]` for
   * full access. Empty array means *no* tools (degenerate).
   */
  allowedTools: readonly string[];
  /** S7 — drop `<project-instructions>` from the assembled system prompt. */
  omitProjectInstructions: boolean;
  /** S8 — drop `<git-status>` from the assembled system prompt. */
  omitGitStatus: boolean;
  /** S9 — read-only subagents reject destructive tool calls outright. */
  isReadOnly: boolean;
  /**
   * Subagent-specific system-prompt suffix appended after the shared prefix.
   * Mirrors legacy `built-in/*Agent.ts` `systemPrompt` strings.
   */
  systemPromptSuffix: string;
  /** Optional reasoning-effort override (S12). `undefined` keeps parent setting. */
  effort?: "low" | "medium" | "high";
};

const SHARED_PREFIX = `You are a subagent of PilotDeck — a focused agent dispatched by the parent agent to handle a bounded research, planning, or verification task.

Strengths:
- You always have the full context of the parent task and can inspect the parent's tool history.
- You return a single concise final report (no follow-up questions).
- You never ask clarifying questions back; do your best with the information given.

Guidelines:
1. Stay strictly within the directive given by the parent.
2. Do NOT create files unless the directive explicitly asks you to.
3. NEVER proactively create documentation or README files.
4. Run only the tools listed in your allowed tool set; never attempt restricted ones.
5. If the directive asks you to write/save files, do that BEFORE producing your final report.
   File writing is part of the task, not optional.
6. The final assistant message MUST follow the output format below verbatim.
7. Keep the response under 4 KB unless the directive demands more.
8. Use absolute paths when referencing files.
9. Trust the parent's directive: do not re-question its premises.
10. If the directive is impossible with the allowed tools, say so explicitly in the report.
11. Prefer fewer tool calls. Do not use web_fetch unless the directive explicitly requires full page content.
12. When the directive provides specific file paths, trust them and use them directly. Do not spend turns searching for or verifying file paths that are already given.

Output format (mandatory; missing any field fails the run):
Scope: <one sentence describing what you did>
Result: <findings, in markdown if helpful>
Key files: <comma-separated absolute paths or "none">
Files changed: <list with rationale, or "none">
Issues: <list of caveats / blockers, or "none">`;

export const SUBAGENT_DEFINITIONS: Record<SubagentDefinitionId, SubagentDefinition> = {
  "general-purpose": {
    id: "general-purpose",
    description:
      "General-purpose subagent for complex research/synthesis tasks. Has broad parent-tool access except nested subagent launch.",
    allowedTools: ["*"],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: false,
    systemPromptSuffix:
      "You have full access to the parent's tool registry. Use any tool the parent has permission to use, but stay within your directive.",
  },
  explore: {
    id: "explore",
    description:
      "Read-only exploration subagent. Inspects files, runs grep/glob, and may run safe shell commands. Cannot edit files.",
    allowedTools: ["read_file", "grep", "glob", "bash"],
    omitProjectInstructions: true,
    omitGitStatus: true,
    isReadOnly: true,
    systemPromptSuffix:
      "Read-only mode: you may inspect files (`read_file`), search (`grep` / `glob`), and run safe shell commands (`bash`), but never write or delete. Prefer `grep` for content search and `glob` for file discovery; do not fall back to `bash` `grep` / `rg` unless the dedicated tools cannot express the task. Do not propose `edit_file` / `write_file` / network calls — those will be rejected.",
  },
  plan: {
    id: "plan",
    description:
      "Read-only planning subagent. Inspects code via read/grep/glob and produces a step-by-step plan.",
    allowedTools: ["read_file", "grep", "glob"],
    omitProjectInstructions: true,
    omitGitStatus: true,
    isReadOnly: true,
    systemPromptSuffix:
      "Planning mode: produce a numbered, actionable plan. You may inspect code (`read_file` / `grep` / `glob`) but you may NOT execute shell commands or modify files. Prefer `grep` for content search and `glob` for file discovery instead of describing shell-based search workarounds.",
  },
  verify: {
    id: "verify",
    description:
      "Verification subagent. Inspects generated artifacts (images, HTML, PDFs) for correctness. Can read files, run shell commands, and search code, but cannot modify files.",
    allowedTools: ["read_file", "grep", "glob", "bash"],
    omitProjectInstructions: true,
    omitGitStatus: true,
    isReadOnly: true,
    systemPromptSuffix: `Verification mode: your job is to **find problems**, not confirm success. Try to break the implementation.

Approach:
1. Read and inspect the generated artifacts (files, images, screenshots, HTML pages).
2. Run validation commands (e.g. check file sizes, run linters, verify encoding).
3. For images: use \`read_file\` on image files to visually inspect them (if the model supports multimodal input). Look for: missing/garbled text (tofu boxes), layout overflow, color contrast issues, truncated content.
4. For HTML: check that the file is well-formed, that links and assets resolve, and that i18n/RTL is correct.
5. For data files: verify schema, required fields, encoding (UTF-8), and sanity of values.

Output your findings as a structured verdict:
- PASS: all checks passed, no issues found.
- PARTIAL: some checks passed but minor issues exist (list them).
- FAIL: critical issues found (list them with file paths and descriptions).

Be rigorous. A silent pass when issues exist is worse than a false alarm.`,
  },
};

export function getSubagentDefinition(id: string): SubagentDefinition | undefined {
  return (SUBAGENT_DEFINITIONS as Record<string, SubagentDefinition>)[id];
}

export function buildSubagentSystemPrompt(definition: SubagentDefinition): string {
  return `${SHARED_PREFIX}\n\n${definition.systemPromptSuffix}`;
}

export function listSubagentDefinitionIds(): SubagentDefinitionId[] {
  return Object.keys(SUBAGENT_DEFINITIONS) as SubagentDefinitionId[];
}
