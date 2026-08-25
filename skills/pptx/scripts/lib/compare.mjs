import path from 'node:path';
import { readPptxFacts } from './ooxml.mjs';

function changedFeatureCounts(before, after) {
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] === after[key]) continue;
    changes[key] = { source: before[key] ?? null, candidate: after[key] ?? null };
  }
  return changes;
}

function packageDifferences(sourceHashes, candidateHashes) {
  const sourceParts = Object.keys(sourceHashes);
  const candidateParts = Object.keys(candidateHashes);
  const sourceSet = new Set(sourceParts);
  const candidateSet = new Set(candidateParts);
  return {
    added: candidateParts.filter((part) => !sourceSet.has(part)).sort(),
    removed: sourceParts.filter((part) => !candidateSet.has(part)).sort(),
    modified: sourceParts
      .filter((part) => candidateSet.has(part) && sourceHashes[part] !== candidateHashes[part])
      .sort(),
  };
}

export async function comparePptx(sourcePath, candidatePath) {
  const source = await readPptxFacts(sourcePath, { includePartHashes: true });
  const candidate = await readPptxFacts(candidatePath, { includePartHashes: true });
  const slides = [];
  const maximum = Math.max(source.slides.length, candidate.slides.length);
  for (let index = 0; index < maximum; index += 1) {
    const before = source.slides[index] ?? null;
    const after = candidate.slides[index] ?? null;
    const textChanged = (before?.text ?? null) !== (after?.text ?? null);
    const notesChanged = (before?.notes ?? null) !== (after?.notes ?? null);
    if (!before || !after || textChanged || notesChanged || before.part !== after.part) {
      slides.push({
        number: index + 1,
        sourcePart: before?.part ?? null,
        candidatePart: after?.part ?? null,
        text: textChanged
          ? { changed: true, source: before?.text ?? null, candidate: after?.text ?? null }
          : { changed: false },
        notes: notesChanged
          ? { changed: true, source: before?.notes ?? null, candidate: after?.notes ?? null }
          : { changed: false },
      });
    }
  }
  const packageParts = packageDifferences(source.partHashes, candidate.partHashes);
  const featureCounts = changedFeatureCounts(source.report.presentation, candidate.report.presentation);
  const changed = source.report.sha256 !== candidate.report.sha256;
  return {
    status: 'ok',
    changed,
    source: {
      path: path.resolve(sourcePath),
      sha256: source.report.sha256,
      slideCount: source.slides.length,
    },
    candidate: {
      path: path.resolve(candidatePath),
      sha256: candidate.report.sha256,
      slideCount: candidate.slides.length,
    },
    summary: {
      slideCountChanged: source.slides.length !== candidate.slides.length,
      changedSlidePositions: slides.length,
      textChangedSlidePositions: slides.filter((slide) => slide.text.changed).length,
      notesChangedSlidePositions: slides.filter((slide) => slide.notes.changed).length,
      addedPartCount: packageParts.added.length,
      removedPartCount: packageParts.removed.length,
      modifiedPartCount: packageParts.modified.length,
      changedFeatureCount: Object.keys(featureCounts).length,
    },
    slides,
    featureCounts,
    packageParts,
    judgment: 'Differences are factual observations, not a pass/fail verdict.',
  };
}
