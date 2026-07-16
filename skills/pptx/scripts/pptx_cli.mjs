#!/usr/bin/env node

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, required, numberArg } from './lib/args.mjs';
import { auditPptx } from './lib/audit.mjs';
import { inspectPptx, writeManifest } from './lib/ooxml.mjs';
import { compareRenderedDirectories, renderPptx, renderingAvailability } from './lib/render.mjs';
import { prepareStarter, validateFrameMap } from './lib/template.mjs';
import { buildToolkit } from './lib/toolkit.mjs';
import { skillRoot } from './lib/runtime.mjs';

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeJson(file, value) {
  const output = path.resolve(file);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(value, null, 2)}\n`);
  return output;
}

async function scaffold(args) {
  const output = path.resolve(required(args, 'out'));
  const source = path.join(skillRoot(), 'assets/starter-deck.mjs');
  const exists = await fs.stat(output).then(() => true).catch(() => false);
  if (exists && !args.force) throw new Error(`Refusing to overwrite existing builder: ${output}`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(source, output);
  return { status: 'ok', builder: output };
}

async function loadBuilder(builderPath) {
  const absolute = path.resolve(builderPath);
  const stat = await fs.stat(absolute);
  const module = await import(`${pathToFileURL(absolute).href}?mtime=${stat.mtimeMs}`);
  const build = module.default ?? module.build;
  if (typeof build !== 'function') throw new Error('Builder must export a default function or named build function');
  return { absolute, build };
}

async function buildDeck(builderPath, outputPath) {
  const { absolute, build } = await loadBuilder(builderPath);
  const toolkit = await buildToolkit();
  const result = await build(toolkit);
  const pptx = result?.pptx ?? result;
  if (!pptx || typeof pptx.writeFile !== 'function') {
    throw new Error('Builder must return a PptxGenJS presentation or { pptx }');
  }
  const output = path.resolve(outputPath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await pptx.writeFile({ fileName: output });
  const exists = await fs.stat(output).then(() => true).catch(() => false);
  if (!exists) throw new Error(`Builder did not produce ${output}`);
  return { builder: absolute, output };
}

async function buildCommand(args) {
  const result = await buildDeck(required(args, 'builder'), required(args, 'out'));
  const response = { status: 'ok', ...result };
  if (args.verify) {
    const qaDir = path.resolve(args['qa-dir'] || `${result.output}.qa`);
    await fs.mkdir(qaDir, { recursive: true });
    response.audit = await auditPptx(result.output, { output: path.join(qaDir, 'audit.json'), strictOverlap: Boolean(args['strict-overlap']) });
    if (renderingAvailability().available) {
      response.render = await renderPptx(result.output, path.join(qaDir, 'slides'), {
        dpi: numberArg(args, 'dpi', 144),
        montage: path.join(qaDir, 'montage.png'),
      });
    } else {
      response.render = { status: 'skipped', reason: 'LibreOffice or PDF renderer is unavailable' };
    }
    if (response.audit.status !== 'passed') process.exitCode = 1;
  }
  return response;
}

async function inspectCommand(args) {
  const input = required(args, 'input');
  if (args.out) return writeManifest(input, args.out);
  return inspectPptx(input);
}

async function renderCommand(args) {
  return renderPptx(required(args, 'input'), required(args, 'out-dir'), {
    dpi: numberArg(args, 'dpi', 144),
    montage: args.montage === false ? false : args.montage,
    pdf: args.pdf,
    columns: numberArg(args, 'columns', undefined),
  });
}

async function auditCommand(args) {
  const report = await auditPptx(required(args, 'input'), {
    output: args.out,
    tolerance: numberArg(args, 'tolerance', 0.02),
    strictOverlap: Boolean(args['strict-overlap']),
  });
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

async function validateMapCommand(args) {
  const report = await validateFrameMap(required(args, 'template'), required(args, 'map'), { output: args.out });
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

async function prepareStarterCommand(args, requireEdits = false) {
  if (requireEdits) required(args, 'edits');
  const result = await prepareStarter(required(args, 'template'), required(args, 'map'), required(args, 'out'), {
    edits: args.edits,
    verbose: Boolean(args.verbose),
  });
  return { status: 'ok', ...result };
}

async function fidelityCommand(args) {
  const reference = path.resolve(required(args, 'reference'));
  const candidate = path.resolve(required(args, 'candidate'));
  const output = path.resolve(required(args, 'out-dir'));
  const referenceDir = path.join(output, 'reference');
  const candidateDir = path.join(output, 'candidate');
  await renderPptx(reference, referenceDir, { dpi: numberArg(args, 'dpi', 144), montage: false });
  await renderPptx(candidate, candidateDir, { dpi: numberArg(args, 'dpi', 144), montage: false });
  const report = await compareRenderedDirectories(referenceDir, candidateDir, {
    threshold: numberArg(args, 'threshold', 0.01),
  });
  report.reference = reference;
  report.candidate = candidate;
  report.report = await writeJson(path.join(output, 'fidelity.json'), report);
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

async function selfTest(args) {
  const keep = Boolean(args.keep || args.out);
  const workspace = args.out
    ? path.resolve(args.out)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-self-test-'));
  await fs.mkdir(workspace, { recursive: true });
  const result = { status: 'passed', workspace, checks: {} };
  try {
    const builder = path.join(workspace, 'self-test.mjs');
    await fs.copyFile(path.join(skillRoot(), 'assets/starter-deck.mjs'), builder);
    const source = path.join(workspace, 'self-test.pptx');
    result.checks.build = await buildDeck(builder, source);
    const manifest = await inspectPptx(source);
    result.checks.inspect = { slideCount: manifest.slideCount, objectCount: manifest.slides.reduce((sum, slide) => sum + slide.objectCount, 0) };
    if (manifest.slideCount !== 5) throw new Error(`Expected 5 slides, found ${manifest.slideCount}`);
    const audit = await auditPptx(source, { output: path.join(workspace, 'audit.json') });
    result.checks.audit = audit.counts;
    if (audit.status !== 'passed') throw new Error(`Self-test deck failed audit: ${JSON.stringify(audit.errors)}`);

    const firstSlide = manifest.slides[0];
    const title = firstSlide.objects.find((object) => object.text.includes('Native PowerPoint'));
    if (!title?.name) throw new Error('Could not locate a stable title shape name for template editing');
    const frameMap = {
      version: 1,
      source: source,
      slides: manifest.slides.map((slide) => ({
        outputSlide: slide.number,
        sourceSlide: slide.number,
        editTargets: slide.number === 1 ? [{ name: title.name, action: 'replace-text' }] : [],
      })),
    };
    const mapFile = await writeJson(path.join(workspace, 'frame-map.json'), frameMap);
    const validation = await validateFrameMap(source, mapFile, { output: path.join(workspace, 'frame-map-validation.json') });
    if (validation.status !== 'passed') throw new Error(`Generated frame map failed validation: ${JSON.stringify(validation.errors)}`);
    result.checks.frameMap = { status: validation.status, warnings: validation.warnings.length };

    const clone = path.join(workspace, 'self-test-clone.pptx');
    result.checks.clone = await prepareStarter(source, mapFile, clone);
    const cloneManifest = await inspectPptx(clone);
    if (cloneManifest.slideCount !== manifest.slideCount) throw new Error('Template clone changed the slide count');

    const edits = {
      slides: [{
        outputSlide: 1,
        operations: [{ type: 'text', target: title.name, value: 'Template edit verified' }],
      }],
    };
    const editsFile = await writeJson(path.join(workspace, 'edits.json'), edits);
    const edited = path.join(workspace, 'self-test-edited.pptx');
    result.checks.edit = await prepareStarter(source, mapFile, edited, { edits: editsFile });
    const editedManifest = await inspectPptx(edited);
    if (!editedManifest.slides[0].text.includes('Template edit verified')) {
      throw new Error('Template text replacement did not appear in the edited PPTX');
    }
    const editedAudit = await auditPptx(edited, { output: path.join(workspace, 'edited-audit.json') });
    if (editedAudit.status !== 'passed') throw new Error(`Edited deck failed audit: ${JSON.stringify(editedAudit.errors)}`);
    result.checks.editedAudit = editedAudit.counts;

    if (renderingAvailability().available) {
      result.checks.render = await renderPptx(source, path.join(workspace, 'slides'), {
        dpi: numberArg(args, 'dpi', 120),
        montage: path.join(workspace, 'montage.png'),
      });
      result.checks.editedRender = await renderPptx(edited, path.join(workspace, 'edited-slides'), {
        dpi: numberArg(args, 'dpi', 120),
        montage: path.join(workspace, 'edited-montage.png'),
      });
    } else {
      result.checks.render = { status: 'skipped', reason: 'LibreOffice or PDF renderer is unavailable' };
    }
    return result;
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    return result;
  } finally {
    if (!keep && result.status === 'passed') await fs.rm(workspace, { recursive: true, force: true });
  }
}

function help() {
  return {
    usage: 'pptx.sh <command> [options]',
    commands: {
      scaffold: '--out deck.mjs [--force]',
      build: '--builder deck.mjs --out deck.pptx [--verify --qa-dir DIR --strict-overlap]',
      inspect: '--input deck.pptx [--out manifest.json]',
      render: '--input deck.pptx --out-dir DIR [--dpi 144 --montage montage.png --pdf deck.pdf]',
      audit: '--input deck.pptx [--out audit.json --strict-overlap]',
      'validate-map': '--template source.pptx --map frame-map.json [--out validation.json]',
      'prepare-starter': '--template source.pptx --map frame-map.json --out starter.pptx',
      'apply-template': '--template source.pptx --map frame-map.json --edits edits.json --out result.pptx',
      fidelity: '--reference source.pptx --candidate clone.pptx --out-dir DIR [--threshold 0.01]',
      'self-test': '[--out DIR --keep --dpi 120]',
    },
  };
}

const [command = 'help', ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  let result;
  if (command === 'scaffold') result = await scaffold(args);
  else if (command === 'build') result = await buildCommand(args);
  else if (command === 'inspect') result = await inspectCommand(args);
  else if (command === 'render') result = await renderCommand(args);
  else if (command === 'audit') result = await auditCommand(args);
  else if (command === 'validate-map') result = await validateMapCommand(args);
  else if (command === 'prepare-starter') result = await prepareStarterCommand(args, false);
  else if (command === 'apply-template') result = await prepareStarterCommand(args, true);
  else if (command === 'fidelity') result = await fidelityCommand(args);
  else if (command === 'self-test') result = await selfTest(args);
  else if (['help', '-h', '--help'].includes(command)) result = help();
  else throw new Error(`Unknown command: ${command}`);
  print(result);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
}
