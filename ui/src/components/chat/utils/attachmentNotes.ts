import type { ChatAttachment } from '../types/types';
import {
  DOCUMENT_SELECTION_ATTACHMENT_KIND,
  parseDocumentSelectionPromptBlock,
  type DocumentSelectionReference,
} from '../../../types/documentSelection';
import {
  CONTENT_REFERENCE_ATTACHMENT_KIND,
  parseContentReferencePromptBlock,
  type ContentReference,
} from '../../../types/contentReference';

const ATTACHMENT_NOTE_MARKER = '[Files attached by user and available for reading in the project:]';
const ATTACHMENT_NOTE_END_MARKER = '[End files attached by user]';
// Older transcripts have no end marker. Their next canonical text block may
// be concatenated directly onto the final path during history projection.
const LEGACY_ATTACHMENT_NOTE_TERMINATORS = [
  ATTACHMENT_NOTE_END_MARKER,
  '[Attachment diagnostics]',
  '[Registered attachment files in this session:]',
  '[PDF attachment:',
  '<attachment ',
];

type AttachmentPathNoteFile = {
  name: string;
  path: string;
};

export function buildAttachmentPathNote(files: AttachmentPathNoteFile[]): string {
  if (files.length === 0) return '';

  const lines = files.map((file) => `- ${file.name}: ${file.path}`);
  return `\n\n${ATTACHMENT_NOTE_MARKER}\n${lines.join('\n')}\n${ATTACHMENT_NOTE_END_MARKER}\n`;
}

function sliceBeforeFirstMarker(value: string, markers: string[]): string {
  let endIndex = value.length;
  for (const marker of markers) {
    const markerIndex = value.indexOf(marker);
    if (markerIndex >= 0 && markerIndex < endIndex) {
      endIndex = markerIndex;
    }
  }
  return value.slice(0, endIndex);
}

function inferAttachmentMimeType(name: string, filePath: string): string | undefined {
  const source = `${name} ${filePath}`.toLowerCase();
  if (source.endsWith('.pdf')) return 'application/pdf';
  if (source.endsWith('.doc')) return 'application/msword';
  if (source.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (source.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (source.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (source.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (source.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (source.endsWith('.txt')) return 'text/plain';
  if (source.endsWith('.md') || source.endsWith('.markdown')) return 'text/markdown';
  if (source.endsWith('.json')) return 'application/json';
  if (source.endsWith('.csv')) return 'text/csv';
  if (source.endsWith('.xml')) return 'application/xml';
  if (source.endsWith('.png')) return 'image/png';
  if (source.endsWith('.jpg') || source.endsWith('.jpeg')) return 'image/jpeg';
  if (source.endsWith('.gif')) return 'image/gif';
  if (source.endsWith('.webp')) return 'image/webp';
  if (source.endsWith('.svg') || source.endsWith('.svgz')) return 'image/svg+xml';
  return undefined;
}

function isImageAttachmentMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('image/'));
}

export function parseUserAttachmentNote(content: unknown): {
  content: string;
  attachments: ChatAttachment[];
} {
  const parsedContentReferences = parseContentReferencePromptBlock(content);
  const parsedSelections = parseDocumentSelectionPromptBlock(parsedContentReferences.content);
  const text = parsedSelections.content;
  const markerIndex = text.indexOf(ATTACHMENT_NOTE_MARKER);
  const selectionAttachments = [
    ...parsedSelections.references.map(documentSelectionToAttachment),
    ...parsedContentReferences.references.map(contentReferenceToAttachment),
  ];
  if (markerIndex < 0) {
    return { content: text, attachments: selectionAttachments };
  }

  const visibleContent = text.slice(0, markerIndex).trimEnd();
  const note = sliceBeforeFirstMarker(
    text.slice(markerIndex + ATTACHMENT_NOTE_MARKER.length),
    LEGACY_ATTACHMENT_NOTE_TERMINATORS,
  );
  const attachments: ChatAttachment[] = [];

  for (const rawLine of note.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const separator = line.indexOf(': ');
    if (separator < 0) continue;

    const name = line.slice(2, separator).trim();
    const filePath = line.slice(separator + 2).trim();
    if (!name || !filePath) continue;
    const mimeType = inferAttachmentMimeType(name, filePath);
    if (isImageAttachmentMime(mimeType)) continue;

    attachments.push({
      name,
      path: filePath,
      mimeType,
    });
  }

  return { content: visibleContent, attachments: [...attachments, ...selectionAttachments] };
}

function attachmentIdentity(attachment: ChatAttachment): string {
  const kind = attachment.kind || 'file';
  const filePath = attachment.path || attachment.filePath || '';

  if (kind === DOCUMENT_SELECTION_ATTACHMENT_KIND) {
    return [
      kind,
      filePath,
      attachment.createdAt || '',
      attachment.occurrenceIndex ?? '',
    ].join('\0');
  }

  if (kind === CONTENT_REFERENCE_ATTACHMENT_KIND) {
    return [
      kind,
      attachment.contentReference?.id || '',
      filePath,
      attachment.createdAt || '',
    ].join('\0');
  }

  return [kind, filePath || attachment.name].join('\0');
}

export function mergeUserAttachments(
  preferred: ChatAttachment[],
  fallback: ChatAttachment[],
): ChatAttachment[] {
  const merged: ChatAttachment[] = [];
  const seen = new Set<string>();

  for (const attachment of [...preferred, ...fallback]) {
    const identity = attachmentIdentity(attachment);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(attachment);
  }

  return merged;
}

function contentReferenceToAttachment(reference: ContentReference): ChatAttachment {
  return {
    kind: CONTENT_REFERENCE_ATTACHMENT_KIND,
    name: reference.source.fileName,
    path: reference.source.relativePath,
    fileName: reference.source.fileName,
    filePath: reference.source.relativePath,
    contentReference: reference,
    createdAt: reference.createdAt,
    mimeType: 'application/vnd.pilotdeck.content-reference+json',
  };
}

function documentSelectionToAttachment(reference: DocumentSelectionReference): ChatAttachment {
  return {
    kind: DOCUMENT_SELECTION_ATTACHMENT_KIND,
    name: reference.fileName,
    path: reference.filePath,
    fileName: reference.fileName,
    filePath: reference.filePath,
    source: reference.source,
    pageNumbers: reference.pageNumbers,
    selectedText: reference.selectedText,
    surroundingText: reference.surroundingText,
    occurrenceIndex: reference.occurrenceIndex,
    createdAt: reference.createdAt,
    truncated: reference.truncated,
    mimeType: 'application/vnd.pilotdeck.document-selection',
  };
}
