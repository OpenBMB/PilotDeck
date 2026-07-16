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
bash "$SHEET" inspect --input source.xlsx --out inspection.json
```

Review `package.unsafeForRoundTrip` and `package.roundTripRisks`. If risks are present:

1. Do not run `build --input` automatically.
2. Explain which objects may be lost or rewritten.
3. Prefer read-only analysis, a new companion workbook, or a narrowly designed future OOXML operation.
4. Use `--allow-risky-roundtrip` only after explicit user approval and only when losing or rewriting the listed objects is acceptable.

## Current chart support

This version can detect native chart parts, chart types, and source range formulas during inspection. It does not create or edit native Excel charts.

- Do not claim chart authoring support.
- Do not replace a requested editable chart with a raster image without user approval.
- Do not round-trip an existing chart workbook through ExcelJS by default.
- If the user requests a chart, offer a clear formatted data table or report that native chart support is not yet available.

Future native chart support should use tested OOXML chart templates or another engine that preserves editable chart objects. It must include category/series length checks, source-range verification, and rendering regression tests before it is enabled.

## Images and drawings

ExcelJS can create images, but existing drawing packages can contain unsupported shapes or chart relationships. For an existing workbook, treat any drawing risk as a reason to stop. For a net-new workbook, use images only when they improve comprehension and verify their placement in the rendered pages.

## Legacy and macro-enabled formats

- Do not edit `.xls` through this skill. Ask for an `.xlsx` conversion or create a new `.xlsx` copy.
- Do not edit `.xlsm`; macro preservation and signature integrity are outside the current contract.
- Do not rename an unsupported file to `.xlsx`.

## LibreOffice round-trip limitations

LibreOffice provides deterministic headless recalculation and rendering, but it is not Microsoft Excel. Complex Excel-only formulas, external connections, and advanced objects may behave differently. Keep final Microsoft Excel smoke testing as an optional higher-assurance step when the environment provides Excel.
