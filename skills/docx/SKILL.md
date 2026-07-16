---
name: docx
description: Create, inspect, edit, restyle, review, compare, sanitize, render, audit, and finalize professional Microsoft Word .docx documents. Use this skill whenever PilotDeck must produce or modify a Word document, preserve an existing document while making targeted changes, add comments or tracked replacements, analyze document structure or metadata, verify accessibility and layout quality, compare revisions, remove review data, or deliver a visually checked DOCX. Use only for .docx files, not legacy .doc, macro-enabled .docm, or Google Docs operations.
---

# Professional Word DOCX

Treat a Word document as both structured content and a paginated visual artifact. Use the bundled CLI for deterministic package operations, follow the task-specific guidance below, and do not deliver a mutated DOCX until the latest structural and visual checks pass.

## Resolve and invoke the skill

Resolve the directory containing this `SKILL.md` as `DOCX_SKILL_ROOT`. Common locations are:

```bash
DOCX_SKILL_ROOT="${PILOT_HOME:-$HOME/.pilotdeck}/skills/docx"
# In a source checkout: <repo>/skills/docx
```

Invoke all deterministic operations through:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" <command> [options]
```

Keep source documents, JSON specifications, rendered pages, and deliverables in the user's workspace or a task-specific temporary directory. Do not write task artifacts into the skill directory.

## Route the request

| User intent | Primary command | Read first |
|---|---|---|
| Read, summarize, or inspect a DOCX | `inspect` | [workflows.md](references/workflows.md) |
| Create a new document or substantially redesign one | `create` | [design-and-layout.md](references/design-and-layout.md), then [specifications.md](references/specifications.md) |
| Make targeted edits while preserving the source | `edit` | [workflows.md](references/workflows.md), then [specifications.md](references/specifications.md) |
| Add reviewer comments or tracked replacements | `review` | [ooxml-and-safety.md](references/ooxml-and-safety.md), then [specifications.md](references/specifications.md) |
| Accept/reject changes or strip comments | `finalize` | [workflows.md](references/workflows.md) |
| Compare two document versions | `compare` | [workflows.md](references/workflows.md) |
| Remove personal metadata and revision identifiers | `sanitize` | [ooxml-and-safety.md](references/ooxml-and-safety.md) |
| Check package integrity | `validate` | This file |
| Audit styles, hierarchy, tables, accessibility, or finalization | `audit` | [design-and-layout.md](references/design-and-layout.md) |
| Convert every page to PNG for visual QA | `render` | [workflows.md](references/workflows.md) |

## Non-negotiable operating contract

1. Run `check` before the first DOCX task in a session. Run `fix` only if dependencies are missing and installing them is allowed.
2. Validate and inspect every existing input before changing it. Read the relevant inspection fields, not only extracted paragraph text.
3. Plan the document form before creation or major restructuring. Select one design preset and one coherent hierarchy.
4. Apply the smallest change that satisfies an edit request. Preserve the original file and write every mutation to a new `.docx` path unless overwrite is explicitly requested.
5. Run `validate` after every mutation. Run `audit --profile draft` during iteration and `audit --profile final` before delivery. Use `accessible` when accessibility matters.
6. Render after every meaningful layout-affecting change. Inspect every generated `page-<N>.png` at full-page scale and zoom into dense areas such as tables, forms, headers, and footers.
7. Fix defects, then repeat validation, audit, rendering, and inspection. Deliver only the latest document that passed the checks.
8. Return only requested deliverables. Keep inspection JSON, diff JSON, PNG pages, and optional PDFs as internal QA artifacts unless the user requests them.

## Prepare the environment

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" check
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fix
```

`fix` creates an isolated Python environment in the user's cache directory and never installs packages globally. LibreOffice is detected but not installed automatically.

If LibreOffice is unavailable, complete structural validation and auditing, disclose that page-image QA could not be performed, and avoid claiming that layout was visually verified. If rendering fails for another reason, diagnose and correct the render environment before delivery.

## Inspect before reasoning or editing

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input input.docx --out inspection.json
```

Review at least:

- metadata and personal fields;
- paragraph text, styles, run formatting, and locations;
- heading order and hierarchy;
- tables and cell content;
- sections, page dimensions, orientation, and margins;
- headers and footers;
- comments and tracked-change counts;
- fields, images, external relationships, and validation warnings.

For read-only questions, do not edit or re-export the source. Preserve qualifiers from headings, table labels, notes, and nearby context when answering.

## Create new documents deliberately

Before writing the JSON specification:

1. Identify the document archetype: brief, memo, report, proposal, SOP, reference guide, form, or simple document.
2. Choose one supported preset and define page geometry, hierarchy, content forms, tables, images, headers, and footers.
3. Read [design-and-layout.md](references/design-and-layout.md). Map each major information unit to prose, a list, steps, a checklist, a callout, a definition list, a real data table, an image, or sources.
4. Read [specifications.md](references/specifications.md) and create a specification using only supported blocks.
5. Generate, validate, audit, render, inspect, and iterate.

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" create \
  --spec document.json --out document.docx
```

Do not rely on Word defaults for page geometry, heading hierarchy, list semantics, table widths, or cell padding. Prefer reusable Word styles and real list definitions over manually formatted lookalikes.

## Edit existing documents surgically

Use `edit` for supported local changes:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" edit \
  --input original.docx --patch edits.json --out revised.docx
```

Preserve structure and formatting unless the user requests redesign. Prefer inline replacement over paragraph replacement, and paragraph replacement over full-document reconstruction. Confirm that every requested operation reports a nonzero `affected` count; treat an unexpected zero as a failed edit.

Use comments or tracked replacements when the user requests reviewable changes. Do not silently turn a review task into a clean rewrite.

## Manage the review lifecycle

Add comments and tracked replacements:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" review \
  --input draft.docx --spec review.json --out reviewed.docx
```

Finalize a reviewed document:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" finalize \
  --input reviewed.docx --accept-changes --remove-comments --out final.docx
```

Use `--reject-changes` instead of `--accept-changes` when requested. Never pass both. Inspect after review and after finalization because page rendering does not reliably expose comment anchors.

## Validate and audit

Validate the ZIP package, required OOXML parts, XML well-formedness, archive safety, and macro absence:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" validate --input output.docx
```

Audit semantic and layout risks:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input output.docx --profile draft --out audit.json

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input final.docx --profile final --out final-audit.json

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input accessible.docx --profile accessible --out a11y-audit.json
```

Interpret profiles as follows:

- `draft`: flag hierarchy, fake lists, small text, unstable table geometry, narrow margins, and formatting drift.
- `final`: include draft checks and fail the audit when comments or tracked changes remain; warn about personal metadata.
- `accessible`: include final checks and flag missing image alternative text or unmarked repeating table headers.

An audit can contain warnings even when `passed` is true. Evaluate each warning in context and resolve every material issue before delivery.

## Render and inspect every page

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" render \
  --input final.docx --out-dir rendered --emit-pdf
```

Inspect every PNG for:

- clipped, overlapping, missing, or substituted text;
- broken glyphs and inappropriate font fallback;
- headings stranded at page bottoms;
- awkward blank pages or large unexplained gaps;
- lists with incorrect wrapping or indentation;
- table overflow, narrow narrative columns, cramped cells, lost headers, or split rows;
- images outside margins, distorted scaling, or separated captions;
- inconsistent section geometry;
- misplaced headers, footers, and page breaks.

Rendering verifies visible layout but not all document semantics. Verify comments, revisions, relationships, fields, and metadata structurally with `inspect`, `audit`, or OOXML-aware commands.

## Compare and sanitize

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" compare \
  --before old.docx --after new.docx --out comparison.json

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" sanitize \
  --input reviewed.docx --out clean.docx --remove-comments
```

`compare` reports paragraph-level textual differences and document counts; it is not a pixel diff and does not prove formatting equivalence. `sanitize` removes core personal metadata, custom properties, revision identifiers, and optionally comments; it does not redact sensitive words from visible document content.

## Safety and fidelity rules

- Accept `.docx` only. Reject `.doc`, `.docm`, `.dotm`, and unrelated ZIP archives.
- Reject unsafe archive paths, malformed XML, macro payloads, and suspiciously expanded packages.
- Never fetch remote images. Use local workspace files only.
- Preserve the source and avoid destructive overwrite by default.
- Do not claim that comments were visually verified from rendered pages.
- Do not claim full fidelity for digital signatures, embedded objects, complex content controls, or custom XML without explicit inspection. Read [ooxml-and-safety.md](references/ooxml-and-safety.md) before touching package-sensitive documents.
- Keep citations and sources as ordinary human-readable document text. Never expose internal tool tokens, private paths, credentials, or hidden reasoning in the document.
- Do not present generated facts as sourced. Preserve existing citations and clearly distinguish supplied facts from drafted language.

## Delivery gate

Before returning a DOCX, confirm all of the following:

- the requested content and edits are complete;
- the output is a new, valid `.docx` file;
- the final audit has no unresolved errors;
- every rendered page from the latest document was inspected, or missing LibreOffice was disclosed;
- comments and revisions match the requested delivery state;
- metadata and privacy state match the request;
- only the final requested artifact is linked in the response.

Run the bundled end-to-end regression when changing this skill itself:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" self-test
```
