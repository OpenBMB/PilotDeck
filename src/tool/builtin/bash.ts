import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { NodeShellCommandRunner, type PilotDeckCommandRunner } from "./bash/commandRunner.js";
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

export type BashOutputState = "stdout_data" | "stderr_only" | "empty_stdout";

export type BashOutputAssertions = {
  commandSucceeded: boolean;
  stdoutVisible: boolean;
  stderrVisible: boolean;
  retrievedDataAvailable: boolean;
  stdoutBytes: number;
  stderrBytes: number;
};

export type BashOutput = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  outputState: BashOutputState;
  assertions: BashOutputAssertions;
};

const BASH_TOOL_DESCRIPTION = `Run a shell command in the PilotDeck workspace.

Usage:
- The \`command\` parameter is passed to the system shell (\`cmd.exe\` on Windows, \`/bin/sh\` on macOS/Linux).
- The shell runs in the current workspace directory and inherits the tool runtime environment.
- Use \`timeout\` to override the command timeout in milliseconds. When omitted, the default is 30000ms. Values above 600000ms are rejected; use task_create for longer-running commands.
- Use \`description\` to provide a short, clear label for logs and audits. Prefer 3-10 words that say what the command does.
- Use this tool for short shell commands, simple pipelines, and running saved workspace scripts.
- Use task_create for long-running work such as dev servers, watchers, builds, test suites, deploys, CI pollers, or commands that need more than the maximum foreground timeout. Poll with task_output and stop long-lived processes with task_stop.
- For non-trivial code or anything you will debug/rerun with changed parameters, first create or edit a script file with write_file/edit_file, then run that file. Avoid large inline heredocs, \`python - <<...\`, long \`python -c\`, or long \`node -e\` programs when a saved script would be reusable.
- Do not use shell-level backgrounding (\`nohup\`, \`disown\`, \`setsid\`, trailing \`&\`) in bash. Use task_create so PilotDeck can track lifecycle and output.
- Read-only shell commands (for example \`pwd\`, \`ls\`, \`git status\`, \`git diff\`, \`git log\`) are treated as read-only. Commands with side effects require permission, and known-dangerous commands are denied outright.
- The tool returns stdout, stderr, exit code, and duration. Non-zero exits raise a tool error, and timeouts raise \`tool_timeout\`.
- Successful results begin with \`BASH_RESULT[success][...]\` plus Assertions. Read \`retrieved_data_available\` before treating \`exit_code: 0\` as task progress: exit code 0 only proves the process succeeded, not that useful task data was retrieved.
- If a task needs content but the result is \`empty_stdout\` or \`stderr_only\`, run a follow-up command that prints or verifies the needed data instead of assuming progress.
- If you have no command to run, respond with text instead of calling bash.`;

const LONG_TASK_HINT =
  "Use task_create to start a tracked background task, task_output to poll output, and task_stop to clean up long-lived processes.";

const SHELL_BACKGROUND_WRAPPER_RE = /(?:^|[;&|]\s*|&&\s*|\|\|\s*|\$\(\s*)(?:nohup|disown|setsid)\b/iu;
const TRAILING_BACKGROUND_RE = /(?:^|[^&])&\s*(?:[)#}\]]\s*)?$/u;
const INLINE_BACKGROUND_RE = /(?:^|[;|]\s*)[^\n;&|]+&\s*(?:[;|]|&&|\|\|)/u;
const LONG_LIVED_COMMAND_PATTERNS = [
  /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/iu,
  /(?:^|\s)(?:vite|webpack(?:-dev-server)?|next|nuxt|astro|remix|svelte-kit)\b(?:[^\n]*\s(?:dev|start|preview|--host)\b|[^\n]*$)/iu,
  /(?:^|\s)(?:python(?:3)?\s+-m\s+http\.server|uvicorn|gunicorn|flask\s+run|streamlit\s+run|fastapi\s+dev)\b/iu,
  /(?:^|\s)(?:nodemon|tsx\s+watch|ts-node-dev|watchmedo)\b/iu,
  /(?:^|\s)(?:cargo\s+watch|watchexec|entr)\b/iu,
];

export function createBashTool(options?: CreateBashToolOptions): PilotDeckToolDefinition<BashInput, BashOutput> {
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
          description: "Optional timeout in milliseconds. Defaults to 30000. Max 600000; larger values are rejected. Use task_create for longer-running commands.",
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
    checkPermissions: async (input) => input.command ? classifyBashPermission(input.command) : ({ type: "allow" as const, reason: { type: "runtime" as const, message: "Empty command is safe" } }),
    execute: async (input, context) => {
      const command = input.command.trim();
      if (input.timeout !== undefined && input.timeout > maxTimeoutMs) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          `Foreground bash timeout ${input.timeout}ms exceeds the maximum of ${maxTimeoutMs}ms. ${LONG_TASK_HINT}`,
        );
      }
      const backgroundGuidance = foregroundBackgroundGuidance(command);
      if (backgroundGuidance) {
        throw new PilotDeckToolRuntimeError("invalid_tool_input", `${backgroundGuidance} ${LONG_TASK_HINT}`);
      }
      const timeoutMs = Math.max(1, input.timeout ?? defaultTimeoutMs);
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
      });

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
        });
      }

      const assertions = buildBashOutputAssertions(result.stdout, result.stderr, result.exitCode);
      const outputState = classifyBashOutput(assertions);

      return {
        content: [
          {
            type: "text",
            text: formatShellResult(result.stdout, result.stderr, result.exitCode, outputState, assertions),
          },
        ],
        data: {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          outputState,
          assertions,
        },
      };
    },
  };
}

function buildBashOutputAssertions(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): BashOutputAssertions {
  const stdoutVisible = stdout.trim().length > 0;
  const stderrVisible = stderr.trim().length > 0;
  return {
    commandSucceeded: exitCode === 0,
    stdoutVisible,
    stderrVisible,
    retrievedDataAvailable: stdoutVisible,
    stdoutBytes: Buffer.byteLength(stdout, "utf8"),
    stderrBytes: Buffer.byteLength(stderr, "utf8"),
  };
}

function classifyBashOutput(assertions: BashOutputAssertions): BashOutputState {
  if (assertions.stdoutVisible) {
    return "stdout_data";
  }
  if (assertions.stderrVisible) {
    return "stderr_only";
  }
  return "empty_stdout";
}

function formatShellResult(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  outputState: BashOutputState,
  assertions: BashOutputAssertions,
): string {
  const lines = [
    `BASH_RESULT[success][${outputState}]`,
    "Assertions:",
    `- exit_code: ${exitCode ?? "null"}`,
    `- stdout_visible: ${assertions.stdoutVisible}`,
    `- stderr_visible: ${assertions.stderrVisible}`,
    `- retrieved_data_available: ${assertions.retrievedDataAvailable}`,
    `- stdout_bytes: ${assertions.stdoutBytes}`,
    `- stderr_bytes: ${assertions.stderrBytes}`,
    `Interpretation: ${bashOutputInterpretation(outputState)}`,
  ];

  if (assertions.stdoutVisible) {
    lines.push("", "stdout:", stdout.trimEnd());
  }
  if (assertions.stderrVisible) {
    lines.push("", "stderr:", stderr.trimEnd());
  }

  return lines.join("\n");
}

function bashOutputInterpretation(outputState: BashOutputState): string {
  switch (outputState) {
    case "stdout_data":
      return "Command succeeded and stdout contains visible data; use stdout as the primary evidence for the next step.";
    case "stderr_only":
      return "Command succeeded but stdout is empty; stderr contains diagnostic or progress output and does not count as retrieved task data by default.";
    case "empty_stdout":
      return "Command succeeded with no visible stdout or stderr; this only confirms process success and does not prove task data was retrieved.";
  }
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

function foregroundBackgroundGuidance(command: string): string | undefined {
  if (looksLikeHelpOrVersionCommand(command)) {
    return undefined;
  }

  const unquoted = stripQuotedText(command);
  if (SHELL_BACKGROUND_WRAPPER_RE.test(unquoted)) {
    return "Foreground bash command uses shell-level background wrappers (nohup/disown/setsid).";
  }
  if (INLINE_BACKGROUND_RE.test(unquoted) || TRAILING_BACKGROUND_RE.test(unquoted)) {
    return "Foreground bash command uses shell-level '&' backgrounding.";
  }
  if (LONG_LIVED_COMMAND_PATTERNS.some((pattern) => pattern.test(unquoted))) {
    return "Foreground bash command appears to start a long-lived server, watcher, or dev process.";
  }
  return undefined;
}

function looksLikeHelpOrVersionCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /(?:^|\s)(?:--help|-h|help|--version|-v|version)\s*$/u.test(normalized);
}

function stripQuotedText(command: string): string {
  return command.replace(/(['"])(?:\\.|(?!\1).)*\1/gu, "").replace(/`(?:\\.|[^`])*`/gu, "");
}

export type { PilotDeckCommandOptions, PilotDeckCommandResult, PilotDeckCommandRunner } from "./bash/commandRunner.js";
