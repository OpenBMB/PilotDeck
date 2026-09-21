import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGeneratedEntrypoint, selectFrontendModules } from './generate-frontend-modules.mjs';

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

test('rejects an explicit frontend registry key that is not registered', () => {
  assert.throws(() => selectFrontendModules({ modules: { knowledge: { enabled: true, implementationId: 'vendor.unknown', frontendModule: 'vendor.missing' } } }), /No registered frontend implementation/);
});
