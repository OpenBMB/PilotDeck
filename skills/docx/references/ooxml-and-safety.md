# OOXML, Review, Privacy, and Compatibility

Read this guide before working with comments, tracked changes, fields, external relationships, sensitive metadata, or package-sensitive Word features.

## Contents

1. Package model
2. Comments
3. Tracked changes
4. Fields and links
5. Privacy and sanitization
6. Unsupported and high-risk features
7. Safe handling rules

## 1. Package model

A `.docx` file is an OPC ZIP package containing XML parts, relationships, media, and properties. Text extraction alone does not establish package integrity or visual correctness.

Use `validate` to check required parts, XML well-formedness, archive path safety, expansion limits, internal relationship targets, content-type declarations, and macro absence. Use `inspect` to report comments, tracked changes across story parts, fields, images, external relationships, package features, metadata, sections, visible structure, and inspection limitations.

The `review`, `finalize`, and `sanitize` commands patch a copied OOXML package. The general `edit` command loads and saves through `python-docx`; it blocks package-sensitive inputs by default. Use the controlled `fallback-patch` wrapper for a narrow OOXML change rather than bypassing the skill.

## 2. Comments

Comments require coordinated changes to:

- `word/comments.xml`;
- comment relationships;
- content type declarations;
- range start, range end, and reference markers in the document body.

Use the bundled `review` command rather than hand-writing these parts. Inspect the result and verify comment count, ID, author, date, text, and anchor context.

Page rendering normally omits review balloons. Do not use PNG pages as proof that comments exist or are correctly anchored.

## 3. Tracked changes

A tracked replacement contains a deletion and insertion with IDs, authors, and dates. The bundled command enables revision tracking and inserts both structures in place.

Limitations:

- the match must be unique enough for the intended paragraph;
- tracked replacement requires the matched text to exist in a single run;
- complex moves, table-structure changes, and full Microsoft Word Compare semantics are not implemented;
- accepting or rejecting revisions changes visible content and can affect pagination.

Finalization processes simple insertions and deletions in the main body, headers, footers, footnotes, and endnotes. It blocks move and property revisions because those require fuller Word semantics. Always inspect before and after finalization. Confirm every revision count reaches zero when delivering a clean final document.

## 4. Fields and links

Inspection reports field instructions and external relationships. Treat field display text as potentially stale because headless tools may not recalculate Word fields.

Do not silently rewrite field instructions, bookmarks, hyperlinks, or relationship targets during unrelated edits. The creator supports TOC, PAGE, NUMPAGES, DATE, and TIME fields. Verify their displayed results in rendering; a valid field instruction does not prove its cached display is current. For a created TOC, use `refresh-toc` to retain the live field while generating visible cached entries and page numbers, then require `toc.populated` in acceptance.

The creator does not set `w:updateFields` by default, and `refresh-toc`
removes that update-on-open request after caching stable results. This avoids
the Word warning that a document's fields may refer to other files. The final
audit reports `fields-update-on-open`, and delivery blocks it unless the
current user explicitly accepts dynamic updates and the
`--allow-update-fields-on-open` flag is used. This opt-in does not authorize
following external relationships.

Treat unexpected external relationships as a security and privacy signal. Do not follow remote targets automatically.

## 5. Privacy and sanitization

The `sanitize` command removes:

- author and last-modified-by values;
- subject and keywords values;
- custom document properties;
- Word revision identifiers (`rsid*`);
- comments when `--remove-comments` is supplied.

It does not remove visible sensitive content, image metadata, embedded files, external link targets, or arbitrary custom XML. For a privacy-sensitive delivery:

1. inspect metadata, comments, relationships, headers, footers, and visible text;
2. sanitize to a new output;
3. inspect again;
4. search visible content for sensitive values;
5. validate, audit, and render the sanitized copy.

Do not claim redaction or anonymization when only metadata was scrubbed.

## 6. Unsupported and high-risk features

Stop and assess fidelity before modifying documents that contain:

- digital signatures;
- document and write protection;
- macros or VBA;
- embedded OLE objects;
- complex content controls;
- custom XML mappings;
- protected or rights-managed content;
- linked external media;
- uncommon drawing, equation, or chart extensions;
- nested revision structures beyond simple insertions and deletions.

This skill rejects macro-enabled formats. Preserve the source and avoid reconstruction when unsupported parts are important to the document's function.

Documents declaring `w:documentProtection` or `w:writeProtection` are read-only. The skill inventories those settings but does not bypass passwords, enforcement, rights management, or policy controls. Standard mutation commands and targeted fallback patching return `blocked`.

Before writing custom code, query `capabilities` and the relevant `schema`. If a fallback is allowed, follow [capabilities-and-fallbacks.md](capabilities-and-fallbacks.md). A fallback manifest and post-mutation preflight are mandatory; direct custom mutation is not an accepted delivery path. Keep the fallback output internal and use `deliver` only after its exact SHA-256-bound candidate passes acceptance and per-page visual review.

## 7. Safe handling rules

- Work only with `.docx` files.
- Validate before extraction or mutation.
- Never overwrite the source by default. A current, explicit request to replace
  that exact source requires `deliver --replace-source`; `--overwrite` is not
  equivalent. The delivery command must retain its hidden recovery copy.
- Continue modifying from the latest session-tracked delivery. Use an older or
  original version as the base only when the current user explicitly asks for
  it.
- Never extract unsafe archive paths.
- Never fetch remote images or relationships automatically.
- Never place credentials, internal tokens, hidden reasoning, or private system paths into document content.
- Keep temporary unpacked packages in controlled temporary directories and delete them after repacking.
- Keep fallback programs under the turn work directory. Do not read secrets
  from the environment, access the network, or write outside declared
  arguments and task-local assets.
- Validate every repacked file before use.
- Treat clean visual rendering as necessary but insufficient; pair it with structural inspection.
