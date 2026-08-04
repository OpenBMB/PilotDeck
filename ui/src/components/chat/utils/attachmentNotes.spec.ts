import { describe, expect, it } from 'vitest';
import type { ChatAttachment } from '../types/types';
import {
  buildAttachmentPathNote,
  mergeUserAttachments,
  parseUserAttachmentNote,
} from './attachmentNotes';

const marker = '[Files attached by user and available for reading in the project:]';

describe('attachment path notes', () => {
  it('writes a bounded attachment note for new messages', () => {
    const note = buildAttachmentPathNote([
      { name: '报告.xlsx', path: '.tmp/chat-attachments/run/1-报告.xlsx' },
    ]);

    expect(note).toBe([
      '',
      '',
      marker,
      '- 报告.xlsx: .tmp/chat-attachments/run/1-报告.xlsx',
      '[End files attached by user]',
      '',
    ].join('\n'));
  });

  it('recovers an xlsx path from a legacy note glued to attachment diagnostics', () => {
    const filePath = String.raw`C:\Users\li_ch\pilotdeck\work\.tmp\chat-attachments\run\1-卫星信息20240802.xlsx`;
    const parsed = parseUserAttachmentNote([
      '总结文件内容',
      '',
      marker,
      `- 卫星信息20240802.xlsx: ${filePath}[Attachment diagnostics]`,
      `- Attachment ${filePath} has Office/archive/binary extension .xlsx; it was not shown inline.`,
    ].join('\n'));

    expect(parsed.content).toBe('总结文件内容');
    expect(parsed.attachments).toEqual([{
      name: '卫星信息20240802.xlsx',
      path: filePath,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }]);
  });

  it.each([
    ['PDF metadata', '[PDF attachment: C:\\work\\brief.pdf, 42 bytes]'],
    ['inline text content', '<attachment path="C:\\work\\notes.txt">'],
    ['registered path guidance', '[Registered attachment files in this session:]'],
  ])('stops legacy parsing before %s', (_label, suffix) => {
    const parsed = parseUserAttachmentNote([
      'Inspect the file',
      '',
      marker,
      `- notes.txt: C:\\work\\notes.txt${suffix}`,
      '- should-not-become-an-attachment.txt: C:\\wrong.txt',
    ].join('\n'));

    expect(parsed.attachments).toEqual([{
      name: 'notes.txt',
      path: 'C:\\work\\notes.txt',
      mimeType: 'text/plain',
    }]);
  });

  it('parses every file inside the new bounded note and ignores following blocks', () => {
    const content = [
      'Compare these files',
      buildAttachmentPathNote([
        { name: '一.xlsx', path: '.tmp/1.xlsx' },
        { name: '二.pdf', path: '.tmp/2.pdf' },
      ]),
      '[Attachment diagnostics]',
      '- ignored.txt: .tmp/ignored.txt',
    ].join('');

    expect(parseUserAttachmentNote(content).attachments).toEqual([
      {
        name: '一.xlsx',
        path: '.tmp/1.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      {
        name: '二.pdf',
        path: '.tmp/2.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  });
});

describe('mergeUserAttachments', () => {
  it('prefers structured attachment metadata over the text fallback', () => {
    const structured: ChatAttachment = {
      name: 'report.xlsx',
      path: '.tmp/report.xlsx',
      size: 42,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const parsedFallback: ChatAttachment = {
      name: 'report.xlsx',
      path: '.tmp/report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };

    expect(mergeUserAttachments([structured], [parsedFallback])).toEqual([structured]);
  });

  it('keeps distinct selections from the same document', () => {
    const first: ChatAttachment = {
      kind: 'document-selection',
      name: 'brief.pdf',
      path: 'brief.pdf',
      createdAt: '2026-07-31T10:00:00.000Z',
      occurrenceIndex: 1,
    };
    const second: ChatAttachment = {
      ...first,
      occurrenceIndex: 2,
    };

    expect(mergeUserAttachments([first, second], [])).toEqual([first, second]);
  });
});
