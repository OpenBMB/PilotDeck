#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const runtimeRoot = process.env.SPREADSHEET_RUNTIME_ROOT;
const skillRoot = process.env.SPREADSHEET_SKILL_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!runtimeRoot) {
  throw new Error("SPREADSHEET_RUNTIME_ROOT is not set. Run this command through scripts/spreadsheet.sh.");
}

const require = createRequire(path.join(runtimeRoot, "package.json"));
const ExcelJS = require("exceljs");
const { parse: parseDelimitedText } = require("csv-parse/sync");
const JSZip = require("jszip");
const { DOMParser } = require("@xmldom/xmldom");
const sharp = require("sharp");

const FORMULA_ERROR_RE = /#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!|CIRC!)/i;
const SPREADSHEET_MAIN_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const HARD_RISK_FEATURES = new Set([
  "macros",
  "charts",
  "pivotTables",
  "slicers",
  "externalLinks",
  "connections",
  "queryTables",
  "drawings",
  "embeddings",
  "activeX",
  "signatures",
]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") {
    throw new Error(`Missing required option --${key}`);
  }
  return String(value);
}

function integerOption(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  const value = Number.parseInt(String(options[key]), 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`--${key} must be a positive integer`);
  return value;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function emitReport(report, outPath) {
  if (outPath) await writeJson(outPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function workbookExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function assertSupportedInput(filePath) {
  const extension = workbookExtension(filePath);
  if (![".xlsx", ".csv", ".tsv"].includes(extension)) {
    throw new Error(`Unsupported spreadsheet format '${extension || "(none)"}'. Use .xlsx, .csv, or .tsv.`);
  }
  return extension;
}

function createWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PilotDeck";
  workbook.lastModifiedBy = "PilotDeck";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  return workbook;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function normalizePrefixedSpreadsheetPackage(filePath) {
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  let changed = false;

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !entryName.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    const namespaceMatch = xml.match(
      /xmlns:([A-Za-z_][\w.-]*)=(["'])http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main\2/,
    );
    if (!namespaceMatch) continue;

    const prefix = escapeRegularExpression(namespaceMatch[1]);
    const quote = namespaceMatch[2];
    let normalized = xml.replace(new RegExp(`(<\\/?)(?:${prefix}):`, "g"), "$1");
    const defaultNamespace = `xmlns=${quote}${SPREADSHEET_MAIN_NAMESPACE}${quote}`;
    normalized = normalized.includes(defaultNamespace)
      ? normalized.replace(namespaceMatch[0], "")
      : normalized.replace(namespaceMatch[0], defaultNamespace);

    if (normalized !== xml) {
      zip.file(entryName, normalized);
      changed = true;
    }
  }

  return changed ? zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : null;
}

async function loadXlsx(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path.resolve(filePath));
    return workbook;
  } catch (error) {
    const normalizedPackage = await normalizePrefixedSpreadsheetPackage(filePath);
    if (!normalizedPackage) throw error;
    const normalizedWorkbook = new ExcelJS.Workbook();
    await normalizedWorkbook.xlsx.load(normalizedPackage);
    return normalizedWorkbook;
  }
}

function inferScalar(value) {
  if (value === "") return "";
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

async function loadDelimited(filePath, { sheetName = "Sheet1", inferTypes = false } = {}) {
  const extension = assertSupportedInput(filePath);
  if (extension === ".xlsx") throw new Error("loadDelimited only accepts .csv or .tsv files");
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const source = await fs.readFile(filePath, "utf8");
  const rows = parseDelimitedText(source, {
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  });
  const workbook = createWorkbook();
  const worksheet = workbook.addWorksheet(sheetName);
  for (const row of rows) {
    worksheet.addRow(inferTypes ? row.map((value) => inferScalar(value)) : row);
  }
  return workbook;
}

async function loadWorkbook(filePath, options = {}) {
  const extension = assertSupportedInput(filePath);
  return extension === ".xlsx" ? loadXlsx(filePath) : loadDelimited(filePath, options);
}

function columnNumber(letters) {
  let value = 0;
  for (const character of letters.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function columnLetters(number) {
  let current = number;
  let result = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function parseCellReference(reference) {
  const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(reference.trim());
  if (!match) throw new Error(`Invalid cell reference '${reference}'`);
  return { col: columnNumber(match[1]), row: Number.parseInt(match[2], 10) };
}

function parseRangeReference(reference) {
  const [fromText, toText = fromText] = reference.split(":");
  const from = parseCellReference(fromText);
  const to = parseCellReference(toText);
  return {
    startRow: Math.min(from.row, to.row),
    endRow: Math.max(from.row, to.row),
    startCol: Math.min(from.col, to.col),
    endCol: Math.max(from.col, to.col),
  };
}

function forEachCellInRange(worksheet, rangeRef, callback) {
  const bounds = parseRangeReference(rangeRef);
  for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
    for (let col = bounds.startCol; col <= bounds.endCol; col += 1) {
      callback(worksheet.getCell(row, col), row, col);
    }
  }
}

function styleHeader(worksheet, rangeRef, options = {}) {
  const fill = options.fill ?? "FF0F766E";
  const color = options.color ?? "FFFFFFFF";
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    cell.font = { ...(cell.font ?? {}), bold: true, color: { argb: color } };
    cell.alignment = { ...(cell.alignment ?? {}), vertical: "middle" };
  });
}

function displayCellText(cell) {
  if (cell.text !== undefined && cell.text !== null && cell.text !== "") return String(cell.text);
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return value.result === null || value.result === undefined ? "" : String(value.result);
    if ("text" in value) return String(value.text);
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

function autoFitColumns(worksheet, { min = 8, max = 40, padding = 2, sampleRows = 5000 } = {}) {
  const lastColumn = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  const lastRow = Math.min(Math.max(worksheet.rowCount, worksheet.actualRowCount, 1), sampleRows);
  for (let col = 1; col <= lastColumn; col += 1) {
    let width = min;
    for (let row = 1; row <= lastRow; row += 1) {
      const text = displayCellText(worksheet.getCell(row, col));
      const longestLine = text.split(/\r?\n/).reduce((longest, line) => Math.max(longest, [...line].length), 0);
      width = Math.max(width, Math.min(max, longestLine + padding));
    }
    worksheet.getColumn(col).width = Math.max(min, Math.min(max, width));
  }
}

function serializableValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(serializableValue);
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value)) output[key] = serializableValue(nested);
    return output;
  }
  return value;
}

function styleSummary(cell) {
  const style = {};
  if (cell.numFmt) style.numberFormat = cell.numFmt;
  if (cell.font && Object.keys(cell.font).length > 0) style.font = serializableValue(cell.font);
  if (cell.fill && cell.fill.type) style.fill = serializableValue(cell.fill);
  if (cell.border && Object.keys(cell.border).length > 0) style.border = serializableValue(cell.border);
  if (cell.alignment && Object.keys(cell.alignment).length > 0) style.alignment = serializableValue(cell.alignment);
  return style;
}

function formulaDescriptor(cell) {
  const value = cell.value;
  if (!value || typeof value !== "object") return null;
  if (!("formula" in value) && !("sharedFormula" in value)) return null;
  return {
    address: cell.address,
    formula: value.formula ?? null,
    sharedFormula: value.sharedFormula ?? null,
    result: serializableValue(value.result),
  };
}

function errorFromValue(value) {
  if (typeof value === "string" && FORMULA_ERROR_RE.test(value)) return value.match(FORMULA_ERROR_RE)?.[0] ?? value;
  if (value && typeof value === "object") {
    if (typeof value.error === "string" && FORMULA_ERROR_RE.test(value.error)) return value.error;
    if (typeof value.result === "string" && FORMULA_ERROR_RE.test(value.result)) return value.result;
    if (value.result && typeof value.result === "object" && typeof value.result.error === "string") return value.result.error;
  }
  return null;
}

function collectWorkbookFacts(workbook, { maxFormulas = 500, maxErrors = 500 } = {}) {
  const formulas = [];
  const errors = [];
  const missingCachedResults = [];
  const formulaReferencesWithErrors = [];
  let formulaCount = 0;

  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const formula = formulaDescriptor(cell);
        if (formula) {
          formulaCount += 1;
          if (formulas.length < maxFormulas) formulas.push({ sheet: worksheet.name, ...formula });
          if (formula.result === null && missingCachedResults.length < maxErrors) {
            missingCachedResults.push({ sheet: worksheet.name, address: cell.address, formula: formula.formula });
          }
          if (typeof formula.formula === "string" && FORMULA_ERROR_RE.test(formula.formula)) {
            formulaReferencesWithErrors.push({ sheet: worksheet.name, address: cell.address, formula: formula.formula });
          }
        }
        const error = errorFromValue(cell.value);
        if (error && errors.length < maxErrors) errors.push({ sheet: worksheet.name, address: cell.address, error });
      });
    });
  }

  return { formulaCount, formulas, errors, missingCachedResults, formulaReferencesWithErrors };
}

async function inspectPackage(filePath) {
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  const entries = Object.keys(zip.files).filter((entry) => !zip.files[entry].dir);
  const count = (predicate) => entries.filter(predicate).length;
  const drawingParts = entries.filter((entry) => /^xl\/drawings\/drawing\d+\.xml$/i.test(entry));
  const drawings = [];
  let drawingObjectCount = 0;
  for (const entry of drawingParts) {
    const xml = await zip.file(entry).async("string");
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const anchors = ["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"]
      .reduce((total, tag) => total + document.getElementsByTagName(`xdr:${tag}`).length, 0);
    if (anchors > 0) {
      drawings.push({ part: entry, objects: anchors });
      drawingObjectCount += anchors;
    }
  }

  const features = {
    macros: count((entry) => /(?:^|\/)vbaProject\.bin$/i.test(entry)),
    charts: count((entry) => /^xl\/charts\/chart\d+\.xml$/i.test(entry)),
    pivotTables: count((entry) => /^xl\/(?:pivotTables|pivotCache)\//i.test(entry)),
    slicers: count((entry) => /^xl\/(?:slicers|slicerCaches)\//i.test(entry)),
    externalLinks: count((entry) => /^xl\/externalLinks\//i.test(entry)),
    connections: count((entry) => /^xl\/connections\.xml$/i.test(entry)),
    queryTables: count((entry) => /^xl\/queryTables\//i.test(entry)),
    drawings: drawingObjectCount,
    media: count((entry) => /^xl\/media\//i.test(entry)),
    embeddings: count((entry) => /^xl\/embeddings\//i.test(entry)),
    activeX: count((entry) => /^xl\/activeX\//i.test(entry)),
    threadedComments: count((entry) => /^xl\/threadedComments\//i.test(entry)),
    comments: count((entry) => /^xl\/comments\d+\.xml$/i.test(entry)),
    customXml: count((entry) => /^customXml\//i.test(entry)),
    signatures: count((entry) => /^_xmlsignatures\//i.test(entry)),
    tables: count((entry) => /^xl\/tables\/table\d+\.xml$/i.test(entry)),
  };

  const charts = [];
  for (const entry of entries.filter((name) => /^xl\/charts\/chart\d+\.xml$/i.test(name))) {
    const xml = await zip.file(entry).async("string");
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const chartTags = [
      "barChart", "lineChart", "areaChart", "pieChart", "doughnutChart", "scatterChart",
      "bubbleChart", "radarChart", "stockChart", "surfaceChart", "ofPieChart",
    ];
    const types = chartTags.filter((tag) => document.getElementsByTagName(`c:${tag}`).length > 0);
    const formulas = Array.from(document.getElementsByTagName("c:f"))
      .map((node) => node.textContent?.trim())
      .filter(Boolean);
    charts.push({ part: entry, types, sourceFormulas: [...new Set(formulas)] });
  }

  const risks = Object.entries(features)
    .filter(([name, amount]) => amount > 0 && HARD_RISK_FEATURES.has(name))
    .map(([name, amount]) => ({ feature: name, count: amount }));

  return {
    entryCount: entries.length,
    features,
    charts,
    drawings,
    unsafeForRoundTrip: risks.length > 0,
    roundTripRisks: risks,
  };
}

function tableSummaries(worksheet) {
  const tables = worksheet.model?.tables;
  if (!Array.isArray(tables)) return [];
  return tables.map((table) => ({
    name: table.name ?? table.displayName ?? null,
    ref: table.tableRef ?? table.ref ?? null,
    headerRow: table.headerRow ?? null,
    totalsRow: table.totalsRow ?? null,
  }));
}

function worksheetSummary(worksheet) {
  return {
    name: worksheet.name,
    state: worksheet.state,
    rowCount: worksheet.rowCount,
    actualRowCount: worksheet.actualRowCount,
    columnCount: worksheet.columnCount,
    actualColumnCount: worksheet.actualColumnCount,
    mergedRanges: Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [],
    tables: tableSummaries(worksheet),
    views: serializableValue(worksheet.views),
    pageSetup: serializableValue(worksheet.pageSetup),
  };
}

function selectedRange(worksheet, requestedRange, maxRows, maxCols) {
  const usedRows = Math.max(worksheet.rowCount, worksheet.actualRowCount, 1);
  const usedCols = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  const requested = requestedRange
    ? parseRangeReference(requestedRange)
    : { startRow: 1, startCol: 1, endRow: usedRows, endCol: usedCols };
  const endRow = Math.min(requested.endRow, requested.startRow + maxRows - 1);
  const endCol = Math.min(requested.endCol, requested.startCol + maxCols - 1);
  return { ...requested, endRow, endCol };
}

function inspectCells(worksheet, range, includeStyles) {
  const cells = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let col = range.startCol; col <= range.endCol; col += 1) {
      const cell = worksheet.getCell(row, col);
      const formula = formulaDescriptor(cell);
      const hasStyle = cell.style && Object.keys(cell.style).length > 0;
      if (cell.value === null && !formula && !(includeStyles && hasStyle)) continue;
      const record = {
        address: cell.address,
        value: formula ? serializableValue(formula.result) : serializableValue(cell.value),
      };
      if (formula) record.formula = formula.formula ?? { sharedFormula: formula.sharedFormula };
      if (includeStyles) record.style = styleSummary(cell);
      cells.push(record);
    }
  }
  return cells;
}

async function inspectXlsx(filePath, options = {}) {
  const workbook = await loadXlsx(filePath);
  const packageInfo = await inspectPackage(filePath);
  const maxRows = integerOption(options, "max-rows", 30);
  const maxCols = integerOption(options, "max-cols", 20);
  const worksheet = options.sheet
    ? workbook.getWorksheet(String(options.sheet))
    : workbook.worksheets[0];
  if (!worksheet) throw new Error(options.sheet ? `Worksheet '${options.sheet}' was not found` : "Workbook has no worksheets");
  const range = selectedRange(worksheet, options.range ? String(options.range) : null, maxRows, maxCols);
  const facts = collectWorkbookFacts(workbook, { maxFormulas: integerOption(options, "max-formulas", 100) });
  return {
    status: "ok",
    path: path.resolve(filePath),
    format: "xlsx",
    workbook: {
      creator: workbook.creator ?? null,
      modified: workbook.modified ?? null,
      worksheetCount: workbook.worksheets.length,
      worksheets: workbook.worksheets.map(worksheetSummary),
      definedNames: serializableValue(workbook.definedNames?.model ?? []),
    },
    package: packageInfo,
    selection: {
      sheet: worksheet.name,
      range: `${columnLetters(range.startCol)}${range.startRow}:${columnLetters(range.endCol)}${range.endRow}`,
      truncated: Boolean(options.range) ? false : worksheet.rowCount > maxRows || worksheet.columnCount > maxCols,
      cells: inspectCells(worksheet, range, Boolean(options.styles)),
    },
    formulas: {
      count: facts.formulaCount,
      items: facts.formulas,
    },
  };
}

async function inspectDelimited(filePath, options = {}) {
  const extension = assertSupportedInput(filePath);
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const source = await fs.readFile(filePath, "utf8");
  const rows = parseDelimitedText(source, {
    bom: true,
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
  });
  const maxRows = integerOption(options, "max-rows", 30);
  const maxCols = integerOption(options, "max-cols", 20);
  const widths = rows.map((row) => row.length);
  return {
    status: "ok",
    path: path.resolve(filePath),
    format: extension.slice(1),
    delimiter: extension === ".tsv" ? "tab" : "comma",
    rowCount: rows.length,
    maxColumnCount: widths.length > 0 ? Math.max(...widths) : 0,
    inconsistentRowWidths: [...new Set(widths)].length > 1,
    preview: rows.slice(0, maxRows).map((row) => row.slice(0, maxCols)),
    truncated: rows.length > maxRows || widths.some((width) => width > maxCols),
  };
}

async function auditXlsx(filePath) {
  const packageInfo = await inspectPackage(filePath);
  const workbook = await loadXlsx(filePath);
  const facts = collectWorkbookFacts(workbook);
  const blankSheets = workbook.worksheets
    .filter((worksheet) => worksheet.actualRowCount === 0)
    .map((worksheet) => worksheet.name);
  const oversizedSheets = workbook.worksheets
    .filter((worksheet) => worksheet.rowCount > 200000 || worksheet.columnCount > 200)
    .map((worksheet) => ({ name: worksheet.name, rows: worksheet.rowCount, columns: worksheet.columnCount }));
  const warnings = [];
  if (blankSheets.length > 0) warnings.push({ type: "blank_sheets", sheets: blankSheets });
  if (oversizedSheets.length > 0) warnings.push({ type: "large_used_ranges", sheets: oversizedSheets });
  if (facts.missingCachedResults.length > 0) {
    warnings.push({ type: "missing_cached_formula_results", cells: facts.missingCachedResults.slice(0, 100) });
  }
  if (packageInfo.unsafeForRoundTrip) {
    warnings.push({ type: "round_trip_risk", features: packageInfo.roundTripRisks });
  }
  const hardFailures = [
    ...facts.errors.map((error) => ({ type: "formula_error", ...error })),
    ...facts.formulaReferencesWithErrors.map((error) => ({ type: "invalid_formula_reference", ...error })),
  ];
  return {
    status: hardFailures.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok",
    path: path.resolve(filePath),
    worksheetCount: workbook.worksheets.length,
    formulas: {
      count: facts.formulaCount,
      errors: facts.errors,
      missingCachedResults: facts.missingCachedResults,
      invalidReferences: facts.formulaReferencesWithErrors,
    },
    package: packageInfo,
    hardFailures,
    warnings,
  };
}

async function auditDelimited(filePath) {
  const report = await inspectDelimited(filePath, { "max-rows": 5, "max-cols": 20 });
  const failures = [];
  const warnings = [];
  if (report.inconsistentRowWidths) warnings.push({ type: "inconsistent_row_widths" });
  if (report.rowCount === 0) warnings.push({ type: "empty_file" });
  return {
    status: failures.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok",
    path: report.path,
    format: report.format,
    rowCount: report.rowCount,
    maxColumnCount: report.maxColumnCount,
    hardFailures: failures,
    warnings,
  };
}

function findSoffice() {
  const configured = process.env.SPREADSHEET_SKILL_SOFFICE;
  if (configured) return configured;
  if (process.platform === "darwin") return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
  return "soffice";
}

function findRenderer() {
  return process.env.SPREADSHEET_SKILL_PDF_RENDERER || "";
}

async function runLibreOffice(args, profileDir) {
  const soffice = findSoffice();
  if (!soffice || !(await pathExists(soffice)) && path.isAbsolute(soffice)) {
    throw new Error("LibreOffice was not found. Install LibreOffice or expose soffice on PATH.");
  }
  const profileArg = `-env:UserInstallation=${pathToFileURL(profileDir).href}`;
  const result = await execFileAsync(soffice, [
    profileArg,
    "--headless",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--norestore",
    ...args,
  ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function prepareWorkbookForRecalculation(inputPath, outputPath) {
  const source = await fs.readFile(inputPath);
  const zip = await JSZip.loadAsync(source);
  const workbookPart = zip.file("xl/workbook.xml");
  if (!workbookPart) throw new Error("The XLSX package is missing xl/workbook.xml");
  let workbookXml = await workbookPart.async("string");
  if (/<calcPr\b[^>]*\/>/.test(workbookXml)) {
    workbookXml = workbookXml.replace(/<calcPr\b([^>]*)\/>/, (_match, attributes) => {
      const preserved = attributes.replace(/\s(?:calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"/g, "");
      return `<calcPr${preserved} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`;
    });
  } else {
    workbookXml = workbookXml.replace("</workbook>", '<calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
  }
  zip.file("xl/workbook.xml", workbookXml);

  const worksheetParts = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name));
  for (const worksheetPart of worksheetParts) {
    let worksheetXml = await zip.file(worksheetPart).async("string");
    worksheetXml = worksheetXml.replace(
      /<c\b([^>]*)>([\s\S]*?<f[^>]*>)([\s\S]*?<\/f>)(?:<v>[^<]*<\/v>)?([\s\S]*?)<\/c>/g,
      (_match, cellAttributes, formulaOpen, formulaBody, remainder) => {
        const normalizedFormula = formulaBody.replace(/^=/, "");
        return `<c${cellAttributes}>${formulaOpen}${normalizedFormula}${remainder}</c>`;
      },
    );
    zip.file(worksheetPart, worksheetXml);
  }

  await ensureParent(outputPath);
  const prepared = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(outputPath, prepared);
}

async function recalculateWorkbook(inputPath, outputPath) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-recalc-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const convertedDir = path.join(tempRoot, "converted");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([
      fs.mkdir(sourceDir, { recursive: true }),
      fs.mkdir(convertedDir, { recursive: true }),
      fs.mkdir(profileDir, { recursive: true }),
    ]);
    const sourcePath = path.join(sourceDir, "workbook.xlsx");
    await prepareWorkbookForRecalculation(inputPath, sourcePath);
    const conversion = await runLibreOffice([
      "--convert-to",
      "xlsx:Calc MS Excel 2007 XML",
      "--outdir",
      convertedDir,
      sourcePath,
    ], profileDir);
    const convertedPath = path.join(convertedDir, "workbook.xlsx");
    if (!(await pathExists(convertedPath))) {
      throw new Error(`LibreOffice did not produce a recalculated XLSX. ${conversion.stderr || conversion.stdout}`.trim());
    }
    await ensureParent(outputPath);
    await fs.copyFile(convertedPath, outputPath);
    return { output: path.resolve(outputPath), engine: "LibreOffice" };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function delimitedCellValue(cell) {
  const formula = formulaDescriptor(cell);
  const value = formula ? formula.result : cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.error === "string") return value.error;
    return JSON.stringify(serializableValue(value));
  }
  return String(value);
}

function escapeDelimited(value, delimiter) {
  const text = String(value ?? "");
  if (text.includes(delimiter) || text.includes('"') || /[\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

async function exportDelimited(workbook, outputPath, sheetName) {
  const worksheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
  if (!worksheet) throw new Error(sheetName ? `Worksheet '${sheetName}' was not found` : "Workbook has no worksheets");
  const delimiter = workbookExtension(outputPath) === ".tsv" ? "\t" : ",";
  const lines = [];
  const lastRow = Math.max(worksheet.rowCount, worksheet.actualRowCount, 0);
  const lastCol = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 0);
  for (let row = 1; row <= lastRow; row += 1) {
    const values = [];
    for (let col = 1; col <= lastCol; col += 1) {
      values.push(escapeDelimited(delimitedCellValue(worksheet.getCell(row, col)), delimiter));
    }
    lines.push(values.join(delimiter));
  }
  await ensureParent(outputPath);
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function createToolkit(inputPath) {
  return {
    ExcelJS,
    inputPath: inputPath ? path.resolve(inputPath) : null,
    createWorkbook,
    loadWorkbook,
    loadXlsx,
    loadDelimited,
    helpers: {
      autoFitColumns,
      forEachCellInRange,
      styleHeader,
      parseRangeReference,
      columnLetters,
      columnNumber,
    },
  };
}

async function buildFromBuilder(builderPath, inputPath) {
  const builderUrl = `${pathToFileURL(path.resolve(builderPath)).href}?pilotdeck=${Date.now()}`;
  const module = await import(builderUrl);
  if (typeof module.default !== "function") throw new Error("The builder must export a default async function");
  const product = await module.default(createToolkit(inputPath));
  const workbook = product?.workbook ?? product;
  if (!workbook || typeof workbook.xlsx?.writeFile !== "function") {
    throw new Error("The builder must return an ExcelJS Workbook or { workbook, sheetName? }");
  }
  return { workbook, sheetName: product?.workbook ? product.sheetName : undefined };
}

async function commandScaffold(options) {
  const outputPath = requireOption(options, "out");
  const starter = path.join(skillRoot, "assets", "starter-workbook.mjs");
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing builder: ${outputPath}`);
  await ensureParent(outputPath);
  await fs.copyFile(starter, outputPath);
  await emitReport({ status: "ok", output: path.resolve(outputPath) }, options.report && String(options.report));
}

async function commandBuild(options) {
  const builderPath = requireOption(options, "builder");
  const outputPath = requireOption(options, "out");
  const inputPath = options.input ? String(options.input) : null;
  const outputExtension = assertSupportedInput(outputPath);

  if (inputPath) {
    assertSupportedInput(inputPath);
    if (path.resolve(inputPath) === path.resolve(outputPath)) {
      throw new Error("Refusing to overwrite the input spreadsheet. Choose a distinct --out path.");
    }
    if (workbookExtension(inputPath) === ".xlsx") {
      const packageInfo = await inspectPackage(inputPath);
      if (packageInfo.unsafeForRoundTrip && !options["allow-risky-roundtrip"]) {
        const names = packageInfo.roundTripRisks.map((risk) => `${risk.feature}(${risk.count})`).join(", ");
        throw new Error(`Input workbook contains objects that are unsafe for an ExcelJS round trip: ${names}. Do not bypass without explicit user approval.`);
      }
    }
  }

  const { workbook, sheetName } = await buildFromBuilder(builderPath, inputPath);
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;

  if (outputExtension === ".csv" || outputExtension === ".tsv") {
    await exportDelimited(workbook, outputPath, options.sheet ? String(options.sheet) : sheetName);
    const audit = await auditDelimited(outputPath);
    await emitReport({ status: audit.status, output: path.resolve(outputPath), format: outputExtension.slice(1), audit }, options.report && String(options.report));
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-build-"));
  try {
    const rawPath = path.join(tempRoot, "raw.xlsx");
    await workbook.xlsx.writeFile(rawPath);
    const facts = collectWorkbookFacts(workbook);
    let recalculated = false;
    if (facts.formulaCount > 0) {
      await recalculateWorkbook(rawPath, outputPath);
      recalculated = true;
    } else {
      await ensureParent(outputPath);
      await fs.copyFile(rawPath, outputPath);
    }
    const audit = await auditXlsx(outputPath);
    if (audit.status === "error") {
      throw new Error(`Workbook was created but failed formula audit. See ${path.resolve(outputPath)} and run audit for details.`);
    }
    await emitReport({
      status: audit.status,
      output: path.resolve(outputPath),
      formulaCount: facts.formulaCount,
      recalculated,
      audit,
    }, options.report && String(options.report));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandInspect(options) {
  const inputPath = requireOption(options, "input");
  const extension = assertSupportedInput(inputPath);
  const report = extension === ".xlsx"
    ? await inspectXlsx(inputPath, options)
    : await inspectDelimited(inputPath, options);
  await emitReport(report, options.out && String(options.out));
}

async function commandAudit(options) {
  const inputPath = requireOption(options, "input");
  const extension = assertSupportedInput(inputPath);
  const report = extension === ".xlsx" ? await auditXlsx(inputPath) : await auditDelimited(inputPath);
  await emitReport(report, options.out && String(options.out));
  if (report.status === "error") process.exitCode = 1;
}

async function commandRecalculate(options) {
  const inputPath = requireOption(options, "input");
  const outputPath = requireOption(options, "out");
  if (workbookExtension(inputPath) !== ".xlsx" || workbookExtension(outputPath) !== ".xlsx") {
    throw new Error("recalculate accepts .xlsx input and output only");
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error("Refusing to overwrite the input workbook");
  const packageInfo = await inspectPackage(inputPath);
  if (packageInfo.unsafeForRoundTrip && !options["allow-risky-roundtrip"]) {
    const names = packageInfo.roundTripRisks.map((risk) => `${risk.feature}(${risk.count})`).join(", ");
    throw new Error(`Input workbook contains objects that are unsafe for a LibreOffice round trip: ${names}. Do not bypass without explicit user approval.`);
  }
  const result = await recalculateWorkbook(inputPath, outputPath);
  const audit = await auditXlsx(outputPath);
  await emitReport({ status: audit.status, ...result, audit }, options.report && String(options.report));
  if (audit.status === "error") process.exitCode = 1;
}

function naturalPageSort(left, right) {
  const leftNumber = Number(left.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  const rightNumber = Number(right.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  return leftNumber - rightNumber || left.localeCompare(right);
}

async function createMontage(pagePaths, outputPath) {
  const thumbWidth = 420;
  const thumbHeight = 560;
  const gutter = 20;
  const labelHeight = 30;
  const columns = Math.min(3, Math.max(1, pagePaths.length));
  const rows = Math.ceil(pagePaths.length / columns);
  const width = columns * (thumbWidth + gutter) + gutter;
  const height = rows * (thumbHeight + labelHeight + gutter) + gutter;
  const composites = [];

  for (let index = 0; index < pagePaths.length; index += 1) {
    const page = pagePaths[index];
    const x = gutter + (index % columns) * (thumbWidth + gutter);
    const y = gutter + Math.floor(index / columns) * (thumbHeight + labelHeight + gutter);
    const image = await sharp(page)
      .flatten({ background: "#ffffff" })
      .resize({ width: thumbWidth, height: thumbHeight, fit: "inside", background: "#ffffff" })
      .png()
      .toBuffer({ resolveWithObject: true });
    composites.push({ input: image.data, left: x + Math.floor((thumbWidth - image.info.width) / 2), top: y });
    const label = Buffer.from(`<svg width="${thumbWidth}" height="${labelHeight}"><text x="${thumbWidth / 2}" y="21" text-anchor="middle" font-family="Arial" font-size="16" fill="#334155">Page ${index + 1}</text></svg>`);
    composites.push({ input: label, left: x, top: y + thumbHeight });
  }

  await ensureParent(outputPath);
  await sharp({ create: { width, height, channels: 4, background: "#e2e8f0" } })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

async function convertToXlsxForRender(inputPath, tempRoot) {
  if (workbookExtension(inputPath) === ".xlsx") return inputPath;
  const workbook = await loadDelimited(inputPath, { inferTypes: true });
  for (const worksheet of workbook.worksheets) {
    autoFitColumns(worksheet, { min: 8, max: 32 });
    worksheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
  const outputPath = path.join(tempRoot, "delimited.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

async function renderWorkbook(inputPath, outputDir, { pdfPath, montagePath } = {}) {
  const renderer = findRenderer();
  if (!renderer) throw new Error("No PDF renderer was found. Install pdftoppm, mutool, or ImageMagick.");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-render-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const pdfDir = path.join(tempRoot, "pdf");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([
      fs.mkdir(sourceDir, { recursive: true }),
      fs.mkdir(pdfDir, { recursive: true }),
      fs.mkdir(profileDir, { recursive: true }),
      fs.mkdir(outputDir, { recursive: true }),
    ]);
    const xlsxInput = await convertToXlsxForRender(inputPath, tempRoot);
    const sourcePath = path.join(sourceDir, "workbook.xlsx");
    await fs.copyFile(xlsxInput, sourcePath);
    const conversion = await runLibreOffice([
      "--convert-to",
      "pdf:calc_pdf_Export",
      "--outdir",
      pdfDir,
      sourcePath,
    ], profileDir);
    const generatedPdf = path.join(pdfDir, "workbook.pdf");
    if (!(await pathExists(generatedPdf))) {
      throw new Error(`LibreOffice did not produce a PDF. ${conversion.stderr || conversion.stdout}`.trim());
    }

    const finalPdf = pdfPath ?? path.join(outputDir, "workbook.pdf");
    await ensureParent(finalPdf);
    await fs.copyFile(generatedPdf, finalPdf);
    const prefix = path.join(outputDir, "page");
    const rendererName = path.basename(renderer).toLowerCase();
    if (rendererName.startsWith("pdftoppm")) {
      await execFileAsync(renderer, ["-png", "-r", "144", generatedPdf, prefix], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    } else if (rendererName.startsWith("mutool")) {
      await execFileAsync(renderer, ["draw", "-r", "144", "-o", `${prefix}-%d.png`, generatedPdf], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    } else {
      await execFileAsync(renderer, ["-density", "144", generatedPdf, `${prefix}-%d.png`], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    }
    const pageNames = (await fs.readdir(outputDir)).filter((name) => /^page-?\d+\.png$/i.test(name)).sort(naturalPageSort);
    if (pageNames.length === 0) throw new Error("The PDF renderer produced no page images");
    const pages = pageNames.map((name) => path.join(outputDir, name));
    const finalMontage = montagePath ?? path.join(outputDir, "montage.png");
    await createMontage(pages, finalMontage);
    return {
      pdf: path.resolve(finalPdf),
      montage: path.resolve(finalMontage),
      pages: pages.map((page) => path.resolve(page)),
      pageCount: pages.length,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandRender(options) {
  const inputPath = requireOption(options, "input");
  const outputDir = requireOption(options, "out-dir");
  assertSupportedInput(inputPath);
  const rendered = await renderWorkbook(inputPath, outputDir, {
    pdfPath: options.pdf ? String(options.pdf) : undefined,
    montagePath: options.montage ? String(options.montage) : undefined,
  });
  await emitReport({ status: "ok", input: path.resolve(inputPath), ...rendered }, options.report && String(options.report));
}

async function createSelfTestWorkbook() {
  const workbook = createWorkbook();
  const inputs = workbook.addWorksheet("Inputs", { views: [{ showGridLines: false }] });
  inputs.addRows([
    ["Assumption", "Value"],
    ["Revenue", 100000],
    ["Growth", 0.1],
  ]);
  styleHeader(inputs, "A1:B1");
  inputs.getCell("B2").numFmt = '"$"#,##0';
  inputs.getCell("B3").numFmt = "0.0%";
  autoFitColumns(inputs, { min: 12, max: 24 });

  const summary = workbook.addWorksheet("Summary", {
    views: [{ state: "frozen", ySplit: 3, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  summary.mergeCells("A1:D1");
  summary.getCell("A1").value = "PilotDeck Spreadsheet Self-Test";
  summary.getCell("A1").font = { name: "Arial", size: 18, bold: true, color: { argb: "FF0F172A" } };
  summary.getRow(1).height = 28;
  summary.addTable({
    name: "SelfTestTable",
    ref: "A3",
    headerRow: true,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [{ name: "Month" }, { name: "Revenue" }, { name: "Cost" }],
    rows: [["Jan", 100000, 70000], ["Feb", 120000, 78000], ["Mar", 135000, 85000]],
  });
  summary.getCell("D3").value = "Margin";
  styleHeader(summary, "D3:D3");
  for (let row = 4; row <= 6; row += 1) {
    summary.getCell(`D${row}`).value = { formula: `IFERROR((B${row}-C${row})/B${row},0)`, result: 0 };
    summary.getCell(`D${row}`).numFmt = "0.0%";
  }
  summary.getCell("A8").value = "Projected revenue";
  summary.getCell("B8").value = { formula: "'Inputs'!B2*(1+'Inputs'!B3)", result: 0 };
  summary.getCell("B8").numFmt = '"$"#,##0';
  summary.getCell("F3").value = "Status";
  summary.getCell("F4").value = "On Track";
  summary.getCell("F4").dataValidation = {
    type: "list",
    allowBlank: false,
    formulae: ['"On Track,At Risk,Blocked"'],
  };
  summary.addConditionalFormatting({
    ref: "D4:D6",
    rules: [{ type: "cellIs", operator: "lessThan", formulae: [0.25], style: { font: { color: { argb: "FFB91C1C" } } } }],
  });
  forEachCellInRange(summary, "B4:C6", (cell) => { cell.numFmt = '"$"#,##0'; });
  autoFitColumns(summary, { min: 11, max: 26 });
  return workbook;
}

async function commandSelfTest(options) {
  const outputDir = options.out ? String(options.out) : path.join(os.tmpdir(), `pilotdeck-spreadsheets-self-test-${Date.now()}`);
  await fs.mkdir(outputDir, { recursive: true });
  const steps = [];

  const rawPath = path.join(outputDir, "raw.xlsx");
  const finalPath = path.join(outputDir, "self-test.xlsx");
  const workbook = await createSelfTestWorkbook();
  await workbook.xlsx.writeFile(rawPath);
  steps.push({ name: "create", status: "ok", output: rawPath });

  await recalculateWorkbook(rawPath, finalPath);
  const recalculated = await loadXlsx(finalPath);
  const margin = recalculated.getWorksheet("Summary").getCell("D4").result;
  const projected = recalculated.getWorksheet("Summary").getCell("B8").result;
  if (Math.abs(Number(margin) - 0.3) > 0.000001 || Math.abs(Number(projected) - 110000) > 0.01) {
    throw new Error(`Formula recalculation failed: margin=${margin}, projected=${projected}`);
  }
  steps.push({ name: "recalculate", status: "ok", margin, projected });

  const inspection = await inspectXlsx(finalPath, { sheet: "Summary", range: "A1:F8", styles: true });
  if (inspection.formulas.count < 4 || inspection.package.features.tables < 1) throw new Error("Inspection missed formulas or tables");
  steps.push({ name: "inspect", status: "ok", formulas: inspection.formulas.count, tables: inspection.package.features.tables });

  const prefixedPath = path.join(outputDir, "prefixed-main-namespace.xlsx");
  const prefixedZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  let prefixedPartCount = 0;
  for (const [entryName, entry] of Object.entries(prefixedZip.files)) {
    if (entry.dir || !entryName.endsWith(".xml")) continue;
    const xml = await entry.async("string");
    const defaultNamespace = `xmlns="${SPREADSHEET_MAIN_NAMESPACE}"`;
    if (!xml.includes(defaultNamespace)) continue;
    const prefixed = xml
      .replace(defaultNamespace, `xmlns:x="${SPREADSHEET_MAIN_NAMESPACE}"`)
      .replace(/(<\/?)([A-Za-z_][\w.-]*)(?=[\s/>])/g, "$1x:$2");
    prefixedZip.file(entryName, prefixed);
    prefixedPartCount += 1;
  }
  await fs.writeFile(prefixedPath, await prefixedZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const prefixedInspection = await inspectXlsx(prefixedPath, { sheet: "Summary", range: "A1:F8" });
  if (prefixedPartCount === 0 || prefixedInspection.selection.cells.length === 0) {
    throw new Error("Inspection failed for prefixed SpreadsheetML namespaces");
  }
  steps.push({ name: "inspect-prefixed-ooxml", status: "ok", normalizedParts: prefixedPartCount });

  const audit = await auditXlsx(finalPath);
  if (audit.status === "error") throw new Error("Clean workbook failed audit");
  if (audit.package.unsafeForRoundTrip) throw new Error("Empty LibreOffice drawing parts were incorrectly marked as unsafe");
  steps.push({ name: "audit-clean", status: audit.status });

  const editBuilderPath = path.join(outputDir, "edit-builder.mjs");
  await fs.writeFile(editBuilderPath, `export default async function build({ inputPath, loadWorkbook }) {\n  const workbook = await loadWorkbook(inputPath);\n  workbook.getWorksheet("Summary").getCell("A1").value = "Edited workbook";\n  return workbook;\n}\n`, "utf8");
  const editedProduct = await buildFromBuilder(editBuilderPath, finalPath);
  const editedRawPath = path.join(outputDir, "edited-raw.xlsx");
  const editedPath = path.join(outputDir, "edited.xlsx");
  await editedProduct.workbook.xlsx.writeFile(editedRawPath);
  await recalculateWorkbook(editedRawPath, editedPath);
  const sourceAfterEdit = await loadXlsx(finalPath);
  const editedWorkbook = await loadXlsx(editedPath);
  if (sourceAfterEdit.getWorksheet("Summary").getCell("A1").value !== "PilotDeck Spreadsheet Self-Test") {
    throw new Error("Existing-workbook edit overwrote the source file");
  }
  if (editedWorkbook.getWorksheet("Summary").getCell("A1").value !== "Edited workbook") {
    throw new Error("Existing-workbook edit did not reach the output file");
  }
  steps.push({ name: "edit-copy", status: "ok" });

  const errorPath = path.join(outputDir, "formula-error.xlsx");
  const errorWorkbook = createWorkbook();
  const errorSheet = errorWorkbook.addWorksheet("Errors");
  errorSheet.getCell("A1").value = { error: "#DIV/0!" };
  await errorWorkbook.xlsx.writeFile(errorPath);
  const errorAudit = await auditXlsx(errorPath);
  if (errorAudit.status !== "error") throw new Error("Formula error scan did not catch #DIV/0!");
  steps.push({ name: "audit-error", status: "ok", detected: errorAudit.hardFailures.length });

  const csvPath = path.join(outputDir, "sample.csv");
  await fs.writeFile(csvPath, 'name,value\n"Alpha, Inc",10\nBeta,20\n', "utf8");
  const csvInspection = await inspectDelimited(csvPath, {});
  if (csvInspection.rowCount !== 3 || csvInspection.preview[1][0] !== "Alpha, Inc") throw new Error("CSV parsing failed");
  const csvWorkbook = await loadDelimited(csvPath, { inferTypes: true });
  const tsvPath = path.join(outputDir, "sample.tsv");
  await exportDelimited(csvWorkbook, tsvPath);
  const tsvInspection = await inspectDelimited(tsvPath, {});
  if (tsvInspection.format !== "tsv" || tsvInspection.preview[1][0] !== "Alpha, Inc") throw new Error("TSV export failed");
  steps.push({ name: "csv-tsv", status: "ok" });

  const riskyPath = path.join(outputDir, "risky-chart-package.xlsx");
  const riskyZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  riskyZip.file("xl/charts/chart1.xml", '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>');
  await fs.writeFile(riskyPath, await riskyZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const riskyInfo = await inspectPackage(riskyPath);
  if (!riskyInfo.unsafeForRoundTrip || riskyInfo.features.charts !== 1) throw new Error("Chart compatibility preflight failed");
  steps.push({ name: "compatibility-preflight", status: "ok", risks: riskyInfo.roundTripRisks });

  const rendered = await renderWorkbook(finalPath, path.join(outputDir, "render"));
  steps.push({ name: "render", status: "ok", pageCount: rendered.pageCount, montage: rendered.montage });

  const report = {
    status: "ok",
    outputDir: path.resolve(outputDir),
    workbook: path.resolve(finalPath),
    render: rendered,
    steps,
  };
  await writeJson(path.join(outputDir, "self-test-report.json"), report);
  await emitReport(report);
}

function printHelp() {
  process.stdout.write(`PilotDeck spreadsheets skill\n\nCommands:\n  scaffold --out builder.mjs\n  build --builder builder.mjs --out result.xlsx [--input source.xlsx]\n  inspect --input book.xlsx [--sheet Sheet1 --range A1:H20 --styles --out report.json]\n  recalculate --input source.xlsx --out recalculated.xlsx\n  audit --input book.xlsx [--out audit.json]\n  render --input book.xlsx --out-dir render [--pdf render.pdf --montage montage.png]\n  self-test [--out directory]\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "scaffold": await commandScaffold(options); break;
    case "build": await commandBuild(options); break;
    case "inspect": await commandInspect(options); break;
    case "recalculate": await commandRecalculate(options); break;
    case "audit": await commandAudit(options); break;
    case "render": await commandRender(options); break;
    case "self-test": await commandSelfTest(options); break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command '${command}'. Run with --help.`);
  }
}

main().catch((error) => {
  const payload = {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
