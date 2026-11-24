import assert from "node:assert/strict";
import { createServer, globalAgent, type Server } from "node:http";
import test from "node:test";
import { createTaskPreviewTool } from "../../src/tool/builtin/taskPreview.js";
import { TaskOutputStore } from "../../src/task/storage/TaskOutputStore.js";
import type { PilotDeckBackgroundBashTask } from "../../src/task/protocol/types.js";

const context = {
  sessionId: "preview-session",
  turnId: "preview-turn",
  cwd: process.cwd(),
  permissionMode: "bypassPermissions" as const,
  permissionContext: {
    mode: "bypassPermissions" as const,
    cwd: process.cwd(),
    additionalWorkingDirectories: [],
    canPrompt: false,
    bypassAvailable: true,
    rules: { allow: [], deny: [], ask: [] },
  },
};

function fixture(output = "", options: { truncated?: boolean; startupOutput?: string } = {}) {
  const task = {
    taskId: "preview-task",
    sessionId: context.sessionId,
    cwd: context.cwd,
    status: "running",
  } as PilotDeckBackgroundBashTask;
  const runtime = {
    get: (id: string) => (id === task.taskId ? task : undefined),
    getOutput: (_id: string, _offset: number) => ({
      content: output,
      nextOffset: Buffer.byteLength(output),
      totalBytes: Buffer.byteLength(output),
      truncated: options.truncated ?? false,
    }),
    ...(options.startupOutput !== undefined
      ? { getStartupOutput: (_id: string) => options.startupOutput! }
      : {}),
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
    const result = await tool.execute(
      { taskId: "preview-task", url: `${origin}/demo?mode=review`, expectedText: "Preview fixture" },
      context,
    );
    assert.equal(requested, "/demo?mode=review");
    assert.equal(result.data?.url, `${origin}/demo?mode=review`);
    assert.equal(result.data?.browserVerified, false);
    assert.equal(result.data?.scope, "gateway-loopback");
    const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /\[Open preview\]\(<http:\/\/127\.0\.0\.1:/);
    assert.match(text, /task_stop\(\{ taskId: "preview-task" \}\)/);
    assert.match(text, /browser rendering has not been verified/);
  } finally {
    await close(server);
  }
});

test("preview Markdown escapes character references and backslashes without rewriting the checked URL", async () => {
  const route = "/demo?value=a&amp;b=x\\";
  const server = createServer((req, res) => {
    res.writeHead(req.url === route ? 200 : 404, { "content-type": "text/html" });
    res.end("Preview fixture");
  });
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    const checked = await tool.execute({ taskId: "preview-task", url: origin + route, expectedText: "Preview fixture" }, context);
    assert.equal(checked.data?.url, origin + route);
    const link = checked.content[0];
    assert.equal(link.type, "text");
    assert.equal(link.text.split("\n")[0], `[Open preview](<${origin}/demo?value=a&amp;amp;b=x\\\\>)`);
  } finally {
    await close(server);
  }
});

test("preview connects directly without using the process-wide HTTP agent", async t => {
  const globalConnection = t.mock.method(globalAgent, "createConnection", () => {
    throw new Error("The global HTTP agent must not handle a preview request");
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("Preview fixture");
  });
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    const checked = await tool.execute({ taskId: "preview-task", url: origin, expectedText: "Preview fixture" }, context);
    assert.equal(checked.data?.url, `${origin}/`);
    assert.equal(globalConnection.mock.callCount(), 0);
  } finally {
    await close(server);
  }
});

test("the preview origin must match an announced loopback or wildcard HTTP origin", async () => {
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
    for (const output of [
      "",
      `http://127.0.0.1:${otherPort}`,
      `https://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
      `Port ${port} is in use, trying another one...`,
    ]) {
      const { tool } = fixture(output);
      await assert.rejects(
        tool.execute({ taskId: "preview-task", url: origin, expectedText: "Expected app" }, context),
        /origin was not found/,
      );
    }
    await assert.rejects(
      fixture(`http://127.0.0.1:${otherPort}`).tool.execute(
        { taskId: "preview-task", url: origin, expectedText: "Expected app" },
        context,
      ),
      new RegExp(`announced: http://127\\.0\\.0\\.1:${otherPort}`),
    );
    await assert.rejects(
      fixture(`http://127.0.0.1:${port}`).tool.execute(
        { taskId: "preview-task", url: `http://[::1]:${port}`, expectedText: "Expected app" },
        context,
      ),
      /origin was not found/,
    );
    assert.equal(requests, 0);

    for (const [announced, probeUrl] of [
      [`Local: \x1b[36mhttp://0.0.0.0:${port}/\x1b[0m`, origin],
      [`Local: \x1b[36mhttp://0.0.0.0:${port}/\x1b[0m`, `http://localhost:${port}`],
      [`Uvicorn running on http://127.0.0.1:${port}`, `http://localhost:${port}`],
      [`Local: http://localhost:${port}/`, origin],
      [`Serving HTTP on :: port ${port} (http://[::]:${port}/) ...`, origin],
      [`Serving HTTP on :: port ${port} (http://[::]:${port}/) ...`, `http://localhost:${port}`],
    ] as const) {
      const { tool } = fixture(announced);
      await tool.execute({ taskId: "preview-task", url: probeUrl, expectedText: "Expected app" }, context);
    }
    assert.equal(requests, 6);
  } finally {
    await close(server);
  }
});

test("retained startup prefix preserves announced origin after ring-buffer turnover", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Long-running preview</title>");
  });
  const origin = await listen(server);
  try {
    const store = new TaskOutputStore({ taskId: "preview-task", maxMemoryBytes: 256 });
    store.append(`  ➜  Local:   ${origin}/\n`);
    store.append("GET /assets/chunk.js 200\n".repeat(40));
    const slice = store.readSlice(0);
    assert.equal(slice.truncated, true);
    assert.doesNotMatch(slice.content, /Local:/);

    const { tool: retainedTool } = fixture(slice.content, {
      truncated: slice.truncated,
      startupOutput: store.readStartup(),
    });
    const result = await retainedTool.execute(
      { taskId: "preview-task", url: origin, expectedText: "Long-running preview" },
      context,
    );
    assert.equal(result.data?.url, `${origin}/`);

    const { tool: evictedTool } = fixture(slice.content, { truncated: true });
    await assert.rejects(
      evictedTool.execute({ taskId: "preview-task", url: origin, expectedText: "Long-running preview" }, context),
      /early startup output was evicted/,
    );
  } finally {
    await close(server);
  }
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
  for (const url of [
    "not-url",
    "file:///tmp/index.html",
    "https://127.0.0.1:12345",
    "http://example.com:12345",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://user:secret@127.0.0.1:12345",
    "http://127.0.0.1:12345/#fragment",
  ]) {
    await assert.rejects(
      tool.execute({ taskId: "preview-task", url, expectedText: "Example" }, context),
      /preview URL|loopback HTTP/,
    );
  }
  for (const expectedText of [" ", "x".repeat(1025)]) {
    await assert.rejects(
      tool.execute({ taskId: "preview-task", url: "http://127.0.0.1:12345", expectedText }, context),
      /expectedText/,
    );
  }
});

test("wrong content, redirects, HTTP errors and oversized HTML never yield a preview link", async () => {
  let redirectedHits = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/target" });
      res.end();
      return;
    }
    if (req.url === "/target") redirectedHits++;
    res.writeHead(req.url === "/error" ? 500 : 200, {
      "content-type": req.url === "/json" ? "application/json" : "text/html",
    });
    if (req.url === "/spa") {
      res.end("<!doctype html><html><head><title>Vite + React + TS</title></head><body><div id=\"root\"></div></body></html>");
      return;
    }
    res.end(req.url === "/big" ? "x".repeat(512 * 1024 + 1) : "wrong page");
  });
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    for (const route of ["/redirect", "/json", "/error", "/wrong", "/big"]) {
      await assert.rejects(
        tool.execute({ taskId: "preview-task", url: origin + route, expectedText: "Expected app" }, context),
        /Preview is not ready/,
      );
    }
    await assert.rejects(
      tool.execute({ taskId: "preview-task", url: `${origin}/spa`, expectedText: "Kanban Board" }, context),
      /initial <title>: "Vite \+ React \+ TS".*before JavaScript executes/,
    );
    assert.equal(redirectedHits, 0);
  } finally {
    await close(server);
  }
});

test("caller cancellation interrupts a pending HTTP response", async () => {
  const abort = new AbortController();
  const server = createServer((_req, _res) => abort.abort());
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    await assert.rejects(
      tool.execute({ taskId: "preview-task", url: origin, expectedText: "Expected" }, { ...context, abortSignal: abort.signal }),
      /cancelled/,
    );
  } finally {
    await close(server);
  }
});

test("a task that exits during the check is not reported ready", async () => {
  let task: PilotDeckBackgroundBashTask;
  const server = createServer((_req, res) => {
    task.status = "completed";
    res.writeHead(200, { "content-type": "text/html" });
    res.end("Expected app");
  });
  const origin = await listen(server);
  const { tool, task: runningTask } = fixture(origin);
  task = runningTask;
  try {
    await assert.rejects(
      tool.execute({ taskId: task.taskId, url: origin, expectedText: "Expected app" }, context),
      /not running/,
    );
  } finally {
    await close(server);
  }
});

test("localhost hands off the literal URL with the Host header that was verified", async () => {
  let host = "";
  const server = createServer((req, res) => {
    host = req.headers.host ?? "";
    res.writeHead(200, { "content-type": "text/html" });
    res.end("Local app");
  });
  const origin = await listen(server);
  const url = `${origin.replace("127.0.0.1", "localhost")}/preview?mode=check`;
  try {
    const { tool } = fixture(url);
    const result = await tool.execute({ taskId: "preview-task", url, expectedText: "Local app" }, context);
    assert.equal(result.data?.url, `${origin}/preview?mode=check`);
    assert.equal(host, new URL(origin).host);
  } finally {
    await close(server);
  }
});

test("IPv6 localhost previews return the literal address without DNS", async t => {
  let host = "";
  const server = createServer((req, res) => {
    host = req.headers.host ?? "";
    res.writeHead(200, { "content-type": "text/html" });
    res.end("IPv6 app");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "::1", port: 0, ipv6Only: true }, resolve);
    });
  } catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      t.skip("IPv6 loopback unavailable");
      return;
    }
    throw error;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const ipv6Port = address.port;
    for (const [announcedHost, probeHost] of [
      ["localhost", "localhost"],
      ["[::1]", "[::1]"],
      ["[::1]", "localhost"],
      ["[::]", "localhost"],
    ] as const) {
      const announced = `http://${announcedHost}:${ipv6Port}/`;
      const probeUrl: string = `http://${probeHost}:${ipv6Port}/`;
      const { tool } = fixture(announced);
      const checked = await tool.execute({ taskId: "preview-task", url: probeUrl, expectedText: "IPv6 app" }, context);
      assert.equal(checked.data?.url, `http://[::1]:${ipv6Port}/`);
      assert.equal(host, `[::1]:${ipv6Port}`);
    }

    await t.test("a different IPv4 app on the same port does not mask the verified IPv6 app", async t => {
      const ipv4 = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("IPv4 app");
      });
      try {
        await new Promise<void>((resolve, reject) => {
          ipv4.once("error", reject);
          ipv4.listen(ipv6Port, "127.0.0.1", resolve);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
          t.skip("The paired IPv4 port is unavailable");
          return;
        }
        throw error;
      }
      try {
        const url = `http://localhost:${ipv6Port}/preview`;
        const { tool } = fixture(url);
        const checked = await tool.execute({ taskId: "preview-task", url, expectedText: "IPv6 app" }, context);
        assert.equal(checked.data?.url, `http://[::1]:${ipv6Port}/preview`);
        assert.equal(host, `[::1]:${ipv6Port}`);
      } finally {
        await close(ipv4);
      }
    });
  } finally {
    await close(server);
  }
});

test("a server that never responds is bounded by the readiness deadline", { timeout: 8000 }, async () => {
  const server = createServer(() => {});
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    await assert.rejects(
      tool.execute({ taskId: "preview-task", url: origin, expectedText: "Expected app" }, context),
      /timed out after 5 seconds/,
    );
  } finally {
    await close(server);
  }
});

test("response failures identify status, type, redirects and unsupported encoding", async () => {
  const server = createServer((req, res) => {
    res.writeHead(
      req.url === "/redirect" ? 302 : req.url === "/error" ? 503 : 200,
      req.url === "/json"
        ? { "content-type": "application/json" }
        : req.url === "/gzip"
          ? { "content-type": "text/html", "content-encoding": "gzip" }
          : { "content-type": "text/html" },
    );
    res.end("Expected app");
  });
  const origin = await listen(server);
  try {
    const { tool } = fixture(origin);
    for (const [route, message] of [
      ["/json", /Expected text\/html, received application\/json \(HTTP 200\)/],
      ["/error", /Expected HTTP 200, received 503/],
      ["/redirect", /HTTP 302 redirect/],
      ["/gzip", /Unsupported content-encoding: gzip/],
    ] as const) {
      await assert.rejects(
        tool.execute({ taskId: "preview-task", url: origin + route, expectedText: "Expected app" }, context),
        message,
      );
    }
  } finally {
    await close(server);
  }
});

test("already cancelled calls retain the structured cancellation code", async () => {
  const { tool } = fixture("http://localhost:12345");
  await assert.rejects(
    tool.execute(
      { taskId: "preview-task", url: "http://localhost:12345", expectedText: "Expected app" },
      { ...context, abortSignal: AbortSignal.abort() },
    ),
    (error: unknown) => (error as { code: string }).code === "tool_aborted",
  );
});

test("default port and wildcard addresses explain the supported URL contract", async () => {
  const { tool } = fixture();
  for (const url of ["http://127.0.0.1:80", "http://0.0.0.0:3000"]) {
    await assert.rejects(
      tool.execute({ taskId: "preview-task", url, expectedText: "App" }, context),
      /non-default port.*same port on 127\.0\.0\.1/,
    );
  }
});
