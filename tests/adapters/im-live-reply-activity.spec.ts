import assert from "node:assert/strict";
import test from "node:test";

import {
  ImLiveReplyController,
  type ImLiveReplyActivity,
} from "../../src/adapters/channel/protocol/ImLiveReplyController.js";

test("resuming IM activity after an interaction respects the configured delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const activities: ImLiveReplyActivity[] = [];
  const controller = new ImLiveReplyController({
    activityDelayMs: 50,
    activityUpdateThrottleMs: 1_000,
    transport: {
      send: async () => undefined,
      pulseActivity: async (activity) => {
        activities.push(activity);
      },
    },
  });

  await controller.resumeActivity("tool", { immediate: false });
  assert.equal(activities.length, 0);

  t.mock.timers.tick(49);
  await Promise.resolve();
  assert.equal(activities.length, 0);

  t.mock.timers.tick(1);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(activities.map((activity) => activity.kind), ["tool"]);

  await controller.pauseActivity();
  t.mock.timers.tick(5_000);
  await Promise.resolve();
  assert.equal(activities.length, 1);
});

test("explicit immediate IM activity resume pulses without waiting", async () => {
  const activities: ImLiveReplyActivity[] = [];
  const controller = new ImLiveReplyController({
    activityDelayMs: 60_000,
    transport: {
      send: async () => undefined,
      pulseActivity: async (activity) => {
        activities.push(activity);
      },
    },
  });

  await controller.resumeActivity("thinking", { immediate: true });

  assert.deepEqual(activities.map((activity) => activity.kind), ["thinking"]);
  await controller.clear();
});
