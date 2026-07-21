import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import {
  type CanonicalMessage,
  type CanonicalModelRequest,
  type ModelRuntime,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";

test("local gateway applies project hook context and enforces artifact correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-runtime-controls-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const pluginRoot = join(projectRoot, ".pilotdeck", "plugins", "runtime-qa");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG);
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "runtime-qa",
    version: "1.0.0",
    hooks: "hooks/hooks.json",
  }));
  await writeFile(join(pluginRoot, "hooks", "hooks.json"), JSON.stringify({
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
    PreModelRequest: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
  }));
  await writeFile(join(pluginRoot, "hook.mjs"), HOOK_SCRIPT);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome },
    __testModelFactory: () => fakeModelRuntime(requests, projectRoot),
  });
  try {
    const events = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "qa-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Create the required workbook.",
      canPrompt: false,
    })) {
      events.push(event);
    }

    const agentRequests = requests.filter((request) => !messageText(request.messages).includes("Summarize the conversation so far"));
    assert.equal(agentRequests.length, 2);
    assert.equal(agentRequests[0]?.maxOutputTokens, 1_234);
    assert.equal(agentRequests[0]?.metadata?.hookQa, true);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /project hook checkpoint/);
    assert.doesNotMatch(messageText(agentRequests[1]?.messages ?? []), /project hook checkpoint/);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /Artifact validation failed/);
    assert.equal(events.some((event) => event.type === "turn_completed" && event.finishReason === "completed"), true);
    await access(join(projectRoot, "final.xlsx"));
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function fakeModelRuntime(requests: CanonicalModelRequest[], projectRoot: string): ModelRuntime {
  return {
    async *stream(request) {
      requests.push(request);
      const requestText = messageText(request.messages);
      if (requestText.includes("Artifact validation failed")) {
        await writeFile(join(projectRoot, "final.xlsx"), "deterministic workbook fixture");
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: requestText.includes("Artifact validation failed") ? "Corrected completion." : "Initial completion." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: '{"title":"QA session"}' }], finishReason: "stop" };
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

function messageText(messages: readonly CanonicalMessage[]): string {
  return messages.flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

const TEST_CONFIG = `schemaVersion: 1
agent:
  model: test/test-model
  maxOutputTokens: 4096
model:
  providers:
    test:
      protocol: openai
      url: https://example.invalid
      apiKey: test-key
      models:
        test-model:
          capabilities:
            maxContextTokens: 32768
            maxOutputTokens: 8192
router:
  enabled: false
  scenarios:
    default: test/test-model
memory:
  enabled: false
`;

const HOOK_SCRIPT = `let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
let output = { hookSpecificOutput: { hookEventName: input.hookEventName } };
if (input.hookEventName === "UserPromptSubmit" && input.internal !== true) {
  output.hookSpecificOutput.dynamicContext = [{
    id: "checkpoint",
    content: "project hook checkpoint",
    priority: "critical",
    ttlMs: 60000
  }];
  output.hookSpecificOutput.artifactContracts = [{
    id: "final-workbook",
    path: "final.xlsx",
    required: true,
    expectedExtensions: [".xlsx"],
    validatorIds: ["core:file-exists"]
  }];
}
if (input.hookEventName === "PreModelRequest") {
  output.hookSpecificOutput.modelRequestPatch = {
    maxOutputTokens: 1234,
    metadata: { hookQa: true }
  };
}
console.log(JSON.stringify(output));
`;
