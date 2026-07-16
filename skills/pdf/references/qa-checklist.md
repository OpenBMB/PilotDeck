# PDF QA Checklist

Read this before delivering any created or modified PDF.

## Structural checks

- `pdfinfo` and `pypdf` can open the file.
- Page count is correct and pages are in the requested order.
- Page sizes and rotations are intentional.
- The document is not unexpectedly encrypted.
- Metadata, forms, annotations, and signatures have not changed unexpectedly.
- No requested content is missing; empty pages are intentional.

## Visual checks

Render every page with Poppler and inspect each individual PNG at full resolution. Confirm:

- fonts are embedded or reliably rendered and all glyphs are present;
- headings, paragraphs, lists, and page breaks are consistent;
- no text, image, table, footer, or annotation is clipped or outside the page;
- no objects overlap unintentionally;
- tables wrap cleanly, repeat headers when needed, and remain readable;
- images preserve aspect ratio and use intentional crops;
- page numbers, headers, footers, dates, and cross-references are correct;
- filled form values are visible and aligned;
- scanned pages are upright, legible, and not excessively soft.

A montage helps find inconsistencies but does not replace full-size page inspection.

## Delivery gate

- Resolve every hard audit failure.
- Understand and document any remaining warning.
- Re-render after the last modification; never rely on an earlier render.
- Deliver only the requested PDF unless the user asks for extraction files, QA reports, or source builders.
