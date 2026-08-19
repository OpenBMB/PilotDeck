import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(skillRoot, 'scripts', 'pptx.sh');
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-test-'));
const workDir = path.join(outputRoot, 'work');
const environment = { ...process.env, PILOTDECK_WORK_DIR: workDir };
let passed = false;

function run(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: skillRoot,
    env: environment,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function pptx(...args) {
  return run('bash', [cli, ...args]);
}

try {
  await fs.mkdir(workDir, { recursive: true });
  const builder = path.join(workDir, 'deck.mjs');
  const candidate = path.join(workDir, 'candidate.pptx');
  const compatibilityCandidate = path.join(workDir, 'candidate-with-ooxml-variants.pptx');
  const templateScaffold = path.join(workDir, 'template-deck.mjs');
  const templateScaffoldCandidate = path.join(workDir, 'template-scaffold-candidate.pptx');
  const editBuilder = path.join(workDir, 'edit.mjs');
  const edited = path.join(workDir, 'edited.pptx');
  const fallbackScript = path.join(workDir, 'patch.mjs');
  const fallbackCandidate = path.join(workDir, 'fallback-candidate.pptx');
  const fallbackReport = path.join(workDir, 'fallback-report.json');
  const evaluator = path.join(workDir, 'evaluator.mjs');
  const evaluation = path.join(workDir, 'evaluation.json');
  const reviewDir = path.join(workDir, 'review');
  const converted = path.join(workDir, 'converted.pptx');
  const conversionReview = path.join(workDir, 'conversion-review');
  const missingContentTypesCandidate = path.join(workDir, 'missing-content-types.pptx');
  const missingRootRelationshipsCandidate = path.join(workDir, 'missing-root-relationships.pptx');
  const invalidContentTypesNamespaceCandidate = path.join(workDir, 'invalid-content-types-namespace.pptx');
  const invalidRelationshipsNamespaceCandidate = path.join(workDir, 'invalid-relationships-namespace.pptx');
  const invalidSlideRelationshipsNamespaceCandidate = path.join(workDir, 'invalid-slide-relationships-namespace.pptx');
  const wrongPresentationContentTypeCandidate = path.join(workDir, 'wrong-presentation-content-type.pptx');
  const invalidDeliveryCandidate = path.join(workDir, 'invalid-delivery-candidate.pptx');
  const invalidFinal = path.join(outputRoot, 'invalid-final.pptx');
  const final = path.join(outputRoot, 'final.pptx');

  const check = pptx('check');
  assert.equal(check.status, 'ok');
  process.env.PPTX_RUNTIME_ROOT = check.runtime;
  pptx('scaffold', '--out', builder);
  const built = pptx('build', '--builder', builder, '--out', candidate);
  assert.equal(built.slideCount, 2);

  const manifest = pptx('inspect', '--input', candidate);
  const title = manifest.slides[0].objects.find((object) => object.text.includes('A clear presentation'));
  assert.ok(title?.name, 'starter title needs a stable object name');

  const sourceHashBeforeScaffold = crypto.createHash('sha256').update(await fs.readFile(candidate)).digest('hex');
  const scaffoldedTemplate = pptx('scaffold', '--input', candidate, '--out', templateScaffold);
  assert.equal(scaffoldedTemplate.mode, 'template');
  assert.equal(scaffoldedTemplate.slideCount, 2);
  const templateScaffoldSource = await fs.readFile(templateScaffold, 'utf8');
  assert.match(templateScaffoldSource, /createTemplatePresentation/);
  assert.match(templateScaffoldSource, /slide\.generate/);
  assert.match(templateScaffoldSource, /template\.setNotes/);
  const scaffoldBuild = pptx(
    'build',
    '--builder', templateScaffold,
    '--input', candidate,
    '--out', templateScaffoldCandidate,
  );
  assert.equal(scaffoldBuild.engine, 'pptx-automizer');
  const scaffoldManifest = pptx('inspect', '--input', templateScaffoldCandidate);
  assert.equal(scaffoldManifest.slideCount, manifest.slideCount);
  assert.deepEqual(
    scaffoldManifest.slides.map((slide) => slide.text),
    manifest.slides.map((slide) => slide.text),
  );
  assert.equal(
    crypto.createHash('sha256').update(await fs.readFile(candidate)).digest('hex'),
    sourceHashBeforeScaffold,
  );

  await fs.writeFile(fallbackScript, [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    'const args = process.argv.slice(2);',
    "const packageIndex = args.indexOf('--package-dir');",
    "if (packageIndex < 0 || !args[packageIndex + 1]) throw new Error('Missing --package-dir');",
    "const slide = path.join(args[packageIndex + 1], 'ppt', 'slides', 'slide1.xml');",
    "const xml = await fs.readFile(slide, 'utf8');",
    "const updated = xml.replace('A clear presentation title', 'Fallback stays inside the skill');",
    "if (updated === xml) throw new Error('Expected source text was not found');",
    "await fs.writeFile(slide, updated, 'utf8');",
    '',
  ].join('\n'));
  const fallback = pptx(
    'fallback-patch',
    '--input', candidate,
    '--script', fallbackScript,
    '--out', fallbackCandidate,
    '--report', fallbackReport,
  );
  assert.equal(fallback.status, 'ok');
  assert.deepEqual(fallback.changedParts, ['ppt/slides/slide1.xml']);
  assert.ok(await fs.stat(fallback.report).then((stat) => stat.isFile()));
  assert.match(pptx('inspect', '--input', fallbackCandidate).slides[0].text, /Fallback stays inside the skill/);
  assert.equal(
    crypto.createHash('sha256').update(await fs.readFile(candidate)).digest('hex'),
    sourceHashBeforeScaffold,
  );

  const { loadDependencies } = await import('../scripts/lib/runtime.mjs');
  const { JSZip, xmldom } = loadDependencies();
  const compatibilityZip = await JSZip.loadAsync(await fs.readFile(candidate));
  const relationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';
  const relationshipOwnerPart = (part) => {
    if (part === '_rels/.rels') return '';
    const match = part.match(/^(.*)\/_rels\/([^/]+)\.rels$/u);
    return match ? path.posix.join(match[1], match[2]) : null;
  };
  const elementDescendants = (node) => {
    const values = [];
    const visit = (current) => {
      for (let child = current?.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        values.push(child);
        visit(child);
      }
    };
    visit(node);
    return values;
  };
  let absoluteRelationshipTargets = 0;
  let localRelationshipNamespaces = 0;
  let bomParts = 0;
  for (const part of Object.keys(compatibilityZip.files)) {
    const file = compatibilityZip.file(part);
    if (!file || !(part.endsWith('.xml') || part.endsWith('.rels'))) continue;
    const xml = (await file.async('string')).replace(/^\uFEFF/u, '');
    const document = new xmldom.DOMParser().parseFromString(xml, 'application/xml');
    if (part.endsWith('.rels')) {
      const ownerPart = relationshipOwnerPart(part);
      assert.notEqual(ownerPart, null);
      for (const relationship of elementDescendants(document).filter((node) => node.localName === 'Relationship')) {
        if (String(relationship.getAttribute('TargetMode') ?? '').toLowerCase() === 'external') continue;
        const target = relationship.getAttribute('Target');
        const resolved = target.startsWith('/')
          ? path.posix.normalize(target.slice(1))
          : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPart), target));
        relationship.setAttribute('Target', `/${resolved}`);
        absoluteRelationshipTargets += 1;
      }
    } else if (part.startsWith('ppt/')) {
      const root = document.documentElement;
      if (root?.getAttribute('xmlns:r') === relationshipNamespace) {
        for (const element of elementDescendants(root)) {
          const usesRelationshipsPrefix = Array.from({ length: element.attributes?.length ?? 0 })
            .some((_, index) => element.attributes.item(index)?.prefix === 'r');
          if (!usesRelationshipsPrefix) continue;
          element.setAttributeNS(xmlnsNamespace, 'xmlns:r', relationshipNamespace);
          localRelationshipNamespaces += 1;
        }
        root.removeAttributeNS(xmlnsNamespace, 'r');
        root.removeAttribute('xmlns:r');
      }
    }
    compatibilityZip.file(part, `\uFEFF${new xmldom.XMLSerializer().serializeToString(document)}`);
    bomParts += 1;
  }
  assert.ok(bomParts > 0);
  assert.ok(absoluteRelationshipTargets > 0);
  assert.ok(localRelationshipNamespaces > 0);

  const notesRelationshipSuffixes = ['/notesSlide', '/notesMaster'];
  for (const part of Object.keys(compatibilityZip.files).filter((name) => name.endsWith('.rels'))) {
    const file = compatibilityZip.file(part);
    if (!file) continue;
    const document = new xmldom.DOMParser().parseFromString(
      (await file.async('string')).replace(/^\uFEFF/u, ''),
      'application/xml',
    );
    let changed = false;
    for (const relationship of elementDescendants(document).filter((node) => node.localName === 'Relationship')) {
      if (!notesRelationshipSuffixes.some((suffix) => relationship.getAttribute('Type').endsWith(suffix))) continue;
      relationship.parentNode.removeChild(relationship);
      changed = true;
    }
    if (changed) compatibilityZip.file(part, new xmldom.XMLSerializer().serializeToString(document));
  }
  const presentationDocument = new xmldom.DOMParser().parseFromString(
    (await compatibilityZip.file('ppt/presentation.xml').async('string')).replace(/^\uFEFF/u, ''),
    'application/xml',
  );
  for (const list of elementDescendants(presentationDocument).filter((node) => node.localName === 'notesMasterIdLst')) {
    list.parentNode.removeChild(list);
  }
  compatibilityZip.file('ppt/presentation.xml', new xmldom.XMLSerializer().serializeToString(presentationDocument));
  const contentTypesDocument = new xmldom.DOMParser().parseFromString(
    (await compatibilityZip.file('[Content_Types].xml').async('string')).replace(/^\uFEFF/u, ''),
    'application/xml',
  );
  for (const override of elementDescendants(contentTypesDocument).filter((node) => node.localName === 'Override')) {
    if (!String(override.getAttribute('ContentType')).includes('.notes')) continue;
    override.parentNode.removeChild(override);
  }
  compatibilityZip.file('[Content_Types].xml', new xmldom.XMLSerializer().serializeToString(contentTypesDocument));
  compatibilityZip.remove('ppt/notesSlides');
  compatibilityZip.remove('ppt/notesMasters');

  await fs.writeFile(compatibilityCandidate, await compatibilityZip.generateAsync({ type: 'nodebuffer' }));
  const compatibilitySourceHash = crypto.createHash('sha256').update(await fs.readFile(compatibilityCandidate)).digest('hex');
  const compatibilityManifest = pptx('inspect', '--input', compatibilityCandidate);
  assert.equal(compatibilityManifest.slideCount, manifest.slideCount);
  assert.deepEqual(
    compatibilityManifest.slides.map((slide) => slide.text),
    manifest.slides.map((slide) => slide.text),
  );

  const conversion = pptx(
    'convert-legacy',
    '--input', candidate,
    '--out', converted,
    '--qa-dir', conversionReview,
  );
  assert.equal(conversion.status, 'converted');
  assert.equal(conversion.validation.status, 'review_pending');
  assert.equal(conversion.validation.sourceRender.slideCount, 2);
  assert.equal(conversion.validation.convertedRender.slideCount, 2);
  await fs.writeFile(editBuilder, [
    'export default async function build({ createTemplatePresentation }) {',
    '  const template = await createTemplatePresentation();',
    '  template.addSlide(1, (slide) => {',
    `    slide.modifyElement(${JSON.stringify(title.name)}, [template.ModifyTextHelper.setText('Template editing stays model-directed')]);`,
    "    slide.generate((canvas, pptxgenjs) => canvas.addChart(pptxgenjs.ChartType.bar, [{ name: 'Results', labels: ['A', 'B'], values: [12, 6] }], { x: 0.8, y: 3.5, w: 4.2, h: 2.4, showLegend: false }), 'Generated Chart');",
    "    slide.generate((canvas) => canvas.addTable([['Metric', 'Value'], ['A', '12'], ['B', '6']], { x: 5.4, y: 3.5, w: 3.6, h: 1.8 }), 'Generated Table');",
    '  });',
    "  template.setNotes(1, '[Sources]\\n- candidate-with-ooxml-variants.pptx');",
    '  return template;',
    '}',
    '',
  ].join('\n'));

  const templateBuild = pptx('build', '--builder', editBuilder, '--input', compatibilityCandidate, '--out', edited);
  assert.equal(templateBuild.engine, 'pptx-automizer');
  assert.equal(
    crypto.createHash('sha256').update(await fs.readFile(compatibilityCandidate)).digest('hex'),
    compatibilitySourceHash,
  );
  assert.deepEqual(
    (await fs.readdir(workDir)).filter((name) => name.endsWith('.template.pptx')),
    [],
    'normalized template copies should be cleaned up after the build',
  );
  const editedManifest = pptx('inspect', '--input', edited);
  assert.match(editedManifest.slides[0].text, /Template editing stays model-directed/);
  assert.ok(editedManifest.masterCount >= compatibilityManifest.masterCount);
  assert.ok(editedManifest.layoutCount >= compatibilityManifest.layoutCount);
  const editedZip = await JSZip.loadAsync(await fs.readFile(edited));
  const editedPresentation = new xmldom.DOMParser().parseFromString(
    await editedZip.file('ppt/presentation.xml').async('string'),
    'application/xml',
  );
  const editedPresentationRelationships = new xmldom.DOMParser().parseFromString(
    await editedZip.file('ppt/_rels/presentation.xml.rels').async('string'),
    'application/xml',
  );
  const activeSlideRelationshipId = elementDescendants(editedPresentation)
    .find((node) => node.localName === 'sldId')
    .getAttribute('r:id');
  const activeSlideRelationship = elementDescendants(editedPresentationRelationships)
    .find((node) => node.localName === 'Relationship' && node.getAttribute('Id') === activeSlideRelationshipId);
  const activeSlidePart = path.posix.join('ppt', activeSlideRelationship.getAttribute('Target'));
  const activeSlideRelationshipsPart = path.posix.join(
    path.posix.dirname(activeSlidePart),
    '_rels',
    `${path.posix.basename(activeSlidePart)}.rels`,
  );
  const activeSlideRelationships = new xmldom.DOMParser().parseFromString(
    await editedZip.file(activeSlideRelationshipsPart).async('string'),
    'application/xml',
  );
  const activeLayoutRelationship = elementDescendants(activeSlideRelationships)
    .find((node) => node.localName === 'Relationship' && node.getAttribute('Type').endsWith('/slideLayout'));
  const activeLayoutPart = path.posix.normalize(path.posix.join(
    path.posix.dirname(activeSlidePart),
    activeLayoutRelationship.getAttribute('Target'),
  ));
  assert.equal(
    await editedZip.file(activeLayoutPart).async('string'),
    await editedZip.file('ppt/slideLayouts/slideLayout1.xml').async('string'),
    'generated content should remain on a copy of the source slide layout',
  );
  assert.ok(
    Object.keys(editedZip.files).some((part) => /^ppt\/charts\/chart\d+\.xml$/u.test(part)),
    'template generation should preserve an editable chart',
  );
  assert.match(await editedZip.file(activeSlidePart).async('string'), /<a:tbl>/u);
  const activeNotesRelationship = elementDescendants(activeSlideRelationships)
    .find((node) => node.localName === 'Relationship' && node.getAttribute('Type').endsWith('/notesSlide'));
  const activeNotesPart = path.posix.normalize(path.posix.join(
    path.posix.dirname(activeSlidePart),
    activeNotesRelationship.getAttribute('Target'),
  ));
  const editedNotes = await editedZip.file(activeNotesPart).async('string');
  assert.match(editedNotes, /\[Sources\]/u);
  assert.match(editedNotes, /candidate-with-ooxml-variants\.pptx/u);
  assert.ok(editedZip.file('ppt/notesMasters/notesMaster1.xml'));
  assert.match(
    await editedZip.file('ppt/presentation.xml').async('string'),
    /<p:notesMasterIdLst>/u,
  );

  await fs.writeFile(evaluator, [
    'export default async function evaluate({ candidate, helpers }) {',
    '  return { checks: [',
    "    { name: 'one selected slide', passed: candidate.slideCount === 1 },",
    "    { name: 'edited text present', passed: helpers.findText('Template editing stays model-directed').length === 1 },",
    '  ] };',
    '}',
    '',
  ].join('\n'));
  assert.equal(pptx('evaluate', '--input', edited, '--script', evaluator, '--out', evaluation).status, 'ok');

  const editedHashBeforeReviewCollision = crypto.createHash('sha256')
    .update(await fs.readFile(edited))
    .digest('hex');
  const reviewCollision = spawnSync('bash', [
    cli,
    'review',
    '--input', edited,
    '--out-dir', path.join(workDir, 'review-collision'),
    '--report', edited,
  ], {
    cwd: skillRoot,
    env: environment,
    encoding: 'utf8',
  });
  assert.notEqual(reviewCollision.status, 0);
  assert.match(reviewCollision.stderr, /candidate and report must use distinct paths/u);
  assert.equal(
    crypto.createHash('sha256').update(await fs.readFile(edited)).digest('hex'),
    editedHashBeforeReviewCollision,
  );

  const review = pptx('review', '--input', edited, '--out-dir', reviewDir);
  assert.ok(['review_pending', 'evidence_unavailable'].includes(review.status));
  assert.equal(review.structure.slideCount, 1);
  assert.equal(review.structure.slides, undefined);
  assert.equal(review.audit.errors, undefined);
  assert.ok(await fs.stat(review.audit.report).then((stat) => stat.isFile()));
  const fullReview = JSON.parse(await fs.readFile(review.report, 'utf8'));
  assert.equal(fullReview.structure.slides.length, 1);
  assert.ok(Array.isArray(fullReview.audit.errors));
  assert.ok(JSON.stringify(review).length < JSON.stringify(fullReview).length);
  if (review.status === 'review_pending') {
    assert.equal(review.render.pages.length, 1);
    assert.ok(await fs.stat(review.render.pages[0].image).then((stat) => stat.isFile()));
  }

  const writeDeliveryVariant = async (output, mutate) => {
    const zip = await JSZip.loadAsync(await fs.readFile(edited));
    await mutate(zip);
    await fs.writeFile(output, await zip.generateAsync({ type: 'nodebuffer' }));
  };
  const assertDeliveryRejected = async (input, expectedError) => {
    const result = spawnSync('bash', [
      cli,
      'deliver',
      '--input', input,
      '--out', invalidFinal,
    ], {
      cwd: skillRoot,
      env: environment,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expectedError);
    assert.equal(await fs.stat(invalidFinal).then(() => true).catch(() => false), false);
  };

  await writeDeliveryVariant(missingContentTypesCandidate, (zip) => {
    zip.remove('[Content_Types].xml');
  });
  await assertDeliveryRejected(missingContentTypesCandidate, /required part \[Content_Types\]\.xml is missing/u);

  await writeDeliveryVariant(missingRootRelationshipsCandidate, (zip) => {
    zip.remove('_rels/.rels');
  });
  await assertDeliveryRejected(missingRootRelationshipsCandidate, /required part _rels\/\.rels is missing/u);

  await writeDeliveryVariant(invalidContentTypesNamespaceCandidate, async (zip) => {
    const part = zip.file('[Content_Types].xml');
    const xml = await part.async('string');
    const namespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
    assert.match(xml, new RegExp(namespace, 'u'));
    zip.file('[Content_Types].xml', xml.replace(namespace, 'urn:invalid-content-types'));
  });
  await assertDeliveryRejected(invalidContentTypesNamespaceCandidate, /must use namespace .*content-types/u);

  await writeDeliveryVariant(invalidRelationshipsNamespaceCandidate, async (zip) => {
    const part = zip.file('_rels/.rels');
    const xml = await part.async('string');
    const namespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
    assert.match(xml, new RegExp(namespace, 'u'));
    zip.file('_rels/.rels', xml.replace(namespace, 'urn:invalid-relationships'));
  });
  await assertDeliveryRejected(invalidRelationshipsNamespaceCandidate, /must use namespace .*relationships/u);

  await writeDeliveryVariant(invalidSlideRelationshipsNamespaceCandidate, async (zip) => {
    const part = zip.file(activeSlideRelationshipsPart);
    const xml = await part.async('string');
    const namespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
    assert.match(xml, new RegExp(namespace, 'u'));
    zip.file(activeSlideRelationshipsPart, xml.replace(namespace, 'urn:invalid-relationships'));
  });
  await assertDeliveryRejected(
    invalidSlideRelationshipsNamespaceCandidate,
    /ppt\/slides\/_rels\/.*\.rels must use namespace .*relationships/u,
  );

  await writeDeliveryVariant(wrongPresentationContentTypeCandidate, async (zip) => {
    const document = new xmldom.DOMParser().parseFromString(
      await zip.file('[Content_Types].xml').async('string'),
      'application/xml',
    );
    const presentationOverride = elementDescendants(document).find((node) => (
      node.localName === 'Override' && node.getAttribute('PartName') === '/ppt/presentation.xml'
    ));
    assert.ok(presentationOverride);
    presentationOverride.setAttribute('ContentType', 'application/xml');
    zip.file('[Content_Types].xml', new xmldom.XMLSerializer().serializeToString(document));
  });
  await assertDeliveryRejected(wrongPresentationContentTypeCandidate, /uses unexpected content type application\/xml/u);

  await writeDeliveryVariant(invalidDeliveryCandidate, (zip) => {
    zip.remove(activeLayoutPart);
  });
  await assertDeliveryRejected(invalidDeliveryCandidate, /targets missing part/u);

  const delivered = pptx('deliver', '--input', edited, '--out', final);
  assert.equal(delivered.slideCount, 1);
  assert.ok(delivered.validation.textPartCount > 0);
  assert.ok(delivered.validation.relationshipCount > 0);
  assert.ok(delivered.validation.contentTypeCount > 0);
  assert.ok(delivered.validation.mappedPartCount > 0);
  assert.ok(await fs.stat(final).then((stat) => stat.isFile()));
  passed = true;
  process.stdout.write(`${JSON.stringify({ status: 'ok', checks: ['build', 'template-scaffold', 'fallback-patch', 'ooxml-compatibility', 'convert', 'template-edit', 'evaluate', 'compact-review', 'opc-validation', 'delivery-validation', 'deliver'] })}\n`);
} finally {
  if (passed) await fs.rm(outputRoot, { recursive: true, force: true });
  else process.stderr.write(`PPTX self-test artifacts: ${outputRoot}\n`);
}
