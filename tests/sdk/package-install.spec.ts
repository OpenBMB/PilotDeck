import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createEmbeddedGatewayEndpoint, startGatewayServer } from "../../src/gateway/index.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
} from "../../src/model/protocol/canonical.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { MultimodalConstraints } from "../../src/model/protocol/multimodal.js";

const execFile = promisify(execFileCallback);

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
`;

class InstalledSdkTestModel implements ModelRuntime {
  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "installed SDK response" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "installed SDK response" }], finishReason: "stop" };
  }

  getCapabilities() {
    return DEFAULT_MODEL_CAPABILITIES;
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

/**
 * Exercises the public SDK's tool() + createPilotDeckMcpServer() path after
 * npm installation. The model asks for the wire-named MCP tool on its first
 * request, then turns the native tool result into its final answer.
 */
class InstalledSdkMcpTestModel implements ModelRuntime {
  private requests = 0;

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests += 1;
    const toolResult = request.messages.flatMap((message) => message.content)
      .find((block): block is Extract<typeof block, { type: "tool_result" }> => block.type === "tool_result");
    if (this.requests === 1) {
      yield { type: "request_started", provider: "test", model: "test" };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "sdk-mcp-call", name: "mcp__tickets__find_ticket" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "sdk-mcp-call", name: "mcp__tickets__find_ticket", input: { id: "PDX-123" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    const responseText = toolResult?.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: `SDK MCP result: ${responseText}` };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "unused" }], finishReason: "stop" };
  }

  getCapabilities() {
    return { ...DEFAULT_MODEL_CAPABILITIES, supportsToolUse: true };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

/**
 * Confirms that a callback owned by the installed SDK process is applied by
 * the existing native UserPromptSubmit lifecycle before model invocation.
 */
class InstalledSdkHookTestModel implements ModelRuntime {
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const hookContext = request.messages
      .flatMap((message) => message.content)
      .find((block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text" && block.text.includes("sdk-hook-context"),
      );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: hookContext ? "SDK hook context: observed" : "SDK hook context: missing" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "unused" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

/** Verifies that an explicit SDK tools: [] reaches the native registry as an empty allow-list. */
class InstalledSdkNoToolsTestModel implements ModelRuntime {
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const isSdkTurn = request.metadata?.purpose !== "session_title_generation";
    if (isSdkTurn) {
      assert.deepEqual(request.tools ?? [], [], "tools: [] must not fall back to the native default registry");
    }
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "SDK empty tool set observed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "unused" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

test("packed SDK includes the human-readable runnable examples", { timeout: 60_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-examples-pack-"));
  const packageRoot = resolve(process.cwd(), "packages/sdk");
  try {
    await execFile("pnpm", ["--dir", packageRoot, "build"]);
    await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", tempRoot]);
    const tarball = (await readdir(tempRoot)).find((file) => file.endsWith(".tgz"));
    assert.ok(tarball);
    const { stdout } = await execFile("tar", ["-tzf", join(tempRoot, tarball)]);
    for (const example of ["basic-run.mjs", "streaming.mjs", "permission.mjs", "resume-fork.mjs", "abort.mjs", "mcp-tool.mjs", "structured-output.mjs"]) {
      assert.match(stdout, new RegExp(`package/examples/${example.replace(".", "\\.")}`));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("packed @pilotdeck/sdk installs and queries a real local Gateway", { timeout: 60_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-install-"));
  const packageRoot = resolve(process.cwd(), "packages/sdk");
  const packDirectory = join(tempRoot, "pack");
  const fixtureDirectory = join(tempRoot, "fixture");
  const projectRoot = join(tempRoot, "project");
  const pilotHome = join(tempRoot, "pilot-home");
  await mkdir(packDirectory, { recursive: true });
  await mkdir(fixtureDirectory, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: pilotHome,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new InstalledSdkTestModel(),
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-package-test-token" });

  try {
    await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");
    await writeFile(join(fixtureDirectory, "check.mjs"), INSTALLED_CONSUMER, "utf8");

    await execFile("pnpm", ["--dir", packageRoot, "build"]);
    await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", packDirectory]);
    const tarball = (await readdir(packDirectory)).find((file) => file.endsWith(".tgz"));
    assert.ok(tarball, "pnpm pack should create a package tarball");
    await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packDirectory, tarball)], { cwd: fixtureDirectory });

    const { stdout } = await execFile(process.execPath, ["check.mjs"], {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        PILOTDECK_SDK_GATEWAY_URL: server.wsUrl,
        PILOTDECK_SDK_AUTH_TOKEN: server.token,
      },
    });
    const result = JSON.parse(stdout) as {
      events: string[];
      result: { status: string; output?: string; error?: { code?: string; message?: string } };
      resolved: { schemaVersion: number; apiKey?: string };
    };
    assert.equal(result.resolved.schemaVersion, 1, stdout);
    assert.equal(result.resolved.apiKey, "<redacted>", stdout);
    assert.ok(result.events.includes("turn.started"), stdout);
    assert.ok(result.events.includes("assistant.message"), stdout);
    assert.equal(result.events.at(-1), "result", stdout);
    assert.equal(result.result.status, "completed", JSON.stringify(result));
    assert.equal(result.result.output, "installed SDK response", JSON.stringify(result));
  } finally {
    await server.close();
    local.dispose();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("packed @pilotdeck/sdk embedded export queries an authoritative in-process Gateway", { timeout: 60_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-embedded-install-"));
  const packageRoot = resolve(process.cwd(), "packages/sdk");
  const packDirectory = join(tempRoot, "pack");
  const fixtureDirectory = join(tempRoot, "fixture");
  const projectRoot = join(tempRoot, "project");
  const pilotHome = join(tempRoot, "pilot-home");
  await Promise.all([mkdir(packDirectory, { recursive: true }), mkdir(fixtureDirectory, { recursive: true }), mkdir(projectRoot, { recursive: true }), mkdir(pilotHome, { recursive: true })]);
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: pilotHome,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new InstalledSdkTestModel(),
  });
  const token = "sdk-embedded-package-test-token";
  const endpoint = createEmbeddedGatewayEndpoint({ gateway: local.gateway, token });

  try {
    await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");
    await writeFile(join(fixtureDirectory, "embedded-consumer.mjs"), INSTALLED_EMBEDDED_CONSUMER, "utf8");
    await execFile("pnpm", ["--dir", packageRoot, "build"]);
    await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", packDirectory]);
    const tarball = (await readdir(packDirectory)).find((file) => file.endsWith(".tgz"));
    assert.ok(tarball, "pnpm pack should create a package tarball");
    await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packDirectory, tarball)], { cwd: fixtureDirectory });

    const consumer = await import(pathToFileURL(join(fixtureDirectory, "embedded-consumer.mjs")).href) as {
      run(endpoint: ReturnType<typeof createEmbeddedGatewayEndpoint>, token: string, projectKey: string): Promise<{
        events: string[];
        result: { status: string; output?: string; error?: { code?: string; message?: string } };
      }>;
    };
    const result = await consumer.run(endpoint, token, pilotHome);
    assert.ok(result.events.includes("turn.started"), JSON.stringify(result));
    assert.equal(result.events.at(-1), "result", JSON.stringify(result));
    assert.equal(result.result.status, "completed", JSON.stringify(result));
    assert.equal(result.result.output, "installed SDK response", JSON.stringify(result));
    assert.equal((await local.gateway.listSessions({ projectKey: pilotHome })).sessions.length, 1);
  } finally {
    endpoint.close();
    local.dispose();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("packed @pilotdeck/sdk executes an SDK-hosted MCP tool through a real local Gateway", { timeout: 60_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-mcp-install-"));
  const packageRoot = resolve(process.cwd(), "packages/sdk");
  const packDirectory = join(tempRoot, "pack");
  const fixtureDirectory = join(tempRoot, "fixture");
  const projectRoot = join(tempRoot, "project");
  const pilotHome = join(tempRoot, "pilot-home");
  await Promise.all([mkdir(packDirectory, { recursive: true }), mkdir(fixtureDirectory, { recursive: true }), mkdir(projectRoot, { recursive: true }), mkdir(pilotHome, { recursive: true })]);
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: pilotHome,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new InstalledSdkMcpTestModel(),
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-mcp-package-test-token" });

  try {
    await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");
    await writeFile(join(fixtureDirectory, "check.mjs"), INSTALLED_MCP_CONSUMER, "utf8");
    await execFile("pnpm", ["--dir", packageRoot, "build"]);
    await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", packDirectory]);
    const tarball = (await readdir(packDirectory)).find((file) => file.endsWith(".tgz"));
    assert.ok(tarball, "pnpm pack should create a package tarball");
    await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packDirectory, tarball)], { cwd: fixtureDirectory });

    const { stdout } = await execFile(process.execPath, ["check.mjs"], {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        PILOTDECK_SDK_GATEWAY_URL: server.wsUrl,
        PILOTDECK_SDK_AUTH_TOKEN: server.token,
      },
    });
    const result = JSON.parse(stdout) as { events: string[]; result: { status: string; output?: string } };
    assert.ok(result.events.includes("tool.started"), stdout);
    assert.ok(result.events.includes("tool.completed"), stdout);
    assert.equal(result.result.status, "completed", stdout);
    assert.equal(result.result.output, "SDK MCP result: ticket:PDX-123", stdout);
  } finally {
    await server.close();
    local.dispose();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("packed @pilotdeck/sdk executes callback Hooks through a real local Gateway", { timeout: 60_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-hooks-install-"));
  const packageRoot = resolve(process.cwd(), "packages/sdk");
  const packDirectory = join(tempRoot, "pack");
  const fixtureDirectory = join(tempRoot, "fixture");
  const projectRoot = join(tempRoot, "project");
  const pilotHome = join(tempRoot, "pilot-home");
  await Promise.all([mkdir(packDirectory, { recursive: true }), mkdir(fixtureDirectory, { recursive: true }), mkdir(projectRoot, { recursive: true }), mkdir(pilotHome, { recursive: true })]);
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: pilotHome,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new InstalledSdkHookTestModel(),
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-hooks-package-test-token" });

  try {
    await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");
    await writeFile(join(fixtureDirectory, "check.mjs"), INSTALLED_HOOK_CONSUMER, "utf8");
    await execFile("pnpm", ["--dir", packageRoot, "build"]);
    await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", packDirectory]);
    const tarball = (await readdir(packDirectory)).find((file) => file.endsWith(".tgz"));
    assert.ok(tarball, "pnpm pack should create a package tarball");
    await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packDirectory, tarball)], { cwd: fixtureDirectory });

    const { stdout } = await execFile(process.execPath, ["check.mjs"], {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        PILOTDECK_SDK_GATEWAY_URL: server.wsUrl,
        PILOTDECK_SDK_AUTH_TOKEN: server.token,
      },
    });
    const result = JSON.parse(stdout) as { result: { status: string; output?: string } };
    assert.equal(result.result.status, "completed", stdout);
    assert.equal(result.result.output, "SDK hook context: observed", stdout);
  } finally {
    await server.close();
    local.dispose();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("packed @pilotdeck/sdk preserves an explicit empty tool allow-list", { timeout: 60_000 }, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-empty-tools-install-"));
  const packageRoot = resolve(process.cwd(), "packages/sdk");
  const packDirectory = join(tempRoot, "pack");
  const fixtureDirectory = join(tempRoot, "fixture");
  const projectRoot = join(tempRoot, "project");
  const pilotHome = join(tempRoot, "pilot-home");
  await Promise.all([mkdir(packDirectory, { recursive: true }), mkdir(fixtureDirectory, { recursive: true }), mkdir(projectRoot, { recursive: true }), mkdir(pilotHome, { recursive: true })]);
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: pilotHome,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new InstalledSdkNoToolsTestModel(),
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-empty-tools-package-test-token" });

  try {
    await writeFile(join(fixtureDirectory, "package.json"), JSON.stringify({ type: "module", private: true }), "utf8");
    await writeFile(join(fixtureDirectory, "check.mjs"), INSTALLED_EMPTY_TOOLS_CONSUMER, "utf8");
    await execFile("pnpm", ["--dir", packageRoot, "build"]);
    await execFile("pnpm", ["--dir", packageRoot, "pack", "--pack-destination", packDirectory]);
    const tarball = (await readdir(packDirectory)).find((file) => file.endsWith(".tgz"));
    assert.ok(tarball, "pnpm pack should create a package tarball");
    await execFile("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(packDirectory, tarball)], { cwd: fixtureDirectory });

    const { stdout } = await execFile(process.execPath, ["check.mjs"], {
      cwd: fixtureDirectory,
      env: {
        ...process.env,
        PILOTDECK_SDK_GATEWAY_URL: server.wsUrl,
        PILOTDECK_SDK_AUTH_TOKEN: server.token,
      },
    });
    const result = JSON.parse(stdout) as { result: { status: string; output?: string } };
    assert.equal(result.result.status, "completed", stdout);
    assert.equal(result.result.output, "SDK empty tool set observed", stdout);
  } finally {
    await server.close();
    local.dispose();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const INSTALLED_CONSUMER = `
import { query, resolveSettings } from "@pilotdeck/sdk";

const resolved = await resolveSettings({
  gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
  authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
});

const run = query({
  prompt: "reply from the installed package",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
  },
});

const events = [];
for await (const event of run) events.push(event.type);
const result = await run.result();
run.close();
console.log(JSON.stringify({
  events,
  result: result.status === "failed" && result.error ? { ...result, error: { code: result.error.code, message: result.error.message } } : result,
  resolved: {
    schemaVersion: resolved.schemaVersion,
    apiKey: resolved.config?.model?.providers?.test?.apiKey,
  },
}));
`;

const INSTALLED_EMBEDDED_CONSUMER = `
import { createEmbeddedQuery } from "@pilotdeck/sdk/embedded";

export async function run(endpoint, token, projectKey) {
  const query = createEmbeddedQuery({
    prompt: "reply from the installed embedded package",
    options: { projectKey, channelKey: "sdk-embedded-package-test", permissionMode: "bypassPermissions" },
    connection: { endpoint, token },
  });
  const events = [];
  for await (const event of query) events.push(event.type);
  const result = await query.result();
  query.close();
  return {
    events,
    result: result.status === "failed" && result.error
      ? { ...result, error: { code: result.error.code, message: result.error.message } }
      : result,
  };
}
`;

const INSTALLED_MCP_CONSUMER = `
import { createPilotDeckMcpServer, query, tool } from "@pilotdeck/sdk";

const tickets = createPilotDeckMcpServer({
  name: "tickets",
  tools: [tool(
    "find_ticket",
    "Find a ticket by id.",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    async ({ id }) => ({ content: [{ type: "text", text: "ticket:" + id }] }),
  )],
});

try {
  const run = query({
    prompt: "Find ticket PDX-123",
    options: {
      gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
      authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
      permissionMode: "bypassPermissions",
      mcpServers: { tickets },
    },
  });
  const events = [];
  for await (const event of run) events.push(event.type);
  const result = await run.result();
  run.close();
  console.log(JSON.stringify({ events, result }));
} finally {
  await tickets.close();
}
`;

const INSTALLED_HOOK_CONSUMER = `
import { query } from "@pilotdeck/sdk";

const run = query({
  prompt: "Run the hook before the model.",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    permissionMode: "bypassPermissions",
    hooks: {
      UserPromptSubmit: [{
        hooks: [() => ({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: "sdk-hook-context",
          },
        })],
      }],
    },
  },
});

try {
  for await (const _event of run) { /* consume */ }
  const result = await run.result();
  console.log(JSON.stringify({
    result: result.status === "failed" && result.error
      ? { ...result, error: { code: result.error.code, message: result.error.message } }
      : result,
  }));
} finally {
  run.close();
}
`;

const INSTALLED_EMPTY_TOOLS_CONSUMER = `
import { query } from "@pilotdeck/sdk";

const run = query({
  prompt: "Reply without tools.",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    permissionMode: "bypassPermissions",
    tools: [],
  },
});

try {
  for await (const _event of run) { /* consume */ }
  console.log(JSON.stringify({ result: await run.result() }));
} finally {
  run.close();
}
`;
