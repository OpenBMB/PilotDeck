# DOCX CLI Specifications

Read this file before writing JSON for `create`, `edit`, or `review`. Use only
documented fields and write specifications below the turn-scoped
`PILOTDECK_WORK_DIR`, never beside user files.

Query the live schema first:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
```

The parser is strict. Unknown fields, blocks, and actions fail instead of being ignored.
Document-writing commands refuse to replace an existing output by default. Pass
`--overwrite` only when the user explicitly authorizes replacement of a
distinct output or internal candidate; input and output paths must still
differ. Final source replacement is a separate delivery mode and requires the
current request to authorize `--replace-source`.

## Contents

1. Create specification
2. Content blocks
3. Rich-text runs
4. Table specification
5. Edit patch
6. Review specification

## 1. Create specification

```json
{
  "style_policy": {
    "mode": "builtin",
    "template": "neutral-document-v1"
  },
  "document_structure": {
    "archetype": "simple"
  },
  "locale": "en-US",
  "page": "letter",
  "orientation": "portrait",
  "margins_inches": {
    "top": 0.8,
    "right": 0.8,
    "bottom": 0.8,
    "left": 0.8
  },
  "metadata": {
    "title": "Program Readiness Brief",
    "subject": "Launch decision",
    "author": "Operations Team",
    "keywords": "launch, readiness",
    "category": "Internal",
    "comments": "Prepared for review"
  },
  "content": []
}
```

`style_policy` must match the policy frozen by `prepare`.

- Built-in mode is
  `{"mode":"builtin","template":"neutral-document-v1"}`. It is the default
  when the user did not provide visual instructions. It does not permit
  `style_overrides` or block-level colors/styles.
- User mode is
  `{"mode":"user","source":"explicit-requirements|reference-template|existing-document"}`.
  An `explicit-requirements` source also requires a non-empty `requirements`
  array containing the user's concrete instructions.
- Generic goals such as “formal report” or “professional document” do not
  qualify as explicit visual requirements.

Supported page values: `a4` and `letter`. Supported orientations: `portrait` and `landscape`.

`document_structure` must also match `prepare`. Use the simple structure for
ordinary documents:

```json
{"document_structure": {"archetype": "simple"}}
```

Use the formal report structure only for a cover + TOC + body document:

```json
{"document_structure": {"archetype": "formal-report"}}
```

The formal structure requires the first content block to be `title`, exactly
one `toc` block, and body content after it. The creator inserts exactly one
page boundary before the TOC and another after it. Do not add manual duplicate
breaks around the TOC.

User mode may include a centralized `style_overrides` object with
`body_font`, `east_asia_font`, `body_size`, `title_size`, `title_color`,
`heading_color`, three `heading_sizes`, `normal_alignment`,
`normal_first_line_indent_inches`, `normal_line_spacing_points`,
`table_style`, table header/border colors, callout fill/border colors, and
`space_after`. Do not scatter these decisions through content blocks. The
creator maps missing CJK fonts to an installed platform fallback.

Use the actual content locale such as `zh-CN` or `en-US`; locale-aware defaults
include Chinese TOC and callout labels. Header and footer values may be strings
or objects with `text` and `alignment` (`left`, `center`, or `right`). `{PAGE}`
and `{NUMPAGES}` create real fields.

Do not include a header, footer, `{PAGE}`, or `{NUMPAGES}` by default. They are
valid only when the current request explicitly asks for them and `prepare`
froze the corresponding permission. A page-number footer requires both
`--allow-footer` and `--allow-page-numbers`. For edits, pass the frozen
acceptance manifest; existing recurring content is preserved, while
`set_header` and `set_footer` remain permission-gated.

`update_fields_on_open` is optional and defaults to `false`. Do not enable it
to populate a TOC. It can make Word show a warning when the file opens.
Enable it only when the user explicitly wants Word to recalculate fields on
open and accepts that prompt; final delivery requires the separate
`--allow-update-fields-on-open` opt-in.

## 2. Content blocks

### Title and subtitle

```json
{"type": "title", "text": "Program Readiness Brief"}
{"type": "subtitle", "text": "Decision meeting · 13 July 2026"}
```

### Heading

```json
{"type": "heading", "level": 1, "text": "Recommendation"}
```

Heading levels must be 1–3.

### Paragraph

```json
{"type": "paragraph", "text": "The program is ready to proceed."}
```

Use `"bold": true` only when the entire paragraph requires bold treatment. Use rich-text runs for local emphasis.
Built-in mode does not permit the `style` field.

### Bullet and numbered items

```json
{"type": "bullet", "text": "Confirm the release owner"}
{"type": "numbered", "text": "Approve the deployment window"}
```

Create one block per list item. Do not place multiple items in one paragraph with line breaks.

### Quote

```json
{"type": "quote", "text": "A short quotation or attributed statement."}
```

### Callout

```json
{
  "type": "callout",
  "label": "Decision",
  "text": "Proceed after the final readiness review.",
  "accent": "595959"
}
```

Colors are six-digit RGB hex values. `fill` is optional; omit it for a neutral
callout. Keep callouts short.

### Checklist

```json
{
  "type": "checklist",
  "items": ["Confirm owner", "Confirm date", "Archive evidence"],
  "checked": [true, false, false]
}
```

The output is a visible checklist, not an interactive Word content control.

### Definition list

```json
{
  "type": "definition_list",
  "items": [
    {"term": "Owner", "definition": "Release Management"},
    {"term": "Status", "definition": "Ready with conditions"}
  ]
}
```

### Source list

```json
{
  "type": "source_list",
  "items": [
    "Readiness review, 10 July 2026",
    "Risk register, revision 4"
  ]
}
```

### Image

```json
{
  "type": "image",
  "path": "figures/timeline.png",
  "width_inches": 5.5,
  "caption": "Figure 1. Delivery timeline",
  "alt_text": "Milestones from discovery through launch"
}
```

Resolve relative paths from the JSON file's directory. Remote URLs are rejected.
Raster images are decoded before insertion, transparency is flattened onto a
white background, and fully blank or invalid images are rejected.

### Table of contents and fields

```json
{
  "type": "toc",
  "title": "Contents",
  "levels": [1, 2, 3],
  "page_break_after": true
}
```

```json
{
  "type": "field",
  "instruction": "DATE \\@ \"yyyy-MM-dd\"",
  "placeholder": "Update field",
  "alignment": "right"
}
```

Supported field prefixes are `TOC`, `PAGE`, `NUMPAGES`, `DATE`, and `TIME`. Verify displayed field results in the rendered output. For a TOC block, run `refresh-toc` after headings are stable. Creation alone inserts the live field and an explicit placeholder; preflight rejects a required TOC until visible cached entries and page numbers are populated.

### Page break and spacer

```json
{"type": "page_break"}
{"type": "spacer", "points": 8}
```

Use spacers sparingly. Prefer paragraph style spacing.

## 3. Rich-text runs

Use `runs` instead of `text` when local emphasis is required:

```json
{
  "type": "paragraph",
  "runs": [
    {"text": "Status: ", "bold": true},
    {"text": "Ready", "bold": true, "color": "1F4E79"},
    {"text": " with two open actions.", "italic": false}
  ]
}
```

Supported run fields are `text`, `bold`, `italic`, and `underline`. User style
mode may additionally use `color` and `size_pt` when those values follow the
user's concrete requirements.

Use rich runs with `title`, `subtitle`, `heading`, `paragraph`, `bullet`, `numbered`, `quote`, and `callout` blocks. Avoid direct formatting on most body text; repeated formatting belongs in the frozen style policy.

## 4. Table specification

```json
{
  "type": "table",
  "headers": ["Workstream", "Owner", "Status"],
  "rows": [
    ["Security review", "Security", "Complete"],
    ["Release approval", "Operations", "Pending"]
  ],
  "column_widths": [4, 2, 1.5],
  "alignments": ["left", "left", "center"],
  "repeat_header": true,
  "caption": "Table 1. Launch readiness"
}
```

Rules:

- Every row must contain the same number of cells as the header.
- `column_widths` contains positive relative weights, one per column.
- `alignments` contains `left`, `center`, or `right`, one per column.
- The creator writes explicit table, grid, and cell widths in DXA.
- Rows auto-expand; do not simulate fixed height with blank lines.
- Set `repeat_header` to `true` for multi-page data tables.
- Built-in mode always uses the neutral template: white cells, bold black
  headers, and neutral borders. It rejects `style`, `header_fill`,
  `header_text_color`, and `border_color` on a table block.
- User mode may use those fields when they implement the supplied style.
  Supported table styles are `Table Grid`, `Light Grid`, `Light Shading`,
  `Light Shading Accent 1`, `Light Grid Accent 1`, and
  `Medium Shading 1 Accent 1`. Any other value is a specification error rather
  than a silent fallback.
- A caption is placed before the table and kept with it across pagination.

## 5. Edit patch

```json
{
  "operations": [
    {
      "action": "replace_text",
      "match": "2025 plan",
      "replacement": "2026 plan",
      "occurrence": "all"
    },
    {
      "action": "insert_after",
      "match": "Recommendation",
      "text": "Proceed after final approval.",
      "style": "Normal",
      "occurrence": 1,
      "location": "body"
    },
    {
      "action": "insert_image",
      "match": "Recommendation",
      "path": "figures/timeline.png",
      "placement": "after",
      "width_inches": 5.5,
      "caption": "Figure 1. Delivery timeline",
      "alt_text": "Milestones from discovery through launch",
      "occurrence": 1,
      "location": "body"
    },
    {
      "action": "set_style",
      "match": "Risk summary",
      "style": "Heading 1"
    },
    {
      "action": "append_paragraph",
      "text": "Appendix note.",
      "style": "Normal"
    },
    {"action": "add_page_break"},
    {
      "action": "set_metadata",
      "title": "Updated Program Brief",
      "author": "Operations Team"
    },
    {"action": "set_header", "text": "CONFIDENTIAL", "alignment": "right"},
    {"action": "set_footer", "text": "Page {PAGE} of {NUMPAGES}", "alignment": "center"},
    {"action": "set_table_cell", "table": 1, "row": 2, "column": 3, "text": "Complete"},
    {"action": "append_table_row", "table": 1, "values": ["Legal review", "Legal", "Pending"]}
  ]
}
```

Supported actions:

- `replace_text`: match across adjacent runs while retaining the first and last run formatting.
- `insert_after`: insert one paragraph after a selected matching paragraph.
- `insert_image`: insert a normalized local image before or after a selected
  matching paragraph, with optional caption and alternative text.
- `delete_paragraph`: delete a selected paragraph containing `match`.
- `set_style`: set a Word style on a selected matching paragraph.
- `append_paragraph`: append a paragraph.
- `add_page_break`: append a page break.
- `set_metadata`: change supported core properties.
- `set_header` and `set_footer`: update recurring story text with optional page fields.
- `set_table_cell`: update a one-based table, row, and column.
- `append_table_row`: append values matching the existing column count.

Use `occurrence: "all"`, `occurrence: "first"`, or a one-based integer. For
`replace_text`, occurrence counts individual non-overlapping text matches in
document order, including repeated matches inside one paragraph. For
paragraph-level actions, it counts matching paragraphs. When the default
target is ambiguous, the operation returns `partial`; add `occurrence` or a
location prefix from `inspect`. A missing target also returns `partial` unless
`allow_missing: true` is explicit. Never interpret an unexpected zero
`affected` count as success.

`edit` blocks package-sensitive documents when a `python-docx` round trip may lose content. Prefer `fallback-patch`; use `--allow-lossy` only after explicit user acceptance.

## 6. Review specification

```json
{
  "comments": [
    {
      "match": "The program is ready",
      "text": "Add the evidence source for this conclusion.",
      "author": "PilotDeck",
      "occurrence": 1,
      "location": "body"
    }
  ],
  "tracked_replacements": [
    {
      "match": "launch in May",
      "replacement": "launch in June",
      "author": "PilotDeck",
      "occurrence": 1,
      "location": "body"
    }
  ]
}
```

Use short, unique match strings. Ambiguous matches return `partial` until a one-based `occurrence` is supplied. Bundled comments attach to the containing paragraph in the main body. Tracked replacements require the matched text to exist in one run; cross-run matches return `unsupported` with fallback guidance rather than silently becoming clean edits.
