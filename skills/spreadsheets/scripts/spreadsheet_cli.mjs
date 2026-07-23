#!/usr/bin/env node

import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  injectNativeCharts,
  inspectDrawingPackage,
  inspectNativeCharts,
  pruneEmptyDrawingParts,
} from "./lib/native-charts.mjs";

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
const iconv = require("iconv-lite");

const NATIVE_CHART_SPECS = new WeakMap();

class SpreadsheetStageError extends Error {
  constructor(stage, message, cause) {
    super(`${stage}: ${message}`, { cause });
    this.name = "SpreadsheetStageError";
    this.stage = stage;
  }
}

async function runStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SpreadsheetStageError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new SpreadsheetStageError(stage, message, error);
  }
}

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

function assertSupportedInput(filePath, { legacy = false } = {}) {
  const extension = workbookExtension(filePath);
  const allowed = legacy ? [".xlsx", ".xls", ".csv", ".tsv"] : [".xlsx", ".csv", ".tsv"];
  if (!allowed.includes(extension)) {
    throw new Error(`Unsupported spreadsheet format '${extension || "(none)"}'. Use ${allowed.join(", ")}.`);
  }
  return extension;
}

function assertSupportedOutput(filePath) {
  const extension = workbookExtension(filePath);
  if (![".xlsx", ".csv", ".tsv"].includes(extension)) {
    throw new Error(`Unsupported spreadsheet output '${extension || "(none)"}'. Use .xlsx, .csv, or .tsv.`);
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

function elementsByLocalName(root, localName) {
  const matches = [];
  const elements = root.getElementsByTagName("*");
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements.item(index);
    const elementLocalName = element?.localName ?? element?.nodeName?.split(":").at(-1);
    if (elementLocalName === localName) matches.push(element);
  }
  return matches;
}

function normalizeLibreOfficeDataValidations(xml) {
  const validationPattern = /<(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\b[^>]*(?:\/>|>[\s\S]*?<\/(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\s*>)/gi;
  const formula2Pattern = /<(?:(?:[A-Za-z_][\w.-]*):)?formula2\b[^>]*(?:\/>|>[\s\S]*?<\/(?:(?:[A-Za-z_][\w.-]*):)?formula2\s*>)/gi;
  let normalizedCount = 0;
  const normalizedXml = xml.replace(validationPattern, (validationXml) => {
    const openingEnd = validationXml.indexOf(">");
    if (openingEnd < 0) return validationXml;
    const opening = validationXml.slice(0, openingEnd + 1);
    const type = opening.match(/\stype=(["'])([^"']+)\1/i)?.[2]?.toLowerCase();
    if (!new Set(["list", "custom"]).has(type)) return validationXml;

    const normalizedOpening = opening.replace(/\soperator=(["'])[^"']*\1/gi, "");
    const normalizedBody = validationXml.slice(openingEnd + 1).replace(formula2Pattern, "");
    const normalized = `${normalizedOpening}${normalizedBody}`;
    if (normalized !== validationXml) normalizedCount += 1;
    return normalized;
  });
  return { xml: normalizedXml, normalizedCount };
}

async function normalizeLibreOfficeRoundTripPackage(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  let normalizedValidations = 0;
  let changedParts = 0;
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/worksheets\/sheet\d+\.xml$/i.test(entryName)) continue;
    const xml = await entry.async("string");
    const normalized = normalizeLibreOfficeDataValidations(xml);
    if (normalized.xml === xml) continue;
    zip.file(entryName, normalized.xml);
    normalizedValidations += normalized.normalizedCount;
    changedParts += 1;
  }
  const drawingCleanup = await pruneEmptyDrawingParts(zip, { DOMParser });
  if (changedParts > 0 || drawingCleanup.removed > 0) {
    await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  return {
    changed: changedParts > 0 || drawingCleanup.removed > 0,
    changedParts: changedParts + drawingCleanup.removed,
    normalizedValidations,
    removedEmptyDrawings: drawingCleanup.removed,
    removedDrawingParts: drawingCleanup.parts,
  };
}

async function collectSpreadsheetCompatibilityIssues(zip) {
  const issues = [];
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/worksheets\/sheet\d+\.xml$/i.test(entryName)) continue;
    const xml = await entry.async("string");
    const document = new DOMParser().parseFromString(xml, "application/xml");
    for (const validation of elementsByLocalName(document, "dataValidation")) {
      const type = validation.getAttribute("type")?.toLowerCase() ?? "none";
      if (!new Set(["list", "custom"]).has(type)) continue;
      const operator = validation.getAttribute("operator");
      const formula2 = elementsByLocalName(validation, "formula2")[0]?.textContent ?? null;
      if (operator === null && formula2 === null) continue;
      issues.push({
        type: "invalid_data_validation_semantics",
        part: entryName,
        range: validation.getAttribute("sqref") ?? null,
        validationType: type,
        unexpectedOperator: operator,
        unexpectedFormula2: formula2,
      });
    }
  }
  return issues;
}

async function loadXlsx(filePath) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(path.resolve(filePath));
    return normalizeMissingTableStyles(workbook);
  } catch (error) {
    const normalizedPackage = await normalizePrefixedSpreadsheetPackage(filePath);
    if (!normalizedPackage) throw error;
    const normalizedWorkbook = new ExcelJS.Workbook();
    await normalizedWorkbook.xlsx.load(normalizedPackage);
    return normalizeMissingTableStyles(normalizedWorkbook);
  }
}

function normalizeMissingTableStyles(workbook) {
  for (const worksheet of workbook.worksheets) {
    for (const table of worksheet.model?.tables ?? []) {
      if (table.style !== null && table.style !== undefined) continue;
      table.style = {
        theme: null,
        showFirstColumn: false,
        showLastColumn: false,
        showRowStripes: false,
        showColumnStripes: false,
      };
    }
  }
  return workbook;
}

function normalizeEncoding(value) {
  const encoding = String(value ?? "auto").toLowerCase().replaceAll("_", "-");
  if (["auto", "utf8", "utf-8", "utf8-bom", "utf-8-bom", "gbk", "gb18030"].includes(encoding)) return encoding;
  throw new Error(`Unsupported text encoding '${value}'. Use auto, utf8, utf8-bom, gbk, or gb18030.`);
}

function decodeDelimitedBuffer(buffer, requestedEncoding = "auto") {
  const requested = normalizeEncoding(requestedEncoding);
  const hasUtf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  let encoding = requested;
  if (encoding === "auto") {
    if (hasUtf8Bom) {
      encoding = "utf8-bom";
    } else {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        encoding = "utf8";
      } catch {
        encoding = "gb18030";
      }
    }
  }
  const withoutBom = hasUtf8Bom ? buffer.subarray(3) : buffer;
  if (["utf8", "utf-8", "utf8-bom", "utf-8-bom"].includes(encoding)) {
    return { text: withoutBom.toString("utf8"), encoding: hasUtf8Bom || encoding.includes("bom") ? "utf8-bom" : "utf8" };
  }
  return { text: iconv.decode(buffer, encoding === "gbk" ? "gbk" : "gb18030"), encoding };
}

function encodeDelimitedText(text, requestedEncoding = "utf8-bom") {
  const encoding = normalizeEncoding(requestedEncoding);
  if (encoding === "auto") throw new Error("Output encoding cannot be auto");
  if (encoding === "utf8-bom" || encoding === "utf-8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  if (encoding === "utf8" || encoding === "utf-8") return Buffer.from(text, "utf8");
  return iconv.encode(text, encoding === "gbk" ? "gbk" : "gb18030");
}

function inferScalar(value) {
  if (value === "") return "";
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^[+-]?0\d+$/.test(value)) return value;
  if (/^[+-]?\d{16,}$/.test(value)) return value;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

async function loadDelimited(filePath, { sheetName = "Sheet1", inferTypes = false, encoding = "auto" } = {}) {
  const extension = assertSupportedInput(filePath);
  if (extension === ".xlsx") throw new Error("loadDelimited only accepts .csv or .tsv files");
  const delimiter = extension === ".tsv" ? "\t" : ",";
  const decoded = decodeDelimitedBuffer(await fs.readFile(filePath), encoding);
  const rows = parseDelimitedText(decoded.text, {
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

function cloneCellStyle(style = {}) {
  return structuredClone(style);
}

function applyStyle(worksheet, rangeRef, style) {
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.style = cloneCellStyle({ ...(cell.style ?? {}), ...style });
  });
}

function setNumberFormat(worksheet, rangeRef, numberFormat) {
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.numFmt = String(numberFormat);
  });
}

function addTableFromRange(worksheet, { name, range, style = { theme: "TableStyleMedium2", showRowStripes: true } }) {
  if (!name || !range) throw new Error("addTableFromRange requires name and range");
  const bounds = parseRangeReference(range);
  if (bounds.endRow <= bounds.startRow) throw new Error(`Table range '${range}' must contain a header row and at least one data row`);
  const columns = [];
  const seen = new Set();
  for (let column = bounds.startCol; column <= bounds.endCol; column += 1) {
    const header = displayCellText(worksheet.getCell(bounds.startRow, column)).trim();
    if (!header) throw new Error(`Table '${name}' has an empty header at ${columnLetters(column)}${bounds.startRow}`);
    if (seen.has(header)) throw new Error(`Table '${name}' has duplicate header '${header}'`);
    seen.add(header);
    columns.push({ name: header });
  }
  const rows = [];
  for (let row = bounds.startRow + 1; row <= bounds.endRow; row += 1) {
    const values = [];
    for (let column = bounds.startCol; column <= bounds.endCol; column += 1) values.push(worksheet.getCell(row, column).value);
    rows.push(values);
  }
  return worksheet.addTable({
    name: String(name),
    ref: `${columnLetters(bounds.startCol)}${bounds.startRow}`,
    headerRow: true,
    totalsRow: false,
    style: cloneCellStyle(style),
    columns,
    rows,
  });
}

function addListValidation(worksheet, rangeRef, values, options = {}) {
  const formula = Array.isArray(values)
    ? `"${values.map((value) => String(value).replaceAll('"', '""')).join(",")}"`
    : String(values);
  if (!formula || formula === '""') throw new Error("addListValidation requires at least one allowed value or a range formula");
  if (Array.isArray(values) && formula.length > 255) {
    throw new Error("Inline list validation exceeds Excel's 255-character limit; place the values in cells and pass a range formula instead");
  }
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.dataValidation = {
      type: "list",
      allowBlank: options.allowBlank ?? true,
      showErrorMessage: options.showErrorMessage ?? true,
      errorStyle: options.errorStyle ?? "stop",
      errorTitle: options.errorTitle ?? "输入无效",
      error: options.error ?? "请选择列表中的值",
      formulae: [formula],
    };
  });
}

function validateConditionalFormattingRule(rule, location) {
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    throw new Error(`${location} must be an object`);
  }
  if (Object.hasOwn(rule, "formula") && !Object.hasOwn(rule, "formulae")) {
    throw new Error(`${location}.formula is invalid; use ${location}.formulae as an array`);
  }
  if (["expression", "cellIs"].includes(rule.type) && (!Array.isArray(rule.formulae) || rule.formulae.length === 0)) {
    throw new Error(`${location}.formulae must be a non-empty array for conditional-formatting type '${rule.type}'`);
  }
}

function validateConditionalFormattingEntry(entry, location) {
  if (!entry?.ref) throw new Error(`${location}.ref is required`);
  if (!Array.isArray(entry.rules) || entry.rules.length === 0) {
    throw new Error(`${location}.rules must contain at least one rule`);
  }
  entry.rules.forEach((rule, index) => validateConditionalFormattingRule(rule, `${location}.rules[${index}]`));
}

function addConditionalFormatting(worksheet, { range, rules }) {
  if (!range || !Array.isArray(rules) || rules.length === 0) {
    throw new Error("addConditionalFormatting requires range and at least one rule");
  }
  validateConditionalFormattingEntry({ ref: range, rules }, `worksheet '${worksheet.name}' conditionalFormatting '${range}'`);
  worksheet.addConditionalFormatting({ ref: range, rules: structuredClone(rules) });
}

function styleHeader(worksheet, rangeRef, options = {}) {
  const fill = options.fill ?? "FF0F766E";
  const color = options.color ?? "FFFFFFFF";
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.style = cloneCellStyle({
      ...(cell.style ?? {}),
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: fill } },
      font: { ...(cell.font ?? {}), bold: true, color: { argb: color } },
      alignment: { ...(cell.alignment ?? {}), vertical: "middle" },
    });
  });
}

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function safeDateIso(value) {
  return isValidDate(value) ? value.toISOString() : null;
}

function displayCellText(cell) {
  let renderedText;
  try {
    renderedText = cell.text;
  } catch {
    renderedText = undefined;
  }
  if (renderedText !== undefined && renderedText !== null && renderedText !== "") return String(renderedText);
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return safeDateIso(value)?.slice(0, 10) ?? "<Invalid Date>";
  if (typeof value === "object") {
    if ("result" in value) {
      if (value.result instanceof Date) return safeDateIso(value.result)?.slice(0, 10) ?? "<Invalid Date>";
      return value.result === null || value.result === undefined ? "" : String(value.result);
    }
    if ("text" in value) return String(value.text);
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value);
}

function visualTextWidth(value) {
  let width = 0;
  for (const character of String(value ?? "")) {
    const code = character.codePointAt(0);
    if (/\p{Mark}/u.test(character)) continue;
    if (
      (code >= 0x1100 && code <= 0x11ff)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7af)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe6f)
      || (code >= 0xff01 && code <= 0xff60)
      || (code >= 0x20000 && code <= 0x3ffff)
    ) width += 2;
    else width += 1;
  }
  return width;
}

function autoFitColumns(worksheet, { min = 8, max = 40, padding = 2, sampleRows = 5000 } = {}) {
  const lastColumn = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  const lastRow = Math.min(Math.max(worksheet.rowCount, worksheet.actualRowCount, 1), sampleRows);
  for (let col = 1; col <= lastColumn; col += 1) {
    let width = min;
    for (let row = 1; row <= lastRow; row += 1) {
      const text = displayCellText(worksheet.getCell(row, col));
      const longestLine = text.split(/\r?\n/).reduce((longest, line) => Math.max(longest, visualTextWidth(line)), 0);
      width = Math.max(width, Math.min(max, longestLine + padding));
    }
    worksheet.getColumn(col).width = Math.max(min, Math.min(max, width));
  }
}

function fontProfile(platform = "cross-platform") {
  const normalized = String(platform).toLowerCase();
  if (["windows", "win"].includes(normalized)) return { platform: "windows", body: "Microsoft YaHei", title: "Microsoft YaHei" };
  if (["mac", "macos", "darwin"].includes(normalized)) return { platform: "macos", body: "PingFang SC", title: "PingFang SC" };
  if (["linux", "libreoffice", "server"].includes(normalized)) return { platform: "linux", body: "Noto Sans CJK SC", title: "Noto Sans CJK SC" };
  if (["cross-platform", "crossplatform", "auto"].includes(normalized)) return { platform: "cross-platform", body: null, title: null };
  throw new Error(`Unsupported font platform '${platform}'`);
}

function applyChineseTypography(worksheet, { platform = "cross-platform", bodySize = 10.5, titleSize = 16, titleRanges = [] } = {}) {
  const profile = fontProfile(platform);
  const titleCells = new Set();
  for (const range of titleRanges) forEachCellInRange(worksheet, range, (cell) => titleCells.add(cell.address));
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      const isTitle = titleCells.has(cell.address);
      const current = cell.font ?? {};
      const next = { ...current, size: current.size ?? (isTitle ? titleSize : bodySize) };
      const selectedFont = isTitle ? profile.title : profile.body;
      if (selectedFont && !current.name) next.name = selectedFont;
      if (isTitle) next.bold = true;
      cell.font = next;
    });
  });
  return profile;
}

function autoFitRows(worksheet, { min = 15, max = 90, lineHeight = 15, sampleRows = 5000 } = {}) {
  const lastRow = Math.min(Math.max(worksheet.rowCount, worksheet.actualRowCount, 1), sampleRows);
  const lastColumn = Math.max(worksheet.columnCount, worksheet.actualColumnCount, 1);
  for (let row = 1; row <= lastRow; row += 1) {
    let lines = 1;
    for (let column = 1; column <= lastColumn; column += 1) {
      const cell = worksheet.getCell(row, column);
      if (!cell.alignment?.wrapText) continue;
      const width = Math.max(1, worksheet.getColumn(column).width ?? 8);
      const textLines = displayCellText(cell).split(/\r?\n/).reduce((count, line) => count + Math.max(1, Math.ceil(visualTextWidth(line) / width)), 0);
      lines = Math.max(lines, textLines);
    }
    if (!worksheet.getRow(row).height) worksheet.getRow(row).height = Math.min(max, Math.max(min, lines * lineHeight));
  }
}

function serializableValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return safeDateIso(value) ?? "<Invalid Date>";
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
  const invalidDates = [];
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
        const candidateDates = [
          { source: "value", value: cell.value },
          { source: "formula_result", value: cell.value && typeof cell.value === "object" ? cell.value.result : null },
        ];
        for (const candidate of candidateDates) {
          if (candidate.value instanceof Date && !isValidDate(candidate.value) && invalidDates.length < maxErrors) {
            invalidDates.push({ sheet: worksheet.name, address: cell.address, source: candidate.source, numberFormat: cell.numFmt ?? null });
          }
        }
      });
    });
  }

  return { formulaCount, formulas, errors, missingCachedResults, formulaReferencesWithErrors, invalidDates };
}

async function inspectPackage(filePath) {
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  const entries = Object.keys(zip.files).filter((entry) => !zip.files[entry].dir);
  const count = (predicate) => entries.filter(predicate).length;
  const drawingInspection = await inspectDrawingPackage(zip, { DOMParser });
  const drawings = drawingInspection.parts;
  const drawingObjectCount = drawings.reduce((total, drawing) => total + drawing.objects, 0);

  const features = {
    macros: count((entry) => /(?:^|\/)vbaProject\.bin$/i.test(entry)),
    charts: count((entry) => /^xl\/charts\/chart\d+\.xml$/i.test(entry)),
    pivotTables: count((entry) => /^xl\/(?:pivotTables|pivotCache)\//i.test(entry)),
    slicers: count((entry) => /^xl\/(?:slicers|slicerCaches)\//i.test(entry)),
    externalLinks: count((entry) => /^xl\/externalLinks\//i.test(entry)),
    connections: count((entry) => /^xl\/connections\.xml$/i.test(entry)),
    queryTables: count((entry) => /^xl\/queryTables\//i.test(entry)),
    drawings: drawingObjectCount,
    drawingParts: drawings.length,
    media: count((entry) => /^xl\/media\//i.test(entry)),
    embeddings: count((entry) => /^xl\/embeddings\//i.test(entry)),
    activeX: count((entry) => /^xl\/activeX\//i.test(entry)),
    threadedComments: count((entry) => /^xl\/threadedComments\//i.test(entry)),
    comments: count((entry) => /^xl\/comments\d+\.xml$/i.test(entry)),
    customXml: count((entry) => /^customXml\//i.test(entry)),
    signatures: count((entry) => /^_xmlsignatures\//i.test(entry)),
    tables: count((entry) => /^xl\/tables\/table\d+\.xml$/i.test(entry)),
  };

  const charts = await inspectNativeCharts(zip);
  const compatibilityIssues = [
    ...await collectSpreadsheetCompatibilityIssues(zip),
    ...drawingInspection.issues,
  ];

  const risks = Object.entries(features)
    .filter(([name, amount]) => amount > 0 && HARD_RISK_FEATURES.has(name))
    .map(([name, amount]) => ({ feature: name, count: amount }));

  return {
    entryCount: entries.length,
    features,
    charts,
    drawings,
    compatibility: {
      status: compatibilityIssues.length > 0 ? "error" : "ok",
      issues: compatibilityIssues,
    },
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
  const decoded = decodeDelimitedBuffer(await fs.readFile(filePath), options.encoding ?? "auto");
  const rows = parseDelimitedText(decoded.text, {
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
    encoding: decoded.encoding,
    delimiter: extension === ".tsv" ? "tab" : "comma",
    rowCount: rows.length,
    maxColumnCount: widths.length > 0 ? Math.max(...widths) : 0,
    inconsistentRowWidths: [...new Set(widths)].length > 1,
    preview: rows.slice(0, maxRows).map((row) => row.slice(0, maxCols)),
    truncated: rows.length > maxRows || widths.some((width) => width > maxCols),
  };
}

const REQUIREMENT_KEYS = new Set([
  "sourceBacked",
  "sourceFiles",
  "sourceBackedSheets",
  "requiredSheets",
  "exactSheetCount",
  "minFormulaCount",
  "requiredFormulaRanges",
  "requiredNonEmptyRanges",
  "expectedCells",
  "expectedRanges",
  "requiredCellTypes",
  "requiredNativeCharts",
  "requiredTables",
  "requiredConditionalFormatting",
  "requiredDataValidations",
  "maxTotalPages",
  "maxPagesPerSheet",
  "warningDispositions",
]);

const REQUIREMENT_ARRAY_KEYS = [
  "sourceFiles",
  "sourceBackedSheets",
  "requiredSheets",
  "requiredFormulaRanges",
  "requiredNonEmptyRanges",
  "expectedCells",
  "expectedRanges",
  "requiredCellTypes",
  "requiredNativeCharts",
  "requiredTables",
  "requiredConditionalFormatting",
  "requiredDataValidations",
  "maxPagesPerSheet",
  "warningDispositions",
];

function validateRequirements(requirements, source = "requirements") {
  if (requirements === null || requirements === undefined) return null;
  if (typeof requirements !== "object" || Array.isArray(requirements)) {
    throw new Error(`${source} must be a JSON object`);
  }
  if (Object.hasOwn(requirements, "coverage") || Object.hasOwn(requirements, "status")) {
    throw new Error(`${source} must declare checks, not audit results; remove coverage/status`);
  }
  const unknown = Object.keys(requirements).filter((key) => !REQUIREMENT_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${source} contains unsupported key(s): ${unknown.join(", ")}`);
  for (const key of REQUIREMENT_ARRAY_KEYS) {
    if (requirements[key] !== undefined && !Array.isArray(requirements[key])) {
      throw new Error(`${source}.${key} must be an array`);
    }
  }
  if (requirements.requiredSheets?.some((sheet) => typeof sheet !== "string" || sheet.trim().length === 0)) {
    throw new Error(`${source}.requiredSheets must contain non-empty worksheet names`);
  }
  if (requirements.sourceBacked !== undefined && typeof requirements.sourceBacked !== "boolean") {
    throw new Error(`${source}.sourceBacked must be true or false`);
  }
  if (requirements.sourceBackedSheets?.some((sheet) => typeof sheet !== "string" || sheet.trim().length === 0)) {
    throw new Error(`${source}.sourceBackedSheets must contain non-empty worksheet names`);
  }
  for (const [key, value] of [["exactSheetCount", requirements.exactSheetCount], ["minFormulaCount", requirements.minFormulaCount], ["maxTotalPages", requirements.maxTotalPages]]) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${source}.${key} must be a non-negative integer`);
    }
  }
  for (const [index, disposition] of (requirements.warningDispositions ?? []).entries()) {
    if (!disposition || typeof disposition.type !== "string" || disposition.type.trim().length === 0 || typeof disposition.rationale !== "string" || disposition.rationale.trim().length === 0) {
      throw new Error(`${source}.warningDispositions[${index}] requires non-empty type and rationale strings`);
    }
  }
  for (const [index, sourceFile] of (requirements.sourceFiles ?? []).entries()) {
    if (!sourceFile || typeof sourceFile.path !== "string" || !path.isAbsolute(sourceFile.path) || !/^[a-f0-9]{64}$/i.test(String(sourceFile.sha256 ?? ""))) {
      throw new Error(`${source}.sourceFiles[${index}] requires an absolute path and SHA-256 hash`);
    }
  }
  for (const [index, item] of (requirements.expectedRanges ?? []).entries()) {
    if (!item || typeof item.sheet !== "string" || typeof item.range !== "string" || !Array.isArray(item.values) || item.values.length === 0 || item.values.some((row) => !Array.isArray(row))) {
      throw new Error(`${source}.expectedRanges[${index}] requires sheet, range, and a non-empty values matrix`);
    }
    const bounds = parseRangeReference(item.range);
    const expectedRows = bounds.endRow - bounds.startRow + 1;
    const expectedColumns = bounds.endCol - bounds.startCol + 1;
    if (item.values.length !== expectedRows || item.values.some((row) => row.length !== expectedColumns)) {
      throw new Error(`${source}.expectedRanges[${index}].values must match ${item.range} (${expectedRows}x${expectedColumns})`);
    }
  }
  for (const [index, item] of (requirements.requiredNativeCharts ?? []).entries()) {
    if (item.minPoints !== undefined && (!Number.isInteger(item.minPoints) || item.minPoints < 1)) {
      throw new Error(`${source}.requiredNativeCharts[${index}].minPoints must be a positive integer`);
    }
    if (item.sourceRanges !== undefined && (!Array.isArray(item.sourceRanges) || item.sourceRanges.some((range) => typeof range !== "string" || range.trim().length === 0))) {
      throw new Error(`${source}.requiredNativeCharts[${index}].sourceRanges must contain non-empty ranges`);
    }
  }
  if (requirements.sourceBacked) {
    if ((requirements.sourceFiles?.length ?? 0) === 0) throw new Error(`${source}.sourceBacked requires sourceFiles`);
    if ((requirements.sourceBackedSheets?.length ?? 0) === 0) throw new Error(`${source}.sourceBacked requires sourceBackedSheets`);
  }
  return requirements;
}

async function resolveRequirements(requirementsPath, inlineRequirements = null) {
  let fileRequirements = null;
  if (requirementsPath) fileRequirements = validateRequirements(JSON.parse(await fs.readFile(requirementsPath, "utf8")), path.resolve(requirementsPath));
  const validatedInline = validateRequirements(inlineRequirements, "builder requirements");
  if (!fileRequirements) return validatedInline;
  if (!validatedInline) return fileRequirements;
  return validateRequirements({ ...validatedInline, ...fileRequirements }, "merged requirements");
}

function normalizeChartFormula(value) {
  return String(value ?? "").replaceAll("$", "").replaceAll("''", "'").toLowerCase();
}

function valuesEqual(actual, expected, tolerance = 0) {
  if (typeof expected === "number") return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) <= tolerance;
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expected) && actual instanceof Date && isValidDate(actual)) {
    return actual.toISOString().startsWith(expected);
  }
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expected) && typeof actual === "string") {
    return actual.startsWith(expected);
  }
  return String(actual ?? "") === String(expected ?? "");
}

function effectiveCellValue(cell) {
  const value = cell?.value;
  if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) return value.result;
  return value;
}

function cellValueType(cell) {
  const value = effectiveCellValue(cell);
  if (value === null || value === undefined || value === "") return "blank";
  if (value instanceof Date) return isValidDate(value) ? "date" : "invalid_date";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "invalid_number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") {
    if (typeof value.error === "string") return "error";
    if (typeof value.text === "string" || Array.isArray(value.richText)) return "string";
  }
  return typeof value;
}

function evaluateRequirements(workbook, packageInfo, requirements) {
  if (!requirements) return { status: "not_requested", total: 0, passed: 0, checks: [], failures: [] };
  const checks = [];
  const record = (type, passed, details = {}) => checks.push({ type, passed, ...details });

  for (const sheetName of requirements.requiredSheets ?? []) {
    record("required_sheet", Boolean(workbook.getWorksheet(sheetName)), { sheet: sheetName });
  }
  if (Number.isFinite(requirements.exactSheetCount)) {
    record("exact_sheet_count", workbook.worksheets.length === requirements.exactSheetCount, { expected: requirements.exactSheetCount, actual: workbook.worksheets.length });
  }
  if (Number.isFinite(requirements.minFormulaCount)) {
    const actual = collectWorkbookFacts(workbook).formulaCount;
    record("min_formula_count", actual >= requirements.minFormulaCount, { expected: requirements.minFormulaCount, actual });
  }
  for (const item of requirements.requiredFormulaRanges ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    let actual = 0;
    let expected = 0;
    if (worksheet) {
      forEachCellInRange(worksheet, item.range, (cell) => {
        expected += 1;
        if (formulaDescriptor(cell)) actual += 1;
      });
    }
    const minimum = item.minCount ?? expected;
    record("required_formula_range", Boolean(worksheet) && actual >= minimum, { sheet: item.sheet, range: item.range, expected: minimum, actual });
  }
  for (const item of requirements.requiredNonEmptyRanges ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    let actual = 0;
    let expected = 0;
    if (worksheet) {
      forEachCellInRange(worksheet, item.range, (cell) => {
        expected += 1;
        if (displayCellText(cell).trim() !== "") actual += 1;
      });
    }
    const minimum = item.minCount ?? expected;
    record("required_non_empty_range", Boolean(worksheet) && actual >= minimum, { sheet: item.sheet, range: item.range, expected: minimum, actual });
  }
  for (const item of requirements.expectedCells ?? []) {
    const cell = workbook.getWorksheet(item.sheet)?.getCell(item.cell);
    const actual = cell ? cellDisplayValueForAudit(cell) : null;
    record("expected_cell", Boolean(cell) && valuesEqual(actual, item.value, item.tolerance ?? 0), { sheet: item.sheet, cell: item.cell, expected: item.value, actual });
  }
  for (const item of requirements.expectedRanges ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const bounds = parseRangeReference(item.range);
    const mismatches = [];
    let matched = 0;
    let total = 0;
    for (let rowOffset = 0; rowOffset < item.values.length; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < item.values[rowOffset].length; columnOffset += 1) {
        total += 1;
        const address = `${columnLetters(bounds.startCol + columnOffset)}${bounds.startRow + rowOffset}`;
        const actual = worksheet ? cellDisplayValueForAudit(worksheet.getCell(address)) : null;
        const expected = item.values[rowOffset][columnOffset];
        if (worksheet && valuesEqual(actual, expected, item.tolerance ?? 0)) matched += 1;
        else if (mismatches.length < 100) mismatches.push({ address, expected, actual });
      }
    }
    record("expected_range", Boolean(worksheet) && matched === total, { sheet: item.sheet, range: item.range, expected: total, actual: matched, mismatches });
  }
  for (const item of requirements.requiredCellTypes ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const expectedType = String(item.type ?? "").toLowerCase();
    const supportedTypes = new Set(["number", "date", "string", "boolean"]);
    if (!supportedTypes.has(expectedType)) throw new Error(`Unsupported requiredCellTypes type '${item.type}'`);
    const mismatches = [];
    const counts = {};
    let total = 0;
    let nonBlank = 0;
    let matched = 0;
    if (worksheet) {
      forEachCellInRange(worksheet, item.range, (cell) => {
        total += 1;
        const actualType = cellValueType(cell);
        counts[actualType] = (counts[actualType] ?? 0) + 1;
        if (actualType === "blank" && item.allowBlank) return;
        if (actualType !== "blank") nonBlank += 1;
        if (actualType === expectedType) matched += 1;
        else if (mismatches.length < 100) mismatches.push({ address: cell.address, actualType, value: serializableValue(effectiveCellValue(cell)), numberFormat: cell.numFmt ?? null });
      });
    }
    const minimum = item.minCount ?? (item.allowBlank ? nonBlank : total);
    record("required_cell_type", Boolean(worksheet) && matched >= minimum && mismatches.length === 0, {
      sheet: item.sheet,
      range: item.range,
      expectedType,
      minimum,
      matched,
      counts,
      mismatches,
    });
  }
  for (const item of requirements.requiredNativeCharts ?? []) {
    const candidates = packageInfo.charts.filter((chart) => {
      if (item.sheet && chart.sheet !== item.sheet) return false;
      if (item.type && !chart.types.includes(item.type)) return false;
      if (Array.isArray(item.sourceRanges)) {
        const actual = chart.sourceFormulas.map(normalizeChartFormula);
        if (!item.sourceRanges.every((range) => actual.some((formula) => formula.includes(normalizeChartFormula(range))))) return false;
      }
      if (Number.isInteger(item.minPoints)) {
        if ((chart.series ?? []).length === 0 || chart.series.some((series) => {
          const stats = chartPointStats(workbook, series);
          return !stats
            || stats.categories !== stats.values
            || stats.blankCategories > 0
            || stats.blankValues > 0
            || stats.numericValues < item.minPoints;
        })) return false;
      }
      return true;
    });
    const minimum = item.minCount ?? 1;
    record("required_native_chart", candidates.length >= minimum, { sheet: item.sheet ?? null, chartType: item.type ?? null, expected: minimum, actual: candidates.length, sourceRanges: item.sourceRanges ?? [], minPoints: item.minPoints ?? null });
  }
  for (const item of requirements.requiredTables ?? []) {
    const worksheets = item.sheet ? [workbook.getWorksheet(item.sheet)].filter(Boolean) : workbook.worksheets;
    const actual = worksheets.reduce((total, worksheet) => total + tableSummaries(worksheet).length, 0);
    const minimum = item.minCount ?? 1;
    record("required_table", actual >= minimum, { sheet: item.sheet ?? null, expected: minimum, actual });
  }
  for (const item of requirements.requiredConditionalFormatting ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const ranges = worksheet?.conditionalFormattings?.map((entry) => entry.ref) ?? [];
    const passed = Boolean(worksheet) && (item.range ? ranges.includes(item.range) : ranges.length > 0);
    record("required_conditional_formatting", passed, { sheet: item.sheet, range: item.range ?? null, actualRanges: ranges });
  }
  for (const item of requirements.requiredDataValidations ?? []) {
    const worksheet = workbook.getWorksheet(item.sheet);
    const model = worksheet?.dataValidations?.model ?? {};
    const addresses = Object.keys(model);
    const passed = Boolean(worksheet) && (item.cell ? addresses.includes(item.cell) : addresses.length > 0);
    record("required_data_validation", passed, { sheet: item.sheet, cell: item.cell ?? null, actualCells: addresses.slice(0, 100) });
  }

  const semanticAssertionCount = [
    ...(requirements.expectedCells ?? []),
    ...(requirements.expectedRanges ?? []),
    ...(requirements.requiredNonEmptyRanges ?? []),
    ...(requirements.requiredCellTypes ?? []),
    ...(requirements.requiredNativeCharts ?? []),
    ...(requirements.requiredTables ?? []),
    ...(requirements.requiredConditionalFormatting ?? []),
    ...(requirements.requiredDataValidations ?? []),
  ].length;
  record("semantic_requirement_floor", semanticAssertionCount > 0, { actual: semanticAssertionCount, minimum: 1 });

  const formulaCount = collectWorkbookFacts(workbook).formulaCount;
  if (formulaCount > 0) {
    record("formula_requirement_floor", (requirements.requiredFormulaRanges?.length ?? 0) > 0, { formulaCount, requiredFormulaRanges: requirements.requiredFormulaRanges?.length ?? 0 });
  }
  if (packageInfo.charts.length > 0) {
    const chartRequirements = requirements.requiredNativeCharts ?? [];
    const complete = chartRequirements.length > 0 && chartRequirements.every((item) => (
      Array.isArray(item.sourceRanges) && item.sourceRanges.length >= 2 && Number.isInteger(item.minPoints) && item.minPoints >= 1
    ));
    record("native_chart_requirement_floor", complete, { charts: packageInfo.charts.length, declared: chartRequirements.length });
  }
  for (const sheetName of requirements.sourceBackedSheets ?? []) {
    const assertions = [
      ...(requirements.expectedCells ?? []).filter((item) => item.sheet === sheetName),
      ...(requirements.expectedRanges ?? []).filter((item) => item.sheet === sheetName),
    ];
    record("source_backed_sheet_assertions", assertions.length > 0, { sheet: sheetName, assertions: assertions.length });
  }

  const failures = checks.filter((check) => !check.passed);
  return { status: failures.length === 0 ? "passed" : "failed", total: checks.length, passed: checks.length - failures.length, checks, failures };
}

async function evaluateSourceFiles(requirements) {
  if (!requirements?.sourceBacked) return [];
  const checks = [];
  for (const sourceFile of requirements.sourceFiles ?? []) {
    const exists = await pathExists(sourceFile.path);
    const actual = exists ? await fileSha256(sourceFile.path) : null;
    checks.push({
      type: "source_file_integrity",
      passed: exists && actual === sourceFile.sha256.toLowerCase(),
      path: sourceFile.path,
      expectedSha256: sourceFile.sha256.toLowerCase(),
      actualSha256: actual,
    });
  }
  return checks;
}

function cellDisplayValueForAudit(cell) {
  const formula = formulaDescriptor(cell);
  if (formula) return formula.result;
  if (cell.value instanceof Date) return safeDateIso(cell.value) ?? "<Invalid Date>";
  if (cell.value && typeof cell.value === "object") {
    if (typeof cell.value.text === "string") return cell.value.text;
    if (Array.isArray(cell.value.richText)) return cell.value.richText.map((run) => run.text ?? "").join("");
    if (typeof cell.value.error === "string") return cell.value.error;
  }
  return cell.value;
}

function evaluateWarningDispositions(warnings, requirements) {
  if (warnings.length === 0) return { status: "not_needed", total: 0, disposed: 0, dispositions: [], unresolved: [] };
  const declared = Array.isArray(requirements?.warningDispositions) ? requirements.warningDispositions : [];
  const dispositions = [];
  const unresolved = [];
  for (const warning of warnings) {
    const disposition = declared.find((item) => item?.type === warning.type && typeof item.rationale === "string" && item.rationale.trim().length > 0);
    if (disposition) dispositions.push({ warning, rationale: disposition.rationale.trim() });
    else unresolved.push(warning);
  }
  return {
    status: unresolved.length === 0 ? "passed" : "failed",
    total: warnings.length,
    disposed: dispositions.length,
    dispositions,
    unresolved,
  };
}

function collectCjkFontWarnings(workbook) {
  const warnings = [];
  const latinOnlyNames = new Set(["arial", "calibri", "aptos", "times new roman", "linux libertine g", "courier new"]);
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = displayCellText(cell);
        if (!/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(text)) return;
        const name = cell.font?.name;
        if (name && latinOnlyNames.has(name.toLowerCase()) && warnings.length < 100) {
          warnings.push({ sheet: worksheet.name, address: cell.address, font: name });
        }
      });
    });
  }
  return warnings;
}

function chartRangeDetails(workbook, formula) {
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(String(formula ?? "").replaceAll("$", ""));
  if (!match) return null;
  const sheetName = match[1]?.replaceAll("''", "'") ?? match[2];
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) return null;
  try {
    const range = parseRangeReference(match[3]);
    const values = [];
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startCol; column <= range.endCol; column += 1) {
        values.push(effectiveCellValue(worksheet.getCell(row, column)));
      }
    }
    return { count: values.length, values };
  } catch {
    return null;
  }
}

function chartPointStats(workbook, series) {
  const categories = chartRangeDetails(workbook, series.categories);
  const values = chartRangeDetails(workbook, series.values);
  if (!categories || !values) return null;
  const blankCategories = categories.values.filter((value) => value === null || value === undefined || String(value).trim() === "").length;
  const blankValues = values.values.filter((value) => value === null || value === undefined || String(value).trim() === "").length;
  const numericValues = values.values.filter((value) => value !== null && value !== undefined && String(value).trim() !== "" && Number.isFinite(Number(value))).length;
  return { categories: categories.count, values: values.count, blankCategories, blankValues, numericValues };
}

function collectChartFailures(workbook, packageInfo) {
  const failures = [];
  for (const chart of packageInfo.charts) {
    if (!chart.sheet) failures.push({ type: "unmapped_native_chart", chart: chart.part });
    for (const series of chart.series ?? []) {
      if (!series.categories || !series.values) continue;
      const stats = chartPointStats(workbook, series);
      if (!stats) {
        failures.push({ type: "invalid_chart_source_range", chart: chart.part, series: series.index, categories: series.categories, values: series.values });
      } else if (stats.categories !== stats.values) {
        failures.push({ type: "chart_series_length_mismatch", chart: chart.part, series: series.index, categories: stats.categories, values: stats.values });
      } else if (stats.blankCategories > 0) {
        failures.push({ type: "chart_blank_categories", chart: chart.part, series: series.index, blank: stats.blankCategories, total: stats.categories });
      } else if (stats.blankValues > 0 || stats.numericValues !== stats.values) {
        failures.push({ type: "chart_invalid_values", chart: chart.part, series: series.index, blank: stats.blankValues, numeric: stats.numericValues, total: stats.values });
      } else if (chart.types.includes("line") && stats.values < 2) {
        failures.push({ type: "chart_insufficient_points", chart: chart.part, series: series.index, minimum: 2, actual: stats.values });
      }
    }
  }
  return failures;
}

async function auditXlsx(filePath, requirements = null) {
  const packageInfo = await inspectPackage(filePath);
  const workbook = await loadXlsx(filePath);
  const facts = collectWorkbookFacts(workbook);
  const coverage = evaluateRequirements(workbook, packageInfo, requirements);
  const sourceFileChecks = await evaluateSourceFiles(requirements);
  if (sourceFileChecks.length > 0) {
    coverage.checks.push(...sourceFileChecks);
    coverage.failures.push(...sourceFileChecks.filter((check) => !check.passed));
    coverage.total = coverage.checks.length;
    coverage.passed = coverage.checks.filter((check) => check.passed).length;
    coverage.status = coverage.failures.length === 0 ? "passed" : "failed";
  }
  const cjkFontWarnings = collectCjkFontWarnings(workbook);
  const chartFailures = collectChartFailures(workbook, packageInfo);
  const blankSheets = workbook.worksheets
    .filter((worksheet) => worksheet.actualRowCount === 0)
    .map((worksheet) => worksheet.name);
  const oversizedSheets = workbook.worksheets
    .filter((worksheet) => worksheet.rowCount > 200000 || worksheet.columnCount > 200)
    .map((worksheet) => ({ name: worksheet.name, rows: worksheet.rowCount, columns: worksheet.columnCount }));
  const warnings = [];
  const advisories = [];
  if (blankSheets.length > 0) warnings.push({ type: "blank_sheets", sheets: blankSheets });
  if (oversizedSheets.length > 0) warnings.push({ type: "large_used_ranges", sheets: oversizedSheets });
  if (facts.missingCachedResults.length > 0) {
    warnings.push({ type: "missing_cached_formula_results", cells: facts.missingCachedResults.slice(0, 100) });
  }
  if (packageInfo.unsafeForRoundTrip) {
    advisories.push({ type: "future_round_trip_risk", features: packageInfo.roundTripRisks });
  }
  if (cjkFontWarnings.length > 0) warnings.push({ type: "cjk_font_fallback", cells: cjkFontWarnings });
  const warningDispositions = evaluateWarningDispositions(warnings, requirements);
  const hardFailures = [
    ...facts.errors.map((error) => ({ type: "formula_error", ...error })),
    ...facts.missingCachedResults.map((error) => ({ type: "missing_cached_formula_result", ...error })),
    ...facts.formulaReferencesWithErrors.map((error) => ({ type: "invalid_formula_reference", ...error })),
    ...facts.invalidDates.map((error) => ({ type: "invalid_date_value", ...error })),
    ...chartFailures,
    ...packageInfo.compatibility.issues,
    ...coverage.failures.map((failure) => ({ type: "requirement_not_met", requirement: failure })),
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
    invalidDates: facts.invalidDates,
    package: packageInfo,
    coverage,
    hardFailures,
    warnings,
    warningDispositions,
    advisories,
  };
}

function summarizeAuditFailures(audit, limit = 8) {
  return audit.hardFailures.slice(0, limit).map((failure) => {
    if (failure.type === "requirement_not_met") {
      const requirement = failure.requirement ?? {};
      const location = [requirement.sheet, requirement.range ?? requirement.cell].filter(Boolean).join("!");
      const mismatch = requirement.mismatches?.[0];
      const comparison = mismatch
        ? `${mismatch.address}: expected ${JSON.stringify(mismatch.expected)}, actual ${JSON.stringify(mismatch.actual)}`
        : `expected ${JSON.stringify(requirement.expected ?? requirement.minimum ?? "pass")}, actual ${JSON.stringify(requirement.actual ?? requirement.matched ?? "failed")}`;
      return `${requirement.type}${location ? ` (${location})` : ""}: ${comparison}`;
    }
    if (failure.type.startsWith("chart_")) {
      return `${failure.type} (${failure.chart ?? "chart"}, series ${failure.series ?? 0}): ${JSON.stringify(failure)}`;
    }
    return `${failure.type}: ${JSON.stringify(failure)}`;
  }).join("; ");
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
  const fontDirectories = [
    path.join(skillRoot, "assets", "fonts"),
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
    path.join(os.homedir(), "Library", "Fonts"),
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    path.join(os.homedir(), ".fonts"),
    process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : "C:/Windows/Fonts",
    "/c/Windows/Fonts",
  ];
  const availableFontDirectories = [];
  for (const directory of fontDirectories) if (await pathExists(directory)) availableFontDirectories.push(directory);
  const fontCache = path.join(profileDir, "font-cache");
  await fs.mkdir(fontCache, { recursive: true });
  const fontconfigPath = path.join(profileDir, "fonts.conf");
  const xmlEscape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  await fs.writeFile(fontconfigPath, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${availableFontDirectories.map((directory) => `<dir>${xmlEscape(directory)}</dir>`).join("")}<cachedir>${xmlEscape(fontCache)}</cachedir></fontconfig>`, "utf8");
  const profileArg = `-env:UserInstallation=${pathToFileURL(profileDir).href}`;
  const result = await execFileAsync(soffice, [
    profileArg,
    "--headless",
    "--nologo",
    "--nodefault",
    "--nofirststartwizard",
    "--norestore",
    ...args,
  ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, FONTCONFIG_FILE: fontconfigPath } });
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
    const compatibilityNormalization = await normalizeLibreOfficeRoundTripPackage(convertedPath);
    await ensureParent(outputPath);
    await fs.copyFile(convertedPath, outputPath);
    return { output: path.resolve(outputPath), engine: "LibreOffice", compatibilityNormalization };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function convertLegacyXls(inputPath, outputPath) {
  if (workbookExtension(inputPath) !== ".xls" || workbookExtension(outputPath) !== ".xlsx") {
    throw new Error("Legacy conversion requires .xls input and .xlsx output");
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error("Refusing to overwrite the legacy source workbook");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-xls-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const convertedDir = path.join(tempRoot, "converted");
    const profileDir = path.join(tempRoot, "profile");
    await Promise.all([fs.mkdir(sourceDir, { recursive: true }), fs.mkdir(convertedDir, { recursive: true }), fs.mkdir(profileDir, { recursive: true })]);
    const sourcePath = path.join(sourceDir, "workbook.xls");
    await fs.copyFile(inputPath, sourcePath);
    const conversion = await runLibreOffice(["--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", convertedDir, sourcePath], profileDir);
    const convertedPath = path.join(convertedDir, "workbook.xlsx");
    if (!(await pathExists(convertedPath))) throw new Error(`LibreOffice did not convert the legacy XLS file. ${conversion.stderr || conversion.stdout}`.trim());
    const compatibilityNormalization = await normalizeLibreOfficeRoundTripPackage(convertedPath);
    const workbook = await loadXlsx(convertedPath);
    if (workbook.worksheets.length === 0) throw new Error("Converted XLSX has no worksheets");
    if (workbook.worksheets.every((worksheet) => worksheet.actualRowCount === 0)) throw new Error("Converted XLSX contains no populated worksheets");
    await ensureParent(outputPath);
    await fs.copyFile(convertedPath, outputPath);
    const audit = await auditXlsx(outputPath);
    if (audit.status === "error") throw new Error("Converted XLSX failed structural or formula audit");
    return { status: audit.status, input: path.resolve(inputPath), output: path.resolve(outputPath), engine: "LibreOffice", compatibilityNormalization, audit };
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

async function exportDelimited(workbook, outputPath, sheetName, encoding = "utf8-bom") {
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
  await fs.writeFile(outputPath, encodeDelimitedText(`${lines.join("\n")}\n`, encoding));
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
      addConditionalFormatting,
      addListValidation,
      addNativeChart(workbook, spec) {
        const current = NATIVE_CHART_SPECS.get(workbook) ?? [];
        current.push(structuredClone(spec));
        NATIVE_CHART_SPECS.set(workbook, current);
      },
      addTableFromRange,
      applyStyle,
      applyChineseTypography,
      autoFitColumns,
      autoFitRows,
      fontProfile,
      forEachCellInRange,
      setNumberFormat,
      styleHeader,
      parseRangeReference,
      columnLetters,
      columnNumber,
    },
  };
}

function validateNativeChartSpec(workbook, spec, location) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error(`${location} must be an object`);
  if (!spec.sheet || !workbook.getWorksheet(spec.sheet)) throw new Error(`${location}.sheet references missing worksheet '${spec.sheet ?? ""}'`);
  if (!["line", "column", "bar"].includes(spec.type)) throw new Error(`${location}.type must be line, column, or bar`);
  if (typeof spec.categories !== "string" || spec.categories.trim().length === 0) throw new Error(`${location}.categories must be a non-empty range`);
  if (spec.minPoints !== undefined && (!Number.isInteger(spec.minPoints) || spec.minPoints < 1)) throw new Error(`${location}.minPoints must be a positive integer`);
  if (!Array.isArray(spec.series) || spec.series.length === 0) throw new Error(`${location}.series must contain at least one series`);
  spec.series.forEach((series, index) => {
    if (!series || typeof series.name !== "string" || series.name.trim().length === 0 || typeof series.values !== "string" || series.values.trim().length === 0) {
      throw new Error(`${location}.series[${index}] requires non-empty name and values`);
    }
  });
}

function validateWorkbookForSerialization(workbook, nativeCharts) {
  if (workbook.worksheets.length === 0) throw new Error("Workbook must contain at least one worksheet");
  for (const worksheet of workbook.worksheets) {
    for (const [index, entry] of (worksheet.conditionalFormattings ?? []).entries()) {
      validateConditionalFormattingEntry(entry, `worksheet '${worksheet.name}' conditionalFormattings[${index}]`);
    }
  }
  if (!Array.isArray(nativeCharts)) throw new Error("Builder nativeCharts must be an array");
  nativeCharts.forEach((spec, index) => validateNativeChartSpec(workbook, spec, `nativeCharts[${index}]`));
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
  return {
    workbook,
    sheetName: product?.workbook ? product.sheetName : undefined,
    nativeCharts: product?.nativeCharts ?? NATIVE_CHART_SPECS.get(workbook) ?? [],
    requirements: product?.requirements ?? null,
  };
}

async function commandScaffold(options) {
  const outputPath = requireOption(options, "out");
  const starter = path.join(skillRoot, "assets", "starter-workbook.mjs");
  const requirementsOutput = options["requirements-out"] ? String(options["requirements-out"]) : null;
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing builder: ${outputPath}`);
  if (requirementsOutput && await pathExists(requirementsOutput)) throw new Error(`Refusing to overwrite existing requirements: ${requirementsOutput}`);
  await ensureParent(outputPath);
  await fs.copyFile(starter, outputPath);
  if (requirementsOutput) {
    await ensureParent(requirementsOutput);
    await fs.copyFile(path.join(skillRoot, "assets", "requirements.example.json"), requirementsOutput);
  }
  await emitReport({ status: "ok", output: path.resolve(outputPath), requirements: requirementsOutput ? path.resolve(requirementsOutput) : null }, options.report && String(options.report));
}

function workbookRequiresRequirements(workbook, nativeCharts, facts) {
  if (workbook.worksheets.length > 1 || facts.formulaCount > 0 || nativeCharts.length > 0) return true;
  return workbook.worksheets.some((worksheet) => (
    tableSummaries(worksheet).length > 0
    || (worksheet.conditionalFormattings?.length ?? 0) > 0
    || Object.keys(worksheet.dataValidations?.model ?? {}).length > 0
  ));
}

async function replaceFileAtomically(sourcePath, outputPath) {
  await ensureParent(outputPath);
  const resolvedOutput = path.resolve(outputPath);
  const temporaryOutput = path.join(path.dirname(resolvedOutput), `.${path.basename(resolvedOutput)}.${process.pid}.${Date.now()}.tmp`);
  const backupOutput = `${temporaryOutput}.bak`;
  await fs.copyFile(sourcePath, temporaryOutput);
  try {
    await fs.rename(temporaryOutput, resolvedOutput);
  } catch (error) {
    const replaceBlocked = process.platform === "win32" && ["EEXIST", "EPERM"].includes(error?.code) && await pathExists(resolvedOutput);
    if (!replaceBlocked) {
      await fs.rm(temporaryOutput, { force: true });
      throw error;
    }
    await fs.rename(resolvedOutput, backupOutput);
    try {
      await fs.rename(temporaryOutput, resolvedOutput);
      await fs.rm(backupOutput, { force: true });
    } catch (replaceError) {
      if (await pathExists(backupOutput)) await fs.rename(backupOutput, resolvedOutput);
      await fs.rm(temporaryOutput, { force: true });
      throw replaceError;
    }
  }
}

async function commandBuild(options) {
  const builderPath = requireOption(options, "builder");
  const outputPath = requireOption(options, "out");
  const inputPath = options.input ? String(options.input) : null;
  const outputExtension = assertSupportedOutput(outputPath);

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

  const { workbook, sheetName, nativeCharts, requirements: builderRequirements } = await runStage(
    "builder_execution",
    () => buildFromBuilder(builderPath, inputPath),
  );
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  await runStage("builder_validation", async () => validateWorkbookForSerialization(workbook, nativeCharts));
  const facts = collectWorkbookFacts(workbook);
  const requirements = await runStage(
    "requirements_validation",
    () => resolveRequirements(options.requirements ? String(options.requirements) : null, builderRequirements),
  );

  if (outputExtension === ".xlsx" && workbookRequiresRequirements(workbook, nativeCharts, facts) && !requirements) {
    throw new Error("Non-trivial XLSX builds require verifiable requirements. Return requirements from the builder or pass --requirements.");
  }

  if (outputExtension === ".csv" || outputExtension === ".tsv") {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-delimited-build-"));
    try {
      const stagedPath = path.join(tempRoot, `candidate${outputExtension}`);
      await exportDelimited(workbook, stagedPath, options.sheet ? String(options.sheet) : sheetName, options.encoding ? String(options.encoding) : "utf8-bom");
      const audit = await auditDelimited(stagedPath);
      await replaceFileAtomically(stagedPath, outputPath);
      await emitReport({ status: audit.status, output: path.resolve(outputPath), format: outputExtension.slice(1), audit }, options.report && String(options.report));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-build-"));
  try {
    const rawPath = path.join(tempRoot, "raw.xlsx");
    const stagedPath = path.join(tempRoot, "candidate.xlsx");
    await runStage("workbook_serialization", () => workbook.xlsx.writeFile(rawPath));
    let recalculated = false;
    if (facts.formulaCount > 0) {
      await runStage("formula_recalculation", () => recalculateWorkbook(rawPath, stagedPath));
      recalculated = true;
    } else {
      await fs.copyFile(rawPath, stagedPath);
    }
    const chartResult = await runStage("chart_injection", () => injectNativeCharts(stagedPath, nativeCharts, { JSZip, loadXlsx }));
    const audit = await runStage("audit", () => auditXlsx(stagedPath, requirements));
    if (audit.status === "error") {
      if (options.report) await writeJson(String(options.report), { status: "error", outputUpdated: false, audit });
      throw new Error(`Workbook failed formula, structure, or requirement coverage audit; the candidate output was not updated. ${summarizeAuditFailures(audit)}`);
    }
    await replaceFileAtomically(stagedPath, outputPath);
    const reportedAudit = { ...audit, path: path.resolve(outputPath) };
    await emitReport({
      status: audit.status,
      output: path.resolve(outputPath),
      formulaCount: facts.formulaCount,
      recalculated,
      nativeCharts: chartResult,
      requirements: reportedAudit.coverage,
      audit: reportedAudit,
    }, options.report && String(options.report));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandInspect(options) {
  const inputPath = requireOption(options, "input");
  const extension = assertSupportedInput(inputPath, { legacy: true });
  let report;
  if (extension === ".xls") {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-inspect-xls-"));
    try {
      const convertedPath = path.join(tempRoot, "converted.xlsx");
      await convertLegacyXls(inputPath, convertedPath);
      report = await inspectXlsx(convertedPath, options);
      report.path = path.resolve(inputPath);
      report.format = "xls";
      report.convertedForInspection = true;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  } else {
    report = extension === ".xlsx" ? await inspectXlsx(inputPath, options) : await inspectDelimited(inputPath, options);
  }
  await emitReport(report, options.out && String(options.out));
}

async function commandAudit(options) {
  const inputPath = requireOption(options, "input");
  const extension = assertSupportedInput(inputPath);
  const requirements = await runStage(
    "requirements_validation",
    () => resolveRequirements(options.requirements ? String(options.requirements) : null),
  );
  const report = await runStage(
    "audit",
    () => extension === ".xlsx" ? auditXlsx(inputPath, requirements) : auditDelimited(inputPath),
  );
  await emitReport(report, options.out && String(options.out));
  if (report.status === "error") process.exitCode = 1;
}

async function commandConvertLegacy(options) {
  const inputPath = requireOption(options, "input");
  const outputPath = requireOption(options, "out");
  const report = await convertLegacyXls(inputPath, outputPath);
  await emitReport(report, options.report && String(options.report));
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
  const result = await runStage("formula_recalculation", () => recalculateWorkbook(inputPath, outputPath));
  const audit = await runStage("audit", () => auditXlsx(outputPath));
  await emitReport({ status: audit.status, ...result, audit }, options.report && String(options.report));
  if (audit.status === "error") process.exitCode = 1;
}

function naturalPageSort(left, right) {
  const leftNumber = Number(left.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  const rightNumber = Number(right.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  return leftNumber - rightNumber || left.localeCompare(right);
}

async function createMontage(pagePaths, outputPath, labels = []) {
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
    const labelText = String(labels[index] ?? `Page ${index + 1}`).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const label = Buffer.from(`<svg width="${thumbWidth}" height="${labelHeight}"><text x="${thumbWidth / 2}" y="21" text-anchor="middle" font-family="Arial" font-size="16" fill="#334155">${labelText}</text></svg>`);
    composites.push({ input: label, left: x, top: y + thumbHeight });
  }

  await ensureParent(outputPath);
  await sharp({ create: { width, height, channels: 4, background: "#e2e8f0" } })
    .composite(composites)
    .png()
    .toFile(outputPath);
}

async function analyzeRenderedPage(pagePath) {
  const { data, info } = await sharp(pagePath).flatten({ background: "#ffffff" }).resize({ width: 480, withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (const value of data) if (value < 245) ink += 1;
  const pixelCount = info.width * info.height;
  const inkRatio = pixelCount > 0 ? ink / pixelCount : 0;
  return { path: path.resolve(pagePath), width: info.width, height: info.height, inkRatio, blank: inkRatio < 0.00035 };
}

async function createSingleSheetPackage(inputPath, outputPath, sheetName) {
  const zip = await JSZip.loadAsync(await fs.readFile(inputPath));
  const workbookPart = zip.file("xl/workbook.xml");
  if (!workbookPart) throw new Error("The XLSX package is missing xl/workbook.xml");
  let workbookXml = await workbookPart.async("string");
  let sheetIndex = -1;
  let selectedIndex = 0;
  workbookXml = workbookXml.replace(/<sheet\b([^>]*)\/?\s*>/gi, (match, attributes) => {
    sheetIndex += 1;
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1]
      ?.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    if (name === sheetName) selectedIndex = sheetIndex;
    const cleaned = attributes.replace(/\sstate="[^"]*"/i, "").replace(/\/\s*$/, "").trimEnd();
    return name === sheetName ? `<sheet${cleaned}/>` : "";
  });
  workbookXml = workbookXml.replace(/<workbookView\b([^>]*)\/?\s*>/i, (_match, attributes) => {
    const cleaned = attributes.replace(/\sactiveTab="[^"]*"/i, "").replace(/\/\s*$/, "").trimEnd();
    return `<workbookView${cleaned} activeTab="0"/>`;
  });
  workbookXml = workbookXml.replace(/<definedName\b([^>]*)\blocalSheetId="(\d+)"([^>]*)>([\s\S]*?)<\/definedName>/gi, (match, before, localSheetId, after, value) => {
    if (Number(localSheetId) !== selectedIndex) return "";
    return `<definedName${before}localSheetId="0"${after}>${value}</definedName>`;
  });
  zip.file("xl/workbook.xml", workbookXml);
  for (const worksheetPart of Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))) {
    const worksheetXml = await zip.file(worksheetPart).async("string");
    zip.file(worksheetPart, worksheetXml.replace(/\stabSelected="[^"]*"/gi, ""));
  }
  await fs.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function convertToXlsxForRender(inputPath, tempRoot) {
  if (workbookExtension(inputPath) === ".xlsx") return inputPath;
  if (workbookExtension(inputPath) === ".xls") {
    const outputPath = path.join(tempRoot, "legacy.xlsx");
    await convertLegacyXls(inputPath, outputPath);
    return outputPath;
  }
  const workbook = await loadDelimited(inputPath, { inferTypes: false });
  for (const worksheet of workbook.worksheets) {
    autoFitColumns(worksheet, { min: 8, max: 32 });
    worksheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
  const outputPath = path.join(tempRoot, "delimited.xlsx");
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

async function renderWorkbook(inputPath, outputDir, { pdfPath, montagePath, perSheet = false } = {}) {
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
    for (const name of await fs.readdir(outputDir)) {
      if (/^page-?\d+\.png$/i.test(name)) await fs.rm(path.join(outputDir, name), { force: true });
    }
    const xlsxInput = await convertToXlsxForRender(inputPath, tempRoot);
    if (perSheet) {
      const workbook = await loadXlsx(xlsxInput);
      const sheetReports = [];
      const allPages = [];
      const labels = [];
      for (let index = 0; index < workbook.worksheets.length; index += 1) {
        const worksheet = workbook.worksheets[index];
        const singlePath = path.join(tempRoot, `sheet-${index + 1}.xlsx`);
        const sheetOutput = path.join(outputDir, `sheet-${String(index + 1).padStart(2, "0")}`);
        await createSingleSheetPackage(xlsxInput, singlePath, worksheet.name);
        const report = await renderWorkbook(singlePath, sheetOutput, {});
        sheetReports.push({ sheet: worksheet.name, ...report });
        allPages.push(...report.pages);
        labels.push(...report.pages.map((_page, pageIndex) => `${worksheet.name} · ${pageIndex + 1}/${report.pages.length}`));
      }
      const finalMontage = montagePath ?? path.join(outputDir, "montage.png");
      await createMontage(allPages, finalMontage, labels);
      return {
        montage: path.resolve(finalMontage),
        pages: allPages,
        pageCount: allPages.length,
        pageStats: sheetReports.flatMap((sheet) => sheet.pageStats.map((page) => ({ ...page, sheet: sheet.sheet }))),
        sheets: sheetReports,
      };
    }
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
    const pageStats = await Promise.all(pages.map(analyzeRenderedPage));
    const finalMontage = montagePath ?? path.join(outputDir, "montage.png");
    await createMontage(pages, finalMontage);
    return {
      pdf: path.resolve(finalPdf),
      montage: path.resolve(finalMontage),
      pages: pages.map((page) => path.resolve(page)),
      pageCount: pages.length,
      pageStats,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandRender(options) {
  const inputPath = requireOption(options, "input");
  const outputDir = requireOption(options, "out-dir");
  assertSupportedInput(inputPath, { legacy: true });
  const rendered = await renderWorkbook(inputPath, outputDir, {
    pdfPath: options.pdf ? String(options.pdf) : undefined,
    montagePath: options.montage ? String(options.montage) : undefined,
    perSheet: Boolean(options["per-sheet"]),
  });
  const blankPages = rendered.pageStats.filter((page) => page.blank);
  await emitReport({ status: blankPages.length > 0 ? "warning" : "ok", input: path.resolve(inputPath), blankPages, ...rendered }, options.report && String(options.report));
}

async function fileSha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function evaluateRenderRequirements(rendered, requirements) {
  const checks = [];
  if (!requirements) return { status: "not_requested", total: 0, passed: 0, checks: [], failures: [] };
  if (Number.isFinite(requirements.maxTotalPages)) {
    checks.push({ type: "max_total_pages", passed: rendered.pageCount <= requirements.maxTotalPages, expected: requirements.maxTotalPages, actual: rendered.pageCount });
  }
  for (const item of requirements.maxPagesPerSheet ?? []) {
    const actual = rendered.sheets.find((sheet) => sheet.sheet === item.sheet)?.pageCount ?? null;
    checks.push({ type: "max_pages_per_sheet", passed: actual !== null && actual <= item.max, sheet: item.sheet, expected: item.max, actual });
  }
  const failures = checks.filter((check) => !check.passed);
  return { status: failures.length === 0 ? "passed" : "failed", total: checks.length, passed: checks.length - failures.length, checks, failures };
}

async function commandDeliver(options) {
  const inputPath = requireOption(options, "input");
  const outputPath = requireOption(options, "out");
  const qaDir = requireOption(options, "qa-dir");
  const requirementsPath = requireOption(options, "requirements");
  if (workbookExtension(inputPath) !== ".xlsx" || workbookExtension(outputPath) !== ".xlsx") {
    throw new Error("deliver currently seals .xlsx candidates only");
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw new Error("Deliverable must be distinct from the candidate workbook");
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing deliverable: ${outputPath}`);
  const requirements = await runStage("requirements_validation", () => resolveRequirements(requirementsPath));
  const audit = await runStage("audit", () => auditXlsx(inputPath, requirements));
  if (audit.status === "error") throw new Error(`Candidate workbook failed structural, formula, or requirement coverage audit. ${summarizeAuditFailures(audit)}`);
  if (audit.coverage.status !== "passed" || audit.coverage.total === 0) {
    throw new Error("Candidate workbook has no passing, verifiable requirement coverage");
  }
  if (audit.warningDispositions.status === "failed") {
    throw new Error(`Candidate workbook has unresolved audit warnings: ${audit.warningDispositions.unresolved.map((warning) => warning.type).join(", ")}`);
  }

  const rendered = await runStage("render", () => renderWorkbook(inputPath, qaDir, { perSheet: true, montagePath: path.join(qaDir, "montage.png") }));
  const blankPages = rendered.pageStats.filter((page) => page.blank);
  if (blankPages.length > 0) {
    throw new Error(`Candidate workbook produced ${blankPages.length} blank print page(s): ${blankPages.map((page) => `${page.sheet}:${path.basename(page.path)}`).join(", ")}`);
  }
  const renderCoverage = evaluateRenderRequirements(rendered, requirements);
  if (renderCoverage.status === "failed") throw new Error(`Candidate workbook failed render requirements: ${renderCoverage.failures.map((failure) => failure.type).join(", ")}`);

  await ensureParent(outputPath);
  const temporaryOutput = path.join(path.dirname(path.resolve(outputPath)), `.${path.basename(outputPath)}.${process.pid}.tmp`);
  await fs.copyFile(inputPath, temporaryOutput);
  const candidateSha256 = await fileSha256(inputPath);
  const copiedSha256 = await fileSha256(temporaryOutput);
  if (candidateSha256 !== copiedSha256) {
    await fs.rm(temporaryOutput, { force: true });
    throw new Error("Candidate and sealed deliverable hashes do not match");
  }
  await fs.rename(temporaryOutput, outputPath);
  const finalAudit = await auditXlsx(outputPath, requirements);
  const finalSha256 = await fileSha256(outputPath);
  if (finalAudit.status === "error" || finalAudit.coverage.status !== "passed" || finalAudit.warningDispositions.status === "failed" || finalSha256 !== candidateSha256) {
    await fs.rm(outputPath, { force: true });
    throw new Error("Final deliverable failed post-seal verification");
  }
  const report = {
    status: finalAudit.status,
    output: path.resolve(outputPath),
    sha256: finalSha256,
    coverage: finalAudit.coverage,
    renderCoverage,
    audit: finalAudit,
    render: rendered,
    blankPages,
  };
  await emitReport(report, options.report && String(options.report));
}

async function createSelfTestWorkbook() {
  const workbook = createWorkbook();
  const inputs = workbook.addWorksheet("输入数据", { views: [{ showGridLines: false }] });
  inputs.addRows([
    ["假设 / Assumption", "数值 / Value"],
    ["收入", 100000],
    ["增长率", 0.1],
  ]);
  styleHeader(inputs, "A1:B1");
  inputs.getCell("B2").numFmt = '"$"#,##0';
  inputs.getCell("B3").numFmt = "0.0%";
  autoFitColumns(inputs, { min: 12, max: 24 });

  const summary = workbook.addWorksheet("汇总", {
    views: [{ state: "frozen", ySplit: 3, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  summary.mergeCells("A1:D1");
  summary.getCell("A1").value = "PilotDeck 表格能力自测";
  summary.getCell("A1").font = { size: 18, bold: true, color: { argb: "FF0F172A" } };
  summary.getRow(1).height = 28;
  summary.addRows([
    [],
    ["月份", "收入", "成本"],
    ["1月", 100000, 70000],
    ["2月", 120000, 78000],
    ["3月", 135000, 85000],
  ]);
  addTableFromRange(summary, { name: "SelfTestTable", range: "A3:C6" });
  summary.getCell("D3").value = "利润率";
  styleHeader(summary, "D3:D3");
  for (let row = 4; row <= 6; row += 1) {
    summary.getCell(`D${row}`).value = { formula: `IFERROR((B${row}-C${row})/B${row},0)`, result: 0 };
    summary.getCell(`D${row}`).numFmt = "0.0%";
  }
  summary.getCell("A8").value = "预计收入";
  summary.getCell("B8").value = { formula: "'输入数据'!B2*(1+'输入数据'!B3)", result: 0 };
  summary.getCell("B8").numFmt = '"$"#,##0';
  summary.getCell("F3").value = "状态";
  summary.getCell("F4").value = "正常";
  addListValidation(summary, "F4:F6", ["正常", "风险", "阻塞"], { allowBlank: false });
  addConditionalFormatting(summary, {
    range: "D4:D6",
    rules: [{ type: "cellIs", operator: "lessThan", formulae: [0.25], style: { font: { color: { argb: "FFB91C1C" } } } }],
  });
  setNumberFormat(summary, "B4:C6", '"$"#,##0');
  autoFitColumns(summary, { min: 11, max: 26 });
  applyChineseTypography(inputs, { platform: "cross-platform" });
  applyChineseTypography(summary, { platform: "cross-platform", titleRanges: ["A1:D1"] });

  const types = workbook.addWorksheet("类型回归", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 },
  });
  types.addRows([
    ["行动项编号", "完成率", "截止日期", "状态"],
    ["A-001", 0.5, new Date("2026-04-30T00:00:00Z"), "进行中"],
    ["A-002", 0.8, new Date("2026-05-31T00:00:00Z"), "已完成"],
  ]);
  applyStyle(types, "A1:D3", { alignment: { vertical: "middle" } });
  styleHeader(types, "A1:D1");
  setNumberFormat(types, "B2:B3", "0.0%");
  setNumberFormat(types, "C2:C3", "yyyy-mm-dd");
  addTableFromRange(types, { name: "TypeRegressionTable", range: "A1:D3" });
  addListValidation(types, "D2:D3", ["未开始", "进行中", "已完成"], { allowBlank: false });
  addConditionalFormatting(types, {
    range: "B2:B3",
    rules: [{ type: "cellIs", operator: "lessThan", formulae: [0.6], style: { font: { color: { argb: "FFB91C1C" } } } }],
  });
  autoFitColumns(types, { min: 12, max: 24 });
  applyChineseTypography(types, { platform: "cross-platform" });
  NATIVE_CHART_SPECS.set(workbook, [{
    sheet: "汇总",
    type: "line",
    title: "收入与成本趋势",
    minPoints: 3,
    categories: "A4:A6",
    series: [{ name: "收入", values: "B4:B6" }, { name: "成本", values: "C4:C6" }],
    anchor: { from: "A10", to: "H25" },
    valueFormat: "¥#,##0",
  }]);
  return workbook;
}

async function commandSelfTest(options) {
  const outputDir = options.out ? String(options.out) : path.join(os.tmpdir(), `pilotdeck-spreadsheets-self-test-${Date.now()}`);
  await fs.mkdir(outputDir, { recursive: true });
  const steps = [];

  const rawPath = path.join(outputDir, "raw.xlsx");
  const finalPath = path.join(outputDir, "self-test.xlsx");
  const workbook = await createSelfTestWorkbook();
  const nativeCharts = NATIVE_CHART_SPECS.get(workbook) ?? [];
  await workbook.xlsx.writeFile(rawPath);
  steps.push({ name: "create", status: "ok", output: rawPath });

  const recalculation = await recalculateWorkbook(rawPath, finalPath);
  await injectNativeCharts(finalPath, nativeCharts, { JSZip, loadXlsx });
  const recalculated = await loadXlsx(finalPath);
  const margin = recalculated.getWorksheet("汇总").getCell("D4").result;
  const projected = recalculated.getWorksheet("汇总").getCell("B8").result;
  if (Math.abs(Number(margin) - 0.3) > 0.000001 || Math.abs(Number(projected) - 110000) > 0.01) {
    throw new Error(`Formula recalculation failed: margin=${margin}, projected=${projected}`);
  }
  steps.push({ name: "recalculate", status: "ok", margin, projected, compatibilityNormalization: recalculation.compatibilityNormalization });

  const inspection = await inspectXlsx(finalPath, { sheet: "汇总", range: "A1:F8", styles: true });
  if (inspection.formulas.count < 4 || inspection.package.features.tables < 1 || inspection.package.features.charts !== 1) throw new Error("Inspection missed formulas, tables, or native charts");
  if (inspection.package.compatibility.status !== "ok") throw new Error("Inspection missed invalid post-recalculation OOXML semantics");
  if (inspection.package.features.drawingParts !== 1 || inspection.package.features.drawings !== 1) {
    throw new Error(`Drawing cleanup or native chart injection left an unexpected package shape: ${inspection.package.features.drawingParts} parts, ${inspection.package.features.drawings} objects`);
  }
  steps.push({
    name: "inspect",
    status: "ok",
    formulas: inspection.formulas.count,
    tables: inspection.package.features.tables,
    charts: inspection.package.features.charts,
    drawingParts: inspection.package.features.drawingParts,
    drawingObjects: inspection.package.features.drawings,
  });

  const invalidDrawingPath = path.join(outputDir, "invalid-drawing-anchor.xlsx");
  const invalidDrawingZip = await JSZip.loadAsync(await fs.readFile(finalPath));
  let invalidDrawingPart = null;
  for (const [entryName, entry] of Object.entries(invalidDrawingZip.files)) {
    if (entry.dir || !/^xl\/drawings\/[^/]+\.xml$/i.test(entryName) || invalidDrawingPart) continue;
    const xml = await entry.async("string");
    const malformed = xml.replace(
      /<\/a:graphic>\s*<\/xdr:graphicFrame>\s*<xdr:clientData\s*\/>/i,
      "</a:graphic><xdr:clientData/></xdr:graphicFrame>",
    );
    if (malformed === xml) continue;
    invalidDrawingZip.file(entryName, malformed);
    invalidDrawingPart = entryName;
  }
  if (!invalidDrawingPart) throw new Error("Self-test could not create a malformed DrawingML anchor fixture");
  await fs.writeFile(invalidDrawingPath, await invalidDrawingZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const invalidDrawingAudit = await auditXlsx(invalidDrawingPath);
  const invalidDrawingReasons = new Set(invalidDrawingAudit.hardFailures
    .filter((failure) => failure.type === "invalid_drawing_anchor_structure")
    .map((failure) => failure.reason));
  if (!invalidDrawingReasons.has("missing_direct_client_data") || !invalidDrawingReasons.has("nested_client_data")) {
    throw new Error("DrawingML audit did not reject a nested clientData element");
  }

  const missingChartPath = path.join(outputDir, "missing-chart-part.xlsx");
  const missingChartZip = await JSZip.loadAsync(await fs.readFile(finalPath));
  const removedChartPart = Object.keys(missingChartZip.files).find((entryName) => /^xl\/charts\/chart\d+\.xml$/i.test(entryName));
  if (!removedChartPart) throw new Error("Self-test could not locate the native chart part");
  missingChartZip.remove(removedChartPart);
  await fs.writeFile(missingChartPath, await missingChartZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const missingChartAudit = await auditXlsx(missingChartPath);
  if (!missingChartAudit.hardFailures.some((failure) => failure.type === "missing_chart_part" && failure.part === removedChartPart)) {
    throw new Error("DrawingML audit did not reject a dangling chart relationship");
  }
  steps.push({
    name: "drawingml-compatibility",
    status: "ok",
    malformedAnchorIssues: invalidDrawingAudit.package.compatibility.issues.length,
    danglingRelationshipIssues: missingChartAudit.package.compatibility.issues.length,
  });

  const emptyDrawingPath = path.join(outputDir, "empty-drawing-part.xlsx");
  const emptyDrawingZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  const emptyDrawingRelationshipId = "rIdPilotDeckEmptyDrawing";
  const emptyDrawingPart = "xl/drawings/drawing999.xml";
  const emptyDrawingSheetPart = "xl/worksheets/sheet1.xml";
  const emptyDrawingSheetRelsPart = "xl/worksheets/_rels/sheet1.xml.rels";
  const emptyDrawingSheetXml = await emptyDrawingZip.file(emptyDrawingSheetPart).async("string");
  emptyDrawingZip.file(emptyDrawingSheetPart, emptyDrawingSheetXml.replace("</worksheet>", `<drawing r:id="${emptyDrawingRelationshipId}"/></worksheet>`));
  const emptyDrawingRelationshipXml = emptyDrawingZip.file(emptyDrawingSheetRelsPart)
    ? await emptyDrawingZip.file(emptyDrawingSheetRelsPart).async("string")
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  emptyDrawingZip.file(emptyDrawingSheetRelsPart, emptyDrawingRelationshipXml.replace(
    "</Relationships>",
    `<Relationship Id="${emptyDrawingRelationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing999.xml"/></Relationships>`,
  ));
  emptyDrawingZip.file(emptyDrawingPart, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>');
  const emptyDrawingContentTypes = await emptyDrawingZip.file("[Content_Types].xml").async("string");
  emptyDrawingZip.file("[Content_Types].xml", emptyDrawingContentTypes.replace(
    "</Types>",
    `<Override PartName="/${emptyDrawingPart}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
  ));
  await fs.writeFile(emptyDrawingPath, await emptyDrawingZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const emptyDrawingNormalization = await normalizeLibreOfficeRoundTripPackage(emptyDrawingPath);
  const cleanedEmptyDrawingZip = await JSZip.loadAsync(await fs.readFile(emptyDrawingPath));
  const cleanedSheetXml = await cleanedEmptyDrawingZip.file(emptyDrawingSheetPart).async("string");
  const cleanedSheetRelsXml = cleanedEmptyDrawingZip.file(emptyDrawingSheetRelsPart)
    ? await cleanedEmptyDrawingZip.file(emptyDrawingSheetRelsPart).async("string")
    : "";
  const cleanedContentTypes = await cleanedEmptyDrawingZip.file("[Content_Types].xml").async("string");
  if (emptyDrawingNormalization.removedEmptyDrawings !== 1
    || cleanedEmptyDrawingZip.file(emptyDrawingPart)
    || cleanedSheetXml.includes(emptyDrawingRelationshipId)
    || cleanedSheetRelsXml.includes(emptyDrawingRelationshipId)
    || cleanedContentTypes.includes(`/${emptyDrawingPart}`)) {
    throw new Error("Empty DrawingML package cleanup left an orphan part or relationship");
  }
  steps.push({ name: "empty-drawing-cleanup", status: "ok", removed: emptyDrawingNormalization.removedEmptyDrawings });

  const incompatibleValidationPath = path.join(outputDir, "invalid-list-validation.xlsx");
  const incompatibleValidationZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  let injectedInvalidValidation = false;
  for (const [entryName, entry] of Object.entries(incompatibleValidationZip.files)) {
    if (entry.dir || !/^xl\/worksheets\/sheet\d+\.xml$/i.test(entryName) || injectedInvalidValidation) continue;
    const xml = await entry.async("string");
    const invalid = xml.replace(
      /(<(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\b)([^>]*\btype=(["'])list\3[^>]*>)([\s\S]*?)(<\/(?:(?:[A-Za-z_][\w.-]*):)?dataValidation\s*>)/i,
      (_match, opening, attributes, _quote, body, closing) => `${opening} operator="between"${attributes}${body}<formula2>0</formula2>${closing}`,
    );
    if (invalid === xml) continue;
    incompatibleValidationZip.file(entryName, invalid);
    injectedInvalidValidation = true;
  }
  if (!injectedInvalidValidation) throw new Error("Self-test could not create an invalid list-validation fixture");
  await fs.writeFile(incompatibleValidationPath, await incompatibleValidationZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const incompatibleValidationAudit = await auditXlsx(incompatibleValidationPath);
  if (!incompatibleValidationAudit.hardFailures.some((failure) => failure.type === "invalid_data_validation_semantics")) {
    throw new Error("Audit did not reject invalid list-validation OOXML semantics");
  }
  const fixtureNormalization = await normalizeLibreOfficeRoundTripPackage(incompatibleValidationPath);
  const repairedValidationAudit = await auditXlsx(incompatibleValidationPath);
  if (fixtureNormalization.normalizedValidations !== 1 || repairedValidationAudit.package.compatibility.status !== "ok") {
    throw new Error("List-validation OOXML normalization did not repair the invalid fixture");
  }
  steps.push({
    name: "list-validation-compatibility",
    status: "ok",
    detected: incompatibleValidationAudit.package.compatibility.issues.length,
    normalized: fixtureNormalization.normalizedValidations,
  });

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
  const prefixedInspection = await inspectXlsx(prefixedPath, { sheet: "汇总", range: "A1:F8" });
  if (prefixedPartCount === 0 || prefixedInspection.selection.cells.length === 0) {
    throw new Error("Inspection failed for prefixed SpreadsheetML namespaces");
  }
  steps.push({ name: "inspect-prefixed-ooxml", status: "ok", normalizedParts: prefixedPartCount });

  const selfTestRequirements = {
    sourceBacked: true,
    sourceFiles: [{ path: rawPath, sha256: await fileSha256(rawPath) }],
    sourceBackedSheets: ["汇总", "类型回归"],
    requiredSheets: ["输入数据", "汇总", "类型回归"],
    minFormulaCount: 4,
    requiredFormulaRanges: [{ sheet: "汇总", range: "D4:D6" }],
    requiredNativeCharts: [{ sheet: "汇总", type: "line", minPoints: 3, sourceRanges: ["A4:A6", "B4:B6", "C4:C6"] }],
    requiredTables: [{ sheet: "汇总", minCount: 1 }],
    requiredConditionalFormatting: [{ sheet: "汇总", range: "D4:D6" }],
    requiredDataValidations: [{ sheet: "汇总", cell: "F4" }],
    requiredCellTypes: [
      { sheet: "汇总", range: "A4:A6", type: "string" },
      { sheet: "汇总", range: "B4:D6", type: "number" },
      { sheet: "类型回归", range: "A2:A3", type: "string" },
      { sheet: "类型回归", range: "B2:B3", type: "number" },
      { sheet: "类型回归", range: "C2:C3", type: "date" },
    ],
    expectedCells: [{ sheet: "汇总", cell: "B8", value: 110000, tolerance: 0.01 }],
    expectedRanges: [
      { sheet: "汇总", range: "A4:C6", values: [["1月", 100000, 70000], ["2月", 120000, 78000], ["3月", 135000, 85000]] },
      { sheet: "类型回归", range: "A2:D3", values: [["A-001", 0.5, "2026-04-30", "进行中"], ["A-002", 0.8, "2026-05-31", "已完成"]] },
    ],
  };
  const audit = await auditXlsx(finalPath, selfTestRequirements);
  if (audit.status === "error") throw new Error("Clean workbook failed audit");
  if (audit.coverage.status !== "passed") throw new Error("Self-test requirement coverage failed");
  if (audit.warnings.some((warning) => warning.type === "cjk_font_fallback")) throw new Error("Chinese font fallback remained unresolved after recalculation");
  steps.push({ name: "audit-clean", status: audit.status, coverage: audit.coverage.status });

  const wrongFactRequirements = structuredClone(selfTestRequirements);
  wrongFactRequirements.expectedRanges[0].values[0][1] = 999999;
  const wrongFactAudit = await auditXlsx(finalPath, wrongFactRequirements);
  if (!wrongFactAudit.coverage.failures.some((failure) => failure.type === "expected_range" && failure.mismatches?.[0]?.address === "B4")) {
    throw new Error("Expected-range coverage did not reject a source-fact mismatch");
  }

  const changedSourcePath = path.join(outputDir, "changed-source.xlsx");
  await fs.copyFile(rawPath, changedSourcePath);
  const changedSourceHash = await fileSha256(changedSourcePath);
  await fs.appendFile(changedSourcePath, "changed");
  const changedSourceRequirements = structuredClone(selfTestRequirements);
  changedSourceRequirements.sourceFiles = [{ path: changedSourcePath, sha256: changedSourceHash }];
  const changedSourceAudit = await auditXlsx(finalPath, changedSourceRequirements);
  if (!changedSourceAudit.coverage.failures.some((failure) => failure.type === "source_file_integrity")) {
    throw new Error("Source-file integrity coverage did not reject a changed input");
  }
  steps.push({ name: "source-fact-coverage", status: "ok", expectedRangeFailures: wrongFactAudit.coverage.failures.length, sourceHashFailures: changedSourceAudit.coverage.failures.length });
  const failedCoverage = await auditXlsx(finalPath, { requiredNativeCharts: [{ sheet: "汇总", type: "bar", minCount: 1 }] });
  if (failedCoverage.status !== "error" || failedCoverage.coverage.status !== "failed") throw new Error("Requirement coverage did not reject a missing native chart type");
  steps.push({ name: "coverage-failure", status: "ok", detected: failedCoverage.coverage.failures.length });
  const failedTypeCoverage = await auditXlsx(finalPath, { requiredCellTypes: [{ sheet: "类型回归", range: "B2:B3", type: "date" }] });
  if (failedTypeCoverage.status !== "error" || failedTypeCoverage.coverage.failures[0]?.type !== "required_cell_type") {
    throw new Error("Cell type coverage did not reject numeric KPI cells interpreted as dates");
  }
  steps.push({ name: "cell-type-coverage", status: "ok", detected: failedTypeCoverage.coverage.failures.length });

  const editBuilderPath = path.join(outputDir, "edit-builder.mjs");
  await fs.writeFile(editBuilderPath, `export default async function build({ inputPath, loadWorkbook }) {\n  const workbook = await loadWorkbook(inputPath);\n  workbook.getWorksheet("汇总").getCell("A1").value = "Edited workbook";\n  return workbook;\n}\n`, "utf8");
  const editedProduct = await buildFromBuilder(editBuilderPath, finalPath);
  const editedRawPath = path.join(outputDir, "edited-raw.xlsx");
  const editedPath = path.join(outputDir, "edited.xlsx");
  await editedProduct.workbook.xlsx.writeFile(editedRawPath);
  await recalculateWorkbook(editedRawPath, editedPath);
  const sourceAfterEdit = await loadXlsx(finalPath);
  const editedWorkbook = await loadXlsx(editedPath);
  if (displayCellText(sourceAfterEdit.getWorksheet("汇总").getCell("A1")) !== "PilotDeck 表格能力自测") {
    throw new Error("Existing-workbook edit overwrote the source file");
  }
  if (editedWorkbook.getWorksheet("汇总").getCell("A1").value !== "Edited workbook") {
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

  const invalidDatePath = path.join(outputDir, "invalid-date.xlsx");
  const invalidDateWorkbook = createWorkbook();
  const invalidDateSheet = invalidDateWorkbook.addWorksheet("InvalidDate");
  invalidDateSheet.getCell("A1").value = 1e20;
  invalidDateSheet.getCell("A1").numFmt = "yyyy-mm-dd";
  await invalidDateWorkbook.xlsx.writeFile(invalidDatePath);
  const invalidDateAudit = await auditXlsx(invalidDatePath);
  if (!invalidDateAudit.hardFailures.some((failure) => failure.type === "invalid_date_value")) {
    throw new Error("Invalid date scan did not catch an out-of-range date-formatted number");
  }
  steps.push({ name: "invalid-date-audit", status: "ok", detected: invalidDateAudit.invalidDates.length });

  const blankPath = path.join(outputDir, "intentional-blank-sheet.xlsx");
  const blankWorkbook = createWorkbook();
  blankWorkbook.addWorksheet("Blank");
  await blankWorkbook.xlsx.writeFile(blankPath);
  const unresolvedWarningAudit = await auditXlsx(blankPath, { requiredSheets: ["Blank"] });
  if (unresolvedWarningAudit.warningDispositions.status !== "failed") throw new Error("Unresolved warnings were not marked as blocking");
  const disposedWarningAudit = await auditXlsx(blankPath, {
    requiredSheets: ["Blank"],
    warningDispositions: [{ type: "blank_sheets", rationale: "Self-test fixture intentionally verifies warning dispositions." }],
  });
  if (disposedWarningAudit.warningDispositions.status !== "passed") throw new Error("Explicit warning disposition was not accepted");
  steps.push({ name: "warning-dispositions", status: "ok" });

  const invalidRequirementMessages = [];
  for (const invalid of [
    { coverage: { status: "passed" } },
    { warningDispositions: { cjk_font_fallback: "invalid shape" } },
  ]) {
    try {
      validateRequirements(invalid, "self-test requirements");
    } catch (error) {
      invalidRequirementMessages.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (invalidRequirementMessages.length !== 2) throw new Error("Malformed requirements were not rejected deterministically");
  steps.push({ name: "requirements-schema", status: "ok", detected: invalidRequirementMessages.length });

  const invalidConditionalBuilderPath = path.join(outputDir, "invalid-conditional-builder.mjs");
  await fs.writeFile(invalidConditionalBuilderPath, `export default async function build({ createWorkbook }) {\n  const workbook = createWorkbook();\n  const sheet = workbook.addWorksheet("行动项");\n  sheet.addConditionalFormatting({ ref: "A1:A2", rules: [{ type: "expression", formula: ["A1>0"], style: {} }] });\n  return { workbook, requirements: { requiredSheets: ["行动项"] } };\n}\n`, "utf8");
  let conditionalValidationError;
  try {
    await commandBuild({ builder: invalidConditionalBuilderPath, out: path.join(outputDir, "invalid-conditional.xlsx") });
  } catch (error) {
    conditionalValidationError = error;
  }
  if (!(conditionalValidationError instanceof SpreadsheetStageError)
    || conditionalValidationError.stage !== "builder_validation"
    || !conditionalValidationError.message.includes(".formulae as an array")) {
    throw new Error("Invalid conditional-formatting formulas did not produce an actionable builder-validation error");
  }
  steps.push({ name: "builder-validation", status: "ok", stage: conditionalValidationError.stage });

  const nullFormulaPath = path.join(outputDir, "missing-formula-cache.xlsx");
  const nullFormulaWorkbook = createWorkbook();
  nullFormulaWorkbook.addWorksheet("Formula").getCell("A1").value = { formula: "1+1" };
  await nullFormulaWorkbook.xlsx.writeFile(nullFormulaPath);
  const nullFormulaAudit = await auditXlsx(nullFormulaPath);
  if (!nullFormulaAudit.hardFailures.some((failure) => failure.type === "missing_cached_formula_result" && failure.address === "A1")) {
    throw new Error("Missing formula cache was not reported as a hard failure");
  }
  steps.push({ name: "missing-formula-cache", status: "ok", detected: nullFormulaAudit.formulas.missingCachedResults.length });

  const blankMergePath = path.join(outputDir, "blank-merge.xlsx");
  const blankMergeWorkbook = createWorkbook();
  const blankMergeSheet = blankMergeWorkbook.addWorksheet("Merged");
  blankMergeSheet.mergeCells("A1:B1");
  blankMergeSheet.getCell("C1").value = "keeps sheet populated";
  await blankMergeWorkbook.xlsx.writeFile(blankMergePath);
  const blankMergeAudit = await auditXlsx(blankMergePath);
  if (blankMergeAudit.status === "error") throw new Error("Blank merged cells crashed or failed workbook audit");
  steps.push({ name: "blank-merge-audit", status: "ok" });

  const atomicCandidatePath = path.join(outputDir, "atomic-candidate.xlsx");
  await fs.copyFile(finalPath, atomicCandidatePath);
  const atomicCandidateHash = await fileSha256(atomicCandidatePath);
  const failingBuilderPath = path.join(outputDir, "failing-builder.mjs");
  await fs.writeFile(failingBuilderPath, `export default async function build({ createWorkbook }) {\n  const workbook = createWorkbook();\n  workbook.addWorksheet("Broken").getCell("A1").value = { error: "#DIV/0!" };\n  return { workbook, requirements: { requiredSheets: ["Broken"] } };\n}\n`, "utf8");
  let buildRejected = false;
  try {
    await commandBuild({ builder: failingBuilderPath, out: atomicCandidatePath });
  } catch {
    buildRejected = true;
  }
  if (!buildRejected || await fileSha256(atomicCandidatePath) !== atomicCandidateHash) {
    throw new Error("Failed build replaced the last valid candidate");
  }
  steps.push({ name: "atomic-failed-build", status: "ok" });

  const csvPath = path.join(outputDir, "sample-gb18030.csv");
  await fs.writeFile(csvPath, iconv.encode('名称,编号,数值\n"北京分公司",001234,10\n上海分公司,123456789012345678,20\n', "gb18030"));
  const csvInspection = await inspectDelimited(csvPath, {});
  if (csvInspection.rowCount !== 3 || csvInspection.preview[1][0] !== "北京分公司" || csvInspection.encoding !== "gb18030") throw new Error("Chinese CSV encoding detection failed");
  const csvWorkbook = await loadDelimited(csvPath, { inferTypes: true });
  if (typeof csvWorkbook.worksheets[0].getCell("B2").value !== "string" || typeof csvWorkbook.worksheets[0].getCell("B3").value !== "string") {
    throw new Error("CSV identifier inference lost leading zeroes or long integer precision");
  }
  const tsvPath = path.join(outputDir, "sample.tsv");
  await exportDelimited(csvWorkbook, tsvPath);
  const tsvInspection = await inspectDelimited(tsvPath, {});
  if (tsvInspection.format !== "tsv" || tsvInspection.preview[1][0] !== "北京分公司" || tsvInspection.encoding !== "utf8-bom") throw new Error("TSV export failed");
  steps.push({ name: "csv-tsv", status: "ok", sourceEncoding: csvInspection.encoding, outputEncoding: tsvInspection.encoding });

  const riskyPath = path.join(outputDir, "risky-chart-package.xlsx");
  const riskyZip = await JSZip.loadAsync(await fs.readFile(rawPath));
  riskyZip.file("xl/charts/chart1.xml", '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:lineChart/></c:plotArea></c:chart></c:chartSpace>');
  await fs.writeFile(riskyPath, await riskyZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const riskyInfo = await inspectPackage(riskyPath);
  if (!riskyInfo.unsafeForRoundTrip || riskyInfo.features.charts !== 1) throw new Error("Chart compatibility preflight failed");
  steps.push({ name: "compatibility-preflight", status: "ok", risks: riskyInfo.roundTripRisks });

  const chartTypesPath = path.join(outputDir, "native-chart-types.xlsx");
  const chartTypesWorkbook = createWorkbook();
  const chartTypeSpecs = [];
  for (const type of ["line", "column", "bar"]) {
    const worksheet = chartTypesWorkbook.addWorksheet(type, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });
    worksheet.addRows([["月份", "实际", "目标"], ["1月", 10, 12], ["2月", 14, 13], ["3月", 16, 15]]);
    styleHeader(worksheet, "A1:C1");
    autoFitColumns(worksheet, { min: 10, max: 18 });
    applyChineseTypography(worksheet, { platform: "cross-platform" });
    chartTypeSpecs.push({ sheet: type, type, title: `${type} 原生图表`, minPoints: 3, categories: "A2:A4", series: [{ name: "实际", values: "B2:B4" }, { name: "目标", values: "C2:C4" }], anchor: { from: "A6", to: "H20" } });
  }
  await chartTypesWorkbook.xlsx.writeFile(chartTypesPath);
  await injectNativeCharts(chartTypesPath, chartTypeSpecs, { JSZip, loadXlsx });
  const chartTypesAudit = await auditXlsx(chartTypesPath, { requiredNativeCharts: chartTypeSpecs.map((spec) => ({ sheet: spec.sheet, type: spec.type, minCount: 1, minPoints: 3, sourceRanges: ["A2:A4", "B2:B4", "C2:C4"] })) });
  const detectedTypes = new Set(chartTypesAudit.package.charts.flatMap((chart) => chart.types));
  if (chartTypesAudit.status === "error" || !["line", "column", "bar"].every((type) => detectedTypes.has(type))) throw new Error("Native chart type regression");
  const chartTypesRender = await renderWorkbook(chartTypesPath, path.join(outputDir, "chart-types-render"), { perSheet: true });
  if (chartTypesRender.pageStats.some((page) => page.blank)) throw new Error("A native chart type rendered as a blank page");
  steps.push({ name: "native-chart-types", status: "ok", types: [...detectedTypes], pages: chartTypesRender.pageCount });

  const blankChartPath = path.join(outputDir, "blank-chart-source.xlsx");
  const blankChartWorkbook = createWorkbook();
  blankChartWorkbook.addWorksheet("趋势").addRows([["月份", "数值"], ["1月", 10], [null, null], ["3月", 14]]);
  await blankChartWorkbook.xlsx.writeFile(blankChartPath);
  let blankChartError = null;
  try {
    await injectNativeCharts(blankChartPath, [{
      sheet: "趋势",
      type: "line",
      title: "空值回归",
      minPoints: 3,
      categories: "A2:A4",
      series: [{ name: "数值", values: "B2:B4" }],
      anchor: { from: "D2", to: "K16" },
    }], { JSZip, loadXlsx });
  } catch (error) {
    blankChartError = error;
  }
  if (!(blankChartError instanceof Error) || !blankChartError.message.includes("blank categories")) {
    throw new Error("Native chart injection did not reject blank categories and values");
  }
  steps.push({ name: "native-chart-data-quality", status: "ok", error: blankChartError.message });

  const legacySourceDir = path.join(outputDir, "legacy-source");
  const legacyProfileDir = path.join(outputDir, "legacy-profile");
  await Promise.all([fs.mkdir(legacySourceDir, { recursive: true }), fs.mkdir(legacyProfileDir, { recursive: true })]);
  const legacySeed = path.join(legacySourceDir, "legacy-seed.xlsx");
  const legacySeedWorkbook = createWorkbook();
  legacySeedWorkbook.addWorksheet("旧格式").addRows([["名称", "数值"], ["测试", 42]]);
  await legacySeedWorkbook.xlsx.writeFile(legacySeed);
  await runLibreOffice(["--convert-to", "xls:MS Excel 97", "--outdir", legacySourceDir, legacySeed], legacyProfileDir);
  const legacyXls = path.join(legacySourceDir, "legacy-seed.xls");
  if (!(await pathExists(legacyXls))) throw new Error("Self-test could not create a legacy XLS fixture");
  const legacyConverted = path.join(outputDir, "legacy-converted.xlsx");
  await convertLegacyXls(legacyXls, legacyConverted);
  const legacyWorkbook = await loadXlsx(legacyConverted);
  if (legacyWorkbook.getWorksheet("旧格式")?.getCell("B2").value !== 42) throw new Error("Legacy XLS conversion lost worksheet values");
  steps.push({ name: "xls-conversion", status: "ok" });

  const blankFixture = path.join(outputDir, "blank-page.png");
  await sharp({ create: { width: 320, height: 240, channels: 3, background: "white" } }).png().toFile(blankFixture);
  const blankAnalysis = await analyzeRenderedPage(blankFixture);
  if (!blankAnalysis.blank) throw new Error("Blank-page detection regression");
  steps.push({ name: "blank-page-detection", status: "ok" });

  const rendered = await renderWorkbook(finalPath, path.join(outputDir, "render"), { perSheet: true });
  if (rendered.pageStats.some((page) => page.blank)) throw new Error("Self-test workbook produced an unexpected blank print page");
  steps.push({ name: "render", status: "ok", pageCount: rendered.pageCount, sheets: rendered.sheets.map((sheet) => ({ name: sheet.sheet, pages: sheet.pageCount })), montage: rendered.montage });

  const sealedPath = path.join(outputDir, "sealed.xlsx");
  const sealAudit = await auditXlsx(finalPath, selfTestRequirements);
  if (sealAudit.status === "error") throw new Error("Candidate failed before seal self-test");
  await fs.copyFile(finalPath, sealedPath);
  if (await fileSha256(finalPath) !== await fileSha256(sealedPath)) throw new Error("Seal hash verification regression");
  steps.push({ name: "seal-hash", status: "ok", sha256: await fileSha256(sealedPath) });

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
  process.stdout.write(`PilotDeck spreadsheets skill\n\nCommands:\n  scaffold --out builder.mjs [--requirements-out requirements.json]\n  build --builder builder.mjs --out candidate.xlsx [--input source.xlsx] [--requirements requirements.json]\n  inspect --input book.xlsx [--sheet Sheet1 --range A1:H20 --styles --out report.json]\n  convert-legacy --input source.xls --out converted.xlsx\n  recalculate --input source.xlsx --out recalculated.xlsx\n  audit --input book.xlsx [--requirements requirements.json --out audit.json]\n  render --input book.xlsx --out-dir render [--pdf render.pdf --montage montage.png --per-sheet]\n  deliver --input candidate.xlsx --out final.xlsx --qa-dir qa --requirements requirements.json\n  self-test [--out directory]\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "scaffold": await commandScaffold(options); break;
    case "build": await commandBuild(options); break;
    case "inspect": await commandInspect(options); break;
    case "convert-legacy": await commandConvertLegacy(options); break;
    case "recalculate": await commandRecalculate(options); break;
    case "audit": await commandAudit(options); break;
    case "render": await commandRender(options); break;
    case "deliver": await commandDeliver(options); break;
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
    ...(error instanceof SpreadsheetStageError ? { stage: error.stage } : {}),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
    ...(error instanceof Error && error.cause instanceof Error && error.cause.stack ? { causeStack: error.cause.stack.split("\n").slice(0, 12) } : {}),
    ...(error instanceof Error && error.stack ? { stack: error.stack.split("\n").slice(0, 8) } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
