import {
  createTextContentReference,
  type ContentReference,
  type TextContentReference,
} from './contentReference';

export const ASSISTANT_REPLY_REFERENCE_PATH = '__pilotdeck__/assistant-reply';
export const ASSISTANT_REPLY_FILE_NAME = 'assistant-reply';
export const ASSISTANT_QUOTE_SOURCE_ATTR = 'data-assistant-quote-source';
export const ASSISTANT_QUOTE_MESSAGE_ID_ATTR = 'data-assistant-quote-message-id';
export const MAX_ASSISTANT_REPLY_QUOTE_LENGTH = 8000;

type CreateAssistantReplyReferenceInput = {
  selectedText: string;
  surroundingText?: string;
  messageId?: string;
};

function surroundingQuoteFields(fullText: string, selectedText: string) {
  const index = fullText.indexOf(selectedText);
  if (index < 0) return {};
  return {
    prefix: fullText.slice(Math.max(0, index - 80), index),
    suffix: fullText.slice(index + selectedText.length, index + selectedText.length + 80),
  };
}

export function isAssistantReplyContentReference(
  reference: ContentReference | null | undefined,
): reference is TextContentReference {
  if (!reference || reference.selectionMode !== 'text') return false;
  return reference.source.relativePath === ASSISTANT_REPLY_REFERENCE_PATH
    || reference.source.fileName === ASSISTANT_REPLY_FILE_NAME;
}

export function partitionContentReferences(references: ContentReference[]): {
  fileReferences: ContentReference[];
  replyQuotes: TextContentReference[];
} {
  const fileReferences: ContentReference[] = [];
  const replyQuotes: TextContentReference[] = [];
  for (const reference of references) {
    if (isAssistantReplyContentReference(reference)) {
      replyQuotes.push(reference);
    } else {
      fileReferences.push(reference);
    }
  }
  return { fileReferences, replyQuotes };
}

export function createAssistantReplyContentReference(
  input: CreateAssistantReplyReferenceInput,
): TextContentReference {
  const rawText = input.selectedText.replace(/\u00a0/g, ' ').trim();
  const truncated = rawText.length > MAX_ASSISTANT_REPLY_QUOTE_LENGTH;
  const selectedText = truncated
    ? rawText.slice(0, MAX_ASSISTANT_REPLY_QUOTE_LENGTH).trimEnd()
    : rawText;
  const surroundingText = (input.surroundingText || selectedText)
    .replace(/\s+/g, ' ')
    .trim();

  return createTextContentReference({
    selectionMode: 'text',
    source: {
      relativePath: ASSISTANT_REPLY_REFERENCE_PATH,
      fileName: ASSISTANT_REPLY_FILE_NAME,
    },
    renderer: {
      id: 'html',
      backend: 'builtin',
      locatorQuality: 'semantic',
    },
    locator: {
      surface: 'document',
      ...(input.messageId ? { headingPath: [`assistant:${input.messageId}`] } : {}),
      quote: {
        exact: selectedText,
        ...surroundingQuoteFields(surroundingText, selectedText),
      },
    },
    selectedText,
    surroundingText,
    truncated,
  });
}
