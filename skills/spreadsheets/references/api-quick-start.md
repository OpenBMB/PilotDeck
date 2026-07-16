# JavaScript builder API

Use one executable `.mjs` builder. The builder exports a default async function and returns an ExcelJS workbook.

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

  // Modify the workbook here.
  return workbook;
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

Apply the bundled header baseline when no stronger style exists:

```js
helpers.styleHeader(sheet, "A3:D3");
helpers.autoFitColumns(sheet, { min: 10, max: 30 });
```

Do not use `autoFitColumns` to restyle an established workbook unless the requested edit needs it.

## Tables and filters

```js
sheet.addTable({
  name: "RevenueTable",
  ref: "A3",
  headerRow: true,
  style: { theme: "TableStyleMedium2", showRowStripes: true },
  columns: [
    { name: "Month" },
    { name: "Revenue" },
    { name: "Cost" },
  ],
  rows: [
    ["Jan", 100000, 70000],
    ["Feb", 120000, 78000],
  ],
});
```

Use unique table names. Do not overlap tables.

## Data validation

```js
sheet.getCell("F4").dataValidation = {
  type: "list",
  allowBlank: false,
  formulae: ['"On Track,At Risk,Blocked"'],
};
```

Prefer a hidden or clearly labeled source range for long validation lists.

## Conditional formatting

```js
sheet.addConditionalFormatting({
  ref: "D4:D100",
  rules: [{
    type: "cellIs",
    operator: "lessThan",
    formulae: [0.25],
    style: { font: { color: { argb: "FFB91C1C" } } },
  }],
});
```

Use conditional formatting for states that must respond to future edits.

## Comments and sources

ExcelJS supports legacy cell notes:

```js
sheet.getCell("B3").note = "Source: https://example.com/data";
```

For row-wise researched data, include a visible source URL column instead of hiding all provenance in notes.

## CSV and TSV

Load delimited input without unwanted type conversion:

```js
const workbook = await loadDelimited(inputPath, {
  sheetName: "Data",
  inferTypes: false,
});
```

Return a workbook and choose `.csv` or `.tsv` as the `build --out` extension. The first worksheet is exported unless `--sheet` is specified. Formulas export their calculated result because delimited files cannot store formulas.

## Common commands

```bash
bash "$SHEET" scaffold --out builder.mjs
bash "$SHEET" build --builder builder.mjs --out output.xlsx
bash "$SHEET" build --builder builder.mjs --input input.xlsx --out output.xlsx
bash "$SHEET" inspect --input output.xlsx --sheet Summary --range A1:H20 --styles
bash "$SHEET" audit --input output.xlsx --out audit.json
bash "$SHEET" render --input output.xlsx --out-dir render
```
