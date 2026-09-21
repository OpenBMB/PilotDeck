import { useEffect, useMemo, useState } from 'react';
import { assembleFrontend, resolveFrontendChoices } from './assemble';
import { generatedFrontendModules, generatedFrontendProfile } from './generated/frontend-modules';
import { slots, type Assembly, type Binding, type CompositionProfile, type Slot } from './contracts';
import { registerPermissionPanels } from '../components/chat/tools/configs/permissionPanelRegistry';
import { authenticatedFetch } from '../utils/api';

let activeAssembly: Assembly | null = null;

export function getActiveAssembly(): Assembly | null {
  return activeAssembly;
}

export function setActiveAssembly(next: Assembly | null): void {
  activeAssembly = next;
}

/** Activate registry-backed contributions and return their deterministic cleanup. */
export function activateAssembly(assembly: Assembly): () => void {
  setActiveAssembly(assembly);
  let disposed = false;
  const cleanups: Array<() => void | Promise<void>> = [];
  cleanups.push(registerPermissionPanels(assembly.permissionPanels.map((panel) => ({
    toolNames: panel.toolNames,
    component: panel.component as any,
  }))));
  for (const selection of [...assembly.selections, ...(assembly.businessSelections ?? [])]) {
    const init = selection.frontend.lifecycle?.init;
    if (!init) continue;
    Promise.resolve(init({ assembly })).then((cleanup) => {
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      if (disposed && typeof cleanup === 'function') void cleanup();
    }).catch((cause) => console.warn(`[composition] lifecycle init failed for ${selection.frontend.id}`, cause));
  }
  return () => {
    disposed = true;
    if (activeAssembly === assembly) setActiveAssembly(null);
    for (const cleanup of cleanups) void cleanup();
    for (const selection of [...assembly.selections, ...(assembly.businessSelections ?? [])]) void selection.frontend.lifecycle?.dispose?.();
  };
}

export type RuntimeModule = {
  enabled: boolean;
  provider?: string;
  implementationId?: string;
  frontendModule?: string;
  contract?: string;
  transport?: string;
  methods?: string[];
};

export type RuntimeCapabilities = {
  modules: Partial<Record<Slot, RuntimeModule>>;
  gatewayCapabilities: string[];
};

/**
 * The server is authoritative at runtime. A static build can only describe
 * what it was assembled for, so the shell must check the live projection
 * before exposing module-owned controls.
 */
export async function readRuntimeCapabilities(
  fetchImpl: typeof fetch = authenticatedFetch,
  endpoint = '/api/modules/runtime',
): Promise<RuntimeCapabilities> {
  const response = await fetchImpl(endpoint, { headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(body)) {
    throw new Error(`Runtime module capabilities are unavailable (HTTP ${response.status}).`);
  }
  const modules = isRecord(body.modules) ? body.modules : {};
  return {
    modules: modules as Partial<Record<Slot, RuntimeModule>>,
    gatewayCapabilities: Array.isArray(body.gatewayCapabilities)
      ? body.gatewayCapabilities.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

export function validateRuntimeCapabilities(assembly: Assembly, runtime: RuntimeCapabilities): string[] {
  const errors: string[] = [];
  const expectedBindings = assembly.bindings ?? Object.fromEntries(assembly.selections.map((selection) => [selection.slot, selection.binding]));
  for (const slot of slots) {
    const expected = expectedBindings[slot];
    if (!expected) continue;
    const actual = runtime.modules[slot];
    if (!actual || actual.enabled !== expected.enabled) {
      errors.push(`Runtime module state differs for ${slot}.`);
      continue;
    }
    if (!expected.enabled) continue;
    const selection = assembly.selections.find((candidate) => candidate.slot === slot);
    if (!selection) {
      errors.push(`Frontend assembly is missing enabled slot ${slot}.`);
      continue;
    }
    if (expected.provider && actual.provider !== expected.provider) {
      errors.push(`Runtime provider differs for ${slot}.`);
    }
    for (const field of ['implementationId', 'frontendModule', 'contract', 'transport'] as const) {
      const expectedValue = expected[field];
      if (expectedValue !== undefined && actual[field] !== expectedValue) {
        errors.push(`Runtime ${field} differs for ${slot}.`);
      }
    }
    for (const capability of selection.frontend.requiresCapabilities ?? []) {
      if (expected.provider !== 'pilotdeck' && !actual.methods?.includes(capability)) {
        errors.push(`${selection.frontend.id} requires runtime capability ${capability}.`);
      }
    }
  }
  return errors;
}

export function assertRuntimeCapabilities(assembly: Assembly, runtime: RuntimeCapabilities): void {
  const errors = validateRuntimeCapabilities(assembly, runtime);
  if (errors.length > 0) throw new Error(`Frontend/runtime composition mismatch: ${errors.join(' ')}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function bindingFingerprint(binding: Binding): string {
  return [binding.provider, binding.implementationId, binding.contract, binding.transport].filter(Boolean).join(':');
}

export type ModuleCompositionState = {
  assembly: Assembly | null;
  profile: CompositionProfile;
  loading: boolean;
  error: string | null;
  runtime: RuntimeCapabilities | null;
};

const staticProfile: CompositionProfile = generatedFrontendProfile as unknown as CompositionProfile;

export function assembleProfile(profile: CompositionProfile): Assembly {
  return assembleFrontend(profile, generatedFrontendModules, resolveFrontendChoices(profile, generatedFrontendModules));
}

export function resolveModuleCompositionState(
  profile: CompositionProfile,
  runtime: RuntimeCapabilities | null,
  error: string | null,
): ModuleCompositionState {
  try {
    const assembly = assembleProfile(profile);
    // Static imports are not an authorization to activate a module. Keep
    // every module-owned contribution dormant until the server projection
    // has confirmed that this exact assembly is available.
    if (error) return { assembly: null, profile, loading: false, error, runtime };
    if (!runtime) return { assembly: null, profile, loading: true, error: null, runtime };
    assertRuntimeCapabilities(assembly, runtime);
    return { assembly, profile, loading: false, error: null, runtime };
  } catch (cause) {
    return { assembly: null, profile, loading: false, error: cause instanceof Error ? cause.message : String(cause), runtime };
  }
}

/** Production shell hook: static imports are build-time selected; live bindings are runtime-authoritative. */
export function useModuleComposition(): ModuleCompositionState {
  const [runtime, setRuntime] = useState<RuntimeCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readRuntimeCapabilities()
      .then((next) => { if (!cancelled) { setRuntime(next); setError(null); } })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  const state = useMemo(
    () => resolveModuleCompositionState(staticProfile, runtime, error),
    [runtime, error],
  );

  useEffect(() => {
    if (!state.assembly || state.error) {
      setActiveAssembly(null);
      return;
    }
    return activateAssembly(state.assembly);
  }, [state.assembly, state.error]);

  return state;
}
