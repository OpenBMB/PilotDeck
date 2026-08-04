# DOCX Design and Layout Guide

Use this guide for new documents, major rewrites, restyling, template-based creation, forms, and any task where pagination or visual hierarchy matters.

## Contents

1. Design sequence
2. Style sources and built-in template
3. Page and typography system
4. Content-form selection
5. Tables
6. Lists, forms, and callouts
7. Images and captions
8. Template following
9. Visual audit

## 1. Design sequence

Design the document before drafting it.

1. Identify the reader, decision, and document archetype.
2. Estimate the page budget and content density.
3. Freeze one style source. Do not mix a user-provided system with the built-in template.
4. Define the title block, heading hierarchy, body rhythm, lists, tables,
   callouts, and images. Define headers, footers, or page numbers only when the
   user explicitly requests them.
5. Map every major content unit to the lightest form that helps the reader understand or act.
6. Generate a working DOCX, render it, and refine the design from the pages rather than from assumptions.

Prefer restraint for serious or operational documents. Achieve polish through typography, alignment, spacing, hierarchy, and consistency before adding decoration.

## 2. Style sources and built-in template

Every creation uses one of two paths:

1. **User style:** follow a supplied reference template, concrete visual
   instructions, or the style of an existing DOCX. Preserve that system
   consistently and do not mix in the built-in template.
2. **Built-in style:** use `neutral-document-v1` whenever the user did not
   specify a visual system. This is the only built-in template currently
   exposed. Document archetypes do not choose colors.

`neutral-document-v1` is intentionally restrained:

- black titles and headings;
- 10.5 pt Chinese serif body with Times New Roman for Latin text and numbers;
- justified body paragraphs, an approximately 0.76 cm first-line indent, and
  18 pt line spacing;
- semantic Heading styles with black hierarchy;
- white table cells, black text, neutral borders, and bold headers rather than
  decorative color fills;
- callouts expressed with spacing and a fine neutral border rather than a
  colored panel.

The architecture may add more built-in templates later, but no unavailable
template may be invented or selected. A colorful design is possible only
through the user-style path and concrete current-request evidence.

## 3. Page and typography system

Set page size, orientation, and margins explicitly in the creation specification. Use A4 or US Letter consistently unless the content clearly requires landscape sections.

Apply these principles:

- Keep body text readable; avoid sizes below 9 pt except for short, secondary labels.
- Use semantic Heading 1, Heading 2, and Heading 3 styles. Do not imitate headings with bold body paragraphs.
- Avoid skipping heading levels.
- Use paragraph spacing, not repeated blank paragraphs, to create vertical rhythm.
- Keep a heading with at least the first paragraph or list item that follows it.
- Avoid forcing content into a page with aggressive font reduction. First shorten labels, adjust widths, improve wrapping, or revise structure.
- Set East Asian font mappings explicitly when the content includes CJK text.
- Use bold, italic, underline, and color sparingly and consistently.

Use rich-text `runs` only when a paragraph needs localized emphasis. Prefer styles for repeated visual behavior.

## 4. Content-form selection

Map information to an appropriate form:

- **Prose:** explanation, evidence, context, or argument.
- **Lead callout:** a decision, recommendation, warning, or critical constraint.
- **Numbered list:** ordered actions or a sequence where order matters.
- **Bulleted list:** related considerations where order does not matter.
- **Checklist:** acceptance criteria or actions that readers must verify.
- **Definition list:** compact terms, owners, values, or key facts.
- **Table:** repeated records with shared fields that readers must compare or look up.
- **Image:** a visual that improves understanding, not decorative filler.
- **Source list:** evidence, references, or supporting materials.

Do not put ordinary prose into a table merely to draw borders around it. If most cells contain paragraph-length text, convert the section to prose, bullets, steps, callouts, or an appendix.

Audit adjacent components. Repetition is acceptable when the information task is the same, but a long sequence of visually identical tables or boxes usually indicates that the form is not matching the content.

## 5. Tables

Use tables only for genuine row-and-column data.

### Geometry

- Define one `column_widths` value per column. Values are relative weights, not inches.
- Give narrative columns more width than status, date, code, score, or owner columns.
- Keep the table within the usable page width.
- Use explicit DXA table width, grid widths, and cell widths. The bundled creator applies this geometry deterministically.
- Keep cell margins on all sides. Text must not touch borders.
- Allow rows to expand naturally. Never use exact row heights for wrapped text.
- Repeat the first row on subsequent pages when it is a header.
- Prefer left table alignment with the document text edge.

### Alignment

- Left-align narrative and multi-line content.
- Center short statuses, dates, checkmarks, and compact codes when that improves scanning.
- Right-align numeric amounts when magnitude comparison matters.
- Vertically center ordinary table cells unless top alignment is intentional for long narrative rows.

### Pagination

- Avoid a table header stranded at the bottom of a page.
- Split long tables across pages with repeating headers.
- Keep a caption with the table.
- If a table creates a large blank area, adjust content or split it logically instead of shrinking it until unreadable.

### QA

Zoom into every rendered table and check:

- cell text clipping;
- cramped top or left edges;
- excessive wrapping in narrow columns;
- inconsistent alignment by column type;
- rows split in confusing places;
- missing repeated headers;
- a table pushed beyond the right margin;
- body text placed too close below the table.

For a formal or neutral document, also verify that tables are not dominated by
blue, green, or another chromatic fill. The final audit warns when repeated
Accent table styles or broad direct color fills appear; either correct the
design or record why the user explicitly requested that treatment.

## 6. Lists, forms, and callouts

Use real Word list styles for bullets and numbering. Never type bullet characters, hyphens, or number prefixes to simulate a list. Confirm that wrapped lines align with the item text rather than the marker.

Use the `checklist` block for a visible, non-interactive checklist. If the user needs fillable Word content controls, explain that the bundled CLI does not yet create interactive controls and do not claim otherwise.

Use `callout` for a short decision, warning, or constraint. Keep callouts concise. Do not place entire sections inside decorative boxes.

Design forms for completion rather than for spreadsheet-like density:

- provide clear labels and adequate response space;
- use obvious selection targets;
- avoid dense full-grid layouts;
- size fields according to expected answers;
- group related fields with light hierarchy and spacing.

## 7. Images and captions

Use local image paths only. Choose a width that remains inside the text area and preserves the source aspect ratio.

- Place the caption immediately after the image.
- Keep the image and caption together when possible.
- Image paragraphs must use automatic line spacing. Exact body-text line
  spacing clips inline drawings even when the embedded image is valid.
- Provide meaningful alternative text when accessibility is required. Set `alt_text` on every meaningful image block; decorative images may use an empty description only when that choice is intentional and verified in the accessible audit.
- Do not use images as a substitute for editable text when the user needs to revise the content.
- Inspect image sharpness, scaling, wrapping, and page position after rendering.
- When the request explicitly requires illustrations, freeze a minimum image
  count during `prepare` and verify the final package contains those images.
  Generating a PNG in tmp is not completion until it is embedded in the DOCX.
- For formal reports, use the formal-report structure so the cover, TOC, and
  body begin on separate pages. Do not imitate page separation with repeated
  blank paragraphs.
- A title's line box must be at least large enough for its largest glyph. Avoid
  exact line spacing below roughly 110% of the maximum font size.

## 8. Template following

When an attached DOCX is a style template:

1. Inspect and render the template before drafting.
2. Treat its page geometry, styles, hierarchy, headers, footers, tables, and recurring components as the visual authority.
3. Preserve the template file and create a new output.
4. Prefer targeted editing of a copy when the required structure already exists.
5. Do not apply the built-in template on top of a user template unless the user requests a redesign.
6. Compare the rendered output with the template's corresponding pages.

Do not promise full template fidelity for macros, digital signatures, embedded objects, complex fields, or content controls without inspecting those parts.

## 9. Visual audit

Inspect all rendered pages, not a sample. Evaluate both correctness and visual quality.

### Correctness

- no clipping, overlap, overflow, missing glyphs, or broken images;
- correct page count and section orientation;
- stable headers and footers;
- coherent heading order and numbering;
- correct tables, captions, and lists;
- no unintended blank pages.

### Quality

- clear reading path and hierarchy;
- balanced density and whitespace;
- consistent spacing between equivalent components;
- reasonable line length;
- no dense text walls unless the genre requires them;
- restrained and purposeful color;
- visual forms that match the reader's task.

When a page feels crowded, fix structure, width, wrapping, or content density before reducing type size. When a page feels empty, verify that a table, image, or keep-together setting was not pushed unnecessarily to the next page.
