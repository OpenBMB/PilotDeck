# Optional DOCX tools

These commands provide deterministic evidence or mechanical package operations. They are optional except for final `deliver`; none replaces the model's judgment about the user's requested outcome.

## Inspect, validate, and render

```bash
bash "$DOCX" inspect --input source.docx --summary
bash "$DOCX" inspect --input source.docx --search "target phrase"
bash "$DOCX" validate --input candidate.docx
bash "$DOCX" render --input candidate.docx --out-dir "$WORKSPACE/review/latest"
```

`inspect` reports document and package facts. `validate` checks that the DOCX package is structurally safe to publish. `render` produces numbered full-page PNGs using LibreOffice under a revision-specific subdirectory of `--out-dir`, so a changed document cannot reuse the previous candidate's image paths. These commands do not declare the content or appearance correct.

## Compare

```bash
bash "$DOCX" compare --before source.docx --after candidate.docx --out "$WORKSPACE/review/comparison.json"
```

`compare` reports text, metadata, count, section, field, image, and package-feature changes. It is neither a visual diff nor a Microsoft Word legal redline.

## Comments and tracked replacements

Use `annotate` only when the request explicitly needs review markup. It accepts a task-local JSON specification:

```json
{
  "comments": [
    {"match": "Target text", "text": "Review note", "author": "PilotDeck", "occurrence": 1}
  ],
  "tracked_replacements": [
    {"match": "Old text", "replacement": "New text", "author": "PilotDeck", "occurrence": 1}
  ]
}
```

The bundled operation targets text in the main document story; implement a task-specific OOXML edit when a requested target is outside that supported surface.

Use `finalize --accept-changes` or `--reject-changes`, optionally with `--remove-comments`, only when the user requested that state. Inspect the result afterward.

## Sanitize

`sanitize` removes core author fields, custom properties, Word revision identifiers, and optionally comments. It does not redact visible names, prose, images, external links, embedded files, or arbitrary custom XML.

## Deliver

```bash
bash "$DOCX" deliver --input candidate.docx --out final.docx
```

The candidate must be under `PILOTDECK_WORK_DIR`; the final path must be in the project workspace. Source replacement requires explicit user authorization and `--replace-source`.
