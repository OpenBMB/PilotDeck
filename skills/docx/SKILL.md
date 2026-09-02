---
name: docx
description: Create, edit, inspect, review, and finalize Microsoft Word .docx documents. Use for new Word documents, source- or template-based reports, precise edits that should preserve an existing file, visual or structural review, comments and tracked changes, and final DOCX delivery. Use only for .docx files, not legacy .doc, macro-enabled .docm, or live Microsoft Word control.
---

# DOCX documents

Use three stages as a reasoning framework, not a fixed tool pipeline:

1. Understand the request and source materials.
2. Build or edit the document using the approach best suited to the task.
3. Review the actual result before delivery.

The user's explicit requirements are the primary acceptance criteria. Adapt the depth of inspection, implementation, and review to the task rather than following a universal checklist.

## Understand

Determine the audience, purpose, authoritative sources, required content, expected form, and what must remain unchanged. Distinguish factual sources from templates and visual references.

- Preserve source files unless replacement is explicitly requested.
- Do not invent unsupported facts, citations, dates, names, figures, or conclusions.
- When editing, preserve content, structure, and formatting the user did not ask to change.
- Inspect only the material relevant to the requested outcome. For complex sources, use direct Python, `python-docx`, ZIP/XML inspection, or the optional `inspect` command as useful.

Resolve the optional CLI once when its evidence or delivery commands help:

```bash
SKILL_ROOT={{SKILL_ROOT_SHELL}}
DOCX="$SKILL_ROOT/scripts/docx.sh"
WORKSPACE="${PILOTDECK_WORK_DIR:?PILOTDECK_WORK_DIR is required}/docx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/review"
```

```bash
bash "$DOCX" inspect --input "$INPUT_DOCX" --summary
bash "$DOCX" inspect --input "$INPUT_DOCX" --search "target phrase"
```

## Build

Write and run task-specific Python directly. Use the complete `python-docx` API, `lxml`, direct OOXML editing, or another suitable library according to the document and requested change. Choose the script structure and implementation route that make the current task simplest and most reliable.

Keep task scripts, candidates, extracted media, reports, renders, and debugging output under `PILOTDECK_WORK_DIR`. Put only the requested final deliverable in the project workspace.

Prefer localized edits to reconstruction when modifying an existing document. Inspect package-sensitive features before round-tripping charts, diagrams, embedded objects, content controls, custom XML, signatures, protection, or uncommon fields. Choose a preservation strategy based on the actual document and report limitations honestly.

Follow supplied templates and explicit visual requirements. Without either, use restrained neutral presentation: readable typography, semantic headings, useful spacing, simple tables, dark text, and white pages. Do not add decorative covers, oversized titles, branding colors, heading fills, headers, footers, a TOC, or page numbers merely to appear professional.

For Word-specific behavior such as fields, revisions, comments, pagination, and renderer differences, read [word-specifics.md](references/word-specifics.md) only when relevant.

### Deployment-managed fonts

Fonts are installed by deployment operations, never copied into this Skill or a generated document package. A mounted font is available to the document tools but is not an automatic typography choice.

- If the user or a supplied template requires a named font, verify it before creating or rendering the document: `fc-match "$FONT_NAME"`.
- Use the actual installed family name reported by `fc-match` or `fc-scan`; configure it explicitly in the DOCX, including the East Asian (`w:eastAsia`) font setting for Chinese text when applicable.
- Do not silently replace a requested named font with a generic system font. If it is unavailable, report that fact and ask the user for a replacement or a corrected deployment.
- A document-wide font policy, such as the title/body/heading mapping for Chinese official documents, must come from the user or a supplied template. Do not invent one.

## Review

Judge the document against the user's requested outcome, not whether a tool ran successfully. Choose evidence according to consequence and uncertainty:

- reread or extract final content;
- reconcile facts and figures with authoritative sources;
- compare a targeted edit with its source;
- inspect fields, comments, revisions, relationships, or package structure;
- render pages and visually inspect the pages material to the request.

The optional CLI provides facts and images, never a content-quality verdict:

```bash
bash "$DOCX" validate --input "$WORKSPACE/tmp/candidate.docx"
bash "$DOCX" render \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out-dir "$WORKSPACE/review/latest"
```

Open relevant full-size page images before making visual claims. After changing the candidate, prior images no longer describe the current document; render the new candidate if visual evidence still matters. LibreOffice rendering can reveal layout defects but may paginate or substitute fonts differently from Microsoft Word.

For a simple task, direct inspection may be enough. When correctness depends on data or sources, write a small task-specific checking script directly when it materially improves confidence.

## Deliver

Publish the reviewed internal candidate through the delivery command:

```bash
bash "$DOCX" deliver \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out "$FINAL_DOCX"
```

For an edit, add `--source "$INPUT_DOCX"`. Replace that exact source only when explicitly requested, using `--source "$INPUT_DOCX" --out "$INPUT_DOCX" --replace-source`; a recovery copy remains internal.

`deliver` checks package validity, protects the source, and publishes the final file. It does not decide whether the prose, facts, design, or requested outcome are good enough; that judgment belongs to the model's review.

Use advanced mechanical commands such as `compare`, `annotate`, `finalize`, and `sanitize` only when they directly serve the request. See [optional-tools.md](references/optional-tools.md) when one is needed.
