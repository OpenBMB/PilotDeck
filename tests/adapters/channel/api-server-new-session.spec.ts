import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { ApiServerChannel } from "../../../src/adapters/channel/api-server/ApiServerChannel.js";
import { ApiServerSessionMapper } from "../../../src/adapters/channel/api-server/ApiServerSessionMapper.js";

class FakeResponse {
  statusCode = 200;
  readonly headers = new Map<string, string>();
  readonly chunks: string[] = [];

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(chunk?: string): void {
    if (chunk) this.chunks.push(chunk);
  }
}

for (const streaming of [false, true]) {
  test(`bare /new returns its session identifier (${streaming ? "streaming" : "buffered"})`, async () => {
    const mapper = new ApiServerSessionMapper({ activeByChatId: {} }, () => "new-id");
    const channel = new ApiServerChannel({ mapper });
    const request = Readable.from([Buffer.from(JSON.stringify({
      messages: [{ role: "user", content: "/new" }],
      stream: streaming,
    }))]) as unknown as IncomingMessage;
    request.headers = {};
    const response = new FakeResponse();

    await (channel as unknown as {
      handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }).handleChatCompletions(request, response as unknown as ServerResponse);

    const chatId = response.headers.get("x-hermes-session-id");
    assert.equal(response.statusCode, 200);
    assert.match(chatId ?? "", /^api-[0-9a-f-]{36}$/);
    assert.equal(mapper.snapshot().activeByChatId[chatId!], `api_server:chat=${chatId}:s_new-id`);
  });
}
