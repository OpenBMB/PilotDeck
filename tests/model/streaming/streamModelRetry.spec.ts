import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ProviderConfig } from "../../../src/model/protocol/canonical.js";
import type { GoogleClientFactory } from "../../../src/model/providers/google/client.js";
import { resolveStreamIdleTimeout, streamModel } from "../../../src/model/streaming/streamModel.js";

function createConfig(input: { timeoutMs?: number; streamMaxRetries?: number; streamIdleTimeoutMs?: number } = {}) {
  return parseModelConfig({
    providers: {
      test: {
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        timeoutMs: input.timeoutMs,
        retry: {
          streamMaxRetries: input.streamMaxRetries ?? 1,
          streamIdleTimeoutMs: input.streamIdleTimeoutMs,
          baseDelayMs: 1,
        },
        models: { "test-model": {} },
      },
    },
  });
}

function createRequest(): CanonicalModelRequest {
  return {
    provider: "test",
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
}

function createGoogleConfig(input: { timeoutMs?: number; streamMaxRetries?: number; streamIdleTimeoutMs?: number } = {}) {
  return parseModelConfig({
    providers: {
      test: {
        protocol: "google",
        url: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "test-key",
        timeoutMs: input.timeoutMs,
        retry: {
          streamMaxRetries: input.streamMaxRetries ?? 0,
          streamIdleTimeoutMs: input.streamIdleTimeoutMs,
          baseDelayMs: 1,
        },
        models: { "test-model": {} },
      },
    },
  });
}

function sse(data: string): Response {
  return new Response(data, { headers: { "content-type": "text/event-stream" } });
}

async function collect(stream: AsyncIterable<CanonicalModelEvent>): Promise<CanonicalModelEvent[]> {
  const events: CanonicalModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("stream idle timeout defaults independently from provider request timeout", () => {
  const config = createConfig({ timeoutMs: 1 });
  const provider = config.providers.test!;

  assert.equal(resolveStreamIdleTimeout(provider), 600_000);
  assert.equal(resolveStreamIdleTimeout(provider, { streamTimeoutMs: 1234 }), 1234);
  assert.equal(resolveStreamIdleTimeout({ ...provider, retry: { streamIdleTimeoutMs: 5678 } }), 5678);
});

test("stream request setup uses the stream timeout instead of provider timeout", async () => {
  const config = createConfig({ timeoutMs: 1, streamMaxRetries: 0 });
  const events = await collect(streamModel(createRequest(), config, {
    streamTimeoutMs: 30,
    fetch: async (_input, init) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5);
        const signal = init?.signal as AbortSignal | null;
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
      return sse("data: [DONE]\n\n");
    },
  }));

  assert.equal(events.some((event) => event.type === "error"), false);
});

test("retries an interrupted stream only before the first content event", async () => {
  const config = createConfig();
  let requests = 0;
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async () => {
      requests++;
      return requests === 1 ? sse("") : sse("data: [DONE]\n\n");
    },
  }));

  assert.equal(requests, 2);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("continues a pure text stream after interruption", async () => {
  const config = createConfig();
  const requestBodies: Array<Record<string, unknown>> = [];
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return requestBodies.length === 1
        ? sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        : sse("data: [DONE]\n\n");
    },
  }));

  assert.equal(requestBodies.length, 2);
  const messages = requestBodies[1]!.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.at(-2)?.role, "assistant");
  assert.equal(messages.at(-2)?.content, "partial");
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("does not continue text-encoded tool calls across an interruption", async () => {
  const config = createConfig();
  const requestBodies: Array<Record<string, unknown>> = [];
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return sse('data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"write_file\\",\\"arguments\\":{\\"path\\":\\"secret.mjs\\""}}]}\n\n');
    },
  }));

  const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
  assert.equal(requestBodies.length, 1);
  assert.equal(error?.error.streamInterruption?.phase, "text");
});

test("retains partial text if its continuation disconnects before output", async () => {
  const config = createConfig({ streamMaxRetries: 1 });
  let requests = 0;
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async () => {
      requests++;
      return requests === 1
        ? sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        : sse("");
    },
  }));

  const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
  assert.equal(requests, 2);
  assert.equal(error?.error.streamInterruption?.phase, "text");
});

test("retains partial text when its continuation receives a terminal HTTP error", async () => {
  const config = createConfig({ streamMaxRetries: 1 });
  let requests = 0;
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async () => {
      requests++;
      return requests === 1
        ? sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        : new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), { status: 429 });
    },
  }));

  const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
  assert.equal(requests, 2);
  assert.equal(error?.error.code, "rate_limit_error");
  assert.equal(error?.error.streamInterruption?.phase, "text");
});

test("retains partial text when continuation setup fails", async () => {
  const config = createConfig({ streamMaxRetries: 1 });
  let requests = 0;
  const events = await collect(streamModel(createRequest(), config, {
    fetch: async () => {
      requests++;
      if (requests === 1) {
        return sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      }
      throw new Error("fetch failed");
    },
  }));

  const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
  assert.equal(requests, 2);
  assert.equal(error?.error.streamInterruption?.phase, "text");
});

test("does not replay a stream after reasoning or tool-call output", async () => {
  const cases = [
    {
      name: "reasoning",
      payload: 'data: {"choices":[{"delta":{"reasoning_content":"think","content":"partial"}}]}\n\n',
      phase: "text",
    },
    {
      name: "tool call",
      payload: 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"deck.mjs"}}]}}]}\n\n',
      phase: "tool_call",
    },
  ] as const;

  for (const item of cases) {
    const config = createConfig();
    let requests = 0;
    const events = await collect(streamModel(createRequest(), config, {
      fetch: async () => {
        requests++;
        return sse(item.payload);
      },
    }));

    const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
    assert.equal(requests, 1, item.name);
    assert.equal(error?.error.streamInterruption?.phase, item.phase, item.name);
  }
});

test("Google streaming uses an idle watchdog instead of an absolute SDK timeout", async () => {
  const config = createGoogleConfig({ timeoutMs: 1 });
  const clientTimeouts: Array<number | undefined> = [];
  const googleClientFactory: GoogleClientFactory = (provider: ProviderConfig) => {
    clientTimeouts.push(provider.timeoutMs);
    return {
      models: {
        generateContent: async () => ({} as never),
        generateContentStream: async () => (async function* () {
          yield { candidates: [{ content: { parts: [{ text: "a" }] } }] } as never;
          await sleep(8);
          yield { candidates: [{ content: { parts: [{ text: "b" }] } }] } as never;
          await sleep(8);
          yield { candidates: [{ finishReason: "STOP", content: { parts: [] } }] } as never;
        })(),
      },
    };
  };

  const events = await collect(streamModel(createRequest(), config, {
    streamTimeoutMs: 10,
    googleClientFactory,
  }));

  assert.deepEqual(clientTimeouts, [undefined]);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("Google idle watchdog interrupts a stalled iterator", async () => {
  const config = createGoogleConfig();
  const googleClientFactory: GoogleClientFactory = () => ({
    models: {
      generateContent: async () => ({} as never),
      generateContentStream: async () => (async function* () {
        await sleep(15);
        yield { candidates: [{ finishReason: "STOP", content: { parts: [] } }] } as never;
      })(),
    },
  });

  const events = await collect(streamModel(createRequest(), config, {
    streamTimeoutMs: 5,
    googleClientFactory,
  }));

  const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
  assert.equal(error?.error.code, "timeout");
  assert.equal(error?.error.settingsFix?.configPath, "model.providers.<id>.retry.streamIdleTimeoutMs");
});

test("Google recovers a stream ending without a finish event", async () => {
  const config = createGoogleConfig();
  const googleClientFactory: GoogleClientFactory = () => ({
    models: {
      generateContent: async () => ({} as never),
      generateContentStream: async () => (async function* () {
        yield { candidates: [{ content: { parts: [{ text: "partial" }] } }] } as never;
      })(),
    },
  });

  const events = await collect(streamModel(createRequest(), config, { googleClientFactory }));

  const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
  assert.equal(error?.error.streamInterruption?.phase, "text");
  assert.equal(events.some((event) => event.type === "message_end"), false);
});

test("Google does not continue text-encoded tool calls across an interruption", async () => {
  const config = createGoogleConfig({ streamMaxRetries: 1 });
  let requests = 0;
  const googleClientFactory: GoogleClientFactory = () => ({
    models: {
      generateContent: async () => ({} as never),
      generateContentStream: async () => {
        requests++;
        return (async function* () {
          yield {
            candidates: [{
              content: {
                parts: [{ text: '<tool_call>{"name":"write_file","arguments":{"path":"secret.mjs"' }],
              },
            }],
          } as never;
        })();
      },
    },
  });

  const events = await collect(streamModel(createRequest(), config, { googleClientFactory }));

  const error = events.find((event): event is Extract<CanonicalModelEvent, { type: "error" }> => event.type === "error");
  assert.equal(requests, 1);
  assert.equal(error?.error.streamInterruption?.phase, "text");
});

test("Google stops reading once it emits a terminal event", async () => {
  const config = createGoogleConfig();
  let readAfterFinish = false;
  const googleClientFactory: GoogleClientFactory = () => ({
    models: {
      generateContent: async () => ({} as never),
      generateContentStream: async () => (async function* () {
        yield { candidates: [{ content: { parts: [{ text: "complete" }] } }] } as never;
        yield { candidates: [{ finishReason: "STOP", content: { parts: [] } }] } as never;
        readAfterFinish = true;
        throw new Error("stream closed after finish");
      })(),
    },
  });

  const events = await collect(streamModel(createRequest(), config, { googleClientFactory }));

  assert.equal(readAfterFinish, false);
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(events.filter((event) => event.type === "message_end").length, 1);
});

test("first-token timeout uses stream-idle guidance", async () => {
  const config = createConfig({ streamMaxRetries: 0 });
  await assert.rejects(
    collect(streamModel(createRequest(), config, {
      streamTimeoutMs: 5,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    })),
    (error: unknown) => {
      const providerError = error as { error?: { settingsFix?: { configPath?: string } } };
      return providerError.error?.settingsFix?.configPath === "model.providers.<id>.retry.streamIdleTimeoutMs";
    },
  );
});
