# Legal input-lineage validation QA

## What was tested

The legal-coverage plugin now consumes a runner-owned
`.pilotdeck/input-manifest.json` when present. It binds canonical source rows to
original files, verifies every derivation used to inspect non-text sources, rejects
omitted originals, and includes original and derived provenance in its state hash and
validator-owned completion proof.

Commands:

```bash
npm test
bun test tests/products/legal-coverage.spec.ts tests/agent/legal-coverage-plugin-runtime.spec.ts
./node_modules/.bin/tsc --noEmit
```

An additional offline interoperability probe used Runner commit `87c2fef` to stage
the real Case 09 source room, then invoked this worktree's legal validator against
the resulting manifest. It did not invoke an LLM or Judge.

## What was observed

- Repository test gate: 225 passed, 0 failed.
- Focused legal and real-Gateway integration gate: 28 passed, 0 failed.
- TypeScript no-emit compilation: passed.
- Existing workspaces without an input manifest retained their previous completion
  proof source shape.
- Manifest-mode tests proved that completion fails when:
  - original bytes change;
  - derived bytes change;
  - a reviewed non-text source omits its derivation records;
  - a manifest original is omitted from `sources.json`;
  - a derived file is presented as the original source;
  - an input root selects derived files or legal mutable work state.
- A valid proof contains the manifest hash plus original and derived hashes, byte
  counts, extraction method, and extractor version.
- Real Case 09 interoperability produced:
  - 24 Runner originals;
  - 24 Runner derivations;
  - 24 legal source records;
  - zero configuration or source-lineage validation errors;
  - verified Runner post-run input integrity.
- The Case 09 probe remained semantically incomplete in `matrices` and `coverage`, as
  expected because the probe intentionally performed no legal analysis.

## Why it is enough

The unit tests cover the manifest contract and stale-data rejection, the Gateway
tests prove the plugin still participates in real runtime hook and artifact correction
flows, and the 225-test repository gate covers Core regressions. The real corpus probe
proves the independently implemented Python Runner manifest and JavaScript legal
validator interoperate on the exact 23-DOCX/1-XLSX source room that exposed the defect.

Runner commit `87c2fef` independently remembers the pre-turn manifest digest and
re-verifies the manifest, originals, and derivations after the Agent turn. This closes
the trust gap where an Agent might otherwise edit all three consistently. The legal
plugin remains domain-specific; the Runner remains unaware of legal ledgers or proof
semantics.

## What was omitted

`bun test` without file filters was tried but is not a valid repository gate: it loads
Playwright, Vitest, Node test, and browser tests into one incompatible Bun environment,
causing environment errors such as missing DOM globals. Its result was not counted;
the declared `npm test` gate passed instead.

No Case 09 source text, query, rubric, ground truth, API key, Gateway token, auth header,
or environment dump was copied into this evidence. No live model or Judge call was run.
