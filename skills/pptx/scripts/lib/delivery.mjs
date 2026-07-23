import fs from 'node:fs/promises';
import path from 'node:path';
import { auditPptx } from './audit.mjs';
import { inspectPptx } from './ooxml.mjs';
import { renderPptx, renderingAvailability } from './render.mjs';

async function writeJson(file, value) {
  const output = path.resolve(file);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(value, null, 2)}\n`);
  return output;
}

async function existingFile(file) {
  return fs.stat(file).then((stat) => stat.isFile()).catch(() => false);
}

async function resolveRequirements(input, qaDir, explicit) {
  if (explicit && typeof explicit === 'object') return { source: explicit, discovered: false, candidates: [] };
  if (explicit) {
    const source = path.resolve(explicit);
    if (!await existingFile(source)) throw new Error(`Requirements file does not exist: ${source}`);
    return { source, discovered: false, candidates: [source] };
  }
  const workspace = path.dirname(qaDir);
  const candidates = [
    `${input}.requirements.json`,
    path.join(qaDir, 'requirements.json'),
    path.join(workspace, 'tmp', 'requirements.json'),
    path.join(workspace, 'requirements.json'),
  ].map((file) => path.resolve(file));
  for (const candidate of candidates) {
    if (await existingFile(candidate)) return { source: candidate, discovered: true, candidates };
  }
  return { source: null, discovered: false, candidates };
}

export async function verifyFinalPptx(inputPath, options = {}) {
  const input = path.resolve(inputPath);
  const qaDir = path.resolve(options.qaDir || `${input}.qa`);
  await fs.mkdir(qaDir, { recursive: true });
  const initial = await inspectPptx(input);
  const requirements = await resolveRequirements(input, qaDir, options.requirements);
  const requireCoverage = Boolean(options.requireCoverage || requirements.source);
  const audit = await auditPptx(input, {
    output: path.join(qaDir, 'audit.json'),
    tolerance: options.tolerance,
    strictOverlap: options.strictOverlap,
    requirements: requirements.source,
    dispositions: options.dispositions,
    targetPlatform: options.targetPlatform,
  });

  const availability = renderingAvailability();
  let render;
  if (!availability.available) {
    render = {
      status: 'skipped',
      baseline: 'libreoffice',
      reason: 'LibreOffice or a supported PDF renderer is unavailable',
      availability,
    };
  } else {
    try {
      render = await renderPptx(input, path.join(qaDir, 'slides'), {
        dpi: options.dpi ?? 144,
        montage: path.join(qaDir, 'montage.png'),
        pdf: options.pdf === false ? undefined : path.join(qaDir, 'rendered.pdf'),
        columns: options.columns,
      });
      if (render.slideCount !== initial.slideCount) {
        render = {
          ...render,
          status: 'failed',
          reason: 'slide_count_mismatch',
          expectedSlideCount: initial.slideCount,
        };
      } else if (audit.typography.languages.hasCjk) {
        render = {
          ...render,
          // This is an advisory rather than an unresolved artifact warning.
          // PowerPoint remains the target viewer; LibreOffice is the baseline.
          advisories: [{
            code: 'renderer_cjk_visual_review_required',
            message: 'The PPTX contains Chinese text. Inspect the PNGs for baseline issues, but treat Microsoft PowerPoint as the target-viewer authority.',
          }],
        };
      }
    } catch (error) {
      render = {
        status: 'failed',
        baseline: 'libreoffice',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const final = await inspectPptx(input);
  const integrityErrors = [];
  if (initial.sha256 !== final.sha256) {
    integrityErrors.push({
      code: 'artifact_changed_during_verification',
      before: initial.sha256,
      after: final.sha256,
      message: 'The PPTX changed while audit and rendering were running',
    });
  }
  if (initial.slideCount !== final.slideCount) {
    integrityErrors.push({
      code: 'slide_count_changed_during_verification',
      before: initial.slideCount,
      after: final.slideCount,
      message: 'The PPTX slide count changed while verification was running',
    });
  }
  if (options.requireRender && render.status === 'skipped') {
    integrityErrors.push({
      code: 'render_required',
      message: 'Final delivery requires rendering, but the rendering baseline was unavailable',
    });
  }

  const gateErrors = [];
  if (requireCoverage && (!requirements.source || audit.coverage.status !== 'passed' || audit.coverage.counts.total < 1)) {
    gateErrors.push({
      code: 'coverage_required',
      source: requirements.source,
      status: audit.coverage.status,
      message: requirements.source
        ? 'Final delivery requires coverage=passed with at least one requirement'
        : 'Final delivery requires a requirements.json file, but none was supplied or discovered',
    });
  }
  if (audit.counts.unresolvedWarnings > 0) {
    gateErrors.push({
      code: 'unresolved_warnings',
      count: audit.counts.unresolvedWarnings,
      message: 'Every audit warning must be fixed or resolved by a hash-bound disposition before delivery',
    });
  }

  const failed = audit.status === 'failed'
    || render.status === 'failed'
    || integrityErrors.length > 0
    || gateErrors.length > 0;
  const hasWarnings = audit.status === 'passed_with_warnings'
    || render.status === 'passed_with_warnings'
    || render.status === 'skipped';
  const status = failed ? 'failed' : hasWarnings ? 'passed_with_warnings' : 'passed';
  const report = {
    schemaVersion: 2,
    status,
    artifact: {
      file: input,
      sha256: final.sha256,
      bytes: final.bytes,
      slideCount: final.slideCount,
      slideSize: final.slideSize,
    },
    integrity: {
      status: integrityErrors.length ? 'failed' : 'passed',
      verifiedSha256: initial.sha256 === final.sha256,
      errors: integrityErrors,
    },
    gates: {
      status: gateErrors.length ? 'failed' : 'passed',
      requireCoverage,
      requireResolvedWarnings: true,
      errors: gateErrors,
    },
    requirements: {
      source: typeof requirements.source === 'string' ? requirements.source : requirements.source ? 'inline' : null,
      discovered: requirements.discovered,
      candidates: requirements.candidates,
    },
    audit,
    render,
    compatibility: {
      targetViewer: 'Microsoft PowerPoint',
      automatedBaseline: 'LibreOffice plus PDF rasterization',
      note: 'A LibreOffice font substitution warning is not by itself proof of a PowerPoint artifact defect.',
    },
  };
  report.report = path.join(qaDir, 'delivery.json');
  await writeJson(report.report, report);
  return report;
}
