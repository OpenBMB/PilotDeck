import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createTaskPreviewTool } from "../../src/tool/builtin/taskPreview.js";
import type { PilotDeckBackgroundBashTask } from "../../src/task/protocol/types.js";

const context = {
  sessionId: "preview-session", turnId: "preview-turn", cwd: process.cwd(),
  permissionMode: "bypassPermissions" as const,
  permissionContext: { mode: "bypassPermissions" as const, cwd: process.cwd(), additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } },
};

function fixture(output = "") {
  const task = { taskId: "preview-task", sessionId: context.sessionId, cwd: context.cwd, status: "running" } as PilotDeckBackgroundBashTask;
  const runtime = {
    get: (id: string) => id === task.taskId ? task : undefined,
    getOutput: (_id: string, _offset: number) => ({
      content: output, nextOffset: Buffer.byteLength(output), totalBytes: Buffer.byteLength(output), truncated: false,
    }),
  };
  return { task, tool: createTaskPreviewTool(runtime) };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}

test("owned running preview returns exact clickable URL, evidence and stop identity", async () => {
  let requested = "";
  const server = createServer((req, res) => {
    requested = req.url!;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Preview fixture</title><button>Ready</button>");
  });
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    const result = await tool.execute({ taskId: "preview-task", url: `${origin}/demo?mode=review`, expectedText: "Preview fixture" }, context);
    assert.equal(requested, "/demo?mode=review");
    assert.equal(result.data?.url, `${origin}/demo?mode=review`);
    assert.equal(result.data?.browserVerified, false);
    assert.equal(result.data?.scope, "gateway-loopback");
    const text = result.content.map(c => c.type === "text" ? c.text : "").join("");
    assert.match(text, /\[Open preview\]\(<http:\/\/127\.0\.0\.1:/);
    assert.match(text, /task_stop\(\{ taskId: "preview-task" \}\)/);
    assert.match(text, /browser rendering has not been verified/);
  } finally { await close(server); }
});

test("the preview origin must be announced by the selected task", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("Expected app");
  });
  const origin = await listen(server);
  try {
    const { port } = new URL(origin);
    const otherPort = port === "3000" ? "3001" : "3000";
    for (const output of ["", `http://127.0.0.1:${otherPort}`, `http://localhost:${port}`]) {
      const { tool } = fixture(output);
      await assert.rejects(tool.execute({ taskId: "preview-task", url: origin, expectedText: "Expected app" }, context), /origin was not found/);
    }
    assert.equal(requests, 0);

    const { tool } = fixture(`Local: \x1b[36mhttp://0.0.0.0:${port}/\x1b[0m`);
    await tool.execute({ taskId: "preview-task", url: origin, expectedText: "Expected app" }, context);
    assert.equal(requests, 1);
  } finally { await close(server); }
});

test("unknown, other-session, other-workspace and settled tasks cannot be presented", async () => {
  const { tool, task } = fixture();
  const input = { taskId: "preview-task", url: "http://127.0.0.1:12345", expectedText: "Example" };
  await assert.rejects(tool.execute({ ...input, taskId: "missing" }, context), /owned by/);
  await assert.rejects(tool.execute(input, { ...context, sessionId: "other" }), /owned by/);
  await assert.rejects(tool.execute(input, { ...context, cwd: "/other-workspace" }), /owned by/);
  task.status = "failed";
  await assert.rejects(tool.execute(input, context), /not running/);
});

test("invalid URL shapes and empty markers fail without probing", async () => {
  const { tool } = fixture();
  for (const url of ["not-url", "file:///tmp/index.html", "https://127.0.0.1:12345", "http://example.com:12345", "http://127.0.0.1", "http://127.0.0.1:0", "http://user:secret@127.0.0.1:12345", "http://127.0.0.1:12345/#fragment"]) {
    await assert.rejects(tool.execute({ taskId: "preview-task", url, expectedText: "Example" }, context), /preview URL|loopback HTTP/);
  }
  for (const expectedText of [" ", "x".repeat(1025)]) {
    await assert.rejects(tool.execute({ taskId: "preview-task", url: "http://127.0.0.1:12345", expectedText }, context), /expectedText/);
  }
});

test("wrong content, redirects, HTTP errors and oversized HTML never yield a preview link", async () => {
  let redirectedHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/target" }); res.end(); return; }
    if (req.url === "/target") redirectedHits++;
    res.writeHead(req.url === "/error" ? 500 : 200, { "content-type": req.url === "/json" ? "application/json" : "text/html" });
    res.end(req.url === "/big" ? "x".repeat(512 * 1024 + 1) : "wrong page");
  });
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    for (const route of ["/redirect", "/json", "/error", "/wrong", "/big"]) {
      await assert.rejects(tool.execute({ taskId: "preview-task", url: origin + route, expectedText: "Expected app" }, context), /Preview is not ready/);
    }
    assert.equal(redirectedHits, 0);
  } finally { await close(server); }
});

test("caller cancellation interrupts a pending HTTP response", async () => {
  const abort = new AbortController();
  const server = createServer((_req, _res) => abort.abort());
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    await assert.rejects(tool.execute({ taskId: "preview-task", url: origin, expectedText: "Expected" }, { ...context, abortSignal: abort.signal }), /cancelled/);
  } finally { await close(server); }
});

test("a task that exits during the check is not reported ready", async () => {
  let task: PilotDeckBackgroundBashTask;
  const server = createServer((_req, res) => {
    task.status = "completed";
    res.writeHead(200, { "content-type": "text/html" }); res.end("Expected app");
  });
  const origin = await listen(server);
  const { tool, task: runningTask } = fixture(origin);
  task = runningTask;
  try {
    await assert.rejects(tool.execute({ taskId: task.taskId, url: origin, expectedText: "Expected app" }, context), /not running/);
  } finally { await close(server); }
});

test("localhost retains its URL and Host header when probing a loopback server", async () => {
  let host = "";
  const server = createServer((req, res) => {
    host = req.headers.host ?? "";
    res.writeHead(200, { "content-type": "text/html" }); res.end("Local app");
  });
  const origin = await listen(server);
  const url = origin.replace("127.0.0.1", "localhost");
  try {
    const { tool } = fixture(url);
    const result = await tool.execute({ taskId: "preview-task", url, expectedText: "Local app" }, context);
    assert.equal(result.data?.url, url + "/");
    assert.equal(host, new URL(url).host);
  } finally { await close(server); }
});

test("IPv6-only localhost services can be checked without DNS", async t => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }); res.end("IPv6 app");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
    });
  } catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) { t.skip("IPv6 loopback unavailable"); return; }
    throw error;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const host of ["localhost", "[::1]"]) {
      const url = `http://${host}:${address.port}/`;
      const { tool } = fixture(url);
      assert.equal((await tool.execute({ taskId: "preview-task", url, expectedText: "IPv6 app" }, context)).data?.url, url);
    }
  } finally { await close(server); }
});

test("a server that never responds is bounded by the readiness deadline", { timeout: 8000 }, async () => {
  const server = createServer(() => {});
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    await assert.rejects(tool.execute({ taskId: "preview-task", url: origin, expectedText: "Expected app" }, context), /timed out after 5 seconds/);
  } finally { await close(server); }
});

test("response failures identify status, type, redirects and unsupported encoding", async () => {
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/redirect" ? 302 : req.url === "/error" ? 503 : 200,
      req.url === "/json" ? { "content-type": "application/json" } : req.url === "/gzip" ? { "content-type": "text/html", "content-encoding": "gzip" } : { "content-type": "text/html" });
    res.end("Expected app");
  });
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    for (const [route, message] of [["/json", /Expected text\/html, received application\/json \(HTTP 200\)/], ["/error", /Expected HTTP 200, received 503/], ["/redirect", /HTTP 302 redirect/], ["/gzip", /Unsupported content-encoding: gzip/]] as const) {
      await assert.rejects(tool.execute({ taskId: "preview-task", url: origin + route, expectedText: "Expected app" }, context), message);
    }
  } finally { await close(server); }
});

test("already cancelled calls retain the structured cancellation code", async () => {
  const { tool } = fixture("http://localhost:12345");
  await assert.rejects(tool.execute({ taskId: "preview-task", url: "http://localhost:12345", expectedText: "Expected app" }, { ...context, abortSignal: AbortSignal.abort() }),
    (error: unknown) => (error as { code: string }).code === "tool_aborted");
});

test("default port and wildcard addresses explain the supported URL contract", async () => {
  const { tool } = fixture();
  for (const url of ["http://127.0.0.1:80", "http://0.0.0.0:3000"]) {
    await assert.rejects(tool.execute({ taskId: "preview-task", url, expectedText: "App" }, context), /non-default port.*same port on 127\.0\.0\.1/);
  }
});
