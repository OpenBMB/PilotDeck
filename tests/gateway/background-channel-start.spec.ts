import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startPilotDeckServer } from "../../src/cli/pilotdeckServer.js";
import type { ChannelAdapter } from "../../src/adapters/index.js";
import type { Gateway } from "../../src/gateway/index.js";

test("startPilotDeckServer listens before a background channel finishes starting", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-channel-start-"));
  const previousPilotHome = process.env.PILOT_HOME;
  process.env.PILOT_HOME = pilotHome;
  t.after(async () => {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(pilotHome, { recursive: true, force: true });
  });

  const stuckChannel: ChannelAdapter = {
    channelKey: "test",
    start: async () => new Promise(() => undefined),
  };

  const server = await startPilotDeckServer({
    gateway: {} as Gateway,
    port: 0,
    channels: [stuckChannel],
  });
  t.after(async () => {
    await server.close();
  });

  const response = await fetch(`${server.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("overlapping hot starts and a stop of one channel never run two instances at once", async (t) => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-channel-hot-start-"));
  const previousPilotHome = process.env.PILOT_HOME;
  process.env.PILOT_HOME = pilotHome;
  t.after(async () => {
    if (previousPilotHome === undefined) {
      delete process.env.PILOT_HOME;
    } else {
      process.env.PILOT_HOME = previousPilotHome;
    }
    await rm(pilotHome, { recursive: true, force: true });
  });

  let running = 0;
  let maxRunning = 0;
  let starts = 0;
  let stops = 0;
  const makeChannel = (): ChannelAdapter => ({
    channelKey: "telegram",
    start: async () => {
      // Slow start, like Telegram's getMe + deleteWebhook round trips.
      await new Promise((resolve) => setTimeout(resolve, 40));
      starts += 1;
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return {
        stop: async () => {
          stops += 1;
          running -= 1;
        },
      };
    },
  });

  const server = await startPilotDeckServer({ gateway: {} as Gateway, port: 0 });
  t.after(async () => {
    await server.close();
  });

  // Two config writes in quick succession each trigger a hot reload.
  await server.hotStartChannel(makeChannel());
  await server.hotStartChannel(makeChannel());
  await server.stopChannel("telegram", "disabled");

  assert.equal(starts, 2);
  assert.equal(stops, 2);
  assert.equal(maxRunning, 1);
  assert.equal(running, 0);
  assert.equal(server.channelState("telegram"), "stopped");
});
