import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTestI18n } from '../../../i18n/testInstance';
import { useSessionStore } from '../../../stores/useSessionStore';
import { useChatSessionState } from '../../chat/hooks/useChatSessionState';
import type { ChatInterfaceProps } from '../../chat/types/types';
import type { CronJobOverview } from '../../../types/app';
import CronPanel from './CronPanel';
import CronTaskConversation from './CronTaskConversation';

const live = vi.hoisted(() => ({ connected: true, handlers: new Set<(frame: any) => void>(),
  subscribe: (handler: (frame: any) => void) => { live.handlers.add(handler); return () => live.handlers.delete(handler); } }));
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), projects: vi.fn(), jobs: vi.fn(), editor: vi.fn(), chat: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: mocks.fetch,
  api: { projects: mocks.projects, allCronJobs: mocks.jobs } }));
vi.mock('../../../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe: live.subscribe, isConnected: live.connected, ws: null, sendMessage: () => {} }) }));
vi.mock('../../../hooks/useUiPreferences', () => ({ useUiPreferences: () => ({ preferences: {} }) }));
vi.mock('../../../hooks/useDeviceSettings', () => ({ useDeviceSettings: () => ({ isMobile: false }) }));
vi.mock('../../code-editor/hooks/useEditorSidebar', () => ({ useEditorSidebar: (props: unknown) => { mocks.editor(props); return { editorTabs: [] }; } }));
vi.mock('../../code-editor/view/EditorSidebar', () => ({ default: ({ projectPath }: { projectPath: string }) => <aside data-testid="editor-root">{projectPath}</aside> }));
vi.mock('../../chat/tools/useVideoJobs', () => ({ useVideoJobs: (messages: unknown) => messages }));
vi.mock('../../chat/hooks/useScrollFollow', () => ({ useScrollFollow: () => ({
  isPaused: false, canReturnToLatest: false, setPaused() {}, getIsPaused: () => false, pauseAt() {},
  scrollToBottom() {}, scheduleFollow() {}, scheduleInitialPosition() {}, captureAnchor: () => null,
  getReadingAnchor: () => null, restoreReadingAnchor() {},
}) }));
const noop = () => {};
// Retain the production history/cache hook; omit only the heavy chat renderer.
vi.mock('../../chat/view/ChatInterface', () => ({ default: function TaskChat(props: ChatInterfaceProps) {
  mocks.chat(props);
  const store = useSessionStore(), pendingViewSessionRef = useRef(null);
  const view = useChatSessionState({ ...props, eventDriven: true, sessionStore: store, pendingViewSessionRef,
    resetStreamingState: noop, sendMessage: noop });
  return <section aria-label="Task messages">{view.chatMessages.map(message => <p key={message.id}>{message.content}</p>)}</section>;
} }));

const i18n = await createTestI18n();
const job = (id: string): CronJobOverview => ({ id, name: id, sessionKey: `cron:${id}`, projectKey: '/fixture',
  cron: '0 18 * * *', status: 'scheduled', createdAt: '2026-01-01', prompt: 'Task', recurring: true, manualOnly: false });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const emit = (activity: unknown) => act(() => { for (const handler of live.handlers) handler({ type: 'session-activity', activity }); });
beforeEach(() => {
  live.connected = true;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  mocks.projects.mockImplementation(async () => json([{ name: 'fixture', fullPath: '/fixture' }]));
  mocks.jobs.mockImplementation(async () => json({ jobs: [job('task-a'), job('task-b')] }));
});
afterEach(() => { cleanup(); live.handlers.clear(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

it.each(['completed', 'failed'])('recovers an ordinary task reply that %s offscreen without a CronRun or polling', async outcome => {
  let answer = 'Old A';
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/token-usage') ? json({ used: 20 }) : json({
    messages: [{ id: url.includes('task-a') ? answer : 'B', kind: 'text', role: 'assistant', content: url.includes('task-a') ? answer : 'B',
      timestamp: '2026-01-01', provider: 'pilotdeck' }], total: 1, hasMore: false,
  }));
  render(<I18nextProvider i18n={i18n}><MemoryRouter initialEntries={['/cron?taskId=task-a']}><CronPanel /></MemoryRouter></I18nextProvider>);
  await screen.findByText('Old A');
  fireEvent.click(screen.getByRole('button', { name: 'View task details: task-b' }));
  await screen.findByText('B');
  const aReads = () => mocks.fetch.mock.calls.filter(([url]) => url.includes('task-a') && url.includes('/messages')).length;
  answer = 'New ordinary reply';
  emit({ sessionId: 'cron:task-a', processing: false, runId: 'chat-1', revision: 2,
    completedRunId: outcome === 'completed' ? 'chat-1' : undefined });
  expect(aReads()).toBe(1); // No eager background fetch for an inactive task.
  fireEvent.click(screen.getByRole('button', { name: 'View task details: task-a' }));
  await screen.findByText('New ordinary reply');
  expect(aReads()).toBe(2);
  emit({ sessionId: 'cron:task-a', processing: false, runId: 'chat-1', revision: 2 });
  emit({ sessionId: 'ordinary-chat', processing: false, runId: 'other', revision: 99 });
  fireEvent.click(screen.getByRole('button', { name: 'View task details: task-b' }));
  await screen.findByText('B');
  fireEvent.click(screen.getByRole('button', { name: 'View task details: task-a' }));
  await screen.findByText('New ordinary reply');
  expect(aReads()).toBe(2);
  expect(mocks.jobs).toHaveBeenCalledTimes(1);
});

it('uses the current workspace for file previews even when the last run used another workspace', async () => {
  mocks.fetch.mockResolvedValue(json({ messages: [], hasMore: false, total: 0 }));
  render(<I18nextProvider i18n={i18n}><CronTaskConversation projects={[]} job={{ ...job('task-a'),
    workspaceCwd: '/current/task-worktree', lastRun: { runId: 'old', taskId: 'task-a', sessionKey: 'cron:task-a', startedAt: '2026-01-01', workspaceCwd: '/old/source' } }} /></I18nextProvider>);
  await waitFor(() => expect(screen.getByTestId('editor-root').textContent).toBe('/current/task-worktree'));
  expect(mocks.editor).toHaveBeenCalledWith(expect.objectContaining({ selectedProject: expect.objectContaining({ fullPath: '/current/task-worktree', name: 'cron-task:task-a' }) }));
  expect(mocks.chat).toHaveBeenCalledWith(expect.objectContaining({ selectedProject: expect.objectContaining({
    name: '/fixture', fullPath: '/fixture', workspaceCwd: '/current/task-worktree', fileOperationsKey: 'cron-task:task-a',
  }) }));
});

it('forwards retained task visibility to the composer without replacing the conversation', async () => {
  mocks.fetch.mockImplementation(async () => json({ messages: [], hasMore: false, total: 0 }));
  const view = (active: boolean) => <I18nextProvider i18n={i18n}><MemoryRouter initialEntries={['/cron?taskId=task-a']}><CronPanel active={active} /></MemoryRouter></I18nextProvider>;
  const { rerender } = render(view(true));
  await waitFor(() => expect(mocks.chat).toHaveBeenLastCalledWith(expect.objectContaining({ active: true })));
  const session = mocks.chat.mock.lastCall?.[0].selectedSession;
  rerender(view(false));
  expect(mocks.chat).toHaveBeenLastCalledWith(expect.objectContaining({ active: false, selectedSession: session }));
  rerender(view(true));
  expect(mocks.chat).toHaveBeenLastCalledWith(expect.objectContaining({ active: true, selectedSession: session }));
  expect(mocks.jobs).toHaveBeenCalledTimes(1);
});

it('enables file context for General task workspaces without changing conversation ownership', () => {
  mocks.fetch.mockImplementation(async () => json({ messages: [], hasMore: false, total: 0 }));
  render(<I18nextProvider i18n={i18n}><CronTaskConversation projects={[{ name: 'general', displayName: 'General', kind: 'general', fullPath: '/general',
    capabilities: { files: false, projectFileMentions: false } }]} job={{ ...job('general-task'), projectKey: '/general', workspaceCwd: '/general/workspace' }} /></I18nextProvider>);
  expect(mocks.chat).toHaveBeenCalledWith(expect.objectContaining({ selectedProject: expect.objectContaining({
    name: 'general', kind: 'general', fullPath: '/general', workspaceCwd: '/general/workspace', fileOperationsKey: 'cron-task:general-task',
    capabilities: { files: false, projectFileMentions: true },
  }) }));
});

it('accepts lower activity revisions after a server restart and reconnect', async () => {
  let answer = 'Initial';
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/token-usage') ? json({ used: 20 }) : json({
    messages: [{ id: answer, kind: 'text', role: 'assistant', content: url.includes('task-a') ? answer : 'B', timestamp: '2026-01-01' }], total: 1, hasMore: false,
  }));
  const view = () => <I18nextProvider i18n={i18n}><MemoryRouter initialEntries={['/cron?taskId=task-a']}><CronPanel /></MemoryRouter></I18nextProvider>;
  const { rerender } = render(view());
  await screen.findByText('Initial');
  answer = 'Before restart'; emit({ sessionId: 'cron:task-a', processing: false, runId: 'first', revision: 100 });
  await screen.findByText('Before restart');
  live.connected = false; rerender(view());
  live.connected = true; rerender(view());
  await waitFor(() => expect(mocks.jobs).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'View task details: task-b' }));
  await screen.findByText('B');
  answer = 'After restart'; emit({ sessionId: 'cron:task-a', processing: false, runId: 'second', revision: 2 });
  fireEvent.click(screen.getByRole('button', { name: 'View task details: task-a' }));
  await screen.findByText('After restart');
});
