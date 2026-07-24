# Frozen-evidence projection experiment

## What was tested

The difficult legal case was evaluated without rerunning the Agent and without rereading source documents.

- E0: the frozen v1.2 opinion.
- E1: the byte-identical E0 body plus mechanically generated user-visible schedules from the frozen evidence ledger.
- Constant Judge settings: 321 checkpoints, batch size 10, 120,000-character limit, same case record, same captured final response.
- E1 generation did not use rubric expectations or Judge feedback. The rubric was used only after generation for evaluation.

Raw legal artifacts, payloads, and Judge responses remain outside Git. This file contains only aggregate, sanitized evidence.

## Observed results

| Metric | E0 | E1 | Delta |
|---|---:|---:|---:|
| Overall pass | 185/321 (57.63%) | 174/321 (54.21%) | -11 |
| Critical pass | 100/141 (70.92%) | 94/141 (66.67%) | -6 |

The single full-run transition table contained 5 apparent improvements, 16 apparent regressions, 169 stable passes, and 131 stable failures.

Because E1 is E0 with append-only schedules, the 16 apparent regressions could not be treated as deterministic content loss. The 21 disputed checkpoints were therefore rejudged in three concurrent E0/E1 pairs:

| Paired result | E0 | E1 |
|---|---:|---:|
| Round 1 | 6/21 | 6/21 |
| Round 2 | 5/21 | 5/21 |
| Round 3 | 5/21 | 4/21 |
| Aggregate | 16/63 | 15/63 |

Across the 21 checkpoints, E1 was better on 1, tied on 18, and E0 was better on 2. One stable E1 improvement came from exposing a source filename that identified a document as an excerpt. One stable E1 regression came from splitting related record fields across separate rows, which caused the Judge to require an entity-specific paid-in statement instead of accepting a document-level statement.

The Judge guard repeatedly downgraded a substantively supporting verdict to fail on one checkpoint even though its own reasoning said the requirement was satisfied. This is evaluation noise and should be fixed or adjudicated in rubric v2.

## E2 record-oriented projection

E2 used a real Agent turn over a copied workspace with zero source files. It could read only the frozen opinion and internal legal evidence. The generation prompt prohibited rubric/Judge input, required the E0 document to remain an exact byte prefix, and limited the change to record-oriented supporting schedules.

The semantic artifact preserved E0 as an exact prefix and appended 14,453 characters. Its single full Judge run scored:

| Metric | E0 | E2 | Delta |
|---|---:|---:|---:|
| Overall pass | 185/321 (57.63%) | 225/321 (70.09%) | +40 |
| Critical pass | 100/141 (70.92%) | 113/141 (80.14%) | +13 |

The single-run transition table contained 50 improvements and 10 regressions. Fact extraction improved from 155/267 to 198/267. Legal citation remained 5/13. Legal reasoning fell from 18/33 to 15/33 in that single run, so record schedules do not replace substantive legal review.

All 60 changed checkpoints were rejudged in three concurrent E0/E2 pairs:

| Paired result | E0 | E2 |
|---|---:|---:|
| Round 1 | 5/60 | 48/60 |
| Round 2 | 6/60 | 48/60 |
| Round 3 | 5/60 | 49/60 |
| Aggregate | 16/180 | 145/180 |

E2 was better on 47 checkpoints, tied on 9, and worse on 4. There were 43 stable E2-only wins (E0 0/3, E2 3/3), including 15 critical checkpoints. There were no stable E0-only wins (E0 3/3, E2 0/3).

E2 did not pass the process gate:

- The Agent created one scratch schedule under the legal work directory despite an explicit instruction that only the opinion could change.
- The Agent then incorrectly reported that the target opinion was the only modified file.
- The run used 47 model requests and approximately 1.25 million total tokens.

The E2 score therefore proves semantic value, but the generated process is not a production implementation.

## Why this is enough

The experiment isolates raw ledger exposure from source reading, Agent generation, prompt injection, and Core lifecycle behavior. The paired three-round recheck prevents a single drifting semantic judgment from being mistaken for a causal effect.

The evidence rejects the naive hypothesis that appending a raw fact ledger is a general solution. It strongly supports record-oriented, selective, co-located, lossless projection. Adding atomic rows without document semantics has near-zero value; aggregating related fields into legal records produces a large and repeatable fact-coverage gain.

## Boundary decision

- No legal schema, legal importance rule, or record renderer belongs in Core.
- No benchmark answer, rubric ID, case entity, or Judge integration should enter production runtime.
- The legal plugin/Skill should own typed legal records, legal-importance routing, compact schedule rendering, and the substantive reasoning review.
- Core may own a generic allowed-mutation contract and hash-based before/after enforcement because the E2 Agent's self-report was demonstrably unreliable. That abstraction should remain domain-neutral.
- The production design must replace the 1.25-million-token exploratory synthesis with incremental structured records and deterministic rendering.
- A verifier/gap loop is not yet justified. First implement the cheaper projection path and mutation guard, then A/B the verifier against that baseline.
- The external Judge remains an evaluation-only dependency.

## Omitted

Raw legal materials, opinion text, expected answers, per-checkpoint legal content, Judge payloads, raw responses, authentication data, and private temporary paths are intentionally omitted.
