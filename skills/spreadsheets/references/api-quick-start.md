# JavaScript builder API

Use one executable `.mjs` builder. The builder exports a default async function and returns an ExcelJS workbook or `{ workbook, requirements }`.

## Builder contract

```js
export default async function build({
  ExcelJS,
  inputPath,
  createWorkbook,
  loadWorkbook,
  loadXlsx,
  loadDelimited,
  helpers,
}) {
  const workbook = inputPath
    ? await loadWorkbook(inputPath)
    : createWorkbook();
  const requirements = { requiredSheets: ["Summary"] };

  // Modify the workbook here.
  return { workbook, requirements };
}
```

Use `createWorkbook()` for a new XLSX. It initializes workbook metadata and requests full calculation. Use `loadWorkbook(inputPath)` for `.xlsx`, `.csv`, or `.tsv` input.

## Create worksheets

```js
const sheet = workbook.addWorksheet("Summary", {
  views: [{ state: "frozen", ySplit: 2, showGridLines: false }],
  pageSetup: {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
  },
});
```

Create all sheets referenced by formulas before assigning those formulas.

## Write blocks of values

Prefer arrays and row blocks over scattered one-cell writes:

```js
sheet.addRows([
  ["Month", "Revenue", "Cost"],
  ["Jan", 100000, 70000],
  ["Feb", 120000, 78000],
]);
```

Use real JavaScript numbers, booleans, and `Date` objects. Keep identifiers such as ZIP codes and SKUs as strings.

## Write formulas

ExcelJS formula strings do not start with `=`:

```js
sheet.getCell("D2").value = {
  formula: "IFERROR((B2-C2)/B2,0)",
  result: 0,
};

sheet.getCell("B8").value = {
  formula: "'Inputs'!B2*(1+'Inputs'!B3)",
  result: 0,
};
```

The placeholder `result` is removed before LibreOffice recalculation. Do not treat it as a verified result.

## Format cells

```js
sheet.getCell("A1").font = {
  name: "Arial",
  size: 18,
  bold: true,
  color: { argb: "FF0F172A" },
};

sheet.getColumn("B").numFmt = '"$"#,##0';
sheet.getColumn("C").numFmt = "0.0%";
sheet.getColumn("A").width = 24;
sheet.getRow(1).height = 28;
```

ARGB colors contain alpha plus RGB, normally `FF` followed by six hexadecimal digits.

Never assign one reusable object to `cell.style` across a range. ExcelJS style objects are mutable and may be shared by reference; changing one cell's number format later can silently turn unrelated numbers into dates. Use the helpers, which clone styles per cell:

```js
helpers.applyStyle(sheet, "A3:E20", {
  alignment: { vertical: "middle" },
  border: { bottom: { style: "thin", color: { argb: "FFE2E8F0" } } },
});
helpers.setNumberFormat(sheet, "B4:C20", '¥#,##0');
helpers.setNumberFormat(sheet, "D4:D20", "0.0%");
```

Apply the bundled header baseline when no stronger style exists:

```js
helpers.styleHeader(sheet, "A3:D3");
helpers.autoFitColumns(sheet, { min: 10, max: 30 });
helpers.autoFitRows(sheet);
helpers.applyChineseTypography(sheet, {
  platform: "cross-platform",
  titleRanges: ["A1:H1"],
});
```

Do not use `autoFitColumns` to restyle an established workbook unless the requested edit needs it.

## Tables and filters

```js
sheet.addRows([
  ["Month", "Revenue", "Cost"],
  ["Jan", 100000, 70000],
  ["Feb", 120000, 78000],
]);
helpers.addTableFromRange(sheet, {
  name: "RevenueTable",
  range: "A1:C3",
});
```

Use unique table names. Do not overlap tables.

## Data validation

```js
helpers.addListValidation(sheet, "F4:F100", ["On Track", "At Risk", "Blocked"], {
  allowBlank: false,
});
```

Prefer a hidden or clearly labeled source range for long validation lists.

## Conditional formatting

```js
helpers.addConditionalFormatting(sheet, {
  range: "D4:D100",
  rules: [{
    type: "cellIs",
    operator: "lessThan",
    formulae: [0.25],
    style: { font: { color: { argb: "FFB91C1C" } } },
  }],
});
```

Use conditional formatting for states that must respond to future edits.

Use `formulae` (plural) for `expression` and `cellIs` rules. The build preflight rejects `formula` before ExcelJS serialization and reports the worksheet, range, and rule index.

## Native charts

Use a native chart instead of inserting a rendered SVG or PNG:

```js
helpers.addNativeChart(workbook, {
  sheet: "Summary",
  type: "column",
  title: "Revenue by month",
  categories: "A4:A15",
  series: [{ name: "Revenue", values: "B4:B15" }],
  anchor: { from: "F3", to: "N20" },
  valueFormat: '"$"#,##0',
});
```

Supported types are `line`, `column`, and `bar`. Add the chart to `requirements.json`; the audit must confirm its native OOXML part and source ranges.

## Comments and sources

ExcelJS supports legacy cell notes:

```js
sheet.getCell("B3").note = "Source: https://example.com/data";
```

For row-wise researched data, include a visible source URL column instead of hiding all provenance in notes.

## CSV and TSV

Load delimited input without unwanted type conversion. Encoding defaults to automatic UTF-8/GB18030 detection:

```js
const workbook = await loadDelimited(inputPath, {
  sheetName: "Data",
  inferTypes: false,
  encoding: "auto",
});
```

Return a workbook and choose `.csv` or `.tsv` as the `build --out` extension. The first worksheet is exported unless `--sheet` is specified. Formulas export their calculated result because delimited files cannot store formulas.

## Common commands

Keep every builder, candidate, conversion, render, and report under the turn work directory. Only `FINAL_XLSX` is user-facing.

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}/spreadsheets"
FINAL_XLSX="$PWD/<requested-output>.xlsx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
bash "$SHEET" scaffold --out "$WORKSPACE/tmp/workbook.mjs" --requirements-out "$WORKSPACE/tmp/requirements.json"
bash "$SHEET" build --builder "$WORKSPACE/tmp/workbook.mjs" --requirements "$WORKSPACE/tmp/requirements.json" --out "$WORKSPACE/tmp/candidate.xlsx"
bash "$SHEET" build --builder "$WORKSPACE/tmp/workbook.mjs" --input "$INPUT_XLSX" --requirements "$WORKSPACE/tmp/requirements.json" --out "$WORKSPACE/tmp/candidate.xlsx"
bash "$SHEET" convert-legacy --input "$INPUT_XLS" --out "$WORKSPACE/tmp/converted.xlsx"
bash "$SHEET" inspect --input "$INPUT_XLSX" --sheet Summary --range A1:H20 --styles --out "$WORKSPACE/tmp/inspection.json"
bash "$SHEET" audit --input "$WORKSPACE/tmp/candidate.xlsx" --requirements "$WORKSPACE/tmp/requirements.json" --out "$WORKSPACE/qa/audit.json"
bash "$SHEET" render --input "$WORKSPACE/tmp/candidate.xlsx" --out-dir "$WORKSPACE/qa/render" --per-sheet
bash "$SHEET" deliver --input "$WORKSPACE/tmp/candidate.xlsx" --out "$FINAL_XLSX" --qa-dir "$WORKSPACE/qa/final" --requirements "$WORKSPACE/tmp/requirements.json"
```
