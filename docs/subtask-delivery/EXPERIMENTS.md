# Engineering evidence — 13 September 2026

The strongest measured value is **intercepting specific delivery faults and repairing the original subtask**. This small evaluation does **not** show a general success-rate improvement over the original PilotDeck baseline.

The implementation is derived from the contributor's **面壁智能黑客松全场冠军成果**. That is project provenance supplied by the contributor, not evidence of model accuracy or an upstream endorsement.

## What ran

Producer: `glm-5.3-flash`; reviewer and Best-of-3 selector: `glm-5.3`, through the authorized Zhipu Coding Plan endpoint. All natural executions use the production `SubAgentSession`, real model calls and real temporary files, with `read_file` / `write_file`. Provider-reported usage is retained. The original competition endpoint was unavailable; no competition-model result is claimed here.

Two cohorts answer different questions:

- **Natural tasks:** eight small tasks covering code, accounting/time arithmetic, document research, operational instructions and a customer reply. Off uses the existing child prompt. Guidance-only replaces the reporting instruction but uses Off execution. Auto adds the production `structured_output` tool as well as its prompt/checks, so this is not a perfectly isolated prompt-only intervention. All arms share task inputs and a total 18-turn cap. Repairs are limited to two (three deliveries).
- **Controlled faults:** four declared faults replay an identical fixture as the first delivery in each arm. That first delivery is **not a model generation and has no producer token cost**. Repairs and model reviews are real. This cohort measures detection/recovery, not natural failure frequency or production cost ratios.

Independent artifact grading is outside the runtime and never feeds the reviewer, repair feedback or Best-of-3 selector. The runtime contains no task answer keys. Best-of-3 generates three independent guided candidates and uses a separately metered live selector; it does not select by the independent grade. Self-Consistency votes on full JSON answers for the two numerical tasks only, breaking ties by earliest proposal. It is not meaningful for arbitrary prose/code, so no broader SC claim is made.

## Natural task results

The main table uses strict artifact grades after correcting evaluator defects. The baseline was already strong; these results are not a basis for claiming superiority over Off or Best-of-3.

| Arm | First/final strict usable artifacts | Producer tokens | Reviewer / selector tokens |
|---|---:|---:|---:|
| Off, original reporting | 8/8 | 45,877 | 0 |
| Guidance only | 7/8 | 58,669 | 0 |
| Auto L1 | 6/8 | 57,417 | 0 |
| Auto L1 + requested Judge | 7/8 | 60,317 | 6,718 |
| Best-of-3, guided candidates + selector | 8/8 | 166,837 | 10,179 |
| Self-Consistency, two JSON tasks only | 2/2 | 43,547 | 0 |

No natural Auto run made an outer delivery repair, so its first and final artifact scores are identical. Producer tool turns are not delivery attempts. The L1+Judge arm used 67,035 tokens versus 177,016 for Best-of-3 across these eight tasks, but also had a lower strict score; that trade-off is not a like-for-like win.

| Task | Off | Guidance | L1 | L1 + Judge | Final Judge status |
|---|---|---|---|---|---|
| Environment parser | usable | usable | usable | usable | accepted |
| Immutable interval merge | usable | usable | usable | usable | accepted |
| Net revenue from CSV | usable | wrong total | wrong total | usable | inconclusive |
| SLA durations across time zones | usable | usable | usable | usable | inconclusive |
| Launch recommendation | usable | usable | usable | usable | accepted |
| Vendor recommendation | usable | usable | incomplete filename citations | incomplete filename citations | accepted |
| Incident runbook | usable | usable | usable | usable | accepted |
| Customer reply | usable | usable | usable | usable | error: output limit |

Manual review found the two vendor recommendations practically usable with a minor citation-completeness issue. This alternative business judgment is stored separately; **it does not replace the stricter headline score**. L1's revenue result passed file/structure checks while containing an incorrect total: file existence is intentionally not semantic correctness.

The Judge returned **5 accepted, 2 inconclusive and 1 error**. Numerical outputs had insufficient source evidence for the bounded result-only reviewer. The customer-reply verdict hit the 512-token output limit; it is an error, despite the independently usable reply. A structured verdict can still overlook a requirement, as seen in vendor citations.

## Judge token budget

This counts actual input (including cache reads) plus output tokens, not money. Cache discounts, model pricing and unreported provider usage must not be inferred from token totals. Here normalized `inputTokens` excludes `cacheReadTokens`; provider `totalTokens` is the denominator source. Requested thinking suppression was not always honored by the provider; any reported reasoning/output usage is included.

| Task | Producer total | Judge total | Judge / producer |
|---|---:|---:|---:|
| Environment parser | 7,562 | 851 | 11.3% |
| Interval merge | 7,635 | 924 | 12.1% |
| Revenue | 10,095 | 744 | 7.4% |
| SLA | 7,703 | 714 | 9.3% |
| Launch research | 7,869 | 910 | 11.6% |
| Vendor research | 7,639 | 831 | 10.9% |
| Runbook | 7,195 | 708 | 9.8% |
| Customer reply | 4,619 | 1,036 | 22.4% |
| **Total** | **60,317** | **6,718** | **11.1%** |

The aggregate is near one ninth of production usage; it is **not a universal 10% bound**. Input budgets use PilotDeck's tokenizer estimate, not a provider-exact tokenizer. This is a cap on packet size and one decision call, not a promise of exact billed cost. Smaller producers, expensive reviewer models, transport retries and errors can worsen the trade-off.

## Controlled detection and local recovery

| Predeclared first-delivery fault | Off final artifact | L1 final artifact | L1 + Judge, 0 repairs | L1 + Judge, up to 2 repairs |
|---|---|---|---|---|
| Claimed result file absent | missing | usable, 1 repair | detected, still missing | usable, 2 repairs; accepted |
| Declared code line outside file | artifact already usable; report false | usable, report repaired once | detected; no repair | usable, report repaired twice; accepted |
| Interval code mutates caller input | incorrect | incorrect | rejected | usable, 1 repair; inconclusive report |
| Runbook permits unsafe recovery | incorrect | incorrect | rejected | usable, 1 repair; accepted |

The no-repair L1+Judge arm detected **all four seeded faults**. With up to two local repairs, independently usable business artifacts increased from **1/4 to 4/4**; complete accepted delivery receipts were **3/4**, with one inconclusive result. The line-location case already had a correct business artifact, so its improvement is report integrity, not artifact correctness. L1 alone caught the two structural faults and produced 2/4 usable business artifacts.

The repaired interval implementation was correct in artifact tests, but its report did not supply usable file evidence for a conclusive final review. We retain that limitation instead of equating artifact correctness with framework acceptance. These are four controlled examples, not an estimate of real-world success rates or evidence that local repair outperforms Best-of-N.

## Final-code fault regression

After parser, archive, history-display and final-outcome review fixes, we reran **all 16 controlled task/arm combinations** on the final runtime. The earlier natural measurements above predate these hardening changes; their 11.1% ratio describes that measured snapshot, not an exact final-release cost guarantee.

| Fault | L1 after one repair | Judge with zero repairs | Judge with up to two repairs |
|---|---|---|---|
| Missing result file | usable; L1 passed | detected by L1 | usable after 1 repair; review inconclusive |
| Wrong line range | artifact usable; new report had no applicable fields, L1 skipped | detected by L1 | usable after 1 repair; accepted |
| Mutating interval code | still incorrect; L1 passed | rejected | usable after 1 repair; accepted |
| Unsafe runbook | still incorrect; L1 passed | rejected | usable after 1 repair; accepted |

Again all four seeded faults were detected with no repair, and all four final artifacts were independently usable after local repairs. Three final receipts were accepted; the missing-file task's repaired numerical result lacked enough evidence for a conclusive model review. The L1 line-range repair illustrates the deliberate sparse policy: a child can omit checkable fields and receive **skipped**, never a claim that its missing report was verified.

[Final regression data](evidence/controlled-final-v2.json.gz) preserves every run, message and usage counter. [Runtime source hashes](evidence/runtime-source-sha256.json) identify the runtime used. [Native demo evidence](evidence/native-demo.json.gz) also includes the two earlier unsuccessful demonstrations and the successful real gateway run.

## Evaluation corrections and retained failures

1. The initial launch-research task said “read three supplied files” without naming them, while the tool set had no directory-listing tool. All seven arms failed to find the sources. Those original rows remain in `natural-v1`. We added only the three filenames and reran **every arm and selector for that task**, stored as `research-path-correction-v1`. The main natural table combines those corrected rows with the seven unchanged tasks. No favorable-only replacement was made.
2. The initial code grader failed to execute a legal combination of named and default ESM exports. It now transpiles ESM before running bounded tests. The old runbook regex rejected “10 consecutive minutes”; the old reply grader counted a legacy report wrapper as business prose. These grading bugs were corrected across all arms without regenerating outputs. Original grades remain in every result; revised grades are in `adjudication-v2.json`.
3. Four retained preflight directories cover transport/parser probes before the full run. Zhipu rejected an OpenAI `metadata` object with HTTP 400; the experimental provider explicitly uses `extraBody.metadata: null`. This compatibility setting is documented, not hidden in the production adapter.
4. Two early native demo runs mixed “submit an unchanged first draft” into the final task itself. The reviewer accepted that intermediate compliance despite unmet final requirements. One run also exposed an unclosed JSON fence being treated as prose. The runtime parser was corrected and the reviewer instruction clarified final-outcome assessment. Clarification alone did not resolve the ambiguous demo. The final demo moves deliberate first-delivery faults into a clearly labeled child-only demo prompt; the assigned task contains the final goal. Earlier failures remain documented. This is not a claim that prompt injection or false acceptance is solved.

## Reproduce and inspect

- Tasks and independent grader: `scripts/subtask-delivery/`.
- Runner: `scripts/subtask-delivery-benchmark.ts`.
- Full completed-run evidence: [compressed JSON bundle](evidence/runs-2026-09-13.json.gz), with [manifest and SHA-256](evidence/manifest.json). Includes all 79 completed arm runs, original and revised grades, producer messages, model decisions and usage. Local roots are redacted; file contents are preserved.
- Decompress the bundle as a JSON map of relative artifact paths. Materialize its entries into a directory, then run `node --import tsx scripts/subtask-delivery/summarize.ts <directory>` to recompute artifact grades and tables.

For new runs, configure `DELIVERY_BENCHMARK_ENDPOINT` and `DELIVERY_BENCHMARK_API_KEY`; optionally set producer/Judge model variables. Without them the runner uses the user's existing OpenCode Zhipu configuration. Runs consume model quota.

```sh
node --import tsx scripts/subtask-delivery-benchmark.ts artifacts/natural-v1
DELIVERY_BENCHMARK_COHORT=controlled node --import tsx scripts/subtask-delivery-benchmark.ts artifacts/controlled-v1
```

Current task fixtures already include the launch filenames. Results are one execution per task/arm, with no confidence intervals, no broad benchmark coverage, no rendered-UI/multimodal quality evaluation and no proof that Judge acceptance implies correctness.
