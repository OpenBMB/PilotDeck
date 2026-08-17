# DOCX design and layout

Load this guide when appearance, pagination, templates, tables, or images matter.

## Visual source

Follow concrete user requirements and supplied templates. When editing, preserve the document's visual language unless redesign is requested. Without a visual source, start from `context.new_document(locale=...)` and build hierarchy with styles, spacing, alignment, and content structure before color.

Use semantic Heading and list styles. Use paragraph spacing rather than repeated empty paragraphs, and keep headings with following content.

## Typography and pages

- Set suitable East Asian fonts for Chinese, Japanese, or Korean text.
- Avoid exact line spacing that can clip glyphs or inline images.
- Choose page size, orientation, margins, and sections from the content.
- Revise structure or widths before shrinking text.
- Expect pagination differences between LibreOffice and Microsoft Word; do not promise pixel-identical rendering.

## Tables and images

Give narrative table columns more room than dates, status, codes, or short numbers. Let rows grow naturally, repeat genuine header rows, and keep content away from borders. Inspect wrapping, clipping, row splits, alignment, and page width after rendering.

Use local images, preserve aspect ratio, and size them within the text area. Keep captions adjacent and add meaningful alternative text when accessibility matters. Temporary source images are not deliverables; verify they are embedded in the DOCX.

## Existing documents

Render the source before layout-sensitive edits. Treat page geometry, styles, sections, recurring content, and tables as evidence. Prefer localized edits of a copy over package reconstruction.

Do not promise full preservation for signatures, embedded objects, SmartArt, complex content controls, custom XML mappings, or uncommon fields without inspecting those features.
