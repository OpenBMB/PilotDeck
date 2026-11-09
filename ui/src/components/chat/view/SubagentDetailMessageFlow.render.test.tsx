// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createTestI18n } from '../../../i18n/testInstance';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import { FindShortcutProvider } from '../../../contexts/FindShortcutContext';
import type { ChatMessage } from '../types/types';
import * as api from '../../../utils/api';
import SubagentDetailMessageFlow from './SubagentDetailMessageFlow';

const baseTime = Date.parse('2026-05-18T08:00:00.000Z');

it('shows child file preparation before dispatch and retires it when the actual call appears', async () => {
  const i18n = await createTestI18n('zh-CN');
  const preparing: ChatMessage = { id: 'preparing', type: 'system', timestamp: baseTime, isAgentActivity: true,
    activityId: 'file-input:child', phase: 'file_input', state: 'running', toolId: 'write', toolName: 'write_file',
    fileInputProgress: { filePath: 'src/example.ts', receivedBytes: 2048 } };
  const view = (messages: ChatMessage[]) => <I18nextProvider i18n={i18n}><FindShortcutProvider activeScope="chat">
    <SubagentDetailMessageFlow messages={messages} provider="pilotdeck" selectedProject={null} createDiff={() => []} isRunning />
  </FindShortcutProvider></I18nextProvider>;
  const result = render(view([preparing]));
  expect(screen.getByText('正在生成文件内容')).toBeTruthy();
  expect(screen.getByText('已接收 2.0 KB')).toBeTruthy();
  result.rerender(view([preparing, { id: 'write', type: 'assistant', content: '', timestamp: baseTime + 1,
    isToolUse: true, toolId: 'write', toolName: 'write_file', toolInput: { file_path: 'src/example.ts', content: 'File content' } }]));
  expect(result.container.querySelector('[data-file-input-status]')).toBeNull();
  expect(screen.getByText('example.ts')).toBeTruthy();
});

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
    window.setTimeout(() => callback(performance.now()), 0)
  ));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Element.prototype.scrollIntoView = vi.fn();
});

function timestamp(offsetMs: number): string {
  return new Date(baseTime + offsetMs).toISOString();
}

function assistant(id: string, content: string, offsetMs = 100): ChatMessage {
  return {
    id,
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
  };
}

function thinking(id: string, content: string, offsetMs = 200): ChatMessage {
  return {
    id,
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
    isThinking: true,
  };
}

function streamingThinking(content: string, offsetMs = 200): ChatMessage {
  return {
    id: '__subagent_thinking_session-1_subagent-1',
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
    isThinking: true,
    isStreaming: true,
  };
}

function tool(id: string, toolName: string, offsetMs = 300): ChatMessage {
  return {
    id,
    type: 'assistant',
    content: '',
    timestamp: timestamp(offsetMs),
    isToolUse: true,
    toolId: id,
    toolName,
    toolInput: JSON.stringify({ file_path: '/repo/src/App.tsx' }),
    toolResult: null,
  };
}

function renderFlow(messages: ChatMessage[], isRunning = true) {
  return render(
    <FindShortcutProvider activeScope="chat">
      <SubagentDetailMessageFlow
        messages={messages}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
        showThinking
        isRunning={isRunning}
      />
    </FindShortcutProvider>,
  );
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

it.each(['generate_image', 'edit_image'])('loads a live %s result before the child finishes, without a history refresh', async toolName => {
  const fetchImage = vi.spyOn(api, 'authenticatedFetch').mockResolvedValue({ ok: true,
    blob: async () => new Blob(['image'], { type: 'image/png' }),
  } as Response);
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => 'blob:child-image'); URL.revokeObjectURL = vi.fn();
  try {
    const call = { id: 'child-draw', sessionId: 'web:parent', provider: 'pilotdeck' as const,
      kind: 'tool_use' as const, role: 'assistant' as const, toolId: 'child-draw', toolName,
      toolInput: { prompt: 'A blue circle', purpose: 'deliverable' }, timestamp: timestamp(300) };
    const pending = normalizedToChatMessages([call]);
    const view = renderFlow(pending, true);
    const surface = view.container.querySelector('.generated-image-surface');
    expect(surface?.getAttribute('aria-busy')).toBe('true');
    const imageGeneration = { imageId: 'image-1', sessionId: '/project::sub::child', width: 24, height: 16, mimeType: 'image/png', purpose: 'deliverable' };
    const messages = normalizedToChatMessages([call, { ...call, id: 'child-draw-result', kind: 'tool_result',
      content: 'Image attached', isError: false, toolUseResult: { imageGeneration } }]);
    view.rerender(<FindShortcutProvider activeScope="chat"><SubagentDetailMessageFlow
      messages={[...messages, assistant('continuing', 'Continuing the subtask.', 500)]} provider="pilotdeck" selectedProject={null}
      createDiff={() => []} showThinking isRunning /></FindShortcutProvider>);
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('blob:child-image'));
    fireEvent.load(screen.getByRole('img'));
    expect(view.container.querySelector('.generated-image-surface')).toBe(surface);
    expect(surface?.getAttribute('aria-busy')).toBe('false');
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(fetchImage).toHaveBeenCalledWith('/api/image-generation/%2Fproject%3A%3Asub%3A%3Achild/image-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByText('Continuing the subtask.')).toBeTruthy();
  } finally {
    fetchImage.mockRestore(); URL.createObjectURL = previousCreate; URL.revokeObjectURL = previousRevoke;
  }
});

describe('SubagentDetailMessageFlow', () => {
  it.each(['__subagent_thinking_session-1_subagent-1', 'child-t0:response:thinking:0'])(
    'does not duplicate the active thinking indicator for %s', (id) => {
      renderFlow([{ ...streamingThinking('Analyzing the request.'), id }]);
      expect(screen.getAllByText('Analyzing the request.')).toHaveLength(1);
      expect(screen.queryByRole('status')).toBeNull();
    },
  );

  it('renders streaming subagent thinking once before the tool status', async () => {
    renderFlow([
      assistant('a-1', 'I will edit the file.', 100),
      streamingThinking('Choose the smallest patch.', 200),
      tool('edit-1', 'Edit', 300),
    ]);

    const thinkingText = await screen.findByText('Choose the smallest patch.');
    const status = document.querySelector('.tool-call') as HTMLElement;

    expect(screen.getAllByText('Choose the smallest patch.')).toHaveLength(1);
    expect(Boolean(thinkingText.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('renders completed standalone subagent thinking once', () => {
    renderFlow([
      assistant('a-1', 'I will inspect the issue.', 100),
      thinking('think-1', 'Standalone thought one.', 200),
      thinking('think-2', 'Standalone thought two.', 300),
    ], false);

    expect(screen.getAllByText('Standalone thought one.')).toHaveLength(1);
    expect(screen.getAllByText('Standalone thought two.')).toHaveLength(1);
  });

  it('groups completed thinking and tools together while preserving the individual disclosures', () => {
    renderFlow([assistant('a-1', 'I will inspect the issue.'), thinking('think-1', 'Completed thought one.'),
      thinking('think-2', 'Completed thought two.'), tool('read-1', 'Read'), assistant('done', 'Finished')], false);
    fireEvent.click(document.querySelector('[data-turn-process-header] button') as HTMLButtonElement);
    const toggle = document.querySelector('[data-process-block] > button') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getAllByRole('button', { name: /Finished thinking|已思考/i })).toHaveLength(2);
    expect(document.querySelectorAll('.tool-call')).toHaveLength(1);
    expect(screen.getByText('Finished')).toBeTruthy();
  });

  it('opens local search and highlights subagent message content', async () => {
    const overlay = document.createElement('div');
    overlay.dataset.modalOverlay = '';
    document.body.appendChild(overlay);

    renderFlow([
      assistant('a-1', 'First Needle appears here.', 100),
      assistant('a-2', 'Second Needle appears here.', 200),
    ], false);

    fireEvent.keyDown(document, { key: 'f', ctrlKey: true });

    const search = screen.getByRole('search');
    const input = search.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (!input) throw new Error('Expected subagent search input');

    fireEvent.change(input, { target: { value: 'needle' } });

    await waitFor(() => {
      const activeMark = document.querySelector('mark.chat-history-search-highlight-active');
      expect(activeMark?.textContent?.toLowerCase()).toBe('needle');
    });
  });
});


it('passes subagent lifecycle state to normalized tool cards and updates it without new messages', async () => {
  const i18n = await createTestI18n();
  const messages = normalizedToChatMessages([{
    id: 'subagent-bash', sessionId: 'web:subagent-test', provider: 'pilotdeck',
    kind: 'tool_use', role: 'assistant', toolId: 'subagent-bash', toolName: 'bash',
    toolInput: { command: 'pnpm build', description: 'Build app' }, timestamp: timestamp(300),
  }]);
  const pane = (isRunning: boolean, items = messages) => (
    <I18nextProvider i18n={i18n}>
      <FindShortcutProvider activeScope="chat">
        <SubagentDetailMessageFlow messages={items} provider="pilotdeck" selectedProject={null}
          createDiff={() => []} isRunning={isRunning} />
      </FindShortcutProvider>
    </I18nextProvider>
  );
  const view = render(pane(true));
  fireEvent.click(view.container.querySelector('.tool-call button[aria-expanded]') as HTMLButtonElement);
  expect(screen.getByRole('button', { name: 'Running Build app' })).toBeTruthy();
  expect(screen.getAllByText('Running…').length).toBeGreaterThan(0);
  expect(screen.queryByText('No result recorded')).toBeNull();

  // Ending the subagent without a tool result must stop claiming execution.
  view.rerender(pane(false));
  expect(screen.getAllByText('No result recorded').length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Running Build app' })).toBeNull();

  // Same message reference: this also detects a stale rendering callback.
  view.rerender(pane(true));
  expect(screen.getByRole('button', { name: 'Running Build app' })).toBeTruthy();
  expect(screen.queryByText('No result recorded')).toBeNull();

  view.rerender(pane(true, messages.map(message => ({
    ...message, toolResult: { content: 'Build complete.', isError: false },
  }))));
  expect(screen.getByRole('button', { name: 'Ran Build app' })).toBeTruthy();
  expect(screen.getByText('Build complete.')).toBeTruthy();
  expect(screen.getByText('Success')).toBeTruthy();
  expect(screen.queryByText('Running…')).toBeNull();
});

it('places child file results after trailing tools and outside the process disclosure', () => {
  const messages: ChatMessage[] = [
    { ...assistant('child-progress', 'Checking generated files.'), turnId: 'child-turn', artifacts: [{
      id: 'child-report', name: 'child.txt', path: 'child.txt', operation: 'created', source: 'workspace_diff',
      status: 'incomplete', size: 42, sha256: 'a'.repeat(64), createdAt: timestamp(100),
    }] },
    { ...tool('child-verify', 'run_command'), turnId: 'child-turn', toolResult: { content: 'verified' } },
  ];
  const view = renderFlow(messages, false);
  const card = screen.getByTestId('turn-changes-card');
  const work = view.container.querySelector('[data-process-block]')!;
  expect(work.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(card.closest('[data-turn-process-region], [data-process-block]')).toBeNull();
});

it('keeps a recovering intermediate video visible after the child turn stops', () => {
  const call: ChatMessage = { ...tool('child-video', 'generate_video'), toolInput: { purpose: 'intermediate' },
    toolResult: { isError: true, content: 'Wait stopped' }, videoJob: { id: 'job', sessionId: 'child', toolCallId: 'child-video',
      purpose: 'intermediate', state: 'reconnecting' } };
  const view = renderFlow([call], false);
  const surface = view.container.querySelector('.generated-image-surface')!;
  expect(surface.getAttribute('aria-busy')).toBe('true');
  expect(surface.closest('[data-turn-process-region], [data-process-block]')).toBeNull();
});

it('shows the model-call spinner after a child tool finishes and hides it during output', () => {
  const pending = tool('child-model-tool', 'Read');
  const view = (messages: ChatMessage[]) => <FindShortcutProvider activeScope="chat">
    <SubagentDetailMessageFlow messages={messages} provider="pilotdeck" selectedProject={null} createDiff={() => []} isRunning />
  </FindShortcutProvider>;
  const result = render(view([pending]));
  const status = () => result.container.querySelector('[data-process-status="subagent-model-call"]');
  expect(status()).toBeNull();
  const finished = { ...pending, toolResult: { content: 'Read complete.' } };
  result.rerender(view([finished, thinking('child-model-thought', 'Verify the result.')]));
  expect(status()?.textContent).toContain('Calling model...');
  expect(status()?.querySelector('svg')?.getAttribute('class')).toContain('motion-safe:animate-spin');
  result.rerender(view([finished, streamingThinking('Continuing the reasoning.')]));
  expect(status()).toBeNull();
  result.rerender(view([finished, { ...assistant('child-model-reply', 'Done.'), isStreaming: true }]));
  expect(status()).toBeNull();
});

it('folds inspected child work on a streaming reply and retains details when reopened', () => {
  const call = { ...tool('child-inspect', 'Read'), toolResult: { content: 'Inspectable file contents' } };
  const element = (messages: ChatMessage[], running: boolean) => <FindShortcutProvider activeScope="chat">
    <SubagentDetailMessageFlow messages={messages} provider="pilotdeck" selectedProject={null} createDiff={() => []} isRunning={running} />
  </FindShortcutProvider>;
  const view = render(element([call], true));
  const toolToggle = view.container.querySelector('.tool-call > div > button')!;
  fireEvent.click(toolToggle);
  const reply = { ...assistant('child-finished-inspection', 'Inspection complete.'), isStreaming: true };
  view.rerender(element([call, reply], true));
  const process = view.container.querySelector('[data-process-block] > button')!;
  expect(process.getAttribute('aria-expanded')).toBe('false');
  expect(toolToggle.closest('[aria-hidden="true"]')).not.toBeNull();
  fireEvent.click(process);
  view.rerender(element([call, { ...reply, content: 'Inspection complete. Verified.' }], true));
  expect(toolToggle.getAttribute('aria-expanded')).toBe('true');
  expect(process.getAttribute('aria-expanded')).toBe('true');
  view.rerender(element([call, { ...reply, isStreaming: false }], false));
  const turn = view.container.querySelector('[data-turn-process-header] button')!;
  expect(turn.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(turn);
  expect(process.getAttribute('aria-expanded')).toBe('true');
  expect(toolToggle.getAttribute('aria-expanded')).toBe('true');
});

it('folds inspected child batches at the limit and keeps a short live tail expanded', () => {
  const calls = Array.from({ length: 13 }, (_, index) => ({ ...tool(`child-batch-${index}`, 'bash'),
    toolInput: { command: `check ${index}` }, toolResult: { content: 'ok' } }));
  const element = (count: number) => <FindShortcutProvider activeScope="chat">
    <SubagentDetailMessageFlow messages={calls.slice(0, count)} provider="pilotdeck" selectedProject={null}
      createDiff={() => []} isRunning />
  </FindShortcutProvider>;
  const view = render(element(2));
  fireEvent.click(view.container.querySelector('.tool-call > div > button')!);
  view.rerender(element(12));
  const first = view.container.querySelector('[data-process-block] > button')!;
  expect(first.getAttribute('aria-expanded')).toBe('false');
  view.rerender(element(13));
  expect(Array.from(view.container.querySelectorAll('[data-process-block] > button'),
    button => button.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  fireEvent.click(first);
  expect(view.container.querySelector('[data-tool-id="child-batch-0"] button')!.getAttribute('aria-expanded')).toBe('true');
});
