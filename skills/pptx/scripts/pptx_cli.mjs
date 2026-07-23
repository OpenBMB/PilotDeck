#!/usr/bin/env node

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, required, numberArg } from './lib/args.mjs';
import { auditPptx } from './lib/audit.mjs';
import { convertLegacyPpt, convertWithLibreOffice } from './lib/convert.mjs';
import { verifyFinalPptx } from './lib/delivery.mjs';
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

async function sealFile(sourcePath, outputPath) {
  const source = path.resolve(sourcePath);
  const output = path.resolve(outputPath);
  if (source === output) return output;
  await fs.mkdir(path.dirname(output), { recursive: true });
  const staging = path.join(path.dirname(output), `.${path.basename(output)}.seal-${process.pid}-${Date.now()}`);
  try {
    await fs.copyFile(source, staging);
    await fs.rm(output, { force: true });
    await fs.rename(staging, output);
    return output;
  } finally {
    await fs.rm(staging, { force: true }).catch(() => {});
  }
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
    response.delivery = await verifyFinalPptx(result.output, {
      qaDir,
      dpi: numberArg(args, 'dpi', 144),
      strictOverlap: Boolean(args['strict-overlap']),
      requirements: args.requirements,
      requireCoverage: Boolean(args['require-coverage']),
      dispositions: args.dispositions,
      targetPlatform: args['target-platform'],
      requireRender: Boolean(args['require-render']),
    });
    response.status = response.delivery.status;
    response.audit = response.delivery.audit;
    response.render = response.delivery.render;
    if (response.delivery.status === 'failed') process.exitCode = 1;
  }
  return response;
}

async function deliverCommand(args) {
  const hasBuilder = Boolean(args.builder && args.builder !== true);
  const hasInput = Boolean(args.input && args.input !== true);
  if (hasBuilder === hasInput) throw new Error('deliver requires exactly one of --builder or --input');
  let build = null;
  let input;
  let requestedOutput = null;
  const qaDir = path.resolve(args['qa-dir'] || (hasBuilder ? `${path.resolve(required(args, 'out'))}.qa` : `${path.resolve(args.input)}.qa`));
  await fs.mkdir(qaDir, { recursive: true });
  if (hasBuilder) {
    requestedOutput = path.resolve(required(args, 'out'));
    input = path.join(qaDir, 'candidate.pptx');
    build = await buildDeck(args.builder, input);
    input = build.output;
  } else {
    input = path.resolve(args.input);
    if (args.out && args.out !== true) requestedOutput = path.resolve(args.out);
  }
  const delivery = await verifyFinalPptx(input, {
    qaDir,
    dpi: numberArg(args, 'dpi', 144),
    columns: numberArg(args, 'columns', undefined),
    strictOverlap: Boolean(args['strict-overlap']),
    requirements: args.requirements,
    requireCoverage: Boolean(args['require-coverage']),
    dispositions: args.dispositions,
    targetPlatform: args['target-platform'],
    requireRender: Boolean(args['require-render']),
    pdf: args.pdf !== false,
  });
  let sealedOutput = null;
  if (delivery.status === 'passed') {
    sealedOutput = requestedOutput ? await sealFile(input, requestedOutput) : input;
    const sealedManifest = await inspectPptx(sealedOutput);
    if (sealedManifest.sha256 !== delivery.artifact.sha256) {
      throw new Error('Sealed output hash does not match the verified delivery artifact');
    }
    delivery.artifact.file = sealedOutput;
    delivery.audit.file = sealedOutput;
    if (delivery.render?.input) delivery.render.input = sealedOutput;
    delivery.seal = {
      status: 'passed',
      requestedOutput,
      output: sealedOutput,
      sha256: sealedManifest.sha256,
    };
    await writeJson(delivery.report, delivery);
    if (hasBuilder && input !== sealedOutput) await fs.rm(input, { force: true });
  } else {
    delivery.seal = {
      status: 'blocked',
      requestedOutput,
      output: null,
      candidate: input,
      reason: 'Only a delivery with status=passed can be sealed to the requested output path',
    };
    await writeJson(delivery.report, delivery);
    process.exitCode = 1;
  }
  return {
    status: delivery.status,
    build,
    requestedOutput,
    candidate: delivery.status === 'passed' ? null : input,
    output: sealedOutput,
    delivery,
  };
}

async function convertCommand(args) {
  const report = await convertLegacyPpt(required(args, 'input'), required(args, 'out'), {
    qaDir: args['qa-dir'],
    dpi: numberArg(args, 'dpi', 120),
    fidelityThreshold: numberArg(args, 'fidelity-threshold', 0.01),
    force: Boolean(args.force),
  });
  if (report.status === 'failed') process.exitCode = 1;
  return report;
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
    requirements: args.requirements,
    dispositions: args.dispositions,
    targetPlatform: args['target-platform'],
  });
  if (report.status === 'failed') process.exitCode = 1;
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
    if (audit.status === 'failed') throw new Error(`Self-test deck failed audit: ${JSON.stringify(audit.errors)}`);

    const cjkBuilder = path.join(workspace, 'cjk-self-test.mjs');
    await fs.copyFile(path.join(skillRoot(), 'assets/cjk-self-test-deck.mjs'), cjkBuilder);
    const cjkSource = path.join(workspace, 'cjk-self-test.pptx');
    result.checks.cjkBuild = await buildDeck(cjkBuilder, cjkSource);
    const cjkManifest = await inspectPptx(cjkSource);
    if (cjkManifest.slideCount !== 4) throw new Error(`Expected 4 CJK slides, found ${cjkManifest.slideCount}`);
    if (!cjkManifest.slides.some((slide) => slide.text.includes('中文演示文稿'))) {
      throw new Error('CJK text was not preserved in the generated PPTX');
    }
    if (!cjkManifest.fontUsage.length) throw new Error('CJK font usage was not extracted from OOXML');
    result.checks.cjkInspect = {
      slideCount: cjkManifest.slideCount,
      fonts: cjkManifest.fontUsage.map((item) => item.fontFace),
    };
    const requirements = await writeJson(path.join(workspace, 'tmp', 'requirements.json'), {
      schemaVersion: 1,
      slideCount: 4,
      requirements: [
        { id: 'critical-values', label: '关键数据 11 / 9 / 7', priority: 'critical', terms: ['11', '9', '7'] },
        { id: 'cross-platform', label: '跨平台说明', priority: 'recommended', terms: [['macOS', 'Mac'], 'Windows'] },
      ],
    });
    const cjkAudit = await auditPptx(cjkSource, {
      output: path.join(workspace, 'cjk-audit.json'),
      requirements,
      targetPlatform: 'cross-platform',
    });
    if (cjkAudit.status === 'failed') throw new Error(`CJK deck failed audit: ${JSON.stringify(cjkAudit.errors)}`);
    if (!cjkAudit.typography.languages.hasCjk) throw new Error('CJK typography analysis did not detect Chinese text');
    if (cjkAudit.coverage.counts.matched !== 3) throw new Error('CJK content and slide-count requirements were not matched');
    if (!cjkAudit.warnings.some((item) => item.code === 'duplicate_unit')) {
      throw new Error('Duplicate measurement-unit warning was not detected');
    }
    result.checks.cjkAudit = { status: cjkAudit.status, ...cjkAudit.counts };

    const dispositions = await writeJson(path.join(workspace, 'warning-dispositions.json'), {
      schemaVersion: 1,
      artifactSha256: cjkManifest.sha256,
      warnings: cjkAudit.warnings.map((item) => ({
        id: item.id,
        decision: 'accepted',
        reason: 'Self-test confirms that every warning can be explicitly dispositioned without hiding it.',
        evidence: 'Full-size self-test render and extracted OOXML text were reviewed.',
      })),
    });
    const dispositionAudit = await auditPptx(cjkSource, {
      requirements,
      dispositions,
      targetPlatform: 'cross-platform',
    });
    if (dispositionAudit.counts.resolvedWarnings !== dispositionAudit.counts.warnings) {
      throw new Error('Warning dispositions were not applied to every matching warning id');
    }
    if (dispositionAudit.status !== 'passed') throw new Error('A fully dispositioned audit must have status=passed');
    result.checks.dispositions = {
      status: dispositionAudit.status,
      resolved: dispositionAudit.counts.resolvedWarnings,
      unresolved: dispositionAudit.counts.unresolvedWarnings,
    };

    let staleDispositionRejected = false;
    try {
      await auditPptx(cjkSource, {
        requirements,
        dispositions: { artifactSha256: '0'.repeat(64), warnings: [] },
        targetPlatform: 'cross-platform',
      });
    } catch (error) {
      staleDispositionRejected = /artifactSha256 does not match/.test(String(error));
    }
    if (!staleDispositionRejected) throw new Error('A stale disposition hash was not rejected');
    result.checks.staleDispositionFailure = { status: 'passed' };

    const missingCoverage = await auditPptx(cjkSource, {
      requirements: {
        requirements: [{ id: 'missing-critical', priority: 'critical', terms: ['9'], slides: [1] }],
      },
    });
    if (missingCoverage.status !== 'failed' || !missingCoverage.errors.some((item) => item.code === 'missing_requirement')) {
      throw new Error('Missing critical requirement did not fail the audit');
    }
    result.checks.coverageFailure = { status: missingCoverage.status, errors: missingCoverage.counts.errors };

    const delivery = await verifyFinalPptx(cjkSource, {
      qaDir: path.join(workspace, 'qa'),
      dpi: numberArg(args, 'dpi', 120),
      requireCoverage: true,
      dispositions,
      targetPlatform: 'cross-platform',
      requireRender: renderingAvailability().available,
    });
    if (delivery.status === 'failed') throw new Error(`CJK delivery verification failed: ${JSON.stringify(delivery.integrity.errors)}`);
    if (delivery.artifact.sha256 !== cjkManifest.sha256 || !delivery.integrity.verifiedSha256) {
      throw new Error('Delivery report was not bound to the verified CJK artifact hash');
    }
    result.checks.delivery = {
      status: delivery.status,
      sha256: delivery.artifact.sha256,
      render: delivery.render.status,
      coverage: delivery.audit.coverage.status,
      requirementsDiscovered: delivery.requirements.discovered,
    };
    if (delivery.status !== 'passed' || delivery.audit.coverage.status !== 'passed' || !delivery.requirements.discovered) {
      throw new Error('Final delivery did not enforce discovered coverage and resolved warnings');
    }

    const missingCoverageDelivery = await verifyFinalPptx(cjkSource, {
      qaDir: path.join(workspace, 'isolated-no-requirements', 'qa'),
      dpi: numberArg(args, 'dpi', 96),
      requireCoverage: true,
      dispositions,
      targetPlatform: 'cross-platform',
      requireRender: false,
      pdf: false,
    });
    if (missingCoverageDelivery.status !== 'failed'
      || !missingCoverageDelivery.gates.errors.some((item) => item.code === 'coverage_required')) {
      throw new Error('Missing required coverage did not block delivery');
    }
    result.checks.requiredCoverageFailure = {
      status: missingCoverageDelivery.status,
      gateErrors: missingCoverageDelivery.gates.errors.map((item) => item.code),
    };

    const blockedOutput = path.join(workspace, 'must-not-be-sealed.pptx');
    const previousExitCode = process.exitCode;
    const warningBlockedDelivery = await deliverCommand({
      input: cjkSource,
      out: blockedOutput,
      'qa-dir': path.join(workspace, 'warning-blocked-qa'),
      requirements,
      'require-coverage': true,
      'require-render': renderingAvailability().available,
      'target-platform': 'cross-platform',
      dpi: numberArg(args, 'dpi', 96),
    });
    process.exitCode = previousExitCode;
    const blockedOutputExists = await fs.stat(blockedOutput).then(() => true).catch(() => false);
    if (warningBlockedDelivery.status !== 'failed'
      || !warningBlockedDelivery.delivery.gates.errors.some((item) => item.code === 'unresolved_warnings')
      || blockedOutputExists) {
      throw new Error('Unresolved warnings did not block atomic sealing');
    }
    result.checks.unresolvedWarningSealFailure = {
      status: warningBlockedDelivery.status,
      outputExists: blockedOutputExists,
      gateErrors: warningBlockedDelivery.delivery.gates.errors.map((item) => item.code),
    };

    const sealedOutput = path.join(workspace, 'sealed-cjk.pptx');
    const sealedDelivery = await deliverCommand({
      input: cjkSource,
      out: sealedOutput,
      'qa-dir': path.join(workspace, 'sealed-qa'),
      'require-coverage': true,
      'require-render': renderingAvailability().available,
      dispositions,
      'target-platform': 'cross-platform',
      dpi: numberArg(args, 'dpi', 96),
    });
    if (sealedDelivery.status !== 'passed' || sealedDelivery.output !== sealedOutput) {
      throw new Error('Verified input was not sealed to the requested final output');
    }
    const sealedManifest = await inspectPptx(sealedOutput);
    if (sealedManifest.sha256 !== cjkManifest.sha256) throw new Error('Sealed delivery hash changed');
    result.checks.atomicSeal = {
      status: sealedDelivery.delivery.seal.status,
      output: sealedDelivery.output,
      sha256: sealedManifest.sha256,
    };

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
    if (editedAudit.status === 'failed') throw new Error(`Edited deck failed audit: ${JSON.stringify(editedAudit.errors)}`);
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

      const legacyExportDir = path.join(workspace, 'legacy-export');
      const exportedLegacy = await convertWithLibreOffice(cjkSource, {
        outputDir: legacyExportDir,
        format: 'ppt',
        filter: 'MS PowerPoint 97',
      });
      const legacyInput = path.join(workspace, '旧版 演示.PPT');
      await fs.rename(exportedLegacy, legacyInput);
      const legacyHashBefore = await fs.readFile(legacyInput)
        .then((buffer) => crypto.createHash('sha256').update(buffer).digest('hex'));
      const convertedLegacy = path.join(workspace, 'legacy-converted.pptx');
      const conversion = await convertLegacyPpt(legacyInput, convertedLegacy, {
        qaDir: path.join(workspace, 'legacy-conversion-qa'),
        dpi: numberArg(args, 'dpi', 96),
        fidelityThreshold: 0.03,
      });
      if (conversion.status === 'failed') throw new Error(`Legacy .ppt conversion failed: ${JSON.stringify(conversion.errors)}`);
      if (!conversion.source.preserved || conversion.source.sha256 !== legacyHashBefore) {
        throw new Error('Legacy source was not preserved during conversion');
      }
      const convertedManifest = await inspectPptx(convertedLegacy);
      if (convertedManifest.slideCount !== cjkManifest.slideCount
        || !convertedManifest.slides[0].text.includes('中文演示文稿')) {
        throw new Error('Converted legacy presentation lost slides or expected text');
      }
      if (conversion.validation.fidelity.status !== 'passed'
        && !conversion.warnings.some((item) => item.code === 'conversion_visual_difference')) {
        throw new Error('Legacy visual difference was not surfaced as a conversion warning');
      }
      result.checks.legacyPptConversion = {
        status: conversion.status,
        sourceFormat: conversion.source.format,
        slideCount: convertedManifest.slideCount,
        maxDifference: conversion.validation.fidelity.maxDifference,
        warnings: conversion.warnings.map((item) => item.code),
      };

      const disguisedInput = path.join(workspace, 'renamed-modern-file.PPT');
      await fs.copyFile(source, disguisedInput);
      const normalizedOutput = path.join(workspace, 'renamed-modern-file.pptx');
      const normalized = await convertLegacyPpt(disguisedInput, normalizedOutput, {
        qaDir: path.join(workspace, 'renamed-modern-qa'),
        dpi: numberArg(args, 'dpi', 96),
      });
      if (normalized.status !== 'passed' || normalized.source.format !== 'pptx' || normalized.conversion.conversionRequired) {
        throw new Error('Content-based format detection did not recognize a renamed PPTX');
      }
      result.checks.renamedPptxDetection = {
        status: normalized.status,
        sourceFormat: normalized.source.format,
      };

      const corruptInput = path.join(workspace, 'corrupt.PPT');
      await fs.writeFile(corruptInput, Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x01]));
      const corruptOutput = path.join(workspace, 'corrupt-converted.pptx');
      const corruptConversion = await convertLegacyPpt(corruptInput, corruptOutput, {
        qaDir: path.join(workspace, 'corrupt-conversion-qa'),
        dpi: 72,
      });
      const corruptOutputExists = await fs.stat(corruptOutput).then(() => true).catch(() => false);
      if (corruptConversion.status !== 'failed' || corruptOutputExists) {
        throw new Error('Corrupt legacy input did not fail closed');
      }
      result.checks.corruptPptFailure = {
        status: corruptConversion.status,
        outputExists: corruptOutputExists,
      };
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
      convert: '--input legacy.ppt --out converted.pptx --qa-dir DIR [--fidelity-threshold 0.01 --force]',
      build: '--builder deck.mjs --out deck.pptx [--verify --qa-dir DIR --strict-overlap]',
      deliver: '(--builder deck.mjs --out deck.pptx | --input candidate.pptx [--out deck.pptx]) [--qa-dir DIR --requirements FILE --require-coverage --dispositions FILE --target-platform cross-platform --require-render]',
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
  else if (command === 'convert') result = await convertCommand(args);
  else if (command === 'build') result = await buildCommand(args);
  else if (command === 'deliver') result = await deliverCommand(args);
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
