import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProtectedRoute from './ProtectedRoute';
import { MemoryRouter, useNavigate } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  auth: {},
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../onboarding/view/Onboarding', () => ({
  default: () => <div>onboarding</div>,
}));

const readyConfiguration = {
  state: 'ready',
  modelRef: 'openai/gpt-5',
  configPath: '/tmp/pilotdeck.yaml',
  revision: 'revision',
};

function authValue(overrides = {}) {
  return {
    user: { username: 'local' },
    isLoading: false,
    needsSetup: false,
    modelConfiguration: readyConfiguration,
    gatewayRuntime: { state: 'ready' },
    refreshOnboardingStatus: vi.fn(),
    retryGateway: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  delete window.pilotdeckDesktop; delete window.__pilotdeckStartupState;
});

describe('ProtectedRoute runtime states', () => {
  it('keeps the application visible with an empty model pool and stopped Gateway', () => {
    mocks.auth = authValue({ modelConfiguration: { state: 'empty' }, gatewayRuntime: { state: 'stopped' } });
    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('application')).toBeTruthy();
    expect(screen.queryByText('onboarding')).toBeNull();
  });

  it('shows onboarding while model configuration is missing', () => {
    mocks.auth = authValue({
      modelConfiguration: {
        state: 'needs_configuration',
        reason: 'missing_config',
        configPath: null,
        revision: '',
      },
      gatewayRuntime: { state: 'stopped' },
    });

    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('onboarding')).toBeTruthy();
  });

  it('waits for Gateway after configuration becomes ready', async () => {
    const i18n = await createTestI18n();
    mocks.auth = authValue({ gatewayRuntime: { state: 'starting' } });

    render(<I18nextProvider i18n={i18n}><MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter></I18nextProvider>);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('78');
    expect(screen.getByText('Starting Gateway…')).toBeTruthy();
    expect(screen.queryByText('application')).toBeNull();
  });

  it.each([false, true])('keeps an actionable Gateway error screen with desktop=%s', async (desktop) => {
    const i18n = await createTestI18n();
    const retryGateway = vi.fn();
    const saveRuntimeLogs = vi.fn().mockResolvedValue({ canceled: false });
    if (desktop) Object.defineProperty(window, 'pilotdeckDesktop', { configurable: true, value: { saveRuntimeLogs } });
    mocks.auth = authValue({
      gatewayRuntime: { state: 'error', error: 'Gateway crashed' },
      retryGateway,
    });

    render(<I18nextProvider i18n={i18n}><MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter></I18nextProvider>);
    expect(screen.queryByText('Gateway crashed')).toBeNull();
    expect(screen.getByText('PD_RUNTIME_PROCESS_FAILED')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(retryGateway).toHaveBeenCalledTimes(1);
    expect(screen.getByText('PilotDeck could not start')).toBeTruthy();
    if (desktop) {
      fireEvent.click(screen.getByRole('button', { name: 'Save runtime logs' }));
      expect(saveRuntimeLogs).toHaveBeenCalledTimes(1);
    } else {
      expect(screen.getByRole('button', { name: 'Save runtime logs' })).toBeTruthy();
    }
  });

  it('allows authenticated users to repair invalid model config from settings', () => {
    mocks.auth = authValue({ modelConfiguration: { state: 'invalid', errors: ['bad provider'] }, gatewayRuntime: { state: 'stopped' } });
    render(<MemoryRouter initialEntries={['/settings/models']}><ProtectedRoute><div>model settings</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('model settings')).toBeTruthy();
    expect(screen.queryByText('Model configuration unavailable')).toBeNull();
  });

  it('keeps the runtime log location outside the scrollable stack trace', async () => {
    const i18n = await createTestI18n();
    const logPath = 'C:\\用户\\PilotDeck\\logs\\runtime.log';
    mocks.auth = authValue({ gatewayRuntime: { state: 'error', error: `${'native frame\n'.repeat(100)}Runtime log: ${logPath}` } });
    render(<I18nextProvider i18n={i18n}><MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter></I18nextProvider>);
    const location = screen.getByText(`Runtime log: ${logPath}`);
    expect(location.closest('[role=alert]')).toBeTruthy();
    expect(screen.queryByText(/native frame/)).toBeNull();
  });

  it.each([
    '/settings/models/test',
    '/settings/models/test/',
    '/settings/advanced/anything',
    '/settings//models',
    '/settings/models%2Ftest/extra',
  ])('keeps an unconfigured user in onboarding at %s', (path) => {
    mocks.auth = authValue({
      modelConfiguration: { state: 'needs_configuration', reason: 'missing_config' },
      gatewayRuntime: { state: 'stopped' },
    });

    render(<MemoryRouter initialEntries={[path]}><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);

    expect(screen.getByText('onboarding')).toBeTruthy();
    expect(screen.queryByText('application')).toBeNull();
  });

  it.each(['/settings', '/settings/', '/settings/models', '/settings/models/', '/SETTINGS/models'])('keeps the real settings route %s available for configuration repair', (path) => {
    mocks.auth = authValue({
      modelConfiguration: { state: 'invalid', errors: ['bad provider'] },
      gatewayRuntime: { state: 'stopped' },
    });

    render(<MemoryRouter initialEntries={[path]}><ProtectedRoute><div>model settings</div></ProtectedRoute></MemoryRouter>);

    expect(screen.getByText('model settings')).toBeTruthy();
    expect(screen.queryByText('onboarding')).toBeNull();
  });

  it('reapplies the onboarding gate when navigating from settings to an invalid nested path', () => {
    mocks.auth = authValue({
      modelConfiguration: { state: 'needs_configuration', reason: 'missing_config' },
      gatewayRuntime: { state: 'stopped' },
    });
    function SettingsProbe() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/settings/models/test')}>Nested settings link</button>;
    }

    render(<MemoryRouter initialEntries={['/settings/models']}><ProtectedRoute><SettingsProbe /></ProtectedRoute></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Nested settings link' }));

    expect(screen.getByText('onboarding')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nested settings link' })).toBeNull();
  });

  it('links the model error screen to the repair settings', () => {
    mocks.auth = authValue({ modelConfiguration: { state: 'invalid', errors: ['bad provider'] }, gatewayRuntime: { state: 'stopped' } });
    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'openModelSettings' }).getAttribute('href')).toBe('/settings/models');
  });

  it('shows configuration diagnostics without changing the configuration', async () => {
    const i18n = await createTestI18n();
    const saveRuntimeLogs = vi.fn();
    Object.defineProperty(window, 'pilotdeckDesktop', { configurable: true, value: { getRuntimeInfo: vi.fn().mockResolvedValue({ logPath: '/logs/runtime.log' }), saveRuntimeLogs } });
    mocks.auth = authValue({ modelConfiguration: { state: 'invalid', errors: ['Invalid YAML'], configPath: '/config/pilotdeck.yaml', revision: 'original' }, gatewayRuntime: { state: 'stopped' } });
    render(<I18nextProvider i18n={i18n}><MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter></I18nextProvider>);
    expect(screen.getByText('PD_CONFIG_INVALID')).toBeTruthy();
    expect(screen.getByText('The model configuration could not be read. Check it in Settings and try again.')).toBeTruthy();
    expect(await screen.findByText('Runtime log: /logs/runtime.log')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save runtime logs' }));
    expect(saveRuntimeLogs).toHaveBeenCalledOnce();
  });

  it('enters the application only after both states are ready', () => {
    mocks.auth = authValue();

    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('application')).toBeTruthy();
  });
});
