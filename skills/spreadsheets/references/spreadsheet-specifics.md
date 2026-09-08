# Spreadsheet-specific behavior

Read only the sections relevant to the current workbook.

## Formula caches and calculation engines

An XLSX formula cell can contain both the formula and a cached result. Libraries such as openpyxl and ExcelJS can write formulas without calculating them; previewers and readers that do not run Excel may then show blanks or stale values.

Use `recalculate` once on the final candidate when formulas or their dependencies changed and cached values matter. Give it a new output path; it will not replace an existing candidate. It calculates a temporary copy and merges safe formula results into the original package. If the workbook contains a known incompatible formula or any result cannot be merged safely, it returns `unsupported` without creating a candidate because other formulas may depend on that result. Do not bypass `unsupported` or `blocked` results with a destructive round trip.

LibreOffice is not Microsoft Excel. Treat external workbook references, VBA or add-in functions, data tables, array and dynamic-array formulas, cube and data-model formulas, and formulas marked with `_xlfn`, `_xlws`, or `_xludf` as higher risk. Preserve the formula and report the limitation when the available engine cannot calculate it reliably.

## Existing workbook packages

XLSX files may contain tables, charts, drawings, validations, conditional formatting, comments, external connections, pivots, custom XML, and signatures in separate package parts. Prefer localized edits when the user asks for a targeted change. A successful library save does not prove that unrelated objects survived.

Use `compare` after a package-sensitive edit when it would help distinguish intended changes from unrelated package changes. Digital signatures are invalidated by any package modification. This skill does not edit `.xlsm`, encrypted workbooks, or live Excel sessions.

## Values and dates

- Store identifiers as text when leading zeroes or more than 15 significant digits matter.
- Use numeric cells for quantities and amounts instead of formatting numeric-looking text.
- Use actual date or datetime values with an appropriate number format.
- Preserve the workbook's 1900 or 1904 date system when editing.
- Use formulas for derived values when the user expects an inspectable, reusable model.

## Delimited files

CSV and TSV files do not preserve formulas, formatting, comments, validation, images, charts, or multiple sheets. Confirm the intended sheet and delimiter before exporting a workbook to a delimited format.

When untrusted text begins with `=`, `+`, `-`, or `@`, consider spreadsheet-formula injection before CSV export. Keep the original value unless the requested workflow authorizes escaping or transforming it.

## Cross-platform appearance

XLSX files do not reliably embed fonts. Excel on Windows, Excel on macOS, and LibreOffice may substitute fonts or paginate differently. Review for complete glyph coverage, readable text, clipping, chart legibility, and print overflow rather than promising pixel-identical rendering across applications.
