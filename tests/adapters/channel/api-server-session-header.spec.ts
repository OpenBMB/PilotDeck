import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { ApiServerChannel } from "../../../src/adapters/channel/api-server/ApiServerChannel.js";
import { ApiServerSessionMapper } from "../../../src/adapters/channel/api-server/ApiServerSessionMapper.js";
import type { Gateway, GatewayEvent, GatewaySubmitTurnInput } from "../../../src/gateway/index.js";

type Call = Pick<GatewaySubmitTurnInput, "sessionKey" | "channelKey" | "message">;

class FakeResponse {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  private readonly chunks: string[] = [];

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), String(value));
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(String(name).toLowerCase());
  }

  write(chunk: string): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  flushHeaders(): void {}

  end(chunk?: string): void {
    if (chunk !== undefined) this.chunks.push(String(chunk));
  }

  get body(): string {
    return this.chunks.join("");
  }
}

function makeRequest(content: string, stream: boolean, sessionId?: string): Readable & {
  method?: string;
  url?: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {
    host: "fixture.invalid",
    "content-type": "application/json",
  };
  if (sessionId !== undefined) headers["x-hermes-session-id"] = sessionId;
  const request = Readable.from([Buffer.from(JSON.stringify({
    model: "fixture-model",
    messages: [{ role: "user", content }],
    stream,
  }))]) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  request.method = "POST";
  request.url = "/v1/chat/completions";
  request.headers = headers;
  return request;
}

function makeMapper(): ApiServerSessionMapper {
  return new ApiServerSessionMapper({ activeByChatId: {} }, () => "00000000-0000-0000-0000-000000000042");
}

async function post(
  channel: ApiServerChannel,
  content: string,
  stream: boolean,
  sessionId?: string,
): Promise<{ status: number; sessionHeader: string | null; body: string }> {
  const response = new FakeResponse();
  await (channel as unknown as {
    handleRequest(req: unknown, res: FakeResponse): Promise<void>;
  }).handleRequest(makeRequest(content, stream, sessionId), response);
  return {
    status: response.statusCode,
    sessionHeader: response.headers.get("x-hermes-session-id") ?? null,
    body: response.body,
  };
}

function makeGateway(mode: "succeed" | "throw", calls: Call[]): Gateway {
  return {
    submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
      calls.push({
        sessionKey: input.sessionKey,
        channelKey: input.channelKey,
        message: input.message,
      });
      return (async function* (): AsyncGenerator<GatewayEvent> {
        if (mode === "throw") {
          throw new Error("synthetic submit failure");
        }
        yield { type: "assistant_text_delta", text: "fixture reply" } as GatewayEvent;
        yield {
          type: "turn_completed",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          finishReason: "completed",
        } as GatewayEvent;
      })();
    },
  } as unknown as Gateway;
}

function installGateway(channel: ApiServerChannel, gateway: Gateway | undefined): void {
  (channel as unknown as { gateway?: Gateway }).gateway = gateway;
}

function mapperEntries(channel: ApiServerChannel): Array<[string, string]> {
  return Object.entries((channel as unknown as {
    mapper: { snapshot(): { activeByChatId: Record<string, string> } };
  }).mapper.snapshot().activeByChatId);
}

function makeChannel(): ApiServerChannel {
  return new ApiServerChannel({
    host: "127.0.0.1",
    port: 0,
    modelName: "fixture-model",
    mapper: makeMapper(),
  });
}

test("buffered inline /new failure exposes the session id and retries reach the reset session", async () => {
  const channel = makeChannel();
  const failedCalls: Call[] = [];
  installGateway(channel, makeGateway("throw", failedCalls));

  const failed = await post(channel, "/new first prompt", false);
  assert.equal(failed.status, 500);
  assert.ok(failed.body.includes("channel_submit_failed"));
  assert.ok(failed.sessionHeader, "buffered failure must still expose the session id");

  const bindings = mapperEntries(channel);
  assert.equal(bindings.length, 1);
  const [, resetSessionKey] = bindings[0]!;
  assert.ok(resetSessionKey.includes(":s_"));

  const retryCalls: Call[] = [];
  installGateway(channel, makeGateway("succeed", retryCalls));
  const retry = await post(channel, "retry with returned token", false, failed.sessionHeader!);
  assert.equal(retry.status, 200);
  assert.equal(retryCalls[0]?.sessionKey, resetSessionKey);
});

test("buffered gateway-unavailable inline /new exposes the session id", async () => {
  const channel = makeChannel();

  const failed = await post(channel, "/new first prompt", false);
  assert.equal(failed.status, 503);
  assert.ok(failed.body.includes("gateway_unavailable"));
  assert.ok(failed.sessionHeader, "preflight failure must still expose the session id");
  assert.equal(mapperEntries(channel).length, 1);
});

test("streaming preflight gateway-unavailable inline /new exposes the session id", async () => {
  const channel = makeChannel();

  const failed = await post(channel, "/new first prompt", true);
  assert.equal(failed.status, 503);
  assert.ok(failed.sessionHeader, "streaming preflight failure must still expose the session id");
  assert.equal(mapperEntries(channel).length, 1);
});

test("buffered success still exposes the session id", async () => {
  const channel = makeChannel();
  const calls: Call[] = [];
  installGateway(channel, makeGateway("succeed", calls));

  const ok = await post(channel, "plain message", false);
  assert.equal(ok.status, 200);
  assert.ok(ok.sessionHeader);
  assert.ok(calls[0]?.sessionKey.endsWith(":general"));
});
