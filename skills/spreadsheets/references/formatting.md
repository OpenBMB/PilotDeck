# Formatting

Use formatting to clarify the workbook's information and purpose. Do not treat visual decoration as evidence of quality.

## Find the design source

Look for presentation guidance in this order:

1. Explicit user requirements.
2. A supplied template or visual reference.
3. The established language of an existing workbook.
4. The workbook's purpose and information structure.
5. A restrained neutral baseline when none of the above supplies a direction.

When editing an existing workbook, render and inspect it first. Preserve unrelated fills, fonts, borders, alignment, number formats, widths, row heights, tables, and conventions. Make the smallest coherent change unless the user requests a redesign.

## Use a neutral baseline thoughtfully

For an ordinary data sheet without a supplied style, prefer:

- White body cells and dark text.
- Bold text or a light-gray fill for headers.
- Subtle borders or whitespace for grouping.
- Readable column widths and consistent row heights.
- Explicit number, percentage, currency, and date formats.
- Frozen headers and filters when they improve navigation.
- Color only when it communicates status, category, exception, or another useful meaning.

Do not automatically add a merged cover title, oversized heading, KPI cards, dashboard framing, theme palette, gradients, shadows, or widespread colored fills. Generic requests such as "professional" do not imply a blue or branded theme.

Neutral is a starting point, not a restriction. Reports and dashboards may benefit from stronger hierarchy, accent colors, summary blocks, and hidden gridlines when those choices support their content.

## Build hierarchy before decoration

Prefer this sequence:

1. Organize the data and sections clearly.
2. Apply appropriate number formats.
3. Set alignment, widths, heights, and wrapping.
4. Establish hierarchy with typography and spacing.
5. Add borders and restrained fills where they improve scanning.
6. Add color or graphic emphasis only when it carries meaning.

Use bold sparingly. Left-align descriptions, right-align numbers, and keep identifiers visually distinct from quantities. Widen columns before creating deeply wrapped rows.

## Use workbook purpose as context

- Favor density, scanning, filtering, and accurate types in data tables.
- Favor input clarity, validation, and editable ranges in trackers and forms.
- Distinguish assumptions, formulas, and outputs in calculation models.
- Use stronger narrative hierarchy in reports.
- Use charts and summary components in dashboards when they answer a real question.
- Follow the supplied structure and tokens in templates.

These are design considerations, not runtime categories.

## Number formats

Use invariant Excel format codes appropriate to the content:

- Count: `#,##0`
- Decimal: `#,##0.0`
- Percentage: `0.0%`
- Chinese yuan: `¥#,##0` or `¥#,##0.00`
- Date: `yyyy-mm-dd`

Use enough precision to support the task without creating visual noise. Keep numeric-looking identifiers as text.

## Tables and summaries

Use a native table when filters, banding, or structured growth improve usability. Keep names unique and stable. Do not merge cells inside calculation tables.

Use summaries and conditional formatting when they help the user understand totals, status, thresholds, variance, or exceptions. Drive derived summaries with formulas when practical.

## Review the result

Render the candidate and inspect the images at useful resolution. Look for clipping, poor wrapping, unreadable scaling, accidental blank areas, misleading emphasis, excessive styling, broken hierarchy, and differences from supplied templates.

Let the model judge whether the presentation supports the user's request. Do not turn palette choices, title size, or fill counts into universal pass/fail rules.
