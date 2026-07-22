import path from "node:path";

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DRAWING_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
const CHART_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const DRAWING_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXml(value) {
  return String(value ?? "")
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function relationshipRecords(xml = "") {
  return Array.from(xml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)).map((match) => {
    const attributes = Object.fromEntries(Array.from(match[1].matchAll(/([\w:.-]+)="([^"]*)"/g)).map((item) => [item[1], unescapeXml(item[2])]));
    return { id: attributes.Id, type: attributes.Type, target: attributes.Target };
  });
}

function relationshipXml(records) {
  const items = records.map((record) => `<Relationship Id="${escapeXml(record.id)}" Type="${escapeXml(record.type)}" Target="${escapeXml(record.target)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}">${items}</Relationships>`;
}

function nextRelationshipId(records) {
  const used = new Set(records.map((record) => record.id));
  let index = 1;
  while (used.has(`rId${index}`)) index += 1;
  return `rId${index}`;
}

function normalizePackageTarget(basePart, target) {
  if (target.startsWith("/")) return target.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePart), target));
}

function relativePackageTarget(basePart, targetPart) {
  return path.posix.relative(path.posix.dirname(basePart), targetPart);
}

function relationshipPart(part) {
  return path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`);
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localName(node) {
  return node?.localName ?? node?.nodeName?.split(":").at(-1) ?? null;
}

function childElements(node) {
  const children = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) children.push(child);
  }
  return children;
}

function descendantElements(node, expectedLocalName) {
  const matches = [];
  const elements = node?.getElementsByTagName?.("*") ?? [];
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements.item(index);
    if (localName(element) === expectedLocalName) matches.push(element);
  }
  return matches;
}

function parseDrawingDocument(xml, DOMParser) {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (!document?.documentElement || localName(document.documentElement) !== "wsDr") return null;
  return document;
}

function drawingAnchors(document) {
  const anchorNames = new Set(["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"]);
  return childElements(document.documentElement).filter((element) => anchorNames.has(localName(element)));
}

function worksheetDrawingIds(xml) {
  return Array.from(xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?drawing\b[^>]*\br:id=(["'])([^"']+)\1[^>]*\/?\s*>/gi)).map((match) => match[2]);
}

function removeWorksheetDrawing(xml, relationshipId) {
  const escapedId = escapeRegularExpression(relationshipId);
  const expression = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?drawing\\b[^>]*\\br:id=(["'])${escapedId}\\1[^>]*/\\s*>`, "gi");
  return xml.replace(expression, "");
}

function removeContentTypeOverride(xml, partName) {
  const escapedPart = escapeRegularExpression(`/${partName}`);
  return xml.replace(new RegExp(`<Override\\b(?=[^>]*\\bPartName=(["'])${escapedPart}\\1)[^>]*/\\s*>`, "gi"), "");
}

async function workbookSheetParts(zip) {
  const workbookPart = zip.file("xl/workbook.xml");
  const workbookRelsPart = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookPart || !workbookRelsPart) throw new Error("The XLSX package is missing workbook relationships");
  const workbookXml = await workbookPart.async("string");
  const workbookRels = relationshipRecords(await workbookRelsPart.async("string"));
  const byId = new Map(workbookRels.map((record) => [record.id, record]));
  const sheets = new Map();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?\s*>/gi)) {
    const attributes = Object.fromEntries(Array.from(match[1].matchAll(/([\w:.-]+)="([^"]*)"/g)).map((item) => [item[1], unescapeXml(item[2])]));
    const relationship = byId.get(attributes["r:id"]);
    if (!relationship?.target || !attributes.name) continue;
    sheets.set(attributes.name, normalizePackageTarget("xl/workbook.xml", relationship.target));
  }
  return sheets;
}

function absoluteRange(sheetName, range) {
  const normalized = String(range).replaceAll("$", "");
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(normalized);
  const actualSheet = match ? (match[1]?.replaceAll("''", "'") ?? match[2]) : sheetName;
  const actualRange = match ? match[3] : normalized;
  const cells = actualRange.split(":").map((cell) => {
    const parsed = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
    if (!parsed) throw new Error(`Unsupported chart range '${range}'`);
    return `$${parsed[1].toUpperCase()}$${parsed[2]}`;
  });
  const escapedSheet = actualSheet.replaceAll("'", "''");
  return `'${escapedSheet}'!${cells.join(":")}`;
}

function parseRange(sheetName, range) {
  const normalized = String(range).replaceAll("$", "");
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(normalized);
  const actualSheet = match ? (match[1]?.replaceAll("''", "'") ?? match[2]) : sheetName;
  const actualRange = match ? match[3] : normalized;
  const [startText, endText = startText] = actualRange.split(":");
  const parseCell = (cell) => {
    const parsed = /^([A-Za-z]+)(\d+)$/.exec(cell.trim());
    if (!parsed) throw new Error(`Unsupported chart range '${range}'`);
    let column = 0;
    for (const character of parsed[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
    return { row: Number(parsed[2]), column };
  };
  return { sheet: actualSheet, start: parseCell(startText), end: parseCell(endText) };
}

function cellDisplayValue(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`Chart source cell ${cell.address} contains an invalid date value`);
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "object") {
    if ("result" in value) {
      if (value.result instanceof Date) {
        if (!Number.isFinite(value.result.getTime())) throw new Error(`Chart source cell ${cell.address} contains an invalid formula date result`);
        return value.result.toISOString().slice(0, 10);
      }
      return value.result ?? "";
    }
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((run) => run.text ?? "").join("");
    if (typeof value.error === "string") return value.error;
  }
  return value;
}

function rangeValues(workbook, ownerSheet, range) {
  const parsed = parseRange(ownerSheet, range);
  const worksheet = workbook.getWorksheet(parsed.sheet);
  if (!worksheet) throw new Error(`Chart range references missing worksheet '${parsed.sheet}'`);
  const values = [];
  for (let row = parsed.start.row; row <= parsed.end.row; row += 1) {
    for (let column = parsed.start.column; column <= parsed.end.column; column += 1) {
      values.push(cellDisplayValue(worksheet.getCell(row, column)));
    }
  }
  return values;
}

function cacheXml(values, numeric) {
  const points = values.map((value, index) => `<c:pt idx="${index}"><c:v>${escapeXml(value)}</c:v></c:pt>`).join("");
  const format = numeric ? "<c:formatCode>General</c:formatCode>" : "";
  return `${format}<c:ptCount val="${values.length}"/>${points}`;
}

function isBlankChartValue(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function seriesXml(workbook, spec, series, index) {
  const categoriesFormula = absoluteRange(spec.sheet, spec.categories);
  const valuesFormula = absoluteRange(spec.sheet, series.values);
  const categories = rangeValues(workbook, spec.sheet, spec.categories);
  const rawValues = rangeValues(workbook, spec.sheet, series.values);
  if (categories.length !== rawValues.length) {
    throw new Error(`Chart '${spec.title ?? spec.sheet}' series '${series.name ?? index + 1}' has ${categories.length} categories but ${rawValues.length} values`);
  }
  const blankCategoryIndexes = categories.flatMap((value, pointIndex) => isBlankChartValue(value) ? [pointIndex + 1] : []);
  if (blankCategoryIndexes.length > 0) {
    throw new Error(`Chart '${spec.title ?? spec.sheet}' series '${series.name ?? index + 1}' contains blank categories at point(s) ${blankCategoryIndexes.join(", ")}`);
  }
  const blankValueIndexes = rawValues.flatMap((value, pointIndex) => isBlankChartValue(value) ? [pointIndex + 1] : []);
  if (blankValueIndexes.length > 0) {
    throw new Error(`Chart '${spec.title ?? spec.sheet}' series '${series.name ?? index + 1}' contains blank values at point(s) ${blankValueIndexes.join(", ")}`);
  }
  const minimumPoints = spec.minPoints ?? (spec.type === "line" ? 2 : 1);
  if (categories.length < minimumPoints) {
    throw new Error(`Chart '${spec.title ?? spec.sheet}' series '${series.name ?? index + 1}' requires at least ${minimumPoints} data points but found ${categories.length}`);
  }
  const values = rawValues.map((value) => Number(value));
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Chart '${spec.title ?? spec.sheet}' series '${series.name ?? index + 1}' contains non-numeric values`);
  }
  const color = String(series.color ?? ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"][index % 6]).replace(/^#/, "").toUpperCase();
  const marker = spec.type === "line" ? '<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>' : "";
  const line = spec.type === "line" ? `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr><c:smooth val="0"/>` : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${escapeXml(series.name ?? `Series ${index + 1}`)}</c:v></c:tx>${line}${marker}<c:cat><c:strRef><c:f>${escapeXml(categoriesFormula)}</c:f><c:strCache>${cacheXml(categories, false)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>${escapeXml(valuesFormula)}</c:f><c:numCache>${cacheXml(values, true)}</c:numCache></c:numRef></c:val></c:ser>`;
}

function titleXml(title) {
  if (!title) return "<c:autoTitleDeleted val=\"1\"/>";
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1400" b="1"/><a:t>${escapeXml(title)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>`;
}

function chartXml(workbook, spec, chartIndex) {
  if (!spec.sheet || !spec.categories || !Array.isArray(spec.series) || spec.series.length === 0) {
    throw new Error("Native chart specs require sheet, categories, and at least one series");
  }
  if (!new Set(["line", "column", "bar"]).has(spec.type)) {
    throw new Error(`Unsupported native chart type '${spec.type}'. Use line, column, or bar.`);
  }
  const axisA = 100000 + chartIndex * 2;
  const axisB = axisA + 1;
  const series = spec.series.map((item, index) => seriesXml(workbook, spec, item, index)).join("");
  const plot = spec.type === "line"
    ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:smooth val="0"/><c:axId val="${axisA}"/><c:axId val="${axisB}"/></c:lineChart>`
    : `<c:barChart><c:barDir val="${spec.type === "bar" ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="120"/><c:axId val="${axisA}"/><c:axId val="${axisB}"/></c:barChart>`;
  const legend = spec.legend === "none" ? "" : `<c:legend><c:legendPos val="${spec.legend ?? "b"}"/><c:layout/><c:overlay val="0"/></c:legend>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:date1904 val="0"/><c:lang val="zh-CN"/><c:roundedCorners val="0"/><c:chart>${titleXml(spec.title)}<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}<c:catAx><c:axId val="${axisA}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axisB}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="${axisB}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="${escapeXml(spec.valueFormat ?? "General")}" sourceLinked="0"/><c:majorGridlines/><c:tickLblPos val="nextTo"/><c:crossAx val="${axisA}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>`;
}

function cellAnchor(reference) {
  const parsed = /^([A-Za-z]+)(\d+)$/.exec(String(reference));
  if (!parsed) throw new Error(`Invalid chart anchor '${reference}'`);
  let column = 0;
  for (const character of parsed[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  return { column: column - 1, row: Number(parsed[2]) - 1 };
}

function anchorXml(spec, relationshipId, drawingObjectId) {
  const from = cellAnchor(spec.anchor?.from ?? "G2");
  const to = cellAnchor(spec.anchor?.to ?? "N18");
  if (to.column <= from.column || to.row <= from.row) throw new Error("Chart anchor.to must be below and to the right of anchor.from");
  return `<xdr:twoCellAnchor editAs="twoCell"><xdr:from><xdr:col>${from.column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${to.column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${drawingObjectId}" name="Chart ${drawingObjectId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE_REL_NS}" r:id="${relationshipId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

function ensureOverride(contentTypesXml, partName, contentType) {
  if (contentTypesXml.includes(`PartName="/${partName}"`)) return contentTypesXml;
  return contentTypesXml.replace("</Types>", `<Override PartName="/${partName}" ContentType="${contentType}"/></Types>`);
}

function nextPartIndex(entries, expression) {
  return entries.reduce((maximum, entry) => Math.max(maximum, Number(entry.match(expression)?.[1] ?? 0)), 0) + 1;
}

export async function injectNativeCharts(filePath, specs, { JSZip, loadXlsx }) {
  if (!Array.isArray(specs) || specs.length === 0) return { chartCount: 0, charts: [] };
  const buffer = await (await import("node:fs/promises")).readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await loadXlsx(filePath);
  const sheetParts = await workbookSheetParts(zip);
  const entries = Object.keys(zip.files);
  let chartIndex = nextPartIndex(entries, /^xl\/charts\/chart(\d+)\.xml$/i);
  let drawingIndex = nextPartIndex(entries, /^xl\/drawings\/drawing(\d+)\.xml$/i);
  let contentTypesXml = await zip.file("[Content_Types].xml").async("string");
  const created = [];

  for (const spec of specs) {
    const sheetPart = sheetParts.get(spec.sheet);
    if (!sheetPart) throw new Error(`Native chart references missing worksheet '${spec.sheet}'`);
    let sheetXml = await zip.file(sheetPart).async("string");
    const sheetRelsPart = relationshipPart(sheetPart);
    const sheetRelationships = zip.file(sheetRelsPart)
      ? relationshipRecords(await zip.file(sheetRelsPart).async("string"))
      : [];
    const drawingMatch = /<drawing\b[^>]*r:id="([^"]+)"[^>]*\/?\s*>/i.exec(sheetXml);
    let drawingPart;
    if (drawingMatch) {
      const relationship = sheetRelationships.find((record) => record.id === drawingMatch[1] && record.type === DRAWING_REL);
      if (!relationship) throw new Error(`Worksheet '${spec.sheet}' has an unresolved drawing relationship`);
      drawingPart = normalizePackageTarget(sheetPart, relationship.target);
    } else {
      drawingPart = `xl/drawings/drawing${drawingIndex}.xml`;
      drawingIndex += 1;
      const drawingRelationshipId = nextRelationshipId(sheetRelationships);
      sheetRelationships.push({ id: drawingRelationshipId, type: DRAWING_REL, target: relativePackageTarget(sheetPart, drawingPart) });
      sheetXml = sheetXml.replace("</worksheet>", `<drawing r:id="${drawingRelationshipId}"/></worksheet>`);
      zip.file(sheetPart, sheetXml);
      zip.file(drawingPart, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="${DRAWING_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${OFFICE_REL_NS}"></xdr:wsDr>`);
      contentTypesXml = ensureOverride(contentTypesXml, drawingPart, "application/vnd.openxmlformats-officedocument.drawing+xml");
    }
    zip.file(sheetRelsPart, relationshipXml(sheetRelationships));

    const drawingRelsPart = relationshipPart(drawingPart);
    const drawingRelationships = zip.file(drawingRelsPart)
      ? relationshipRecords(await zip.file(drawingRelsPart).async("string"))
      : [];
    const chartRelationshipId = nextRelationshipId(drawingRelationships);
    const chartPart = `xl/charts/chart${chartIndex}.xml`;
    drawingRelationships.push({ id: chartRelationshipId, type: CHART_REL, target: relativePackageTarget(drawingPart, chartPart) });
    zip.file(drawingRelsPart, relationshipXml(drawingRelationships));

    let drawingXml = await zip.file(drawingPart).async("string");
    const existingObjectIds = Array.from(drawingXml.matchAll(/<xdr:cNvPr\b[^>]*\bid="(\d+)"/gi)).map((match) => Number(match[1]));
    const objectId = Math.max(0, ...existingObjectIds) + 1;
    drawingXml = drawingXml.replace("</xdr:wsDr>", `${anchorXml(spec, chartRelationshipId, objectId)}</xdr:wsDr>`);
    zip.file(drawingPart, drawingXml);
    zip.file(chartPart, chartXml(workbook, spec, chartIndex));
    contentTypesXml = ensureOverride(contentTypesXml, chartPart, "application/vnd.openxmlformats-officedocument.drawingml.chart+xml");
    created.push({ part: chartPart, sheet: spec.sheet, type: spec.type, title: spec.title ?? null });
    chartIndex += 1;
  }

  zip.file("[Content_Types].xml", contentTypesXml);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await (await import("node:fs/promises")).writeFile(filePath, output);
  return { chartCount: created.length, charts: created };
}

export async function pruneEmptyDrawingParts(zip, { DOMParser }) {
  const sheetParts = await workbookSheetParts(zip);
  const references = [];
  for (const [sheet, sheetPart] of sheetParts.entries()) {
    const sheetFile = zip.file(sheetPart);
    if (!sheetFile) continue;
    const sheetXml = await sheetFile.async("string");
    const sheetRelsPart = relationshipPart(sheetPart);
    const relationships = zip.file(sheetRelsPart)
      ? relationshipRecords(await zip.file(sheetRelsPart).async("string"))
      : [];
    for (const relationshipId of worksheetDrawingIds(sheetXml)) {
      const relationship = relationships.find((record) => record.id === relationshipId && record.type === DRAWING_REL);
      if (!relationship?.target) continue;
      references.push({ sheet, sheetPart, sheetRelsPart, sheetXml, relationships, relationshipId, drawingPart: normalizePackageTarget(sheetPart, relationship.target) });
    }
  }

  const referenceCounts = new Map();
  for (const reference of references) referenceCounts.set(reference.drawingPart, (referenceCounts.get(reference.drawingPart) ?? 0) + 1);
  const removedParts = [];
  let contentTypesXml = zip.file("[Content_Types].xml") ? await zip.file("[Content_Types].xml").async("string") : null;

  for (const reference of references) {
    if (referenceCounts.get(reference.drawingPart) !== 1) continue;
    const drawingFile = zip.file(reference.drawingPart);
    if (!drawingFile) continue;
    const drawingXml = await drawingFile.async("string");
    const document = parseDrawingDocument(drawingXml, DOMParser);
    if (!document || drawingAnchors(document).length > 0) continue;
    const drawingRelsPart = relationshipPart(reference.drawingPart);
    const drawingRelationships = zip.file(drawingRelsPart)
      ? relationshipRecords(await zip.file(drawingRelsPart).async("string"))
      : [];
    if (drawingRelationships.length > 0) continue;

    const latestSheetXml = await zip.file(reference.sheetPart).async("string");
    zip.file(reference.sheetPart, removeWorksheetDrawing(latestSheetXml, reference.relationshipId));
    const latestRelationships = zip.file(reference.sheetRelsPart)
      ? relationshipRecords(await zip.file(reference.sheetRelsPart).async("string"))
      : reference.relationships;
    const remainingRelationships = latestRelationships.filter((record) => record.id !== reference.relationshipId);
    if (remainingRelationships.length > 0) zip.file(reference.sheetRelsPart, relationshipXml(remainingRelationships));
    else zip.remove(reference.sheetRelsPart);
    zip.remove(reference.drawingPart);
    zip.remove(drawingRelsPart);
    if (contentTypesXml !== null) contentTypesXml = removeContentTypeOverride(contentTypesXml, reference.drawingPart);
    removedParts.push({ part: reference.drawingPart, sheet: reference.sheet });
  }

  if (contentTypesXml !== null && removedParts.length > 0) zip.file("[Content_Types].xml", contentTypesXml);
  return { removed: removedParts.length, parts: removedParts };
}

export async function inspectDrawingPackage(zip, { DOMParser }) {
  const issues = [];
  const sheetParts = await workbookSheetParts(zip);
  const references = new Map();

  for (const [sheet, sheetPart] of sheetParts.entries()) {
    const sheetFile = zip.file(sheetPart);
    if (!sheetFile) continue;
    const sheetXml = await sheetFile.async("string");
    const relationshipIds = worksheetDrawingIds(sheetXml);
    if (relationshipIds.length === 0) continue;
    const sheetRelsPart = relationshipPart(sheetPart);
    const relationships = zip.file(sheetRelsPart)
      ? relationshipRecords(await zip.file(sheetRelsPart).async("string"))
      : [];
    for (const relationshipId of relationshipIds) {
      const relationship = relationships.find((record) => record.id === relationshipId && record.type === DRAWING_REL);
      if (!relationship?.target) {
        issues.push({ type: "unresolved_worksheet_drawing_relationship", sheet, part: sheetPart, relationshipId });
        continue;
      }
      const drawingPart = normalizePackageTarget(sheetPart, relationship.target);
      if (!zip.file(drawingPart)) {
        issues.push({ type: "missing_drawing_part", sheet, part: drawingPart, relationshipId });
        continue;
      }
      const owners = references.get(drawingPart) ?? [];
      owners.push({ sheet, sheetPart, relationshipId });
      references.set(drawingPart, owners);
    }
  }

  const drawingPartNames = Object.keys(zip.files).filter((name) => /^xl\/drawings\/[^/]+\.xml$/i.test(name) && !zip.files[name].dir);
  const parts = [];
  for (const part of drawingPartNames) {
    const owners = references.get(part) ?? [];
    if (owners.length === 0) issues.push({ type: "orphan_drawing_part", part });
    const xml = await zip.file(part).async("string");
    const document = parseDrawingDocument(xml, DOMParser);
    if (!document) {
      issues.push({ type: "malformed_drawing_xml", part });
      parts.push({ part, sheet: owners[0]?.sheet ?? null, objects: 0, relationships: 0 });
      continue;
    }
    const anchors = drawingAnchors(document);
    const drawingRelsPart = relationshipPart(part);
    const relationships = zip.file(drawingRelsPart)
      ? relationshipRecords(await zip.file(drawingRelsPart).async("string"))
      : [];
    const relationshipsById = new Map(relationships.map((record) => [record.id, record]));
    if (anchors.length === 0 && relationships.length > 0) {
      issues.push({ type: "empty_drawing_with_relationships", part, relationshipCount: relationships.length });
    }

    anchors.forEach((anchor, anchorIndex) => {
      const children = childElements(anchor);
      const clientDataIndexes = children.map((child, index) => localName(child) === "clientData" ? index : -1).filter((index) => index >= 0);
      if (clientDataIndexes.length !== 1 || clientDataIndexes[0] !== children.length - 1) {
        issues.push({
          type: "invalid_drawing_anchor_structure",
          part,
          anchor: anchorIndex + 1,
          anchorType: localName(anchor),
          reason: clientDataIndexes.length === 0 ? "missing_direct_client_data" : clientDataIndexes.length > 1 ? "multiple_direct_client_data" : "client_data_not_last",
        });
      }
      const nestedClientData = descendantElements(anchor, "clientData").filter((element) => element.parentNode !== anchor);
      if (nestedClientData.length > 0) {
        issues.push({ type: "invalid_drawing_anchor_structure", part, anchor: anchorIndex + 1, anchorType: localName(anchor), reason: "nested_client_data" });
      }
      for (const graphicFrame of children.filter((child) => localName(child) === "graphicFrame")) {
        const frameChildren = new Set(childElements(graphicFrame).map(localName));
        const missing = ["nvGraphicFramePr", "xfrm", "graphic"].filter((name) => !frameChildren.has(name));
        if (missing.length > 0) {
          issues.push({ type: "invalid_drawing_graphic_frame", part, anchor: anchorIndex + 1, missing });
        }
        for (const chart of descendantElements(graphicFrame, "chart")) {
          const relationshipId = chart.getAttribute("r:id") || chart.getAttributeNS?.(OFFICE_REL_NS, "id");
          const relationship = relationshipsById.get(relationshipId);
          if (!relationshipId || relationship?.type !== CHART_REL) {
            issues.push({ type: "unresolved_drawing_chart_relationship", part, anchor: anchorIndex + 1, relationshipId: relationshipId || null });
            continue;
          }
          const chartPart = normalizePackageTarget(part, relationship.target);
          if (!zip.file(chartPart)) issues.push({ type: "missing_chart_part", part: chartPart, drawingPart: part, relationshipId });
        }
      }
    });
    parts.push({ part, sheet: owners[0]?.sheet ?? null, objects: anchors.length, relationships: relationships.length });
  }

  return { parts, issues };
}

export async function inspectNativeCharts(zip) {
  const sheetParts = await workbookSheetParts(zip);
  const sheetByPart = new Map(Array.from(sheetParts.entries()).map(([name, part]) => [part, name]));
  const chartToSheet = new Map();

  for (const [sheetPart, sheetName] of sheetByPart.entries()) {
    const sheetFile = zip.file(sheetPart);
    if (!sheetFile) continue;
    const sheetXml = await sheetFile.async("string");
    const drawingId = /<drawing\b[^>]*r:id="([^"]+)"/i.exec(sheetXml)?.[1];
    if (!drawingId) continue;
    const sheetRelsPart = relationshipPart(sheetPart);
    if (!zip.file(sheetRelsPart)) continue;
    const drawingRelationship = relationshipRecords(await zip.file(sheetRelsPart).async("string"))
      .find((record) => record.id === drawingId && record.type === DRAWING_REL);
    if (!drawingRelationship) continue;
    const drawingPart = normalizePackageTarget(sheetPart, drawingRelationship.target);
    const drawingRelsPart = relationshipPart(drawingPart);
    if (!zip.file(drawingRelsPart)) continue;
    for (const relationship of relationshipRecords(await zip.file(drawingRelsPart).async("string"))) {
      if (relationship.type !== CHART_REL) continue;
      chartToSheet.set(normalizePackageTarget(drawingPart, relationship.target), sheetName);
    }
  }

  const charts = [];
  for (const part of Object.keys(zip.files).filter((name) => /^xl\/charts\/chart\d+\.xml$/i.test(name))) {
    const xml = await zip.file(part).async("string");
    const tags = ["lineChart", "areaChart", "pieChart", "doughnutChart", "scatterChart", "bubbleChart", "radarChart", "stockChart", "surfaceChart", "ofPieChart"];
    const types = tags.filter((tag) => new RegExp(`<c:${tag}\\b`, "i").test(xml)).map((tag) => tag.replace("Chart", ""));
    if (/<c:barChart\b/i.test(xml)) types.push(/<c:barDir\b[^>]*val="col"/i.test(xml) ? "column" : "bar");
    const sourceFormulas = Array.from(xml.matchAll(/<c:f>([\s\S]*?)<\/c:f>/gi)).map((match) => unescapeXml(match[1].trim()));
    const seriesCount = (xml.match(/<c:ser\b/gi) ?? []).length;
    const series = Array.from(xml.matchAll(/<c:ser\b[\s\S]*?<\/c:ser>/gi)).map((match, index) => {
      const block = match[0];
      const category = /<c:cat>[\s\S]*?<c:f>([\s\S]*?)<\/c:f>[\s\S]*?<\/c:cat>/i.exec(block)?.[1];
      const values = /<c:val>[\s\S]*?<c:f>([\s\S]*?)<\/c:f>[\s\S]*?<\/c:val>/i.exec(block)?.[1];
      const name = /<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>[\s\S]*?<\/c:tx>/i.exec(block)?.[1];
      return { index, name: name ? unescapeXml(name.trim()) : null, categories: category ? unescapeXml(category.trim()) : null, values: values ? unescapeXml(values.trim()) : null };
    });
    charts.push({ part, sheet: chartToSheet.get(part) ?? null, types, sourceFormulas: [...new Set(sourceFormulas)], seriesCount, series });
  }
  return charts;
}
