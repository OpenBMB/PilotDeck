import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Settings from './Settings';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), commit: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock('../../hooks/usePilotDeckConfig', () => ({
  PilotDeckConfigProvider: ({ children }) => children,
  usePilotDeckConfig: () => ({
    raw: JSON.stringify({
      agent: { model: 'provider/default', subagents: {
        profiles: { vision: { description: 'Review screenshots.', model: 'provider/vision' } },
      } },
      model: { providers: { provider: {
        protocol: 'openai', url: 'https://example.test/v1',
        models: { default: {}, vision: {} },
      } } },
    }),
    commitRaw: mocks.commit,
    loading: false,
    saving: false,
  }),
}));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

function Page() {
  const { section } = useParams();
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate(-1)}>History back</button>
    <button onClick={() => navigate(1)}>History forward</button>
    <Settings section={section} onClose={vi.fn()} />
  </>;
}

it('keeps profile model references and Computer Use controls reachable across navigation history', async () => {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({
    enabled: false, phase: 'disabled', available: true, platform: 'linux', version: 'fixture',
  }) });
  render(<MemoryRouter initialEntries={[
    '/settings/agent-subagents?reference=agent.subagents.profiles.vision.model',
  ]}><Routes><Route path="/settings/:section?" element={<Page />} /></Routes></MemoryRouter>);

  const modelLabel = 'pilotDeckConfig.panels.agentSubagents.editor.model.label';
  await waitFor(() => expect(screen.getByLabelText(modelLabel).value)
    .toBe('provider/vision'));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('settingsPage.menu.agentSubagents');

  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.menu.computerUse' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'computerUse.enable' }).hasAttribute('disabled'))
    .toBe(false));
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('settingsPage.menu.computerUse');
  expect(screen.queryByLabelText(modelLabel)).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'History back' }));
  await waitFor(() => expect(screen.getByLabelText(modelLabel).value)
    .toBe('provider/vision'));
  expect(screen.queryByRole('switch', { name: 'computerUse.enable' })).toBeNull();
  expect(screen.getByRole('button', { name: 'settingsPage.menu.agentSubagents' }).getAttribute('aria-current'))
    .toBe('page');

  fireEvent.click(screen.getByRole('button', { name: 'History forward' }));
  await waitFor(() => expect(screen.getByRole('switch', { name: 'computerUse.enable' }).hasAttribute('disabled'))
    .toBe(false));
  expect(screen.getByRole('button', { name: 'settingsPage.menu.computerUse' }).getAttribute('aria-current'))
    .toBe('page');
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  for (const call of mocks.fetch.mock.calls) {
    expect(call).toEqual(['/api/computer-use/status', expect.objectContaining({ method: 'GET' })]);
  }
  expect(mocks.commit).not.toHaveBeenCalled();
});
