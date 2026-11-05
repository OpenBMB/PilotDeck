import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../i18n/testInstance';
import { ThinkingBlock } from './ThinkingBlock';

vi.unmock('react-i18next');
vi.mock('../chat/view/subcomponents/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('./StreamingScrollViewport', () => ({ StreamingScrollViewport: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

it.each([
  ['en', 'Thinking for 0s', 'Thinking for 3s', 'Thought for 3s'],
  ['zh-CN', '正在思考 0 秒', '正在思考 3 秒', '已思考 3 秒'],
])('opens live reasoning with a localized clock and closes it on completion (%s)', async (language, initial, running, completed) => {
  const i18n = await createTestI18n(language);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const element = (isStreaming: boolean) => <I18nextProvider i18n={i18n}><ThinkingBlock content="Reasoning" isStreaming={isStreaming} /></I18nextProvider>;
  const view = render(element(true));
  expect(screen.getByRole('button', { name: initial }).getAttribute('aria-expanded')).toBe('true');
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.getByRole('button', { name: running })).toBeTruthy();
  view.rerender(element(false));
  act(() => vi.advanceTimersByTime(20000));
  expect(screen.getByRole('button', { name: completed }).getAttribute('aria-expanded')).toBe('false');
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves manual expansion across tokens, collapses on completion and keeps final content available', () => {
  const view = render(<ThinkingBlock content="First chunk" isStreaming />);
  const toggle = screen.getByRole('button');
  view.rerender(<ThinkingBlock content="First chunk and final words" isStreaming />);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  view.rerender(<ThinkingBlock content="First chunk and final words" isStreaming={false} durationMs={4200} />);
  expect(toggle.textContent).toBe('Thought for 4s');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.textContent).toContain('final words');
  view.rerender(<ThinkingBlock content="Persisted final words" isStreaming={false} durationMs={4200} />);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});

it('respects a manual collapse while tokens arrive and starts a new phase expanded', () => {
  const view = render(<ThinkingBlock content="First chunk" isStreaming />);
  const toggle = screen.getByRole('button');
  fireEvent.click(toggle);
  view.rerender(<ThinkingBlock content="First chunk and more" isStreaming />);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const disclosure = document.getElementById(toggle.getAttribute('aria-controls')!);
  expect(disclosure?.getAttribute('aria-hidden')).toBe('true');
  expect(disclosure?.hasAttribute('inert')).toBe(true);
  view.rerender(<ThinkingBlock content="First complete" isStreaming={false} />);
  view.rerender(<ThinkingBlock content="New phase" isStreaming />);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});

it('restores the measured duration and live start rather than counting since mount', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:12Z'));
  const view = render(<ThinkingBlock content="Plan" isStreaming startedAt="2026-01-01T00:00:00Z" />);
  expect(screen.getByRole('button').textContent).toBe('Thinking for 12s');
  view.rerender(<ThinkingBlock content="Plan" isStreaming={false} durationMs={8700} />);
  expect(screen.getByRole('button').textContent).toBe('Thought for 8s');
  view.unmount();
  render(<ThinkingBlock content="History" isStreaming={false} durationMs={8700} />);
  expect(screen.getByRole('button').textContent).toBe('Thought for 8s');
});

it('does not invent a duration for old history and clamps future timestamps', () => {
  const view = render(<ThinkingBlock content="Old thought" isStreaming={false} durationMs={NaN} />);
  expect(screen.getByRole('button').textContent).toBe('Finished thinking');
  view.rerender(<ThinkingBlock content="New thought" isStreaming startedAt="2999-01-01T00:00:00Z" />);
  expect(screen.getByRole('button').textContent).toBe('Thinking for 0s');
});
