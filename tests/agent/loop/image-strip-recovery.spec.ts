import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../../src/model/protocol/canonical.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

const modelError: CanonicalModelEvent = {
  type: "error",
  error: {
    provider: "custom",
    model: "text-model",
    protocol: "openai",
    code: "BadRequestError",
    status: 400,
    message: "text-model is not a multimodal model",
    retryable: false,
    recoverableViaImageStrip: true,
  },
};

test("agent loop strips images and retries a rejected multimodal request", async () => {
  const seenRequests: CanonicalModelRequest[] = [];
  const loop = createLoop(async function* (_decision, request) {
    seenRequests.push(request);
    if (seenRequests.length === 1) {
      yield modelError;
      return;
    }
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "recovered" };
    yield { type: "message_end", finishReason: "stop" };
  });

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "image-strip-success",
    turnId: "turn-1",
    messages: imageMessages(),
  })) {
    events.push(event);
  }

  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[0]!.messages[0]!.content[1]!.type, "image");
  const recoveredBlock = seenRequests[1]!.messages[0]!.content[1]!;
  assert.equal(recoveredBlock.type, "text");
  assert.match(recoveredBlock.type === "text" ? recoveredBlock.text : "", /Image removed/);
  assert.ok(events.some((event) => event.type === "turn_continued"));
  assert.ok(!events.some((event) => event.type === "turn_failed"));
});

test("agent loop attempts image-strip recovery only once per failing request", async () => {
  let executeCalls = 0;
  const loop = createLoop(async function* () {
    executeCalls += 1;
    yield modelError;
  });

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "image-strip-failure",
    turnId: "turn-2",
    messages: imageMessages(),
  })) {
    events.push(event);
  }

  assert.equal(executeCalls, 2);
  assert.ok(events.some((event) => event.type === "turn_failed"));
});

function createLoop(
  execute: AgentRouterRuntime["execute"],
): AgentLoop {
  const tokenBudget = new TokenBudgetManager();
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute,
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({
      ...request,
      provider: decision.provider,
      model: decision.model,
    }),
    observeUsage: () => undefined,
  };
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async (input) => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async (input) => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({
      type: "strip_images_and_retry",
      reason: "multimodal-processor-error",
    }),
    captureTurn: async () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "custom",
    model: "text-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };

  return new AgentLoop(config, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: { async executeAll() { return []; } },
    },
    context,
    tokenAccounting: {
      evaluateRequestBudget: async () => tokenBudget.snapshotFromTokens(10, 32_768),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });
}

function imageMessages(): CanonicalMessage[] {
  return [{
    role: "user",
    content: [
      { type: "text", text: "Inspect the screenshot" },
      {
        type: "image",
        source: "base64",
        data: "aW1hZ2U=",
        mimeType: "image/png",
        bytes: 5,
      },
    ],
  }];
}
