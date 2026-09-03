// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

const mocks = vi.hoisted(() => ({
  onboardingStatus: vi.fn(),
  runtimeStatus: vi.fn(),
}));

vi.mock('../../../constants/config', () => ({
  IS_PLATFORM: true,
  DISABLE_LOCAL_AUTH: false,
}));

vi.mock('../../../utils/api', () => ({
  api: {
    auth: {},
    user: {
      onboardingStatus: mocks.onboardingStatus,
      runtimeStatus: mocks.runtimeStatus,
      retryGateway: vi.fn(),
    },
  },
}));

function StateProbe() {
  const { modelConfiguration } = useAuth();
  return <div>{modelConfiguration.state}</div>;
}

describe('AuthContext model configuration state', () => {
  beforeEach(() => {
    mocks.onboardingStatus.mockReset();
    mocks.runtimeStatus.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not fail open when the configuration status request fails', async () => {
    mocks.onboardingStatus.mockRejectedValueOnce(new Error('server unavailable'));

    render(<AuthProvider><StateProbe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('status_error')).toBeTruthy();
    });
  });

  it('preserves the explicit configuration state returned by the server', async () => {
    mocks.onboardingStatus.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        configuration: {
          state: 'needs_configuration',
          reason: 'missing_config',
          configPath: '/tmp/pilotdeck.yaml',
          revision: 'revision',
        },
      }),
    });

    render(<AuthProvider><StateProbe /></AuthProvider>);

    await waitFor(() => {
      expect(screen.getByText('needs_configuration')).toBeTruthy();
    });
  });

  it('keeps polling while Gateway remains in its starting state', async () => {
    mocks.onboardingStatus.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        configuration: {
          state: 'ready',
          modelRef: 'openai/gpt-5',
          configPath: '/tmp/pilotdeck.yaml',
          revision: 'revision',
        },
        gateway: { state: 'starting' },
      }),
    });
    mocks.runtimeStatus
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          configuration: {
            state: 'ready',
            modelRef: 'openai/gpt-5',
            configPath: '/tmp/pilotdeck.yaml',
            revision: 'revision',
          },
          gateway: { state: 'starting' },
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          configuration: {
            state: 'ready',
            modelRef: 'openai/gpt-5',
            configPath: '/tmp/pilotdeck.yaml',
            revision: 'revision',
          },
          gateway: { state: 'ready' },
        }),
      });

    render(<AuthProvider><StateProbe /></AuthProvider>);

    await waitFor(() => {
      expect(mocks.runtimeStatus).toHaveBeenCalledTimes(2);
    }, { timeout: 2_000 });
  });
});
