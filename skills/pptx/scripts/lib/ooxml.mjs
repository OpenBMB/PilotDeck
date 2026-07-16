import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadDependencies } from './runtime.mjs';

const EMU_PER_INCH = 914400;

function parseXml(xml) {
  const { xmldom } = loadDependencies();
  const errors = [];
  const document = new xmldom.DOMParser({
    onError: (level, message) => errors.push({ level, message }),
  }).parseFromString(xml, 'application/xml');
  if (errors.some((item) => item.level === 'fatalError')) {
    throw new Error(`Invalid OOXML: ${errors.map((item) => item.message).join('; ')}`);
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
  if (target.startsWith('/')) return target.slice(1);
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePart), target));
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
    text: readText(node),
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
  if (!xml) return { majorFont: null, minorFont: null, colors: {} };
  const document = parseXml(xml);
  const major = firstDescendant(document, 'majorFont');
  const minor = firstDescendant(document, 'minorFont');
  const latin = (node) => firstDescendant(node, 'latin')?.getAttribute('typeface') || null;
  const colors = {};
  const scheme = firstDescendant(document, 'clrScheme');
  for (const child of elementChildren(scheme)) {
    const colorNode = elementChildren(child)[0];
    if (!colorNode) continue;
    colors[child.localName] = colorNode.getAttribute('val') || colorNode.getAttribute('lastClr') || null;
  }
  return { majorFont: latin(major), minorFont: latin(minor), colors };
}

function slidePartFallback(files) {
  return files
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]));
}

export async function inspectPptx(inputPath) {
  const absolute = path.resolve(inputPath);
  const buffer = await fs.readFile(absolute);
  const { JSZip } = loadDependencies();
  const zip = await JSZip.loadAsync(buffer);
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
    slides,
  };
}

export async function writeManifest(inputPath, outputPath) {
  const manifest = await inspectPptx(inputPath);
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
