import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPilotConfig, loadPilotConfigRecovering, recoverPilotConfig } from '../../../src/pilot/config/loadPilotConfig.js';

const valid = {
  schemaVersion: 1,
  agent: { model: 'test/one', maxContextTokens: 64000 },
  model: { providers: { test: { protocol: 'openai', url: 'http://127.0.0.1:1/v1', apiKey: 'preserve-key', models: { one: {} } } } },
};

test('present boolean fields recover without changing legacy defaults of missing fields', () => {
  const result = recoverPilotConfig({ ...valid, telemetry: { enabled: 'false' }, adapters: { qq: { enabled: 'yes', appId: 'keep-id', clientSecret: 'keep-secret' } }, gateway: { port: 123.5 }, memory: { includeAssistant: 'invalid' } }, { env: {} });
  assert.equal(result.snapshot.config.telemetry?.enabled, false);
  assert.equal(result.snapshot.config.adapters?.qq?.enabled, false);
  assert.equal(result.snapshot.config.adapters?.qq?.clientSecret, 'keep-secret');
  assert.equal(result.snapshot.config.gateway?.port, 18789);
  assert.equal(result.snapshot.config.memory?.enabled, true);
  assert.equal(result.raw.model && (result.raw.model as any).providers.test.apiKey, 'preserve-key');
});

test('repairs literal project-path keys and warning-only fields without losing other configuration', () => {
  const result = recoverPilotConfig({ ...valid, cron: { timezone: 'not-a-timezone', maxConcurrentRuns: -5 }, alwaysOn: { projects: { '/workspace/project.with.dots': 'invalid', '/workspace/healthy': { enabled: false } } } }, { env: {} });
  assert.equal(result.snapshot.config.agent.model.id, 'test/one');
  assert.equal((result.raw.model as any).providers.test.apiKey, 'preserve-key');
  assert.equal((result.raw.cron as any).timezone, 'UTC');
  assert.equal((result.raw.cron as any).maxConcurrentRuns, 1);
  assert.equal(Object.hasOwn((result.raw.alwaysOn as any).projects, '/workspace/project.with.dots'), false);
  assert.deepEqual((result.raw.alwaysOn as any).projects['/workspace/healthy'], { enabled: false });
});

test('invalid individual values recover while healthy siblings and keys survive', () => {
  const original = { ...valid, agent: { ...valid.agent, maxOutputTokens: -5 }, memory: { enabled: true, maxMessageChars: 'bad', includeAssistant: false }, gateway: { port: -1 } };
  const result = recoverPilotConfig(original, { env: {} });
  assert.equal(result.snapshot.config.agent.model.id, 'test/one');
  assert.equal(result.snapshot.config.agent.maxContextTokens, 64000);
  assert.equal(result.snapshot.config.agent.maxOutputTokens, undefined);
  assert.equal(result.snapshot.config.memory?.includeAssistant, false);
  assert.equal(result.snapshot.config.memory?.enabled, true);
  assert.equal(result.snapshot.config.gateway?.port, 18789);
  assert.equal(result.snapshot.config.model.providers.test.apiKey, 'preserve-key');
  assert.ok(result.snapshot.diagnostics.some(issue => issue.path === 'agent.maxOutputTokens'));
  assert.ok(result.snapshot.diagnostics.some(issue => issue.path === 'memory.maxMessageChars'));
  assert.equal(original.agent.maxOutputTokens, -5);
});

test('missing or unusable models keep the application unconfigured without fake credentials', () => {
  for (const raw of [{}, { ...valid, model: { providers: {} } }, { agent: 'broken', model: false }, { ...valid, model: { providers: { bad: {} } } }]) {
    const result = recoverPilotConfig(raw, { env: {} });
    assert.equal(result.snapshot.config.agent.model.id, '');
    assert.deepEqual(result.snapshot.config.model.providers, {});
  }
});

test('bad environment overrides fall back without persisting them into the file', () => {
  const result = recoverPilotConfig(valid, { env: { PILOT_AGENT_MODEL: 'missing/model' } });
  assert.equal(result.snapshot.config.agent.model.id, 'test/one');
  assert.equal((result.raw.agent as { model: string }).model, 'test/one');
});

test('bad optional sections and Web runtime fields never throw', () => {
  for (const section of ['memory', 'gateway', 'router', 'alwaysOn', 'cron', 'tools', 'proxy', 'extension', 'adapters', 'webui']) {
    const result = recoverPilotConfig({ ...valid, [section]: false }, { env: {} });
    assert.equal(result.snapshot.config.agent.model.id, 'test/one', section);
    assert.equal(result.snapshot.config.model.providers.test.apiKey, 'preserve-key');
  }
  const result = recoverPilotConfig({ ...valid, webui: { runtime: { serverPort: -4, vitePort: 'bad', apiTimeoutMs: -1, host: '127.0.0.1' } } }, { env: {} });
  const runtime = (result.raw.webui as { runtime: Record<string, unknown> }).runtime;
  assert.equal(runtime.serverPort, 3001);
  assert.equal(runtime.vitePort, 5173);
  assert.equal(runtime.host, '127.0.0.1');
});

test('a damaged startup file is backed up and becomes usable; strict validation stays explicit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-recovery-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'pilotdeck.yaml');
  fs.writeFileSync(file, 'schemaVersion: 1\nagent: bad\nmodel: false\nbroken: [');
  assert.throws(() => loadPilotConfig({ configPath: file, env: {} }));
  const snapshot = loadPilotConfigRecovering({ configPath: file, env: {} });
  assert.equal(snapshot.config.agent.model.id, '');
  assert.ok(snapshot.diagnostics.length);
  assert.ok(fs.readdirSync(path.join(root, 'backups', 'configuration')).length);
  assert.doesNotThrow(() => loadPilotConfigRecovering({ configPath: file, env: {} }));
});
