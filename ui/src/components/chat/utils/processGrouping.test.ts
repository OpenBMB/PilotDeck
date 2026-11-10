import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import {
  buildRenderableMessageItems,
  groupProcessIntervals,
  getLiveProcessGroups,
  hasPendingWebFetchInRunningGroup,
  shouldShowWebFetchWaitingHint,
  splitLiveProcessGroupDetailMessages,
  type LiveProcessGroup,
  type RenderableMessageItem,
} from './processGrouping';

const baseTime = Date.parse('2026-05-18T08:00:00.000Z');

describe('turn file result placement', () => {
  it('keeps early artifacts at the turn tail and hides them until execution stops', () => {
    const artifacts: NonNullable<ChatMessage['artifacts']> = [{ id: 'report', name: 'report.txt', path: 'report.txt',
      operation: 'created', source: 'workspace_diff', status: 'incomplete', size: 42, sha256: 'a'.repeat(64), createdAt: timestamp(1000) }];
    const messages: ChatMessage[] = [user('u1'), { ...assistant('progress', 'Checking the result'), turnId: 'turn-1', artifacts },
      { ...tool('verify', 'run_command'), turnId: 'turn-1' }];
    const project = (input: ChatMessage[], running: boolean) => groupProcessIntervals(input,
      buildRenderableMessageItems(input, { isAssistantWorking: running }), running);
    const live = project(messages, true);
    expect(live.filter(item => item.turnFiles)).toHaveLength(1);
    expect(live.at(-1)?.turnFiles).toEqual({ turnId: 'turn-1', artifacts, visible: false });
    expect(live.find(item => item.message.id === 'progress')?.turnFiles).toBeUndefined();
    const stopped = project(messages, false);
    expect(stopped.at(-1)?.turnFiles).toEqual({ turnId: 'turn-1', artifacts, visible: true });
    const completed = project([...messages, { ...assistant('final', 'Done'), turnId: 'turn-1-resumed' },
      user('u2'), { ...assistant('next', 'Another turn'), turnId: 'turn-2' }], true);
    expect(completed.find(item => item.message.id === 'final')?.turnFiles).toEqual({ turnId: 'turn-1-resumed', artifacts, visible: false });
    expect(completed.at(-1)?.turnFiles).toEqual({ turnId: 'turn-2', artifacts: [], visible: false });
    expect(messages[1].artifacts).toBe(artifacts);
  });
});

function timestamp(offsetMs: number): string {
  return new Date(baseTime + offsetMs).toISOString();
}

function user(id: string, content = 'Do the work'): ChatMessage {
  return {
    id,
    type: 'user',
    content,
    timestamp: timestamp(0),
  };
}

function assistant(id: string, content: string, offsetMs = 1000): ChatMessage {
  return {
    id,
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
  };
}

function thinking(id: string, content = 'Thinking through the next step.', offsetMs = 500): ChatMessage {
  return {
    id,
    type: 'assistant',
    content,
    timestamp: timestamp(offsetMs),
    isThinking: true,
  };
}

function compact(id: string, offsetMs = 500): ChatMessage {
  return {
    id,
    type: 'system',
    content: 'Context compacted',
    timestamp: timestamp(offsetMs),
    isCompactBoundary: true,
    compactionId: id,
  };
}

function tool(
  id: string,
  toolName: string,
  input: Record<string, unknown> = {},
  offsetMs = 500,
  toolResult: ChatMessage['toolResult'] = { content: 'ok' },
): ChatMessage {
  return {
    id,
    type: 'assistant',
    content: '',
    timestamp: timestamp(offsetMs),
    isToolUse: true,
    toolName,
    toolId: id,
    toolInput: JSON.stringify(input),
    toolResult,
  };
}

function normalizedText(
  id: string,
  role: 'user' | 'assistant',
  content: string,
  offsetMs = 0,
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    provider: 'pilotdeck',
    kind: 'text',
    role,
    content,
    timestamp: timestamp(offsetMs),
  };
}

function normalizedTool(
  id: string,
  toolName: string,
  input: Record<string, unknown> = {},
  offsetMs = 0,
): NormalizedMessage {
  return {
    id,
    sessionId: 'session-1',
    provider: 'pilotdeck',
    kind: 'tool_use',
    toolName,
    toolId: id,
    toolInput: input,
    timestamp: timestamp(offsetMs),
  };
}

function processAttachments(item: RenderableMessageItem | undefined) {
  return [
    ...(item?.beforeProcessAttachments || []),
    ...(item?.afterProcessAttachments || []),
  ];
}

describe('processGrouping', () => {
  it('hides ordinary live tools while keeping assistant prose visible', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'I will inspect the files.', 100),
      tool('read-1', 'Read', { file_path: '/repo/src/App.tsx' }, 200),
      tool('grep-1', 'Grep', { pattern: 'ProcessTrace' }, 300),
    ];

    const items = buildRenderableMessageItems(messages, { isAssistantWorking: true });
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(groups).toHaveLength(1);
    expect(groups[0].afterOriginalIndex).toBe(1);
    expect(groups[0].detailMessages.map((message) => message.toolName)).toEqual(['Read', 'Grep']);
  });

  it('summarizes Read and Grep tools as explored files and searches', () => {
    const messages = [
      user('u1'),
      tool('read-1', 'Read', { file_path: '/repo/src/App.tsx' }, 100),
      tool('read-2', 'Read', { file_path: '/repo/src/index.tsx' }, 200),
      tool('grep-1', 'Grep', { pattern: 'MessagesPane' }, 300),
      assistant('a1', 'Here is what I found.', 400),
    ];

    const items = buildRenderableMessageItems(messages);
    const assistantItem = items.find((item) => item.message.id === 'a1');

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    const attachment = processAttachments(assistantItem)[0];
    expect(attachment?.processDetailMessages.map((message) => message.id)).toEqual([
      'read-1',
      'read-2',
      'grep-1',
    ]);
    expect(attachment?.processSummary.exploredFileCount).toBe(2);
    expect(attachment?.processSummary.ragSearchCount).toBe(1);
    expect(attachment?.processSummary.toolCallCount).toBe(3);
    expect(attachment?.inlineImages).toEqual([]);
  });

  it('surfaces tool-result images outside the collapsed trace', () => {
    const imageDataUrl = 'data:image/jpeg;base64,/9j/4AAQ';
    const messages = [
      user('u1'),
      tool(
        'read-1',
        'Read',
        { file_path: '/Users/me/Downloads/3D.jpg' },
        100,
        {
          content: '[Image file]',
          images: [{ data: imageDataUrl, name: '3D.jpg', mimeType: 'image/jpeg' }],
        } as ChatMessage['toolResult'],
      ),
      assistant('a1', 'This is a 3D surface plot.', 200),
    ];

    const items = buildRenderableMessageItems(messages);
    const attachment = processAttachments(items.find((item) => item.message.id === 'a1'))[0];

    expect(attachment?.inlineImages).toEqual([
      {
        data: imageDataUrl,
        name: '3D.jpg',
        mimeType: 'image/jpeg',
        source: 'tool_result',
        toolId: 'read-1',
      },
    ]);
  });

  it('summarizes edit tools with unique edited file count', () => {
    const messages = [
      user('u1'),
      tool('edit-1', 'Edit', { file_path: '/repo/src/App.tsx' }, 100),
      tool('write-1', 'Write', { file_path: '/repo/src/App.tsx' }, 200),
      tool('patch-1', 'ApplyPatch', { file_path: '/repo/src/styles.css' }, 300),
      assistant('a1', 'Updated the UI.', 400),
    ];

    const items = buildRenderableMessageItems(messages);
    const summary = processAttachments(items.find((item) => item.message.id === 'a1'))[0]?.processSummary;

    expect(summary?.editedFileCount).toBe(2);
    expect(summary?.toolCallCount).toBe(3);
  });

  it('summarizes Bash tools as command activity', () => {
    const messages = [
      user('u1'),
      tool('bash-1', 'Bash', { command: 'npm test' }, 100),
      tool('bash-2', 'Bash', { command: 'npm run lint' }, 200),
      assistant('a1', 'Checks are done.', 300),
    ];

    const items = buildRenderableMessageItems(messages);
    const summary = processAttachments(items.find((item) => item.message.id === 'a1'))[0]?.processSummary;

    expect(summary?.commandCount).toBe(2);
    expect(summary?.toolCallCount).toBe(2);
  });

  it('folds ordinary failed tools into process summaries and counts errors', () => {
    const failedResult = {
      content: '<tool_use_error>InputValidationError: missing file_path</tool_use_error>',
      isError: true,
      errorCode: 'tool_execution_failed',
    };
    const messages = [
      user('u1'),
      tool('edit-1', 'Edit', { file_path: '/repo/src/App.tsx' }, 100, failedResult),
      tool('grep-1', 'Grep', { pattern: 'Footer' }, 200, failedResult),
      tool('bash-1', 'Bash', { command: 'npm run build' }, 300, failedResult),
      assistant('a1', 'I will retry with corrected inputs.', 400),
    ];

    const items = buildRenderableMessageItems(messages);
    const assistantItem = items.find((item) => item.message.id === 'a1');
    const attachment = processAttachments(assistantItem)[0];

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(attachment?.processDetailMessages.map((message) => message.id)).toEqual([
      'edit-1',
      'grep-1',
      'bash-1',
    ]);
    expect(attachment?.processSummary.toolCallCount).toBe(3);
    expect(attachment?.processSummary.toolErrorCount).toBe(3);
    expect(attachment?.processSummary.editedFileCount).toBe(1);
    expect(attachment?.processSummary.ragSearchCount).toBe(1);
    expect(attachment?.processSummary.commandCount).toBe(1);
  });

  it('keeps completed process summaries segmented at their original assistant positions', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'First I will inspect files.', 100),
      tool('read-1', 'Read', { file_path: '/repo/src/App.tsx' }, 200),
      assistant('a2', 'Now I will run checks.', 300),
      tool('bash-1', 'Bash', { command: 'npm test' }, 400),
      assistant('a3', 'Done.', 500),
    ];

    const items = buildRenderableMessageItems(messages);
    const firstAssistant = items.find((item) => item.message.id === 'a1');
    const secondAssistant = items.find((item) => item.message.id === 'a2');
    const thirdAssistant = items.find((item) => item.message.id === 'a3');

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1', 'a2', 'a3']);
    expect(firstAssistant?.afterProcessAttachments).toHaveLength(1);
    expect(firstAssistant?.afterProcessAttachments[0].processSummary.exploredFileCount).toBe(1);
    expect(secondAssistant?.afterProcessAttachments).toHaveLength(1);
    expect(secondAssistant?.afterProcessAttachments[0].processSummary.commandCount).toBe(1);
    expect(thirdAssistant?.beforeProcessAttachments).toHaveLength(0);
    expect(processAttachments(thirdAssistant)).toHaveLength(0);
  });

  it('keeps alternating thinking and tool segments in chronological order after completion', () => {
    const transcript = [user('u'), thinking('think-a'), tool('read', 'Read'), thinking('think-b'), tool('bash', 'Bash'), assistant('answer', 'Done')];
    const items = buildRenderableMessageItems(transcript, { isAssistantWorking: false });
    const timeline = items.flatMap((item) => [
      ...item.beforeProcessAttachments.flatMap((attachment) => attachment.processDetailMessages.map((message) => message.id)),
      item.message.id,
      ...item.afterProcessAttachments.flatMap((attachment) => attachment.processDetailMessages.map((message) => message.id)),
    ]);
    expect(timeline).toEqual(transcript.map((message) => message.id));
  });

  it('attaches completed run duration after the user turn finishes', () => {
    const messages: ChatMessage[] = [
      user('u1'),
      assistant('a1', 'I finished the work.', 5000),
      {
        id: 'summary-1',
        type: 'system',
        content: 'Process summary',
        timestamp: timestamp(81000),
        isAgentActivitySummary: true,
        durationMs: 80000,
        state: 'completed',
      },
    ];

    const items = buildRenderableMessageItems(messages);
    const userItem = items.find((item) => item.message.id === 'u1');

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(userItem?.afterRunAttachment?.durationMs).toBe(80000);
  });

  it('attaches a leading completed process segment before the next assistant message', () => {
    const messages = [
      user('u1'),
      tool('read-1', 'Read', { file_path: '/repo/src/App.tsx' }, 100),
      assistant('a1', 'Here is what I found.', 200),
    ];

    const items = buildRenderableMessageItems(messages);
    const assistantItem = items.find((item) => item.message.id === 'a1');

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(assistantItem?.beforeProcessAttachments).toHaveLength(1);
    expect(assistantItem?.beforeProcessAttachments[0].processSummary.exploredFileCount).toBe(1);
    expect(assistantItem?.afterProcessAttachments).toHaveLength(0);
  });

  it('keeps a mid-turn compact boundary folded with the process before the final answer', () => {
    const messages = [
      user('u1'),
      tool('bash-1', 'Bash', { command: 'build workbook' }, 100),
      compact('compact-1', 200),
      tool('bash-2', 'Bash', { command: 'deliver workbook' }, 300),
      assistant('a-final', 'Workbook delivered.', 400),
    ];

    const items = buildRenderableMessageItems(messages);
    const finalAssistant = items.find((item) => item.message.id === 'a-final');

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a-final']);
    expect(finalAssistant?.beforeProcessAttachments).toHaveLength(1);
    expect(finalAssistant?.beforeProcessAttachments[0].processSummary.compactCount).toBe(1);
    expect(finalAssistant?.beforeProcessAttachments[0].processSummary.commandCount).toBe(2);
    expect(finalAssistant?.afterProcessAttachments).toHaveLength(0);
  });

  it('folds a recovered trailing compact boundary before the completed final answer', () => {
    const messages = [
      user('u1'),
      assistant('a-final', 'Workbook delivered.', 300),
      compact('compact-recovered', 400),
    ];

    const items = buildRenderableMessageItems(messages);
    const finalAssistant = items.find((item) => item.message.id === 'a-final');

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a-final']);
    expect(finalAssistant?.beforeProcessAttachments).toHaveLength(1);
    expect(finalAssistant?.beforeProcessAttachments[0].processSummary.compactCount).toBe(1);
    expect(finalAssistant?.afterProcessAttachments).toHaveLength(0);
  });

  it('does not hide user-visible prompts, plan exits, permissions, or errors', () => {
    const permissionError = {
      content: 'Permission required',
      isError: true,
      errorCode: 'permission_required',
    };
    const messages = [
      user('u1'),
      tool('ask-1', 'AskUserQuestion', { question: 'Continue?' }, 100),
      tool('plan-1', 'ExitPlanMode', { plan: 'Do it' }, 200),
      tool('denied-1', 'Bash', { command: 'rm file' }, 300, permissionError),
      {
        id: 'error-1',
        type: 'error',
        content: 'Something failed',
        timestamp: timestamp(400),
      },
      assistant('a1', 'Waiting on you.', 500),
    ];

    const items = buildRenderableMessageItems(messages);

    expect(items.map((item) => item.message.id)).toEqual([
      'u1',
      'ask-1',
      'plan-1',
      'denied-1',
      'error-1',
      'a1',
    ]);
    expect(processAttachments(items.find((item) => item.message.id === 'a1'))).toHaveLength(0);
  });

  it('folds plan-mode side-effect denials into the process row', () => {
    const planModeDeny = {
      content: 'Plan mode denies side-effecting tool bash.',
      isError: true,
      errorCode: 'permission_denied',
    };
    const messages = [
      user('u1'),
      tool('plan-deny-1', 'bash', { command: 'cd .' }, 100, planModeDeny),
      assistant('a1', 'I will continue with a plan.', 200),
    ];

    const items = buildRenderableMessageItems(messages);
    const assistantItem = items.find((item) => item.message.id === 'a1');
    const attachments = processAttachments(assistantItem);

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].processDetailMessages.map((message) => message.id)).toEqual(['plan-deny-1']);
    expect(attachments[0].processSummary.toolErrorCount).toBe(1);
  });

  it('folds structured plan-mode violations into the process row', () => {
    const planModeDeny = {
      content: '[PLAN_MODE_VIOLATION] Tool "edit_notebook" is BLOCKED in plan mode.',
      isError: true,
      errorCode: 'plan_mode_violation',
    };
    const messages = [
      user('u1'),
      tool('plan-deny-1', 'edit_notebook', { file_path: 'notebook.ipynb' }, 100, planModeDeny),
      assistant('a1', 'I will continue with a plan.', 200),
    ];

    const items = buildRenderableMessageItems(messages);
    const assistantItem = items.find((item) => item.message.id === 'a1');
    const attachments = processAttachments(assistantItem);

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].processDetailMessages.map((message) => message.id)).toEqual(['plan-deny-1']);
    expect(attachments[0].processSummary.toolErrorCount).toBe(1);
  });

  it('detects a pending web_fetch in a running plan-mode process group', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'Let me fetch that page.', 100),
      {
        ...tool('fetch-1', 'web_fetch', { url: 'https://example.com' }, 200),
        toolResult: undefined,
      },
    ];
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(shouldShowWebFetchWaitingHint(groups[0], true)).toBe(true);
    expect(hasPendingWebFetchInRunningGroup(groups, true)).toBe(true);
    expect(hasPendingWebFetchInRunningGroup(groups, false)).toBe(false);
  });

  it('detects pending web_fetch across multiple live process groups', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'Search first.', 100),
      tool('search-1', 'web_search', { query: 'antd' }, 200),
      tool('grep-1', 'Grep', { pattern: 'antd' }, 300),
      assistant('a2', 'Now fetch docs.', 400),
      {
        ...tool('fetch-1', 'web_fetch', { url: 'https://example.com' }, 500),
        toolResult: undefined,
      },
    ];
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(groups).toHaveLength(2);
    expect(shouldShowWebFetchWaitingHint(groups[0], true)).toBe(false);
    expect(shouldShowWebFetchWaitingHint(groups[1], true)).toBe(true);
    expect(hasPendingWebFetchInRunningGroup(groups, true)).toBe(true);
  });

  it('does not treat a completed web_fetch as pending', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'Let me fetch that page.', 100),
      tool('fetch-1', 'web_fetch', { url: 'https://example.com' }, 200),
    ];
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(shouldShowWebFetchWaitingHint(groups[0], true)).toBe(false);
    expect(hasPendingWebFetchInRunningGroup(groups, true)).toBe(false);
  });

  it('drops empty assistant shells and keeps live process groups anchored to prose', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'Starting work.', 100),
      tool('read-1', 'Read', { file_path: '/repo/src/App.tsx' }, 200),
      assistant('a-empty-1', '', 250),
      tool('grep-1', 'Grep', { pattern: 'MessagesPane' }, 300),
      assistant('a-empty-2', '', 350),
      assistant('a-final', 'Here is the result.', 400),
    ];

    const items = buildRenderableMessageItems(messages, { isAssistantWorking: true });
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1', 'a-final']);
    expect(groups).toHaveLength(1);
    expect(groups[0].afterOriginalIndex).toBe(1);
    expect(groups[0].messages.map((message) => message.id)).toEqual(['read-1', 'grep-1']);
  });

  it('keeps thinking standalone after empty live assistant shells to preserve its viewport', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'Starting work.', 100),
      tool('bash-1', 'Bash', { command: 'head -30 package.json' }, 200, null),
      assistant('a-empty', '', 250),
      thinking('think-1', 'Inspect the command output next.', 300),
    ];

    const items = buildRenderableMessageItems(messages, { isAssistantWorking: true });
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1', 'think-1']);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages.map((message) => message.id)).toEqual(['bash-1']);
    expect(groups[0].detailMessages.map((message) => message.id)).toEqual(['bash-1']);
  });

  it('keeps leading live thinking inside the current running status details', () => {
    const group: LiveProcessGroup = {
      id: 'group-1',
      afterOriginalIndex: 1,
      beforeOriginalIndex: null,
      startIndex: 2,
      endIndex: 4,
      messages: [
        thinking('think-1', 'Decide which file to edit.', 200),
        tool('edit-1', 'Edit', { file_path: '/repo/src/App.tsx' }, 300, null),
      ],
      detailMessages: [
        thinking('think-1', 'Decide which file to edit.', 200),
        tool('edit-1', 'Edit', { file_path: '/repo/src/App.tsx' }, 300, null),
      ],
      isRunning: true,
    };

    const split = splitLiveProcessGroupDetailMessages(group);

    expect(split.beforeStatusMessages).toEqual([]);
    expect(split.statusDetailMessages.map((message) => message.id)).toEqual(['think-1', 'edit-1']);
  });

  it('keeps normalized empty assistant shells available as process separators', () => {
    const normalized = [
      normalizedText('u1', 'user', 'Do the work'),
      normalizedText('a1', 'assistant', 'Starting work.', 100),
      normalizedTool('read-1', 'Read', { file_path: '/repo/src/App.tsx' }, 200),
      normalizedText('a-empty-1', 'assistant', '', 250),
      normalizedTool('grep-1', 'Grep', { pattern: 'MessagesPane' }, 300),
      normalizedText('a-empty-2', 'assistant', '', 350),
      normalizedText('a-final', 'assistant', 'Here is the result.', 400),
    ];

    const messages = normalizedToChatMessages(normalized);
    const items = buildRenderableMessageItems(messages, { isAssistantWorking: true });
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'read-1',
      'a-empty-1',
      'grep-1',
      'a-empty-2',
      'a-final',
    ]);
    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1', 'a-final']);
    expect(groups).toHaveLength(1);
    expect(groups.map((group) => group.messages.map((message) => message.id))).toEqual([
      ['read-1', 'grep-1'],
    ]);
  });

  it('still drops unrelated normalized empty assistant messages', () => {
    const empty = normalizedText('a-empty', 'assistant', '');

    expect(normalizedToChatMessages([
      normalizedText('u1', 'user', 'Hello'),
      empty,
    ]).map((message) => message.id)).toEqual(['u1']);

    expect(normalizedToChatMessages([
      normalizedText('u1', 'user', 'Hello'),
      normalizedTool('read-1', 'Read', { file_path: '/repo/src/App.tsx' }, 100),
      empty,
    ]).map((message) => message.id)).toEqual(['u1', 'read-1', 'a-empty']);
  });
});


describe('process seats between visible replies', () => {
  const fold = (messages: ChatMessage[], working = false) => groupProcessIntervals(
    messages, buildRenderableMessageItems(messages, { isAssistantWorking: working }), working,
  );
  it.each(['thinking', 'prose'])('keeps compaction after preceding %s in timeline order', kind => {
    const preceding = kind === 'thinking' ? thinking('before') : assistant('before', 'Before compact');
    const items = fold([user('u'), preceding, compact('middle'), assistant('final', 'After compact')]);
    const projected = items.flatMap(item => item.turnTrace?.items ?? [item]);
    expect(projected.map(item => item.message.id)).toEqual(['u', 'before', 'middle', 'final']);
    expect(items.find(item => item.turnTrace)?.turnTrace?.defaultExpanded).toBe(false);
    if (kind === 'prose') expect(items.some(item => item.message === preceding)).toBe(true);
  });
  it('keeps unfinished work open and retains stable identity through tools and final prose', () => {
    const first = { ...thinking('transient'), renderKey: 'canonical-thought' };
    const live = fold([user('u'), first], true)[1];
    const next = fold([user('u'), { ...first, id: 'persisted' }, tool('read', 'Read')], true)[1];
    const closed = fold([user('u'), first, tool('read', 'Read'), assistant('a', 'Done')])[1];
    expect(live.turnTrace?.isLive).toBe(true);
    expect(live.turnTrace?.defaultExpanded).toBe(true);
    expect(next.message.renderKey).toBe(live.message.renderKey);
    expect(closed.message.renderKey).toBe(live.message.renderKey);
    expect(closed.turnTrace?.defaultExpanded).toBe(false);
    expect(closed.turnTrace?.items.map(item => item.message.id)).toEqual(['transient', 'read']);
  });
  it('groups each prose interval independently without mutating the source', () => {
    const messages = [user('u'), thinking('t'), tool('read', 'Read'), assistant('interim', 'An update'),
      thinking('t2'), tool('bash', 'Bash'), assistant('final', 'Answer')];
    const original = JSON.stringify(messages);
    const items = fold(messages, true);
    expect(items.map(item => item.turnTrace ? 'process' : item.message.id)).toEqual(['u','process','interim','process','final']);
    expect(items.filter(item => item.turnTrace).every(item => !item.turnTrace?.defaultExpanded)).toBe(true);
    expect(JSON.stringify(messages)).toBe(original);
  });
  it('keeps artifact-only replies and all prose outside work seats', () => {
    const final = { ...assistant('final', ''), artifacts: [{
      id: 'file', name: 'result.md', path: '/result.md', operation: 'created' as const,
      source: 'tool' as const, status: 'complete' as const, size: 12, sha256: 'hash', createdAt: timestamp(1000),
    }] };
    const items = fold([user('u'), assistant('intermediate', 'Writing a file'), tool('read','Read'), final]);
    expect(items.at(-1)?.message).toBe(final);
    expect(items[1].message.content).toBe('Writing a file');
  });
  it.each(['error', 'interrupted'])('keeps %s visible and preceding incomplete work open', kind => {
    const notice = { ...assistant('notice', 'Stopped'), type: kind === 'error' ? 'error' as const : 'assistant' as const,
      isInterruptedNotice: kind === 'interrupted' };
    const items = fold([user('u'), thinking('t'), notice]);
    expect(items[1].turnTrace?.defaultExpanded).toBe(true);
    expect(items[2].message).toBe(notice);
  });
  it.each(['AskUserQuestion', 'ask_user_question', 'ExitPlanMode'])('keeps interactive %s outside work', name => {
    const question = tool('question', name);
    const items = fold([user('u'), thinking('t'), question, thinking('next')], true);
    expect(items[2].message).toBe(question);
    expect(items[1].turnTrace?.defaultExpanded).toBe(false);
    expect(items[3].turnTrace?.isLive).toBe(true);
  });
});

describe('turn-wide process disclosure', () => {
  const project = (messages: ChatMessage[], working = false) => groupProcessIntervals(messages,
    buildRenderableMessageItems(messages, { isAssistantWorking: working }), working);
  it('gives prose and tools one stable owner while retaining only the final reply', () => {
    const raw = [user('u'), thinking('t'), tool('read', 'Read'), assistant('progress', 'A progress reply'),
      tool('bash', 'Bash'), assistant('final', 'The final answer', 29000)];
    const live = project(raw.slice(0, -1), true);
    const finished = project(raw);
    const owner = finished[0].afterTurnProcess!;
    expect(owner.id).toBe(live[0].afterTurnProcess?.id);
    expect(owner.defaultExpanded).toBe(false);
    expect(owner.durationMs).toBe(29000);
    expect(owner.memberIds).toEqual(['process-block-u-t', 'progress', 'process-block-u-bash']);
    expect(finished.filter(item => item.processRun).every(item => item.processRun === owner)).toBe(true);
    expect(finished.find(item => item.message.id === 'progress')?.processOutput).toBe(false);
    expect(finished.find(item => item.message.id === 'final')?.processOutput).toBe(true);
    expect(finished.every(item => !item.beforeRunAttachment && !item.afterRunAttachment)).toBe(true);
  });
  it('uses the recorded duration and includes answered questions and subagents', () => {
    const question = { ...tool('question', 'AskUserQuestion'), toolResult: { content: 'Answered', toolUseResult: { answers: { Route: 'Continue' } } } };
    const child = { ...assistant('child', ''), isSubagentContainer: true, subagentId: 'child' };
    const raw = [user('u'), question, child, assistant('answer', 'Finished'), {
      ...assistant('summary', ''), isAgentActivitySummary: true, state: 'completed', durationMs: 34500,
    }];
    const items = project(raw);
    expect(items[0].afterTurnProcess?.durationMs).toBe(34500);
    expect(items.filter(item => item.processRun && !item.processOutput).map(item => item.message.id)).toEqual(['question', 'child']);
  });
  it.each(['error', 'interrupted', 'unfinished'])('leaves %s work accessible', kind => {
    const raw = [user('u'), tool('call', 'Read')];
    if (kind !== 'unfinished') raw.push({ ...assistant('notice', 'Stopped'), type: kind === 'error' ? 'error' : 'assistant', isInterruptedNotice: kind === 'interrupted' });
    const items = project(raw);
    expect(items[0].afterTurnProcess?.defaultExpanded).toBe(kind !== 'interrupted');
    expect(items.find(item => item.message.id === 'notice')?.processRun).toBeUndefined();
  });
  it('folds stopped partial replies and projects one notice outside the process when only a cancelled summary exists', () => {
    const raw = [user('u'), thinking('t'), tool('read', 'Read'), assistant('partial', 'A partial reply'), {
      ...assistant('summary', ''), isAgentActivitySummary: true, state: 'cancelled', durationMs: 90000,
    }];
    const items = project(raw);
    const group = items[0].afterTurnProcess!;
    expect(group).toMatchObject({ defaultExpanded: false, outcome: 'cancelled', durationMs: 90000 });
    expect(items.find(item => item.message.id === 'partial')).toMatchObject({ processOutput: false, processRun: group });
    expect(items.at(-1)?.message.isInterruptedNotice).toBe(true);
    expect(items.at(-1)?.processRun).toBeUndefined();
    const notice = { ...assistant('stop', ''), type: 'system' as const, isInterruptedNotice: true };
    expect(project([...raw, notice]).filter(item => item.message.isInterruptedNotice)).toHaveLength(1);
  });
  it('folds pending questions after cancellation while keeping their recorded input inspectable', () => {
    const question = { ...tool('question', 'AskUserQuestion'), toolResult: null };
    const items = project([user('u'), question, {
      ...assistant('summary', ''), isAgentActivitySummary: true, state: 'cancelled', durationMs: 1000,
    }]);
    expect(items[0].afterTurnProcess?.defaultExpanded).toBe(false);
    expect(items.find(item => item.message.id === 'question')?.processRun).toBe(items[0].afterTurnProcess);
  });
  it('assigns a restored timing summary by run identity when execution started before the accepted input', () => {
    const oldUser = { ...user('old-user'), runId: 'old' };
    const nextUser = { ...user('next-user'), runId: 'next', timestamp: timestamp(1100) };
    const summary = { ...assistant('status-timing', ''), type: 'system' as const, isAgentActivitySummary: true,
      runId: 'next', state: 'cancelled', startedAt: timestamp(1000), endedAt: timestamp(3000), durationMs: 2000 };
    const items = project([oldUser, { ...assistant('old-answer', 'Previous answer'), runId: 'old' }, summary,
      nextUser, { ...tool('next-call', 'Read'), runId: 'next' }]);
    const next = items.find(item => item.message.id === 'next-user')!.afterTurnProcess!;
    expect(next).toMatchObject({ defaultExpanded: false, outcome: 'cancelled', durationMs: 2000 });
    expect(items.find(item => item.message.id === 'old-user')?.afterTurnProcess?.outcome).not.toBe('cancelled');
    expect(items.filter(item => item.message.isInterruptedNotice)).toHaveLength(1);
    expect(items.at(-1)?.message.isInterruptedNotice).toBe(true);
  });
  it.each(['status', 'user'])('keeps a stopped steered run on its own boundaries with timing on %s', timingHost => {
    const turnTiming = { startedAt: timestamp(1000), completedAt: timestamp(3000), finishReason: 'aborted_streaming' };
    const messages: NormalizedMessage[] = [
      { id: 'old-user', sessionId: 'session', provider: 'pilotdeck', kind: 'text', role: 'user', content: 'Previous request', runId: 'old', timestamp: timestamp(0) },
      { id: 'old-answer', sessionId: 'session', provider: 'pilotdeck', kind: 'text', role: 'assistant', content: 'Previous answer', runId: 'old', timestamp: timestamp(100) },
      ...(timingHost === 'status' ? [{ id: 'timing', sessionId: 'session', provider: 'pilotdeck' as const, kind: 'status' as const, runId: 'next', timestamp: timestamp(1000), turnTiming }] : []),
      { id: 'next-user', sessionId: 'session', provider: 'pilotdeck', kind: 'text', role: 'user', content: 'Next request', runId: 'next', timestamp: timestamp(1200),
        ...(timingHost === 'user' ? { turnTiming } : {}) },
      { id: 'partial', sessionId: 'session', provider: 'pilotdeck', kind: 'text', role: 'assistant', content: 'Partial reply', runId: 'next', timestamp: timestamp(1500) },
      { id: 'steer', sessionId: 'session', provider: 'pilotdeck', kind: 'text', role: 'user', content: 'Continue this way', runId: 'next', isSteer: true, timestamp: timestamp(2000) },
      { id: 'call', sessionId: 'session', provider: 'pilotdeck', kind: 'tool_use', toolId: 'call', toolName: 'read_file', toolInput: { file_path: 'example.ts' }, runId: 'next', timestamp: timestamp(2500) },
    ];
    const items = project(normalizedToChatMessages(messages));
    expect(items.find(item => item.message.id === 'old-user')?.afterTurnProcess?.outcome).not.toBe('cancelled');
    expect(items.find(item => item.message.id === 'steer')?.afterTurnProcess).toMatchObject({ outcome: 'cancelled', defaultExpanded: false });
    expect(items.find(item => item.message.id === 'next-user')?.afterTurnProcess).toMatchObject({ outcome: 'cancelled', defaultExpanded: false });
    expect(items.find(item => item.message.id === 'partial')?.processOutput).toBe(false);
    expect(items.filter(item => item.message.isInterruptedNotice)).toHaveLength(1);
    expect(items.at(-1)?.message.isInterruptedNotice).toBe(true);
  });
  it('keeps pending questions and media outside the turn fold and tolerates invalid legacy timestamps', () => {
    const image = { ...tool('image', 'generate_image', { purpose: 'deliverable' }), toolResult: {
      content: 'Image', toolUseResult: { imageGeneration: { imageId: 'image', sessionId: 'session', purpose: 'deliverable' } },
    } };
    const raw = [{ ...user('u'), timestamp: 'invalid' }, { ...tool('question', 'AskUserQuestion'), toolResult: null }, image, assistant('answer', 'Finished')];
    const items = project(raw);
    expect(items.find(item => item.message.id === 'question')?.processRun).toBeUndefined();
    expect(items.filter(item => item.mediaArtifact)).toHaveLength(1);
    expect(items.find(item => item.mediaArtifact)?.processRun).toBeUndefined();
    expect(() => project(raw)).not.toThrow();
  });
});
