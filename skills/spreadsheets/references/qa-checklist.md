# QA checklist

## Structural inspection

- Confirm the expected worksheet names and count.
- Confirm the target ranges contain the intended values and formulas.
- Confirm tables, filters, merged ranges, validations, and conditional formatting remain in scope.
- Confirm CSV/TSV row counts, delimiter, and row widths.
- Confirm an edited source file was not overwritten.

## Formula verification

- Recalculate every formula-driven XLSX.
- Inspect representative input, helper, subtotal, and final output cells.
- Reconcile important totals with source rows.
- Check relative and absolute references after copied formulas.
- Check zero, blank, negative, and missing-data edge cases.
- Run the final formula error scan.

Use:

```bash
bash "$SHEET" audit --input "$FINAL_FILE" --out audit.json
```

Do not finalize when `status` is `error`. Review every `warning`, especially missing cached formula results, blank sheets, oversized used ranges, and round-trip risks.

## Visual verification

Render the complete final workbook:

```bash
bash "$SHEET" render --input "$FINAL_FILE" --out-dir render
```

Inspect the montage for overall coverage, then inspect every `page-N.png` at full resolution.

Check:

- No clipped titles, labels, or important numbers.
- No unreadably narrow columns or excessively tall wrapped rows.
- Correct number, date, currency, and percentage formats.
- Clear visual hierarchy and consistent spacing.
- No accidental blank sheets or extra blank print pages.
- No tables, images, or sections extending beyond the printable page unexpectedly.
- No formula errors visible in cells.

## Final integrity

- Reopen the exported file through `inspect` after the last rebuild.
- Confirm page count and worksheet count are plausible.
- Confirm the deliverable extension matches the requested format.
- Deliver only the final spreadsheet unless support artifacts were requested.
