import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPptx } from './ooxml.mjs';
import { loadDependencies } from './runtime.mjs';

const ALLOWED_ACTIONS = new Set(['replace-text', 'replace-image', 'replace-table', 'remove']);

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'));
}

function targetKey(target) {
  if (typeof target === 'string') return target;
  return target?.name || target?.creationId || target?.id || null;
}

export async function validateFrameMap(templatePath, mapOrPath, options = {}) {
  const manifest = await inspectPptx(templatePath);
  const map = typeof mapOrPath === 'string' ? await readJson(mapOrPath) : mapOrPath;
  const errors = [];
  const warnings = [];
  if (map?.version !== 1) errors.push({ code: 'invalid_version', message: 'Frame map version must be 1' });
  if (!Array.isArray(map?.slides) || !map.slides.length) {
    errors.push({ code: 'missing_slides', message: 'Frame map must contain a non-empty slides array' });
  }
  const seenOutput = new Set();
  for (const mapping of map?.slides ?? []) {
    if (!Number.isInteger(mapping.outputSlide) || mapping.outputSlide < 1) {
      errors.push({ code: 'invalid_output_slide', mapping });
      continue;
    }
    if (seenOutput.has(mapping.outputSlide)) errors.push({ code: 'duplicate_output_slide', outputSlide: mapping.outputSlide });
    seenOutput.add(mapping.outputSlide);
    const source = manifest.slides[mapping.sourceSlide - 1];
    if (!source) {
      errors.push({ code: 'invalid_source_slide', outputSlide: mapping.outputSlide, sourceSlide: mapping.sourceSlide });
      continue;
    }
    if (source.objects.some((object) => object.type === 'diagram')) {
      warnings.push({ code: 'diagram_present', sourceSlide: mapping.sourceSlide, message: 'SmartArt/diagram content may not survive structural edits' });
    }
    for (const target of mapping.editTargets ?? []) {
      const key = targetKey(target);
      if (!key) {
        errors.push({ code: 'invalid_edit_target', outputSlide: mapping.outputSlide, target });
        continue;
      }
      const object = source.objects.find((item) => item.name === key || item.creationId === key || item.id === String(key));
      if (!object) errors.push({ code: 'edit_target_not_found', outputSlide: mapping.outputSlide, sourceSlide: mapping.sourceSlide, target: key });
      if (!ALLOWED_ACTIONS.has(target.action)) errors.push({ code: 'invalid_edit_action', outputSlide: mapping.outputSlide, target: key, action: target.action });
      if (!target.name && object?.name) {
        warnings.push({ code: 'target_should_use_name', outputSlide: mapping.outputSlide, target: key, suggestedName: object.name });
      }
    }
  }
  const report = {
    status: errors.length ? 'failed' : 'passed',
    template: manifest.file,
    sourceSlideCount: manifest.slideCount,
    outputSlideCount: map?.slides?.length ?? 0,
    errors,
    warnings,
    map,
  };
  if (options.output) {
    await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await fs.writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

function operationAllowed(mapping, operation) {
  const target = targetKey(operation.target);
  const expected = {
    text: 'replace-text',
    image: 'replace-image',
    table: 'replace-table',
    remove: 'remove',
  }[operation.type];
  return mapping.editTargets?.some((item) => targetKey(item) === target && item.action === expected);
}

function normalizeTableRows(rows) {
  return rows.map((row, index) => ({
    label: row.label ?? `row-${index + 1}`,
    values: Array.isArray(row) ? row : row.values,
  }));
}

export async function prepareStarter(templatePath, mapPath, outputPath, options = {}) {
  const validation = await validateFrameMap(templatePath, mapPath);
  if (validation.status !== 'passed') {
    throw new Error(`Frame map validation failed: ${JSON.stringify(validation.errors)}`);
  }
  const map = validation.map;
  const edits = options.edits ? await readJson(options.edits) : { slides: [] };
  const editBySlide = new Map((edits.slides ?? []).map((item) => [item.outputSlide, item.operations ?? []]));
  for (const mapping of map.slides) {
    for (const operation of editBySlide.get(mapping.outputSlide) ?? []) {
      if (!operationAllowed(mapping, operation)) {
        throw new Error(`Operation ${operation.type} on ${targetKey(operation.target)} is not allowed by the frame map for output slide ${mapping.outputSlide}`);
      }
    }
  }

  const { Automizer, automizerModule } = loadDependencies();
  const source = path.resolve(templatePath);
  const output = path.resolve(outputPath);
  const templateDir = path.dirname(source);
  const outputDir = path.dirname(output);
  const templateFile = path.basename(source);
  const sourceAlias = '__pilotdeck_source__';
  await fs.mkdir(outputDir, { recursive: true });
  const automizer = new Automizer({
    templateDir,
    outputDir,
    mediaDir: templateDir,
    autoImportSlideMasters: true,
    removeExistingSlides: true,
    cleanup: false,
    cleanupPlaceholders: false,
    useCreationIds: false,
    verbosity: options.verbose ? 1 : 0,
  });
  let presentation = automizer
    .loadRoot(templateFile)
    .load(templateFile, sourceAlias);

  const mediaNames = new Map();
  for (const slide of edits.slides ?? []) {
    for (const operation of slide.operations ?? []) {
      if (operation.type !== 'image') continue;
      const image = path.resolve(operation.path);
      const name = path.basename(image);
      if (mediaNames.has(name) && mediaNames.get(name) !== image) {
        throw new Error(`Image basenames must be unique across template edits: ${name}`);
      }
      mediaNames.set(name, image);
      presentation = presentation.loadMedia(name, path.dirname(image));
    }
  }

  const ModifyTextHelper = automizerModule.ModifyTextHelper;
  const ModifyImageHelper = automizerModule.ModifyImageHelper;
  const modify = automizerModule.modify;
  const sorted = [...map.slides].sort((a, b) => a.outputSlide - b.outputSlide);
  for (const mapping of sorted) {
    const operations = editBySlide.get(mapping.outputSlide) ?? [];
    presentation = presentation.addSlide(sourceAlias, mapping.sourceSlide, (slide) => {
      for (const operation of operations) {
        const target = targetKey(operation.target);
        if (operation.type === 'text') {
          slide.modifyElement(target, [ModifyTextHelper.setText(String(operation.value ?? ''))]);
        } else if (operation.type === 'image') {
          slide.modifyElement(target, [ModifyImageHelper.setRelationTargetCover(path.basename(operation.path), presentation)]);
        } else if (operation.type === 'table') {
          slide.modifyElement(target, [modify.setTable({ body: normalizeTableRows(operation.rows ?? []) })]);
        } else if (operation.type === 'remove') {
          slide.removeElement(target);
        } else {
          throw new Error(`Unsupported template operation type: ${operation.type}`);
        }
      }
    });
  }
  await presentation.write(path.basename(output));
  const exists = await fs.stat(output).then(() => true).catch(() => false);
  if (!exists) throw new Error(`Template automation did not produce ${output}`);
  return { output, slideCount: sorted.length, edited: Boolean(options.edits) };
}
