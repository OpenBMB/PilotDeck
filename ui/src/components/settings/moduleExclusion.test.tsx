import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Settings from './Settings';
import { authenticatedFetch } from '../../utils/api';

vi.mock('../../hooks/usePilotDeckConfig', () => ({ PilotDeckConfigProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.mocked(authenticatedFetch).mockReset();
});

it.each(['about', 'privacy'])("does not mount %s module requests when the profile omits it", (section) => {
  render(<MemoryRouter><Settings section={section} onClose={vi.fn()} moduleSettings={[]} /></MemoryRouter>);
  expect(screen.getByRole('status').textContent).toContain('not installed');
  expect(authenticatedFetch).not.toHaveBeenCalled();
});
