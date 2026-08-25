import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDependencies } from './runtime.mjs';

const CONTENT_TYPES_PART = '[Content_Types].xml';
const ROOT_RELATIONSHIPS_PART = '_rels/.rels';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const PRESENTATION_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const PRESENTATION_SLIDE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const PRESENTATION_NOTES_SLIDE_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const DRAWINGML_CHART_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const PRESENTATION_MAIN_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DRAWINGML_CHART_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/chart',
  'http://purl.oclc.org/ooxml/drawingml/chart',
]);
const LEGACY_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

function normalizeXmlSource(xml) {
  const withoutBom = String(xml).replace(/^\uFEFF/u, '');
  return /^\s+<\?xml/u.test(withoutBom) ? withoutBom.trimStart() : withoutBom;
}

function parseXml(xml, part = 'OOXML part') {
  const { xmldom } = loadDependencies();
  const errors = [];
  const document = new xmldom.DOMParser({
    onError: (level, message) => errors.push({ level, message }),
  }).parseFromString(normalizeXmlSource(xml), 'application/xml');
  const fatal = errors.filter((item) => item.level === 'fatalError');
  if (!document?.documentElement || fatal.length) {
    const details = fatal.map((item) => item.message).join('; ') || 'document root is missing';
    throw new Error(`Invalid XML in ${part}: ${details}`);
  }
  return document;
}

function elementChildren(node) {
  const values = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) values.push(child);
  }
  return values;
}

function descendants(node, localName = null) {
  const values = [];
  const visit = (current) => {
    for (const child of elementChildren(current)) {
      if (localName === null || child.localName === localName || child.nodeName === localName) values.push(child);
      visit(child);
    }
  };
  visit(node);
  return values;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalPartName(value) {
  const raw = String(value ?? '').replace(/^\/+/, '');
  if (!raw || raw.includes('\\') || raw.includes('\0')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const normalized = path.posix.normalize(decoded);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function assertSafeZipEntries(zip) {
  for (const [name, entry] of Object.entries(zip.files)) {
    const original = entry.unsafeOriginalName ?? name;
    const withoutTrailingSlash = String(original).replace(/\/+$/u, '');
    if (!withoutTrailingSlash) continue;
    if (withoutTrailingSlash.startsWith('/') || !canonicalPartName(withoutTrailingSlash)) {
      throw new Error(`Invalid PPTX OPC package: unsafe ZIP entry path ${original}`);
    }
  }
}

function buildPartIndex(zip) {
  const index = new Map();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const canonical = canonicalPartName(name);
    if (!canonical) throw new Error(`Invalid PPTX OPC package: unsafe part path ${name}`);
    if (index.has(canonical)) {
      throw new Error(`Invalid PPTX OPC package: multiple ZIP entries resolve to ${canonical}`);
    }
    index.set(canonical, name);
  }
  return index;
}

function requiredPart(context, part) {
  const canonical = canonicalPartName(part);
  const actual = canonical ? context.partIndex.get(canonical) : null;
  const file = actual ? context.zip.file(actual) : null;
  if (!file) throw new Error(`Invalid PPTX OPC package: required part ${part} is missing`);
  return { canonical, actual, file };
}

function optionalPart(context, part) {
  const canonical = canonicalPartName(part);
  const actual = canonical ? context.partIndex.get(canonical) : null;
  return actual ? context.zip.file(actual) : null;
}

function relationshipOwnerPart(relationshipsPart) {
  if (relationshipsPart === ROOT_RELATIONSHIPS_PART) return '';
  const match = relationshipsPart.match(/^(.*)\/_rels\/([^/]+)\.rels$/u);
  return match ? path.posix.join(match[1], match[2]) : null;
}

function relationshipsPartFor(ownerPart) {
  if (!ownerPart) return ROOT_RELATIONSHIPS_PART;
  return path.posix.join(path.posix.dirname(ownerPart), '_rels', `${path.posix.basename(ownerPart)}.rels`);
}

function resolveRelationshipTarget(ownerPart, target) {
  const raw = String(target ?? '').split(/[?#]/u, 1)[0];
  if (!raw || raw.includes('\\') || raw.includes('\0')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const joined = decoded.startsWith('/')
    ? decoded.slice(1)
    : path.posix.join(path.posix.dirname(ownerPart || ''), decoded);
  return canonicalPartName(joined);
}

function relationshipId(node) {
  const prefixed = node.getAttribute('r:id');
  if (prefixed) return prefixed;
  for (let index = 0; index < (node.attributes?.length ?? 0); index += 1) {
    const attribute = node.attributes.item(index);
    if (attribute?.localName === 'id' && /\/relationships$/u.test(attribute.namespaceURI ?? '')) return attribute.value;
  }
  return null;
}

async function readRelationships(context, part, { required = false } = {}) {
  const file = optionalPart(context, part);
  if (!file) {
    if (required) requiredPart(context, part);
    return [];
  }
  const document = parseXml(await file.async('string'), part);
  const root = document.documentElement;
  if (root.localName !== 'Relationships' || root.namespaceURI !== PACKAGE_RELATIONSHIPS_NAMESPACE) {
    throw new Error(`Invalid PPTX OPC package: ${part} must use namespace ${PACKAGE_RELATIONSHIPS_NAMESPACE}`);
  }
  return elementChildren(root)
    .filter((node) => node.localName === 'Relationship' && node.namespaceURI === PACKAGE_RELATIONSHIPS_NAMESPACE)
    .map((node) => ({
      id: node.getAttribute('Id'),
      type: node.getAttribute('Type'),
      target: node.getAttribute('Target'),
      external: String(node.getAttribute('TargetMode') ?? '').toLowerCase() === 'external',
    }));
}

function partExtension(part) {
  const basename = path.posix.basename(part);
  if (/^\.[^.]+$/u.test(basename)) return basename.slice(1).toLowerCase();
  return path.posix.extname(basename).slice(1).toLowerCase();
}

async function validateContentTypes(context, officeDocumentPart) {
  const { file } = requiredPart(context, CONTENT_TYPES_PART);
  const document = parseXml(await file.async('string'), CONTENT_TYPES_PART);
  const root = document.documentElement;
  if (root.localName !== 'Types' || root.namespaceURI !== CONTENT_TYPES_NAMESPACE) {
    throw new Error(`Invalid PPTX OPC package: ${CONTENT_TYPES_PART} must use namespace ${CONTENT_TYPES_NAMESPACE}`);
  }
  const defaults = new Map();
  const overrides = new Map();
  for (const entry of elementChildren(root).filter((node) => node.namespaceURI === CONTENT_TYPES_NAMESPACE)) {
    if (entry.localName === 'Default') {
      const extension = entry.getAttribute('Extension').replace(/^\./u, '').toLowerCase();
      const contentType = entry.getAttribute('ContentType');
      if (!extension || !contentType) throw new Error(`Invalid PPTX OPC package: ${CONTENT_TYPES_PART} contains an incomplete Default entry`);
      defaults.set(extension, contentType);
    } else if (entry.localName === 'Override') {
      const part = canonicalPartName(entry.getAttribute('PartName'));
      const contentType = entry.getAttribute('ContentType');
      if (!part || !contentType) throw new Error(`Invalid PPTX OPC package: ${CONTENT_TYPES_PART} contains an incomplete Override entry`);
      overrides.set(part, contentType);
    }
  }
  const contentTypeFor = (part) => overrides.get(part) ?? defaults.get(partExtension(part));
  let mappedPartCount = 0;
  for (const part of context.partIndex.keys()) {
    if (part === CONTENT_TYPES_PART) continue;
    if (!contentTypeFor(part)) throw new Error(`Invalid PPTX OPC package: no content type is declared for ${part}`);
    mappedPartCount += 1;
  }
  const mainType = contentTypeFor(officeDocumentPart);
  if (mainType !== PRESENTATION_MAIN_CONTENT_TYPE) {
    throw new Error(`Invalid PPTX OPC package: ${officeDocumentPart} uses unexpected content type ${mainType ?? '(missing)'}`);
  }
  return { contentTypeCount: defaults.size + overrides.size, mappedPartCount, contentTypeFor };
}

async function findOfficeDocumentPart(context) {
  const relationships = await readRelationships(context, ROOT_RELATIONSHIPS_PART, { required: true });
  const matches = relationships.filter((relationship) => (
    !relationship.external && OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type)
  ));
  if (matches.length !== 1) {
    throw new Error('Invalid PPTX OPC package: root relationships must contain one officeDocument entry');
  }
  const target = resolveRelationshipTarget('', matches[0].target);
  if (!target || !context.partIndex.has(target)) {
    throw new Error(`Invalid PPTX OPC package: officeDocument targets missing or unsafe part ${matches[0].target}`);
  }
  return target;
}

async function validateAllXml(context) {
  const parts = [...context.partIndex.keys()].filter((part) => part.endsWith('.xml') || part.endsWith('.rels'));
  for (const part of parts) parseXml(await requiredPart(context, part).file.async('string'), part);
  return parts.length;
}

async function validateAllRelationships(context) {
  let relationshipCount = 0;
  let externalRelationshipCount = 0;
  const orphanRelationshipParts = [];
  for (const part of [...context.partIndex.keys()].filter((name) => name.endsWith('.rels'))) {
    const owner = relationshipOwnerPart(part);
    if (owner === null) throw new Error(`Invalid OOXML relationship part path: ${part}`);
    if (owner && !context.partIndex.has(owner)) orphanRelationshipParts.push(part);
    for (const relationship of await readRelationships(context, part, { required: true })) {
      relationshipCount += 1;
      if (relationship.external) {
        externalRelationshipCount += 1;
        continue;
      }
      const target = resolveRelationshipTarget(owner, relationship.target);
      if (!target) throw new Error(`Invalid OOXML relationship: ${part} has unsafe target ${relationship.target}`);
      if (!context.partIndex.has(target)) {
        throw new Error(`Invalid OOXML relationship: ${part} targets missing part ${relationship.target}`);
      }
    }
  }
  return { relationshipCount, externalRelationshipCount, orphanRelationshipParts };
}

function normalizedText(document) {
  const paragraphs = descendants(document, 'p')
    .map((paragraph) => descendants(paragraph, 't').map((node) => node.textContent ?? '').join(''))
    .map((value) => value.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length) return paragraphs.join('\n');
  return descendants(document, 't')
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function presentationSlides(context, officeDocumentPart, contentTypeFor) {
  const presentationDocument = parseXml(
    await requiredPart(context, officeDocumentPart).file.async('string'),
    officeDocumentPart,
  );
  const presentationRelationshipsPart = relationshipsPartFor(officeDocumentPart);
  const relationships = await readRelationships(context, presentationRelationshipsPart, { required: true });
  const relationshipMap = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  const slideParts = [];
  for (const slideId of descendants(presentationDocument, 'sldId')) {
    const id = relationshipId(slideId);
    const relationship = relationshipMap.get(id);
    if (!id || !relationship || relationship.external || !/\/slide$/u.test(relationship.type)) {
      throw new Error(`Invalid PPTX presentation: slide entry ${id ?? '(missing relationship id)'} does not resolve to a slide relationship`);
    }
    const part = resolveRelationshipTarget(officeDocumentPart, relationship.target);
    if (!part || !context.partIndex.has(part)) {
      throw new Error(`Invalid PPTX presentation: slide relationship ${id} targets missing or unsafe part ${relationship.target}`);
    }
    const contentType = contentTypeFor(part);
    if (contentType !== PRESENTATION_SLIDE_CONTENT_TYPE) {
      throw new Error(`Invalid PPTX presentation: slide relationship ${id} targets ${part} with unexpected content type ${contentType ?? '(missing)'}`);
    }
    slideParts.push(part);
  }
  if (!slideParts.length) throw new Error('Invalid PPTX presentation: no active slides were found');

  const slides = [];
  const activeNotes = new Set();
  const activeCharts = new Set();
  for (let index = 0; index < slideParts.length; index += 1) {
    const part = slideParts[index];
    const document = parseXml(await requiredPart(context, part).file.async('string'), part);
    const root = document.documentElement;
    if (root.localName !== 'sld' || !PRESENTATION_MAIN_NAMESPACES.has(root.namespaceURI)) {
      throw new Error(`Invalid PPTX presentation: ${part} is not a presentation slide part`);
    }
    const slideRelationships = await readRelationships(context, relationshipsPartFor(part));
    for (const relationship of slideRelationships.filter((item) => (
      !item.external && /\/chart$/u.test(item.type)
    ))) {
      const chartPart = resolveRelationshipTarget(part, relationship.target);
      if (!chartPart || !context.partIndex.has(chartPart)) {
        throw new Error(`Invalid PPTX presentation: ${part} targets missing or unsafe chart part ${relationship.target}`);
      }
      const chartContentType = contentTypeFor(chartPart);
      if (chartContentType !== DRAWINGML_CHART_CONTENT_TYPE) {
        throw new Error(`Invalid PPTX presentation: chart relationship from ${part} targets ${chartPart} with unexpected content type ${chartContentType ?? '(missing)'}`);
      }
      const chartDocument = parseXml(await requiredPart(context, chartPart).file.async('string'), chartPart);
      const chartRoot = chartDocument.documentElement;
      if (chartRoot.localName !== 'chartSpace' || !DRAWINGML_CHART_NAMESPACES.has(chartRoot.namespaceURI)) {
        throw new Error(`Invalid PPTX presentation: ${chartPart} is not a DrawingML chart part`);
      }
      activeCharts.add(chartPart);
    }
    const notesRelationship = slideRelationships.find((relationship) => (
      !relationship.external && /\/notesSlide$/u.test(relationship.type)
    ));
    let notesPart = null;
    let notes = '';
    if (notesRelationship) {
      notesPart = resolveRelationshipTarget(part, notesRelationship.target);
      if (!notesPart || !context.partIndex.has(notesPart)) {
        throw new Error(`Invalid PPTX presentation: ${part} targets missing or unsafe notes part ${notesRelationship.target}`);
      }
      const notesContentType = contentTypeFor(notesPart);
      if (notesContentType !== PRESENTATION_NOTES_SLIDE_CONTENT_TYPE) {
        throw new Error(`Invalid PPTX presentation: notes relationship from ${part} targets ${notesPart} with unexpected content type ${notesContentType ?? '(missing)'}`);
      }
      const notesDocument = parseXml(await requiredPart(context, notesPart).file.async('string'), notesPart);
      const notesRoot = notesDocument.documentElement;
      if (notesRoot.localName !== 'notes' || !PRESENTATION_MAIN_NAMESPACES.has(notesRoot.namespaceURI)) {
        throw new Error(`Invalid PPTX presentation: ${notesPart} is not a presentation notes slide part`);
      }
      activeNotes.add(notesPart);
      notes = normalizedText(notesDocument);
    }
    slides.push({
      number: index + 1,
      part,
      text: normalizedText(document),
      notesPart,
      notes,
    });
  }
  return { slides, activeNotes, activeCharts };
}

function featureCounts(parts, externalRelationshipCount, activeChartCount) {
  const count = (pattern) => parts.filter((part) => pattern.test(part)).length;
  return {
    masterCount: count(/^ppt\/slideMasters\/slideMaster\d+\.xml$/u),
    layoutCount: count(/^ppt\/slideLayouts\/slideLayout\d+\.xml$/u),
    themeCount: count(/^ppt\/theme\/theme\d+\.xml$/u),
    notesSlideCount: count(/^ppt\/notesSlides\/notesSlide\d+\.xml$/u),
    chartCount: activeChartCount,
    mediaCount: count(/^ppt\/media\//u),
    embeddingCount: count(/^ppt\/embeddings\//u),
    oleObjectCount: count(/^ppt\/embeddings\/oleObject/u),
    activeXCount: count(/^ppt\/activeX\//u),
    macroPartCount: count(/(^|\/)vbaProject\.bin$/u),
    signaturePartCount: count(/^_xmlsignatures\//u),
    externalRelationshipCount,
  };
}

async function partHashes(context) {
  const values = [];
  for (const [part, actual] of [...context.partIndex.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const buffer = await context.zip.file(actual).async('nodebuffer');
    values.push([part, sha256(buffer)]);
  }
  return Object.fromEntries(values);
}

async function loadPptxPackage(inputPath) {
  const absolute = path.resolve(inputPath);
  const buffer = await fs.readFile(absolute);
  if (buffer.length >= LEGACY_MAGIC.length && buffer.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
    throw new Error('Legacy binary .ppt is not OOXML. Run `pptx.sh convert-legacy --input source.ppt --out source-converted.pptx` first.');
  }
  const { JSZip } = loadDependencies();
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new Error(`Not a valid PPTX OOXML package: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSafeZipEntries(zip);
  return { absolute, buffer, zip, partIndex: buildPartIndex(zip) };
}

export async function readPptxFacts(inputPath, options = {}) {
  const context = await loadPptxPackage(inputPath);
  const officeDocumentPart = await findOfficeDocumentPart(context);
  const contentTypes = await validateContentTypes(context, officeDocumentPart);
  const textPartCount = await validateAllXml(context);
  const relationships = await validateAllRelationships(context);
  const presentation = await presentationSlides(context, officeDocumentPart, contentTypes.contentTypeFor);
  const parts = [...context.partIndex.keys()].sort();
  const activeSlides = new Set(presentation.slides.map((slide) => slide.part));
  const orphanSlides = parts.filter((part) => /^ppt\/slides\/slide\d+\.xml$/u.test(part) && !activeSlides.has(part));
  const orphanNotes = parts.filter((part) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(part) && !presentation.activeNotes.has(part));
  const warnings = [];
  if (relationships.orphanRelationshipParts.length) {
    warnings.push({ code: 'orphan-relationship-parts', parts: relationships.orphanRelationshipParts });
  }
  if (orphanSlides.length) warnings.push({ code: 'orphan-slide-parts', parts: orphanSlides });
  if (orphanNotes.length) warnings.push({ code: 'orphan-notes-parts', parts: orphanNotes });
  const features = featureCounts(parts, relationships.externalRelationshipCount, presentation.activeCharts.size);
  const report = {
    status: 'ok',
    input: context.absolute,
    sha256: sha256(context.buffer),
    bytes: context.buffer.length,
    package: {
      readable: true,
      officeDocumentPart,
      textPartCount,
      relationshipCount: relationships.relationshipCount,
      contentTypeCount: contentTypes.contentTypeCount,
      mappedPartCount: contentTypes.mappedPartCount,
      partCount: parts.length,
    },
    presentation: {
      slideCount: presentation.slides.length,
      ...features,
    },
    warnings,
  };
  return {
    report,
    slides: presentation.slides,
    parts,
    partHashes: options.includePartHashes ? await partHashes(context) : null,
  };
}

export async function validatePptxPackage(inputPath) {
  return (await readPptxFacts(inputPath)).report;
}
