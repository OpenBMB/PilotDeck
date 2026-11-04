import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { ApiServerChannel } from "../../../src/adapters/channel/api-server/ApiServerChannel.js";
import type { GatewayEvent } from "../../../src/gateway/protocol/types.js";
import type { ChannelHandle } from "../../../src/adapters/channel/protocol/types.js";

const NOOP_LOGGER = { error() {}, info() {}, warn() {} };

function fakeReq(body: object, headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  const req = Object.assign(stream, {
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json", host: "127.0.0.1:8642", ...headers },
  }) as unknown as IncomingMessage;
  return req;
}

function fakeRes(): { res: ServerResponse; chunks: string[] } {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader(k: string, v: string) { headers[k] = v; },
    flushHeaders() {},
    write(chunk: string | Buffer): boolean { chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk); return true; },
    end(chunk?: string | Buffer): void { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk); },
  } as unknown as ServerResponse;
  return { res, chunks };
}

async function startChannel(gateway: { submitTurn(): AsyncIterable<GatewayEvent> }): Promise<{
  channel: ApiServerChannel;
  stop: ChannelHandle["stop"];
}> {
  const channel = new ApiServerChannel({
    port: 0, // ephemeral port so tests never collide on the default listener
    mapper: {
      resolve: () => ({ sessionKey: "sk-test", message: "hi" }),
    } as never,
  });
  const handle = await channel.start({ gateway: gateway as never, logger: NOOP_LOGGER } as never);
  return { channel, stop: handle.stop };
}

test("SSE error path emits the OpenAI terminal markers (finish chunk + [DONE])", async () => {
  // Gateway that throws mid-stream, after the request was accepted.
  const failingGateway = {
    submitTurn(): AsyncIterable<GatewayEvent> {
      const gen = (async function* () {
        throw new Error("gateway boom");
        yield { type: "turn_started", runId: "r1" } as unknown as GatewayEvent;
      })();
      return gen;
    },
  };
  const { channel, stop } = await startChannel(failingGateway);
  try {
    const req = fakeReq({ stream: true, messages: [{ role: "user", content: "hi" }] });
    const { res, chunks } = fakeRes();
    await (channel as unknown as { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> }).handleRequest(req, res);

    const joined = chunks.join("");
    assert.match(joined, /channel_submit_failed/);
    assert.match(joined, /"finish_reason":"stop"/);
    assert.match(joined, /data: \[DONE\]/);
  } finally {
    await stop("test teardown");
  }
});

test("SSE success path emits the OpenAI terminal markers", async () => {
  const okGateway = {
    submitTurn(): AsyncIterable<GatewayEvent> {
      const gen = (async function* () {
        yield { type: "turn_started", runId: "r1" } as GatewayEvent;
        yield { type: "assistant_text_delta", runId: "r1", text: "hello" } as unknown as GatewayEvent;
      })();
      return gen;
    },
  };
  const { channel, stop } = await startChannel(okGateway);
  try {
    const req = fakeReq({ stream: true, messages: [{ role: "user", content: "hi" }] });
    const { res, chunks } = fakeRes();
    await (channel as unknown as { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> }).handleRequest(req, res);

    const joined = chunks.join("");
    assert.match(joined, /"content":"hello"/);
    assert.match(joined, /"finish_reason":"stop"/);
    assert.match(joined, /data: \[DONE\]/);
  } finally {
    await stop("test teardown");
  }
});
