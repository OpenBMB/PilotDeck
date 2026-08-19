import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPptx, validatePptxPackage } from './ooxml.mjs';
import {
  assertDeliveryPath,
  assertDistinctPaths,
  assertInternalPath,
  fileSha256,
  pathExists,
} from './paths.mjs';

export async function deliverPptx(inputPath, outputPath, options = {}) {
  const input = assertInternalPath(inputPath, 'PPTX candidate');
  const output = assertDeliveryPath(outputPath);
  assertDistinctPaths({ candidate: input, deliverable: output });
  if (path.extname(output).toLowerCase() !== '.pptx') {
    throw new Error('The final presentation must use a .pptx extension');
  }
  const outputExists = await pathExists(output);
  if (outputExists && !options.overwrite) {
    throw new Error(`Refusing to overwrite existing deliverable: ${output}`);
  }

  const manifest = await inspectPptx(input);
  if (manifest.slideCount < 1) throw new Error('Cannot deliver an empty presentation');
  const digest = manifest.sha256;
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`,
  );
  let packageValidation;
  try {
    await fs.copyFile(input, temporary);
    packageValidation = await validatePptxPackage(temporary);
    const copiedManifest = await inspectPptx(temporary);
    if (copiedManifest.sha256 !== digest) throw new Error('Delivered copy does not match the candidate');
    if (outputExists) await fs.rm(output);
    await fs.rename(temporary, output);
    if (await fileSha256(output) !== digest) throw new Error('Final deliverable does not match the candidate');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }

  return {
    status: 'ok',
    input,
    output,
    sha256: digest,
    slideCount: manifest.slideCount,
    validation: {
      status: 'ok',
      format: 'pptx',
      package: 'ooxml',
      textPartCount: packageValidation.textPartCount,
      relationshipCount: packageValidation.relationshipCount,
      contentTypeCount: packageValidation.contentTypeCount,
      mappedPartCount: packageValidation.mappedPartCount,
    },
  };
}
