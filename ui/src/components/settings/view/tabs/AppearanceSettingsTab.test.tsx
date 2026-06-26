// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../../../../contexts/ThemeContext';
import { useAppearanceProfile } from '../../../../contexts/AppearanceProfileContext';
import { APPEARANCE_PRESETS, type AppearanceProfile } from '../../../../lib/appearanceProfiles';
import AppearanceSettingsTab from './AppearanceSettingsTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'appearanceSettings.brand.duplicate': 'Duplicate',
        'appearanceSettings.brand.reset': 'Reset Profiles',
        'appearanceSettings.brand.delete': 'Delete Profile',
        'appearanceSettings.brand.cancel': 'Cancel',
        'appearanceSettings.brand.deleteConfirmTitle': 'Delete {{name}}?',
        'appearanceSettings.brand.deleteConfirmDescription': 'This profile will be removed locally.',
        'appearanceSettings.brand.confirmDelete': 'Delete profile',
        'appearanceSettings.brand.resetConfirmTitle': 'Reset all custom profiles?',
        'appearanceSettings.brand.resetConfirmDescription': 'This removes every custom appearance profile.',
        'appearanceSettings.brand.confirmReset': 'Reset profiles',
      };
      let text = translations[key] ?? key;
      for (const [name, value] of Object.entries(options ?? {})) {
        text = text.replace(`{{${name}}}`, String(value));
      }
      return text;
    },
  }),
}));

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: vi.fn(),
}));

vi.mock('../../../../contexts/AppearanceProfileContext', () => ({
  useAppearanceProfile: vi.fn(),
}));

type AppearanceProfileContextMock = {
  presets: AppearanceProfile[];
  profiles: AppearanceProfile[];
  activeProfile: AppearanceProfile;
  activeProfileId: string;
  setActiveProfileId: (id: string) => void;
  createFromPreset: (presetId: string, name?: string) => AppearanceProfile;
  duplicateProfile: (profileId: string, name?: string) => AppearanceProfile;
  updateProfile: (id: string, patch: Partial<AppearanceProfile>) => void;
  deleteProfile: (id: string) => void;
  resetProfiles: () => void;
};

const useThemeMock = vi.mocked(useTheme);
const useAppearanceProfileMock = vi.mocked(useAppearanceProfile);

const preset = APPEARANCE_PRESETS[0];
const customProfile: AppearanceProfile = {
  ...preset,
  id: 'custom-lab',
  name: 'Lab Brand',
  brandName: 'Lab Brand',
  readonly: false,
};

function renderTab(contextOverrides: Partial<AppearanceProfileContextMock> = {}) {
  const context: AppearanceProfileContextMock = {
    presets: [preset],
    profiles: [customProfile],
    activeProfile: customProfile,
    activeProfileId: customProfile.id,
    setActiveProfileId: vi.fn(),
    createFromPreset: vi.fn(() => customProfile),
    duplicateProfile: vi.fn(() => customProfile),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    resetProfiles: vi.fn(),
    ...contextOverrides,
  };

  useThemeMock.mockReturnValue({ themeMode: 'system', setThemeMode: vi.fn() });
  useAppearanceProfileMock.mockReturnValue(context as ReturnType<typeof useAppearanceProfile>);

  render(
    <AppearanceSettingsTab
      projectSortOrder="name"
      onProjectSortOrderChange={vi.fn()}
      codeEditorSettings={{ wordWrap: true, showMinimap: false, lineNumbers: true, fontSize: '13' }}
      onCodeEditorWordWrapChange={vi.fn()}
      onCodeEditorShowMinimapChange={vi.fn()}
      onCodeEditorLineNumbersChange={vi.fn()}
      onCodeEditorFontSizeChange={vi.fn()}
    />,
  );

  return context;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppearanceSettingsTab profile management', () => {
  it('requires confirmation before deleting the active custom profile', () => {
    const context = renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Profile' }));

    expect(context.deleteProfile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Delete Lab Brand?');

    fireEvent.click(screen.getByRole('button', { name: 'Delete profile' }));

    expect(context.deleteProfile).toHaveBeenCalledWith('custom-lab');
  });

  it('requires confirmation before resetting all custom profiles', () => {
    const context = renderTab();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Profiles' }));

    expect(context.resetProfiles).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Reset all custom profiles?');

    fireEvent.click(screen.getByRole('button', { name: 'Reset profiles' }));

    expect(context.resetProfiles).toHaveBeenCalledTimes(1);
  });

  it('does not offer reset when there are no custom profiles', () => {
    renderTab({
      profiles: [],
      activeProfile: preset,
      activeProfileId: preset.id,
    });

    const resetButton = screen.getByRole('button', { name: 'Reset Profiles' }) as HTMLButtonElement;

    expect(resetButton.disabled).toBe(true);
  });
});
