import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function numericSort(a, b) {
  const aNum = Number(path.basename(a).match(/(\d+)/)?.[1] ?? 0);
  const bNum = Number(path.basename(b).match(/(\d+)/)?.[1] ?? 0);
  return aNum - bNum || a.localeCompare(b);
}

export function renderingAvailability() {
  const soffice = process.env.PPTX_SKILL_SOFFICE || null;
  const renderer = process.env.PPTX_SKILL_PDF_RENDERER || null;
  return { available: Boolean(soffice && renderer), soffice, renderer };
}

async function clearPriorSlides(outputDir) {
  const entries = await fs.readdir(outputDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^slide-\d+\.png$/i.test(entry.name))
    .map((entry) => fs.unlink(path.join(outputDir, entry.name))));
}

async function renderPdf(pdfPath, outputDir, dpi, renderer) {
  const base = path.basename(renderer).toLowerCase();
  if (base.includes('pdftoppm')) {
    run(renderer, ['-png', '-r', String(dpi), pdfPath, path.join(outputDir, 'slide')]);
    return;
  }
  if (base.includes('mutool')) {
    run(renderer, ['draw', '-r', String(dpi), '-o', path.join(outputDir, 'slide-%d.png'), pdfPath]);
    return;
  }
  if (base.includes('magick')) {
    run(renderer, ['-density', String(dpi), pdfPath, path.join(outputDir, 'slide-%d.png')]);
    const zero = path.join(outputDir, 'slide-0.png');
    if (await fs.stat(zero).then(() => true).catch(() => false)) {
      const files = (await fs.readdir(outputDir)).filter((name) => /^slide-\d+\.png$/.test(name)).sort(numericSort).reverse();
      for (const name of files) {
        const number = Number(name.match(/(\d+)/)[1]);
        await fs.rename(path.join(outputDir, name), path.join(outputDir, `slide-${number + 1}.png`));
      }
    }
    return;
  }
  throw new Error(`Unsupported PDF renderer: ${renderer}`);
}

export async function renderPptx(inputPath, outputDir, options = {}) {
  const availability = renderingAvailability();
  if (!availability.available) {
    throw new Error('Rendering requires LibreOffice plus pdftoppm, mutool, or ImageMagick');
  }
  const input = path.resolve(inputPath);
  const output = path.resolve(outputDir);
  const dpi = Number(options.dpi ?? 144);
  await fs.mkdir(output, { recursive: true });
  await clearPriorSlides(output);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-pptx-render-'));
  const profile = path.join(temp, 'lo-profile');
  await fs.mkdir(profile, { recursive: true });
  try {
    run(availability.soffice, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      temp,
      input,
    ]);
    const pdf = path.join(temp, `${path.parse(input).name}.pdf`);
    const exists = await fs.stat(pdf).then(() => true).catch(() => false);
    if (!exists) throw new Error(`LibreOffice did not produce ${pdf}`);
    await renderPdf(pdf, output, dpi, availability.renderer);
    const slides = (await fs.readdir(output))
      .filter((name) => /^slide-\d+\.png$/i.test(name))
      .map((name) => path.join(output, name))
      .sort(numericSort);
    if (!slides.length) throw new Error('PDF renderer did not produce any slide images');
    return {
      status: 'ready',
      baseline: 'libreoffice',
      engine: availability.soffice,
      rasterizer: availability.renderer,
      input,
      output,
      dpi,
      slides,
      slideCount: slides.length,
      compatibilityNote: 'LibreOffice rendering is a baseline and may substitute fonts differently from Microsoft PowerPoint.',
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
