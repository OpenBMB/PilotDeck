// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import ModelPoolSections from './index';
const mocks = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock('../../../../hooks/usePilotDeckConfig', () => ({ usePilotDeckConfig: () => ({
  raw: JSON.stringify({ agent: { model: 'HX API/old', maxContextTokens: 128000 }, model: { providers: { 'HX API': { protocol: 'openai', models: { old: {} } } } } }),
  loading: false, error: null, commitRaw: mocks.commit, acceptServerConfig: vi.fn(),
}) }));
vi.mock('./components/ModelsSection', () => ({ default: ({ config, onChange }: any) => <div data-testid="modern-provider-workspace">
  <button onClick={() => onChange({ ...config, model: { providers: { 'HX API': { ...config.model.providers['HX API'], models: { old: { capabilities: { maxContextTokens: 65536 } } } } } } })}>Save model settings</button>
</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('shows the provider workspace without primary-model or agent-context controls', () => {
  render(<ModelPoolSections title="Models" />);
  expect(screen.getByTestId('modern-provider-workspace')).toBeTruthy();
  expect(screen.queryByLabelText('pilotDeckConfig.panels.agents.mainModel.label')).toBeNull();
  expect(screen.queryByLabelText('pilotDeckConfig.panels.agents.mainModel.contextLimit')).toBeNull();
  expect(document.querySelector('[data-model-reference="agent.model"]')).toBeNull();
  expect(mocks.commit).not.toHaveBeenCalled();
});

it('continues saving per-model context settings without rewriting the existing agent configuration', async () => {
  mocks.commit.mockResolvedValue({ ok: true });
  render(<ModelPoolSections title="Models" />);
  fireEvent.click(screen.getByRole('button', { name: 'Save model settings' }));
  await waitFor(() => expect(mocks.commit).toHaveBeenCalledOnce());
  const config = parse(mocks.commit.mock.calls[0][0]);
  expect(config.agent).toEqual({ model: 'HX API/old', maxContextTokens: 128000 });
  expect(config.model.providers['HX API'].models.old.capabilities.maxContextTokens).toBe(65536);
});
