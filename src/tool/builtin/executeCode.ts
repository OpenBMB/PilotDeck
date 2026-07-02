import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../protocol/types.js";
import { contentToText, type PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolValidationIssue } from "../protocol/schema.js";

type ExecuteCodeInput = {
  code: string;
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

type RpcTransport =
  | { kind: "uds"; socketPath: string }
  | { kind: "tcp"; host: "127.0.0.1"; port: number; token: string };

export type ExecuteCodeTransportKind = RpcTransport["kind"];

let executeCodeTransportOverride: ExecuteCodeTransportKind | undefined;

export function setExecuteCodeTransportOverrideForTests(kind: ExecuteCodeTransportKind | undefined): void {
  executeCodeTransportOverride = kind;
}

export async function handleExecuteCodeRpcLineForTests(
  line: string,
  options: {
    expectedToken?: string;
    executeTool?: NonNullable<PilotDeckToolRuntimeContext["executeTool"]>;
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
  });
}

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_TOOL_CALLS = 50;
const MAX_STDOUT_BYTES = 50_000;
const MAX_STDERR_BYTES = 10_000;
const EXECUTE_CODE_ALLOWED_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "glob",
  "bash",
]);
const SECRET_ENV_SUBSTRINGS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "PASSWD", "AUTH"];
const SAFE_ENV_PREFIXES = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "LOGNAME",
  "XDG_",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "CONDA",
  "TZ",
];

export function createExecuteCodeTool(): PilotDeckToolDefinition<ExecuteCodeInput, ExecuteCodeOutput> {
  return {
    name: "execute_code",
    description:
      "Run a local Python 3 script that can call a small allow-list of PilotDeck tools via `import pilotdeck_tools`. " +
      "Only the script's final stdout/stderr summary is returned to the model; intermediate tool results stay inside the script. " +
      "Available helper functions: web_search, web_fetch, read_file, write_file, edit_file, grep, glob, bash. " +
      "Use normal Python control flow to orchestrate tools: loops for batch work, conditionals for branching, data structures for aggregation, and try/except around individual helper calls when one failure should not abort the whole script. Helper failures raise RuntimeError. You can chain helper results, e.g. grep -> read_file -> edit_file. Print only the concise final result needed by the agent. " +
      "Before modifying an existing file, call read_file first so PilotDeck can verify freshness. Prefer edit_file for targeted changes and write_file for new files or complete rewrites. " +
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
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    validateInput: async (input) => validateExecuteCodeInput(input as ExecuteCodeInput),
    execute: async (input, context) => {
      const startedAt = Date.now();
      const result = await runExecuteCode(input, context, startedAt);
      return {
        content: [{ type: "text", text: formatExecuteCodeResult(result) }],
        data: result,
        metadata: {
          status: result.status,
          tool_calls_made: result.tool_calls_made,
          duration_seconds: result.duration_seconds,
        },
      };
    },
  };
}

function validateExecuteCodeInput(input: ExecuteCodeInput) {
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
  return issues.length === 0 ? { ok: true as const, input } : { ok: false as const, issues };
}

function createRpcTransport(): RpcTransport {
  const kind = executeCodeTransportOverride ?? (process.platform === "win32" ? "tcp" : "uds");
  if (kind === "tcp") {
    return {
      kind: "tcp",
      host: "127.0.0.1",
      port: 0,
      token: randomBytes(32).toString("hex"),
    };
  }
  return {
    kind: "uds",
    socketPath: path.join(
      process.platform === "darwin" ? "/tmp" : tmpdir(),
      `pilotdeck_rpc_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}.sock`,
    ),
  };
}

async function runExecuteCode(
  input: ExecuteCodeInput,
  context: PilotDeckToolRuntimeContext,
  startedAt: number,
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

  const python = await findPython3(context.env);
  if (!python) {
    return buildOutput("unsupported", "", "execute_code requires python3 on PATH.", startedAt, toolCallsMade, toolCallLog);
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "pilotdeck_execute_code_"));
  let transport = createRpcTransport();
  let server: Server | undefined;
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let settled = false;
  let status: ExecuteCodeStatus = "success";
  let statusError: string | undefined;

  const cleanup = async () => {
    await closeServer(server);
    await rm(tempRoot, { recursive: true, force: true });
    if (transport.kind === "uds") {
      await rm(transport.socketPath, { force: true });
    }
  };

  try {
    await writeFile(path.join(tempRoot, "pilotdeck_tools.py"), generatePilotDeckToolsModule(transport.kind), "utf8");
    await writeFile(path.join(tempRoot, "script.py"), input.code, "utf8");

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
    });
    transport = await listen(server, transport);

    child = spawn(python, ["script.py"], {
      cwd: tempRoot,
      env: buildChildEnv(context.env ?? process.env, transport),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const activeChild = child;
    const stdout = collectHeadTail(activeChild.stdout, MAX_STDOUT_BYTES);
    const stderr = collectHead(activeChild.stderr, MAX_STDERR_BYTES);

    const timeout = setTimeout(() => {
      if (!settled) {
        status = "timeout";
        statusError = `Script timed out after ${timeoutSeconds}s and was killed.`;
        killProcess(activeChild, true);
      }
    }, timeoutSeconds * 1000);

    const abortHandler = () => {
      if (!settled) {
        status = "cancelled";
        statusError = "Script execution was cancelled.";
        killProcess(activeChild, true);
      }
    };
    context.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    const exit = await waitForExit(activeChild);
    settled = true;
    clearTimeout(timeout);
    context.abortSignal?.removeEventListener("abort", abortHandler);

    const stdoutText = await stdout;
    const stderrText = await stderr;
    if (status === "success" && exit.code !== 0) {
      status = "error";
      statusError = stderrText || `Script exited with code ${exit.code ?? "unknown"}.`;
    }

    const output = status === "error" && stderrText ? `${stdoutText}\n--- stderr ---\n${stderrText}`.trim() : stdoutText;
    return buildOutput(status, stripAnsi(output), statusError ? stripAnsi(statusError) : undefined, startedAt, toolCallsMade, toolCallLog);
  } catch (error) {
    return buildOutput("error", "", error instanceof Error ? error.message : String(error), startedAt, toolCallsMade, toolCallLog);
  } finally {
    await cleanup();
  }
}

function createRpcServer(options: {
  context: PilotDeckToolRuntimeContext;
  executeTool: NonNullable<PilotDeckToolRuntimeContext["executeTool"]>;
  maxToolCalls: number;
  toolCallLog: ExecuteCodeToolCallLogEntry[];
  nextToolCall: () => number;
  canCallTool: () => boolean;
  expectedToken?: string;
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
  if (!EXECUTE_CODE_ALLOWED_TOOLS.has(toolName)) {
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

function generatePilotDeckToolsModule(kind: RpcTransport["kind"]): string {
  const transportHeader = kind === "tcp" ? TCP_PYTHON_TRANSPORT_HEADER : UDS_PYTHON_TRANSPORT_HEADER;
  return `${transportHeader}

def web_search(query, country=None):
    args = {"query": query}
    if country is not None:
        args["country"] = country
    return _call("web_search", args)


def web_fetch(url, extract="markdown"):
    mode = "raw" if extract == "markdown" else extract
    return _call("web_fetch", {"url": url, "mode": mode})


def read_file(file_path, offset=0, limit=None):
    args = {"file_path": file_path}
    if offset is not None and offset > 0:
        args["offset"] = offset
    if limit is not None:
        args["limit"] = limit
    return _call("read_file", args)


def write_file(file_path, content):
    return _call("write_file", {"file_path": file_path, "content": content})


def edit_file(file_path, old_string, new_string, replace_all=False):
    return _call("edit_file", {
        "file_path": file_path,
        "old_string": old_string,
        "new_string": new_string,
        "replace_all": replace_all,
    })


def grep(pattern, path=None, glob=None):
    args = {"pattern": pattern}
    if path is not None:
        args["path"] = path
    if glob is not None:
        args["glob"] = glob
    return _call("grep", args)


def glob(pattern, path=None):
    args = {"pattern": pattern}
    if path is not None:
        args["path"] = path
    return _call("glob", args)


def bash(command, timeout_ms=None, workdir=None):
    args = {"command": command}
    if workdir is not None:
        args["command"] = "cd " + shlex.quote(workdir) + " && " + command
    if timeout_ms is not None:
        args["timeout"] = timeout_ms
    return _call("bash", args)
`;
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

async function findPython3(env: NodeJS.ProcessEnv | undefined): Promise<string | undefined> {
  const candidates = ["python3", "python"];
  for (const candidate of candidates) {
    const result = await new Promise<boolean>((resolve) => {
      const child = spawn(candidate, ["--version"], { env, stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
    if (result) return candidate;
  }
  return undefined;
}

function buildChildEnv(source: NodeJS.ProcessEnv, transport: RpcTransport): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SECRET_ENV_SUBSTRINGS.some((part) => key.toUpperCase().includes(part))) continue;
    if (SAFE_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))) {
      env[key] = value;
    }
  }
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

function collectHead(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total < maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - total));
      }
      total += buffer.byteLength;
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function collectHeadTail(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const headBytes = Math.floor(maxBytes * 0.4);
  const tailBytes = maxBytes - headBytes;
  return new Promise((resolve) => {
    const head: Buffer[] = [];
    const tail: Buffer[] = [];
    let headCollected = 0;
    let tailCollected = 0;
    let total = 0;
    stream.on("data", (chunk: Buffer | string) => {
      let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (headCollected < headBytes) {
        const keep = Math.min(buffer.byteLength, headBytes - headCollected);
        head.push(buffer.subarray(0, keep));
        headCollected += keep;
        buffer = buffer.subarray(keep);
      }
      if (buffer.byteLength > 0) {
        tail.push(buffer);
        tailCollected += buffer.byteLength;
        while (tailCollected > tailBytes && tail.length > 0) {
          const first = tail[0]!;
          const overflow = tailCollected - tailBytes;
          if (overflow >= first.byteLength) {
            tail.shift();
            tailCollected -= first.byteLength;
          } else {
            tail[0] = first.subarray(overflow);
            tailCollected -= overflow;
          }
        }
      }
    });
    const finish = () => {
      const headText = Buffer.concat(head).toString("utf8");
      const tailText = Buffer.concat(tail).toString("utf8");
      if (total > maxBytes && tailText) {
        const omitted = Math.max(0, total - Buffer.byteLength(headText) - Buffer.byteLength(tailText));
        resolve(`${headText}\n\n... [OUTPUT TRUNCATED - ${omitted.toLocaleString()} bytes omitted out of ${total.toLocaleString()} total] ...\n\n${tailText}`);
      } else {
        resolve(headText + tailText);
      }
    };
    stream.on("end", finish);
    stream.on("error", finish);
  });
}

function waitForExit(child: ChildProcessByStdio<null, Readable, Readable>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

function killProcess(child: ChildProcessByStdio<null, Readable, Readable> | undefined, escalate: boolean): void {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
      if (escalate) setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* noop */ }
      }, 500).unref();
    } else {
      child.kill("SIGTERM");
      if (escalate) setTimeout(() => child?.kill("SIGKILL"), 500).unref();
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* noop */ }
  }
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
