import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { AlwaysOnRunContextRegistry } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import { resolveAlwaysOnPaths } from "../../src/always-on/storage/AlwaysOnPaths.js";
import {
  defaultDiscoveryState,
  DiscoveryStateStore,
  getDayKey,
} from "../../src/always-on/storage/DiscoveryStateStore.js";
import type { DiscoveryRunContext } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";

test("DiscoveryStateStore returns defaults for missing, malformed, and unknown schemas", async (t) => {
  const { paths, store } = await fixture(t, "defaults");
  const now = new Date("2026-08-05T01:00:00.000Z");

  assert.deepEqual(await store.read(now), defaultDiscoveryState(now));
  await mkdir(dirname(paths.stateFile), { recursive: true });
  await writeFile(paths.stateFile, "not json", "utf8");
  assert.deepEqual(await store.read(now), defaultDiscoveryState(now));
  await writeFile(paths.stateFile, JSON.stringify({ schemaVersion: 99, todayRunCount: 100 }), "utf8");
  assert.deepEqual(await store.read(now), defaultDiscoveryState(now));
});

test("DiscoveryStateStore resets only the daily budget at UTC day rollover", async (t) => {
  const { store } = await fixture(t, "rollover");
  const dayOne = new Date("2026-08-05T23:59:00.000Z");
  const dayTwo = new Date("2026-08-06T00:01:00.000Z");

  await store.markFireStarted("run-1", dayOne);
  await store.markFireCompleted({ outcome: "failed", runId: "run-1", now: dayOne });
  const rolled = await store.read(dayTwo);

  assert.equal(rolled.todayKey, getDayKey(dayTwo));
  assert.equal(rolled.todayRunCount, 0);
  assert.equal(rolled.consecutiveFailures, 1);
  assert.equal(rolled.lastRunId, "run-1");
});

test("DiscoveryStateStore tracks failures and resets the streak after a non-failure", async (t) => {
  const { store } = await fixture(t, "outcomes");
  const now = new Date("2026-08-05T01:00:00.000Z");

  assert.equal((await store.markFireCompleted({ outcome: "failed", runId: "run-1", now })).consecutiveFailures, 1);
  assert.equal((await store.markFireCompleted({ outcome: "failed", runId: "run-2", now })).consecutiveFailures, 2);
  const recovered = await store.markFireCompleted({
    outcome: "executed",
    runId: "run-3",
    planId: "plan-1",
    now,
  });
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.lastPlanId, "plan-1");
});

test("DiscoveryStateStore starts a work cycle without retaining a stale workspace", async (t) => {
  const { store } = await fixture(t, "cycle");
  const now = new Date("2026-08-05T01:00:00.000Z");
  await store.write({
    ...defaultDiscoveryState(now),
    currentWorkspace: {
      runId: "stale-run",
      cwd: "/tmp/stale-workspace",
      strategy: "snapshot-copy",
      metadata: {},
    },
  });

  const next = await store.setActiveWorkCycleId("cycle-1", now);
  assert.equal(next.activeWorkCycleId, "cycle-1");
  assert.equal(next.currentWorkspace, undefined);
  assert.equal((await store.read(now)).currentWorkspace, undefined);
});

test("AlwaysOnRunContextRegistry keeps project lookups isolated by session key", () => {
  const registry = new AlwaysOnRunContextRegistry();
  const projectA = discoveryContext("always-on:project-a", "/projects/a");
  const projectB = discoveryContext("always-on:project-b", "/projects/b");

  registry.register(projectA);
  registry.register(projectB);

  assert.equal(registry.getDiscovery(projectA.sessionKey)?.projectKey, "/projects/a");
  assert.equal(registry.getDiscovery(projectB.sessionKey)?.projectKey, "/projects/b");
  assert.throws(() => registry.register(projectA), /already exists/);
  registry.unregister(projectA.sessionKey);
  assert.equal(registry.get(projectA.sessionKey), undefined);
  assert.equal(registry.getDiscovery(projectB.sessionKey)?.projectKey, "/projects/b");
});

async function fixture(t: test.TestContext, suffix: string) {
  const pilotHome = await mkdtemp(join(tmpdir(), `pilotdeck-always-on-${suffix}-`));
  t.after(() => rm(pilotHome, { recursive: true, force: true }));
  const paths = resolveAlwaysOnPaths({ pilotHome, projectKey: `/projects/${suffix}` });
  return { paths, store: new DiscoveryStateStore(paths) };
}

function discoveryContext(sessionKey: string, projectKey: string): DiscoveryRunContext {
  return {
    kind: "discovery",
    sessionKey,
    runId: "run-1",
    projectKey,
    paths: resolveAlwaysOnPaths({ pilotHome: "/tmp/pilot-home", projectKey }),
    startedAt: new Date("2026-08-05T01:00:00.000Z"),
    planStore: {} as DiscoveryRunContext["planStore"],
    planCallCount: 0,
  };
}
