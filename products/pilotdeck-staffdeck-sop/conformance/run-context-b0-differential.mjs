#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const cases = [
  { name: "system-prompt-canonical-order" },
  {
    name: "system-prompt-contribution-order-with-custom-and-instructions",
    customSystemPrompt: "Custom approval system contract.",
    appendSystemPrompt: "Append the approval evidence rules.",
    includeInstructions: true,
  },
  {
    name: "tool-pairing-and-media-preserved",
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the approval screenshot." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "lookup-1", name: "read_file", input: { path: "approval.md" } }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "lookup-1", content: [{ type: "text", text: "approval evidence" }] }] },
      { role: "user", content: [{ type: "image", source: "base64", data: "c2NyZWVuc2hvdA==", mimeType: "image/png", bytes: 10 }, { type: "text", text: "Continue." }] },
    ],
  },
  {
    name: "max-message-projection-and-cache-plan",
    protocol: "anthropic",
    supportsPromptCache: true,
    maxMessages: 3,
    messages: [
      { role: "user", content: [{ type: "text", text: "First request." }] },
      { role: "assistant", content: [{ type: "text", text: "First answer." }] },
      { role: "user", content: [{ type: "text", text: "Second request." }] },
      { role: "assistant", content: [{ type: "text", text: "Second answer." }] },
      { role: "user", content: [{ type: "text", text: "Final request." }] },
    ],
  },
];

const normalized = [];
for (const testCase of cases) {
  const expected = await runCase(testCase, b0Root);
  const actual = await runCase(testCase, candidateRoot);
  assert.deepEqual(actual.prepared, expected.prepared, `Context differential mismatch in ${testCase.name}`);
  assert.deepEqual(actual.prepared.messages, expected.prepared.messages, `Context message order mismatch in ${testCase.name}`);
  normalized.push({ name: testCase.name, result: actual });
}

const candidateFeature = await runCandidateUserMessageAndReplay(candidateRoot);
assert.equal(candidateFeature.userMessageContextCount, 1);
assert.equal(candidateFeature.restoredInstructionEvents, 0);

const altered = structuredClone(normalized[0].result.prepared);
altered.systemPromptParts.reverse();
assert.notDeepEqual(
  altered,
  normalized[0].result.prepared,
  "comparator sensitivity fixture did not detect changed canonical contribution order",
);

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  cases: normalized.map(({ name }) => name),
  candidateFeature: {
    userMessageContextCount: candidateFeature.userMessageContextCount,
    originalInstructionEvents: candidateFeature.originalInstructionEvents,
    restoredInstructionEvents: candidateFeature.restoredInstructionEvents,
  },
  compared: normalized.length,
}, null, 2) + "\n");

async function runCase(testCase, root) {
  const [{ DefaultContextRuntime }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/src/context/DefaultContextRuntime.js")).href),
  ]);

  const runtime = new DefaultContextRuntime({
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    extension: extensionFixture(),
    ...(testCase.includeExtensionsWithCustomSystemPrompt === undefined
      ? {}
      : { includeExtensionsWithCustomSystemPrompt: testCase.includeExtensionsWithCustomSystemPrompt }),
    ...(testCase.runtimeContextSurface ? { runtimeContextSurface: testCase.runtimeContextSurface } : {}),
    ...(testCase.includeInstructions ? {
      instructionDiscovery: {
        async discover() {
          return [{
            scope: "project",
            path: "/workspace/PILOTDECK.md",
            content: "Follow the approval policy.",
          }];
        },
      },
    } : {}),
    memoryResolver: {
      async retrieve() {
        return { systemContext: "Remembered approval constraint.", diagnostics: [] };
      },
      async captureTurn() {},
    },
  });

  const input = {
    sessionId: "context-diff-session",
    turnId: "context-diff-turn-1",
    stepId: 1,
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    runMode: "agent",
    additionalWorkingDirectories: ["/workspace/shared"],
    runtimeContextSurface: testCase.runtimeContextSurface,
    messages: testCase.messages ?? [
      { role: "user", content: [{ type: "text", text: "Read the approval policy." }] },
      { role: "assistant", content: [{ type: "text", text: "I will inspect the evidence." }] },
      { role: "user", content: [{ type: "text", text: "Continue with the same request." }] },
    ],
    tools: [
      { name: "knowledge_query", description: "Query evidence.", inputSchema: { type: "object" } },
      { name: "read_file", description: "Read a file.", inputSchema: { type: "object" } },
    ],
    ...(testCase.customSystemPrompt ? { customSystemPrompt: testCase.customSystemPrompt } : {}),
    ...(testCase.appendSystemPrompt ? { appendSystemPrompt: testCase.appendSystemPrompt } : {}),
    ...(testCase.maxMessages !== undefined ? { maxMessages: testCase.maxMessages } : {}),
    ...(testCase.protocol ? { protocol: testCase.protocol } : {}),
    ...(testCase.supportsPromptCache !== undefined ? { supportsPromptCache: testCase.supportsPromptCache } : {}),
  };

  const prepared = normalizePrepared(await runtime.prepareForModel(input));

  return {
    prepared,
  };
}

async function runCandidateUserMessageAndReplay(root) {
  const [{ DefaultContextRuntime }, { createDurableContextRuntime }, { AgentSessionEventRecorder }, { InMemoryTranscriptWriter }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/src/context/DefaultContextRuntime.js")).href),
    import(pathToFileURL(join(root, "dist/src/agent/modules/context/durableContextRuntime.js")).href),
    import(pathToFileURL(join(root, "dist/src/agent/session/AgentSessionEventRecorder.js")).href),
    import(pathToFileURL(join(root, "dist/src/session/transcript/InMemoryTranscriptWriter.js")).href),
  ]);
  const options = {
    now: () => new Date("2026-09-19T00:00:00.000Z"),
    extension: extensionFixture(),
    runtimeContextSurface: "user_message",
    instructionDiscovery: { discover: async () => [{
      scope: "project",
      path: "/workspace/PILOTDECK.md",
      content: "Follow the approval policy.",
    }] },
    memoryResolver: {
      async retrieve() {
        return { systemContext: "Remembered approval constraint.", diagnostics: [] };
      },
      async captureTurn() {},
    },
  };
  const input = {
    sessionId: "context-replay-session",
    turnId: "context-replay-turn-1",
    cwd: "/workspace",
    provider: "provider-a",
    model: "model-a",
    permissionMode: "default",
    runMode: "agent",
    additionalWorkingDirectories: [],
    runtimeContextSurface: "user_message",
    messages: [{ role: "user", content: [{ type: "text", text: "Continue approval." }] }],
    tools: [],
  };
  const runtime = new DefaultContextRuntime(options);
  const transcript = new InMemoryTranscriptWriter();
  const recorder = new AgentSessionEventRecorder(transcript, { uuid: () => "context-replay-id" });
  await recorder.startTurn(input.sessionId, input.turnId);
  const durable = createDurableContextRuntime(runtime, recorder);
  const first = await durable.prepareForModel(input);
  const originalInstructionEvents = transcript.entries.filter((entry) => entry.type === "agent_instructions").length;

  const restoredTranscript = new InMemoryTranscriptWriter();
  const restoredRecorder = new AgentSessionEventRecorder(restoredTranscript, {
    restoredEntries: transcript.entries,
    uuid: () => "context-replay-restored-id",
  });
  await restoredRecorder.startTurn(input.sessionId, "context-replay-turn-2");
  const restored = createDurableContextRuntime(new DefaultContextRuntime(options), restoredRecorder);
  const second = await restored.prepareForModel({ ...input, turnId: "context-replay-turn-2" });
  const restoredInstructionEvents = restoredTranscript.entries.filter((entry) => entry.type === "agent_instructions").length;

  return {
    userMessageContextCount: first.messages.filter((message) => message.metadata?.purpose === "runtime_context").length,
    originalInstructionEvents,
    restoredInstructionEvents,
    restoredContextCount: second.messages.filter((message) => message.metadata?.purpose === "runtime_context").length,
  };
}

function extensionFixture() {
  return {
    listCommands: () => [{ name: "approve", description: "Review approval evidence." }],
    listSkills: () => [{ name: "approval-guide", description: "Approval guide", path: "/workspace/SKILL.md" }],
    listMcpInstructions: () => [{ serverName: "knowledge", instructions: "Use cited evidence." }],
  };
}

function normalizePrepared(value) {
  return {
    messages: value.messages,
    systemPrompt: value.systemPrompt,
    systemPromptParts: value.systemPromptParts,
    tools: value.tools,
    diagnostics: value.diagnostics,
    boundaries: value.boundaries,
    cacheBreakpoints: value.cacheBreakpoints,
    cachePlan: value.cachePlan,
  };
}
