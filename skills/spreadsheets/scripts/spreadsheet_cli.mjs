#!/usr/bin/env node

import fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
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
  workbookSheetParts,
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
const INSERTED_IMAGE_SPECS = new WeakMap();
const GUARDED_WORKBOOKS = new WeakSet();
const GUARDED_WORKSHEETS = new WeakSet();
const TABLE_RANGE_COPY_DEPTH = Symbol("pilotdeckTableRangeCopyDepth");

const RESULT_STATUSES = ["ok", "partial", "unsupported", "blocked", "error", "review_pending", "evidence_unavailable"];
const CAPABILITY_STATES = ["supported", "partial", "fallback", "unsupported", "blocked"];

class SpreadsheetProtocolError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "SpreadsheetProtocolError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function blocked(code, message, details = {}) {
  return new SpreadsheetProtocolError("blocked", code, message, details);
}

function unsupported(code, message, details = {}) {
  return new SpreadsheetProtocolError("unsupported", code, message, details);
}

class SpreadsheetStageError extends Error {
  constructor(stage, message, cause, details = {}) {
    super(`${stage}: ${message}`, { cause });
    this.name = "SpreadsheetStageError";
    this.stage = stage;
    this.details = details;
  }
}

async function runStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SpreadsheetStageError || error instanceof SpreadsheetProtocolError) throw error;
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
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (Object.hasOwn(options, key)) {
      options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
    } else {
      options[key] = value;
    }
    if (value !== true) {
      index += 1;
    }
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "" || Array.isArray(value)) {
    throw new Error(`Missing required option --${key}`);
  }
  return String(value);
}

function optionValues(options, key) {
  const value = options[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((item) => item !== true && item !== "")
    .map(String);
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

function pilotDeckWorkDir() {
  const configured = String(process.env.PILOTDECK_WORK_DIR ?? "").trim();
  return configured ? resolveThroughExistingAncestor(configured) : null;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveThroughExistingAncestor(filePath) {
  let current = path.resolve(filePath);
  const suffix = [];

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }

  const canonicalBase = existsSync(current)
    ? realpathSync.native(current)
    : current;
  return path.resolve(canonicalBase, ...suffix);
}

function pathsReferToSameLocation(left, right) {
  return resolveThroughExistingAncestor(left) === resolveThroughExistingAncestor(right);
}

function assertDistinctArtifactPaths(artifacts) {
  const entries = Object.entries(artifacts)
    .filter(([, filePath]) => filePath !== null && filePath !== undefined && filePath !== "")
    .map(([role, filePath]) => [role, path.resolve(String(filePath))]);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftRole, leftPath] = entries[leftIndex];
      const [rightRole, rightPath] = entries[rightIndex];
      if (!pathsReferToSameLocation(leftPath, rightPath)) continue;
      throw blocked(
        "artifact-path-conflict",
        `Spreadsheet ${leftRole} and ${rightRole} must use distinct paths`,
        {
          [leftRole]: leftPath,
          [rightRole]: rightPath,
          next: "Choose a separate path for every input, executable, candidate, report, manifest, and deliverable artifact.",
        },
      );
    }
  }
}

function assertInternalArtifactPath(filePath, purpose) {
  const resolved = resolveThroughExistingAncestor(filePath);
  const workDir = pilotDeckWorkDir();
  if (workDir && !isInsidePath(resolved, workDir)) {
    throw new Error(
      `${purpose} is an intermediate task artifact and must be under `
      + `PILOTDECK_WORK_DIR (${workDir}). Only deliver may write the final workbook outside it.`,
    );
  }
  return resolved;
}

function assertDeliveryOutputPath(filePath) {
  const resolved = resolveThroughExistingAncestor(filePath);
  const workDir = pilotDeckWorkDir();
  if (workDir && isInsidePath(resolved, workDir)) {
    throw new Error("The final spreadsheet deliverable must be outside PILOTDECK_WORK_DIR");
  }
  return resolved;
}

async function writeJson(filePath, value) {
  const target = assertInternalArtifactPath(filePath, "Spreadsheet JSON report");
  await ensureParent(target);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function hasCellContent(value) {
  return value !== null && value !== undefined && value !== "";
}

function comparableCellValue(value) {
  if (value instanceof Date) return { date: value.toISOString() };
  return serializableValue(value);
}

function assertRawTableWriteIsNonDestructive(worksheet, model) {
  if (!model || typeof model !== "object" || !Array.isArray(model.columns) || !Array.isArray(model.rows)) return;
  const start = parseCellReference(String(model.ref ?? "").split(":")[0]);
  const incoming = [model.columns.map((column) => column?.name ?? null), ...model.rows];
  const conflicts = [];
  for (let rowOffset = 0; rowOffset < incoming.length; rowOffset += 1) {
    const row = Array.isArray(incoming[rowOffset]) ? incoming[rowOffset] : [];
    for (let columnOffset = 0; columnOffset < model.columns.length; columnOffset += 1) {
      const cell = worksheet.getCell(start.row + rowOffset, start.col + columnOffset);
      const existing = cell.value;
      const replacement = row[columnOffset] ?? null;
      if (!hasCellContent(existing)) continue;
      if (JSON.stringify(comparableCellValue(existing)) === JSON.stringify(comparableCellValue(replacement))) continue;
      if (conflicts.length < 8) {
        conflicts.push({ address: cell.address, existing: comparableCellValue(existing), replacement: comparableCellValue(replacement) });
      }
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `worksheet '${worksheet.name}'.addTable would overwrite populated cells (${conflicts.map((item) => item.address).join(", ")}). `
      + "When cells are already populated, use helpers.addTableFromRange(worksheet, { name, range }) instead of passing replacement rows to worksheet.addTable.",
    );
  }
}

function guardWorksheetTableWrites(worksheet) {
  if (!worksheet || GUARDED_WORKSHEETS.has(worksheet)) return worksheet;
  const originalAddTable = worksheet.addTable.bind(worksheet);
  worksheet.addTable = (model) => {
    if (!worksheet[TABLE_RANGE_COPY_DEPTH]) assertRawTableWriteIsNonDestructive(worksheet, model);
    return originalAddTable(model);
  };
  GUARDED_WORKSHEETS.add(worksheet);
  return worksheet;
}

function guardWorkbookTableWrites(workbook) {
  if (!workbook || GUARDED_WORKBOOKS.has(workbook)) return workbook;
  for (const worksheet of workbook.worksheets) guardWorksheetTableWrites(worksheet);
  const originalAddWorksheet = workbook.addWorksheet.bind(workbook);
  workbook.addWorksheet = (...args) => guardWorksheetTableWrites(originalAddWorksheet(...args));
  GUARDED_WORKBOOKS.add(workbook);
  return workbook;
}

function createWorkbook() {
  const workbook = guardWorkbookTableWrites(new ExcelJS.Workbook());
  workbook.creator = "PilotDeck";
  workbook.lastModifiedBy = "PilotDeck";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  return workbook;
}

function guardedExcelJsApi() {
  class GuardedWorkbook extends ExcelJS.Workbook {
    constructor(...args) {
      super(...args);
      guardWorkbookTableWrites(this);
    }
  }
  return new Proxy(ExcelJS, {
    get(target, property) {
      if (property === "Workbook") return GuardedWorkbook;
      return Reflect.get(target, property);
    },
  });
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

function expectedPackageXmlRoot(entryName) {
  if (entryName === "[Content_Types].xml") return "Types";
  if (/[.]rels$/i.test(entryName)) return "Relationships";
  if (/^xl\/charts\/chart[^/]*[.]xml$/i.test(entryName)) return "chartSpace";
  if (/^xl\/drawings\/drawing[^/]*[.]xml$/i.test(entryName)) return "wsDr";
  if (/^xl\/worksheets\/sheet[^/]*[.]xml$/i.test(entryName)) return "worksheet";
  if (entryName === "xl/workbook.xml") return "workbook";
  if (entryName === "xl/styles.xml") return "styleSheet";
  if (entryName === "xl/sharedStrings.xml") return "sst";
  return null;
}

async function collectChangedPackageXmlIssues(zip, changedParts) {
  const issues = [];
  for (const entryName of changedParts) {
    if (!/[.](?:xml|rels)$/i.test(entryName)) continue;
    const entry = zip.file(entryName);
    if (!entry) continue;
    const diagnostics = [];
    let document;
    try {
      document = new DOMParser({
        onError(level, message) {
          diagnostics.push({ level, message });
        },
      }).parseFromString(await entry.async("string"), "application/xml");
    } catch (error) {
      diagnostics.push({ level: "fatalError", message: error instanceof Error ? error.message : String(error) });
    }
    const parseErrors = diagnostics.filter((item) => item.level === "error" || item.level === "fatalError");
    if (!document?.documentElement || parseErrors.length > 0) {
      issues.push({
        type: "malformed_package_xml",
        part: entryName,
        diagnostics: parseErrors.slice(0, 8),
      });
      continue;
    }
    const actualRoot = document.documentElement.localName ?? document.documentElement.nodeName?.split(":").at(-1);
    const expectedRoot = expectedPackageXmlRoot(entryName);
    if (expectedRoot && actualRoot !== expectedRoot) {
      issues.push({
        type: "unexpected_package_xml_root",
        part: entryName,
        expected: expectedRoot,
        actual: actualRoot ?? null,
      });
      continue;
    }
    if (/^xl\/charts\/chart[^/]*[.]xml$/i.test(entryName)) {
      const hasChart = elementsByLocalName(document, "chart").length > 0;
      const hasPlotArea = elementsByLocalName(document, "plotArea").length > 0;
      if (!hasChart || !hasPlotArea) {
        issues.push({
          type: "invalid_chart_xml_structure",
          part: entryName,
          missing: [!hasChart ? "chart" : null, !hasPlotArea ? "plotArea" : null].filter(Boolean),
        });
      }
    }
  }
  return issues;
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

function normalizeExcelJsTableSemantics(xml) {
  const tableOpen = xml.match(/<table\b[^>]*>/i)?.[0];
  if (!tableOpen || /\btotalsRowCount="1"/i.test(tableOpen)) {
    return { xml, changed: false };
  }
  let normalizedOpen = tableOpen.replace(/\s+totalsRowShown="[^"]*"/i, "");
  normalizedOpen = normalizedOpen.replace(/>$/, ' totalsRowShown="0">');
  const normalized = xml
    .replace(tableOpen, normalizedOpen)
    .replace(/\s+totalsRowLabel=""/gi, "");
  return { xml: normalized, changed: normalized !== xml };
}

async function normalizeGeneratedTablePackage(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  let changedParts = 0;
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/tables\/table\d+[.]xml$/i.test(entryName)) continue;
    const xml = await entry.async("string");
    const normalized = normalizeExcelJsTableSemantics(xml);
    if (!normalized.changed) continue;
    zip.file(entryName, normalized.xml);
    changedParts += 1;
  }
  if (changedParts > 0) {
    await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  }
  return { changed: changedParts > 0, changedParts };
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

function cachedFormulaResult(cellElement) {
  const children = elementsByLocalName(cellElement, "v");
  const valueElement = children[0];
  if (!valueElement) return { present: false, value: undefined };
  const text = valueElement.textContent ?? "";
  const type = cellElement.getAttribute("t")?.toLowerCase() ?? "n";
  if (type === "str" || type === "inlinestr") return { present: true, value: text };
  if (type === "b") return { present: true, value: text !== "0" };
  if (type === "e") return { present: true, value: { error: text } };
  const numeric = Number(text);
  return { present: Number.isFinite(numeric), value: numeric };
}

async function restoreFalseyFormulaResults(workbook, packageBuffer) {
  const zip = await JSZip.loadAsync(packageBuffer);
  const sheetParts = await workbookSheetParts(zip);
  let restored = 0;
  for (const [sheetName, sheetPart] of sheetParts.entries()) {
    const worksheet = workbook.getWorksheet(sheetName);
    const part = zip.file(sheetPart);
    if (!worksheet || !part) continue;
    const document = new DOMParser().parseFromString(await part.async("string"), "application/xml");
    for (const cellElement of elementsByLocalName(document, "c")) {
      const address = cellElement.getAttribute("r");
      if (!address || elementsByLocalName(cellElement, "f").length === 0) continue;
      const cell = worksheet.getCell(address);
      const formula = formulaDescriptor(cell);
      if (!formula || formula.result !== null) continue;
      const cached = cachedFormulaResult(cellElement);
      if (!cached.present) continue;
      cell.value = { ...cell.value, result: cached.value };
      restored += 1;
    }
  }
  return restored;
}

async function loadXlsx(filePath) {
  const source = await fs.readFile(path.resolve(filePath));
  const workbook = new ExcelJS.Workbook();
  let packageBuffer = source;
  try {
    await workbook.xlsx.load(source);
  } catch (error) {
    const normalizedPackage = await normalizePrefixedSpreadsheetPackage(filePath);
    if (!normalizedPackage) throw error;
    const normalizedWorkbook = new ExcelJS.Workbook();
    await normalizedWorkbook.xlsx.load(normalizedPackage);
    packageBuffer = normalizedPackage;
    await restoreFalseyFormulaResults(normalizedWorkbook, packageBuffer);
    return guardWorkbookTableWrites(normalizedWorkbook);
  }
  await restoreFalseyFormulaResults(workbook, packageBuffer);
  return guardWorkbookTableWrites(workbook);
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

function addTableFromRange(worksheet, { name, range, style = { theme: "TableStyleLight1", showRowStripes: true } }) {
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
    columns.push({
      name: header,
      filterButton: true,
      ...(column === bounds.startCol ? { totalsRowLabel: "" } : {}),
    });
  }
  const rows = [];
  for (let row = bounds.startRow + 1; row <= bounds.endRow; row += 1) {
    const values = [];
    for (let column = bounds.startCol; column <= bounds.endCol; column += 1) values.push(worksheet.getCell(row, column).value);
    rows.push(values);
  }
  worksheet[TABLE_RANGE_COPY_DEPTH] = (worksheet[TABLE_RANGE_COPY_DEPTH] ?? 0) + 1;
  try {
    return worksheet.addTable({
      name: String(name),
      ref: `${columnLetters(bounds.startCol)}${bounds.startRow}`,
      headerRow: true,
      totalsRow: false,
      style: cloneCellStyle(style),
      columns,
      rows,
    });
  } finally {
    worksheet[TABLE_RANGE_COPY_DEPTH] -= 1;
  }
}

function addListValidation(worksheet, rangeRef, values, options = {}) {
  const formula = Array.isArray(values)
    ? `"${values.map((value) => String(value).replaceAll('"', '""')).join(",")}"`
    : String(values);
  if (!formula || formula === '""') throw new Error("addListValidation requires at least one allowed value or a range formula");
  if (Array.isArray(values) && formula.length > 255) {
    throw new Error("Inline list validation exceeds Excel's 255-character limit; place the values in cells and pass a range formula instead");
  }
  worksheet.dataValidations.add(rangeRef, {
    type: "list",
    allowBlank: options.allowBlank ?? true,
    showErrorMessage: options.showErrorMessage ?? true,
    errorStyle: options.errorStyle ?? "stop",
    errorTitle: options.errorTitle ?? "输入无效",
    error: options.error ?? "请选择列表中的值",
    formulae: [formula],
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
  const fill = options.fill ?? "FFF3F4F6";
  const color = options.color ?? "FF1F2937";
  forEachCellInRange(worksheet, rangeRef, (cell) => {
    cell.style = cloneCellStyle({
      ...(cell.style ?? {}),
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: fill } },
      font: { ...(cell.font ?? {}), bold: true, color: { argb: color } },
      border: {
        ...(cell.border ?? {}),
        bottom: options.bottomBorder ?? { style: "thin", color: { argb: "FFD1D5DB" } },
      },
      alignment: { ...(cell.alignment ?? {}), vertical: "middle", horizontal: options.horizontal ?? "left" },
    });
  });
}

async function addImage(workbook, spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("addImage requires an options object");
  const worksheet = workbook.getWorksheet(spec.sheet);
  if (!worksheet) throw new Error(`addImage references missing worksheet '${spec.sheet ?? ""}'`);
  const sourcePath = path.resolve(String(spec.path ?? ""));
  if (!sourcePath || !(await pathExists(sourcePath))) throw new Error(`Image not found: ${sourcePath || "(empty path)"}`);
  const sourceExtension = path.extname(sourcePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"].includes(sourceExtension)) {
    throw new Error("addImage supports local PNG, JPEG, WebP, and TIFF raster images");
  }
  const from = String(spec.anchor?.from ?? "").trim();
  const to = String(spec.anchor?.to ?? "").trim();
  if (!from || !to) throw new Error("addImage requires anchor.from and anchor.to cell references");
  const fromCell = parseCellReference(from);
  const toCell = parseCellReference(to);
  if (toCell.row <= fromCell.row || toCell.col <= fromCell.col) {
    throw new Error("addImage anchor.to must be below and to the right of anchor.from");
  }

  const image = sharp(sourcePath, { failOn: "error" }).rotate();
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions could not be determined");
  const stats = await image.stats();
  const alpha = stats.channels[3];
  const visibleChannels = stats.channels.slice(0, 3);
  const blankTransparent = alpha && alpha.max === 0;
  const blankWhite = stats.entropy < 0.0001 && visibleChannels.length >= 3 && visibleChannels.every((channel) => channel.min >= 250);
  if (blankTransparent || blankWhite) throw new Error("Refusing to insert a blank image");

  const buffer = await image.flatten({ background: "#ffffff" }).png().toBuffer();
  const imageId = workbook.addImage({ buffer, extension: "png" });
  worksheet.addImage(imageId, `${from}:${to}`);
  const current = INSERTED_IMAGE_SPECS.get(workbook) ?? [];
  const record = {
    sheet: worksheet.name,
    source: sourcePath,
    sourceSha256: await fileSha256(sourcePath),
    sourceWidth: metadata.width,
    sourceHeight: metadata.height,
    anchor: { from, to },
  };
  current.push(record);
  INSERTED_IMAGE_SPECS.set(workbook, current);
  return structuredClone(record);
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
  const formula = formulaDescriptor(cell);
  if (formula) {
    const result = rawFormulaResult(cell);
    if (result instanceof Date) return safeDateIso(result)?.slice(0, 10) ?? "<Invalid Date>";
    return result === null || result === undefined ? "" : String(result);
  }
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

const CJK_TEXT_PATTERN = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u;
const LATIN_ONLY_CJK_FONTS = new Set(["arial", "calibri", "aptos", "times new roman", "linux libertine g", "courier new"]);

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

function rawFormulaResult(cell, value = cell?.value) {
  return value && typeof value === "object" && Object.hasOwn(value, "result") ? value.result : cell?.result;
}

function formulaDescriptor(cell) {
  const value = cell.value;
  if (!value || typeof value !== "object") return null;
  if (!("formula" in value) && !("sharedFormula" in value)) return null;
  const result = rawFormulaResult(cell, value);
  return {
    address: cell.address,
    formula: value.formula ?? null,
    sharedFormula: value.sharedFormula ?? null,
    result: serializableValue(result),
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
          { source: "formula_result", value: formula ? rawFormulaResult(cell) : null },
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
  const validationRanges = Object.keys(worksheet.dataValidations?.model ?? {}).filter((range) => worksheet.dataValidations.model[range]);
  return {
    name: worksheet.name,
    state: worksheet.state,
    rowCount: worksheet.rowCount,
    actualRowCount: worksheet.actualRowCount,
    columnCount: worksheet.columnCount,
    actualColumnCount: worksheet.actualColumnCount,
    mergedRanges: Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [],
    tables: tableSummaries(worksheet),
    autoFilter: serializableValue(worksheet.autoFilter ?? null),
    dataValidations: validationRanges.slice(0, 100),
    conditionalFormatting: (worksheet.conditionalFormattings ?? []).slice(0, 100).map((entry) => entry.ref),
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
      errors: facts.errors,
      missingCachedResults: facts.missingCachedResults,
      invalidReferences: facts.formulaReferencesWithErrors,
    },
    invalidDates: facts.invalidDates,
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

function valuesEqual(actual, expected, tolerance = 0) {
  if (typeof expected === "number") return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expected) && actual instanceof Date && isValidDate(actual)) {
    return actual.toISOString().startsWith(expected);
  }
  if (typeof expected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expected) && typeof actual === "string") {
    return actual.startsWith(expected);
  }
  return String(actual ?? "") === String(expected ?? "");
}

function effectiveCellValue(cell) {
  return cell && formulaDescriptor(cell) ? rawFormulaResult(cell) : cell?.value;
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

function collectCjkFontWarnings(workbook) {
  const warnings = [];
  for (const worksheet of workbook.worksheets) {
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = displayCellText(cell);
        if (!CJK_TEXT_PATTERN.test(text)) return;
        const name = cell.font?.name;
        if (name && LATIN_ONLY_CJK_FONTS.has(name.toLowerCase()) && warnings.length < 100) {
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

async function auditXlsx(filePath) {
  const packageInfo = await inspectPackage(filePath);
  const workbook = await loadXlsx(filePath);
  const facts = collectWorkbookFacts(workbook);
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
  if (cjkFontWarnings.length > 0) warnings.push({ type: "cjk_font_fallback", cells: cjkFontWarnings });
  if (packageInfo.unsafeForRoundTrip) {
    advisories.push({ type: "future_round_trip_risk", features: packageInfo.roundTripRisks });
  }
  const hardFailures = [
    ...facts.errors.map((error) => ({ type: "formula_error", ...error })),
    ...facts.missingCachedResults.map((error) => ({ type: "missing_cached_formula_result", ...error })),
    ...facts.formulaReferencesWithErrors.map((error) => ({ type: "invalid_formula_reference", ...error })),
    ...facts.invalidDates.map((error) => ({ type: "invalid_date_value", ...error })),
    ...chartFailures,
    ...packageInfo.compatibility.issues,
  ];
  return {
    status: hardFailures.length > 0 ? "error" : warnings.length > 0 ? "partial" : "ok",
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
    hardFailures,
    warnings,
    advisories,
  };
}

function failureCategory(failure) {
  return failure.type ?? "unknown";
}

function formatFailure(failure) {
  if (String(failure.type).startsWith("chart_")) {
    return `${failure.type} (${failure.chart ?? "chart"}, series ${failure.series ?? 0}): ${JSON.stringify(failure)}`;
  }
  const location = [failure.sheet, failure.range ?? failure.address ?? failure.cell].filter(Boolean).join("!");
  return `${failure.type}${location ? ` (${location})` : ""}: ${JSON.stringify(failure)}`;
}

function summarizeFailures(failures, maxCategories = 12) {
  const groups = new Map();
  for (const failure of failures ?? []) {
    const category = failureCategory(failure);
    const group = groups.get(category) ?? { count: 0, sample: failure };
    group.count += 1;
    groups.set(category, group);
  }
  const summaries = [...groups.entries()].slice(0, maxCategories).map(([category, group]) => (
    `${category} ×${group.count}: ${formatFailure(group.sample)}`
  ));
  if (groups.size > maxCategories) summaries.push(`${groups.size - maxCategories} additional failure categories; inspect the build report for full details`);
  return summaries.join("; ");
}

function summarizeAuditFailures(audit) {
  return summarizeFailures(audit.hardFailures);
}

async function auditDelimited(filePath) {
  const report = await inspectDelimited(filePath, { "max-rows": 5, "max-cols": 20 });
  const failures = [];
  const warnings = [];
  if (report.inconsistentRowWidths) warnings.push({ type: "inconsistent_row_widths" });
  if (report.rowCount === 0) warnings.push({ type: "empty_file" });
  return {
    status: failures.length > 0 ? "error" : warnings.length > 0 ? "partial" : "ok",
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
    throw unsupported("libreoffice-unavailable", "LibreOffice was not found. Install LibreOffice or expose soffice on PATH.");
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
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Refusing to overwrite the legacy source workbook");
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
    ExcelJS: guardedExcelJsApi(),
    inputPath: inputPath ? path.resolve(inputPath) : null,
    createWorkbook,
    loadWorkbook,
    loadXlsx,
    loadDelimited,
    helpers: {
      addConditionalFormatting,
      addImage,
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
    insertedImages: INSERTED_IMAGE_SPECS.get(workbook) ?? [],
  };
}

async function commandScaffold(options) {
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet builder");
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet scaffold report")
    : null;
  assertDistinctArtifactPaths({ builder: outputPath, report: reportPath });
  const starter = path.join(skillRoot, "assets", "starter-workbook.mjs");
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing builder: ${outputPath}`);
  await ensureParent(outputPath);
  await fs.copyFile(starter, outputPath);
  await emitReport({ status: "ok", output: path.resolve(outputPath) }, reportPath);
}

function capabilitiesReport() {
  return {
    status: "ok",
    protocolVersion: 3,
    resultStatuses: RESULT_STATUSES,
    capabilityStates: CAPABILITY_STATES,
    outputPolicy: {
      mutationOutputsAreInternalCandidates: true,
      finalOutputRequiresCommand: "deliver",
      deliveryRequiresMatchingCandidateSha256: true,
      sourceReplacement: "blocked",
      existingOutputsBlockedByDefault: true,
    },
    styleGuidance: {
      defaultWhenUnspecified: "restrained-neutral",
      decisionMaker: "model",
      helperDefaults: "neutral-and-overridable",
    },
    operations: {
      inspect: { status: "supported", formats: ["xlsx", "xls", "csv", "tsv"] },
      createAndEdit: {
        status: "supported",
        command: "build",
        existingWorkbookRoundTrip: "partial",
        reason: "Existing workbooks with charts, pivots, drawings, external links, connections, macros, signatures, or active content are unsafe for a generic ExcelJS round trip.",
      },
      nativeCharts: { status: "supported", types: ["line", "column", "bar"], helper: "addNativeChart" },
      rasterImages: { status: "supported", formats: ["png", "jpeg", "webp", "tiff"], helper: "addImage" },
      scatterAreaComboPieCharts: { status: "fallback", command: "fallback-patch" },
      pivotTablesExternalConnectionsPowerQuery: { status: "unsupported", fallback: "Create a companion workbook without mutating the source package." },
      macrosSignaturesEncryptionActiveX: { status: "blocked" },
      controlledFallback: { status: "supported", command: "fallback-patch", directUntrackedPackageMutation: "blocked" },
      review: { status: "supported", command: "review", multimodalRender: true, revisionDirectories: true, structuralEvidence: true, verdict: "model" },
      evaluate: { status: "supported", command: "evaluate", taskSpecificScript: true, sourceReread: true, verdict: "model-authored-checks" },
      delivery: { status: "supported", command: "deliver", candidateDigestBinding: true },
    },
  };
}

async function commandCapabilities(options = {}) {
  const full = capabilitiesReport();
  if (options.full) {
    await emitReport(full);
    return;
  }
  if (options.feature) {
    const feature = requireOption(options, "feature");
    if (!Object.hasOwn(full.operations, feature)) throw unsupported("capability-not-found", `No capability is declared for '${feature}'`, { available: Object.keys(full.operations) });
    await emitReport({ status: "ok", protocolVersion: full.protocolVersion, feature, capability: full.operations[feature] });
    return;
  }
  await emitReport({
    status: "ok",
    protocolVersion: full.protocolVersion,
    workflow: ["inspect", "build", "review", "evaluate", "deliver"],
    review: "Use model judgment over rendered pages and structural facts; add a task-specific evaluator when source fidelity or calculations need stronger evidence.",
    next: "Use the simplest capability that supplies enough evidence for the current task; add --full only for capability debugging.",
  });
}

function schemaFor(command) {
  const schemas = {
    "native-chart": {
      required: ["sheet", "type", "categories", "series", "anchor"],
      types: ["line", "column", "bar"],
      seriesRequired: ["name", "values"],
      anchorRequired: ["from", "to"],
    },
    image: {
      helper: "await helpers.addImage(workbook, spec)",
      required: ["sheet", "path", "anchor"],
      formats: ["png", "jpeg", "webp", "tiff"],
      anchorRequired: ["from", "to"],
    },
    "fallback-patch": {
      required: ["input", "script", "out", "manifest", "reason", "allow-part"],
      repeatable: ["allow-part"],
      scriptContract: "node patch.mjs --package-dir <temporary-unpacked-xlsx>",
    },
  };
  const schema = schemas[command];
  if (!schema) throw unsupported("schema-not-found", `No spreadsheet schema is declared for '${command}'`, { available: Object.keys(schemas) });
  return { status: "ok", command, schema };
}

async function commandSchema(options) {
  await emitReport(schemaFor(requireOption(options, "command")));
}

function safePackageEntryName(entryName) {
  const normalized = entryName.replaceAll("\\", "/");
  return normalized
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && !path.isAbsolute(normalized);
}

async function unpackXlsxToDirectory(inputPath, packageDir) {
  const zip = await JSZip.loadAsync(await fs.readFile(inputPath));
  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (!safePackageEntryName(entryName)) throw blocked("unsafe-package-path", `Unsafe XLSX package entry: ${entryName}`);
    const target = path.join(packageDir, ...entryName.split("/"));
    if (entry.dir) await fs.mkdir(target, { recursive: true });
    else {
      await ensureParent(target);
      await fs.writeFile(target, await entry.async("nodebuffer"));
    }
  }
}

async function packageFileHashes(packageDir) {
  const hashes = new Map();
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw blocked("fallback-symlink", "Fallback package scripts may not create symbolic links");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path.relative(packageDir, absolute).split(path.sep).join("/");
        if (!safePackageEntryName(relative)) throw blocked("unsafe-package-path", `Unsafe fallback output path: ${relative}`);
        hashes.set(relative, await fileSha256(absolute));
      }
    }
  }
  await visit(packageDir);
  return hashes;
}

function packageChanges(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

function globPatternMatches(pattern, value) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`).test(value);
}

async function repackDirectoryToXlsx(packageDir, outputPath) {
  const zip = new JSZip();
  const hashes = await packageFileHashes(packageDir);
  for (const entryName of [...hashes.keys()].sort()) {
    zip.file(entryName, await fs.readFile(path.join(packageDir, ...entryName.split("/"))));
  }
  await ensureParent(outputPath);
  await fs.writeFile(outputPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function commandFallbackPatch(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const scriptPath = assertInternalArtifactPath(requireOption(options, "script"), "Spreadsheet fallback script");
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet fallback candidate");
  const manifestPath = assertInternalArtifactPath(requireOption(options, "manifest"), "Spreadsheet fallback manifest");
  assertDistinctArtifactPaths({ input: inputPath, script: scriptPath, candidate: outputPath, manifest: manifestPath });
  const reason = requireOption(options, "reason").trim();
  const allowParts = optionValues(options, "allow-part");
  if (!reason) throw new Error("--reason must explain the missing standard capability");
  if (allowParts.length === 0) throw new Error("fallback-patch requires at least one --allow-part");
  if (workbookExtension(inputPath) !== ".xlsx" || workbookExtension(outputPath) !== ".xlsx") throw new Error("fallback-patch requires .xlsx input and output");
  if (!(await pathExists(inputPath))) throw new Error(`Fallback input not found: ${inputPath}`);
  if (!(await pathExists(scriptPath))) throw new Error(`Fallback script not found: ${scriptPath}`);
  if (!/[.]mjs$/i.test(scriptPath)) throw new Error("Fallback scripts must be JavaScript ES modules (.mjs)");
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Fallback output must be distinct from input");
  if (await pathExists(outputPath)) throw blocked("fallback-output-exists", "Refusing to overwrite an existing fallback candidate", { output: outputPath });

  const packageInfo = await inspectPackage(inputPath);
  const forbiddenFeatures = ["macros", "activeX", "signatures", "embeddings"].filter((feature) => packageInfo.features[feature] > 0);
  if (forbiddenFeatures.length > 0) {
    throw blocked("fallback-active-content", "Controlled fallback cannot mutate a workbook containing active, signed, or embedded content", { features: forbiddenFeatures });
  }
  const forbiddenPart = /^(?:_xmlsignatures\/|xl\/(?:vbaProject[.]bin|activeX\/|embeddings\/))/i;
  if (allowParts.some((pattern) => forbiddenPart.test(pattern.replaceAll("*", "")))) {
    throw blocked("fallback-forbidden-part", "The fallback allowlist includes a forbidden active-content part", { allowParts });
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-fallback-"));
  const packageDir = path.join(tempRoot, "package");
  const stagedOutput = path.join(tempRoot, "candidate.xlsx");
  let manifest;
  try {
    await fs.mkdir(packageDir, { recursive: true });
    await unpackXlsxToDirectory(inputPath, packageDir);
    const before = await packageFileHashes(packageDir);
    const safeEnvironment = {};
    for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SYSTEMROOT", "WINDIR"]) {
      if (process.env[key]) safeEnvironment[key] = process.env[key];
    }
    let scriptResult;
    try {
      scriptResult = await execFileAsync(process.execPath, [scriptPath, "--package-dir", packageDir], {
        cwd: path.dirname(scriptPath),
        env: safeEnvironment,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      manifest = {
        status: "error",
        protocol: "pilotdeck-spreadsheet-fallback/v1",
        reason,
        input: inputPath,
        script: scriptPath,
        scriptSha256: await fileSha256(scriptPath),
        allowParts,
        error: error instanceof Error ? error.message : String(error),
        stdout: String(error?.stdout ?? "").slice(0, 8000),
        stderr: String(error?.stderr ?? "").slice(0, 8000),
      };
      await writeJson(manifestPath, manifest);
      throw new Error(`Fallback script failed: ${manifest.error}`);
    }
    const after = await packageFileHashes(packageDir);
    const changedParts = packageChanges(before, after);
    const outsideAllowlist = changedParts.filter((name) => !allowParts.some((pattern) => globPatternMatches(pattern, name)));
    const forbiddenChanges = changedParts.filter((name) => forbiddenPart.test(name));
    if (outsideAllowlist.length > 0 || forbiddenChanges.length > 0) {
      manifest = {
        status: "blocked",
        protocol: "pilotdeck-spreadsheet-fallback/v1",
        reason,
        input: inputPath,
        script: scriptPath,
        scriptSha256: await fileSha256(scriptPath),
        allowParts,
        changedParts,
        outsideAllowlist,
        forbiddenChanges,
        stdout: String(scriptResult.stdout ?? "").slice(0, 8000),
        stderr: String(scriptResult.stderr ?? "").slice(0, 8000),
      };
      await writeJson(manifestPath, manifest);
      throw blocked("fallback-scope-exceeded", "Fallback changed XLSX parts outside its declared allowlist", manifest);
    }
    if (changedParts.length === 0) {
      manifest = {
        status: "partial",
        protocol: "pilotdeck-spreadsheet-fallback/v1",
        reason,
        input: inputPath,
        script: scriptPath,
        scriptSha256: await fileSha256(scriptPath),
        allowParts,
        changedParts,
        next: "Correct the fallback script; a no-op is not success.",
      };
      await writeJson(manifestPath, manifest);
      if (!options.quiet) await emitReport(manifest);
      return;
    }
    await repackDirectoryToXlsx(packageDir, stagedOutput);
    const validationIssues = [];
    let packageInfo = null;
    let audit = null;
    try {
      const stagedZip = await JSZip.loadAsync(await fs.readFile(stagedOutput));
      validationIssues.push(...await collectChangedPackageXmlIssues(stagedZip, changedParts));
      packageInfo = await inspectPackage(stagedOutput);
      validationIssues.push(...packageInfo.compatibility.issues);
      if (validationIssues.length === 0) {
        audit = await auditXlsx(stagedOutput);
        if (audit.worksheetCount === 0) validationIssues.push({ type: "missing_worksheets" });
        validationIssues.push(...audit.hardFailures);
      }
    } catch (error) {
      validationIssues.push({
        type: "package_validation_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (validationIssues.length > 0) {
      manifest = {
        status: "blocked",
        protocol: "pilotdeck-spreadsheet-fallback/v1",
        reason,
        input: inputPath,
        script: scriptPath,
        scriptSha256: await fileSha256(scriptPath),
        allowParts,
        changedParts,
        validation: { status: "error", issues: validationIssues },
        stdout: String(scriptResult.stdout ?? "").slice(0, 8000),
        stderr: String(scriptResult.stderr ?? "").slice(0, 8000),
      };
      await writeJson(manifestPath, manifest);
      throw blocked("fallback-invalid-package", "Fallback produced an invalid spreadsheet package", manifest);
    }
    await replaceFileAtomically(stagedOutput, outputPath);
    manifest = {
      status: "ok",
      protocol: "pilotdeck-spreadsheet-fallback/v1",
      reason,
      input: inputPath,
      inputSha256: await fileSha256(inputPath),
      script: scriptPath,
      scriptSha256: await fileSha256(scriptPath),
      allowParts,
      changedParts,
      output: outputPath,
      outputSha256: await fileSha256(outputPath),
      validation: {
        status: "ok",
        issues: [],
        compatibility: packageInfo.compatibility,
        auditStatus: audit.status,
      },
      stdout: String(scriptResult.stdout ?? "").slice(0, 8000),
      stderr: String(scriptResult.stderr ?? "").slice(0, 8000),
    };
    await writeJson(manifestPath, manifest);
    if (!options.quiet) await emitReport(manifest);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
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

async function commandBuildCore(options) {
  const builderPath = assertInternalArtifactPath(
    requireOption(options, "builder"),
    "Spreadsheet builder",
  );
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet candidate");
  const inputPath = options.input ? requireOption(options, "input") : null;
  const outputExtension = assertSupportedOutput(outputPath);

  if (inputPath) {
    assertSupportedInput(inputPath);
    if (pathsReferToSameLocation(inputPath, outputPath)) {
      throw new Error("Refusing to overwrite the input spreadsheet. Choose a distinct --out path.");
    }
    if (workbookExtension(inputPath) === ".xlsx") {
      const packageInfo = await inspectPackage(inputPath);
      if (packageInfo.unsafeForRoundTrip && !options["allow-risky-roundtrip"]) {
        const names = packageInfo.roundTripRisks.map((risk) => `${risk.feature}(${risk.count})`).join(", ");
        throw blocked(
          "unsafe-workbook-round-trip",
          `Input workbook contains objects that are unsafe for an ExcelJS round trip: ${names}`,
          { risks: packageInfo.roundTripRisks, next: "Preserve the source and create a companion workbook, or obtain explicit approval for the listed losses." },
        );
      }
    }
  }

  const { workbook, sheetName, nativeCharts, insertedImages } = await runStage(
    "builder_execution",
    () => buildFromBuilder(builderPath, inputPath),
  );
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  await runStage("builder_validation", async () => validateWorkbookForSerialization(workbook, nativeCharts));
  const facts = collectWorkbookFacts(workbook);

  if (outputExtension === ".csv" || outputExtension === ".tsv") {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-delimited-build-"));
    try {
      const stagedPath = path.join(tempRoot, `candidate${outputExtension}`);
      await exportDelimited(workbook, stagedPath, options.sheet ? String(options.sheet) : sheetName, options.encoding ? String(options.encoding) : "utf8-bom");
      const audit = await auditDelimited(stagedPath);
      await replaceFileAtomically(stagedPath, outputPath);
      const report = { status: audit.status, output: path.resolve(outputPath), format: outputExtension.slice(1), audit };
      if (!options.quiet) await emitReport(report, options.report && String(options.report));
      else if (options.report) await writeJson(String(options.report), report);
      return report;
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-spreadsheet-build-"));
  const rawPath = path.join(tempRoot, "raw.xlsx");
  const stagedPath = path.join(tempRoot, "candidate.xlsx");
  let audit = null;
  try {
    await runStage("workbook_serialization", () => workbook.xlsx.writeFile(rawPath));
    let recalculated = false;
    if (facts.formulaCount > 0) {
      await runStage("formula_recalculation", () => recalculateWorkbook(rawPath, stagedPath));
      recalculated = true;
    } else {
      await fs.copyFile(rawPath, stagedPath);
    }
    const tableNormalization = await runStage("table_normalization", () => normalizeGeneratedTablePackage(stagedPath));
    const chartResult = await runStage("chart_injection", () => injectNativeCharts(stagedPath, nativeCharts, { JSZip, loadXlsx }));
    audit = await runStage("audit", () => auditXlsx(stagedPath));
    if (audit.status === "error") {
      throw new SpreadsheetStageError(
        "audit",
        `Workbook failed formula, structure, or package compatibility audit; the candidate output was not updated. ${summarizeAuditFailures(audit)}`,
      );
    }
    await replaceFileAtomically(stagedPath, outputPath);
    const reportedAudit = { ...audit, path: path.resolve(outputPath) };
    const report = {
      status: audit.status,
      output: path.resolve(outputPath),
      formulaCount: facts.formulaCount,
      recalculated,
      nativeCharts: chartResult,
      tableNormalization,
      insertedImages,
      audit: reportedAudit,
    };
    if (!options.quiet) await emitReport(report, options.report && String(options.report));
    else if (options.report) await writeJson(String(options.report), report);
    return report;
  } catch (error) {
    const failedDir = assertInternalArtifactPath(`${outputPath}.failed`, "Failed spreadsheet build artifacts");
    let failedArtifacts = null;
    try {
      await fs.rm(failedDir, { recursive: true, force: true });
      await fs.mkdir(failedDir, { recursive: true });
      const files = {};
      if (await pathExists(rawPath)) {
        files.raw = path.join(failedDir, "raw.xlsx");
        await fs.copyFile(rawPath, files.raw);
      }
      if (await pathExists(stagedPath)) {
        files.staged = path.join(failedDir, "staged.xlsx");
        await fs.copyFile(stagedPath, files.staged);
      }
      if (audit) {
        files.audit = path.join(failedDir, "audit.json");
        await writeJson(files.audit, audit);
      }
      failedArtifacts = { directory: failedDir, files };
    } catch (artifactError) {
      failedArtifacts = { directory: failedDir, error: artifactError instanceof Error ? artifactError.message : String(artifactError) };
    }
    const report = {
      status: "error",
      output: path.resolve(outputPath),
      outputUpdated: false,
      stage: error instanceof SpreadsheetStageError ? error.stage : "build",
      error: error instanceof Error ? error.message : String(error),
      ...(audit ? { audit, failureSummary: summarizeAuditFailures(audit) } : {}),
      failedArtifacts,
    };
    if (failedArtifacts?.directory && !failedArtifacts.error) {
      const artifactReport = path.join(failedArtifacts.directory, "report.json");
      await writeJson(artifactReport, report);
      failedArtifacts.files.report = artifactReport;
    }
    if (options.report) await writeJson(String(options.report), report);
    if (error instanceof SpreadsheetStageError) error.details = { ...error.details, report: options.report, failedArtifacts };
    throw error;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandBuild(options) {
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet candidate");
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet build report")
    : assertInternalArtifactPath(`${outputPath}.build-report.json`, "Spreadsheet build report");
  const builderPath = assertInternalArtifactPath(requireOption(options, "builder"), "Spreadsheet builder");
  const inputPath = options.input ? path.resolve(requireOption(options, "input")) : null;
  assertDistinctArtifactPaths({ builder: builderPath, input: inputPath, candidate: outputPath, report: reportPath });
  try {
    return await commandBuildCore({ ...options, report: reportPath });
  } catch (error) {
    if (!(await pathExists(reportPath))) {
      await writeJson(reportPath, {
        status: "error",
        output: path.resolve(outputPath),
        outputUpdated: false,
        stage: error instanceof SpreadsheetStageError ? error.stage : "build",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (error instanceof SpreadsheetStageError) error.details = { ...error.details, report: reportPath };
    throw error;
  }
}

async function inspectSpreadsheet(inputPath, options = {}) {
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
  return report;
}

async function commandInspect(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const reportPath = options.out
    ? assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet inspection report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, report: reportPath });
  const report = await inspectSpreadsheet(inputPath, options);
  await emitReport(report, reportPath);
}

function readRangeMatrix(workbook, sheetName, rangeRef, { typed = false } = {}) {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new Error(`Worksheet not found: ${sheetName}`);
  const bounds = parseRangeReference(rangeRef);
  const matrix = [];
  for (let row = bounds.startRow; row <= bounds.endRow; row += 1) {
    const values = [];
    for (let column = bounds.startCol; column <= bounds.endCol; column += 1) {
      const cell = worksheet.getCell(row, column);
      const formula = formulaDescriptor(cell);
      const value = effectiveCellValue(cell);
      values.push(typed ? {
        address: cell.address,
        value: serializableValue(value),
        type: cellValueType(cell),
        formula: formula?.formula ?? null,
        numberFormat: cell.numFmt ?? null,
      } : serializableValue(value));
    }
    matrix.push(values);
  }
  return matrix;
}

function compareMatrices(actual, expected, { tolerance = 0, maxMismatches = 100 } = {}) {
  const mismatches = [];
  const rowCount = Math.max(actual?.length ?? 0, expected?.length ?? 0);
  for (let row = 0; row < rowCount; row += 1) {
    const actualRow = actual?.[row] ?? [];
    const expectedRow = expected?.[row] ?? [];
    const columnCount = Math.max(actualRow.length, expectedRow.length);
    for (let column = 0; column < columnCount; column += 1) {
      if (valuesEqual(actualRow[column], expectedRow[column], tolerance)) continue;
      if (mismatches.length < maxMismatches) {
        mismatches.push({ row: row + 1, column: column + 1, expected: expectedRow[column] ?? null, actual: actualRow[column] ?? null });
      }
    }
  }
  return {
    passed: mismatches.length === 0,
    actualShape: [actual?.length ?? 0, Math.max(0, ...(actual ?? []).map((row) => row.length))],
    expectedShape: [expected?.length ?? 0, Math.max(0, ...(expected ?? []).map((row) => row.length))],
    mismatches,
  };
}

async function commandEvaluate(options) {
  const inputPath = assertInternalArtifactPath(requireOption(options, "input"), "Spreadsheet candidate");
  const scriptPath = assertInternalArtifactPath(requireOption(options, "script"), "Spreadsheet evaluator");
  const reportPath = options.out
    ? assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet evaluation report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, evaluator: scriptPath, report: reportPath });
  const evaluatorUrl = `${pathToFileURL(path.resolve(scriptPath)).href}?pilotdeck=${Date.now()}`;
  const module = await import(evaluatorUrl);
  if (typeof module.default !== "function") throw new Error("The evaluator must export a default async function");
  const candidate = await loadWorkbook(inputPath, { inferTypes: true });
  const product = await module.default({
    inputPath: path.resolve(inputPath),
    candidate,
    loadWorkbook,
    loadXlsx,
    loadDelimited,
    helpers: {
      readRange: (workbook, sheet, range) => readRangeMatrix(workbook, sheet, range),
      readTypedRange: (workbook, sheet, range) => readRangeMatrix(workbook, sheet, range, { typed: true }),
      compareMatrices,
    },
  });
  if (!product || typeof product !== "object" || Array.isArray(product) || !Array.isArray(product.checks)) {
    throw new Error("The evaluator must return { checks: [{ name, passed, ...details }], ...optionalEvidence }");
  }
  const checks = product.checks.map((check, index) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error(`Evaluator checks[${index}] must be an object`);
    const name = String(check.name ?? "").trim();
    if (!name || typeof check.passed !== "boolean") throw new Error(`Evaluator checks[${index}] requires a name and boolean passed value`);
    return { ...serializableValue(check), name, passed: check.passed };
  });
  const failed = checks.filter((check) => !check.passed);
  const report = {
    ...serializableValue(product),
    status: checks.length === 0 ? "partial" : failed.length > 0 ? "error" : "ok",
    input: path.resolve(inputPath),
    evaluator: { path: path.resolve(scriptPath), sha256: await fileSha256(scriptPath) },
    checks,
    failed,
  };
  if (!options.quiet) await emitReport(report, reportPath);
  else if (reportPath) await writeJson(reportPath, report);
  if (report.status === "error") process.exitCode = 1;
  return report;
}

async function commandAudit(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const reportPath = options.out
    ? assertInternalArtifactPath(requireOption(options, "out"), "Spreadsheet audit report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, report: reportPath });
  const extension = assertSupportedInput(inputPath);
  const report = await runStage(
    "audit",
    () => extension === ".xlsx" ? auditXlsx(inputPath) : auditDelimited(inputPath),
  );
  await emitReport(report, reportPath);
  if (report.status === "error") process.exitCode = 1;
}

async function commandConvertLegacy(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Converted spreadsheet candidate");
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet conversion report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, candidate: outputPath, report: reportPath });
  const report = await convertLegacyXls(inputPath, outputPath);
  if (!options.quiet) await emitReport(report, reportPath);
  else if (reportPath) await writeJson(reportPath, report);
}

async function commandRecalculate(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const outputPath = assertInternalArtifactPath(requireOption(options, "out"), "Recalculated spreadsheet candidate");
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet recalculation report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, candidate: outputPath, report: reportPath });
  if (workbookExtension(inputPath) !== ".xlsx" || workbookExtension(outputPath) !== ".xlsx") {
    throw new Error("recalculate accepts .xlsx input and output only");
  }
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Refusing to overwrite the input workbook");
  const packageInfo = await inspectPackage(inputPath);
  if (packageInfo.unsafeForRoundTrip && !options["allow-risky-roundtrip"]) {
    const names = packageInfo.roundTripRisks.map((risk) => `${risk.feature}(${risk.count})`).join(", ");
    throw blocked(
      "unsafe-libreoffice-round-trip",
      `Input workbook contains objects that are unsafe for a LibreOffice round trip: ${names}`,
      { risks: packageInfo.roundTripRisks, next: "Preserve the source unless the user explicitly accepts the listed compatibility risks." },
    );
  }
  const result = await runStage("formula_recalculation", () => recalculateWorkbook(inputPath, outputPath));
  const audit = await runStage("audit", () => auditXlsx(outputPath));
  await emitReport({ status: audit.status, ...result, audit }, reportPath);
  if (audit.status === "error") process.exitCode = 1;
}

function naturalPageSort(left, right) {
  const leftNumber = Number(left.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  const rightNumber = Number(right.match(/(\d+)(?=\.png$)/)?.[1] ?? 0);
  return leftNumber - rightNumber || left.localeCompare(right);
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

async function renderWorkbook(inputPath, outputDir, { pdfPath, perSheet = false, sheetNames = null } = {}) {
  const renderer = findRenderer();
  if (!renderer) throw unsupported("pdf-renderer-unavailable", "No PDF renderer was found. Install pdftoppm, mutool, or ImageMagick.");
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
      if (/^page-?\d+\.png$/i.test(name) || /^montage\.png$/i.test(name)) {
        await fs.rm(path.join(outputDir, name), { force: true });
      } else if (perSheet && /^sheet-\d+$/i.test(name)) {
        await fs.rm(path.join(outputDir, name), { recursive: true, force: true });
      }
    }
    const xlsxInput = await convertToXlsxForRender(inputPath, tempRoot);
    if (perSheet) {
      const workbook = await loadXlsx(xlsxInput);
      const sheetReports = [];
      const allPages = [];
      const requestedSheetNames = Array.isArray(sheetNames) ? [...new Set(sheetNames)] : null;
      const worksheets = requestedSheetNames
        ? requestedSheetNames.map((name) => workbook.getWorksheet(name)).filter(Boolean)
        : workbook.worksheets;
      if (requestedSheetNames && worksheets.length !== requestedSheetNames.length) {
        const missing = requestedSheetNames.filter((name) => !workbook.getWorksheet(name));
        throw new Error(`Visual review references missing worksheet(s): ${missing.join(", ")}`);
      }
      for (const worksheet of worksheets) {
        const workbookSheetIndex = workbook.worksheets.indexOf(worksheet) + 1;
        const sheetIdentifier = String(workbookSheetIndex).padStart(2, "0");
        const singlePath = path.join(tempRoot, `sheet-${sheetIdentifier}.xlsx`);
        const sheetOutput = path.join(outputDir, `sheet-${sheetIdentifier}`);
        await createSingleSheetPackage(xlsxInput, singlePath, worksheet.name);
        const report = await renderWorkbook(singlePath, sheetOutput, {});
        sheetReports.push({ sheet: worksheet.name, ...report });
        allPages.push(...report.pages);
      }
      return {
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
    return {
      pdf: path.resolve(finalPdf),
      pages: pages.map((page) => path.resolve(page)),
      pageCount: pages.length,
      pageStats,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function commandRender(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const outputDir = assertInternalArtifactPath(requireOption(options, "out-dir"), "Spreadsheet render directory");
  const pdfPath = options.pdf
    ? assertInternalArtifactPath(requireOption(options, "pdf"), "Spreadsheet render PDF")
    : null;
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet render report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, directory: outputDir, pdf: pdfPath, report: reportPath });
  assertSupportedInput(inputPath, { legacy: true });
  const rendered = await renderWorkbook(inputPath, outputDir, {
    pdfPath: pdfPath ?? undefined,
    perSheet: Boolean(options["per-sheet"]),
  });
  const blankPages = rendered.pageStats.filter((page) => page.blank);
  await emitReport({ status: blankPages.length > 0 ? "partial" : "ok", input: path.resolve(inputPath), blankPages, ...rendered }, reportPath);
}

async function commandReview(options) {
  const inputPath = path.resolve(requireOption(options, "input"));
  const outputDir = assertInternalArtifactPath(requireOption(options, "out-dir"), "Spreadsheet review directory");
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet review report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, directory: outputDir, report: reportPath });
  const candidateSha256 = await fileSha256(inputPath);
  const revisionId = `rev-${candidateSha256.slice(0, 12)}`;
  const evidenceId = `run-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const revisionDir = assertInternalArtifactPath(path.join(outputDir, revisionId, evidenceId), "Spreadsheet review revision directory");
  const sheetNames = [...new Set(optionValues(options, "sheet"))];
  const inspectionOptions = {
    ...(sheetNames[0] ? { sheet: sheetNames[0] } : {}),
    ...(options.range ? { range: String(options.range) } : {}),
    ...(options["max-rows"] ? { "max-rows": options["max-rows"] } : {}),
    ...(options["max-cols"] ? { "max-cols": options["max-cols"] } : {}),
    styles: true,
  };
  const inspection = await runStage("inspection", () => inspectSpreadsheet(inputPath, inspectionOptions));
  let render;
  try {
    const rendered = await runStage("render", () => renderWorkbook(inputPath, revisionDir, {
      perSheet: true,
      sheetNames: sheetNames.length > 0 ? sheetNames : null,
    }));
    const blankPages = rendered.pageStats.filter((page) => page.blank);
    const pages = rendered.sheets.flatMap((sheet) => sheet.pages.map((pagePath, pageIndex) => ({
      sheet: sheet.sheet,
      page: pageIndex + 1,
      path: pagePath,
    })));
    render = {
      status: blankPages.length > 0 ? "partial" : "success",
      directory: revisionDir,
      pages,
      pageCount: pages.length,
    };
  } catch (error) {
    render = {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const evidenceReady = render.status !== "unavailable"
    && Array.isArray(render.pages)
    && render.pages.length > 0;
  const currentSha256 = await fileSha256(inputPath);
  if (currentSha256 !== candidateSha256) {
    throw blocked("spreadsheet-changed-during-review", "The spreadsheet candidate changed while its visual evidence was being generated", {
      expected: candidateSha256,
      actual: currentSha256,
      next: "Run review again for the current candidate revision.",
    });
  }
  const report = {
    status: evidenceReady ? "review_pending" : "evidence_unavailable",
    input: path.resolve(inputPath),
    revision: {
      id: revisionId,
      sha256: candidateSha256,
      directory: revisionDir,
      evidenceId,
    },
    inspection,
    render,
    visualReview: evidenceReady ? {
      status: "pending",
      instruction: `These pages describe ${revisionId}. Choose and open the pages relevant to the task before making visual claims. If you revise the workbook, run review again and inspect the new revision's relevant pages before delivery.`,
    } : {
      status: "unavailable",
      instruction: "Report the rendering limitation; no visual judgment was performed.",
    },
    next: evidenceReady
      ? "Open the current revision's relevant page images and judge them against the task."
      : "Report the rendering limitation; no visual judgment was performed.",
    judgment: "Review the rendered workbook and structural facts against the user's request. This report records evidence and does not make the final product decision.",
  };
  if (!options.quiet) await emitReport(report, reportPath);
  else if (reportPath) await writeJson(reportPath, report);
  return report;
}

async function fileSha256(filePath) {
  return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function commandDirectDeliver(options) {
  const inputPath = assertInternalArtifactPath(requireOption(options, "input"), "Spreadsheet candidate");
  const outputPath = assertDeliveryOutputPath(requireOption(options, "out"));
  const reportPath = options.report
    ? assertInternalArtifactPath(requireOption(options, "report"), "Spreadsheet delivery report")
    : null;
  assertDistinctArtifactPaths({ input: inputPath, deliverable: outputPath, report: reportPath });
  const inputExtension = assertSupportedInput(inputPath);
  const outputExtension = assertSupportedOutput(outputPath);
  if (inputExtension !== outputExtension) {
    throw new Error(`Candidate and deliverable formats must match (${inputExtension} != ${outputExtension})`);
  }
  if (pathsReferToSameLocation(inputPath, outputPath)) throw new Error("Deliverable must be distinct from the candidate workbook");
  if (await pathExists(outputPath)) throw new Error(`Refusing to overwrite existing deliverable: ${outputPath}`);

  const audit = await runStage(
    "audit",
    () => inputExtension === ".xlsx" ? auditXlsx(inputPath) : auditDelimited(inputPath),
  );
  if (audit.status === "error") {
    throw new Error(`Candidate workbook is not safe to deliver. ${summarizeFailures(audit.hardFailures)}`);
  }

  await ensureParent(outputPath);
  const temporaryOutput = path.join(path.dirname(path.resolve(outputPath)), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.copyFile(inputPath, temporaryOutput);
  const candidateSha256 = await fileSha256(inputPath);
  const copiedSha256 = await fileSha256(temporaryOutput);
  if (candidateSha256 !== copiedSha256) {
    await fs.rm(temporaryOutput, { force: true });
    throw new Error("Candidate and deliverable hashes do not match");
  }
  await fs.rename(temporaryOutput, outputPath);
  const finalSha256 = await fileSha256(outputPath);
  if (finalSha256 !== candidateSha256) {
    await fs.rm(outputPath, { force: true });
    throw new Error("Final deliverable hash does not match the reviewed candidate");
  }
  const report = {
    status: "ok",
    output: path.resolve(outputPath),
    sha256: finalSha256,
    candidate: { path: path.resolve(inputPath), sha256: candidateSha256 },
    audit,
  };
  if (!options.quiet) await emitReport(report, reportPath);
  else if (reportPath) await writeJson(reportPath, report);
  return report;
}

async function commandDeliver(options) {
  return commandDirectDeliver(options);
}

async function commandSelfTest(options) {
  const outputDir = options.out
    ? path.resolve(String(options.out))
    : path.join(os.tmpdir(), "pilotdeck-spreadsheets-self-test-" + Date.now());
  const workDir = path.join(outputDir, "work");
  const previousWorkDir = process.env.PILOTDECK_WORK_DIR;
  await fs.mkdir(workDir, { recursive: true });
  process.env.PILOTDECK_WORK_DIR = workDir;

  const steps = [];
  const builderPath = path.join(workDir, "workbook.mjs");
  const candidatePath = path.join(workDir, "candidate.xlsx");
  const reviewDir = path.join(workDir, "review");
  const evaluatorPath = path.join(workDir, "evaluator.mjs");
  const evaluationPath = path.join(workDir, "evaluation.json");
  const fallbackScriptPath = path.join(workDir, "break-chart.mjs");
  const invalidFallbackPath = path.join(workDir, "invalid-fallback.xlsx");
  const invalidFallbackManifestPath = path.join(workDir, "invalid-fallback.json");
  const aliasFallbackPath = path.join(workDir, "alias-fallback.xlsx");
  const validFallbackScriptPath = path.join(workDir, "patch-core-properties.mjs");
  const validFallbackPath = path.join(workDir, "valid-fallback.xlsx");
  const validFallbackManifestPath = path.join(workDir, "valid-fallback.json");
  const finalPath = path.join(outputDir, "final-" + Date.now() + ".xlsx");

  const builderSource = (label) => [
    "export default async function build({ createWorkbook, helpers }) {",
    "  const workbook = createWorkbook();",
    "  const sheet = workbook.addWorksheet('销售', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });",
    "  sheet.addRows([['月份', '销售额', '状态'], ['1月', 100, '完成'], ['2月', 120, '完成'], ['3月', 135, '进行中'], ['合计', { formula: 'SUM(B2:B4)', result: 355 }, '']]);",
    "  helpers.styleHeader(sheet, 'A1:C1');",
    "  helpers.addTableFromRange(sheet, { name: 'SalesTable', range: 'A1:C4' });",
    "  helpers.addListValidation(sheet, 'C2:C4', ['未开始', '进行中', '完成'], { allowBlank: false });",
    "  helpers.addConditionalFormatting(sheet, { range: 'B2:B4', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [110], style: { font: { bold: true } } }] });",
    "  helpers.setNumberFormat(sheet, 'B2:B5', '#,##0');",
    "  helpers.autoFitColumns(sheet, { min: 10, max: 22 });",
    "  helpers.applyChineseTypography(sheet, { platform: 'cross-platform' });",
    "  sheet.getCell('E1').value = " + JSON.stringify(label) + ";",
    "  helpers.addNativeChart(workbook, { sheet: '销售', type: 'line', title: '销售趋势', categories: 'A2:A4', series: [{ name: '销售额', values: 'B2:B4' }], anchor: { from: 'E2', to: 'L16' } });",
    "  const notes = workbook.addWorksheet('说明', { pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 1 } });",
    "  notes.addRows([['说明'], [" + JSON.stringify(label) + "]]);",
    "  helpers.styleHeader(notes, 'A1:A1');",
    "  helpers.autoFitColumns(notes, { min: 12, max: 24 });",
    "  return workbook;",
    "}",
    "",
  ].join("\n");

  try {
    await fs.writeFile(builderPath, builderSource("初版"), "utf8");
    const firstBuild = await commandBuild({ builder: builderPath, out: candidatePath, quiet: true });
    if (firstBuild.status === "error" || !(await pathExists(candidatePath))) {
      throw new Error("Core build did not produce a candidate workbook");
    }
    if (firstBuild.audit.hardFailures.length > 0
      || !Array.isArray(firstBuild.nativeCharts.charts)
      || firstBuild.nativeCharts.charts.length < 1) {
      throw new Error("Core build failed deterministic workbook or native-chart checks");
    }
    steps.push({ name: "build", status: "ok", formulas: firstBuild.formulaCount, charts: firstBuild.nativeCharts.charts.length });

    const inspection = await inspectSpreadsheet(candidatePath, { sheet: "销售", range: "A1:E5", styles: true });
    if (inspection.workbook.worksheetCount !== 2 || inspection.formulas.count < 1) {
      throw new Error("Inspection did not return workbook structure and formulas");
    }
    steps.push({ name: "inspect", status: "ok", worksheets: inspection.workbook.worksheetCount });

    const firstReview = await commandReview({ input: candidatePath, "out-dir": reviewDir, quiet: true });
    if (firstReview.status !== "review_pending" || firstReview.render.pages.length === 0) {
      throw new Error("Review did not return per-page visual evidence");
    }

    await fs.writeFile(builderPath, builderSource("复核版"), "utf8");
    const secondBuild = await commandBuild({ builder: builderPath, out: candidatePath, quiet: true });
    const secondReview = await commandReview({ input: candidatePath, "out-dir": reviewDir, quiet: true });
    if (secondBuild.status === "error"
      || secondReview.status !== "review_pending"
      || firstReview.revision.sha256 === secondReview.revision.sha256
      || firstReview.revision.directory === secondReview.revision.directory
      || secondReview.render.pages.some((page) => !isInsidePath(page.path, secondReview.revision.directory))
      || Object.hasOwn(secondReview.render, "montage")
      || await pathExists(path.join(reviewDir, "montage.png"))) {
      throw new Error("Review evidence is not clean, per-page, and revision-specific");
    }
    steps.push({ name: "review", status: "ok", revisions: [firstReview.revision.id, secondReview.revision.id], pages: secondReview.render.pageCount });

    const salesReview = await commandReview({ input: candidatePath, "out-dir": reviewDir, sheet: "销售", quiet: true });
    const salesPage = salesReview.render.pages[0];
    const salesPageSha256 = await fileSha256(salesPage.path);
    const notesReview = await commandReview({ input: candidatePath, "out-dir": reviewDir, sheet: "说明", quiet: true });
    if (salesReview.revision.sha256 !== notesReview.revision.sha256
      || salesReview.revision.directory === notesReview.revision.directory
      || salesPage.path === notesReview.render.pages[0]?.path
      || salesPage.sheet !== "销售"
      || notesReview.render.pages[0]?.sheet !== "说明"
      || !(await pathExists(salesPage.path))
      || await fileSha256(salesPage.path) !== salesPageSha256) {
      throw new Error("Selective review evidence was overwritten or assigned an unstable worksheet path");
    }
    steps.push({ name: "review-evidence-isolation", status: "ok", revision: salesReview.revision.id });

    const fallbackScriptSource = [
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      "const packageDir = process.argv[process.argv.indexOf('--package-dir') + 1];",
      "await fs.writeFile(path.join(packageDir, 'xl', 'charts', 'chart1.xml'), '<broken', 'utf8');",
      "",
    ].join("\n");
    await fs.writeFile(fallbackScriptPath, fallbackScriptSource, "utf8");
    const candidateSha256BeforeFallback = await fileSha256(candidatePath);
    let aliasBlocked = false;
    try {
      await commandFallbackPatch({
        input: candidatePath,
        script: fallbackScriptPath,
        out: aliasFallbackPath,
        manifest: aliasFallbackPath,
        reason: "self-test path alias",
        "allow-part": "xl/charts/chart*.xml",
        quiet: true,
      });
    } catch (error) {
      aliasBlocked = error instanceof SpreadsheetProtocolError && error.code === "artifact-path-conflict";
    }
    if (!aliasBlocked || await pathExists(aliasFallbackPath) || await fileSha256(candidatePath) !== candidateSha256BeforeFallback) {
      throw new Error("Aliased fallback output and manifest paths were not blocked before mutation");
    }

    let invalidPackageBlocked = false;
    try {
      await commandFallbackPatch({
        input: candidatePath,
        script: fallbackScriptPath,
        out: invalidFallbackPath,
        manifest: invalidFallbackManifestPath,
        reason: "self-test malformed chart XML",
        "allow-part": "xl/charts/chart*.xml",
        quiet: true,
      });
    } catch (error) {
      invalidPackageBlocked = error instanceof SpreadsheetProtocolError && error.code === "fallback-invalid-package";
    }
    const invalidManifest = JSON.parse(await fs.readFile(invalidFallbackManifestPath, "utf8"));
    if (!invalidPackageBlocked
      || await pathExists(invalidFallbackPath)
      || invalidManifest.status !== "blocked"
      || !invalidManifest.validation?.issues?.some((issue) => issue.type === "malformed_package_xml")
      || await fileSha256(candidatePath) !== candidateSha256BeforeFallback) {
      throw new Error("Malformed fallback chart XML was not rejected without updating the candidate");
    }
    const validFallbackScriptSource = [
      "import fs from 'node:fs/promises';",
      "import path from 'node:path';",
      "const packageDir = process.argv[process.argv.indexOf('--package-dir') + 1];",
      "const target = path.join(packageDir, 'docProps', 'core.xml');",
      "const xml = await fs.readFile(target, 'utf8');",
      "await fs.writeFile(target, xml.replace('</cp:coreProperties>', '<cp:keywords>self-test</cp:keywords></cp:coreProperties>'), 'utf8');",
      "",
    ].join("\n");
    await fs.writeFile(validFallbackScriptPath, validFallbackScriptSource, "utf8");
    await commandFallbackPatch({
      input: candidatePath,
      script: validFallbackScriptPath,
      out: validFallbackPath,
      manifest: validFallbackManifestPath,
      reason: "self-test valid core-properties patch",
      "allow-part": "docProps/core.xml",
      quiet: true,
    });
    const validManifest = JSON.parse(await fs.readFile(validFallbackManifestPath, "utf8"));
    if (validManifest.status !== "ok"
      || validManifest.validation?.status !== "ok"
      || !(await pathExists(validFallbackPath))
      || (await auditXlsx(validFallbackPath)).status === "error") {
      throw new Error("A valid controlled fallback did not pass package validation");
    }
    steps.push({ name: "fallback-safety", status: "ok", checks: ["path-alias", "malformed-chart-xml", "valid-package"] });

    const evaluatorSource = [
      "export default async function evaluate({ candidate, helpers }) {",
      "  const values = helpers.readRange(candidate, '销售', 'A1:B5');",
      "  return { checks: [",
      "    { name: 'sheet exists', passed: Boolean(candidate.getWorksheet('销售')) },",
      "    { name: 'source values preserved', passed: values[1][1] === 100 && values[3][1] === 135 },",
      "    { name: 'formula result', passed: values[4][1] === 355 },",
      "  ] };",
      "}",
      "",
    ].join("\n");
    await fs.writeFile(evaluatorPath, evaluatorSource, "utf8");
    const evaluation = await commandEvaluate({ input: candidatePath, script: evaluatorPath, out: evaluationPath, quiet: true });
    if (evaluation.status !== "ok") throw new Error("Task-specific evaluator did not pass");
    steps.push({ name: "evaluate", status: "ok", checks: evaluation.checks.length });

    const delivery = await commandDeliver({ input: candidatePath, out: finalPath, quiet: true });
    if (delivery.status !== "ok" || !(await pathExists(finalPath)) || await fileSha256(candidatePath) !== await fileSha256(finalPath)) {
      throw new Error("Delivery did not preserve the reviewed candidate bytes");
    }
    steps.push({ name: "deliver", status: "ok", output: finalPath });
  } finally {
    if (previousWorkDir === undefined) delete process.env.PILOTDECK_WORK_DIR;
    else process.env.PILOTDECK_WORK_DIR = previousWorkDir;
  }

  const report = { status: "ok", outputDir, workbook: finalPath, steps };
  await writeJson(path.join(outputDir, "self-test-report.json"), report);
  await emitReport(report);
}

function printHelp() {
  process.stdout.write(`PilotDeck spreadsheets skill\n\nModel-guided workflow:\n  inspect --input book.xlsx [--sheet Sheet1 --range A1:H20 --styles --out report.json]\n  scaffold --out builder.mjs\n  build --builder builder.mjs --out candidate.xlsx [--input source.xlsx]\n  review --input candidate.xlsx --out-dir review [--sheet Sheet1 --report review.json]\n  evaluate --input candidate.xlsx --script evaluator.mjs [--out evaluation.json]\n  deliver --input candidate.xlsx --out final.xlsx [--report delivery.json]\n\nAdditional capabilities:\n  capabilities [--full]\n  schema --command <native-chart|image|fallback-patch>\n  convert-legacy --input source.xls --out converted.xlsx\n  recalculate --input source.xlsx --out recalculated.xlsx\n  audit --input book.xlsx [--out audit.json]\n  render --input book.xlsx --out-dir render [--pdf render.pdf --per-sheet]\n  fallback-patch --input candidate.xlsx --script patch.mjs --out patched.xlsx --manifest fallback.json --reason TEXT --allow-part PART\n  self-test [--out directory]\n`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "capabilities": await commandCapabilities(options); break;
    case "schema": await commandSchema(options); break;
    case "scaffold": await commandScaffold(options); break;
    case "build": await commandBuild(options); break;
    case "fallback-patch": await commandFallbackPatch(options); break;
    case "inspect": await commandInspect(options); break;
    case "evaluate": await commandEvaluate(options); break;
    case "convert-legacy": await commandConvertLegacy(options); break;
    case "recalculate": await commandRecalculate(options); break;
    case "audit": await commandAudit(options); break;
    case "render": await commandRender(options); break;
    case "review": await commandReview(options); break;
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
  const protocolError = error instanceof SpreadsheetProtocolError
    ? error
    : error instanceof SpreadsheetStageError && error.cause instanceof SpreadsheetProtocolError
      ? error.cause
      : null;
  const payload = {
    status: protocolError?.status ?? "error",
    ...(protocolError?.code ? { code: protocolError.code } : {}),
    ...(protocolError?.details && Object.keys(protocolError.details).length > 0 ? { details: protocolError.details } : {}),
    ...(!protocolError && error instanceof SpreadsheetStageError && Object.keys(error.details ?? {}).length > 0 ? { details: error.details } : {}),
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof SpreadsheetStageError ? { stage: error.stage } : {}),
    ...(error instanceof Error && error.cause instanceof Error ? { cause: error.cause.message } : {}),
    ...(error instanceof Error && error.cause instanceof Error && error.cause.stack ? { causeStack: error.cause.stack.split("\n").slice(0, 12) } : {}),
    ...(error instanceof Error && error.stack ? { stack: error.stack.split("\n").slice(0, 8) } : {}),
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
