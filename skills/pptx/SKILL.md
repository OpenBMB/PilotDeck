---
name: pptx
description: Create, edit, review, and finalize editable Microsoft PowerPoint .pptx presentations. Use for new decks, source- or template-based presentations, targeted slide edits, charts, tables, images, speaker notes, visual QA, and legacy .ppt conversion. Do not use for HTML/browser presentations, Google Slides, or live Microsoft PowerPoint control.
---

# PPTX presentations

Use four stages as a reasoning framework, not a fixed tool pipeline:

1. Understand the request and source materials.
2. Build or edit the presentation using the approach best suited to the task.
3. Review the actual result with evidence proportionate to the risk.
4. Deliver the chosen candidate safely.

The user's explicit requirements are the primary acceptance criteria. Adapt the implementation and review depth to the task rather than optimizing for a template, style rule, or tool verdict from this skill.

## Understand

Determine the audience, purpose, intended takeaway, authoritative sources, expected form, and what must remain unchanged. Distinguish factual sources from templates and visual references.

- Preserve source files unless replacement is explicitly requested.
- Do not invent unsupported facts, quotations, dates, names, values, or citations.
- When editing, preserve content, structure, formatting, notes, and package features the user did not ask to change.
- Inspect only the material and package features relevant to the requested outcome. Use direct Python, `python-pptx`, ZIP/XML inspection, LibreOffice, or another suitable approach as useful.

Resolve the mechanical CLI only when one of its commands helps:

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
PPTX="$SKILL_ROOT/scripts/pptx.sh"
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/pptx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"
```

## Build

Use the approach best suited to the task. `python-pptx`, PptxGenJS, direct OOXML editing, LibreOffice, other libraries, or a combination are all valid. Do not switch languages or adopt a wrapper merely to use this skill.

Keep task scripts, candidates, extracted media, reports, renders, and debugging output under `PILOTDECK_WORK_DIR`. Put only the requested final deliverable in the project workspace.

Prefer localized edits to reconstruction when modifying an existing presentation. Inspect package-sensitive features before round-tripping speaker notes, masters, layouts, themes, charts, animations, embedded workbooks, OLE objects, macros, signatures, or uncommon media. Choose a preservation strategy based on the actual presentation and report limitations honestly.

Follow supplied templates, brand guidance, and explicit art direction. Otherwise choose a coherent visual language appropriate to the audience and content.

For PowerPoint-specific package and compatibility behavior, read [powerpoint-specifics.md](references/powerpoint-specifics.md) only when relevant.

## Review

Judge the presentation against the user's requested outcome, not whether a tool ran successfully. Directly rereading the final content may be enough for a simple task. When additional evidence would materially improve confidence, choose any appropriate combination of:

- reconcile facts, values, quotations, and sources;
- inspect relevant slides, notes, relationships, or package parts directly;
- `validate` for package, XML, relationship, and active-slide diagnostics;
- `render` for slide images and visual evidence;
- `compare` for factual differences after editing an existing presentation;
- a small task-specific checking script for requirements unique to the request.

These tools are independent, not a required pipeline. They provide facts and evidence, never a content- or design-quality verdict.

```bash
bash "$PPTX" validate --input "$WORKSPACE/tmp/candidate.pptx"
bash "$PPTX" render \
  --input "$WORKSPACE/tmp/candidate.pptx" \
  --out-dir "$WORKSPACE/review/latest"
bash "$PPTX" compare \
  --source "$INPUT_PPTX" \
  --candidate "$WORKSPACE/tmp/candidate.pptx" \
  --out "$WORKSPACE/review/comparison.json"
```

Open relevant full-size slide images before making visual claims. After changing the candidate, prior images no longer describe the current presentation. LibreOffice rendering is a compatibility baseline and may substitute fonts, wrap text, or render effects differently from Microsoft PowerPoint.

## Specialized operation

For legacy PowerPoint 97–2003 input, preserve the source and convert it to an internal `.pptx` candidate before editing:

```bash
bash "$PPTX" convert-legacy \
  --input "$SOURCE_PPT" \
  --out "$WORKSPACE/tmp/source-converted.pptx"
```

Read [legacy-ppt-conversion.md](references/legacy-ppt-conversion.md) when handling `.ppt`. Conversion is not a guarantee of lossless migration; use `render` or another targeted check when conversion fidelity matters.

## Deliver

Publish the chosen internal candidate through the delivery command:

```bash
bash "$PPTX" deliver \
  --input "$WORKSPACE/tmp/candidate.pptx" \
  --out "$FINAL_PPTX"
```

For an edit, add `--source "$INPUT_PPTX"`. Replace that exact source only when explicitly requested, using `--source "$INPUT_PPTX" --out "$INPUT_PPTX" --replace-source`; a recovery copy remains internal.

`deliver` checks package validity, protects the source, and publishes the exact candidate atomically. It does not run `validate`, `render`, or `compare`, and it does not decide whether the content, facts, design, or requested outcome are good enough; those judgments belong to the model's review.
