# JavaScript builder API

Use one executable `.mjs` builder and return an ExcelJS workbook or `{ workbook, sheetName? }`.

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

  // Understand the task, then create or modify the workbook here.
  return workbook;
}
```

Use `createWorkbook()` for a new XLSX. Use `loadWorkbook(inputPath)` for the workbook being edited. Use `loadXlsx(path)` or `loadDelimited(path, options)` to read additional source files without mutating them.

Create all sheets referenced by formulas before assigning those formulas.

## Write typed data

Prefer row or range writes over scattered one-cell assignments:

```js
sheet.addRows([
  ["Month", "Revenue", "Cost"],
  ["Jan", 100000, 70000],
  ["Feb", 120000, 78000],
]);
```

Use JavaScript numbers, booleans, and `Date` objects. Keep ZIP codes, account numbers, SKUs, and other identifiers as strings when their exact digits matter.

## Write formulas

ExcelJS formula strings do not start with `=`:

```js
sheet.getCell("D2").value = {
  formula: "IFERROR((B2-C2)/B2,0)",
  result: 0,
};
```

The placeholder result is removed before LibreOffice recalculation. Do not treat it as a verified result.

## Apply formatting

Use helpers that clone style objects per cell:

```js
helpers.styleHeader(sheet, "A1:D1");
helpers.applyStyle(sheet, "A2:D20", {
  alignment: { vertical: "middle" },
});
helpers.setNumberFormat(sheet, "B2:C20", "#,##0");
helpers.setNumberFormat(sheet, "D2:D20", "0.0%");
helpers.autoFitColumns(sheet, { min: 10, max: 30 });
helpers.autoFitRows(sheet);
```

The default header is neutral light gray with dark text and can be overridden when the task calls for another design. Avoid assigning one mutable style object to multiple cells directly.

Use `helpers.applyChineseTypography` for Chinese or bilingual content when the surrounding workbook does not already establish a suitable font.

## Add tables and filters

Populate the range first, then create the table:

```js
helpers.addTableFromRange(sheet, {
  name: "RevenueTable",
  range: "A1:C3",
});
```

The helper preserves populated values, keeps filter buttons visible, and defaults to a light table style. Use unique names and do not overlap tables.

Raw `worksheet.addTable()` writes its `columns` and `rows` into the target range. The runtime rejects raw table calls that would replace different populated values.

## Add data validation

```js
helpers.addListValidation(
  sheet,
  "F2:F1000",
  ["On Track", "At Risk", "Blocked"],
  { allowBlank: false },
);
```

The helper stores range-level validation without materializing every empty cell. Use a worksheet range as the validation source when an inline list exceeds Excel's limit.

## Add conditional formatting

```js
helpers.addConditionalFormatting(sheet, {
  range: "D2:D100",
  rules: [{
    type: "cellIs",
    operator: "lessThan",
    formulae: [0.25],
    style: { font: { color: { argb: "FFB91C1C" } } },
  }],
});
```

Use `formulae` for `expression` and `cellIs` rules.

## Add native charts

```js
helpers.addNativeChart(workbook, {
  sheet: "Summary",
  type: "column",
  title: "Revenue by month",
  categories: "A2:A13",
  series: [{ name: "Revenue", values: "B2:B13" }],
  anchor: { from: "F2", to: "N20" },
  valueFormat: "#,##0",
});
```

Supported standard chart types are line, column, and bar. Use an image only when the user wants an image; an image is not an editable Excel chart.

## Add raster images

```js
await helpers.addImage(workbook, {
  sheet: "Summary",
  path: "/absolute/path/to/illustration.png",
  anchor: { from: "F2", to: "N18" },
});
```

The helper accepts local PNG, JPEG, WebP, and TIFF sources and records the inserted asset.

## Work with CSV and TSV

```js
const workbook = await loadDelimited(inputPath, {
  sheetName: "Data",
  inferTypes: false,
  encoding: "auto",
});
```

Choose `.csv` or `.tsv` as the candidate extension. Delimited files store formula results rather than formulas.

## Model-guided commands

```bash
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/spreadsheets"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"

bash "$SHEET" scaffold --out "$WORKSPACE/tmp/workbook.mjs"
bash "$SHEET" build --builder "$WORKSPACE/tmp/workbook.mjs" --out "$WORKSPACE/tmp/candidate.xlsx"
bash "$SHEET" build --builder "$WORKSPACE/tmp/workbook.mjs" --input "$INPUT_XLSX" --out "$WORKSPACE/tmp/candidate.xlsx"
bash "$SHEET" inspect --input "$INPUT_XLSX" --sheet Summary --range A1:H20 --styles
bash "$SHEET" review --input "$WORKSPACE/tmp/candidate.xlsx" --out-dir "$WORKSPACE/review"
bash "$SHEET" deliver --input "$WORKSPACE/tmp/candidate.xlsx" --out "$FINAL_XLSX"
```

Use the optional `audit`, `evaluate`, and fallback capabilities when they provide useful evidence for the current task. They are not mandatory phases of every build.
