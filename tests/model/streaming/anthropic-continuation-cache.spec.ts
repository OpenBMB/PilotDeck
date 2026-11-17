import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { buildCachePlan } from "../../../src/context/cache/CachePlan.js";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { streamModel } from "../../../src/model/streaming/streamModel.js";

test("Anthropic HTTP stream continuations keep valid cache writes across repeated interruptions", async (t) => {
  type Block = { type: string; text?: string; cache_control?: { type: string; ttl: string } };
  type Body = { system: Block[]; messages: Array<{ role: string; content: Block[] }> };
  const bodies: Body[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body);
    assert.equal(req.headers["x-api-key"], "synthetic-test-key");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const text = ["alpha ", "beta ", "gamma"][bodies.length - 1];
    res.write(`data: ${JSON.stringify({ type: "message_start", message: { role: "assistant" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
    if (bodies.length === 3) {
      res.write('data: {"type":"content_block_stop","index":0}\n\n');
      res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    }
    // The first two responses end before a terminal event, like a dropped stream.
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const config = parseModelConfig({ providers: { fixture: { protocol: "anthropic",
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: "synthetic-test-key",
    retry: { streamMaxRetries: 2, requestMaxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    models: { "fixture-model": { capabilities: { supportsPromptCache: true } } },
  } } });
  const request: CanonicalModelRequest = { provider: "fixture", model: "fixture-model", systemPrompt: "Stable policy",
    messages: Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? "assistant" as const : "user" as const,
      content: [{ type: "text" as const, text: `history-${i}` }] })),
  };
  request.cachePlan = buildCachePlan({ ...request, tools: [], enabled: true }, 1);
  request.cacheBreakpoints = request.cachePlan?.messages;
  const original = structuredClone(request);
  const events = [];
  for await (const event of streamModel(request, config, { signal: AbortSignal.timeout(10_000) })) events.push(event);
  assert.equal(bodies.length, 3);
  assert.equal(events.some(event => event.type === "error"), false);
  assert.equal(events.filter(event => event.type === "text_delta").map(event => event.text).join(""), "alpha beta gamma");
  for (const body of bodies) {
    const marked = body.messages.filter(message => message.content.some(block => block.cache_control));
    assert.equal(marked.length, 3);
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral", ttl: "5m" });
    for (const message of marked) assert.deepEqual(message.content.at(-1)?.cache_control, { type: "ephemeral", ttl: "5m" });
    assert.deepEqual(body.messages.slice(0, 5).map(message => message.content[0].text),
      original.messages.map(message => message.content[0].type === "text" && message.content[0].text));
  }
  assert.equal(bodies[1].messages[5].content[0].text, "alpha ");
  assert.equal(bodies[2].messages[5].content[0].text, "alpha beta ");
  assert.deepEqual(request, original);
});
