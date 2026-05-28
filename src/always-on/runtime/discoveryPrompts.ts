import type { DiscoveryPlanRecord } from "../protocol/types.js";
import type { WorkspaceDiff } from "../workspace/WorkspaceApply.js";
import type { ChatDigest } from "../context/ChatDigestBuilder.js";
import { ALWAYS_ON_PLAN_TOOL_NAME } from "../tool/AlwaysOnDiscoveryPlanTool.js";
import { ALWAYS_ON_REPORT_TOOL_NAME } from "../tool/AlwaysOnReportTool.js";
import { ALWAYS_ON_WORKSPACE_TOOL_NAME } from "../tool/AlwaysOnWorkspaceTool.js";
import { ALWAYS_ON_CHAT_HISTORY_TOOL_NAME } from "../tool/AlwaysOnChatHistoryTool.js";
import {
  buildDiscoveryPromptZh,
  buildWorkspacePromptZh,
  buildExecutionPromptZh,
  buildReportPromptZh,
  buildApplyPromptZh,
} from "./discoveryPrompts.zh.js";

export type ExistingPlanSummary = {
  id: string;
  title: string;
  dedupeKey: string;
  status: string;
};

export type BuildDiscoveryPromptInput = {
  projectRoot: string;
  runId: string;
  /** ISO timestamp the runtime should embed in the plan metadata. */
  createdAt: string;
  /** Absolute path of the project's PilotDeck chat transcript directory. */
  chatDir: string;
  /** When an isolated workspace from a previous run still exists on disk, discovery runs inside it. */
  workspace?: { cwd: string; strategy: string };
  /** Pre-built digest of recent user chat sessions. */
  chatDigest?: ChatDigest;
  /** Summaries of previously created Always-On plans. */
  existingPlans?: ExistingPlanSummary[];
  /** Prompt language override. Defaults to English when absent. */
  language?: string;
};

export function buildDiscoveryPrompt(input: BuildDiscoveryPromptInput): string {
  if (input.language === "zh-CN") return buildDiscoveryPromptZh(input);
  const codeAccessLines: string[] = input.workspace
    ? [
        `Isolated workspace cwd: ${input.workspace.cwd}`,
        `Workspace strategy: ${input.workspace.strategy}.`,
        "This workspace is an isolated snapshot of the project — read / glob / bash freely inside it.",
        `Do NOT cd outside the workspace to the project root (${input.projectRoot}).`,
      ]
    : [
        `Read the project root at ${input.projectRoot} using read_file / glob / bash freely.`,
      ];

  const headerLine = input.workspace
    ? `You are running an autonomous Always-On discovery for project: ${input.projectRoot} (working inside isolated workspace: ${input.workspace.cwd})`
    : `You are running an autonomous Always-On discovery for project: ${input.projectRoot}`;

  const lines: string[] = [
    headerLine,
    "",
    "Goal: identify AT MOST ONE worthwhile task to propose.",
    "Tasks may include enriching or adding content, completing unfinished work,",
    "improving structure or layout, fixing errors, enhancing user experience,",
    "or anything valuable discussed in user chat history.",
    "Each plan must include at least one automatically-checkable verification step",
    "(e.g. file exists, content matches expected pattern, page renders without error).",
    "If nothing actionable is found, do not call any tool — just respond with a short note explaining why.",
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    ...codeAccessLines,
  ];

  lines.push("", ...formatChatDigestSection(input.chatDigest));
  lines.push("", ...formatExistingPlansSection(input.existingPlans));

  lines.push(
    "",
    `If you identify a task, call \`${ALWAYS_ON_PLAN_TOOL_NAME}\` exactly once with a strictly-formatted markdown plan.`,
    "Required plan structure (top to bottom):",
    "  - Level-1 heading: # <plan title>",
    "  - Metadata blockquote, first line `Always-On Discovery Plan`, then keyed lines:",
    `    > id: plan_${input.runId}`,
    `    > sourceRunId: ${input.runId}`,
    `    > createdAt: ${input.createdAt}`,
    `    > projectRoot: ${input.projectRoot}`,
    "    > dedupeKey: <stable identifier>",
    "  - Sections in this exact order: ## Summary, ## Rationale, ## Context Signals, ## Proposed Change, ## Execution Steps, ## Verification.",
    "  - Summary ≤ 200 chars, single paragraph.",
    "  - Context Signals: at least one `-` bullet.",
    "  - Execution Steps: ordered list (1., 2., …) only; no bullets.",
    "  - Verification: at least one `-` bullet, each line must be machine-checkable.",
    "",
    "Hard constraints:",
    `  - Calling \`${ALWAYS_ON_PLAN_TOOL_NAME}\` more than once returns plan_quota_exhausted.`,
    "  - Plans missing or reordering required sections, or containing fuzzy 'TODO' wording, will be rejected.",
    "  - Do not include Risks or Rollback sections.",
  );

  return lines.join("\n");
}

function formatChatDigestSection(digest?: ChatDigest): string[] {
  if (!digest || digest.sessions.length === 0) {
    return [
      "No recent user conversations found. Explore the workspace contents to find a worthwhile task.",
    ];
  }

  const lines: string[] = [
    "## Recent user conversations",
    "",
    "Below is a structured digest of recent user-agent chat sessions.",
    "These are primary signals for what the user cares about.",
    `To see the full conversation of a session, call \`${ALWAYS_ON_CHAT_HISTORY_TOOL_NAME}\` with its sessionId.`,
    "",
  ];

  for (const session of digest.sessions) {
    const ts = session.lastModified.replace(/\.\d{3}Z$/, "Z");
    lines.push(`- [${ts}] "${session.title}" (sessionId: ${session.alias})`);
    for (const prompt of session.userPrompts) {
      const oneLiner = prompt.replace(/\n/g, " ").trim();
      lines.push(`  > ${oneLiner}`);
    }
    lines.push("");
  }

  return lines;
}

function formatExistingPlansSection(plans?: ExistingPlanSummary[]): string[] {
  if (!plans || plans.length === 0) {
    return [];
  }

  const lines: string[] = [
    "## Existing Always-On plans (do NOT duplicate these topics)",
    "",
  ];

  for (const plan of plans) {
    lines.push(`- [${plan.status}] "${plan.title}" (dedupeKey: ${plan.dedupeKey})`);
  }

  return lines;
}

export type BuildWorkspacePromptInput = {
  projectRoot: string;
  runId: string;
  language?: string;
};

export function buildWorkspacePrompt(input: BuildWorkspacePromptInput): string {
  if (input.language === "zh-CN") return buildWorkspacePromptZh(input);
  return [
    "You are preparing an isolated workspace for an Always-On plan execution.",
    "",
    `Project root: ${input.projectRoot}`,
    "",
    "Available workspace strategies:",
    "  - `git-worktree`: Creates a git worktree on a new branch. Fast and space-efficient (hard-links).",
    "    Requires a git repo with at least one commit and a clean working tree (no uncommitted changes).",
    "  - `snapshot-copy`: Copies the project directory (CoW on APFS/btrfs). Works for any directory",
    "    but uses more disk space. Ignores .git, node_modules, dist by default.",
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "",
    "## What to do",
    "1. Check the project root state (e.g. `git status --porcelain` if it looks like a git repo, or `ls` otherwise).",
    `2. Call \`${ALWAYS_ON_WORKSPACE_TOOL_NAME}\` with the chosen strategy, or \`auto\` to let the runtime decide.`,
  ].join("\n");
}

export type BuildExecutionPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
  language?: string;
};

export function buildExecutionPrompt(input: BuildExecutionPromptInput): string {
  if (input.language === "zh-CN") return buildExecutionPromptZh(input);
  return [
    `You are executing an Always-On discovery plan inside an isolated workspace.`,
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "Safety boundary is the workspace itself; do NOT cd outside it, do NOT touch the user's project root.",
    "",
    "## Plan",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    "1. Execute the Execution Steps in order.",
    "2. Run the Verification list and record results.",
    "3. Respond with a summary of what was done and the verification outcomes.",
  ].join("\n");
}

export type BuildReportPromptInput = {
  plan: DiscoveryPlanRecord;
  planMarkdown: string;
  workspaceCwd: string;
  workspaceStrategy: string;
  language?: string;
};

export function buildReportPrompt(input: BuildReportPromptInput): string {
  if (input.language === "zh-CN") return buildReportPromptZh(input);
  return [
    "You are writing a work report for a completed Always-On plan execution.",
    `Workspace strategy: ${input.workspaceStrategy}.`,
    `Workspace cwd: ${input.workspaceCwd}`,
    "",
    "Permissions: this turn runs in `bypassPermissions` mode — every tool call is auto-allowed.",
    "",
    "## Plan that was executed",
    input.planMarkdown.trim(),
    "",
    "## What to do",
    "1. Review the workspace to see what changed (e.g. `git diff --stat`, `ls`, read relevant files).",
    "2. Summarize the execution: what steps were performed, which files were changed, command outputs, and verification results.",
    `3. Call \`${ALWAYS_ON_REPORT_TOOL_NAME}\` exactly once with the full work-report markdown.`,
    "",
    "Required report sections in order: Plan Reference, Steps Performed, Files Changed, Command Output, Verification Results, Follow-ups, Notes.",
    "Missing sections will be filled by the runtime fallback.",
  ].join("\n");
}

export type BuildApplyPromptInput = {
  plan: { title: string; id: string; workspace?: { cwd: string; strategy: string } };
  projectName: string;
  projectRoot: string;
  diff: WorkspaceDiff;
  branchName?: string;
  language?: string;
};

export function buildApplyPrompt(input: BuildApplyPromptInput): string {
  if (input.language === "zh-CN") return buildApplyPromptZh(input);
  const { plan, projectName, projectRoot, diff, branchName } = input;

  const lines: string[] = [
    `Always-On apply for project "${projectName}".`,
    "",
    "Your job is to merge changes from the isolated workspace into the project root.",
    "",
    "Do not enter Plan Mode.",
    "Do not create a new plan — apply the existing changes directly.",
    "",
    `Plan: "${plan.title}" (${plan.id})`,
    `Project root: ${projectRoot}`,
  ];

  if (plan.workspace?.cwd) {
    lines.push(`Isolated workspace: ${plan.workspace.cwd} (${plan.workspace.strategy})`);
  }

  if (branchName) {
    lines.push(`Workspace branch: ${branchName}`);
  }

  lines.push(
    "",
    "## Merge approach",
    "",
    "Choose the best merge strategy based on the situation. You have full access to git and shell tools.",
    "Common approaches (pick whichever fits):",
    "  - `git merge` / `git merge --no-ff` if the workspace is on a named branch",
    "  - `git cherry-pick` for individual commits",
    "  - `git diff` + `git apply` for patch-based application",
    "  - Direct file edits via Edit/Write tools for surgical changes",
    "",
    "If you encounter conflicts, resolve them intelligently — do not blindly overwrite.",
    "If you cannot resolve a conflict, leave standard conflict markers (<<<< / ==== / >>>>).",
    "",
  );

  if (!diff.diff.trim()) {
    lines.push("No differences detected in the workspace. Nothing to apply.");
    return lines.join("\n");
  }

  if (diff.truncated) {
    lines.push(
      `The diff is large (${diff.fileCount} files) and has been truncated.`,
      "Read the relevant files from the workspace directory to compare and apply.",
      "",
      "Truncated diff (first portion):",
      "",
      diff.diff,
    );
  } else {
    lines.push(
      `Changes (${diff.fileCount} file${diff.fileCount === 1 ? "" : "s"}):`,
      "",
      diff.diff,
    );
  }

  return lines.join("\n");
}
