# Full-corpus E2-Elite applicability review

## What was tested

The review used the case-name workbook from the supplied ten-batch evaluation
archive and the available case metadata. The scope was the first six delivery
batches plus the 7.14 retest column, matching the user's "80+" corpus.

Only task labels, requested artifact shape, source/generated-file metadata,
checkpoint counts, dimensions, and critical flags were used. Expected answers,
checkpoint descriptions, Judge reasoning, and generated legal content were not
used to design or alter production prompts.

Each unique case was classified along two axes:

- delivery mode: narrative, hybrid, schedule-heavy, or operational;
- E2-Elite applicability: primary, optional, internal-support-only, or
  outside-legal-plugin.

## What was observed

- Spreadsheet entries: 85.
- Exact duplicate labels: 3.
- Unique cases: 82.
- Checkpoints represented by the case inventory: 4,685.
- Critical checkpoints: 2,135.

Applicability:

| Class | Cases |
|---|---:|
| primary | 18 |
| optional | 46 |
| internal-support-only | 13 |
| outside-legal-plugin | 5 |

Delivery modes:

| Mode | Cases |
|---|---:|
| narrative | 14 |
| hybrid | 48 |
| schedule-heavy | 14 |
| operational | 6 |

The result supports adaptive selection and rejects a universal legal table or
seven-matrix workflow. Structured projection is most useful for due diligence,
evidence comparison, calculations, timelines, registers, and operational file
state. It is usually selective for contract, privacy, investigation, and legal
research work. Pleadings and short advice should remain narrative, with at most
small internal consistency records. File redaction and legal content planning
need generic artifact controls or separate task Skills, not the due-diligence
legal schema.

## Why it is enough

All 82 unique labels were included in the architecture-applicability census,
and eleven materially different task shapes received a deeper manual review in
`products/legal/docs/e2-elite-adaptive-legal-projection.md`. The full census
tests whether the architecture can select an appropriate mode without tuning
production behavior to expected answers. The stratified review tests the
failure boundary of each mode in more detail.

This is enough to decide that E2-Elite should be adaptive and task-owned. It is
not enough to claim a semantic quality improvement across the corpus.

## What was omitted

Raw source documents, expected answers, rubric text, checkpoint descriptions,
Judge prompts and responses, generated legal documents, credentials, and
private endpoint details are intentionally omitted. The three duplicate labels
were retained in the source-entry count and removed only from the unique-case
classification; no additional cases were deleted to force the count to 80.

## Remaining gate

A full 82-case A/B rerun should wait until the original legal Skills are
available and one representative case from each delivery mode passes runtime,
mutation, cost, and semantic gates. The recovered `output/skills/*.json` files
are QA reports that point to unavailable Skill sources; they are not executable
Skill bodies and cannot support a faithful rerun.
