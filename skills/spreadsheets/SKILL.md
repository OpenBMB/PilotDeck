---
name: spreadsheets
description: Create, edit, review, and finalize standalone XLSX, XLS, CSV, and TSV spreadsheet files. Use for spreadsheet generation, formatting, formulas, charts, data consolidation, source-based calculations, numeric reconciliation, legacy conversion, and visual QA. Do not use for live Microsoft Excel control or macro-enabled workbook editing.
---

# Spreadsheets

Use three stages as a reasoning framework, not a fixed tool pipeline:

1. Understand the request and source materials.
2. Build or edit the spreadsheet using the approach best suited to the task.
3. Review the actual result before delivery.

The user's explicit requirements are the primary acceptance criteria.

## Understand

Determine what the final spreadsheet should accomplish, which sources contain authoritative facts, what must change, what must remain, and what evidence would demonstrate success.

- Preserve source files unless replacement is explicitly requested.
- Do not invent missing facts or replace unknown values with plausible ones.
- When editing, preserve content, formulas, structure, and formatting the user did not ask to change.
- Inspect only the files, sheets, ranges, and package features relevant to the requested outcome.

Resolve the optional CLI when its mechanical commands help:

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
SHEET="$SKILL_ROOT/scripts/spreadsheet.sh"
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/spreadsheets"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"
```

Review package-sensitive features before modifying workbooks containing charts, drawings, pivots, external connections, signatures, or other advanced objects.

## Build

Write and run one task-specific, reproducible script for each workbook revision. Use `openpyxl`, `xlsxwriter`, pandas, ExcelJS, direct OOXML editing, LibreOffice UNO, or another suitable tool according to the task. Do not switch languages or adopt a wrapper merely to use this skill.

Keep task scripts, candidates, extracted assets, reports, renders, and debugging output under `PILOTDECK_WORK_DIR`. Put only the requested final deliverable in the project workspace.

Prefer localized edits to reconstruction when modifying an existing workbook. Keep identifiers as text when leading zeroes or long digits matter. Use real numbers, dates, and booleans, and retain derived values as formulas when the workbook should remain inspectable or reusable.

Follow supplied templates and explicit visual requirements. Without either, use restrained neutral presentation: readable typography, clear number formats, useful spacing, dark text, white backgrounds, and limited color for meaning. Do not add dashboard furniture, branding, or decorative formatting unrelated to the requested outcome.

For formula caches, Excel/LibreOffice differences, dates, package-sensitive objects, or CSV safety, read [spreadsheet-specifics.md](references/spreadsheet-specifics.md) only when relevant.

## Review

Judge the spreadsheet against the user's requested outcome, not whether a tool ran successfully. Review may be as light as directly checking the result. When mechanical evidence would materially improve confidence, choose any appropriate combination of:

- `validate` for package, relationship, formula-cache, and formula-error diagnostics;
- `recalculate` to refresh supported formula caches when changed formulas or dependencies must display calculated results;
- `render` for visual evidence about layout, pagination, charts, and formatting.

These are optional tools, not a required pipeline. Decide whether to use them and what to examine according to the task's consequences and uncertainty. If recalculation is needed alongside validation or rendering, recalculate the final candidate first so later evidence describes its final calculation state.

The CLI provides facts and images, never a content- or design-quality verdict. See [optional-tools.md](references/optional-tools.md) only when one of these commands or another mechanical operation would serve the task.

Open relevant full-size page images before making visual claims. After changing the candidate, prior renders no longer describe the current workbook. LibreOffice may paginate, calculate, or substitute fonts differently from Microsoft Excel.

When correctness depends on sources or non-trivial calculations, independently reread or reconcile important cells, formulas, and types, or write a small task-specific checking script when it materially improves confidence. Use `compare` after a package-sensitive edit only when distinguishing intended changes from unrelated package changes matters.

## Deliver

Publish the chosen internal candidate through the delivery command:

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_OUTPUT"
```

For an edit, add `--source "$INPUT"`. Replace that exact source only when explicitly requested, using `--source "$INPUT" --out "$INPUT" --replace-source`; a recovery copy remains internal.

`deliver` protects the source, rejects structurally unsafe or unreadable packages, and publishes the exact candidate atomically. It does not run `validate`, `recalculate`, or `render`, and it does not decide whether the content, formulas, design, or requested outcome are good enough; those judgments belong to the model.

Use optional mechanical commands such as `compare` and `convert-legacy` only when they directly serve the request.
