import type { CanonicalToolSchema } from "../../model/index.js";
import type {
  ContributedCommand,
  ContributedSkill,
  ExtensionResolver,
  McpServerInstruction,
} from "../extension/ExtensionResolver.js";

export type PromptAssemblerInput = {
  cwd: string;
  provider: string;
  model: string;
  permissionMode: string;
  additionalWorkingDirectories: string[];
  tools: CanonicalToolSchema[];
  /** Custom system prompt (replaces sections 1 + 3). */
  customSystemPrompt?: string;
  /** Optional appended fragment (always last). */
  appendSystemPrompt?: string;
  /** Optional override for the user-context "now" line. */
  now?: () => Date;
};

export type PromptAssemblerSections = {
  defaultSystemPrompt: string[];
  userContext: string[];
  systemContext: string[];
};

export type PromptAssemblerResult = {
  parts: string[];
  joined: string;
  sections: PromptAssemblerSections;
};

/**
 * Build the system prompt for a turn. Mirrors legacy `fetchSystemPromptParts`
 * information slots (tool catalog / cwd / git / env / mcp instructions /
 * commands / skills) but uses PilotDeck-authored copy.
 *
 * Sections (review decision 2026-05):
 *   1 default_system_prompt   — product identity + tool catalog + permission mode
 *                                + additional working directories + mcp instructions
 *   2 user_context            — cwd + env summary + active model
 *   3 system_context          — timestamp + extension commands/skills summary
 *   4 custom_system_prompt    — replaces 1 + 3 when provided
 *   5 append_system_prompt    — always last
 */
export class PromptAssembler {
  constructor(
    private readonly extension: ExtensionResolver,
    private readonly instructionSanitizer?: (instructions: string) => string,
  ) {}

  assemble(input: PromptAssemblerInput): PromptAssemblerResult {
    const sections = this.buildSections(input);
    const parts: string[] = [];
    const useCustom = input.customSystemPrompt !== undefined;

    if (useCustom) {
      if (input.customSystemPrompt && input.customSystemPrompt.trim().length > 0) {
        parts.push(input.customSystemPrompt.trim());
      }
    } else {
      parts.push(...sections.defaultSystemPrompt);
    }

    parts.push(...sections.userContext);

    if (!useCustom) {
      parts.push(...sections.systemContext);
    }

    if (input.appendSystemPrompt && input.appendSystemPrompt.trim().length > 0) {
      parts.push(input.appendSystemPrompt.trim());
    }

    const joined = parts.join("\n\n");
    return { parts, joined, sections };
  }

  private buildSections(input: PromptAssemblerInput): PromptAssemblerSections {
    return {
      defaultSystemPrompt: this.buildDefaultSystemPrompt(input),
      userContext: this.buildUserContext(input),
      systemContext: this.buildSystemContext(input),
    };
  }

  private buildDefaultSystemPrompt(input: PromptAssemblerInput): string[] {
    const lines: string[] = [
      "You are PilotDeck, an AI agent runtime. You execute tasks across CLI, TUI, web, and chat channels by calling structured tools and reasoning over their results.",
      "Operate decisively: prefer using available tools to gather facts before answering, prefer concise replies, and surface uncertainty when present.",
    ];

    const permissionLine = formatPermissionMode(input.permissionMode);
    if (permissionLine) {
      lines.push("");
      lines.push(permissionLine);
    }

    if (input.additionalWorkingDirectories.length > 0) {
      lines.push("");
      lines.push("Additional working directories you may operate in:");
      for (const dir of input.additionalWorkingDirectories) {
        lines.push(`- ${dir}`);
      }
    }

    const mcpInstructions = this.extension.listMcpInstructions();
    const mcpBlock = formatMcpInstructions(mcpInstructions, this.instructionSanitizer);
    if (mcpBlock) {
      lines.push("");
      lines.push("Connected MCP server instructions:");
      lines.push(mcpBlock);
    }

    return [lines.join("\n")];
  }

  private buildUserContext(input: PromptAssemblerInput): string[] {
    const lines: string[] = [];
    lines.push("<user-context>");
    lines.push(`cwd: ${input.cwd}`);
    lines.push("IMPORTANT: When the user does not specify an explicit file path, all file paths in tool calls MUST be relative to the cwd above — use \"foo.html\", not an absolute path like \"/home/user/foo.html\". If the user explicitly provides a path, respect their choice.");
    lines.push(`model: ${input.provider}/${input.model}`);
    lines.push(`permission_mode: ${input.permissionMode}`);
    lines.push(`platform: ${process.platform}`);
    lines.push(`node: ${process.version}`);
    lines.push("</user-context>");
    return [lines.join("\n")];
  }

  private buildSystemContext(input: PromptAssemblerInput): string[] {
    const sections: string[] = [];
    const now = (input.now ?? (() => new Date()))();
    const dayOnly = now.toISOString().slice(0, 10);

    const envLines = [`<environment>`, `now: ${dayOnly}`, `</environment>`];
    sections.push(envLines.join("\n"));

    const commands = this.extension.listCommands();
    if (commands.length > 0) {
      sections.push(formatCommands(commands));
    }

    const skills = this.extension.listSkills();
    if (skills.length > 0) {
      sections.push(formatSkills(skills));
    }

    return sections;
  }

}

function formatPermissionMode(mode: string): string {
  switch (mode) {
    case "default":
      return "Permission mode: default — write/shell tools require explicit approval.";
    case "plan":
      return [
        "Permission mode: plan — You are in a READ-ONLY exploration and planning phase.",
        "",
        "## What To Do",
        "1. Explore the codebase using read_file, grep, glob to understand existing patterns and structure",
        "2. Identify the key files, functions, and data flows relevant to the task",
        "3. Design your implementation approach — consider trade-offs between alternatives",
        "4. Create or refine a markdown plan file under the project's `.pilotdeck/plans/` directory",
        "5. When your plan is ready, call exit_plan_mode with the `plan_file_path` you want to submit for user approval",
        "",
        "## Rules",
        "- DO NOT exit plan mode any other way; use exit_plan_mode when you want to leave it",
        "- Do NOT call enter_plan_mode again - you are already in plan mode",
        "- DO NOT call write_file, edit_file, create_file, or bash with any command that writes, deletes, or modifies files, except for markdown plan files under `.pilotdeck/plans/`",
        "- You may use read-only tools freely, and you may write only markdown plan files under `.pilotdeck/plans/` while plan mode is active",
        "- You MAY use ask_user_question to clarify requirements or choose between approaches",
        "- Focus on understanding before proposing — read first, plan second",
        "- Do NOT skip the planning phase — even for seemingly simple tasks, explore first",
        "- Do NOT call exit_plan_mode until you have a concrete, actionable plan",
      ].join("\n");
    case "acceptEdits":
      return "Permission mode: acceptEdits — file edits are auto-approved; shell still requires approval.";
    case "bypassPermissions":
      return "Permission mode: bypassPermissions — all tools are auto-approved; act conservatively.";
    case "dontAsk":
      return "Permission mode: dontAsk — do not prompt the user; deny anything ambiguous.";
    default:
      return `Permission mode: ${mode}`;
  }
}

/**
 * Render MCP server instructions inside a stable `<mcp-instructions>` block
 * (B3 §5.3.5.7). Servers are sorted by name to keep prompt caches stable.
 * Entries lacking instructions are dropped so we never emit dummy `(no
 * instructions)` lines that thrash provider caches.
 */
function formatMcpInstructions(
  instructions: McpServerInstruction[],
  sanitize?: (instructions: string) => string,
): string {
  const populated = instructions
    .filter((entry) => typeof entry.instructions === "string" && entry.instructions.trim().length > 0)
    .map((entry) => ({ serverName: entry.serverName, instructions: entry.instructions!.trim() }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName));
  if (populated.length === 0) return "";
  const lines: string[] = ["<mcp-instructions>"];
  for (const entry of populated) {
    lines.push(`<server name="${escapeXmlAttr(entry.serverName)}">`);
    const body = sanitize ? sanitize(entry.instructions) : entry.instructions;
    lines.push(`<instruction-source>${escapeXmlContent(entry.serverName)}</instruction-source>`);
    lines.push(`<instruction-body>`);
    lines.push(body);
    lines.push(`</instruction-body>`);
    lines.push("</server>");
  }
  lines.push("</mcp-instructions>");
  return lines.join("\n");
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeXmlContent(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatCommands(commands: ContributedCommand[]): string {
  const lines = ["<available-commands>"];
  for (const command of commands) {
    const description = command.description ? ` — ${command.description}` : "";
    const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
    lines.push(`- /${command.name}${hint}${description}`);
  }
  lines.push("</available-commands>");
  return lines.join("\n");
}

function formatSkills(skills: ContributedSkill[]): string {
  const lines = [
    "<available-skills>",
    "Use the read_skill tool to load the full content of any skill listed below.",
  ];
  for (const skill of skills) {
    const description = skill.description ? ` — ${skill.description}` : "";
    lines.push(`- ${skill.name}${description}`);
  }
  lines.push("</available-skills>");
  return lines.join("\n");
}
