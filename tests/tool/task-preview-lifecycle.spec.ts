import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { BackgroundTaskRuntime } from "../../src/task/runtime/BackgroundTaskRuntime.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";
import { createTaskTools } from "../../src/tool/builtin/taskTools.js";

// Real child, socket and tool sequence: no model calls or user configuration.
test("managed service exposes its startup URL through task_output after log turnover, verifies and stops", { timeout: 15000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pilotdeck-preview-"));
  const runtime = new BackgroundTaskRuntime();
  const tools = createTaskTools({ runtime });
  const context = {
    sessionId: "preview-session", turnId: "preview-turn", cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: { mode: "bypassPermissions" as const, cwd, additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true, rules: { allow: [], deny: [], ask: [] } },
  };
  try {
    const registry = createBuiltinRegistry({ backgroundTasks: { runtime }, agent: false, webSearch: false, webFetch: false });
    assert.equal(registry.get("task_preview")?.name, "task_preview");
    assert.equal(createBuiltinRegistry({ agent: false, webSearch: false, webFetch: false }).get("task_preview"), undefined);
    const script = join(cwd, "server.cjs");
    const startupLineWidth = 32;
    const logLine = "hmr-log-line\n";
    const logLineCount = 90_000;
    const expectedOutputBytes = startupLineWidth + 1 + Buffer.byteLength(logLine) * logLineCount;
    await writeFile(script, `const {createServer} = require('node:http');
const server = createServer((req,res) => { res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><title>Managed preview fixture</title><button id="action" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>'); });
server.listen(0, '127.0.0.1', () => {
  console.log(('http://127.0.0.1:' + server.address().port).padEnd(${startupLineWidth}));
  process.stdout.write(${JSON.stringify(logLine)}.repeat(${logLineCount}));
});`);
    const created = await tools.create.execute({ command: `"${process.execPath}" "${script}"`, lifecycle: "service" }, context);
    const taskId = created.data!.taskId;
    const maxBytes = 64;
    const deadline = Date.now() + 5000;
    let output = await tools.output.execute({ taskId, maxBytes }, context);
    while (output.data!.totalBytes < expectedOutputBytes && Date.now() < deadline) {
      await setTimeout(25);
      output = await tools.output.execute({ taskId, maxBytes }, context);
    }
    const firstRead = output.data!;
    assert.equal(firstRead.totalBytes, expectedOutputBytes, "child finished writing fixture logs before paging");
    assert.equal(firstRead.truncated, true, "ring buffer wrapped past 1 MB");
    assert.equal(Buffer.byteLength(firstRead.content), maxBytes);
    const modelContent = output.content[0];
    assert.equal(modelContent.type, "text");
    const url = modelContent.text.match(/Retained startup preview origins: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    assert.ok(url, "task_output must expose the startup URL in model-visible content");
    assert.deepEqual(firstRead.startupPreviewOrigins, [url]);
    assert.ok(!firstRead.content.includes(url), "the incremental log contains only the retained tail");

    const nextRead = await tools.output.execute({ taskId, offset: firstRead.nextOffset, maxBytes }, context);
    assert.equal(nextRead.data!.startupPreviewOrigins, undefined);
    assert.equal(nextRead.data!.truncated, false);
    assert.equal(nextRead.data!.nextOffset, firstRead.nextOffset + maxBytes);

    for (const otherContext of [{ ...context, sessionId: "other-session" }, { ...context, cwd: tmpdir() }]) {
      const otherRead = await tools.output.execute({ taskId, maxBytes }, otherContext);
      assert.equal(otherRead.data!.startupPreviewOrigins, undefined);
      assert.doesNotMatch(JSON.stringify(otherRead.content), /Retained startup preview origins/);
    }

    const preview = await tools.preview.execute({ taskId, url, expectedText: "Managed preview fixture" }, context);
    assert.equal(preview.data!.url, url + "/");
    assert.equal(runtime.get(taskId)?.status, "running", "handoff leaves the service alive");
    const stopped = await tools.stop.execute({ taskId, graceMs: 100 }, context);
    assert.equal(stopped.data!.status, "cancelled");
    await assert.rejects(tools.preview.execute({ taskId, url, expectedText: "Managed preview fixture" }, context), /not running/);
    await assert.rejects(fetch(url));
  } finally {
    await runtime.killAll();
    await rm(cwd, { recursive: true, force: true });
  }
});
