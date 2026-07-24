# E2-Elite: Adaptive Legal Projection

Status: accepted architecture decision with a bounded due-diligence vertical
slice, supported by a frozen-evidence experiment, a full-corpus applicability
review, and an isolated real-runtime pilot.

## 1. Decision

E2-Elite is the proposed legal delivery architecture for PilotDeck:

> Selective structured projection + adaptive legal reasoning + bounded
> validation + observable mutation control.

It is not a mandatory report template. It does not require every legal task to
produce tables or appendices. The legal plugin first classifies the task and
creates a small projection plan. Structured records and deterministic renderers
are used only where they preserve dense, repetitive, or exact facts better than
free-form prose. Narrative legal reasoning remains authored and reviewed as
narrative.

The name distinguishes this design from the E2 experiment. E2 demonstrated the
semantic value of record-oriented projections, but its process was too costly
and did not enforce the requested write boundary. E2-Elite retains the useful
mechanism and replaces the experimental generation process.

## 2. Evidence and problem statement

The difficult legal-opinion experiment compared three artifacts over the same
321 checkpoints:

| Variant | Overall | Critical | Interpretation |
|---|---:|---:|---|
| E0 frozen opinion | 185/321 | 100/141 | Narrative baseline |
| E1 raw ledger appendices | 174/321 | 94/141 | Atomic rows lost record context |
| E2 record-oriented appendices | 225/321 | 113/141 | Related facts were exposed together |

Three paired E0/E2 rechecks covered every changed checkpoint. E2 accumulated
145 passes against E0's 16 across 180 judgments. It produced 43 stable E2-only
wins, including 15 critical wins, and no stable E0-only win.

The result is strong evidence for record-oriented projection, but not for a
record-only workflow:

- fact extraction improved from 155/267 to 198/267;
- legal reasoning fell from 18/33 to 15/33 in the single full run;
- legal citation remained 5/13;
- the Agent used 47 model requests and about 1.25 million tokens;
- it created an unauthorized scratch artifact;
- it incorrectly reported that only the target opinion changed.

The production problem therefore has four parts: preserve record-level fact
coverage, preserve legal reasoning quality, bound the repair cost, and verify
actual mutations independently of the Agent's narrative.

Sanitized experiment evidence is stored under
`.omo/evidence/20260723-legal-coverage-v1/`. Raw legal material, expected
answers, Judge prompts, and Judge responses remain outside Git.

## 3. Design principles

1. **Adapt before structuring.** Select a delivery mode from the task shape;
   never assume that a table is useful.
2. **Project records, not cells.** Keep an entity, event, clause, calculation,
   or issue together with its provenance, uncertainty, and legal significance.
3. **Reason in prose where prose carries the law.** A renderer may assemble a
   chronology or schedule; it must not manufacture legal analysis.
4. **Expose only decision-useful structure.** Internal extraction state does not
   automatically become a user-visible appendix.
5. **Inject state, not history.** Dynamic prompts carry current invariants,
   compact pointers, gaps, and one next action instead of replaying raw evidence.
6. **Validate deterministically before asking a model.** Schema, provenance,
   arithmetic, linkage, citation shape, hashes, and mutation boundaries are
   machine checks. A model is reserved for bounded semantic review.
7. **Measure regressions, cost, and side effects.** A higher Judge score alone
   is not a production pass.

## 4. Ownership boundary

| Layer | Owns | Must not own |
|---|---|---|
| PilotDeck Core | Generic lifecycle hooks, context envelopes, artifact contracts, write policy, before/after hashes, mutation manifests, retry budgets, completion enforcement | Legal concepts, legal importance rules, task-family prompts, benchmark IDs, case entities, expected answers, Judge endpoints |
| Legal plugin and Skills | Legal task profiling, claims, issues, authorities, provenance semantics, importance routing, projection plans, legal renderers, citation review, substantive reasoning review | Generic harness lifecycle or benchmark scoring policy |
| Benchmark harness | Corpus loading, rubric and Judge adapters, A/B comparisons, paired rechecks, cost and mutation measurements, release evidence | Production prompt injection or runtime completion decisions |

The external Judge is evaluation-only. Production behavior must remain useful
and testable when no Judge service exists.

Within the legal product bundle, shared legal infrastructure and task expertise
remain separate:

- the legal plugin owns the claim envelope, projection-plan protocol,
  provenance semantics, renderer registry, and legal validation interfaces;
- task-family Skills own contract-review, due-diligence, litigation, privacy,
  calculation, or operational instructions and register only the claim kinds,
  renderers, and hard gates they need;
- a Skill may select `narrative` and register no renderer at all;
- the current `legal-coverage` due-diligence workflow must not be widened into a
  universal legal schema. Shared mechanics should be extracted only after two
  task families prove the same abstraction.

## 5. Delivery modes

The legal plugin selects one mode before drafting. The mode is a planning hint,
not a permanent task taxonomy.

| Mode | Default output | Typical tasks | Structured projection |
|---|---|---|---|
| `narrative` | Coherent prose or formal pleading | Pleadings, advocacy, short advice, legal content | Internal checklist or sparse support only |
| `hybrid` | Narrative analysis with selected schedules | Contract review, privacy assessment, investigation, opinion | Only dense sections with clear record semantics |
| `schedule-heavy` | Tables/calculations lead, prose interprets | Due diligence, disclosure lists, chronology, damages | Primary delivery mechanism |
| `operational` | State, manifest, action log, renamed/classified files | Matter intake, filing, document organization | Operational records, not legal appendices |

Mode selection uses observable task properties:

- the requested user-visible artifact;
- evidence count, formats, and repetition;
- whether exact quotation, location, amount, date, or status is required;
- whether relationships across records matter;
- whether legal persuasion or explanation dominates;
- whether the task primarily mutates files rather than drafts analysis.

If confidence is low, choose the less structured mode and allow a later plan to
add one targeted projection. Do not default upward to `schedule-heavy`.

## 6. Extensible legal representation

The legal plugin owns an open claim envelope. `kind` and `fields` are extensible
because a closed hierarchy would force unrelated legal tasks into one schema.

```ts
interface LegalClaim {
  id: string
  kind: string
  subject?: EntityRef
  fields: Record<string, JsonValue>
  sources: SourceSpan[]
  confidence: "confirmed" | "supported" | "unclear" | "disputed"
  materiality?: "critical" | "material" | "context"
  legalSignificance?: string
  unresolved?: string[]
  relations?: ClaimRelation[]
}
```

Examples of `kind` include `contract_clause`, `corporate_record`,
`evidence_event`, `damages_item`, and `processing_activity`. These are plugin
vocabulary, not Core vocabulary.

The envelope must preserve:

- **record identity:** which real-world thing the fields describe;
- **co-location:** fields needed to interpret one another stay together;
- **provenance:** file and stable location or span;
- **epistemic status:** confirmed, inferred, disputed, missing, or not applicable;
- **relations:** contradictions, support, supersession, dependency, and grouping;
- **legal significance:** why the record matters to the requested decision.

Fields that cannot be sourced stay explicitly unresolved. Renderers may never
turn absence into `not_present` unless the task's review protocol supports that
conclusion.

## 7. Projection planning

Before drafting, the legal plugin creates a compact `ProjectionPlan`:

```ts
interface ProjectionPlan {
  mode: "narrative" | "hybrid" | "schedule-heavy" | "operational"
  rationale: string
  projections: Array<{
    id: string
    recordKinds: string[]
    audience: "internal" | "user"
    placement: "inline" | "appendix" | "artifact" | "state"
    renderer?: string
    purpose: string
    omitWhenEmpty: boolean
  }>
  narrativeSections: string[]
  hardGates: string[]
}
```

A projection is justified when at least one of these conditions holds:

- records repeat across multiple entities, documents, dates, or issues;
- users need exact comparison, reconciliation, calculation, quotation, or status;
- several facts must be co-located to avoid a misleading conclusion;
- a deterministic completeness rule exists;
- the requested deliverable explicitly calls for a table, schedule, register,
  chronology, or manifest.

A projection is rejected or kept internal when it would fragment an argument,
duplicate a short narrative, reveal work product the user did not request, or
create false precision from incomplete evidence.

## 8. Dynamic context injection

Core provides a generic hook that delivers a bounded context envelope. The legal
plugin supplies domain content for that envelope at milestone transitions.

```text
INIT
  -> SOURCE_REVIEW
  -> SOURCES_READY
  -> EVIDENCE_READY
  -> PROJECTION_PLANNED
  -> DRAFT_READY
  -> VALIDATING
  -> COMPLETE
```

An injected envelope contains only:

```json
{
  "milestone": "PROJECTION_PLANNED",
  "objective": "Draft the selected deliverable",
  "invariants": ["Do not invent missing fields", "Preserve source links"],
  "artifactPointers": ["state://projection-plan", "state://open-issues"],
  "knownGaps": ["Two material records remain disputed"],
  "writeScope": ["deliverables/opinion.md"],
  "nextAction": "Draft the narrative and the two approved projections",
  "completionSignal": "draft-ready"
}
```

Injection rules:

- inject on milestone change, failed hard gate, compaction recovery, or explicit
  continuation, not on every model turn;
- use stable artifact pointers and compact summaries, not raw document excerpts;
- include one next action so the prompt does not become a second workflow engine;
- for a large canonical ledger, inject only the next deterministic work slice
  (currently capped at four records and 2 KiB) rather than requiring the Agent
  to rediscover the slice or load the full ledger;
- keep generic lifecycle fields in Core and legal invariants in the plugin;
- deduplicate by milestone, state version, and injection digest;
- cap the envelope by bytes and fail with a pointer rather than truncating a
  legal invariant silently;
- deduplicate on the visible milestone, blocking gap, and aggregate progress;
  an unrelated draft hash change must not replay the same envelope;
- make canonical ledger writes bounded transactions (one fragment or ledger
  section, at most 12 records and 24 KiB of serialized new content), followed
  by deterministic validation;
- never include rubric IDs, expected answers, Judge feedback, or benchmark-only
  case facts.

This is dynamic prompt injection as state delivery. It is not keyword-based
prompt accumulation.

## 9. Composition and rendering

Composition has three separate operations:

1. **Legal drafting:** the Agent writes conclusions, legal reasoning,
   qualifications, recommendations, and transitions.
2. **Projection rendering:** deterministic code renders approved record sets
   into tables, schedules, calculations, timelines, registers, or manifests.
3. **Document composition:** named anchors place rendered sections inline or in
   appendices without rewriting unrelated narrative.

Renderers must be optional, idempotent, stable under record ordering, and able to
report omitted or unresolved values. They receive validated records rather than
raw source text. A renderer must not decide legal materiality or fill a missing
legal conclusion.

For narrative mode, composition can consist only of Agent-authored prose. For
hybrid mode, projections should normally stay between one and five. A larger
number requires a plan rationale because the 17-appendix E2 artifact was useful
for coverage but poor as a default product shape.

## 10. Bounded validation

Validation is layered from cheapest and most deterministic to most semantic:

1. schema and required-field validation;
2. source inventory and provenance resolution;
3. record linkage, deduplication, and unresolved-state validation;
4. arithmetic, dates, status vocabulary, quotations, anchors, and artifact hash
   checks where applicable;
5. deliverable-specific structural gates;
6. one focused legal reasoning and citation review;
7. mutation-policy verification and completion proof.

Failures produce typed gaps with artifact pointers. The repair prompt receives
only failed gates and their local context. It does not ask the Agent to rewrite
the entire deliverable.

At most two targeted repair passes are allowed. After the second failure, the
run returns an explicit incomplete result with unresolved gates. It must not
loop until a model happens to satisfy an unstable evaluator.

## 11. Mutation policy

Core owns a domain-neutral write contract:

```ts
interface MutationPolicy {
  writableArtifacts: string[]
  writableScratchPrefixes: string[]
  readOnlyPrefixes: string[]
  forbiddenPrefixes: string[]
  denyUnmatchedWrites: boolean
}
```

Core snapshots relevant paths before execution and emits a mutation manifest
from observed filesystem state afterward. The manifest records created,
modified, deleted, and unchanged declared artifacts with hashes. The Agent's
self-report is informational only.

Unexpected writes fail the completion gate. Scratch writes are allowed only
under declared prefixes and are either retained intentionally or cleaned by a
separate, explicit lifecycle action. Symlink escapes, path normalization, case
normalization where required, and rename detection must be covered by Core
tests.

The legal plugin declares its target deliverables and work-state prefixes. It
does not implement a competing filesystem monitor.

## 12. E2-Elite experiment protocol

The first implementation experiment reuses the difficult case without giving
production code access to rubric expectations or Judge feedback.

Acceptance targets:

| Gate | Target |
|---|---:|
| Overall semantic score | at least 220/321 |
| Critical semantic score | at least 113/141 |
| Fact extraction | at least 195/267 |
| Legal reasoning | at least 18/33 |
| Legal citation | at least 5/13 |
| User-visible appendices | 3-5 unless the plan justifies more |
| Model tokens | no more than 150,000 |
| Unauthorized mutations | 0 |
| Stable paired regressions | 0 |

Compare four frozen variants where practical:

- current narrative baseline;
- selective projections without semantic verifier;
- selective projections plus one reasoning review;
- the previous E2 semantic artifact as an upper-reference, not a process model.

Record score, critical score, dimension score, model requests, input/output
tokens, elapsed time, projection count, mutation manifest, and unresolved gates.
Any changed checkpoint receives three paired rechecks before being called a
stable improvement or regression.

## 13. Cross-case validation method

The initial review uses a stratified sample rather than tuning on the difficult
opinion or immediately rerunning the full corpus. For each case, inspect only:

- user request and requested deliverable;
- checkpoint count, dimensions, and critical count;
- source and generated artifact counts and formats;
- repetition, exactness, relationship density, and narrative dependence.

Do not inspect expected answers to design production prompts. Do not import
rubric language into legal schemas. The review asks whether E2-Elite's adaptive
decision is appropriate, not whether one projection can maximize every score.

Classification:

- `primary`: structured or operational records are central to the requested
  deliverable;
- `optional`: selective records help, but narrative analysis remains central;
- `inappropriate`: structured projection should not be the main user-visible
  workflow, though small internal records may still support drafting.

## 14. Cross-case applicability results

The source workbook contains 85 entries across the first six batches and the
7.14 retest column. Three labels repeat exactly, leaving 82 unique cases. The
inventory contains 4,685 checkpoints, including 2,135 marked critical. The
review classified every unique case from task metadata and requested artifact
shape, without reading expected answers or Judge feedback into the design:

| Applicability | Cases | Meaning |
|---|---:|---|
| `primary` | 18 | Structured or operational records are central |
| `optional` | 46 | Selective internal or visible projections can help |
| `internal-support-only` | 13 | Narrative remains primary; structure is an internal consistency aid |
| `outside-legal-plugin` | 5 | Reuse generic harness capabilities or another task Skill |

| Delivery mode | Cases |
|---|---:|
| `narrative` | 14 |
| `hybrid` | 48 |
| `schedule-heavy` | 14 |
| `operational` | 6 |

These are architecture-applicability classifications, not semantic pass
results. They show that E2-Elite is broadly useful only when its mode selector
is allowed to choose sparse internal support or no legal projection at all.

Eleven cases were selected across materially different task families. Counts are
case metadata only; no expected answer or Judge feedback informed the design.

| Task family and observed shape | Mode | Useful projection | Where deterministic rendering harms quality | Required hard gates | Applicability |
|---|---|---|---|---|---|
| SaaS contract review: 84 checks, 29 critical, 4 mixed Markdown/PDF inputs | `hybrid` | Clause-source-risk-recommendation records for data, AI, renewal, and SLA | Rendering the whole memorandum as clause rows fragments prioritization and negotiation advice | Requested topics covered; quote locations resolve; risk and recommendation stay linked; legal basis reviewed | `optional` |
| Civil pleading: 50 checks, 27 critical, 21 PDFs | `narrative` | Internal party-fact-evidence-relief consistency map | Formulaic rendering weakens factual theory, persuasion, and procedural coherence; no default user-visible appendix | Parties, claims, facts, evidence, jurisdiction, requested relief, and calculations are mutually consistent | `inappropriate` as the main workflow |
| Multi-person statement comparison: 60 checks, 28 critical, 6 Markdown inputs; the request explicitly requires a comparison table and contradiction analysis | `hybrid` | Fact-point x statement records, evolution timeline, support/contradiction links, objective-evidence gaps | A table cannot decide credibility or replace careful explanation of ambiguity and alternative causes | Every material statement has provenance; inconsistency labels are neutral; objective corroboration and gaps are explicit | `primary` for comparison records |
| Personal-information impact assessment: 51 checks, 38 critical, 3 mixed inputs | `hybrid` | Processing activities, data lifecycle, affected rights, controls, residual-risk register, open technical questions | A generated risk register cannot replace necessity, proportionality, legal-basis, and residual-risk reasoning | Unknown technical details remain unresolved; processing-purpose-data-recipient links are complete; citations and residual risks reviewed | `optional` |
| Tort damages calculation: 54 checks, 37 critical; arithmetic and legal reasoning dominate | `schedule-heavy` | Claim-item formula, factual inputs, authority/version, evidence, responsibility allocation, subtotal and final amount | Narrative should explain contested assumptions and alternative scenarios; a single unexplained total creates false certainty | Units, dates, jurisdiction/version, formulas, dependencies, responsibility ratio, rounding, and evidence links recompute exactly | `primary` |
| Matter intake and file management: 85 checks, 19 critical, 21 PDFs; observed outputs include matter records, event logs, and a portfolio register | `operational` | File manifest, classification state, matter metadata, event/action log, unresolved filing queue | Legal appendices are the wrong abstraction; prose-only output also fails because actual file operations matter | No source mutation unless authorized; every file accounted for; naming collisions and duplicates handled; mutation manifest matches results | `primary` in operational mode |
| Short legal advice email: 49 checks, 24 critical, 1 document input | `narrative` | Small internal issue-rule-risk-action checklist | A visible schedule makes a short answer harder to read and can obscure conditional advice | Question answered directly; assumptions and missing contract terms disclosed; legal basis checked; next actions are practical | `inappropriate` as the main workflow |
| Tabular due diligence: 125 checks, 49 critical, 11 mixed inputs; one row per file with exact status, quotation, and location | `schedule-heavy` | Contract x review-field records with controlled status, verbatim quote, location, and aggregate counts | Free-form generated cell prose reduces comparability; narrative is useful only for cross-document exceptions and conclusions | Every file and field accounted for; status vocabulary valid; quotes and locations resolve; counts recompute from rows | `primary` |
| Case-law research report: 62 checks, 35 critical, 2 pleadings; fact, citation, reasoning, and structure are all material | `hybrid` | Issue-authority-holding-applicability records, search scope, negative-result log, citation provenance | A case list cannot replace comparison of legally material facts or explain why an authority applies | Research scope and cutoff disclosed; every citation resolves; holding is separated from application; contrary authority and research gaps remain visible | `optional` user projection, `primary` internal authority records |
| Document redaction: 33 checks, 11 critical, 1 Word input; structure compliance dominates and the output must remain Word | `operational` | Detection/redaction manifest, replacement policy, residual scan, before/after document metadata | A legal record appendix is irrelevant, and reconstructing the document as generated prose can destroy layout | Authorized categories only; every occurrence handled; residual scan passes; layout and file type preserved; mutation manifest names the output | `inappropriate` for legal projection; use generic document transformation plus a task Skill |
| Legal content planning: 13 checks, 5 critical, 9 text/tabular inputs; reasoning dominates but the request repeats platform, audience, purpose, conversion, and safety fields | `hybrid` | Task-specific content-idea records and a lightweight publishing plan | A legal claim model is the wrong semantic type; rigid row generation can flatten editorial judgment and platform-specific voice | Requested themes covered; platform/audience fit explained; legal and marketing-risk language reviewed; no unsupported legal claim | `inappropriate` for the legal plugin; use a content-planning Skill |

The sample supports the adaptive design and rejects both a universal structured
format and a universal legal runtime. Projection is primary for due diligence,
evidence comparison, calculations, and operational records; optional for
contract, regulatory, and legal-research analysis; and usually inappropriate as
the main visible workflow for pleadings and short advice. Document redaction and
content planning confirm the ownership boundary: they may reuse Core lifecycle,
mutation, and artifact mechanisms, but they should not activate the legal claim
and projection protocol merely because their benchmark category is legal.

The design therefore applies across the legal-analysis subset only because mode
selection may choose little or no user-visible projection. It intentionally does
not apply to every task in the broader legal benchmark. If `ProjectionPlan` were
required to produce appendices for every case, or if every task were forced to
create `LegalClaim` records, the design would fail this review.

## 15. Implementation sequence

Keep each stage independently measurable and do not begin with a general
semantic verifier.

The current implementation is a useful due-diligence vertical slice, not yet
the complete architecture:

| Current behavior | E2-Elite change | Boundary |
|---|---|---|
| `legal-coverage` creates seven fixed due-diligence matrices | Add a validated projection plan and task-owned registrations; keep the existing matrices as one due-diligence adapter | Legal plugin and task Skill only |
| The legal hook now emits compact, digest-deduplicated envelopes, recovers after compaction, and injects a 2-KiB deterministic coverage slice | Generalize the domain-neutral delivery primitive only after another task family proves the same contract | Current legal content stays in the plugin; any later generic delivery mechanism belongs in Core |
| The artifact contract requires `completion-proof.json` and checks file existence | Extend Core contracts with observed mutation policy and hash manifests; keep legal completion semantics in the plugin | Core mechanism, plugin declaration |
| Coverage discovery now has a read-only `next-batch` CLI and automatic four-record prompt slice | Extend bounded slices to other proven ledger phases; add explicit repair budgets and return unresolved gates after two targeted attempts | Legal slicing stays in the plugin; a generic retry budget belongs in Core |
| Activation recognizes due-diligence/opinion/risk-review requests | Let task Skills opt into the shared legal protocol; do not broaden one regex to every legal prompt | Task Skill registration |

1. **Core mutation contract.** Add policy parsing, before/after snapshots,
   mutation manifests, deny-unmatched enforcement, and adversarial path tests.
2. **Legal task profiler and `ProjectionPlan`.** Implement the four modes,
   conservative fallback, plan validation, and task-family configuration in the
   legal plugin.
3. **Open legal claim envelope.** Add provenance, uncertainty, relation, and
   unresolved-field validation without imposing a closed claim taxonomy.
4. **Two high-value renderers.** Start with record schedules and calculations;
   prove idempotence and lossless linkage. Do not build a renderer per case.
5. **Milestone injection.** Add versioned, digest-deduplicated state envelopes
   through the generic Core hook, with byte limits and compaction recovery.
6. **Bounded validation.** Add deterministic gates first, then one focused legal
   reasoning/citation review and no more than two targeted repairs.
7. **Difficult-case A/B.** Meet semantic, cost, appendix, and mutation gates.
8. **Stratified pilot.** Run one case from each mode and compare against the
   unchanged baseline.
9. **Full-corpus decision.** Rerun the 80+ cases only after the four-mode pilot
   shows no architectural mismatch and the benchmark noise policy is fixed.

Each implementation step must add evidence that proves the layer boundary:
Core tests remain domain-neutral, legal tests contain no benchmark answers, and
benchmark adapters remain unreachable from production runtime.

## 16. Non-goals

E2-Elite does not:

- turn all legal work into tables or typed appendices;
- move legal schemas, rules, or prompt content into PilotDeck Core;
- encode rubric checkpoints, expected answers, or known case entities;
- use an external Judge to steer production execution;
- treat deterministic rendering as legal reasoning;
- authorize unlimited verifier/repair loops;
- trust the Agent's description of which files changed;
- claim that the 82-case architecture review is a full-corpus semantic quality result.
