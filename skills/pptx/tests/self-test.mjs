import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(skillRoot, 'scripts', 'pptx.sh');
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-test-'));
const workDir = path.join(outputRoot, 'work');
const cacheDir = path.join(outputRoot, 'cache');
const environment = {
  ...process.env,
  PILOTDECK_WORK_DIR: workDir,
  PPTX_SKILL_CACHE: cacheDir,
};
let passed = false;

function rawPptx(...args) {
  return spawnSync('bash', [cli, ...args], {
    cwd: skillRoot,
    env: environment,
    encoding: 'utf8',
  });
}

function pptx(...args) {
  const result = rawPptx(...args);
  if (result.status !== 0) {
    throw new Error(`pptx.sh ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

try {
  await fs.mkdir(workDir, { recursive: true });

  const bootstrap = rawPptx('validate', '--input', path.join(workDir, 'missing.pptx'));
  assert.notEqual(bootstrap.status, 0);
  process.env.PPTX_RUNTIME_ROOT = path.join(cacheDir, 'runtime');
  const { loadDependencies } = await import(`${pathToFileURL(path.join(skillRoot, 'scripts/lib/runtime.mjs')).href}?test=${Date.now()}`);
  const { JSZip } = loadDependencies();

  async function writeDeck(output, options = {}) {
    const texts = options.texts ?? ['Alpha', 'Beta'];
    const notes = options.notes ?? ['Source note', ''];
    const chartPart = options.chartPart ?? null;
    const orphanChartPart = options.orphanChartPart ?? null;
    const prefix = options.bom ? '\uFEFF  \n' : '';
    const zip = new JSZip();
    const overrides = [
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
      ...texts.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
      ...notes.map((value, index) => value
        ? `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`
        : ''),
      ...[chartPart, orphanChartPart].filter(Boolean).map((part) => (
        `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`
      )),
    ];
    if (options.orphanSlide) {
      overrides.push('<Override PartName="/ppt/slides/slide99.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>');
    }
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  ${overrides.filter(Boolean).join('\n  ')}
</Types>`;
    zip.file('[Content_Types].xml', `${prefix}${contentTypes}`);
    zip.file('_rels/.rels', `${prefix}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);
    zip.file('ppt/presentation.xml', `${prefix}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>${texts.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`);
    zip.file('ppt/_rels/presentation.xml.rels', `${prefix}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${texts.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('\n  ')}
</Relationships>`);
    for (let index = 0; index < texts.length; index += 1) {
      const number = index + 1;
      zip.file(`ppt/slides/slide${number}.xml`, `${prefix}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text ${number}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(texts[index])}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`);
      const slideRelationships = [];
      if (notes[index]) {
        slideRelationships.push(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${number}.xml"/>`);
      }
      if (index === 0 && chartPart) {
        slideRelationships.push(`<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="${escapeXml(options.chartTarget)}"/>`);
      }
      if (slideRelationships.length) {
        zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, `${prefix}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRelationships.join('')}</Relationships>`);
      }
      if (notes[index]) {
        zip.file(`ppt/notesSlides/notesSlide${number}.xml`, `${prefix}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(notes[index])}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
      }
    }
    for (const part of [chartPart, orphanChartPart].filter(Boolean)) {
      zip.file(part, `${prefix}<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea/></c:chart></c:chartSpace>`);
    }
    if (options.orphanSlide) {
      zip.file('ppt/slides/slide99.xml', `${prefix}<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld/></p:sld>`);
    }
    if (options.media) zip.file('ppt/media/image1.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await fs.writeFile(output, await zip.generateAsync({ type: 'nodebuffer' }));
  }

  async function mutateDeck(input, output, mutate) {
    const zip = await JSZip.loadAsync(await fs.readFile(input));
    await mutate(zip);
    await fs.writeFile(output, await zip.generateAsync({ type: 'nodebuffer' }));
  }

  const source = path.join(outputRoot, 'source.pptx');
  const candidate = path.join(workDir, 'candidate.pptx');
  const changedCandidate = path.join(workDir, 'changed.pptx');
  const bomCandidate = path.join(workDir, 'bom.pptx');
  const orphanCandidate = path.join(workDir, 'orphan.pptx');
  const standardChartCandidate = path.join(workDir, 'standard-chart.pptx');
  const nonstandardChartCandidate = path.join(workDir, 'nonstandard-chart.pptx');
  const shorterCandidate = path.join(workDir, 'shorter.pptx');
  await writeDeck(source);
  await fs.copyFile(source, candidate);
  await writeDeck(changedCandidate, { texts: ['Alpha revised', 'Beta'], notes: ['Revised source note', ''], media: true });
  await writeDeck(bomCandidate, { bom: true });
  await writeDeck(orphanCandidate, { orphanSlide: true });
  await writeDeck(standardChartCandidate, {
    chartPart: 'ppt/charts/chart1.xml',
    chartTarget: '../charts/chart1.xml',
  });
  await writeDeck(nonstandardChartCandidate, {
    chartPart: 'ppt/slides/charts/chart1.xml',
    chartTarget: 'charts/chart1.xml',
    orphanChartPart: 'ppt/charts/chart99.xml',
  });
  await writeDeck(shorterCandidate, { texts: ['Alpha'], notes: ['Source note'] });

  const valid = pptx('validate', '--input', candidate);
  assert.equal(valid.status, 'ok');
  assert.equal(valid.presentation.slideCount, 2);
  assert.equal(valid.presentation.notesSlideCount, 1);
  assert.equal(valid.warnings.length, 0);
  assert.equal(pptx('validate', '--input', bomCandidate).status, 'ok');
  assert.ok(pptx('validate', '--input', orphanCandidate).warnings.some((warning) => warning.code === 'orphan-slide-parts'));
  assert.equal(pptx('validate', '--input', standardChartCandidate).presentation.chartCount, 1);
  assert.equal(pptx('validate', '--input', nonstandardChartCandidate).presentation.chartCount, 1);

  const missingContentTypes = path.join(workDir, 'missing-content-types.pptx');
  await mutateDeck(candidate, missingContentTypes, (zip) => zip.remove('[Content_Types].xml'));
  let failed = rawPptx('validate', '--input', missingContentTypes);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /required part \[Content_Types\]\.xml is missing/u);

  const missingTarget = path.join(workDir, 'missing-target.pptx');
  await mutateDeck(candidate, missingTarget, async (zip) => {
    const part = zip.file('ppt/_rels/presentation.xml.rels');
    zip.file('ppt/_rels/presentation.xml.rels', (await part.async('string')).replace('slides/slide1.xml', 'slides/missing.xml'));
  });
  failed = rawPptx('validate', '--input', missingTarget);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /targets missing part/u);

  const wrongSlideTarget = path.join(workDir, 'wrong-slide-target.pptx');
  await mutateDeck(candidate, wrongSlideTarget, async (zip) => {
    const part = zip.file('ppt/_rels/presentation.xml.rels');
    zip.file('ppt/_rels/presentation.xml.rels', (await part.async('string')).replace('slides/slide1.xml', 'presentation.xml'));
  });
  failed = rawPptx('validate', '--input', wrongSlideTarget);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /unexpected content type/u);

  const wrongSlideRoot = path.join(workDir, 'wrong-slide-root.pptx');
  await mutateDeck(candidate, wrongSlideRoot, async (zip) => {
    const part = zip.file('ppt/slides/slide1.xml');
    const xml = await part.async('string');
    zip.file('ppt/slides/slide1.xml', xml.replace('<p:sld ', '<p:presentation ').replace('</p:sld>', '</p:presentation>'));
  });
  failed = rawPptx('validate', '--input', wrongSlideRoot);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /not a presentation slide part/u);

  const wrongNotesTarget = path.join(workDir, 'wrong-notes-target.pptx');
  await mutateDeck(candidate, wrongNotesTarget, async (zip) => {
    const part = zip.file('ppt/slides/_rels/slide1.xml.rels');
    zip.file('ppt/slides/_rels/slide1.xml.rels', (await part.async('string')).replace('../notesSlides/notesSlide1.xml', '../presentation.xml'));
  });
  failed = rawPptx('validate', '--input', wrongNotesTarget);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /notes relationship.*unexpected content type/u);

  const wrongNotesRoot = path.join(workDir, 'wrong-notes-root.pptx');
  await mutateDeck(candidate, wrongNotesRoot, async (zip) => {
    const part = zip.file('ppt/notesSlides/notesSlide1.xml');
    const xml = await part.async('string');
    zip.file('ppt/notesSlides/notesSlide1.xml', xml.replace('<p:notes ', '<p:presentation ').replace('</p:notes>', '</p:presentation>'));
  });
  failed = rawPptx('validate', '--input', wrongNotesRoot);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /not a presentation notes slide part/u);

  const wrongChartTarget = path.join(workDir, 'wrong-chart-target.pptx');
  await mutateDeck(standardChartCandidate, wrongChartTarget, async (zip) => {
    const part = zip.file('ppt/slides/_rels/slide1.xml.rels');
    zip.file('ppt/slides/_rels/slide1.xml.rels', (await part.async('string')).replace('../charts/chart1.xml', '../presentation.xml'));
  });
  failed = rawPptx('validate', '--input', wrongChartTarget);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /chart relationship.*unexpected content type/u);

  const wrongChartRoot = path.join(workDir, 'wrong-chart-root.pptx');
  await mutateDeck(standardChartCandidate, wrongChartRoot, async (zip) => {
    const part = zip.file('ppt/charts/chart1.xml');
    const xml = await part.async('string');
    zip.file('ppt/charts/chart1.xml', xml.replace('<c:chartSpace ', '<c:notChart ').replace('</c:chartSpace>', '</c:notChart>'));
  });
  failed = rawPptx('validate', '--input', wrongChartRoot);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /not a DrawingML chart part/u);

  const unsafeTarget = path.join(workDir, 'unsafe-target.pptx');
  await mutateDeck(candidate, unsafeTarget, async (zip) => {
    const part = zip.file('ppt/_rels/presentation.xml.rels');
    zip.file('ppt/_rels/presentation.xml.rels', (await part.async('string')).replace('slides/slide1.xml', '../../../outside.xml'));
  });
  failed = rawPptx('validate', '--input', unsafeTarget);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /unsafe target/u);

  const unsafeEntry = path.join(workDir, 'unsafe-entry.pptx');
  await mutateDeck(candidate, unsafeEntry, (zip) => zip.file('../outside.xml', '<outside/>'));
  failed = rawPptx('validate', '--input', unsafeEntry);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /unsafe ZIP entry path/u);

  const malformed = path.join(workDir, 'malformed.pptx');
  await fs.writeFile(malformed, 'not a zip');
  failed = rawPptx('validate', '--input', malformed);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Not a valid PPTX OOXML package/u);

  const comparisonPath = path.join(workDir, 'comparison.json');
  const comparison = pptx('compare', '--source', source, '--candidate', changedCandidate, '--out', comparisonPath);
  assert.equal(comparison.status, 'ok');
  assert.equal(comparison.changed, true);
  assert.equal(comparison.summary.textChangedSlidePositions, 1);
  assert.equal(comparison.summary.notesChangedSlidePositions, 1);
  assert.equal(comparison.summary.addedPartCount, 1);
  assert.equal(comparison.summary.slideCountChanged, false);
  assert.equal(Object.hasOwn(comparison.summary, 'slideSequenceChanged'), false);
  const fullComparison = JSON.parse(await fs.readFile(comparisonPath, 'utf8'));
  assert.equal(fullComparison.slides[0].text.source, 'Alpha');
  assert.equal(fullComparison.slides[0].notes.candidate, 'Revised source note');
  assert.equal(pptx('compare', '--source', source, '--candidate', candidate).changed, false);
  assert.equal(pptx('compare', '--source', source, '--candidate', shorterCandidate).summary.slideCountChanged, true);

  const final = path.join(outputRoot, 'final.pptx');
  const delivered = pptx('deliver', '--input', candidate, '--out', final, '--source', source);
  assert.equal(delivered.status, 'ok');
  assert.equal(delivered.structure.slideCount, 2);
  assert.equal(Object.hasOwn(delivered, 'validation'), false);
  assert.equal(await fs.readFile(final).then(sha256), await fs.readFile(candidate).then(sha256));
  assert.equal(await fs.readFile(source).then(sha256), await fs.readFile(candidate).then(sha256));

  failed = rawPptx('deliver', '--input', changedCandidate, '--out', final);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Refusing to overwrite existing deliverable/u);
  const overwritten = pptx('deliver', '--input', changedCandidate, '--out', final, '--overwrite');
  assert.equal(overwritten.sha256, await fs.readFile(changedCandidate).then(sha256));

  const invalidFinal = path.join(outputRoot, 'invalid-final.pptx');
  failed = rawPptx('deliver', '--input', wrongSlideTarget, '--out', invalidFinal);
  assert.notEqual(failed.status, 0);
  assert.equal(await fs.stat(invalidFinal).then(() => true).catch(() => false), false);
  for (const [name, invalidCandidate] of [['notes', wrongNotesTarget], ['chart', wrongChartTarget]]) {
    const relatedInvalidFinal = path.join(outputRoot, `invalid-${name}-final.pptx`);
    failed = rawPptx('deliver', '--input', invalidCandidate, '--out', relatedInvalidFinal);
    assert.notEqual(failed.status, 0);
    assert.equal(await fs.stat(relatedInvalidFinal).then(() => true).catch(() => false), false);
  }

  const replaceSource = path.join(outputRoot, 'replace-source.pptx');
  await fs.copyFile(source, replaceSource);
  failed = rawPptx('deliver', '--input', changedCandidate, '--source', replaceSource, '--out', replaceSource);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /without --replace-source/u);
  const replacement = pptx(
    'deliver',
    '--input', changedCandidate,
    '--source', replaceSource,
    '--out', replaceSource,
    '--replace-source',
  );
  assert.equal(replacement.sourceReplaced, true);
  assert.ok(replacement.recovery?.path.startsWith(await fs.realpath(path.join(workDir, 'pptx', 'recovery'))));
  assert.equal(await fs.readFile(replacement.recovery.path).then(sha256), replacement.recovery.sha256);
  assert.equal(await fs.readFile(replaceSource).then(sha256), await fs.readFile(changedCandidate).then(sha256));

  const help = rawPptx('help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /validate\|render\|compare\|deliver\|convert-legacy/u);
  assert.doesNotMatch(help.stdout, /inspect|scaffold|fallback-patch|review|evaluate/u);

  const pythonCheck = spawnSync('python3', ['-c', 'import pptx'], { encoding: 'utf8' });
  if (pythonCheck.status === 0) {
    const renderCandidate = path.join(workDir, 'render-candidate.pptx');
    const pythonDeck = spawnSync('python3', ['-c', [
      'from pptx import Presentation',
      'from pptx.util import Inches',
      'import sys',
      'prs = Presentation()',
      'slide = prs.slides.add_slide(prs.slide_layouts[6])',
      'box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))',
      'box.text_frame.text = "Render smoke test"',
      'prs.save(sys.argv[1])',
    ].join(';'), renderCandidate], { encoding: 'utf8' });
    assert.equal(pythonDeck.status, 0, pythonDeck.stderr);
    const render = rawPptx('render', '--input', renderCandidate, '--out-dir', path.join(workDir, 'render'));
    if (render.status === 0) {
      const report = JSON.parse(render.stdout);
      assert.equal(report.slideCount, 1);
      assert.ok(await fs.stat(report.slides[0]).then((stat) => stat.isFile()));
      const legacyDir = path.join(workDir, 'legacy-source');
      const legacyProfile = path.join(workDir, 'legacy-profile');
      await fs.mkdir(legacyDir, { recursive: true });
      await fs.mkdir(legacyProfile, { recursive: true });
      const toLegacy = spawnSync(report.engine, [
        `-env:UserInstallation=${pathToFileURL(legacyProfile).href}`,
        '--headless',
        '--convert-to',
        'ppt:MS PowerPoint 97',
        '--outdir',
        legacyDir,
        renderCandidate,
      ], { encoding: 'utf8' });
      assert.equal(toLegacy.status, 0, toLegacy.stderr || toLegacy.stdout);
      const legacySource = path.join(legacyDir, 'render-candidate.ppt');
      assert.ok(await fs.stat(legacySource).then((stat) => stat.isFile()));
      const conversion = pptx(
        'convert-legacy',
        '--input', legacySource,
        '--out', path.join(workDir, 'legacy-converted.pptx'),
      );
      assert.equal(conversion.status, 'converted_with_warnings');
      assert.equal(conversion.source.preserved, true);
      assert.equal(conversion.output.slideCount, 1);
    } else {
      assert.match(render.stderr, /Rendering requires LibreOffice/u);
    }
  }

  passed = true;
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    checks: [
      'runtime-bootstrap',
      'package-validation',
      'bom-compatibility',
      'warning-nonblocking',
      'broken-package-rejection',
      'slide-target-semantics',
      'notes-chart-target-semantics',
      'unsafe-path-rejection',
      'factual-comparison',
      'active-chart-counting',
      'atomic-delivery',
      'source-protection',
      'recovery-copy',
      'public-command-surface',
      'render-when-available',
      'legacy-conversion-when-available',
    ],
  })}\n`);
} finally {
  if (passed) await fs.rm(outputRoot, { recursive: true, force: true });
  else process.stderr.write(`PPTX self-test artifacts: ${outputRoot}\n`);
}
