import { describe, expect, it } from 'vitest';
import { assembleFrontend } from './assemble';
import type { FrontendModule } from './contracts';

describe('frontend assembly', () => {
  it.each(['sop.lifecycle/v2', 'sop.lifecycle/v3'])('exposes the approval inbox for %s', contract => {
    const Inbox = () => null;
    const modules: FrontendModule[] = [
      { id: 'chat', slot: 'agentLoop', contract: 'pilotdeck.agent-loop/v1' },
      { id: 'tools', slot: 'tools', contract: 'pilotdeck.tools/v1' },
      { id: 'context', slot: 'context', contract: 'pilotdeck.context/v1' },
      { id: 'model', slot: 'modelProvider', contract: 'pilotdeck.model/v1' },
      { id: 'staffdeck.sop', slot: 'sop', contract: 'sop.lifecycle/v2', approvalInbox: Inbox },
    ];
    const profile = {
      modules: {
        agentLoop: { enabled: true, provider: 'pilotdeck' },
        tools: { enabled: true, provider: 'pilotdeck' },
        context: { enabled: true, provider: 'pilotdeck' },
        modelProvider: { enabled: true, provider: 'pilotdeck' },
        skills: { enabled: false },
        sop: { enabled: true, contract },
        knowledge: { enabled: false },
      },
      frontend: { businessModules: {} },
    } as const;
    const assembly = assembleFrontend(profile, modules, {
      agentLoop: 'chat', tools: 'tools', context: 'context', modelProvider: 'model', sop: 'staffdeck.sop',
    });
    expect(assembly.approvalInbox).toBe(Inbox);
  });
});
