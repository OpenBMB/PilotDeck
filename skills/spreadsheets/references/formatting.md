# Formatting

## Preserve an existing workbook

- Render the source workbook before editing it.
- Inspect the target range's fills, fonts, borders, alignment, merged cells, number formats, widths, and row heights.
- Change values without replacing existing styles.
- Extend surrounding formulas, table ranges, validations, and conditional formatting when adding rows or columns.
- Make the smallest plausible visual change. Do not apply sheet-wide autofit or restyling without a redesign request.

## Baseline for a new workbook

- Use a clear title, section hierarchy, and visible summary area.
- Distinguish headers from input and output cells.
- Use restrained fills and borders; do not box every populated cell.
- Use whitespace and slightly taller section rows to separate logical blocks.
- Hide gridlines only when explicit styling provides sufficient structure.
- Freeze header rows or identifier columns for large sheets.
- Apply formatting only to populated or intentionally reserved ranges.

## Typography and alignment

- Use one neutral, widely available body font.
- Use bold sparingly to establish reading order.
- Left-align descriptions, right-align numbers, and apply explicit date/number formats.
- Widen columns before creating deeply wrapped rows.
- Keep row heights consistent within a section.

## Number formats

Use invariant Excel format codes:

- Count: `#,##0`
- Decimal: `#,##0.0`
- Percentage: `0.0%`
- Currency: `"$"#,##0` or a currency requested by the user
- Date: `yyyy-mm-dd`
- Month: `mmm yyyy`

Use enough precision to support the decision, not every available decimal place.

## Tables and summaries

- Use a native table when filters, banding, or structured growth improve usability.
- Keep table names unique and stable.
- Show important totals near the top or in a summary block, driven by formulas.
- Use conditional formatting for status, thresholds, variances, and exceptions.
- Do not merge cells inside calculation tables. Reserve merging for titles and section labels.

## Visual QA

At full-size render, verify:

- Headers and important numbers are not clipped.
- Wrapped text is readable and row heights are sufficient.
- Units, currency, dates, and percentages display correctly.
- Sections do not overlap and pages do not contain accidental blank areas caused by a bloated used range.
- Print scaling does not make the workbook unreadably small.
