import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Settings from './Settings';
import AgentMemorySections from './view/agentMemory';
import { parse } from 'yaml';
const mocks = vi.hoisted(() => ({ commit: vi.fn(), minutes: 30 }));
vi.mock('../../hooks/usePilotDeckConfig', () => ({ PilotDeckConfigProvider: ({ children }: any) => children, usePilotDeckConfig: () => ({ raw: `memory:\n  enabled: true\n  autoDreamIntervalMinutes: ${mocks.minutes}\n`, commitRaw: mocks.commit, loading: false, error: null }) }));
vi.mock('./view/agentMemory/MemoryDataSection', () => ({ default: () => null }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./view/SettingsContent', () => ({ default: ({ selectedKey, mobileVisible, onOpenMobileNavigation }: any) => <main data-testid="content" data-mobile-visible={String(mobileVisible)}><span>{selectedKey}</span><button onClick={onOpenMobileNavigation}>Open navigation</button></main> }));
afterEach(() => {cleanup();vi.clearAllMocks();});
it('opens General on the first selection from another settings section on mobile', () => {
  function Page() { const { section } = useParams(); return <Settings section={section} onClose={vi.fn()} />; }
  render(<MemoryRouter initialEntries={['/settings/advanced']}><Routes><Route path="/settings/:section?" element={<Page />} /></Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.menu.general' }));
  expect(screen.getByTestId('content').getAttribute('data-mobile-visible')).toBe('true');
});
it.each([30, 90])('preserves an existing %i minute dream interval when opening and saving its editor', (minutes) => {
 mocks.minutes = minutes;
  render(<AgentMemorySections title="Memory" projects={[]} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.actions.edit' })[1]);
  fireEvent.click(screen.getByRole('button', { name: 'settingsPage.actions.save' }));
  expect(parse(mocks.commit.mock.calls[0][0]).memory.autoDreamIntervalMinutes).toBe(minutes);
});

it.each([
  ['/settings/image-generation', '/settings/multimodal-generation'],
  ['/settings/video-generation', '/settings/multimodal-generation?tab=video'],
])('redirects %s to its matching multimodal tab', async (initial, expected) => {
  function Page() { const { section } = useParams(); const location = useLocation(); return <><Settings section={section} onClose={vi.fn()} /><output data-testid="route">{location.pathname + location.search}</output></>; }
  render(<MemoryRouter initialEntries={[initial]}><Routes><Route path="/settings/:section?" element={<Page />} /></Routes></MemoryRouter>);
  expect(screen.getByTestId('content').textContent).toContain('multimodalGeneration');
  expect(screen.getByTestId('route').textContent).toBe(expected);
});
