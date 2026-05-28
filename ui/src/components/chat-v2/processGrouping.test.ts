import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import {
  buildRenderableMessageItems,
  getLiveProcessGroups,
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
});
