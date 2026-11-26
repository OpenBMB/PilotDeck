import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
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

const invalidRoles: Array<[string, unknown]> = [
  ["assistant", "assistant"],
  ["system", "system"],
  ["tool", "tool"],
  ["developer", "developer"],
  ["unknown", "unknown"],
  ["missing", undefined],
  ["null", null],
  ["number", 7],
  ["object", { name: "user" }],
];

for (const [name, role] of invalidRoles) {
  for (const streaming of [false, true]) {
    test(`rejects final ${name} role before /new (${streaming ? "streaming" : "buffered"})`, async () => {
      const chatId = "existing-chat";
      const oldSession = `api_server:chat=${chatId}:s_old`;
      const mapper = new ApiServerSessionMapper({ activeByChatId: { [chatId]: oldSession } }, () => "new-id");
      const channel = new ApiServerChannel({ mapper });
      const message = role === undefined ? { content: "/new" } : { role, content: "/new" };
      const request = Readable.from([Buffer.from(JSON.stringify({ messages: [message], stream: streaming }))]) as unknown as IncomingMessage;
      request.headers = { "x-hermes-session-id": chatId };
      const response = new FakeResponse();

      await (channel as unknown as {
        handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void>;
      }).handleChatCompletions(request, response as unknown as ServerResponse);

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.chunks.join("")).error.code, "invalid_message_role");
      assert.equal(mapper.snapshot().activeByChatId[chatId], oldSession);
    });
  }
}

test("accepts a final user role", async () => {
  const channel = new ApiServerChannel();
  const request = Readable.from([Buffer.from(JSON.stringify({
    messages: [{ role: "user", content: "/new" }],
  }))]) as unknown as IncomingMessage;
  request.headers = {};
  const response = new FakeResponse();

  await (channel as unknown as {
    handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void>;
  }).handleChatCompletions(request, response as unknown as ServerResponse);

  assert.equal(response.statusCode, 200);
});
