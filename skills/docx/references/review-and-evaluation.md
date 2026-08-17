# DOCX review and evaluation

Use visual evidence for layout and structural evidence for semantics. Neither substitutes for the other.

## Visual review

`review` converts the candidate through LibreOffice, creates a revision-specific directory, and returns one full-size PNG path per page together with page text counts and structural facts.

`review_pending` means the render completed. Open relevant images before claiming visual quality. For a short document, reviewing every page is often sensible. For a long document, select pages from the task and changes: title or opening pages, TOC, section transitions, dense tables, figures, unusual orientations, edited areas, and the final page.

Check:

- reading order and hierarchy;
- missing, clipped, overlapping, or substituted text;
- headings separated from following content;
- table width, wrapping, row splits, and repeated headers;
- image scale, sharpness, placement, and captions;
- section and page breaks, blank pages, headers, and footers;
- consistency with supplied templates or existing documents.

Each candidate digest gets a different review directory. If the candidate changes, rerun review and inspect images from the new revision.

If LibreOffice is unavailable, review returns structural evidence with `evidence_unavailable`. Disclose the missing visual evidence instead of claiming layout was checked.

## Structural evidence

Use the report for comments, tracked changes, fields, relationships, metadata, sections, package features, and inspection limitations. Use `accessibility` only when semantic accessibility evidence matters.

Package validation errors, unsafe archive content, failed relationships, and source mutation are not stylistic findings; correct them before delivery.

## Task-specific evaluation

Use `evaluate` when a consequence or uncertainty cannot be resolved by visual review and general inspection. Write an evaluator that independently rereads the candidate and authoritative sources, then writes a JSON object to `--out`.

Evaluator contract:

```python
import argparse
import json

parser = argparse.ArgumentParser()
parser.add_argument("--input", required=True)
parser.add_argument("--out", required=True)
args = parser.parse_args()

result = {"passed": True, "checks": []}
with open(args.out, "w", encoding="utf-8") as handle:
    json.dump(result, handle, ensure_ascii=False, indent=2)
```

Useful evaluations include factual reconciliation, required-section coverage, record counts, citation/source checks, and comparing targeted edits while confirming unrelated content remains stable. Encode only evidence relevant to the current task instead of building a universal checklist.
