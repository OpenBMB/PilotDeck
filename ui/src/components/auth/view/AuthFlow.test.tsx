// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../i18n/testInstance';
import enAuth from '../../../i18n/locales/en/auth.json';
import { AuthProvider } from '../context/AuthContext';
import ProtectedRoute from './ProtectedRoute';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), user: vi.fn(), login: vi.fn(), register: vi.fn(),
  onboardingStatus: vi.fn(), runtimeStatus: vi.fn(),
}));
vi.mock('../../../constants/config', () => ({ IS_PLATFORM: false, DISABLE_LOCAL_AUTH: false }));
vi.mock('../../../utils/api', () => ({
  api: {
    auth: { status: mocks.status, user: mocks.user, login: mocks.login, register: mocks.register },
    user: { onboardingStatus: mocks.onboardingStatus, runtimeStatus: mocks.runtimeStatus },
  },
  authenticatedFetch: vi.fn(),
}));
vi.mock('../../onboarding/view/Onboarding', () => ({ default: () => <div>onboarding</div> }));

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const session = { token: 'test-session-token', user: { username: 'owner' } };
const configured = { configuration: { state: 'ready', modelRef: 'test/model' }, gateway: { state: 'unmanaged' } };

async function mount() {
  const i18n = await createTestI18n();
  i18n.addResourceBundle('en', 'auth', enAuth);
  render(<I18nextProvider i18n={i18n}><MemoryRouter><AuthProvider>
    <ProtectedRoute><main>workspace</main></ProtectedRoute>
  </AuthProvider></MemoryRouter></I18nextProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.status.mockImplementation(async () => response({ needsSetup: false }));
  mocks.user.mockImplementation(async () => response({ user: session.user }));
  mocks.onboardingStatus.mockImplementation(async () => response(configured));
  mocks.login.mockImplementation(async () => response(session));
  mocks.register.mockImplementation(async () => response(session));
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe('active authentication entry points', () => {
  it('logs in through the self-hosted account form before mounting the workspace', async () => {
    await mount();
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(await screen.findByText('workspace')).toBeTruthy();
    expect(mocks.login).toHaveBeenCalledWith('owner', 'password');
    expect(localStorage.getItem('auth-token')).toBe(session.token);
  });

  it('keeps account setup reachable on a new self-hosted server', async () => {
    mocks.status.mockImplementation(async () => response({ needsSetup: true }));
    await mount();
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'owner' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.change(screen.getByLabelText('Confirm Password'), { target: { value: 'password' } });
    mocks.status.mockImplementation(async () => response({ needsSetup: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
    expect(await screen.findByText('workspace')).toBeTruthy();
    expect(mocks.register).toHaveBeenCalledWith('owner', 'password');
  });

  it('skips both forms when the runtime server explicitly disables local authentication', async () => {
    // The packaged UI can be built without the desktop runtime's environment.
    mocks.status.mockImplementation(async () => response({ authDisabled: true, needsSetup: false }));
    await mount();
    expect(await screen.findByText('workspace')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(mocks.user).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP failure', async () => response({ error: 'unavailable' }, 503)],
    ['invalid JSON', async () => new Response('<html>unavailable</html>')],
    ['invalid status', async () => response({ needsSetup: 'unknown' })],
    ['network failure', async () => { throw new Error('connection refused'); }],
  ])('shows a retryable startup error instead of a login form after %s', async (_name, failedStatus) => {
    mocks.status.mockImplementation(failedStatus);
    await mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('PD_AUTH_STATUS_UNAVAILABLE')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByText('workspace')).toBeNull();
    mocks.status.mockImplementation(async () => response({ authDisabled: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('workspace')).toBeTruthy();
  });

  it('keeps the stored session during a user-service outage and restores it on retry', async () => {
    localStorage.setItem('auth-token', session.token);
    mocks.user.mockImplementation(async () => response({ error: 'unavailable' }, 503));
    await mount();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(localStorage.getItem('auth-token')).toBe(session.token);
    expect(screen.queryByLabelText('Password')).toBeNull();
    mocks.user.mockImplementation(async () => response({ user: session.user }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('workspace')).toBeTruthy();
  });

  it('returns to login when the server rejects an expired session', async () => {
    localStorage.setItem('auth-token', session.token);
    mocks.user.mockImplementation(async () => response({ error: 'expired' }, 401));
    await mount();
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem('auth-token')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('workspace')).toBeNull();
  });
});
