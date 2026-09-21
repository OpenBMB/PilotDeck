#!/usr/bin/env node
/**
 * Generate the browser-side static module entrypoint from one PilotDeck
 * profile. Only selected module files are imported by the generated output;
 * disabled implementations therefore do not enter the build. Compatible
 * unknown implementations reuse the slot's public adapter unless a profile
 * selects an explicit frontendModule key.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { resolveFrontendProfile } from './frontend-profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = resolve(root, 'ui/src/composition/generated/frontend-modules.ts');

const SLOT_ORDER = ['agentLoop', 'skills', 'tools', 'context', 'modelProvider', 'sop', 'knowledge'];
const DEFAULT_FRONTEND = {
  agentLoop: 'pilotdeck.chat',
  skills: 'pilotdeck.skills',
  tools: 'pilotdeck.tools',
  context: 'pilotdeck.context',
  modelProvider: 'pilotdeck.model',
  sop: 'staffdeck.sop',
  knowledge: 'staffdeck.knowledge',
};
const IMPLEMENTATION_FRONTENDS = {
  'staffdeck.portable-sop': 'staffdeck.sop',
  'staffdeck.knowledge': 'staffdeck.knowledge',
};
const MODULE_SOURCES = {
  'pilotdeck.chat': 'modules/pilotdeck-chat',
  'pilotdeck.skills': 'modules/pilotdeck-skills',
  'pilotdeck.tools': 'modules/pilotdeck-tools',
  'pilotdeck.context': 'modules/pilotdeck-context',
  'pilotdeck.model': 'modules/pilotdeck-model',
  'staffdeck.sop': 'modules/staffdeck-sop',
  'staffdeck.knowledge': 'modules/staffdeck-knowledge',
  'fixture.knowledge-search': 'modules/fixture-knowledge-search',
  'agent.routing': 'modules/agent-routing',
  'agent.resident': 'modules/agent-resident',
  'agent.scheduling': 'modules/agent-scheduling',
  'channels.integrations': 'modules/channels-integrations',
  'model.providers': 'modules/model-providers',
  'agent.model-selection': 'modules/agent-model-selection',
  'tools.search': 'modules/tools-search',
  'tools.mcp': 'modules/tools-mcp',
  'context.memory': 'modules/context-memory',
  'workspace.office-preview': 'modules/workspace-office-preview',
  'system.advanced': 'modules/system-advanced',
  'system.privacy': 'modules/system-privacy',
};

const LEGACY_BUSINESS_MODULES = [
  'agent.routing', 'agent.resident', 'agent.scheduling', 'channels.integrations',
  'model.providers', 'agent.model-selection',
  'tools.search', 'tools.mcp', 'context.memory',
  'workspace.office-preview',
  'system.advanced',
  'system.privacy',
];

// Route ownership remains declarative even when a capability is omitted. This
// lets the shell show its generic unavailable state without importing a
// feature implementation to discover its route.
const BUSINESS_ROUTE_PATHS = {
  'agent.resident': ['/always-on'],
  'agent.scheduling': ['/cron'],
  'context.memory': ['/memory'],
};

export function selectFrontendModules(profile) {
  const bindings = resolveBindings(profile?.modules);
  const selected = [];
  for (const slot of SLOT_ORDER) {
    const binding = bindings[slot];
    if (binding?.enabled === false) continue;
    const id = binding?.frontendModule
      ?? IMPLEMENTATION_FRONTENDS[binding?.implementationId]
      ?? (binding?.implementationId ? null : DEFAULT_FRONTEND[slot]);
    if (!id || !MODULE_SOURCES[id]) {
      throw new Error(`No registered frontend implementation for ${slot}${binding?.implementationId ? ` (${binding.implementationId})` : ''}.`);
    }
    selected.push({ slot, id, binding });
  }
  return selected;
}

export function selectBusinessFrontendModules(profile) {
  const configured = profile?.frontend?.businessModules;
  const bindings = configured === undefined
    ? Object.fromEntries(LEGACY_BUSINESS_MODULES.map((id) => [id, { enabled: true }]))
    : configured;
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) {
    throw new Error('frontend.businessModules must be an object.');
  }
  const selected = [];
  for (const [businessModuleId, binding] of Object.entries(bindings)) {
    if (binding?.enabled === false) continue;
    const id = binding?.frontendModule ?? businessModuleId;
    if (!MODULE_SOURCES[id]) {
      throw new Error(`No registered frontend business implementation for ${businessModuleId}${binding?.frontendModule ? ` (${binding.frontendModule})` : ''}.`);
    }
    selected.push({ businessModuleId, id, binding: { enabled: true, ...(binding?.frontendModule ? { frontendModule: binding.frontendModule } : {}) } });
  }
  return selected;
}

export function renderGeneratedEntrypoint(profile, outputPath = defaultOutput, compositionRoot = resolve(root, 'ui/src/composition')) {
  const selected = selectFrontendModules(profile);
  const businessSelected = selectBusinessFrontendModules(profile);
  const allSelected = [...selected, ...businessSelected];
  const outputDir = dirname(outputPath);
  const imports = allSelected.map(({ id }, index) => {
    const importPath = relative(outputDir, resolve(compositionRoot, MODULE_SOURCES[id])).replaceAll('\\', '/');
    const normalized = importPath.startsWith('.') ? importPath : `./${importPath}`;
    return `import module${index} from '${normalized}';`;
  });
  const modules = [
    ...selected.map((item, index) => `  Object.assign({ slot: '${item.slot}' }, module${index}),`),
    ...businessSelected.map((item, index) => `  module${selected.length + index},`),
  ].join('\n');
  // Preserve every resolved binding, including explicit enabled:false slots.
  // Dropping disabled bindings would make the browser-side defaults silently
  // re-enable Skills after a normal build.
  const profileJson = JSON.stringify({
    modules: resolveBindings(profile?.modules),
    frontend: { businessModules: Object.fromEntries(businessSelected.map((item) => [item.businessModuleId, item.binding])) },
  }, null, 2);
  const businessPaths = JSON.stringify(
    Object.values(BUSINESS_ROUTE_PATHS).flat(),
    null,
    2,
  );
  return `// Generated by scripts/generate-frontend-modules.mjs. Do not edit.\n${imports.join('\n')}\n\nexport const generatedFrontendModules = [\n${modules}\n] as const;\n\nexport const generatedBusinessPaths = ${businessPaths} as const;\n\nexport const generatedFrontendProfile = ${profileJson} as const;\n`;
}

export async function generateFrontendModules({ profilePath, outputPath = defaultOutput } = {}) {
  const resolvedProfilePath = profilePath ?? resolveFrontendProfile().path;
  const profile = parse(await readFile(resolvedProfilePath, 'utf8'));
  const source = renderGeneratedEntrypoint(profile, outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source, 'utf8');
  return { outputPath, profilePath: resolvedProfilePath };
}

function resolveBindings(modules = {}) {
  return Object.fromEntries(SLOT_ORDER.map((slot) => [slot, modules[slot] ?? (
    slot === 'sop' || slot === 'knowledge'
      ? { enabled: false }
      : { enabled: true, provider: 'pilotdeck' }
  )]));
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    args.set(value.slice(2), argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedProfile = args.get('profile');
  const profilePath = requestedProfile
    ? resolve(root, String(requestedProfile))
    : resolveFrontendProfile().path;
  const outputPath = resolve(root, String(args.get('out') || defaultOutput));
  const result = await generateFrontendModules({ profilePath, outputPath });
  process.stdout.write(`${result.outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
