#!/usr/bin/env node

import path from 'node:path';
import { parseArgs, required, numberArg } from './lib/args.mjs';
import { comparePptx } from './lib/compare.mjs';
import { convertLegacyPpt } from './lib/convert.mjs';
import { deliverPptx } from './lib/delivery.mjs';
import { validatePptxPackage } from './lib/ooxml.mjs';
import { assertDistinctPaths, assertInternalPath, writeJson } from './lib/paths.mjs';
import { renderPptx } from './lib/render.mjs';

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function validateCommand(args) {
  const input = path.resolve(required(args, 'input'));
  const output = args.out ? assertInternalPath(required(args, 'out'), 'PPTX validation report') : null;
  assertDistinctPaths({ input, report: output });
  const report = await validatePptxPackage(input);
  if (output) await writeJson(output, report);
  return output ? { ...report, report: output } : report;
}

async function renderCommand(args) {
  const input = path.resolve(required(args, 'input'));
  const output = assertInternalPath(required(args, 'out-dir'), 'PPTX render directory');
  assertDistinctPaths({ input, render: output });
  const dpi = numberArg(args, 'dpi', 144);
  if (dpi <= 0) throw new Error('--dpi must be greater than zero');
  return renderPptx(input, output, { dpi });
}

async function compareCommand(args) {
  const source = path.resolve(required(args, 'source'));
  const candidate = assertInternalPath(required(args, 'candidate'), 'PPTX candidate');
  const output = args.out ? assertInternalPath(required(args, 'out'), 'PPTX comparison report') : null;
  assertDistinctPaths({ source, candidate, report: output });
  const report = await comparePptx(source, candidate);
  if (!output) return report;
  await writeJson(output, report);
  return {
    status: report.status,
    changed: report.changed,
    source: report.source,
    candidate: report.candidate,
    summary: report.summary,
    report: output,
    judgment: report.judgment,
  };
}

async function deliverCommand(args) {
  return deliverPptx(required(args, 'input'), required(args, 'out'), {
    source: args.source ? required(args, 'source') : null,
    replaceSource: Boolean(args['replace-source']),
    overwrite: Boolean(args.overwrite),
  });
}

async function convertLegacyCommand(args) {
  const input = path.resolve(required(args, 'input'));
  const output = assertInternalPath(required(args, 'out'), 'Converted PPTX candidate');
  assertDistinctPaths({ input, output });
  return convertLegacyPpt(input, output, { force: Boolean(args.force) });
}

function help() {
  return {
    usage: 'pptx.sh <command> [options]',
    review: {
      validate: '--input candidate.pptx [--out validation.json]',
      render: '--input candidate.pptx --out-dir slides [--dpi 144]',
      compare: '--source original.pptx --candidate candidate.pptx [--out comparison.json]',
    },
    delivery: {
      deliver: '--input candidate.pptx --out final.pptx [--source original.pptx --replace-source] [--overwrite]',
    },
    specialized: {
      'convert-legacy': '--input source.ppt --out converted.pptx [--force]',
    },
  };
}

const [command = 'help', ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  let result;
  if (command === 'validate') result = await validateCommand(args);
  else if (command === 'render') result = await renderCommand(args);
  else if (command === 'compare') result = await compareCommand(args);
  else if (command === 'deliver') result = await deliverCommand(args);
  else if (command === 'convert-legacy') result = await convertLegacyCommand(args);
  else if (['help', '-h', '--help'].includes(command)) result = help();
  else throw new Error(`Unknown command: ${command}`);
  print(result);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
}
