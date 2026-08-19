# Review and evaluation

## Review evidence

`pptx.sh review` produces structural facts, audit observations, and full-size slide images under a revision-specific directory. The report status `review_pending` means that evidence is ready; it does not mean the deck has passed visual review.

Choose inspection scope from the task and risk:

- Review a short net-new deck broadly for pacing and consistency.
- Review changed and neighboring slides for a localized edit.
- Expand the review when global typography, theme, layout, or data changes.
- Inspect chart, table, image, and template-sensitive slides at full size.

Audit heuristics identify possible overflow, placeholders, overlap, text-fit risk, repeated units, and typography compatibility. Treat them as prompts for visual judgment. Intentional containment and overlap are common in slide design; font substitution in LibreOffice is not automatically a Microsoft PowerPoint defect.

After rebuilding, run review again. Each run receives a revision and evidence directory tied to the candidate hash. Do not use images from an earlier revision to justify claims about a changed file.

## Task-specific evaluation

Use `evaluate` when images and generic structure cannot establish correctness. Write an evaluator for the actual request instead of encoding the request into universal Skill parameters.

```js
export default async function evaluate({ candidate, helpers }) {
  return {
    checks: [
      {
        name: 'Required decision appears',
        passed: helpers.findText('Approve the pilot').length > 0,
      },
      {
        name: 'Expected slide count',
        passed: candidate.slideCount === 8,
      },
    ],
  };
}
```

Each check needs a name and boolean `passed`. Add evidence or details useful for diagnosis. Evaluators can reread authoritative inputs, inspect the candidate manifest, reconcile chart values, compare before and after slides, or verify required copy.

Use evaluation proportionally. A simple visual deck may need no evaluator. A source-based presentation with important numbers may require independent reconciliation against the source rather than keyword presence alone.
