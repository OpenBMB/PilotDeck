import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDependencies } from './runtime.mjs';

const EMU_PER_INCH = 914400;
const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
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

function parseXml(xml) {
  const { xmldom } = loadDependencies();
  const errors = [];
  const normalized = xml.replace(/^\uFEFF/u, '');
  const document = new xmldom.DOMParser({
    onError: (level, message) => errors.push({ level, message }),
  }).parseFromString(normalized, 'application/xml');
  if (errors.some((item) => item.level === 'fatalError')) {
    throw new Error(`Invalid OOXML: ${errors.map((item) => item.message).join('; ')}`);
  }
  return document;
}

function serializeXml(document) {
  const { xmldom } = loadDependencies();
  return new xmldom.XMLSerializer().serializeToString(document);
}

function elementChildren(node) {
  const values = [];
  for (let child = node?.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) values.push(child);
  }
  return values;
}

function descendants(node, localName) {
  const values = [];
  const visit = (current) => {
    for (const child of elementChildren(current)) {
      if (child.localName === localName || child.nodeName === localName) values.push(child);
      visit(child);
    }
  };
  visit(node);
  return values;
}

function firstDescendant(node, localName) {
  return descendants(node, localName)[0] ?? null;
}

function numberAttribute(node, name) {
  if (!node) return null;
  const value = Number(node.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function inches(emu) {
  return emu === null ? null : Math.round((emu / EMU_PER_INCH) * 10000) / 10000;
}

function relationshipMap(document) {
  const map = new Map();
  for (const rel of descendants(document, 'Relationship')) {
    map.set(rel.getAttribute('Id'), rel.getAttribute('Target'));
  }
  return map;
}

function resolvePart(basePart, target) {
  if (!target) return null;
  const [part] = target.split(/[?#]/u, 1);
  if (part.startsWith('/')) return path.posix.normalize(part.slice(1));
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePart), part));
}

function relationshipOwnerPart(relationshipsPart) {
  if (relationshipsPart === '_rels/.rels') return '';
  const match = relationshipsPart.match(/^(.*)\/_rels\/([^/]+)\.rels$/u);
  if (!match) return null;
  return path.posix.join(match[1], match[2]);
}

function relationshipTargetSuffix(target) {
  return target.slice(target.search(/[?#]/u) < 0 ? target.length : target.search(/[?#]/u));
}

function relativeRelationshipTarget(ownerPart, target) {
  const resolved = resolvePart(ownerPart, target);
  if (!resolved) return target;
  const ownerDirectory = path.posix.dirname(ownerPart);
  const relative = path.posix.relative(ownerDirectory === '.' ? '' : ownerDirectory, resolved);
  return `${relative || path.posix.basename(resolved)}${relationshipTargetSuffix(target)}`;
}

function zipContainsPart(zip, part) {
  if (!part || part === '.' || part.startsWith('../')) return false;
  if (zip.file(part)) return true;
  try {
    return decodeURI(part) !== part && Boolean(zip.file(decodeURI(part)));
  } catch {
    return false;
  }
}

function ensureRelationshipNamespace(document) {
  const root = document.documentElement;
  if (!root) throw new Error('Invalid OOXML: document root is missing');
  const current = root.getAttribute('xmlns:r');
  if (current && current !== RELATIONSHIPS_NAMESPACE) {
    throw new Error(`Invalid OOXML: xmlns:r is bound to an unexpected namespace: ${current}`);
  }
  if (!current) root.setAttributeNS(XMLNS_NAMESPACE, 'xmlns:r', RELATIONSHIPS_NAMESPACE);
}

async function validateZipRelationships(zip) {
  let relationshipCount = 0;
  for (const relationshipsPart of Object.keys(zip.files).filter((name) => name.endsWith('.rels'))) {
    const ownerPart = relationshipOwnerPart(relationshipsPart);
    if (ownerPart === null) throw new Error(`Invalid OOXML relationship part path: ${relationshipsPart}`);
    for (const relationship of await readRelationshipsPart(zip, relationshipsPart)) {
      relationshipCount += 1;
      if (String(relationship.getAttribute('TargetMode') ?? '').toLowerCase() === 'external') continue;
      const target = relationship.getAttribute('Target');
      const resolved = resolvePart(ownerPart, target);
      if (!zipContainsPart(zip, resolved)) {
        throw new Error(`Invalid OOXML relationship: ${relationshipsPart} targets missing part ${target}`);
      }
    }
  }
  return relationshipCount;
}

function requiredZipPart(zip, part) {
  const file = zip.file(part);
  if (!file) throw new Error(`Invalid PPTX OPC package: required part ${part} is missing`);
  return file;
}

async function readRelationshipsPart(zip, part) {
  const document = parseXml(await requiredZipPart(zip, part).async('string'));
  const root = document.documentElement;
  if (root?.localName !== 'Relationships' || root.namespaceURI !== PACKAGE_RELATIONSHIPS_NAMESPACE) {
    throw new Error(
      `Invalid PPTX OPC package: ${part} must use namespace ${PACKAGE_RELATIONSHIPS_NAMESPACE}`,
    );
  }
  return elementChildren(root).filter((relationship) => (
    relationship.localName === 'Relationship'
    && relationship.namespaceURI === PACKAGE_RELATIONSHIPS_NAMESPACE
  ));
}

function canonicalPartName(partName) {
  const value = String(partName ?? '').replace(/^\/+/u, '');
  const normalized = path.posix.normalize(value);
  if (!value || normalized === '.' || normalized.startsWith('../')) return null;
  try {
    return decodeURI(normalized);
  } catch {
    return normalized;
  }
}

function partExtension(part) {
  const basename = path.posix.basename(part);
  if (/^\.[^.]+$/u.test(basename)) return basename.slice(1).toLowerCase();
  return path.posix.extname(basename).slice(1).toLowerCase();
}

async function validateRootOfficeDocument(zip) {
  const officeDocumentRelationships = (await readRelationshipsPart(zip, ROOT_RELATIONSHIPS_PART))
    .filter((relationship) => (
      OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.getAttribute('Type'))
      && String(relationship.getAttribute('TargetMode') ?? '').toLowerCase() !== 'external'
    ));
  if (officeDocumentRelationships.length !== 1) {
    throw new Error('Invalid PPTX OPC package: root relationships must contain one officeDocument entry');
  }
  const target = officeDocumentRelationships[0].getAttribute('Target');
  const resolved = resolvePart('', target);
  if (!zipContainsPart(zip, resolved)) {
    throw new Error(`Invalid PPTX OPC package: officeDocument targets missing part ${target}`);
  }
  return canonicalPartName(resolved);
}

async function validateContentTypes(zip, officeDocumentPart) {
  const document = parseXml(await requiredZipPart(zip, CONTENT_TYPES_PART).async('string'));
  const root = document.documentElement;
  if (root?.localName !== 'Types' || root.namespaceURI !== CONTENT_TYPES_NAMESPACE) {
    throw new Error(
      `Invalid PPTX OPC package: ${CONTENT_TYPES_PART} must use namespace ${CONTENT_TYPES_NAMESPACE}`,
    );
  }

  const contentTypeEntries = elementChildren(root)
    .filter((entry) => entry.namespaceURI === CONTENT_TYPES_NAMESPACE);
  const defaults = new Map();
  for (const entry of contentTypeEntries.filter((item) => item.localName === 'Default')) {
    const extension = entry.getAttribute('Extension').replace(/^\./u, '').toLowerCase();
    const contentType = entry.getAttribute('ContentType');
    if (!extension || !contentType) {
      throw new Error(`Invalid PPTX OPC package: ${CONTENT_TYPES_PART} contains an incomplete Default entry`);
    }
    defaults.set(extension, contentType);
  }

  const overrides = new Map();
  for (const entry of contentTypeEntries.filter((item) => item.localName === 'Override')) {
    const part = canonicalPartName(entry.getAttribute('PartName'));
    const contentType = entry.getAttribute('ContentType');
    if (!part || !contentType) {
      throw new Error(`Invalid PPTX OPC package: ${CONTENT_TYPES_PART} contains an incomplete Override entry`);
    }
    overrides.set(part, contentType);
  }

  const contentTypeForPart = (part) => {
    const canonical = canonicalPartName(part);
    if (!canonical) return undefined;
    return overrides.get(canonical) ?? defaults.get(partExtension(canonical));
  };

  let mappedPartCount = 0;
  for (const [part, entry] of Object.entries(zip.files)) {
    if (entry.dir || part === CONTENT_TYPES_PART) continue;
    if (!contentTypeForPart(part)) {
      throw new Error(`Invalid PPTX OPC package: no content type is declared for ${part}`);
    }
    mappedPartCount += 1;
  }

  const officeDocumentContentType = contentTypeForPart(officeDocumentPart);
  if (officeDocumentContentType !== PRESENTATION_MAIN_CONTENT_TYPE) {
    throw new Error(
      `Invalid PPTX OPC package: ${officeDocumentPart} uses unexpected content type ${officeDocumentContentType ?? '(missing)'}`,
    );
  }

  return {
    contentTypeCount: defaults.size + overrides.size,
    mappedPartCount,
  };
}

async function loadPptxPackage(inputPath) {
  const absolute = path.resolve(inputPath);
  const buffer = await fs.readFile(absolute);
  const { JSZip } = loadDependencies();
  const legacyMagic = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  if (buffer.length >= legacyMagic.length && buffer.subarray(0, legacyMagic.length).equals(legacyMagic)) {
    throw new Error('Legacy binary .ppt is not OOXML. Run `pptx.sh convert-legacy --input source.ppt --out source-converted.pptx --qa-dir conversion-qa` first.');
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new Error(`Not a valid PPTX OOXML package: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { absolute, buffer, zip };
}

export async function validatePptxPackage(inputPath) {
  const { absolute, zip } = await loadPptxPackage(inputPath);
  const officeDocumentPart = await validateRootOfficeDocument(zip);
  const contentTypes = await validateContentTypes(zip, officeDocumentPart);
  const textParts = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && (name.endsWith('.xml') || name.endsWith('.rels')));
  for (const part of textParts) parseXml(await zip.file(part).async('string'));
  const relationshipCount = await validateZipRelationships(zip);
  return {
    file: absolute,
    textPartCount: textParts.length,
    relationshipCount,
    contentTypeCount: contentTypes.contentTypeCount,
    mappedPartCount: contentTypes.mappedPartCount,
  };
}

export async function normalizeTemplatePptx(inputPath, outputPath) {
  const source = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  if (source === output) throw new Error('Template normalization requires a separate output path');
  const { zip } = await loadPptxPackage(source);
  const stats = {
    bomParts: 0,
    absoluteRelationshipTargets: 0,
    relationshipNamespaces: 0,
  };
  const textParts = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && (name.endsWith('.xml') || name.endsWith('.rels')));

  for (const part of textParts) {
    const file = zip.file(part);
    const original = await file.async('string');
    const withoutBom = original.replace(/^\uFEFF/u, '');
    if (withoutBom !== original) stats.bomParts += 1;
    let normalized = withoutBom;

    if (part.endsWith('.rels')) {
      const ownerPart = relationshipOwnerPart(part);
      if (ownerPart === null) throw new Error(`Invalid OOXML relationship part path: ${part}`);
      const document = parseXml(normalized);
      for (const relationship of descendants(document, 'Relationship')) {
        if (String(relationship.getAttribute('TargetMode') ?? '').toLowerCase() === 'external') continue;
        const target = relationship.getAttribute('Target');
        if (!target.startsWith('/')) continue;
        relationship.setAttribute('Target', relativeRelationshipTarget(ownerPart, target));
        stats.absoluteRelationshipTargets += 1;
      }
      normalized = serializeXml(document);
    } else if (part.startsWith('ppt/')) {
      const document = parseXml(normalized);
      const hadRelationshipNamespace = Boolean(document.documentElement?.getAttribute('xmlns:r'));
      ensureRelationshipNamespace(document);
      if (!hadRelationshipNamespace) stats.relationshipNamespaces += 1;
      normalized = serializeXml(document);
    }

    zip.file(part, normalized);
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await fs.writeFile(output, buffer);
  await validatePptxPackage(output);
  return { input: source, output, ...stats };
}

function readText(node) {
  return descendants(node, 't')
    .map((item) => item.textContent ?? '')
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function fontPoints(node) {
  const sizes = descendants(node, 'rPr')
    .concat(descendants(node, 'defRPr'), descendants(node, 'endParaRPr'))
    .map((item) => Number(item.getAttribute('sz')) / 100)
    .filter(Number.isFinite);
  return sizes.length ? Math.max(...sizes) : null;
}

function fontFaces(node) {
  const values = [];
  for (const tag of ['latin', 'ea', 'cs', 'sym']) {
    for (const item of descendants(node, tag)) {
      const typeface = item.getAttribute('typeface');
      if (typeface && !values.includes(typeface)) values.push(typeface);
    }
  }
  return values;
}

function textFitMode(node) {
  if (firstDescendant(node, 'spAutoFit')) return 'resize_shape';
  if (firstDescendant(node, 'normAutofit')) return 'shrink_text';
  if (firstDescendant(node, 'noAutofit')) return 'none';
  return 'unspecified';
}

function containsCjk(text) {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u.test(String(text ?? ''));
}

function classifyGraphicFrame(node) {
  const graphicData = firstDescendant(node, 'graphicData');
  const uri = graphicData?.getAttribute('uri') ?? '';
  if (/chart/i.test(uri)) return 'chart';
  if (/table/i.test(uri)) return 'table';
  if (/diagram/i.test(uri)) return 'diagram';
  return 'graphic-frame';
}

function parseBounds(node) {
  const xfrm = firstDescendant(node, 'xfrm');
  if (!xfrm) return null;
  const off = firstDescendant(xfrm, 'off');
  const ext = firstDescendant(xfrm, 'ext');
  const x = numberAttribute(off, 'x');
  const y = numberAttribute(off, 'y');
  const w = numberAttribute(ext, 'cx');
  const h = numberAttribute(ext, 'cy');
  if ([x, y, w, h].some((value) => value === null)) return null;
  return { x: inches(x), y: inches(y), w: inches(w), h: inches(h) };
}

function parseSlideObject(node) {
  const cNvPr = firstDescendant(node, 'cNvPr');
  const placeholder = firstDescendant(node, 'ph');
  const creationId = descendants(node, 'creationId')[0];
  const objectType = node.localName === 'graphicFrame'
    ? classifyGraphicFrame(node)
    : ({ sp: 'shape', pic: 'image', cxnSp: 'connector', grpSp: 'group' }[node.localName] ?? node.localName);
  const text = readText(node);
  return {
    id: cNvPr?.getAttribute('id') || null,
    creationId: creationId?.getAttribute('id') || creationId?.getAttribute('val') || null,
    name: cNvPr?.getAttribute('name') || null,
    description: cNvPr?.getAttribute('descr') || null,
    type: objectType,
    placeholder: placeholder
      ? {
          type: placeholder.getAttribute('type') || 'body',
          index: placeholder.getAttribute('idx') || null,
        }
      : null,
    bounds: parseBounds(node),
    fontPoints: fontPoints(node),
    fonts: fontFaces(node),
    textFit: textFitMode(node),
    containsCjk: containsCjk(text),
    text,
  };
}

function parseSlide(xml, number, part) {
  const document = parseXml(xml);
  const spTree = firstDescendant(document, 'spTree');
  const objects = spTree
    ? elementChildren(spTree)
        .filter((node) => ['sp', 'pic', 'graphicFrame', 'cxnSp', 'grpSp'].includes(node.localName))
        .map(parseSlideObject)
    : [];
  const creationId = descendants(document, 'creationId')
    .find((node) => node.getAttribute('val'))?.getAttribute('val') ?? null;
  return {
    number,
    part,
    creationId,
    objectCount: objects.length,
    objects,
    text: objects.map((item) => item.text).filter(Boolean).join(' '),
  };
}

function parseTheme(xml) {
  if (!xml) return {
    majorFont: null,
    minorFont: null,
    majorEastAsianFont: null,
    minorEastAsianFont: null,
    supplementalFonts: [],
    colors: {},
  };
  const document = parseXml(xml);
  const major = firstDescendant(document, 'majorFont');
  const minor = firstDescendant(document, 'minorFont');
  const latin = (node) => firstDescendant(node, 'latin')?.getAttribute('typeface') || null;
  const eastAsian = (node) => firstDescendant(node, 'ea')?.getAttribute('typeface') || null;
  const supplementalFonts = [...new Map(
    [major, minor]
      .flatMap((node) => descendants(node, 'font'))
      .map((node) => ({ script: node.getAttribute('script') || null, typeface: node.getAttribute('typeface') || null }))
      .filter((item) => item.typeface && ['Hans', 'Hant', 'Jpan', 'Hang'].includes(item.script))
      .map((item) => [`${item.script}:${item.typeface}`, item]),
  ).values()];
  const colors = {};
  const scheme = firstDescendant(document, 'clrScheme');
  for (const child of elementChildren(scheme)) {
    const colorNode = elementChildren(child)[0];
    if (!colorNode) continue;
    colors[child.localName] = colorNode.getAttribute('val') || colorNode.getAttribute('lastClr') || null;
  }
  return {
    majorFont: latin(major),
    minorFont: latin(minor),
    majorEastAsianFont: eastAsian(major),
    minorEastAsianFont: eastAsian(minor),
    supplementalFonts,
    colors,
  };
}

function slidePartFallback(files) {
  return files
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
}

export async function inspectPptx(inputPath) {
  const { absolute, buffer, zip } = await loadPptxPackage(inputPath);
  const files = Object.keys(zip.files);
  const presentationPart = 'ppt/presentation.xml';
  const presentationFile = zip.file(presentationPart);
  if (!presentationFile) throw new Error('Not a valid PPTX: ppt/presentation.xml is missing');
  const presentationXml = await presentationFile.async('string');
  const presentation = parseXml(presentationXml);
  const sizeNode = firstDescendant(presentation, 'sldSz');
  const cx = numberAttribute(sizeNode, 'cx') ?? 12192000;
  const cy = numberAttribute(sizeNode, 'cy') ?? 6858000;
  const relsFile = zip.file('ppt/_rels/presentation.xml.rels');
  let slideParts = [];
  if (relsFile) {
    const rels = relationshipMap(parseXml(await relsFile.async('string')));
    slideParts = descendants(presentation, 'sldId')
      .map((node) => node.getAttribute('r:id') || node.getAttribute('id'))
      .map((id) => resolvePart(presentationPart, rels.get(id)))
      .filter((part) => part && zip.file(part));
  }
  if (!slideParts.length) slideParts = slidePartFallback(files);
  const slides = [];
  for (let i = 0; i < slideParts.length; i += 1) {
    const xml = await zip.file(slideParts[i]).async('string');
    slides.push(parseSlide(xml, i + 1, slideParts[i]));
  }
  const fontUsageMap = new Map();
  for (const slide of slides) {
    for (const object of slide.objects) {
      for (const fontFace of object.fonts) {
        const current = fontUsageMap.get(fontFace) ?? {
          fontFace,
          slides: new Set(),
          objectCount: 0,
          cjkObjectCount: 0,
        };
        current.slides.add(slide.number);
        current.objectCount += 1;
        if (object.containsCjk) current.cjkObjectCount += 1;
        fontUsageMap.set(fontFace, current);
      }
    }
  }
  const fontUsage = [...fontUsageMap.values()]
    .map((item) => ({ ...item, slides: [...item.slides].sort((a, b) => a - b) }))
    .sort((a, b) => a.fontFace.localeCompare(b.fontFace));
  const themePart = files.find((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name));
  const themeXml = themePart ? await zip.file(themePart).async('string') : null;
  return {
    schemaVersion: 1,
    file: absolute,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    slideSize: { width: inches(cx), height: inches(cy), cx, cy },
    slideCount: slides.length,
    masterCount: files.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)).length,
    layoutCount: files.filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)).length,
    theme: parseTheme(themeXml),
    fontUsage,
    slides,
  };
}
