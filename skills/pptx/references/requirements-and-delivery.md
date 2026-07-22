# Requirements and final delivery

## Use a requirements file selectively

Create a requirements file when the user supplies exact facts, counts, mandatory sections, slide-specific copy, or benchmark acceptance criteria. Skip it for open-ended visual exploration without explicit coverage requirements.

```json
{
  "schemaVersion": 1,
  "slideCount": 10,
  "requirements": [
    {
      "id": "win-reason-values",
      "label": "Win-reason values 11 / 9 / 7",
      "priority": "critical",
      "terms": ["11", "9", "7"],
      "match": "all",
      "slides": [6]
    },
    {
      "id": "mobile-experience",
      "priority": "recommended",
      "terms": [["mobile experience", "移动体验"]]
    }
  ]
}
```

Use top-level `slideCount` when an exact page count is mandatory. Each term may be a string or an array of acceptable aliases. `match` defaults to `all`; use `any` only when one alternative is sufficient. A missing critical requirement makes coverage fail. A missing recommended requirement remains an audit warning that must be fixed or explicitly dispositioned. Coverage itself is `passed` when every critical requirement is present.

This check confirms extracted slide text coverage. It does not prove that a claim is correct, legible, or placed on the intended visual unless a slide selector is supplied.

## Verify one immutable artifact

For a net-new deck, build and verify once:

```bash
bash "$PPTX" deliver \
  --builder "$WORKSPACE/tmp/deck.mjs" \
  --out "$FINAL_PPTX" \
  --qa-dir "$WORKSPACE/qa" \
  --requirements "$WORKSPACE/tmp/requirements.json" \
  --require-coverage \
  --target-platform cross-platform \
  --require-render
```

`deliver` auto-discovers `WORKSPACE/tmp/requirements.json` from the QA directory, but use `--require-coverage` whenever exact criteria exist so a missing manifest fails closed. For template output or an already-built final artifact, use `--input "$FINAL_PPTX"`. Use `--input "$WORKSPACE/qa/candidate.pptx" --out "$FINAL_PPTX"` to seal a reviewed candidate after adding dispositions.

The delivery report records the PPTX SHA-256 before and after structural audit and rendering. `deliver --builder` builds into the QA candidate path and copies it to the requested output only when every gate passes. Never deliver the candidate, and never rebuild or edit the file after the last successful sealed delivery report.

## Disposition warnings

Fix genuine defects in the builder. For an intentional overlap, verified false positive, or accepted renderer limitation, create a disposition file using warning IDs from `audit.json`:

```json
{
  "schemaVersion": 1,
  "artifactSha256": "<sha256 from audit.json>",
  "warnings": [
    {
      "id": "overlap:slide-4:timeline-node-label",
      "decision": "intentional",
      "reason": "The label is visually centered over its background field in the full-size render.",
      "evidence": "qa/slides/slide-04.png reviewed at full size"
    }
  ]
}
```

Allowed decisions are `accepted`, `intentional`, and `false_positive`. Every disposition requires the exact artifact hash, a concrete reason, and visual evidence. Unknown warning IDs, duplicate IDs, missing evidence, and stale artifact hashes are rejected. Re-run `deliver --input candidate.pptx --out "$FINAL_PPTX"` with `--dispositions` so the unchanged candidate can be sealed.

## Interpret statuses

- `passed`: no errors or unresolved warnings; coverage and required rendering passed.
- `passed_with_warnings`: an intermediate audit result only; the artifact is not sealed for delivery.
- `failed`: a structural error, missing critical requirement, required-render failure, page-count mismatch, or artifact-integrity failure blocks delivery.

Heuristic text-fit warnings and LibreOffice font substitution are not automatically PowerPoint defects.
