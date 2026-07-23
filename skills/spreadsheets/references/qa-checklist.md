# QA checklist

## Structural inspection

- Confirm the expected worksheet names and count.
- Confirm the target ranges contain the intended values and formulas.
- Confirm tables, filters, merged ranges, validations, and conditional formatting remain in scope.
- Confirm CSV/TSV row counts, delimiter, and row widths.
- Confirm an edited source file was not overwritten.
- Confirm `coverage.status` is `passed` for every non-trivial task.
- For source-backed workbooks, confirm source hashes still match and inspect every `expectedRanges` mismatch. Do not accept sheet names plus a formula count as meaningful coverage.
- Add `requiredCellTypes` for important KPI, amount, percentage, date, and identifier ranges so number-format contamination cannot pass as a visual-only issue.
- When a chart is requested, confirm a native chart part, worksheet mapping, chart type, series count, source formulas, non-blank categories/values, and the requested minimum point count. An image or a one-point “trend” is not a chart pass.
- Confirm `package.compatibility.status` is `ok`. For native charts, verify the reported drawing part and object counts, and treat malformed anchors or dangling worksheet/drawing/chart relationships as hard failures.

## Formula verification

- Recalculate every formula-driven XLSX.
- Inspect representative input, helper, subtotal, and final output cells.
- Reconcile important totals with source rows.
- Check relative and absolute references after copied formulas.
- Check zero, blank, negative, and missing-data edge cases.
- Run the final formula error scan.

Use:

```bash
bash "$SHEET" audit --input "$FINAL_FILE" --out "$WORKSPACE/qa/audit.json"
```

Do not finalize when `status` is `error`. Fix every `warning`, or register its type and concrete rationale in `warningDispositions`; unresolved warnings block `deliver`. Pay particular attention to missing cached formula results, blank sheets, oversized used ranges, and CJK fallback. Review `advisories` and `package.roundTripRisks` before any future edit of a workbook containing native charts or drawings.

## Visual verification

Render the candidate one worksheet at a time:

```bash
bash "$SHEET" render --input "$CANDIDATE" --out-dir "$WORKSPACE/qa/render" --per-sheet
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
- Chinese titles, labels, chart text, and full-width punctuation have complete glyphs.
- The reported sheet-to-page mapping is plausible and contains no automatically detected blank pages.

## Final integrity

- Seal the candidate with `deliver`; do not manually copy it to the final path.
- Reopen the exported file through `inspect` after the last rebuild.
- Confirm page count and worksheet count are plausible.
- Confirm the final SHA-256 matches the sealed candidate and the final coverage remains passed.
- Confirm the deliverable extension matches the requested format.
- Deliver only the final spreadsheet unless support artifacts were requested.
