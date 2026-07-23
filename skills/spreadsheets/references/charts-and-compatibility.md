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
- Do not use an image to satisfy a requested chart.
- Add every requested chart to `requirements.json`; audit the sheet, type, source ranges, native chart count, and `minPoints`. For a requested three-month trend, use `minPoints: 3`.
- Render and inspect chart titles, category labels, legend labels, units, placement, and empty-data behavior.
- Do not round-trip an existing chart workbook through ExcelJS by default. Net-new chart creation does not imply safe editing of arbitrary existing chart packages.

The native-chart helper owns the DrawingML anchor and relationship XML. Do not hand-edit it in a builder. `audit` rejects malformed anchors, nested or misplaced `clientData`, unresolved worksheet-to-drawing links, unresolved chart relationships, and missing chart parts. A chart is structurally deliverable only when `package.compatibility.status` is `ok` in addition to meeting the chart requirements.

Other chart types remain unsupported. If a requested type is unavailable, choose the closest supported native type only when it preserves the intended analytical takeaway, and state the substitution.

## Images and drawings

ExcelJS can create images, but existing drawing packages can contain unsupported shapes or chart relationships. For an existing workbook, treat any drawing risk as a reason to stop. For a net-new workbook, use images only when they improve comprehension and verify their placement in the rendered pages.

## Legacy and macro-enabled formats

- Convert `.xls` to a temporary `.xlsx` with `convert-legacy`, inspect the converted workbook, and continue through the XLSX workflow. Preserve the `.xls` source and deliver `.xlsx`.
- Do not edit `.xlsm`; macro preservation and signature integrity are outside the current contract.
- Do not rename an unsupported file to `.xlsx`.

## LibreOffice round-trip limitations

LibreOffice provides deterministic headless recalculation and rendering, but it is not Microsoft Excel. Recalculation can introduce empty drawing parts on worksheets with filters. The runtime removes only drawing parts that have zero anchors, zero drawing relationships, and exactly one resolvable worksheet owner; it preserves and rejects ambiguous or populated drawing structures instead of guessing. Complex Excel-only formulas, external connections, and advanced objects may behave differently. Keep final Microsoft Excel smoke testing as an optional higher-assurance step when the environment provides Excel.
