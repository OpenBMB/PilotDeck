import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { GatewayEvent } from "../../src/gateway/index.js";
import {
  createModelRuntime,
  type CanonicalModelEvent,
  type CanonicalModelRequest,
} from "../../src/model/index.js";

const CONFIG = `
schemaVersion: 1
agent:
  model: test/model
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models:
        model:
          multimodal:
            input: [text, image]
extension:
  builtinPluginsEnabled:
    windows-skills: false
    browser-use: false
    funasr: false
telemetry:
  enabled: false
`;

async function* toolCall(id: string, name: string, input: unknown): AsyncIterable<CanonicalModelEvent> {
  yield { type: "tool_call_start", id, name };
  yield { type: "tool_call_delta", id, delta: JSON.stringify(input) };
  yield { type: "tool_call_end", toolCall: { id, name, input } };
  yield { type: "message_end", finishReason: "tool_call" };
}

test("managed background agents receive Computer Use observations and lose its tools after disable", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "pilotdeck-background-cua-"));
  const managedPath = join(home, "managed-mcp.json");
  const previousManagedPath = process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG;
  let local: ReturnType<typeof createLocalGateway> | undefined;
  let disabled = false;
  let parentCalls = 0;
  const childRequests: CanonicalModelRequest[] = [];
  const parentRequests: CanonicalModelRequest[] = [];
  const disabledRequests: CanonicalModelRequest[] = [];
  try {
    await mkdir(join(home, "skills"));
    await writeFile(join(home, "pilotdeck.yaml"), CONFIG);
    await writeFile(managedPath, JSON.stringify({ mcpServers: {
      "pilotdeck-computer-use": {
        command: process.execPath,
        args: [resolve("tests/mcp/fixtures/roundtrip-server.mjs")],
        concurrencySafe: false,
      },
    } }));
    process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG = managedPath;
    local = createLocalGateway({
      pilotHome: home,
      projectRoot: home,
      builtinSkillsRoot: join(home, "skills"),
      permissionMode: "bypassPermissions",
      env: {
        ...process.env,
        PILOT_HOME: home,
        PILOTDECK_CONFIG_PATH: join(home, "pilotdeck.yaml"),
        PILOT_AGENT_MODEL: undefined,
      },
      __testModelFactory(snapshot) {
        return {
          ...createModelRuntime(snapshot.config.model),
          async *stream(request): AsyncIterable<CanonicalModelEvent> {
            yield { type: "message_start", role: "assistant" };
            if (disabled) {
              disabledRequests.push(request);
              yield { type: "text_delta", text: "Computer Use is disabled." };
            } else if (request.metadata?.subagentId) {
              childRequests.push(request);
              if (childRequests.length === 1) {
                yield* toolCall("observe-window", "mcp__pilotdeck-computer-use__observe", {});
                return;
              }
              yield { type: "text_delta", text: "Scope: observe desktop\nResult: CHILD-CUA-REPORT\nKey files: none\nFiles changed: none\nIssues: none" };
            } else {
              parentRequests.push(request);
              if (parentCalls++ === 0) {
                yield* toolCall("delegate-observation", "agent", {
                  description: "Observe the desktop",
                  prompt: "Observe the window and report its contents.",
                  run_in_background: true,
                });
                return;
              }
              yield { type: "text_delta", text: "Observation received." };
            }
            yield { type: "message_end", finishReason: "stop" };
          },
          async complete() {
            return { role: "assistant" as const, content: [{ type: "text" as const, text: '{"title":"Desktop observation"}' }], finishReason: "stop" as const };
          },
        };
      },
    });
    const submit = async () => {
      const events: GatewayEvent[] = [];
      for await (const event of local!.gateway.submitTurn({
        projectKey: home,
        sessionKey: "web:background-computer-use",
        channelKey: "web",
        message: disabled ? "Check available tools." : "Delegate a desktop observation.",
        mode: "bypassPermissions",
        basePermissionMode: "bypassPermissions",
      })) events.push(event);
      assert.deepEqual(events.filter(event => event.type === "error"), []);
      assert.ok(events.some(event => event.type === "turn_completed" && event.finishReason === "completed"));
      return events;
    };

    await submit();
    assert.equal(childRequests.length, 2, "the background child must execute the MCP observation");
    assert.ok(childRequests[0]!.tools?.some(tool => tool.name === "mcp__pilotdeck-computer-use__observe"));
    assert.match(childRequests[0]!.systemPrompt ?? "", /Observe the window before acting/);
    assert.match(JSON.stringify(childRequests[1]!.messages), /fixture:4:0/);
    assert.match(JSON.stringify(childRequests[1]!.messages), /image\/png/);
    const reports = parentRequests.flatMap(request => request.messages.filter(message =>
      message.metadata?.purpose === "background_subagent_result"));
    assert.ok(reports.some(message => JSON.stringify(message).includes("CHILD-CUA-REPORT")),
      "the parent must receive the background result before completing");

    disabled = true;
    await writeFile(managedPath, JSON.stringify({ mcpServers: {} }));
    await submit();
    assert.equal(disabledRequests.length, 1);
    assert.equal(disabledRequests[0]!.tools?.some(tool => tool.name.startsWith("mcp__pilotdeck-computer-use__")), false);
    assert.doesNotMatch(disabledRequests[0]!.systemPrompt ?? "", /Observe the window before acting/);
  } finally {
    local?.dispose();
    if (previousManagedPath === undefined) delete process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG;
    else process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG = previousManagedPath;
    await rm(home, { recursive: true, force: true });
  }
});
