import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { ApiServerChannel } from "../../../src/adapters/channel/api-server/ApiServerChannel.js";
import type { Gateway } from "../../../src/gateway/index.js";

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

for (const content of [{ kind: "fixture" }, { type: "text", text: "fixture" }]) {
  for (const streaming of [false, true]) {
    test(`object content is rejected before Gateway (${content.kind ?? content.type}, ${streaming ? "streaming" : "buffered"})`, async () => {
      const calls: unknown[] = [];
      const channel = new ApiServerChannel();
      (channel as unknown as { gateway: Gateway }).gateway = {
        async *submitTurn(input: unknown) {
          calls.push(input);
          yield { type: "assistant_text_delta", text: "fixture reply" };
        },
      } as unknown as Gateway;
      const request = Readable.from([Buffer.from(JSON.stringify({
        messages: [{ role: "user", content }],
        stream: streaming,
      }))]) as unknown as IncomingMessage;
      request.headers = {};
      const response = new FakeResponse();

      await (channel as unknown as {
        handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void>;
      }).handleChatCompletions(request, response as unknown as ServerResponse);

      assert.equal(response.statusCode, 400);
      assert.equal(JSON.parse(response.chunks.join("")).error.code, "invalid_content");
      assert.equal(calls.length, 0);
    });
  }
}
