import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGeneratedEntrypoint, selectBusinessFrontendModules, selectFrontendModules } from './generate-frontend-modules.mjs';

const native = {
  modules: {
    agentLoop: { enabled: true, provider: 'pilotdeck' },
    tools: { enabled: true, provider: 'pilotdeck' },
    context: { enabled: true, provider: 'pilotdeck' },
    modelProvider: { enabled: true, provider: 'pilotdeck' },
    skills: { enabled: false },
    sop: { enabled: false },
    knowledge: { enabled: false },
  },
};

test('generates imports only for selected enabled modules', () => {
  const source = renderGeneratedEntrypoint(native, '/tmp/generated/frontend-modules.ts');
  assert.match(source, /pilotdeck-chat/);
  assert.match(source, /pilotdeck-tools/);
  assert.doesNotMatch(source, /pilotdeck-skills|staffdeck-sop|staffdeck-knowledge/);
  assert.match(source, /"skills": \{\n\s+"enabled": false/);
});

test('maps StaffDeck implementations to public frontend modules', () => {
  const selected = selectFrontendModules({ modules: {
    sop: { enabled: true, implementationId: 'staffdeck.portable-sop' },
    knowledge: { enabled: true, implementationId: 'staffdeck.knowledge' },
    skills: { enabled: false },
  } });
  assert.deepEqual(selected.map(item => item.id), ['pilotdeck.chat', 'pilotdeck.tools', 'pilotdeck.context', 'pilotdeck.model', 'staffdeck.sop', 'staffdeck.knowledge']);
});

test('selects the native SOP host explicitly and preserves that selection in the browser profile', () => {
  const profile = { ...native, modules: { ...native.modules, sop: { enabled: true, implementationId: 'portable-sop', contract: 'sop.lifecycle/v3', hostAdapter: 'pilotdeck' } } };
  assert.equal(selectFrontendModules(profile).find(item => item.slot === 'sop').id, 'pilotdeck.sop');
  const source = renderGeneratedEntrypoint(profile, '/tmp/generated/frontend-modules.ts');
  assert.match(source, /modules\/pilotdeck-sop/); assert.match(source, /"hostAdapter": "pilotdeck"/);
  assert.doesNotMatch(source, /modules\/staffdeck-sop/);
});

test('rejects an explicit frontend registry key that is not registered', () => {
  assert.throws(() => selectFrontendModules({ modules: { knowledge: { enabled: true, implementationId: 'vendor.unknown', frontendModule: 'vendor.missing' } } }), /No registered frontend implementation/);
});

test('does not statically select business modules omitted from an explicit product profile', () => {
  const profile = { ...native, frontend: { businessModules: {} } };
  const source = renderGeneratedEntrypoint(profile, '/tmp/generated/frontend-modules.ts');
  assert.deepEqual(selectBusinessFrontendModules(profile), []);
  assert.doesNotMatch(source, /agent-routing|agent-resident|agent-scheduling|channels-integrations|model-providers|agent-model-selection|tools-search|tools-mcp|context-memory|workspace-office-preview|system-privacy|tools-permissions|system-telemetry|system-updates|host-preferences|chat-preferences|workspace-editor-preferences|CronV2/);
  assert.match(source, /generatedBusinessPaths/);
  assert.match(source, /generatedBusinessRoutePaths/);
  assert.match(source, /generatedBusinessPaths = \[\] as const/);
  assert.match(source, /generatedBusinessRoutePaths = \[\n\s+"\/always-on",\n\s+"\/cron",\n\s+"\/memory"/);
});

test('selects only explicitly installed business modules', () => {
  const profile = { ...native, frontend: { businessModules: {
    'agent.routing': { enabled: true },
    'agent.scheduling': { enabled: false },
  } } };
  const source = renderGeneratedEntrypoint(profile, '/tmp/generated/frontend-modules.ts');
  assert.deepEqual(selectBusinessFrontendModules(profile).map((item) => item.id), ['agent.routing']);
  assert.match(source, /agent-routing/);
  assert.doesNotMatch(source, /agent-scheduling|agent-resident|channels-integrations/);
  assert.match(source, /generatedBusinessPaths = \[\] as const/);
  assert.match(source, /generatedBusinessRoutePaths = \[\n\s+"\/always-on",\n\s+"\/cron",\n\s+"\/memory"/);
});

test('selects model-management modules independently from the model-provider slot adapter', () => {
  const profile = { ...native, frontend: { businessModules: {
    'model.providers': { enabled: true },
    'agent.model-selection': { enabled: true },
  } } };
  const source = renderGeneratedEntrypoint(profile, '/tmp/generated/frontend-modules.ts');
  assert.deepEqual(selectBusinessFrontendModules(profile).map((item) => item.id), ['model.providers', 'agent.model-selection']);
  assert.match(source, /modules\/model-providers/);
  assert.match(source, /modules\/agent-model-selection/);
  assert.match(source, /modules\/pilotdeck-model/);
});

test('selects update controls only when the product profile installs them', () => {
  const profile = { ...native, frontend: { businessModules: {
    'system.updates': { enabled: true },
  } } };
  const source = renderGeneratedEntrypoint(profile, '/tmp/generated/frontend-modules.ts');
  assert.deepEqual(selectBusinessFrontendModules(profile).map((item) => item.id), ['system.updates']);
  assert.match(source, /modules\/system-updates/);
});

test('selects tool permissions and telemetry independently', () => {
  const profile = { ...native, frontend: { businessModules: {
    'tools.permissions': { enabled: true },
    'system.telemetry': { enabled: true },
  } } };
  const source = renderGeneratedEntrypoint(profile, '/tmp/generated/frontend-modules.ts');
  assert.deepEqual(selectBusinessFrontendModules(profile).map((item) => item.id), ['tools.permissions', 'system.telemetry']);
  assert.match(source, /modules\/tools-permissions/);
  assert.match(source, /modules\/system-telemetry/);
  assert.doesNotMatch(source, /modules\/system-privacy/);
});

test('omits management credentials and endpoints from the browser composition', () => {
  const source = renderGeneratedEntrypoint({ ...native, modules: {
    ...native.modules,
    sop: {
      enabled: true,
      implementationId: 'staffdeck.portable-sop',
      management: { enabled: true, endpoint: 'https://staffdeck.internal/api/v1', apiKey: 'secret', agentId: 'agent-1', methods: ['list'] },
    },
  } }, '/tmp/generated/frontend-modules.ts');
  assert.match(source, /"management": \{\n\s+"enabled": true,\n\s+"methods": \[\n\s+"list"\n\s+\],\n\s+"agentId": "agent-1"/);
  assert.doesNotMatch(source, /staffdeck\.internal|secret/);
});
