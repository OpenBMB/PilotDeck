---
name: spreadsheets
description: Create, edit, inspect, transform, render, and verify standalone XLSX, XLS, CSV, and TSV files. Use for spreadsheet generation, formatting, formulas, charts, data consolidation, source-based calculations, numeric reconciliation, legacy conversion, and visual QA. Do not use for live control of Microsoft Excel or macro-enabled workbook editing.
---

# Spreadsheets

Create accurate, useful, and visually coherent spreadsheets by working through three stages:

1. Understand the request and source materials.
2. Build or edit the workbook.
3. Review the actual result before delivery.

Adapt the depth of inspection and verification to the task. Use judgment instead of forcing every request through the same workflow.

## Protect data and files

- Preserve source files unless the user explicitly requests replacement.
- Keep builders, candidates, renders, evaluators, and debug artifacts under `PILOTDECK_WORK_DIR`.
- Do not invent missing facts or replace unknown values with plausible ones.
- Deliver only a valid workbook corresponding to the candidate you reviewed.

Resolve the CLI entry point once:

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
SHEET="$SKILL_ROOT/scripts/spreadsheet.sh"
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/spreadsheets"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"
```

## Understand

Determine what the user wants the final workbook to accomplish. Identify which materials contain authoritative facts, which establish formatting or structure, what must change, what must remain, and what evidence would demonstrate success.

Inspect only the files, sheets, and ranges needed to understand the task:

```bash
bash "$SHEET" inspect --input "$INPUT" --sheet "Sheet1" --range "A1:H30" --styles
```

Render an existing workbook before visual edits when its current appearance matters. Review compatibility risks before modifying workbooks containing charts, drawings, pivots, external connections, macros, signatures, or other package-sensitive objects.

Do not reduce your understanding to a rigid task category, validation profile, or collection of boolean flags.

## Execute

Use one reproducible JavaScript `.mjs` builder for each workbook revision. Patch and rerun the same builder instead of creating numbered copies.

Scaffold a minimal builder when useful:

```bash
bash "$SHEET" scaffold --out "$WORKSPACE/tmp/workbook.mjs"
```

Use `createWorkbook()` for a new workbook and `loadWorkbook(inputPath)` for an existing workbook. Use bundled helpers for typed data, formulas, styles, tables, filters, validations, conditional formatting, native charts, images, and compatibility-safe operations.

Keep identifiers as text when leading zeroes or long digits matter. Use real numbers, dates, and booleans. Keep derived values as formulas when the workbook should remain inspectable and reusable.

### Choose presentation intentionally

Follow explicit user styling requirements and supplied templates when they exist. When editing an existing workbook, preserve its established visual language unless the user asks for a redesign.

When neither the user nor the source establishes a style, choose a restrained, neutral presentation appropriate to the workbook's purpose. For ordinary data sheets, favor white backgrounds, dark text, subtle gray hierarchy, readable spacing, restrained borders, and clear number formats.

Use typography, alignment, spacing, and structure before adding color. Reserve color for meaningful emphasis, status, grouping, or a presentation-oriented workbook. Do not add cover-like title rows, oversized headings, KPI cards, branding palettes, or widespread colored fills merely to make a workbook look professional.

Allow stronger hierarchy when the workbook is genuinely a dashboard, report, or presentation artifact, but make every visual element support the content.

Build to an internal candidate:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

Add `--input "$INPUT"` when editing an existing workbook. The runtime handles serialization, formula recalculation, native chart injection, package checks, and atomic candidate updates. A failed build must not replace the previous candidate.

## Use fallback when necessary

Use standard helpers when they express the requested result well. When they do not, use the controlled fallback mechanism against an internal copy instead of bypassing the skill with an untracked project script.

After fallback, inspect and review the workbook again. Preserve unrelated package parts and report limitations rather than silently removing requested functionality.

## Review

Review the workbook itself, not a hand-written pass status.

Generate structural evidence and per-sheet images:

```bash
bash "$SHEET" review \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out-dir "$WORKSPACE/review" \
  --report "$WORKSPACE/review/report.json"
```

The review result returns a revision identifier and each rendered page with its worksheet name, page number, and full-size image path. `review_pending` means the current revision is ready to inspect; it is not a visual pass. Choose and open the pages that matter for the task, and keep visual claims within the pages you actually inspected. Check visual hierarchy, readability, clipping, spacing, number formats, charts, unnecessary decoration, and consistency with supplied templates.

Visual observations describe only the candidate revision that produced them. If you revise the workbook afterward, run review again and inspect the new revision's relevant pages before delivery. Decide which pages matter from the task and the changes you made; do not turn review into a fixed page-by-page pipeline.

Use the structural facts in the review report for information images cannot prove, including formulas, cell types, validations, native objects, hidden content, and package compatibility.

When important facts come from source files, calculations, consolidation, or images, write a task-specific evaluator and reread the authoritative sources independently:

```bash
bash "$SHEET" evaluate \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --script "$WORKSPACE/tmp/evaluator.mjs" \
  --out "$WORKSPACE/review/evaluation.json"
```

Choose verification evidence according to consequence and uncertainty. A simple workbook may need visual and structural review only; a complex transformation may need source reconciliation. If evidence reveals a problem, revise the builder and review the new candidate.

## Deliver

After reviewing the candidate, publish it atomically:

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_OUTPUT"
```

Confirm that the final file exists, matches the reviewed candidate, opens successfully, and is the only requested project-visible artifact. Report any unresolved ambiguity, rendering limitation, unsupported feature, or verification gap.

## Load references only when needed

- Read [api-quick-start.md](references/api-quick-start.md) for builder and helper APIs.
- Read [formatting.md](references/formatting.md) when appearance, layout, or template preservation matters.
- Read [formulas-and-data.md](references/formulas-and-data.md) for formulas, typed data, CSV, TSV, and imports.
- Read [charts-and-compatibility.md](references/charts-and-compatibility.md) for charts, drawings, existing workbook objects, and round-trip risks.
- Read [evaluation.md](references/evaluation.md) for multimodal review, source comparison, numeric reconciliation, and evaluator APIs.
- Read [chinese-and-cross-platform.md](references/chinese-and-cross-platform.md) for Chinese or bilingual typography.
- Read [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md) when standard helpers cannot express a requested feature.
