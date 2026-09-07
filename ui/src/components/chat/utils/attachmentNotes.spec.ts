import { describe, expect, it } from 'vitest';
import type { ChatAttachment } from '../types/types';
import {
  createTextContentReference,
  formatContentReferencePromptBlock,
} from '../../../types/contentReference';
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
      '- attachment-json: {"name":"报告.xlsx","path":".tmp/chat-attachments/run/1-报告.xlsx"}',
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

  it('hides PDF runtime metadata after refresh and restores the attachment', () => {
    const filePath = '/workspace/政研室/.tmp/chat-uploads/run/files/file-0-opaque-upload-id';
    const parsed = parseUserAttachmentNote([
      '分析一下这个文件内容，总结给我',
      `[PDF attachment: ${filePath}, 54858 bytes, estimated 1 pages. Use read_file on this registered attachment path to inspect it.]`,
      '[Registered attachment files in this session:]',
      `- 年度报告.pdf: ${filePath}`,
    ].join('\n'));

    expect(parsed).toEqual({
      content: '分析一下这个文件内容，总结给我',
      attachments: [{
        name: '年度报告.pdf',
        path: filePath,
        mimeType: 'application/pdf',
      }],
    });
  });

  it('hides standalone Office diagnostics after refresh and restores the attachment', () => {
    const filePath = '/workspace/政研室/.tmp/chat-uploads/run/files/file-0-report.docx';
    const parsed = parseUserAttachmentNote([
      '分析一下这个文件内容，总结给我',
      '[Attachment diagnostics]',
      `- Attachment ${filePath} has Office/archive/binary extension .docx; it was registered as a file path but not shown inline.`,
    ].join('\n'));

    expect(parsed).toEqual({
      content: '分析一下这个文件内容，总结给我',
      attachments: [{
        name: 'file-0-report.docx',
        path: filePath,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }],
    });
  });

  it.each([
    '请解释 <attachment path="/tmp/demo.txt"> 这段 XML',
    '请解释 <attachment path="/tmp/demo.txt">example</attachment> 这段 XML',
    '正文中提到了 [PDF attachment:，但这不是附件元数据',
    '请解释 [PDF attachment: /tmp/demo.pdf, 42 bytes, estimated 1 page. Use read_file on this registered attachment path to inspect it.] 这段文本',
    '请解释 [Attachment diagnostics] 这个标题',
    '请解释 [Registered attachment files in this session:] 这个标题',
  ])('preserves attachment-like user text: %s', (content) => {
    expect(parseUserAttachmentNote(content)).toEqual({
      content,
      attachments: [],
    });
  });

  it('restores a trailing generated inline attachment', () => {
    const filePath = '/tmp/file-0-notes.txt';
    const parsed = parseUserAttachmentNote([
      '总结文件',
      `<attachment path="${filePath}">\nhello\n</attachment>`,
      '\n\n[Registered attachment files in this session:]\n',
      `- notes.txt: ${filePath}`,
    ].join(''));

    expect(parsed).toEqual({
      content: '总结文件',
      attachments: [{
        name: 'notes.txt',
        path: filePath,
        mimeType: 'text/plain',
      }],
    });
  });

  it('restores an upload and content reference from the projected production order', () => {
    const reference = createTextContentReference({
      id: 'reference-1',
      createdAt: '2026-08-16T09:00:00.000Z',
      selectionMode: 'text',
      source: { relativePath: 'notes.md', fileName: 'notes.md' },
      renderer: { id: 'text', backend: 'builtin', locatorQuality: 'semantic' },
      locator: { surface: 'document', quote: { exact: 'selection' } },
      selectedText: 'selection',
    });
    const filePath = '/tmp/file-0-report';
    const parsed = parseUserAttachmentNote([
      '比较两个文件',
      buildAttachmentPathNote([{ name: 'report.pdf', path: filePath }]),
      formatContentReferencePromptBlock([reference]),
      `[PDF attachment: ${filePath}, 42 bytes, estimated 1 page. Use read_file on this registered attachment path to inspect it.]`,
      '\n\n[Registered attachment files in this session:]\n',
      `- report.pdf: ${filePath}`,
    ].join(''));

    expect(parsed.content).toBe('比较两个文件');
    expect(parsed.attachments.map((attachment) => ({
      kind: attachment.kind || 'file',
      name: attachment.name,
    }))).toEqual([
      { kind: 'file', name: 'report.pdf' },
      { kind: 'content-reference', name: 'notes.md' },
    ]);
  });

  it('does not restore a registered image as a duplicate file card', () => {
    const filePath = '/tmp/file-0-opaque-image-id';
    const parsed = parseUserAttachmentNote([
      '查看图片',
      '[Registered attachment files in this session:]',
      `- photo.png: ${filePath}`,
    ].join('\n'));

    expect(parsed).toEqual({
      content: '查看图片',
      attachments: [],
    });
  });

  it('preserves a colon in the attachment filename', () => {
    const filePath = '/tmp/1-report__final.pdf';
    const parsed = parseUserAttachmentNote([
      'Review this report',
      '',
      marker,
      `- report: final.pdf: ${filePath}`,
      '[End files attached by user]',
    ].join('\n'));

    expect(parsed.attachments).toEqual([{
      name: 'report: final.pdf',
      path: filePath,
      mimeType: 'application/pdf',
    }]);
  });

  it('preserves a colon and space in a legacy attachment path', () => {
    const parsed = parseUserAttachmentNote([
      'Review this report',
      '',
      marker,
      '- report.pdf: /tmp/Project: Docs/report.pdf',
      '[End files attached by user]',
    ].join('\n'));

    expect(parsed.attachments).toEqual([{
      name: 'report.pdf',
      path: '/tmp/Project: Docs/report.pdf',
      mimeType: 'application/pdf',
    }]);
  });

  it('round trips colons in both attachment names and paths', () => {
    const parsed = parseUserAttachmentNote([
      'Review this report',
      buildAttachmentPathNote([{
        name: 'report: final.pdf',
        path: '/tmp/project: docs/report: final.pdf',
      }]),
    ].join(''));

    expect(parsed).toEqual({
      content: 'Review this report',
      attachments: [{
        name: 'report: final.pdf',
        path: '/tmp/project: docs/report: final.pdf',
        mimeType: 'application/pdf',
      }],
    });
  });

  it('round trips an end marker substring inside a JSON attachment path', () => {
    const filePath = '/tmp/[End files attached by user]/report.pdf';
    const parsed = parseUserAttachmentNote([
      'Review this report',
      buildAttachmentPathNote([{ name: 'report.pdf', path: filePath }]),
    ].join(''));

    expect(parsed.attachments).toEqual([{
      name: 'report.pdf',
      path: filePath,
      mimeType: 'application/pdf',
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
