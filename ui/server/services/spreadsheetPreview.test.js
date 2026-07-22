import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  createSingleVisibleSheetWorkbookXml,
  getSpreadsheetPreviewManifest,
  parseSpreadsheetWorkbookXml,
} from './spreadsheetPreview.js';

const PREFIXED_WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <x:bookViews><x:workbookView activeTab="2"/></x:bookViews>
  <x:sheets>
    <x:sheet name="管理摘要" sheetId="1" r:id="rId1"/>
    <x:sheet name="内部数据" sheetId="2" state="veryHidden" r:id="rId2"/>
    <x:sheet name="KPI&amp;趋势" sheetId="3" r:id="rId3"/>
  </x:sheets>
  <x:definedNames><x:definedName localSheetId="2">'KPI&amp;趋势'!$A$1</x:definedName></x:definedNames>
</x:workbook>`;

describe('spreadsheet workbook manifest parsing', () => {
  it('supports namespace-prefixed SpreadsheetML and excludes hidden sheets', () => {
    const parsed = parseSpreadsheetWorkbookXml(PREFIXED_WORKBOOK_XML);

    expect(parsed.visibleSheets).toEqual([
      { index: 0, name: '管理摘要', state: 'visible' },
      { index: 2, name: 'KPI&趋势', state: 'visible' },
    ]);
    expect(parsed.activeSheetIndex).toBe(2);
  });

  it('keeps every worksheet relationship while hiding non-selected sheets', () => {
    const filtered = createSingleVisibleSheetWorkbookXml(PREFIXED_WORKBOOK_XML, 2);
    const parsed = parseSpreadsheetWorkbookXml(filtered);

    expect(parsed.sheets).toHaveLength(3);
    expect(parsed.visibleSheets).toEqual([
      { index: 2, name: 'KPI&趋势', state: 'visible' },
    ]);
    expect(parsed.activeSheetIndex).toBe(2);
    expect(filtered).toContain('localSheetId="2"');
    expect(filtered).toContain('activeTab="2"');
  });

  it('reads a workbook manifest without flattening worksheets into pages', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'pilotdeck-spreadsheet-preview-'));
    const workbookPath = path.join(tempDir, 'workbook.xlsx');
    try {
      const zip = new JSZip();
      zip.file('xl/workbook.xml', PREFIXED_WORKBOOK_XML);
      await writeFile(workbookPath, await zip.generateAsync({ type: 'nodebuffer' }));

      const manifest = await getSpreadsheetPreviewManifest(workbookPath);
      expect(manifest.activeSheetIndex).toBe(2);
      expect(manifest.sheets).toEqual([
        { index: 0, name: '管理摘要' },
        { index: 2, name: 'KPI&趋势' },
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
