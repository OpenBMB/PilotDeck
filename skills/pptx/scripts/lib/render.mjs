import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadDependencies } from './runtime.mjs';

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

export async function createMontage(imageFiles, outputPath, options = {}) {
  if (!imageFiles.length) throw new Error('Cannot create a montage without images');
  const { sharp } = loadDependencies();
  const columns = Math.max(1, Number(options.columns ?? Math.min(4, imageFiles.length)));
  const tileWidth = Number(options.tileWidth ?? 480);
  const gap = Number(options.gap ?? 18);
  const background = options.background ?? '#E9EDF2';
  const rendered = [];
  let tileHeight = 0;
  for (const file of imageFiles) {
    const item = await sharp(file).resize({ width: tileWidth }).png().toBuffer({ resolveWithObject: true });
    tileHeight = Math.max(tileHeight, item.info.height);
    rendered.push(item);
  }
  const rows = Math.ceil(rendered.length / columns);
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = rows * tileHeight + (rows + 1) * gap;
  const composites = rendered.map((item, index) => ({
    input: item.data,
    left: gap + (index % columns) * (tileWidth + gap),
    top: gap + Math.floor(index / columns) * (tileHeight + gap),
  }));
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background } })
    .composite(composites)
    .png()
    .toFile(path.resolve(outputPath));
  return path.resolve(outputPath);
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
    let montage = null;
    if (options.montage !== false) {
      montage = path.resolve(options.montage || path.join(output, 'montage.png'));
      await createMontage(slides, montage, { columns: options.columns });
    }
    let exportedPdf = null;
    if (options.pdf) {
      exportedPdf = path.resolve(options.pdf);
      await fs.mkdir(path.dirname(exportedPdf), { recursive: true });
      await fs.copyFile(pdf, exportedPdf);
    }
    return {
      status: 'passed',
      baseline: 'libreoffice',
      engine: availability.soffice,
      rasterizer: availability.renderer,
      input,
      output,
      dpi,
      slides,
      montage,
      pdf: exportedPdf,
      slideCount: slides.length,
      compatibilityNote: 'LibreOffice rendering is a baseline and may substitute fonts differently from Microsoft PowerPoint.',
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function compareRenderedDirectories(referenceDir, candidateDir, options = {}) {
  const { sharp } = loadDependencies();
  const list = async (dir) => (await fs.readdir(path.resolve(dir)))
    .filter((name) => /^slide-\d+\.png$/i.test(name))
    .map((name) => path.join(path.resolve(dir), name))
    .sort(numericSort);
  const reference = await list(referenceDir);
  const candidate = await list(candidateDir);
  if (reference.length !== candidate.length) {
    return { status: 'failed', reason: 'slide_count_mismatch', referenceCount: reference.length, candidateCount: candidate.length, slides: [] };
  }
  const slides = [];
  for (let i = 0; i < reference.length; i += 1) {
    const ref = await sharp(reference[i]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cand = await sharp(candidate[i])
      .resize(ref.info.width, ref.info.height, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let total = 0;
    for (let j = 0; j < ref.data.length; j += 1) total += Math.abs(ref.data[j] - cand.data[j]);
    const meanAbsoluteError = total / (ref.data.length * 255);
    slides.push({ slide: i + 1, meanAbsoluteError: Math.round(meanAbsoluteError * 1000000) / 1000000 });
  }
  const threshold = Number(options.threshold ?? 0.01);
  const maxDifference = Math.max(0, ...slides.map((item) => item.meanAbsoluteError));
  return {
    status: maxDifference <= threshold ? 'passed' : 'failed',
    threshold,
    maxDifference,
    slides,
  };
}
