# DOCX Task Workflows

Use this guide to choose the correct lifecycle for reading, creating, editing, reviewing, comparing, sanitizing, and delivering Word documents.

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
2. Select an archetype and one design preset.
3. Read `design-and-layout.md` and map content to appropriate forms.
4. Write a JSON specification in the task workspace.
5. Run `create` to a new DOCX path.
6. Run `validate` and `audit --profile draft`.
7. Render and inspect all pages.
8. Correct content or design defects and repeat.
9. Run `audit --profile final` on the delivery candidate.

Use placeholders or clearly marked assumptions when required information is missing. Do not silently fabricate names, dates, financial values, citations, legal terms, or technical results.

## 3. Targeted editing

1. Preserve the original.
2. Run `inspect` and identify exact text, style, and location targets.
3. Use the smallest supported edit operation.
4. Write to a new output path.
5. Verify each operation's `affected` count.
6. Re-inspect the changed area and compare the output with the input when useful.
7. Validate, audit, render, and inspect every page affected by pagination changes. For safety, inspect all pages before final delivery.

Prefer this order of intervention:

1. replace text inside existing runs;
2. insert or remove one paragraph;
3. change one paragraph style;
4. append a clearly requested section;
5. rebuild only when the user asks for substantial redesign or the source cannot support the request.

Do not convert a local correction into a broad rewrite. Preserve citations, fields, bookmarks, links, and review history unless the user asks to change them.

## 4. Major rewrite or redesign

Treat a major rewrite as a new design task with a fidelity constraint.

- Capture the original content and hierarchy with `inspect`.
- Render the original to understand pagination and recurring components.
- Decide what must remain semantically or visually stable.
- Choose whether to edit a copy or recreate from a specification.
- Record intentional omissions or structural changes.
- Compare old and new text, then render both when visual comparison matters.

Use recreation only when its benefits outweigh the risk of losing unsupported OOXML features.

## 5. Review and redline

Use `review` when changes must remain visible or feedback must be anchored near the relevant content.

- Use comments for questions, requests for evidence, ambiguity, or non-authoritative suggestions.
- Use tracked replacements for proposed wording changes.
- Keep comment text specific and actionable.
- Anchor feedback at the point of concern instead of collecting unrelated notes at the end.
- Use a short unique match whenever possible.
- Inspect the result to verify comment count, author, text, and tracked insertion/deletion counts.

The bundled tracked-replacement operation requires the matched text to reside in one Word run. If it spans multiple differently formatted runs, use a smaller unique match or apply a normal edit after the user approves the wording.

## 6. Finalization

Determine the requested review state before finalizing:

- accept changes and keep comments;
- accept changes and remove comments;
- reject changes and keep comments;
- reject changes and remove comments;
- remove comments without changing revisions.

Never accept or reject changes by assumption. After finalization, inspect the output and verify that comment and revision counts match the requested state. Run the `final` audit before delivery.

## 7. Comparison

Use `compare` to produce a paragraph-level unified text diff and document counts. Read the diff rather than reporting only that files differ.

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

Treat page PNGs and optional PDFs as internal QA unless the user explicitly requests them.

## 10. Failure handling

- If dependencies are missing, run `fix` only when installation is allowed.
- If LibreOffice is absent, finish structural QA and disclose that visual QA was not completed.
- If LibreOffice exists but conversion fails, inspect the command output, writable HOME/profile, input validity, and output directory before retrying.
- If an edit target is missing or ambiguous, do not guess. Refine the match from inspection data or report the unresolved target.
- If a package contains macros, reject it; this skill intentionally supports `.docx` only.
- If the document depends on signatures, embedded objects, custom XML, or complex content controls, preserve the source and explain the fidelity risk before reconstruction.
