import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTelemetryCollector } from "../../src/telemetry/index.js";
import { TelemetrySender } from "../../src/telemetry/sender.js";
import type { TelemetryConfig } from "../../src/telemetry/types.js";

test("disabled telemetry shutdown does not create a queue file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-disabled-telemetry-"));
  const queueFilePath = join(root, "telemetry", "queue.jsonl");
  try {
    const telemetry = createTelemetryCollector({ pilotHome: root, env: {} });

    await telemetry.shutdown();

    await assert.rejects(stat(queueFilePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telemetry enabled during its lifetime still persists pending events", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-enabled-telemetry-"));
  const queueFilePath = join(root, "telemetry", "queue.jsonl");
  const config: TelemetryConfig = {
    enabled: false,
    baseUrl: "https://telemetry.invalid",
    flushIntervalMs: 60_000,
    batchSize: 20,
    timeoutMs: 100,
    maxRetries: 0,
    maxQueueSize: 20,
    queueFilePath,
  };
  try {
    const sender = new TelemetrySender(config);
    sender.setEnabled(true);
    sender.enqueue({
      schemaVersion: "analytics.v2",
      eventId: "event-1",
      eventName: "feature_used",
      occurredAt: "2026-07-23T00:00:00.000Z",
      installationId: "installation-1",
      instanceId: "instance-1",
      deploymentMode: "source",
      commitHash: "commit-1",
      appVersion: "test",
      platform: process.platform,
      properties: {},
    });
    sender.setEnabled(false);

    await sender.shutdown();

    assert.equal((await stat(queueFilePath)).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled telemetry leaves an existing queue byte-for-byte unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-existing-telemetry-"));
  const queueFilePath = join(root, "queue.jsonl");
  const original = '{"existing":"queue"}\n';
  try {
    await writeFile(queueFilePath, original);
    const sender = new TelemetrySender({
      enabled: false,
      baseUrl: "https://telemetry.invalid",
      flushIntervalMs: 60_000,
      batchSize: 20,
      timeoutMs: 100,
      maxRetries: 0,
      maxQueueSize: 20,
      queueFilePath,
    });

    await sender.shutdown();

    assert.equal(await readFile(queueFilePath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
