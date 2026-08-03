---
name: spreadsheets
description: Create, edit, inspect, analyze, recalculate, render, and validate standalone spreadsheet files in .xlsx, .xls, .csv, and .tsv formats. Use whenever the requested input or deliverable is a workspace spreadsheet, including formula-driven workbooks, native charts, formatted tables, data cleanup, workbook questions, legacy XLS conversion, Chinese or bilingual workbooks, and visual spreadsheet QA. Do not use for Google Sheets, macro-enabled .xlsm files, or live control of Microsoft Excel.
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
- Use native Excel chart objects for requested charts. A raster image or SVG does not satisfy a chart requirement.
- Create `requirements.json` for every non-trivial workbook and require `coverage.status=passed`.
- For source-backed workbooks, freeze source file hashes and a compact fact matrix before building. Do not rely on remembered values or reconstruct missing facts from context.
- Treat Chinese as first-class content when the user does not specify a language. Apply the cross-platform typography policy and verify glyphs after recalculation.
- Render every final worksheet page and inspect the individual PNG files at full size. A montage is only an overview.
- Fix formula errors, clipped content, broken tables, unreadable formats, unexpected blank sheets, and poor page layout before delivery.
- Build to a scratch candidate and use `deliver` to seal the final XLSX. Do not manually copy an unaudited candidate to the final path.
- A failed `build`, `audit`, or `deliver` means the workbook is not deliverable. Do not copy a raw/debug workbook, remove requested features, append `|| true`, or claim success after a gate fails.
- Use the bundled helpers for conditional formatting and native charts. Do not replace them with unsupported ExcelJS chart APIs or unvalidated low-level conditional-formatting objects.
- Resolve every audit warning or add a task-specific `warningDispositions` entry with a concrete rationale. Undisposed warnings block `deliver`.

## Read the relevant references

- Read [api-quick-start.md](references/api-quick-start.md) before writing or modifying a builder.
- Read [formulas-and-data.md](references/formulas-and-data.md) for every formula-driven workbook or data conversion.
- Read [formatting.md](references/formatting.md) before creating or visually editing a workbook.
- Read [chinese-and-cross-platform.md](references/chinese-and-cross-platform.md) for Chinese, bilingual, or unspecified-language net-new workbooks.
- Read [charts-and-compatibility.md](references/charts-and-compatibility.md) before editing an existing XLSX or handling charts and advanced Excel objects.
- Read [requirements-and-delivery.md](references/requirements-and-delivery.md) for every non-trivial workbook.
- Read [qa-checklist.md](references/qa-checklist.md) before delivery.

## Prepare the runtime

Resolve the directory containing this file as `SPREADSHEET_SKILL_ROOT`, then run:

```bash
SHEET="$SPREADSHEET_SKILL_ROOT/scripts/spreadsheet.sh"
bash "$SHEET" check || bash "$SHEET" fix
```

Use the turn-scoped PilotDeck work directory for every intermediate. The host sets `PILOTDECK_WORK_DIR`; the fallback keeps manual runs internal to the project:

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/spreadsheets"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

Keep builders, converted inputs, source notes, inspections, candidates, renders, recalculation files, and QA reports in `WORKSPACE`. Put only requested deliverables in the project or user-selected output directory. Never create `.pilotdeck_build.mjs`, QA directories, or other intermediates beside the user's files.

## Route the request

Choose one route:

1. Read-only question or analysis: inspect the relevant workbook ranges and formulas; do not export or modify a file.
2. Net-new XLSX: scaffold a builder, create the workbook, recalculate, audit, render, and inspect it.
3. Existing XLSX edit: inspect and render first, review compatibility risks, then make the smallest scoped edit.
4. Legacy XLS: convert to a temporary XLSX, inspect and render the conversion, then use the XLSX workflow and deliver `.xlsx`.
5. CSV or TSV task: preserve delimiter, encoding, identifiers, and text semantics. Convert to XLSX only when formulas, formatting, tables, images, or other workbook features are requested.

Do not accept `.xlsm`, Google Sheets, or a live Excel session through this skill. Never rename `.xls` to `.xlsx`.

Convert a legacy workbook without modifying the source:

```bash
bash "$SHEET" convert-legacy \
  --input "$INPUT_XLS" \
  --out "$WORKSPACE/tmp/converted.xlsx"
```

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

Create requirements and one executable builder:

```bash
bash "$SHEET" scaffold \
  --out "$WORKSPACE/tmp/workbook.mjs" \
  --requirements-out "$WORKSPACE/tmp/requirements.json"
```

The scaffold command creates an existing file. Immediately call PilotDeck's
`read_file` tool with that exact builder path before changing it with
`write_file` or `edit_file`. Shell output such as `cat` does not establish the
file snapshot required by PilotDeck's write-safety guard and is not a
substitute for `read_file`.

Write `$WORKSPACE/tmp/requirements.json` from the user's requested sheets, formulas, native charts, validations, conditional formatting, expected cells/ranges, and print-page constraints. A sheet list plus a formula count is not sufficient coverage.

For a task based on input files:

1. Inspect the exact source ranges or text sections first.
2. Set `sourceBacked: true`, record every input in `sourceFiles` with its pre-build SHA-256, and list output data sheets in `sourceBackedSheets`.
3. Add `expectedRanges` for complete user-critical tables such as KPI history, source rows, action items, owners, and deadlines. Use `expectedCells` for important totals and derived checkpoints.
4. Do not create a builder until the fact matrix is written. If a source omits a status, owner, date, or value, keep it blank or label it as unconfirmed instead of inventing it.

Patch and rerun that builder instead of creating duplicate scripts. Build a net-new workbook:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

Edit an existing safe workbook:

```bash
bash "$SHEET" build \
  --builder "$WORKSPACE/tmp/workbook.mjs" \
  --input "$INPUT_XLSX" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --out "$WORKSPACE/tmp/candidate.xlsx"
```

`build` preserves the input, validates builder structures and requirements, blocks unsafe round trips, recalculates formula-driven XLSX files, and performs a compact formula audit. It stages output and updates the requested candidate only after audit passes, so a failed build must be fixed and rerun. Fix the reported `stage`, worksheet, range, and field instead of disabling requested features or switching to a second builder. Never add `--allow-risky-roundtrip` unless the user has explicitly accepted the listed compatibility risks.

## Formula and data rules

- Separate assumptions/raw data from derived outputs.
- Write derived values as formulas and use visible helper ranges for complex logic.
- Use bounded ranges instead of entire-column references in large calculations.
- Use typed numbers, booleans, and dates rather than display-formatted strings.
- Apply explicit number formats for currency, percentages, counts, and dates.
- Keep cross-sheet references quoted, for example `'Revenue Model'!B6`.
- In ExcelJS formula objects, omit the leading `=`. See [formulas-and-data.md](references/formulas-and-data.md).
- For CSV and TSV, preserve identifiers with leading zeroes as text and do not infer dates or numbers unless the task requires it.
- Preserve identifiers longer than 15 digits as text. Detect UTF-8/UTF-8 BOM/GBK/GB18030 and default new delimited exports to UTF-8 BOM.
- Preserve source facts exactly when translating labels or reorganizing tables. Never substitute plausible KPIs, channels, action items, owners, dates, or statuses.

## Validate and render

Run the final structural audit:

```bash
bash "$SHEET" audit \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --out "$WORKSPACE/qa/audit.json"
```

Render the final workbook:

```bash
bash "$SHEET" render \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out-dir "$WORKSPACE/qa/render" \
  --montage "$WORKSPACE/qa/montage.png" \
  --per-sheet
```

Inspect every `page-N.png` at full resolution. Revise the builder, rebuild, and rerun audit/render until hard failures are gone and every warning is fixed or explicitly dispositioned in `requirements.json`. Stop after the workbook is correct, legible, and usable; do not spend extra loops on decorative polish.

After modifying this skill or its runtime, run:

```bash
bash "$SHEET" self-test --out "$WORKSPACE/self-test"
```

## Deliver

Seal an XLSX only after inspecting the candidate pages:

```bash
bash "$SHEET" deliver \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --out "$FINAL_XLSX" \
  --qa-dir "$WORKSPACE/qa/final-render" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --report "$WORKSPACE/qa/delivery.json"
```

Return the final `.xlsx`, `.csv`, or `.tsv` and a concise summary grounded in the delivery report. Mention deliberate compatibility limitations. Do not claim a native chart when package inspection reports zero charts. Describe coverage as only the checks actually declared; never turn a shallow structural pass into “100% task coverage.” Do not deliver builders, requirements JSON, PDFs, renders, runtime files, or QA reports unless the user requests them.
