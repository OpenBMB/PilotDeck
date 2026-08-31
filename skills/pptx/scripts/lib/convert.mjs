import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validatePptxPackage } from './ooxml.mjs';
import { fileSha256, pathExists, samePath } from './paths.mjs';
import { renderingAvailability } from './render.mjs';

const OLE_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

async function findConvertedFile(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.pptx')
    .map((entry) => path.join(outputDir, entry.name));
  if (candidates.length !== 1) {
    throw new Error(`LibreOffice produced ${candidates.length} .pptx files in ${outputDir}; expected exactly one`);
  }
  return candidates[0];
}

export async function detectPresentationFormat(inputPath) {
  const input = path.resolve(inputPath);
  const handle = await fs.open(input, 'r');
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= OLE_MAGIC.length && header.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) return 'ppt';
    if (bytesRead >= 2 && header[0] === 0x50 && header[1] === 0x4B) {
      await validatePptxPackage(input);
      return 'pptx';
    }
    return 'unknown';
  } finally {
    await handle.close();
  }
}

export async function convertLegacyPpt(inputPath, outputPath, options = {}) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  if (path.extname(output).toLowerCase() !== '.pptx') {
    throw new Error('Legacy PowerPoint conversion output must use a .pptx extension');
  }
  if (samePath(input, output)) throw new Error('Conversion must preserve the source and use a distinct output path');
  if (await pathExists(output) && !options.force) {
    throw new Error(`Refusing to overwrite existing conversion output without --force: ${output}`);
  }
  const format = await detectPresentationFormat(input);
  if (format === 'pptx') throw new Error('The input is already a PPTX presentation; legacy conversion is unnecessary');
  if (format !== 'ppt') throw new Error('Unsupported presentation format: expected a binary PowerPoint .ppt file');

  const soffice = options.soffice || renderingAvailability().soffice;
  if (!soffice) throw new Error('LibreOffice is required for legacy .ppt conversion');
  const sourceHash = await fileSha256(input);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-ppt-convert-'));
  const profile = path.join(workspace, 'lo-profile');
  const convertedDir = path.join(workspace, 'converted');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(convertedDir, { recursive: true });
  try {
    run(soffice, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--convert-to',
      'pptx:Impress MS PowerPoint 2007 XML',
      '--outdir',
      convertedDir,
      input,
    ]);
    const candidate = await findConvertedFile(convertedDir);
    const structure = await validatePptxPackage(candidate);
    if (await fileSha256(input) !== sourceHash) throw new Error('The source presentation changed during conversion');

    await fs.mkdir(path.dirname(output), { recursive: true });
    const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.copyFile(candidate, temporary);
      if (await fileSha256(temporary) !== structure.sha256) throw new Error('The staged conversion does not match the converted candidate');
      await fs.rename(temporary, output);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    if (await fileSha256(output) !== structure.sha256) throw new Error('The conversion output does not match the converted candidate');
    return {
      status: 'converted_with_warnings',
      source: { path: input, sha256: sourceHash, preserved: true, format: 'ppt' },
      output: {
        path: output,
        sha256: structure.sha256,
        slideCount: structure.presentation.slideCount,
        format: 'pptx',
      },
      engine: soffice,
      warnings: [{
        code: 'legacy-features-require-targeted-review',
        message: 'Legacy animations, macros, OLE objects, WordArt, charts, media, and uncommon fonts may not convert losslessly.',
      }],
    };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
