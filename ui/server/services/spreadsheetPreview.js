import crypto from 'crypto';
import { execFile } from 'child_process';
import fsPromises from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import JSZip from 'jszip';
import {
  LIBREOFFICE_TIMEOUT_MS,
  OFFICE_PREVIEW_CACHE_DIR,
  convertOfficeDocumentToPdf,
  createLibreOfficeConversionWorkspace,
  getLibreOfficeStatus,
} from './officePreview.js';

const execFileAsync = promisify(execFile);
const spreadsheetPreviewLocks = new Map();

export const SPREADSHEET_PREVIEW_EXTENSIONS = new Set(['xls', 'xlsx', 'et', 'ods']);

function createSpreadsheetPreviewError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function decodeXmlEntities(value) {
  return String(value || '').replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|quot|apos|amp|lt|gt);/gi,
    (entity, decimal, hexadecimal) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return {
        '&quot;': '"',
        '&apos;': "'",
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
      }[entity.toLowerCase()] || entity;
    },
  );
}

function readXmlAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attributes);
  return match ? decodeXmlEntities(match[2]) : '';
}

function removeXmlAttribute(attributes, name) {
  return attributes.replace(new RegExp(`\\s+${name}\\s*=\\s*(["']).*?\\1`, 'ig'), '');
}

export function parseSpreadsheetWorkbookXml(workbookXml) {
  const sheets = [];
  const sheetPattern = /<((?:[\w.-]+:)?sheet)\b([^>]*)\/?\s*>/gi;
  let match;
  while ((match = sheetPattern.exec(workbookXml)) !== null) {
    const attributes = match[2];
    const name = readXmlAttribute(attributes, 'name');
    const state = readXmlAttribute(attributes, 'state') || 'visible';
    sheets.push({
      index: sheets.length,
      name: name || `Sheet ${sheets.length + 1}`,
      state,
    });
  }

  const workbookView = /<(?:[\w.-]+:)?workbookView\b([^>]*)\/?\s*>/i.exec(workbookXml);
  const requestedActiveIndex = Number.parseInt(
    readXmlAttribute(workbookView?.[1] || '', 'activeTab'),
    10,
  );
  const visibleSheets = sheets.filter((sheet) => sheet.state.toLowerCase() === 'visible');
  if (visibleSheets.length === 0) {
    throw createSpreadsheetPreviewError(
      'The workbook does not contain a visible worksheet',
      422,
      'SPREADSHEET_VISIBLE_SHEET_MISSING',
    );
  }
  const activeSheet = visibleSheets.find((sheet) => sheet.index === requestedActiveIndex)
    || visibleSheets[0];

  return {
    sheets,
    visibleSheets,
    activeSheetIndex: activeSheet.index,
  };
}

export function createSingleVisibleSheetWorkbookXml(workbookXml, selectedIndex) {
  let sheetIndex = -1;
  const nextWorkbookXml = workbookXml.replace(
    /<((?:[\w.-]+:)?sheet)\b([^>]*)\/\s*>/gi,
    (_match, tagName, attributes) => {
      sheetIndex += 1;
      const cleaned = removeXmlAttribute(attributes, 'state').trimEnd();
      const state = sheetIndex === selectedIndex ? '' : ' state="hidden"';
      return `<${tagName}${cleaned}${state}/>`;
    },
  );

  return nextWorkbookXml.replace(
    /<((?:[\w.-]+:)?workbookView)\b([^>]*?)(\/?)>/i,
    (_match, tagName, attributes, selfClosing) => {
      const cleaned = removeXmlAttribute(attributes, 'activeTab').trimEnd();
      return `<${tagName}${cleaned} activeTab="${selectedIndex}"${selfClosing}>`;
    },
  );
}

async function withPreviewLock(key, callback) {
  const existing = spreadsheetPreviewLocks.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(callback);
  spreadsheetPreviewLocks.set(key, promise);
  try {
    return await promise;
  } finally {
    if (spreadsheetPreviewLocks.get(key) === promise) {
      spreadsheetPreviewLocks.delete(key);
    }
  }
}

async function convertSpreadsheetToXlsx(sourcePath, outputPath, cacheDir) {
  const status = await getLibreOfficeStatus();
  if (!status.available || !status.binaryPath) {
    throw createSpreadsheetPreviewError(
      'LibreOffice executable not found',
      501,
      'LIBREOFFICE_NOT_FOUND',
    );
  }

  const { tempDir, profileDir } = await createLibreOfficeConversionWorkspace(cacheDir);
  try {
    let conversionOutput;
    try {
      conversionOutput = await execFileAsync(status.binaryPath, [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--nolockcheck',
        '--nofirststartwizard',
        '--convert-to',
        'xlsx:Calc MS Excel 2007 XML',
        '--outdir',
        tempDir,
        sourcePath,
      ], {
        timeout: LIBREOFFICE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      error.statusCode = 500;
      error.code = error.code || 'SPREADSHEET_XLSX_CONVERT_FAILED';
      throw error;
    }

    const generatedName = (await fsPromises.readdir(tempDir))
      .find((name) => name.toLowerCase().endsWith('.xlsx'));
    if (!generatedName) {
      const detail = String(conversionOutput?.stderr || conversionOutput?.stdout || '').trim();
      throw createSpreadsheetPreviewError(
        `LibreOffice did not produce an XLSX workbook${detail ? `: ${detail}` : ''}`,
        500,
        'SPREADSHEET_XLSX_OUTPUT_MISSING',
      );
    }

    const pendingPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    await fsPromises.copyFile(path.join(tempDir, generatedName), pendingPath);
    await fsPromises.rename(pendingPath, outputPath);
  } finally {
    await Promise.all([
      fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {}),
      fsPromises.rm(profileDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}

async function prepareSpreadsheetWorkbook(sourcePath, options = {}) {
  const resolvedSourcePath = path.resolve(sourcePath);
  const stats = await fsPromises.stat(resolvedSourcePath).catch(() => null);
  if (!stats?.isFile()) {
    throw createSpreadsheetPreviewError(
      'Spreadsheet preview source was not found',
      404,
      'SPREADSHEET_PREVIEW_SOURCE_NOT_FOUND',
    );
  }
  const extension = path.extname(resolvedSourcePath).slice(1).toLowerCase();
  if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
    throw createSpreadsheetPreviewError(
      'Unsupported spreadsheet preview format',
      400,
      'SPREADSHEET_PREVIEW_UNSUPPORTED',
    );
  }

  const cacheKey = crypto
    .createHash('sha256')
    .update(`${resolvedSourcePath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex');
  const cacheDir = path.join(OFFICE_PREVIEW_CACHE_DIR, cacheKey, 'spreadsheet');
  const normalizedWorkbookPath = extension === 'xlsx'
    ? resolvedSourcePath
    : path.join(cacheDir, 'normalized.xlsx');

  await fsPromises.mkdir(cacheDir, { recursive: true });
  if (options.force) {
    await fsPromises.rm(path.join(cacheDir, 'sheets'), { recursive: true, force: true }).catch(() => {});
    if (extension !== 'xlsx') {
      await fsPromises.rm(normalizedWorkbookPath, { force: true }).catch(() => {});
    }
  }

  if (extension !== 'xlsx') {
    await withPreviewLock(`normalize:${cacheKey}`, async () => {
      const normalizedStats = await fsPromises.stat(normalizedWorkbookPath).catch(() => null);
      if (!normalizedStats?.isFile()) {
        await convertSpreadsheetToXlsx(resolvedSourcePath, normalizedWorkbookPath, cacheDir);
      }
    });
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(await fsPromises.readFile(normalizedWorkbookPath));
  } catch (error) {
    throw createSpreadsheetPreviewError(
      `Failed to read workbook package: ${error instanceof Error ? error.message : String(error)}`,
      422,
      'SPREADSHEET_PACKAGE_INVALID',
    );
  }
  const workbookPart = zip.file('xl/workbook.xml');
  if (!workbookPart) {
    throw createSpreadsheetPreviewError(
      'The workbook package is missing xl/workbook.xml',
      422,
      'SPREADSHEET_WORKBOOK_XML_MISSING',
    );
  }
  const workbookXml = await workbookPart.async('string');
  const workbook = parseSpreadsheetWorkbookXml(workbookXml);

  return {
    cacheDir,
    cacheKey,
    normalizedWorkbookPath,
    workbook,
    workbookXml,
    zip,
  };
}

export async function getSpreadsheetPreviewManifest(sourcePath, options = {}) {
  const prepared = await prepareSpreadsheetWorkbook(sourcePath, options);
  return {
    version: 1,
    revision: prepared.cacheKey,
    activeSheetIndex: prepared.workbook.activeSheetIndex,
    sheets: prepared.workbook.visibleSheets.map(({ index, name }) => ({ index, name })),
  };
}

async function createSheetPreviewWorkbook(prepared, selectedIndex, outputPath) {
  const nextZip = await JSZip.loadAsync(await fsPromises.readFile(prepared.normalizedWorkbookPath));
  const workbookPart = nextZip.file('xl/workbook.xml');
  if (!workbookPart) {
    throw createSpreadsheetPreviewError(
      'The workbook package is missing xl/workbook.xml',
      422,
      'SPREADSHEET_WORKBOOK_XML_MISSING',
    );
  }
  const workbookXml = await workbookPart.async('string');
  nextZip.file('xl/workbook.xml', createSingleVisibleSheetWorkbookXml(workbookXml, selectedIndex));
  const pendingPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.writeFile(
    pendingPath,
    await nextZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  );
  await fsPromises.rename(pendingPath, outputPath);
}

export async function getSpreadsheetSheetPreviewPdf(sourcePath, sheetIndex, options = {}) {
  const prepared = await prepareSpreadsheetWorkbook(sourcePath, options);
  const selectedIndex = Number(sheetIndex);
  const selectedSheet = prepared.workbook.visibleSheets.find((sheet) => sheet.index === selectedIndex);
  if (!selectedSheet) {
    throw createSpreadsheetPreviewError(
      'Requested worksheet is not visible in this workbook',
      404,
      'SPREADSHEET_SHEET_NOT_FOUND',
    );
  }

  const sheetDir = path.join(prepared.cacheDir, 'sheets', String(selectedIndex));
  const workbookPath = path.join(sheetDir, 'workbook.xlsx');
  await fsPromises.mkdir(sheetDir, { recursive: true });
  await withPreviewLock(`sheet:${prepared.cacheKey}:${selectedIndex}`, async () => {
    const workbookStats = await fsPromises.stat(workbookPath).catch(() => null);
    if (options.force || !workbookStats?.isFile()) {
      await createSheetPreviewWorkbook(prepared, selectedIndex, workbookPath);
    }
  });

  return convertOfficeDocumentToPdf(workbookPath, { force: options.force });
}
