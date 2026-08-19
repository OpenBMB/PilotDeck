---
name: pptx
description: Create, edit, inspect, render, review, and deliver editable Microsoft PowerPoint .pptx presentations. Use for new decks, source- or template-based presentations, targeted slide edits, charts, tables, images, narrative restructuring, visual QA, and conversion of legacy .ppt inputs to .pptx. Do not use for HTML/browser presentations, Google Slides, or live Microsoft PowerPoint control.
---

# PPTX presentations

Work through four stages:

1. Understand the request and source materials.
2. Build or edit the presentation.
3. Review the actual result.
4. Deliver the reviewed candidate.

Adapt the depth of inspection and verification to the task. Let the model decide the narrative, visual language, layout, and review scope; use scripts for reproducible file operations and evidence.

## Protect files and facts

- Preserve source files unless the user explicitly requests replacement.
- Keep builders, candidates, renders, evaluators, reports, and debug output under `PILOTDECK_WORK_DIR`.
- Do not invent unsupported claims, quotations, dates, names, or values.
- Treat `.pptx` as the editable deliverable. Convert legacy `.ppt` to an internal `.pptx` candidate before further work.
- Deliver only a valid candidate that corresponds to the evidence reviewed.

Resolve the CLI once:

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
PPTX="$SKILL_ROOT/scripts/pptx.sh"
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/pptx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"
bash "$PPTX" check || bash "$PPTX" fix
```

## Understand

Determine the audience, communication purpose, authoritative sources, intended takeaway, expected format, and what must remain unchanged. Distinguish factual sources from visual references.

Inspect structure when an existing presentation matters:

```bash
bash "$PPTX" inspect --input "$INPUT_PPTX"
```

Review the source visually before layout-sensitive edits. Use judgment instead of converting the request into a fixed route, task category, frame map, or collection of boolean permissions.

## Execute

Use one reproducible JavaScript `.mjs` builder for each candidate revision. Scaffold a minimal builder, patch the same file as the work evolves, and build to an internal candidate. Pass the source when the task starts from a template or existing PPTX so the scaffold uses the template editing API:

```bash
bash "$PPTX" scaffold --out "$WORKSPACE/tmp/deck.mjs"
bash "$PPTX" scaffold --input "$INPUT_PPTX" --out "$WORKSPACE/tmp/deck.mjs"
bash "$PPTX" build \
  --builder "$WORKSPACE/tmp/deck.mjs" \
  --out "$WORKSPACE/tmp/candidate.pptx"
```

For template inheritance or an existing PPTX, add `--input "$INPUT_PPTX"`. The builder can call `createTemplatePresentation()` and use the complete pptx-automizer API to select, reorder, preserve, or modify source slides and named objects. On a copied template slide, use `slide.generate()` to add editable PptxGenJS text, shapes, images, charts, or tables, and use `template.setNotes()` to set speaker notes by final output position. Prefer localized edits over reconstruction when the source already contains the desired visual system.

For a new deck, return a PptxGenJS presentation from the builder. Use the complete PptxGenJS API and the optional image crop/contain helpers. Charts, tables, native shapes, prepared graphics, and diagrams are available when they serve the content.

When the standard builder APIs cannot safely express an important package edit, write a task-local patch and run it through the controlled fallback instead of unpacking, repacking, or publishing a PPTX directly:

```bash
bash "$PPTX" fallback-patch \
  --input "$INPUT_OR_CANDIDATE" \
  --script "$WORKSPACE/tmp/patch.mjs" \
  --out "$WORKSPACE/tmp/patched-candidate.pptx" \
  --report "$WORKSPACE/tmp/fallback-report.json"
```

The patch receives a temporary package directory. The wrapper preserves the source, records changed parts, repacks to an internal candidate, and keeps the result in the normal review and delivery flow. See [builder-api.md](references/builder-api.md) for the patch contract.

### Choose presentation intentionally

Follow supplied templates, brand guidance, and explicit art direction. Otherwise choose a coherent visual language appropriate to the audience and subject. Plan the story and visuals together; avoid default branding, decoration, or dense UI-like layouts that do not help the presentation communicate.

## Review

Review the presentation itself, not a handwritten pass status:

```bash
bash "$PPTX" review \
  --input "$WORKSPACE/tmp/candidate.pptx" \
  --out-dir "$WORKSPACE/review"
```

`review_pending` means structural facts, audit observations, and revision-specific slide images are ready; it is not a visual verdict. Choose relevant slides from the task and risk, inspect them at full size, and treat audit findings as evidence rather than automatic failures. If the candidate changes, review the new revision instead of relying on earlier images.

The command returns a compact evidence index; detailed structure and findings remain in its `report` and `audit.report` files. Read those details when the task or a summary finding warrants them instead of loading them by default.

LibreOffice rendering is a compatibility baseline, not Microsoft PowerPoint. It may substitute or omit fonts—commonly CJK fonts—causing boxes, blanks, or different wrapping. Compare source and candidate evidence before attributing these artifacts to the candidate; when the baseline is inconclusive, report the rendering limitation instead of claiming a visual fix.

When correctness depends on sources, exact values, specified copy, slide preservation, or task-specific acceptance criteria, write an independent evaluator:

```bash
bash "$PPTX" evaluate \
  --input "$WORKSPACE/tmp/candidate.pptx" \
  --script "$WORKSPACE/tmp/evaluator.mjs" \
  --out "$WORKSPACE/review/evaluation.json"
```

Let the evaluator reflect the actual task. See [review-and-evaluation.md](references/review-and-evaluation.md) for proportional visual and factual review.

## Specialized operation

For legacy PowerPoint 97–2003 input, preserve the source and convert it once:

```bash
bash "$PPTX" convert-legacy \
  --input "$SOURCE_PPT" \
  --out "$WORKSPACE/tmp/source-converted.pptx" \
  --qa-dir "$WORKSPACE/review/legacy-conversion"
```

Use the converted candidate in the ordinary understand, execute, and review stages. Report compatibility limits rather than claiming lossless migration.

## Deliver

Publish the reviewed candidate atomically:

```bash
bash "$PPTX" deliver \
  --input "$WORKSPACE/tmp/candidate.pptx" \
  --out "$FINAL_PPTX"
```

Confirm that the final file exists, matches the candidate, opens as a valid non-empty PPTX, and is the only requested project-visible artifact. Report unresolved ambiguity, unsupported features, rendering limitations, or verification gaps.

## Load references only when needed

- [builder-api.md](references/builder-api.md): builder contract, PptxGenJS, optional helpers, and template inheritance.
- [design-and-narrative.md](references/design-and-narrative.md): story, layout, typography, images, and neutral defaults.
- [charts-and-data.md](references/charts-and-data.md): quantitative charts, tables, sources, and reconciliation.
- [review-and-evaluation.md](references/review-and-evaluation.md): revision evidence and task-specific evaluators.
- [legacy-ppt-conversion.md](references/legacy-ppt-conversion.md): old `.ppt` conversion and compatibility limitations.
