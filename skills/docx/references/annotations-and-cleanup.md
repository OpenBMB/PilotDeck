# DOCX annotations and cleanup

Load this guide only when the task needs review markup, finalization, comparison, or metadata cleanup.

## Comments and tracked replacements

Use `annotate` with a small task-local JSON file:

```json
{
  "comments": [
    {
      "match": "The program is ready",
      "text": "Add the evidence source for this conclusion.",
      "author": "PilotDeck",
      "occurrence": 1
    }
  ],
  "tracked_replacements": [
    {
      "match": "launch in May",
      "replacement": "launch in June",
      "author": "PilotDeck",
      "occurrence": 1
    }
  ]
}
```

Identify the intended occurrence. Tracked replacement currently requires the matched text to exist in one run; use a narrower match or a controlled OOXML patch when it spans runs. Rendering usually omits comment balloons, so verify annotation counts and text structurally.

## Finalization

Use `finalize --accept-changes` or `--reject-changes`, optionally with `--remove-comments`. Do not choose a review state by assumption. Inspect afterward to confirm the requested comment and revision state.

## Compare and sanitize

`compare` reports paragraph text differences plus metadata, counts, sections, field additions and removals, images, package-feature changes, and inspection coverage. It is not a visual diff or Microsoft Word legal redline.

`sanitize` removes core author fields, custom properties, Word revision identifiers, and optionally comments. It does not redact visible names, prose, images, external links, embedded files, or arbitrary custom XML. Evaluate visible content separately when privacy or redaction is the actual goal.
