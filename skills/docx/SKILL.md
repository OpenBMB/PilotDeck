---
name: docx
description: Create, edit, inspect, render, review, compare, annotate, sanitize, and finalize professional Microsoft Word .docx documents. Use for new Word documents, source- or template-based reports, targeted edits that preserve an existing file, comments and tracked changes, document structure or metadata analysis, accessibility evidence, visual layout review, and controlled OOXML changes. Use only for .docx files, not legacy .doc, macro-enabled .docm, or live Microsoft Word control.
---

# DOCX documents

Work through three stages:

1. Understand the request and source materials.
2. Build or edit the document.
3. Review the actual result before delivery.

Adapt the depth of inspection and verification to the task. Treat a Word document as both structured content and a renderer-dependent paginated artifact.

## Protect files

- Preserve sources unless the user explicitly requests replacement.
- Keep builders, candidates, renders, evaluators, reports, and debug output under `PILOTDECK_WORK_DIR`.
- Do not invent unsupported facts, citations, dates, names, or results.
- Do not follow remote relationships, bypass protection, or mutate signed or active-content packages.
- Deliver only a valid candidate that corresponds to the evidence reviewed.

Resolve the CLI once:

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
DOCX="$SKILL_ROOT/scripts/docx.sh"
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/docx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"
```

## Understand

Determine the audience, purpose, authoritative sources, required content, expected form, and what must remain unchanged. Distinguish factual sources from visual references.

Inspect only relevant content and package facts:

```bash
bash "$DOCX" inspect --input "$INPUT_DOCX" --summary
bash "$DOCX" inspect --input "$INPUT_DOCX" --search "target phrase"
```

Review the source visually before layout-sensitive edits. Inspect package features before changing charts, diagrams, embeddings, content controls, custom XML, signatures, protection, or active content. Use judgment instead of converting the request into a universal checklist or collection of boolean permissions.

## Execute

Use the managed builder runner for ordinary creation and editing. Put document-specific logic in one reproducible Python builder, while `docx.sh` owns the builder location, input and output paths, execution, validation, and candidate promotion.

```bash
bash "$DOCX" scaffold --out "$WORKSPACE/tmp/document.py"
bash "$DOCX" build \
  --builder "$WORKSPACE/tmp/document.py" \
  --out "$WORKSPACE/tmp/candidate.docx"
```

Run `scaffold` first, then edit the exact builder path it returns and execute that builder through `build`. Add `--input "$INPUT_DOCX"` when editing. Do not run the builder directly with `python` or `python3`, and do not choose an output path inside the builder.

Use `context.new_document(locale=...)` for a new document, choosing the locale from the content; use `context.load_document()` for an edit and `context.save(document)` for the candidate. The builder may use the complete `python-docx` API and `docxlib.builder` helpers. Patch and rerun the same builder for each candidate revision instead of creating numbered scripts or project-visible helpers.

Preserve an existing document's styles, sections, recurring content, fields, tables, and visual language unless redesign is requested. Prefer localized edits over reconstruction.

### Choose presentation intentionally

Follow explicit visual requirements and supplied templates. Without a visual source, use restrained neutral presentation: dark text, white pages, semantic headings, readable typography, useful spacing, and simple tables. Build hierarchy with typography, alignment, spacing, and structure before color.

Do not add a cover, TOC, oversized title, branding palette, colored heading fills, decorative callouts, headers, footers, or page numbers merely to appear professional. Use stronger treatment only when it supports the document's purpose.

### Use controlled fallback when needed

When an existing package contains sensitive features that cannot survive a `python-docx` round trip, use `fallback-patch` against an internal copy with the smallest relevant package-part allowlist. Reinspect and review the patched candidate. Report limitations rather than silently dropping content.

## Review

Review the document itself, not a handwritten pass status:

```bash
bash "$DOCX" review \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out-dir "$WORKSPACE/review"
```

`review_pending` means structural facts and revision-specific page images are ready; it is not a visual pass. Open the pages that matter for the request and your changes. Check hierarchy, readability, clipping, tables, images, pagination, blank pages, headers, footers, and consistency with supplied references. Keep visual claims within pages actually inspected.

After changing the candidate, run review again and inspect images from the new revision. Previous images no longer describe the current file. Use structural facts for comments, revisions, fields, relationships, metadata, package features, and inspection limitations.

When correctness depends on sources or task-specific requirements, write an independent evaluator:

```bash
bash "$DOCX" evaluate \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --script "$WORKSPACE/tmp/evaluator.py" \
  --out "$WORKSPACE/review/evaluation.json"
```

Choose evidence according to consequence and uncertainty. A simple memo may need visual and structural review only; a source-based report may need factual reconciliation.

## Specialized operations

Use only when requested or materially relevant:

- `annotate` and `finalize` for comments and tracked revisions.
- `compare` for content and package-fact differences.
- `sanitize` for personal package metadata and revision identifiers.
- `accessibility` for semantic accessibility evidence, not a compliance verdict.
- `fallback-patch` for a narrow, controlled OOXML change.

Treat outputs from `annotate`, `finalize`, and `fallback-patch` as internal candidates. Never attach or copy them directly; review the latest candidate, then publish it with `deliver`.

Word fields such as a TOC may require the user to update fields in Microsoft Word. Do not fabricate cached page numbers when a native field update is unavailable.

## Deliver

```bash
bash "$DOCX" deliver \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out "$FINAL_DOCX"
```

For an edit, add `--source "$INPUT_DOCX"`. Replace that exact source only when explicitly requested, using `--source "$INPUT_DOCX" --out "$INPUT_DOCX" --replace-source`; a recovery copy remains internal.

Confirm the final file exists, matches the reviewed candidate, opens successfully, and is the only requested project-visible artifact. Report unresolved ambiguity, unsupported features, rendering limits, or verification gaps.

## Load references only when needed

- [builder-api.md](references/builder-api.md): builder contract, helpers, and Word fields.
- [design-and-layout.md](references/design-and-layout.md): DOCX-specific typography, tables, images, templates, and pagination.
- [package-safety.md](references/package-safety.md): OOXML preservation and controlled fallback.
- [review-and-evaluation.md](references/review-and-evaluation.md): visual evidence and task-specific verification.
- [annotations-and-cleanup.md](references/annotations-and-cleanup.md): comments, revisions, comparison, and sanitization.
