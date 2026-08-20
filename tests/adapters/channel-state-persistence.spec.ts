import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelStatePersistence } from "../../src/adapters/channel/protocol/ChannelStatePersistence.js";

test("ChannelStatePersistence returns undefined for missing and malformed state", async (t) => {
  const stateDir = await makeTempDir(t);
  const persistence = new ChannelStatePersistence({ stateDir });

  assert.equal(await persistence.load("missing"), undefined);
});

test("ChannelStatePersistence flushes the latest state for each dirty channel", async (t) => {
  const stateDir = await makeTempDir(t);
  const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 60_000 });

  persistence.save("wecom", { activeByChatId: { user: "session-1" } });
  persistence.save("wecom", { activeByChatId: { user: "session-2" } });
  persistence.save("feishu", { projectByChatId: { chat: "/tmp/project" } });
  await persistence.flush();

  assert.deepEqual(await persistence.load("wecom"), {
    activeByChatId: { user: "session-2" },
  });
  assert.deepEqual(await persistence.load("feishu"), {
    projectByChatId: { chat: "/tmp/project" },
  });
});

test("ChannelStatePersistence creates nested directories and leaves no temporary files", async (t) => {
  const root = await makeTempDir(t);
  const stateDir = join(root, "nested", "channels");
  const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 60_000 });

  persistence.save("slack", { activeByChatId: {} });
  await persistence.flush();

  assert.deepEqual(JSON.parse(await readFile(join(stateDir, "slack.state.json"), "utf8")), {
    activeByChatId: {},
  });
  assert.deepEqual((await readdir(stateDir)).filter((file) => file.endsWith(".tmp")), []);
});

test("ChannelStatePersistence debounce writes without a real-time delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stateDir = await makeTempDir(t);
  const persistence = new ChannelStatePersistence({ stateDir, debounceMs: 50 });

  persistence.save("telegram", { activeByChatId: { chat: "session-1" } });
  assert.equal(await persistence.load("telegram"), undefined);

  t.mock.timers.tick(50);
  await persistence.flush();
  assert.deepEqual(await persistence.load("telegram"), {
    activeByChatId: { chat: "session-1" },
  });
});

async function makeTempDir(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-channel-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
