import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import SettingsContent from './view/SettingsContent';
import SettingsSidebar from './view/SettingsSidebar';

const translations: Record<string, string> = {
  'settingsPage.breadcrumb': '设置',
  'settingsPage.modules.title': '模块',
  'settingsPage.menu.general': '通用',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => translations[key] ?? options?.defaultValue ?? key,
  }),
}));

afterEach(cleanup);

const translatedSetting = {
  id: 'host-preferences',
  settingsSection: 'host-preferences',
  label: 'General',
  labelKey: 'settingsPage.menu.general',
  component: () => null,
};

it('uses contribution translation keys for module navigation and headings', () => {
  const sidebar = render(<SettingsSidebar selectedKey="module:host-preferences" onSelect={vi.fn()} onClose={vi.fn()} moduleSettings={[translatedSetting]} />);
  expect(screen.getByRole('button', { name: '通用' })).toBeTruthy();
  sidebar.unmount();

  render(
    <MemoryRouter>
      <SettingsContent selectedKey="module:host-preferences" projects={[]} moduleSettings={[translatedSetting]} />
    </MemoryRouter>,
  );
  expect(screen.getByText('设置')).toBeTruthy();
  expect(screen.getAllByText('通用')).toHaveLength(2);
});

it('keeps a literal module label when a contribution does not define a translation key', () => {
  render(<SettingsSidebar selectedKey="module:replacement" onSelect={vi.fn()} onClose={vi.fn()} moduleSettings={[{ id: 'replacement', label: 'Replacement settings', component: () => null }]} />);
  expect(screen.getByRole('button', { name: 'Replacement settings' })).toBeTruthy();
});
