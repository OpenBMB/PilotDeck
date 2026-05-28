import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import type { ContributedCommand, ExtensionResolver } from "../extension/ExtensionResolver.js";
import { NullExtensionResolver } from "../extension/ExtensionResolver.js";

export type ContextInputBlock =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type ContextInputResult = {
  /** Messages produced for the conversation log. */
  messages: CanonicalMessage[];
  /** Whether the agent loop should call the model after this input. */
  shouldCallModel: boolean;
  /** Diagnostics emitted while processing (e.g. unknown command). */
  diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
  /** Recognized command (if any). */
  command?: { name: string; argument?: string; source: "extension" | "unknown" };
};

export type InputProcessorOptions = {
  extension?: ExtensionResolver;
};

const SLASH_COMMAND_RE = /^\/(?<name>[A-Za-z0-9_:-]+)(?<sep>\s+|$)/;

/**
 * Phase 4 input processor (review decision §3.2 — three-layer slash command):
 *  - adapter pre-parses `/foo` token; passes raw input here
 *  - this processor checks `extension.listCommands()` for a match
 *  - if matched: produces a user message with the command body + arg as text
 *    (still triggers a model call so plugin command bodies get summarized /
 *    executed by the agent loop)
 *  - if unmatched: passes through as plain text and flags an `unknown_command`
 *    diagnostic
 *
 * The extension owner has not yet finished plugin command body extraction, so
 * we only attach `name` / `argument`; the loop forwards the original text to
 * the model verbatim until the contribution view is wired (Phase 6).
 */
export class InputProcessor {
  private readonly extension: ExtensionResolver;

  constructor(options: InputProcessorOptions = {}) {
    this.extension = options.extension ?? new NullExtensionResolver();
  }

  process(input: ContextInputBlock): ContextInputResult {
    if (input.type === "blocks") {
      return {
        messages: [{ role: "user", content: cloneBlocks(input.content) }],
        shouldCallModel: !input.isMeta,
        diagnostics: [],
      };
    }

    const trimmed = input.text;
    const match = trimmed.match(SLASH_COMMAND_RE);
    if (!match) {
      return {
        messages: [{ role: "user", content: [{ type: "text", text: trimmed }] }],
        shouldCallModel: !input.isMeta,
        diagnostics: [],
      };
    }

    const commandName = match.groups?.name ?? "";
    const argument = trimmed.slice(match[0].length);
    const command = this.findCommand(commandName);
    if (!command) {
      return {
        messages: [{ role: "user", content: [{ type: "text", text: trimmed }] }],
        shouldCallModel: !input.isMeta,
        diagnostics: [
          {
            code: "unknown_command",
            severity: "warning",
            message: `Slash command /${commandName} is not registered. Forwarding as plain text.`,
          },
        ],
        command: { name: commandName, argument: argument || undefined, source: "unknown" },
      };
    }

    const text = argument
      ? `Run plugin command "/${commandName}" with argument: ${argument}`
      : `Run plugin command "/${commandName}".`;
    return {
      messages: [{ role: "user", content: [{ type: "text", text }] }],
      shouldCallModel: !input.isMeta,
      diagnostics: [],
      command: { name: commandName, argument: argument || undefined, source: "extension" },
    };
  }

  private findCommand(name: string): ContributedCommand | undefined {
    return this.extension.listCommands().find((command) => command.name === name);
  }
}

function cloneBlocks(blocks: CanonicalContentBlock[]): CanonicalContentBlock[] {
  return blocks.map((block) => ({ ...block }));
}
