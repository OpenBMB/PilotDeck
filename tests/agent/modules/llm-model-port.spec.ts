import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostModelInvokerPort,
  createRouterModelInvokerPort,
} from "../../../src/agent/modules/llm/index.js";
import type { AgentRouterRuntime } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { ModelProviderError, type CanonicalModelRequest } from "../../../src/model/index.js";

const request = {
  provider: "provider-a",
  model: "model-a",
  messages: [],
  tools: [],
} as unknown as CanonicalModelRequest;

const context = {
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
  operationId: "operation-1",
  idempotencyKey: "stable-1",
  operationDeadline: "2026-09-09T00:00:30.000Z",
  metadata: { source: "test" },
  abortSignal: new AbortController().signal,
};

test("native model provider adapts Router decisions and canonical events", async () => {
  const calls: string[] = [];
  const router = {
    async decide() {
      calls.push("decide");
      return {
        provider: "provider-b",
        model: "model-b",
        scenarioType: "default",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "default",
        mutations: {},
      };
    },
    async *execute() {
      calls.push("execute");
      yield { type: "message_start", role: "assistant" } as const;
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  } as unknown as AgentRouterRuntime;
  const port = createRouterModelInvokerPort(router);

  const prepared = await port.prepare({ request, context });
  const events = [];
  for await (const event of port.stream({ prepared, context })) events.push(event);

  assert.equal(prepared.provider, "provider-b");
  assert.equal(prepared.model, "model-b");
  assert.deepEqual(calls, ["decide", "execute"]);
  assert.equal(events.length, 2);
});

test("native Router adapter freezes the materialized request before provider retry", async () => {
  const materializedRequest = {
    provider: "provider-b",
    model: "model-b",
    messages: [{ role: "user", content: [{ type: "text", text: "before" }] }],
    tools: [{ name: "tool", description: "v1", inputSchema: { type: "object" } }],
    outputSchema: {
      name: "result",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    },
    cachePlan: {
      system: true,
      tools: true,
      messages: [0],
      fingerprint: "fp-v1",
      generation: 1,
    },
  } as unknown as CanonicalModelRequest;
  const router = {
    async decide() {
      return {
        provider: "provider-b",
        model: "model-b",
        scenarioType: "default",
        isSubagent: false,
        orchestrating: false,
        resolvedFrom: "default",
        mutations: {},
      };
    },
    materializeRequest: () => materializedRequest,
    async *execute() {
      yield { type: "message_end", finishReason: "stop" } as const;
    },
  } as unknown as AgentRouterRuntime;
  const port = createRouterModelInvokerPort(router);

  const prepared = await port.prepare({ request, context });
  assert.notEqual(prepared.request, materializedRequest);
  assert.equal(Object.isFrozen(prepared.request), true);
  assert.equal(Object.isFrozen(prepared.request.messages), true);
  assert.equal(Object.isFrozen(prepared.request.tools), true);
  assert.equal(Object.isFrozen(prepared.request.outputSchema), true);
  assert.equal(Object.isFrozen(prepared.request.outputSchema?.schema), true);
  assert.equal(Object.isFrozen(prepared.request.cachePlan), true);

  materializedRequest.messages[0]!.content[0] = { type: "text", text: "after" };
  materializedRequest.tools![0]!.description = "v2";
  materializedRequest.cachePlan!.fingerprint = "fp-v2";

  assert.equal(prepared.request.messages[0]!.content[0]!.type, "text");
  assert.equal((prepared.request.messages[0]!.content[0] as { text: string }).text, "before");
  assert.equal(prepared.request.tools?.[0]?.description, "v1");
  assert.equal(prepared.request.cachePlan?.fingerprint, "fp-v1");
});

test("host model consumer maps canonical input and strips AbortSignal", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const port = createHostModelInvokerPort(async (moduleCall) => {
    calls.push(moduleCall as unknown as Record<string, unknown>);
    return {
      kind: "response",
      messageId: "response-1",
      inReplyTo: "call-1",
      ok: true,
      payload: { events: [{ type: "message_end", finishReason: "stop" }] },
    };
  }, { uuid: () => "fixed" });

  const prepared = await port.prepare({ request, context });
  const events = [];
  for await (const event of port.stream({ prepared, context })) events.push(event);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.module, "model");
  assert.equal(calls[0]?.runId, "run-1");
  assert.equal(calls[0]?.operationId, "operation-1");
  assert.equal(calls[0]?.requestId, "model-fixed");
  assert.equal(calls[0]?.idempotencyKey, "stable-1");
  const payload = calls[0]?.payload as Record<string, unknown>;
  assert.deepEqual(payload.request, request);
  assert.notEqual(payload.request, request);
  assert.equal("abortSignal" in (payload.context as Record<string, unknown>), false);
  assert.equal(events.length, 1);
});

test("host model consumer uses an advertised prepare call and keeps host routing state opaque", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const payload = moduleCall.payload as Record<string, unknown>;
    calls.push({
      requestId: moduleCall.requestId,
      operation: payload.operation,
      preparationId: payload.preparationId,
      payload,
    });
    if (payload.operation === "prepare") {
      return {
        kind: "response" as const,
        messageId: "prepared-1",
        inReplyTo: "call-prepare",
        ok: true,
        payload: {
          prepared: {
            request: { ...request, provider: "provider-b", model: "model-b" },
            provider: "provider-b",
            model: "model-b",
            maxContextTokens: 4096,
            maxOutputTokens: 1024,
            opaque: { mustNotReachSidecar: true },
          },
        },
      };
    }
    return {
      kind: "response" as const,
      messageId: "stream-1",
      inReplyTo: "call-stream",
      ok: true,
      payload: { events: [{ type: "message_end", finishReason: "stop" }] },
    };
  }, { methods: ["prepare", "stream"], uuid: () => "fixed" });

  const prepared = await port.prepare({ request, context });
  const events = [];
  for await (const event of port.stream({ prepared, context })) events.push(event);

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.operation, "prepare");
  assert.equal(calls[1]?.operation, "stream");
  assert.equal(calls[0]?.preparationId, calls[1]?.preparationId);
  assert.equal(prepared.provider, "provider-b");
  assert.equal(prepared.model, "model-b");
  assert.equal(prepared.maxContextTokens, 4096);
  assert.equal(prepared.maxOutputTokens, 1024);
  assert.equal(prepared.opaque, undefined);
  const preparePayload = calls[0]?.payload as Record<string, unknown>;
  assert.equal((preparePayload.context as Record<string, unknown>).abortSignal, undefined);
  assert.equal(events.length, 1);
});

test("host model consumer materializes an existing preparation without exposing host opaque state", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const payload = moduleCall.payload as Record<string, unknown>;
    calls.push({ operation: payload.operation, preparationId: payload.preparationId, request: payload.request });
    if (payload.operation === "prepare") {
      return {
        kind: "response" as const,
        messageId: "prepared",
        inReplyTo: "prepare",
        ok: true,
        payload: {
          prepared: {
            request: {
              ...request,
              provider: "provider-b",
              model: "model-b",
              systemPrompt: "provider prompt",
              tools: [{ name: "provider_tool" }],
              maxOutputTokens: 64,
            },
            provider: "provider-b",
            model: "model-b",
            opaque: { hostOnly: true },
          },
        },
      };
    }
    if (payload.operation === "materialize_prepared_request") {
      assert.equal((payload.request as CanonicalModelRequest).systemPrompt, "candidate prompt");
      return {
        kind: "response" as const,
        messageId: "materialized",
        inReplyTo: "materialize",
        ok: true,
        payload: {
          request: {
            ...(payload.request as CanonicalModelRequest),
            systemPrompt: "provider prompt",
            tools: [{ name: "provider_tool" }],
            maxOutputTokens: 64,
          },
        },
      };
    }
    throw new Error(`Unexpected operation: ${payload.operation}`);
  }, { methods: ["prepare", "materialize_prepared_request"], uuid: () => "fixed" });

  const prepared = await port.prepare({ request, context });
  const materialized = await port.materializePreparedRequest?.(prepared, {
    ...request,
    provider: "provider-b",
    model: "model-b",
    messages: [{ role: "user", content: [{ type: "text", text: "compacted" }] }],
    systemPrompt: "candidate prompt",
  } as CanonicalModelRequest);

  assert.equal(materialized?.systemPrompt, "provider prompt");
  assert.equal(Object.isFrozen(materialized), true);
  assert.equal(materialized?.tools?.[0]?.name, "provider_tool");
  assert.equal(materialized?.maxOutputTokens, 64);
  assert.equal(calls[0]?.preparationId, calls[1]?.preparationId);
  assert.equal((calls[1]?.request as { opaque?: unknown }).opaque, undefined);
});

test("host model consumer preserves one prepared request snapshot and identity when a caller retries the module call", async () => {
  const calls: Array<{
    requestId?: string;
    preparationId?: string;
    runId?: string;
    operationId?: string;
    idempotencyKey?: string;
    operationDeadline?: string;
    request: unknown;
  }> = [];
  let attempt = 0;
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const payload = moduleCall.payload as Record<string, unknown>;
    const serializedContext = payload.context as Record<string, unknown>;
    calls.push({
      requestId: moduleCall.requestId,
      preparationId: payload.preparationId as string | undefined,
      runId: moduleCall.runId,
      operationId: moduleCall.operationId,
      idempotencyKey: moduleCall.idempotencyKey,
      operationDeadline: serializedContext.operationDeadline as string | undefined,
      request: structuredClone(payload.request),
    });
    if (attempt++ === 0) {
      return {
        kind: "response",
        messageId: "response-failed",
        inReplyTo: "call-1",
        ok: false,
        code: "MODEL_TEMPORARY_FAILURE",
        error: { message: "temporary model failure" },
      };
    }
    return {
      kind: "response",
      messageId: "response-ok",
      inReplyTo: "call-2",
      ok: true,
      payload: { events: [{ type: "message_end", finishReason: "stop" }] },
    };
  }, { uuid: (() => {
    let value = 0;
    return () => `retry-${++value}`;
  })() });

  const mutableRequest = structuredClone(request);
  mutableRequest.messages = [{ role: "user", content: [{ type: "text", text: "before" }] }];
  const prepared = await port.prepare({ request: mutableRequest, context });
  assert.equal(Object.isFrozen(prepared.request), true);
  assert.equal(Object.isFrozen(prepared.request.messages), true);
  mutableRequest.messages[0]!.content[0] = { type: "text", text: "after" };

  await assert.rejects(
    async () => {
      for await (const _event of port.stream({ prepared, context })) {
        // Consume the failed attempt.
      }
    },
    /temporary model failure/,
  );
  const events = [];
  for await (const event of port.stream({ prepared, context })) events.push(event);

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]?.requestId, calls[1]?.requestId);
  assert.equal(typeof calls[0]?.preparationId, "string");
  assert.equal(calls[0]?.preparationId, calls[1]?.preparationId);
  assert.equal(calls[0]?.runId, calls[1]?.runId);
  assert.equal(calls[0]?.operationId, calls[1]?.operationId);
  assert.equal(calls[0]?.idempotencyKey, calls[1]?.idempotencyKey);
  assert.equal(calls[0]?.operationDeadline, calls[1]?.operationDeadline);
  assert.deepEqual(calls[0]?.request, calls[1]?.request);
  assert.equal((calls[1]?.request as { messages?: Array<{ content?: Array<{ text?: string }> }> })?.messages?.[0]?.content?.[0]?.text, "before");
  assert.equal(events.length, 1);
});

test("host model consumer gives distinct preparations distinct identities even with a fixed UUID", async () => {
  const preparationIds: string[] = [];
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const payload = moduleCall.payload as Record<string, unknown>;
    preparationIds.push(payload.preparationId as string);
    return {
      kind: "response",
      messageId: "response-1",
      inReplyTo: "call-1",
      ok: true,
      payload: { events: [{ type: "message_end", finishReason: "stop" }] },
    };
  }, { uuid: () => "fixed" });

  const first = await port.prepare({ request, context });
  const second = await port.prepare({ request, context });
  for await (const _event of port.stream({ prepared: first, context })) {
    // Consume the host response.
  }
  for await (const _event of port.stream({ prepared: second, context })) {
    // Consume the host response.
  }

  assert.deepEqual(preparationIds, ["prepared-fixed-1", "prepared-fixed-2"]);
});

test("host model consumer preserves module failure code and retry metadata", async () => {
  const port = createHostModelInvokerPort(async () => ({
    kind: "response",
    messageId: "response-1",
    inReplyTo: "call-1",
    ok: false,
    code: "MODEL_UNAVAILABLE",
    error: {
      message: "host model unavailable",
      retryable: true,
      retryAfterMs: 250,
    },
  }));
  const prepared = await port.prepare({ request, context });

  await assert.rejects(
    async () => {
      for await (const _event of port.stream({ prepared, context })) {
        // Consume the stream so the module response is evaluated.
      }
    },
    (error: Error & { code?: string; retryable?: boolean; retryAfterMs?: number }) =>
      error.message === "host model unavailable"
      && error.code === "MODEL_UNAVAILABLE"
      && error.retryable === true
      && error.retryAfterMs === 250,
  );
});

test("host model consumer rejects a successful response without canonical events", async () => {
  const port = createHostModelInvokerPort(async () => ({
    kind: "response",
    messageId: "response-1",
    inReplyTo: "call-1",
    ok: true,
    payload: {},
  }));
  const prepared = await port.prepare({ request, context });

  await assert.rejects(
    async () => {
      for await (const _event of port.stream({ prepared, context })) {
        // Consume the stream so malformed responses cannot be ignored.
      }
    },
    (error: Error & { code?: string }) => error.code === "INVALID_MODEL_RESPONSE",
  );
});

test("host model consumer pulls advertised stream events incrementally", async () => {
  const operations: string[] = [];
  let releaseSecond!: () => void;
  const secondAllowed = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const operation = (moduleCall.payload as Record<string, unknown>).operation as string;
    operations.push(operation);
    if (operation === "prepare") {
      return {
        kind: "response",
        messageId: "prepared",
        inReplyTo: "prepare",
        ok: true,
        payload: { prepared: { request, provider: request.provider, model: request.model } },
      };
    }
    const pull = operations.filter((candidate) => candidate === "stream_next").length;
    if (pull === 1) {
      return {
        kind: "response",
        messageId: "delta",
        inReplyTo: "next-1",
        ok: true,
        payload: { events: [{ type: "text_delta", text: "first" }], done: false },
      };
    }
    await secondAllowed;
    return {
      kind: "response",
      messageId: "done",
      inReplyTo: "next-2",
      ok: true,
      payload: { events: [{ type: "message_end", finishReason: "stop" }], done: true },
    };
  }, { methods: ["prepare", "stream_next", "close_stream"], uuid: () => "pull" });

  const prepared = await port.prepare({ request, context });
  const iterator = port.stream({ prepared, context })[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: { type: "text_delta", text: "first" }, done: false });
  assert.deepEqual(operations, ["prepare", "stream_next"]);
  releaseSecond();
  assert.deepEqual(await iterator.next(), { value: { type: "message_end", finishReason: "stop" }, done: false });
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  assert.deepEqual(operations, ["prepare", "stream_next", "stream_next"]);
});

test("host model consumer preserves pulled prefix before a later provider error", async () => {
  let pulls = 0;
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const operation = (moduleCall.payload as Record<string, unknown>).operation;
    if (operation === "prepare") {
      return {
        kind: "response",
        messageId: "prepared",
        inReplyTo: "prepare",
        ok: true,
        payload: { prepared: { request, provider: request.provider, model: request.model } },
      };
    }
    pulls += 1;
    if (pulls === 1) {
      return {
        kind: "response",
        messageId: "prefix",
        inReplyTo: "next-1",
        ok: true,
        payload: { events: [{ type: "reasoning_delta", text: "thinking" }], done: false },
      };
    }
    return {
      kind: "response",
      messageId: "failure",
      inReplyTo: "next-2",
      ok: false,
      code: "MODEL_STREAM_FAILED",
      error: { message: "provider failed after output", retryable: false },
    };
  }, { methods: ["prepare", "stream_next"], uuid: () => "prefix" });

  const prepared = await port.prepare({ request, context });
  const iterator = port.stream({ prepared, context })[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: { type: "reasoning_delta", text: "thinking" }, done: false });
  await assert.rejects(iterator.next(), (error: Error & { code?: string }) =>
    error.message === "provider failed after output" && error.code === "MODEL_STREAM_FAILED");
});

test("host model consumer closes an unfinished pulled stream when iteration stops early", async () => {
  const operations: string[] = [];
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const operation = (moduleCall.payload as Record<string, unknown>).operation as string;
    operations.push(operation);
    if (operation === "prepare") {
      return {
        kind: "response",
        messageId: "prepared",
        inReplyTo: "prepare",
        ok: true,
        payload: { prepared: { request, provider: request.provider, model: request.model } },
      };
    }
    if (operation === "close_stream") {
      return { kind: "response", messageId: "closed", inReplyTo: "close", ok: true, payload: { closed: true } };
    }
    return {
      kind: "response",
      messageId: "delta",
      inReplyTo: "next",
      ok: true,
      payload: { events: [{ type: "text_delta", text: "first" }], done: false },
    };
  }, { methods: ["prepare", "stream_next", "close_stream"], uuid: () => "close" });

  const prepared = await port.prepare({ request, context });
  for await (const _event of port.stream({ prepared, context })) break;
  assert.deepEqual(operations, ["prepare", "stream_next", "close_stream"]);
});

test("host model consumer rejects malformed pulled stream responses", async () => {
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const operation = (moduleCall.payload as Record<string, unknown>).operation;
    if (operation === "prepare") {
      return {
        kind: "response",
        messageId: "prepared",
        inReplyTo: "prepare",
        ok: true,
        payload: { prepared: { request, provider: request.provider, model: request.model } },
      };
    }
    return {
      kind: "response",
      messageId: "malformed",
      inReplyTo: "next",
      ok: true,
      payload: { events: [] },
    };
  }, { methods: ["prepare", "stream_next"], uuid: () => "malformed" });
  const prepared = await port.prepare({ request, context });

  await assert.rejects(
    async () => {
      for await (const _event of port.stream({ prepared, context })) {
        // Consume so response validation executes.
      }
    },
    (error: Error & { code?: string }) => error.code === "INVALID_MODEL_RESPONSE",
  );
});

test("host model consumer restores a canonical provider error from the module response", async () => {
  const port = createHostModelInvokerPort(async (moduleCall) => {
    const operation = (moduleCall.payload as Record<string, unknown>).operation;
    if (operation === "prepare") {
      return {
        kind: "response", messageId: "prepared", inReplyTo: "prepare", ok: true,
        payload: { prepared: { request, provider: request.provider, model: request.model } },
      };
    }
    return {
      kind: "response", messageId: "failure", inReplyTo: "next", ok: false,
      code: "agent_model_error",
      error: {
        message: "credentials rejected",
        canonical: {
          code: "auth_error", message: "credentials rejected", retryable: false,
          provider: "provider-a", model: "model-a", protocol: "openai",
          userHint: "Update the API key.", settingsFix: { description: "Update the API key.", configPath: "model.providers.provider-a.apiKey" },
        },
      },
    };
  }, { methods: ["prepare", "stream_next"], uuid: () => "canonical-error" });
  const prepared = await port.prepare({ request, context });

  await assert.rejects(
    async () => { for await (const _event of port.stream({ prepared, context })) { /* consume */ } },
    (error: unknown) => error instanceof ModelProviderError
      && error.error.code === "auth_error"
      && error.error.userHint === "Update the API key."
      && error.error.settingsFix?.configPath === "model.providers.provider-a.apiKey",
  );
});
