import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { complete, streamModel } from "../../../src/model/streaming/streamModel.js";
import { JsonlInvocationLogSink, type InvocationLogRecord, type ModelInvocationLogSink } from "../../../src/storage/legalDataStorage.js";

const config = parseModelConfig({
  providers: {
    test: {
      protocol: "openai",
      url: "https://example.test/v1",
      apiKey: "test-key",
      retry: { requestMaxRetries: 0, streamMaxRetries: 0 },
      models: { "test-model": {} },
    },
  },
});

const request: CanonicalModelRequest = {
  provider: "test",
  model: "test-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

function createSink(): { staged: InvocationLogRecord[]; appended: InvocationLogRecord[]; sink: ModelInvocationLogSink } {
  const staged: InvocationLogRecord[] = [];
  const appended: InvocationLogRecord[] = [];
  return {
    staged,
    appended,
    sink: {
      stage: (record) => { staged.push(record); },
      append: async (record) => { appended.push(record); },
    },
  };
}

function invocation(sink: ModelInvocationLogSink) {
  return {
    sink,
    context: {
      workspaceId: "workspace",
      sessionId: "session",
      turnId: "turn",
      runId: "run",
      logicalCallId: "call",
      caller: "agent" as const,
    },
  };
}

test("complete stages the raw invocation before sending HTTP", async () => {
  const { staged, appended, sink } = createSink();
  let fetchCalls = 0;
  await complete(request, config, {
    invocation: invocation(sink),
    fetch: async (_input, init) => {
      fetchCalls += 1;
      assert.equal(staged.length, 1);
      assert.equal(staged[0]?.requestBody, String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
    },
  });
  assert.equal(fetchCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.outcome, "success");
  assert.equal(appended[0]?.responseComplete, true);
});

test("a staging failure prevents provider transmission", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    complete(request, config, {
      invocation: invocation({
        stage: () => { throw new Error("storage unavailable"); },
        append: async () => {},
      }),
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("provider must not be called");
      },
    }),
    /storage unavailable/,
  );
  assert.equal(fetchCalls, 0);
});

test("complete records provider HTTP failures without marking the response complete", async () => {
  const { appended, sink } = createSink();
  await assert.rejects(
    complete(request, config, {
      invocation: invocation(sink),
      fetch: async () => new Response(JSON.stringify({ error: { message: "provider rejected" } }), { status: 503 }),
    }),
    /provider rejected|503/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.outcome, "provider_error");
  assert.equal(appended[0]?.httpStatus, 503);
  assert.equal(appended[0]?.responseComplete, false);
});

test("each retry attempt gets its own audit record", async () => {
  const retryConfig = parseModelConfig({
    providers: {
      test: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        retry: { requestMaxRetries: 1, streamMaxRetries: 0, baseDelayMs: 1 },
        models: { "test-model": {} },
      },
    },
  });
  const { staged, appended, sink } = createSink();
  let fetchCalls = 0;
  await complete(request, retryConfig, {
    invocation: invocation(sink),
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw new Error("fetch failed");
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(staged.length, 2);
  assert.deepEqual(staged.map((record) => record.attempt), [1, 2]);
  assert.equal(appended.length, 2);
  assert.equal(appended[0]?.outcome, "transport_error");
  assert.equal(appended[1]?.outcome, "success");
});

test("streamModel records the complete raw response", async () => {
  const { staged, appended, sink } = createSink();
  const events = [];
  for await (const event of streamModel(request, config, {
    invocation: invocation(sink),
    fetch: async (_input, init) => {
      assert.equal(staged.length, 1);
      assert.equal(staged[0]?.requestBody, String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  })) {
    events.push(event);
  }
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "ok"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.responseComplete, true);
  assert.equal(appended[0]?.responseBody?.includes("[DONE]"), true);
});

test("streamModel records an incomplete provider stream before returning its error event", async () => {
  const incompleteConfig = parseModelConfig({
    providers: {
      test: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        retry: { requestMaxRetries: 0, streamMaxRetries: 0, baseDelayMs: 1 },
        models: { "test-model": {} },
      },
    },
  });
  const { appended, sink } = createSink();
  const events = [];
  for await (const event of streamModel(request, incompleteConfig, {
    invocation: invocation(sink),
    fetch: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  })) {
    events.push(event);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "error"));
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.outcome, "incomplete");
  assert.equal(appended[0]?.responseComplete, false);
});

test("streamModel audits an incomplete stream retry as separate attempts", async () => {
  const retryConfig = parseModelConfig({
    providers: {
      test: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        retry: { requestMaxRetries: 0, streamMaxRetries: 1, baseDelayMs: 1 },
        models: { "test-model": {} },
      },
    },
  });
  const { staged, appended, sink } = createSink();
  let fetchCalls = 0;
  const events = [];
  for await (const event of streamModel(request, retryConfig, {
    invocation: invocation(sink),
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  })) {
    events.push(event);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 2);
  assert.deepEqual(staged.map((record) => record.attempt), [1, 2]);
  assert.deepEqual(appended.map((record) => record.outcome), ["incomplete", "success"]);
  assert.equal(appended[0]?.responseComplete, false);
  assert.equal(appended[1]?.responseComplete, true);
  assert.equal(events.some((event) => event.type === "text_delta" && event.text === "ok"), true);
});

test("complete preserves subagent invocation provenance in the audit record", async () => {
  const { appended, sink } = createSink();
  await complete(request, config, {
    invocation: {
      sink,
      context: {
        workspaceId: "workspace",
        sessionId: "parent-session",
        subSessionId: "child-session",
        turnId: "child-turn",
        runId: "child-run",
        logicalCallId: "child-call",
        caller: "subagent",
        parentToolCallId: "parent-tool-call",
      },
    },
    fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "child" } }] }), { status: 200 }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.caller, "subagent");
  assert.equal(appended[0]?.subSessionId, "child-session");
  assert.equal(appended[0]?.parentToolCallId, "parent-tool-call");
  assert.equal(appended[0]?.runId, "child-run");
});

test("invocation audit finalization failures are visible without changing the provider result", async () => {
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const result = await complete(request, config, {
      invocation: invocation({
        stage: () => {},
        append: async () => { throw new Error("audit append failed"); },
      }),
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "ok");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), /failed to persist model invocation audit/);
    assert.match(String(errors[0]?.[0]), /requestLogId=/);
    assert.equal(errors[0]?.some((value) => String(value).includes("audit append failed")), true);
  } finally {
    console.error = originalError;
  }
});

test("JsonlInvocationLogSink persists staged records under Gateway-owned scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-invocation-audit-"));
  try {
    const sink = new JsonlInvocationLogSink({ root });
    const record: InvocationLogRecord = {
      ...invocation(sink).context,
      requestLogId: "request-log",
      requestId: "request",
      attempt: 1,
      provider: "test",
      protocol: "openai",
      model: "test-model",
      stream: false,
      requestBody: "{}",
      responseBody: "{}",
      requestBytes: 2,
      responseBytes: 2,
      outcome: "success",
      responseComplete: true,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
    };
    sink.stage(record);
    await sink.append(record);
    const path = join(root, "workspaces", "workspace", "sessions", "session", "llm", "invocations.jsonl");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
