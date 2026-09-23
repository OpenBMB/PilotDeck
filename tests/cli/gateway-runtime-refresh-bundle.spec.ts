import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { GatewayRuntimeRefreshBundle } from "../../src/cli/GatewayRuntimeRefreshBundle.js";

type ConfigEvent = {
  changedPaths: string[];
  changeClasses: string[];
};

function createConfigStore() {
  const listeners = new Set<(event: ConfigEvent) => void>();
  let reloadEvent: ConfigEvent = { changedPaths: [], changeClasses: [] };
  return {
    store: {
      subscribe(listener: (event: ConfigEvent) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async reload() {
        for (const listener of listeners) listener(reloadEvent);
      },
    },
    publish(event: ConfigEvent) {
      for (const listener of listeners) listener(event);
    },
    setReloadEvent(event: ConfigEvent) { reloadEvent = event; },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("gateway runtime refresh bundle keeps config reload, router dirtying, and server notification in their existing owners", async () => {
  const config = createConfigStore();
  const calls: string[] = [];
  const broadcasts: Array<{ name: string; payload?: unknown }> = [];
  const bundle = new GatewayRuntimeRefreshBundle({
    configStore: config.store,
    registry: {
      async reload() { calls.push("registry:reload"); },
      invalidate(projectKey) { calls.push(`invalidate:${projectKey ?? "all"}`); },
    },
    memoryMaintenance: {
      schedule(projectKey) { calls.push(`maintenance:${projectKey}`); },
    },
    getRouter: () => ({
      markAllDirty(reason) { calls.push(`dirty-all:${reason}`); return 1; },
      markProjectDirty(projectKey, reason) { calls.push(`dirty-project:${projectKey}:${reason}`); return 1; },
      cachedSessionCount() { return 3; },
      snapshotSession(sessionKey) { return { messages: [{ role: "user", content: [{ type: "text", text: sessionKey }] }] }; },
    }),
    projectRoot: "/project",
    memoryDiagnosticsEnabled: true,
    logMemoryDiagnostic: (input) => calls.push(`diagnostic:${input.event}`),
    summarizeMessages: () => ({ messageCount: 1 }),
    warn: (message) => calls.push(`warn:${message}`),
    log: (message) => calls.push(`log:${message}`),
  });
  bundle.attach();
  bundle.bindServer({
    broadcastNotification(name, payload) { broadcasts.push({ name, payload }); },
  });

  config.publish({ changedPaths: ["agent.model"], changeClasses: ["hot-reload"] });
  await flush();
  assert.deepEqual(calls.slice(0, 4), [
    "log:[pilotdeck] Config reloaded, refreshing runtimes: agent.model",
    "registry:reload",
    "diagnostic:runtime_invalidated",
    "dirty-all:config_changed",
  ]);
  assert.deepEqual(broadcasts, [{
    name: "config_changed",
    payload: { changedPaths: ["agent.model"], changeClasses: ["hot-reload"] },
  }]);

  const runtimeReloads = calls.filter((call) => call === "registry:reload").length;
  const dirtyCalls = calls.filter((call) => call === "dirty-all:config_changed").length;
  config.publish({
    changedPaths: ["runPolicy.failureGuard.modelFailureLimit"],
    changeClasses: ["next-request"],
  });
  await flush();
  assert.equal(calls.filter((call) => call === "registry:reload").length, runtimeReloads);
  assert.equal(calls.filter((call) => call === "dirty-all:config_changed").length, dirtyCalls);
  assert.ok(calls.includes(
    "log:[pilotdeck] Config reloaded (runPolicy applies next turn): runPolicy.failureGuard.modelFailureLimit",
  ));
  assert.deepEqual(broadcasts.at(-1), {
    name: "config_changed",
    payload: {
      changedPaths: ["runPolicy.failureGuard.modelFailureLimit"],
      changeClasses: ["next-request"],
    },
  });

  await bundle.reloadExtensions({ projectKey: "/project-a", changedPaths: ["plugin.ts"] });
  await bundle.reloadExtensions();
  assert.ok(calls.includes("invalidate:/project-a"));
  assert.ok(calls.includes("dirty-project:/project-a:extension_changed"));
  assert.ok(calls.includes("invalidate:all"));
  assert.ok(calls.includes("dirty-all:extension_changed"));

  config.setReloadEvent({ changedPaths: ["router.enabled"], changeClasses: ["hot-reload"] });
  assert.deepEqual(await bundle.reloadConfig(), { reloaded: true, changedPaths: ["router.enabled"] });
  await bundle.afterTurnCompleted({ sessionKey: "s", projectKey: undefined, runId: "run" });
  assert.ok(calls.includes("maintenance:/project"));

  bundle.dispose();
  const reloads = calls.filter((call) => call === "registry:reload").length;
  config.publish({ changedPaths: ["ignored"], changeClasses: ["hot-reload"] });
  await flush();
  assert.equal(calls.filter((call) => call === "registry:reload").length, reloads);
});

test("local Gateway management callbacks delegate to refresh composition and release its config subscription", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-runtime-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), CONFIG, "utf8");

  const local = createLocalGateway({ projectRoot: root, pilotHome: root });
  t.after(() => local.dispose());
  const invalidated: Array<string | undefined> = [];
  const reloads = { count: 0 };
  const invalidate = local.registry.invalidate.bind(local.registry);
  const reload = local.registry.reload.bind(local.registry);
  local.registry.invalidate = (projectKey?: string) => {
    invalidated.push(projectKey);
    invalidate(projectKey);
  };
  local.registry.reload = async () => {
    reloads.count += 1;
    await reload();
  };

  const extensionResult = await local.gateway.reloadExtensions!({
    projectKey: root,
    changedPaths: ["plugin.ts"],
  });
  assert.deepEqual(extensionResult, { reloaded: true, changedPaths: ["plugin.ts"] });
  assert.deepEqual(invalidated, [root]);

  await writeFile(
    join(root, "pilotdeck.yaml"),
    CONFIG.replace("  maxOutputTokens: 1024", "  maxOutputTokens: 1025"),
    "utf8",
  );
  assert.deepEqual(await local.gateway.reloadConfig!(), {
    reloaded: true,
    changedPaths: ["agent.maxOutputTokens"],
  });
  await waitFor(() => reloads.count === 1);

  await local.dispose();
  await writeFile(
    join(root, "pilotdeck.yaml"),
    CONFIG.replace("  maxOutputTokens: 1024", "  maxOutputTokens: 1026"),
    "utf8",
  );
  await local.configStore.reload("after-dispose");
  await flush();
  assert.equal(reloads.count, 1, "disposed local Gateway must not retain the config refresh subscription");
});

const CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 8192
  maxOutputTokens: 1024
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 8192
            maxOutputTokens: 1024
`;

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("Expected Gateway runtime refresh to complete.");
}
