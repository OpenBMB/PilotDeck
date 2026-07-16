# Creating PDFs

Read this before generating a new PDF or substantially redesigning one.

## Builder contract

- Start with `pdf.sh scaffold` and maintain one executable Python builder for the task.
- The builder must accept `--out <path>`, create parent directories, work offline, and exit nonzero on failure.
- Keep source data and calculations outside drawing callbacks when possible. Make the content model easy to inspect and revise.
- Use ReportLab for generation. Use `SimpleDocTemplate` and flowables for ordinary reports; use canvas-level drawing only when exact placement is genuinely required.

## Page and type system

- Choose page size, margins, type scale, line spacing, colors, table styles, and spacing before adding content.
- Register fonts explicitly. Confirm that the selected font contains every required glyph, especially for Chinese, Japanese, Korean, symbols, and emoji.
- Prefer a project-provided font. If none exists, search common system font locations and provide a safe fallback. Never download a font during the build.
- Keep body text readable at the final page size. Avoid shrinking text merely to force content onto a page.
- Use deterministic header/footer callbacks for titles, dates, confidentiality labels, and page numbers.

## Tables and images

- Specify column widths rather than relying on accidental auto-sizing.
- Repeat table headers across pages and allow rows to split only when the result remains readable.
- Use paragraphs inside table cells for wrapping and consistent typography.
- Preserve image aspect ratios. Crop intentionally; do not stretch.
- Use sufficient source resolution for the rendered output. A visually soft image is a defect even when the PDF is structurally valid.

## Iteration

1. Build the PDF.
2. Run `audit`.
3. Render all pages at 144 DPI or higher.
4. Inspect every page PNG at full size.
5. Patch the same builder and repeat until the QA checklist passes.
