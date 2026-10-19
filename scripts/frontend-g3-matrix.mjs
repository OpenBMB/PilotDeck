#!/usr/bin/env node

/**
 * Frontend-only six-state acceptance matrix.
 *
 * The build matrix is intentionally separate from this check: a generated
 * bundle can compile while an installed-but-disabled business route is still
 * accidentally exposed. Each state below asserts slot bindings, business
 * route ownership, legacy route handling, settings/chat/permission ownership,
 * and the request contract that the browser adapter is allowed to use.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderGeneratedEntrypoint, selectBusinessFrontendModules, selectFrontendModules } from './generate-frontend-modules.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const outputRoot = resolve(root, 'test-results/frontend-g3-matrix');

const core = {
  agentLoop: { enabled: true, provider: 'pilotdeck' },
  skills: { enabled: true, provider: 'pilotdeck' },
  tools: { enabled: true, provider: 'pilotdeck' },
  context: { enabled: true, provider: 'pilotdeck' },
  modelProvider: { enabled: true, provider: 'pilotdeck' },
};

const staffdeckSlots = {
  ...core,
  sop: {
    enabled: true,
    implementationId: 'staffdeck.portable-sop',
    contract: 'sop.lifecycle/v2',
    transport: 'sop-http-v2',
    methods: ['prepare', 'submit'],
  },
  knowledge: {
    enabled: true,
    implementationId: 'staffdeck.knowledge',
    contract: 'staffdeck.knowledge/v1',
    transport: 'module-http-v2',
    methods: ['list_bases', 'import_document', 'get_job', 'update_document', 'query', 'resolve_citation'],
  },
};

const minimalSlots = {
  ...core,
  skills: { enabled: false },
  sop: { enabled: false },
  knowledge: { enabled: false },
};

const states = [
  {
    id: 'native-routing-installed-off',
    modules: { ...core, sop: { enabled: false }, knowledge: { enabled: false } },
    businessModules: { 'agent.routing': { enabled: false }, 'tools.permissions': { enabled: true } },
    routerEnabled: false,
    expectedBusiness: ['tools.permissions'],
    expectedSlots: ['agentLoop', 'skills', 'tools', 'context', 'modelProvider'],
  },
  {
    id: 'native-routing-enabled',
    modules: { ...core, sop: { enabled: false }, knowledge: { enabled: false } },
    businessModules: { 'agent.routing': { enabled: true }, 'tools.permissions': { enabled: true } },
    routerEnabled: true,
    expectedBusiness: ['agent.routing', 'tools.permissions'],
    expectedSlots: ['agentLoop', 'skills', 'tools', 'context', 'modelProvider'],
  },
  {
    id: 'staffdeck-routing-installed-off',
    modules: staffdeckSlots,
    businessModules: { 'agent.routing': { enabled: false }, 'tools.permissions': { enabled: true } },
    routerEnabled: false,
    expectedBusiness: ['tools.permissions'],
    expectedSlots: ['agentLoop', 'skills', 'tools', 'context', 'modelProvider', 'sop', 'knowledge'],
  },
  {
    id: 'staffdeck-routing-enabled',
    modules: staffdeckSlots,
    businessModules: { 'agent.routing': { enabled: true }, 'tools.permissions': { enabled: true } },
    routerEnabled: true,
    expectedBusiness: ['agent.routing', 'tools.permissions'],
    expectedSlots: ['agentLoop', 'skills', 'tools', 'context', 'modelProvider', 'sop', 'knowledge'],
  },
  {
    id: 'minimal-routing-installed-off',
    modules: minimalSlots,
    businessModules: { 'agent.routing': { enabled: false }, 'tools.permissions': { enabled: false } },
    routerEnabled: false,
    expectedBusiness: [],
    expectedSlots: ['agentLoop', 'tools', 'context', 'modelProvider'],
  },
  {
    id: 'minimal-routing-enabled',
    modules: minimalSlots,
    businessModules: { 'agent.routing': { enabled: true }, 'tools.permissions': { enabled: true } },
    routerEnabled: true,
    expectedBusiness: ['agent.routing', 'tools.permissions'],
    expectedSlots: ['agentLoop', 'tools', 'context', 'modelProvider'],
  },
];

const expectedNetworkBySlot = {
  agentLoop: ['execute'],
  skills: ['list', 'read'],
  tools: ['execute'],
  context: ['prepare_for_model', 'apply_tool_results', 'try_auto_compact'],
  modelProvider: ['prepare', 'stream'],
  sop: ['prepare', 'submit'],
  knowledge: ['list_bases', 'import_document', 'get_job', 'update_document', 'query', 'resolve_citation'],
};

await mkdir(outputRoot, { recursive: true });
const report = [];
for (const state of states) {
  await mkdir(resolve(outputRoot, state.id), { recursive: true });
  const profile = {
    modules: state.modules,
    frontend: { businessModules: state.businessModules },
    router: { enabled: state.routerEnabled },
  };
  const source = renderGeneratedEntrypoint(profile, resolve(outputRoot, `${state.id}/frontend-modules.ts`));
  const selected = selectFrontendModules(profile);
  const business = selectBusinessFrontendModules(profile);
  assert.deepEqual(selected.map(({ slot }) => slot), state.expectedSlots, `${state.id}: slot assembly`);
  assert.deepEqual(business.map(({ businessModuleId }) => businessModuleId), state.expectedBusiness, `${state.id}: business assembly`);
  assert.match(source, /generatedBusinessRoutePaths = \[/, `${state.id}: legacy route registry`);
  assert.match(source, /generatedBusinessPaths = \[/, `${state.id}: installed route registry`);
  if (state.expectedBusiness.includes('agent.routing')) assert.match(source, /modules\/agent-routing/);
  else assert.doesNotMatch(source, /modules\/agent-routing/);
  if (state.expectedBusiness.includes('tools.permissions')) assert.match(source, /modules\/tools-permissions/);
  else assert.doesNotMatch(source, /modules\/tools-permissions/);
  if (state.expectedSlots.includes('sop')) assert.match(source, /staffdeck-sop/);
  else assert.doesNotMatch(source, /staffdeck-sop/);
  if (state.expectedSlots.includes('knowledge')) assert.match(source, /knowledge-core/);
  else assert.doesNotMatch(source, /knowledge-core/);
  for (const item of selected) {
    const expected = expectedNetworkBySlot[item.slot];
    assert.ok(expected?.every((method) => (item.binding.methods || expected).includes(method)), `${state.id}: ${item.slot} network capability`);
  }
  const result = {
    id: state.id,
    routerInstalled: state.expectedBusiness.includes('agent.routing'),
    routerEnabled: state.routerEnabled,
    slots: selected.map(({ slot, binding }) => ({ slot, enabled: binding.enabled !== false, methods: binding.methods || expectedNetworkBySlot[slot] })),
    businessModules: business.map(({ businessModuleId }) => businessModuleId),
    legacyRoutes: ['/always-on', '/cron', '/memory'],
    settings: business.map(({ businessModuleId }) => businessModuleId === 'agent.routing' ? '/settings/agent-route' : '/settings/module/tools-permissions'),
    chatPermission: state.expectedSlots.includes('sop') ? 'sop-approval-panel' : 'tools-permission-panel',
  };
  report.push(result);
  await writeFile(resolve(outputRoot, `${state.id}/result.json`), `${JSON.stringify(result, null, 2)}\n`);
}
await writeFile(resolve(outputRoot, 'report.json'), `${JSON.stringify({ states: report, stateCount: report.length }, null, 2)}\n`);
console.log(`G3 frontend six-state matrix: ${report.length}/${states.length} PASS`);
