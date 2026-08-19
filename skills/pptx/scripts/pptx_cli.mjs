#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, required, numberArg } from './lib/args.mjs';
import { auditPptx } from './lib/audit.mjs';
import { convertLegacyPpt } from './lib/convert.mjs';
import { deliverPptx } from './lib/delivery.mjs';
import { fallbackPatchPptx } from './lib/fallback.mjs';
import { inspectPptx, validatePptxPackage } from './lib/ooxml.mjs';
import {
  assertDistinctPaths,
  assertInternalPath,
  fileSha256,
  pathExists,
  writeJson,
} from './lib/paths.mjs';
import { renderPptx, renderingAvailability } from './lib/render.mjs';
import { applyTemplateSpeakerNotes } from './lib/notes.mjs';
import {
  buildToolkit,
  disposeToolkit,
  templateSpeakerNotes,
} from './lib/toolkit.mjs';
import { skillRoot } from './lib/runtime.mjs';

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function scaffoldCommand(args) {
  const output = assertInternalPath(required(args, 'out'), 'PPTX builder');
  const input = args.input === undefined ? null : path.resolve(required(args, 'input'));
  assertDistinctPaths({ input, builder: output });
  if (await pathExists(output) && !args.force) {
    throw new Error(`Refusing to overwrite existing builder: ${output}`);
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  if (!input) {
    await fs.copyFile(path.join(skillRoot(), 'assets', 'starter-deck.mjs'), output);
    return { status: 'ok', mode: 'new', builder: output };
  }

  const manifest = await inspectPptx(input);
  const builder = [
    'export default async function build({ createTemplatePresentation }) {',
    '  const template = await createTemplatePresentation();',
    '',
    '  // Modify, reorder, repeat, or omit source slides according to the request.',
    `  for (let slideNumber = 1; slideNumber <= ${manifest.slideCount}; slideNumber += 1) {`,
    '    template.addSlide(slideNumber, (slide) => {',
    '      // Use slide.modifyElement(...) for existing objects.',
    '      // Use slide.generate((canvas, pptxgenjs) => { ... }) for new editable',
    '      // text, shapes, images, charts, or tables on this template slide.',
    '    });',
    '  }',
    '',
    "  // Add or replace notes by final output position: template.setNotes(1, '[Sources]\\n- source.pptx');",
    '',
    '  return template;',
    '}',
    '',
  ].join('\n');
  await fs.writeFile(output, builder, 'utf8');
  return {
    status: 'ok',
    mode: 'template',
    input,
    inputSha256: manifest.sha256,
    slideCount: manifest.slideCount,
    builder: output,
  };
}

async function loadBuilder(builderPath) {
  const absolute = assertInternalPath(builderPath, 'PPTX builder');
  const stat = await fs.stat(absolute);
  const module = await import(`${pathToFileURL(absolute).href}?mtime=${stat.mtimeMs}-${Date.now()}`);
  const build = module.default ?? module.build;
  if (typeof build !== 'function') {
    throw new Error('Builder must export a default function or named build function');
  }
  return { absolute, build };
}

async function writeBuilderProduct(product, outputPath) {
  const pptx = product?.pptx ?? product;
  if (pptx && typeof pptx.writeFile === 'function') {
    await pptx.writeFile({ fileName: outputPath });
    return 'pptxgenjs';
  }
  const presentation = product?.presentation ?? product;
  if (presentation && typeof presentation.write === 'function') {
    await presentation.write(path.basename(outputPath));
    await applyTemplateSpeakerNotes(outputPath, product?.[templateSpeakerNotes]);
    return 'pptx-automizer';
  }
  throw new Error('Builder must return a PptxGenJS deck, a template presentation, or an object containing one');
}

async function buildDeck(builderPath, inputPath, outputPath) {
  const output = assertInternalPath(outputPath, 'PPTX candidate');
  if (path.extname(output).toLowerCase() !== '.pptx') {
    throw new Error('The PPTX candidate must use a .pptx extension');
  }
  const input = inputPath ? path.resolve(inputPath) : null;
  const { absolute: builder, build } = await loadBuilder(builderPath);
  assertDistinctPaths({ builder, input, candidate: output });
  if (input) await inspectPptx(input);

  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output, '.pptx')}.${process.pid}.${Date.now()}.candidate.pptx`,
  );
  let toolkit;
  try {
    toolkit = await buildToolkit({ inputPath: input, outputPath: temporary });
    const product = await build(toolkit);
    const engine = await writeBuilderProduct(product, temporary);
    await validatePptxPackage(temporary);
    const manifest = await inspectPptx(temporary);
    if (manifest.slideCount < 1) throw new Error('Builder produced an empty presentation');
    await fs.rm(output, { force: true });
    await fs.rename(temporary, output);
    return {
      status: 'ok',
      builder,
      input,
      output,
      engine,
      sha256: manifest.sha256,
      slideCount: manifest.slideCount,
    };
  } finally {
    await toolkit?.[disposeToolkit]?.();
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function buildCommand(args) {
  return buildDeck(required(args, 'builder'), args.input, required(args, 'out'));
}

async function inspectCommand(args) {
  const manifest = await inspectPptx(required(args, 'input'));
  if (args.out) await writeJson(args.out, manifest);
  return { status: 'ok', ...manifest };
}

function reviewStructure(manifest) {
  return {
    slideCount: manifest.slideCount,
    slideSize: manifest.slideSize,
    masterCount: manifest.masterCount,
    layoutCount: manifest.layoutCount,
    theme: manifest.theme,
    fontUsage: manifest.fontUsage,
    slides: manifest.slides.map((slide) => ({
      number: slide.number,
      objectCount: slide.objectCount,
      text: slide.text,
      objects: slide.objects.map((object) => ({
        id: object.id,
        name: object.name,
        type: object.type,
        bounds: object.bounds,
        text: object.text,
      })),
    })),
  };
}

async function reviewCommand(args) {
  const input = path.resolve(required(args, 'input'));
  const root = assertInternalPath(required(args, 'out-dir'), 'PPTX review directory');
  const reportOutput = args.report === undefined
    ? null
    : assertInternalPath(required(args, 'report'), 'PPTX review report');
  assertDistinctPaths({ candidate: input, report: reportOutput });
  const initial = await inspectPptx(input);
  const revisionId = `rev-${initial.sha256.slice(0, 12)}`;
  const evidenceId = `run-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const revisionDir = assertInternalPath(path.join(root, revisionId, evidenceId), 'PPTX review evidence');
  await fs.mkdir(revisionDir, { recursive: true });

  const auditPath = path.join(revisionDir, 'audit.json');
  const audit = await auditPptx(input, { output: auditPath });
  let render;
  try {
    const rendered = await renderPptx(input, path.join(revisionDir, 'slides'), {
      dpi: numberArg(args, 'dpi', 144),
    });
    render = {
      status: 'ready',
      directory: rendered.output,
      pageCount: rendered.slideCount,
      pages: rendered.slides.map((image, index) => ({ slide: index + 1, image })),
      baseline: rendered.baseline,
      compatibilityNote: rendered.compatibilityNote,
    };
  } catch (error) {
    render = {
      status: 'unavailable',
      pages: [],
      error: error instanceof Error ? error.message : String(error),
      availability: renderingAvailability(),
    };
  }

  const finalHash = await fileSha256(input);
  if (finalHash !== initial.sha256) {
    throw new Error('The PPTX changed while review evidence was being generated; review the latest revision again');
  }
  if (render.status === 'ready' && render.pageCount !== initial.slideCount) {
    throw new Error(`Rendered ${render.pageCount} pages for a ${initial.slideCount}-slide presentation`);
  }

  const report = {
    status: render.status === 'ready' ? 'review_pending' : 'evidence_unavailable',
    input,
    revision: {
      id: revisionId,
      sha256: initial.sha256,
      directory: revisionDir,
      evidenceId,
    },
    structure: reviewStructure(initial),
    audit,
    render,
    visualReview: render.status === 'ready' ? {
      status: 'pending',
      instruction: `These images describe ${revisionId}. Open the slides relevant to the request and your changes before making visual claims. If the PPTX changes, run review again and use only the new revision's images.`,
    } : {
      status: 'unavailable',
      instruction: 'Report the rendering limitation; no visual judgment was performed.',
    },
    judgment: 'Use the structural findings and rendered slides as evidence. The report does not decide whether the presentation is good or complete.',
  };
  const reportPath = await writeJson(path.join(revisionDir, 'report.json'), report);
  if (reportOutput) await writeJson(reportOutput, report);
  return {
    status: report.status,
    input: report.input,
    revision: report.revision,
    structure: {
      slideCount: report.structure.slideCount,
      slideSize: report.structure.slideSize,
      masterCount: report.structure.masterCount,
      layoutCount: report.structure.layoutCount,
    },
    audit: {
      status: audit.status,
      counts: audit.counts,
      report: auditPath,
    },
    render: report.render,
    visualReview: report.visualReview,
    judgment: report.judgment,
    report: reportPath,
  };
}

async function evaluateCommand(args) {
  const input = assertInternalPath(required(args, 'input'), 'PPTX candidate');
  const script = assertInternalPath(required(args, 'script'), 'PPTX evaluator');
  const output = assertInternalPath(required(args, 'out'), 'PPTX evaluation report');
  assertDistinctPaths({ candidate: input, evaluator: script, report: output });
  const stat = await fs.stat(script);
  const module = await import(`${pathToFileURL(script).href}?mtime=${stat.mtimeMs}-${Date.now()}`);
  if (typeof module.default !== 'function') throw new Error('Evaluator must export a default async function');
  const manifest = await inspectPptx(input);
  const product = await module.default({
    inputPath: input,
    candidate: manifest,
    inspectPptx,
    helpers: {
      allText: (deck = manifest) => deck.slides.map((slide) => slide.text).join('\n'),
      slideText: (number, deck = manifest) => deck.slides[number - 1]?.text ?? '',
      findText: (pattern, deck = manifest) => deck.slides
        .filter((slide) => typeof pattern === 'string' ? slide.text.includes(pattern) : pattern.test(slide.text))
        .map((slide) => slide.number),
    },
  });
  if (!product || typeof product !== 'object' || !Array.isArray(product.checks)) {
    throw new Error('Evaluator must return { checks: [{ name, passed, ...details }] }');
  }
  const checks = product.checks.map((check, index) => {
    if (!check || typeof check !== 'object') throw new Error(`Evaluator checks[${index}] must be an object`);
    const name = String(check.name ?? '').trim();
    if (!name || typeof check.passed !== 'boolean') {
      throw new Error(`Evaluator checks[${index}] requires a name and boolean passed value`);
    }
    return { ...check, name, passed: check.passed };
  });
  const failed = checks.filter((check) => !check.passed);
  const report = {
    ...product,
    status: checks.length === 0 ? 'partial' : failed.length ? 'error' : 'ok',
    input,
    revision: manifest.sha256,
    evaluator: { path: script, sha256: await fileSha256(script) },
    checks,
    failed,
  };
  await writeJson(output, report);
  if (failed.length) process.exitCode = 1;
  return report;
}

async function fallbackPatchCommand(args) {
  const timeoutSeconds = numberArg(args, 'timeout', 120);
  if (timeoutSeconds <= 0) throw new Error('--timeout must be greater than zero');
  return fallbackPatchPptx({
    inputPath: required(args, 'input'),
    scriptPath: required(args, 'script'),
    outputPath: required(args, 'out'),
    reportPath: args.report === undefined ? undefined : required(args, 'report'),
    timeoutSeconds,
  });
}

async function deliverCommand(args) {
  return deliverPptx(required(args, 'input'), required(args, 'out'), {
    overwrite: Boolean(args.overwrite),
  });
}

async function convertLegacyCommand(args) {
  const input = path.resolve(required(args, 'input'));
  const output = assertInternalPath(required(args, 'out'), 'Converted PPTX candidate');
  const qaDir = assertInternalPath(required(args, 'qa-dir'), 'Legacy PPT review directory');
  assertDistinctPaths({ input, output, qaDir });
  const report = await convertLegacyPpt(input, output, {
    qaDir,
    force: Boolean(args.force),
  });
  if (report.status === 'failed') process.exitCode = 1;
  return report;
}

function help() {
  return {
    usage: 'pptx.sh <command> [options]',
    workflow: {
      inspect: '--input source.pptx [--out manifest.json]',
      scaffold: '--out deck.mjs [--input source.pptx --force]',
      build: '--builder deck.mjs --out candidate.pptx [--input source.pptx]',
      'fallback-patch': '--input source-or-candidate.pptx --script patch.mjs --out candidate.pptx [--report report.json --timeout 120]',
      review: '--input candidate.pptx --out-dir review [--report report.json --dpi 144]',
      evaluate: '--input candidate.pptx --script evaluator.mjs --out evaluation.json',
      deliver: '--input candidate.pptx --out final.pptx [--overwrite]',
    },
    specialized: {
      'convert-legacy': '--input source.ppt --out converted.pptx --qa-dir DIR',
    },
  };
}

const [command = 'help', ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  let result;
  if (command === 'scaffold') result = await scaffoldCommand(args);
  else if (command === 'build') result = await buildCommand(args);
  else if (command === 'inspect') result = await inspectCommand(args);
  else if (command === 'review') result = await reviewCommand(args);
  else if (command === 'evaluate') result = await evaluateCommand(args);
  else if (command === 'fallback-patch') result = await fallbackPatchCommand(args);
  else if (command === 'deliver') result = await deliverCommand(args);
  else if (command === 'convert-legacy') result = await convertLegacyCommand(args);
  else if (['help', '-h', '--help'].includes(command)) result = help();
  else throw new Error(`Unknown command: ${command}`);
  print(result);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}
