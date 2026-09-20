import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import path from "node:path";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import { contentToText, type PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolValidationIssue } from "../protocol/schema.js";
import { isReadOnlyShellCommand } from "./bash/permissions.js";
import type { PilotDeckCommandRunner } from "./bash/commandRunner.js";
import { collectPythonSyntaxDiagnostics } from "./filesystem/syntaxDiagnostics.js";
import { createNodeExecutionWorkspacePort } from "../execution-world/NodeExecutionWorkspacePort.js";
import type { ExecutionWorkspacePort } from "../execution-world/ExecutionWorkspacePort.js";
import { createNodeCodeRuntimePort } from "../execution-world/NodeCodeRuntimePort.js";
import type { CodeRuntimePort } from "../execution-world/CodeRuntimePort.js";
import type { SandboxMode, SandboxPolicy, SandboxPort } from "../execution-world/SandboxPort.js";
import {
  createNodeExecutionTransportPort,
  setExecuteCodeTransportOverrideForTests,
  type ExecutionRpcTransport,
  type ExecutionTransportPort,
} from "../execution-world/ExecutionTransportPort.js";

type ExecuteCodeInput = {
  code: string;
  description?: string;
  timeout_seconds?: number;
  max_tool_calls?: number;
};

export type ExecuteCodeStatus = "success" | "error" | "timeout" | "cancelled" | "unsupported";

export type ExecuteCodeToolCallLogEntry = {
  tool: string;
  duration_ms: number;
  ok: boolean;
};

export type ExecuteCodeOutput = {
  status: ExecuteCodeStatus;
  output: string;
  error?: string;
  tool_calls_made: number;
  duration_seconds: number;
  tool_call_log: ExecuteCodeToolCallLogEntry[];
};

export type CreateExecuteCodeToolOptions = {
  /** Defaults to true. False removes the web_search Python helper and RPC capability. */
  webSearch?: boolean;
  /** Optional host-selected helper allowlist. */
  allowedTools?: readonly ExecuteCodeHelperToolName[];
  /** Private temporary workspace provider; composition roots may replace the Node provider. */
  executionWorkspace?: ExecutionWorkspacePort;
  /** Code process provider; the builtin retains Python RPC and tool-dispatch ownership. */
  codeRuntime?: CodeRuntimePort;
  /** Private RPC transport provider; the builtin retains protocol and dispatch ownership. */
  executionTransport?: ExecutionTransportPort;
  /** Optional per-run sandbox adapter. Omission preserves the legacy unconfined execution path. */
  sandbox?: {
    port: SandboxPort;
    mode?: SandboxMode;
    resolvePolicy(input: { workspaceRoot: string; executionRoot: string }): SandboxPolicy;
  };
};

type RpcRequest = {
  token?: unknown;
  tool?: unknown;
  args?: unknown;
};

type RpcResponse = {
  content?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
  code?: string;
};

type RpcTransport = ExecutionRpcTransport;

export type ExecuteCodeTransportKind = RpcTransport["kind"];
export { setExecuteCodeTransportOverrideForTests };

export async function handleExecuteCodeRpcLineForTests(
  line: string,
  options: {
    expectedToken?: string;
    executeTool?: NonNullable<PilotDeckToolRuntimeContext["executeTool"]>;
    webSearch?: boolean;
    allowedTools?: readonly ExecuteCodeHelperToolName[];
  } = {},
): Promise<RpcResponse> {
  return handleRpcLine(line, {
    context: {
      sessionId: "test-session",
      turnId: "test-turn",
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
      permissionContext: {
        mode: "bypassPermissions",
        rules: { allow: [], deny: [], ask: [] },
        cwd: process.cwd(),
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
      },
    },
    executeTool: options.executeTool ?? (async () => {
      throw new Error("executeTool should not be called by this test.");
    }),
    maxToolCalls: 50,
    toolCallLog: [],
    nextToolCall: () => 1,
    canCallTool: () => true,
    expectedToken: options.expectedToken,
    allowedTools: resolveExecuteCodeAllowedTools({
      webSearch: options.webSearch,
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    }),
  });
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_TOOL_CALLS = 50;
const MAX_STDOUT_BYTES = 50_000;
const MAX_STDERR_BYTES = 10_000;
const EXECUTE_CODE_BASE_ALLOWED_TOOLS = [
  "web_fetch",
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "glob",
  "bash",
] as const;

export type ExecuteCodeHelperToolName = (typeof EXECUTE_CODE_BASE_ALLOWED_TOOLS)[number] | "web_search";

function resolveExecuteCodeAllowedTools(
  options: CreateExecuteCodeToolOptions,
): ReadonlySet<string> {
  if (options.allowedTools) {
    const known = new Set<ExecuteCodeHelperToolName>([...EXECUTE_CODE_BASE_ALLOWED_TOOLS, "web_search"]);
    return new Set(options.allowedTools.filter((name) => known.has(name)));
  }
  const allowed = new Set<string>(EXECUTE_CODE_BASE_ALLOWED_TOOLS);
  if (options.webSearch !== false) {
    allowed.add("web_search");
  }
  return allowed;
}

export function createExecuteCodeTool(
  options: CreateExecuteCodeToolOptions = {},
): PilotDeckToolDefinition<ExecuteCodeInput, ExecuteCodeOutput> {
  const allowedTools = resolveExecuteCodeAllowedTools(options);
  const executionWorkspace = options.executionWorkspace ?? createNodeExecutionWorkspacePort();
  const codeRuntime = options.codeRuntime ?? createNodeCodeRuntimePort();
  const executionTransport = options.executionTransport ?? createNodeExecutionTransportPort();
  const sandbox = options.sandbox;
  const availableHelpers = options.allowedTools
    ? [...allowedTools]
    : [
        ...(allowedTools.has("web_search") ? ["web_search"] : []),
        ...EXECUTE_CODE_BASE_ALLOWED_TOOLS,
      ];
  const supportsFileWrites = allowedTools.has("write_file") || allowedTools.has("edit_file");
  const helperExample = allowedTools.has("edit_file")
    ? "grep -> read_file -> edit_file"
    : allowedTools.has("read_file")
      ? "grep -> read_file"
      : "bash -> concise output";
  const fileWriteGuidance = supportsFileWrites
    ? "Before modifying an existing file, call read_file first so PilotDeck can verify freshness. Prefer edit_file for targeted changes and write_file for new files or complete rewrites. "
    : "This session exposes only the listed helper subset; unavailable file-write and network helpers must not be imported or called. ";
  const helperSurface = availableHelpers.length > 0
    ? `Available helper functions: ${availableHelpers.join(", ")}. `
    : "No PilotDeck helper RPC is available in this strict host sandbox. ";
  const helperGuidance = availableHelpers.length > 0
    ? `Use normal Python control flow to orchestrate tools: loops for batch work, conditionals for branching, data structures for aggregation, and try/except around individual helper calls when one failure should not abort the whole script. Helper failures raise RuntimeError. You can chain helper results, e.g. ${helperExample}. Print only the concise final result needed by the agent. `
    : "Use normal Python only against the profile-owned process and its mounted workspace; do not import PilotDeck helpers. ";
  const executionEnvironment = describeExecutionEnvironment(sandbox);
  return {
    name: "execute_code",
    description:
      "Run a local Python 3 script that can call a small allow-list of PilotDeck tools via `import pilotdeck_tools`. " +
      executionEnvironment +
      "Only the script's final stdout/stderr summary is returned to the model; intermediate tool results stay inside the script. " +
      helperSurface +
      helperGuidance +
      fileWriteGuidance +
      "Notebook edits, agent, task tools, MCP tools, and execute_code itself are not available.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["code"],
      additionalProperties: false,
      properties: {
        code: {
          type: "string",
          description: "Python 3 source code to execute. Use `from pilotdeck_tools import ...` to call allowed PilotDeck tools.",
        },
        description: {
          type: "string",
          description: "Optional human-readable note; ignored by execution.",
        },
        timeout_seconds: {
          type: "integer",
          description: "Maximum execution time in seconds. Defaults to 300; maximum 300.",
        },
        max_tool_calls: {
          type: "integer",
          description: "Maximum number of PilotDeck tool calls the script may make. Defaults to 50; maximum 50.",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        output: { type: "string" },
        error: { type: "string" },
        tool_calls_made: { type: "integer" },
        duration_seconds: { type: "number" },
        tool_call_log: { type: "array" },
      },
    },
    isReadOnly: (input) => isExecuteCodeReadOnly(input),
    isConcurrencySafe: () => false,
    validateInput: async (input) => validateExecuteCodeInput(input as ExecuteCodeInput),
    execute: async (input, context) => {
      const startedAt = Date.now();
      const result = await runExecuteCode(input, context, startedAt, {
        allowedTools,
        executionWorkspace,
        codeRuntime,
        executionTransport,
        sandbox,
      });
      return {
        content: [{ type: "text", text: formatExecuteCodeResult(result) }],
        data: result,
        metadata: {
          status: result.status,
          tool_calls_made: result.tool_calls_made,
          duration_seconds: result.duration_seconds,
          cwd: context.cwd,
          env_inheritance: "full",
          python_path_augmented: true,
        },
      };
    },
  };
}

function describeExecutionEnvironment(
  sandbox: CreateExecuteCodeToolOptions["sandbox"],
): string {
  if (!sandbox || sandbox.mode === "danger-full-access") {
    return "The script runs from the workspace cwd and inherits the same runtime environment as normal tools such as bash, including configured API, proxy, PATH, virtualenv, and conda variables; do not print secrets or dump the full environment. ";
  }
  if (sandbox.mode === "read-only" || sandbox.mode === "workspace-write") {
    return `The script runs from the workspace cwd with the host ${sandbox.mode} file-effect policy. It inherits the same runtime environment as normal tools such as bash, including configured API, proxy, PATH, virtualenv, and conda variables; do not print secrets or dump the full environment. `;
  }
  return "The script runs through a host-selected sandbox whose environment visibility is provider-defined; do not assume provider credentials or arbitrary host variables are available, and do not print secrets or dump the full environment. ";
}

async function validateExecuteCodeInput(input: ExecuteCodeInput) {
  const issues: PilotDeckToolValidationIssue[] = [];
  if (!input.code.trim()) {
    issues.push({ path: "$.code", code: "invalid_schema", message: "$.code must not be empty." });
  }
  if (input.timeout_seconds !== undefined && (input.timeout_seconds < 1 || input.timeout_seconds > DEFAULT_TIMEOUT_SECONDS)) {
    issues.push({
      path: "$.timeout_seconds",
      code: "invalid_schema",
      message: `$.timeout_seconds must be between 1 and ${DEFAULT_TIMEOUT_SECONDS}.`,
    });
  }
  if (input.max_tool_calls !== undefined && (input.max_tool_calls < 0 || input.max_tool_calls > DEFAULT_MAX_TOOL_CALLS)) {
    issues.push({
      path: "$.max_tool_calls",
      code: "invalid_schema",
      message: `$.max_tool_calls must be between 0 and ${DEFAULT_MAX_TOOL_CALLS}.`,
    });
  }
  if (issues.length === 0) {
    const syntaxDiagnostics = await collectPythonSyntaxDiagnostics("execute_code.py", input.code);
    for (const diagnostic of syntaxDiagnostics) {
      issues.push({
        path: "$.code",
        code: "invalid_schema",
        message: `Python syntax error at L${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
      });
    }
  }
  return issues.length === 0 ? { ok: true as const, input } : { ok: false as const, issues };
}

function isExecuteCodeReadOnly(input: ExecuteCodeInput): boolean {
  const code = typeof input?.code === "string" ? input.code : undefined;
  if (!code) {
    return false;
  }
  return !containsWriteCapableHelper(code) && readOnlyBashCallsOnly(code);
}

function containsWriteCapableHelper(code: string): boolean {
  return /\b(?:write_file|edit_file)\s*\(/u.test(stripPythonCommentsAndStrings(code));
}

function readOnlyBashCallsOnly(code: string): boolean {
  const searchable = stripPythonCommentsAndStrings(code);
  const bashCallPattern = /\bbash\s*\(/gu;
  let match: RegExpExecArray | null;
  while ((match = bashCallPattern.exec(searchable)) !== null) {
    const command = readFirstPythonStringArgument(code, bashCallPattern.lastIndex);
    if (!command || !isReadOnlyShellCommand(command)) {
      return false;
    }
  }
  return true;
}

function readFirstPythonStringArgument(code: string, offset: number): string | undefined {
  let index = offset;
  while (index < code.length && /\s/u.test(code[index]!)) index += 1;
  const quote = code[index];
  if (quote !== '"' && quote !== "'") return undefined;
  const isTriple = code.slice(index, index + 3) === quote.repeat(3);
  const delimiterLength = isTriple ? 3 : 1;
  index += delimiterLength;
  let value = "";
  while (index < code.length) {
    if (code[index] === "\\") {
      const escaped = code[index + 1];
      if (escaped === undefined) return undefined;
      value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
      index += 2;
      continue;
    }
    if (code.slice(index, index + delimiterLength) === quote.repeat(delimiterLength)) {
      return value;
    }
    value += code[index]!;
    index += 1;
  }
  return undefined;
}

function stripPythonCommentsAndStrings(code: string): string {
  let output = "";
  let index = 0;
  while (index < code.length) {
    const char = code[index]!;
    if (char === "#") {
      while (index < code.length && code[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const isTriple = code.slice(index, index + 3) === quote.repeat(3);
      const length = isTriple ? 3 : 1;
      output += " ".repeat(length);
      index += length;
      while (index < code.length) {
        if (code[index] === "\\") {
          output += "  ";
          index += 2;
          continue;
        }
        if (code.slice(index, index + length) === quote.repeat(length)) {
          output += " ".repeat(length);
          index += length;
          break;
        }
        output += code[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

async function runExecuteCode(
  input: ExecuteCodeInput,
  context: PilotDeckToolRuntimeContext,
  startedAt: number,
  options: {
    allowedTools: ReadonlySet<string>;
    executionWorkspace: ExecutionWorkspacePort;
    codeRuntime: CodeRuntimePort;
    executionTransport: ExecutionTransportPort;
    sandbox?: NonNullable<CreateExecuteCodeToolOptions["sandbox"]>;
  },
): Promise<ExecuteCodeOutput> {
  const timeoutSeconds = input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
  const maxToolCalls = input.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
  const toolCallLog: ExecuteCodeToolCallLogEntry[] = [];
  let toolCallsMade = 0;

  const executeTool = context.executeTool;
  if (!executeTool) {
    return buildOutput(
      "unsupported",
      "",
      "execute_code requires a ToolRuntime recursion hook, but this host did not provide one.",
      startedAt,
      toolCallsMade,
      toolCallLog,
    );
  }

  const python = await options.codeRuntime.resolveExecutable(["python3", "python"], context.env, context.abortSignal);
  if (!python) {
    return buildOutput("unsupported", "", "execute_code requires python3 on PATH.", startedAt, toolCallsMade, toolCallLog);
  }

  const executionWorkspace = await options.executionWorkspace.create({
    prefix: "pilotdeck_execute_code_",
    signal: context.abortSignal,
  });
  const tempRoot = executionWorkspace.root;
  const sandboxPolicy = options.sandbox?.resolvePolicy({
    workspaceRoot: context.cwd,
    executionRoot: tempRoot,
  });
  // RPC helpers execute through the host ToolRuntime rather than the confined
  // Python child. Remove host-side mutation paths under a constrained policy.
  const rpcAllowedTools = restrictSandboxedRpcTools(options.allowedTools, sandboxPolicy);
  let transport = options.executionTransport.create();
  let server: Server | undefined;

  const cleanup = async () => {
    await closeServer(server);
    await executionWorkspace.cleanup();
    await options.executionTransport.cleanup(transport);
  };

  try {
    await executionWorkspace.writeText(
      "pilotdeck_tools.py",
      generatePilotDeckToolsModule(transport.kind, options.allowedTools),
    );
    await executionWorkspace.writeText("script.py", input.code);

    server = createRpcServer({
      context,
      executeTool,
      maxToolCalls,
      toolCallLog,
      nextToolCall: () => {
        toolCallsMade += 1;
        return toolCallsMade;
      },
      canCallTool: () => toolCallsMade < maxToolCalls,
      expectedToken: transport.kind === "tcp" ? transport.token : undefined,
      allowedTools: rpcAllowedTools,
    });
    transport = await listen(server, transport);

    const command = {
      executable: python,
      args: [path.join(tempRoot, "script.py")],
      cwd: context.cwd,
      env: buildChildEnv(context.env ?? process.env, transport, tempRoot, context.cwd),
    };
    const sandboxedCommand = options.sandbox
      ? await options.sandbox.port.prepare({
          ...command,
          policy: sandboxPolicy!,
          signal: context.abortSignal,
        })
      : command;
    const execution = await options.codeRuntime.run({
      ...sandboxedCommand,
      timeoutMs: timeoutSeconds * 1000,
      signal: context.abortSignal,
      stdoutMaxBytes: MAX_STDOUT_BYTES,
      stderrMaxBytes: MAX_STDERR_BYTES,
    });
    const status = execution.cancelled ? "cancelled"
      : execution.timedOut ? "timeout"
        : execution.exitCode !== 0 ? "error"
          : "success";
    const statusError = status === "cancelled" ? "Script execution was cancelled."
      : status === "timeout" ? `Script timed out after ${timeoutSeconds}s and was killed.`
        : status === "error" ? execution.stderr || `Script exited with code ${execution.exitCode ?? "unknown"}.`
          : undefined;
    const output = status === "error" && execution.stderr
      ? `${execution.stdout}\n--- stderr ---\n${execution.stderr}`.trim()
      : execution.stdout;
    return buildOutput(status, stripAnsi(output), statusError ? stripAnsi(statusError) : undefined, startedAt, toolCallsMade, toolCallLog);
  } catch (error) {
    return buildOutput("error", "", error instanceof Error ? error.message : String(error), startedAt, toolCallsMade, toolCallLog);
  } finally {
    await cleanup();
  }
}

function restrictSandboxedRpcTools(
  allowedTools: ReadonlySet<string>,
  policy: SandboxPolicy | undefined,
): ReadonlySet<string> {
  if (!policy || policy.mode === "danger-full-access") return allowedTools;
  const confined = new Set(allowedTools);
  // These all execute outside the Python child, so Seatbelt on the child
  // cannot enforce their side effects. Do not let RPC become an escape hatch.
  confined.delete("bash");
  confined.delete("write_file");
  confined.delete("edit_file");
  return confined;
}

function createRpcServer(options: {
  context: PilotDeckToolRuntimeContext;
  executeTool: NonNullable<PilotDeckToolRuntimeContext["executeTool"]>;
  maxToolCalls: number;
  toolCallLog: ExecuteCodeToolCallLogEntry[];
  nextToolCall: () => number;
  canCallTool: () => boolean;
  expectedToken?: string;
  allowedTools: ReadonlySet<string>;
}): Server {
  return createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      void processBufferedRequests(socket, () => {
        const lines: string[] = [];
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          lines.push(line);
          index = buffer.indexOf("\n");
        }
        return lines;
      }, options);
    });
  });
}

async function processBufferedRequests(
  socket: Socket,
  takeLines: () => string[],
  options: {
    context: PilotDeckToolRuntimeContext;
    executeTool: NonNullable<PilotDeckToolRuntimeContext["executeTool"]>;
    maxToolCalls: number;
    toolCallLog: ExecuteCodeToolCallLogEntry[];
    nextToolCall: () => number;
    canCallTool: () => boolean;
    expectedToken?: string;
    allowedTools: ReadonlySet<string>;
  },
): Promise<void> {
  for (const rawLine of takeLines()) {
    const line = rawLine.trim();
    if (!line) continue;
    const response = await handleRpcLine(line, options);
    socket.write(`${JSON.stringify(response)}\n`);
  }
}

async function handleRpcLine(
  line: string,
  options: {
    context: PilotDeckToolRuntimeContext;
    executeTool: NonNullable<PilotDeckToolRuntimeContext["executeTool"]>;
    maxToolCalls: number;
    toolCallLog: ExecuteCodeToolCallLogEntry[];
    nextToolCall: () => number;
    canCallTool: () => boolean;
    expectedToken?: string;
    allowedTools: ReadonlySet<string>;
  },
): Promise<RpcResponse> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch (error) {
    return { error: `Invalid RPC request: ${error instanceof Error ? error.message : String(error)}`, code: "invalid_rpc" };
  }

  const toolName = typeof request.tool === "string" ? request.tool : "";
  const args = isRecord(request.args) ? request.args : {};
  if (options.expectedToken && request.token !== options.expectedToken) {
    return { error: "Invalid execute_code RPC token.", code: "invalid_rpc_token" };
  }
  if (!options.allowedTools.has(toolName)) {
    return { error: `Tool '${toolName}' is not available in execute_code.`, code: "tool_not_allowed" };
  }
  if (!options.canCallTool()) {
    return {
      error: `Tool call limit reached (${options.maxToolCalls}). No more tool calls allowed in this execution.`,
      code: "tool_call_limit_reached",
    };
  }

  const sequence = options.nextToolCall();
  const started = Date.now();
  const outerId = options.context.currentToolCallId ?? "execute_code";
  const result = await options.executeTool(
    { id: `${outerId}:code:${sequence}`, name: toolName, input: args },
    { currentToolCallId: `${outerId}:code:${sequence}` },
  );
  const ok = result.type === "success";
  options.toolCallLog.push({ tool: toolName, duration_ms: Date.now() - started, ok });
  return toolResultToRpcResponse(result);
}

function toolResultToRpcResponse(result: PilotDeckToolResult): RpcResponse {
  const content = result.content.map(contentToText).join("\n");
  if (result.type === "error") {
    const details = formatToolErrorDetails(result);
    return {
      error: details ? `${result.error.message}\n${details}` : result.error.message,
      code: result.error.code,
      content,
      metadata: result.metadata,
    };
  }
  return {
    content,
    data: result.data,
    metadata: result.metadata,
  };
}

function formatToolErrorDetails(result: Extract<PilotDeckToolResult, { type: "error" }>): string | undefined {
  const issues = result.error.details?.issues;
  if (!Array.isArray(issues)) return undefined;
  const messages = issues
    .map((issue) => isRecord(issue) && typeof issue.message === "string" ? issue.message : undefined)
    .filter((message): message is string => !!message);
  return messages.length > 0 ? messages.join("\n") : undefined;
}

function generatePilotDeckToolsModule(
  kind: RpcTransport["kind"],
  allowedTools: ReadonlySet<string>,
): string {
  // A strict host profile deliberately receives an importable but empty
  // module. This avoids exposing the RPC socket or any helper function to the
  // sandboxed Python process; the server still rejects raw protocol requests
  // because it receives the same empty allowlist.
  if (allowedTools.size === 0) {
    return '"""No PilotDeck helper RPC is available in this strict host sandbox."""\n';
  }
  const transportHeader = kind === "tcp" ? TCP_PYTHON_TRANSPORT_HEADER : UDS_PYTHON_TRANSPORT_HEADER;
  const webSearchHelper = allowedTools.has("web_search") ? `
def web_search(query, country=None):
    args = {"query": query}
    if country is not None:
        args["gl"] = country
    return _call("web_search", args)

` : "";
  const webFetchHelper = allowedTools.has("web_fetch") ? `
def web_fetch(url, mode=None, prompt=None):
    args = {"url": url}
    if mode is not None:
        args["mode"] = mode
    if prompt is not None:
        args["prompt"] = prompt
    return _call("web_fetch", args)

` : "";
  const readFileHelper = allowedTools.has("read_file") ? `
def read_file(file_path, offset=0, limit=None):
    args = {"file_path": file_path}
    if offset is not None and offset > 0:
        args["offset"] = offset
    if limit is not None:
        args["limit"] = limit
    return _call("read_file", args)

` : "";
  const writeFileHelper = allowedTools.has("write_file") ? `
def write_file(file_path, content):
    return _call("write_file", {"file_path": file_path, "content": content})

` : "";
  const editFileHelper = allowedTools.has("edit_file") ? `
def edit_file(file_path, old_string, new_string, replace_all=False):
    return _call("edit_file", {
        "file_path": file_path,
        "old_string": old_string,
        "new_string": new_string,
        "replace_all": replace_all,
    })

` : "";
  const grepHelper = allowedTools.has("grep") ? `
def grep(pattern, path=None, glob=None):
    args = {"pattern": pattern}
    if path is not None:
        args["path"] = path
    if glob is not None:
        args["glob"] = glob
    return _call("grep", args)

` : "";
  const globHelper = allowedTools.has("glob") ? `
def glob(pattern, path=None):
    args = {"pattern": pattern}
    if path is not None:
        args["path"] = path
    return _call("glob", args)

` : "";
  const bashHelper = allowedTools.has("bash") ? `
def bash(command, timeout_ms=None, workdir=None):
    args = {"command": command}
    if workdir is not None:
        args["command"] = "cd " + shlex.quote(workdir) + " && " + command
    if timeout_ms is not None:
        args["timeout"] = timeout_ms
    return _call("bash", args)
` : "";
  return `${transportHeader}
${webSearchHelper}${webFetchHelper}${readFileHelper}${writeFileHelper}${editFileHelper}${grepHelper}${globHelper}${bashHelper}`;
}

const UDS_PYTHON_TRANSPORT_HEADER = `"""Auto-generated PilotDeck execute_code RPC helpers."""
import json
import os
import shlex
import socket

_sock = None


def _connect():
    global _sock
    if _sock is None:
        _sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        _sock.connect(os.environ["PILOTDECK_RPC_SOCKET"])
        _sock.settimeout(300)
    return _sock


def _call(tool_name, args):
    conn = _connect()
    conn.sendall((json.dumps({"tool": tool_name, "args": args}) + "\\n").encode("utf-8"))
    chunks = []
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            raise RuntimeError("PilotDeck RPC server disconnected")
        chunks.append(chunk)
        if chunk.endswith(b"\\n"):
            break
    response = json.loads(b"".join(chunks).decode("utf-8").strip())
    if response.get("error"):
        raise RuntimeError(response.get("error"))
    return response
`;

const TCP_PYTHON_TRANSPORT_HEADER = `"""Auto-generated PilotDeck execute_code RPC helpers."""
import json
import os
import shlex
import socket

_sock = None
_token = os.environ["PILOTDECK_RPC_TOKEN"]


def _connect():
    global _sock
    if _sock is None:
        host = os.environ.get("PILOTDECK_RPC_HOST", "127.0.0.1")
        port = int(os.environ["PILOTDECK_RPC_PORT"])
        _sock = socket.create_connection((host, port), timeout=300)
        _sock.settimeout(300)
    return _sock


def _call(tool_name, args):
    conn = _connect()
    conn.sendall((json.dumps({"token": _token, "tool": tool_name, "args": args}) + "\\n").encode("utf-8"))
    chunks = []
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            raise RuntimeError("PilotDeck RPC server disconnected")
        chunks.append(chunk)
        if chunk.endswith(b"\\n"):
            break
    response = json.loads(b"".join(chunks).decode("utf-8").strip())
    if response.get("error"):
        raise RuntimeError(response.get("error"))
    return response
`;

function buildChildEnv(
  source: NodeJS.ProcessEnv,
  transport: RpcTransport,
  tempRoot: string,
  workspaceCwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  env.PYTHONPATH = source.PYTHONPATH ? `${tempRoot}${path.delimiter}${source.PYTHONPATH}` : tempRoot;
  env.PILOTDECK_WORKSPACE_CWD = workspaceCwd;
  env.PILOTDECK_EXECUTE_CODE_TEMP_ROOT = tempRoot;
  if (transport.kind === "uds") {
    env.PILOTDECK_RPC_SOCKET = transport.socketPath;
  } else {
    env.PILOTDECK_RPC_HOST = transport.host;
    env.PILOTDECK_RPC_PORT = String(transport.port);
    env.PILOTDECK_RPC_TOKEN = transport.token;
  }
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

function listen(server: Server, transport: RpcTransport): Promise<RpcTransport> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const onListening = () => {
      server.off("error", reject);
      if (transport.kind === "tcp") {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Unable to determine execute_code TCP RPC port."));
          return;
        }
        resolve({ ...transport, port: (address as AddressInfo).port });
        return;
      }
      resolve(transport);
    };
    if (transport.kind === "tcp") {
      server.listen(transport.port, transport.host, onListening);
    } else {
      server.listen(transport.socketPath, onListening);
    }
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function buildOutput(
  status: ExecuteCodeStatus,
  output: string,
  error: string | undefined,
  startedAt: number,
  toolCallsMade: number,
  toolCallLog: ExecuteCodeToolCallLogEntry[],
): ExecuteCodeOutput {
  return {
    status,
    output,
    ...(error ? { error } : {}),
    tool_calls_made: toolCallsMade,
    duration_seconds: Math.round(((Date.now() - startedAt) / 1000) * 100) / 100,
    tool_call_log: toolCallLog,
  };
}

function formatExecuteCodeResult(result: ExecuteCodeOutput): string {
  const lines = [`status: ${result.status}`, `duration_seconds: ${result.duration_seconds}`, `tool_calls_made: ${result.tool_calls_made}`];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.output) lines.push("", result.output);
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
