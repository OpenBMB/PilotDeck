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
  runMode?: string;
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
  constructor(private readonly extension: ExtensionResolver) {}

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
    const hasWebSearch = input.tools.some((tool) => tool.name === "web_search");
    const hasWebFetch = input.tools.some((tool) => tool.name === "web_fetch");
    const documentationLookupPolicy = hasWebSearch
      ? "When implementing code against an API, SDK, framework, CLI, config schema, or file format whose usage is not clear from local source, installed types, examples, or project docs, search for official documentation before writing or changing code. Prefer versioned official docs and existing in-repo call sites. Use web_search for discovery and web_fetch for the relevant docs page. Do not guess unfamiliar signatures, options, or output shapes when a quick lookup can resolve them. If network tools are unavailable or denied, state the uncertainty and proceed conservatively."
      : hasWebFetch
        ? "When implementing code against an API, SDK, framework, CLI, config schema, or file format whose usage is not clear, prefer installed types, local source, examples, and project docs. If a relevant official documentation URL is already known, use web_fetch to inspect it. Otherwise state the uncertainty and proceed conservatively."
        : "When implementing code against an API, SDK, framework, CLI, config schema, or file format whose usage is not clear, prefer installed types, local source, examples, and project docs. State any remaining uncertainty and proceed conservatively.";
    const lines: string[] = [
      "You are PilotDeck, an AI agent runtime. You execute tasks across CLI, TUI, web, and chat channels by calling structured tools and reasoning over their results.",
      "Operate decisively: prefer using available tools to gather facts before answering, prefer concise replies, and surface uncertainty when present.",
      "",
      "Documentation lookup policy:",
      documentationLookupPolicy,
      "",
      "Parallel delegation policy:",
      "When the agent tool is available and the task contains two or more independent, repetitive, or separable workstreams, prefer launching multiple subagents in the same assistant message instead of waiting for one to finish before starting the next. Good parallel candidates include inspecting multiple files/modules, researching independent APIs, checking several artifacts, or comparing alternatives. Do not parallelize tasks that write to the same files, depend on another subagent's output, require shared ordering, or need user approval between steps. Give each subagent a self-contained prompt, distinct scope, and expected output. After all sibling results return, synthesize them yourself and decide the next step.",
      "",
      "Reusable script workflow:",
      "When code is more than a tiny one-off command, or you expect to rerun it with changed parameters, write it to a workspace file first with write_file, then run it with bash. Prefer scripts with CLI arguments, environment variables, or a small config section so parameters can be adjusted with edit_file or command args. Do not pack large Python/JS/shell programs into bash heredocs or long `python -c` / `node -e` strings. After each run, inspect output and edit the saved script instead of regenerating a new inline command.",
    ];

    const permissionLine = formatPermissionMode(input.permissionMode);
    if (permissionLine) {
      lines.push("");
      lines.push(permissionLine);
    }
    const runModeLine = formatRunMode(input.runMode);
    if (runModeLine) {
      lines.push(runModeLine);
    }

    if (input.additionalWorkingDirectories.length > 0) {
      lines.push("");
      lines.push("Additional working directories you may operate in:");
      for (const dir of input.additionalWorkingDirectories) {
        lines.push(`- ${dir}`);
      }
    }

    const mcpInstructions = this.extension.listMcpInstructions();
    const mcpBlock = formatMcpInstructions(mcpInstructions);
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
    if (input.runMode) {
      lines.push(`run_mode: ${input.runMode}`);
    }
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
      return "Permission mode: plan — read-only planning mode; implementation changes are blocked at tool runtime.";
    case "bypassPermissions":
      return "Permission mode: bypassPermissions — all tools are auto-approved; act conservatively.";
    default:
      return `Permission mode: ${mode}`;
  }
}

function formatRunMode(mode: string | undefined): string | undefined {
  switch (mode) {
    case "ask":
      return "Run mode: ask — read-only analysis mode; write/action tools are blocked at tool runtime even when permission mode is bypassPermissions.";
    case "plan":
      return "Run mode: plan — planning mode is active.";
    default:
      return undefined;
  }
}

/**
 * Render MCP server instructions inside a stable `<mcp-instructions>` block
 * (B3 §5.3.5.7). Servers are sorted by name to keep prompt caches stable.
 * Entries lacking instructions are dropped so we never emit dummy `(no
 * instructions)` lines that thrash provider caches.
 */
function formatMcpInstructions(instructions: McpServerInstruction[]): string {
  const populated = instructions
    .filter((entry) => typeof entry.instructions === "string" && entry.instructions.trim().length > 0)
    .map((entry) => ({ serverName: entry.serverName, instructions: entry.instructions!.trim() }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName));
  if (populated.length === 0) return "";
  const lines: string[] = ["<mcp-instructions>"];
  for (const entry of populated) {
    lines.push(`<server name="${escapeXmlAttr(entry.serverName)}">`);
    lines.push(entry.instructions);
    lines.push("</server>");
  }
  lines.push("</mcp-instructions>");
  return lines.join("\n");
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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
    "Use the read_skill tool to load the full content of any skill listed below. Each entry includes the exact SKILL.md selected by the runtime.",
    "Resolve relative references, scripts, and assets against the directory containing that SKILL.md.",
    "Do not search the user's home directory to rediscover a skill or infer runtime/cache paths; use the listed file and paths or commands returned by the skill.",
  ];
  for (const skill of skills) {
    const description = skill.description ? ` — ${skill.description}` : "";
    lines.push(`- ${skill.name}${description} (file: ${skill.path})`);
  }
  lines.push("</available-skills>");
  return lines.join("\n");
}
