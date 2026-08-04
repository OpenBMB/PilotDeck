---
name: docx
description: Create, inspect, edit, review, compare, sanitize, render, audit, preflight, and finalize professional Microsoft Word .docx documents through an explicit capability, execution, controlled-fallback, and acceptance protocol. Use whenever PilotDeck must produce or modify a Word document, preserve an existing document while making targeted changes, add comments or tracked replacements, analyze structure or metadata, verify accessibility and layout quality, compare revisions, remove review data, or deliver a visually checked DOCX. Use only for .docx files, not legacy .doc, macro-enabled .docm, or Google Docs operations.
---

# Professional Word DOCX

Treat a Word document as both structured content and a paginated visual artifact. The bundled CLI is the authority for what the skill can do. Never infer missing capability from examples, silently ignore unsupported fields, or bypass the CLI with an ad hoc Python program. Use the controlled fallback protocol when the declared operation is insufficient. Do not deliver a mutated DOCX until structural, rendered-text, warning-disposition, and visual-review gates pass.

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

Use the turn-scoped PilotDeck work directory for every intermediate. The host
sets `PILOTDECK_WORK_DIR`. For a manual run, explicitly export a unique
project-internal directory before invoking any modifying command:

```bash
export PILOTDECK_WORK_DIR="${PILOTDECK_WORK_DIR:-$PWD/.pilotdeck/work/manual/<task-slug>}"
WORKSPACE="$PILOTDECK_WORK_DIR/docx"
mkdir -p "$WORKSPACE/tmp" "$WORKSPACE/qa"
```

`prepare`, `qa-init`, `qa-record`, and `qa-finalize` require this environment
variable and never search for another session or turn directory. The CLI
enforces this boundary whenever `PILOTDECK_WORK_DIR` is set. Create,
edit, and review specifications; fallback scripts and manifests; inspections,
audits, acceptance, dispositions, renders, visual reviews, preflight reports,
and DOCX candidates are internal. Only `deliver --out` may create the one
project-visible final DOCX. Never put helper code in the PilotDeck source tree
or another workspace.

Keep JSON specifications, inspections, comparisons, rendered pages, optional QA PDFs, and temporary candidates in `WORKSPACE`. Keep source documents in place and put only requested final DOCX deliverables in the project or user-selected output directory. Never create inspection JSON, render directories, or other intermediates beside the user's files. Do not write task artifacts into the skill directory.

## Route the request

| User intent | Primary command | Read first |
|---|---|---|
| Discover exact support or JSON fields | `capabilities`, `schema` | [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md) |
| Freeze acceptance and obtain canonical internal paths | `prepare` | This file |
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
| Populate a live TOC with visible entries and page numbers | `refresh-toc` | [workflows.md](references/workflows.md) |
| Initialize, record, and complete visual QA | `qa-init`, `qa-record`, `qa-finalize` | [workflows.md](references/workflows.md) |
| Run a lower-level diagnostic gate | `preflight` | [workflows.md](references/workflows.md) |
| Promote exactly one passed candidate to the requested final path | `deliver` | [workflows.md](references/workflows.md) |
| Resolve an original or prior path to the latest delivered session version | `resolve-latest` | [workflows.md](references/workflows.md) |
| Perform an operation outside the standard schema | `fallback-patch` or `fallback-create` | [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md), then [ooxml-and-safety.md](references/ooxml-and-safety.md) |

## Non-negotiable operating contract

1. Run `check`, then `capabilities`, before the first DOCX operation in a session. For a modifying request, run `prepare` before the first mutation to create canonical turn paths and freeze acceptance. Run `fix` only if dependencies are missing and installation is allowed.
2. Run `schema --command <create|edit|review>` before writing a JSON specification. Unknown fields and operations are errors; never assume they were applied.
3. Validate and inspect every existing input before changing it. Read package features and inspection coverage, not only extracted paragraph text. Never bypass declared document/write protection.
4. If the operation is declared supported, use the bundled command first. Do not replace it with `python-docx`, direct ZIP/XML mutation, or another library.
5. If the standard operation returns `partial`, `unsupported`, or `blocked`, stop and follow the decision ladder in [capabilities-and-fallbacks.md](references/capabilities-and-fallbacks.md). Never turn those statuses into success.
6. Every fallback must be explicit: state the unmet capability and reason, keep its program under `WORKSPACE/tmp`, execute `fallback-patch` or `fallback-create`, and retain the generated manifest in `WORKSPACE/qa`.
7. Before modifying an existing document, run `resolve-latest --input <user-referenced-path>` and use its `resolved` path as the editing base. The standard mutation commands also resolve tracked inputs defensively. Use `--use-exact-input` only when the current user request explicitly asks to restart from an older/original version.
8. Apply the smallest change that satisfies an edit request. Preserve the original and write every mutation to a new internal candidate below `PILOTDECK_WORK_DIR`. Never write numbered drafts, sanitized copies, fallback candidates, or other DOCX intermediates into the project root. Existing candidate paths are blocked by default; `fallback-create` never overwrites.
9. Use `qa-init`, one `qa-record` call immediately after inspecting each current page image, and `qa-finalize`. Do not handwrite review JSON, guess a work path, or hash PNG files yourself. Every warning must be fixed or assigned a concrete disposition. A failed or undocumented visual review is blocking and cannot be dispositioned.
10. Use `deliver` once, after preflight passes, to promote the exact SHA-256-bound candidate to the requested final path. Declare `--new-document` for creation or `--source` for a derived version. A new document must use a nonexistent final path; `--new-document --overwrite` is blocked. Existing-document work defaults to a new final filename. `--overwrite` alone never permits source replacement.
11. Replace the source only when the current user request explicitly says to overwrite that exact file. In that case, and only then, pass `--source <path> --out <same-path> --replace-source`; the command retains a hidden recovery copy and updates the version chain. Past consent or a generic preference is insufficient.
12. Return only requested deliverables. Keep specifications, candidates, manifests, audits, PNG pages, optional PDFs, hidden recovery copies, and other intermediates internal unless requested. Mention the final filename naturally; PilotDeck renders the file card. Do not add a Markdown download/view link unless the user explicitly asks for one.

## Capability and result protocol

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" capabilities
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
```

All operation results use one of:

- `ok`: the requested operation completed within its declared fidelity.
- `partial`: output or inspection exists, but an unresolved target, warning, coverage gap, or review remains.
- `unsupported`: the requested capability is outside the standard operation; choose an approved fallback or report it.
- `blocked`: continuing would risk fidelity, signatures, protection, package scope, or safety.
- `error`: invalid input, invalid specification, execution failure, or invalid output.

Only `ok` is success. Do not use `|| true`, discard stderr, parse a failed result as a deliverable, or claim completion from the existence of a file.

## Prepare the environment

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" check
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fix
```

`fix` creates an isolated Python environment in the user's cache directory and never installs packages globally. LibreOffice is detected but not installed automatically.

If LibreOffice is unavailable, `render` and `preflight` report `unsupported`; complete structural validation and auditing, disclose that visual QA was not completed, and do not claim delivery passed the full gate. If rendering fails for another reason, diagnose the environment before delivery.

## Inspect before reasoning or editing

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "$INPUT_DOCX" --summary --out "$WORKSPACE/tmp/inspection-summary.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" inspect \
  --input "$INPUT_DOCX" --search "target phrase" --max-items 50 \
  --out "$WORKSPACE/tmp/inspection-target.json"
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

`inspect` returns `partial` when it can inventory a package feature but cannot
interpret its complete reading order or behavior, such as text boxes, notes,
Office Math, SmartArt/diagrams, chart semantics, content controls, embedded
objects, protected-document behavior, or nonstandard custom XML.
Continue only within the explicitly covered scope; never describe a partial
inspection as a complete reading of the document.

For read-only questions, do not edit or re-export the source. Preserve qualifiers from headings, table labels, notes, and nearby context when answering.

## Create new documents deliberately

Before writing the JSON specification:

1. Identify the document archetype: brief, memo, report, proposal, SOP, reference guide, form, or simple document.
2. Freeze exactly one style path during `prepare`:
   - `--style-mode user` only when the user supplied concrete visual
     requirements, a reference template, or an existing DOCX whose style must
     be preserved. Record the matching `--style-source` and any explicit
     `--style-requirement`.
   - `--style-mode builtin` for every other creation request. Words such as
     “report”, “professional”, “formal”, “business”, or “polished” are document
     goals, not permission to invent a color theme.
   The built-in `neutral-document-v1` template is the only default: black
   titles and headings, white tables with neutral lines, restrained callouts,
   and locale-aware Chinese/Latin typography.
3. Read [design-and-layout.md](references/design-and-layout.md). Map each major information unit to prose, a list, steps, a checklist, a callout, a definition list, a real data table, an image, or sources.
   If the user requests illustrations, figures, diagrams, or charts, treat
   image presence as an acceptance requirement. Generate local assets below
   the returned `tmp` path and use standard image blocks; do not merely create
   images that never enter the DOCX.
4. Choose `--document-structure formal-report` when the deliverable requires a
   cover, TOC, and body. That structure owns the page boundaries: cover page,
   TOC on a new page, and body on another new page. Use `simple` for briefs,
   memos, forms, and documents without that three-part structure.
5. Query `schema --command create`, read [specifications.md](references/specifications.md), and create a specification using only supported blocks. Copy the frozen `document_structure` into the specification.
6. Run standard `create`. If the schema cannot express a required feature, follow the controlled fallback decision before writing custom code.
7. Generate, inspect, compare when relevant, and run preflight.

For a new document, omit `header`, `footer`, `PAGE`, and `NUMPAGES` unless the
current user explicitly requested them. `prepare` denies all three by default;
the create and preflight gates enforce the frozen decision.

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" create \
  --spec "$WORKSPACE/tmp/document.json" \
  --acceptance "$WORKSPACE/qa/acceptance.json" \
  --out "$WORKSPACE/tmp/candidate.docx"
```

Do not rely on Word defaults for page geometry, title line height, heading hierarchy, list semantics, table widths, or cell padding. Prefer reusable Word styles and real list definitions over manually formatted lookalikes. A chart may be generated as a local image and referenced by an image block without entering full-create fallback. When the user asks for one or more figures, freeze `--min-images` so a text-only candidate cannot pass.

The create specification's `style_policy` must exactly match the frozen
acceptance manifest. Built-in mode rejects style overrides, per-run colors or
sizes, paragraph style substitutions, callout colors, and table style/color
overrides. User mode may express only the concrete style the user supplied.
Do not switch modes after seeing a draft.

If a candidate path already exists, use another path below `WORKSPACE/tmp` or intentionally replace that internal candidate. Do not create versioned candidates in the project root.

Automatic field updates on open are disabled by default. Do not set
`update_fields_on_open: true` merely to populate a TOC or page fields; it can
make Word show an external-field warning. Use `refresh-toc` to cache visible
TOC entries without an opening prompt.

## Edit existing documents surgically

Resolve the editing base first, even when the user or conversation still names
the initially uploaded path:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" resolve-latest \
  --input "$REQUESTED_INPUT_DOCX"

# Set INPUT_DOCX to the returned `resolved` path.
```

Use `edit` for supported local changes:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" edit \
  --input "$INPUT_DOCX" \
  --patch "$WORKSPACE/tmp/edits.json" \
  --acceptance "$WORKSPACE/qa/acceptance.json" \
  --out "$WORKSPACE/tmp/candidate.docx"
```

Preserve structure and formatting unless the user requests redesign. Prefer inline replacement over paragraph replacement, and paragraph replacement over full-document reconstruction. Use standard `insert_image` to place a local figure before or after an unambiguous paragraph anchor; do not jump to an OOXML fallback for ordinary inline image insertion. Ambiguous targets require `occurrence` or `location`. A missing target returns `partial`; it is not a successful no-op.

The standard editor blocks a `python-docx` round trip when package-sensitive features could be lost. Prefer `fallback-patch` with a narrow OOXML part allowlist. Use `--allow-lossy` only when the user explicitly accepts the listed fidelity risk; record that decision.

`--overwrite` authorizes replacing an existing internal candidate or a distinct
derived output file. It never authorizes replacing a source. Do not pass
`--use-exact-input` merely because the user supplied the original filename;
the version chain intentionally resolves that name to the latest delivered
revision.

Use comments or tracked replacements when the user requests reviewable changes. Do not silently turn a review task into a clean rewrite.

## Manage the review lifecycle

Add comments and tracked replacements:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" review \
  --input "$INPUT_DOCX" \
  --spec "$WORKSPACE/tmp/review.json" \
  --out "$WORKSPACE/tmp/candidate.docx"
```

Finalize a reviewed document:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" finalize \
  --input "$INPUT_DOCX" \
  --accept-changes --remove-comments \
  --out "$WORKSPACE/tmp/candidate.docx"
```

Use `--reject-changes` instead of `--accept-changes` when requested. Never pass both. Inspect after review and after finalization because page rendering does not reliably expose comment anchors.

## Validate and audit

Validate the ZIP package, required OOXML parts, XML well-formedness, archive safety, and macro absence:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" validate \
  --input "$WORKSPACE/tmp/candidate.docx"
```

Audit semantic and layout risks:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --profile draft --out "$WORKSPACE/qa/draft-audit.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --profile final --out "$WORKSPACE/qa/final-audit.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" audit \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --profile accessible --out "$WORKSPACE/qa/a11y-audit.json"
```

Interpret profiles as follows:

- `draft`: flag hierarchy, fake lists, small text, unstable table geometry, narrow margins, and formatting drift.
- `final`: include draft checks and fail the audit when comments or tracked changes remain; warn about personal metadata.
- `accessible`: include final checks and flag missing image alternative text or unmarked repeating table headers.

An audit can contain warnings even when `passed` is true. An audit with errors
or partial inspection coverage returns top-level `status: partial`; it must not
be treated as a successful audit. Final delivery is stricter: every warning
must be fixed or included in a disposition JSON mapping its issue code to a
specific rationale.

## Render and inspect every page

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" render \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out-dir "$WORKSPACE/qa/rendered" --emit-pdf
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

## Refresh fields, prove acceptance, and deliver once

`create` inserts a live TOC field but does not invent visible page numbers. When
the specification contains a TOC, refresh its cached result after content is
stable:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" refresh-toc \
  --input "$WORKSPACE/tmp/candidate.docx" \
  --out "$WORKSPACE/tmp/candidate-with-toc.docx" \
  --render-dir "$WORKSPACE/qa/toc-render"

CANDIDATE_DOCX="$WORKSPACE/tmp/candidate-with-toc.docx"
```

`refresh-toc` renders the document, locates semantic Heading paragraphs on
their rendered pages, and retains the live field while writing visible cached
entries, dot leaders, and page numbers. It also disables update-on-open after
the cached result is stable, so Word does not prompt merely because the
document contains a TOC. Do not substitute a manually typed contents page. If
there is no TOC, set `CANDIDATE_DOCX` to the current internal candidate.

Before the first mutation, freeze acceptance and obtain the canonical task
paths with `prepare`:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" prepare \
  --style-mode builtin \
  --document-structure formal-report \
  --require-text "Executive Summary" \
  --require-heading "1:Executive Summary" \
  --min-pages 8 --max-pages 12 \
  --min-images 2 \
  --require-toc \
  --protect-source "/absolute/path/to/source.xlsx"
```

Repeat `--require-text`, `--require-heading`, and `--protect-source` as needed.
Use `--min-images` only when figures are part of the user request. A
`formal-report` automatically requires a populated semantic TOC and freezes
separate cover/TOC/body pagination.
For an edit, add `--existing-document`. Header, footer, and page-number
permissions remain off unless the current request explicitly asks for them:

```bash
--allow-header
--allow-footer
--allow-page-numbers
```

Use only the permissions actually requested. Page numbers in a footer require
both `--allow-footer` and `--allow-page-numbers`.

`prepare` also freezes the current workspace as the default delivery boundary.
When the user does not name a destination, choose a final `.docx` path inside
that workspace. Never choose Desktop, Downloads, another project, or an
arbitrary absolute path. Only when the current user explicitly supplies an
exact outside-workspace path may `prepare` include:

```bash
--external-output "/exact/user/requested/path/result.docx"
```

This authorizes that exact path only. An explicit request to replace an
existing source is handled separately by `deliver --replace-source`.
For user-directed styling, replace `--style-mode builtin` with one of:

```bash
--style-mode user --style-source explicit-requirements \
  --style-requirement "Use the supplied navy brand color for Heading 1"
--style-mode user --style-source reference-template
--style-mode user --style-source existing-document
```

Use user mode only for evidence present in the current request or input.
Use `LEVEL:TEXT` only when the heading level is part of the requirement.
Omit constraints the user did not request; never invent a page count merely
to make a gate pass. `prepare` hashes protected sources itself and returns
the exact `tmp`, `qa`, candidate, acceptance, render, and report paths. Reuse
the frozen manifest for the complete task. Run `prepare --overwrite` only
when the current user request changes the acceptance requirements, never
after a candidate fails.

After the candidate is stable, initialize deterministic QA:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-init \
  --input "$CANDIDATE_DOCX" \
  --profile final \
  --disposition "personal-metadata=The user explicitly requested this author."
```

`qa-init` runs the automated gate, writes the initial report, renders the
latest candidate, and creates a pending visual-review file already bound to
the candidate SHA-256 and each decoded page-image SHA-256. Its top-level
`status: ok` means QA initialization completed; it does not mean the candidate
passed. Read `automated_gate` and resolve every error. Fix warnings or add a
specific disposition; never use a generic “acceptable” rationale.

Open every page path returned by `qa-init`. Immediately after inspecting one
page, record its page-specific result:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-record \
  --page 1 --status passed \
  --notes "Cover title, margins, and body content are complete and unclipped."

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-record \
  --page 2 --status passed \
  --notes "TOC entries, dot leaders, and page numbers are visible."
```

Do not edit the visual-review JSON, copy hashes, or run `sha256sum` on PNG
files. PNG container-byte hashes are intentionally different from the
normalized decoded-pixel hashes used by the gate. `qa-record` preserves the
canonical digest and adds a timestamped record for exactly one page. Inspect
and record every current page; do not infer unviewed pages from thumbnails or
reuse a generic note.

Complete the gate with the same candidate:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" qa-finalize \
  --input "$CANDIDATE_DOCX"
```

`qa-finalize` validates the current candidate, frozen acceptance, protected
sources, and recorded review against the exact render produced by `qa-init`;
it does not create a second, potentially different LibreOffice render. Warning
dispositions belong on `qa-init`. If they change, rerun `qa-init --overwrite`
before reviewing pages. Any candidate change also makes the review stale:
rerun `qa-init --overwrite`, inspect the newly rendered pages, and record them
again. The lower-level `preflight` command remains available for diagnostics
and compatibility, but the modifying workflow must use the deterministic QA
commands. A bare `--visual-review-status passed` is deliberately rejected
because it provides no page evidence.

Delivery requires a non-empty acceptance manifest and passes only when
preflight reports `status: ok`, `passed: true`,
`coverage.status: passed`, and `visual_review.status: passed`. Promote that
exact candidate once:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" deliver \
  --input "$CANDIDATE_DOCX" \
  --preflight-report "$WORKSPACE/qa/preflight-final.json" \
  --out "$FINAL_DOCX" \
  --new-document
```

`deliver` verifies the candidate SHA-256 against the successful report and
atomically writes the only project-visible DOCX. Any post-preflight mutation
invalidates delivery and requires a fresh preflight.

Relative `--out` paths resolve from the workspace frozen by `prepare`.
Outside-workspace delivery is blocked unless the exact path was frozen with
`--external-output`; a generic `--overwrite` never expands this boundary.

`deliver` blocks a document that still requests automatic field updates.
`--allow-update-fields-on-open` is an exceptional opt-in: use it only when the
current user explicitly requests dynamic updates and accepts the Word opening
prompt. A warning disposition alone is not permission to use this flag.

For an edited/reviewed/finalized/sanitized document, replace
`--new-document` with `--source "$REQUESTED_INPUT_DOCX"`. The command records
the delivered result as the latest session version, so a later turn that names
the original or any prior revision continues from this result.

By default, `FINAL_DOCX` must be a new path distinct from both the requested
source and the resolved latest version. Only an explicit current request such
as “直接覆盖原文件” permits:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" deliver \
  --input "$CANDIDATE_DOCX" \
  --preflight-report "$WORKSPACE/qa/preflight-final.json" \
  --source "$REQUESTED_INPUT_DOCX" \
  --out "$REQUESTED_INPUT_DOCX" \
  --replace-source
```

This exceptional mode saves a hidden digest-verified recovery copy before the
atomic replacement. Never infer it from `--overwrite`, from an earlier turn,
or from the desire to avoid choosing a new filename.

## Compare and sanitize

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" compare \
  --before "$INPUT_DOCX" --after "$WORKSPACE/tmp/candidate.docx" \
  --out "$WORKSPACE/qa/comparison.json"

bash "$DOCX_SKILL_ROOT/scripts/docx.sh" sanitize \
  --input "$INPUT_DOCX" \
  --out "$WORKSPACE/tmp/sanitized-candidate.docx" \
  --remove-comments
```

`compare` reports paragraph-level textual differences and document counts; it is not a pixel diff and does not prove formatting equivalence. `sanitize` removes core personal metadata, custom properties, revision identifiers, and optionally comments; it does not redact sensitive words from visible document content.

## Safety and fidelity rules

- Accept `.docx` only. Reject `.doc`, `.docm`, `.dotm`, and unrelated ZIP archives.
- Reject unsafe archive paths, malformed XML, macro payloads, and suspiciously expanded packages.
- Never fetch remote images. Use local workspace files only.
- Preserve the source and deliver a new version by default. Source replacement
  requires the current user's explicit instruction and `--replace-source`.
- Do not claim that comments were visually verified from rendered pages.
- Do not bypass document or write protection. Do not claim full fidelity for digital signatures, embedded objects, notes, Office Math, SmartArt/diagrams, complex content controls, or custom XML without explicit inspection. Read [ooxml-and-safety.md](references/ooxml-and-safety.md) before touching package-sensitive documents.
- Never run a custom DOCX builder directly as the delivery path. Standard operations must be tried or declared insufficient first; custom code must run through the controlled fallback command and manifest.
- Keep citations and sources as ordinary human-readable document text. Never expose internal tool tokens, private paths, credentials, or hidden reasoning in the document.
- Do not present generated facts as sourced. Preserve existing citations and clearly distinguish supplied facts from drafted language.

## Delivery gate

Before returning a DOCX, confirm all of the following:

- the requested content and edits are complete;
- only one project-visible final DOCX exists; all candidates and QA files remain below the turn work directory;
- the output is a new, valid `.docx` produced by `deliver`, unless the current
  user request explicitly authorized `--replace-source`;
- an existing-document workflow used the latest tracked revision as its base;
- preflight reports `status: ok`, `passed: true`, `coverage.status: passed`, and `visual_review.status: passed`;
- every warning is fixed or has a specific recorded disposition;
- every rendered page from the latest candidate has a non-empty review note;
- required headings, page constraints, image count, document structure, TOC state, and protected source hashes satisfy the acceptance manifest;
- comments and revisions match the requested delivery state;
- metadata and privacy state match the request;
- the delivered SHA-256 matches the passed preflight report;
- the response mentions the final filename without an unsolicited Markdown download/view link.

Run the bundled end-to-end regression when changing this skill itself:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" self-test
```
