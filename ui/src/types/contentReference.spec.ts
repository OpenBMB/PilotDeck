import { describe, expect, it } from 'vitest';
import { createDocumentSelectionReference } from './documentSelection';
import {
  createCellRangeContentReference,
  createImageRegionContentReference,
  createTextContentReference,
  formatContentReferencePromptBlock,
  isContentReference,
  normalizeContentReference,
  parseContentReferencePromptBlock,
} from './contentReference';

const source = {
  projectName: 'demo',
  relativePath: 'reports/Q1.xlsx',
  fileName: 'Q1.xlsx',
};

describe('contentReference', () => {
  it('normalizes old document selections into text references', () => {
    const legacy = createDocumentSelectionReference({
      projectName: 'demo',
      fileName: 'brief.pdf',
      filePath: 'brief.pdf',
      source: 'pdf',
      pageNumbers: [2],
      selectedText: '关键结论',
      surroundingText: '这是关键结论的上下文',
    });

    const normalized = normalizeContentReference(legacy);
    expect(normalized?.selectionMode).toBe('text');
    expect(normalized?.source.relativePath).toBe('brief.pdf');
    expect(normalized?.renderer.id).toBe('pdf');
  });

  it('serializes semantic cell ranges with values and formulas', () => {
    const reference = createCellRangeContentReference({
      selectionMode: 'cells',
      source,
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'semantic' },
      locator: {
        surface: 'sheet',
        sheetId: 'sheet-0',
        sheetName: 'KPI趋势',
        ranges: ['B2:C3'],
        activeRange: 'B2:C3',
      },
      cells: [{
        range: 'B2:C3',
        displayValues: [['一月', '10'], ['二月', '12']],
        rawValues: [['一月', 10], ['二月', 12]],
        formulas: [['', '=SUM(A1:A2)'], ['', '']],
        rowCount: 2,
        columnCount: 2,
        truncated: false,
      }],
      headers: [['月份', '收入']],
      surroundingValues: [['月份', '收入'], ['一月', '10'], ['二月', '12']],
    });

    const prompt = formatContentReferencePromptBlock([reference]);
    expect(prompt).toContain('KPI趋势');
    expect(prompt).toContain('B2:C3');
    expect(prompt).toContain('rawValues');
    expect(prompt).toContain('=SUM(A1:A2)');
    expect(prompt).toContain('Nearby header rows');
    expect(parseContentReferencePromptBlock(prompt).references).toEqual([reference]);
  });

  it('sends region metadata without duplicating image bytes in the structured attachment', () => {
    const reference = createImageRegionContentReference({
      selectionMode: 'region',
      source,
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'visual' },
      locator: {
        surface: 'sheet',
        sheetId: 'sheet-0',
        sheetName: 'Sheet1',
        rect: { x: -1, y: 0.2, width: 2, height: 0.3 },
      },
      image: {
        name: 'selection.png',
        mimeType: 'image/png',
        width: 300,
        height: 120,
        dataUrl: 'data:image/png;base64,AAAA',
      },
    });

    expect(reference.locator.rect).toEqual({ x: 0, y: 0.2, width: 1, height: 0.3 });
    const prompt = formatContentReferencePromptBlock([reference]);
    expect(prompt).toContain('selection.png');
    expect(prompt).not.toContain('data:image/png');
  });

  it('keeps text quote context and normalized coordinates', () => {
    const reference = createTextContentReference({
      selectionMode: 'text',
      source: { ...source, relativePath: 'brief.docx', fileName: 'brief.docx' },
      renderer: { id: 'docx', backend: 'builtin', locatorQuality: 'semantic' },
      locator: {
        surface: 'document',
        pageNumbers: [1],
        headingPath: ['结论'],
        quote: { exact: '增长 20%', prefix: '收入', suffix: '，超预期' },
        rects: [{ x: 0.8, y: 0.1, width: 0.5, height: 0.1 }],
      },
      selectedText: '增长 20%',
      surroundingText: '收入增长 20%，超预期',
    });

    expect(reference.locator.rects?.[0]?.x).toBeCloseTo(0.8);
    expect(reference.locator.rects?.[0]?.y).toBeCloseTo(0.1);
    expect(reference.locator.rects?.[0]?.width).toBeCloseTo(0.2);
    expect(reference.locator.rects?.[0]?.height).toBeCloseTo(0.1);
  });

  it.each([
    ['unknown selection mode', { selectionMode: 'unknown' }],
    ['text reference without a locator', { selectionMode: 'text', selectedText: 'hello' }],
    ['cell reference without snapshots', {
      selectionMode: 'cells',
      locator: {
        surface: 'sheet',
        sheetId: 'sheet-0',
        sheetName: 'Sheet1',
        ranges: ['A1'],
        activeRange: 'A1',
      },
    }],
    ['region reference without an image', {
      selectionMode: 'region',
      locator: {
        surface: 'sheet',
        rect: { x: 0, y: 0, width: 1, height: 1 },
      },
    }],
  ])('rejects malformed %s payloads', (_label, fields) => {
    const malformed = {
      schemaVersion: 1,
      kind: 'content-reference',
      id: 'malformed-reference',
      createdAt: new Date().toISOString(),
      source,
      renderer: { id: 'xlsx', backend: 'builtin', locatorQuality: 'semantic' },
      ...fields,
    };

    expect(isContentReference(malformed)).toBe(false);
    expect(normalizeContentReference(malformed)).toBeNull();
    const prompt = [
      'Question',
      '[Content references selected by user:]',
      `   Reference JSON: ${JSON.stringify(malformed)}`,
    ].join('\n');
    expect(parseContentReferencePromptBlock(prompt)).toEqual({
      content: 'Question',
      references: [],
    });
  });
});
