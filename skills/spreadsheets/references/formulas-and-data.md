# Formulas and data

## Workbook organization

- Put raw imports and editable assumptions in dedicated sheets or clearly marked ranges.
- Put calculation helpers next to their source or in a labeled calculation sheet.
- Put decision-ready outputs in a compact summary sheet.
- Use cells as the source of truth for anything the user should be able to update.

## Formula rules

- Write derived values as formulas rather than hardcoded numbers.
- Keep formulas short and traceable. Break long formulas into helper cells.
- Use correct relative and absolute references when formulas are copied.
- Use bounded ranges such as `$A$2:$A$5000`; avoid `A:A` in large models.
- Reference assumptions instead of embedding magic numbers.
- Quote every cross-sheet name: `'Revenue Model'!B6`.
- Use English Excel function names and comma separators.
- In an ExcelJS `{ formula }` object, omit the leading `=`.
- Guard expected edge cases with functions such as `IFERROR` only when the fallback is semantically valid.
- Do not use `NA()` or an intentional `#N/A` to represent an expected business state such as “not applicable” or “missing source”. Return a blank or text such as `"不适用"`, and explain it in a note or status column. Formula error values are hard audit failures.

Example:

```js
sheet.getCell("D5").value = {
  formula: "IF(B5=0,0,C5/B5)",
  result: 0,
};
```

Do not use `result` as an independently calculated answer. The build command removes cached formula results, requests a full calculation, and lets LibreOffice write verified results back to the XLSX.

## Compatibility of formulas

LibreOffice and Excel do not implement every function identically. Treat these as higher risk:

- New Excel-only dynamic-array functions.
- Cube formulas and data-model functions.
- External workbook references.
- Proprietary add-in functions.
- Power Query and linked data types.

Prefer well-supported arithmetic, logical, lookup, date, text, statistical, and financial functions. If a requested formula is Excel-specific, disclose the compatibility risk and verify in Microsoft Excel when available.

## Typed values

- Store counts and measures as numbers.
- Store percentages as decimal numbers such as `0.125`, formatted as `0.0%`.
- Store dates as `Date` values and apply an invariant number format such as `yyyy-mm-dd`.
- Store account IDs, SKUs, ZIP codes, and zero-prefixed identifiers as strings.
- Do not write currency symbols or thousands separators into numeric values.

## CSV and TSV safety

Delimited files do not preserve formulas, formats, comments, multiple sheets, validations, images, or charts.

- Preserve the source delimiter when the requested output stays delimited.
- Preserve quoted delimiters and newlines correctly.
- Preserve leading zeroes unless the user clearly requests numeric conversion.
- Preserve integers longer than 15 digits as text; JavaScript and Excel cannot safely represent them as ordinary numbers.
- Detect UTF-8, UTF-8 BOM, GBK, and GB18030 input. Use an explicit encoding when automatic detection is ambiguous.
- New delimited exports default to UTF-8 with BOM so Chinese opens correctly in desktop Excel.
- Do not infer locale-specific dates automatically.
- Treat phone numbers, identity numbers, account numbers, order IDs, and postal codes as identifiers, not measures.
- Review untrusted text beginning with `=`, `+`, `-`, or `@` before CSV export when spreadsheet-formula injection is a security concern.
- Report inconsistent row widths instead of silently dropping cells.
- Convert to XLSX when the requested result needs formulas or formatting.

## Verification

After build or recalculation:

1. Inspect important result cells and their formulas.
2. Reconcile totals against source rows or assumptions.
3. Run `audit` and fix every formula error.
4. Render the final workbook and check visible values and units.

The audit scans `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, `#N/A`, `#NUM!`, `#NULL!`, `#SPILL!`, and related error values. These are hard failures, including an intentional `#N/A`.
