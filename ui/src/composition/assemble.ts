import { MODULE_SLOT_CONTRACTS } from '../../../src/composition/contracts';
import { slots, type Assembly, type Binding, type BusinessBinding, type CompositionProfile, type FrontendModule, type Slot, type Selection as ModuleSelection } from './contracts';

export const slotContracts: Record<Slot, string> = {
  ...MODULE_SLOT_CONTRACTS,
  sop: 'sop.lifecycle/v2',
};
export const optionalSlots = new Set<Slot>(['skills', 'knowledge', 'sop']);

/** Compatibility for profiles written before business capabilities were explicit. */
export const legacyBusinessModuleIds = [
  'agent.routing', 'agent.resident', 'agent.scheduling', 'channels.integrations',
  'model.providers', 'agent.model-selection',
  'tools.search', 'tools.mcp', 'context.memory',
  'workspace.office-preview',
  'system.advanced',
  'tools.permissions', 'system.telemetry',
  'system.updates',
  'host.preferences', 'chat.preferences', 'workspace.editor-preferences',
] as const;

export function resolveBusinessBindings(profile: CompositionProfile): Record<string, BusinessBinding> {
  const explicit = profile.frontend?.businessModules;
  if (!explicit) return Object.fromEntries(legacyBusinessModuleIds.map((id) => [id, { enabled: true }]));
  return Object.fromEntries(Object.entries(explicit).map(([id, binding]) => [id, { enabled: binding?.enabled !== false, ...(binding?.frontendModule ? { frontendModule: binding.frontendModule } : {}) }]));
}

export function defaultFrontendChoice(binding: Binding, slot: Slot): string {
  if (binding.frontendModule) return binding.frontendModule === 'staffdeck.knowledge' ? 'knowledge-core' : binding.frontendModule;
  if (slot === 'sop' && binding.hostAdapter === 'pilotdeck') return 'pilotdeck.sop';
  if (binding.implementationId === 'staffdeck.portable-sop' || (slot === 'sop' && binding.contract === 'sop.lifecycle/v3')) return 'staffdeck.sop';
  if (binding.implementationId === 'staffdeck.knowledge') return 'knowledge-core';
  if (binding.implementationId) return binding.implementationId;
  if (binding.provider === 'pilotdeck') {
    const frontendSlot = slot === 'agentLoop' ? 'chat' : slot === 'modelProvider' ? 'model' : slot;
    return `pilotdeck.${frontendSlot}`;
  }
  return `${binding.provider ?? 'pilotdeck'}.${slot}`;
}

export function resolveFrontendChoices(
  profile: CompositionProfile,
  catalog: readonly FrontendModule[],
): Partial<Record<Slot, string>> {
  const bindings = resolveBindings(profile);
  return Object.fromEntries(slots.map((slot) => {
    const preferred = defaultFrontendChoice(bindings[slot], slot);
    const selected = catalog.find((module) => module.id === preferred);
    return [slot, selected?.id ?? preferred];
  })) as Partial<Record<Slot, string>>;
}

// Omitted native bindings preserve the backend's default composition.
export function resolveBindings(profile: CompositionProfile): Record<Slot, Binding> {
  return Object.fromEntries(slots.map(slot => [slot, profile.modules?.[slot] ?? (
    slot === 'knowledge' || slot === 'sop'
      ? { enabled: false }
      : { enabled: true, provider: 'pilotdeck' }
  )])) as Record<Slot, Binding>;
}

export function assembleFrontend(
  profile: CompositionProfile,
  catalog: readonly FrontendModule[],
  choices: Partial<Record<Slot, string>>,
): Assembly {
  const bindings = resolveBindings(profile);
  const businessBindings = resolveBusinessBindings(profile);
  const result: Assembly = { bindings, selections: [], businessBindings, businessSelections: [], pages: [], settings: [], chatSurface: null, approvalInbox: null, chatExtensions: [], permissionPanels: [], toolRenderers: [], artifactRenderers: [], fileRenderers: [], markdownLinkRenderers: [], historyFallbacks: catalog.flatMap((module) => module.historyFallback ? [{ moduleId: module.id, contribution: module.historyFallback }] : []) };
  const ids = new Set<string>();
  for (const module of catalog) {
    if (ids.has(module.id)) throw new Error(`Duplicate frontend module: ${module.id}`);
    ids.add(module.id);
  }
  for (const slot of slots) {
    const binding = bindings[slot];
    if (!binding.enabled) {
      if (!optionalSlots.has(slot)) throw new Error(`Required slot cannot be disabled: ${slot}`);
      continue;
    }
    const contract = binding.contract ?? slotContracts[slot];
    // SOP v4 exposes execution tools through AgentLoop without a management UI.
    if (slot === 'sop' && contract === 'sop.lifecycle/v4') continue;
    const portableSop = slot === 'sop' && contract === 'sop.lifecycle/v3';
    if (contract !== slotContracts[slot] && !portableSop && !(slot === 'knowledge' && contract === 'knowledge-core/v1')) throw new Error(`Unsupported backend contract: ${slot} / ${contract}`);
    const frontend = catalog.find(module => module.id === choices[slot]);
    if (!frontend || frontend.slot !== slot) throw new Error(`Missing frontend for enabled slot: ${slot}`);
    if (frontend.contract !== contract && !frontend.compatibleContracts?.includes(contract) && !(portableSop && frontend.id === 'staffdeck.sop'
      && frontend.contract === 'sop.lifecycle/v2')) throw new Error(`Frontend contract mismatch: ${frontend.id}`);
    if (frontend.frontendApiVersion && frontend.frontendApiVersion !== 'frontend-module/v1') {
      throw new Error(`Frontend API version mismatch: ${frontend.id}`);
    }
    for (const dependency of frontend.requires ?? []) {
      if (!bindings[dependency].enabled) throw new Error(`${frontend.id} requires ${dependency}`);
    }
    for (const capability of frontend.requiresCapabilities ?? []) {
      if (!binding.methods?.includes(capability) && binding.provider !== 'pilotdeck') {
        throw new Error(`${frontend.id} requires backend capability ${capability}`);
      }
    }
    result.selections.push({ slot, binding, frontend });
    addModuleContributions(result, frontend);
  }
  for (const [businessModuleId, binding] of Object.entries(businessBindings)) {
    if (binding.enabled === false) continue;
    const frontend = catalog.find((module) => module.id === (binding.frontendModule ?? businessModuleId));
    // Legacy profiles predate explicit business module declarations. Preserve
    // their native defaults only when this catalog actually contains the
    // optional contribution; explicit profiles remain strict below.
    if (!frontend && !profile.frontend?.businessModules) continue;
    if (!frontend || frontend.businessModuleId !== businessModuleId) {
      throw new Error(`Missing frontend business module: ${businessModuleId}`);
    }
    if (frontend.frontendApiVersion && frontend.frontendApiVersion !== 'frontend-module/v1') {
      throw new Error(`Frontend API version mismatch: ${frontend.id}`);
    }
    for (const dependency of frontend.requires ?? []) {
      if (!bindings[dependency].enabled) throw new Error(`${frontend.id} requires ${dependency}`);
    }
    result.businessSelections.push({ businessModuleId, binding, frontend });
    addModuleContributions(result, frontend);
  }
  validateFrontendDependencyGraph(result.selections);
  return result;
}

function addModuleContributions(result: Assembly, frontend: FrontendModule): void {
  if (frontend.chatSurface) {
    if (result.chatSurface) throw new Error(`Duplicate chat surface: ${frontend.chatSurface.id}`);
    result.chatSurface = frontend.chatSurface;
  }
  if (frontend.approvalInbox) {
    if (result.approvalInbox) throw new Error('Duplicate approval inbox');
    result.approvalInbox = frontend.approvalInbox;
  }
  for (const link of frontend.markdownLinkRenderers ?? []) {
    const links = result.markdownLinkRenderers ??= [];
    if (!/^[a-z][a-z0-9+.-]*:$/.test(link.protocol) || ['javascript:', 'data:', 'vbscript:'].includes(link.protocol)) throw new Error('Invalid markdown link protocol');
    if (links.some(existing => existing.id === link.id || existing.protocol === link.protocol)) throw new Error(`Duplicate markdown link renderer: ${link.id}`);
    links.push(link);
  }
  for (const kind of ['pages', 'settings', 'chatExtensions', 'permissionPanels', 'toolRenderers', 'artifactRenderers', 'fileRenderers'] as const) {
    const contributions = frontend[kind] ?? [];
    for (const contribution of contributions) {
      if (result[kind].some(existing => existing.id === contribution.id)) throw new Error(`Duplicate ${kind}: ${contribution.id}`);
      if (kind === 'pages') {
        const page = contribution as NonNullable<FrontendModule['pages']>[number];
        if (result.pages.some(existing => existing.path === page.path)) throw new Error(`Duplicate route: ${page.path}`);
        result.pages.push(page);
      } else result[kind].push(contribution);
    }
  }
}

function validateFrontendDependencyGraph(selections: ModuleSelection[]): void {
  const bySlot = new Map(selections.map(selection => [selection.slot, selection.frontend]));
  const visiting = new Set<Slot>();
  const visited = new Set<Slot>();
  const visit = (slot: Slot) => {
    if (visited.has(slot)) return;
    if (visiting.has(slot)) throw new Error(`Circular frontend dependency: ${slot}`);
    visiting.add(slot);
    for (const dependency of bySlot.get(slot)?.requires ?? []) {
      if (bySlot.has(dependency)) visit(dependency);
    }
    visiting.delete(slot);
    visited.add(slot);
  };
  for (const selection of selections) visit(selection.slot);
}
