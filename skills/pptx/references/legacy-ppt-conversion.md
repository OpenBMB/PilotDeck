# Legacy PPT conversion

## Supported contract

Accept a binary PowerPoint 97–2003 `.ppt` only as a preserved source. Convert it with LibreOffice to a distinct `.pptx`, then use the normal OOXML inspection, template, audit, render, and delivery workflow. Never promise native `.ppt` editing, `.ppt` output, or lossless migration.

```bash
bash "$PPTX" convert \
  --input source.ppt \
  --out "$WORKSPACE/tmp/source-converted.pptx" \
  --qa-dir "$WORKSPACE/legacy-conversion-qa"
```

The command detects the format from file bytes rather than trusting the extension. A renamed PPTX is normalized without legacy conversion. An invalid or corrupt binary file fails closed and does not create the requested output.

## Verification

The conversion command:

1. Hashes the source before and after conversion.
2. Renders the source `.ppt` with LibreOffice.
3. Converts through the `Impress MS PowerPoint 2007 XML` filter.
4. Parses the converted OOXML and verifies a non-empty slide manifest.
5. Renders the converted `.pptx` at the same DPI.
6. Compares page counts and paired raster output.
7. Atomically writes the requested `.pptx` only after structural checks pass.

Page-count mismatch, source mutation, invalid OOXML, missing render output, or conversion failure blocks the result. A visual-difference warning requires full-size review and a compatibility note.

## Known limitations

Do not claim that LibreOffice preserves all legacy PowerPoint behavior. Explicitly disclose risk for:

- VBA macros, which cannot be retained in `.pptx`.
- Legacy animation, transitions, WordArt, and organization charts.
- Embedded OLE objects, linked files, audio, and video.
- Editable chart data and uncommon PowerPoint 97–2003 objects.
- Missing fonts, text reflow, and target-viewer substitution.
- Password-protected or damaged files.

For high-risk archival migration, ask the user to smoke-test the converted file in Microsoft PowerPoint. PowerPoint is the target-viewer authority; LibreOffice supplies the automated conversion and baseline rendering.
