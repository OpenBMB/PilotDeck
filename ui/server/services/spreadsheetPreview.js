import crypto from 'crypto';
import { execFile } from 'child_process';
import fsPromises from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import ExcelJS from 'exceljs';
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
const MAX_INTERACTIVE_CELL_AREA = 1_000_000;
const SPREADSHEET_MAIN_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

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

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function normalizePrefixedSpreadsheetPackage(filePath) {
  const zip = await JSZip.loadAsync(await fsPromises.readFile(filePath));
  let changed = false;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !entryName.endsWith('.xml')) continue;
    const xml = await entry.async('string');
    const namespaceMatch = xml.match(
      /xmlns:([A-Za-z_][\w.-]*)=(["'])http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main\2/,
    );
    if (!namespaceMatch) continue;

    const prefix = escapeRegularExpression(namespaceMatch[1]);
    const quote = namespaceMatch[2];
    let normalized = xml.replace(new RegExp(`(<\\/?)(?:${prefix}):`, 'g'), '$1');
    const defaultNamespace = `xmlns=${quote}${SPREADSHEET_MAIN_NAMESPACE}${quote}`;
    normalized = normalized.includes(defaultNamespace)
      ? normalized.replace(namespaceMatch[0], '')
      : normalized.replace(namespaceMatch[0], defaultNamespace);

    if (normalized !== xml) {
      zip.file(entryName, normalized);
      changed = true;
    }
  }

  return changed ? zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) : null;
}

function readXmlAttribute(attributes, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(attributes);
  return match ? decodeXmlEntities(match[2]) : '';
}

function getActiveVisibleSheetIndex(workbook) {
  return workbook.visibleSheets.some((sheet) => sheet.index === workbook.activeSheetIndex)
    ? workbook.activeSheetIndex
    : workbook.visibleSheets[0]?.index ?? 0;
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

async function loadInteractiveWorkbook(workbookPath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(workbookPath);
    return workbook;
  } catch (error) {
    const normalizedPackage = await normalizePrefixedSpreadsheetPackage(workbookPath);
    if (!normalizedPackage) throw error;
    const normalizedWorkbook = new ExcelJS.Workbook();
    await normalizedWorkbook.xlsx.load(normalizedPackage);
    return normalizedWorkbook;
  }
}

function excelColorToRgb(color) {
  const argb = typeof color?.argb === 'string' ? color.argb : '';
  if (/^[0-9a-f]{8}$/i.test(argb)) return `#${argb.slice(2)}`;
  if (/^[0-9a-f]{6}$/i.test(argb)) return `#${argb}`;
  return null;
}

const EXCEL_THEME_COLOR_ORDER = [
  'lt1',
  'dk1',
  'lt2',
  'dk2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
];

const EXCEL_INDEXED_COLORS = [
  '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
  '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#C0C0C0', '#808080',
  '#9999FF', '#993366', '#FFFFCC', '#CCFFFF', '#660066', '#FF8080', '#0066CC', '#CCCCFF',
  '#000080', '#FF00FF', '#FFFF00', '#00FFFF', '#800080', '#800000', '#008080', '#0000FF',
  '#00CCFF', '#CCFFFF', '#CCFFCC', '#FFFF99', '#99CCFF', '#FF99CC', '#CC99FF', '#FFCC99',
  '#3366FF', '#33CCCC', '#99CC00', '#FFCC00', '#FF9900', '#FF6600', '#666699', '#969696',
  '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333',
];

function parseWorkbookThemeColors(workbook) {
  const themeXml = workbook?._themes?.theme1;
  if (typeof themeXml !== 'string' || !themeXml) return {};
  const colorScheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/i.exec(themeXml)?.[1] || '';
  const colors = {};

  for (const name of EXCEL_THEME_COLOR_ORDER) {
    const body = new RegExp(`<a:${name}\\b[^>]*>([\\s\\S]*?)<\\/a:${name}>`, 'i')
      .exec(colorScheme)?.[1];
    if (!body) continue;
    const rgb = /<a:srgbClr\b[^>]*\bval=(["'])([0-9a-f]{6})\1/i.exec(body)?.[2]
      || /<a:sysClr\b[^>]*\blastClr=(["'])([0-9a-f]{6})\1/i.exec(body)?.[2];
    if (rgb) colors[name] = `#${rgb.toUpperCase()}`;
  }

  return colors;
}

function applyColorTint(rgb, tint) {
  if (!rgb || !Number.isFinite(tint) || tint === 0) return rgb;
  const channels = rgb.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16));
  if (!channels || channels.length !== 3) return rgb;
  const adjusted = channels.map((channel) => {
    const value = tint > 0
      ? channel + (255 - channel) * tint
      : channel * (1 + tint);
    return Math.max(0, Math.min(255, Math.round(value)));
  });
  return `#${adjusted.map((value) => value.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function resolveExcelColor(color, themeColors) {
  const direct = excelColorToRgb(color);
  if (direct) return applyColorTint(direct, Number(color?.tint));

  const themeIndex = Number(color?.theme);
  if (Number.isInteger(themeIndex)) {
    const themeName = EXCEL_THEME_COLOR_ORDER[themeIndex];
    const themed = themeName ? themeColors[themeName] : null;
    if (themed) return applyColorTint(themed, Number(color?.tint));
  }

  const indexed = Number(color?.indexed);
  return Number.isInteger(indexed) ? EXCEL_INDEXED_COLORS[indexed] || null : null;
}

function mapHorizontalAlignment(value) {
  return {
    left: 1,
    center: 2,
    centerContinuous: 2,
    right: 3,
    justify: 4,
    distributed: 6,
  }[value] || 0;
}

function mapVerticalAlignment(value) {
  return {
    top: 1,
    middle: 2,
    bottom: 3,
  }[value] || 0;
}

function mapBorderStyle(value) {
  return {
    thin: 1,
    hair: 2,
    dotted: 3,
    dashed: 4,
    dashDot: 5,
    dashDotDot: 6,
    double: 7,
    medium: 8,
    mediumDashed: 9,
    mediumDashDot: 10,
    mediumDashDotDot: 11,
    slantDashDot: 12,
    thick: 13,
  }[value] || 0;
}

function mapBorderSide(side, themeColors) {
  if (!side?.style) return null;
  return {
    s: mapBorderStyle(side.style),
    cl: { rgb: resolveExcelColor(side.color, themeColors) || '#000000' },
  };
}

function mapCellStyle(cell, themeColors) {
  const style = {};
  const font = cell.font || {};
  const alignment = cell.alignment || {};
  const fill = cell.fill || {};
  const foreground = resolveExcelColor(font.color, themeColors);
  const background = fill.type === 'pattern' && fill.pattern !== 'none'
    ? resolveExcelColor(fill.fgColor, themeColors)
    : null;

  if (font.name) style.ff = font.name;
  if (Number.isFinite(font.size)) style.fs = font.size;
  if (font.bold) style.bl = 1;
  if (font.italic) style.it = 1;
  if (font.underline) style.ul = { s: 1 };
  if (font.strike) style.st = { s: 1 };
  if (foreground) style.cl = { rgb: foreground };
  if (background) style.bg = { rgb: background };
  if (alignment.horizontal) style.ht = mapHorizontalAlignment(alignment.horizontal);
  if (alignment.vertical) style.vt = mapVerticalAlignment(alignment.vertical);
  if (alignment.wrapText) style.tb = 3;
  if (Number.isFinite(alignment.textRotation)) {
    style.tr = { a: alignment.textRotation };
  }
  if (cell.numFmt && cell.numFmt !== 'General') {
    style.n = { pattern: cell.numFmt };
  }

  const border = {
    t: mapBorderSide(cell.border?.top, themeColors),
    r: mapBorderSide(cell.border?.right, themeColors),
    b: mapBorderSide(cell.border?.bottom, themeColors),
    l: mapBorderSide(cell.border?.left, themeColors),
  };
  if (Object.values(border).some(Boolean)) {
    style.bd = Object.fromEntries(Object.entries(border).filter(([, value]) => value));
  }

  return Object.keys(style).length > 0 ? style : undefined;
}

function dateToExcelSerial(value, date1904) {
  const epoch = Date.UTC(1899, 11, 30);
  const serial = (value.getTime() - epoch) / 86_400_000;
  return date1904 ? serial - 1462 : serial;
}

function normalizeFormulaResult(value, date1904) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateToExcelSerial(value, date1904);
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'object' && typeof value.error === 'string') return value.error;
  return String(value);
}

function mapCellValue(cell, date1904, themeColors) {
  const raw = cell.value;
  const style = mapCellStyle(cell, themeColors);
  const output = style ? { s: style } : {};

  if (raw === null || raw === undefined) return output;
  if (raw instanceof Date) {
    output.v = dateToExcelSerial(raw, date1904);
    output.t = 2;
    return output;
  }
  if (typeof raw === 'string') {
    output.v = raw;
    output.t = 1;
    return output;
  }
  if (typeof raw === 'number') {
    output.v = raw;
    output.t = 2;
    return output;
  }
  if (typeof raw === 'boolean') {
    output.v = raw;
    output.t = 3;
    return output;
  }
  if (Array.isArray(raw.richText)) {
    output.v = raw.richText.map((part) => part.text || '').join('');
    output.t = 1;
    return output;
  }
  const formula = typeof cell.formula === 'string'
    ? cell.formula
    : typeof raw.formula === 'string'
      ? raw.formula
      : null;
  if (formula) {
    output.f = formula.startsWith('=') ? formula : `=${formula}`;
    const result = normalizeFormulaResult(raw.result, date1904);
    if (result !== null) {
      output.v = result;
      output.t = typeof result === 'number' ? 2 : typeof result === 'boolean' ? 3 : 1;
    }
    return output;
  }
  if (typeof raw.text === 'string') {
    output.v = raw.text;
    output.t = 1;
    return output;
  }
  if (typeof raw.error === 'string') {
    output.v = raw.error;
    output.t = 1;
    return output;
  }

  output.v = String(cell.text || raw);
  output.t = 1;
  return output;
}

function rangeToUniver(worksheet, range) {
  const [startAddress, endAddress = startAddress] = String(range).split(':');
  const start = worksheet.getCell(startAddress);
  const end = worksheet.getCell(endAddress);
  return {
    startRow: start.row - 1,
    endRow: end.row - 1,
    startColumn: start.col - 1,
    endColumn: end.col - 1,
  };
}

function worksheetToUniver(worksheet, sheetIndex, date1904, themeColors) {
  const rowCount = Math.max(worksheet.rowCount, 100);
  const columnCount = Math.max(worksheet.columnCount, 26);
  if (rowCount * columnCount > MAX_INTERACTIVE_CELL_AREA) {
    throw createSpreadsheetPreviewError(
      `Worksheet "${worksheet.name}" is too large for interactive preview`,
      413,
      'SPREADSHEET_INTERACTIVE_TOO_LARGE',
    );
  }

  const cellData = {};
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const rowValues = {};
    row.eachCell({ includeEmpty: false }, (cell) => {
      rowValues[cell.col - 1] = mapCellValue(cell, date1904, themeColors);
    });
    if (Object.keys(rowValues).length > 0) cellData[row.number - 1] = rowValues;
  });

  const rowData = {};
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const data = {};
    if (Number.isFinite(row.height)) data.h = Math.round(row.height * (96 / 72));
    if (row.hidden) data.hd = 1;
    if (Object.keys(data).length > 0) rowData[rowNumber - 1] = data;
  }

  const columnData = {};
  for (let columnNumber = 1; columnNumber <= worksheet.columnCount; columnNumber += 1) {
    const column = worksheet.getColumn(columnNumber);
    const data = {};
    if (Number.isFinite(column.width)) data.w = Math.max(20, Math.round(column.width * 7 + 5));
    if (column.hidden) data.hd = 1;
    if (Object.keys(data).length > 0) columnData[columnNumber - 1] = data;
  }

  const frozenView = worksheet.views?.find((view) => view.state === 'frozen');
  const xSplit = Number(frozenView?.xSplit) || 0;
  const ySplit = Number(frozenView?.ySplit) || 0;
  return {
    id: `sheet-${sheetIndex}`,
    name: worksheet.name,
    tabColor: resolveExcelColor(worksheet.properties?.tabColor, themeColors) || '',
    hidden: 0,
    freeze: {
      xSplit,
      ySplit,
      startRow: ySplit,
      startColumn: xSplit,
    },
    rowCount,
    columnCount,
    zoomRatio: 1,
    scrollTop: 0,
    scrollLeft: 0,
    defaultColumnWidth: 88,
    defaultRowHeight: 24,
    mergeData: (worksheet.model?.merges || []).map((range) => rangeToUniver(worksheet, range)),
    cellData,
    rowData,
    columnData,
    rowHeader: { width: 46 },
    columnHeader: { height: 24 },
    showGridlines: worksheet.views?.[0]?.showGridLines === false ? 0 : 1,
    rightToLeft: worksheet.views?.[0]?.rightToLeft ? 1 : 0,
  };
}

function collectInteractivePreviewWarnings(workbook) {
  const warnings = [];
  const imageCount = workbook.worksheets.reduce(
    (total, worksheet) => total + (worksheet.getImages?.().length || 0),
    0,
  );
  if (imageCount > 0) {
    warnings.push({
      code: 'SPREADSHEET_IMAGES_NOT_RENDERED',
      message: `${imageCount} embedded image${imageCount === 1 ? '' : 's'} are not shown in interactive preview.`,
    });
  }
  if (workbook.vbaProject) {
    warnings.push({
      code: 'SPREADSHEET_MACROS_NOT_RENDERED',
      message: 'Workbook macros are not executed in interactive preview.',
    });
  }
  return warnings;
}

export async function getSpreadsheetInteractivePreview(sourcePath, options = {}) {
  const prepared = await prepareSpreadsheetWorkbook(sourcePath, options);
  const workbook = await loadInteractiveWorkbook(prepared.normalizedWorkbookPath);
  const visibleWorksheets = prepared.workbook.visibleSheets
    .map((sheet) => ({
      index: sheet.index,
      worksheet: workbook.getWorksheet(sheet.name),
    }))
    .filter(({ worksheet }) => worksheet?.state === 'visible');
  if (visibleWorksheets.length === 0) {
    throw createSpreadsheetPreviewError(
      'The workbook does not contain a visible worksheet',
      422,
      'SPREADSHEET_VISIBLE_SHEET_MISSING',
    );
  }

  const sheets = {};
  const sheetOrder = [];
  const themeColors = parseWorkbookThemeColors(workbook);
  for (const { index, worksheet } of visibleWorksheets) {
    const sheet = worksheetToUniver(
      worksheet,
      index,
      workbook.properties?.date1904 === true,
      themeColors,
    );
    sheets[sheet.id] = sheet;
    sheetOrder.push(sheet.id);
  }

  return {
    version: 1,
    revision: prepared.cacheKey,
    activeSheetIndex: getActiveVisibleSheetIndex(prepared.workbook),
    sheets: visibleWorksheets.map(({ index, worksheet }) => ({
      index,
      name: worksheet.name,
    })),
    warnings: collectInteractivePreviewWarnings(workbook),
    workbook: {
      id: `workbook-${prepared.cacheKey.slice(0, 16)}`,
      name: path.basename(sourcePath),
      appVersion: '0.25.1',
      locale: 'zhCN',
      styles: {},
      sheetOrder,
      sheets,
    },
  };
}

export async function getSpreadsheetPreviewManifest(sourcePath, options = {}) {
  const prepared = await prepareSpreadsheetWorkbook(sourcePath, options);
  return {
    version: 1,
    revision: prepared.cacheKey,
    activeSheetIndex: getActiveVisibleSheetIndex(prepared.workbook),
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
