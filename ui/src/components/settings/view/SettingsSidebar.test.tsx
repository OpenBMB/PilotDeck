// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('lucide-react', () => ({
  ArrowLeft: ({ className }: { className?: string }) => <span className={className} />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'settingsPage.menu.account': 'Accounts & Members',
      'settingsPage.menu.general': 'General',
    }[key] || key),
  }),
}));

import SettingsSidebar from './SettingsSidebar';

describe('SettingsSidebar', () => {
  it('does not expose the deferred accounts and members surface', () => {
    render(
      <SettingsSidebar
        selectedKey="general"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.queryByText('Accounts & Members')).toBeNull();
  });
});
