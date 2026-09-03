// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

const mocks = vi.hoisted(() => ({
  onboardingStatus: vi.fn(),
}));

vi.mock('../../../constants/config', () => ({
  IS_PLATFORM: true,
  DISABLE_LOCAL_AUTH: false,
}));

vi.mock('../../../utils/api', () => ({
  api: {
    auth: {},
    user: { onboardingStatus: mocks.onboardingStatus },
  },
}));

function StateProbe() {
  const { modelConfiguration } = useAuth();
  return <div>{modelConfiguration.state}</div>;
}

describe('AuthContext model configuration state', () => {
  beforeEach(() => {
    mocks.onboardingStatus.mockReset();
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
});
