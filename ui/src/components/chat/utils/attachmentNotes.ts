import type { ChatAttachment } from '../types/types';

const ATTACHMENT_NOTE_MARKER = '[Files attached by user and available for reading in the project:]';

function inferAttachmentMimeType(name: string, filePath: string): string | undefined {
  const source = `${name || filePath}`.toLowerCase();
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
  return undefined;
}

export function parseUserAttachmentNote(content: unknown): {
  content: string;
  attachments: ChatAttachment[];
} {
  const text = typeof content === 'string' ? content : '';
  const markerIndex = text.indexOf(ATTACHMENT_NOTE_MARKER);
  if (markerIndex < 0) {
    return { content: text, attachments: [] };
  }

  const visibleContent = text.slice(0, markerIndex).trimEnd();
  const note = text.slice(markerIndex + ATTACHMENT_NOTE_MARKER.length);
  const attachments: ChatAttachment[] = [];

  for (const rawLine of note.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const separator = line.indexOf(': ');
    if (separator < 0) continue;

    const name = line.slice(2, separator).trim();
    const filePath = line.slice(separator + 2).trim();
    if (!name || !filePath) continue;

    attachments.push({
      name,
      path: filePath,
      mimeType: inferAttachmentMimeType(name, filePath),
    });
  }

  return { content: visibleContent, attachments };
}
