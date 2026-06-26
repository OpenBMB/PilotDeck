// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectModelsSettingsPage } from './Settings';
import { useProjectModelSettings } from '../../../hooks/useProjectModelSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let text = String(options?.defaultValue ?? key);
      for (const [name, value] of Object.entries(options ?? {})) {
        text = text.replace(`{{${name}}}`, String(value));
      }
      return text;
    },
  }),
}));

vi.mock('../../../hooks/useProjectModelSettings', () => ({
  useProjectModelSettings: vi.fn(),
}));

const useProjectModelSettingsMock = vi.mocked(useProjectModelSettings);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectModelsSettingsPage', () => {
  it('keeps the current project selected and prompts before discarding unsaved model changes', () => {
    useProjectModelSettingsMock.mockReturnValue({
      data: {
        projectKey: '/repo/alpha',
        configPath: '/repo/alpha/.pilotdeck/pilotdeck.yaml',
        exists: true,
        inherited: {},
        settings: { mainModel: 'openai/main' },
        effective: { mainModel: 'openai/main' },
        modelOptions: [
          { id: 'openai/main', provider: 'openai', model: 'main', label: 'OpenAI Main' },
        ],
        diagnostics: [],
      },
      draft: { mainModel: 'openai/project' },
      setDraft: vi.fn(),
      loading: false,
      saving: false,
      error: null,
      message: null,
      dirty: true,
      refresh: vi.fn(),
      save: vi.fn(),
    });

    render(<ProjectModelsSettingsPage projects={[
      { name: 'alpha', displayName: 'Alpha', fullPath: '/repo/alpha' },
      { name: 'beta', displayName: 'Beta', fullPath: '/repo/beta' },
    ]} />);

    const projectSelect = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
    expect(projectSelect.value).toBe('alpha');

    fireEvent.change(projectSelect, { target: { value: 'beta' } });

    expect(projectSelect.value).toBe('alpha');
    expect(screen.getByText('Unsaved changes in this project')).toBeTruthy();
    expect(screen.getByText('Save or discard changes before switching to Beta.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard & switch' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save & switch' })).toBeTruthy();
  });
});
