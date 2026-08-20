import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ModelRuntime } from "../../src/model/index.js";
import {
  createCollisionResistantProjectId,
  createProjectId,
  getPilotConfigFilePath,
} from "../../src/pilot/index.js";
import {
  createPilotConfigStore,
  loadPilotConfig,
  PilotConfigError,
} from "../../src/pilot/config/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import { SessionRouterStore } from "../../src/router/session/SessionRouterStore.js";
import { FileHistoryStore } from "../../src/session/filesystem/FileHistoryStore.js";
import { listWebProjects } from "../../src/web/server/listProjects.js";

test("PilotConfigStore keeps its last valid snapshot when reload fails", async (t) => {
  const pilotHome = await tempDir(t, "pilotdeck-config-store-");
  const configPath = getPilotConfigFilePath(pilotHome);
  await writeJson(configPath, validConfig());
  const store = await createPilotConfigStore({ env: { PILOT_HOME: pilotHome } });
  const previous = store.getSnapshot();

  await writeJson(configPath, {
    schemaVersion: 1,
    agent: { model: "missing/model" },
    model: { providers: {} },
  });

  await assert.rejects(() => store.reload("regression-test"), PilotConfigError);
  assert.equal(store.getSnapshot(), previous);
  assert.equal(store.getDiagnostics().some(diagnostic => diagnostic.severity === "fatal"), true);
});

test("conflicting router default model is normalized to the main agent model", async (t) => {
  const pilotHome = await tempDir(t, "pilotdeck-config-conflict-");
  await writeJson(getPilotConfigFilePath(pilotHome), {
    ...validConfig(),
    router: { scenarios: { default: "google/gemini-2.0-flash" } },
  });

  const snapshot = loadPilotConfig({ env: { PILOT_HOME: pilotHome } });
  assert.equal(snapshot.config.agent.model.id, "openai/gpt-4o-mini");
  assert.equal(snapshot.config.router?.scenarios?.default.id, "openai/gpt-4o-mini");
  assert.equal(snapshot.diagnostics.some(diagnostic => diagnostic.code === "CONFIG_MODEL_CONFLICT"), true);
});

test("RouterRuntime shutdown preserves an externally owned session store", async () => {
  const sessionStore = new SessionRouterStore();
  sessionStore.set({
    sessionId: "session-1",
    isSubagent: false,
    stickyProvider: "openai",
    stickyModel: "gpt-4o-mini",
    orchestrating: false,
    updatedAt: 1,
  });
  const runtime = createRouterRuntime({
    scenarios: { default: { id: "openai/gpt-4o-mini", provider: "openai", model: "gpt-4o-mini" } },
  }, {
    modelRuntime: {} as ModelRuntime,
    sessionStore,
  });

  await runtime.shutdown();
  assert.equal(sessionStore.get("session-1", false)?.stickyModel, "gpt-4o-mini");
});

test("collision-resistant project ids distinguish paths with the same legacy slug", () => {
  const dashed = "/Users/test/claude-code";
  const nested = "/Users/test/claude/code";

  assert.equal(createProjectId(dashed), createProjectId(nested));
  assert.notEqual(createCollisionResistantProjectId(dashed), createCollisionResistantProjectId(nested));
});

test("project enumeration uses the .cwd marker instead of lossy id decoding", async (t) => {
  const pilotHome = await tempDir(t, "pilotdeck-project-marker-");
  const workspace = await tempDir(t, "pilotdeck-workspace-marker-");
  const projectDir = join(pilotHome, "projects", createProjectId(workspace));
  await mkdir(join(projectDir, "chats"), { recursive: true });
  await writeFile(join(projectDir, ".cwd"), `${workspace}\n`, "utf8");

  const result = await listWebProjects({ pilotHome });
  assert.equal(result.projects.some(project => project.fullPath === workspace), true);
});

test("FileHistoryStore captures only the first pre-edit value per message", async (t) => {
  const workspace = await tempDir(t, "pilotdeck-history-idempotent-");
  const file = join(workspace, "src", "value.ts");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "before", "utf8");
  const backupDir = join(workspace, ".backups");
  const store = new FileHistoryStore({ backupDir });

  await store.trackEdit(file, "message-1");
  await writeFile(file, "after", "utf8");
  await store.trackEdit(file, "message-1");
  const backup = store.getState().snapshots[0]?.trackedFileBackups[file];

  assert.ok(backup?.backupFileName);
  assert.equal(await readFile(join(backupDir, backup.backupFileName), "utf8"), "before");
});

test("FileHistoryStore rewind restores edited files and removes newly created files", async (t) => {
  const workspace = await tempDir(t, "pilotdeck-history-rewind-");
  const existing = join(workspace, "existing.txt");
  const created = join(workspace, "created.txt");
  await writeFile(existing, "before", "utf8");
  const store = new FileHistoryStore({ backupDir: join(workspace, ".backups") });

  await store.trackEdit(existing, "message-1");
  await store.trackEdit(created, "message-1");
  await writeFile(existing, "after", "utf8");
  await writeFile(created, "new", "utf8");
  await store.rewind("message-1");

  assert.equal(await readFile(existing, "utf8"), "before");
  await assert.rejects(() => readFile(created, "utf8"), { code: "ENOENT" });
});

test("FileHistoryStore evicts old snapshots and unreferenced backups", async (t) => {
  const workspace = await tempDir(t, "pilotdeck-history-eviction-");
  const file = join(workspace, "value.txt");
  const backupDir = join(workspace, ".backups");
  await writeFile(file, "v0", "utf8");
  const store = new FileHistoryStore({ backupDir, maxSnapshots: 2 });

  for (let index = 0; index < 4; index += 1) {
    await writeFile(file, `v${index}`, "utf8");
    await store.trackEdit(file, `message-${index}`);
    await store.makeSnapshot(`message-${index}`);
  }

  assert.deepEqual(store.getState().snapshots.map(snapshot => snapshot.messageId), ["message-2", "message-3"]);
});

function validConfig() {
  return {
    schemaVersion: 1,
    agent: { model: "openai/gpt-4o-mini" },
    model: {
      providers: {
        openai: { apiKey: "test", models: { "gpt-4o-mini": {} } },
        google: { apiKey: "test", models: { "gemini-2.0-flash": {} } },
      },
    },
  };
}

async function tempDir(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}
