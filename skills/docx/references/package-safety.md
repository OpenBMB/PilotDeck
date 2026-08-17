# DOCX package safety

A DOCX is an OPC ZIP package containing XML parts, relationships, media, and properties. Text extraction and clean page images do not prove package fidelity.

## Strict invariants

The CLI validates archive paths, expansion limits, required parts, XML, internal relationships, content types, and macro absence. Mutation blocks active content, effective document/write protection, and digital signatures that would be invalidated.

Keep source and candidate paths distinct. Build and fallback outputs stay under `PILOTDECK_WORK_DIR`; only `deliver` publishes the final file. Source replacement requires the current request to authorize `--replace-source` and creates a recovery copy.

Never follow external relationships automatically or fetch remote media. Never bypass protection or claim signature validity after mutation.

## Decide between builder and patch

Use the ordinary builder for:

- new documents;
- ordinary DOCX files created from standard paragraphs, lists, tables, sections, fields, and inline images;
- localized edits when inspection shows no package-sensitive objects.

Use `fallback-patch` for a narrow edit to an existing package containing charts, diagrams, embedded objects, content controls, or nonstandard custom XML, or when a required operation is not safely expressible through `python-docx`.

The patch program receives:

```bash
python patch.py --package-dir /temporary/unpacked/package
```

It edits only that temporary package. Declare the smallest relevant `--allow-part` set, such as:

- `word/document.xml`
- `word/styles.xml`
- `word/numbering.xml`
- `word/header*.xml`
- `word/footer*.xml`
- `word/settings.xml`
- `word/_rels/*.rels`
- `[Content_Types].xml`

Macro, ActiveX, signature, and embedded-object parts cannot be allowlisted. The wrapper records changed parts, rejects scope violations, repacks the document, and validates the result.

Reinspect and review after a patch. A valid ZIP proves package integrity, not content correctness or visual quality.

## Coverage limits

Inspection inventories but may not fully interpret text boxes, charts, SmartArt, Office Math, footnotes, endnotes, comments, tracked revisions, embedded objects, complex content controls, or application-specific custom XML. Decide whether a limitation matters to the requested change; do not turn a limited reading surface into a claim of complete understanding.
