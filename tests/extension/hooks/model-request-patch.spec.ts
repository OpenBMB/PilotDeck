import test from "node:test";
import assert from "node:assert/strict";
import { parseHookOutput } from "../../../src/extension/hooks/execution/parseHookOutput.js";
import { HookRuntime } from "../../../src/extension/hooks/execution/HookRuntime.js";

test("parses only the supported model request patch fields", () => {
  const output = parseHookOutput(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreModelRequest",
      modelRequestPatch: {
        provider: "provider",
        model: "model",
        maxOutputTokens: 4096,
        temperature: 0.2,
        metadata: { domain: "legal" },
        messages: [{ role: "user", content: "forbidden" }],
        tools: [],
      },
    },
  }));
  assert.equal(output.type, "sync");
  if (output.type !== "sync") return;
  assert.deepEqual(output.specific?.modelRequestPatch, {
    provider: "provider",
    model: "model",
    maxOutputTokens: 4096,
    temperature: 0.2,
    metadata: { domain: "legal" },
  });
});

test("parses bounded dynamic context controls for hook-driven injection", () => {
  const output = parseHookOutput(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      dynamicContext: [
        { id: "goal", content: "Goal checkpoint 3/7", priority: "critical", ttlMs: 2_000 },
        { id: "invalid", content: "ignored priority", priority: "urgent", ttlMs: 999_999_999 },
        { id: "blank", content: "   " },
      ],
    },
  }));

  assert.equal(output.type, "sync");
  if (output.type !== "sync") return;
  assert.deepEqual(output.specific?.dynamicContext, [
    { id: "goal", content: "Goal checkpoint 3/7", priority: "critical", ttlMs: 2_000 },
    { id: "invalid", content: "ignored priority", priority: undefined, ttlMs: 86_400_000 },
  ]);
});

test("parses only bounded convergence preview fields", () => {
  const output = parseHookOutput(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      convergencePreview: {
        schemaVersion: 1,
        scope: "synthetic-validation",
        phase: "matrices",
        stateHash: "state-b",
        blockingCode: "matrix_pending",
        remainingCount: 4,
        progressOrdinal: 7,
        repairOrdinal: 1,
        repairPreparationOrdinal: 1,
        handoffOrdinal: 3,
        nextBatch: { privateDomainPayload: true },
      },
    },
  }));

  assert.equal(output.type, "sync");
  if (output.type !== "sync") return;
  assert.deepEqual(output.specific?.convergencePreview, {
    schemaVersion: 1,
    scope: "synthetic-validation",
    phase: "matrices",
    stateHash: "state-b",
    blockingCode: "matrix_pending",
    remainingCount: 4,
    progressOrdinal: 7,
    repairOrdinal: 1,
    repairPreparationOrdinal: 1,
    handoffOrdinal: 3,
  });
});

test("HookRuntime accepts convergence previews only from PostToolUse", async () => {
  const convergencePreview = {
    schemaVersion: 1 as const,
    scope: "synthetic-validation",
    phase: "matrices",
    stateHash: "state-b",
    blockingCode: "matrix_pending",
    remainingCount: 4,
    progressOrdinal: 7,
    handoffOrdinal: 3,
  };
  const runtime = new HookRuntime({
    PreModelRequest: [{ hooks: [{ type: "command", command: "ignored" }] }],
    PostToolUse: [{ hooks: [{ type: "command", command: "ignored" }] }],
  }, {
    async execute(options: { hookInput: { hookEventName: string } }) {
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        outcome: "success" as const,
        output: {
          type: "sync" as const,
          specific: {
            hookEventName: options.hookInput.hookEventName,
            convergencePreview,
          },
        },
      };
    },
  } as never);
  const baseInput = { sessionId: "session-1", transcriptPath: "", cwd: process.cwd() };

  const preModel = await runtime.run({
    event: "PreModelRequest",
    hookInput: { ...baseInput, hookEventName: "PreModelRequest" },
    cwd: process.cwd(),
  });
  const postTool = await runtime.run({
    event: "PostToolUse",
    hookInput: { ...baseInput, hookEventName: "PostToolUse", toolName: "write_file" },
    cwd: process.cwd(),
  });

  assert.equal(preModel.effects.some((effect) => effect.type === "convergence_preview"), false);
  assert.deepEqual(
    postTool.effects.filter((effect) => effect.type === "convergence_preview"),
    [{ type: "convergence_preview", report: convergencePreview }],
  );
});
