---
name: spreadsheets
description: Create, edit, inspect, analyze, recalculate, render, and validate standalone spreadsheet files in .xlsx, .csv, and .tsv formats. Use whenever the requested input or deliverable is a workspace spreadsheet, including formula-driven workbooks, formatted tables, data cleanup, workbook questions, and visual spreadsheet QA. Do not use for Google Sheets, legacy .xls files, macro-enabled .xlsm files, or live control of Microsoft Excel.
---

# Spreadsheets

Work with standalone spreadsheet files through a reproducible JavaScript `.mjs` builder and the bundled `spreadsheet.sh` workflow. Preserve source files, keep calculations auditable, recalculate formulas, and verify both workbook structure and rendered pages before delivery.

## Hard requirements

- Use JavaScript ES modules and the bundled scripts. Do not use `openpyxl`, `xlsxwriter`, `pandas.ExcelWriter`, Google Sheets APIs, or Codex-private runtime paths.
- Preserve every input file. Write edits to a distinct output unless the user explicitly requests replacement.
- Keep important calculations in worksheet formulas. Do not replace inspectable formulas with hardcoded results.
- Inspect and render an existing workbook before modifying it. Match its formatting and conventions unless the user requests a redesign.
- Run compatibility preflight before editing an existing XLSX. Do not bypass a risky round trip without explicit user approval.
- Recalculate formula-driven XLSX files through LibreOffice and scan the saved results for formula errors.
- Render every final worksheet page and inspect the individual PNG files at full size. A montage is only an overview.
- Fix formula errors, clipped content, broken tables, unreadable formats, unexpected blank sheets, and poor page layout before delivery.

## Read the relevant references

- Read [api-quick-start.md](references/api-quick-start.md) before writing or modifying a builder.
- Read [formulas-and-data.md](references/formulas-and-data.md) for every formula-driven workbook or data conversion.
- Read [formatting.md](references/formatting.md) before creating or visually editing a workbook.
- Read [charts-and-compatibility.md](references/charts-and-compatibility.md) before editing an existing XLSX or handling charts and advanced Excel objects.
- Read [qa-checklist.md](references/qa-checklist.md) before delivery.

## Prepare the runtime

Resolve the directory containing this file as `SPREADSHEET_SKILL_ROOT`, then run:

```bash
SHEET="$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh"
bash "$SHEET" check || bash "$SHEET" fix
```

Use a task-specific scratch directory outside the skill:

```bash
SCRATCH_ROOT="$(node -p "require('node:os').tmpdir()")"
WORKSPACE="$SCRATCH_ROOT/pilotdeck-spreadsheets/${CODEX_THREAD_ID:-manual}/<task-slug>"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

Keep builders, source notes, inspections, renders, and QA reports in `WORKSPACE`. Put only requested deliverables in the project or user-selected output directory.

## Route the request

Choose one route:

1. Read-only question or analysis: inspect the relevant workbook ranges and formulas; do not export or modify a file.
2. Net-new XLSX: scaffold a builder, create the workbook, recalculate, audit, render, and inspect it.
3. Existing XLSX edit: inspect and render first, review compatibility risks, then make the smallest scoped edit.
4. CSV or TSV task: preserve the requested delimiter and text semantics. Convert to XLSX only when formulas, formatting, tables, images, or other workbook features are requested.

Do not accept `.xls`, `.xlsm`, Google Sheets, or a live Excel session through this skill.

## Inspect before acting

Get a compact workbook overview:

```bash
bash "$SHEET" inspect \
  --input "$INPUT" \
  --out "$WORKSPACE/tmp/inspection.json"
```

Inspect exact ranges and styles when needed:

```bash
bash "$SHEET" inspect \
  --input "$INPUT" \
  --sheet "Summary" \
  --range "A1:H30" \
  --styles \
  --out "$WORKSPACE/tmp/summary.json"
```

For an existing XLSX, review `package.unsafeForRoundTrip` and `package.roundTripRisks`. If either reports risky objects, stop before editing and follow [charts-and-compatibility.md](references/charts-and-compatibility.md).

Render an existing XLSX before changing its visual layout:

```bash
bash "$SHEET" render \
  --input "$INPUT" \
  --out-dir "$WORKSPACE/tmp/source-render"
```

## Create or edit a workbook

Create one executable builder:

```bash
bash "$SHEET" scaffold --out "$WORKSPACE/tmp/workbook.mjs"
```

The scaffold command creates an existing file. Immediately call PilotDeck's
`read_file` tool with that exact builder path before changing it with
`write_file` or `edit_file`. Shell output such as `cat` does not establish the
file snapshot required by PilotDeck's write-safety guard and is not a
substitute for `read_file`.

Patch and rerun that builder instead of creating duplicate scripts. Build a net-new workbook:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --out "$FINAL_XLSX"
```

Edit an existing safe workbook:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --input "$INPUT_XLSX" \
  --out "$FINAL_XLSX"
```

`build` preserves the input, blocks unsafe round trips, recalculates formula-driven XLSX files, and performs a compact formula audit. Never add `--allow-risky-roundtrip` unless the user has explicitly accepted the listed compatibility risks.

## Formula and data rules

- Separate assumptions/raw data from derived outputs.
- Write derived values as formulas and use visible helper ranges for complex logic.
- Use bounded ranges instead of entire-column references in large calculations.
- Use typed numbers, booleans, and dates rather than display-formatted strings.
- Apply explicit number formats for currency, percentages, counts, and dates.
- Keep cross-sheet references quoted, for example `'Revenue Model'!B6`.
- In ExcelJS formula objects, omit the leading `=`. See [formulas-and-data.md](references/formulas-and-data.md).
- For CSV and TSV, preserve identifiers with leading zeroes as text and do not infer dates or numbers unless the task requires it.

## Validate and render

Run the final structural audit:

```bash
bash "$SHEET" audit \
  --input "$FINAL_FILE" \
  --out "$WORKSPACE/qa/audit.json"
```

Render the final workbook:

```bash
bash "$SHEET" render \
  --input "$FINAL_FILE" \
  --out-dir "$WORKSPACE/qa/render" \
  --pdf "$WORKSPACE/qa/rendered.pdf" \
  --montage "$WORKSPACE/qa/montage.png"
```

Inspect every `page-N.png` at full resolution. Revise the builder, rebuild, and rerun audit/render until hard failures are gone and every warning is understood.

After modifying this skill or its runtime, run:

```bash
bash "$SHEET" self-test --out "$WORKSPACE/self-test"
```

## Deliver

Return the final `.xlsx`, `.csv`, or `.tsv` and a concise summary. Mention any deliberate compatibility limitation. Do not deliver builders, inspection JSON, PDFs, renders, runtime files, or QA reports unless the user requests them.
