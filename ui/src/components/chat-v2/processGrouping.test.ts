import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../stores/useSessionStore';
import type { ChatMessage } from '../chat/types/types';
import { normalizedToChatMessages } from '../chat/hooks/useChatMessages';
import {
  buildRenderableMessageItems,
  getLiveProcessGroups,
  hasPendingWebFetchInRunningGroup,
  shouldShowWebFetchWaitingHint,
  splitLiveProcessGroupDetailMessages,
  type LiveProcessGroup,
  type RenderableMessageItem,
} from './processGrouping';

const baseTime = Date.parse('2026-05-18T08:00:00.000Z');

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
      tool('grep-1', 'Grep', { pattern: 'MessagesPaneV2' }, 300),
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
      tool('grep-1', 'Grep', { pattern: 'MessagesPaneV2' }, 300),
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

  it('does not render thinking as standalone after empty live assistant shells', () => {
    const messages = [
      user('u1'),
      assistant('a1', 'Starting work.', 100),
      tool('bash-1', 'Bash', { command: 'head -30 package.json' }, 200, null),
      assistant('a-empty', '', 250),
      thinking('think-1', 'Inspect the command output next.', 300),
    ];

    const items = buildRenderableMessageItems(messages, { isAssistantWorking: true });
    const groups = getLiveProcessGroups(messages, { isAssistantWorking: true });

    expect(items.map((item) => item.message.id)).toEqual(['u1', 'a1']);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages.map((message) => message.id)).toEqual(['bash-1', 'think-1']);
    expect(groups[0].detailMessages.map((message) => message.id)).toEqual(['bash-1', 'think-1']);
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
      normalizedTool('grep-1', 'Grep', { pattern: 'MessagesPaneV2' }, 300),
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
