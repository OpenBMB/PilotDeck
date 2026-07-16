# PDF Structure and Forms

Read this before merging, splitting, rotating, editing metadata, or filling a PDF form.

## Structural edits

- Page operations change the PDF object structure; they do not reflow text like a word processor.
- Preserve the input and write a distinct output.
- Inspect page count, media boxes, rotation, metadata, encryption, annotations, and AcroForm fields before editing.
- After merging, verify source order, total page count, page-size changes, bookmarks or forms that may not survive, and all rendered pages.
- After splitting, name outputs deterministically and confirm the requested page selection is one-based.
- Rotation must be a multiple of 90 degrees. Render rotated pages to catch crop-box and orientation issues.

## Forms

- `forms-inspect` targets AcroForm fields. XFA and proprietary dynamic forms are not supported by the bundled workflow.
- Use the exact field names returned by inspection. Store fill values in a JSON object and keep sensitive values in the task scratch directory.
- Filling fields can update values without guaranteeing a correct visual appearance in every viewer. Render the filled result and inspect all affected pages.
- Checkbox and choice values are PDF-specific. Use the exported options/states rather than guessing.
- Do not alter digital signatures or claim that a modified PDF remains signed. Editing a signed PDF usually invalidates its signature.

## Content extraction limitations

- PDF text order is reconstructed from positioned glyphs and may differ from visual reading order.
- Table detection is heuristic. Validate extracted rows against the rendered page before using them for calculations or decisions.
- An image-only page can be visually valid while yielding no text. OCR is a separate workflow.
- Redaction is not the same as drawing an opaque rectangle. Do not claim content is securely redacted without a dedicated redaction implementation and verification that underlying text and objects were removed.
