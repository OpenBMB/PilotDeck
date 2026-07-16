---
name: pptx
description: Create, edit, inspect, render, and validate editable Microsoft PowerPoint (.pptx) presentations with executable JavaScript .mjs builders, including template-based decks, charts, tables, images, and slide-level quality assurance. Use whenever the requested deliverable or input is a native PowerPoint/PPTX file. Do not use for HTML/browser presentations or Google Slides.
---

# PPTX

Create and modify native PowerPoint files through a reproducible JavaScript workflow. Keep the `.mjs` builder, render every final slide, and fix structural and visual defects before delivery.

## Hard requirements

- Use JavaScript ES modules and the bundled `scripts/pptx.sh` workflow.
- Use PptxGenJS for net-new decks and pptx-automizer for inherited template slides.
- Do not use `python-pptx`, `@oai/artifact-tool`, Google Slides APIs, or an HTML-to-PPTX authoring path.
- Preserve every input PPTX. Write edits to a distinct output unless the user explicitly requests replacement.
- Write audience-facing slide copy. Do not expose planning notes or implementation commentary on slides.
- Render every final slide to PNG and inspect each page at full size. A montage is only an overview.
- Fix unintended clipping, overflow, wrapping, overlap, image cropping, broken connectors, unresolved placeholders, footer/page-number inconsistency, and chart/data mismatches.
- Do not ignore `audit` warnings. Inspect each warning against the rendered slide and revise or record why the overlap is intentional.

## Read the relevant references

- Always read [content-and-narrative.md](references/content-and-narrative.md) before planning a deck.
- Read [api-quick-start.md](references/api-quick-start.md) before writing a builder.
- Read [design-and-layout.md](references/design-and-layout.md) for a deck without a supplied template.
- Read [template-following.md](references/template-following.md) when a source PPTX supplies the visual system or editable frames.
- Read [charts-and-data.md](references/charts-and-data.md) before adding charts or quantitative tables.
- Read [qa-checklist.md](references/qa-checklist.md) before delivery.

## Resolve paths and prepare the runtime

Resolve the directory containing this file as `PPTX_SKILL_ROOT`, then use:

```bash
PPTX="$PPTX_SKILL_ROOT/scripts/pptx.sh"
bash "$PPTX" check || bash "$PPTX" fix
```

Use an external scratch directory for project-backed work. If the host does not provide one, derive it from Node:

```bash
SCRATCH_ROOT="$(node -p "require('node:os').tmpdir()")"
WORKSPACE="$SCRATCH_ROOT/pilotdeck-pptx/${CODEX_THREAD_ID:-manual}/<task-slug>"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

Put the builder, source notes, renders, manifests, maps, and QA reports in `WORKSPACE`. Put only the requested final deliverables in the project or user-selected output directory. Do not conceal scratch files with Git ignore changes.

## Route the request

Choose exactly one route:

1. Existing PPTX to inspect or answer questions about: inspect the entire deck; do not edit unless requested.
2. Net-new PPTX without a template: use the PilotDeck layout library unless the user gives explicit visual direction.
3. Net-new PPTX with explicit visual direction: build a custom composition; do not combine it with the default library.
4. Template-based creation or edit: use only the supplied source deck as the visual system and follow template mode.

Use `frontend-slides` instead when the requested output is a browser-based HTML presentation or a PPTX-to-web conversion. Never route a native Google Slides request through this skill.

## Plan the communication before coding

Write one sentence that states the audience, desired outcome, and single most important takeaway. Then create a slide plan with one job per slide. Prefer a coherent argument over a collection of facts.

Plan visuals together with the narrative. Use one strong image, chart, table, or simple diagram only when it improves comprehension. Do not repeat the same image except as a background. Avoid presentation pages that resemble dashboards, settings screens, or grids of UI cards.

When no template controls typography, use at least:

- 50 pt for the deck title.
- 35 pt for slide titles.
- 24 pt for subheadings and callouts.
- 16 pt for body copy.

Shorten copy or change the layout before shrinking type.

## Build a net-new deck

Create the executable builder:

```bash
bash "$PPTX" scaffold --out "$WORKSPACE/tmp/deck.mjs"
```

Edit the builder so its default export receives the PilotDeck toolkit and returns a PptxGenJS presentation. Use plain `.mjs`; do not add a transpiler. Set PptxGenJS `objectName` values for anything likely to be edited later.

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

Run both structural and visual QA after every material revision:

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

Run the bundled integration test after modifying this skill or its runtime:

```bash
bash "$PPTX" self-test --out "$WORKSPACE/self-test"
```

## Deliver

Return the final `.pptx` and a concise summary. Mention any deliberate compatibility limitation. Do not deliver builders, manifests, frame maps, renders, or QA reports unless the user requests them.
