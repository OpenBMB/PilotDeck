import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import {
  NodeShellCommandRunner,
  type PilotDeckCommandInputRequest,
  type PilotDeckCommandRunner,
} from "./bash/commandRunner.js";
import { classifyBashPermission, isReadOnlyShellCommand } from "./bash/permissions.js";

export type BashInput = {
  command: string;
  timeout?: number;
  description?: string;
};

export type CreateBashToolOptions = {
  runner?: PilotDeckCommandRunner;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
};

const BASH_TOOL_DESCRIPTION = `Run a shell command in the PilotDeck workspace.

Usage:
- The \`command\` parameter is passed to the system shell (\`cmd.exe\` on Windows, \`/bin/sh\` on macOS/Linux).
- The shell runs in the current workspace directory and inherits the tool runtime environment.
- Use \`timeout\` to override the command timeout in milliseconds. When omitted, the default is 30000ms. Values above 600000ms are clamped to the maximum.
- Use \`description\` to provide a short, clear label for logs and audits. Prefer 3-10 words that say what the command does.
- Read-only shell commands (for example \`pwd\`, \`ls\`, \`git status\`, \`git diff\`, \`git log\`) are treated as read-only. Commands with side effects require permission, and known-dangerous commands are denied outright.
- The tool returns stdout, stderr, exit code, and duration. Non-zero exits raise a tool error, and timeouts raise \`tool_timeout\`.
- If you have no command to run, respond with text instead of calling bash.`;

export function createBashTool(options?: CreateBashToolOptions): PilotDeckToolDefinition<BashInput> {
  const runner = options?.runner ?? new NodeShellCommandRunner();
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = options?.maxTimeoutMs ?? 600_000;

  return {
    name: "bash",
    aliases: ["Bash"],
    description: BASH_TOOL_DESCRIPTION,
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (passed to the system shell).",
        },
        timeout: {
          type: "integer",
          description: "Optional timeout in milliseconds. Defaults to 30000. Max 600000.",
        },
        description: {
          type: "string",
          description: "Clear, concise description of what this command does in active voice. Prefer 3-10 words.",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isConcurrencySafe: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isOpenWorld: () => true,
    checkPermissions: async (input, context) => input.command
      ? classifyBashPermission(input.command, context.permissionContext.sudoPolicy)
      : ({ type: "allow" as const, reason: { type: "runtime" as const, message: "Empty command is safe" } }),
    execute: async (input, context) => {
      const command = input.command.trim();
      const timeoutMs = Math.min(Math.max(1, input.timeout ?? defaultTimeoutMs), maxTimeoutMs);
      const progress = context.progress;
      const toolCallId = ""; // ToolRuntime fills this via metadata; we pull from context if available.
      const emitProgress = progress
        ? (stream: "stdout" | "stderr") => (chunk: string) => {
            try {
              progress({
                type: "tool_progress",
                sessionId: context.sessionId,
                turnId: context.turnId,
                toolCallId,
                toolName: "bash",
                message: `${stream}: ${chunk.length} bytes`,
                metadata: { stream, chunk, byteCount: Buffer.byteLength(chunk, "utf8") },
                createdAt: (context.now?.() ?? new Date()).toISOString(),
              });
            } catch {
              // Progress sinks are fire-and-forget; never crash the tool.
            }
          }
        : undefined;
      const result = await runner.run(command, {
        cwd: context.cwd,
        env: context.env,
        timeoutMs,
        signal: context.abortSignal,
        onStdout: emitProgress?.("stdout"),
        onStderr: emitProgress?.("stderr"),
        onInputRequest: async (request) => {
          const channel = context.elicitation;
          if (!channel) {
            return {
              type: "cancelled",
              reason: "No elicitation channel is available for interactive command input.",
            };
          }
          emitInteractiveInputProgress(context, request);
          const fieldId = "stdin";
          const answer = await channel.askUser({
            toolCallId: context.currentToolCallId ?? context.turnId,
            toolName: "bash",
            questions: [],
            fields: [
              {
                id: fieldId,
                label: request.prompt,
                description: request.secret
                  ? "This value will be sent to the running command and will not be echoed in tool output."
                  : "This value will be sent to the running command stdin.",
                kind: request.secret ? "secret" : "text",
                required: true,
              },
            ],
            metadata: {
              source: "bash_interactive_input",
              command,
              stream: request.stream,
              secret: request.secret,
              prompt: request.prompt,
            },
            ...(context.abortSignal && { signal: context.abortSignal }),
          });
          if (answer.type === "cancelled") {
            return { type: "cancelled", reason: answer.reason };
          }
          const input = answer.inputs?.[fieldId] ?? scalarAnswer(answer.answers[fieldId]);
          if (typeof input !== "string" || input.length === 0) {
            return { type: "cancelled", reason: "No input was provided." };
          }
          return { type: "answered", input };
        },
      });

      if (result.interactiveInputCancelled) {
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `Command needed interactive input but could not continue${result.interactiveInputCancelledReason ? `: ${result.interactiveInputCancelledReason}` : "."}`,
          {
            command,
            interactions: result.interactions?.map(redactInteraction),
          },
        );
      }

      if (result.timedOut) {
        throw new PilotDeckToolRuntimeError("tool_timeout", `Command timed out after ${timeoutMs}ms.`);
      }

      if (result.exitCode !== 0) {
        const summary = formatShellFailure(command, result);
        throw new PilotDeckToolRuntimeError("tool_execution_failed", summary, {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          ...(result.interactions ? { interactions: result.interactions.map(redactInteraction) } : {}),
        });
      }

      return {
        content: [
          {
            type: "text",
            text: formatShellResult(result.stdout, result.stderr, result.exitCode),
          },
        ],
        data: {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          ...(result.interactions ? { interactions: result.interactions.map(redactInteraction) } : {}),
        },
        metadata: result.interactions
          ? { interactions: result.interactions.map(redactInteraction) }
          : undefined,
      };
    },
  };
}

function scalarAnswer(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function redactInteraction(interaction: NonNullable<Awaited<ReturnType<PilotDeckCommandRunner["run"]>>["interactions"]>[number]) {
  return {
    prompt: interaction.prompt,
    stream: interaction.stream,
    secret: interaction.secret,
    answered: interaction.answered,
    ...(interaction.cancelledReason ? { cancelledReason: interaction.cancelledReason } : {}),
  };
}

function emitInteractiveInputProgress(
  context: PilotDeckToolRuntimeContext,
  request: PilotDeckCommandInputRequest,
): void {
  try {
    context.progress?.({
      type: "tool_progress",
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.currentToolCallId ?? "",
      toolName: "bash",
      message: request.secret ? "waiting for secure input" : "waiting for input",
      metadata: {
        stream: request.stream,
        prompt: request.prompt,
        secret: request.secret,
      },
      createdAt: (context.now?.() ?? new Date()).toISOString(),
    });
  } catch {
    // Progress sinks are fire-and-forget.
  }
}

function formatShellResult(stdout: string, stderr: string, exitCode: number | null): string {
  const parts: string[] = [];
  if (stdout.length > 0) {
    parts.push(stdout);
  }
  if (stderr.length > 0) {
    parts.push(stderr);
  }
  return parts.length > 0 ? parts.join("\n") : `exitCode: ${exitCode ?? "null"}`;
}

function formatShellFailure(
  command: string,
  result: { exitCode: number | null; stdout: string; stderr: string },
): string {
  const lines: string[] = [];
  lines.push(`Command exited with code ${result.exitCode ?? "null"}: ${command}`);
  if (result.stderr.length > 0) {
    lines.push("", "stderr:", result.stderr.trimEnd());
  }
  if (result.stdout.length > 0) {
    lines.push("", "stdout:", result.stdout.trimEnd());
  }
  return lines.join("\n");
}

export type { PilotDeckCommandOptions, PilotDeckCommandResult, PilotDeckCommandRunner } from "./bash/commandRunner.js";
