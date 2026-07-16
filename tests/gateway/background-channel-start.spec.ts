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
