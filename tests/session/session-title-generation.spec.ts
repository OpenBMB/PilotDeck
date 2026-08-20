import assert from "node:assert/strict";
import test from "node:test";

import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { CanonicalMessage, CanonicalModelRequest, CanonicalModelResponse } from "../../src/model/index.js";
import { SessionMetadataStore } from "../../src/session/metadata/SessionMetadataStore.js";
import {
  createSessionTitleGenerator,
  normalizeSessionTitleInput,
  type SessionTitleGenerator,
} from "../../src/session/title/SessionTitleGenerator.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

test("session title generator uses the main model, normalized input, and current output budget", async () => {
  let capturedRequest: CanonicalModelRequest | undefined;
  const generator = createSessionTitleGenerator({
    agentModel: { id: "main", provider: "openai", model: "gpt-main" },
    modelRuntime: {
      async complete(request) {
        capturedRequest = request;
        return textResponse("```json\n{\"title\":\"Debug failing CI tests\"}\n```");
      },
    },
    timeoutMs: 10_000,
  });

  const title = await generator({
    text: "  CI is failing\n after the dependency update.  ",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "Debug failing CI tests");
  assert.equal(capturedRequest?.provider, "openai");
  assert.equal(capturedRequest?.model, "gpt-main");
  assert.equal(capturedRequest?.maxOutputTokens, 4096);
  assert.equal(capturedRequest?.temperature, 0);
  assert.equal(capturedRequest?.messages[0]?.content[0]?.type, "text");
  assert.equal(
    capturedRequest?.messages[0]?.content[0]?.type === "text"
      ? capturedRequest.messages[0].content[0].text
      : undefined,
    "CI is failing after the dependency update.",
  );
  assert.equal(normalizeSessionTitleInput("x".repeat(1300))?.length, 1200);
});

test("TurnRunner waits for a slow title after the agent loop completes", async () => {
  const title = deferred<string | null>();
  const started = deferred<void>();
  const { runner, metadataStore, transcript } = createRunner(async () => {
    started.resolve();
    return title.promise;
  });

  let completed = false;
  const completion = runTurn(runner, turnOptions("t1", [], "Fix the login flow"))
    .then((result) => {
      completed = true;
      return result;
    });
  await started.promise;
  await Promise.resolve();
  assert.equal(completed, false);

  title.resolve("Fix login flow");
  const result = await completion;

  assert.equal(result.result.type, "success");
  assert.equal(metadataStore.getSnapshot().aiTitle, "Fix login flow");
  const metadataEntries = transcript.entries.filter((entry) => entry.type === "session_metadata");
  assert.equal(metadataEntries.length, 1);
  assert.equal(metadataEntries[0]?.turnId, "t1");
});

test("TurnRunner retries missing titles with all accumulated user messages", async () => {
  const inputs: string[] = [];
  const { runner, metadataStore } = createRunner(async ({ text }) => {
    inputs.push(text);
    return inputs.length === 1 ? null : "Combined session goal";
  });

  await runTurn(runner, turnOptions("t1", [], "First request"));
  await runTurn(runner, turnOptions("t2", [userMessage("First request")], "Second request"));

  assert.deepEqual(inputs, ["First request", "First request\nSecond request"]);
  assert.equal(metadataStore.getSnapshot().aiTitle, "Combined session goal");
});

test("a manual title set while generation is in flight is never overwritten", async () => {
  const generated = deferred<string | null>();
  const started = deferred<void>();
  const { runner, metadataStore } = createRunner(async () => {
    started.resolve();
    return generated.promise;
  });

  const completion = runTurn(runner, turnOptions("t1", [], "Investigate the build"));
  await started.promise;
  await metadataStore.saveTitle("Manual build investigation", "manual");
  generated.resolve("AI build title");
  await completion;

  assert.equal(metadataStore.getSnapshot().title, "Manual build investigation");
  assert.equal(metadataStore.getSnapshot().aiTitle, undefined);
});

test("title generation failures do not fail the main turn", async () => {
  const { runner, metadataStore } = createRunner(async () => {
    throw new Error("title provider unavailable");
  });

  const result = await runTurn(runner, turnOptions("t1", [], "Keep the turn successful"));

  assert.equal(result.result.type, "success");
  assert.equal(metadataStore.getSnapshot().aiTitle, undefined);
});

test("existing titles and disabled auto-title runners do not call the generator", async () => {
  for (const setup of ["existing", "disabled"] as const) {
    let calls = 0;
    const { runner, metadataStore } = createRunner(async () => {
      calls += 1;
      return "Unexpected title";
    }, setup !== "disabled");
    if (setup === "existing") {
      await metadataStore.saveAiTitle("Existing title", "setup");
    }

    await runTurn(runner, turnOptions("t1", [], "Do not generate"));
    assert.equal(calls, 0, setup);
  }
});

function createRunner(generator: SessionTitleGenerator, autoGenerateSessionTitle = true) {
  const transcript = new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({ transcript, sessionId: "s1" });
  const runner = new TurnRunner(
    createLoop(),
    transcript,
    undefined,
    () => new Date("2026-07-14T00:00:00.000Z"),
    undefined,
    { cwd: "/tmp/project", transcriptPath: "", collectFileArtifacts: false },
    {
      metadataStore,
      sessionTitleGenerator: generator,
      autoGenerateSessionTitle,
    },
  );
  return { runner, metadataStore, transcript };
}

function createLoop(): AgentLoop {
  return {
    async *run(input: AgentLoopInput): AsyncGenerator<never, AgentLoopRunResult, unknown> {
      return {
        result: {
          type: "success",
          sessionId: input.sessionId,
          turnId: input.turnId,
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-07-14T00:00:00.000Z",
          completedAt: "2026-07-14T00:00:01.000Z",
        },
        messages: input.messages,
      };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
}

async function runTurn(
  runner: TurnRunner,
  options: Parameters<TurnRunner["run"]>[0],
): Promise<AgentLoopRunResult> {
  const iterator = runner.run(options);
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
  }
}

function turnOptions(turnId: string, messages: CanonicalMessage[], text: string) {
  return {
    sessionId: "s1",
    turnId,
    messages,
    input: { type: "text" as const, text },
  };
}

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function textResponse(text: string): CanonicalModelResponse {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    finishReason: "stop",
    usage: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
