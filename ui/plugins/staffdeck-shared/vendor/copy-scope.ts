import type { PilotDeckHostCapabilityPort } from '../../../src/composition/modules/staffdeck/pilotdeck-host-capabilities';
import { staffDeckCopyClient, type ModuleRequestOptions } from '../../../src/composition/modules/staffdeck/clients';
import { isTeamScope, ENTERPRISE_AGENT_STORAGE_KEY } from '../../../src/composition/modules/staffdeck/host-contract-helpers';

export type CopyAgent = { id: string; tenant_id: string; name: string; is_overall: boolean; active: boolean; copy_target: boolean; can_manage: boolean };
const AGENT_SCOPE_KEY = ENTERPRISE_AGENT_STORAGE_KEY;

// Each mounted provider owns its directory target. The persisted scope key is
// retained so this adaptation cannot disconnect existing editor lifecycles.
export function createCopyContext(configuration: { fixedTarget?: boolean; hostCapabilities?: PilotDeckHostCapabilityPort } = {}) {
  let targetAgentId = '';
  let targetTenantId = '';
  let visibleAgentIds: Set<string> | undefined;
  const storedScope = () => { try { return window.localStorage.getItem(AGENT_SCOPE_KEY) || ''; } catch { return ''; } };
  const readScope = (): string => {
    if (configuration.fixedTarget) return targetAgentId;
    const stored = storedScope();
    if (isTeamScope(stored)) return '';
    return stored && (!visibleAgentIds || visibleAgentIds.has(stored)) ? stored : targetAgentId;
  };
  return {
    readScope,
    hostCapabilities: configuration.hostCapabilities,
    assertSelectedScope(scope: { kind: 'agent'; agentId: string } | { kind: 'team' }) {
      if (configuration.fixedTarget && (scope.kind !== 'agent' || !targetAgentId || scope.agentId !== targetAgentId)) {
        throw new Error('PUBLIC_SCOPE_EXCLUDED: this delivery uses only the authenticated configured target.');
      }
    },
    readTenant: () => {
      if (!targetTenantId) throw new Error('The StaffDeck target tenant has not been authenticated.');
      return targetTenantId;
    },
    isTarget: (agent: { id: string }) => Boolean(targetAgentId && agent.id === targetAgentId),
    async loadDirectory(options?: ModuleRequestOptions): Promise<CopyAgent[]> {
      const agents = options
        ? await staffDeckCopyClient.call<CopyAgent[]>('list_agents', {}, options)
        : await staffDeckCopyClient.call<CopyAgent[]>('list_agents');
      options?.signal?.throwIfAborted();
      if (!Array.isArray(agents)) throw new Error('The StaffDeck employee directory response is invalid.');
      const target = agents.find((agent) => agent.copy_target && !agent.is_overall);
      if (!target) throw new Error('The StaffDeck copy target is not in the visible employee directory.');
      if (!target.tenant_id) throw new Error('The StaffDeck target directory omitted its tenant.');
      targetAgentId = target.id;
      targetTenantId = target.tenant_id;
      visibleAgentIds = new Set(agents.filter(agent => !agent.is_overall).map(agent => agent.id));
      const current = storedScope();
      if (!configuration.fixedTarget && !isTeamScope(current) && !agents.some((agent) => agent.id === current && !agent.is_overall)) {
        try { window.localStorage.setItem(AGENT_SCOPE_KEY, target.id); } catch {}
      }
      return agents;
    },
  };
}
export type CopyContext = ReturnType<typeof createCopyContext>;
// Compatibility entry points for direct adapter consumers. Production providers
// use an independent context instead of mutating this default instance.
const defaultContext = createCopyContext();
export const readCopyAgentScope = defaultContext.readScope;
export const loadCopyDirectory = defaultContext.loadDirectory;
export const isCopyTarget = defaultContext.isTarget;
export const readCopyTenant = defaultContext.readTenant;

export const createFixedTargetContext = (hostCapabilities?: PilotDeckHostCapabilityPort) => createCopyContext({ fixedTarget: true, hostCapabilities });
