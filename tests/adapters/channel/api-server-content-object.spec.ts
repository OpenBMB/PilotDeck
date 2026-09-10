import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { ApiServerChannel } from "../../../src/adapters/channel/api-server/ApiServerChannel.js";
import { ApiServerSessionMapper } from "../../../src/adapters/channel/api-server/ApiServerSessionMapper.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../../src/gateway/index.js";

type CapturedCall = {
  sessionKey: string;
  channelKey: string;
  message: string;
};

type CaptureResponse = {
  statusCode: number;
  headers: Map<string, string>;
  ended: boolean;
  body: string;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string | Buffer): boolean;
  end(chunk?: string | Buffer): void;
};

function makeResponse(): CaptureResponse {
  const chunks: string[] = [];
  return {
    statusCode: 0,
    headers: new Map<string, string>(),
    ended: false,
    get body() {
      return chunks.join("");
    },
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), String(value));
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk != null) chunks.push(String(chunk));
      this.ended = true;
    },
  };
}

function makeRequest(content: unknown, stream: boolean, sessionId: string): IncomingMessage {
  const body = JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content }],
    stream,
  });
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  (req as any).method = "POST";
  (req as any).url = "/v1/chat/completions";
  (req as any).headers = {
    host: "fixture.invalid",
    "content-type": "application/json",
    "x-hermes-session-id": sessionId,
  };
  return req;
}

function makeGateway(calls: CapturedCall[]): Gateway {
  return {
    async *submitTurn(input: GatewaySubmitTurnInput): AsyncGenerator<GatewayEvent> {
      calls.push({
        sessionKey: input.sessionKey,
        channelKey: input.channelKey,
        message: input.message,
      });
      yield { type: "assistant_text_delta", text: "fixture-reply" } as GatewayEvent;
      yield {
        type: "turn_completed",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "completed",
      } as unknown as GatewayEvent;
    },
  } as unknown as Gateway;
}

async function runCase(content: unknown, stream: boolean, sessionId: string) {
  const calls: CapturedCall[] = [];
  const mapper = new ApiServerSessionMapper({ activeByChatId: {} }, () => "fixture-uuid");
  const channel = new ApiServerChannel({ mapper, modelName: "fixture-model" });
  (channel as any).gateway = makeGateway(calls);
  const res = makeResponse();
  await (channel as any).handleRequest(
    makeRequest(content, stream, sessionId),
    res as unknown as ServerResponse,
  );
  return { calls, res, channel, mapper };
}

test("A. arbitrary plain object is rejected with HTTP 400 and zero Gateway calls", async () => {
  const { calls, res, channel } = await runCase(
    { kind: "fixture-object", value: 7 },
    false,
    "fixture-501-A",
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(res.body, /\[object Object\]/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error?.code, "invalid_content");
  assert.equal((channel as any).activeChats.size, 0);
});

test("B. object shaped like a content part is rejected and never becomes [object Object]", async () => {
  const { calls, res, channel } = await runCase(
    { type: "text", text: "fixture-object-text" },
    false,
    "fixture-501-B",
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(res.body, /\[object Object\]/);
  assert.doesNotMatch(res.body, /fixture-object-text/);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error?.code, "invalid_content");
  assert.equal((channel as any).activeChats.size, 0);
});

test("C. rejected object with stream=true is rejected before SSE/Gateway admission", async () => {
  const { calls, res, channel } = await runCase(
    { kind: "fixture-object", value: 7 },
    true,
    "fixture-501-C",
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.doesNotMatch(res.body, /\[object Object\]/);
  assert.ok(!res.body.includes("data: [DONE]"));
  assert.equal((channel as any).activeChats.size, 0);
});

test("D. string content remains accepted with exact original string", async () => {
  const { calls, res, channel } = await runCase("hello fixture string", false, "fixture-501-D");
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.message, "hello fixture string");
  assert.equal((channel as any).activeChats.size, 0);
});

test("E. intentionally-supported array content preserves existing behavior", async () => {
  const stringArray = await runCase(["alpha", "beta"], false, "fixture-501-E1");
  assert.equal(stringArray.res.statusCode, 200);
  assert.equal(stringArray.calls.length, 1);
  assert.equal(stringArray.calls[0]?.message, "alpha\nbeta");

  const partArray = await runCase(
    [
      { type: "text", text: "part-one" },
      { type: "input_text", text: "part-two" },
    ],
    false,
    "fixture-501-E2",
  );
  assert.equal(partArray.res.statusCode, 200);
  assert.equal(partArray.calls.length, 1);
  assert.equal(partArray.calls[0]?.message, "part-one\npart-two");
});

test("F. object shaped like a content part with stream=true is rejected before SSE/Gateway admission", async () => {
  const { calls, res, channel } = await runCase(
    { type: "text", text: "fixture-object-text" },
    true,
    "fixture-501-F",
  );
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.doesNotMatch(res.body, /\[object Object\]/);
  assert.doesNotMatch(res.body, /fixture-object-text/);
  assert.ok(!res.body.includes("data: [DONE]"));
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error?.code, "invalid_content");
  assert.equal((channel as any).activeChats.size, 0);
});
