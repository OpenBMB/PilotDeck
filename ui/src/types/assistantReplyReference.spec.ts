import { describe, expect, it } from 'vitest';
import {
  createTextContentReference,
  formatContentReferencePromptBlock,
  isContentReference,
} from './contentReference';
import {
  ASSISTANT_REPLY_FILE_NAME,
  ASSISTANT_REPLY_REFERENCE_PATH,
  MAX_ASSISTANT_REPLY_QUOTE_LENGTH,
  createAssistantReplyContentReference,
  isAssistantReplyContentReference,
  partitionContentReferences,
} from './assistantReplyReference';

describe('assistantReplyReference', () => {
  it('creates a text content-reference that the existing prompt serializer accepts', () => {
    const reference = createAssistantReplyContentReference({
      selectedText: '2024 Yagi / 摩羯',
      surroundingText: 'Index Year Typhoon 2024 Yagi / 摩羯 landing',
      messageId: 'msg-1',
    });

    expect(isContentReference(reference)).toBe(true);
    expect(isAssistantReplyContentReference(reference)).toBe(true);
    expect(reference.source.relativePath).toBe(ASSISTANT_REPLY_REFERENCE_PATH);
    expect(reference.source.fileName).toBe(ASSISTANT_REPLY_FILE_NAME);
    expect(reference.locator.headingPath).toEqual(['assistant:msg-1']);

    const prompt = formatContentReferencePromptBlock([reference]);
    expect(prompt).toContain('[Content references selected by user:]');
    expect(prompt).toContain('2024 Yagi / 摩羯');
    expect(prompt).toContain('Reference JSON:');
  });

  it('does not treat workspace file references as reply quotes', () => {
    const fileReference = createTextContentReference({
      selectionMode: 'text',
      source: {
        relativePath: 'docs/report.xlsx',
        fileName: 'report.xlsx',
      },
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'semantic' },
      locator: {
        surface: 'document',
        quote: { exact: '格美' },
      },
      selectedText: '格美',
    });

    expect(isAssistantReplyContentReference(fileReference)).toBe(false);
    const partitioned = partitionContentReferences([fileReference]);
    expect(partitioned.fileReferences).toHaveLength(1);
    expect(partitioned.replyQuotes).toHaveLength(0);
  });

  it('truncates oversized quotes and keeps them valid content-references', () => {
    const selectedText = `${'台风统计 '.repeat(2000)}结尾`;
    const reference = createAssistantReplyContentReference({ selectedText });
    expect(reference.truncated).toBe(true);
    expect(reference.selectedText.length).toBeLessThanOrEqual(MAX_ASSISTANT_REPLY_QUOTE_LENGTH);
    expect(isContentReference(reference)).toBe(true);
  });
});
