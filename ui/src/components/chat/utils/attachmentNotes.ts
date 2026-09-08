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
const ATTACHMENT_NOTE_JSON_PREFIX = '- attachment-json: ';
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

  const lines = files.map((file) => (
    `${ATTACHMENT_NOTE_JSON_PREFIX}${JSON.stringify({ name: file.name, path: file.path })}`
  ));
  return `\n\n${ATTACHMENT_NOTE_MARKER}\n${lines.join('\n')}\n${ATTACHMENT_NOTE_END_MARKER}\n`;
}

function parseAttachmentPathNoteLine(line: string): AttachmentPathNoteFile | null {
  if (line.startsWith(ATTACHMENT_NOTE_JSON_PREFIX)) {
    try {
      const parsed = JSON.parse(line.slice(ATTACHMENT_NOTE_JSON_PREFIX.length)) as {
        name?: unknown;
        path?: unknown;
      };
      if (
        typeof parsed.name !== 'string'
        || typeof parsed.path !== 'string'
        || !parsed.name.trim()
        || !parsed.path.trim()
      ) {
        return null;
      }
      return { name: parsed.name, path: parsed.path };
    } catch {
      return null;
    }
  }

  if (!line.startsWith('- ')) return null;
  const separator = findLegacyAttachmentSeparator(line);
  if (separator < 0) return null;

  const name = line.slice(2, separator).trim();
  const filePath = line.slice(separator + 2).trim();
  return name && filePath ? { name, path: filePath } : null;
}

function isLikelyLegacyAttachmentPath(value: string): boolean {
  return value.startsWith('/')
    || value.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('./')
    || value.startsWith('../');
}

function findLegacyAttachmentSeparator(line: string): number {
  const firstSeparator = line.indexOf(': ', 2);
  if (firstSeparator < 0) return -1;

  // Legacy notes originally used the first delimiter. Prefer it whenever it
  // clearly starts a path, then allow colon-containing filenames on common
  // absolute-path records.
  if (isLikelyLegacyAttachmentPath(line.slice(firstSeparator + 2).trim())) {
    return firstSeparator;
  }
  for (let separator = line.indexOf(': ', firstSeparator + 2);
    separator >= 0;
    separator = line.indexOf(': ', separator + 2)) {
    if (isLikelyLegacyAttachmentPath(line.slice(separator + 2).trim())) {
      return separator;
    }
  }
  return firstSeparator;
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
  for (const source of [name, filePath]) {
    const normalized = source.toLowerCase();
    if (normalized.endsWith('.pdf')) return 'application/pdf';
    if (normalized.endsWith('.doc')) return 'application/msword';
    if (normalized.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (normalized.endsWith('.xls')) return 'application/vnd.ms-excel';
    if (normalized.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (normalized.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
    if (normalized.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (normalized.endsWith('.txt')) return 'text/plain';
    if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) return 'text/markdown';
    if (normalized.endsWith('.json')) return 'application/json';
    if (normalized.endsWith('.csv')) return 'text/csv';
    if (normalized.endsWith('.xml')) return 'application/xml';
    if (normalized.endsWith('.png')) return 'image/png';
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
    if (normalized.endsWith('.gif')) return 'image/gif';
    if (normalized.endsWith('.webp')) return 'image/webp';
    if (normalized.endsWith('.svg') || normalized.endsWith('.svgz')) return 'image/svg+xml';
  }
  return undefined;
}

function isImageAttachmentMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('image/'));
}

function toChatAttachment(file: AttachmentPathNoteFile): ChatAttachment {
  return {
    name: file.name,
    path: file.path,
    mimeType: inferAttachmentMimeType(file.name, file.path),
  };
}

function attachmentFromGeneratedPath(path: string, name?: string): AttachmentPathNoteFile | null {
  const filePath = path.trim();
  if (!isLikelyLegacyAttachmentPath(filePath)) return null;

  const fallbackName = filePath.split(/[\\/]/).pop()?.trim();
  const fileName = name?.trim() || fallbackName;
  return fileName ? { name: fileName, path: filePath } : null;
}

function appendUniqueAttachment(
  attachments: AttachmentPathNoteFile[],
  seen: Set<string>,
  candidate: AttachmentPathNoteFile | null,
): void {
  if (!candidate) return;
  const key = candidate.path;
  if (seen.has(key)) return;
  seen.add(key);
  attachments.push(candidate);
}

function generatedDiagnosticsBlockStart(value: string, end: number): number | null {
  const marker = '[Attachment diagnostics]';
  const diagnosticLine = /^\s*-\s+(?:Attachment|Image|PDF attachment|File extension|Cannot determine image mime type)\b/u;
  for (let index = value.lastIndexOf(marker, end - 1);
    index >= 0;
    index = value.lastIndexOf(marker, index - 1)) {
    const lines = value.slice(index + marker.length, end)
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (lines.length > 0 && lines.every((line) => diagnosticLine.test(line))) {
      return index;
    }
  }
  return null;
}

function parseGeneratedAttachmentBlocks(value: string): {
  content: string;
  attachments: AttachmentPathNoteFile[];
} | null {
  const attachments: AttachmentPathNoteFile[] = [];
  const seen = new Set<string>();
  const registeredPaths = new Set<string>();
  const registeredMarker = '[Registered attachment files in this session:]';
  let registeredIndex = value.lastIndexOf(registeredMarker);
  if (registeredIndex >= 0) {
    const registeredLines = value.slice(registeredIndex + registeredMarker.length).split(/\r?\n/);
    let foundRegisteredAttachment = false;
    for (const rawLine of registeredLines) {
      const parsed = parseAttachmentPathNoteLine(rawLine.trim());
      const candidate = parsed
        ? attachmentFromGeneratedPath(parsed.path, parsed.name)
        : null;
      if (candidate) {
        foundRegisteredAttachment = true;
        registeredPaths.add(candidate.path);
      }
      appendUniqueAttachment(attachments, seen, candidate);
    }
    if (!foundRegisteredAttachment) registeredIndex = -1;
  }

  const diagnosticsEnd = registeredIndex >= 0 ? registeredIndex : value.length;
  const diagnosticsStart = generatedDiagnosticsBlockStart(value, diagnosticsEnd);
  if (diagnosticsStart !== null) {
    const officeDiagnosticPattern = /Attachment\s+(.+?)\s+has Office\/archive\/binary extension\s+[^;]+;/giu;
    const diagnosticBlock = value.slice(diagnosticsStart, diagnosticsEnd);
    for (const match of diagnosticBlock.matchAll(officeDiagnosticPattern)) {
      appendUniqueAttachment(attachments, seen, attachmentFromGeneratedPath(match[1] ?? ''));
    }
  }

  const embeddedBlocks: Array<{
    start: number;
    end: number;
    attachment: AttachmentPathNoteFile;
  }> = [];
  const inlineAttachmentPattern = /<attachment\s+path="([^"]+)">[\s\S]*?<\/attachment>/giu;
  for (const match of value.matchAll(inlineAttachmentPattern)) {
    const candidate = attachmentFromGeneratedPath(match[1] ?? '');
    if (candidate && match.index !== undefined) {
      embeddedBlocks.push({
        start: match.index,
        end: match.index + match[0].length,
        attachment: candidate,
      });
    }
  }

  const pdfAttachmentPattern = /\[PDF attachment:\s*(.+?),\s*\d+\s+bytes,\s*estimated\s+\d+\s+pages?\.\s*Use read_file on this registered attachment path to inspect it\.\]/giu;
  for (const match of value.matchAll(pdfAttachmentPattern)) {
    const candidate = attachmentFromGeneratedPath(match[1] ?? '');
    if (candidate && match.index !== undefined) {
      embeddedBlocks.push({
        start: match.index,
        end: match.index + match[0].length,
        attachment: candidate,
      });
    }
  }

  let generatedStart = diagnosticsStart
    ?? (registeredIndex >= 0 ? registeredIndex : value.length);
  let foundGeneratedBlock = diagnosticsStart !== null || registeredIndex >= 0;
  const acceptedEmbeddedBlocks: typeof embeddedBlocks = [];
  for (const block of embeddedBlocks.sort((left, right) => right.start - left.start)) {
    if (block.end > generatedStart) continue;
    if (value.slice(block.end, generatedStart).trim().length > 0) continue;
    if (registeredIndex >= 0 && !registeredPaths.has(block.attachment.path)) continue;
    acceptedEmbeddedBlocks.push(block);
    generatedStart = block.start;
    foundGeneratedBlock = true;
  }
  for (const block of acceptedEmbeddedBlocks.reverse()) {
    appendUniqueAttachment(attachments, seen, block.attachment);
  }

  if (!foundGeneratedBlock) return null;
  return { content: value.slice(0, generatedStart).trimEnd(), attachments };
}

export function parseUserAttachmentNote(content: unknown): {
  content: string;
  attachments: ChatAttachment[];
} {
  const rawText = typeof content === 'string' ? content : '';
  const hasClientAttachmentNote = rawText.includes(ATTACHMENT_NOTE_MARKER);
  // Strip trailing gateway-authored blocks before parsing content references.
  // The client-authored note remains authoritative for attachment names when
  // present, so generated attachments are merged only for legacy/channel input.
  const generated = parseGeneratedAttachmentBlocks(rawText);
  const parsedContentReferences = parseContentReferencePromptBlock(generated?.content ?? rawText);
  const parsedSelections = parseDocumentSelectionPromptBlock(parsedContentReferences.content);
  const text = parsedSelections.content;
  const markerIndex = text.indexOf(ATTACHMENT_NOTE_MARKER);
  const selectionAttachments = [
    ...parsedSelections.references.map(documentSelectionToAttachment),
    ...parsedContentReferences.references.map(contentReferenceToAttachment),
  ];
  const generatedAttachments = (hasClientAttachmentNote
    ? []
    : generated?.attachments.map(toChatAttachment) ?? [])
    .filter((attachment) => !isImageAttachmentMime(attachment.mimeType));
  if (markerIndex < 0) {
    return {
      content: text,
      attachments: mergeUserAttachments(generatedAttachments, selectionAttachments),
    };
  }

  const visibleContent = text.slice(0, markerIndex).trimEnd();
  const note = text.slice(markerIndex + ATTACHMENT_NOTE_MARKER.length);
  const attachments: ChatAttachment[] = [];

  for (const rawLine of note.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === ATTACHMENT_NOTE_END_MARKER) break;
    let reachedLegacyTerminator = false;
    if (!line.startsWith(ATTACHMENT_NOTE_JSON_PREFIX)) {
      const legacyLine = sliceBeforeFirstMarker(line, LEGACY_ATTACHMENT_NOTE_TERMINATORS);
      reachedLegacyTerminator = legacyLine.length !== line.length;
      line = legacyLine.trim();
      if (!line && reachedLegacyTerminator) break;
    }

    const attachment = parseAttachmentPathNoteLine(line);
    if (attachment) {
      const chatAttachment = toChatAttachment(attachment);
      if (!isImageAttachmentMime(chatAttachment.mimeType)) {
        attachments.push(chatAttachment);
      }
    }
    if (reachedLegacyTerminator) break;
  }

  return {
    content: visibleContent,
    attachments: mergeUserAttachments(
      attachments,
      [...generatedAttachments, ...selectionAttachments],
    ),
  };
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
