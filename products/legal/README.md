# PilotDeck Legal Product Bundle

This product bundle keeps legal-domain knowledge outside PilotDeck Core. The
`legal-coverage` plugin provides the legal workflow, schemas, dynamic milestone
selection, deterministic validation, and completion proof. PilotDeck Core
continues to own only generic hooks, context delivery, tools, and artifact
correction.

The proposed delivery architecture is documented in
[E2-Elite: Adaptive Legal Projection](docs/e2-elite-adaptive-legal-projection.md).
It selects narrative, hybrid, schedule-heavy, or operational delivery before
deciding whether structured legal projections are useful.

## Install

Link the plugin into a project or PilotDeck home:

```bash
ln -s "$(pwd)/products/legal/plugins/legal-coverage" \
  /path/to/project/.pilotdeck/plugins/legal-coverage
```

The plugin activates when the project already has an enabled legal coverage
configuration or when a user submits a legal due-diligence/opinion task.

## Initialize

```bash
node products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs init \
  --workspace /path/to/project \
  --input source-room \
  --deliverable opinion=deliverables/legal-opinion.md \
  --jurisdiction "Applicable jurisdiction" \
  --basis-date "Review basis date"
```

The command creates state under `.pilotdeck/work/legal-coverage/`. Source legal
materials and generated work state remain project-local; they are not part of
this product bundle.

## Validate

```bash
node products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs validate \
  --workspace /path/to/project \
  --write-proof
```

When validation reaches final coverage, inspect one deterministic repair slice
instead of loading every ledger into model context:

```bash
node products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs next-batch \
  --workspace /path/to/project \
  --phase coverage \
  --limit 12 \
  --max-bytes 24576
```

Inspect the machine-readable patch schema, then apply only the current batch:

```bash
node products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs schema
node products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs apply-batch \
  --workspace /path/to/project \
  --phase coverage \
  --input-file .pilotdeck/work/legal-coverage/patches/coverage-batch.json
```

The patch must carry the `stateHash` returned by `next-batch`, may update only
the current group and record identities, and is limited to 12 records / 24 KiB.
The command atomically preserves unrelated coverage rows and invokes the same
validator after writing. A stale or out-of-scope patch is rejected before the
canonical ledger changes.

Validation fails closed on incomplete source inventory, partial facts, orphaned
risks, unverified citations that are not disclosed, stale deliverable hashes, or
missing or generic final coverage. Canonical ledgers use a single main-agent
writer; delegated workers produce disjoint evidence fragments for serial merge.
Only the validator writes `completion-proof.json`.

Evaluation runners may provide `.pilotdeck/input-manifest.json`. When present,
the plugin requires `sources.json` to bind originals under the manifest's
`originalRoot`; reviewed Office or other non-text sources must also record every
verified `derivedRoot` artifact used for inspection. Original and derived hashes,
extraction methods, and extractor versions become part of the validator-owned
state hash and completion proof. Existing non-runner workspaces remain compatible
when no input manifest is present.

For document rooms larger than 20 files, the legal Skill requires two to four
read-only evidence batches. This keeps raw extraction out of the main context
while preserving a single writer for canonical state.
