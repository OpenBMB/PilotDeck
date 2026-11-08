import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CollapsibleSection } from './CollapsibleSection';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps native content rendering until its closing grid transition actually ends', () => {
  vi.useFakeTimers();
  const view = render(<CollapsibleSection title="Tasks" open><p>Work details</p></CollapsibleSection>);
  const details = view.container.querySelector('details')!;
  const summary = view.container.querySelector('summary')!;
  const body = view.container.querySelector('.chat-process-disclosure')!;
  fireEvent.click(summary);
  expect(summary.getAttribute('aria-expanded')).toBe('false');
  act(() => vi.advanceTimersByTime(240));
  expect(details.open).toBe(true);
  fireEvent(body, Object.assign(new Event('transitionend', { bubbles: true }), { propertyName: 'grid-template-rows' }));
  expect(details.open).toBe(false);
  expect(view.getByText('Work details')).toBeTruthy();
  fireEvent.click(summary);
  expect(details.open).toBe(true);
});

it('closes native content immediately when reduced motion disables its transition', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const view = render(<CollapsibleSection title="Tasks" open><p>Work details</p></CollapsibleSection>);
  fireEvent.click(view.container.querySelector('summary')!);
  expect(view.container.querySelector('details')!.open).toBe(false);
});
