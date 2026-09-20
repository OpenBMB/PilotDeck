import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionContextRuntimeBundle } from "../../src/cli/SessionContextRuntimeBundle.js";
import {
  createNodeInstructionStoragePort,
  DefaultContextRuntime,
  TokenAccountingRuntime,
  type ExtensionResolver,
} from "../../src/context/index.js";
import { NullLifecycleRuntime } from "../../src/lifecycle/index.js";
import type { RouterRuntime } from "../../src/router/index.js";

test("session context bundle installs frozen prompt contributions in a scope-owned registry", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "pilotdeck-session-context-"));
  const pilotHome = join(projectRoot, ".pilotdeck-home");
  try {
    const result = new SessionContextRuntimeBundle({
      sessionKey: "session-context",
      projectKey: projectRoot,
      projectRoot,
      pilotHome,
      toolResultsDir: join(projectRoot, ".pilotdeck", "tool-results"),
      extension: extensionWithPrompt(),
      instructionStorage: createNodeInstructionStoragePort(),
      toolResultSpill: {
        async writeTextIfAbsent() { return { created: true }; },
        async copyFileIfAbsent() { return { created: true }; },
      },
      model: { async *stream() {} } satisfies Pick<RouterRuntime, "stream">,
      tokenAccounting: new TokenAccountingRuntime({ modelConfig: { providers: {} } }),
      lifecycle: new NullLifecycleRuntime(),
      modelProvider: "test-provider",
      modelName: "test-model",
      maxContextTokens: 8_192,
      now: () => new Date("2026-09-09T00:00:00.000Z"),
    }).compose();

    assert.ok(result.context instanceof DefaultContextRuntime);
    const prepared = await result.context.prepareForModel({
      sessionId: "session-context",
      turnId: "turn-1",
      cwd: projectRoot,
      provider: "test-provider",
      model: "test-model",
      permissionMode: "default",
      runMode: "agent",
      additionalWorkingDirectories: [],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
    });

    assert.match(prepared.systemPrompt ?? "", /Follow the frozen extension rule\./);
    assert.equal(result.promptContributions.owned, true);
    assert.equal(result.promptContributions.registry.name, "agent:session-context");
    result.promptContributions.registry.dispose();
    assert.equal(result.promptContributions.registry.state, "disposed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("session context bundle rolls back a partially registered frozen extension generation", () => {
  assert.throws(
    () => new SessionContextRuntimeBundle({
      sessionKey: "session-context-failure",
      projectKey: "/workspace",
      projectRoot: "/workspace",
      pilotHome: "/pilot-home",
      toolResultsDir: "/workspace/.pilotdeck/tool-results",
      extension: {
        ...extensionWithPrompt(),
        listPromptContributions: () => [
          { name: "duplicate", content: "first" },
          { name: "duplicate", content: "second" },
        ],
      },
      instructionStorage: createNodeInstructionStoragePort(),
      toolResultSpill: {
        async writeTextIfAbsent() { return { created: true }; },
        async copyFileIfAbsent() { return { created: true }; },
      },
      model: { async *stream() {} } satisfies Pick<RouterRuntime, "stream">,
      tokenAccounting: new TokenAccountingRuntime({ modelConfig: { providers: {} } }),
      lifecycle: new NullLifecycleRuntime(),
      modelProvider: "test-provider",
      modelName: "test-model",
      maxContextTokens: 8_192,
      now: () => new Date("2026-09-09T00:00:00.000Z"),
    }).compose(),
    /already registered/,
  );
});

test("session context bundle observes the native automatic-compaction trigger without changing its input", async () => {
  const observations: Array<{ input: unknown; snapshot: unknown; decision: unknown }> = [];
  const result = new SessionContextRuntimeBundle({
    sessionKey: "observed-compaction-session",
    projectKey: "/workspace",
    projectRoot: "/workspace",
    pilotHome: "/pilot-home",
    toolResultsDir: "/workspace/.pilotdeck/tool-results",
    extension: extensionWithPrompt(),
    instructionStorage: createNodeInstructionStoragePort(),
    toolResultSpill: {
      async writeTextIfAbsent() { return { created: true }; },
      async copyFileIfAbsent() { return { created: true }; },
    },
    model: {
      async *stream() {
        yield { type: "message_start", role: "assistant" as const };
        yield { type: "text_delta", text: "compacted history" };
        yield { type: "message_end", finishReason: "stop" as const };
      },
    } satisfies Pick<RouterRuntime, "stream">,
    tokenAccounting: new TokenAccountingRuntime({ modelConfig: { providers: {} } }),
    lifecycle: new NullLifecycleRuntime(),
    modelProvider: "test-provider",
    modelName: "test-model",
    maxContextTokens: 10,
    now: () => new Date("2026-09-09T00:00:00.000Z"),
    testOnAutomaticCompactionTrigger: (observation) => observations.push({
      input: observation.input,
      snapshot: observation.snapshot,
      decision: observation.decision,
    }),
  }).compose();
  const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "history ".repeat(100) }] }];

  const compact = await result.context.tryAutoCompact({
    sessionId: "observed-compaction-session",
    turnId: "observed-compaction-turn",
    messages,
    maxContextTokens: 10,
  });

  assert.equal(compact.type, "compacted");
  assert.equal(observations.length, 1);
  assert.deepEqual((observations[0]?.input as { messages?: unknown }).messages, messages);
  assert.equal((observations[0]?.snapshot as { maxContextTokens?: unknown }).maxContextTokens, 10);
  assert.equal((observations[0]?.decision as { type?: unknown }).type, "trigger");
});

function extensionWithPrompt(): ExtensionResolver {
  return {
    listCommands: () => [],
    listSkills: () => [],
    listMcpInstructions: () => [],
    listPromptContributions: () => [{
      name: "frozen-rule",
      content: "Follow the frozen extension rule.",
    }],
  };
}
