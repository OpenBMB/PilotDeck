import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPilotConfig } from '../../src/pilot/config/loadPilotConfig.js';
import { diffConfigSnapshots, classifyConfigChanges } from '../../src/pilot/config/classifyChanges.js';
import { SessionRouter } from '../../src/gateway/SessionRouter.js';
import { AgentSession } from '../../src/agent/session/AgentSession.js';

test('Python defaults on, validates booleans, and participates in runtime reload hashes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'pilotdeck-python-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'pilotdeck.yaml');
  const base = 'agent: { model: test/model }\nmodel:\n  providers:\n    test:\n      protocol: openai\n      url: https://example.test/v1\n      apiKey: fixture\n      models: { model: {} }\n';
  const read = () => loadPilotConfig({ configPath: path, env: { PILOT_HOME: home } });
  await writeFile(path, base);
  const on = read(); assert.equal(on.config.runtime?.python.enabled, true);
  await writeFile(path, base + 'runtime: { python: { enabled: false } }\n');
  const off = read(); assert.equal(off.config.runtime?.python.enabled, false);
  assert.notEqual(on.contentHash, off.contentHash);
  const paths = diffConfigSnapshots(on, off);
  assert.deepEqual(paths, ['runtime.python.enabled']);
  assert.deepEqual(classifyConfigChanges(paths), ['next-runtime']);
  for (const value of ['"false"', 'null', '1']) {
    await writeFile(path, base + `runtime: { python: { enabled: ${value} } }\n`);
    assert.throws(read, /runtime.python.enabled|Invalid PilotDeck config/);
  }
});

test('a preference changed during initialization recreates the next turn without disposing the initializing session', async t => {
  let finish!: (session: AgentSession) => void;
  let disposals = 0, recreations = 0;
  const old = { dispose: async () => { disposals++; } } as unknown as AgentSession;
  const replacement = { dispose: async () => {} } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0,
    createSession: () => new Promise(done => { finish = done; }),
    recreateSession: async () => { recreations++; return replacement; },
  });
  t.after(() => router.shutdown());
  const context = { sessionKey: 'python', projectKey: '/synthetic', channelKey: 'web' };
  const pending = router.getOrCreate(context);
  router.markAllDirty('config_changed');
  assert.equal(disposals, 0); finish(old);
  assert.equal(await pending, old);
  assert.equal(disposals, 0);
  assert.equal(await router.getOrCreate(context), replacement);
  assert.equal(disposals, 1); assert.equal(recreations, 1);
});

test('runtime session leases are released exactly once after asynchronous disposal', async () => {
  let finish!: () => void;
  const drained = new Promise<void>(done => { finish = done; });
  let releases = 0;
  const session = new AgentSession({ sessionId: 'python', turnRunner: { dispose: () => drained } as never, releaseSessionResources: () => { releases++; } });
  const a = session.dispose(), b = session.dispose();
  assert.equal(releases, 0); finish(); await Promise.all([a, b]);
  assert.equal(releases, 1);
});

test('resuming a dirty session never disposes a running turn; the next owning turn refreshes it', async t => {
  let disposed = 0;
  const old = { dispose: async () => { disposed++; } } as unknown as AgentSession;
  const next = { dispose: async () => {} } as unknown as AgentSession;
  const router = new SessionRouter({ idleSweepIntervalMs: 0, createSession: () => old, recreateSession: () => next });
  t.after(() => router.shutdown());
  const context = { sessionKey: 'python-active', channelKey: 'web' };
  await router.getOrCreate(context);
  router.beginTurn(context.sessionKey, 'old-turn');
  router.markAllDirty('config_changed');
  assert.equal(await router.getOrCreate(context), old);
  assert.equal(disposed, 0);
  router.endTurn(context.sessionKey, 'old-turn');
  router.beginTurn(context.sessionKey, 'new-turn');
  assert.equal(await router.getOrCreate(context, 'new-turn'), next);
  assert.equal(disposed, 1);
});
