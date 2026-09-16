import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RouterSection from './agentRoute/components/RouterSection';
import ToolsSection from './agentSearch/components/ToolsSection';
import AgentMemorySections from './agentMemory';
import type { PilotDeckConfig } from './modelPool/types';

const mocks = vi.hoisted(() => ({ raw: '', commitRaw: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/usePilotDeckConfig', () => ({
  usePilotDeckConfig: () => ({ raw: mocks.raw, commitRaw: mocks.commitRaw, loading: false, error: null }),
}));
vi.mock('./agentMemory/MemoryDataSection', () => ({ default: () => null }));
afterEach(cleanup);

const base: PilotDeckConfig = {
  agent: { model: 'test/model' },
  model: { providers: { test: { protocol: 'openai', url: 'https://example.test/v1', apiKey: 'test', models: { model: {} } } } },
};

describe('optional feature switches', () => {
  it.each([
    { name: 'unconfigured', enabled: false, sections: {} },
    { name: 'explicitly disabled', enabled: false, sections: { router: { enabled: false }, memory: { enabled: false }, tools: { webSearch: { enabled: false } } } },
    { name: 'explicitly enabled', enabled: true, sections: { router: { enabled: true }, memory: { enabled: true }, tools: { webSearch: { enabled: true } } } },
    { name: 'legacy configured', enabled: true, sections: { router: {}, memory: {}, tools: { webSearch: {} } } },
  ])('shows consistent defaults for $name features', ({ enabled, sections }) => {
    const config = { ...base, ...sections } as PilotDeckConfig;
    mocks.raw = JSON.stringify(config);
    render(<>
      <RouterSection config={config} onChange={vi.fn()} />
      <ToolsSection config={config} onChange={vi.fn()} />
      <AgentMemorySections title="Memory" projects={[]} />
    </>);
    for (const name of [
      'pilotDeckConfig.panels.router.ui.smartRouting',
      'pilotDeckConfig.panels.tools.enabled.label',
      'pilotDeckConfig.panels.memory.enabled.label',
    ]) {
      expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe(String(enabled));
    }
  });

  it('requires a user toggle to opt an unconfigured search into the saved configuration', () => {
    const onChange = vi.fn();
    render(<ToolsSection config={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'pilotDeckConfig.panels.tools.enabled.label' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tools: { webSearch: { enabled: true } } }));
  });
});
