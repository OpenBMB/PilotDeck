import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelemetrySender } from '../../src/telemetry/sender.js';

test('disabled telemetry neither loads nor overwrites a historic queue; enabled restore is bounded', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-telemetry-'));
  try {
    const file = path.join(home, 'queue.jsonl');
    const content = Array.from({ length: 20 }, (_, id) => JSON.stringify({ event: { eventId: String(id) }, attempts: 0 })).join('\n') + '\n';
    fs.writeFileSync(file, content);
    const config = { enabled: false, baseUrl: 'http://127.0.0.1:1', flushIntervalMs: 60_000, batchSize: 20, timeoutMs: 10, maxRetries: 1, maxQueueSize: 3, queueFilePath: file };
    const sender = new TelemetrySender(config, { fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(sender.snapshot().queueDepth, 0);
    await sender.shutdown(); assert.equal(fs.readFileSync(file, 'utf8'), content);
    sender.setEnabled(true); assert.equal(sender.snapshot().queueDepth, 3);
    assert.equal(sender.snapshot().dropped, 17);
    sender.setEnabled(false); await sender.shutdown();
    assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
