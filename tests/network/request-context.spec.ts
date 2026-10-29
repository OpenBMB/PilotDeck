import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { anonymousRequestId, currentRequestContext, installationId, requestAppVersion, requestContextHeaders, withRequestContext } from "../../src/network/requestContext.js";
import { buildProviderHeaders, complete, streamModel } from "../../src/model/streaming/streamModel.js";
import { parseModelConfig } from "../../src/model/config/parseModelConfig.js";
import type { ModelProtocol } from "../../src/model/protocol/canonical.js";

const home = mkdtempSync(join(tmpdir(), "pilotdeck-request-context-"));
const saved = { home: process.env.PILOT_HOME, mode: process.env.PILOTDECK_REQUEST_HEADERS };
before(() => { process.env.PILOT_HOME = home; process.env.PILOTDECK_REQUEST_HEADERS = "full"; });
after(() => {
  for (const [key, value] of [["PILOT_HOME", saved.home], ["PILOTDECK_REQUEST_HEADERS", saved.mode]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
const request = { provider: "test", model: "test-model", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }] };
const config = (protocol: ModelProtocol, url = "https://example.test/v1") => parseModelConfig({ providers: { test: {
  protocol, url, apiKey: "test-key", models: { "test-model": {} }, retry: { baseDelayMs: 1, streamMaxRetries: 1 },
} } });
const responseBody = (protocol: ModelProtocol) => protocol === "google"
  ? { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }
  : protocol === "anthropic" ? { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
  : protocol === "openai-responses" ? { id: "resp_1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }] }
  : { id: "chat_1", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };

test("installation identity survives processes and is independent of credentials", () => {
  const id = installationId();
  const privateSeed = readFileSync(join(home, "request-identity"), "utf8");
  assert.notEqual(privateSeed, id);
  assert.ok(!JSON.stringify(requestContextHeaders()).includes(privateSeed));
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/network/requestContext.ts")).href;
  const child = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {installationId} from ${JSON.stringify(moduleUrl)}; console.log(installationId());`], { encoding: "utf8" }).trim();
  assert.equal(child, id);
  assert.notEqual(anonymousRequestId("user", "alice"), anonymousRequestId("user", "bob"));
  assert.notEqual(anonymousRequestId("user", "alice"), anonymousRequestId("project", "alice"));
  assert.notEqual(installationId(join(home, "other")), id);
});

test("headers omit raw paths, named sessions, invalid values and missing context", () => {
  const headers = requestContextHeaders({ projectPath: "/private/customer", sessionId: "weixin:private-person", clientVersion: "bad\r\nx: y" });
  assert.match(headers["x-pilotdeck-project-id"], /^[a-f0-9]{32}$/);
  assert.match(headers["x-pilotdeck-session-id"], /^[a-f0-9]{32}$/);
  assert.equal(headers["x-pilotdeck-client-version"], undefined);
  assert.doesNotMatch(JSON.stringify(headers), /private|customer|weixin/);
  assert.equal(requestContextHeaders()["x-pilotdeck-session-id"], undefined);
  assert.doesNotThrow(() => requestContextHeaders({ projectPath: {} as string, sessionId: {} as string }));
  assert.equal(requestAppVersion({ PILOTDECK_VERSION: "2.3.4" }), "2.3.4");
  assert.notEqual(requestAppVersion({ npm_package_version: "wrong-package" }), "wrong-package");
});

test("off and basic modes suppress persistent identities and context", () => {
  process.env.PILOTDECK_REQUEST_HEADERS = "off";
  assert.deepEqual(requestContextHeaders(), {});
  process.env.PILOTDECK_REQUEST_HEADERS = "basic";
  const headers = requestContextHeaders({ sessionId: randomUUID() });
  assert.equal(headers["x-pilotdeck-user-id"], undefined);
  assert.equal(headers["x-pilotdeck-device-id"], undefined);
  assert.equal(headers["x-pilotdeck-session-id"], undefined);
  assert.ok(headers["x-pilotdeck-version"]);
  process.env.PILOTDECK_REQUEST_HEADERS = "full";
});

test("concurrent operations and nested scopes never leak session/user context", async () => {
  const sessions = [randomUUID(), randomUUID()];
  await Promise.all(sessions.map((sessionId, index) => withRequestContext({ sessionId, userId: anonymousRequestId("user", String(index)) }, async () => {
    await new Promise(resolve => setTimeout(resolve, index ? 2 : 10));
    const headers = requestContextHeaders();
    assert.equal(headers["x-pilotdeck-session-id"], sessionId);
    assert.equal(headers["x-pilotdeck-user-id"], anonymousRequestId("user", String(index)));
    await assert.rejects(withRequestContext({ sessionId: "child" }, async () => { throw new Error("cancelled"); }));
    assert.equal(currentRequestContext().sessionId, sessionId);
  })));
  assert.deepEqual(currentRequestContext(), {});
});

test("configured headers override defaults case-insensitively without duplicate auth", () => {
  const provider = config("openai").providers.test;
  provider.headers = { "User-Agent": "Enterprise/1", Authorization: "Bearer explicit", "X-PilotDeck-Version": "custom" };
  const headers = new Headers(buildProviderHeaders(provider));
  assert.equal(headers.get("user-agent"), "Enterprise/1");
  assert.equal(headers.get("authorization"), "Bearer explicit");
  assert.equal(headers.get("x-pilotdeck-version"), "custom");
});

test("provider modes are validated and cannot bypass global off", () => {
  for (const mode of ["full", "basic", "off"] as const) {
    const raw = { providers: { test: { protocol: "openai", url: "https://example.test/v1", apiKey: "key", models: { "test-model": {} }, requestHeadersMode: mode } } };
    const provider = parseModelConfig(raw).providers.test;
    assert.equal(provider.requestHeadersMode, mode);
    const headers = new Headers(buildProviderHeaders(provider));
    assert.equal(headers.has("x-pilotdeck-version"), mode !== "off");
    assert.equal(headers.has("x-pilotdeck-installation-id"), mode === "full");
    process.env.PILOTDECK_REQUEST_HEADERS = "off";
    assert.equal(new Headers(buildProviderHeaders(provider)).has("x-pilotdeck-version"), false);
    process.env.PILOTDECK_REQUEST_HEADERS = "full";
  }
  assert.throws(() => parseModelConfig({ providers: { test: { protocol: "openai", url: "https://example.test", apiKey: "key", models: { model: {} }, requestHeadersMode: "invalid" } } }), /requestHeadersMode/);
});

for (const protocol of ["openai", "openai-responses", "anthropic", "google"] as const) {
  test(`${protocol}: actual HTTP carries context without adding model-visible content`, async () => {
    let received: IncomingHttpHeaders = {};
    let body = "";
    const server = createServer(async (req, res) => {
      received = req.headers;
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody(protocol)));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const sessionId = randomUUID();
      await withRequestContext({ sessionId, projectPath: "/private/project", purpose: "conversation" }, () => complete(request, config(protocol, `http://127.0.0.1:${port}/v1`)));
      assert.match(String(received["user-agent"]), /PilotDeck\//);
      assert.equal(received["x-pilotdeck-session-id"], sessionId);
      assert.ok(received["x-pilotdeck-operation-id"]);
      assert.ok(received["x-pilotdeck-request-id"]);
      assert.ok(received["x-pilotdeck-project-id"]);
      assert.doesNotMatch(body, /x-pilotdeck|private\/project|operationId|requestContext/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test("stream retry has distinct wire IDs, one operation ID, and stable session", async () => {
  const seen: Headers[] = [];
  const sessionId = randomUUID();
  const stream = streamModel(request, config("openai"), {
    requestContext: { sessionId },
    fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers));
      if (seen.length === 1) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    },
  });
  for await (const _ of stream) { /* consume */ }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].get("x-pilotdeck-request-id"), seen[1].get("x-pilotdeck-request-id"));
  assert.equal(seen[0].get("x-pilotdeck-operation-id"), seen[1].get("x-pilotdeck-operation-id"));
  assert.equal(seen[1].get("x-pilotdeck-session-id"), sessionId);
});
