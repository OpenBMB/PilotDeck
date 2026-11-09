// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../../i18n/testInstance';
import PermissionRequestsBanner from './PermissionRequestsBanner';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('sends the answer immediately, retains an inert closing seat, then removes it once', async () => {
  const i18n = await createTestI18n('en');
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  const onDecision = vi.fn();
  const requests = [{ requestId: 'question-1', toolName: 'AskUserQuestion', input: {
    questions: [{ question: 'Choose a route', options: [{ label: 'Continue' }] }],
  } }];
  const pane = (pending = requests) => <I18nextProvider i18n={i18n}><PermissionRequestsBanner
    pendingPermissionRequests={pending} handlePermissionDecision={onDecision}
    handleGrantToolPermission={() => ({ success: true })} /></I18nextProvider>;
  const view = render(pane());
  const seat = view.container.querySelector('[data-question-seat]')!;
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
  fireEvent.click(screen.getByRole('button', { name: /Submit/ }));
  expect(onDecision).toHaveBeenCalledTimes(1);
  expect(onDecision).toHaveBeenCalledWith('question-1', expect.objectContaining({ updatedInput: {
    ...requests[0].input, answers: { 'Choose a route': 'Continue' },
  } }));
  view.rerender(pane([]));
  expect(view.container.querySelector('[data-question-seat]')).toBe(seat);
  expect(seat.getAttribute('data-expanded')).toBe('false');
  expect(seat.hasAttribute('inert')).toBe(true);
  act(() => vi.advanceTimersByTime(220));
  expect(view.container.querySelector('[data-question-seat]')).toBe(seat);
  act(() => vi.advanceTimersByTime(20));
  expect(view.container.querySelector('[data-question-seat]')).toBeNull();
  expect(onDecision).toHaveBeenCalledTimes(1);
});
