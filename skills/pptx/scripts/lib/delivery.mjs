import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePptxPackage } from './ooxml.mjs';
import {
  assertDeliveryPath,
  assertInternalPath,
  fileSha256,
  pathExists,
  pilotDeckWorkDir,
  samePath,
} from './paths.mjs';

function requirePptxPath(filePath, purpose) {
  const resolved = path.resolve(filePath);
  if (path.extname(resolved).toLowerCase() !== '.pptx') {
    throw new Error(`${purpose} must use a .pptx extension`);
  }
  return resolved;
}

async function backupSource(source) {
  const workDir = pilotDeckWorkDir();
  if (!workDir) throw new Error('PILOTDECK_WORK_DIR is required for recoverable source replacement');
  const digest = await fileSha256(source);
  const directory = path.join(workDir, 'pptx', 'recovery');
  const parsed = path.parse(source);
  const backup = path.join(directory, `${parsed.name}-${digest.slice(0, 16)}${parsed.ext}`);
  await fs.mkdir(directory, { recursive: true });
  if (!await pathExists(backup)) await fs.copyFile(source, backup);
  if (await fileSha256(backup) !== digest) throw new Error('The PPTX source recovery copy failed its digest check');
  return { path: backup, sha256: digest };
}

export async function deliverPptx(inputPath, outputPath, options = {}) {
  const input = requirePptxPath(assertInternalPath(inputPath, 'PPTX candidate'), 'PPTX candidate');
  const output = requirePptxPath(assertDeliveryPath(outputPath), 'Final presentation');
  const source = options.source ? requirePptxPath(options.source, 'PPTX source') : null;
  const replaceSource = Boolean(options.replaceSource);
  const overwrite = Boolean(options.overwrite);

  if (samePath(input, output)) throw new Error('The deliverable must be distinct from the internal candidate');
  if (source && samePath(input, source)) throw new Error('The internal candidate must be distinct from the source presentation');
  if (source && !await pathExists(source)) throw new Error(`PPTX source does not exist: ${source}`);

  const replacingSource = Boolean(source && samePath(output, source));
  if (replaceSource && !replacingSource) {
    throw new Error('--replace-source requires --source and --out to identify the same source file');
  }
  if (replacingSource && !replaceSource) {
    throw new Error('Refusing to replace the source presentation without --replace-source');
  }
  if (await pathExists(output) && !(overwrite || replacingSource)) {
    throw new Error(`Refusing to overwrite existing deliverable: ${output}`);
  }

  const structure = await validatePptxPackage(input);
  const digest = await fileSha256(input);
  const sourceDigest = source ? await fileSha256(source) : null;
  const recovery = replacingSource ? await backupSource(source) : null;

  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.copyFile(input, temporary);
    await validatePptxPackage(temporary);
    if (await fileSha256(temporary) !== digest) throw new Error('The staged deliverable does not match the candidate');
    await fs.rename(temporary, output);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }

  if (await fileSha256(output) !== digest) throw new Error('The final deliverable does not match the candidate');
  if (source && !replacingSource && await fileSha256(source) !== sourceDigest) {
    throw new Error('The source presentation changed during delivery');
  }
  return {
    status: 'ok',
    input,
    output,
    sha256: digest,
    source,
    sourceReplaced: replacingSource,
    recovery,
    structure: {
      packageReadable: structure.package.readable,
      slideCount: structure.presentation.slideCount,
      relationshipCount: structure.package.relationshipCount,
      partCount: structure.package.partCount,
    },
  };
}
