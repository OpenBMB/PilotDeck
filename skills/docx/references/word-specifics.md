# Word-specific considerations

Read this only when the request depends on Word behavior that is not obvious from ordinary document text.

## Existing and complex documents

A DOCX is an OPC ZIP package containing XML parts, relationships, media, and properties. A `python-docx` round trip is well suited to ordinary paragraphs, lists, tables, sections, styles, and inline images, but it may not preserve every chart, diagram, embedded object, content control, custom XML mapping, signature, protection setting, or uncommon field.

Inspect the features material to the requested change. Prefer a localized edit, direct OOXML operation, or another suitable library when a full object-model round trip would discard something important. Do not follow external relationships automatically, bypass protection, or claim that a changed digital signature remains valid.

## Layout and rendering

- Follow supplied templates and concrete visual requirements.
- Use semantic heading and list styles where they support the document.
- Use paragraph spacing rather than repeated blank paragraphs.
- Let tables grow naturally and inspect wrapping, row splitting, and page width.
- Preserve image aspect ratios and keep captions adjacent when relevant.
- Expect pagination and font substitution differences between LibreOffice and Microsoft Word. Treat rendering as evidence, not proof of pixel-identical Word output.

## Fields, comments, and revisions

Word fields such as a TOC may need to be updated in Microsoft Word before their displayed result and page numbers are current. Do not fabricate cached page numbers when a native field update is unavailable.

Comments and tracked changes may not appear in ordinary page renders. Inspect their XML or structural counts when their presence and state matter. Do not accept or reject revisions unless the user requested that review state.
