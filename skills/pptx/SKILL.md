---
name: pptx
description: Create, edit, inspect, render, and validate editable Microsoft PowerPoint (.pptx) presentations, and import legacy binary .ppt files through verified conversion to .pptx. Use for native PowerPoint creation, modification, template inheritance, charts, tables, images, legacy .ppt migration, and slide-level quality assurance. Do not use for HTML/browser presentations or Google Slides.
---

# PPTX

Create and modify native PowerPoint files through a reproducible JavaScript workflow. Keep the `.mjs` builder, render every final slide, and fix structural and visual defects before delivery.

## Hard requirements

- Use JavaScript ES modules and the bundled `scripts/pptx.sh` workflow.
- Use PptxGenJS for net-new decks and pptx-automizer for inherited template slides.
- Do not use `python-pptx`, `@oai/artifact-tool`, Google Slides APIs, or an HTML-to-PPTX authoring path.
- Preserve every input PPT or PPTX. Write edits and conversions to a distinct `.pptx` output unless the user explicitly requests replacement.
- Write audience-facing slide copy. Do not expose planning notes or implementation commentary on slides.
- Render every final slide to PNG and inspect each page at full size. A montage is only an overview.
- Fix unintended clipping, overflow, wrapping, overlap, image cropping, broken connectors, unresolved placeholders, footer/page-number inconsistency, and chart/data mismatches.
- Use `deliver` for the last build or verification so the PPTX hash, coverage, audit, render, and seal all refer to the same artifact. Do not edit or rebuild after the final report.
- Never append `|| true`, suppress stderr, or otherwise bypass `deliver`. A file is final only when `delivery.status` and `delivery.seal.status` are both `passed`.
- Do not ignore `audit` warnings. Fix genuine defects; explicitly disposition verified false positives, intentional overlaps, and accepted renderer limitations. Every disposition must bind to the exact PPTX SHA-256 and include a concrete reason and visual evidence.

## Read the relevant references

- Always read [content-and-narrative.md](references/content-and-narrative.md) before planning a deck.
- Read [api-quick-start.md](references/api-quick-start.md) before writing a builder.
- Read [design-and-layout.md](references/design-and-layout.md) for a deck without a supplied template.
- Read [template-following.md](references/template-following.md) when a source PPTX supplies the visual system or editable frames.
- Read [charts-and-data.md](references/charts-and-data.md) before adding charts or quantitative tables.
- Read [typography-and-fonts.md](references/typography-and-fonts.md) when no supplied template controls typography, especially for Chinese or mixed-language content.
- Read [requirements-and-delivery.md](references/requirements-and-delivery.md) when the task contains exact facts, mandatory sections, benchmark criteria, or high-risk delivery requirements.
- Read [legacy-ppt-conversion.md](references/legacy-ppt-conversion.md) when the input is `.ppt`, has an ambiguous extension, or was created by PowerPoint 97–2003.
- Read [qa-checklist.md](references/qa-checklist.md) before delivery.

## Resolve paths and prepare the runtime

Resolve the directory containing this file as `PPTX_SKILL_ROOT`, then use:

```bash
PPTX="$PPTX_SKILL_ROOT/scripts/pptx.sh"
bash "$PPTX" check || bash "$PPTX" fix
```

Use the turn-scoped PilotDeck work directory for every intermediate. The host sets `PILOTDECK_WORK_DIR`; the fallback keeps manual runs internal to the project:

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/pptx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

Put the builder, converted inputs, source notes, renders, manifests, maps, candidates, and QA reports in `WORKSPACE`. Put only the requested final deliverables in the project or user-selected output directory. Never create `.pilotdeck_build.mjs`, QA directories, or other intermediates beside the user's files. Do not conceal scratch files with Git ignore changes.

## Route the request

Choose exactly one route:

1. Legacy `.ppt` input: preserve it, convert it once to a verified temporary `.pptx`, inspect the paired renders, and use only the converted `.pptx` downstream.
2. Existing PPTX to inspect or answer questions about: inspect the entire deck; do not edit unless requested.
3. Net-new PPTX without a template: use the PilotDeck layout library unless the user gives explicit visual direction.
4. Net-new PPTX with explicit visual direction: build a custom composition; do not combine it with the default library.
5. Template-based creation or edit: use only the supplied source deck as the visual system and follow template mode.

Use `frontend-slides` instead when the requested output is a browser-based HTML presentation or a PPTX-to-web conversion. Never route a native Google Slides request through this skill.

## Plan the communication before coding

Write one sentence that states the audience, desired outcome, and single most important takeaway. Then create a slide plan with one job per slide. Prefer a coherent argument over a collection of facts.

Plan visuals together with the narrative. Use one strong image, chart, table, or simple diagram only when it improves comprehension. Do not repeat the same image except as a background. Avoid presentation pages that resemble dashboards, settings screens, or grids of UI cards.

When no template controls typography, resolve a locale profile with `resolveDesignTokens`. Use `cross-platform-zh` for unspecified simplified-Chinese or mixed-language delivery and `cross-platform-en` for English. Use a platform-specific profile only when the target platform is known. Shorten copy or change the layout before shrinking type below the selected density profile.

When the user supplies exact values, required phrases, mandatory sections, or benchmark criteria, create a lightweight requirements file before authoring. Mark only genuinely blocking items as `critical`; keep preferred details `recommended` so the Harness does not over-constrain creative work.

## Control effort without a wall-clock cutoff

Prioritize a complete, correct, editable, and auditable deck over repeated visual refinement. API or tool waiting time is not a reason to stop an otherwise progressing task.

1. Read and normalize each source once; reuse extracted facts and file hashes.
2. Establish the complete slide structure before visual refinement, then produce one usable full-deck build.
3. Run `audit` and render the full deck. Fix critical content, overflow, clipping, and unintended overlap before aesthetic details.
4. After the hard requirements pass, perform at most one optional visual-polish pass unless the user explicitly requests more.
5. Do not rebuild the whole deck for small spacing, color, or decorative differences. Inspect and repair only affected slides.
6. Use the bundled typography profile. Do not scan the system or repeatedly compare fonts unless the selected font breaks the target PowerPoint output.
7. Do not rewrite a valid deck only because LibreOffice substitutes Chinese glyphs differently. Treat PowerPoint as the target viewer and record the baseline limitation.
8. When an audit warning is visually intentional, disposition it instead of redesigning the page repeatedly.

## Convert a legacy PPT

Do not pass `.ppt` directly to OOXML inspection or template editing. Convert and verify it first:

```bash
bash "$PPTX" convert \
  --input "$SOURCE_PPT" \
  --out "$WORKSPACE/tmp/source-converted.pptx" \
  --qa-dir "$WORKSPACE/legacy-conversion-qa"
```

Inspect the source and converted montages and the conversion report. Page-count or structural failure blocks use. A visual-difference or legacy-feature warning requires review but does not claim that the `.ppt` was converted losslessly. Keep the original `.ppt`; final output remains `.pptx`.

## Build a net-new deck

Create the executable builder:

```bash
bash "$PPTX" scaffold --out "$WORKSPACE/tmp/deck.mjs"
```

Edit the builder so its default export receives the PilotDeck toolkit and returns a PptxGenJS presentation. Use plain `.mjs`; do not add a transpiler. Resolve design tokens for the content language, pass the same tokens to `createDeck` and layout functions, and set PptxGenJS `objectName` values for anything likely to be edited later.

Build the PPTX:

```bash
bash "$PPTX" build \
  --builder "$WORKSPACE/tmp/deck.mjs" \
  --out "$FINAL_PPTX"
```

Use the bundled layout registry and design tokens only when no stronger visual source exists:

- `assets/layout-library/template-registry.json`
- `assets/layout-library/design-tokens.json`
- `assets/layout-library/layouts/core.mjs`

Do not fill a deck with every available layout. Select the smallest set that supports the story and vary the slide silhouette across the deck.

## Follow a supplied template

Inspect and render the complete source deck before mapping output slides:

```bash
bash "$PPTX" inspect \
  --input "$TEMPLATE_PPTX" \
  --out "$WORKSPACE/tmp/template-manifest.json"

bash "$PPTX" render \
  --input "$TEMPLATE_PPTX" \
  --out-dir "$WORKSPACE/tmp/template-slides" \
  --montage "$WORKSPACE/tmp/template-montage.png"
```

Create `template-frame-map.json`. Map every output slide to a source slide and list the exact inherited objects allowed to change. Validate the map before editing:

```bash
bash "$PPTX" validate-map \
  --template "$TEMPLATE_PPTX" \
  --map "$WORKSPACE/tmp/template-frame-map.json" \
  --out "$WORKSPACE/tmp/template-map-validation.json"
```

Create an unedited starter deck first:

```bash
bash "$PPTX" prepare-starter \
  --template "$TEMPLATE_PPTX" \
  --map "$WORKSPACE/tmp/template-frame-map.json" \
  --out "$WORKSPACE/tmp/template-starter.pptx"
```

Render the source and starter, then run `fidelity`. Resolve unexplained differences before applying edits. Apply only operations authorized by the frame map:

```bash
bash "$PPTX" apply-template \
  --template "$TEMPLATE_PPTX" \
  --map "$WORKSPACE/tmp/template-frame-map.json" \
  --edits "$WORKSPACE/tmp/template-edits.json" \
  --out "$FINAL_PPTX"
```

Do not overlay replacement objects on top of inaccessible template objects. If the requested target cannot be preserved or safely modified, stop and report the unsupported object and closest viable source-slide alternatives.

## Charts, diagrams, and images

- Validate chart category counts, series lengths, units, labels, and displayed totals before generation.
- Keep a source note for externally researched values and visuals.
- Create connectors before diagram nodes so edges stay behind nodes.
- Use native shapes only for simple diagrams. Use a prepared raster or SVG asset for complex or aesthetic visuals.
- Determine image aspect ratio and intended crop before placement. Use `imageSizingCrop` or `imageSizingContain` from the toolkit rather than stretching images.
- Do not treat decorative shapes as the main visual content.

## Render and validate

Use `audit` and `render` for fast iteration after material revisions:

```bash
bash "$PPTX" audit \
  --input "$FINAL_PPTX" \
  --out "$WORKSPACE/qa/audit.json"

bash "$PPTX" render \
  --input "$FINAL_PPTX" \
  --out-dir "$WORKSPACE/qa/slides" \
  --montage "$WORKSPACE/qa/montage.png" \
  --pdf "$WORKSPACE/qa/rendered.pdf"
```

Inspect every `slide-N.png` at full resolution. Compare the rendered page count to the PPTX manifest. Revise the builder or template edit map, rebuild, and repeat until all hard failures are gone and every warning has been resolved or visually confirmed as intentional.

For the final net-new build, run:

```bash
bash "$PPTX" deliver \
  --builder "$WORKSPACE/tmp/deck.mjs" \
  --out "$FINAL_PPTX" \
  --qa-dir "$WORKSPACE/qa" \
  --target-platform cross-platform \
  --require-render
```

For exact coverage criteria, save `requirements.json` under `WORKSPACE/tmp` and add `--require-coverage`. `deliver` auto-discovers that file. For template output, run `deliver --input "$FINAL_PPTX"` instead.

If the first delivery is blocked by warnings, inspect the full-size PNGs and `audit.json`. Create a hash-bound disposition file, then seal the unchanged QA candidate:

```bash
bash "$PPTX" deliver \
  --input "$WORKSPACE/qa/candidate.pptx" \
  --out "$FINAL_PPTX" \
  --qa-dir "$WORKSPACE/qa" \
  --dispositions "$WORKSPACE/tmp/warning-dispositions.json" \
  --require-coverage \
  --target-platform cross-platform \
  --require-render
```

Do not deliver `candidate.pptx`. Only a `passed` delivery is sealed to `FINAL_PPTX`. Treat Microsoft PowerPoint as the target viewer and LibreOffice as an automated baseline, especially for Chinese font substitution.

Run the bundled integration test after modifying this skill or its runtime:

```bash
bash "$PPTX" self-test --out "$WORKSPACE/self-test"
```

## Deliver

Return the sealed final `.pptx` and a concise summary. State that verification passed and disclose accepted compatibility limitations. For legacy input, state that the preserved `.ppt` was converted to `.pptx` and that macros, legacy animation, OLE objects, WordArt, media, and uncommon fonts are not guaranteed lossless. Do not deliver builders, candidates, manifests, frame maps, renders, or QA reports unless the user requests them.
