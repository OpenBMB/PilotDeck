// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../../../utils/api.js';
import PermissionsSettingsTab, { getPermissionsImportImpactForTest } from './PermissionsSettingsTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'permissions.sudoPolicy.actions.ask': 'Ask',
        'permissions.sudoPolicy.actions.allow': 'Allow',
        'permissions.values.enabled': 'enabled',
        'permissions.values.disabled': 'disabled',
      };
      let text = String(translations[key] ?? options?.defaultValue ?? key);
      for (const [name, value] of Object.entries(options ?? {})) {
        text = text.replace(`{{${name}}}`, String(value));
      }
      return text;
    },
  }),
}));

vi.mock('../../../../utils/api.js', () => ({
  authenticatedFetch: vi.fn(),
}));

const fetchMock = vi.mocked(authenticatedFetch);

const basePermissions = {
  allowedTools: ['read_file'],
  disallowedTools: [],
  skipPermissions: false,
  sudoPolicy: { local: 'deny', remote: 'deny', remoteHosts: [] },
  projectSortOrder: 'name',
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('pilotdeck-settings', JSON.stringify(basePermissions));
  fetchMock.mockImplementation(async (_url, options) => {
    if (options?.method === 'PUT') {
      const updates = JSON.parse(String(options.body ?? '{}'));
      const next = { ...basePermissions, ...updates };
      return {
        ok: true,
        json: async () => ({ permissions: next }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({ permissions: basePermissions }),
    } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('PermissionsSettingsTab import safety', () => {
  it('calls out skip-permissions and sudo-policy changes before importing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const payload = JSON.stringify({
      version: 2,
      source: 'pilotdeck',
      allowedTools: ['write_file'],
      disallowedTools: ['bash:rm:*'],
      skipPermissions: true,
      sudoPolicy: {
        local: 'ask',
        remote: 'allow',
        remoteHosts: [{ host: 'lab-*', action: 'allow' }],
      },
    });
    const file = new File([payload], 'permissions.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => payload });

    const { container } = render(<PermissionsSettingsTab />);

    await screen.findByRole('button', { name: 'Import' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toBeTruthy();

    fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalled();
    });

    const confirmText = String(confirmSpy.mock.calls[0][0]);
    expect(confirmText).toContain('Merge 1 allowed and 1 blocked tools');
    expect(confirmText).toContain('This import also changes:');
    expect(confirmText).toContain('Skip permission prompts: enabled');
    expect(confirmText).toContain('sudo policy: local Ask, remote Allow, 1 host override');
  });

  it('summarizes high-risk import effects for tests and future UI copy', () => {
    expect(getPermissionsImportImpactForTest({
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      sudoPolicy: { local: 'deny', remote: 'ask', remoteHosts: [{ host: 'prod', action: 'ask' }] },
    })).toEqual({
      affectsSkipPermissions: true,
      affectsSudoPolicy: true,
      sudoHostCount: 1,
    });
  });
});
