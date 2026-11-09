import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../../../utils/api';
import GitRuntimeSection from './GitRuntimeSection';
vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const fetchMock = vi.mocked(authenticatedFetch);
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each(['bundled', 'configured', 'system'])('shows %s Git from the execution host and checks again on request', async source => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ state: 'ready', source, version: '2.51.2', executable: '/host/git' }) } as Response);
  render(<GitRuntimeSection />);
  await screen.findByText('/host/git');
  expect(screen.getByText(`gitRuntime.sources.${source}`)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith('/api/config/git-runtime', expect.objectContaining({ method: 'GET' }));
  fireEvent.click(screen.getByRole('button', { name: 'gitRuntime.refresh' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('reports unavailable Git without claiming that it is bundled', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ state: 'unavailable', source: 'system' }) } as Response);
  render(<GitRuntimeSection />); await screen.findByText('gitRuntime.unavailable');
  expect(screen.queryByText('gitRuntime.sources.bundled')).toBeNull();
});
