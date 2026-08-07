# Review and evaluation

Treat review as evidence collection for model judgment, not as a universal scoring system.

## Multimodal review

Run:

```bash
bash "$SHEET" review \
  --input "$CANDIDATE" \
  --out-dir "$WORKSPACE/review" \
  --report "$WORKSPACE/review/report.json"
```

`review` renders every worksheet separately into a directory named for the current candidate revision. It returns that revision and each full-size page with its worksheet name, page number, and image path. It also returns workbook structure, representative cells with styles, formulas, tables, validations, conditional formatting, chart/package information, and compatibility issues. `review_pending` means the images are available to inspect, not that their visual quality passed.

Choose and open the pages relevant to the task. Keep visual conclusions within the pages actually inspected. Judge the evidence against the user's request and the source materials. Look for clipping, poor wrapping, incorrect formats, excessive styling, confusing hierarchy, broken charts, blank pages, and unintended differences from a supplied template.

Visual observations belong to the revision that produced them. After changing the workbook, run `review` again and inspect the new revision's relevant pages before describing the final visual result. Let the task and the scope of the change determine which pages matter instead of recording a fixed checklist.

Rendering shows what a user sees, but it cannot prove formulas, types, hidden content, validation behavior, native object identity, or source fidelity. Use the structural report and code-based checks for those facts.

If rendering is unavailable, the report records `render.status: unavailable`. Do not manufacture a visual pass. Retry with the available renderer or disclose the limitation when visual quality is central to the task.

## Task-specific evaluators

Use an evaluator when important facts should be checked independently of the builder:

```bash
bash "$SHEET" evaluate \
  --input "$CANDIDATE" \
  --script "$WORKSPACE/tmp/evaluator.mjs" \
  --out "$WORKSPACE/review/evaluation.json"
```

The evaluator exports a default async function and returns named checks:

```js
export default async function evaluate({
  candidate,
  loadXlsx,
  helpers,
}) {
  const source = await loadXlsx("/absolute/path/to/source.xlsx");
  const expected = helpers.readRange(source, "明细", "A2:F20");
  const actual = helpers.readRange(candidate, "合并明细", "A2:F20");
  const comparison = helpers.compareMatrices(actual, expected);

  return {
    checks: [{
      name: "source rows preserved",
      passed: comparison.passed,
      comparison,
    }],
  };
}
```

Available evaluator helpers:

- `readRange(workbook, sheet, range)` returns effective values, including formula results.
- `readTypedRange(workbook, sheet, range)` also returns cell types, formulas, number formats, and addresses.
- `compareMatrices(actual, expected, { tolerance?, maxMismatches? })` returns shapes and representative mismatches.

Use ordinary JavaScript to perform joins, aggregations, key checks, invariants, and other task-specific reasoning. Return one check per independently meaningful claim.

## Preserve validation independence

- Reread authoritative source files inside the evaluator.
- Derive expected results from sources or explicit user facts, not from the candidate alone.
- Preserve identifier, number, date, and boolean distinctions.
- Use tolerances only when exact equality is inappropriate.
- Keep the evaluator separate from the builder when practical so the same implementation error is less likely to appear in both.
- Verify only claims that matter to the task; do not create checks merely to satisfy a template.
