import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  createSingleVisibleSheetWorkbookXml,
  getSpreadsheetInteractivePreview,
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

async function createInteractiveFixture(workbookPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PilotDeck test';
  workbook.views = [{ activeTab: 0 }];
  const summary = workbook.addWorksheet('管理摘要', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
  });
  summary.getColumn(1).width = 24;
  summary.getColumn(2).width = 18;
  summary.getRow(1).height = 30;
  summary.mergeCells('A1:B1');
  summary.getCell('A1').value = '中文指标';
  summary.getCell('A1').font = {
    name: 'Microsoft YaHei',
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  summary.getCell('A1').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF70AD47' },
  };
  summary.getCell('A1').alignment = {
    horizontal: 'center',
    vertical: 'middle',
  };
  summary.getCell('A2').value = 20;
  summary.getCell('B2').value = 22;
  summary.getCell('A3').value = {
    formula: 'SUM(A2:B2)',
    result: 42,
  };
  summary.getCell('A3').numFmt = '0.00';

  const hidden = workbook.addWorksheet('内部数据');
  hidden.state = 'hidden';
  hidden.getCell('A1').value = 'secret';

  const details = workbook.addWorksheet('行动项');
  details.getCell('A1').value = '负责人';
  details.getCell('B1').value = '王芳';

  await workbook.xlsx.writeFile(workbookPath);
}

function prefixMainSpreadsheetNamespace(xml) {
  if (!xml.includes('http://schemas.openxmlformats.org/spreadsheetml/2006/main')) {
    return xml;
  }
  return xml
    .replace(
      /xmlns=(["'])http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main\1/,
      'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"',
    )
    .replace(/<(\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, '<$1x:$2');
}

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

  it('builds a selectable workbook snapshot with layout, formulas, and worksheet tabs', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'pilotdeck-spreadsheet-interactive-'));
    const workbookPath = path.join(tempDir, 'workbook.xlsx');
    try {
      await createInteractiveFixture(workbookPath);

      const preview = await getSpreadsheetInteractivePreview(workbookPath);
      const summary = preview.workbook.sheets['sheet-0'];

      expect(preview.activeSheetIndex).toBe(0);
      expect(preview.sheets).toEqual([
        { index: 0, name: '管理摘要' },
        { index: 2, name: '行动项' },
      ]);
      expect(preview.workbook.sheetOrder).toEqual(['sheet-0', 'sheet-2']);
      expect(summary.mergeData).toContainEqual({
        startRow: 0,
        endRow: 0,
        startColumn: 0,
        endColumn: 1,
      });
      expect(summary.columnData[0].w).toBeGreaterThan(150);
      expect(summary.rowData[0].h).toBe(40);
      expect(summary.freeze).toMatchObject({
        xSplit: 1,
        ySplit: 1,
      });
      expect(summary.cellData[0][0]).toMatchObject({
        v: '中文指标',
        t: 1,
        s: {
          ff: 'Microsoft YaHei',
          bl: 1,
          bg: { rgb: '#70AD47' },
          cl: { rgb: '#FFFFFF' },
        },
      });
      expect(summary.cellData[2][0]).toMatchObject({
        f: '=SUM(A2:B2)',
        v: 42,
        t: 2,
        s: { n: { pattern: '0.00' } },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes namespace-prefixed SpreadsheetML before interactive parsing', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'pilotdeck-spreadsheet-prefix-'));
    const workbookPath = path.join(tempDir, 'workbook.xlsx');
    try {
      await createInteractiveFixture(workbookPath);
      const zip = await JSZip.loadAsync(await readFile(workbookPath));
      for (const [entryName, entry] of Object.entries(zip.files)) {
        if (entry.dir || !entryName.endsWith('.xml')) continue;
        const xml = await entry.async('string');
        const prefixed = prefixMainSpreadsheetNamespace(xml);
        if (prefixed !== xml) zip.file(entryName, prefixed);
      }
      await writeFile(workbookPath, await zip.generateAsync({ type: 'nodebuffer' }));

      const preview = await getSpreadsheetInteractivePreview(workbookPath);

      expect(preview.sheets[0]).toEqual({ index: 0, name: '管理摘要' });
      expect(preview.workbook.sheets['sheet-0'].cellData[0][0].v).toBe('中文指标');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to the first visible sheet when the saved active sheet is hidden', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'pilotdeck-spreadsheet-hidden-active-'));
    const workbookPath = path.join(tempDir, 'workbook.xlsx');
    try {
      await createInteractiveFixture(workbookPath);
      const zip = await JSZip.loadAsync(await readFile(workbookPath));
      const workbookEntry = zip.file('xl/workbook.xml');
      const workbookXml = await workbookEntry.async('string');
      zip.file(
        'xl/workbook.xml',
        workbookXml.replace(/activeTab="\d+"/, 'activeTab="1"'),
      );
      await writeFile(workbookPath, await zip.generateAsync({ type: 'nodebuffer' }));

      const preview = await getSpreadsheetInteractivePreview(workbookPath);

      expect(preview.sheets.map((sheet) => sheet.index)).toEqual([0, 2]);
      expect(preview.activeSheetIndex).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
