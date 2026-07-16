---
name: pdf
description: Read, create, edit, merge, split, rotate, fill, render, and verify workspace PDF files. Use whenever the requested input or deliverable is a .pdf, including extracting text or tables, inspecting metadata and page geometry, generating a new PDF, rearranging pages, filling AcroForm fields, or checking visual layout. Do not use for Google Drive or browser-only PDF workflows.
---

# PDF

Work with PDFs through the bundled `pdf.sh` workflow. Treat structure extraction and visual rendering as complementary: parsed text is evidence about content, while rendered pages are the evidence for layout.

## Hard requirements

- Preserve every input PDF. Write edits to a distinct output unless the user explicitly requests replacement.
- Use `pdfplumber` for text, table, image, and coordinate-aware inspection; use `pypdf` for page structure, metadata, page operations, and AcroForms; use ReportLab for new PDFs.
- Inspect an existing PDF before changing it. Render it first when layout, page order, form appearance, or visual fidelity matters.
- Create a new PDF from one executable Python builder. Patch and rerun the same builder rather than accumulating one-off scripts.
- Never assume successful text extraction proves that a PDF looks correct.
- Run `audit`, render every final page with Poppler, and inspect every page PNG at full size before delivery. A montage is only an overview.
- Fix clipped or overlapping content, missing glyphs, broken tables, incorrect page order, bad image crops, inconsistent page sizes, and wrong page numbers before delivery.
- Do not depend on Codex-private runtime paths or install Python packages globally.

## Read the relevant references

- Read [creation.md](references/creation.md) before creating or visually redesigning a PDF.
- Read [structure-and-forms.md](references/structure-and-forms.md) before merging, splitting, rotating, editing metadata, or handling forms.
- Read [qa-checklist.md](references/qa-checklist.md) before delivery.

## Prepare the runtime

Resolve the directory containing this file as `PDF_SKILL_ROOT`, then run:

```bash
PDF_TOOL="$PDF_SKILL_ROOT/scripts/pdf.sh"
bash "$PDF_TOOL" check || bash "$PDF_TOOL" fix
```

`fix` creates an isolated Python environment under `${PDF_SKILL_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/pilotdeck-pdf}`. Poppler is a system dependency; if `pdfinfo` or `pdftoppm` is missing, follow the platform-specific hint printed by `fix`.

Use a task-specific scratch directory outside the skill:

```bash
WORKSPACE="${TMPDIR:-/tmp}/pilotdeck-pdf/${CODEX_THREAD_ID:-manual}/<task-slug>"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

Keep builders, extracted content, inspections, renders, and QA reports in `WORKSPACE`. Put only requested deliverables in the project or user-selected output directory.

## Route the request

Choose one route:

1. Read-only question: inspect or extract only; do not export a modified PDF.
2. New PDF: scaffold one builder, build, audit, render, inspect, and iterate.
3. Existing PDF structural edit: inspect and render first, make the smallest page-level change, then audit and render again.
4. AcroForm task: inspect fields, fill a distinct output, render every affected page, and verify appearances.

Scanned/image-only PDFs may contain no machine-readable text. Do not call that an extraction failure if rendered pages are valid. OCR is not bundled; disclose the limitation or use a separately available OCR workflow when the user requests it.

## Inspect or extract

Create a compact structural and content overview:

```bash
bash "$PDF_TOOL" inspect \
  --input "$INPUT_PDF" \
  --out "$WORKSPACE/tmp/inspection.json"
```

Extract full page text and detected tables when needed:

```bash
bash "$PDF_TOOL" inspect \
  --input "$INPUT_PDF" \
  --out "$WORKSPACE/tmp/inspection.json" \
  --text-out "$WORKSPACE/tmp/text.json" \
  --tables-out "$WORKSPACE/tmp/tables.json"
```

Do not load a large extraction wholesale when page-level inspection or targeted searching is enough.

## Create a PDF

Scaffold one builder and edit it for the task:

```bash
bash "$PDF_TOOL" scaffold --out "$WORKSPACE/tmp/build_pdf.py"
bash "$PDF_TOOL" build \
  --builder "$WORKSPACE/tmp/build_pdf.py" \
  --out "$FINAL_PDF"
```

The builder must accept `--out <path>`, work offline, embed or register fonts explicitly, and keep page numbering deterministic. Follow [creation.md](references/creation.md).

## Perform structural operations

```bash
bash "$PDF_TOOL" merge --inputs first.pdf second.pdf --out merged.pdf
bash "$PDF_TOOL" split --input source.pdf --out-dir "$WORKSPACE/tmp/pages" --pages "1-3,7"
bash "$PDF_TOOL" rotate --input source.pdf --out rotated.pdf --degrees 90 --pages "2,4-5"
```

For forms:

```bash
bash "$PDF_TOOL" forms-inspect --input form.pdf --out "$WORKSPACE/tmp/fields.json"
bash "$PDF_TOOL" forms-fill \
  --input form.pdf \
  --data "$WORKSPACE/tmp/values.json" \
  --out filled.pdf
```

These operations preserve the source and do not reflow page content. See [structure-and-forms.md](references/structure-and-forms.md).

## Validate and render

Run the final structural audit:

```bash
bash "$PDF_TOOL" audit \
  --input "$FINAL_PDF" \
  --out "$WORKSPACE/qa/audit.json"
```

Render every page and optionally create an overview montage:

```bash
bash "$PDF_TOOL" render \
  --input "$FINAL_PDF" \
  --out-dir "$WORKSPACE/qa/render" \
  --dpi 144 \
  --montage "$WORKSPACE/qa/montage.png"
```

Inspect every `page-*.png` at full resolution. Revise the builder or edit, then rerun audit and render until hard failures are gone and every warning is understood.

After changing this skill or its runtime, run:

```bash
bash "$PDF_TOOL" self-test --out "$WORKSPACE/self-test"
```

## Deliver

Return the final PDF and a concise summary. Mention deliberate limitations such as image-only pages, unsupported dynamic forms, signatures, or preserved source defects. Do not deliver builders, extracted text, JSON reports, renders, runtime files, or scratch artifacts unless requested.
