# PowerPoint-specific behavior

Read this reference only when the presentation or requested edit involves the relevant feature.

## Preserve package-sensitive features

`python-pptx`, PptxGenJS, LibreOffice, and other libraries support different subsets of PowerPoint. Rebuilding or round-tripping a presentation can alter or remove speaker notes, masters, layouts, themes, animations, transitions, charts, embedded workbooks, OLE objects, macros, signatures, custom XML, and uncommon media.

For a targeted edit, inspect the features actually present and prefer a localized change when reconstruction would expose unrelated content to round-trip loss. A structurally valid package does not prove that every advanced feature survived semantically.

## Charts and embedded data

A native chart can contain cached values, formulas, external-data relationships, and an embedded workbook. Whether the workbook must be present depends on how the chart was created and what the user expects to edit. Broken internal relationships are structural errors; absence of an embedded workbook is not universally an error.

## Rendering

LibreOffice rendering is useful evidence but is not Microsoft PowerPoint. Font substitution, line wrapping, effects, media, animations, and some chart or SmartArt behavior may differ. Compare source and candidate evidence before attributing a renderer-specific difference to an edit.

Rendered images become stale as soon as the candidate changes.
