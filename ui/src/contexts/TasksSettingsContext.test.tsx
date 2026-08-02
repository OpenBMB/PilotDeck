// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksSettingsProvider } from './TasksSettingsContext';

const mocks = vi.hoisted(() => ({
  auth: { user: null as { id: number } | null, isLoading: true },
  get: vi.fn(),
}));

vi.mock('../components/auth/context/AuthContext', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../utils/api', () => ({
  api: { get: mocks.get },
}));

describe('TasksSettingsProvider authentication gate', () => {
  beforeEach(() => {
    mocks.auth.user = null;
    mocks.auth.isLoading = true;
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({
      ok: true,
      json: async () => ({ installation: { isInstalled: true }, isReady: true }),
    });
  });

  afterEach(cleanup);

  it('waits for an authenticated user before checking TaskMaster', async () => {
    const view = render(<TasksSettingsProvider><div>content</div></TasksSettingsProvider>);
    expect(mocks.get).not.toHaveBeenCalled();

    mocks.auth.isLoading = false;
    view.rerender(<TasksSettingsProvider><div>content</div></TasksSettingsProvider>);
    expect(mocks.get).not.toHaveBeenCalled();

    mocks.auth.user = { id: 1 };
    view.rerender(<TasksSettingsProvider><div>content</div></TasksSettingsProvider>);

    await waitFor(() => {
      expect(mocks.get).toHaveBeenCalledWith('/taskmaster/installation-status');
    });
  });
});
