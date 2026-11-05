// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AnimatedDisclosure } from './AnimatedDisclosure';

afterEach(cleanup);
it('mounts details on demand, makes closing content inert, and retains local input state on reopening', () => {
  const content = <input aria-label="Draft" defaultValue="Initial" />;
  const view = render(<AnimatedDisclosure expanded={false}>{content}</AnimatedDisclosure>);
  expect(screen.queryByRole('textbox')).toBeNull();
  view.rerender(<AnimatedDisclosure expanded>{content}</AnimatedDisclosure>);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Edited' } });
  view.rerender(<AnimatedDisclosure expanded={false}>{content}</AnimatedDisclosure>);
  expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  expect(view.container.firstElementChild?.hasAttribute('inert')).toBe(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  view.rerender(<AnimatedDisclosure expanded>{content}</AnimatedDisclosure>);
  expect(screen.getByRole('textbox')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Edited');
});
