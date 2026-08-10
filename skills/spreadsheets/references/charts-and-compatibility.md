# Charts and compatibility

## Compatibility preflight

An XLSX is a package containing many object types. The bundled inspector detects advanced features before an ExcelJS round trip.

Treat these as unsafe by default:

- VBA macros.
- Native charts and chart drawings.
- Pivot tables and pivot caches.
- Slicers.
- External links, connections, and query tables.
- Embedded or ActiveX objects.
- Package signatures.
- Drawings that may contain unsupported shapes.

Run:

```bash
bash "$SHEET" inspect --input "$INPUT_XLSX" --out "$WORKSPACE/tmp/inspection.json"
```

Review `package.unsafeForRoundTrip` and `package.roundTripRisks`. If risks are present:

1. Do not run `build --input` automatically.
2. Explain which objects may be lost or rewritten.
3. Prefer read-only analysis, a new companion workbook, or a narrowly designed future OOXML operation.
4. Use `--allow-risky-roundtrip` only after explicit user approval and only when losing or rewriting the listed objects is acceptable.

If the standard helper cannot express a required object, follow [capabilities-and-fallbacks.md](capabilities-and-fallbacks.md). Do not switch libraries or write package XML outside `fallback-patch`.

## Native chart support

Net-new workbooks support editable native `line`, `column`, and `bar` charts. The runtime recalculates formulas first and injects the chart OOXML afterward, so LibreOffice cannot erase the newly created chart during recalculation.

Create a chart through the builder helper:

```js
helpers.addNativeChart(workbook, {
  sheet: "KPI趋势",
  type: "line",
  title: "Q1 指标趋势",
  minPoints: 3,
  categories: "A4:A11",
  series: [
    { name: "实际值", values: "B4:B11", color: "4472C4" },
    { name: "目标值", values: "C4:C11", color: "ED7D31" }
  ],
  anchor: { from: "F3", to: "N19" },
  valueFormat: "0.0%",
  legend: "b"
});
```

- Category and series ranges must have equal lengths.
- Categories must be non-blank, series values must be non-blank and numeric after recalculation, and line charts must contain at least two complete points.
- Keep chart sources visible and formula-backed when reshaping is needed.
- Never copy calculated values into a hidden static range to bypass a chart-source error. Repair the source table/formulas, recalculate, and chart the real range so later edits update the chart.
- Do not use an image to satisfy a requested chart.
- Inspect the package to confirm the chart is native and uses the intended sheet, type, source ranges, series, and point count. For a requested three-month trend, use all three points.
- Render and inspect chart titles, category labels, legend labels, units, placement, and empty-data behavior.
- Do not round-trip an existing chart workbook through ExcelJS by default. Net-new chart creation does not imply safe editing of arbitrary existing chart packages.

The native-chart helper owns the DrawingML anchor and relationship XML. Do not hand-edit it in a builder. Structural inspection rejects malformed anchors, nested or misplaced `clientData`, unresolved worksheet-to-drawing links, unresolved chart relationships, and missing chart parts. Review the rendered chart and confirm `package.compatibility.status` is `ok` before delivery.

Other chart types remain controlled fallbacks. Query `capabilities`; use `fallback-patch` only with a narrow chart/drawing/relationship allowlist, then inspect and review the patched candidate. Choose a supported substitute only when it preserves the intended analytical takeaway and the user accepts the substitution.

## Images and drawings

Use `await helpers.addImage(...)` for a net-new local raster illustration. It normalizes PNG/JPEG/WebP/TIFF input, rejects blank assets, and records the source hash and anchor. Inspect the package and verify placement in the rendered pages. Existing drawing packages can contain unsupported shapes or chart relationships; treat any existing drawing risk as a reason to stop or create a companion workbook.

## Legacy and macro-enabled formats

- Convert `.xls` to a temporary `.xlsx` with `convert-legacy`, inspect the converted workbook, and continue through the XLSX workflow. Preserve the `.xls` source and deliver `.xlsx`.
- Do not edit `.xlsm`; macro preservation and signature integrity are outside the current contract.
- Do not rename an unsupported file to `.xlsx`.

## LibreOffice round-trip limitations

LibreOffice provides deterministic headless recalculation and rendering, but it is not Microsoft Excel. Recalculation can introduce empty drawing parts on worksheets with filters. The runtime removes only drawing parts that have zero anchors, zero drawing relationships, and exactly one resolvable worksheet owner; it preserves and rejects ambiguous or populated drawing structures instead of guessing. Complex Excel-only formulas, external connections, and advanced objects may behave differently. Keep final Microsoft Excel smoke testing as an optional higher-assurance step when the environment provides Excel.
