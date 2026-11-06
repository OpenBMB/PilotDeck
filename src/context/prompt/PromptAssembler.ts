import type { CanonicalToolSchema } from "../../model/index.js";
import { pythonRuntimeContext, type PythonRuntimeStatus } from '../../runtime/pythonRuntime.js';
import type {
  ContributedCommand,
  ContributedSkill,
  ExtensionResolver,
  McpServerInstruction,
  PromptContributions,
} from "../extension/ExtensionResolver.js";
import { toolGuidance } from "./toolGuidance.js";

export type PromptAssemblerInput = {
  pythonRuntime?: PythonRuntimeStatus;
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
 * Build the stable instruction prefix from one request's capabilities.
 * Dynamic retrieval context belongs in request messages, not this prefix.
 *
 * Sections:
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
    if (input.customSystemPrompt !== undefined) {
      return { defaultSystemPrompt: [], userContext: this.buildUserContext(input), systemContext: [] };
    }
    const contributions = this.extension.getPromptContributions?.() ?? {
      commands: this.extension.listCommands(),
      skills: this.extension.listSkills(),
      mcpInstructions: this.extension.listMcpInstructions(),
    };
    return {
      defaultSystemPrompt: this.buildDefaultSystemPrompt(input, contributions),
      userContext: this.buildUserContext(input),
      systemContext: this.buildSystemContext(input, contributions),
    };
  }

  private buildDefaultSystemPrompt(input: PromptAssemblerInput, contributions: PromptContributions): string[] {
    const lines: string[] = [
      "You are PilotDeck, an AI agent runtime. You execute tasks across CLI, TUI, web, and chat channels by calling structured tools and reasoning over their results.",
      "Operate decisively: prefer using available tools to gather facts before answering, prefer concise replies, and surface uncertainty when present.",
      "",
      ...toolGuidance(input.tools),
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

    const mcpBlock = formatMcpInstructions(contributions.mcpInstructions);
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
    const python = pythonRuntimeContext(input.pythonRuntime);
    if (python) lines.push(`<python-runtime>\n${python}\n</python-runtime>`);
    lines.push("</user-context>");
    return [lines.join("\n")];
  }

  private buildSystemContext(input: PromptAssemblerInput, contributions: PromptContributions): string[] {
    const sections: string[] = [];
    const now = (input.now ?? (() => new Date()))();
    const dayOnly = now.toISOString().slice(0, 10);

    const envLines = [`<environment>`, `now: ${dayOnly}`, `</environment>`];
    sections.push(envLines.join("\n"));

    const commands = contributions.commands;
    if (commands.length > 0) {
      sections.push(formatCommands(commands));
    }

    const skills = contributions.skills;
    if (skills.length > 0) {
      sections.push(formatSkills(skills, input.tools));
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
  for (const command of [...commands].sort((a, b) => a.name.localeCompare(b.name) || (a.namespace ?? "").localeCompare(b.namespace ?? ""))) {
    const description = command.description ? ` — ${command.description}` : "";
    const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
    lines.push(`- /${command.name}${hint}${description}`);
  }
  lines.push("</available-commands>");
  return lines.join("\n");
}

function formatSkills(skills: ContributedSkill[], tools: CanonicalToolSchema[]): string {
  const reader = tools.some(tool => tool.name === "read_skill") ? "read_skill"
    : tools.some(tool => tool.name === "read_file") ? "read_file" : undefined;
  const lines = [
    "<available-skills>",
    reader
      ? `Use the ${reader} tool to load the full content of a listed skill before following it. Each entry includes the exact SKILL.md selected by the runtime.`
      : "These entries are reference metadata; their full instructions are not loaded and no skill-reading tool is available. Do not claim to have read or applied them.",
    "Resolve relative references, scripts, and assets against the directory containing that SKILL.md.",
    "Do not search the user's home directory to rediscover a skill or infer runtime/cache paths; use the listed file and paths or commands returned by the skill.",
  ];
  for (const skill of [...skills].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))) {
    const description = skill.description ? ` — ${skill.description}` : "";
    lines.push(`- ${skill.name}${description} (file: ${skill.path})`);
  }
  lines.push("</available-skills>");
  return lines.join("\n");
}
