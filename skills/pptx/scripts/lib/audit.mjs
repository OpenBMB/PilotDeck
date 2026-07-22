import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateRequirements } from './coverage.mjs';
import { inspectPptx } from './ooxml.mjs';
import { analyzeTypography } from './typography.mjs';

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
    if (/[\u2E80-\u9FFF\uF900-\uFAFF]/u.test(char)) units += 1;
    else if (/\s/u.test(char)) units += 0.3;
    else if (/[.,:;!?%()[\]{}'"`~\-_/\\]/u.test(char)) units += 0.42;
    else units += 0.55;
  }
  return units;
}

function textFitRisk(object) {
  if (!object.text || !object.bounds || !object.fontPoints) return null;
  const { w, h } = object.bounds;
  if (w <= 0 || h <= 0) return null;
  const lineCapacity = Math.max(1, (w * 72) / object.fontPoints);
  const estimatedLines = Math.ceil(textUnits(object.text) / lineCapacity);
  const cjkLineFactor = object.containsCjk ? 1.25 : 1.22;
  const estimatedHeight = (estimatedLines * object.fontPoints * cjkLineFactor) / 72;
  if (estimatedHeight <= h * 1.12) return null;
  const requiredScale = h / estimatedHeight;
  if (object.textFit === 'resize_shape') return null;
  if (object.textFit === 'shrink_text' && requiredScale >= 0.72) return null;
  return {
    estimatedLines,
    estimatedHeight: Math.round(estimatedHeight * 100) / 100,
    textFit: object.textFit,
    requiredScale: Math.round(requiredScale * 1000) / 1000,
  };
}

function issueIds(issues) {
  const counts = new Map();
  return issues.map((issue) => {
    const target = issue.object
      || issue.requirement
      || issue.objects?.join('-')
      || 'deck';
    const slug = String(target).toLocaleLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'item';
    const base = `${issue.code}:slide-${issue.slide ?? 'all'}:${slug}`;
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    return { id: occurrence === 1 ? base : `${base}:${occurrence}`, ...issue };
  });
}

async function applyDispositions(warnings, source, artifactSha256) {
  if (!source) {
    return {
      source: null,
      artifactSha256: null,
      warnings: warnings.map((item) => ({ ...item, resolved: false, disposition: null })),
    };
  }
  const specification = typeof source === 'object'
    ? source
    : JSON.parse(await fs.readFile(path.resolve(source), 'utf8'));
  if (!specification.artifactSha256) {
    throw new Error('Disposition file must include artifactSha256');
  }
  if (specification.artifactSha256 !== artifactSha256) {
    throw new Error(`Disposition artifactSha256 does not match the audited PPTX (${artifactSha256})`);
  }
  const entries = specification.warnings ?? specification.dispositions;
  if (!Array.isArray(entries)) throw new Error('Disposition file must contain a warnings or dispositions array');
  const allowed = new Set(['accepted', 'intentional', 'false_positive']);
  const byId = new Map();
  for (const entry of entries) {
    if (!entry?.id || typeof entry.id !== 'string') throw new Error('Every disposition must include a warning id');
    if (byId.has(entry.id)) throw new Error(`Duplicate disposition warning id: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  const warningIds = new Set(warnings.map((item) => item.id));
  const unknownIds = [...byId.keys()].filter((id) => !warningIds.has(id));
  if (unknownIds.length) throw new Error(`Disposition file contains stale or unknown warning ids: ${unknownIds.join(', ')}`);
  return {
    source: typeof source === 'string' ? path.resolve(source) : 'inline',
    artifactSha256: specification.artifactSha256,
    warnings: warnings.map((item) => {
      const disposition = byId.get(item.id) ?? null;
      const reason = String(disposition?.reason ?? '').trim();
      const evidence = Array.isArray(disposition?.evidence)
        ? disposition.evidence.filter(Boolean).join('; ').trim()
        : String(disposition?.evidence ?? '').trim();
      const resolved = Boolean(disposition && allowed.has(disposition.decision) && reason && evidence);
      return { ...item, resolved, disposition };
    }),
  };
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
      const duplicateUnit = object.text?.match(/(万元|亿元|个百分点|元|万|亿|%)\s+\1/u);
      if (duplicateUnit) {
        warnings.push({
          code: 'duplicate_unit',
          slide: slide.number,
          object: label,
          value: duplicateUnit[0],
          message: `${label} contains a repeated measurement unit; verify the visible copy`,
        });
      }
      const fit = textFitRisk(object);
      if (fit) {
        warnings.push({
          code: 'text_fit_risk',
          slide: slide.number,
          object: label,
          ...fit,
          message: fit.textFit === 'shrink_text'
            ? `${label} may require excessive automatic shrinking; inspect the rendered slide`
            : `${label} may wrap or clip; inspect the rendered slide`,
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

  const coverage = await evaluateRequirements(manifest, options.requirements);
  errors.push(...coverage.errors);
  warnings.push(...coverage.warnings);
  const typography = analyzeTypography(manifest, { targetPlatform: options.targetPlatform });
  warnings.push(...typography.warnings.map((item) => ({ ...item, category: 'typography' })));
  if (options.strictOverlap) {
    errors.push(...warnings
      .filter((item) => item.code === 'overlap')
      .map((item) => ({
        code: 'strict_overlap',
        slide: item.slide,
        objects: item.objects,
        message: 'Object overlap is a blocker because strict overlap mode is enabled',
      })));
  }

  const identifiedErrors = issueIds(errors);
  const dispositionResult = await applyDispositions(issueIds(warnings), options.dispositions, manifest.sha256);
  const identifiedWarnings = dispositionResult.warnings;
  const unresolvedWarnings = identifiedWarnings.filter((item) => !item.resolved);

  const report = {
    schemaVersion: 2,
    file: manifest.file,
    sha256: manifest.sha256,
    slideCount: manifest.slideCount,
    slideSize: manifest.slideSize,
    status: identifiedErrors.length ? 'failed' : unresolvedWarnings.length ? 'passed_with_warnings' : 'passed',
    counts: {
      errors: identifiedErrors.length,
      warnings: identifiedWarnings.length,
      resolvedWarnings: identifiedWarnings.filter((item) => item.resolved).length,
      unresolvedWarnings: identifiedWarnings.filter((item) => !item.resolved).length,
      overlaps: identifiedWarnings.filter((item) => item.code === 'overlap').length,
      textFitRisks: identifiedWarnings.filter((item) => item.code === 'text_fit_risk').length,
      typographyWarnings: identifiedWarnings.filter((item) => item.category === 'typography').length,
    },
    coverage,
    typography,
    dispositions: {
      source: dispositionResult.source,
      artifactSha256: dispositionResult.artifactSha256,
    },
    errors: identifiedErrors,
    warnings: identifiedWarnings,
  };
  if (options.output) {
    const output = path.resolve(options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
