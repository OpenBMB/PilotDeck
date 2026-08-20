import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent, AgentInput, AgentSession, AgentSubmitOptions } from "../../src/agent/index.js";
import {
  GatewayWsClient,
  InProcessGateway,
  RemoteGateway,
  SessionRouter,
  startGatewayServer,
  type GatewayEvent,
} from "../../src/gateway/index.js";

test("Gateway hello and submit_turn preserve the stable wire contract", async (t) => {
  const session: AgentSession = {
    abort: () => undefined,
    snapshot: () => ({
      sessionId: "session-contract",
      messages: [],
      usage: {},
      permissionDenials: [],
      status: "idle" as const,
      abortController: new AbortController(),
    }),
    replay: async function* () {},
    submit: async function* (_input: AgentInput, options: AgentSubmitOptions) {
      const turnId = options.turnId ?? "generated";
      yield { type: "turn_started", sessionId: "session-contract", turnId } satisfies AgentEvent;
      yield {
        type: "model_event",
        sessionId: "session-contract",
        turnId,
        event: { type: "text_delta", text: "contract response" },
      } satisfies AgentEvent;
      yield {
        type: "turn_completed",
        sessionId: "session-contract",
        turnId,
        result: {
          type: "success",
          sessionId: "session-contract",
          turnId,
          stopReason: "completed",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies AgentEvent;
    },
  } as unknown as AgentSession;

  const gateway = new InProcessGateway(new SessionRouter({ createSession: async () => session }));
  const server = await startGatewayServer({ gateway, host: "127.0.0.1", port: 0, token: "contract-token" });
  const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
  t.after(async () => {
    client.close();
    await server.close();
  });

  const hello = await client.connect();
  assert.deepEqual(Object.keys(hello).sort(), ["protocolVersion", "serverInfo", "serverVersion", "type"]);
  assert.equal(hello.type, "hello_ok");
  assert.equal(typeof hello.protocolVersion, "string");
  assert.equal(typeof hello.serverVersion, "string");
  assert.equal(hello.serverInfo.mode, "in_process");

  const remote = new RemoteGateway(client);
  const events = await collect(remote.submitTurn({
    sessionKey: "session-contract",
    channelKey: "test",
    message: "hello",
    runId: "run-contract",
  }));

  assert.deepEqual(events.map(normalizeEvent), [
    { type: "turn_started", runId: "<run>" },
    { type: "assistant_text_delta", text: "contract response", runId: "<run>" },
    { type: "turn_completed", finishReason: "completed", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, runId: "<run>" },
  ]);
});

test("Gateway protocol errors use a stable structured response envelope", () => {
  const error = {
    type: "response",
    id: "request-1",
    ok: false,
    error: { code: "session_busy", message: "Session is busy." },
  } as const;
  assert.deepEqual(Object.keys(error).sort(), ["error", "id", "ok", "type"]);
  assert.deepEqual(Object.keys(error.error).sort(), ["code", "message"]);
  assert.equal(error.ok, false);
});

function normalizeEvent(event: GatewayEvent): Record<string, unknown> {
  switch (event.type) {
    case "turn_started":
      return { type: event.type, runId: "<run>" };
    case "assistant_text_delta":
      return { type: event.type, text: event.text, runId: "<run>" };
    case "turn_completed":
      return { type: event.type, finishReason: event.finishReason, usage: event.usage, runId: "<run>" };
    default:
      return { type: event.type, runId: "<run>" };
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
