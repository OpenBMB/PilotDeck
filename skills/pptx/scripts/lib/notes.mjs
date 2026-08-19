import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDependencies } from './runtime.mjs';

const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DRAWING_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NAMESPACE = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const NOTES_MASTER_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';
const NOTES_SLIDE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const SLIDE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const THEME_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
const NOTES_MASTER_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';
const NOTES_SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

let seedPartsPromise;

function parseXml(xml) {
  const { xmldom } = loadDependencies();
  return new xmldom.DOMParser().parseFromString(xml.replace(/^\uFEFF/u, ''), 'application/xml');
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

function relationshipPart(ownerPart) {
  return path.posix.join(
    path.posix.dirname(ownerPart),
    '_rels',
    `${path.posix.basename(ownerPart)}.rels`,
  );
}

function resolveTarget(ownerPart, target) {
  if (target.startsWith('/')) return path.posix.normalize(target.slice(1));
  return path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), target));
}

function relativeTarget(ownerPart, targetPart) {
  return path.posix.relative(path.posix.dirname(ownerPart), targetPart);
}

function relationships(document) {
  return descendants(document, 'Relationship');
}

function relationshipByType(document, type) {
  return relationships(document).find((relationship) => relationship.getAttribute('Type') === type) ?? null;
}

function nextRelationshipId(document) {
  const maximum = relationships(document).reduce((value, relationship) => {
    const match = relationship.getAttribute('Id').match(/^rId(\d+)$/u);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `rId${maximum + 1}`;
}

function appendRelationship(document, { type, target }) {
  const relationship = document.createElementNS(RELATIONSHIPS_NAMESPACE, 'Relationship');
  relationship.setAttribute('Id', nextRelationshipId(document));
  relationship.setAttribute('Type', type);
  relationship.setAttribute('Target', target);
  document.documentElement.appendChild(relationship);
  return relationship;
}

function createRelationshipsDocument() {
  const { xmldom } = loadDependencies();
  const document = new xmldom.DOMImplementation().createDocument(
    RELATIONSHIPS_NAMESPACE,
    'Relationships',
    null,
  );
  return document;
}

function ensureContentType(document, partName, contentType) {
  const normalized = partName.startsWith('/') ? partName : `/${partName}`;
  const existing = descendants(document, 'Override')
    .find((override) => override.getAttribute('PartName') === normalized);
  if (existing) {
    existing.setAttribute('ContentType', contentType);
    return;
  }
  const override = document.createElementNS(CONTENT_TYPES_NAMESPACE, 'Override');
  override.setAttribute('PartName', normalized);
  override.setAttribute('ContentType', contentType);
  document.documentElement.appendChild(override);
}

function uniquePart(zip, directory, prefix, extension = '.xml') {
  let index = 1;
  while (zip.file(`${directory}/${prefix}${index}${extension}`)) index += 1;
  return `${directory}/${prefix}${index}${extension}`;
}

function noteBodyShape(document) {
  return descendants(document, 'sp').find((shape) => {
    const placeholder = firstDescendant(shape, 'ph');
    return placeholder?.getAttribute('type') === 'body';
  }) ?? null;
}

function slideNumberShape(document) {
  return descendants(document, 'sp').find((shape) => {
    const placeholder = firstDescendant(shape, 'ph');
    return placeholder?.getAttribute('type') === 'sldNum';
  }) ?? null;
}

function renderNotesSlide(seedXml, text, slideNumber) {
  const document = parseXml(seedXml);
  const body = noteBodyShape(document);
  const textBody = firstDescendant(body, 'txBody');
  if (!textBody) throw new Error('Unable to locate the notes body placeholder in the generated seed');
  for (const paragraph of elementChildren(textBody).filter((child) => child.localName === 'p')) {
    textBody.removeChild(paragraph);
  }

  const paragraph = document.createElementNS(DRAWING_NAMESPACE, 'a:p');
  const run = document.createElementNS(DRAWING_NAMESPACE, 'a:r');
  const runProperties = document.createElementNS(DRAWING_NAMESPACE, 'a:rPr');
  runProperties.setAttribute('lang', 'en-US');
  const noteText = document.createElementNS(DRAWING_NAMESPACE, 'a:t');
  noteText.setAttributeNS(XML_NAMESPACE, 'xml:space', 'preserve');
  noteText.appendChild(document.createTextNode(text));
  const endProperties = document.createElementNS(DRAWING_NAMESPACE, 'a:endParaRPr');
  endProperties.setAttribute('lang', 'en-US');
  run.appendChild(runProperties);
  run.appendChild(noteText);
  paragraph.appendChild(run);
  paragraph.appendChild(endProperties);
  textBody.appendChild(paragraph);

  const numberText = firstDescendant(slideNumberShape(document), 't');
  if (numberText) numberText.textContent = String(slideNumber);
  return serializeXml(document);
}

async function speakerNotesSeedParts() {
  if (!seedPartsPromise) {
    seedPartsPromise = (async () => {
      const { PptxGenJS, JSZip } = loadDependencies();
      const seed = new PptxGenJS();
      const slide = seed.addSlide();
      slide.addNotes('__PILOTDECK_NOTE__');
      const buffer = await seed.write({ outputType: 'nodebuffer' });
      const zip = await JSZip.loadAsync(buffer);
      return {
        notesMaster: await zip.file('ppt/notesMasters/notesMaster1.xml').async('string'),
        notesSlide: await zip.file('ppt/notesSlides/notesSlide1.xml').async('string'),
      };
    })();
  }
  return seedPartsPromise;
}

function notesRelationships(notesPart, notesMasterPart, slidePart) {
  const document = createRelationshipsDocument();
  appendRelationship(document, {
    type: NOTES_MASTER_RELATIONSHIP,
    target: relativeTarget(notesPart, notesMasterPart),
  });
  appendRelationship(document, {
    type: SLIDE_RELATIONSHIP,
    target: relativeTarget(notesPart, slidePart),
  });
  return serializeXml(document);
}

function ensureNotesMasterReference(presentation, relationshipId) {
  const existing = descendants(presentation, 'notesMasterId')[0];
  if (existing) {
    existing.setAttributeNS(OFFICE_RELATIONSHIPS_NAMESPACE, 'r:id', relationshipId);
    return;
  }
  const list = presentation.createElementNS(PRESENTATION_NAMESPACE, 'p:notesMasterIdLst');
  const reference = presentation.createElementNS(PRESENTATION_NAMESPACE, 'p:notesMasterId');
  reference.setAttributeNS(OFFICE_RELATIONSHIPS_NAMESPACE, 'r:id', relationshipId);
  list.appendChild(reference);
  const slideList = descendants(presentation, 'sldIdLst')[0];
  if (slideList) presentation.documentElement.insertBefore(list, slideList);
  else presentation.documentElement.appendChild(list);
}

function orderedSlideParts(presentation, presentationRelationships) {
  const relationshipsById = new Map(
    relationships(presentationRelationships).map((relationship) => [
      relationship.getAttribute('Id'),
      relationship,
    ]),
  );
  return descendants(presentation, 'sldId').map((slideId) => {
    const relationshipId = slideId.getAttribute('r:id') || slideId.getAttribute('id');
    const relationship = relationshipsById.get(relationshipId);
    if (!relationship || relationship.getAttribute('Type') !== SLIDE_RELATIONSHIP) {
      throw new Error(`Unable to resolve output slide relationship ${relationshipId}`);
    }
    return resolveTarget('ppt/presentation.xml', relationship.getAttribute('Target'));
  });
}

export async function applyTemplateSpeakerNotes(outputPath, notesBySlide) {
  if (!(notesBySlide instanceof Map) || notesBySlide.size === 0) return;
  const { JSZip } = loadDependencies();
  const zip = await JSZip.loadAsync(await fs.readFile(outputPath));
  const seed = await speakerNotesSeedParts();
  const contentTypesPart = '[Content_Types].xml';
  const contentTypes = parseXml(await zip.file(contentTypesPart).async('string'));
  const presentationPart = 'ppt/presentation.xml';
  const presentation = parseXml(await zip.file(presentationPart).async('string'));
  const presentationRelationshipsPart = relationshipPart(presentationPart);
  const presentationRelationships = parseXml(await zip.file(presentationRelationshipsPart).async('string'));
  const slideParts = orderedSlideParts(presentation, presentationRelationships);

  let notesMasterRelationship = relationshipByType(presentationRelationships, NOTES_MASTER_RELATIONSHIP);
  let notesMasterPart;
  if (notesMasterRelationship) {
    notesMasterPart = resolveTarget(presentationPart, notesMasterRelationship.getAttribute('Target'));
  } else {
    notesMasterPart = uniquePart(zip, 'ppt/notesMasters', 'notesMaster');
    const themeRelationship = relationshipByType(presentationRelationships, THEME_RELATIONSHIP);
    const themePart = themeRelationship
      ? resolveTarget(presentationPart, themeRelationship.getAttribute('Target'))
      : Object.keys(zip.files).find((name) => /^ppt\/theme\/theme\d+\.xml$/u.test(name));
    if (!themePart) throw new Error('Unable to add speaker notes because the presentation theme is missing');

    zip.file(notesMasterPart, seed.notesMaster);
    const masterRelationships = createRelationshipsDocument();
    appendRelationship(masterRelationships, {
      type: THEME_RELATIONSHIP,
      target: relativeTarget(notesMasterPart, themePart),
    });
    zip.file(relationshipPart(notesMasterPart), serializeXml(masterRelationships));
    notesMasterRelationship = appendRelationship(presentationRelationships, {
      type: NOTES_MASTER_RELATIONSHIP,
      target: relativeTarget(presentationPart, notesMasterPart),
    });
    ensureContentType(contentTypes, notesMasterPart, NOTES_MASTER_CONTENT_TYPE);
  }
  ensureNotesMasterReference(presentation, notesMasterRelationship.getAttribute('Id'));

  for (const [slideNumber, text] of [...notesBySlide.entries()].sort(([left], [right]) => left - right)) {
    const slidePart = slideParts[slideNumber - 1];
    if (!slidePart || !zip.file(slidePart)) {
      throw new Error(`Speaker notes target missing output slide ${slideNumber}`);
    }
    const slideRelationshipsPart = relationshipPart(slidePart);
    const slideRelationshipsFile = zip.file(slideRelationshipsPart);
    const slideRelationships = slideRelationshipsFile
      ? parseXml(await slideRelationshipsFile.async('string'))
      : createRelationshipsDocument();
    let notesRelationship = relationshipByType(slideRelationships, NOTES_SLIDE_RELATIONSHIP);
    let notesPart;
    if (notesRelationship) {
      notesPart = resolveTarget(slidePart, notesRelationship.getAttribute('Target'));
    } else {
      notesPart = uniquePart(zip, 'ppt/notesSlides', 'notesSlide');
      notesRelationship = appendRelationship(slideRelationships, {
        type: NOTES_SLIDE_RELATIONSHIP,
        target: relativeTarget(slidePart, notesPart),
      });
    }

    zip.file(notesPart, renderNotesSlide(seed.notesSlide, text, slideNumber));
    zip.file(relationshipPart(notesPart), notesRelationships(notesPart, notesMasterPart, slidePart));
    zip.file(slideRelationshipsPart, serializeXml(slideRelationships));
    ensureContentType(contentTypes, notesPart, NOTES_SLIDE_CONTENT_TYPE);
  }

  zip.file(contentTypesPart, serializeXml(contentTypes));
  zip.file(presentationPart, serializeXml(presentation));
  zip.file(presentationRelationshipsPart, serializeXml(presentationRelationships));
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.notes.tmp`;
  try {
    await fs.writeFile(temporary, await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    }));
    await fs.rename(temporary, outputPath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
