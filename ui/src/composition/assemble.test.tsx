import { describe, expect, it } from 'vitest';
import { assembleFrontend, defaultFrontendChoice } from './assemble';
import { assembleProfile } from './runtime';
import type { FrontendModule, Slot } from './contracts';

describe('frontend assembly', () => {
  it('assembles native SOP and independent knowledge with compatible contracts together', () => {
    const modules: FrontendModule[] = [
      { id: 'pilotdeck.chat', slot: 'agentLoop', contract: 'pilotdeck.agent-loop/v1' },
      { id: 'pilotdeck.tools', slot: 'tools', contract: 'pilotdeck.tools/v1' },
      { id: 'pilotdeck.context', slot: 'context', contract: 'pilotdeck.context/v1' },
      { id: 'pilotdeck.model', slot: 'modelProvider', contract: 'pilotdeck.model/v1' },
      { id: 'pilotdeck.sop', slot: 'sop', contract: 'sop.lifecycle/v3' },
      { id: 'knowledge-core', slot: 'knowledge', contract: 'knowledge-core/v1', compatibleContracts: ['staffdeck.knowledge/v1'] },
    ];
    for (const contract of ['knowledge-core/v1', 'staffdeck.knowledge/v1']) {
      const bindings = {
        agentLoop: { enabled: true, provider: 'pilotdeck' },
        tools: { enabled: true, provider: 'pilotdeck' },
        context: { enabled: true, provider: 'pilotdeck' },
        modelProvider: { enabled: true, provider: 'pilotdeck' },
        skills: { enabled: false },
        sop: { enabled: true, contract: 'sop.lifecycle/v3', hostAdapter: 'pilotdeck' },
        knowledge: { enabled: true, contract, frontendModule: 'staffdeck.knowledge' },
      } as const;
      const choices = Object.fromEntries(Object.entries(bindings).map(([slot, binding]) => [
        slot, defaultFrontendChoice(binding, slot as Slot),
      ]));
      const assembly = assembleFrontend({ modules: bindings, frontend: { businessModules: {} } }, modules, choices);
      expect(assembly.selections.map(selection => selection.frontend.id)).toContain('pilotdeck.sop');
      expect(assembly.selections.map(selection => selection.frontend.id)).toContain('knowledge-core');
      const projectAssembly = assembleProfile({ modules: bindings, frontend: { businessModules: {} } }, true);
      expect(projectAssembly.selections.map(selection => selection.frontend.id)).toContain('pilotdeck.sop');
      expect(projectAssembly.selections.map(selection => selection.frontend.id)).toContain('knowledge-core');
    }
  });

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
