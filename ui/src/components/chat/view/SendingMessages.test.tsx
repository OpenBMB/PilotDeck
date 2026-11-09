// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import SendingMessages from './SendingMessages';
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string) => key})}));
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('renders the message immediately and only spins for a send lasting 200ms', () => {
  vi.useFakeTimers();
  const item = {id: 'one', displayText: 'Hello', status: 'submitting' as const, createdAt: new Date().toISOString()};
  const view = render(<SendingMessages items={[item]} />);
  expect(screen.getByText('Hello')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(199));
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<SendingMessages items={[{...item, status: 'dispatching'}]} />);
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status')).toBeTruthy();
  view.rerender(<SendingMessages items={[]} />);
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<SendingMessages items={[{...item, id: 'two'}]} />);
  expect(screen.queryByRole('status')).toBeNull();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
