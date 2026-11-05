// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../i18n/testInstance';
import type { ChatMessage } from '../chat/types/types';
import { ConversationTurnNav } from './ConversationTurnNav';
import { buildConversationTurns } from './conversationTurnNavUtils';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const message = (id: string, type: 'user' | 'assistant', content: string): ChatMessage => ({ id, type, content, timestamp: '2026-01-01T00:00:00Z' });

it('uses bounded prose previews, preserves stable keys, and excludes tools and reasoning', () => {
  const user = { ...message('transient', 'user', '## A [linked](https://example.com) question'), renderKey: 'stable' };
  const messages = [user, { ...message('think', 'assistant', 'Private reasoning'), isThinking: true },
    { ...message('tool', 'assistant', 'Tool output'), isToolUse: true },
    message('answer', 'assistant', '😀'.repeat(200)), message('second', 'user', 'Another question')];
  const turns = buildConversationTurns(messages);
  expect(turns).toHaveLength(2);
  expect(turns[0].prompt).toBe('A linked question');
  expect(Array.from(turns[0].response)).toHaveLength(160);
  expect(turns[1].response).toBe('');
  expect(JSON.stringify(turns)).not.toMatch(/Private reasoning|Tool output/);
  expect(buildConversationTurns([{ ...user, id: 'persisted' }])[0].key).toBe(turns[0].key);
});

it.each(['en', 'zh-CN'])('previews on keyboard focus, bounds the rail DOM, and offers history loading (%s)', async language => {
  const i18n = await createTestI18n(language);
  const loadAll = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  const messages = Array.from({ length: 1000 }, (_, i) => message(`u${i}`, 'user', `Question ${i}`));
  const view = render(<I18nextProvider i18n={i18n}><ConversationTurnNav messages={messages}
    items={[]} heights={[]} scrollRef={{ current: null }} loadAll={loadAll} hasMore loading={false} /></I18nextProvider>);
  const nav = screen.getByRole('navigation', { name: i18n.t('chat:turnNavigation.label') });
  expect(nav.querySelectorAll('[data-turn-index]').length).toBeLessThan(50);
  const first = nav.querySelector('[data-turn-index="0"]')!;
  fireEvent.focus(first);
  expect(screen.getByRole('tooltip').textContent).toBe('Question 0');
  fireEvent.click(screen.getByRole('button', { name: i18n.t('chat:turnNavigation.loadEarlier') }));
  expect(loadAll).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(first, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  view.unmount();
});

it('loads a known turn outside the render window before landing and reports synchronous loading failures', async () => {
  const i18n = await createTestI18n('en');
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
  const messages = [message('u1', 'user', 'First'), message('u2', 'user', 'Second')];
  const loadAll = vi.fn();
  const pause = vi.fn();
  const scroller = document.createElement('div');
  const scrollTo = vi.fn();
  scroller.scrollTo = scrollTo;
  document.body.append(scroller);
  const props = { messages, heights: [96], scrollRef: { current: scroller }, onPause: pause, loadAll, hasMore: true, loading: false };
  const pane = (loaded = false) => <I18nextProvider i18n={i18n}><ConversationTurnNav {...props}
    items={loaded ? [{ message: messages[0], itemKey: 'first-row', renderIndex: 0 }] : []} /></I18nextProvider>;
  try {
    const view = render(pane());
    fireEvent.click(screen.getByRole('button', { name: 'Jump to turn 1' }));
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    const row = document.createElement('div'); row.className = 'chat-message'; row.dataset.messageKey = 'first-row'; scroller.append(row);
    view.rerender(pane(true));
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' }));
    expect(pause).toHaveBeenCalledWith('first-row');
    loadAll.mockImplementation(() => { throw new Error('Unavailable'); });
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier conversation turns' }));
    expect(screen.getByRole('status').textContent).toBe('Could not load this conversation');
  } finally { scroller.remove(); }
});
