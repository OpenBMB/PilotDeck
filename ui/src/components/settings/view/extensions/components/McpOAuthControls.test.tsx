// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import McpOAuthControls from './McpOAuthControls';
const request = vi.hoisted(() => vi.fn());
vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: request }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('offers a real browser link and polls completion without window.open', async () => {
  let authorized = false;
  let started = false;
  request.mockImplementation(async (url: string) => {
    if (url.endsWith('/start')) started = true;
    return { ok: true, json: async () => url.endsWith('/start')
    ? { status: 'pending', authorizationUrl: 'https://auth.example.test/authorize' }
    : { status: authorized ? 'authorized' : started ? 'pending' : 'needs-auth' } }; });
  const opened = vi.spyOn(window, 'open');
  const complete = vi.fn();
  render(<McpOAuthControls scope="global" name="test" onComplete={complete} />);
  await waitFor(() => expect(request).toHaveBeenCalled());
  fireEvent.click(screen.getByText('mcpOAuth.start'));
  const link = await screen.findByRole('link');
  expect(link.getAttribute('href')).toBe('https://auth.example.test/authorize');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(opened).not.toHaveBeenCalled();
  authorized = true;
  await waitFor(() => expect(complete).toHaveBeenCalled(), { timeout: 4000 });
  expect(request.mock.calls.some(([url]) => url.endsWith('/complete'))).toBe(true);
  opened.mockRestore();
});
