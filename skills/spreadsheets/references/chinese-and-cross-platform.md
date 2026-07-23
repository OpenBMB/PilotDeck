# Chinese and cross-platform workbooks

## Default behavior

When the user does not specify a language or target platform, treat Chinese and English as first-class content and use the `cross-platform` profile. Do not force a platform-only font name in that profile; let Excel select its native East Asian fallback. The LibreOffice workflow exposes installed system fonts so Chinese remains visible during recalculation and rendering.

Use `helpers.applyChineseTypography` after populating and styling the sheet:

```js
helpers.applyChineseTypography(sheet, {
  platform: "cross-platform",
  bodySize: 10.5,
  titleSize: 16,
  titleRanges: ["A1:H1"],
});
```

Supported profiles:

- `cross-platform`: leave the font family theme-driven; use this by default.
- `windows`: Microsoft YaHei.
- `macos`: PingFang SC.
- `linux`: Noto Sans CJK SC; use only when the deployment provides it.

An XLSX does not reliably embed fonts. Do not promise pixel-identical typography across Excel for Windows, Excel for macOS, and LibreOffice. The hard requirement is complete glyph coverage, readable text, and no clipping. Font substitution is a warning when the rendered output remains correct.

## Size and spacing baseline

- Body and ordinary table cells: 10.5–11 pt.
- Table headers: 11–12 pt, bold.
- Section headers: 12–14 pt.
- Worksheet title: 16–18 pt.
- Avoid print scaling that makes body text effectively smaller than 9 pt.

Use `helpers.autoFitColumns`; it treats Han characters and full-width punctuation as double-width. Use `helpers.autoFitRows` after setting column widths when wrapped Chinese text is present. Widen a column before creating deeply wrapped rows.

## Chinese data conventions

- Keep values numeric. Apply `¥#,##0`, `¥#,##0.00`, or another requested format instead of writing `¥` into cell values.
- Keep percentages as decimals and format them with `0.0%` or the required precision.
- Keep dates typed. Use invariant format codes such as `yyyy-mm-dd`; use a Chinese display such as `yyyy"年"m"月"d"日"` only when it improves the requested presentation.
- Do not convert values to `万` or `亿` by changing their underlying type. Use a formula-backed helper value or a clearly labeled unit column.
- Quote Chinese sheet names in formulas, for example `'输入数据'!B2`.
- Preserve phone numbers, identity numbers, account numbers, postal codes, and zero-prefixed identifiers as text.

## Chinese CSV and TSV

The runtime detects UTF-8, UTF-8 BOM, GBK, and GB18030 input. Use `--encoding` when detection is ambiguous. New CSV/TSV exports default to UTF-8 with BOM for Excel compatibility; override with `--encoding utf8`, `gbk`, or `gb18030` only when required.

## QA

For a Chinese or bilingual workbook:

1. Inspect representative Chinese cells after LibreOffice recalculation.
2. Review `cjk_font_fallback` warnings.
3. Render every sheet and verify Chinese titles, table headers, chart titles, axes, legends, and month/category labels.
4. Treat missing glyphs, replacement squares, blank Chinese labels, and clipped Han text as hard failures.
5. When assurance matters, perform an additional smoke test in Microsoft Excel on the user's target platform.
