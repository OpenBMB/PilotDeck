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
test("managed service starts, exposes its real URL, verifies content and stops", { timeout: 15000 }, async () => {
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
    await writeFile(script, `const {createServer} = require('node:http');
const server = createServer((req,res) => { res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><title>Managed preview fixture</title><button id="action" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>'); });
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));`);
    const created = await tools.create.execute({ command: `"${process.execPath}" "${script}"`, lifecycle: "service" }, context);
    const taskId = created.data!.taskId;
    let url = "";
    const deadline = Date.now() + 5000;
    while (!url && Date.now() < deadline) {
      const output = await tools.output.execute({ taskId }, context);
      url = output.data!.content.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? "";
      if (!url) await setTimeout(25);
    }
    assert.ok(url, "child must publish its actual ephemeral port");
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
