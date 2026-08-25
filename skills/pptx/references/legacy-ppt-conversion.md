# Legacy `.ppt` conversion

The binary PowerPoint 97–2003 format is not OOXML. Preserve the source and convert it once to an internal `.pptx` candidate before editing.

Use `convert-legacy` for the deterministic conversion step. It isolates the LibreOffice profile, verifies that the source did not change, validates the converted OOXML package, and writes the candidate atomically. Rendering is deliberately separate.

Legacy animations, macros, OLE objects, WordArt, charts, media, and uncommon fonts may not convert losslessly. When any of them matters, compare the source and converted presentation in a viewer that supports the source, or render both when the available renderer can open them. Report unresolved compatibility limits instead of claiming lossless migration.
