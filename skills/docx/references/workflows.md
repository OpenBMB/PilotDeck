# DOCX Task Workflows

Use this guide to choose the correct lifecycle for reading, creating, editing, reviewing, comparing, sanitizing, and delivering Word documents.

Begin every modifying workflow with `capabilities`, `prepare`, and the relevant
`schema`. `prepare` freezes acceptance and returns the canonical paths for the
current `PILOTDECK_WORK_DIR`; never guess or search for another turn directory.
The standard command owns common operations;
[capabilities-and-fallbacks.md](capabilities-and-fallbacks.md) owns every
exception. Every mutation produces an internal candidate below
`PILOTDECK_WORK_DIR`; only `deliver` may create the project-visible final DOCX.
The Skill keeps a session-scoped version chain outside the project-visible
files. An original or prior path therefore resolves to the latest delivered
revision during later modifying turns.

## Contents

1. Read-only analysis
2. New document creation
3. Targeted editing
4. Major rewrite or redesign
5. Review and redline
6. Finalization
7. Comparison
8. Privacy cleanup
9. Rendering and iteration
10. Failure handling

## 1. Read-only analysis

Validate and inspect the source. Read the complete relevant section, including headings, table labels, notes, headers, footers, comments, and tracked content. Use rendering when page position or layout affects the answer.

Do not change or re-export the source for a read-only question. State when a requested fact is absent, ambiguous, or present only inside unresolved revisions.

## 2. New document creation

1. Clarify the requested outcome from available context without inventing facts.
2. Select an archetype, then freeze one style path. Use user mode only for a
   supplied template, concrete visual requirements, or an existing document
   whose style must be preserved. Otherwise use the single built-in neutral
   template. Never infer a colored theme from the document archetype.
3. Read `design-and-layout.md` and map content to appropriate forms.
4. Run `prepare --style-mode builtin` or the corresponding user style source.
   Add `--document-structure formal-report` for a cover + TOC + body report,
   and add `--min-images N` when figures are required. Include requirements
   from the current user request, then query
   `schema --command create` and write a strict JSON specification below the
   returned `tmp` path. Do not loosen acceptance after a candidate fails.
   Do not enable headers, footers, or page numbers unless the current user
   explicitly requested them. When requested, freeze only the corresponding
   `--allow-header`, `--allow-footer`, and/or `--allow-page-numbers` flags.
5. Copy the frozen style policy into the create specification and run `create`
   with the acceptance manifest to a new internal candidate path.
6. If the required feature is outside the schema, choose an auxiliary asset or declared fallback; never run an ad hoc builder directly.
7. Inspect the candidate and run `audit --profile draft`.
8. Correct content or design defects and repeat.
9. If a TOC is required, run `refresh-toc` after content and headings are
   stable. It writes visible cached entries and disables field updates on
   open; do not enable automatic updates merely to refresh the TOC.
10. Run `qa-init` with the frozen acceptance manifest and resolve its automated gate.
11. Open every current page path, call `qa-record` immediately with a
    page-specific passed/failed note, then run `qa-finalize`. Do not handwrite
    review JSON or calculate page hashes.
12. Run `deliver --new-document` once with the exact candidate and successful
    preflight report. If the user did not specify a destination, keep the final
    file in the current workspace. An outside-workspace destination must be
    the exact path frozen by `prepare --external-output`.

Use placeholders or clearly marked assumptions when required information is missing. Do not silently fabricate names, dates, financial values, citations, legal terms, or technical results.

## 3. Targeted editing

1. Preserve the original by default.
2. Run `resolve-latest` on the path named by the user. Inspect and modify the
   returned `resolved` document, not a stale original or prior revision.
3. Run `prepare --existing-document`, then `inspect` and identify exact text,
   style, and location targets. Existing recurring content may remain, but
   `set_header`, `set_footer`, and new page fields require explicit frozen
   permission.
4. Use the smallest supported edit operation. Ordinary anchored image insertion
   is supported by `insert_image`; use fallback only for unsupported wrapping,
   floating placement, or package-sensitive structures.
5. Write to a new internal candidate path.
6. Verify each operation's `affected` count. Missing or ambiguous targets return `partial`; refine them rather than guessing.
7. Re-inspect the changed area and compare the output with the resolved input when useful.
8. Validate, audit, render, and inspect every page affected by pagination changes. For safety, inspect all pages before final delivery.
9. Pass `qa-init`, per-page `qa-record`, and `qa-finalize`, then promote the exact
   candidate with `deliver --source <user-referenced-path>` to a new final
   filename. The delivery becomes the latest version for the next turn.

Prefer this order of intervention:

1. replace text inside existing runs;
2. insert or remove one paragraph;
3. change one paragraph style;
4. append a clearly requested section;
5. use a narrow `fallback-patch` when preservation requires an OOXML operation outside the edit schema;
6. rebuild only for a requested substantial redesign, and only through declared `fallback-create`.

Do not convert a local correction into a broad rewrite. Preserve citations, fields, bookmarks, links, and review history unless the user asks to change them.

Use `--use-exact-input` only when the current user explicitly requests an
older/original revision as the new editing base. If the current request
explicitly says to overwrite the exact source, `deliver` may use
`--source <source> --out <source> --replace-source`. That mode creates a
hidden recovery copy. A generic `--overwrite` flag, an earlier request, or the
absence of a preferred filename does not authorize source replacement.

## 4. Major rewrite or redesign

Treat a major rewrite as a new design task with a fidelity constraint.

- Capture the original content and hierarchy with `inspect`.
- Render the original to understand pagination and recurring components.
- Decide what must remain semantically or visually stable.
- Choose whether to edit a copy or recreate from a specification.
- Record intentional omissions or structural changes.
- Compare old and new text, then render both when visual comparison matters.
- Keep all redesign iterations internal and deliver only the accepted candidate.

Use recreation only when its benefits outweigh the risk of losing unsupported OOXML features.

## 5. Review and redline

Use `review` when changes must remain visible or feedback must be anchored near the relevant content.

- Use comments for questions, requests for evidence, ambiguity, or non-authoritative suggestions.
- Use tracked replacements for proposed wording changes.
- Keep comment text specific and actionable.
- Anchor feedback at the point of concern instead of collecting unrelated notes at the end.
- Use a short unique match whenever possible.
- Inspect the result to verify comment count, author, text, and tracked insertion/deletion counts.

The bundled tracked-replacement operation requires the matched text to reside in one Word run. If it spans multiple runs, the command returns `unsupported`. Use a smaller exact match, obtain approval for a clean edit, or use a controlled OOXML patch; never silently downgrade a requested redline.

## 6. Finalization

Determine the requested review state before finalizing:

- accept changes and keep comments;
- accept changes and remove comments;
- reject changes and keep comments;
- reject changes and remove comments;
- remove comments without changing revisions.

Never accept or reject changes by assumption. After finalization, inspect the output and verify that comment and revision counts match the requested state. Run the `final` audit before delivery.

## 7. Comparison

Use `compare` to produce a paragraph-level unified text diff plus metadata, section, field, image, package-feature, and inspection-coverage differences. Read the result rather than reporting only that files differ.

If either document has partial inspection coverage, comparison top-level `status` is `partial`. Do not report a complete comparison when unsupported structures could contain changes outside the modeled surface.

This comparison does not establish:

- visual equality;
- style equality;
- identical table geometry;
- identical images or relationships;
- a legal redline equivalent to Microsoft Word Compare.

Render both documents for visual comparison when layout matters. Use inspection output to compare metadata, sections, tables, comments, and revisions.

## 8. Privacy cleanup

Use `sanitize` to remove core author fields, custom properties, and revision identifiers. Add `--remove-comments` when comments must not remain.

Sanitization does not remove visible names, emails, phone numbers, account values, or confidential prose. Search visible content separately when the user requests redaction or anonymization. Do not claim irreversible redaction unless visible text, document XML, comments, headers, footers, hyperlinks, and embedded content were all checked.

Validate, inspect, and render the sanitized output. Confirm that the visual document remains unchanged where expected.

## 9. Rendering and iteration

Render every delivery candidate through the bundled command. Use a fresh output directory for each iteration so stale pages cannot be mistaken for the latest result.

For each page:

1. inspect the full page at a readable scale;
2. zoom into tables, images, callouts, footnotes, headers, and footers;
3. note every defect and its page;
4. correct the source or specification;
5. regenerate the DOCX and rerun validation and audit;
6. render again and discard stale QA images.

Treat page PNGs and optional PDFs as internal QA unless the user explicitly
requests them. Rendering alone is not acceptance: freeze requirements with
`prepare`, resolve or disposition warnings from `qa-init`, inspect every PNG,
and call `qa-record` for every current page before `qa-finalize`. Never edit
the review JSON or calculate image hashes manually; `qa-init` emits the
normalized decoded-pixel digests consumed by the gate. Repeated generic notes
and stale page images are rejected.
Automated body-ink checks also block unintended blank pages and surface
suspiciously sparse pages. A searchable PDF text layer
does not compensate for text that is missing from the rendered page. A TOC
field is not accepted until `refresh-toc` produces visible cached entries and
page numbers. A final candidate that requests automatic field updates is
blocked unless the current user explicitly accepted the Word opening prompt
and `deliver --allow-update-fields-on-open` is used. `deliver` also requires
the acceptance manifest and rejects
visual evidence or preflight reports bound to another candidate digest.

## 10. Failure handling

- If dependencies are missing, run `fix` only when installation is allowed.
- If LibreOffice is absent, `preflight` cannot pass. Finish structural QA and disclose that visual QA was not completed.
- If LibreOffice exists but conversion fails, inspect the command output, writable HOME/profile, input validity, and output directory before retrying.
- If an edit target is missing or ambiguous, do not guess. Refine the match from inspection data or report the unresolved target.
- If a package contains macros, reject it; this skill intentionally supports `.docx` only.
- If a standard operation returns `partial`, `unsupported`, or `blocked`, preserve that result. Do not use `|| true` or continue from a file merely because it exists.
- An `inspect` result with `inspection_coverage.status: partial` also has top-level
  `status: partial`. You may continue with a narrowly supported operation only
  when its target is inside the inspected scope and the unmodeled package
  features are preserved and disclosed; do not claim complete document
  understanding.
- If the document depends on signatures, embedded objects, custom XML mappings, or complex content controls, preserve the source. Use a narrow fallback only when the capability table permits it.
- If a fallback is appropriate, run it through `fallback-patch` or `fallback-create` and retain its manifest. Scope violations are blocked, not retried outside the wrapper.
- If preflight passed but the candidate changed, delivery is blocked by the
  SHA-256 mismatch. Rerun the complete gate; never copy or rename around it.
- If full preflight is impossible, report the limitation and keep the candidate
  internal. Do not expose it as a completed deliverable.
