import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPptx } from './ooxml.mjs';

const PLACEHOLDER_PATTERNS = [
  /lorem ipsum/i,
  /click to add/i,
  /replace (me|this)/i,
  /\b(?:todo|tbd)\b/i,
  /在此处(?:添加|键入)/,
  /单击此处/,
];

function intersection(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function contains(a, b, tolerance = 0.03) {
  return b.x >= a.x - tolerance
    && b.y >= a.y - tolerance
    && b.x + b.w <= a.x + a.w + tolerance
    && b.y + b.h <= a.y + a.h + tolerance;
}

function isDecorative(object, slideArea) {
  const name = object.name ?? '';
  const area = object.bounds ? object.bounds.w * object.bounds.h : 0;
  return /background|backdrop|decoration|accent|rule|line|footer|page number/i.test(name)
    || area >= slideArea * 0.7;
}

function textUnits(text) {
  let units = 0;
  for (const char of text) {
    units += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/u.test(char) ? 1 : 0.55;
  }
  return units;
}

function textFitRisk(object) {
  if (!object.text || !object.bounds || !object.fontPoints) return null;
  const { w, h } = object.bounds;
  if (w <= 0 || h <= 0) return null;
  const lineCapacity = Math.max(1, (w * 72) / object.fontPoints);
  const estimatedLines = Math.ceil(textUnits(object.text) / lineCapacity);
  const estimatedHeight = (estimatedLines * object.fontPoints * 1.22) / 72;
  if (estimatedHeight <= h * 1.12) return null;
  return { estimatedLines, estimatedHeight: Math.round(estimatedHeight * 100) / 100 };
}

export async function auditPptx(inputPath, options = {}) {
  const manifest = await inspectPptx(inputPath);
  const errors = [];
  const warnings = [];
  const { width, height } = manifest.slideSize;
  const slideArea = width * height;
  const tolerance = options.tolerance ?? 0.02;

  if (!manifest.slideCount) errors.push({ code: 'empty_deck', message: 'Presentation has no slides' });

  for (const slide of manifest.slides) {
    for (const object of slide.objects) {
      const label = object.name || `${object.type}#${object.id ?? '?'}`;
      if (object.bounds) {
        const { x, y, w, h } = object.bounds;
        if (w < 0 || h < 0 || x < -tolerance || y < -tolerance || x + w > width + tolerance || y + h > height + tolerance) {
          errors.push({
            code: 'out_of_bounds',
            slide: slide.number,
            object: label,
            bounds: object.bounds,
            message: `${label} extends outside the ${width}×${height} inch slide canvas`,
          });
        }
      }
      for (const pattern of PLACEHOLDER_PATTERNS) {
        if (object.text && pattern.test(object.text)) {
          errors.push({
            code: 'unresolved_placeholder',
            slide: slide.number,
            object: label,
            text: object.text,
            message: `${label} contains unresolved placeholder text`,
          });
          break;
        }
      }
      const fit = textFitRisk(object);
      if (fit) {
        warnings.push({
          code: 'text_fit_risk',
          slide: slide.number,
          object: label,
          ...fit,
          message: `${label} may wrap or clip; inspect the rendered slide`,
        });
      }
    }

    const candidates = slide.objects.filter((object) => object.bounds && object.bounds.w > 0 && object.bounds.h > 0);
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const a = candidates[i];
        const b = candidates[j];
        if (a.type === 'connector' || b.type === 'connector') continue;
        if (isDecorative(a, slideArea) || isDecorative(b, slideArea)) continue;
        if (contains(a.bounds, b.bounds) || contains(b.bounds, a.bounds)) continue;
        const overlap = intersection(a.bounds, b.bounds);
        if (!overlap) continue;
        const overlapArea = overlap.w * overlap.h;
        const smallerArea = Math.min(a.bounds.w * a.bounds.h, b.bounds.w * b.bounds.h);
        const ratio = smallerArea ? overlapArea / smallerArea : 0;
        if (ratio < 0.12 || overlapArea < 0.02) continue;
        warnings.push({
          code: 'overlap',
          slide: slide.number,
          objects: [a.name || `${a.type}#${a.id}`, b.name || `${b.type}#${b.id}`],
          overlapRatio: Math.round(ratio * 1000) / 1000,
          message: 'Objects overlap; confirm that this is intentional in the rendered slide',
        });
      }
    }
  }

  const report = {
    schemaVersion: 1,
    file: manifest.file,
    slideCount: manifest.slideCount,
    slideSize: manifest.slideSize,
    status: errors.length || (options.strictOverlap && warnings.some((item) => item.code === 'overlap')) ? 'failed' : 'passed',
    counts: {
      errors: errors.length,
      warnings: warnings.length,
      overlaps: warnings.filter((item) => item.code === 'overlap').length,
      textFitRisks: warnings.filter((item) => item.code === 'text_fit_risk').length,
    },
    errors,
    warnings,
  };
  if (options.output) {
    const output = path.resolve(options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
